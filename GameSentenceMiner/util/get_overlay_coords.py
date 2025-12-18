import asyncio
import io
import base64
import json
import math
import os
import threading
import time
import difflib
import ctypes
from ctypes import wintypes
from PIL import Image
from typing import Dict, Any, List, Tuple, Optional
from rapidfuzz import fuzz

# Local application imports
from GameSentenceMiner.ocr.gsm_ocr_config import set_dpi_awareness
from GameSentenceMiner.util.configuration import OverlayEngine, get_config, get_overlay_config, get_temporary_directory, is_wayland, is_windows, is_beangate, logger
from GameSentenceMiner.util.electron_config import get_ocr_language
# Updated imports to include window info helpers
from GameSentenceMiner.obs import get_screenshot_PIL, get_window_info_from_source, get_current_scene, get_current_game
from GameSentenceMiner.web.texthooking_page import send_word_coordinates_to_overlay
from GameSentenceMiner.web.gsm_websocket import websocket_manager, ID_OVERLAY

# --- Windows API Definitions ---
if is_windows():
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    
    # Process Access Rights
    PROCESS_QUERY_INFORMATION = 0x0400
    PROCESS_VM_READ = 0x0010
    
    # User32 types
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, ctypes.c_void_p), ctypes.c_void_p]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.GetWindow.argtypes = [wintypes.HWND, ctypes.c_uint]
    user32.GetWindow.restype = wintypes.HWND
    
    # GetWindow constants
    GW_HWNDPREV = 3  # Get window above in Z-order

    # Kernel32 types
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    # PSAPI types
    psapi.GetModuleFileNameExW.argtypes = [wintypes.HANDLE, wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    psapi.GetModuleFileNameExW.restype = wintypes.DWORD


def load_overlay_config_for_scene(scene_name: str = None) -> Dict[str, Any]:
    """
    Load the overlay config file for a specific scene.
    Returns None if not found.
    """
    try:
        from GameSentenceMiner.ocr.gsm_ocr_config import get_ocr_config_path
        from GameSentenceMiner.util.gsm_utils import sanitize_filename
        
        if not scene_name:
            scene_name = get_current_game()
        
        scene = sanitize_filename(scene_name or "Default")
        ocr_config_dir = get_ocr_config_path()
        overlay_config_path = os.path.join(ocr_config_dir, f"{scene}_overlay.json")
        
        if not os.path.exists(overlay_config_path):
            return None
        
        with open(overlay_config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.debug(f"Error loading overlay config: {e}")
        return None


def apply_overlay_config_to_image(img: Image.Image, overlay_config: Dict[str, Any]) -> Image.Image:
    """
    Apply overlay config rectangles to an image by creating a transparent canvas
    and pasting only the specified regions.
    """
    if not overlay_config or 'rects' not in overlay_config:
        return img
    
    rects = overlay_config.get('rects', [])
    if not rects:
        return img
    
    # Check if using percentage-based coordinates
    use_percentage = overlay_config.get('coordinate_system') == 'percentage'
    
    # Create a transparent canvas with the same size as the original image
    composite_img = Image.new("RGBA", (img.width, img.height), (0, 0, 0, 0))
    
    for rect in rects:
        # Convert coordinates based on system
        if use_percentage:
            # Convert from percentage to pixels
            x = int(rect['x'] * img.width)
            y = int(rect['y'] * img.height)
            w = int(rect['w'] * img.width)
            h = int(rect['h'] * img.height)
        else:
            # Legacy: use pixel coordinates directly
            x = rect['x']
            y = rect['y']
            w = rect['w']
            h = rect['h']
        
        # Extract rectangle coordinates
        left = max(0, x)
        top = max(0, y)
        right = min(img.width, x + w)
        bottom = min(img.height, y + h)
        
        # Skip if the coordinates result in an invalid box
        if left >= right or top >= bottom:
            continue
            
        try:
            cropped_image = img.crop((left, top, right, bottom))
            # Paste the cropped image onto the canvas at its original location
            paste_x = int(left)
            paste_y = int(top)
            composite_img.paste(cropped_image, (paste_x, paste_y))
        except ValueError:
            logger.warning("Error cropping image region, skipping rectangle")
            continue
    
    return composite_img


# Conditionally import OCR engines
try:
    if os.path.exists(os.path.expanduser('~/.config/oneocr/oneocr.dll')):
        from GameSentenceMiner.owocr.owocr.ocr import OneOCR
    else:
        OneOCR = None
    from GameSentenceMiner.owocr.owocr.ocr import GoogleLens, get_regex, MeikiOCR
except ImportError as import_err:
    GoogleLens, OneOCR, get_regex, MeikiOCR = None, None, None, None
except Exception as e:
    GoogleLens, OneOCR, get_regex, MeikiOCR = None, None, None, None
    logger.error(f"Error importing OCR engines: {e}", exc_info=True)

# Conditionally import screenshot library
try:
    import mss
except ImportError:
    mss = None

# --- Window State Monitor Class ---
class WindowStateMonitor:
    """
    Monitors the state of the target game window (Minimized, Active, Background)
    using OBS source info for robust matching.
    """
    def __init__(self):
        self.target_hwnd: Optional[int] = None
        self.last_state: str = "unknown"
        self.last_game_name: str = ""
        self.last_target_info: Dict[str, str] = {}
        self.retry_find_count = 0
        self.found_hwnds: List[int] = []

    def _get_window_exe_name(self, hwnd) -> str:
        """Helper to get the .exe name from an HWND."""
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        
        h_process = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
        if not h_process:
            return ""
            
        try:
            buff = ctypes.create_unicode_buffer(1024)
            if psapi.GetModuleFileNameExW(h_process, None, buff, 1024):
                return os.path.basename(buff.value)
        finally:
            kernel32.CloseHandle(h_process)
        return ""

    def _get_window_class(self, hwnd) -> str:
        """Helper to get Window Class name."""
        buff = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, buff, 256)
        return buff.value

    def _get_window_title(self, hwnd) -> str:
        """Helper to get window title."""
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return ""
        buff = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buff, length + 1)
        return buff.value

    def _is_overlay_window(self, hwnd) -> bool:
        """Check if a window is the GSM overlay or other transparent overlay."""
        try:
            title = self._get_window_title(hwnd)
            window_class = self._get_window_class(hwnd)
            
            # Check for GSM Overlay by title or class
            if "GSM Overlay" in title or "gsm_overlay" in title.lower():
                return True
            
            # Electron windows typically have "Chrome" class
            if "Chrome" in window_class and "overlay" in title.lower():
                return True
            
            return False
        except Exception:
            return False

    def _is_window_obscured(self, hwnd) -> bool:
        """Check if the window is completely obscured by other windows."""
        try:
            # Get target window rect
            target_rect = wintypes.RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(target_rect)):
                return False
            
            # Calculate target window area
            target_width = target_rect.right - target_rect.left
            target_height = target_rect.bottom - target_rect.top
            
            # If window has no area, consider it obscured
            if target_width <= 0 or target_height <= 0:
                return True
            
            # Check windows above in Z-order
            current_hwnd = user32.GetWindow(hwnd, GW_HWNDPREV)
            
            while current_hwnd:
                # Skip overlay windows (GSM overlay and similar transparent overlays)
                if self._is_overlay_window(current_hwnd):
                    current_hwnd = user32.GetWindow(current_hwnd, GW_HWNDPREV)
                    continue
                
                # Only check visible windows
                if user32.IsWindowVisible(current_hwnd):
                    overlapping_rect = wintypes.RECT()
                    if user32.GetWindowRect(current_hwnd, ctypes.byref(overlapping_rect)):
                        # Check if this window completely covers the target
                        if (overlapping_rect.left <= target_rect.left and
                            overlapping_rect.top <= target_rect.top and
                            overlapping_rect.right >= target_rect.right and
                            overlapping_rect.bottom >= target_rect.bottom):
                            # Window is completely covered
                            logger.debug(f"Target window is completely obscured by another window")
                            return True
                
                # Move to next window above in Z-order
                current_hwnd = user32.GetWindow(current_hwnd, GW_HWNDPREV)
            
            return False
        except Exception as e:
            logger.debug(f"Error checking window occlusion: {e}")
            return False

    def _find_window_callback(self, hwnd, extra):
        """Callback for EnumWindows. Matches against source info or title."""
        if not user32.IsWindowVisible(hwnd):
            return True

        length = user32.GetWindowTextLengthW(hwnd)
        title = ""
        if length > 0:
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            title = buff.value

        # Match Strategy 1: Specific info from OBS Source
        if self.last_target_info:
            tgt_exe = self.last_target_info.get('exe')
            tgt_class = self.last_target_info.get('window_class')
            tgt_title = self.last_target_info.get('title')

            # Class check (Fast)
            if tgt_class:
                curr_class = self._get_window_class(hwnd)
                if curr_class != tgt_class:
                    return True 

            # Exe check (Slow/Accurate)
            if tgt_exe:
                curr_exe = self._get_window_exe_name(hwnd)
                if curr_exe.lower() == tgt_exe.lower():
                    self.found_hwnds.append(hwnd)
                    return True
            # Fallback if only class/title available
            elif tgt_class:
                self.found_hwnds.append(hwnd)

        # Match Strategy 2: Legacy fuzzy title match
        elif self.last_game_name:
            if self.last_game_name.lower() in title.lower():
                self.found_hwnds.append(hwnd)

        return True

    def find_target_hwnd(self) -> Optional[int]:
        """Attempts to find the HWND for the current game."""
        try:
            window_info = get_window_info_from_source(scene_name=get_current_scene())
        except Exception:
            window_info = None

        current_game = get_current_game()
        
        if not window_info and not current_game:
            return None
            
        self.last_target_info = window_info if window_info else {}
        self.last_game_name = current_game if current_game else ""
        self.found_hwnds = []
        
        cmp_func = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, ctypes.c_void_p)
        user32.EnumWindows(cmp_func(self._find_window_callback), 0)
        
        if self.found_hwnds:
            fg = user32.GetForegroundWindow()
            if fg in self.found_hwnds:
                return fg
            return self.found_hwnds[0]
        return None

    async def check_and_send(self):
        """Checks window state and broadcasts if changed."""
        if not is_windows:
            return

        if not self.target_hwnd or self.retry_find_count > 10:
            self.target_hwnd = self.find_target_hwnd()
            self.retry_find_count = 0
        
        if not self.target_hwnd:
            self.retry_find_count += 1
            return

        current_state = "unknown"
        
        if not user32.IsWindowVisible(self.target_hwnd):
            self.target_hwnd = None
            current_state = "closed"
        elif user32.IsIconic(self.target_hwnd):
            current_state = "minimized"
        else:
            foreground_hwnd = user32.GetForegroundWindow()
            if foreground_hwnd == self.target_hwnd:
                current_state = "active"
            # elif self._is_window_obscured(self.target_hwnd):
            #     current_state = "obscured"
            else:
                current_state = "background"

        game_name_ref = self.last_target_info.get('title', self.last_game_name)

        if current_state != self.last_state:
            self.last_state = current_state
            
            payload = {
                "type": "window_state",
                "data": current_state,
                "game": game_name_ref
            }
            
            if websocket_manager.has_clients(ID_OVERLAY):
                await websocket_manager.send(ID_OVERLAY,json.dumps(payload))
            
            # Trigger aggressive scan when window becomes active
            if current_state == "active" and self.last_state != "background":
                logger.display("Window activated - triggering new scan")
                asyncio.create_task(
                    overlay_processor.find_box_and_send_to_overlay('', check_against_last=True, custom_threshold=0.95)
                )

