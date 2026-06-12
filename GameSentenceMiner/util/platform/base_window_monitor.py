import asyncio
import copy
import ctypes
import json
import os
import signal
import threading
import time
from ctypes import wintypes
from pathlib import Path
from typing import Dict, Any, List, Literal, Tuple, Optional, Set

import psutil

# python-xlib is required for Linux X11 auto-detection (declared in pyproject.toml).
# Imported defensively so the module still loads if unavailable; callers fall back to name match.
try:
    from Xlib import X as _X
    from Xlib import display as _xdisplay

    _HAS_XLIB = True
except ImportError:  # pragma: no cover - exercised only without python-xlib
    _X = None
    _xdisplay = None
    _HAS_XLIB = False

from GameSentenceMiner.obs import (
    get_window_info_from_source,
    get_linux_capture_window_info,
    get_current_scene,
    get_current_game,
)
from GameSentenceMiner.util.config.configuration import (
    get_app_directory,
    get_config,
    get_overlay_config,
    get_master_config,
    is_windows,
    is_linux,
    is_wayland,
    logger,
)
from GameSentenceMiner.util.config.feature_flags import (
    process_pausing_feature,
)
from GameSentenceMiner.util.platform.monitor_selection import (
    get_mss_monitor_descriptors,
    set_overlay_monitor_identity_from_index,
)
from GameSentenceMiner.util.platform.windows_dpi import per_monitor_v2_dpi_context
from GameSentenceMiner.web.gsm_websocket import websocket_manager, ID_OVERLAY

if is_windows():
    from GameSentenceMiner.util.platform.magpie_compat import get_magpie_info

# Conditionally import screenshot library (used for monitor detection)
try:
    import mss
except ImportError:
    mss = None

# --- Windows API Definitions ---
if is_windows():
    try:
        from importlib.util import find_spec

        HAS_WIN32 = find_spec("win32gui") and find_spec("win32con")
    except ImportError:
        HAS_WIN32 = False

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi

    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    PROCESS_QUERY_INFORMATION = 0x0400
    PROCESS_VM_READ = 0x0010
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.EnumWindows.argtypes = [
        ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, ctypes.c_void_p),
        ctypes.c_void_p,
    ]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    ]
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
    user32.SetActiveWindow.argtypes = [wintypes.HWND]
    user32.SetActiveWindow.restype = wintypes.HWND
    user32.SetFocus.argtypes = [wintypes.HWND]
    user32.SetFocus.restype = wintypes.HWND
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.SetWindowPos.argtypes = [
        wintypes.HWND,
        wintypes.HWND,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.UINT,
    ]
    user32.SetWindowPos.restype = wintypes.BOOL
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.AttachThreadInput.restype = wintypes.BOOL
    user32.SystemParametersInfoW.argtypes = [
        wintypes.UINT,
        wintypes.UINT,
        ctypes.c_void_p,
        wintypes.UINT,
    ]
    user32.SystemParametersInfoW.restype = wintypes.BOOL
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.c_void_p, ctypes.c_int]
    user32.SendInput.restype = wintypes.UINT
    user32.PostMessageW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.keybd_event.argtypes = [
        wintypes.BYTE,
        wintypes.BYTE,
        wintypes.DWORD,
        wintypes.WPARAM,
    ]
    user32.keybd_event.restype = None
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromWindow.restype = wintypes.HANDLE
    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    user32.GetMonitorInfoW.restype = wintypes.BOOL

    GW_HWNDPREV = 3

    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL

    psapi.GetModuleFileNameExW.argtypes = [
        wintypes.HANDLE,
        wintypes.HMODULE,
        wintypes.LPWSTR,
        wintypes.DWORD,
    ]
    psapi.GetModuleFileNameExW.restype = wintypes.DWORD
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
        wintypes.DWORD,
    ]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL

    SW_RESTORE = 9
    SW_SHOW = 5
    SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000
    SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
    SPIF_SENDCHANGE = 2
    HWND_TOP = 0
    HWND_TOPMOST = -1
    HWND_NOTOPMOST = -2
    SWP_NOSIZE = 0x0001
    SWP_NOMOVE = 0x0002
    SWP_SHOWWINDOW = 0x0040
    INPUT_KEYBOARD = 1
    KEYEVENTF_EXTENDEDKEY = 0x0001
    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_SCANCODE = 0x0008
    WM_KEYDOWN = 0x0100
    WM_KEYUP = 0x0101
    VK_MENU = 0x12
    VK_RETURN = 0x0D
    ASFW_ANY = -1

    GWL_STYLE = -16
    GWL_EXSTYLE = -20
    WS_CAPTION = 0x00C00000
    WS_THICKFRAME = 0x00040000
    WS_POPUP = 0x80000000
    WS_EX_TOPMOST = 0x00000008

    MONITOR_DEFAULTTONEAREST = 2

    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    class CURSORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("hCursor", wintypes.HANDLE),
            ("ptScreenPos", POINT),
        ]

    user32.GetCursorInfo.argtypes = [ctypes.POINTER(CURSORINFO)]
    user32.GetCursorInfo.restype = wintypes.BOOL

    CURSOR_SHOWING = 0x00000001
    CURSOR_SUPPRESSED = 0x00000002

if is_windows():
    ntdll = ctypes.WinDLL("ntdll")
    PROCESS_SUSPEND_RESUME = 0x0800
    THREAD_QUERY_INFORMATION = 0x0040
    THREAD_SUSPEND_RESUME = 0x0002

    ntdll.NtSuspendProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtSuspendProcess.restype = wintypes.DWORD
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.restype = wintypes.DWORD

    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    kernel32.Thread32First.restype = wintypes.BOOL
    kernel32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    kernel32.Thread32Next.restype = wintypes.BOOL
    kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenThread.restype = wintypes.HANDLE
    kernel32.SuspendThread.argtypes = [wintypes.HANDLE]
    kernel32.SuspendThread.restype = wintypes.DWORD
    kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel32.ResumeThread.restype = wintypes.DWORD

    TH32CS_SNAPTHREAD = 0x00000004
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

    class THREADENTRY32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ThreadID", wintypes.DWORD),
            ("th32OwnerProcessID", wintypes.DWORD),
            ("tpBasePri", wintypes.LONG),
            ("tpDeltaPri", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
        ]
else:
    user32 = None
    kernel32 = None
    psapi = None
    ntdll = None
    PROCESS_SUSPEND_RESUME = 0
    THREAD_QUERY_INFORMATION = 0
    THREAD_SUSPEND_RESUME = 0


# --- Window geometry helpers (Windows-only, no-op on other platforms) ---


