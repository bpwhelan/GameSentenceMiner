import asyncio
from copy import copy
import io
import json
import os
import queue
import threading
import time
from datetime import datetime
from pathlib import Path

import mss
import mss.tools
import websockets
from PIL import Image
from rapidfuzz import fuzz

from GameSentenceMiner import obs
from GameSentenceMiner.ocr.gsm_ocr_config import get_ocr_config
from GameSentenceMiner.owocr.owocr.run import TextFiltering
from GameSentenceMiner.util.configuration import get_config, get_app_directory, get_temporary_directory, is_windows
from GameSentenceMiner.util.logging_config import logger  # Use centralized loguru logger
from GameSentenceMiner.ocr.gsm_ocr_config import OCRConfig, has_config_changed, set_dpi_awareness, get_window
from GameSentenceMiner.owocr.owocr import run
from GameSentenceMiner.util.electron_config import get_ocr_ocr2, get_ocr_send_to_clipboard, get_ocr_scan_rate, \
    has_ocr_config_changed, reload_electron_config, get_ocr_two_pass_ocr, get_ocr_optimize_second_scan, \
    get_ocr_language, get_ocr_manual_ocr_hotkey
from GameSentenceMiner.util.text_log import TextSource
from GameSentenceMiner.util.communication import ocr_ipc

CONFIG_FILE = Path("ocr_config.json")
DEFAULT_IMAGE_PATH = r"C:\Users\Beangate\Pictures\msedge_acbl8GL7Ax.jpg"  # CHANGE THIS

websocket_server_thread = None
websocket_queue = queue.Queue()
paused = False


# IPC command handlers
# These commands are sent from Electron via stdin using OCRCMD: prefix
# Available commands defined in ocr_ipc.OCRCommand enum

def handle_ipc_command(cmd_data: dict) -> None:
    """
    Handle IPC commands sent from Electron via stdin.
    Commands follow format: {"command": <name>, "data": {...}, "id": optional}
    """
    global ocr_state
    
    try:
        command = cmd_data.get('command', '').lower()
        cmd_id = cmd_data.get('id')
        data = cmd_data.get('data', {})
        
        if not hasattr(run, "paused"):
            run.paused = False
        
        if command == ocr_ipc.OCRCommand.PAUSE.value:
            # Only pause if not already paused (pause_handler toggles)
            if not run.paused:
                run.pause_handler(is_combo=False)
                logger.info("IPC: Paused OCR")
                ocr_ipc.announce_paused()
            else:
                logger.info("IPC: Already paused, ignoring pause command")
            
        elif command == ocr_ipc.OCRCommand.UNPAUSE.value:
            # Only unpause if currently paused (pause_handler toggles)
            if run.paused:
                run.pause_handler(is_combo=False)
                logger.info("IPC: Unpaused OCR")
                ocr_ipc.announce_unpaused()
            else:
                logger.info("IPC: Already unpaused, ignoring unpause command")
            
        elif command == ocr_ipc.OCRCommand.TOGGLE_PAUSE.value:
            # Always toggle - this is the safest command
            run.pause_handler(is_combo=False)
            if run.paused:
                logger.info("IPC: Toggled to paused")
                ocr_ipc.announce_paused()
            else:
                logger.info("IPC: Toggled to unpaused")
                ocr_ipc.announce_unpaused()
            
        elif command == ocr_ipc.OCRCommand.GET_STATUS.value:
            status_data = {
                "paused": run.paused,
                "current_engine": run.engine_instances[run.engine_index].readable_name if hasattr(run, 'engine_instances') and run.engine_instances else "unknown",
                "scan_rate": get_ocr_scan_rate(),
                "force_stable": ocr_state.force_stable if ocr_state else False,
                "manual": manual,
            }
            ocr_ipc.announce_status(status_data)
                
        elif command == ocr_ipc.OCRCommand.MANUAL_OCR.value:
            # Trigger a manual OCR scan
            if hasattr(run, 'screenshot_event') and run.screenshot_event:
                run.screenshot_event.set()
                logger.info("IPC: Triggered manual OCR")
            else:
                logger.error("IPC: Screenshot event not available")
                ocr_ipc.announce_error("Screenshot event not available")
                
        elif command == ocr_ipc.OCRCommand.TOGGLE_FORCE_STABLE.value:
            is_stable = ocr_state.toggle_force_stable()
            logger.info(f"IPC: Force stable mode {'enabled' if is_stable else 'disabled'}")
            ocr_ipc.announce_force_stable_changed(is_stable)
            
        elif command == ocr_ipc.OCRCommand.SET_FORCE_STABLE.value:
            enabled = data.get('enabled', False)
            ocr_state.set_force_stable(enabled)
            logger.info(f"IPC: Set force stable mode to {enabled}")
            ocr_ipc.announce_force_stable_changed(enabled)
            
        elif command == ocr_ipc.OCRCommand.RELOAD_CONFIG.value:
            # Reload configuration (config check thread will handle it)
            logger.info("IPC: Config reload requested")
            reload_electron_config()
            ocr_ipc.announce_config_reloaded()
            
        elif command == ocr_ipc.OCRCommand.STOP.value:
            logger.info("IPC: Stop command received")
            ocr_ipc.announce_stopped()
            # Let the process exit naturally
            
    except Exception as e:
        logger.exception(f"Error handling IPC command: {e}")
        ocr_ipc.announce_error(str(e))


