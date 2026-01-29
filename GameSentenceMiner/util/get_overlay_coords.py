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
from datetime import datetime
from ctypes import wintypes
from PIL import Image
from typing import Dict, Any, List, Tuple, Optional
from rapidfuzz import fuzz
import regex

# Local application imports
from GameSentenceMiner.ocr.gsm_ocr_config import OCRConfig, set_dpi_awareness
from GameSentenceMiner.ocr.gsm_ocr_config import get_ocr_config
from GameSentenceMiner.owocr.owocr.run import apply_ocr_config_to_image
from GameSentenceMiner.util.image_scaling import (
    scale_dimensions_by_aspect_buckets,
    scale_dimensions_to_minimum_bounds,
    scale_pil_image,
    ScaledSize,
)
from GameSentenceMiner.util.configuration import OverlayEngine, get_config, get_overlay_config, get_master_config, get_temporary_directory, is_wayland, is_windows, is_beangate, logger
from GameSentenceMiner.util.electron_config import get_ocr_language
# Updated imports to include window info helpers
from GameSentenceMiner.obs import get_screenshot_PIL, get_window_info_from_source, get_current_scene, get_current_game
from GameSentenceMiner.web.texthooking_page import send_word_coordinates_to_overlay
from GameSentenceMiner.web.gsm_websocket import websocket_manager, ID_OVERLAY
from GameSentenceMiner.util.text_log import GameLine, TextSource, game_log

# Import Magpie compatibility helper
if is_windows():
    from GameSentenceMiner.util.magpie_compat import get_magpie_info

# --- Configuration ---
# Set to True only when debugging image issues to save CPU/Disk usage
SAVE_DEBUG_IMAGES = True
# Convert images to grayscale for overlay processing
CONVERT_TO_GRAYSCALE = False

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
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    
    # PROCESS_MEMORY_COUNTERS structure for memory queries
    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ('cb', wintypes.DWORD),
            ('PageFaultCount', wintypes.DWORD),
            ('PeakWorkingSetSize', ctypes.c_size_t),
            ('WorkingSetSize', ctypes.c_size_t),
            ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
            ('QuotaPagedPoolUsage', ctypes.c_size_t),
            ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
            ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
            ('PagefileUsage', ctypes.c_size_t),
            ('PeakPagefileUsage', ctypes.c_size_t),
        ]
    
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
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromWindow.restype = wintypes.HANDLE
    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    user32.GetMonitorInfoW.restype = wintypes.BOOL
    
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
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wintypes.DWORD]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    
    SW_RESTORE = 9
    SW_SHOW = 5
    SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000
    SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
    SPIF_SENDCHANGE = 2
    HWND_TOP = 0
    SWP_NOSIZE = 0x0001
    SWP_NOMOVE = 0x0002
    SWP_SHOWWINDOW = 0x0040
    
    # Window style constants
    GWL_STYLE = -16
    GWL_EXSTYLE = -20
    WS_CAPTION = 0x00C00000
    WS_THICKFRAME = 0x00040000
    WS_POPUP = 0x80000000
    WS_EX_TOPMOST = 0x00000008
    
    # Monitor constants
    MONITOR_DEFAULTTONEAREST = 2
    
    # MONITORINFO structure
    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ('cbSize', wintypes.DWORD),
            ('rcMonitor', wintypes.RECT),
            ('rcWork', wintypes.RECT),
            ('dwFlags', wintypes.DWORD)
        ]