def get_window_client_physical_geometry(
    hwnd: int,
) -> Optional[Tuple[int, int, int, int]]:
    """Returns a window client area's screen position and size in physical pixels."""
    if not is_windows() or not user32 or not hwnd:
        return None

    with per_monitor_v2_dpi_context():
        pt = POINT()
        pt.x = 0
        pt.y = 0
        if not user32.ClientToScreen(hwnd, ctypes.byref(pt)):
            return None

        client_rect = wintypes.RECT()
        if not user32.GetClientRect(hwnd, ctypes.byref(client_rect)):
            return None

    width = max(0, int(client_rect.right - client_rect.left))
    height = max(0, int(client_rect.bottom - client_rect.top))
    return int(pt.x), int(pt.y), width, height


def get_window_client_screen_offset(hwnd: int) -> Tuple[int, int]:
    """Returns screen coordinates of the top-left corner of the window's client area."""
    geometry = get_window_client_physical_geometry(hwnd)
    if not geometry:
        return 0, 0
    return geometry[0], geometry[1]


def get_window_rect_physical(hwnd: int) -> Optional[Tuple[int, int, int, int]]:
    """Returns a window rectangle in physical pixels."""
    if not is_windows() or not user32 or not hwnd:
        return None

    rect = wintypes.RECT()
    with per_monitor_v2_dpi_context():
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None

    return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)


# --- Critical process denylist ---

_CRITICAL_DENYLIST: List[str] = [
    # Windows
    "explorer.exe",
    "dwm.exe",
    "csrss.exe",
    "services.exe",
    "svchost.exe",
    "smss.exe",
    "wininit.exe",
    "winlogon.exe",
    "lsass.exe",
    "audiodg.exe",
    # Linux display servers / compositors / window managers
    "Xorg",
    "Xwayland",
    "gamescope",
    "gnome-shell",
    "kwin_x11",
    "kwin_wayland",
    "mutter",
    "plasmashell",
    "sway",
    "hyprland",
    "weston",
    "wayfire",
    "river",
    "labwc",
    # Linux display / login managers
    "sddm",
    "gdm",
    "gdm3",
    "lightdm",
    # Linux session bus
    "dbus-daemon",
    "dbus-broker",
    # Input methods — never pause these (critical for Japanese text entry)
    "ibus-daemon",
    "ibus-x11",
    "ibus-engine-simple",
    "ibus-engine-mozc",
    "mozc_server",
    "fcitx",
    "fcitx5",
    "kkc",
    "uim",
    "uim-xim",
    # Linux audio
    "pipewire",
    "pipewire-pulse",
    "pipewire-media-session",
    "wireplumber",
    "pulseaudio",
    "systemd",
    "rtkit-daemon",
    # Shells
    "bash",
    "zsh",
    "sh",
    "fish",
    # OBS / Steam helpers — never suspend the capture source itself
    "obs",
    "obs64.exe",
    "obs.exe",
    "steam",
    "steam.exe",
    "steamwebhelper",
    "reaper",
    "srt-bwrap",
    "pressure-vessel",
    "gameoverlayui",
    # GSM itself
    "gamesentenceminer",
    "gamesentenceminer.exe",
    "gsm_overlay",
    "gsm_overlay.exe",
]

# Emit the Wayland auto-detection warning at most once per session.
_wayland_warn_shown: bool = False

_window_state_monitor: Optional["BaseWindowStateMonitor"] = None
_suspended_pids: Dict[int, Dict[str, Any]] = {}  # pid -> {'suspended_at': float, 'created': int, 'exe': str}
_suspended_pids_lock = threading.RLock()
_auto_resume_thread: Optional[threading.Thread] = None
_suspended_pids_file: Optional[Path] = None
_overlay_pause_request_sources: Set[str] = set()
_overlay_pause_request_pid: Optional[int] = None
_last_process_pausing_activity_ts: float = 0.0


# --- Persistence ---


def _get_suspended_pids_file_path() -> Path:
    global _suspended_pids_file
    if _suspended_pids_file is None:
        _suspended_pids_file = Path(get_app_directory()) / "suspended_pids.json"
    return _suspended_pids_file


@process_pausing_feature()
def _get_suspended_pids_file() -> Path:
    """Get the path to the suspended PIDs persistence file."""
    return _get_suspended_pids_file_path()


@process_pausing_feature()
def _load_suspended_pids():
    """Load suspended PIDs from disk and resume any orphaned processes."""
    global _suspended_pids, _overlay_pause_request_pid, _last_process_pausing_activity_ts
    try:
        pids_file = _get_suspended_pids_file()
        if pids_file.exists():
            with open(pids_file, "r") as f:
                data = json.load(f)
                for entry in data.get("pids", []):
                    try:
                        if isinstance(entry, dict):
                            pid = int(entry.get("pid", 0))
                            record = entry
                        else:
                            pid = int(entry)
                            record = {}
                    except (TypeError, ValueError):
                        continue

                    if pid <= 0:
                        continue

                    if not record or "created" not in record:
                        logger.warning(f"Skipping resume for PID {pid}: missing creation time (legacy entry).")
                        continue

                    if not _process_matches_record(pid, record):
                        logger.warning(f"Skipping resume for PID {pid}: process does not match recorded info.")
                        continue

                    if _resume_process(pid):
                        logger.info(f"Resumed orphaned suspended process PID {pid} from previous session.")
                    else:
                        logger.debug(f"Could not resume PID {pid} (may have already terminated).")
            pids_file.unlink(missing_ok=True)
    except Exception as e:
        logger.debug(f"Error loading suspended PIDs: {e}")
    finally:
        with _suspended_pids_lock:
            _suspended_pids = {}
            _overlay_pause_request_sources.clear()
            _overlay_pause_request_pid = None
            _last_process_pausing_activity_ts = 0.0


@process_pausing_feature()
def _save_suspended_pids():
    """Save currently suspended PIDs to disk."""
    try:
        with _suspended_pids_lock:
            entries = [{"pid": pid, **info} for pid, info in _suspended_pids.items()]
        pids_file = _get_suspended_pids_file()
        pids_file.parent.mkdir(parents=True, exist_ok=True)
        with open(pids_file, "w") as f:
            json.dump({"pids": entries}, f)
    except Exception as e:
        logger.debug(f"Error saving suspended PIDs: {e}")


@process_pausing_feature()
def cleanup_suspended_processes():
    """Resume all currently suspended processes and clear persistence file. Call during app shutdown."""
    try:
        result = force_resume_suspended_processes()
        if result["total_candidates"] > 0:
            logger.info(
                "Suspended process cleanup complete: "
                f"resumed={result['resumed']}, stale={result['stale']}, "
                f"legacy={result['legacy_missing_created']}, failed={result['failed']}."
            )
    except Exception as e:
        logger.error(f"Error during suspended process cleanup: {e}")