class OverlayThread(threading.Thread):
    """
    A thread to run the overlay processing loop.
    This is a simple wrapper around asyncio to run the overlay processing
    in a separate thread.
    """
    def __init__(self):
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self.daemon = True
        self.first_time_run = True
        
        self.window_monitor = WindowStateMonitor()
        overlay_processor.processing_loop = self.loop

    def run(self):
        """Runs the overlay processing loop."""
        asyncio.set_event_loop(self.loop)
        self.loop.create_task(self.window_monitor_loop())
        self.loop.create_task(self.overlay_loop())
        self.loop.run_forever()

    async def window_monitor_loop(self):
        """Secondary loop to monitor window state (High Frequency)."""
        while True:
            try:
                if websocket_manager.has_clients(ID_OVERLAY):
                    await self.window_monitor.check_and_send()
                await asyncio.sleep(0.5) 
            except Exception as e:
                logger.debug(f"Window monitor error: {e}")
                await asyncio.sleep(1)

    async def overlay_loop(self):
        """Main loop to periodically process and send overlay data."""
        while True:
            if websocket_manager.has_clients(ID_OVERLAY):
                if get_config().overlay.periodic:
                    await overlay_processor.find_box_and_send_to_overlay('', True)
                    await asyncio.sleep(get_config().overlay.periodic_interval)
                elif self.first_time_run:
                    await overlay_processor.find_box_and_send_to_overlay('', False)
                    self.first_time_run = False
                else:
                    await asyncio.sleep(3)
            else:
                self.first_time_run = True
                await asyncio.sleep(3)

