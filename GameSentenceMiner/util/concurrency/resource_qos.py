"""Best-effort OS scheduling isolation for latency and background lanes.

Queues and actors prevent lock contention, but threads still share the Python GIL
and the operating system's CPU scheduler.  GSM therefore reserves a small CPU
set for latency-sensitive text/transport threads on machines with at least four
logical CPUs and keeps managed background work off that set.  Heavy scheduled
work also calls :func:`configure_background_process` from a separate process,
which gives it a separate GIL.

Every operation is deliberately best-effort.  Unsupported platforms and process
managers with restricted affinity simply retain the platform defaults.
"""

from __future__ import annotations

import os
import sys
import threading
from enum import Enum
from functools import lru_cache
from typing import Iterable


RESPONSIVE_GIL_INTERVAL_SECONDS = 0.001
MIN_CPUS_FOR_AFFINITY_ISOLATION = 4


class ExecutionClass(Enum):
    NORMAL = "normal"
    LATENCY = "latency"
    INTERACTIVE = "interactive"
    BACKGROUND = "background"


def enable_responsive_gil() -> None:
    """Bound how long ordinary Python background code can retain the GIL."""
    try:
        if sys.getswitchinterval() > RESPONSIVE_GIL_INTERVAL_SECONDS:
            sys.setswitchinterval(RESPONSIVE_GIL_INTERVAL_SECONDS)
    except (AttributeError, ValueError):
        pass


def partition_cpu_sets(allowed_cpus: Iterable[int]) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Return ``(latency, background)`` CPU sets without ever starving either lane."""
    cpus = tuple(sorted({int(cpu) for cpu in allowed_cpus if int(cpu) >= 0}))
    if len(cpus) < MIN_CPUS_FOR_AFFINITY_ISOLATION:
        return cpus, cpus
    reserved_count = 2 if len(cpus) >= 8 else 1
    return cpus[-reserved_count:], cpus[:-reserved_count]


@lru_cache(maxsize=1)
def current_cpu_partition() -> tuple[tuple[int, ...], tuple[int, ...]]:
    try:
        import psutil

        allowed = psutil.Process().cpu_affinity()
    except (AttributeError, OSError, RuntimeError, ImportError):
        allowed = list(range(os.cpu_count() or 1))
    return partition_cpu_sets(allowed)


def configure_current_thread(execution_class: ExecutionClass) -> None:
    """Apply priority and affinity to the calling managed thread."""
    if execution_class is ExecutionClass.NORMAL:
        return
    enable_responsive_gil()
    latency_cpus, background_cpus = current_cpu_partition()
    cpus = latency_cpus if execution_class is ExecutionClass.LATENCY else background_cpus
    _set_current_thread_affinity(cpus)
    _set_current_thread_priority(execution_class)


def configure_background_process() -> None:
    """Keep a spawned background worker below and away from the latency lane."""
    enable_responsive_gil()
    _latency_cpus, background_cpus = current_cpu_partition()
    try:
        import psutil

        process = psutil.Process()
        if background_cpus:
            process.cpu_affinity(list(background_cpus))
        if os.name == "nt":
            process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        else:
            # Raising niceness is permitted for an unprivileged process.
            process.nice(max(10, int(process.nice())))
    except (AttributeError, OSError, RuntimeError, ImportError):
        pass


def _set_current_thread_affinity(cpus: tuple[int, ...]) -> None:
    if not cpus:
        return
    try:
        if os.name == "nt":
            # SetThreadAffinityMask addresses the current processor group. GSM's
            # common Windows targets are below the 64-logical-CPU group boundary.
            mask = sum(1 << cpu for cpu in cpus if cpu < 64)
            if not mask:
                return
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentThread.restype = wintypes.HANDLE
            kernel32.SetThreadAffinityMask.argtypes = (wintypes.HANDLE, ctypes.c_size_t)
            kernel32.SetThreadAffinityMask.restype = ctypes.c_size_t
            kernel32.SetThreadAffinityMask(kernel32.GetCurrentThread(), mask)
        elif hasattr(os, "sched_setaffinity"):
            os.sched_setaffinity(threading.get_native_id(), set(cpus))
    except (AttributeError, OSError, RuntimeError, ValueError):
        pass


def _set_current_thread_priority(execution_class: ExecutionClass) -> None:
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            # Interactive OCR gets normal priority on non-reserved CPUs. Text
            # transport remains above normal; managed helpers remain below it.
            if execution_class is ExecutionClass.LATENCY:
                priority = 1
            elif execution_class is ExecutionClass.INTERACTIVE:
                priority = 0
            else:
                priority = -1
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentThread.restype = wintypes.HANDLE
            kernel32.SetThreadPriority.argtypes = (wintypes.HANDLE, ctypes.c_int)
            kernel32.SetThreadPriority.restype = wintypes.BOOL
            kernel32.SetThreadPriority(kernel32.GetCurrentThread(), priority)
        elif execution_class is ExecutionClass.BACKGROUND and hasattr(os, "setpriority"):
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)
    except (AttributeError, OSError, RuntimeError, ValueError):
        pass
