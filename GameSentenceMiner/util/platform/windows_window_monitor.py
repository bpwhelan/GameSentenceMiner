import asyncio
import copy
import ctypes
import json
import os
import threading
import time
from ctypes import wintypes
from typing import Dict, Any, List, Tuple, Optional, Set

from .base_window_monitor import *
from .base_window_monitor import (
    _get_pid_for_hwnd,
    _is_tracked_suspended_pid,
    _exe_name_matches_set,
    _exe_names_match,
)

from GameSentenceMiner.util.platform.magpie_compat import get_magpie_info
from GameSentenceMiner.util.platform.windows_audio import set_process_mute

try:
    import mss
except ImportError:
    mss = None

# --- Win32 event hook constants ---
EVENT_SYSTEM_FOREGROUND = 0x0003
EVENT_SYSTEM_MOVESIZEEND = 0x000B
EVENT_SYSTEM_MINIMIZESTART = 0x0016
EVENT_SYSTEM_MINIMIZEEND = 0x0017
EVENT_OBJECT_DESTROY = 0x8001
EVENT_OBJECT_REORDER = 0x8004
WINEVENT_OUTOFCONTEXT = 0x0000
WINEVENT_SKIPOWNPROCESS = 0x0002
WM_QUIT = 0x0012

WinEventProcType = ctypes.WINFUNCTYPE(
    None,
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.HWND,
    wintypes.LONG,
    wintypes.LONG,
    wintypes.DWORD,
    wintypes.DWORD,
)

if user32:
    user32.SetWinEventHook.restype = wintypes.HANDLE
    user32.SetWinEventHook.argtypes = [
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HMODULE,
        WinEventProcType,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.UINT,
    ]
    user32.UnhookWinEvent.restype = wintypes.BOOL
    user32.UnhookWinEvent.argtypes = [wintypes.HANDLE]
    user32.GetMessageW.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.UINT]
    user32.TranslateMessage.restype = wintypes.BOOL
    user32.TranslateMessage.argtypes = [ctypes.c_void_p]
    user32.DispatchMessageW.restype = wintypes.LPARAM
    user32.DispatchMessageW.argtypes = [ctypes.c_void_p]
    user32.PostThreadMessageW.restype = wintypes.BOOL
    user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]


from GameSentenceMiner.obs import (
    get_window_info_from_source,
    get_current_scene,
    get_current_game,
)
from GameSentenceMiner.util.config.configuration import (
    get_config,
    get_overlay_config,
    get_master_config,
    is_windows,
    logger,
)
from GameSentenceMiner.util.platform.monitor_selection import (
    get_mss_monitor_descriptors,
    set_overlay_monitor_identity_from_index,
)
from GameSentenceMiner.web.gsm_websocket import websocket_manager, ID_OVERLAY