class WebsocketServerThread(threading.Thread):
    def __init__(self, read):
        super().__init__(daemon=True)
        self._loop = None
        self.read = read
        self.clients = set()
        self._event = threading.Event()

    @property
    def loop(self):
        self._event.wait()
        return self._loop

    async def send_text_coroutine(self, message):
        for client in self.clients:
            await client.send(message)

    async def server_handler(self, websocket):
        self.clients.add(websocket)
        try:
            async for message in websocket:
                # Check if this is a remote control command
                command_response = handle_remote_command(message)
                if command_response is not None:
                    try:
                        await websocket.send(json.dumps(command_response))
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
                    continue
                
                # Regular message handling - use run.paused to check current state
                is_paused = run.paused if hasattr(run, 'paused') else paused
                if self.read and not is_paused:
                    websocket_queue.put(message)
                    try:
                        await websocket.send('True')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
                else:
                    try:
                        await websocket.send('False')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
        except websockets.exceptions.ConnectionClosedError:
            pass
        finally:
            self.clients.remove(websocket)

    async def send_text(self, text, line_time: datetime, response_dict=None):
        if text:
            data = {"sentence": text, "time": line_time.isoformat(), "process_path": obs.get_current_game(), "source": TextSource.OCR}
            if response_dict:
                data["dict_from_ocr"] = response_dict
            return asyncio.run_coroutine_threadsafe(
                self.send_text_coroutine(json.dumps(data)), self.loop)

    def stop_server(self):
        self.loop.call_soon_threadsafe(self._stop_event.set)

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = stop_event = asyncio.Event()
            self._event.set()
            self.server = start_server = websockets.serve(self.server_handler,
                                                          get_config().advanced.localhost_bind_address,
                                                          get_config().advanced.ocr_websocket_port,
                                                          max_size=1000000000)
            async with start_server:
                await stop_event.wait()

        asyncio.run(main())


def compare_ocr_results(prev_text, new_text, threshold=90):
    if not prev_text or not new_text:
        return False
    if isinstance(prev_text, list):
        prev_text = ''.join([item for item in prev_text if item is not None]) if prev_text else ""
    if isinstance(new_text, list):
        new_text = ''.join([item for item in new_text if item is not None]) if new_text else ""
    similarity = fuzz.ratio(prev_text, new_text)
    return similarity >= threshold

all_cords = None
rectangles = None

class OCRProcessor():
    def __init__(self):
        self.filtering = TextFiltering(lang=get_ocr_language())

    def do_second_ocr(self, ocr1_text, time, img, filtering, pre_crop_image=None, ignore_furigana_filter=False, ignore_previous_result=False, response_dict=None):
        global ocr_state
        try:
            orig_text, text = run.process_and_write_results(
                img, None, 
                ocr_state.last_ocr2_result if not ignore_previous_result else None, 
                self.filtering, None,
                engine=get_ocr_ocr2(), 
                furigana_filter_sensitivity=furigana_filter_sensitivity if not ignore_furigana_filter else 0
            )
            
            if compare_ocr_results(ocr_state.last_sent_result, text, threshold=80):
                if text:
                    logger.background("Duplicate text detected, skipping.")
                return
            save_result_image(img, pre_crop_image=pre_crop_image)
            ocr_state.last_ocr2_result = orig_text
            ocr_state.last_sent_result = text
            asyncio.run(send_result(text, time, response_dict=response_dict))
        except json.JSONDecodeError:
            print("Invalid JSON received.")
        except Exception as e:
            logger.exception(e)
            print(f"Error processing message: {e}")


def save_result_image(img, pre_crop_image=None):
    try:
        if isinstance(img, bytes):
            with open(os.path.join(get_temporary_directory(), "last_successful_ocr.png"), "wb") as f:
                f.write(img)
        else:
            img.save(os.path.join(get_temporary_directory(), "last_successful_ocr.png"))
            if pre_crop_image:
                pre_crop_image.save(os.path.join(get_temporary_directory(), "last_successful_ocr_precrop.png"))
    except Exception as e:
        logger.debug(f"Error saving debug result image: {e}")
    run.set_last_image(pre_crop_image if pre_crop_image else img)


async def send_result(text, time, response_dict=None):
    if text:
        if get_ocr_send_to_clipboard():
            import pyperclipfix
            # TODO Test this out and see if i can make it work properly across platforms
            # from GameSentenceMiner.ui.qt_main import send_to_clipboard
            # send_to_clipboard(text)
            pyperclipfix.copy(text)
        try:
            await websocket_server_thread.send_text(text, time, response_dict=response_dict)
        except Exception as e:
            logger.debug(f"Error sending text to websocket: {e}")


TEXT_APPEARENCE_DELAY = get_ocr_scan_rate() * 1000 + 500  # Adjust as needed