def force_resume_suspended_processes() -> Dict[str, int]:
    """
    Force-resume all tracked suspended processes and clear persistence state.

    Intentionally not feature-gated so recovery works even if process pausing
    was disabled after a process was suspended.
    """
    global _suspended_pids, _overlay_pause_request_pid, _last_process_pausing_activity_ts

    result = {
        "total_candidates": 0,
        "resumed": 0,
        "failed": 0,
        "stale": 0,
        "legacy_missing_created": 0,
    }

    records_by_pid: Dict[int, Dict[str, Any]] = {}

    with _suspended_pids_lock:
        for pid, record in _suspended_pids.items():
            records_by_pid[int(pid)] = dict(record)

    pids_file = _get_suspended_pids_file_path()
    try:
        if pids_file.exists():
            with open(pids_file, "r") as f:
                data = json.load(f)
            for entry in data.get("pids", []):
                try:
                    if isinstance(entry, dict):
                        pid = int(entry.get("pid", 0))
                        record = dict(entry)
                    else:
                        pid = int(entry)
                        record = {}
                except (TypeError, ValueError):
                    continue

                if pid <= 0 or pid in records_by_pid:
                    continue
                records_by_pid[pid] = record
    except Exception as e:
        logger.debug(f"Error reading suspended PID persistence during force resume: {e}")

    result["total_candidates"] = len(records_by_pid)

    if result["total_candidates"] > 0:
        logger.info(f"Force-resuming {result['total_candidates']} suspended process(es).")

    for pid, record in records_by_pid.items():
        if not record or "created" not in record:
            logger.warning(f"Skipping resume for PID {pid}: missing creation time (legacy entry).")
            result["legacy_missing_created"] += 1
            continue

        if not _process_matches_record(pid, record):
            logger.warning(f"Skipping resume for PID {pid}: process does not match recorded info.")
            result["stale"] += 1
            continue

        if _resume_process(pid):
            logger.info(f"Resumed suspended process PID {pid}")
            result["resumed"] += 1
        else:
            logger.warning(f"Failed to resume PID {pid} (may have already terminated)")
            result["failed"] += 1

    with _suspended_pids_lock:
        _suspended_pids.clear()
        _overlay_pause_request_sources.clear()
        _overlay_pause_request_pid = None
        _last_process_pausing_activity_ts = 0.0

    try:
        if pids_file.exists():
            pids_file.unlink()
            logger.debug("Cleared suspended PIDs persistence file")
    except Exception as e:
        logger.debug(f"Error clearing suspended PIDs persistence file: {e}")

    return result


# --- Monitor registry ---


def set_window_state_monitor(monitor: Optional["BaseWindowStateMonitor"]) -> None:
    global _window_state_monitor
    _window_state_monitor = monitor


def get_window_state_monitor() -> Optional["BaseWindowStateMonitor"]:
    return _window_state_monitor


def cleanup_minimized_audio_mutes() -> None:
    monitor = get_window_state_monitor()
    if monitor:
        monitor._restore_minimized_audio_mute_internal("shutdown", force_all_sessions=True)


# --- Process pausing state helpers ---


def _clear_overlay_pause_request_state() -> None:
    global _overlay_pause_request_pid
    with _suspended_pids_lock:
        _overlay_pause_request_sources.clear()
        _overlay_pause_request_pid = None


def _mark_process_pausing_activity() -> None:
    global _last_process_pausing_activity_ts
    with _suspended_pids_lock:
        _last_process_pausing_activity_ts = time.time()


def was_process_pausing_used_recently(max_age_seconds: float = 180.0) -> bool:
    if max_age_seconds <= 0:
        return False
    with _suspended_pids_lock:
        last_activity = _last_process_pausing_activity_ts
    if last_activity <= 0:
        return False
    return (time.time() - last_activity) <= float(max_age_seconds)


def _normalize_overlay_pause_source(source: Optional[str]) -> str:
    normalized = str(source or "").strip().lower()
    return normalized or "overlay"


def _resolve_pause_target_hwnd(hwnd: Optional[int]) -> Optional[int]:
    if hwnd:
        return hwnd
    monitor = get_window_state_monitor()
    if monitor and monitor.target_hwnd:
        return monitor.target_hwnd
    if not user32:
        return None
    return user32.GetForegroundWindow()


# --- Linux process resolution ---


def _get_configured_linux_target() -> str:
    process_cfg = getattr(get_config(), "process_pausing", None)
    return (getattr(process_cfg, "linux_target_process", "") or "") if process_cfg else ""


def _cmdline_matches_target(cmdline: List[str], target_names: Set[str], deny_set: Set[str]) -> bool:
    """Return True if any cmdline arg matches target_names and is not denylisted."""
    cmd_variants: Set[str] = set()
    for arg in cmdline:
        cmd_variants |= _normalize_exe_entry(arg)
    return bool(cmd_variants & target_names) and not bool(cmd_variants & deny_set)


def _match_process_by_names(target_names: Set[str], context: str) -> int:
    """Find the PID of a running process whose name matches one of target_names."""
    if not target_names:
        return 0

    self_pid = os.getpid()
    deny_set = _effective_denylist()

    truncated_targets = {t[:15] for t in target_names}

    cmdline_fallback = 0
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            pid = proc.info["pid"]
            name = proc.info["name"] or ""
            cmdline = proc.info["cmdline"] or []
        except (psutil.Error, KeyError):
            continue
        if not pid or pid <= 0 or pid == self_pid:
            continue

        name_variants = _normalize_exe_entry(name)
        if name_variants & deny_set:
            continue

        if name_variants and ((name_variants & target_names) or (name_variants & truncated_targets)):
            return pid

        if not cmdline_fallback and _cmdline_matches_target(cmdline, target_names, deny_set):
            cmdline_fallback = pid

    if cmdline_fallback:
        logger.debug(f"{context}: matched target via cmdline fallback (PID {cmdline_fallback}).")
    return cmdline_fallback


def _x11_window_pid(disp, window_id: int) -> int:
    """_NET_WM_PID of an X11 window, or 0 if unavailable/stale (BadWindow)."""
    try:
        win = disp.create_resource_object("window", window_id)
        atom = disp.intern_atom("_NET_WM_PID")
        prop = win.get_full_property(atom, _X.AnyPropertyType)
        if prop and prop.value:
            return int(prop.value[0])
    except Exception:
        return 0
    return 0