def get_window_client_screen_offset(hwnd: int) -> Tuple[int, int]:
    """
    Calculates the screen coordinates (x, y) of the top-left corner 
    of a window's CLIENT area (excluding title bar/borders).
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
    from GameSentenceMiner.owocr.owocr.ocr import OneOCR
except ImportError:
    OneOCR = None
    
try:
    from GameSentenceMiner.owocr.owocr.ocr import GoogleLens, get_regex, MeikiOCR
except ImportError:
    GoogleLens, get_regex, MeikiOCR = None, None, None
except Exception as e:
    GoogleLens, get_regex, MeikiOCR = None, None, None
    logger.exception(f"Error importing OCR engines: {e}")

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
        self.poll_interval = 0.3  # Current polling interval
        self.base_poll_interval = 0.3
        self.fast_poll_interval = 0.1
        self.backoff_steps = [0.1, 0.2, 0.3, 0.4, 0.5]
        self.max_poll_interval = 1.0
        self.last_obs_check_time = 0
        self.last_is_fullscreen: bool = False
        self.last_scene_name = None
        self.last_obs_dimensions_time = 0
        self.last_hwnd_refresh_time = 0

        # Known browser window classes to completely exclude
        self.BROWSER_CLASSES = {
            "Chrome_WidgetWin_1",   # Chrome, Edge (Chromium), Brave, Opera, Vivaldi
            "Chrome_WidgetWin_0",
            "Chrome_WidgetWin_2",
            "MozillaWindowClass",   # Firefox
            "OpWindow",             # Pre-Chromium Opera
            "ApplicationFrameWindow",
        }
        
        self.EXCLUDED_EXES = {
            "ocenaudio.exe",
        }

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
    
    def _get_process_memory_usage(self, hwnd) -> int:
        """Gets the working set size (memory usage) for a window's process."""
        try:
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            
            h_process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not h_process:
                return 0
            
            try:
                mem_counters = PROCESS_MEMORY_COUNTERS()
                mem_counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
                
                if psapi.GetProcessMemoryInfo(h_process, ctypes.byref(mem_counters), mem_counters.cb):
                    return mem_counters.WorkingSetSize
                return 0
            finally:
                kernel32.CloseHandle(h_process)
        except Exception as e:
            logger.debug(f"Error getting memory usage for hwnd {hwnd}: {e}")
            return 0

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
        """Check if a window is a transparent overlay (GSM, Magpie, OBS preview, etc).
        
        Returns TRUE only for windows that should be ignored in obscured checks.
        Regular apps (Discord, VS Code, etc.) should return FALSE even if Electron-based.
        
        Optimized to check cheap properties (class, title) before expensive exe lookup.
        """
        try:
            # Get window class (cheap: just GetClassNameW)
            window_class = self._get_window_class(hwnd)
            
            # Check for Magpie window first (most specific)
            if "Magpie" in window_class:
                return True
            
            # Check for Japanese learning tool overlays by class
            # Qt5152QWindowIcon is LunaTranslator
            if "Qt5" in window_class and "QWindowIcon" in window_class:
                return True
            
            # HwndWrapper[JL;;...] is JL (Japanese Learning tool)
            if "HwndWrapper" in window_class and "[JL;" in window_class:
                return True
            
            # CEF-OSC-WIDGET is RivaTuner Statistics Server (RTSS) overlay, and also NVIDIA GeForce overlay
            if "CEF-OSC-WIDGET" in window_class:
                return True
            
            # Get title (cheap: just GetWindowTextW)
            title = self._get_window_title(hwnd)
            if "Magpie" in title:
                return True
            
            # Check for GSM Overlay by title
            if "GSM Overlay" in title or "gsm_overlay" in title.lower():
                return True
            
            # Check for NVIDIA GeForce Overlay by title
            if "NVIDIA GeForce Overlay" in title or "nvidia geforce overlay" in title.lower():
                return True
            
            # Check for RivaTuner Statistics Server (RTSS) by title
            if "RTSS" in title or "RivaTuner" in title:
                return True
            
            # Electron windows have "Chrome" class - check title for GSM-specific overlays
            if "Chrome" in window_class:
                title_lower = title.lower()
                if "overlay" in title_lower and "gsm" in title_lower:
                    return True
                
                # For Chrome class windows, we need to check exe name
                # to distinguish overlay apps from regular apps like Discord/VS Code
                # This is expensive (OpenProcess + GetModuleFileNameExW) but necessary for Electron
                exe_name = self._get_window_exe_name(hwnd)
                if exe_name:
                    exe_lower = exe_name.lower()
                    
                    # FALSE: Regular Electron apps that should count as obscuring
                    if any(name in exe_lower for name in [
                        "discord.exe",
                        "code.exe", "code - insiders.exe",  # VS Code
                        "slack.exe",
                        "teams.exe",
                        "spotify.exe",
                        "cursor.exe",  # Cursor IDE
                        "windsurf.exe"  # Windsurf IDE
                    ]):
                        return False
            
            # Check executable name for known overlay apps (expensive but necessary for some)
            # Only reach here if not Chrome class or Chrome class didn't match deny list
            # exe_name = self._get_window_exe_name(hwnd)
            # if exe_name:
            #     exe_lower = exe_name.lower()
                
            #     # TRUE: Transparent overlays that sit on top of games
            #     if any(name in exe_lower for name in [
            #         "gsm_overlay.exe",
            #         "obs64.exe", "obs32.exe",  # OBS Studio
            #         "streamlabs obs.exe",
            #         "xsplit.broadcaster.exe",
            #         "gamebar.exe",  # Windows Game Bar
            #         "nvidia share.exe", "nvcontainer.exe",  # GeForce Experience overlay
            #         "lunatranslator.exe",  # LunaTranslator (backup check if class fails)
            #         "jl.exe"  # JL (Japanese Learning) (backup check if class fails)
            #     ]):
            #         return True
            
            return False
        except Exception:
            return False

    def _is_browser_window(self, hwnd) -> bool:
        """Check if the given HWND belongs to a web browser."""
        try:
            class_name = self._get_window_class(hwnd)
            return class_name in self.BROWSER_CLASSES
        except Exception:
            return False

    def _is_window_obscured(self, hwnd) -> bool:
        """Check if the window is mostly obscured by other windows.
        
        Uses padding to account for taskbar and other UI elements that might
        prevent a window from being 100% covered but still effectively obscure the game.
        """
        try:
            # Get target window rect
            target_rect = wintypes.RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(target_rect)):
                return False
            
            target_width = target_rect.right - target_rect.left
            target_height = target_rect.bottom - target_rect.top
            
            if target_width <= 0 or target_height <= 0:
                return True
            
            # Padding to allow for taskbar and small UI elements (mainly bottom for taskbar)
            # Horizontal padding: 10px on each side
            # Vertical padding: 15px top, 80px bottom (typical taskbar height is ~40-48px, use 80 for safety)
            PADDING_LEFT = 10
            PADDING_RIGHT = 10
            PADDING_TOP = 15
            PADDING_BOTTOM = 80  # Account for taskbar
            
            # Create padded target rect for comparison
            padded_target_left = target_rect.left + PADDING_LEFT
            padded_target_right = target_rect.right - PADDING_RIGHT
            padded_target_top = target_rect.top + PADDING_TOP
            padded_target_bottom = target_rect.bottom - PADDING_BOTTOM
            
            current_hwnd = user32.GetWindow(hwnd, GW_HWNDPREV)
            
            while current_hwnd:
                if self._is_overlay_window(current_hwnd):
                    current_hwnd = user32.GetWindow(current_hwnd, GW_HWNDPREV)
                    continue
                
                if user32.IsWindowVisible(current_hwnd):
                    overlapping_rect = wintypes.RECT()
                    if user32.GetWindowRect(current_hwnd, ctypes.byref(overlapping_rect)):
                        # Check if overlapping window covers the padded target area
                        if (overlapping_rect.left <= padded_target_left and
                            overlapping_rect.top <= padded_target_top and
                            overlapping_rect.right >= padded_target_right and
                            overlapping_rect.bottom >= padded_target_bottom):
                            # window_name = self._get_window_title(current_hwnd)
                            # logger.background(f"Window obscured by {window_name} (with padding tolerance)")
                            return True
                
                current_hwnd = user32.GetWindow(current_hwnd, GW_HWNDPREV)
            
            return False
        except Exception as e:
            logger.debug(f"Error checking window occlusion: {e}")
            return False

    def _is_exclusive_fullscreen(self, hwnd) -> bool:
        """Check if the window is in exclusive fullscreen mode."""
        try:
            # Get window style
            style = user32.GetWindowLongW(hwnd, GWL_STYLE)
            
            # Exclusive fullscreen windows typically:
            # 1. Have WS_POPUP style
            # 2. Don't have WS_CAPTION or WS_THICKFRAME
            # 3. Cover the entire monitor
            has_popup = (style & WS_POPUP) != 0
            has_no_caption = (style & WS_CAPTION) == 0
            has_no_thickframe = (style & WS_THICKFRAME) == 0
            
            if not (has_popup and has_no_caption and has_no_thickframe):
                return False
            
            # Get window rectangle
            window_rect = wintypes.RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(window_rect)):
                return False
            
            # Get monitor info for the monitor containing this window
            monitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
            if not monitor:
                return False
            
            monitor_info = MONITORINFO()
            monitor_info.cbSize = ctypes.sizeof(MONITORINFO)
            if not user32.GetMonitorInfoW(monitor, ctypes.byref(monitor_info)):
                return False
            
            # Check if window covers the entire monitor
            mon_rect = monitor_info.rcMonitor
            window_width = window_rect.right - window_rect.left
            window_height = window_rect.bottom - window_rect.top
            monitor_width = mon_rect.right - mon_rect.left
            monitor_height = mon_rect.bottom - mon_rect.top
            
            # Allow small tolerance (1-2 pixels) for matching
            matches_monitor = (
                abs(window_rect.left - mon_rect.left) <= 2 and
                abs(window_rect.top - mon_rect.top) <= 2 and
                abs(window_width - monitor_width) <= 2 and
                abs(window_height - monitor_height) <= 2
            )
            
            return matches_monitor
            
        except Exception as e:
            logger.debug(f"Error checking exclusive fullscreen: {e}")
            return False

    def _find_window_callback(self, hwnd, extra):
        """Callback for EnumWindows."""
        if not user32.IsWindowVisible(hwnd):
            return True

        if self._is_browser_window(hwnd):
            return True 

        # Match based on OBS source info (window class)
        if self.last_target_info:
            tgt_class = self.last_target_info.get('window_class')
            if tgt_class:
                window_class = self._get_window_class(hwnd)
                if window_class and window_class.lower() == tgt_class.lower():
                    self.found_hwnds.append(hwnd)
                    return True

        # Fallback 1: match on exe name
        if self.last_target_info:
            tgt_exe = self.last_target_info.get('exe')
            if tgt_exe:
                window_exe = self._get_window_exe_name(hwnd)
                if window_exe in self.EXCLUDED_EXES:
                    return True
                if window_exe and window_exe.lower() == tgt_exe.lower():
                    self.found_hwnds.append(hwnd)
                    return True

        # Fallback 2: match on game name in title
        if self.last_game_name:
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                title = buff.value
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
        """Attempts to find the HWND for the current game, robustly excluding browsers."""
        try:
            window_info = get_window_info_from_source(scene_name=get_current_scene())
        except Exception as e:
            logger.exception(f"Error getting window info from source: {e}")
            window_info = None
            
        current_game = get_current_game()
        
        if not window_info and not current_game:
            return None

        if window_info and "chrome" in window_info.get('class', '').lower():
            logger.info("OBS source appears to be a browser window - skipping target search")
            return None
            
        self.last_target_info = window_info if window_info else {}
        self.last_game_name = current_game if current_game else ""
        self.found_hwnds = []
        
        cmp_func = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, ctypes.c_void_p)
        user32.EnumWindows(cmp_func(self._find_window_callback), 0)
        
        if self.found_hwnds:
            # If only one window found, return it
            if len(self.found_hwnds) == 1:
                return self.found_hwnds[0]
            
            # Multiple windows found - prefer foreground if it's one of them
            fg = user32.GetForegroundWindow()
            if fg in self.found_hwnds:
                return fg
            
            # Otherwise, select the one with highest memory usage
            best_hwnd = None
            max_memory = 0
            
            for hwnd in self.found_hwnds:
                memory = self._get_process_memory_usage(hwnd)
                if memory > max_memory:
                    max_memory = memory
                    best_hwnd = hwnd
            
            if best_hwnd:
                return best_hwnd
            
            # Fallback to first window if memory query fails
            return self.found_hwnds[0]
        
        return None

    def _detect_current_monitor(self, rect: Tuple[int, int, int, int]) -> int:
        """Determines which monitor index (0-based) contains the largest portion of the window."""
        if not mss:
            return -1
        
        try:
            with mss.mss() as sct:
                monitors = sct.monitors[1:] # Skip the "all in one" monitor 0
                max_area = 0
                best_monitor_idx = -1
                
                wx1, wy1, wx2, wy2 = rect
                window_area = (wx2 - wx1) * (wy2 - wy1)
                if window_area <= 0:
                    return -1
                
                for i, monitor in enumerate(monitors):
                    mx1, my1 = monitor['left'], monitor['top']
                    mx2, my2 = mx1 + monitor['width'], my1 + monitor['height']
                    
                    # Calculate intersection
                    ix1 = max(wx1, mx1)
                    iy1 = max(wy1, my1)
                    ix2 = min(wx2, mx2)
                    iy2 = min(wy2, my2)
                    
                    if ix1 < ix2 and iy1 < iy2:
                        intersection_area = (ix2 - ix1) * (iy2 - iy1)
                        if intersection_area > max_area:
                            max_area = intersection_area
                            best_monitor_idx = i
                
                return best_monitor_idx
        except Exception as e:
            logger.debug(f"Error detecting monitor: {e}")
            return -1

    async def check_and_send(self):
        """Checks window state and broadcasts if changed."""
        if not is_windows():
            return

        now = time.time()
        scene_changed = False
        if now - self.last_obs_check_time > 2.0:  # Check every 2 seconds
            self.last_obs_check_time = now
            try:
                current_scene = get_current_scene()
                if current_scene != self.last_scene_name:
                    if self.last_scene_name:
                        logger.info(f"Scene changed from '{self.last_scene_name}' to '{current_scene}' - Resetting OBS dimensions.")
                    overlay_processor.obs_width = None
                    overlay_processor.obs_height = None
                    scene_changed = True
                    self.last_scene_name = current_scene
                
                new_info = get_window_info_from_source(scene_name=current_scene)
                
                if new_info and self.last_target_info:
                    if (new_info.get('title') != self.last_target_info.get('title') or 
                        new_info.get('class') != self.last_target_info.get('class')):
                        logger.info(f"OBS Source changed from '{self.last_target_info.get('title')}' to '{new_info.get('title')}' - Resetting target.")
                        self.target_hwnd = None
                        self.retry_find_count = 0
                        overlay_processor.obs_width = None
                        overlay_processor.obs_height = None
            except Exception:
                pass

        # Check if hwnd needs refresh: None, retry limit, or stale (10+ seconds)
        should_refresh_hwnd = False
        if not self.target_hwnd or self.retry_find_count > 10:
            should_refresh_hwnd = True
        elif now - self.last_hwnd_refresh_time > 10.0:
            should_refresh_hwnd = True
        
        if should_refresh_hwnd:
            self.target_hwnd = self.find_target_hwnd()
            self.retry_find_count = 0
            self.last_hwnd_refresh_time = now
        
        if not self.target_hwnd:
            self.retry_find_count += 1
            return

        current_state = "unknown"
        current_rect = None
        is_fullscreen = False
        
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
            else:
                # Window is visible but not focused - check if completely obscured
                is_obscured = self._is_window_obscured(self.target_hwnd)
                if is_obscured:
                    current_state = "obscured"
                else:
                    current_state = "background"

            # Check for exclusive fullscreen
            is_fullscreen = self._is_exclusive_fullscreen(self.target_hwnd)

            # Only check rect if visible (not minimized)
            current_rect_struct = wintypes.RECT()
            if user32.GetWindowRect(self.target_hwnd, ctypes.byref(current_rect_struct)):
                current_rect = (current_rect_struct.left, current_rect_struct.top, 
                                current_rect_struct.right, current_rect_struct.bottom)

        window_moved_or_resized = (current_rect != self.last_window_rect)
        if window_moved_or_resized:
            if self.last_window_rect is not None and current_rect is not None:
                logger.debug(f"Target window moved or resized: {self.last_window_rect} -> {current_rect}")
            self.window_stable_count = 0
            self.poll_interval = self.fast_poll_interval
            # Reset OBS dimensions on window size/position change
            overlay_processor.obs_width = None
            overlay_processor.obs_height = None
        else:
            self.window_stable_count += 1
            if self.window_stable_count > 0 and self.window_stable_count <= len(self.backoff_steps):
                self.poll_interval = self.backoff_steps[self.window_stable_count - 1]
            elif self.window_stable_count > len(self.backoff_steps):
                self.poll_interval = self.base_poll_interval
            
            # Check for monitor change if window has been stable for a moment
            if current_rect and is_windows() and self.window_stable_count == 2:
                best_monitor = self._detect_current_monitor(current_rect)
                overlay_cfg = get_overlay_config()
                if best_monitor != -1 and overlay_cfg.monitor_to_capture != best_monitor:
                    logger.info(f"Window moved to Monitor {best_monitor + 1}. Updating config.")
                    overlay_cfg.monitor_to_capture = best_monitor
                    get_master_config().save()
                    asyncio.create_task(
                        overlay_processor.reprocess_and_send_last_results()
                    )

        # Update Magpie info
        self.update_magpie_info()
        magpie_changed = self.magpie_info != self.last_magpie_info

        game_name_ref = self.last_target_info.get('title', self.last_game_name)

        fullscreen_changed = is_fullscreen != self.last_is_fullscreen

        if current_state != self.last_state or magpie_changed or fullscreen_changed:
            logger.debug(f"Window state changed: {self.last_state} -> {current_state} (game: {game_name_ref}, fullscreen: {is_fullscreen})")
            self.last_state = current_state
            self.last_is_fullscreen = is_fullscreen
            
            # Determine if we should recommend manual mode
            # Recommend when: fullscreen detected AND overlay config shows manual mode is OFF
            overlay_cfg = get_overlay_config()
            recommend_manual = is_fullscreen and current_state in ["active", "background"]
            
            payload = {
                "type": "window_state",
                "data": current_state,
                "game": game_name_ref,
                "magpie_info": self.magpie_info,
                "is_fullscreen": is_fullscreen,
                "recommend_manual_mode": recommend_manual
            }
            
            if websocket_manager.has_clients(ID_OVERLAY):
                await websocket_manager.send(ID_OVERLAY, json.dumps(payload))
        
        # Always update last_magpie_info after checking for changes to prevent stale state
        self.last_magpie_info = copy.deepcopy(self.magpie_info) if self.magpie_info else None
        
        # Check for stale OBS dimensions (reset every 60 seconds)
        if overlay_processor.obs_width is not None and overlay_processor.obs_height is not None:
            if now - self.last_obs_dimensions_time > 60.0:
                logger.debug("OBS dimensions are stale (>60s), resetting for next capture")
                overlay_processor.obs_width = None
                overlay_processor.obs_height = None
                self.last_obs_dimensions_time = now
        
        # Smart Update
        if (magpie_changed or window_moved_or_resized or scene_changed):
            if current_state not in ["minimized", "closed"]:
                logger.display("Window geometry, Magpie, or scene changed - reprocessing last OCR result")
                asyncio.create_task(
                    overlay_processor.reprocess_and_send_last_results()
                )
            self.poll_interval = self.base_poll_interval
        else:
            self.poll_interval = min(self.max_poll_interval, self.poll_interval + 0.05)

        self.last_window_rect = current_rect

    async def activate_target_window(self):
        """
        More aggressively activates the target game window on Windows.
        """
        if not is_windows():
            logger.debug("Window activation only supported on Windows")
            return
        
        if not self.target_hwnd:
            logger.debug("No target window to activate")
            return
        
        try:
            hwnd = self.target_hwnd
            
            # Restore if minimized
            if user32.IsIconic(hwnd):
                logger.debug("Target window minimized, restoring")
                user32.ShowWindow(hwnd, SW_RESTORE)
            
            # Get current foreground window and thread IDs
            foreground_hwnd = user32.GetForegroundWindow()
            if foreground_hwnd == hwnd:
                logger.debug("Target window already in foreground")
                return
            
            current_thread = kernel32.GetCurrentThreadId()
            foreground_thread = user32.GetWindowThreadProcessId(foreground_hwnd, None)
            
            old_timeout = wintypes.DWORD()
            
            # Attach threads and temporarily disable foreground lock timeout
            attached = False
            if current_thread != foreground_thread:
                if user32.AttachThreadInput(current_thread, foreground_thread, True):
                    attached = True
                    # Save old timeout
                    user32.SystemParametersInfoW(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ctypes.byref(old_timeout), 0)
                    # Set timeout to 0 (bypasses lock)
                    user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ctypes.c_void_p(0), SPIF_SENDCHANGE)
            
            # Try primary method
            if user32.SetForegroundWindow(hwnd):
                logger.debug(f"Successfully activated target window (HWND: {hwnd})")
            else:
                logger.debug("SetForegroundWindow failed, trying fallbacks")
                
                # Fallback 1: Bring to top + show
                user32.BringWindowToTop(hwnd)
                user32.ShowWindow(hwnd, SW_SHOW)
                
                # Fallback 2: Simulate null input to grant permission (common hack)
                INPUT_MOUSE = 0
                class INPUT(ctypes.Structure):
                    _fields_ = [("type", wintypes.DWORD),
                                ("dx", wintypes.LONG), ("dy", wintypes.LONG),
                                ("mouseData", wintypes.DWORD),
                                ("dwFlags", wintypes.DWORD),
                                ("time", wintypes.DWORD),
                                ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG))]
                
                inputs = (INPUT * 1)()
                inputs[0].type = INPUT_MOUSE
                # All zeros = null mouse input
                user32.SendInput(1, inputs, ctypes.sizeof(INPUT))
                user32.SetForegroundWindow(hwnd)
                
                # Fallback 3: Temporary topmost (visually aggressive, but works)
                if not user32.SetForegroundWindow(hwnd):
                    user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE)  # HWND_TOPMOST = -1
                    user32.SetForegroundWindow(hwnd)
                    user32.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)  # Remove topmost
            
            # Clean up: restore timeout and detach threads
            if attached:
                user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ctypes.byref(old_timeout), SPIF_SENDCHANGE)
                user32.AttachThreadInput(current_thread, foreground_thread, False)
                
        except Exception as e:
            logger.exception(f"Error aggressively activating target window: {e}")