class OCRStateManager:
    """
    Manages all OCR state for two-pass OCR processing.
    
    Tracks:
    - Pending text state (text awaiting second OCR pass)
    - Last sent results (to avoid duplicates)
    - Previous OCR results for comparison
    - Meiki (bounding box) stability tracking
    - Force stable flag
    
    Second scan is triggered when:
    1. Text disappears (OCR returns empty after having text)
    2. Force stable mode is enabled
    3. Text COMPLETELY changes (low similarity + different start/end chars)
    4. NEW: OCR returns empty when we have pending text (immediate trigger)
    """
    
    def __init__(self):
        self.reset()
        self._ocr_processor = None  # Lazy-loaded to avoid GPU initialization at import
        self.second_ocr_queue = None  # Will be set by module
    
    @property
    def ocr_processor(self):
        """Lazy-load OCRProcessor to avoid GPU initialization at module import."""
        if self._ocr_processor is None:
            self._ocr_processor = OCRProcessor()
        return self._ocr_processor
        
    def reset(self):
        """Reset all state variables to initial values."""
        # Pending text state (text waiting to be processed by second OCR)
        self.pending_text_state = None
        
        # Last results tracking
        self.last_sent_result = ""
        self.last_ocr2_result = []
        
        # Previous OCR tracking (for detecting changes)
        self.previous_text_list = []
        self.previous_text = ""
        self.previous_ocr1_result = ""
        self.previous_orig_text = ""
        self.previous_img = None
        
        # Timing
        self.last_oneocr_time = None
        self.text_stable_start_time = None
        
        # Force stable flag
        self.force_stable = False
        
        # Meiki (bounding box) tracking
        self.last_meiki_crop_coords = None
        self.last_meiki_crop_time = None
        self.last_meiki_success = None
        
        # Track consecutive empty results to detect "cleared" state
        self.consecutive_empty_count = 0
        self.last_non_empty_text = ""
        
    def set_force_stable(self, value: bool):
        """Set force stable mode."""
        self.force_stable = value
        
    def toggle_force_stable(self):
        """Toggle force stable mode."""
        self.force_stable = not self.force_stable
        return self.force_stable
    
    def should_trigger_second_scan(self, text: str, orig_text_string: str) -> bool:
        """
        Determine if we should trigger the second OCR scan based on current state.
        
        Returns True if:
        1. Text disappeared (had pending text, now empty)
        2. Force stable mode is enabled
        3. Text completely changed (low similarity + different start/end)
        4. NEW: Text became empty OR completely different from last non-empty text
        """
        if not self.pending_text_state:
            return False
            
        p_orig_text = self.pending_text_state['orig_text']
        
        # Case 1: Text Disappeared -> Process
        if not text:
            logger.debug("Triggering second scan: text disappeared")
            return True
            
        # Case 2: Forced -> Process
        if self.force_stable:
            logger.debug("Triggering second scan: force stable mode")
            return True
            
        # Case 3: Text Changed Significantly (completely different text)
        # Requirement: < 20% similarity AND Starts differently AND Ends differently
        is_low_similarity = not compare_ocr_results(p_orig_text, orig_text_string, 20)
        
        if is_low_similarity and p_orig_text and orig_text_string:
            starts_diff = p_orig_text[0] != orig_text_string[0]
            ends_diff = p_orig_text[-1] != orig_text_string[-1]
            
            if starts_diff and ends_diff:
                logger.debug(f"Triggering second scan: text completely changed "
                           f"(similarity < 20%, different start/end)")
                return True
                
        return False
    
    def is_text_evolving(self, orig_text_string: str) -> bool:
        """
        Determine if the current text is an evolution of the pending text
        (same line being updated) vs completely new text.
        
        Returns True if text is at least 20% similar to pending text.
        """
        if not self.pending_text_state:
            return False
            
        return compare_ocr_results(
            self.pending_text_state['orig_text'], 
            orig_text_string, 
            20
        )
    
    def update_pending_state(self, text: str, orig_text_string: str, 
                            current_time, img, crop_coords):
        """
        Update or create pending text state.
        
        If text is evolving, update the state but keep the original start time.
        If text is new, create a fresh state.
        """
        if self.is_text_evolving(orig_text_string):
            # Text is evolving; update data but KEEP start_time
            self.pending_text_state['img'] = img.copy()
            self.pending_text_state['crop_coords'] = crop_coords
            self.pending_text_state['text'] = text
            self.pending_text_state['orig_text'] = orig_text_string
        else:
            # Completely new text state
            self.pending_text_state = {
                'text': text,
                'orig_text': orig_text_string,
                'start_time': current_time,
                'img': img.copy(),
                'crop_coords': crop_coords
            }
            run.set_last_image(img)
            
        # Track last non-empty text
        if text:
            self.last_non_empty_text = orig_text_string
            self.consecutive_empty_count = 0
    
    def queue_second_ocr(self, filtering, response_dict=None):
        """
        Queue the pending text for second OCR processing.
        Returns True if queued successfully, False otherwise.
        """
        if not self.pending_text_state:
            return False
            
        if compare_ocr_results(self.last_sent_result, self.pending_text_state['text'], 80):
            logger.debug("Skipping second OCR: text too similar to last sent")
            return False
            
        try:
            ocr2_image = get_ocr2_image(
                self.pending_text_state['crop_coords'],
                og_image=self.pending_text_state['img'],
                ocr2_engine=get_ocr_ocr2()
            )
            self.second_ocr_queue.put((
                self.pending_text_state['text'],
                self.pending_text_state['start_time'],
                ocr2_image,
                filtering,
                self.pending_text_state['img'],
                response_dict
            ))
            return True
        except Exception as e:
            logger.exception(f"Error queueing second OCR: {e}")
            return False
    
    def clear_pending_state(self):
        """Clear the pending text state after processing."""
        self.pending_text_state = None
        if self.force_stable:
            self.force_stable = False
            
    def handle_empty_ocr_result(self, filtering, response_dict=None) -> bool:
        """
        Handle when OCR returns empty.
        
        NEW BEHAVIOR: If we have pending text and get an empty result,
        immediately trigger second scan (the text has "stabilized" by disappearing
        or the game moved on).
        
        Returns True if second scan was triggered.
        """
        self.consecutive_empty_count += 1
        
        if self.pending_text_state:
            logger.debug(f"Empty OCR result with pending text, triggering second scan "
                        f"(consecutive empty: {self.consecutive_empty_count})")
            if self.queue_second_ocr(filtering, response_dict):
                self.clear_pending_state()
                return True
        
        return False
    
    def handle_meiki_stability(self, text, crop_coords, time, img, filtering, response_dict):
        """
        Handle Meiki (bounding box) stability checking for auto-detect mode.
        Returns True if the callback should return early.
        """
        try:
            if self.last_meiki_crop_coords is None:
                self.last_meiki_crop_coords = crop_coords
                self.last_meiki_crop_time = time
                self.previous_img = img.copy()
                return True

            if not crop_coords or not self.last_meiki_crop_coords:
                self.last_meiki_crop_coords = crop_coords
                self.last_meiki_crop_time = time
                return True

            tol = 5
            try:
                close = all(
                    abs(int(crop_coords[i]) - int(self.last_meiki_crop_coords[i])) <= tol 
                    for i in range(4)
                )
            except Exception:
                close = False
                
            if close:
                if self.last_meiki_success and all(
                    abs(int(crop_coords[i]) - int(self.last_meiki_success[i])) <= tol 
                    for i in range(4)
                ):
                    self.last_meiki_crop_coords = None
                    self.last_meiki_crop_time = None
                    return True
                
                try:
                    stable_time = self.last_meiki_crop_time
                    pre_crop_image = self.previous_img
                    ocr2_image = get_ocr2_image(
                        crop_coords, 
                        og_image=pre_crop_image, 
                        ocr2_engine=get_ocr_ocr2(), 
                        extra_padding=10
                    )
                    self.second_ocr_queue.put((
                        text, stable_time, ocr2_image, filtering, 
                        pre_crop_image, response_dict
                    ))
                    run.set_last_image(img)
                    self.last_meiki_success = crop_coords
                except Exception as e:
                    logger.info(f"Failed to queue second OCR task: {e}", exc_info=True)
                
                self.last_meiki_crop_coords = None
                self.last_meiki_crop_time = None
                return True
            else:
                self.last_meiki_crop_coords = crop_coords
                self.last_meiki_success = None
                self.previous_img = img.copy()
                return True
                
        except Exception as e:
            logger.debug(f"Error handling meiki crop coords stability check: {e}")
            self.last_meiki_crop_coords = crop_coords
            return False