def _x11_window_identity(disp, window_id: int) -> Tuple[Set[str], str]:
    """Return ((lowercased WM_CLASS names), lowercased WM_NAME title) for a window."""
    try:
        win = disp.create_resource_object("window", window_id)
        cls = win.get_wm_class()
        names = {c.lower() for c in (cls or ()) if c}
        nm = win.get_wm_name()
        title = nm.lower() if nm else ""
        return names, title
    except Exception:
        return set(), ""


def _x11_find_window_by_class_or_title(disp, wm_class: str, title: str) -> int:
    """Locate a live top-level window by WM_CLASS (preferred) or exact title."""
    wm_class_l = (wm_class or "").lower()
    title_l = (title or "").lower()
    if not wm_class_l and not title_l:
        return 0
    use_title_fallback = title_l and not wm_class_l
    try:
        root = disp.screen().root
        atom = disp.intern_atom("_NET_CLIENT_LIST")
        prop = root.get_full_property(atom, _X.AnyPropertyType)
        if not prop:
            return 0
        title_match = 0
        for wid in prop.value:
            wid = int(wid)
            names, win_title = _x11_window_identity(disp, wid)
            if wm_class_l and wm_class_l in names:
                return wid
            if use_title_fallback and not title_match and win_title == title_l:
                title_match = wid
        return title_match
    except Exception:
        return 0


def _x11_window_matches(disp, window_id: int, wm_class: str, title: str) -> bool:
    """Return True if the live window at window_id still has the recorded wm_class/title."""
    wm_class_l = (wm_class or "").lower()
    title_l = (title or "").lower()
    if not wm_class_l and not title_l:
        return False
    names, win_title = _x11_window_identity(disp, window_id)
    if wm_class_l and title_l:
        return wm_class_l in names and bool(win_title) and win_title == title_l
    if wm_class_l:
        return wm_class_l in names
    return bool(win_title) and win_title == title_l


# Proton/Steam launcher processes that can own a game's X11 window but are not the game itself.
_PROTON_LAUNCHER_COMMS = {
    "pv-bwrap",
    "pv-adverb",
    "pressure-vessel-wrap",
    "wine",
    "wine64",
    "wineserver",
    "wine-preloader",
    "wine64-preloader",
    "winedevice.exe",
    "start.exe",
    "conhost.exe",
    "rpcss.exe",
    "plugplay.exe",
    "proton",
    "python3",
    "python",
}


def _steam_game_dir_from_cmdline(cmdline: List[str]) -> str:
    """Return the lowercased 'steamapps/common/<GameDir>' from a launcher's cmdline, or ''."""
    result = ""
    for arg in cmdline or []:
        path = (arg or "").replace("\\", "/").lower()
        idx = path.find("steamapps/common/")
        if idx == -1:
            continue
        parts = path[idx:].split("/")
        if len(parts) < 3 or not parts[2]:
            continue
        if parts[2].startswith("steamlinuxruntime"):
            continue
        result = "/".join(parts[:3])
    return result


def _proc_rss_if_in_dir(info: dict, game_dir: str, deny_set: Set[str], self_pid: int) -> Tuple[int, int]:
    """Return (pid, rss) if info describes a non-denylisted process running from game_dir, else (0, 0)."""
    pid = info.get("pid") or 0
    if not pid or pid == self_pid:
        return 0, 0
    if _normalize_exe_entry(info.get("name") or "") & deny_set:
        return 0, 0
    haystack = ((info.get("exe") or "") + " " + " ".join(info.get("cmdline") or [])).replace("\\", "/").lower()
    if game_dir not in haystack:
        return 0, 0
    mem = info.get("memory_info")
    return pid, (mem.rss if mem else 0)


def _largest_process_in_dir(game_dir: str, deny_set: Set[str]) -> int:
    """The highest-memory non-denylisted process running from game_dir."""
    if not game_dir:
        return 0
    self_pid = os.getpid()
    best_rss, best_pid = 0, 0
    for proc in psutil.process_iter(["pid", "name", "exe", "cmdline", "memory_info"]):
        try:
            pid, rss = _proc_rss_if_in_dir(proc.info, game_dir, deny_set, self_pid)
            if rss > best_rss:
                best_rss, best_pid = rss, pid
        except (psutil.Error, KeyError):
            continue
    if best_pid:
        logger.debug(f"Proton game dir '{game_dir}': selected PID {best_pid} (RSS {best_rss // 1024 // 1024} MB).")
    return best_pid


def _refine_proton_pid(window_pid: int) -> int:
    """Map a captured-window PID to the real game PID for Proton/Steam titles."""
    try:
        proc = psutil.Process(window_pid)
        comm = (proc.name() or "").lower()
        cmdline = proc.cmdline()
    except psutil.Error as e:
        logger.debug(f"_refine_proton_pid: cannot inspect PID {window_pid}: {e}; treating as unresolvable.")
        return 0

    process_cfg = getattr(get_config(), "process_pausing", None)
    deny_set = _effective_denylist(process_cfg)
    is_launcher = comm in _PROTON_LAUNCHER_COMMS or bool(_normalize_exe_entry(comm) & deny_set)
    if not is_launcher:
        return window_pid

    real = _largest_process_in_dir(_steam_game_dir_from_cmdline(cmdline), deny_set)
    if real and real != window_pid:
        logger.debug(f"Proton title: window owned by launcher '{comm}' (PID {window_pid}); using game PID {real}.")
        return real
    return 0


def _x11_window_to_pid(disp, info: dict) -> int:
    """Resolve the PID for the window described by info using the live X11 state."""
    wm_class = info.get("wm_class", "")
    title = info.get("title", "")
    pid = 0
    winid = info.get("winid")
    if winid:
        if _x11_window_matches(disp, int(winid), wm_class, title):
            pid = _x11_window_pid(disp, int(winid))
    if pid <= 0:
        found = _x11_find_window_by_class_or_title(disp, wm_class, title)
        if found:
            pid = _x11_window_pid(disp, found)
    return pid


def _exe_path_from_cmdline(cmdline: List[str]) -> str:
    """Return the most game-like '*.exe' argument from a launcher cmdline, or ''."""
    best = ""
    for arg in cmdline or []:
        norm = (arg or "").replace("\\", "/")
        if not norm.lower().endswith(".exe"):
            continue
        if os.path.basename(norm).lower() in _PROTON_LAUNCHER_COMMS:
            continue
        # Prefer the exe under steamapps/common (the actual game) over launcher shims.
        if "steamapps/common/" in norm.lower():
            return arg
        if not best:
            best = arg
    return best


