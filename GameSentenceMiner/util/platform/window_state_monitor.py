"""
Compatibility shim — re-exports everything from base_window_monitor and provides a
platform-appropriate WindowStateMonitor alias.

All module-level functions (process pausing, window geometry helpers, etc.) and
constants defined in base_window_monitor are accessible via this module so that
existing import sites need no changes.
"""

from .base_window_monitor import *  # noqa: F401, F403
from .base_window_monitor import (  # noqa: F401
    _load_suspended_pids,
    _get_pid_for_hwnd,
    _exe_names_match,
    _exe_name_matches_set,
    _is_tracked_suspended_pid,
)

from GameSentenceMiner.util.config.configuration import is_windows, is_linux

if is_windows():
    from .windows_window_monitor import WindowsWindowStateMonitor as WindowStateMonitor  # noqa: F401
elif is_linux():
    from .linux_window_monitor import LinuxWindowStateMonitor as WindowStateMonitor  # noqa: F401
else:
    from .base_window_monitor import BaseWindowStateMonitor as WindowStateMonitor  # noqa: F401
