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

from GameSentenceMiner.obs import get_window_info_from_source, get_current_scene, get_current_game
from GameSentenceMiner.util.config.configuration import get_app_directory, get_overlay_config, get_master_config, \
    is_windows, logger
from GameSentenceMiner.util.config.feature_flags import experimental_feature, process_pausing_feature
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
    kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL

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
    
    class THREADENTRY32(ctypes.Structure):
        _fields_ = [
            ('dwSize', wintypes.DWORD),
            ('cntUsage', wintypes.DWORD),
            ('th32ThreadID', wintypes.DWORD),
            ('th32OwnerProcessID', wintypes.DWORD),
            ('tpBasePri', wintypes.LONG),
            ('tpDeltaPri', wintypes.LONG),
            ('dwFlags', wintypes.DWORD)
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
_suspended_pids: Dict[int, Dict[str, Any]] = {}  # pid -> {'suspended_at': float, 'created': int, 'exe': str}
_suspended_pids_lock = threading.RLock()
_auto_resume_thread: Optional[threading.Thread] = None
_suspended_pids_file: Optional[Path] = None
_overlay_pause_request_sources: Set[str] = set()
_overlay_pause_request_pid: Optional[int] = None
_last_process_pausing_activity_ts: float = 0.0


@process_pausing_feature()
def _get_suspended_pids_file() -> Path:
    """Get the path to the suspended PIDs persistence file."""
    global _suspended_pids_file
    if _suspended_pids_file is None:
        _suspended_pids_file = Path(get_app_directory()) / "suspended_pids.json"
    return _suspended_pids_file

@process_pausing_feature()
def _load_suspended_pids():
    """Load suspended PIDs from disk and resume any orphaned processes."""
    global _suspended_pids, _overlay_pause_request_pid, _last_process_pausing_activity_ts
    try:
        pids_file = _get_suspended_pids_file()
        if pids_file.exists():
            with open(pids_file, 'r') as f:
                data = json.load(f)
                # Resume any processes that were left suspended (only if PID matches creation time)
                for entry in data.get('pids', []):
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
            entries = [
                {"pid": pid, **info}
                for pid, info in _suspended_pids.items()
            ]
        pids_file = _get_suspended_pids_file()
        pids_file.parent.mkdir(parents=True, exist_ok=True)
        with open(pids_file, 'w') as f:
            json.dump({'pids': entries}, f)
    except Exception as e:
        logger.debug(f"Error saving suspended PIDs: {e}")

@process_pausing_feature()
def cleanup_suspended_processes():
    """Resume all currently suspended processes and clear persistence file. Call during app shutdown."""
    global _suspended_pids, _overlay_pause_request_pid, _last_process_pausing_activity_ts
    try:
        with _suspended_pids_lock:
            pids_to_resume = list(_suspended_pids.keys())
        if pids_to_resume:
            logger.info(f"Resuming {len(pids_to_resume)} suspended process(es) during shutdown...")
            for pid in pids_to_resume:
                with _suspended_pids_lock:
                    record = _suspended_pids.get(pid)
                if record and not _process_matches_record(pid, record):
                    logger.warning(f"Skipping resume for PID {pid}: process does not match recorded info.")
                    continue
                if _resume_process(pid):
                    logger.info(f"Resumed suspended process PID {pid}")
                else:
                    logger.warning(f"Failed to resume PID {pid} (may have already terminated)")
            with _suspended_pids_lock:
                _suspended_pids.clear()
                _overlay_pause_request_sources.clear()
                _overlay_pause_request_pid = None
                _last_process_pausing_activity_ts = 0.0
        else:
            with _suspended_pids_lock:
                _overlay_pause_request_sources.clear()
                _overlay_pause_request_pid = None
                _last_process_pausing_activity_ts = 0.0
        
        # Clear the persistence file
        pids_file = _get_suspended_pids_file()
        if pids_file.exists():
            pids_file.unlink()
            logger.debug("Cleared suspended PIDs persistence file")
    except Exception as e:
        logger.error(f"Error during suspended process cleanup: {e}")


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


def _resolve_pause_target_pid(hwnd: Optional[int], context: str, log_on_missing: bool = True) -> int:
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
    h_process = kernel32.OpenProcess(PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
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
    h_process = kernel32.OpenProcess(PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h_process:
        return False
    try:
        status = ntdll.NtResumeProcess(h_process)
        return status == 0
    finally:
        kernel32.CloseHandle(h_process)

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
            logger.warning("Pause hotkey: could not determine current game exe; refusing to suspend.")
            return False
        if os.path.basename(exe_name).lower() != os.path.basename(detected_game_exe).lower():
            logger.warning(f"Pause hotkey: exe '{exe_name}' does not match detected game exe '{detected_game_exe}'.")
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
                overlay_holds_pause = (
                    _overlay_pause_request_pid == pid and bool(_overlay_pause_request_sources)
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
                # Remove from tracking even if resume failed (process may have terminated)
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
        logger.info(f"Suspended process PID {pid}. Will auto-resume in {auto_resume_delay}s.")
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
        candidate_pid = _resolve_pause_target_pid(hwnd, "Overlay resume request", log_on_missing=False)
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
def request_overlay_process_pause(action: str, source: str = "overlay", hwnd: Optional[int] = None) -> bool:
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
                    if (new_info.get('title') != self.last_target_info.get('title') or 
                        new_info.get('window_class') != self.last_target_info.get('window_class') or
                        new_info.get('exe') != self.last_target_info.get('exe')):
                        logger.info(f"OBS Source changed from '{self.last_target_info.get('title')}' to '{new_info.get('title')}' - Resetting target.")
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
            self.overlay_processor.obs_width = None
            self.overlay_processor.obs_height = None
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
                        self.overlay_processor.reprocess_and_send_last_results()
                    )

        # Update Magpie info
        self.update_magpie_info()
        magpie_changed = self.magpie_info != self.last_magpie_info
        magpie_active = bool(self.magpie_info)


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
        if self.overlay_processor.obs_width is not None and self.overlay_processor.obs_height is not None:
            if now - self.last_obs_dimensions_time > 60.0:
                logger.debug("OBS dimensions are stale (>60s), resetting for next capture")
                self.overlay_processor.obs_width = None
                self.overlay_processor.obs_height = None
                self.last_obs_dimensions_time = now
        
        # Smart Update
        if (magpie_changed or window_moved_or_resized or scene_changed):
            if current_state not in ["minimized", "closed"]:
                logger.display("Window geometry, Magpie, or scene changed - reprocessing last OCR result")
                asyncio.create_task(
                    self.overlay_processor.reprocess_and_send_last_results()
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