def detect_linux_game_executable(context: str = "detect game exe") -> str:
    """Resolve the game's executable path/name from the OBS-captured X11 window.

    Reuses the X11/XComposite resolution that drives process pausing. Prefers the Windows
    '*.exe' path from the process cmdline (so the Wine/Proton prefix can be derived), falling
    back to the resolved Linux exe path/name. Returns '' when the game cannot be resolved
    (e.g. Wayland sessions — the user should then set the path manually).
    """
    if not is_linux():
        return ""
    pid = _resolve_linux_pid_from_obs(context)
    if pid <= 0:
        return ""
    try:
        cmdline = psutil.Process(pid).cmdline() or []
    except (psutil.Error, OSError):
        cmdline = []
    exe_arg = _exe_path_from_cmdline(cmdline)
    if exe_arg:
        return exe_arg
    return _get_process_exe_path(pid) or _get_process_exe_name(pid)


def _resolve_linux_pid_from_obs(context: str) -> int:
    """Automatic target: the PID of the window OBS is capturing (X11 only)."""
    if not _HAS_XLIB or not is_linux() or is_wayland():
        return 0
    try:
        info = get_linux_capture_window_info(scene_name=get_current_scene())
    except Exception as e:
        logger.debug(f"{context}: OBS capture window lookup failed: {e}")
        return 0
    if not info:
        return 0

    disp = None
    try:
        disp = _xdisplay.Display()
        pid = _x11_window_to_pid(disp, info)
        if pid > 0 and pid != os.getpid():
            refined = _refine_proton_pid(pid)
            if refined > 0 and refined != os.getpid():
                return refined
    except Exception as e:
        logger.debug(f"{context}: X11 PID resolution failed: {e}")
    finally:
        if disp is not None:
            try:
                disp.close()
            except Exception:
                pass
    return 0


def _resolve_linux_target_pid(context: str, log_on_missing: bool = True) -> Tuple[int, str]:
    """Resolve the game PID on Linux and return (pid, source).

    Source values: 'config_name', 'obs_x11', 'detected_name', 'none'.
    """
    global _wayland_warn_shown

    configured = _get_configured_linux_target()
    if configured:
        pid = _match_process_by_names(_normalize_exe_entry(configured), context)
        if pid > 0:
            return pid, "config_name"

    pid = _resolve_linux_pid_from_obs(context)
    if pid > 0:
        return pid, "obs_x11"

    detected = _get_detected_game_exe()
    if detected:
        pid = _match_process_by_names(_normalize_exe_entry(detected), context)
        if pid > 0:
            return pid, "detected_name"

    if log_on_missing:
        if is_wayland() and not configured and not _wayland_warn_shown:
            _wayland_warn_shown = True
            logger.warning(
                f"{context}: automatic game detection relies on X11 window enumeration "
                f"and is unavailable on this Wayland session "
                f"(this includes XWayland games — the session type, not the game, determines availability). "
                f"Set process_pausing.linux_target_process to the game's process name "
                f"(e.g. 'eldenring.exe' for a Proton title) to enable pausing."
            )
        else:
            logger.warning(
                f"{context}: could not resolve a game process. No OBS capture window found "
                f"and no process_pausing.linux_target_process configured."
            )
    return 0, "none"


def _resolve_pause_target_pid(hwnd: Optional[int], context: str, log_on_missing: bool = True) -> Tuple[int, str]:
    """Resolve the PID to suspend/resume and return (pid, source)."""
    if is_linux():
        return _resolve_linux_target_pid(context, log_on_missing=log_on_missing)

    if not is_windows():
        return 0, "none"

    resolved_hwnd = _resolve_pause_target_hwnd(hwnd)
    if not resolved_hwnd:
        if log_on_missing:
            logger.warning(f"{context}: no active window detected.")
        return 0, "none"

    pid = _get_pid_for_hwnd(resolved_hwnd)
    if pid <= 0:
        if log_on_missing:
            logger.warning(f"{context}: failed to resolve PID.")
        return 0, "none"

    if pid == os.getpid():
        if log_on_missing:
            logger.warning(f"{context}: refusing to suspend GSM itself.")
        return 0, "none"
    return pid, "windows_hwnd"


def _get_pid_for_hwnd(hwnd: int) -> int:
    if not is_windows() or not user32:
        return 0
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def _is_tracked_suspended_pid(pid: int) -> bool:
    if pid <= 0:
        return False

    with _suspended_pids_lock:
        record = dict(_suspended_pids.get(pid) or {})

    if not record:
        return False

    return _process_matches_record(pid, record)


def _get_process_creation_time(pid: int) -> Optional[int]:
    if is_linux():
        try:
            return int(psutil.Process(pid).create_time() * 1_000_000)
        except (psutil.Error, ValueError, OSError):
            return None
    if not is_windows() or not kernel32:
        return None
    h_process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h_process:
        return None
    try:
        creation_time = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel_time = wintypes.FILETIME()
        user_time = wintypes.FILETIME()
        if not kernel32.GetProcessTimes(
            h_process,
            ctypes.byref(creation_time),
            ctypes.byref(exit_time),
            ctypes.byref(kernel_time),
            ctypes.byref(user_time),
        ):
            return None
        return (creation_time.dwHighDateTime << 32) + creation_time.dwLowDateTime
    finally:
        kernel32.CloseHandle(h_process)


def _get_process_exe_path(pid: int) -> str:
    if is_linux():
        try:
            proc = psutil.Process(pid)
            return proc.exe() or proc.name() or ""
        except (psutil.Error, OSError):
            return ""
    if not is_windows() or not kernel32 or not psapi:
        return ""
    h_process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h_process:
        return ""
    try:
        buff = ctypes.create_unicode_buffer(1024)
        if psapi.GetModuleFileNameExW(h_process, None, buff, 1024):
            return buff.value
    finally:
        kernel32.CloseHandle(h_process)
    return ""


def _normalize_exe_entry(entry: str) -> Set[str]:
    if not entry:
        return set()
    exe = os.path.basename(entry.replace("\\", "/")).lower()
    if not exe:
        return set()
    variants = {exe}
    if exe.endswith(".exe"):
        variants.add(exe[:-4])
    else:
        variants.add(f"{exe}.exe")
    return variants


def _build_exe_name_set(entries: List[str]) -> Set[str]:
    exe_names: Set[str] = set()
    for entry in entries:
        exe_names.update(_normalize_exe_entry(entry))
    return exe_names


def _name_variants(entry: str) -> Set[str]:
    """Exe-name variants of entry plus 15-char-truncated forms (/proc/comm limit)."""
    variants = _normalize_exe_entry(entry)
    return variants | {v[:15] for v in variants}


def _effective_denylist(process_cfg=None) -> Set[str]:
    """User denylist unioned with the hardcoded critical-process floor."""
    if process_cfg is None:
        process_cfg = getattr(get_config(), "process_pausing", None)
    stored: List[str] = list(getattr(process_cfg, "denylist", []) or []) if process_cfg else []
    names = _build_exe_name_set([*stored, *_CRITICAL_DENYLIST])
    return names | {n[:15] for n in names}