# Global state manager instance
ocr_state = OCRStateManager()
_second_ocr_processor = None  # Lazy-loaded

def get_second_ocr_processor():
    """Get or create the second OCR processor (lazy-loaded to avoid GPU init at import)."""
    global _second_ocr_processor
    if _second_ocr_processor is None:
        _second_ocr_processor = OCRProcessor()
    return _second_ocr_processor

class ConfigChangeCheckThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.last_changes = None
        self.config_callbacks = []
        self.area_callbacks = []

    def run(self):
        global ocr_config
        while True:
            try:
                section_changed, changes = has_ocr_config_changed()
                if section_changed:
                    reload_electron_config()
                    self.last_changes = changes
                # Only run this block after a change has occurred and then the section is stable (no change)
                if self.last_changes is not None and not section_changed:
                    logger.info(f"Detected config changes: {self.last_changes}")
                    for cb in self.config_callbacks:
                        cb(self.last_changes)
                    if hasattr(run, 'handle_config_change'):
                        run.handle_config_change()
                    # Check for mode switch or config changes that need reset
                    mode_switched = '_mode_switched' in self.last_changes or 'advancedMode' in self.last_changes
                    config_needs_reset = any(c in self.last_changes for c in ('ocr1', 'ocr2', 'language', 'furigana_filter_sensitivity', 'basic', 'advanced'))
                    if mode_switched or config_needs_reset:
                        reset_callback_vars()
                        if mode_switched:
                            logger.info("Advanced mode toggled, resetting OCR state")
                    self.last_changes = None
                ocr_config_changed = has_config_changed(ocr_config)
                if ocr_config_changed:
                    logger.info("OCR config has changed, reloading...")
                    ocr_config = get_ocr_config(use_window_for_config=True, window=obs.get_current_game())
                    for cb in self.area_callbacks:
                        cb(ocr_config)
                    if hasattr(run, 'handle_area_config_changes'):
                        run.handle_area_config_changes(ocr_config)
                    reset_callback_vars()
            except Exception as e:
                logger.debug(f"ConfigChangeCheckThread error: {e}")
            time.sleep(0.5)

    def add_config_callback(self, callback):
        self.config_callbacks.append(callback)

    def add_area_callback(self, callback):
        self.area_callbacks.append(callback)
    
