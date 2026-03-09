from __future__ import annotations

import contextlib
import ctypes
import os
import threading
from ctypes import wintypes
from typing import Iterator

_IS_WINDOWS = os.name == "nt"
_PROCESS_PER_MONITOR_DPI_AWARE = 2
_E_ACCESSDENIED = 0x80070005

if _IS_WINDOWS:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    try:
        shcore = ctypes.WinDLL("shcore", use_last_error=True)
    except OSError:
        shcore = None

    _DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)

    if hasattr(user32, "SetProcessDpiAwarenessContext"):
        user32.SetProcessDpiAwarenessContext.argtypes = [wintypes.HANDLE]
        user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL

    if hasattr(user32, "SetThreadDpiAwarenessContext"):
        user32.SetThreadDpiAwarenessContext.argtypes = [wintypes.HANDLE]
        user32.SetThreadDpiAwarenessContext.restype = wintypes.HANDLE

    if shcore and hasattr(shcore, "SetProcessDpiAwareness"):
        shcore.SetProcessDpiAwareness.argtypes = [ctypes.c_int]
        shcore.SetProcessDpiAwareness.restype = ctypes.c_long

    if hasattr(user32, "SetProcessDPIAware"):
        user32.SetProcessDPIAware.argtypes = []
        user32.SetProcessDPIAware.restype = wintypes.BOOL
else:
    user32 = None
    shcore = None
    _DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = None

_dpi_lock = threading.Lock()
_process_dpi_initialized = False
_process_dpi_enabled = False


def _try_set_process_dpi_awareness_context() -> bool:
    if not _IS_WINDOWS or not user32 or not hasattr(user32, "SetProcessDpiAwarenessContext"):
        return False

    ctypes.set_last_error(0)
    if user32.SetProcessDpiAwarenessContext(_DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2):
        return True

    return ctypes.get_last_error() == 5


def _try_set_process_dpi_awareness() -> bool:
    if not _IS_WINDOWS or not shcore or not hasattr(shcore, "SetProcessDpiAwareness"):
        return False

    result = int(shcore.SetProcessDpiAwareness(_PROCESS_PER_MONITOR_DPI_AWARE))
    return result in (0, _E_ACCESSDENIED)


def _try_set_process_dpi_aware() -> bool:
    if not _IS_WINDOWS or not user32 or not hasattr(user32, "SetProcessDPIAware"):
        return False

    ctypes.set_last_error(0)
    if user32.SetProcessDPIAware():
        return True

    return ctypes.get_last_error() == 5


def enable_per_monitor_v2_dpi_awareness() -> bool:
    """Best-effort Windows DPI initialization with stable fallbacks."""
    global _process_dpi_initialized, _process_dpi_enabled

    if not _IS_WINDOWS:
        return False

    with _dpi_lock:
        if _process_dpi_initialized:
            return _process_dpi_enabled

        _process_dpi_enabled = (
            _try_set_process_dpi_awareness_context()
            or _try_set_process_dpi_awareness()
            or _try_set_process_dpi_aware()
        )
        _process_dpi_initialized = True
        return _process_dpi_enabled


@contextlib.contextmanager
def per_monitor_v2_dpi_context() -> Iterator[None]:
    """Temporarily forces the current thread into per-monitor-v2 DPI space."""
    enable_per_monitor_v2_dpi_awareness()

    if not _IS_WINDOWS or not user32 or not hasattr(user32, "SetThreadDpiAwarenessContext"):
        yield
        return

    ctypes.set_last_error(0)
    previous = user32.SetThreadDpiAwarenessContext(_DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
    if not previous:
        yield
        return

    try:
        yield
    finally:
        user32.SetThreadDpiAwarenessContext(previous)