def _get_process_comm_name(pid: int) -> str:
    """Return the comm (psutil name) for a process — the /proc/<pid>/comm basename."""
    try:
        return psutil.Process(pid).name() or ""
    except (psutil.Error, OSError):
        return ""


def _get_process_uid(pid: int) -> Optional[int]:
    """Return the effective UID of the process, or None if it cannot be determined."""
    try:
        return psutil.Process(pid).uids().effective
    except (psutil.Error, OSError, AttributeError):
        return None


def _pid_name_matches_target(pid: int, target: str) -> bool:
    """True if either the exe basename or the comm name of pid matches target."""
    if not target:
        return False
    target_set = _name_variants(target)

    exe_name = _get_process_exe_name(pid)
    if exe_name and (_normalize_exe_entry(exe_name) & target_set):
        return True

    comm_name = _get_process_comm_name(pid)
    if comm_name and (_normalize_exe_entry(comm_name) & target_set):
        return True

    return False


def _exe_names_match(left: str, right: str) -> bool:
    if not left or not right:
        return False
    return bool(_normalize_exe_entry(left) & _normalize_exe_entry(right))


def _get_process_exe_name(pid: int) -> str:
    path = _get_process_exe_path(pid)
    return os.path.basename(path) if path else ""


def _get_auto_resume_delay() -> float:
    process_cfg = getattr(get_config(), "process_pausing", None)
    if process_cfg and getattr(process_cfg, "auto_resume_seconds", None) is not None:
        try:
            return max(5.0, float(process_cfg.auto_resume_seconds))
        except (TypeError, ValueError):
            return 30.0
    return 30.0


def _process_matches_record(pid: int, record: Dict[str, Any]) -> bool:
    creation_time = record.get("created")
    exe_name = record.get("exe", "")
    if creation_time is None:
        return False
    current_creation_time = _get_process_creation_time(pid)
    if current_creation_time is None or current_creation_time != creation_time:
        return False
    if exe_name:
        current_exe = _get_process_exe_name(pid).lower()
        return current_exe == exe_name.lower()
    return True


def _posix_signal_process(pid: int, sig: int) -> bool:
    """Send sig to a single PID on Linux. Returns True on success."""
    try:
        os.kill(pid, sig)
        return True
    except ProcessLookupError as e:
        logger.debug(f"POSIX signal {sig} to PID {pid}: process no longer exists ({e}).")
        return False
    except PermissionError as e:
        logger.warning(
            f"Cannot signal PID {pid}: insufficient permissions ({e}). "
            f"The game may be running as a different user or in a sandbox "
            f"(Proton/Flatpak/root helper); GSM cannot pause it."
        )
        return False
    except OSError as e:
        logger.warning(f"POSIX signal {sig} to PID {pid} failed: {e}")
        return False