def reset_callback_vars():
    """Reset all OCR state variables via the state manager."""
    global ocr_state
    ocr_state.reset()
    run.set_last_image(None)


def ocr_result_callback(text, orig_text, time, img=None, came_from_ss=False, filtering=None, crop_coords=None, meiki_boxes=None, response_dict=None):
    """
    Main callback for OCR results. Uses OCRStateManager for all state tracking.
    
    Handles:
    - Direct screenshot mode (came_from_ss=True)
    - Meiki (bounding box) mode with stability checking
    - Manual mode (no two-pass OCR)
    - Two-pass OCR with intelligent triggering:
      * Text disappears
      * Force stable mode
      * Text completely changes
      * Empty OCR result with pending text
    """
    global ocr_state, second_ocr_queue

    # Ensure state manager has reference to queue
    ocr_state.second_ocr_queue = second_ocr_queue
    
    # Convert orig_text list to string for comparisons
    orig_text_string = ''.join([item for item in orig_text if item is not None]) if orig_text else ""
    current_time = time if time else datetime.now()

    # Handle direct screenshot mode - just send result immediately
    if came_from_ss:
        save_result_image(img)
        asyncio.run(send_result(text, current_time))
        ocr_state.clear_pending_state()
        return

    # Handle Meiki (auto-detect bounding box) mode
    if meiki_boxes:
        if ocr_state.handle_meiki_stability(text, crop_coords, time, img, filtering, response_dict):
            return

    # Update last image for empty results (for debugging/display)
    if not text:
        run.set_last_image(img)

    # Manual mode or two-pass OCR disabled - send directly
    if manual or not get_ocr_two_pass_ocr():
        if compare_ocr_results(ocr_state.last_sent_result, text, 80):
            return
        save_result_image(img)
        asyncio.run(send_result(text, current_time))
        ocr_state.last_sent_result = text
        ocr_state.clear_pending_state()
        return

    # ===== Two-Pass OCR Logic =====
    
    # Check if we should trigger second scan
    should_process = ocr_state.should_trigger_second_scan(text, orig_text_string)
    
    # NEW: Also trigger if we get empty text when we have pending text
    # This handles the case where OCR "clears" before getting same text again
    if not should_process and not text and ocr_state.pending_text_state:
        should_process = True
        logger.debug("Triggering second scan: empty result with pending text")
    
    if should_process:
        ocr_state.queue_second_ocr(filtering, response_dict)
        ocr_state.clear_pending_state()

    # If we have text, update or create pending state
    if text:
        ocr_state.update_pending_state(text, orig_text_string, current_time, img, crop_coords)

done = False

# Create a queue for tasks
second_ocr_queue = queue.Queue()

