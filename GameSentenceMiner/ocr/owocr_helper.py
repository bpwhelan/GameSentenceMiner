import asyncio
import io
import json
import mss
import mss.tools
import os
import queue
import threading
import time
import websockets
from PIL import Image
from copy import copy
from datetime import datetime
from pathlib import Path
import multiprocessing as mp
import sys
from rapidfuzz import fuzz

from GameSentenceMiner import obs
from GameSentenceMiner.ocr.gsm_ocr_config import OCRConfig, has_config_changed, set_dpi_awareness, get_window
from GameSentenceMiner.ocr.gsm_ocr_config import get_ocr_config
from GameSentenceMiner.owocr.owocr import run
from GameSentenceMiner.owocr.owocr.run import TextFiltering
from GameSentenceMiner.util.communication import ocr_ipc
from GameSentenceMiner.util.config.configuration import get_config, get_temporary_directory, is_windows, is_beangate
from GameSentenceMiner.util.config.electron_config import get_ocr_ocr2, get_ocr_send_to_clipboard, get_ocr_scan_rate, \
    has_ocr_config_changed, reload_electron_config, get_ocr_two_pass_ocr, get_ocr_optimize_second_scan, \
    get_ocr_language, get_ocr_manual_ocr_hotkey, get_ocr_ocr1
# Use centralized loguru logger
from GameSentenceMiner.util.logging_config import logger
from GameSentenceMiner.util.text_log import TextSource

CONFIG_FILE = Path("ocr_config.json")
DEFAULT_IMAGE_PATH = r"C:\Users\Beangate\Pictures\msedge_acbl8GL7Ax.jpg"  # CHANGE THIS

websocket_server_thread = None
websocket_queue = queue.Queue()
paused = False

if os.name == "nt":
    # Ensure multiprocessing child workers reuse the current launched executable path.
    try:
        mp.set_executable(sys.executable)
    except Exception:
        pass


# IPC command handlers
# These commands are sent from Electron via stdin using OCRCMD: prefix
# Available commands defined in ocr_ipc.OCRCommand enum

def _normalize_command_data(cmd_data: dict) -> tuple[str, dict, str | None]:
    command = cmd_data.get('command', '').lower()
    cmd_id = cmd_data.get('id')
    data = cmd_data.get('data', {})
    if not isinstance(data, dict):
        data = {}
    # Backward-compat: allow legacy top-level fields like "state"/"enabled".
    for key in ("state", "enabled"):
        if key in cmd_data and key not in data:
            data[key] = cmd_data[key]
    return command, data, cmd_id