def _suspend_process(pid: int) -> bool:
    if is_linux():
        return _posix_signal_process(pid, signal.SIGSTOP)
    if not is_windows():
        return False
    if not kernel32 or not ntdll:
        return False
    h_process = kernel32.OpenProcess(PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h_process:
        return False
    try:
        status = ntdll.NtSuspendProcess(h_process)
        return status == 0
    finally:
        kernel32.CloseHandle(h_process)


def _resume_process(pid: int) -> bool:
    if is_linux():
        return _posix_signal_process(pid, signal.SIGCONT)
    if not is_windows():
        return False
    if not kernel32 or not ntdll:
        return False
    h_process = kernel32.OpenProcess(PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h_process:
        return False
    try:
        status = ntdll.NtResumeProcess(h_process)
        nt_resume_succeeded = status == 0
    finally:
        kernel32.CloseHandle(h_process)

    total_threads, forced_resume_calls, failed_threads = _force_resume_process_threads(pid)
    if failed_threads:
        logger.debug(
            f"Resume process PID {pid}: thread force-resume encountered {failed_threads} inaccessible thread(s)."
        )

    if nt_resume_succeeded:
        return True

    if total_threads > 0 and failed_threads == 0:
        if forced_resume_calls > 0:
            logger.debug(f"Resume process PID {pid}: recovered via thread force-resume after NtResumeProcess failure.")
        return True

    return False


def _force_resume_process_threads(pid: int, max_resume_attempts: int = 64) -> Tuple[int, int, int]:
    if not is_windows() or not kernel32 or pid <= 0:
        return 0, 0, 0

    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    if not snapshot or int(snapshot) == int(INVALID_HANDLE_VALUE):
        return 0, 0, 0

    total_threads = 0
    forced_resume_calls = 0
    failed_threads = 0

    try:
        thread_entry = THREADENTRY32()
        thread_entry.dwSize = ctypes.sizeof(THREADENTRY32)
        has_entry = bool(kernel32.Thread32First(snapshot, ctypes.byref(thread_entry)))

        while has_entry:
            if int(thread_entry.th32OwnerProcessID) == int(pid):
                total_threads += 1
                h_thread = kernel32.OpenThread(
                    THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION,
                    False,
                    int(thread_entry.th32ThreadID),
                )

                if not h_thread:
                    failed_threads += 1
                else:
                    try:
                        for _ in range(max_resume_attempts):
                            previous_suspend_count = int(kernel32.ResumeThread(h_thread))
                            if previous_suspend_count == 0xFFFFFFFF:
                                failed_threads += 1
                                break
                            if previous_suspend_count <= 1:
                                if previous_suspend_count == 1:
                                    forced_resume_calls += 1
                                break
                            forced_resume_calls += 1
                        else:
                            failed_threads += 1
                            logger.warning(
                                f"Resume process PID {pid}: exceeded max resume attempts for thread "
                                f"{int(thread_entry.th32ThreadID)}."
                            )
                    finally:
                        kernel32.CloseHandle(h_thread)

            thread_entry.dwSize = ctypes.sizeof(THREADENTRY32)
            has_entry = bool(kernel32.Thread32Next(snapshot, ctypes.byref(thread_entry)))
    finally:
        kernel32.CloseHandle(snapshot)

    return total_threads, forced_resume_calls, failed_threads


def _exe_name_matches_set(exe_name: str, allowed: Set[str]) -> bool:
    if not exe_name:
        return False
    name = os.path.basename(exe_name).lower()
    if name in allowed:
        return True
    if name.endswith(".exe") and name[:-4] in allowed:
        return True
    if not name.endswith(".exe") and f"{name}.exe" in allowed:
        return True
    return False


def _get_detected_game_exe() -> str:
    monitor = get_window_state_monitor()
    current_scene = get_current_scene()
    if monitor and monitor.last_target_info:
        if getattr(monitor, "last_target_scene_name", None) == current_scene:
            exe = monitor.last_target_info.get("exe", "")
            if exe:
                return os.path.basename(exe)
    try:
        window_info = get_window_info_from_source(scene_name=current_scene)
        if window_info:
            exe = window_info.get("exe", "")
            if exe:
                return os.path.basename(exe)
    except Exception as e:
        logger.debug(f"Error getting OBS window info for game exe: {e}")
    return ""


def _is_pid_allowed_to_suspend(
    pid: int,
    source: Literal["config_name", "obs_x11", "detected_name", "windows_hwnd", "none"] = "none",
) -> bool:
    process_cfg = getattr(get_config(), "process_pausing", None)
    if not process_cfg:
        logger.warning("Process pausing config missing; refusing to suspend.")
        return False

    exe_name = _get_process_exe_name(pid)

    deny_set = _effective_denylist(process_cfg)
    if exe_name and _exe_name_matches_set(exe_name, deny_set):
        logger.warning(f"Pause: {exe_name} is denylisted.")
        return False
    comm_name = _get_process_comm_name(pid)
    if comm_name and _exe_name_matches_set(comm_name, deny_set):
        logger.warning(f"Pause: comm '{comm_name}' (PID {pid}) is denylisted.")
        return False

    if is_linux():
        target_uid = _get_process_uid(pid)
        if target_uid is None:
            logger.warning(f"Pause: could not verify ownership of PID {pid}; refusing to suspend.")
            return False
        if target_uid != os.geteuid():
            logger.warning(
                f"Pause: PID {pid} is owned by uid {target_uid}, not the "
                f"current user (uid {os.geteuid()}); refusing to suspend."
            )
            return False

    if not exe_name and not comm_name:
        logger.warning(f"Pause: could not resolve process name for PID {pid}; refusing to suspend.")
        return False

    if getattr(process_cfg, "require_game_exe_match", True):
        if is_linux():
            return _linux_pid_source_allowed(pid, source, exe_name, comm_name)

        detected_game_exe = _get_detected_game_exe()
        if not detected_game_exe:
            logger.warning("Pause: could not determine current game exe; refusing to suspend.")
            return False
        if os.path.basename(exe_name).lower() != os.path.basename(detected_game_exe).lower():
            logger.warning(f"Pause: exe '{exe_name}' does not match detected game exe '{detected_game_exe}'.")
            return False

    return True


def _linux_pid_source_allowed(pid: int, source: str, exe_name: str, comm_name: str) -> bool:
    """Provenance-aware allow-gate for Linux PIDs."""
    configured = _get_configured_linux_target()
    if configured:
        if not _pid_name_matches_target(pid, configured):
            logger.warning(
                f"Pause: PID {pid} (exe='{exe_name}', comm='{comm_name}') does not "
                f"match configured target '{configured}'."
            )
            return False
        return True

    if source == "obs_x11":
        return True

    if source == "detected_name":
        detected_linux_exe = _get_detected_game_exe()
        if not detected_linux_exe:
            return True
        if not _pid_name_matches_target(pid, detected_linux_exe):
            logger.warning(f"Pause: PID {pid} does not match detected game exe '{detected_linux_exe}'.")
            return False
        return True

    logger.warning(
        f"Pause: could not establish a game-exe anchor for PID {pid} "
        f"(source={source!r}); refusing to suspend. "
        f"Set process_pausing.linux_target_process to enable deterministic matching."
    )
    return False


# --- Auto-resume monitor ---


def _auto_resume_monitor():
    """Monitors suspended processes and auto-resumes after timeout."""
    while True:
        time.sleep(5.0)

        with _suspended_pids_lock:
            if not _suspended_pids:
                continue
            items = list(_suspended_pids.items())

        current_time = time.time()
        pids_to_resume = []

        auto_resume_delay = _get_auto_resume_delay()
        for pid, info in items:
            with _suspended_pids_lock:
                overlay_holds_pause = _overlay_pause_request_pid == pid and bool(_overlay_pause_request_sources)
            if overlay_holds_pause:
                continue
            suspended_at = info.get("suspended_at", 0)
            if current_time - suspended_at >= auto_resume_delay:
                pids_to_resume.append(pid)

        for pid in pids_to_resume:
            with _suspended_pids_lock:
                record = _suspended_pids.get(pid)
            if not record or not _process_matches_record(pid, record):
                logger.warning(f"Auto-resume skipped for PID {pid}: process does not match recorded info.")
                with _suspended_pids_lock:
                    _suspended_pids.pop(pid, None)
                _save_suspended_pids()
                continue
            if _resume_process(pid):
                with _suspended_pids_lock:
                    _suspended_pids.pop(pid, None)
                _save_suspended_pids()
                _mark_process_pausing_activity()
                logger.info(f"Auto-resumed process PID {pid} after {auto_resume_delay}s timeout.")
            else:
                logger.warning(f"Failed to auto-resume PID {pid}.")
                with _suspended_pids_lock:
                    _suspended_pids.pop(pid, None)
                _save_suspended_pids()


def _ensure_auto_resume_task():
    """Ensures the auto-resume monitoring thread is running."""
    global _auto_resume_thread

    if _auto_resume_thread is None or not _auto_resume_thread.is_alive():
        _auto_resume_thread = threading.Thread(target=_auto_resume_monitor, daemon=True, name="AutoResumeMonitor")
        _auto_resume_thread.start()


def _resume_tracked_process(pid: int, context: str) -> bool:
    with _suspended_pids_lock:
        record = _suspended_pids.get(pid)

    if not record:
        logger.debug(f"{context}: PID {pid} is not tracked as suspended.")
        return False

    if not _process_matches_record(pid, record):
        logger.warning(f"{context}: PID {pid} does not match recorded process; clearing stale entry.")
        with _suspended_pids_lock:
            _suspended_pids.pop(pid, None)
        _save_suspended_pids()
        return False

    if _resume_process(pid):
        with _suspended_pids_lock:
            _suspended_pids.pop(pid, None)
        _save_suspended_pids()
        _mark_process_pausing_activity()
        logger.info(f"Resumed process PID {pid}.")
        return True

    logger.warning(f"{context}: failed to resume PID {pid}.")
    return False


def _suspend_process_with_tracking(pid: int, context: str, source: str = "none") -> bool:
    if not _is_pid_allowed_to_suspend(pid, source=source):
        return False

    creation_time = _get_process_creation_time(pid)
    if creation_time is None:
        logger.warning(f"{context}: could not determine process creation time.")
        return False

    exe_name = _get_process_exe_name(pid)
    if _suspend_process(pid):
        with _suspended_pids_lock:
            _suspended_pids[pid] = {
                "suspended_at": time.time(),
                "created": creation_time,
                "exe": exe_name,
            }
        _save_suspended_pids()
        _mark_process_pausing_activity()
        _ensure_auto_resume_task()
        auto_resume_delay = _get_auto_resume_delay()
        logger.info(f"Suspended process PID {pid}. Will auto-resume in {auto_resume_delay}s.")
        return True

    logger.warning(f"{context}: failed to suspend PID {pid}.")
    return False


def _handle_overlay_pause_request(source: str, hwnd: Optional[int]) -> bool:
    global _overlay_pause_request_pid

    pid, pid_source = _resolve_pause_target_pid(hwnd, "Overlay pause request")
    if pid <= 0:
        return False

    with _suspended_pids_lock:
        tracked_overlay_pid = _overlay_pause_request_pid
        source_already_registered = source in _overlay_pause_request_sources
        record = _suspended_pids.get(pid)

    if source_already_registered and tracked_overlay_pid == pid:
        logger.debug(f"Overlay pause request: source '{source}' already paused PID {pid}.")
        return True

    if tracked_overlay_pid is not None and tracked_overlay_pid != pid:
        logger.warning(
            f"Overlay pause request: source '{source}' targeted PID {pid}, "
            f"but overlay pause target is PID {tracked_overlay_pid}; refusing to conflict."
        )
        return False

    if record and _process_matches_record(pid, record):
        with _suspended_pids_lock:
            _overlay_pause_request_sources.add(source)
            _overlay_pause_request_pid = pid
        logger.info(f"Overlay pause request: source '{source}' linked to existing suspended PID {pid}.")
        return True

    if record and not _process_matches_record(pid, record):
        logger.warning(f"Overlay pause request: PID {pid} has stale tracking record; clearing.")
        with _suspended_pids_lock:
            _suspended_pids.pop(pid, None)
        _save_suspended_pids()

    if not _suspend_process_with_tracking(pid, "Overlay pause request", source=pid_source):
        return False

    with _suspended_pids_lock:
        _overlay_pause_request_sources.add(source)
        _overlay_pause_request_pid = pid
    return True


def _handle_overlay_resume_request(source: str, hwnd: Optional[int]) -> bool:
    global _overlay_pause_request_pid

    with _suspended_pids_lock:
        _overlay_pause_request_sources.discard(source)
        remaining_sources = set(_overlay_pause_request_sources)
        tracked_overlay_pid = _overlay_pause_request_pid

    if remaining_sources:
        logger.info(
            f"Overlay resume request: source '{source}' released pause, but still held by {sorted(remaining_sources)}."
        )
        return True

    pid_to_resume = tracked_overlay_pid
    if not pid_to_resume:
        candidate_pid, _ = _resolve_pause_target_pid(hwnd, "Overlay resume request", log_on_missing=False)
        if candidate_pid > 0:
            with _suspended_pids_lock:
                if candidate_pid in _suspended_pids:
                    pid_to_resume = candidate_pid

    with _suspended_pids_lock:
        _overlay_pause_request_pid = None

    if not pid_to_resume:
        logger.debug("Overlay resume request: no suspended PID found to resume.")
        return True

    return _resume_tracked_process(pid_to_resume, "Overlay resume request")


@process_pausing_feature(default_return=False)
def request_overlay_process_pause(action: str, source: str = "overlay", hwnd: Optional[int] = None) -> bool:
    if is_windows() and not user32:
        logger.info("Overlay pause requests require Win32 APIs that are unavailable.")
        return False
    if not is_windows() and not is_linux():
        logger.info("Overlay pause requests are supported on Windows and Linux only.")
        return False

    normalized_action = str(action or "").strip().lower()
    if normalized_action not in {"pause", "resume"}:
        logger.warning(f"Overlay pause request: unsupported action '{action}'.")
        return False

    normalized_source = _normalize_overlay_pause_source(source)
    if normalized_action == "pause":
        return _handle_overlay_pause_request(normalized_source, hwnd)
    return _handle_overlay_resume_request(normalized_source, hwnd)


_PAUSE_HOTKEY_CTX = "Pause hotkey"


@process_pausing_feature(default_return=False)
def toggle_active_game_pause(hwnd: Optional[int] = None) -> bool:
    if is_windows() and not user32:
        logger.info("Pause hotkey requires Win32 APIs that are unavailable.")
        return False
    if not is_windows() and not is_linux():
        logger.info("Pause hotkey is supported on Windows and Linux only.")
        return False

    pid, pid_source = _resolve_pause_target_pid(hwnd, _PAUSE_HOTKEY_CTX)
    if pid <= 0:
        return False

    with _suspended_pids_lock:
        record = _suspended_pids.get(pid)

    if record:
        if _resume_tracked_process(pid, _PAUSE_HOTKEY_CTX):
            _clear_overlay_pause_request_state()
            return True

        with _suspended_pids_lock:
            if pid in _suspended_pids:
                return False

    if _suspend_process_with_tracking(pid, _PAUSE_HOTKEY_CTX, source=pid_source):
        _clear_overlay_pause_request_state()
        return True

    return False


# --- Base window state monitor ---


class BaseWindowStateMonitor:
    """Shared interface for platform-specific window state monitors.

    Windows uses WindowsWindowStateMonitor; Linux uses LinuxWindowStateMonitor.
    Attributes accessed by OverlayProcessor and other callers are declared here
    so type-checking and attribute access work on all platforms.
    """

    def __init__(self, overlay_processor=None):
        self.overlay_processor = overlay_processor
        self.target_hwnd: Optional[int] = None
        self.last_state: str = "unknown"
        self.last_game_name: str = ""
        self.last_target_info: Dict[str, str] = {}
        self.last_target_scene_name: Optional[str] = None
        self.magpie_info: Optional[Dict[str, Any]] = None
        self.last_magpie_info: Optional[Dict[str, Any]] = None
        self.poll_interval: float = 0.3
        self.last_obs_dimensions_time: float = 0.0
        self.window_stable_count: int = 0

    async def check_and_send(self) -> None:
        """Check window state and broadcast changes. No-op on non-Windows platforms."""
        pass

    def find_target_hwnd(self) -> Optional[int]:
        """Find the HWND for the current game. Returns None on non-Windows platforms."""
        return None

    async def activate_target_window(self) -> bool:
        """Bring the target game window to the foreground. Returns False on non-Windows."""
        return False

    def _restore_minimized_audio_mute_internal(
        self,
        reason: str = "",
        force_all_sessions: bool = False,
        pid: Optional[int] = None,
    ) -> bool:
        """No-op on non-Windows platforms."""
        return False