class OverlayThread(threading.Thread):
    """
    A thread to run the overlay processing loop.
    """
    def __init__(self):
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self.daemon = True
        self.first_time_run = True
        
        self.window_monitor = WindowStateMonitor()
        overlay_processor.window_monitor = self.window_monitor
        overlay_processor.processing_loop = self.loop

    def run(self):
        """Runs the overlay processing loop."""
        asyncio.set_event_loop(self.loop)
        if is_windows():
            self.loop.create_task(self.window_monitor_loop())
        self.loop.create_task(self.overlay_loop())
        self.loop.run_forever()

    async def window_monitor_loop(self):
        """Secondary loop to monitor window state (High Frequency)."""
        while True:
            try:
                if websocket_manager.has_clients(ID_OVERLAY):
                    await self.window_monitor.check_and_send()
                await asyncio.sleep(self.window_monitor.poll_interval)
            except Exception as e:
                logger.debug(f"Window monitor error: {e}")
                await asyncio.sleep(1)

    async def overlay_loop(self):
        """Main loop to periodically process and send overlay data."""
        while True:
            if websocket_manager.has_clients(ID_OVERLAY):
                if get_config().overlay.periodic:
                    await overlay_processor.find_box_and_send_to_overlay(check_against_last=True, local_ocr_retry=0)
                    await asyncio.sleep(get_config().overlay.periodic_interval)
                elif self.first_time_run:
                    await overlay_processor.find_box_and_send_to_overlay(check_against_last=False, local_ocr_retry=0)
                    self.first_time_run = False
                else:
                    await asyncio.sleep(3)
            else:
                self.first_time_run = True
                await asyncio.sleep(3)

