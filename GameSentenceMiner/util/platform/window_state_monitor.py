import asyncio
import copy
import ctypes
import json
import os
import threading
import time
from ctypes import wintypes
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional, Set

from GameSentenceMiner.obs import (
    get_window_info_from_source,
    get_current_scene,
    get_current_game,
)
from GameSentenceMiner.util.config.configuration import (
    get_app_directory,
    get_overlay_config,
    get_master_config,
    is_windows,
    logger,
)
from GameSentenceMiner.util.config.feature_flags import (
    experimental_feature,
    process_pausing_feature,
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

    # User32 types
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

    # GetWindow constants
    GW_HWNDPREV = 3

    # Kernel32 types
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

    # PSAPI types
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
    WM_KEYDOWN = 0x0100
    WM_KEYUP = 0x0101
    VK_MENU = 0x12
    VK_RETURN = 0x0D
    ASFW_ANY = -1

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
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]


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
    """
    Calculates the screen coordinates (x, y) of the top-left corner
    of a window's CLIENT area (excluding title bar/borders).
    """
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


if is_windows():
    ntdll = ctypes.WinDLL("ntdll")
    PROCESS_SUSPEND_RESUME = 0x0800
    THREAD_QUERY_INFORMATION = 0x0040
    THREAD_SUSPEND_RESUME = 0x0002

    ntdll.NtSuspendProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtSuspendProcess.restype = wintypes.DWORD
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.restype = wintypes.DWORD

    # Thread snapshot APIs
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
    THREAD_QUERY_INFORMATION = 0
    THREAD_SUSPEND_RESUME = 0