def _handle_command(cmd_data: dict, *, announce_ipc: bool) -> dict:
    """
    Handle IPC/remote commands.
    Commands follow format: {"command": <name>, "data": {...}, "id": optional}
    Returns a response dict with 'success' and optionally 'data' or 'error'.
    """
    global ocr_state

    response = {"success": False, "command": None}
    try:
        command, data, cmd_id = _normalize_command_data(cmd_data)
        response["command"] = command
        if cmd_id is not None:
            response["id"] = cmd_id

        if not hasattr(run, "paused"):
            run.paused = False

        if command == ocr_ipc.OCRCommand.PAUSE.value:
            # Legacy behavior: if "state" is provided, set it; otherwise toggle.
            if "state" in data:
                new_state = bool(data.get("state"))
                if run.paused != new_state:
                    run.pause_handler(is_combo=False)
            else:
                run.pause_handler(is_combo=False)
            response["success"] = True
            response["paused"] = run.paused
            logger.info(f"Remote control: {'Paused' if run.paused else 'Unpaused'} OCR")
            if announce_ipc:
                if run.paused:
                    ocr_ipc.announce_paused()
                else:
                    ocr_ipc.announce_unpaused()

        elif command == ocr_ipc.OCRCommand.UNPAUSE.value:
            if run.paused:
                run.pause_handler(is_combo=False)
            response["success"] = True
            response["paused"] = run.paused
            logger.info("IPC: Unpaused OCR")
            if announce_ipc:
                ocr_ipc.announce_unpaused()

        elif command == ocr_ipc.OCRCommand.TOGGLE_PAUSE.value:
            run.pause_handler(is_combo=False)
            response["success"] = True
            response["paused"] = run.paused
            logger.info(f"IPC: Toggled to {'paused' if run.paused else 'unpaused'}")
            if announce_ipc:
                if run.paused:
                    ocr_ipc.announce_paused()
                else:
                    ocr_ipc.announce_unpaused()

        elif command == ocr_ipc.OCRCommand.GET_STATUS.value:
            status_data = {
                "paused": run.paused,
                "current_engine": run.engine_instances[run.engine_index].readable_name if hasattr(run, 'engine_instances') and run.engine_instances else "unknown",
                "scan_rate": get_ocr_scan_rate(),
                "force_stable": ocr_state.force_stable if ocr_state else False,
                "manual": globals().get("manual", False),
            }
            response["success"] = True
            response["data"] = status_data
            if announce_ipc:
                ocr_ipc.announce_status(status_data)

        elif command == ocr_ipc.OCRCommand.MANUAL_OCR.value:
            if hasattr(run, 'screenshot_event') and run.screenshot_event:
                run.screenshot_event.set()
                response["success"] = True
                logger.info("IPC: Triggered manual OCR")
            else:
                response["error"] = "Screenshot event not available"
                logger.error("IPC: Screenshot event not available")
                if announce_ipc:
                    ocr_ipc.announce_error("Screenshot event not available")

        elif command == ocr_ipc.OCRCommand.TOGGLE_FORCE_STABLE.value:
            is_stable = ocr_state.toggle_force_stable()
            response["success"] = True
            response["data"] = {"enabled": is_stable}
            logger.info(f"IPC: Force stable mode {'enabled' if is_stable else 'disabled'}")
            if announce_ipc:
                ocr_ipc.announce_force_stable_changed(is_stable)

        elif command == ocr_ipc.OCRCommand.SET_FORCE_STABLE.value:
            enabled = bool(data.get('enabled', False))
            ocr_state.set_force_stable(enabled)
            response["success"] = True
            response["data"] = {"enabled": enabled}
            logger.info(f"IPC: Set force stable mode to {enabled}")
            if announce_ipc:
                ocr_ipc.announce_force_stable_changed(enabled)

        elif command == ocr_ipc.OCRCommand.RELOAD_CONFIG.value:
            logger.info("IPC: Config reload requested")
            apply_ipc_config_reload(data)
            response["success"] = True
            if announce_ipc:
                ocr_ipc.announce_config_reloaded()

        elif command == ocr_ipc.OCRCommand.STOP.value:
            logger.info("IPC: Stop command received")
            response["success"] = True
            if announce_ipc:
                ocr_ipc.announce_stopped()
            # Let the process exit naturally

        else:
            response["error"] = f"Unknown command: {command}"

    except Exception as e:
        logger.exception(f"Error handling command: {e}")
        response["error"] = str(e)
        if announce_ipc:
            ocr_ipc.announce_error(str(e))

    return response


def handle_ipc_command(cmd_data: dict) -> dict:
    """Handle IPC commands sent from Electron via stdin."""
    return _handle_command(cmd_data, announce_ipc=True)


def handle_websocket_command(message_str: str) -> dict | None:
    """Handle websocket commands (legacy remote control)."""
    try:
        cmd_data = json.loads(message_str)
    except json.JSONDecodeError:
        return None

    if not isinstance(cmd_data, dict):
        return { "success": False, "error": "Invalid json" }
        
    if 'command' not in cmd_data:
        return { "success": False, "error": "No command specified" }

    return _handle_command(cmd_data, announce_ipc=False)


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
                command_response = handle_websocket_command(message)
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

    async def send_text(self, text, line_time: datetime, response_dict=None, source=TextSource.OCR):
        if text:
            data = {"sentence": text, "time": line_time.isoformat(
            ), "process_path": obs.get_current_game(), "source": source}
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
        prev_text = ''.join(
            [item for item in prev_text if item is not None]) if prev_text else ""
    if isinstance(new_text, list):
        new_text = ''.join(
            [item for item in new_text if item is not None]) if new_text else ""
    similarity = fuzz.ratio(prev_text, new_text)
    return similarity >= threshold