def get_ocr2_image(crop_coords, og_image: Image.Image, ocr2_engine=None, extra_padding=0):
    """
    Returns the image to use for the second OCR pass, cropping and scaling as needed.
    Logic is unchanged, but code is refactored for clarity and maintainability.
    """
    def return_original_image():
        """Return a (possibly cropped) PIL.Image based on the original image and padding."""
        # Convert bytes to PIL.Image if necessary
        img = og_image
        if isinstance(og_image, (bytes, bytearray)):
            try:
                img = Image.open(io.BytesIO(og_image)).convert('RGB')
            except Exception:
                # If conversion fails, just return og_image as-is
                return og_image

        if not crop_coords or not get_ocr_optimize_second_scan():
            return img

        x1, y1, x2, y2 = crop_coords
        # Apply integer padding (can be negative to shrink)
        pad = int(extra_padding or 0)
        x1 = x1 - pad
        y1 = y1 - pad
        x2 = x2 + pad
        y2 = y2 + pad

        # Clamp coordinates to image bounds
        x1 = min(max(0, int(x1)), img.width)
        y1 = min(max(0, int(y1)), img.height)
        x2 = min(max(0, int(x2)), img.width)
        y2 = min(max(0, int(y2)), img.height)

        # Ensure at least a 1-pixel width/height
        if x2 <= x1:
            x2 = min(img.width, x1 + 1)
            x1 = max(0, x2 - 1)
        if y2 <= y1:
            y2 = min(img.height, y1 + 1)
            y1 = max(0, y2 - 1)
            
        # Turning off debug
        # try:
        #     img.save(os.path.join(get_temporary_directory(), "pre_oneocrcrop.png"))
        # except Exception:
        #     # don't fail just because we couldn't save a debug image
        #     logger.debug("Could not save pre_oneocrcrop.png for debugging")
        return img.crop((x1, y1, x2, y2))
    
    # TODO Get rid of this check, and just always convert to full res
    LOCAL_OCR_ENGINES = ['easyocr', 'oneocr', 'rapidocr', 'mangaocr', 'winrtocr']
    local_ocr = ocr2_engine in LOCAL_OCR_ENGINES
    ocr_config_local = copy(ocr_config)

    # Non-local OCR: just crop the original image if needed
    if not local_ocr:
        return return_original_image()

    # Local OCR: get fresh screenshot and apply config/cropping
    obs_width = getattr(run.obs_screenshot_thread, 'width', None)
    obs_height = getattr(run.obs_screenshot_thread, 'height', None)
    if not obs_width or not obs_height:
        return return_original_image()
    
    logger.debug(f"Getting OCR2 image with OBS dimensions: {obs_width}x{obs_height}")

    img = obs.get_screenshot_PIL(compression=100, img_format="jpg")
    
    ocr_config_local.scale_to_custom_size(img.width, img.height)
    
    # If img.width and height is the same as obs, no need to scale coords, tolerance of .1%
    if abs(img.width - obs_width) <= 0.1 * obs_width and abs(img.height - obs_height) <= 0.1 * obs_height:
        logger.info("Image size matches OBS size, no need to scale coordinates.")
        return return_original_image()

    # If no crop or optimization, just apply config and return
    if not crop_coords or not get_ocr_optimize_second_scan():
        img, _ = run.apply_ocr_config_to_image(img, ocr_config_local, is_secondary=False, return_full_size=False)
        return img

    # Calculate scaling ratios
    width_ratio = img.width / obs_width if obs_width else 1
    height_ratio = img.height / obs_height if obs_height else 1
    logger.debug(f"Cropping OCR2 image with crop coordinates: {crop_coords} and ratios: {width_ratio}, {height_ratio}")

    # Scale crop_coords
    x1 = int(crop_coords[0] * width_ratio)
    y1 = int(crop_coords[1] * height_ratio)
    x2 = int(crop_coords[2] * width_ratio)
    y2 = int(crop_coords[3] * height_ratio)

    # Scale padding separately for X and Y
    pad_x = int(round((extra_padding or 0) * width_ratio))
    pad_y = int(round((extra_padding or 0) * height_ratio))

    x1 = x1 - pad_x
    y1 = y1 - pad_y
    x2 = x2 + pad_x
    y2 = y2 + pad_y

    # Clamp coordinates to image bounds
    x1 = min(max(0, int(x1)), img.width)
    y1 = min(max(0, int(y1)), img.height)
    x2 = min(max(0, int(x2)), img.width)
    y2 = min(max(0, int(y2)), img.height)

    # Ensure at least a 1-pixel width/height
    if x2 <= x1:
        x2 = min(img.width, x1 + 1)
        x1 = max(0, x2 - 1)
    if y2 <= y1:
        y2 = min(img.height, y1 + 1)
        y1 = max(0, y2 - 1)

    logger.debug(f"Scaled crop coordinates: {(x1, y1, x2, y2)}")

    img, _ = run.apply_ocr_config_to_image(img, ocr_config_local, is_secondary=False)

    ret = img.crop((x1, y1, x2, y2))
    return ret

def process_task_queue():
    while True:
        try:
            task = second_ocr_queue.get()
            if task is None:  # Exit signal
                break
            ignore_furigana_filter = False
            ignore_previous_result = False
            response_dict = None
            task = (list(task) + [None]*8)[:8]
            ocr1_text, stable_time, previous_img_local, filtering, pre_crop_image, ignore_furigana_filter, ignore_previous_result, response_dict = task
            get_second_ocr_processor().do_second_ocr(ocr1_text, stable_time, previous_img_local, filtering, pre_crop_image, ignore_furigana_filter, ignore_previous_result, response_dict)
        except Exception as e:
            logger.exception(f"Error processing task: {e}")
        finally:
            second_ocr_queue.task_done()


def run_oneocr(ocr_config: OCRConfig, rectangles, config_check_thread):
    global done
    screen_area = None
    screen_areas = [",".join(str(c) for c in rect_config.coordinates) for rect_config in rectangles if not rect_config.is_excluded]
    exclusions = list(rect.coordinates for rect in list(filter(lambda x: x.is_excluded, rectangles)))

    run.init_config(False)
    try:
        read_from = ""
        if obs_ocr:
            read_from = "obs"
        elif window:
            read_from = "screencapture"
        read_from_secondary = "clipboard" if ss_clipboard else None
        run.run(read_from=read_from,
                read_from_secondary=read_from_secondary,
                write_to="callback",
                screen_capture_area=screen_area,
                # screen_capture_monitor=monitor_config['index'],
                screen_capture_window=ocr_config.window if ocr_config and ocr_config.window else None,
                screen_capture_delay_secs=get_ocr_scan_rate(), engine=ocr1,
                text_callback=ocr_result_callback,
                screen_capture_exclusions=exclusions,
                monitor_index=None,
                ocr1=ocr1,
                ocr2=ocr2,
                gsm_ocr_config=ocr_config,
                screen_capture_areas=screen_areas,
                furigana_filter_sensitivity=furigana_filter_sensitivity,
                screen_capture_combo=manual_ocr_hotkey.upper() if manual_ocr_hotkey and manual else None,
                config_check_thread=config_check_thread,
                combo_pause=global_pause_hotkey,
                disable_user_input=True,  # Disable stdin user input to avoid conflicts with IPC
                logger_level='INFO')  # Set logger level to INFO to suppress DEBUG messages
    except Exception as e:
        logger.exception(f"Error running OneOCR: {e}")
    done = True
    # Quit Qt app if running
    try:
        from PyQt6.QtWidgets import QApplication
        app = QApplication.instance()
        if app:
            app.quit()
    except Exception:
        pass