class WindowsWindowStateMonitor(BaseWindowStateMonitor):
    """
    Monitors the state of the target game window (Minimized, Active, Background)
    using OBS source info for robust matching.

    Uses Win32 event hooks (SetWinEventHook) to gate the expensive Z-order walk
    in _is_window_obscured so it only runs when the desktop Z-order actually changes.
    """

    def __init__(self, overlay_processor=None):
        super().__init__(overlay_processor)

        self.retry_find_count = 0
        self.found_hwnds: List[int] = []
        self.last_window_rect: Optional[Tuple[int, int, int, int]] = None
        self.base_poll_interval = 0.3
        self.fast_poll_interval = 0.1
        self.backoff_steps = [0.1, 0.2, 0.3, 0.4, 0.5]
        self.max_poll_interval = 1.0
        self.last_obs_check_time = 0
        self.last_is_fullscreen: bool = False
        self.last_cursor_hidden: bool = False
        self.cursor_hidden_since: Optional[float] = None
        self.cursor_hidden_confirm_seconds: float = 3.0
        self.obs_no_output_confirm_seconds: float = 180.0
        # True once we've acquired a real target hwnd for the current game/source.
        # Gates the lenient no-output wait: only honor it before we've ever seen the
        # window; once we've had it and lost it, the game is gone — hide immediately.
        self.ever_had_target_hwnd: bool = False
        self.hidden_due_to_no_output: bool = False
        self.state_before_no_output_hide: Optional[str] = None
        self.is_fullscreen_before_no_output_hide: bool = False
        self.last_scene_name = None
        self.last_target_scene_name = None
        self.last_hwnd_refresh_time = 0
        self.last_monitor_layout_signature: Optional[Tuple[Tuple[int, int, int, int], ...]] = None
        self.last_monitor_validation_time = 0.0
        self.minimized_audio_mutes: Dict[int, Tuple[Set[str], bool]] = {}

        self.BROWSER_CLASSES = {
            "Chrome_WidgetWin_1",
            "Chrome_WidgetWin_0",
            "Chrome_WidgetWin_2",
            "MozillaWindowClass",
            "OpWindow",
            "ApplicationFrameWindow",
        }

        self.BROWSER_EXES = {
            "chrome.exe",
            "msedge.exe",
            "brave.exe",
            "opera.exe",
            "vivaldi.exe",
            "chromium.exe",
            "arc.exe",
            "thorium.exe",
            "whale.exe",
            "yandex.exe",
            "firefox.exe",
            "zen.exe",
            "waterfox.exe",
            "librewolf.exe",
            "floorp.exe",
            "palemoon.exe",
            "torbrowser.exe",
        }

        self.EXCLUDED_EXES = {
            "ocenaudio.exe",
        }

        # Win32 event hook state
        # True whenever the desktop Z-order may have changed; gates _is_window_obscured.
        self._zorder_dirty: bool = True
        self._target_destroyed: bool = False
        self._event_hook_proc: Optional[WinEventProcType] = None
        self._event_hook_handles: List[int] = []
        self._event_hook_thread: Optional[threading.Thread] = None
        self._event_hook_thread_id: int = 0
        self._event_hook_stop = threading.Event()

        self._start_event_hooks()

    # --- Win32 event hooks ---

    def _start_event_hooks(self) -> None:
        """Start the dedicated thread that owns the Win32 event hook message pump."""
        if not is_windows() or not user32:
            return
        if self._event_hook_thread and self._event_hook_thread.is_alive():
            return
        self._event_hook_stop.clear()
        self._event_hook_thread = threading.Thread(
            target=self._event_hook_loop,
            daemon=True,
            name="WinEventHookLoop",
        )
        self._event_hook_thread.start()

    def _event_hook_loop(self) -> None:
        """Registers Win32 event hooks and runs the GetMessage pump.

        Must live on its own thread because WINEVENT_OUTOFCONTEXT callbacks are
        delivered to the thread that called SetWinEventHook via its message queue.
        """
        def _on_event(hook, event, hwnd, id_object, id_child, id_event_thread, dwms_event_time):
            try:
                target = self.target_hwnd
                if event == EVENT_OBJECT_REORDER:
                    self._zorder_dirty = True
                elif event in (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND):
                    self._zorder_dirty = True
                elif event == EVENT_OBJECT_DESTROY:
                    if target and hwnd and int(hwnd) == int(target):
                        self._target_destroyed = True
                        self._zorder_dirty = True
                elif event == EVENT_SYSTEM_MOVESIZEEND:
                    # Window finished moving/resizing; let next poll pick up new rect.
                    self._zorder_dirty = True
            except Exception:
                pass

        proc = WinEventProcType(_on_event)
        self._event_hook_proc = proc  # keep reference alive

        flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
        hooks = [
            user32.SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, proc, 0, 0, flags),
            user32.SetWinEventHook(EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND, None, proc, 0, 0, flags),
            user32.SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, None, proc, 0, 0, flags),
            user32.SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY, None, proc, 0, 0, flags),
            user32.SetWinEventHook(EVENT_OBJECT_REORDER, EVENT_OBJECT_REORDER, None, proc, 0, 0, flags),
        ]
        self._event_hook_handles = [h for h in hooks if h]
        self._event_hook_thread_id = kernel32.GetCurrentThreadId()

        msg = wintypes.MSG()
        while not self._event_hook_stop.is_set():
            result = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if result == 0 or result == -1:
                break
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

        for hook in self._event_hook_handles:
            try:
                user32.UnhookWinEvent(hook)
            except Exception:
                pass
        self._event_hook_handles = []

    def _stop_event_hooks(self) -> None:
        self._event_hook_stop.set()
        tid = self._event_hook_thread_id
        if tid:
            try:
                user32.PostThreadMessageW(tid, WM_QUIT, 0, 0)
            except Exception:
                pass

    # --- Audio mute helpers ---

    def _restore_minimized_audio_mute(self, reason: str = "") -> None:
        self._restore_minimized_audio_mute_internal(reason=reason)

    def _restore_minimized_audio_mute_internal(
        self,
        reason: str = "",
        force_all_sessions: bool = False,
        pid: Optional[int] = None,
    ) -> bool:
        if pid is not None:
            if pid not in self.minimized_audio_mutes:
                return False
            mutes_to_restore = [(pid, self.minimized_audio_mutes.pop(pid))]
        else:
            if not self.minimized_audio_mutes:
                return False
            mutes_to_restore = list(self.minimized_audio_mutes.items())
            self.minimized_audio_mutes.clear()

        if not is_windows():
            return False

        restored_any = False

        for muted_pid, (session_ids, restore_all_sessions) in mutes_to_restore:
            try:
                if force_all_sessions or restore_all_sessions:
                    results = set_process_mute(muted_pid, False)
                else:
                    results = set_process_mute(muted_pid, False, session_instance_ids=session_ids)

                    # Some games replace their audio session while minimized; fall back
                    # to the whole process so the restored window doesn't stay silent.
                    if session_ids and not results:
                        results = set_process_mute(muted_pid, False)

                changed_count = sum(1 for result in results if result.changed)
                if changed_count:
                    logger.debug(
                        f"Restored audio for minimized target PID {muted_pid} ({reason or 'window restored'})."
                    )
                restored_any = restored_any or bool(results)
            except Exception as e:
                logger.debug(f"Failed to restore audio for minimized target PID {muted_pid}: {e}")

        return restored_any

    def _force_unmute_current_target_audio(self, reason: str = "") -> bool:
        if not is_windows() or not self.target_hwnd:
            return False

        pid = _get_pid_for_hwnd(self.target_hwnd)
        if pid <= 0:
            return False

        try:
            results = set_process_mute(pid, False)
            changed_count = sum(1 for result in results if result.changed)
            if changed_count:
                logger.debug(f"Force-restored audio for target PID {pid} ({reason or 'window restored'}).")
            return bool(results)
        except Exception as e:
            logger.debug(f"Failed to force-restore audio for target PID {pid}: {e}")
            return False

    def _sync_minimized_audio_mute(self, current_state: str) -> None:
        if not is_windows():
            return

        try:
            advanced_cfg = get_config().advanced
            enabled = bool(getattr(advanced_cfg, "mute_game_on_minimize", False))
        except Exception:
            enabled = False

        if not enabled:
            self._restore_minimized_audio_mute_internal("disabled", force_all_sessions=True)
            return

        if current_state != "minimized":
            should_force_restore = self.last_state == "minimized" and current_state in {
                "active",
                "background",
                "obscured",
            }
            pid = _get_pid_for_hwnd(self.target_hwnd) if self.target_hwnd else 0
            restored = False
            if pid > 0:
                restored = self._restore_minimized_audio_mute_internal(
                    current_state,
                    force_all_sessions=should_force_restore,
                    pid=pid,
                )
            if should_force_restore and not restored and pid > 0:
                self._force_unmute_current_target_audio(current_state)
            return

        if not self.target_hwnd:
            return

        pid = _get_pid_for_hwnd(self.target_hwnd)
        if pid <= 0:
            return

        if pid in self.minimized_audio_mutes:
            return

        try:
            results = set_process_mute(pid, True)
        except Exception as e:
            logger.debug(f"Failed to mute minimized target PID {pid}: {e}")
            return

        changed_results = [result for result in results if result.changed]
        if not changed_results:
            return

        session_ids = {result.session_instance_id for result in changed_results if result.session_instance_id}
        restore_all_sessions = any(not result.session_instance_id for result in changed_results)
        self.minimized_audio_mutes[pid] = (session_ids, restore_all_sessions)
        logger.debug(f"Muted audio for minimized target PID {pid}.")

    # --- Window info helpers ---

    def _get_window_exe_name(self, hwnd) -> str:
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
        buff = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, buff, 256)
        return buff.value

    def _get_window_title(self, hwnd) -> str:
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return ""
        buff = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buff, length + 1)
        return buff.value

    def _hwnd_matches_target_exe(self, hwnd: int, target_exe: Optional[str]) -> bool:
        if not target_exe:
            return True

        window_exe = self._get_window_exe_name(hwnd)
        if not window_exe:
            return False
        return _exe_names_match(window_exe, target_exe)

    def _is_overlay_window(self, hwnd) -> bool:
        """Check if a window is a transparent overlay (GSM, Magpie, OBS preview, etc).

        Returns TRUE only for windows that should be ignored in obscured checks.
        Regular apps (Discord, VS Code, etc.) should return FALSE even if Electron-based.

        Optimized to check cheap properties (class, title) before expensive exe lookup.
        """
        try:
            window_class = self._get_window_class(hwnd)

            if "Magpie" in window_class:
                return True

            if "Qt5" in window_class and "QWindowIcon" in window_class:
                return True

            if "HwndWrapper" in window_class and "[JL;" in window_class:
                return True

            if "CEF-OSC-WIDGET" in window_class:
                return True

            title = self._get_window_title(hwnd)
            if "Magpie" in title:
                return True

            if "GSM Overlay" in title or "gsm_overlay" in title.lower():
                return True

            if "NVIDIA GeForce Overlay" in title or "nvidia geforce overlay" in title.lower():
                return True

            if "RTSS" in title or "RivaTuner" in title:
                return True

            if "ShareX - Screen recording" in title:
                return True

            if "Chrome" in window_class:
                title_lower = title.lower()
                if "overlay" in title_lower and "gsm" in title_lower:
                    return True

                exe_name = self._get_window_exe_name(hwnd)
                if exe_name:
                    exe_lower = exe_name.lower()

                    if any(
                        name in exe_lower
                        for name in [
                            "discord.exe",
                            "code.exe",
                            "code - insiders.exe",
                            "slack.exe",
                            "teams.exe",
                            "spotify.exe",
                            "cursor.exe",
                            "windsurf.exe",
                        ]
                    ):
                        return False

            if exe_name:
                exe_lower = exe_name.lower()

                if any(
                    name in exe_lower
                    for name in [
                        "gsm_overlay.exe",
                        "obs64.exe",
                        "obs32.exe",
                        "streamlabs obs.exe",
                        "xsplit.broadcaster.exe",
                        "gamebar.exe",
                        "nvidia share.exe",
                        "nvcontainer.exe",
                        "lunatranslator.exe",
                        "jl.exe"
                        "sharex.exe",
                    ]
                ):
                    return True

            return False
        except Exception:
            return False

    def _is_browser_window(self, hwnd) -> bool:
        try:
            class_name = self._get_window_class(hwnd)
            return class_name in self.BROWSER_CLASSES and self._get_window_exe_name(hwnd).lower() in self.BROWSER_EXES
        except Exception:
            return False

    def _is_browser_class(self, hwnd) -> bool:
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
            target_rect = get_window_rect_physical(hwnd)
            if not target_rect:
                return False

            target_left, target_top, target_right, target_bottom = target_rect
            target_width = target_right - target_left
            target_height = target_bottom - target_top

            if target_width <= 0 or target_height <= 0:
                return True

            PADDING_LEFT = 10
            PADDING_RIGHT = 10
            PADDING_TOP = 15
            PADDING_BOTTOM = 80

            padded_target_left = target_left + PADDING_LEFT
            padded_target_right = target_right - PADDING_RIGHT
            padded_target_top = target_top + PADDING_TOP
            padded_target_bottom = target_bottom - PADDING_BOTTOM

            current_hwnd = user32.GetWindow(hwnd, GW_HWNDPREV)

            while current_hwnd:
                if self._is_overlay_window(current_hwnd):
                    current_hwnd = user32.GetWindow(current_hwnd, GW_HWNDPREV)
                    continue

                if user32.IsWindowVisible(current_hwnd):
                    overlapping_rect = get_window_rect_physical(current_hwnd)
                    if overlapping_rect:
                        overlap_left, overlap_top, overlap_right, overlap_bottom = overlapping_rect
                        if (
                            overlap_left <= padded_target_left
                            and overlap_top <= padded_target_top
                            and overlap_right >= padded_target_right
                            and overlap_bottom >= padded_target_bottom
                        ):
                            return True

                current_hwnd = user32.GetWindow(current_hwnd, GW_HWNDPREV)

            return False
        except Exception as e:
            logger.debug(f"Error checking window occlusion: {e}")
            return False

    def _is_exclusive_fullscreen(self, hwnd) -> bool:
        try:
            style = user32.GetWindowLongW(hwnd, GWL_STYLE)

            has_popup = (style & WS_POPUP) != 0
            has_no_caption = (style & WS_CAPTION) == 0
            has_no_thickframe = (style & WS_THICKFRAME) == 0

            if not (has_popup and has_no_caption and has_no_thickframe):
                return False

            window_rect = get_window_rect_physical(hwnd)
            if not window_rect:
                return False

            monitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
            if not monitor:
                return False

            monitor_info = MONITORINFO()
            monitor_info.cbSize = ctypes.sizeof(MONITORINFO)
            if not user32.GetMonitorInfoW(monitor, ctypes.byref(monitor_info)):
                return False

            mon_rect = monitor_info.rcMonitor
            window_left, window_top, window_right, window_bottom = window_rect
            window_width = window_right - window_left
            window_height = window_bottom - window_top
            monitor_width = mon_rect.right - mon_rect.left
            monitor_height = mon_rect.bottom - mon_rect.top

            return (
                abs(window_left - mon_rect.left) <= 2
                and abs(window_top - mon_rect.top) <= 2
                and abs(window_width - monitor_width) <= 2
                and abs(window_height - monitor_height) <= 2
            )

        except Exception as e:
            logger.debug(f"Error checking exclusive fullscreen: {e}")
            return False

    def _find_window_callback(self, hwnd, extra):
        if not user32.IsWindowVisible(hwnd):
            return True

        if self._is_browser_window(hwnd):
            return True

        if self.last_target_info and not self._is_browser_class(hwnd):
            tgt_class = self.last_target_info.get("window_class")
            if tgt_class:
                window_class = self._get_window_class(hwnd)
                if window_class and window_class.lower() == tgt_class.lower():
                    tgt_exe = self.last_target_info.get("exe")
                    if self._hwnd_matches_target_exe(hwnd, tgt_exe):
                        self.found_hwnds.append(hwnd)
                    return True

        if self.last_target_info:
            tgt_exe = self.last_target_info.get("exe")
            if tgt_exe:
                window_exe = self._get_window_exe_name(hwnd)
                if _exe_name_matches_set(window_exe, self.EXCLUDED_EXES):
                    return True
                if _exe_names_match(window_exe, tgt_exe):
                    self.found_hwnds.append(hwnd)
                    return True
                if window_exe:
                    return True

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
        if not is_windows():
            return
        try:
            self.magpie_info = get_magpie_info()
        except Exception as e:
            logger.debug(f"Error getting Magpie info: {e}")
            self.magpie_info = None

    def _build_window_rect_payload(self, rect: Optional[Tuple[int, int, int, int]]) -> Optional[Dict[str, int]]:
        if not rect:
            return None

        left, top, right, bottom = [int(value) for value in rect]
        if right <= left or bottom <= top:
            return None

        return {
            "left": left,
            "top": top,
            "right": right,
            "bottom": bottom,
            "width": right - left,
            "height": bottom - top,
        }

    def _build_client_rect_payload(self) -> Optional[Dict[str, int]]:
        geometry = get_window_client_physical_geometry(self.target_hwnd)
        if not geometry:
            return None

        left, top, width, height = [int(value) for value in geometry]
        if width <= 0 or height <= 0:
            return None

        return {
            "left": left,
            "top": top,
            "right": left + width,
            "bottom": top + height,
            "width": width,
            "height": height,
        }

    def find_target_hwnd(self) -> Optional[int]:
        try:
            window_info = get_window_info_from_source(scene_name=get_current_scene())
        except Exception as e:
            logger.exception(f"Error getting window info from source: {e}")
            window_info = None

        current_game = get_current_game()

        if not window_info and not current_game:
            return None

        self.last_target_info = window_info if window_info else {}
        self.last_target_scene_name = get_current_scene()
        self.last_game_name = current_game if current_game else ""
        self.found_hwnds = []

        cmp_func = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, ctypes.c_void_p)
        user32.EnumWindows(cmp_func(self._find_window_callback), 0)

        if self.found_hwnds:
            if len(self.found_hwnds) == 1:
                return self.found_hwnds[0]

            fg = user32.GetForegroundWindow()
            if fg in self.found_hwnds:
                return fg

            best_hwnd = None
            max_memory = 0

            for hwnd in self.found_hwnds:
                memory = self._get_process_memory_usage(hwnd)
                if memory > max_memory:
                    max_memory = memory
                    best_hwnd = hwnd

            if best_hwnd:
                return best_hwnd

            return self.found_hwnds[0]

        return None

    def _detect_current_monitor(self, rect: Tuple[int, int, int, int]) -> int:
        if not mss:
            return -1

        try:
            with mss.mss() as sct:
                monitors = sct.monitors[1:]
                if not monitors:
                    return -1
                max_area = 0
                best_monitor_idx = -1

                wx1, wy1, wx2, wy2 = rect
                window_area = (wx2 - wx1) * (wy2 - wy1)
                if window_area <= 0:
                    return -1

                for i, monitor in enumerate(monitors):
                    mx1, my1 = monitor["left"], monitor["top"]
                    mx2, my2 = mx1 + monitor["width"], my1 + monitor["height"]

                    ix1 = max(wx1, mx1)
                    iy1 = max(wy1, my1)
                    ix2 = min(wx2, mx2)
                    iy2 = min(wy2, my2)

                    if ix1 < ix2 and iy1 < iy2:
                        intersection_area = (ix2 - ix1) * (iy2 - iy1)
                        if intersection_area > max_area:
                            max_area = intersection_area
                            best_monitor_idx = i

                if best_monitor_idx != -1:
                    return best_monitor_idx

                window_center_x = (wx1 + wx2) / 2.0
                window_center_y = (wy1 + wy2) / 2.0
                nearest_monitor_idx = -1
                nearest_distance = None

                for i, monitor in enumerate(monitors):
                    mx1, my1 = monitor["left"], monitor["top"]
                    mx2, my2 = mx1 + monitor["width"], my1 + monitor["height"]

                    nearest_x = min(max(window_center_x, mx1), mx2)
                    nearest_y = min(max(window_center_y, my1), my2)
                    dx = window_center_x - nearest_x
                    dy = window_center_y - nearest_y
                    distance_sq = (dx * dx) + (dy * dy)

                    if nearest_distance is None or distance_sq < nearest_distance:
                        nearest_distance = distance_sq
                        nearest_monitor_idx = i

                return nearest_monitor_idx
        except Exception as e:
            logger.debug(f"Error detecting monitor: {e}")
            return -1

    def _get_monitor_layout_signature(self) -> Tuple[Tuple[int, int, int, int], ...]:
        if not mss:
            return tuple()

        try:
            with mss.mss() as sct:
                monitors = sct.monitors[1:]
                signature: List[Tuple[int, int, int, int]] = []
                for monitor in monitors:
                    try:
                        left = int(monitor.get("left", 0))
                        top = int(monitor.get("top", 0))
                        width = max(1, int(monitor.get("width", 0)))
                        height = max(1, int(monitor.get("height", 0)))
                    except Exception:
                        continue
                    signature.append((left, top, width, height))
                return tuple(signature)
        except Exception as e:
            logger.debug(f"Error reading monitor topology: {e}")
            return tuple()

    def _validate_capture_monitor_selection(
        self,
        monitor_signature: Tuple[Tuple[int, int, int, int], ...],
    ) -> bool:
        if not monitor_signature:
            return False

        overlay_cfg = get_overlay_config()
        try:
            configured_index = int(getattr(overlay_cfg, "monitor_to_capture", 0))
        except (TypeError, ValueError):
            configured_index = 0

        clamped_index = min(max(configured_index, 0), len(monitor_signature) - 1)
        missing_monitor_identity = not getattr(overlay_cfg, "monitor_to_capture_id", "") or not getattr(
            overlay_cfg, "monitor_to_capture_bounds", {}
        )
        if clamped_index == configured_index and not missing_monitor_identity:
            return False

        monitor_bounds = [
            {"left": left, "top": top, "width": width, "height": height}
            for left, top, width, height in monitor_signature
        ]
        set_overlay_monitor_identity_from_index(overlay_cfg, monitor_bounds, clamped_index)
        if clamped_index != configured_index:
            logger.warning(
                f"Configured capture monitor index {configured_index} is unavailable. "
                f"Falling back to monitor {clamped_index + 1} of {len(monitor_signature)}."
            )
        try:
            get_master_config().save()
        except Exception as e:
            logger.debug(f"Failed to persist fallback capture monitor index: {e}")
        return True

    def _check_monitor_topology_changes(self) -> bool:
        monitor_signature = self._get_monitor_layout_signature()
        if not monitor_signature:
            return False

        monitor_selection_changed = self._validate_capture_monitor_selection(monitor_signature)

        if self.last_monitor_layout_signature is None:
            self.last_monitor_layout_signature = monitor_signature
            return monitor_selection_changed

        topology_changed = monitor_signature != self.last_monitor_layout_signature
        if topology_changed:
            old_count = len(self.last_monitor_layout_signature)
            new_count = len(monitor_signature)
            logger.info(
                f"Monitor topology changed ({old_count} -> {new_count} display(s)). Refreshing overlay geometry."
            )
            self.last_monitor_layout_signature = monitor_signature

        if (topology_changed or monitor_selection_changed) and self.overlay_processor:
            self.overlay_processor.obs_width = None
            self.overlay_processor.obs_height = None
            self.last_obs_dimensions_time = 0
            self.window_stable_count = 0
            self.poll_interval = self.fast_poll_interval

        return topology_changed or monitor_selection_changed

    def _obs_reports_no_output(self) -> bool:
        """Read the OBS service's existing output probe result (no extra screenshots)."""
        import GameSentenceMiner.obs as _obs_pkg

        svc = _obs_pkg.obs_service
        if not svc:
            return False

        state = svc.state
        if state.source_output_active is not False:
            return False

        checked_at = state.source_output_checked_at
        if not checked_at or (time.time() - checked_at) > 30.0:
            return False

        empty_since = state.source_output_empty_since
        if not empty_since or (time.time() - empty_since) < self.obs_no_output_confirm_seconds:
            return False
        return True

    async def _hide_overlay_if_obs_has_no_output(self):
        if not self._obs_reports_no_output():
            await self._restore_overlay_after_no_output()
            return

        if self.last_state in ("minimized", "closed"):
            return

        logger.info("Target window not found and OBS reports no output - hiding overlay (minimized).")
        self.state_before_no_output_hide = self.last_state
        self.is_fullscreen_before_no_output_hide = self.last_is_fullscreen
        self.hidden_due_to_no_output = True
        self.last_state = "minimized"
        self.last_is_fullscreen = False

        payload = {
            "type": "window_state",
            "data": "minimized",
            "game": self.last_target_info.get("title", self.last_game_name),
            "magpie_info": None,
            "is_fullscreen": False,
            "recommend_manual_mode": False,
            "target_window_rect": None,
            "target_client_rect": None,
        }

        if websocket_manager.has_clients(ID_OVERLAY):
            await websocket_manager.send(ID_OVERLAY, json.dumps(payload))

    async def _hide_overlay_after_target_lost(self):
        """Hide the overlay immediately when a previously-acquired window is gone.

        Unlike the no-output path, this does not wait: if we had the window and it
        vanished, the game has closed, so hide right away.
        """
        if self.last_state in ("minimized", "closed"):
            return

        logger.info("Target window lost after being acquired - hiding overlay (closed).")
        self.last_state = "closed"
        self.last_is_fullscreen = False

        payload = {
            "type": "window_state",
            "data": "closed",
            "game": self.last_target_info.get("title", self.last_game_name),
            "magpie_info": None,
            "is_fullscreen": False,
            "recommend_manual_mode": False,
            "target_window_rect": None,
            "target_client_rect": None,
        }

        if websocket_manager.has_clients(ID_OVERLAY):
            await websocket_manager.send(ID_OVERLAY, json.dumps(payload))

    async def _restore_overlay_after_no_output(self):
        if not self.hidden_due_to_no_output:
            return

        self.hidden_due_to_no_output = False
        logger.info("OBS output returned - restoring overlay after no-output minimize.")

        restored_state = self.state_before_no_output_hide or "background"
        if restored_state in ("minimized", "closed"):
            restored_state = "background"
        restored_fullscreen = self.is_fullscreen_before_no_output_hide

        self.target_hwnd = None
        self.retry_find_count = 0
        self.last_state = restored_state
        self.last_is_fullscreen = restored_fullscreen
        self.poll_interval = self.fast_poll_interval

        payload = {
            "type": "window_state",
            "data": restored_state,
            "game": self.last_target_info.get("title", self.last_game_name),
            "magpie_info": self.magpie_info,
            "is_fullscreen": restored_fullscreen,
            "recommend_manual_mode": False,
            "target_window_rect": None,
            "target_client_rect": None,
        }

        if websocket_manager.has_clients(ID_OVERLAY):
            await websocket_manager.send(ID_OVERLAY, json.dumps(payload))

    def _is_cursor_hidden(self) -> bool:
        if not is_windows() or not user32:
            return False
        try:
            info = CURSORINFO()
            info.cbSize = ctypes.sizeof(CURSORINFO)
            if not user32.GetCursorInfo(ctypes.byref(info)):
                return False
            return not bool(info.flags & CURSOR_SHOWING)
        except Exception:
            return False

    def _update_cursor_hidden_state(self, raw_hidden: bool, now: float) -> bool:
        if not raw_hidden:
            self.cursor_hidden_since = None
            return False
        if self.cursor_hidden_since is None:
            self.cursor_hidden_since = now
            return False
        return (now - self.cursor_hidden_since) >= self.cursor_hidden_confirm_seconds

    async def check_and_send(self):
        """Check window state and broadcast changes."""
        if not is_windows():
            return

        # Apply any pending target-destroyed notification from the hook thread.
        if self._target_destroyed:
            self._target_destroyed = False
            self.target_hwnd = None

        now = time.time()
        monitor_topology_changed = False
        if now - self.last_monitor_validation_time > 1.0:
            self.last_monitor_validation_time = now
            monitor_topology_changed = self._check_monitor_topology_changes()

        scene_changed = False
        if now - self.last_obs_check_time > 2.0:
            self.last_obs_check_time = now
            try:
                current_scene = get_current_scene()
                if current_scene and current_scene != self.last_scene_name:
                    if self.last_scene_name:
                        logger.info(
                            f"Scene changed from '{self.last_scene_name}' to '{current_scene}' - Resetting OBS dimensions."
                        )
                    self.overlay_processor.obs_width = None
                    self.overlay_processor.obs_height = None
                    self.target_hwnd = None
                    self.retry_find_count = 0
                    self.last_target_info = {}
                    self.last_target_scene_name = None
                    self.ever_had_target_hwnd = False
                    scene_changed = True
                    self.last_scene_name = current_scene

                lookup_scene = current_scene or self.last_scene_name
                new_info = get_window_info_from_source(scene_name=lookup_scene) if lookup_scene else None

                if new_info and self.last_target_info:
                    if (
                        new_info.get("title") != self.last_target_info.get("title")
                        or new_info.get("window_class") != self.last_target_info.get("window_class")
                        or new_info.get("exe") != self.last_target_info.get("exe")
                    ):
                        logger.info(
                            f"OBS Source changed from '{self.last_target_info.get('title')}' to '{new_info.get('title')}' - Resetting target."
                        )
                        self.target_hwnd = None
                        self.retry_find_count = 0
                        self.last_target_info = {}
                        self.last_target_scene_name = None
                        self.ever_had_target_hwnd = False
                        self.overlay_processor.obs_width = None
                        self.overlay_processor.obs_height = None
            except Exception:
                pass

        should_refresh_hwnd = False
        if not self.target_hwnd or self.retry_find_count > 10:
            should_refresh_hwnd = True
        elif now - self.last_hwnd_refresh_time > 10.0:
            should_refresh_hwnd = True

        if should_refresh_hwnd:
            self.target_hwnd = self.find_target_hwnd()
            self.retry_find_count = 0
            self.last_hwnd_refresh_time = now
            # New hwnd: Z-order state is unknown, force a fresh obscured check.
            self._zorder_dirty = True

        if not self.target_hwnd:
            self.retry_find_count += 1
            if self.ever_had_target_hwnd:
                # We had the window and lost it — the game is gone, hide now.
                await self._hide_overlay_after_target_lost()
            else:
                # Never saw the window yet; tolerate transient absence while OBS captures.
                await self._hide_overlay_if_obs_has_no_output()
            return

        self.ever_had_target_hwnd = True
        self.hidden_due_to_no_output = False

        current_state = "unknown"
        current_rect = None
        is_fullscreen = False

        if not user32.IsWindowVisible(self.target_hwnd):
            self.target_hwnd = None
            current_state = "closed"
        elif user32.IsIconic(self.target_hwnd):
            current_state = "minimized"
            self._zorder_dirty = False  # no point checking Z-order while minimized
        else:
            foreground_hwnd = user32.GetForegroundWindow()
            if foreground_hwnd == self.target_hwnd:
                current_state = "active"
                self._zorder_dirty = False  # game is foreground; can't be obscured
            else:
                # Only walk the Z-order when something actually changed it.
                if self._zorder_dirty:
                    is_obscured = self._is_window_obscured(self.target_hwnd)
                    self._zorder_dirty = False
                else:
                    is_obscured = (self.last_state == "obscured")

                current_state = "obscured" if is_obscured else "background"

            is_fullscreen = self._is_exclusive_fullscreen(self.target_hwnd)
            current_rect = get_window_rect_physical(self.target_hwnd)

        self._sync_minimized_audio_mute(current_state)

        window_moved_or_resized = current_rect != self.last_window_rect
        if window_moved_or_resized:
            if self.last_window_rect is not None and current_rect is not None:
                logger.debug(f"Target window moved or resized: {self.last_window_rect} -> {current_rect}")
            self.window_stable_count = 0
            self.poll_interval = self.fast_poll_interval
            self.overlay_processor.obs_width = None
            self.overlay_processor.obs_height = None
        else:
            self.window_stable_count += 1
            if self.window_stable_count > 0 and self.window_stable_count <= len(self.backoff_steps):
                self.poll_interval = self.backoff_steps[self.window_stable_count - 1]
            elif self.window_stable_count > len(self.backoff_steps):
                self.poll_interval = self.base_poll_interval

            if current_rect and is_windows() and self.window_stable_count == 2:
                best_monitor = self._detect_current_monitor(current_rect)
                overlay_cfg = get_overlay_config()
                missing_monitor_identity = not getattr(overlay_cfg, "monitor_to_capture_id", "") or not getattr(
                    overlay_cfg, "monitor_to_capture_bounds", {}
                )
                if best_monitor != -1 and (overlay_cfg.monitor_to_capture != best_monitor or missing_monitor_identity):
                    if overlay_cfg.monitor_to_capture != best_monitor:
                        logger.info(f"Window moved to Monitor {best_monitor + 1}. Updating config.")
                    descriptors = get_mss_monitor_descriptors()
                    monitor_bounds = [descriptor["bounds"] for descriptor in descriptors]
                    if not set_overlay_monitor_identity_from_index(overlay_cfg, monitor_bounds, best_monitor):
                        overlay_cfg.monitor_to_capture = best_monitor
                    get_master_config().save()
                    asyncio.create_task(self.overlay_processor.reprocess_and_send_last_results())

        self.update_magpie_info()
        magpie_changed = self.magpie_info != self.last_magpie_info

        game_name_ref = self.last_target_info.get("title", self.last_game_name)

        fullscreen_changed = is_fullscreen != self.last_is_fullscreen

        raw_cursor_hidden = current_state == "active" and self._is_cursor_hidden()
        cursor_hidden = self._update_cursor_hidden_state(raw_cursor_hidden, now)
        cursor_hidden_changed = cursor_hidden != self.last_cursor_hidden

        if (
            current_state != self.last_state
            or magpie_changed
            or fullscreen_changed
            or window_moved_or_resized
            or cursor_hidden_changed
        ):
            logger.debug(
                f"Window state changed: {self.last_state} -> {current_state} "
                f"(game: {game_name_ref}, fullscreen: {is_fullscreen}, cursor_hidden: {cursor_hidden})"
            )
            self.last_state = current_state
            self.last_is_fullscreen = is_fullscreen
            self.last_cursor_hidden = cursor_hidden

            recommend_manual = cursor_hidden

            payload = {
                "type": "window_state",
                "data": current_state,
                "game": game_name_ref,
                "magpie_info": self.magpie_info,
                "is_fullscreen": is_fullscreen,
                "cursor_hidden": cursor_hidden,
                "recommend_manual_mode": recommend_manual,
                "target_window_rect": self._build_window_rect_payload(current_rect),
                "target_client_rect": self._build_client_rect_payload(),
            }

            if websocket_manager.has_clients(ID_OVERLAY):
                await websocket_manager.send(ID_OVERLAY, json.dumps(payload))

        self.last_magpie_info = copy.deepcopy(self.magpie_info) if self.magpie_info else None

        if self.overlay_processor.obs_width is not None and self.overlay_processor.obs_height is not None:
            if now - self.last_obs_dimensions_time > 60.0:
                logger.debug("OBS dimensions are stale (>60s), resetting for next capture")
                self.overlay_processor.obs_width = None
                self.overlay_processor.obs_height = None
                self.last_obs_dimensions_time = now

        if magpie_changed or window_moved_or_resized or scene_changed or monitor_topology_changed:
            if current_state not in ["minimized", "closed"]:
                logger.background(
                    "Window geometry, monitor topology, Magpie, or scene changed - reprocessing last OCR result"
                )
                asyncio.create_task(self.overlay_processor.reprocess_and_send_last_results())
            self.poll_interval = self.base_poll_interval
        else:
            self.poll_interval = min(self.max_poll_interval, self.poll_interval + 0.05)

        self.last_window_rect = current_rect

    async def activate_target_window(self) -> bool:
        if not is_windows():
            logger.debug("Window activation only supported on Windows")
            return False

        if not self.target_hwnd:
            logger.debug("No target window to activate")
            return False

        attempt_delays = (0.0, 0.08, 0.2)
        for attempt_number, delay in enumerate(attempt_delays, start=1):
            if delay > 0:
                await asyncio.sleep(delay)
            if self._set_foreground_aggressive(self.target_hwnd, attempt_number=attempt_number):
                return True

        logger.debug(f"Failed to activate target window after {len(attempt_delays)} aggressive attempts")
        return False

    def _resolve_hwnd_for_pid(self, target_pid: int) -> Optional[int]:
        if not is_windows() or target_pid <= 0:
            return None

        matching_hwnds: List[int] = []

        def _enum_windows_callback(hwnd, _extra):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                if _get_pid_for_hwnd(hwnd) != target_pid:
                    return True
                matching_hwnds.append(hwnd)
            except Exception:
                pass
            return True

        cmp_func = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, ctypes.c_void_p)
        callback = cmp_func(_enum_windows_callback)
        user32.EnumWindows(callback, 0)

        if not matching_hwnds:
            return None

        foreground_hwnd = user32.GetForegroundWindow()
        if foreground_hwnd in matching_hwnds:
            return foreground_hwnd

        def _score(hwnd: int) -> Tuple[int, int]:
            title = self._get_window_title(hwnd)
            area = 0
            rect = get_window_rect_physical(hwnd)
            if rect:
                area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
            return (1 if title else 0, area)

        return max(matching_hwnds, key=_score)

    def _post_enter_to_hwnd(self, hwnd: int) -> bool:
        if not is_windows() or not hwnd:
            return False

        lparam_down = 0x001C0001
        lparam_up = 0xC01C0001
        down_ok = bool(user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, lparam_down))
        up_ok = bool(user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, lparam_up))
        return down_ok and up_ok

    def _send_enter_with_sendinput(self) -> bool:
        if not is_windows():
            return False

        enter_scan_code = 0x1C
        ULONG_PTR = wintypes.WPARAM

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [
                ("wVk", wintypes.WORD),
                ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR),
            ]

        class INPUT_UNION(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT)]

        class INPUT(ctypes.Structure):
            _fields_ = [
                ("type", wintypes.DWORD),
                ("union", INPUT_UNION),
            ]

        inputs = (INPUT * 2)()
        inputs[0].type = INPUT_KEYBOARD
        inputs[0].union.ki = KEYBDINPUT(0, enter_scan_code, KEYEVENTF_SCANCODE, 0, 0)
        inputs[1].type = INPUT_KEYBOARD
        inputs[1].union.ki = KEYBDINPUT(0, enter_scan_code, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP, 0, 0)

        sent = int(user32.SendInput(2, inputs, ctypes.sizeof(INPUT)))
        return sent == 2

    def _send_enter_with_keybd_event(self) -> bool:
        if not is_windows():
            return False

        try:
            user32.keybd_event(VK_RETURN, 0x1C, 0, 0)
            time.sleep(0.01)
            user32.keybd_event(VK_RETURN, 0x1C, KEYEVENTF_KEYUP, 0)
            return True
        except Exception:
            return False

    def _send_enter_with_fallbacks(self) -> bool:
        if self._send_enter_with_keybd_event():
            return True

        logger.debug("keybd_event Enter injection failed, retrying with SendInput")
        return self._send_enter_with_sendinput()

    def _resolve_target_hwnd(self, target_pid: Optional[int] = None) -> Optional[int]:
        hwnd = self.target_hwnd
        requested_pid = int(target_pid or 0)

        if requested_pid <= 0:
            return hwnd

        if hwnd and _get_pid_for_hwnd(hwnd) == requested_pid:
            return hwnd

        pid_hwnd = self._resolve_hwnd_for_pid(requested_pid)
        if not pid_hwnd:
            return hwnd

        self.target_hwnd = pid_hwnd
        return pid_hwnd

    def _send_alt_key_tap(self) -> bool:
        if not is_windows():
            return False

        try:
            user32.keybd_event(VK_MENU, 0x38, KEYEVENTF_EXTENDEDKEY, 0)
            time.sleep(0.01)
            user32.keybd_event(VK_MENU, 0x38, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0)
            return True
        except Exception:
            return False

    def _set_foreground_aggressive(self, hwnd: int, attempt_number: int = 1) -> bool:
        if not is_windows() or not hwnd:
            return False

        target_pid = _get_pid_for_hwnd(hwnd)
        if _is_tracked_suspended_pid(target_pid):
            logger.debug(
                f"Skipping target window activation for HWND {hwnd} / PID {target_pid}: process is currently paused."
            )
            return False

        try:
            if int(user32.GetForegroundWindow() or 0) == int(hwnd):
                return True

            fg_hwnd = int(user32.GetForegroundWindow() or 0)
            current_tid = int(kernel32.GetCurrentThreadId())
            fg_tid = int(user32.GetWindowThreadProcessId(fg_hwnd, None)) if fg_hwnd else 0
            target_tid = int(user32.GetWindowThreadProcessId(hwnd, None))
            attached_pairs: List[Tuple[int, int]] = []
            old_timeout = wintypes.UINT()
            timeout_changed = False

            def _attach(a: int, b: int) -> None:
                if a and b and a != b and (a, b) not in attached_pairs:
                    if user32.AttachThreadInput(a, b, True):
                        attached_pairs.append((a, b))

            def _is_foreground() -> bool:
                return int(user32.GetForegroundWindow() or 0) == int(hwnd)

            def _restore_and_raise(toggle_topmost: bool = False) -> None:
                if user32.IsIconic(hwnd):
                    logger.debug(f"Target window minimized, restoring (attempt {attempt_number})")
                    user32.ShowWindow(hwnd, SW_RESTORE)
                else:
                    user32.ShowWindow(hwnd, SW_SHOW)
                user32.BringWindowToTop(hwnd)
                if toggle_topmost:
                    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
                    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)

            def _focus_sequence(toggle_topmost: bool = False) -> bool:
                _restore_and_raise(toggle_topmost=toggle_topmost)
                try:
                    user32.SetActiveWindow(hwnd)
                except Exception:
                    pass
                try:
                    user32.SetFocus(hwnd)
                except Exception:
                    pass
                user32.SetForegroundWindow(hwnd)
                time.sleep(0.03)
                return _is_foreground()

            _attach(current_tid, fg_tid)
            _attach(current_tid, target_tid)
            _attach(fg_tid, target_tid)

            try:
                user32.SystemParametersInfoW(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ctypes.byref(old_timeout), 0)
                if user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ctypes.c_void_p(0), SPIF_SENDCHANGE):
                    timeout_changed = True
            except Exception:
                timeout_changed = False

            allow_set_foreground = getattr(user32, "AllowSetForegroundWindow", None)
            if allow_set_foreground:
                try:
                    allow_set_foreground(ASFW_ANY)
                except Exception:
                    pass

            if _focus_sequence():
                return True

            logger.debug(f"SetForegroundWindow fallback path engaged (attempt {attempt_number})")

            if _focus_sequence(toggle_topmost=True):
                return True

            if self._send_alt_key_tap() and _focus_sequence(toggle_topmost=True):
                return True

            switch_to_this_window = getattr(user32, "SwitchToThisWindow", None)
            if switch_to_this_window:
                try:
                    switch_to_this_window(hwnd, True)
                    time.sleep(0.03)
                    if _is_foreground():
                        return True
                except Exception:
                    pass

            return _is_foreground()
        except Exception as e:
            logger.exception(f"Error aggressively activating target window (attempt {attempt_number}): {e}")
            return False
        finally:
            if "timeout_changed" in locals() and timeout_changed:
                try:
                    user32.SystemParametersInfoW(
                        SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ctypes.c_void_p(int(old_timeout.value)), SPIF_SENDCHANGE
                    )
                except Exception:
                    pass
            if "attached_pairs" in locals():
                for a, b in reversed(attached_pairs):
                    try:
                        user32.AttachThreadInput(a, b, False)
                    except Exception:
                        pass

    async def send_enter_to_target_window(self, target_pid: Optional[int] = None, activate_window: bool = True) -> bool:
        if not is_windows():
            return False

        requested_pid = int(target_pid or 0)
        target_hwnd = self._resolve_target_hwnd(requested_pid)

        if not target_hwnd:
            return False

        self.target_hwnd = target_hwnd

        if activate_window:
            focused = await self.activate_target_window()
            if not focused:
                return False
            await asyncio.sleep(0.03)
            return self._send_enter_with_fallbacks()

        foreground_hwnd = user32.GetForegroundWindow()
        if foreground_hwnd == target_hwnd:
            return self._send_enter_with_fallbacks()
        return self._post_enter_to_hwnd(target_hwnd)

    def post_enter_to_target_window(self, target_pid: Optional[int] = None) -> bool:
        """Backward-compatible direct PostMessage path."""
        if not is_windows():
            return False

        hwnd = self._resolve_target_hwnd(target_pid)

        if not hwnd:
            return False

        return self._post_enter_to_hwnd(hwnd)