all_cords = None
rectangles = None


class OCRProcessor():
    def __init__(self):
        self.filtering = TextFiltering(lang=get_ocr_language())

    def _prepare_beangate_secondary_ocr2_image(self, img, ignore_furigana_filter=False):
        """
        Beangate-only local->trim->ocr2 flow for secondary OCR.
        Runs configured OCR1 locally, then trims to detected crop coords for OCR2.
        """
        if not is_beangate:
            return img

        local_engine_name = get_ocr_ocr1()
        if not local_engine_name:
            return img

        local_engine = None
        for instance in getattr(run, "engine_instances", []) or []:
            name = getattr(instance, "name", "")
            if local_engine_name.lower() in name.lower() or name.lower() in local_engine_name.lower():
                local_engine = instance
                break

        if not local_engine:
            logger.debug(
                f"Beangate secondary OCR pre-pass skipped: OCR1 engine '{local_engine_name}' not initialized.")
            return img

        local_img = img
        if isinstance(img, (bytes, bytearray)):
            try:
                local_img = Image.open(io.BytesIO(img)).convert('RGB')
            except Exception:
                return img

        try:
            local_result = local_engine(
                local_img,
                furigana_filter_sensitivity if not ignore_furigana_filter else 0
            )
            success, _text, _coords, _crop_coords_list, crop_coords, _response_dict = (list(local_result) + [None] * 6)[:6]
            if not success or not crop_coords:
                return local_img
            return get_ocr2_image(
                crop_coords,
                og_image=local_img,
                ocr2_engine=get_ocr_ocr2()
            )
        except Exception as e:
            logger.debug(f"Beangate secondary OCR pre-pass failed; using untrimmed image: {e}")
            return local_img

    def do_second_ocr(self, ocr1_text, time, img, filtering, pre_crop_image=None, ignore_furigana_filter=False, ignore_previous_result=False, response_dict=None, source=TextSource.OCR):
        global ocr_state
        try:
            ocr2_input_img = img
            if source == TextSource.SECONDARY and is_beangate:
                ocr2_input_img = self._prepare_beangate_secondary_ocr2_image(
                    img,
                    ignore_furigana_filter=ignore_furigana_filter
                )

            orig_text, text = run.process_and_write_results(
                ocr2_input_img, None,
                ocr_state.last_ocr2_result if not ignore_previous_result else None,
                self.filtering, None,
                engine=get_ocr_ocr2(),
                furigana_filter_sensitivity=furigana_filter_sensitivity if not ignore_furigana_filter else 0
            )

            if compare_ocr_results(ocr_state.last_sent_result, text, threshold=80):
                if text:
                    logger.background("Duplicate text detected, skipping.")
                return
            save_result_image(ocr2_input_img, pre_crop_image=pre_crop_image)
            ocr_state.last_ocr2_result = orig_text
            ocr_state.last_sent_result = text
            asyncio.run(send_result(
                text, time, response_dict=response_dict, source=source))
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
            img.save(os.path.join(get_temporary_directory(),
                     "last_successful_ocr.png"))
            if pre_crop_image:
                pre_crop_image.save(os.path.join(
                    get_temporary_directory(), "last_successful_ocr_precrop.png"))
    except Exception as e:
        logger.debug(f"Error saving debug result image: {e}")