def add_ss_hotkey(ss_hotkey="ctrl+shift+g"):
    import keyboard
    
    # We'll create the signal helper when the Qt app is available
    global _screen_cropper_signals

    def ocr_secondary_rectangles():
        logger.info("Running secondary OCR rectangles...")
        ocr_config = get_ocr_config()
        img = obs.get_screenshot_PIL(compression=80, img_format="jpg")
        ocr_config.scale_to_custom_size(img.width, img.height)
        # for rectangle in [rectangle for rectangle in ocr_config.rectangles if rectangle.is_secondary]:
        has_secondary_rectangles = any(rectangle.is_secondary for rectangle in ocr_config.rectangles)
        if has_secondary_rectangles:
            img, _ = run.apply_ocr_config_to_image(img, ocr_config, is_secondary=True)
        get_second_ocr_processor().do_second_ocr("", datetime.now(), img, TextFiltering(lang=get_ocr_language()), ignore_furigana_filter=True, ignore_previous_result=True)

    filtering = TextFiltering(lang=get_ocr_language())
    
    def capture():
        from GameSentenceMiner.ui.qt_main import launch_screen_cropper
        print("Taking screenshot via screen cropper...")
        
        # Use the dialog manager's synchronous method
        cropped_img = launch_screen_cropper(transparent_mode=False)
        
        global second_ocr_queue
        if cropped_img:
            second_ocr_queue.put(("", datetime.now(), cropped_img, filtering, None, True, True))
        else:
            logger.info("Screen cropper cancelled")
    def capture_main_monitor():
        print("Taking screenshot of main monitor...")
        with mss.mss() as sct:
            main_monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            img = sct.grab(main_monitor)
            img_bytes = mss.tools.to_png(img.rgb, img.size)
            get_second_ocr_processor().do_second_ocr("", datetime.now(), img_bytes, filtering, ignore_furigana_filter=True, ignore_previous_result=True)
    hotkey_reg = None
    secondary_hotkey_reg = None
    try:
        hotkey_reg = keyboard.add_hotkey(ss_hotkey, capture)
        if not manual:
            secondary_hotkey_reg = keyboard.add_hotkey(get_ocr_manual_ocr_hotkey().lower(), ocr_secondary_rectangles)
        print(f"Press {ss_hotkey} to take a screenshot.")
    except Exception as e:
        if hotkey_reg:
            keyboard.remove_hotkey(hotkey_reg)
        if secondary_hotkey_reg:
            keyboard.remove_hotkey(secondary_hotkey_reg)
        logger.error(f"Error setting up screenshot hotkey with keyboard, Attempting Backup: {e}")
        logger.debug(e)
        pynput_hotkey = ss_hotkey.replace("ctrl", "<ctrl>").replace("shift", "<shift>").replace("alt", "<alt>")
        secondary_ss_hotkey = get_ocr_manual_ocr_hotkey().lower().replace("ctrl", "<ctrl>").replace("shift", "<shift>").replace("alt", "<alt>")
        try:
            from pynput import keyboard as pynput_keyboard
            listener = pynput_keyboard.GlobalHotKeys({
                pynput_hotkey: capture,
                secondary_ss_hotkey: ocr_secondary_rectangles,
            })
            listener.start()
            print(f"Press {pynput_hotkey} to take a screenshot.")
        except Exception as e:
            logger.error(f"Error setting up screenshot hotkey with pynput, Screenshot Hotkey Will not work: {e}")

def set_force_stable_hotkey():
    import keyboard
    global ocr_state
    
    def toggle_force_stable():
        global ocr_state
        is_stable = ocr_state.toggle_force_stable()
        if is_stable:
            print("Force stable mode enabled.")
        else:
            print("Force stable mode disabled.")
    
    keyboard.add_hotkey('p', toggle_force_stable)
    print("Press Ctrl+Shift+F to toggle force stable mode.")