class OverlayProcessor:
    """
    Handles the entire overlay process from screen capture to text extraction.

    This class encapsulates the logic for taking screenshots, identifying text
    regions, performing OCR, and processing the results into a structured format
    with pixel coordinates.
    """
    
    def __init__(self):
        self.config = get_config()
        self.oneocr = None
        self.meikiocr = None
        self.lens = None
        self.regex = None
        self.ready = False
        self.last_oneocr_result = None
        self.last_lens_result = None
        self.current_task = None  # Track current running task
        self.windows_warning_shown = False
        self.processing_loop: asyncio.AbstractEventLoop = None
        self.last_sentences = []  # Backlog of last 8 sentences
        self.sentence_backlog_max_size = 8
        self.remove_used_sentences = True  # Flag to control removal of sentences from backlog
        self.current_engine_config = None  # Track current engine configuration

    def init(self):
        """Initializes the OCR engines and configuration."""
        try:
            if self.config.overlay.websocket_port and all([GoogleLens, get_regex]):
                logger.info("Initializing OCR engines...")
                self.ocr_language = get_ocr_language()
                self.regex = get_regex(self.ocr_language)
                logger.info("OCR engines initialized.")
                self.ready = True
            else:
                logger.warning("OCR dependencies not found or websocket port not configured. OCR functionality will be disabled.")
            
            if is_windows:
                set_dpi_awareness()
                
            if not mss:
                logger.warning("MSS library not found. Screenshot functionality may be limited.")
        except Exception as e:
            logger.error(f"Error initializing OCR engines for overlay, try installing owocr in OCR tab of GSM: {e}", exc_info=True)
            self.oneocr = None
            self.lens = None
            self.regex = None
    
    def _get_effective_engine(self) -> str:
        """
        Determines which engine to use based on platform and configuration.
        On non-Windows platforms, forces meikiocr if oneocr or lens is selected.
        """
        overlay_config = get_overlay_config()
        engine = getattr(overlay_config, 'engine_v2', overlay_config.engine)
        
        # Force meikiocr on non-Windows if oneocr or lens is selected
        if not is_windows() and engine in [OverlayEngine.ONEOCR.value, OverlayEngine.LENS.value]:
            logger.info(f"Forcing MeikiOCR on non-Windows platform (selected: {engine})")
            return OverlayEngine.MEIKIOCR.value
        
        return engine
    
    def _ensure_correct_engine_loaded(self):
        """
        Ensures the correct OCR engine is loaded based on current configuration.
        Closes and clears engines that are no longer needed when config changes.
        """
        effective_engine = self._get_effective_engine()
        
        # Check if engine config has changed
        if self.current_engine_config == effective_engine:
            return  # No change, engines already correct
        
        logger.info(f"Engine config changed from {self.current_engine_config} to {effective_engine}")
        
        # Close and clear all engines
        if self.oneocr:
            try:
                if hasattr(self.oneocr, 'close'):
                    self.oneocr.close()
            except Exception as e:
                logger.debug(f"Error closing oneocr: {e}")
            self.oneocr = None
        
        if self.meikiocr:
            try:
                if hasattr(self.meikiocr, 'close'):
                    self.meikiocr.close()
            except Exception as e:
                logger.debug(f"Error closing meikiocr: {e}")
            self.meikiocr = None
        
        if self.lens:
            try:
                if hasattr(self.lens, 'close'):
                    self.lens.close()
            except Exception as e:
                logger.debug(f"Error closing lens: {e}")
            self.lens = None
        
        # Update current engine config
        self.current_engine_config = effective_engine
            
    async def find_box_and_send_to_overlay(self, sentence_to_check: str = None, check_against_last: bool = False, custom_threshold: float = None):
        """
        Sends the detected text boxes to the overlay via WebSocket.
        Cancels any running OCR task before starting a new one.
        
        Args:
            sentence_to_check: Ground truth sentence for correction
            check_against_last: Whether to compare against last result
            custom_threshold: Custom fuzzy match threshold (0-1). If None, uses config value.
        """
        # Cancel any existing task
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
            try:
                await self.current_task
            except asyncio.CancelledError:
                logger.info("Previous OCR task was cancelled")
        
        # Ensure correct engine is loaded based on current config
        self._ensure_correct_engine_loaded()
        effective_engine = self._get_effective_engine()
        
        # Initialize engines based on effective engine configuration
        if effective_engine == OverlayEngine.LENS.value:
            if GoogleLens and not self.lens:
                self.lens = GoogleLens(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        elif effective_engine == OverlayEngine.ONEOCR.value:
            if OneOCR and not self.oneocr:
                self.oneocr = OneOCR(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        elif effective_engine == OverlayEngine.MEIKIOCR.value:
            if MeikiOCR and not self.meikiocr:
                self.meikiocr = MeikiOCR(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        
        # Start new task
        self.current_task = self.processing_loop.create_task(self.find_box_for_sentence(sentence_to_check, check_against_last, custom_threshold))
        try:
            await self.current_task
        except asyncio.CancelledError:
            logger.info("OCR task was cancelled")

    async def find_box_for_sentence(self, sentence_to_check: str = None, check_against_last: bool = False, custom_threshold: float = None) -> List[Dict[str, Any]]:
        """
        Public method to perform OCR and find text boxes for a given sentence.
        
        This is a wrapper around the main work-horse method, providing
        error handling.
        """
        try:
            return await self._do_work(sentence_to_check, check_against_last=check_against_last, custom_threshold=custom_threshold)
        except Exception as e:
            logger.error(f"Error during OCR processing: {e}", exc_info=True)
            return []
        
    @staticmethod
    def get_monitor_workarea(monitor_index=0):
        """
        Return MSS-style dict for monitor area.
        For primary monitor, excludes taskbar. For others, returns full monitor area.
        monitor_index: 0 = primary monitor, 1+ = others (as in mss.monitors).
        """
        # set_dpi_awareness()
        with mss.mss() as sct:
            monitors = sct.monitors[1:]
            monitor = monitors[monitor_index] if 0 <= monitor_index < len(monitors) else monitors[0]
            # Return monitor but the Y is 1 less to avoid taskbar on Windows
            return {
                "left": monitor["left"],
                "top": monitor["top"],
                "width": monitor["width"],
                "height": monitor["height"] - 1
            }


    def _get_full_screenshot(self) -> Tuple[Image.Image | None, int, int]:
        """Captures a screenshot of the configured monitor."""
        # Prefer MSS (X11) when available, but fall back to OBS/other methods on Wayland
        wayland = is_wayland()

        if mss and not wayland:
            try:
                with mss.mss() as sct:
                    monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)  # Get primary monitor work area
                    sct_img = sct.grab(monitor)
                    img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
                    img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                    return img, monitor['width'], monitor['height']
            except Exception as e:
                # MSS (X11) failed (commonly XGetImage on Wayland or permission issues). Fall back below.
                logger.debug(f"MSS screenshot failed: {e}")

        # Fallback: try OBS-based screenshot (if OBS is connected and has a suitable source)
        try:
            logger.debug("Attempting fallback screenshot via OBS sources")
            obs_img = get_screenshot_PIL(compression=100, img_format='jpg', width=None, height=None)
            if obs_img is not None:
                # get_screenshot_PIL returns a PIL Image already
                # Try to infer monitor size from the image
                w, h = obs_img.size
                obs_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                if mss:
                    monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)
                    w = monitor['width']
                    h = monitor['height']
                return obs_img, w, h
        except Exception as e:
            logger.debug(f"OBS fallback screenshot failed: {e}")

        # As a last resort, raise an informative error
        raise RuntimeError("Failed to capture screen: MSS unavailable or failed and OBS fallback unavailable. On Wayland you must run with a portal or use an OBS source.")

    def _create_composite_image(
        self, 
        full_screenshot: Image.Image,
        crop_coords_list: List[Tuple[int, int, int, int]],
        monitor_width: int,
        monitor_height: int
    ) -> Image.Image:
        """
        Creates a new image by pasting cropped text regions onto a transparent background.
        This isolates text for more accurate secondary OCR.
        """
        if not crop_coords_list:
            return full_screenshot

        # Create a transparent canvas
        composite_img = Image.new("RGBA", (monitor_width, monitor_height), (0, 0, 0, 0))

        for crop_coords in crop_coords_list:
            # Ensure crop coordinates are within image bounds
            x1, y1, x2, y2, = crop_coords[:4]
            x1 = max(0, min(x1, full_screenshot.width))
            y1 = max(0, min(y1, full_screenshot.height))
            x2 = max(x1, min(x2, full_screenshot.width))
            y2 = max(y1, min(y2, full_screenshot.height))
            
            # Skip if the coordinates result in an invalid box
            if x1 >= x2 or y1 >= y2:
                continue
            try:
                cropped_image = full_screenshot.crop((x1, y1, x2, y2))
            except ValueError:
                logger.warning("Error cropping image, using original image")
                return full_screenshot
            # Paste the cropped image onto the canvas at its original location
            paste_x = math.floor(x1)
            paste_y = math.floor(y1)
            composite_img.paste(cropped_image, (paste_x, paste_y))
            
        composite_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_trimmed.png"))
        
        return composite_img

    async def _do_work(self, sentence_to_check: str = None, check_against_last: bool = False, custom_threshold: float = None) -> Tuple[List[Dict[str, Any]], int]:
        """The main OCR workflow with cancellation support."""
        effective_engine = self._get_effective_engine()
        
        # Check if any required engine is initialized
        if not self.lens and not self.oneocr and not self.meikiocr:
            logger.error("OCR engines are not initialized. Cannot perform OCR for Overlay.")
            return []
        
        if get_config().overlay.scan_delay > 0:
            try:
                await asyncio.sleep(get_config().overlay.scan_delay)
            except asyncio.CancelledError:
                logger.info("OCR task cancelled during scan delay")
                raise

        # Check for cancellation before taking screenshot
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()

        # 1. Get screenshot
        full_screenshot, monitor_width, monitor_height = self._get_full_screenshot()
        if not full_screenshot:
            logger.warning("Failed to get a screenshot.")
            return []
            
        # Check for cancellation after screenshot
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        # Load and apply overlay config if it exists (before local OCR)
        from GameSentenceMiner.obs import get_current_game
        overlay_config = load_overlay_config_for_scene(get_current_game())
        if overlay_config:
            logger.debug("Applying overlay config to screenshot before OCR")
            full_screenshot = apply_overlay_config_to_image(full_screenshot, overlay_config)
            full_screenshot.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_with_config.png"))
        
        # Use local OCR engine (OneOCR or MeikiOCR) if configured
        local_ocr_engine = self.oneocr or self.meikiocr
        if local_ocr_engine:
            tries = get_overlay_config().number_of_local_scans_per_event if not check_against_last else 1
            for i in range(tries):
                if i > 0:
                    try:
                        await asyncio.sleep(0.1)
                    except asyncio.CancelledError:
                        logger.info("OCR task cancelled during local scan delay")
                        raise
                # 2. Use local OCR (OneOCR or MeikiOCR) to find general text areas (fast)
                start_time = time.perf_counter()
                res, text, oneocr_results, crop_coords_list = local_ocr_engine(
                    full_screenshot,
                    return_coords=True,
                    multiple_crop_coords=True,
                    return_one_box=False,
                    furigana_filter_sensitivity=get_overlay_config().minimum_character_size,
                )
                end_time = time.perf_counter()
                # logger.info("Local OCR processing took %.4f seconds.", end_time - start_time)
                
                if not crop_coords_list:
                    return        
                
                # Check for cancellation after OneOCR
                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()
                
                text_str = "".join([text for text in text if self.regex.match(text)])
                
                logger.display(f"Local OCR found text: {text_str}")
                
                # RapidFuzz fuzzy match to not send the same results repeatedly
                if self.last_oneocr_result and check_against_last:
                    # Use custom threshold if provided (for activation scans), otherwise use config
                    if custom_threshold is not None:
                        score = fuzz.ratio(text_str, self.last_oneocr_result)
                        threshold = custom_threshold * 100
                        if score >= threshold:
                            logger.display(f"Skipping update: ratio {score}% >= {threshold}%")
                            return
                    else:
                        score = fuzz.ratio(text_str, self.last_oneocr_result)
                        if score >= get_config().overlay.periodic_ratio * 100:
                            return
                self.last_oneocr_result = text_str
                
                # Convert results
                oneocr_final = self._convert_oneocr_results_to_percentages(oneocr_results, monitor_width, monitor_height)

                # Correct text if ground truth is available and conditions are met
                if sentence_to_check:
                    start_time = time.perf_counter()
                    oneocr_final = self._correct_ocr_with_backlog(oneocr_final, sentence_to_check)
                    end_time = time.perf_counter()
                    # logger.info("OCR text correction took %.4f seconds.", end_time - start_time)
                
                await send_word_coordinates_to_overlay(oneocr_final)
                
                # If User Home is beangate
                if is_beangate:
                    with open("oneocr_results.json", "w", encoding="utf-8") as f:
                        f.write(json.dumps(oneocr_results, ensure_ascii=False, indent=2))
                
                # Check if we're using a local-only engine (not lens)
                if effective_engine in [OverlayEngine.ONEOCR.value, OverlayEngine.MEIKIOCR.value] and local_ocr_engine:
                    logger.info("Sent %d text boxes to overlay.", len(oneocr_results))
                    return

                # Check for cancellation before creating composite image
                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()

                # 3. Create a composite image with only the detected text regions
                composite_image = self._create_composite_image(
                    full_screenshot, 
                    crop_coords_list, 
                    monitor_width, 
                    monitor_height
                )
                
        else:
            composite_image = full_screenshot
        
        # Check for cancellation before Google Lens processing
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        # 4. Use Google Lens on the cleaner composite image for higher accuracy
        start_time = time.perf_counter()
        res = self.lens(
            composite_image,
            return_coords=True,
            furigana_filter_sensitivity=get_overlay_config().minimum_character_size
        )
        end_time = time.perf_counter()
        # logger.info("Google Lens processing took %.4f seconds.", end_time - start_time)
        
        # Check for cancellation after Google Lens
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        if len(res) != 3:
            return
        
        success, text_list, coords = res
        
        text_str = "".join([text for text in text_list if self.regex.match(text)])
        
        # RapidFuzz fuzzy match to not send the same results repeatedly
        if self.last_lens_result and check_against_last:
            # Use custom threshold if provided (for activation scans), otherwise use config
            if custom_threshold is not None:
                score = fuzz.partial_ratio(text_str, self.last_lens_result)
                threshold = custom_threshold * 100
                if score >= threshold:
                    logger.debug(f"Skipping Lens update: partial_ratio {score}% >= {threshold}%")
                    return
            else:
                score = fuzz.ratio(text_str, self.last_lens_result)
                if score >= get_config().overlay.periodic_ratio * 100:
                    logger.info("Google Lens results are similar to the last results (score: %d). Skipping overlay update.", score)
                    return
        self.last_lens_result = text_str

        if not success or not coords:
            return
        
        # Check for cancellation before final processing
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        # 5. Process the high-accuracy results into the desired format
        extracted_data = self._extract_text_with_pixel_boxes(
            api_response=coords,
            original_width=monitor_width,
            original_height=monitor_height,
            crop_x=0,
            crop_y=0,
            crop_width=composite_image.width,
            crop_height=composite_image.height,
            use_percentages=True
        )

        # Correct text if ground truth is available and conditions are met
        if sentence_to_check:
            start_time = time.perf_counter()
            extracted_data = self._correct_ocr_with_backlog(extracted_data, sentence_to_check)
            end_time = time.perf_counter()
            # logger.info("OCR text correction took %.4f seconds.", end_time - start_time)

        await send_word_coordinates_to_overlay(extracted_data)
        
        logger.info("Sent %d text boxes to overlay.", len(extracted_data))

    def _correct_ocr_with_backlog(self, ocr_results: List[Dict[str, Any]], current_sentence: str) -> List[Dict[str, Any]]:
        """
        Corrects OCR results using sentence backlog with conditional logic:
        1. If past sentence is NOT within 50% partial_ratio of CURRENT sentence
        2. If past sentence is AT LEAST 80% partial ratio with the current OCR result
        
        This handles cases where games require multiple clicks and previous sentences remain visible.
        If remove_used_sentences is True, sentences meeting both conditions are removed from backlog.
        """
        if not current_sentence or not ocr_results:
            return ocr_results
        
        # Extract OCR text for comparison
        ocr_text = "".join([line.get('text', '') for line in ocr_results])
        
        # Track sentences to remove if flag is enabled
        sentences_to_remove = []
        
        # Check backlog and apply corrections
        for past_sentence in self.last_sentences:
            # Condition 1: Past sentence is NOT similar to current sentence (< 50% partial_ratio)
            current_similarity = fuzz.partial_ratio(past_sentence, current_sentence)
            if current_similarity >= 50:
                continue  # Skip if past and current are too similar
            
            # Condition 2: Past sentence IS similar to OCR result (>= 80% partial_ratio)
            ocr_similarity = fuzz.partial_ratio(past_sentence, ocr_text)
            if ocr_similarity >= 80:
                logger.debug(f"Applying OCR correction with past sentence (current_sim={current_similarity}%, ocr_sim={ocr_similarity}%)")
                ocr_results = self._correct_ocr_text(ocr_results, past_sentence)
                
                # Mark for removal if flag is enabled
                if self.remove_used_sentences:
                    sentences_to_remove.append(past_sentence)
        
        # Remove used sentences from backlog if flag is enabled
        if self.remove_used_sentences and sentences_to_remove:
            for sentence in sentences_to_remove:
                self.last_sentences.remove(sentence)
            logger.debug(f"Removed {len(sentences_to_remove)} used sentence(s) from backlog")
        
        # Always try to correct with the current sentence as well
        ocr_results = self._correct_ocr_text(ocr_results, current_sentence)
        
        # Update backlog
        self.last_sentences.append(current_sentence)
        if len(self.last_sentences) > self.sentence_backlog_max_size:
            self.last_sentences.pop(0)  # Remove oldest sentence
        
        return ocr_results

    def _correct_ocr_text(self, ocr_results: List[Dict[str, Any]], sentence: str) -> List[Dict[str, Any]]:
        """
        Matches the OCR results against a ground truth sentence and corrects 
        characters in the OCR results where they align 1-to-1.
        Also handles:
        - Flipped kanji pairs (e.g., 冗談 misread as 談冗)
        - Missing characters after opening quotes (「)
        """
        if not sentence or not ocr_results:
            return ocr_results

        # Known flippable kanji pairs (Meiki OCR issue)
        FLIPPABLE_PAIRS = [
            ('冗', '談'),  # 冗談
            ('痙', '攣'),  # 痙攣
        ]

        # 1. Flatten OCR content into a list of characters with mapping to their structure
        flat_ocr_chars = []
        # map flat_index -> (line_idx, word_idx, char_idx)
        char_map = {} 
        current_idx = 0

        # Buffer to hold mutable chars for reconstruction
        # (line_idx, word_idx) -> list of chars
        word_buffers = {}

        for l_idx, line in enumerate(ocr_results):
            words = line.get('words', [])
            if words:
                for w_idx, word in enumerate(words):
                    text = word.get('text', '')
                    # Initialize buffer
                    word_buffers[(l_idx, w_idx)] = list(text)
                    
                    for c_idx, char in enumerate(text):
                        flat_ocr_chars.append(char)
                        char_map[current_idx] = (l_idx, w_idx, c_idx)
                        current_idx += 1
            else:
                # Handle lines without words (fallback)
                text = line.get('text', '')
                word_buffers[(l_idx, -1)] = list(text)
                for c_idx, char in enumerate(text):
                    flat_ocr_chars.append(char)
                    char_map[current_idx] = (l_idx, -1, c_idx)
                    current_idx += 1
        
        flat_ocr_str = "".join(flat_ocr_chars)
        
        # PRE-PROCESSING: Fix flipped kanji pairs
        for char1, char2 in FLIPPABLE_PAIRS:
            # Check for flipped version (char2 + char1)
            flipped = char2 + char1
            correct = char1 + char2
            
            if flipped in flat_ocr_str and correct in sentence:
                # Find all occurrences
                idx = 0
                while idx < len(flat_ocr_str) - 1:
                    if flat_ocr_str[idx] == char2 and flat_ocr_str[idx + 1] == char1:
                        # Swap characters in the buffers
                        if idx in char_map and (idx + 1) in char_map:
                            l1, w1, c1 = char_map[idx]
                            l2, w2, c2 = char_map[idx + 1]
                            
                            # Swap in buffers
                            word_buffers[(l1, w1)][c1], word_buffers[(l2, w2)][c2] = \
                                word_buffers[(l2, w2)][c2], word_buffers[(l1, w1)][c1]
                            
                            # Update flat_ocr_chars for subsequent matching
                            flat_ocr_chars[idx], flat_ocr_chars[idx + 1] = \
                                flat_ocr_chars[idx + 1], flat_ocr_chars[idx]
                            
                            logger.display(f"OCR flipped kanji fix: '{flipped}' -> '{correct}'")
                    idx += 1
        
        # Rebuild flat_ocr_str after flipping
        flat_ocr_str = "".join(flat_ocr_chars)
        
        # 2. Match OCR string against the ground truth sentence
        matcher = difflib.SequenceMatcher(None, flat_ocr_str, sentence)
        
        # 3. Apply corrections
        # We only apply 1-to-1 replacements to preserve coordinate validity
        corrections_made = 0
        insertions_made = 0
        
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'replace':
                ocr_segment_len = i2 - i1
                sent_segment_len = j2 - j1
                
                # Only correct if lengths match (simple character misrecognition)
                # This avoids messing up coordinates if OCR completely missed a char or saw duplicates
                if ocr_segment_len == sent_segment_len:
                    correct_segment = sentence[j1:j2]
                    ocr_segment = flat_ocr_str[i1:i2]
                    for k, new_char in enumerate(correct_segment):
                        flat_idx = i1 + k
                        if flat_idx in char_map:
                            l, w, c = char_map[flat_idx]
                            old_char = word_buffers[(l, w)][c]
                            # Update the buffer
                            word_buffers[(l, w)][c] = new_char
                            if old_char != new_char:
                                corrections_made += 1
                    
                    if ocr_segment != correct_segment:
                        logger.display(f"OCR correction: '{ocr_segment}' -> '{correct_segment}'")
            
            elif tag == 'delete':
                # OCR has extra characters - handle separately if needed
                pass
            
            elif tag == 'insert':
                # Sentence has characters that OCR is missing
                missing_segment = sentence[j1:j2]
                
                # Check if this is right after an opening quote 「
                # We need to look at what comes before position i1 in the OCR
                if i1 > 0 and flat_ocr_str[i1 - 1] == '「':
                    # Verify that in the sentence, these missing chars also come after 「
                    if j1 > 0 and sentence[j1 - 1] == '「':
                        # Insert the missing character(s) after the 「
                        # We need to insert into the buffer at position i1
                        if i1 in char_map:
                            l, w, c = char_map[i1]
                            # Insert at the beginning of this word/line
                            for insert_char in reversed(missing_segment):  # Reverse to maintain order
                                word_buffers[(l, w)].insert(c, insert_char)
                            insertions_made += len(missing_segment)
                            logger.display(f"OCR missing chars after 「: inserted '{missing_segment}'")

        # 4. Reconstruct OCR results from the modified buffers
        for (l, w), char_list in word_buffers.items():
            new_text = "".join(char_list)
            if w == -1:
                ocr_results[l]['text'] = new_text
            else:
                ocr_results[l]['words'][w]['text'] = new_text
                
        # 5. Re-generate main line text from words if words exist to keep consistency
        for line in ocr_results:
            if line.get('words'):
                line['text'] = "".join([wd['text'] for wd in line['words']])
        
        if corrections_made > 0:
            logger.display(f"Made {corrections_made} character correction(s) in OCR results")
        
        if insertions_made > 0:
            logger.display(f"Inserted {insertions_made} missing character(s) in OCR results")
                
        return ocr_results

    def _extract_text_with_pixel_boxes(
        self,
        api_response: Dict[str, Any],
        original_width: int,
        original_height: int,
        crop_x: int,
        crop_y: int,
        crop_width: int,
        crop_height: int,
        use_percentages: bool
    ) -> List[Dict[str, Any]]:
        """
        Parses Google Lens API response and converts normalized coordinates
        to absolute pixel coordinates.
        """
        results = []
        try:
            paragraphs = api_response["objects_response"]["text"]["text_layout"]["paragraphs"]
        except (KeyError, TypeError):
            return []  # Return empty if the expected structure isn't present

        for para in paragraphs:
            for line in para.get("lines", []):
                # if not self.regex.match(line.get("plain_text", "")):
                #     continue
                line_text_parts = []
                word_list = []

                for word in line.get("words", []):
                    if self.ocr_language not in ['ja', 'zh', 'ko', 'th', 'lo', 'km', 'my', 'bo']:
                        word["plain_text"] += word["text_separator"]
                    word_text = word.get("plain_text", "")
                    line_text_parts.append(word_text)
                    
                    word_box = self._convert_box_to_overlay_coords(
                        word["geometry"]["bounding_box"],
                        crop_x, crop_y, crop_width, crop_height,
                        use_percentage=use_percentages
                    )
                    
                    word_list.append({
                        "text": word_text,
                        "bounding_rect": word_box
                    })
                
                if not line_text_parts:
                    continue
                
                full_line_text = "".join(line_text_parts)
                line_box = self._convert_box_to_overlay_coords(
                    line["geometry"]["bounding_box"],
                    crop_x, crop_y, crop_width, crop_height, use_percentage=use_percentages
                )

                results.append({
                    "text": full_line_text,
                    "bounding_rect": line_box,
                    "words": word_list
                })
        return results

    def _convert_box_to_overlay_coords(
        self,
        bbox_data: Dict[str, float],
        crop_x: int,
        crop_y: int,
        crop_width: int,
        crop_height: int,
        use_percentage: bool
    ) -> Dict[str, float]:
        """
        Simplified conversion: scales normalized bbox to pixel coordinates within
        the cropped region, then offsets by the crop position. Ignores rotation.
        If use_percentage is True, returns coordinates as percentages of the crop dimensions.
        """
        cx, cy = bbox_data['center_x'], bbox_data['center_y']
        w, h = bbox_data['width'], bbox_data['height']

        if use_percentage:
            # Return coordinates as percentages of the crop dimensions
            box_width = w
            box_height = h
            center_x = cx
            center_y = cy
        else:
            # Scale normalized coordinates to pixel coordinates relative to the crop area
            box_width = w * crop_width
            box_height = h * crop_height

            # Calculate center within the cropped area and then add the crop offset
            center_x = (cx * crop_width) + crop_x
            center_y = (cy * crop_height) + crop_y

        # Calculate corners (unrotated)
        half_w, half_h = box_width / 2, box_height / 2
        return {
            "x1": center_x - half_w, "y1": center_y - half_h,
            "x2": center_x + half_w, "y2": center_y - half_h,
            "x3": center_x + half_w, "y3": center_y + half_h,
            "x4": center_x - half_w, "y4": center_y + half_h,
        }
        
    def _convert_oneocr_results_to_percentages(
        self,
        oneocr_results: List[Dict[str, Any]],
        monitor_width: int,
        monitor_height: int
    ) -> List[Dict[str, Any]]:
        """
        Converts OneOCR results with pixel coordinates to percentages relative to the monitor size.
        """
        converted_results = []
        for item in oneocr_results:
            # Check Regex
            # if not self.regex.match(item.get("text", "")):
            #     continue
            bbox = item.get("bounding_rect", {})
            if not bbox:
                continue
            # Convert each coordinate to a percentage of the monitor dimensions
            converted_bbox = {
                key: (value / monitor_width if "x" in key else value / monitor_height)
                for key, value in bbox.items()
            }
            converted_item = item.copy()
            converted_item["bounding_rect"] = converted_bbox
            converted_results.append(converted_item)
            for word in converted_item.get("words", []):
                word_bbox = word.get("bounding_rect", {})
                # If not CJK or Southeast Asian script, add a space after each word
                if self.ocr_language not in ['ja', 'zh', 'ko', 'th', 'lo', 'km', 'my', 'bo']:
                    word["text"] += " "
                if word_bbox:
                    word["bounding_rect"] = {
                        key: (value / monitor_width if "x" in key else value / monitor_height)
                        for key, value in word_bbox.items()
                    }
        # logger.info(f"Converted OneOCR results to percentages: {converted_results}")
        return converted_results
    
async def init_overlay_processor():
    """
    Initializes the overlay processor and starts the overlay thread.
    This function can be called at application startup.
    """
    overlay_processor.init()
    overlay_thread = OverlayThread()
    overlay_thread.start()
    logger.info("Overlay processor initialized and thread started.")
    
    
def get_overlay_processor() -> OverlayProcessor:
    """
    Returns the initialized overlay processor instance.
    """
    global overlay_processor
    if overlay_processor is None:
        asyncio.run(init_overlay_processor())
    return overlay_processor

async def main_test_screenshot():
    """
    A test function to demonstrate screenshot and image composition.
    This is preserved from your original __main__ block.
    """
    processor = OverlayProcessor()
    
    # Use the class method to get the screenshot
    img, monitor_width, monitor_height = processor._get_full_screenshot()
    if not img:
        logger.error("Could not get screenshot for test.")
        return
        
    img.show()
    
    # Create a transparent image with the same size as the monitor
    new_img = Image.new("RGBA", (monitor_width, monitor_height), (0, 0, 0, 0))
    
    # Calculate coordinates to center the captured image (if it's not full-screen)
    left = (monitor_width - img.width) // 2
    top = (monitor_height - img.height) // 2
    
    print(f"Image size: {img.size}, Monitor size: {monitor_width}x{monitor_height}")
    print(f"Pasting at: Left={left}, Top={top}")
    
    new_img.paste(img, (left, top))
    new_img.show()
    
async def main_run_ocr():
    """
    Main function to demonstrate running the full OCR process.
    """
    overlay_processor = OverlayProcessor()
    while True:
        await overlay_processor.find_box_and_send_to_overlay('', False)
        await asyncio.sleep(10)
        
overlay_processor = OverlayProcessor()

if __name__ == '__main__':
    try:
        # To run the screenshot test:
        # asyncio.run(main_test_screenshot())
        
        # To run the full OCR process:
        asyncio.run(main_run_ocr())

    except KeyboardInterrupt:
        logger.info("Script terminated by user.")
    except Exception as e:
        logger.error(f"An error occurred in the main execution block: {e}", exc_info=True)