async def send_result(text, time, response_dict=None, source=TextSource.OCR):
    if text:
        if get_ocr_send_to_clipboard():
            import pyperclipfix
            # TODO Test this out and see if i can make it work properly across platforms
            # from GameSentenceMiner.ui.qt_main import send_to_clipboard
            # send_to_clipboard(text)
            pyperclipfix.copy(text)
        try:
            await websocket_server_thread.send_text(text, time, response_dict=response_dict, source=source)
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
        is_low_similarity = not compare_ocr_results(
            p_orig_text, orig_text_string, 20)

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

        # Track last non-empty text
        if text:
            self.last_non_empty_text = orig_text_string
            self.consecutive_empty_count = 0

    def queue_second_ocr(self, filtering, response_dict=None, source=TextSource.OCR):
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
                response_dict,
                source
            ))
            # Only mark the last image once second-pass is queued (prevents early "identical" sleeps).
            run.set_last_image(self.pending_text_state['img'])
            return True
        except Exception as e:
            logger.exception(f"Error queueing second OCR: {e}")
            return False

    def clear_pending_state(self):
        """Clear the pending text state after processing."""
        self.pending_text_state = None
        if self.force_stable:
            self.force_stable = False

    def handle_empty_ocr_result(self, filtering, response_dict=None, source=TextSource.OCR) -> bool:
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
            if self.queue_second_ocr(filtering, response_dict, source=source):
                self.clear_pending_state()
                return True

        return False

    def handle_meiki_stability(self, text, crop_coords, time, img, filtering, response_dict, source=TextSource.OCR):
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
                    abs(int(crop_coords[i]) -
                        int(self.last_meiki_crop_coords[i])) <= tol
                    for i in range(4)
                )
            except Exception:
                close = False

            if close:
                if self.last_meiki_success and all(
                    abs(int(crop_coords[i]) -
                        int(self.last_meiki_success[i])) <= tol
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
                        pre_crop_image, response_dict, source
                    ))
                    self.last_meiki_success = crop_coords
                except Exception as e:
                    logger.info(
                        f"Failed to queue second OCR task: {e}", exc_info=True)

                self.last_meiki_crop_coords = None
                self.last_meiki_crop_time = None
                return True
            else:
                self.last_meiki_crop_coords = crop_coords
                self.last_meiki_success = None
                self.previous_img = img.copy()
                return True

        except Exception as e:
            logger.debug(
                f"Error handling meiki crop coords stability check: {e}")
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


def apply_ipc_config_reload(data: dict | None = None) -> None:
    """
    Reload OCR configs based on an IPC request from Electron.
    data can include:
      - reload_electron: bool (default True)
      - reload_area: bool (default True)
      - changes: dict (optional precomputed config diffs)
    """
    global ocr_config

    payload = data or {}
    reload_electron = payload.get('reload_electron', True)
    reload_area = payload.get('reload_area', True)
    changes = payload.get('changes')

    if reload_electron:
        if changes is None:
            section_changed, changes = has_ocr_config_changed()
        else:
            section_changed = True

        if section_changed:
            reload_electron_config()
            logger.info(f"IPC: OCR config changes applied: {changes}")
            mode_switched = '_mode_switched' in changes or 'advancedMode' in changes
            config_needs_reset = any(c in changes for c in (
                'ocr1', 'ocr2', 'language', 'furigana_filter_sensitivity', 'basic', 'advanced'))
            if config_needs_reset:
                try:
                    run.engine_change_handler_name(get_ocr_ocr1(), switch=True)
                    run.engine_change_handler_name(
                        get_ocr_ocr2(), switch=False)
                    run.set_ocr_engines(get_ocr_ocr1(), get_ocr_ocr2())
                except Exception as e:
                    logger.debug(
                        f"IPC: Failed to update OCR engines after config change: {e}")
            if mode_switched or config_needs_reset:
                reset_callback_vars()
                if mode_switched:
                    logger.info("Advanced mode toggled, resetting OCR state")

    if reload_area:
        try:
            ocr_config_changed = ocr_config is None or has_config_changed(
                ocr_config)
            if ocr_config_changed:
                logger.info("IPC: OCR area config changed, reloading...")
                ocr_config = get_ocr_config(
                    use_window_for_config=True, window=obs.get_current_game())
                if hasattr(run, 'screenshot_thread') and run.screenshot_thread:
                    run.screenshot_thread.ocr_config = ocr_config
                if hasattr(run, 'obs_screenshot_thread') and run.obs_screenshot_thread:
                    run.obs_screenshot_thread.init_config()
                reset_callback_vars()
        except Exception as e:
            logger.debug(f"IPC: Error reloading OCR area config: {e}")