class OverlayProcessor:
    """
    Handles the entire overlay process from screen capture to text extraction.
    """
    
    ENABLE_DETAILED_TIMING = True  # Set to True to enable detailed timing traces in logger.info
    ENABLE_SCALING_DEBUG = True  # Set to True to enable detailed scaling debug logs
    
    # Screenshot scaling factor for performance optimization
    # SCALE_TYPE options:
    # - "fixed": Uses SCREENSHOT_SCALE_FACTOR to scale the image
    # - "forced_minimum": Scales down to MINIMUM_WIDTH/MINIMUM_HEIGHT (whichever is larger)
    SCALE_TYPE = "fixed"
    # SCALE_TYPE = "forced_minimum"
    SCREENSHOT_SCALE_FACTOR = 0.1  # 1.0 = no scaling (only used when SCALE_TYPE = "fixed")
    MINIMUM_WIDTH = 1024
    MINIMUM_HEIGHT = 768
    
    def __init__(self):
        self.config = get_config()
        self.oneocr = None
        self.meikiocr = None
        self.lens = None
        self.regex = None
        self.ready = False
        self.last_oneocr_result = None
        self.last_lens_result = None
        self.current_task = None
        self.windows_warning_shown = False
        self.processing_loop: asyncio.AbstractEventLoop = None
        self.last_sentences = []
        self.sentence_backlog_max_size = 8
        self.remove_used_sentences = True
        self.current_engine_config = None
        self.ss_width = 0
        self.ss_height = 0
        self._current_sequence = 0
        self.punctuation_regex = regex.compile(r'[\p{P}\p{S}\p{Z}]')
        self.calculated_width_scale_factor = 1.0
        self.calculated_height_scale_factor = 1.0
        self.obs_width = None
        self.obs_height = None
        
        # State for reprocessing without re-scanning
        self.last_raw_results: Optional[List[Dict[str, Any]]] = None
        self.last_raw_source: Optional[str] = None
        self.last_img_dimensions: Tuple[int, int] = (0, 0)
        self.last_scan_window_offset: Tuple[int, int] = (0, 0)

        # Reference to WindowStateMonitor (injected by OverlayThread)
        self.window_monitor: Optional[WindowStateMonitor] = None

    def init(self):
        """Initializes the OCR engines and configuration."""
        try:
            if self.config.overlay.websocket_port and all([GoogleLens, get_regex]):
                logger.debug("Initializing OCR engines...")
                self.ocr_language = get_ocr_language()
                self.regex = get_regex(self.ocr_language)
                self.ready = True
            else:
                logger.warning("OCR dependencies not found or websocket port not configured. OCR functionality will be disabled.")
            
            if is_windows:
                set_dpi_awareness()
                
            if not mss:
                logger.warning("MSS library not found. Screenshot functionality may be limited.")
        except Exception as e:
            logger.exception(f"Error initializing OCR engines for overlay, try installing owocr in OCR tab of GSM: {e}")
            self.oneocr = None
            self.lens = None
            self.regex = None
            
    def _is_sentence_recycled(self, line_text: str) -> bool:
        """Checks if a line was used before based on the backlog."""
        return line_text in game_log.previous_lines
    
    def _get_effective_engine(self) -> str:
        """Determines which engine to use based on platform and configuration."""
        overlay_config = get_overlay_config()
        engine = overlay_config.engine_v2
        if not is_windows() and engine in [OverlayEngine.ONEOCR.value, OverlayEngine.LENS.value]:
            logger.info(f"Forcing MeikiOCR on non-Windows platform (selected: {engine})")
            return OverlayEngine.MEIKIOCR.value
        return engine
    
    def _ensure_correct_engine_loaded(self):
        """Ensures the correct OCR engine is loaded based on current configuration."""
        effective_engine = self._get_effective_engine()
        
        if self.current_engine_config == effective_engine:
            return
        
        if self.current_engine_config:
            logger.info(f"Engine config changed from {self.current_engine_config} to {effective_engine}")
        
        for engine in [self.oneocr, self.meikiocr, self.lens]:
            if engine:
                try:
                    if hasattr(engine, 'close'):
                        engine.close()
                except Exception as e:
                    logger.debug(f"Error closing engine: {e}")
        
        self.oneocr = None
        self.meikiocr = None
        self.lens = None
        self.current_engine_config = effective_engine
            
    async def find_box_and_send_to_overlay(self, line: 'GameLine' = None, check_against_last: bool = False, custom_threshold: float = None, dict_from_ocr = None, sequence: int = None, local_ocr_retry = 5, source: TextSource = None):
        """Sends the detected text boxes to the overlay via WebSocket."""
        if sequence is not None and sequence != self._current_sequence:
            logger.debug(f"Skipping outdated overlay request (sequence {sequence}, current {self._current_sequence})")
            return
        
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
            try:
                await self.current_task
            except asyncio.CancelledError:
                logger.debug("Previous OCR task was cancelled")
        
        self._ensure_correct_engine_loaded()
        effective_engine = self._get_effective_engine()
        
        if effective_engine == OverlayEngine.LENS.value:
            if GoogleLens and not self.lens:
                self.lens = GoogleLens(lang=get_ocr_language(), get_furigana_sens_from_file=False)
            # On Windows, also load OneOCR for the Local -> Lens workflow
            if is_windows() and OneOCR and not self.oneocr:
                self.oneocr = OneOCR(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        elif effective_engine == OverlayEngine.ONEOCR.value:
            if OneOCR and not self.oneocr:
                self.oneocr = OneOCR(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        elif effective_engine == OverlayEngine.MEIKIOCR.value:
            if MeikiOCR and not self.meikiocr:
                self.meikiocr = MeikiOCR(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        
        self.current_task = self.processing_loop.create_task(
            self.find_box_for_sentence(line, check_against_last, custom_threshold, dict_from_ocr=dict_from_ocr, sequence=sequence, local_ocr_retry=local_ocr_retry, source=source)
        )
        try:
            await self.current_task
        except asyncio.CancelledError:
            logger.debug("OCR task was cancelled")

    async def find_box_for_sentence(self, line: 'GameLine' = None, check_against_last: bool = False, custom_threshold: float = None, dict_from_ocr = None, sequence: int = None, local_ocr_retry = 5, source: TextSource = None) -> List[Dict[str, Any]]:
        if sequence is not None and sequence != self._current_sequence:
            logger.debug(f"Skipping outdated OCR work (sequence {sequence}, current {self._current_sequence})")
            return []
        
        try:
            return await self._do_work(line, check_against_last=check_against_last, custom_threshold=custom_threshold, dict_from_ocr=dict_from_ocr, local_ocr_retry=local_ocr_retry, source=source)
        except Exception as e:
            logger.exception(f"Error during OCR processing: {e}")
            return []
        
    @staticmethod
    def get_monitor_workarea(monitor_index=0):
        with mss.mss() as sct:
            monitors = sct.monitors[1:]
            monitor = monitors[monitor_index] if 0 <= monitor_index + len(monitors) else monitors[0]
            return {
                "left": monitor["left"],
                "top": monitor["top"],
                "width": monitor["width"],
                "height": monitor["height"] - 1
            }


    def _get_screenshot_and_offset(self) -> Tuple[Image.Image | None, int, int, int, int]:
        monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)
        monitor_w, monitor_h = monitor['width'], monitor['height']

        # If configured to use full-screen MSS instead of OBS, prefer that method.
        try:
            overlay_cfg = get_overlay_config()
            use_mss_override = bool(getattr(overlay_cfg, 'ocr_full_screen_instead_of_obs', False))
        except Exception:
            use_mss_override = False

        if use_mss_override:
            logger.info("Overlay configured to use full-screen MSS for OCR (debug). Taking MSS screenshot.")
            wayland = is_wayland()
            if mss and not wayland:
                try:
                    with mss.mss() as sct:
                        sct_img = sct.grab(monitor)
                        img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
                        if CONVERT_TO_GRAYSCALE:
                            img = img.convert('L')
                        if SAVE_DEBUG_IMAGES:
                            img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_mss_override.png"))
                        self.ss_width = img.width
                        self.ss_height = img.height
                        return img, 0, 0, monitor_w, monitor_h
                except Exception as e:
                    logger.debug(f"MSS screenshot (override) failed: {e}")

        if is_windows() and self.window_monitor and not use_mss_override:
            hwnd = self.window_monitor.target_hwnd
            if not hwnd:
                hwnd = self.window_monitor.find_target_hwnd()
                
            if hwnd and user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
                try:
                    obs_img = get_screenshot_PIL(compression=90, img_format='jpg', width=self.obs_width, height=self.obs_height)
                    
                    if obs_img:
                        if CONVERT_TO_GRAYSCALE:
                            obs_img = obs_img.convert('L')
                        # Don't set obs_width/obs_height here - let scaling logic in get_image_to_ocr handle it
                        
                        off_x, off_y = get_window_client_screen_offset(hwnd)
                        final_off_x = off_x - monitor['left']
                        final_off_y = off_y - monitor['top']
                        
                        if SAVE_DEBUG_IMAGES:
                            obs_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_obs.png"))
                        
                        if self.ENABLE_SCALING_DEBUG:
                            logger.debug(f"Captured OBS window {obs_img.width}x{obs_img.height}. Offset: ({final_off_x}, {final_off_y})")
                        self.ss_width = obs_img.width
                        self.ss_height = obs_img.height
                        return obs_img, final_off_x, final_off_y, monitor_w, monitor_h
                except Exception as e:
                    logger.debug(f"OBS Window capture failed, falling back to MSS: {e}")

        wayland = is_wayland()
        
        if mss and not wayland:
            try:
                with mss.mss() as sct:
                    sct_img = sct.grab(monitor)
                    img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
                    if CONVERT_TO_GRAYSCALE:
                        img = img.convert('L')
                    if SAVE_DEBUG_IMAGES:
                        img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                    self.ss_width = img.width
                    self.ss_height = img.height
                    return img, 0, 0, monitor_w, monitor_h
            except Exception as e:
                logger.debug(f"MSS screenshot failed: {e}")

        try:
            logger.debug("Attempting fallback screenshot via OBS sources (Full Scene)")
            obs_img = get_screenshot_PIL(compression=100, img_format='jpg', width=None, height=None)
            if obs_img:
                if CONVERT_TO_GRAYSCALE:
                    obs_img = obs_img.convert('L')
                if SAVE_DEBUG_IMAGES:
                    obs_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                self.ss_width = obs_img.width
                self.ss_height = obs_img.height
                return obs_img, 0, 0, monitor_w, monitor_h
        except Exception as e:
            logger.debug(f"OBS fallback screenshot failed: {e}")

        raise RuntimeError("Failed to capture screen.")

    def _create_composite_image(
        self, 
        full_screenshot: Image.Image,
        crop_coords_list: List[Tuple[int, int, int, int]],
        monitor_width: int,
        monitor_height: int,
        source: str = None
    ) -> Image.Image:
        """Creates a new image by pasting cropped text regions onto a transparent background."""
        if not crop_coords_list:
            return full_screenshot

        composite_img = Image.new("RGBA", (full_screenshot.width, full_screenshot.height), (0, 0, 0, 0))

        for crop_coords in crop_coords_list:
            x1, y1, x2, y2, = crop_coords[:4]
            x1 = max(0, min(x1, full_screenshot.width))
            y1 = max(0, min(y1, full_screenshot.height))
            x2 = max(x1, min(x2, full_screenshot.width))
            y2 = max(y1, min(y2, full_screenshot.height))
            
            if x1 >= x2 or y1 >= y2:
                continue
            try:
                cropped_image = full_screenshot.crop((x1, y1, x2, y2))
            except ValueError:
                continue
                
            paste_x = math.floor(x1)
            paste_y = math.floor(y1)
            composite_img.paste(cropped_image, (paste_x, paste_y))
            
        if SAVE_DEBUG_IMAGES:
            composite_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_trimmed.png"))
        
        return composite_img
    
    def get_image_to_ocr(self) -> Image.Image | None:
        full_screenshot, off_x, off_y, monitor_width, monitor_height = self._get_screenshot_and_offset()
        
        if not full_screenshot:
            logger.warning("Failed to get a screenshot.")
            return None
            
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        if get_overlay_config().use_ocr_area_config:
            overlay_config = get_ocr_config()
            overlay_config.scale_to_custom_size(self.ss_width, self.ss_height)
            if overlay_config:
                full_screenshot, crop_offset = apply_ocr_config_to_image(full_screenshot, overlay_config, both_types=True, return_full_size=True)
            
                off_x += crop_offset[0]
                off_y += crop_offset[1]

                if SAVE_DEBUG_IMAGES:
                    full_screenshot.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_with_config.png"))
        
        # Apply scaling based on SCALE_TYPE
        original_width, original_height = full_screenshot.size
        
        # Check if image needs scaling (either first time or dimensions changed)
        needs_scaling = (
            self.obs_width is None or 
            self.obs_height is None or 
            original_width != self.obs_width or 
            original_height != self.obs_height
        )
        
        if self.ENABLE_SCALING_DEBUG:
            logger.debug(f"Scaling check: original={original_width}x{original_height}, cached={self.obs_width}x{self.obs_height}, needs_scaling={needs_scaling}")

        scaled: Optional[ScaledSize] = None

        if needs_scaling:
            scaled = scale_dimensions_by_aspect_buckets(
                original_width,
                original_height,
                allow_upscale=True
            )

        if scaled and (scaled.width != original_width or scaled.height != original_height):
            self.calculated_width_scale_factor = scaled.scale_x
            self.calculated_height_scale_factor = scaled.scale_y
            full_screenshot = scale_pil_image(full_screenshot, scaled, resample=Image.Resampling.BILINEAR)
            self.obs_width = scaled.width
            self.obs_height = scaled.height
            if self.window_monitor:
                self.window_monitor.last_obs_dimensions_time = time.time()
            if self.ENABLE_SCALING_DEBUG:
                logger.debug(
                    f"Scaled screenshot ({self.SCALE_TYPE}) from {original_width}x{original_height} "
                    f"to {scaled.width}x{scaled.height} (factors: {self.calculated_width_scale_factor:.3f}, {self.calculated_height_scale_factor:.3f})"
                )
            if SAVE_DEBUG_IMAGES:
                full_screenshot.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_scaled.png"))
        elif not needs_scaling:
            # Image is already at cached scaled size, keep existing scale factors
            if self.ENABLE_SCALING_DEBUG:
                logger.debug(f"Using cached dimensions {self.obs_width}x{self.obs_height}, scale factors: {self.calculated_width_scale_factor:.3f}x{self.calculated_height_scale_factor:.3f}")
        else:
            # No scaling was applied (shouldn't happen but fallback)
            self.calculated_width_scale_factor = 1.0
            self.calculated_height_scale_factor = 1.0
            
        return full_screenshot, off_x, off_y, monitor_width, monitor_height

    async def _do_work(self, line: 'GameLine' = None, check_against_last: bool = False, custom_threshold: float = None, dict_from_ocr = None, local_ocr_retry = 5, source: TextSource = None) -> Tuple[List[Dict[str, Any]], int]:
        """The main OCR workflow with cancellation support."""
        # logger.background("Finding text for overlay...")
        start_time = datetime.now()
        timing_start = time.time()
        effective_engine = self._get_effective_engine()
        
        if self.ENABLE_DETAILED_TIMING:
            logger.info("Starting OCR workflow timing")
        
        self.sentence_is_recycled = self._is_sentence_recycled(line.text) if line else False
        sentence_to_check = line.text.replace(" ", "").replace("\t", "").replace("\n", "").replace("\r", "") if line else None
        
        if not self.lens and not self.oneocr and not self.meikiocr:
            logger.error("OCR engines are not initialized. Cannot perform OCR for Overlay.")
            self.init()
            return []
        
        # if get_config().overlay.scan_delay > 0:
        #     await asyncio.sleep(get_config().overlay.scan_delay)

        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()

        full_screenshot, off_x, off_y, monitor_width, monitor_height = self.get_image_to_ocr()
        if not full_screenshot:
            return []
        
        if self.ENABLE_DETAILED_TIMING:
            elapsed = (time.time() - timing_start) * 1000
            logger.info(f"Screenshot capture time: {elapsed:.1f}ms")
        
        local_ocr_engine = self.oneocr or self.meikiocr
        crop_coords_list = []
        oneocr_final = []
        if local_ocr_engine:
            # Assume Text from Source is already Stable
            source = line.source if line and line.source else source
            tries = max(1, 1 if source in [TextSource.OCR, TextSource.HOTKEY] else local_ocr_retry)
            # logger.background(f"Using local OCR engine '{local_ocr_engine.readable_name}' with {tries} tries for overlay. TextSource: {line.source if line else source or 'N/A'}")
            last_result_flattened = ""
            last_scan_time = None
            total_ocr_time = 0  # Track actual OCR processing time
            for i in range(tries):
                if i > 0:
                    # max_sleep = 1 if i > 5 else 0.6
                    try:
                        elapsed = time.time() - last_scan_time
                        sleep_duration = max(0, 1 - elapsed)
                        
                        if sleep_duration > 0:
                            await asyncio.sleep(sleep_duration)
                        
                        # Re-capture if retrying, otherwise we are OCRing the same static image
                        full_screenshot, off_x, off_y, monitor_width, monitor_height = self.get_image_to_ocr()
                    except asyncio.CancelledError:
                        raise
                
                ocr_start = time.time()
                result = local_ocr_engine(
                    full_screenshot,
                    return_coords=True,
                    multiple_crop_coords=True,
                    return_one_box=False,
                    furigana_filter_sensitivity=get_overlay_config().minimum_character_size,
                )
                ocr_end = time.time()
                total_ocr_time += (ocr_end - ocr_start)
                last_scan_time = ocr_end
                
                res, text, oneocr_results, crop_coords_list, crop_coords, response_dict = (list(result) + [None]*6)[:6]
                
                if not res or not text:
                    continue
                
                if not crop_coords_list:
                    continue
                
                # # Early abort on blank results during retry
                # if i > 0 and not text:
                #     logger.debug("Retry returned no text, aborting further attempts")
                #     break
                
                if sentence_to_check:
                    oneocr_results = self._correct_ocr_with_backlog(oneocr_results, sentence_to_check)
                
                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()
                
                text_str = "".join([t for t in text if self.regex.match(t)])
                stabilized = False
                if text_str and last_result_flattened and text_str == last_result_flattened or (sentence_to_check and self.punctuation_regex.sub('', sentence_to_check) in text_str):
                    # logger.background(f"Text stabilized after {i+1} tries: {text_str}")
                    stabilized = True
                last_result_flattened = text_str
                # logger.display(f"Local OCR found text: {text_str}")
                
                if self.last_oneocr_result and check_against_last:
                    # Quick length check optimization before fuzzy matching
                    if abs(len(text_str) - len(self.last_oneocr_result)) > 5:
                        score = 0
                    else:
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
                
                self.last_raw_results = copy.deepcopy(oneocr_results)
                self.last_raw_source = 'local'
                self.last_img_dimensions = full_screenshot.size
                self.last_scan_window_offset = (off_x, off_y)
                
                oneocr_final = self._convert_oneocr_results_to_percentages(
                    oneocr_results, 
                    monitor_width, 
                    monitor_height,
                    off_x, off_y
                )

                data = {
                    "type": "word_coordinates",
                    "data": oneocr_final,
                    "is_sentence_recycled": self.sentence_is_recycled
                }
                
                await send_word_coordinates_to_overlay(data)
                
                if is_beangate:
                    with open("oneocr_results.json", "w", encoding="utf-8") as f:
                        f.write(json.dumps(oneocr_final, ensure_ascii=False, indent=2))

                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()
                
                if stabilized:
                    break
                
                
            # Only return early if the effective engine is local-only (not Lens)
            # When Lens is configured, we want to continue to the Lens scan with the composite image
            if effective_engine in [OverlayEngine.ONEOCR.value, OverlayEngine.MEIKIOCR.value]:
                if not oneocr_final:
                    logger.warning("Local OCR did not return any text boxes for overlay.")
                    return
                # Log completion with comprehensive details
                elapsed_ms = (datetime.now() - start_time).total_seconds() * 1000
                ocr_ms = total_ocr_time * 1000
                engine_name = local_ocr_engine.readable_name if local_ocr_engine else "Local OCR"
                
                if self.ENABLE_DETAILED_TIMING:
                    total_elapsed = (time.time() - timing_start) * 1000
                    logger.info(f"Local OCR workflow complete: {total_elapsed:.1f}ms (OCR: {ocr_ms:.1f}ms, processing: {total_elapsed - ocr_ms:.1f}ms)")
                
                logger.info(
                    "Overlay OCR complete: {} sent {} text boxes (total: {}ms, OCR: {}ms, tries: {}",
                    engine_name,
                    len(oneocr_final) if oneocr_final else 0,
                    int(elapsed_ms),
                    int(ocr_ms),
                    i + 1,
                )
                
                if source and source == TextSource.HOTKEY and get_overlay_config().send_hotkey_text_to_texthooker:
                    from GameSentenceMiner.gametext import add_line_to_text_log
                    logger.info("Sending overlay text to texthooker due to hotkey trigger.")
                    await add_line_to_text_log(text_str, line_time=datetime.now(), source=source, skip_overlay=True)
                return
            
            if crop_coords_list:
                composite_image = self._create_composite_image(
                    full_screenshot, 
                    crop_coords_list, 
                    monitor_width, 
                    monitor_height
                )
            else:
                composite_image = None
        
        composite_image.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_before_lens.png"))
        
        # If we have a composite image from local OCR and lens is available, use it for lens scan
        # This handles the Local -> Lens workflow on Windows
        if not composite_image:
            composite_image = full_screenshot
        
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        lens_start = time.time()
        result = self.lens(
            composite_image,
            return_coords=True,
            furigana_filter_sensitivity=get_overlay_config().minimum_character_size
        )
        lens_ocr_time = time.time() - lens_start
        
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
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
        
        self.last_raw_results = copy.deepcopy(response_dict)
        self.last_raw_source = 'lens'
        self.last_img_dimensions = composite_image.size
        self.last_scan_window_offset = (off_x, off_y)

        # Get current magpie info for coordinate adjustment
        magpie_info = None
        if hasattr(self, 'window_monitor') and self.window_monitor:
            magpie_info = self.window_monitor.magpie_info

        extracted_data = self._extract_text_with_pixel_boxes(
            api_response=response_dict,
            original_width=monitor_width,
            original_height=monitor_height,
            crop_x=off_x,
            crop_y=off_y,
            crop_width=composite_image.width,
            crop_height=composite_image.height,
            use_percentages=True,
            magpie_info=magpie_info
        )

        if sentence_to_check:
            extracted_data = self._correct_ocr_with_backlog(extracted_data, sentence_to_check)
            
        data = {
            "type": "word_coordinates",
            "data": extracted_data,
            "is_sentence_recycled": self.sentence_is_recycled
        }

        await send_word_coordinates_to_overlay(data)
        
        # Log completion with comprehensive details
        elapsed_ms = (datetime.now() - start_time).total_seconds() * 1000
        ocr_ms = lens_ocr_time * 1000
        engine_name = "Google Lens"
        
        if self.ENABLE_DETAILED_TIMING:
            total_elapsed = (time.time() - timing_start) * 1000
            logger.info(f"Google Lens workflow complete: {total_elapsed:.1f}ms (OCR: {ocr_ms:.1f}ms, processing: {total_elapsed - ocr_ms:.1f}ms)")
        
        logger.info(
            "Overlay OCR complete: {} sent {} text boxes (total: {}ms, OCR: {}ms)",
            engine_name,
            len(extracted_data),
            int(elapsed_ms),
            int(ocr_ms),
        )
        
        if source and source == TextSource.HOTKEY and get_overlay_config().send_hotkey_text_to_texthooker:
            # Send overlay text to texthooker when triggered by hotkey
            logger.info("Sending overlay text to texthooker due to hotkey trigger.")
            from GameSentenceMiner.gametext import add_line_to_text_log
            await add_line_to_text_log(text_str, line_time=start_time, source=source)

    async def reprocess_and_send_last_results(self):
        """Reprocesses the last known raw OCR results with updated window coordinates."""
        if not self.last_raw_results or not self.last_raw_source:
            logger.debug("No previous OCR results to reprocess.")
            return

        monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)
        monitor_w, monitor_h = monitor['width'], monitor['height']

        off_x, off_y = 0, 0
        current_content_w, current_content_h = self.last_img_dimensions

        if is_windows() and self.window_monitor and self.window_monitor.target_hwnd:
            hwnd = self.window_monitor.target_hwnd
            if user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
                raw_off_x, raw_off_y = get_window_client_screen_offset(hwnd)
                off_x = raw_off_x - monitor['left']
                off_y = raw_off_y - monitor['top']
                
                client_rect = wintypes.RECT()
                if user32.GetClientRect(hwnd, ctypes.byref(client_rect)):
                    current_content_w = client_rect.right
                    current_content_h = client_rect.bottom

        logger.debug(f"Reprocessing overlay with current offset: ({off_x}, {off_y})")

        # Get current magpie info for coordinate adjustment
        magpie_info = None
        if hasattr(self, 'window_monitor') and self.window_monitor:
            magpie_info = self.window_monitor.magpie_info
            logger.debug(f"Reprocessing with magpie_info: {magpie_info}")

        final_data = []

        if self.last_raw_source == 'local':
            final_data = self._convert_oneocr_results_to_percentages(
                copy.deepcopy(self.last_raw_results),
                monitor_w,
                monitor_h,
                off_x, off_y
            )
            
        elif self.last_raw_source == 'lens':
            final_data = self._extract_text_with_pixel_boxes(
                api_response=copy.deepcopy(self.last_raw_results),
                original_width=monitor_w,
                original_height=monitor_h,
                crop_x=off_x,
                crop_y=off_y,
                crop_width=current_content_w,
                crop_height=current_content_h,
                use_percentages=True,
                magpie_info=magpie_info
            )

        if final_data:
            data = {
                "type": "word_coordinates",
                "data": final_data,
                "is_sentence_recycled": self.sentence_is_recycled
            }
            await send_word_coordinates_to_overlay(data)
            logger.info("Resent {} text boxes with updated coordinates.", len(final_data))


    def _correct_ocr_with_backlog(self, ocr_results: List[Dict[str, Any]], current_sentence: str) -> List[Dict[str, Any]]:
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
                logger.debug(f"Applying OCR correction with past sentence")
                ocr_results, _ = self._correct_ocr_text(ocr_results, past_sentence)
                
                if self.remove_used_sentences:
                    sentences_to_remove.append(past_sentence)
        
        if self.remove_used_sentences and sentences_to_remove:
            for sentence in sentences_to_remove:
                if sentence in self.last_sentences:
                    self.last_sentences.remove(sentence)
        
        ocr_results, current_changes = self._correct_ocr_text(ocr_results, current_sentence)
        
        self.last_sentences.append(current_sentence)
        if len(self.last_sentences) > self.sentence_backlog_max_size:
            self.last_sentences.pop(0)
        
        # Log summary of corrections
        corrected_text = "".join([line.get('text', '') for line in ocr_results])
        if corrected_text != ocr_text and current_changes:
            changes_str = ", ".join([f"'{c['old']}'->'{c['new']}'" for c in current_changes])
            logger.debug(f"OCR corrections: {changes_str} (using {len(sentences_to_remove)} past sentences + current)")
        
        return ocr_results

    def _correct_ocr_text(self, ocr_results: List[Dict[str, Any]], sentence: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
        if not sentence or not ocr_results:
            return ocr_results, []

        FLIPPABLE_PAIRS = [('冗', '談'), ('痙', '攣')]

        flat_ocr_chars = []
        char_map = {} 
        current_idx = 0
        word_buffers = {}
        changes = []  # Track all changes

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
                            old_pair = char2 + char1
                            new_pair = char1 + char2
                            changes.append({"old": old_pair, "new": new_pair})
                            word_buffers[(l1, w1)][c1], word_buffers[(l2, w2)][c2] = \
                                word_buffers[(l2, w2)][c2], word_buffers[(l1, w1)][c1]
                            flat_ocr_chars[idx], flat_ocr_chars[idx + 1] = \
                                flat_ocr_chars[idx + 1], flat_ocr_chars[idx]
                    idx += 1
        
        flat_ocr_str = "".join(flat_ocr_chars)
        matcher = difflib.SequenceMatcher(None, flat_ocr_str, sentence)
        
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'replace':
                if (i2 - i1) == (j2 - j1):
                    correct_segment = sentence[j1:j2]
                    for k, new_char in enumerate(correct_segment):
                        flat_idx = i1 + k
                        if flat_idx in char_map:
                            l, w, c = char_map[flat_idx]
                            old_char = word_buffers[(l, w)][c]
                            if old_char != new_char:
                                changes.append({"old": old_char, "new": new_char})
                            word_buffers[(l, w)][c] = new_char
            elif tag == 'insert':
                missing_segment = sentence[j1:j2]
                if i1 > 0 and flat_ocr_str[i1 - 1] == '「':
                    if j1 > 0 and sentence[j1 - 1] == '「':
                        if i1 in char_map:
                            l, w, c = char_map[i1]
                            for insert_char in reversed(missing_segment):
                                changes.append({"old": "", "new": insert_char})
                                word_buffers[(l, w)].insert(c, insert_char)

        for (l, w), char_list in word_buffers.items():
            new_text = "".join(char_list)
            if w == -1:
                ocr_results[l]['text'] = new_text
            else:
                ocr_results[l]['words'][w]['text'] = new_text
                
        for line in ocr_results:
            if line.get('words'):
                line['text'] = "".join([wd['text'] for wd in line['words']])
                
        return ocr_results, changes

    def _extract_text_with_pixel_boxes(
        self,
        api_response: Dict[str, Any],
        original_width: int,
        original_height: int,
        crop_x: int,
        crop_y: int,
        crop_width: int,
        crop_height: int,
        use_percentages: bool,
        magpie_info: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """Parses Google Lens API response and converts normalized coordinates to absolute pixel coordinates."""
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
                        use_percentage=False
                    )
                    
                    if use_percentages:
                        # Apply Magpie adjustments before converting to percentages
                        if magpie_info:
                            for key in word_box.keys():
                                if "x" in key:
                                    word_box[key], _ = self._adjust_coords_for_magpie(word_box[key], 0, magpie_info)
                                else:  # "y" in key
                                    _, word_box[key] = self._adjust_coords_for_magpie(0, word_box[key], magpie_info)
                        
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
                    use_percentage=False
                )

                if use_percentages:
                    # Apply Magpie adjustments before converting to percentages
                    if magpie_info:
                        for key in line_box.keys():
                            if "x" in key:
                                line_box[key], _ = self._adjust_coords_for_magpie(line_box[key], 0, magpie_info)
                            else:  # "y" in key
                                _, line_box[key] = self._adjust_coords_for_magpie(0, line_box[key], magpie_info)
                    
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
    
    def _adjust_coords_for_magpie(self, x: float, y: float, magpie_info: Optional[Dict[str, Any]]) -> Tuple[float, float]:
        """Adjusts screen coordinates based on Magpie scaling."""
        if not magpie_info:
            return x, y
        
        try:
            src_left = magpie_info.get('sourceWindowLeftEdgePosition', 0)
            src_top = magpie_info.get('sourceWindowTopEdgePosition', 0)
            src_right = magpie_info.get('sourceWindowRightEdgePosition', 0)
            src_bottom = magpie_info.get('sourceWindowBottomEdgePosition', 0)
            
            dst_left = magpie_info.get('magpieWindowLeftEdgePosition', 0)
            dst_top = magpie_info.get('magpieWindowTopEdgePosition', 0)
            dst_right = magpie_info.get('magpieWindowRightEdgePosition', 0)
            dst_bottom = magpie_info.get('magpieWindowBottomEdgePosition', 0)
            
            src_width = src_right - src_left
            src_height = src_bottom - src_top
            dst_width = dst_right - dst_left
            dst_height = dst_bottom - dst_top
            
            if src_width <= 0 or src_height <= 0:
                return x, y
            
            scale_x = dst_width / src_width
            scale_y = dst_height / src_height
            
            rel_x = x - src_left
            rel_y = y - src_top
            
            final_x = (rel_x * scale_x) + dst_left
            final_y = (rel_y * scale_y) + dst_top
            
            return final_x, final_y
        except Exception as e:
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
        cx, cy = bbox_data['center_x'], bbox_data['center_y']
        w, h = bbox_data['width'], bbox_data['height']
        
        inverse_width_scale = 1.0 / self.calculated_width_scale_factor if self.calculated_width_scale_factor != 0 else 1.0
        inverse_height_scale = 1.0 / self.calculated_height_scale_factor if self.calculated_height_scale_factor != 0 else 1.0

        if use_percentage:
            box_width = w
            box_height = h
            center_x = cx
            center_y = cy
        else:
            effective_crop_width = crop_width * inverse_width_scale
            effective_crop_height = crop_height * inverse_height_scale
            
            box_width = w * effective_crop_width
            box_height = h * effective_crop_height

            center_x = (cx * effective_crop_width) + crop_x
            center_y = (cy * effective_crop_height) + crop_y

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
        """Converts OneOCR results to percentages."""
        magpie_info = None
        if hasattr(self, 'window_monitor') and self.window_monitor:
            magpie_info = self.window_monitor.magpie_info
        
        inverse_width_scale = 1.0 / self.calculated_width_scale_factor if self.calculated_width_scale_factor != 0 else 1.0
        inverse_height_scale = 1.0 / self.calculated_height_scale_factor if self.calculated_height_scale_factor != 0 else 1.0
        
        converted_results = []
        for line in oneocr_results:
            bbox = line.get("bounding_rect", {})
            if not bbox:
                continue
            
            def transform_box(box):
                for key, value in box.items():
                    if "x" in key:
                        scaled_coord = value * inverse_width_scale
                        abs_coord = scaled_coord + offset_x
                        abs_coord, _ = self._adjust_coords_for_magpie(abs_coord, 0, magpie_info)
                        box[key] = abs_coord / monitor_width
                    else:  # "y" in key
                        scaled_coord = value * inverse_height_scale
                        abs_coord = scaled_coord + offset_y
                        _, abs_coord = self._adjust_coords_for_magpie(0, abs_coord, magpie_info)
                        box[key] = abs_coord / monitor_height

            transform_box(bbox)
            converted_results.append(line)
            
            for word in line.get("words", []):
                word_bbox = word.get("bounding_rect", {})
                if self.ocr_language not in ['ja', 'zh', 'ko', 'th', 'lo', 'km', 'my', 'bo']:
                    word["text"] += " "
                if word_bbox:
                    transform_box(word_bbox)
                    
        return converted_results
    
async def init_overlay_processor():
    """Initializes the overlay processor and starts the overlay thread."""
    overlay_processor.init()
    overlay_thread = OverlayThread()
    overlay_thread.start()
    logger.success("Overlay processor ready")
    
def get_overlay_processor() -> OverlayProcessor:
    """Returns the initialized overlay processor instance."""
    global overlay_processor
    if overlay_processor is None:
        asyncio.run(init_overlay_processor())
    return overlay_processor

async def main_test_screenshot():
    processor = OverlayProcessor()
    img, off_x, off_y, monitor_width, monitor_height = processor._get_screenshot_and_offset()
    if not img:
        return
    img.show()
    
async def main_run_ocr():
    overlay_processor = OverlayProcessor()
    while True:
        await overlay_processor.find_box_and_send_to_overlay(check_against_last=False, local_ocr_retry=0)
        await asyncio.sleep(10)
        
overlay_processor = OverlayProcessor()

if __name__ == '__main__':
    try:
        asyncio.run(main_run_ocr())
    except KeyboardInterrupt:
        logger.info("Script terminated by user.")
    except Exception as e:
        logger.exception(f"An error occurred in the main execution block: {e}")