_window_state_monitor: Optional["WindowStateMonitor"] = None
_suspended_pids: Dict[
    int, Dict[str, Any]
] = {}  # pid -> {'suspended_at': float, 'created': int, 'exe': str}
_suspended_pids_lock = threading.RLock()
_auto_resume_thread: Optional[threading.Thread] = None
_suspended_pids_file: Optional[Path] = None
_overlay_pause_request_sources: Set[str] = set()
_overlay_pause_request_pid: Optional[int] = None
_last_process_pausing_activity_ts: float = 0.0


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
    global \
        _suspended_pids, \
        _overlay_pause_request_pid, \
        _last_process_pausing_activity_ts
    try:
        pids_file = _get_suspended_pids_file()
        if pids_file.exists():
            with open(pids_file, "r") as f:
                data = json.load(f)
                # Resume any processes that were left suspended (only if PID matches creation time)
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
                        logger.warning(
                            f"Skipping resume for PID {pid}: missing creation time (legacy entry)."
                        )
                        continue

                    if not _process_matches_record(pid, record):
                        logger.warning(
                            f"Skipping resume for PID {pid}: process does not match recorded info."
                        )
                        continue

                    if _resume_process(pid):
                        logger.info(
                            f"Resumed orphaned suspended process PID {pid} from previous session."
                        )
                    else:
                        logger.debug(
                            f"Could not resume PID {pid} (may have already terminated)."
                        )
            # Clear the file after cleanup
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

    This is intentionally not feature-gated so recovery can still work even if
    the user disabled process pausing after suspending a process.
    """
    global \
        _suspended_pids, \
        _overlay_pause_request_pid, \
        _last_process_pausing_activity_ts

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
        logger.debug(
            f"Error reading suspended PID persistence during force resume: {e}"
        )

    result["total_candidates"] = len(records_by_pid)

    if result["total_candidates"] > 0:
        logger.info(
            f"Force-resuming {result['total_candidates']} suspended process(es)."
        )

    for pid, record in records_by_pid.items():
        if not record or "created" not in record:
            logger.warning(
                f"Skipping resume for PID {pid}: missing creation time (legacy entry)."
            )
            result["legacy_missing_created"] += 1
            continue

        if not _process_matches_record(pid, record):
            logger.warning(
                f"Skipping resume for PID {pid}: process does not match recorded info."
            )
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


def set_window_state_monitor(monitor: Optional["WindowStateMonitor"]) -> None:
    global _window_state_monitor
    _window_state_monitor = monitor


def get_window_state_monitor() -> Optional["WindowStateMonitor"]:
    return _window_state_monitor


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


def _resolve_pause_target_pid(
    hwnd: Optional[int], context: str, log_on_missing: bool = True
) -> int:
    resolved_hwnd = _resolve_pause_target_hwnd(hwnd)
    if not resolved_hwnd:
        if log_on_missing:
            logger.warning(f"{context}: no active window detected.")
        return 0

    pid = _get_pid_for_hwnd(resolved_hwnd)
    if pid <= 0:
        if log_on_missing:
            logger.warning(f"{context}: failed to resolve PID.")
        return 0

    if pid == os.getpid():
        if log_on_missing:
            logger.warning(f"{context}: refusing to suspend GSM itself.")
        return 0
    return pid


def _get_pid_for_hwnd(hwnd: int) -> int:
    if not is_windows() or not user32:
        return 0
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def _get_process_creation_time(pid: int) -> Optional[int]:
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
    if not is_windows() or not kernel32 or not psapi:
        return ""
    h_process = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid
    )
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
    exe = os.path.basename(entry).lower()
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


def _get_process_exe_name(pid: int) -> str:
    path = _get_process_exe_path(pid)
    return os.path.basename(path) if path else ""


def _get_auto_resume_delay() -> float:
    master = get_master_config()
    process_cfg = getattr(master, "process_pausing", None) if master else None
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


def _suspend_process(pid: int) -> bool:
    if not is_windows() or not kernel32 or not ntdll:
        return False
    h_process = kernel32.OpenProcess(
        PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION, False, pid
    )
    if not h_process:
        return False
    try:
        status = ntdll.NtSuspendProcess(h_process)
        return status == 0
    finally:
        kernel32.CloseHandle(h_process)


def _resume_process(pid: int) -> bool:
    if not is_windows() or not kernel32 or not ntdll:
        return False
    h_process = kernel32.OpenProcess(
        PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION, False, pid
    )
    if not h_process:
        return False
    try:
        status = ntdll.NtResumeProcess(h_process)
        nt_resume_succeeded = status == 0
    finally:
        kernel32.CloseHandle(h_process)

    total_threads, forced_resume_calls, failed_threads = _force_resume_process_threads(
        pid
    )
    if failed_threads:
        logger.debug(
            f"Resume process PID {pid}: thread force-resume encountered {failed_threads} inaccessible thread(s)."
        )

    if nt_resume_succeeded:
        return True

    # Fallback success: if we could inspect at least one thread and none failed,
    # treat the force-resume pass as authoritative even if NtResumeProcess failed.
    if total_threads > 0 and failed_threads == 0:
        if forced_resume_calls > 0:
            logger.debug(
                f"Resume process PID {pid}: recovered via thread force-resume after NtResumeProcess failure."
            )
        return True

    return False


def _force_resume_process_threads(
    pid: int, max_resume_attempts: int = 64
) -> Tuple[int, int, int]:
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
                            previous_suspend_count = int(
                                kernel32.ResumeThread(h_thread)
                            )
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
            has_entry = bool(
                kernel32.Thread32Next(snapshot, ctypes.byref(thread_entry))
            )
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
        # Only trust cached target info when it was resolved for the current scene.
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


def _is_pid_allowed_to_suspend(pid: int) -> bool:
    master = get_master_config()
    process_cfg = getattr(master, "process_pausing", None) if master else None
    if not process_cfg:
        logger.warning("Process pausing config missing; refusing to suspend.")
        return False

    exe_name = _get_process_exe_name(pid)
    if not exe_name:
        logger.warning("Pause hotkey: failed to resolve process exe name.")
        return False

    deny_set = _build_exe_name_set(list(getattr(process_cfg, "denylist", []) or []))
    if _exe_name_matches_set(exe_name, deny_set):
        logger.warning(f"Pause hotkey: {exe_name} is denylisted.")
        return False

    allow_set = _build_exe_name_set(list(getattr(process_cfg, "allowlist", []) or []))
    if _exe_name_matches_set(exe_name, allow_set):
        return True

    if getattr(process_cfg, "require_game_exe_match", True):
        detected_game_exe = _get_detected_game_exe()
        if not detected_game_exe:
            logger.warning(
                "Pause hotkey: could not determine current game exe; refusing to suspend."
            )
            return False
        if (
            os.path.basename(exe_name).lower()
            != os.path.basename(detected_game_exe).lower()
        ):
            logger.warning(
                f"Pause hotkey: exe '{exe_name}' does not match detected game exe '{detected_game_exe}'."
            )
            return False

    return True


def _auto_resume_monitor():
    """Monitors suspended processes and auto-resumes after timeout."""
    while True:
        time.sleep(5.0)  # Check every 5 seconds

        with _suspended_pids_lock:
            if not _suspended_pids:
                continue
            items = list(_suspended_pids.items())

        current_time = time.time()
        pids_to_resume = []

        auto_resume_delay = _get_auto_resume_delay()
        for pid, info in items:
            with _suspended_pids_lock:
                overlay_holds_pause = _overlay_pause_request_pid == pid and bool(
                    _overlay_pause_request_sources
                )
            if overlay_holds_pause:
                continue
            suspended_at = info.get("suspended_at", 0)
            if current_time - suspended_at >= auto_resume_delay:
                pids_to_resume.append(pid)

        for pid in pids_to_resume:
            with _suspended_pids_lock:
                record = _suspended_pids.get(pid)
            if not record or not _process_matches_record(pid, record):
                logger.warning(
                    f"Auto-resume skipped for PID {pid}: process does not match recorded info."
                )
                with _suspended_pids_lock:
                    _suspended_pids.pop(pid, None)
                _save_suspended_pids()
                continue
            if _resume_process(pid):
                with _suspended_pids_lock:
                    _suspended_pids.pop(pid, None)
                _save_suspended_pids()
                _mark_process_pausing_activity()
                logger.info(
                    f"Auto-resumed process PID {pid} after {auto_resume_delay}s timeout."
                )
            else:
                logger.warning(f"Failed to auto-resume PID {pid}.")
                # Remove from tracking even if resume failed (process may have terminated)
                with _suspended_pids_lock:
                    _suspended_pids.pop(pid, None)
                _save_suspended_pids()


def _ensure_auto_resume_task():
    """Ensures the auto-resume monitoring thread is running."""
    global _auto_resume_thread

    if _auto_resume_thread is None or not _auto_resume_thread.is_alive():
        _auto_resume_thread = threading.Thread(
            target=_auto_resume_monitor, daemon=True, name="AutoResumeMonitor"
        )
        _auto_resume_thread.start()


def _resume_tracked_process(pid: int, context: str) -> bool:
    with _suspended_pids_lock:
        record = _suspended_pids.get(pid)

    if not record:
        logger.debug(f"{context}: PID {pid} is not tracked as suspended.")
        return False

    if not _process_matches_record(pid, record):
        logger.warning(
            f"{context}: PID {pid} does not match recorded process; clearing stale entry."
        )
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


def _suspend_process_with_tracking(pid: int, context: str) -> bool:
    if not _is_pid_allowed_to_suspend(pid):
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
        _ensure_auto_resume_task()  # Start monitoring task
        auto_resume_delay = _get_auto_resume_delay()
        logger.info(
            f"Suspended process PID {pid}. Will auto-resume in {auto_resume_delay}s."
        )
        return True

    logger.warning(f"{context}: failed to suspend PID {pid}.")
    return False


def _handle_overlay_pause_request(source: str, hwnd: Optional[int]) -> bool:
    global _overlay_pause_request_pid

    pid = _resolve_pause_target_pid(hwnd, "Overlay pause request")
    if pid <= 0:
        return False

    with _suspended_pids_lock:
        tracked_overlay_pid = _overlay_pause_request_pid
        source_already_registered = source in _overlay_pause_request_sources
        record = _suspended_pids.get(pid)

    if source_already_registered and tracked_overlay_pid == pid:
        logger.debug(
            f"Overlay pause request: source '{source}' already paused PID {pid}."
        )
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
        logger.info(
            f"Overlay pause request: source '{source}' linked to existing suspended PID {pid}."
        )
        return True

    if record and not _process_matches_record(pid, record):
        logger.warning(
            f"Overlay pause request: PID {pid} has stale tracking record; clearing."
        )
        with _suspended_pids_lock:
            _suspended_pids.pop(pid, None)
        _save_suspended_pids()

    if not _suspend_process_with_tracking(pid, "Overlay pause request"):
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
            f"Overlay resume request: source '{source}' released pause, "
            f"but still held by {sorted(remaining_sources)}."
        )
        return True

    pid_to_resume = tracked_overlay_pid
    if not pid_to_resume:
        candidate_pid = _resolve_pause_target_pid(
            hwnd, "Overlay resume request", log_on_missing=False
        )
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
@experimental_feature(default_return=False)
def request_overlay_process_pause(
    action: str, source: str = "overlay", hwnd: Optional[int] = None
) -> bool:
    if not is_windows() or not user32:
        logger.info("Overlay pause requests are only supported on Windows.")
        return False

    normalized_action = str(action or "").strip().lower()
    if normalized_action not in {"pause", "resume"}:
        logger.warning(f"Overlay pause request: unsupported action '{action}'.")
        return False

    normalized_source = _normalize_overlay_pause_source(source)
    if normalized_action == "pause":
        return _handle_overlay_pause_request(normalized_source, hwnd)
    return _handle_overlay_resume_request(normalized_source, hwnd)


@process_pausing_feature(default_return=False)
@experimental_feature(default_return=False)
def toggle_active_game_pause(hwnd: Optional[int] = None) -> bool:
    if not is_windows() or not user32:
        logger.info("Pause hotkey is only supported on Windows.")
        return False

    pid = _resolve_pause_target_pid(hwnd, "Pause hotkey")
    if pid <= 0:
        return False

    with _suspended_pids_lock:
        record = _suspended_pids.get(pid)

    if record:
        if _resume_tracked_process(pid, "Pause hotkey"):
            _clear_overlay_pause_request_state()
            return True

        # If the record still exists here, this was a true resume failure.
        with _suspended_pids_lock:
            if pid in _suspended_pids:
                return False

    if _suspend_process_with_tracking(pid, "Pause hotkey"):
        _clear_overlay_pause_request_state()
        return True

    return False


# --- Window State Monitor Class ---
class WindowStateMonitor:
    """
    Monitors the state of the target game window (Minimized, Active, Background)
    using OBS source info for robust matching.
    """

    def __init__(self, overlay_processor=None):
        self.overlay_processor = overlay_processor
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
        self.last_target_scene_name = None
        self.last_obs_dimensions_time = 0
        self.last_hwnd_refresh_time = 0
        self.last_monitor_layout_signature: Optional[
            Tuple[Tuple[int, int, int, int], ...]
        ] = None
        self.last_monitor_validation_time = 0.0

        # Known browser window classes to completely exclude
        self.BROWSER_CLASSES = {
            "Chrome_WidgetWin_1",  # Chrome, Edge (Chromium), Brave, Opera, Vivaldi
            "Chrome_WidgetWin_0",
            "Chrome_WidgetWin_2",
            "MozillaWindowClass",  # Firefox
            "OpWindow",  # Pre-Chromium Opera
            "ApplicationFrameWindow",
        }

        self.BROWSER_EXES = {
            "chrome.exe",
            "msedge.exe",
            "brave.exe",
            "opera.exe",
            "vivaldi.exe",  # Chromium-based browsers
            "chromium.exe",
            "arc.exe",
            "thorium.exe",
            "whale.exe",
            "yandex.exe",  # More Chromium-based
            "firefox.exe",
            "zen.exe",
            "waterfox.exe",
            "librewolf.exe",
            "floorp.exe",  # Firefox-based
            "palemoon.exe",
            "torbrowser.exe",  # Firefox forks
        }

        self.EXCLUDED_EXES = {
            "ocenaudio.exe",
        }

    def _get_window_exe_name(self, hwnd) -> str:
        """Helper to get the .exe name from an HWND."""
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

        h_process = kernel32.OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid
        )
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

            h_process = kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid
            )
            if not h_process:
                return 0

            try:
                mem_counters = PROCESS_MEMORY_COUNTERS()
                mem_counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)

                if psapi.GetProcessMemoryInfo(
                    h_process, ctypes.byref(mem_counters), mem_counters.cb
                ):
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
            if (
                "NVIDIA GeForce Overlay" in title
                or "nvidia geforce overlay" in title.lower()
            ):
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
                    if any(
                        name in exe_lower
                        for name in [
                            "discord.exe",
                            "code.exe",
                            "code - insiders.exe",  # VS Code
                            "slack.exe",
                            "teams.exe",
                            "spotify.exe",
                            "cursor.exe",  # Cursor IDE
                            "windsurf.exe",  # Windsurf IDE
                        ]
                    ):
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
            return (
                class_name in self.BROWSER_CLASSES
                and self._get_window_exe_name(hwnd).lower() in self.BROWSER_EXES
            )
        except Exception:
            return False

    def _is_browser_class(self, hwnd) -> bool:
        """Check if the given HWND has a class name associated with browsers."""
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
            target_rect = get_window_rect_physical(hwnd)
            if not target_rect:
                return False

            target_left, target_top, target_right, target_bottom = target_rect
            target_width = target_right - target_left
            target_height = target_bottom - target_top

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
                        overlap_left, overlap_top, overlap_right, overlap_bottom = (
                            overlapping_rect
                        )
                        # Check if overlapping window covers the padded target area
                        if (
                            overlap_left <= padded_target_left
                            and overlap_top <= padded_target_top
                            and overlap_right >= padded_target_right
                            and overlap_bottom >= padded_target_bottom
                        ):
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
            window_rect = get_window_rect_physical(hwnd)
            if not window_rect:
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
            window_left, window_top, window_right, window_bottom = window_rect
            window_width = window_right - window_left
            window_height = window_bottom - window_top
            monitor_width = mon_rect.right - mon_rect.left
            monitor_height = mon_rect.bottom - mon_rect.top

            # Allow small tolerance (1-2 pixels) for matching
            matches_monitor = (
                abs(window_rect.left - mon_rect.left) <= 2
                and abs(window_rect.top - mon_rect.top) <= 2
                and abs(window_width - monitor_width) <= 2
                and abs(window_height - monitor_height) <= 2
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
        if self.last_target_info and not self._is_browser_class(hwnd):
            tgt_class = self.last_target_info.get("window_class")
            if tgt_class:
                window_class = self._get_window_class(hwnd)
                if window_class and window_class.lower() == tgt_class.lower():
                    self.found_hwnds.append(hwnd)
                    return True

        # Fallback 1: match on exe name
        if self.last_target_info:
            tgt_exe = self.last_target_info.get("exe")
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

        self.last_target_info = window_info if window_info else {}
        self.last_target_scene_name = get_current_scene()
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
                monitors = sct.monitors[1:]  # Skip the "all in one" monitor 0
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

                if best_monitor_idx != -1:
                    return best_monitor_idx

                # If the window is currently outside visible monitor bounds (e.g., disconnected display),
                # snap to the nearest monitor by distance to avoid leaving capture monitor unresolved.
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
        if clamped_index == configured_index:
            return False

        logger.warning(
            f"Configured capture monitor index {configured_index} is unavailable. "
            f"Falling back to monitor {clamped_index + 1} of {len(monitor_signature)}."
        )
        overlay_cfg.monitor_to_capture = clamped_index
        try:
            get_master_config().save()
        except Exception as e:
            logger.debug(f"Failed to persist fallback capture monitor index: {e}")
        return True

    def _check_monitor_topology_changes(self) -> bool:
        monitor_signature = self._get_monitor_layout_signature()
        if not monitor_signature:
            return False

        monitor_selection_changed = self._validate_capture_monitor_selection(
            monitor_signature
        )

        if self.last_monitor_layout_signature is None:
            self.last_monitor_layout_signature = monitor_signature
            return monitor_selection_changed

        topology_changed = monitor_signature != self.last_monitor_layout_signature
        if topology_changed:
            old_count = len(self.last_monitor_layout_signature)
            new_count = len(monitor_signature)
            logger.info(
                f"Monitor topology changed ({old_count} -> {new_count} display(s)). "
                "Refreshing overlay geometry."
            )
            self.last_monitor_layout_signature = monitor_signature

        if (topology_changed or monitor_selection_changed) and self.overlay_processor:
            self.overlay_processor.obs_width = None
            self.overlay_processor.obs_height = None
            self.last_obs_dimensions_time = 0
            self.window_stable_count = 0
            self.poll_interval = self.fast_poll_interval

        return topology_changed or monitor_selection_changed

    async def check_and_send(self):
        """Checks window state and broadcasts if changed."""
        if not is_windows():
            return

        now = time.time()
        monitor_topology_changed = False
        if now - self.last_monitor_validation_time > 1.0:
            self.last_monitor_validation_time = now
            monitor_topology_changed = self._check_monitor_topology_changes()

        scene_changed = False
        if now - self.last_obs_check_time > 2.0:  # Check every 2 seconds
            self.last_obs_check_time = now
            try:
                current_scene = get_current_scene()
                if current_scene != self.last_scene_name:
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
                    scene_changed = True
                    self.last_scene_name = current_scene

                new_info = get_window_info_from_source(scene_name=current_scene)

                if new_info and self.last_target_info:
                    if (
                        new_info.get("title") != self.last_target_info.get("title")
                        or new_info.get("window_class")
                        != self.last_target_info.get("window_class")
                        or new_info.get("exe") != self.last_target_info.get("exe")
                    ):
                        logger.info(
                            f"OBS Source changed from '{self.last_target_info.get('title')}' to '{new_info.get('title')}' - Resetting target."
                        )
                        self.target_hwnd = None
                        self.retry_find_count = 0
                        self.last_target_info = {}
                        self.last_target_scene_name = None
                        self.overlay_processor.obs_width = None
                        self.overlay_processor.obs_height = None
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
            current_rect = get_window_rect_physical(self.target_hwnd)

        window_moved_or_resized = current_rect != self.last_window_rect
        if window_moved_or_resized:
            if self.last_window_rect is not None and current_rect is not None:
                logger.debug(
                    f"Target window moved or resized: {self.last_window_rect} -> {current_rect}"
                )
            self.window_stable_count = 0
            self.poll_interval = self.fast_poll_interval
            # Reset OBS dimensions on window size/position change
            self.overlay_processor.obs_width = None
            self.overlay_processor.obs_height = None
        else:
            self.window_stable_count += 1
            if self.window_stable_count > 0 and self.window_stable_count <= len(
                self.backoff_steps
            ):
                self.poll_interval = self.backoff_steps[self.window_stable_count - 1]
            elif self.window_stable_count > len(self.backoff_steps):
                self.poll_interval = self.base_poll_interval

            # Check for monitor change if window has been stable for a moment
            if current_rect and is_windows() and self.window_stable_count == 2:
                best_monitor = self._detect_current_monitor(current_rect)
                overlay_cfg = get_overlay_config()
                if (
                    best_monitor != -1
                    and overlay_cfg.monitor_to_capture != best_monitor
                ):
                    logger.info(
                        f"Window moved to Monitor {best_monitor + 1}. Updating config."
                    )
                    overlay_cfg.monitor_to_capture = best_monitor
                    get_master_config().save()
                    asyncio.create_task(
                        self.overlay_processor.reprocess_and_send_last_results()
                    )

        # Update Magpie info
        self.update_magpie_info()
        magpie_changed = self.magpie_info != self.last_magpie_info
        magpie_active = bool(self.magpie_info)

        game_name_ref = self.last_target_info.get("title", self.last_game_name)

        fullscreen_changed = is_fullscreen != self.last_is_fullscreen

        if current_state != self.last_state or magpie_changed or fullscreen_changed:
            logger.debug(
                f"Window state changed: {self.last_state} -> {current_state} (game: {game_name_ref}, fullscreen: {is_fullscreen})"
            )
            self.last_state = current_state
            self.last_is_fullscreen = is_fullscreen

            # Determine if we should recommend manual mode
            # Recommend when: fullscreen detected AND overlay config shows manual mode is OFF
            overlay_cfg = get_overlay_config()
            recommend_manual = is_fullscreen and current_state in [
                "active",
                "background",
            ]

            payload = {
                "type": "window_state",
                "data": current_state,
                "game": game_name_ref,
                "magpie_info": self.magpie_info,
                "is_fullscreen": is_fullscreen,
                "recommend_manual_mode": recommend_manual,
            }

            if websocket_manager.has_clients(ID_OVERLAY):
                await websocket_manager.send(ID_OVERLAY, json.dumps(payload))

        # Always update last_magpie_info after checking for changes to prevent stale state
        self.last_magpie_info = (
            copy.deepcopy(self.magpie_info) if self.magpie_info else None
        )

        # Check for stale OBS dimensions (reset every 60 seconds)
        if (
            self.overlay_processor.obs_width is not None
            and self.overlay_processor.obs_height is not None
        ):
            if now - self.last_obs_dimensions_time > 60.0:
                logger.debug(
                    "OBS dimensions are stale (>60s), resetting for next capture"
                )
                self.overlay_processor.obs_width = None
                self.overlay_processor.obs_height = None
                self.last_obs_dimensions_time = now

        # Smart Update
        if (
            magpie_changed
            or window_moved_or_resized
            or scene_changed
            or monitor_topology_changed
        ):
            if current_state not in ["minimized", "closed"]:
                logger.background(
                    "Window geometry, monitor topology, Magpie, or scene changed - reprocessing last OCR result"
                )
                asyncio.create_task(
                    self.overlay_processor.reprocess_and_send_last_results()
                )
            self.poll_interval = self.base_poll_interval
        else:
            self.poll_interval = min(self.max_poll_interval, self.poll_interval + 0.05)

        self.last_window_rect = current_rect

    async def activate_target_window(self) -> bool:
        """
        More aggressively activates the target game window on Windows.
        Runs multiple activation attempts because overlay teardown can race focus handoff.
        """
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
            if self._set_foreground_aggressive(
                self.target_hwnd, attempt_number=attempt_number
            ):
                return True

        logger.debug(
            f"Failed to activate target window after {len(attempt_delays)} aggressive attempts"
        )
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

        lparam_down = 0x001C0001  # VK_RETURN scan code (0x1C), keydown
        lparam_up = 0xC01C0001  # keyup flags
        down_ok = bool(user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, lparam_down))
        up_ok = bool(user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, lparam_up))
        return down_ok and up_ok

    def _send_enter_with_sendinput(self) -> bool:
        if not is_windows():
            return False

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
        inputs[0].union.ki = KEYBDINPUT(VK_RETURN, 0, 0, 0, 0)
        inputs[1].type = INPUT_KEYBOARD
        inputs[1].union.ki = KEYBDINPUT(VK_RETURN, 0, KEYEVENTF_KEYUP, 0, 0)

        sent = int(user32.SendInput(2, inputs, ctypes.sizeof(INPUT)))
        return sent == 2

    def _send_enter_with_keybd_event(self) -> bool:
        if not is_windows():
            return False

        try:
            # VK_RETURN scan code: 0x1C
            user32.keybd_event(VK_RETURN, 0x1C, 0, 0)
            time.sleep(0.01)
            user32.keybd_event(VK_RETURN, 0x1C, KEYEVENTF_KEYUP, 0)
            return True
        except Exception:
            return False

    def _resolve_target_hwnd(self, target_pid: Optional[int] = None) -> Optional[int]:
        hwnd = self.target_hwnd
        requested_pid = int(target_pid or 0)

        if requested_pid <= 0:
            return hwnd

        if hwnd and _get_pid_for_hwnd(hwnd) == requested_pid:
            return hwnd

        pid_hwnd = self._resolve_hwnd_for_pid(requested_pid)
        if not pid_hwnd:
            # If explicit PID lookup fails, keep using the tracked target window.
            # Overlay callers may provide stale diagnostic PIDs.
            return hwnd

        self.target_hwnd = pid_hwnd
        return pid_hwnd

    def _send_alt_key_tap(self) -> bool:
        if not is_windows():
            return False

        try:
            # ALT key tap can satisfy foreground activation restrictions on Windows.
            user32.keybd_event(VK_MENU, 0x38, KEYEVENTF_EXTENDEDKEY, 0)
            time.sleep(0.01)
            user32.keybd_event(
                VK_MENU, 0x38, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0
            )
            return True
        except Exception:
            return False

    def _set_foreground_aggressive(self, hwnd: int, attempt_number: int = 1) -> bool:
        if not is_windows() or not hwnd:
            return False

        try:
            if int(user32.GetForegroundWindow() or 0) == int(hwnd):
                return True

            fg_hwnd = int(user32.GetForegroundWindow() or 0)
            current_tid = int(kernel32.GetCurrentThreadId())
            fg_tid = (
                int(user32.GetWindowThreadProcessId(fg_hwnd, None)) if fg_hwnd else 0
            )
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
                    logger.debug(
                        f"Target window minimized, restoring (attempt {attempt_number})"
                    )
                    user32.ShowWindow(hwnd, SW_RESTORE)
                else:
                    user32.ShowWindow(hwnd, SW_SHOW)
                user32.BringWindowToTop(hwnd)
                if toggle_topmost:
                    user32.SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                    )
                    user32.SetWindowPos(
                        hwnd,
                        HWND_NOTOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                    )

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
                user32.SystemParametersInfoW(
                    SPI_GETFOREGROUNDLOCKTIMEOUT,
                    0,
                    ctypes.byref(old_timeout),
                    0,
                )
                if user32.SystemParametersInfoW(
                    SPI_SETFOREGROUNDLOCKTIMEOUT,
                    0,
                    ctypes.c_void_p(0),
                    SPIF_SENDCHANGE,
                ):
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

            logger.debug(
                f"SetForegroundWindow fallback path engaged (attempt {attempt_number})"
            )

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
            logger.exception(
                f"Error aggressively activating target window (attempt {attempt_number}): {e}"
            )
            return False
        finally:
            if "timeout_changed" in locals() and timeout_changed:
                try:
                    user32.SystemParametersInfoW(
                        SPI_SETFOREGROUNDLOCKTIMEOUT,
                        0,
                        ctypes.c_void_p(int(old_timeout.value)),
                        SPIF_SENDCHANGE,
                    )
                except Exception:
                    pass
            if "attached_pairs" in locals():
                for a, b in reversed(attached_pairs):
                    try:
                        user32.AttachThreadInput(a, b, False)
                    except Exception:
                        pass

    async def send_enter_to_target_window(
        self, target_pid: Optional[int] = None, activate_window: bool = True
    ) -> bool:
        if not is_windows():
            return False

        requested_pid = int(target_pid or 0)
        target_hwnd = self._resolve_target_hwnd(requested_pid)

        if not target_hwnd:
            return False

        self.target_hwnd = target_hwnd

        if activate_window:
            # Match proven probe behavior: focus target first, then inject Enter via keybd_event.
            focused = self._set_foreground_aggressive(target_hwnd, attempt_number=1)
            if not focused:
                return False
            return self._send_enter_with_keybd_event()

        foreground_hwnd = user32.GetForegroundWindow()
        if foreground_hwnd == target_hwnd:
            return self._send_enter_with_keybd_event()
        return self._post_enter_to_hwnd(target_hwnd)

    def post_enter_to_target_window(self, target_pid: Optional[int] = None) -> bool:
        """
        Backward-compatible direct PostMessage path.
        """
        if not is_windows():
            return False

        hwnd = self._resolve_target_hwnd(target_pid)

        if not hwnd:
            return False

        return self._post_enter_to_hwnd(hwnd)