def reset_callback_vars():
    """Reset all OCR state variables via the state manager."""
    global ocr_state
    ocr_state.reset()


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
    orig_text_string = ''.join(
        [item for item in orig_text if item is not None]) if orig_text else ""
    current_time = time if time else datetime.now()

    line_source = TextSource.OCR_MANUAL if manual else TextSource.OCR

    # Handle direct screenshot mode - just send result immediately
    if came_from_ss:
        save_result_image(img)
        asyncio.run(send_result(text, current_time, source=line_source))
        ocr_state.clear_pending_state()
        return

    # Handle Meiki (auto-detect bounding box) mode
    if meiki_boxes:
        if ocr_state.handle_meiki_stability(text, crop_coords, time, img, filtering, response_dict, source=line_source):
            return

    # Manual mode or two-pass OCR disabled - send directly
    if manual or not get_ocr_two_pass_ocr():
        if compare_ocr_results(ocr_state.last_sent_result, text, 80):
            return
        save_result_image(img)
        asyncio.run(send_result(text, current_time, source=line_source))
        run.set_last_image(img)
        ocr_state.last_sent_result = text
        ocr_state.clear_pending_state()
        return

    # ===== Two-Pass OCR Logic =====

    # Check if we should trigger second scan
    should_process = ocr_state.should_trigger_second_scan(
        text, orig_text_string)

    # NEW: Also trigger if we get empty text when we have pending text
    # This handles the case where OCR "clears" before getting same text again
    if not should_process and not text and ocr_state.pending_text_state:
        should_process = True
        logger.debug("Triggering second scan: empty result with pending text")

    if should_process:
        ocr_state.queue_second_ocr(
            filtering, response_dict, source=line_source)
        ocr_state.clear_pending_state()

    # If we have text, update or create pending state
    if text:
        ocr_state.update_pending_state(
            text, orig_text_string, current_time, img, crop_coords)


done = False

# Create a queue for tasks
second_ocr_queue = queue.Queue()


def get_ocr2_image(crop_coords, og_image: Image.Image, ocr2_engine=None, extra_padding=0):
    """
    Returns the image to use for the second OCR pass, cropping with optional padding.
    Simplified to only handle trimming/cropping the original image.
    """
    # Convert bytes to PIL.Image if necessary
    img = og_image
    if isinstance(og_image, (bytes, bytearray)):
        try:
            img = Image.open(io.BytesIO(og_image)).convert('RGB')
        except Exception:
            # If conversion fails, just return og_image as-is
            return og_image

    # If no crop coords or optimization disabled, return full image
    if not crop_coords or not get_ocr_optimize_second_scan():
        return img

    # Apply cropping with padding
    x1, y1, x2, y2 = crop_coords
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

    return img.crop((x1, y1, x2, y2))


def process_task_queue():
    while True:
        try:
            task = second_ocr_queue.get()
            if task is None:  # Exit signal
                break
            ignore_furigana_filter = False
            ignore_previous_result = False
            response_dict = None
            task = (list(task) + [None]*9)[:9]
            ocr1_text, stable_time, previous_img_local, filtering, pre_crop_image, ignore_furigana_filter, ignore_previous_result, response_dict, source = task
            get_second_ocr_processor().do_second_ocr(
                ocr1_text,
                stable_time,
                previous_img_local,
                filtering,
                pre_crop_image,
                ignore_furigana_filter,
                ignore_previous_result,
                response_dict,
                source=source or TextSource.OCR
            )
        except Exception as e:
            logger.exception(f"Error processing task: {e}")
        finally:
            second_ocr_queue.task_done()