if __name__ == "__main__":
    try:
        global ocr1, ocr2, twopassocr, language, ss_clipboard, ss, ocr_config, furigana_filter_sensitivity, area_select_ocr_hotkey, window, optimize_second_scan, use_window_for_config, keep_newline, obs_ocr, manual, settings_window, global_pause_hotkey
        import sys

        import argparse

        parser = argparse.ArgumentParser(description="OCR Configuration")
        parser.add_argument("--language", type=str, default="ja", help="Language for OCR (default: ja)")
        parser.add_argument("--ocr1", type=str, default="oneocr", help="Primary OCR engine (default: oneocr)")
        parser.add_argument("--ocr2", type=str, default="glens", help="Secondary OCR engine (default: glens)")
        parser.add_argument("--twopassocr", type=int, choices=[0, 1], default=1,
                            help="Enable two-pass OCR (default: 1)")
        parser.add_argument("--manual", action="store_true", help="Use screenshot-only mode")
        parser.add_argument("--clipboard", action="store_true", help="Use clipboard for input")
        parser.add_argument("--clipboard-output", action="store_true", default=False, help="Use clipboard for output")
        parser.add_argument("--window", type=str, help="Specify the window name for OCR")
        parser.add_argument("--furigana_filter_sensitivity", type=float, default=0,
                            help="Furigana Filter Sensitivity for OCR (default: 0)")
        parser.add_argument("--manual_ocr_hotkey", type=str, default=None, help="Hotkey for manual OCR (default: None)")
        parser.add_argument("--area_select_ocr_hotkey", type=str, default="ctrl+shift+o",
                            help="Hotkey for area selection OCR (default: ctrl+shift+o)")
        parser.add_argument("--optimize_second_scan", action="store_true",
                            help="Optimize second scan by cropping based on first scan results")
        parser.add_argument("--use_window_for_config", action="store_true",
                            help="Use the specified window for loading OCR configuration")
        parser.add_argument("--keep_newline", action="store_true", help="Keep new lines in OCR output")
        parser.add_argument('--obs_ocr', action='store_true', help='Use OBS for Picture Source (not implemented)')
        parser.add_argument("--global_pause_hotkey", type=str, default="ctrl+shift+p",
                            help="Hotkey to pause/resume OCR scanning (default: ctrl+shift+p)")

        args = parser.parse_args()

        language = args.language
        ocr1 = args.ocr1
        ocr2 = args.ocr2 if args.ocr2 else None
        twopassocr = bool(args.twopassocr)
        manual = args.manual
        ss_clipboard = args.clipboard
        window_name = args.window
        furigana_filter_sensitivity = args.furigana_filter_sensitivity
        ss_hotkey = args.area_select_ocr_hotkey.lower()
        manual_ocr_hotkey = args.manual_ocr_hotkey.lower().replace("ctrl", "<ctrl>").replace("shift",
                                                                                             "<shift>").replace(
            "alt", "<alt>") if args.manual_ocr_hotkey else None
        clipboard_output = args.clipboard_output
        optimize_second_scan = args.optimize_second_scan
        use_window_for_config = args.use_window_for_config
        keep_newline = args.keep_newline
        obs_ocr = args.obs_ocr
        global_pause_hotkey = args.global_pause_hotkey.lower() if args.global_pause_hotkey else "ctrl+shift+p"
        
        obs.connect_to_obs_sync(check_output=False)
    
        # Start config change checker thread
        config_check_thread = ConfigChangeCheckThread()
        config_check_thread.start()
        # Example: add a callback to config_check_thread if needed
        # config_check_thread.add_callback(lambda: print("Config changed!"))

        window = None
        logger.info(f"Received arguments: {vars(args)}")
        # set_force_stable_hotkey()
        ocr_config: OCRConfig = get_ocr_config(window=window_name, use_window_for_config=use_window_for_config)
        if ocr_config and not obs_ocr:
            if ocr_config.window:
                start_time = time.time()
                while time.time() - start_time < 30:
                    window = get_window(ocr_config.window)
                    if window or manual:
                        if window:
                            ocr_config.scale_coords()
                        break
                    logger.background(f"Window: {ocr_config.window} Could not be found, retrying in 1 second...")
                    time.sleep(1)
                else:
                    logger.error(f"Window '{ocr_config.window}' not found within 30 seconds.")
                    sys.exit(1)
            logger.info(
                f"Starting OCR with configuration: Window: {ocr_config.window}, Rectangles: {ocr_config.rectangles}, Engine 1: {ocr1}, Engine 2: {ocr2}, Two-pass OCR: {twopassocr}")
        set_dpi_awareness()
        if manual or ocr_config:
            rectangles = ocr_config.rectangles if ocr_config and ocr_config.rectangles else []
            oneocr_threads = []
            ocr_thread = threading.Thread(target=run_oneocr, args=(ocr_config, rectangles, config_check_thread), daemon=True)
            ocr_thread.start()
            # Always start worker thread to process manual screenshots from screen cropper
            worker_thread = threading.Thread(target=process_task_queue, daemon=True)
            worker_thread.start()
            
            # Start IPC listener for Electron communication
            ocr_ipc.register_command_handler(handle_ipc_command)
            ocr_ipc.start_ipc_listener()
            ocr_ipc.announce_started()
            logger.info("OCR IPC communication initialized")
            
            # Keep websocket for backward compatibility with texthooker page
            websocket_server_thread = WebsocketServerThread(read=True)
            websocket_server_thread.start()
            
            if is_windows():
                add_ss_hotkey(ss_hotkey)
            try:
                # Run Qt event loop instead of sleep loop - this allows Qt dialogs to work
                import GameSentenceMiner.ui.qt_main as qt_main
                settings_window = qt_main.get_config_window()
                qt_main.start_qt_app(show_config_immediately=False)
            except KeyboardInterrupt:
                pass
        else:
            print("Failed to load OCR configuration. Please check the logs.")
    except Exception as e:
        logger.info(e, exc_info=True)
        logger.debug(e, exc_info=True)
        logger.info("Closing in 5 seconds...")
        time.sleep(5)
