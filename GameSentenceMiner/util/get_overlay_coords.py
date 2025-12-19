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
import copy
from ctypes import wintypes
from PIL import Image
from typing import Dict, Any, List, Tuple, Optional
from rapidfuzz import fuzz

# Local application imports
from GameSentenceMiner.ocr.gsm_ocr_config import OCRConfig, set_dpi_awareness
from GameSentenceMiner.ocr.owocr_helper import get_ocr_config
from GameSentenceMiner.owocr.owocr.run import apply_ocr_config_to_image
from GameSentenceMiner.util.configuration import OverlayEngine, get_config, get_overlay_config, get_temporary_directory, is_wayland, is_windows, is_beangate, logger
from GameSentenceMiner.util.electron_config import get_ocr_language
# Updated imports to include window info helpers
from GameSentenceMiner.obs import get_screenshot_PIL, get_window_info_from_source, get_current_scene, get_current_game
from GameSentenceMiner.web.texthooking_page import send_word_coordinates_to_overlay
from GameSentenceMiner.web.gsm_websocket import websocket_manager, ID_OVERLAY
from GameSentenceMiner.util.text_log import game_log

# Import Magpie compatibility helper
if is_windows():
    from GameSentenceMiner.util.magpie_compat import get_magpie_info

# --- Windows API Definitions (Cleaned & Expanded) ---
if is_windows():
    # Attempt to use win32gui if available for cleaner access, otherwise fallback/mix with ctypes
    try:
        import win32gui
        import win32con
        HAS_WIN32 = True
    except ImportError:
        HAS_WIN32 = False

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    
    # Structure definitions
    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

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
    user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetClientRect.restype = wintypes.BOOL
    user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(POINT)]
    user32.ClientToScreen.restype = wintypes.BOOL
    user32.GetWindow.argtypes = [wintypes.HWND, ctypes.c_uint]
    user32.GetWindow.restype = wintypes.HWND
    
    # GetWindow constants
    GW_HWNDPREV = 3

    # Kernel32 types
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    # PSAPI types
    psapi.GetModuleFileNameExW.argtypes = [wintypes.HANDLE, wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    psapi.GetModuleFileNameExW.restype = wintypes.DWORD

def get_window_client_screen_offset(hwnd: int) -> Tuple[int, int]:
    """
    Calculates the screen coordinates (x, y) of the top-left corner 
    of a window's CLIENT area (excluding title bar/borders).
    This is usually what OBS captures.
    """
    if not is_windows():
        return 0, 0
    
    pt = POINT()
    pt.x = 0
    pt.y = 0
    # Map (0,0) of client area to screen coordinates
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return pt.x, pt.y


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
        self.magpie_info: Optional[Dict[str, Any]] = None
        self.last_magpie_info: Optional[Dict[str, Any]] = None
        self.last_window_rect: Optional[Tuple[int, int, int, int]] = None
        self.window_stable_count = 0
        self.poll_interval = 0.5  # Current polling interval (starts at base rate)
        self.base_poll_interval = 0.5  # Normal polling rate
        self.fast_poll_interval = 0.1  # Fast polling when moving
        self.backoff_steps = [0.1, 0.2, 0.3, 0.4, 0.5]  # Gradual backoff intervals

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
        """Check if a window is the GSM overlay, Magpie, or other transparent overlay."""
        try:
            title = self._get_window_title(hwnd)
            window_class = self._get_window_class(hwnd)
            
            # Check for GSM Overlay by title or class
            if "GSM Overlay" in title or "gsm_overlay" in title.lower():
                return True
            
            # Electron windows typically have "Chrome" class
            if "Chrome" in window_class and "overlay" in title.lower():
                return True
            
            # Check for Magpie window
            if "Magpie" in window_class or "Magpie" in title:
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

    def update_magpie_info(self):
        """Updates the current Magpie scaling information."""
        if not is_windows():
            return
        
        try:
            self.magpie_info = get_magpie_info()
        except Exception as e:
            logger.debug(f"Error getting Magpie info: {e}")
            self.magpie_info = None
    
    def find_target_hwnd(self) -> Optional[int]:
        """Attempts to find the HWND for the current game."""
        try:
            window_info = get_window_info_from_source(scene_name=get_current_scene())
        except Exception as e:
            logger.error(f"Error getting window info from source: {e}", exc_info=True)
            window_info = None
            
        current_game = get_current_game()
        
        if not window_info and not current_game:
            return None
            
        self.last_target_info = window_info if window_info else {}
        self.last_game_name = current_game if current_game else ""
        self.found_hwnds = []
        
        cmp_func = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, ctypes.c_void_p)
        user32.EnumWindows(cmp_func(self._find_window_callback), 0)
        
        # logger.info("Found HWNDs matching criteria:", self.found_hwnds)
        
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
        
        # Check basic visibility/iconic state
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

        # Check Window Rect (Movement/Resize)
        current_rect_struct = wintypes.RECT()
        current_rect = None
        if user32.GetWindowRect(self.target_hwnd, ctypes.byref(current_rect_struct)):
            current_rect = (current_rect_struct.left, current_rect_struct.top, 
                            current_rect_struct.right, current_rect_struct.bottom)
        
        window_moved_or_resized = (current_rect != self.last_window_rect)
        if window_moved_or_resized:
            if self.last_window_rect is not None:
                logger.debug(f"Target window moved or resized: {self.last_window_rect} -> {current_rect}")
            self.window_stable_count = 0
            # Accelerate polling when window moves
            self.poll_interval = self.fast_poll_interval
        else:
            self.window_stable_count += 1
            # Gradually back off to normal polling rate
            if self.window_stable_count > 0 and self.window_stable_count <= len(self.backoff_steps):
                self.poll_interval = self.backoff_steps[self.window_stable_count - 1]
            elif self.window_stable_count > len(self.backoff_steps):
                self.poll_interval = self.base_poll_interval

        # Update Magpie info
        self.update_magpie_info()
        magpie_changed = self.magpie_info != self.last_magpie_info

        game_name_ref = self.last_target_info.get('title', self.last_game_name)

        # Broadcast state change if state changed or magpie changed
        if current_state != self.last_state or magpie_changed:
            self.last_state = current_state
            self.last_magpie_info = copy.deepcopy(self.magpie_info) if self.magpie_info else None
            
            payload = {
                "type": "window_state",
                "data": current_state,
                "game": game_name_ref,
                "magpie_info": self.magpie_info
            }
            
            if websocket_manager.has_clients(ID_OVERLAY):
                await websocket_manager.send(ID_OVERLAY,json.dumps(payload))
            
            # Logic for Triggering Scans or Updates
            if current_state == "active" and self.last_state not in ["background", "active"] and not magpie_changed:
                # Standard activation: scan
                logger.display("Window activated - triggering new scan")
                asyncio.create_task(
                    overlay_processor.find_box_and_send_to_overlay('', check_against_last=True, custom_threshold=0.95)
                )
        
        # Smart Update: If (Magpie Changed OR Window Moved) AND window has settled for 2 checks
        if (magpie_changed or window_moved_or_resized):
            if current_state not in ["minimized", "closed"]:
                logger.display("Window geometry or Magpie state stable - reprocessing last OCR result")
                asyncio.create_task(
                    overlay_processor.reprocess_and_send_last_results()
                )

        # Update last known rect
        self.last_window_rect = current_rect

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
        # Share the monitor with processor to avoid duplicate HWND seeking
        overlay_processor.window_monitor = self.window_monitor
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
                # Use adaptive polling interval based on window movement
                await asyncio.sleep(self.window_monitor.poll_interval)
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
        self.ss_width = 0
        self.ss_height = 0
        self._current_sequence = 0  # Sequence counter to track latest request
        
        # State for reprocessing without re-scanning
        self.last_raw_results: Optional[List[Dict[str, Any]]] = None # Stores pixel-based results
        self.last_raw_source: Optional[str] = None # 'local' or 'lens'
        self.last_img_dimensions: Tuple[int, int] = (0, 0) # Dimensions of the image used for the last scan
        self.last_scan_window_offset: Tuple[int, int] = (0, 0) # The window offset when the scan occurred

        # Reference to WindowStateMonitor (injected by OverlayThread)
        self.window_monitor: Optional[WindowStateMonitor] = None

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
            
    def _is_sentence_recycled(self, line_text: str) -> bool:
        """Checks if a line was used before based on the backlog."""
        return line_text in game_log.previous_lines
    
    def _get_effective_engine(self) -> str:
        """
        Determines which engine to use based on platform and configuration.
        On non-Windows platforms, forces meikiocr if oneocr or lens is selected.
        """
        overlay_config = get_overlay_config()
        engine = overlay_config.engine_v2
        
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
            
    async def find_box_and_send_to_overlay(self, sentence_to_check: str = None, check_against_last: bool = False, custom_threshold: float = None, dict_from_ocr = None, sequence: int = None):
        """
        Sends the detected text boxes to the overlay via WebSocket.
        Uses sequence numbers to skip outdated requests.
        
        Args:
            sentence_to_check: Ground truth sentence for correction
            check_against_last: Whether to compare against last result
            custom_threshold: Custom fuzzy match threshold (0-1). If None, uses config value.
            dict_from_ocr: Pre-computed OCR results
            sequence: Sequence number of this request. Outdated requests are skipped.
        """
        # Check if this is an outdated request
        if sequence is not None and sequence != self._current_sequence:
            logger.debug(f"Skipping outdated overlay request (sequence {sequence}, current {self._current_sequence})")
            return
        
        # Cancel any existing task
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
            try:
                await self.current_task
            except asyncio.CancelledError:
                logger.debug("Previous OCR task was cancelled")
        
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
        
        # Start new task with sequence check
        self.current_task = self.processing_loop.create_task(
            self.find_box_for_sentence(sentence_to_check, check_against_last, custom_threshold, dict_from_ocr=dict_from_ocr, sequence=sequence)
        )
        try:
            await self.current_task
        except asyncio.CancelledError:
            logger.debug("OCR task was cancelled")

    async def find_box_for_sentence(self, sentence_to_check: str = None, check_against_last: bool = False, custom_threshold: float = None, dict_from_ocr = None, sequence: int = None) -> List[Dict[str, Any]]:
        """
        Public method to perform OCR and find text boxes for a given sentence.
        
        This is a wrapper around the main work-horse method, providing
        error handling.
        """
        # Check sequence again before doing the actual work
        if sequence is not None and sequence != self._current_sequence:
            logger.debug(f"Skipping outdated OCR work (sequence {sequence}, current {self._current_sequence})")
            return []
        
        try:
            return await self._do_work(sentence_to_check, check_against_last=check_against_last, custom_threshold=custom_threshold, dict_from_ocr=dict_from_ocr)
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


    def _get_screenshot_and_offset(self) -> Tuple[Image.Image | None, int, int, int, int]:
        """
        Captures a screenshot.
        
        Returns:
            (Image, offset_x, offset_y, monitor_width, monitor_height)
            
        Strategy:
        1. If Windows and WindowStateMonitor has a target HWND:
           - Get screenshot via OBS (which usually captures the window's Client Area).
           - Get the Client Area's screen coordinates (offset).
           - Return that small image and the offset.
        2. Fallback:
           - Use MSS to grab the full screen.
           - Offset is 0,0.
        """
        monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)
        monitor_w, monitor_h = monitor['width'], monitor['height']

        # Strategy 1: OBS Window Capture (Preferred on Windows for specific windows)
        if is_windows() and self.window_monitor:
            hwnd = self.window_monitor.target_hwnd
            # If not found recently, try one last check
            if not hwnd:
                hwnd = self.window_monitor.find_target_hwnd()
                
            if hwnd and user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
                try:
                    # Get screenshot via OBS (assumed to be the Game Capture source)
                    # This image typically matches the "Client Area" of the window.
                    obs_img = get_screenshot_PIL(compression=100, img_format='jpg', width=None, height=None)
                    
                    if obs_img:
                        # Calculate the offset of the window content on the screen
                        off_x, off_y = get_window_client_screen_offset(hwnd)
                        
                        # Adjust offset relative to the captured monitor 
                        # (MSS monitors start at monitor['left'], monitor['top'])
                        # This assumes the Overlay is positioned on 'monitor_to_capture'.
                        final_off_x = off_x - monitor['left']
                        final_off_y = off_y - monitor['top']
                        
                        # Save debug info
                        obs_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_obs.png"))
                        logger.debug(f"Captured OBS window. Offset: ({final_off_x}, {final_off_y})")
                        self.ss_width = obs_img.width
                        self.ss_height = obs_img.height
                        
                        return obs_img, final_off_x, final_off_y, monitor_w, monitor_h
                except Exception as e:
                    logger.debug(f"OBS Window capture failed, falling back to MSS: {e}")

        # Strategy 2: Full Screen (MSS / Fallback)
        # Prefer MSS (X11) when available, but fall back to OBS/other methods on Wayland
        wayland = is_wayland()

        if mss and not wayland:
            try:
                with mss.mss() as sct:
                    sct_img = sct.grab(monitor)
                    img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
                    img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                    self.ss_width = img.width
                    self.ss_height = img.height
                    return img, 0, 0, monitor_w, monitor_h
            except Exception as e:
                logger.debug(f"MSS screenshot failed: {e}")

        # Strategy 3: Blind Fallback (OBS Scene Capture usually)
        try:
            logger.debug("Attempting fallback screenshot via OBS sources (Full Scene)")
            obs_img = get_screenshot_PIL(compression=100, img_format='jpg', width=None, height=None)
            if obs_img:
                obs_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                self.ss_width = obs_img.width
                self.ss_height = obs_img.height
                # Assuming OBS scene covers the full monitor
                return obs_img, 0, 0, monitor_w, monitor_h
        except Exception as e:
            logger.debug(f"OBS fallback screenshot failed: {e}")

        raise RuntimeError("Failed to capture screen.")

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
        # Note: If we are using Window Capture, full_screenshot is SMALL. 
        # But composite_img usually expects the size of the input image for the Lens pass.
        # We will keep composite image same size as input image.
        composite_img = Image.new("RGBA", (full_screenshot.width, full_screenshot.height), (0, 0, 0, 0))

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
    
    def get_image_to_ocr(self) -> Image.Image | None:
        full_screenshot, off_x, off_y, monitor_width, monitor_height = self._get_screenshot_and_offset()
        
        if not full_screenshot:
            logger.warning("Failed to get a screenshot.")
            return None
            
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        # Load and apply overlay config (cropping specific regions of the game)
        overlay_config = get_ocr_config()
        overlay_config.scale_to_custom_size(self.ss_width, self.ss_height)
        if overlay_config:
            full_screenshot = apply_ocr_config_to_image(full_screenshot, overlay_config, both_types=True, keep_aspect_ratio=True)
            full_screenshot.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_with_config.png"))
        return full_screenshot, off_x, off_y, monitor_width, monitor_height

    async def _do_work(self, sentence_to_check: str = None, check_against_last: bool = False, custom_threshold: float = None, dict_from_ocr = None) -> Tuple[List[Dict[str, Any]], int]:
        """The main OCR workflow with cancellation support."""
        effective_engine = self._get_effective_engine()
        
        self.sentence_is_recycled = self._is_sentence_recycled(sentence_to_check) if sentence_to_check else False
        
        if not self.lens and not self.oneocr and not self.meikiocr:
            logger.error("OCR engines are not initialized. Cannot perform OCR for Overlay.")
            return []
        
        if get_config().overlay.scan_delay > 0:
            try:
                await asyncio.sleep(get_config().overlay.scan_delay)
            except asyncio.CancelledError:
                logger.info("OCR task cancelled during scan delay")
                raise

        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        # 1. Get screenshot (possibly just the window) and the offset to screen coords
        # off_x, off_y are 0 if taking full screen.

        full_screenshot, off_x, off_y, monitor_width, monitor_height = self.get_image_to_ocr()
        if not full_screenshot:
            return []
        
        # Kinda doesn't work properly
        # if dict_from_ocr:
        #     # Raw OCR results provided (pixel coordinates) - process like local OCR results
        #     # Convert results: Pass offsets to map relative img coords to absolute screen %
        #     oneocr_final = self._convert_oneocr_results_to_percentages(
        #         dict_from_ocr, 
        #         monitor_width, 
        #         monitor_height,
        #         off_x, off_y
        #     )

        #     if sentence_to_check:
        #         oneocr_final = self._correct_ocr_with_backlog(oneocr_final, sentence_to_check)
            
        #     await send_word_coordinates_to_overlay(oneocr_final)
        #     logger.info("Sent %d text boxes to overlay from provided OCR results.", len(dict_from_ocr))
        #     return

        
        # Use local OCR engine
        local_ocr_engine = self.oneocr or self.meikiocr
        if local_ocr_engine:
            tries = 5
            last_result_flattened = ""
            for i in range(tries):
                if i > 0:
                    try:
                        await asyncio.sleep(0.3)
                        full_screenshot, off_x, off_y, monitor_width, monitor_height = self.get_image_to_ocr()
                    except asyncio.CancelledError:
                        logger.info("OCR task cancelled during local scan delay")
                        raise
                
                start_time = time.perf_counter()
                result = local_ocr_engine(
                    full_screenshot,
                    return_coords=True,
                    multiple_crop_coords=True,
                    return_one_box=False,
                    furigana_filter_sensitivity=get_overlay_config().minimum_character_size,
                )
                end_time = time.perf_counter()
                
                # Safe unpacking with defaults for 6-element tuple
                res, text, oneocr_results, crop_coords_list, crop_coords, response_dict = (list(result) + [None]*6)[:6]
                
                if not crop_coords_list:
                    return        
                
                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()
                
                text_str = "".join([text for text in text if self.regex.match(text)])
                if text_str and last_result_flattened and text_str == last_result_flattened:
                    logger.info(f"Text stabilized after {i+1} tries: {text_str}")
                    if effective_engine in [OverlayEngine.ONEOCR.value, OverlayEngine.MEIKIOCR.value]:
                        return
                    else:
                        break
                last_result_flattened = text_str
                logger.display(f"Local OCR found text: {text_str}")
                
                if self.last_oneocr_result and check_against_last:
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
                
                # STORE RAW RESULTS (Local)
                self.last_raw_results = copy.deepcopy(oneocr_results)
                self.last_raw_source = 'local'
                self.last_img_dimensions = full_screenshot.size
                self.last_scan_window_offset = (off_x, off_y)
                
                # Convert results: Pass offsets to map relative img coords to absolute screen %
                oneocr_final = self._convert_oneocr_results_to_percentages(
                    oneocr_results, 
                    monitor_width, 
                    monitor_height,
                    off_x, off_y
                )

                if sentence_to_check:
                    oneocr_final = self._correct_ocr_with_backlog(oneocr_final, sentence_to_check)
                    
                data = {
                    "type": "word_coordinates",
                    "data": oneocr_final,
                    "is_sentence_recycled": self.sentence_is_recycled
                }
                
                await send_word_coordinates_to_overlay(data)
                
                if is_beangate:
                    with open("oneocr_results.json", "w", encoding="utf-8") as f:
                        f.write(json.dumps(oneocr_results, ensure_ascii=False, indent=2))
                
                if effective_engine in [OverlayEngine.ONEOCR.value, OverlayEngine.MEIKIOCR.value] and local_ocr_engine:
                    logger.info("Sent %d text boxes to overlay.", len(oneocr_results))

                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()

                composite_image = self._create_composite_image(
                    full_screenshot, 
                    crop_coords_list, 
                    monitor_width, 
                    monitor_height
                )
                
            if effective_engine in [OverlayEngine.ONEOCR.value, OverlayEngine.MEIKIOCR.value] and local_ocr_engine:
                return
                
        else:
            composite_image = full_screenshot
        
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        start_time = time.perf_counter()
        result = self.lens(
            composite_image,
            return_coords=True,
            furigana_filter_sensitivity=get_overlay_config().minimum_character_size
        )
        end_time = time.perf_counter()
        
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        # Safe unpacking with defaults for 6-element tuple
        success, text_list, coords, crop_coords_list, crop_coords, response_dict = (list(result) + [None]*6)[:6]
        
        if not response_dict:
            return
        
        text_str = "".join([text for text in text_list if self.regex.match(text)])
        
        if self.last_lens_result and check_against_last:
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

        if not success or not response_dict:
            return
        
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        # STORE RAW RESULTS (Lens)
        self.last_raw_results = copy.deepcopy(response_dict) # Full response dict for Lens
        self.last_raw_source = 'lens'
        self.last_img_dimensions = composite_image.size
        self.last_scan_window_offset = (off_x, off_y)

        # 5. Process results. We must add the offset here as well.
        # "crop_x/y" in _extract_text_with_pixel_boxes originally meant crop relative to screenshot.
        # We can treat the Window Offset as an initial crop offset.
        extracted_data = self._extract_text_with_pixel_boxes(
            api_response=response_dict,
            original_width=monitor_width,
            original_height=monitor_height,
            crop_x=off_x, # Add window offset
            crop_y=off_y, # Add window offset
            crop_width=composite_image.width,
            crop_height=composite_image.height,
            use_percentages=True
        )

        if sentence_to_check:
            extracted_data = self._correct_ocr_with_backlog(extracted_data, sentence_to_check)
            
        data = {
            "type": "word_coordinates",
            "data": extracted_data,
            "is_sentence_recycled": self.sentence_is_recycled
        }

        await send_word_coordinates_to_overlay(data)
        
        logger.info("Sent %d text boxes to overlay.", len(extracted_data))

    async def reprocess_and_send_last_results(self):
        """
        Reprocesses the last known raw OCR results with updated window coordinates/scaling.
        Useful when the window moves, resizes, or Magpie scaling changes, avoiding a costly new OCR scan.
        """
        if not self.last_raw_results or not self.last_raw_source:
            logger.debug("No previous OCR results to reprocess.")
            return

        # Get current monitor info
        monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)
        monitor_w, monitor_h = monitor['width'], monitor['height']

        # Determine current offsets and content dimensions
        off_x, off_y = 0, 0
        current_content_w, current_content_h = self.last_img_dimensions # Fallback

        if is_windows() and self.window_monitor and self.window_monitor.target_hwnd:
            hwnd = self.window_monitor.target_hwnd
            if user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
                # Recalculate offset based on current window position
                raw_off_x, raw_off_y = get_window_client_screen_offset(hwnd)
                off_x = raw_off_x - monitor['left']
                off_y = raw_off_y - monitor['top']
                
                # Get current content dimensions
                client_rect = wintypes.RECT()
                if user32.GetClientRect(hwnd, ctypes.byref(client_rect)):
                    current_content_w = client_rect.right
                    current_content_h = client_rect.bottom

        logger.debug(f"Reprocessing overlay with current offset: ({off_x}, {off_y})")

        final_data = []

        if self.last_raw_source == 'local':
            # Local results are pixels relative to the image at time of scan.
            # When we reprocess, _convert_oneocr_results_to_percentages will apply
            # the *current* offset and current Magpie info to the original pixel coords.
            final_data = self._convert_oneocr_results_to_percentages(
                copy.deepcopy(self.last_raw_results),
                monitor_w,
                monitor_h,
                off_x, off_y
            )
            
        elif self.last_raw_source == 'lens':
            # Lens results are normalized (0-1) relative to the captured content.
            # We apply them to the current content dimensions + current offset.
            final_data = self._extract_text_with_pixel_boxes(
                api_response=copy.deepcopy(self.last_raw_results),
                original_width=monitor_w,
                original_height=monitor_h,
                crop_x=off_x,
                crop_y=off_y,
                crop_width=current_content_w,
                crop_height=current_content_h,
                use_percentages=True
            )

        if final_data:
            data = {
                "type": "word_coordinates",
                "data": final_data,
                "is_sentence_recycled": self.sentence_is_recycled
            }
            await send_word_coordinates_to_overlay(data)
            logger.info("Resent %d text boxes with updated coordinates.", len(final_data))


    def _correct_ocr_with_backlog(self, ocr_results: List[Dict[str, Any]], current_sentence: str) -> List[Dict[str, Any]]:
        """
        Corrects OCR results using sentence backlog with conditional logic:
        1. If past sentence is NOT within 50% partial_ratio of CURRENT sentence
        2. If past sentence is AT LEAST 80% partial ratio with the current OCR result
        """
        if not current_sentence or not ocr_results:
            return ocr_results
        
        ocr_text = "".join([line.get('text', '') for line in ocr_results])
        sentences_to_remove = []
        
        for past_sentence in self.last_sentences:
            current_similarity = fuzz.partial_ratio(past_sentence, current_sentence)
            if current_similarity >= 50:
                continue 
            
            ocr_similarity = fuzz.partial_ratio(past_sentence, ocr_text)
            if ocr_similarity >= 80:
                logger.debug(f"Applying OCR correction with past sentence (current_sim={current_similarity}%, ocr_sim={ocr_similarity}%)")
                ocr_results = self._correct_ocr_text(ocr_results, past_sentence)
                
                if self.remove_used_sentences:
                    sentences_to_remove.append(past_sentence)
        
        if self.remove_used_sentences and sentences_to_remove:
            for sentence in sentences_to_remove:
                self.last_sentences.remove(sentence)
            logger.debug(f"Removed {len(sentences_to_remove)} used sentence(s) from backlog")
        
        ocr_results = self._correct_ocr_text(ocr_results, current_sentence)
        
        self.last_sentences.append(current_sentence)
        if len(self.last_sentences) > self.sentence_backlog_max_size:
            self.last_sentences.pop(0)
        
        return ocr_results

    def _correct_ocr_text(self, ocr_results: List[Dict[str, Any]], sentence: str) -> List[Dict[str, Any]]:
        """
        Matches the OCR results against a ground truth sentence and corrects 
        characters in the OCR results where they align 1-to-1.
        """
        if not sentence or not ocr_results:
            return ocr_results

        FLIPPABLE_PAIRS = [('冗', '談'), ('痙', '攣')]

        flat_ocr_chars = []
        char_map = {} 
        current_idx = 0
        word_buffers = {}

        for l_idx, line in enumerate(ocr_results):
            words = line.get('words', [])
            if words:
                for w_idx, word in enumerate(words):
                    text = word.get('text', '')
                    word_buffers[(l_idx, w_idx)] = list(text)
                    for c_idx, char in enumerate(text):
                        flat_ocr_chars.append(char)
                        char_map[current_idx] = (l_idx, w_idx, c_idx)
                        current_idx += 1
            else:
                text = line.get('text', '')
                word_buffers[(l_idx, -1)] = list(text)
                for c_idx, char in enumerate(text):
                    flat_ocr_chars.append(char)
                    char_map[current_idx] = (l_idx, -1, c_idx)
                    current_idx += 1
        
        flat_ocr_str = "".join(flat_ocr_chars)
        
        for char1, char2 in FLIPPABLE_PAIRS:
            flipped = char2 + char1
            correct = char1 + char2
            if flipped in flat_ocr_str and correct in sentence:
                idx = 0
                while idx < len(flat_ocr_str) - 1:
                    if flat_ocr_str[idx] == char2 and flat_ocr_str[idx + 1] == char1:
                        if idx in char_map and (idx + 1) in char_map:
                            l1, w1, c1 = char_map[idx]
                            l2, w2, c2 = char_map[idx + 1]
                            word_buffers[(l1, w1)][c1], word_buffers[(l2, w2)][c2] = \
                                word_buffers[(l2, w2)][c2], word_buffers[(l1, w1)][c1]
                            flat_ocr_chars[idx], flat_ocr_chars[idx + 1] = \
                                flat_ocr_chars[idx + 1], flat_ocr_chars[idx]
                            logger.display(f"OCR flipped kanji fix: '{flipped}' -> '{correct}'")
                    idx += 1
        
        flat_ocr_str = "".join(flat_ocr_chars)
        matcher = difflib.SequenceMatcher(None, flat_ocr_str, sentence)
        corrections_made = 0
        insertions_made = 0
        
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'replace':
                ocr_segment_len = i2 - i1
                sent_segment_len = j2 - j1
                if ocr_segment_len == sent_segment_len:
                    correct_segment = sentence[j1:j2]
                    ocr_segment = flat_ocr_str[i1:i2]
                    for k, new_char in enumerate(correct_segment):
                        flat_idx = i1 + k
                        if flat_idx in char_map:
                            l, w, c = char_map[flat_idx]
                            old_char = word_buffers[(l, w)][c]
                            word_buffers[(l, w)][c] = new_char
                            if old_char != new_char:
                                corrections_made += 1
                    if ocr_segment != correct_segment:
                        logger.display(f"OCR correction: '{ocr_segment}' -> '{correct_segment}'")
            elif tag == 'insert':
                missing_segment = sentence[j1:j2]
                if i1 > 0 and flat_ocr_str[i1 - 1] == '「':
                    if j1 > 0 and sentence[j1 - 1] == '「':
                        if i1 in char_map:
                            l, w, c = char_map[i1]
                            for insert_char in reversed(missing_segment):
                                word_buffers[(l, w)].insert(c, insert_char)
                            insertions_made += len(missing_segment)
                            logger.display(f"OCR missing chars after 「: inserted '{missing_segment}'")

        for (l, w), char_list in word_buffers.items():
            new_text = "".join(char_list)
            if w == -1:
                ocr_results[l]['text'] = new_text
            else:
                ocr_results[l]['words'][w]['text'] = new_text
                
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
        
        crop_x/y: The pixel offset of the image relative to the screen/monitor.
        """
        results = []
        try:
            paragraphs = api_response["objects_response"]["text"]["text_layout"]["paragraphs"]
        except (KeyError, TypeError):
            return []

        for para in paragraphs:
            for line in para.get("lines", []):
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
                        use_percentage=False  # Get absolute pixels first
                    )
                    
                    if use_percentages:
                         word_box = {
                            key: (value / original_width if "x" in key else value / original_height)
                            for key, value in word_box.items()
                        }
                    
                    word_list.append({
                        "text": word_text,
                        "bounding_rect": word_box
                    })
                
                if not line_text_parts:
                    continue
                
                full_line_text = "".join(line_text_parts)
                line_box = self._convert_box_to_overlay_coords(
                    line["geometry"]["bounding_box"],
                    crop_x, crop_y, crop_width, crop_height, 
                    use_percentage=False # Get absolute pixels first
                )

                if use_percentages:
                    line_box = {
                        key: (value / original_width if "x" in key else value / original_height)
                        for key, value in line_box.items()
                    }

                results.append({
                    "text": full_line_text,
                    "bounding_rect": line_box,
                    "words": word_list
                })
        return results
    
    def _adjust_coords_for_magpie(
        self,
        x: float,
        y: float,
        magpie_info: Optional[Dict[str, Any]]
    ) -> Tuple[float, float]:
        """
        Adjusts screen coordinates based on Magpie scaling.
        
        When Magpie is active, it creates a scaled window. We need to map
        coordinates from the source window to the scaled (destination) window.
        
        Args:
            x, y: Screen coordinates (in pixels)
            magpie_info: Dictionary containing Magpie window bounds
        
        Returns:
            Adjusted (x, y) coordinates
        """
        if not magpie_info:
            return x, y
        
        try:
            # Source window bounds (original game window)
            src_left = magpie_info.get('sourceWindowLeftEdgePosition', 0)
            src_top = magpie_info.get('sourceWindowTopEdgePosition', 0)
            src_right = magpie_info.get('sourceWindowRightEdgePosition', 0)
            src_bottom = magpie_info.get('sourceWindowBottomEdgePosition', 0)
            
            # Destination window bounds (scaled Magpie window)
            dst_left = magpie_info.get('magpieWindowLeftEdgePosition', 0)
            dst_top = magpie_info.get('magpieWindowTopEdgePosition', 0)
            dst_right = magpie_info.get('magpieWindowRightEdgePosition', 0)
            dst_bottom = magpie_info.get('magpieWindowBottomEdgePosition', 0)
            
            # Calculate dimensions
            src_width = src_right - src_left
            src_height = src_bottom - src_top
            dst_width = dst_right - dst_left
            dst_height = dst_bottom - dst_top
            
            if src_width <= 0 or src_height <= 0:
                return x, y
            
            # Calculate scaling factors
            scale_x = dst_width / src_width
            scale_y = dst_height / src_height
            
            # Convert coordinate from source space to destination space
            # First, make relative to source window
            rel_x = x - src_left
            rel_y = y - src_top
            
            # Scale the relative coordinate
            scaled_x = rel_x * scale_x
            scaled_y = rel_y * scale_y
            
            # Make absolute to destination window
            final_x = scaled_x + dst_left
            final_y = scaled_y + dst_top
            
            return final_x, final_y
            
        except Exception as e:
            logger.debug(f"Error adjusting coordinates for Magpie: {e}")
            return x, y

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
        the cropped region, then offsets by the crop position.
        """
        cx, cy = bbox_data['center_x'], bbox_data['center_y']
        w, h = bbox_data['width'], bbox_data['height']

        if use_percentage:
            # This branch is generally used only if we aren't doing the screen mapping manually
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
        monitor_height: int,
        offset_x: int = 0,
        offset_y: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Converts OneOCR results with pixel coordinates to percentages relative to the monitor size.
        Adds the window offset to the coordinates before converting.
        Applies Magpie scaling adjustments if active.
        """
        # Get Magpie info from window monitor if available
        magpie_info = None
        if hasattr(self, 'window_monitor') and self.window_monitor:
            magpie_info = self.window_monitor.magpie_info
        
        converted_results = []
        for item in oneocr_results:
            bbox = item.get("bounding_rect", {})
            if not bbox:
                continue
            
            # Helper to offset, apply Magpie scaling, and convert to percentage
            def transform_box(box):
                new_box = {}
                for key, value in box.items():
                    if "x" in key:
                        # Add offset to get absolute screen coordinate
                        abs_coord = value + offset_x
                        # Apply Magpie adjustment
                        abs_coord, _ = self._adjust_coords_for_magpie(abs_coord, 0, magpie_info)
                        # Convert to percentage
                        new_box[key] = abs_coord / monitor_width
                    else:  # "y" in key
                        # Add offset to get absolute screen coordinate
                        abs_coord = value + offset_y
                        # Apply Magpie adjustment
                        _, abs_coord = self._adjust_coords_for_magpie(0, abs_coord, magpie_info)
                        # Convert to percentage
                        new_box[key] = abs_coord / monitor_height
                return new_box

            converted_bbox = transform_box(bbox)
            converted_item = item.copy()
            converted_item["bounding_rect"] = converted_bbox
            converted_results.append(converted_item)
            
            for word in converted_item.get("words", []):
                word_bbox = word.get("bounding_rect", {})
                if self.ocr_language not in ['ja', 'zh', 'ko', 'th', 'lo', 'km', 'my', 'bo']:
                    word["text"] += " "
                if word_bbox:
                    word["bounding_rect"] = transform_box(word_bbox)
                    
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
    """
    processor = OverlayProcessor()
    
    # Use the class method to get the screenshot
    img, off_x, off_y, monitor_width, monitor_height = processor._get_screenshot_and_offset()
    if not img:
        logger.error("Could not get screenshot for test.")
        return
        
    img.show()
    print(f"Captured Size: {img.size}")
    print(f"Screen Offset: ({off_x}, {off_y})")
    
    # Create a transparent image with the same size as the monitor
    new_img = Image.new("RGBA", (monitor_width, monitor_height), (0, 0, 0, 0))
    new_img.paste(img, (off_x, off_y))
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