def run_oneocr(ocr_config: OCRConfig, rectangles):
    global done
    screen_area = None
    screen_areas = [",".join(str(c) for c in rect_config.coordinates)
                    for rect_config in rectangles if not rect_config.is_excluded]
    exclusions = list(rect.coordinates for rect in list(
        filter(lambda x: x.is_excluded, rectangles)))

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
                screen_capture_combo=manual_ocr_hotkey.upper(
                ) if manual_ocr_hotkey and manual else None,
                config_check_thread=None,
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
        time = datetime.now()
        ocr_config = get_ocr_config()
        img = obs.get_screenshot_PIL(compression=90, img_format="jpg")
        ocr_config.scale_to_custom_size(img.width, img.height)
        # for rectangle in [rectangle for rectangle in ocr_config.rectangles if rectangle.is_secondary]:
        has_secondary_rectangles = any(
            rectangle.is_secondary for rectangle in ocr_config.rectangles)
        if has_secondary_rectangles:
            img, _ = run.apply_ocr_config_to_image(
                img, ocr_config, is_secondary=True)
        get_second_ocr_processor().do_second_ocr("", time, img, TextFiltering(lang=get_ocr_language()),
                                                 ignore_furigana_filter=True, ignore_previous_result=True, source=TextSource.SECONDARY)

    filtering = TextFiltering(lang=get_ocr_language())

    def capture():
        from GameSentenceMiner.ui.qt_main import launch_screen_cropper
        print("Taking screenshot via screen cropper...")
        time = datetime.now()
        # Use the dialog manager's synchronous method
        cropped_img = launch_screen_cropper(transparent_mode=False)

        global second_ocr_queue
        if cropped_img:
            second_ocr_queue.put(("", time, cropped_img, filtering,
                                 None, True, True, None, TextSource.SCREEN_CROPPER))
        else:
            logger.info("Screen cropper cancelled")

    def capture_main_monitor():
        print("Taking screenshot of main monitor...")
        with mss.mss() as sct:
            time = datetime.now()
            main_monitor = sct.monitors[1] if len(
                sct.monitors) > 1 else sct.monitors[0]
            img = sct.grab(main_monitor)
            img_bytes = mss.tools.to_png(img.rgb, img.size)
            get_second_ocr_processor().do_second_ocr("", time, img_bytes, filtering,
                                                     ignore_furigana_filter=True, ignore_previous_result=True, source=TextSource.MANUAL)
    hotkey_reg = None
    secondary_hotkey_reg = None
    try:
        hotkey_reg = keyboard.add_hotkey(ss_hotkey, capture)
        if not manual:
            secondary_hotkey_reg = keyboard.add_hotkey(
                get_ocr_manual_ocr_hotkey().lower(), ocr_secondary_rectangles)
        print(f"Press {ss_hotkey} to take a screenshot.")
    except Exception as e:
        if hotkey_reg:
            keyboard.remove_hotkey(hotkey_reg)
        if secondary_hotkey_reg:
            keyboard.remove_hotkey(secondary_hotkey_reg)
        logger.error(
            f"Error setting up screenshot hotkey with keyboard, Attempting Backup: {e}")
        logger.debug(e)
        pynput_hotkey = ss_hotkey.replace("ctrl", "<ctrl>").replace(
            "shift", "<shift>").replace("alt", "<alt>")
        secondary_ss_hotkey = get_ocr_manual_ocr_hotkey().lower().replace(
            "ctrl", "<ctrl>").replace("shift", "<shift>").replace("alt", "<alt>")
        try:
            from pynput import keyboard as pynput_keyboard
            listener = pynput_keyboard.GlobalHotKeys({
                pynput_hotkey: capture,
                secondary_ss_hotkey: ocr_secondary_rectangles,
            })
            listener.start()
            print(f"Press {pynput_hotkey} to take a screenshot.")
        except Exception as e:
            logger.error(
                f"Error setting up screenshot hotkey with pynput, Screenshot Hotkey Will not work: {e}")


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
        parser.add_argument("--language", type=str, default="ja",
                            help="Language for OCR (default: ja)")
        parser.add_argument("--ocr1", type=str, default="oneocr",
                            help="Primary OCR engine (default: oneocr)")
        parser.add_argument("--ocr2", type=str, default="glens",
                            help="Secondary OCR engine (default: glens)")
        parser.add_argument("--twopassocr", type=int, choices=[0, 1], default=1,
                            help="Enable two-pass OCR (default: 1)")
        parser.add_argument("--manual", action="store_true",
                            help="Use screenshot-only mode")
        parser.add_argument("--clipboard", action="store_true",
                            help="Use clipboard for input")
        parser.add_argument("--clipboard-output", action="store_true",
                            default=False, help="Use clipboard for output")
        parser.add_argument("--window", type=str,
                            help="Specify the window name for OCR")
        parser.add_argument("--furigana_filter_sensitivity", type=float, default=0,
                            help="Furigana Filter Sensitivity for OCR (default: 0)")
        parser.add_argument("--manual_ocr_hotkey", type=str,
                            default=None, help="Hotkey for manual OCR (default: None)")
        parser.add_argument("--area_select_ocr_hotkey", type=str, default="ctrl+shift+o",
                            help="Hotkey for area selection OCR (default: ctrl+shift+o)")
        parser.add_argument("--optimize_second_scan", action="store_true",
                            help="Optimize second scan by cropping based on first scan results")
        parser.add_argument("--use_window_for_config", action="store_true",
                            help="Use the specified window for loading OCR configuration")
        parser.add_argument("--keep_newline", action="store_true",
                            help="Keep new lines in OCR output")
        parser.add_argument('--obs_ocr', action='store_true',
                            help='Use OBS for Picture Source (not implemented)')
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
        global_pause_hotkey = args.global_pause_hotkey.lower(
        ) if args.global_pause_hotkey else "ctrl+shift+p"

        obs.connect_to_obs_sync(check_output=False)

        window = None
        logger.info(f"Received arguments: {vars(args)}")
        # set_force_stable_hotkey()
        ocr_config: OCRConfig = get_ocr_config(
            window=window_name, use_window_for_config=use_window_for_config)
        if ocr_config and not obs_ocr:
            if ocr_config.window:
                start_time = time.time()
                while time.time() - start_time < 30:
                    window = get_window(ocr_config.window)
                    if window or manual:
                        if window:
                            ocr_config.scale_coords()
                        break
                    logger.background(
                        f"Window: {ocr_config.window} Could not be found, retrying in 1 second...")
                    time.sleep(1)
                else:
                    logger.error(
                        f"Window '{ocr_config.window}' not found within 30 seconds.")
                    sys.exit(1)
            logger.info(
                f"Starting OCR with configuration: Window: {ocr_config.window}, Rectangles: {ocr_config.rectangles}, Engine 1: {ocr1}, Engine 2: {ocr2}, Two-pass OCR: {twopassocr}")
        set_dpi_awareness()
        if manual or ocr_config:
            # Create the Qt app on the main thread before any worker/hotkey threads
            # to avoid Qt initialization from background threads.
            import GameSentenceMiner.ui.qt_main as qt_main
            settings_window = qt_main.get_config_window()

            rectangles = ocr_config.rectangles if ocr_config and ocr_config.rectangles else []
            oneocr_threads = []
            ocr_thread = threading.Thread(target=run_oneocr, args=(
                ocr_config, rectangles), daemon=True)
            ocr_thread.start()
            # Always start worker thread to process manual screenshots from screen cropper
            worker_thread = threading.Thread(
                target=process_task_queue, daemon=True)
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
