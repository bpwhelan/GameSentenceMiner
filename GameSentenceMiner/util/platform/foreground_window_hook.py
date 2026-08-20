from __future__ import annotations

import ctypes
import os
import queue
import threading
import time
from ctypes import wintypes
from pathlib import Path
from typing import Any, Callable, Optional

import psutil

EVENT_SYSTEM_FOREGROUND = 0x0003
EVENT_OBJECT_NAMECHANGE = 0x800C
WINEVENT_OUTOFCONTEXT = 0x0000
WINEVENT_SKIPOWNPROCESS = 0x0002
WM_QUIT = 0x0012
SW_RESTORE = 9

ForegroundSnapshotCallback = Callable[[dict[str, Any]], None]
StatusCallback = Callable[[str, str], None]

_WIN_EVENT_PROC_TYPE = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)(
    None,
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.HWND,
    wintypes.LONG,
    wintypes.LONG,
    wintypes.DWORD,
    wintypes.DWORD,
)


def _load_windows_libraries():
    if os.name != "nt":
        return None, None
    return ctypes.windll.user32, ctypes.windll.kernel32


def _configure_windows_api(user32, kernel32) -> None:
    """Set pointer-sized Win32 signatures when real ctypes DLLs are used."""

    try:
        user32.SetWinEventHook.argtypes = [
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
            _WIN_EVENT_PROC_TYPE,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.DWORD,
        ]
        user32.SetWinEventHook.restype = wintypes.HANDLE
        user32.UnhookWinEvent.argtypes = [wintypes.HANDLE]
        user32.UnhookWinEvent.restype = wintypes.BOOL
        user32.GetForegroundWindow.restype = wintypes.HWND
        user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.GetWindowTextW.restype = ctypes.c_int
        user32.GetWindowThreadProcessId.argtypes = [
            wintypes.HWND,
            ctypes.POINTER(wintypes.DWORD),
        ]
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        user32.PostThreadMessageW.argtypes = [
            wintypes.DWORD,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        ]
        user32.PostThreadMessageW.restype = wintypes.BOOL
        user32.IsWindow.argtypes = [wintypes.HWND]
        user32.IsWindow.restype = wintypes.BOOL
        user32.IsIconic.argtypes = [wintypes.HWND]
        user32.IsIconic.restype = wintypes.BOOL
        user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.ShowWindow.restype = wintypes.BOOL
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        user32.SetForegroundWindow.restype = wintypes.BOOL
        kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    except (AttributeError, TypeError):
        # Test doubles deliberately do not expose ctypes function metadata.
        pass


class ForegroundWindowHook:
    """Publish foreground HWND/title changes from a real Win32 event hook."""

    def __init__(
        self,
        on_snapshot: ForegroundSnapshotCallback,
        on_status: Optional[StatusCallback] = None,
        *,
        user32=None,
        kernel32=None,
    ) -> None:
        default_user32, default_kernel32 = _load_windows_libraries()
        self._user32 = user32 if user32 is not None else default_user32
        self._kernel32 = kernel32 if kernel32 is not None else default_kernel32
        if self._user32 is not None and self._kernel32 is not None:
            _configure_windows_api(self._user32, self._kernel32)
        self._on_snapshot = on_snapshot
        self._on_status = on_status
        self._event_thread: Optional[threading.Thread] = None
        self._worker_thread: Optional[threading.Thread] = None
        self._event_thread_id = 0
        self._hook_handles: list[int] = []
        self._event_proc = None
        self._stop_event = threading.Event()
        self._ready_event = threading.Event()
        self._latest_hwnd: queue.Queue[Optional[int]] = queue.Queue(maxsize=1)
        self._queue_lock = threading.Lock()
        self._snapshot_lock = threading.Lock()
        self._sequence = 0
        self._last_snapshot_key: tuple[int, int, str, str] | None = None

    @property
    def is_running(self) -> bool:
        return bool(self._event_thread and self._event_thread.is_alive())

    def _publish_status(self, status: str, error: str = "") -> None:
        if self._on_status:
            self._on_status(status, error)

    def start(self) -> bool:
        if self.is_running:
            return True
        if self._user32 is None or self._kernel32 is None:
            self._publish_status("unsupported")
            return False

        self._stop_event.clear()
        self._ready_event.clear()
        self._worker_thread = threading.Thread(
            target=self._worker_loop,
            name="ForegroundWindowResolver",
            daemon=True,
        )
        self._event_thread = threading.Thread(
            target=self._event_loop,
            name="ForegroundWinEventHook",
            daemon=True,
        )
        self._worker_thread.start()
        self._event_thread.start()
        self._ready_event.wait(timeout=2.0)
        if not self._hook_handles:
            self.stop()
            self._publish_status("failed", "SetWinEventHook did not return a hook handle.")
            return False
        self._publish_status("running")
        self.emit_current()
        return True

    def stop(self) -> None:
        self._stop_event.set()
        if self._event_thread_id and self._user32 is not None:
            try:
                self._user32.PostThreadMessageW(self._event_thread_id, WM_QUIT, 0, 0)
            except Exception:
                pass
        self._replace_queued_hwnd(None)
        if self._event_thread and self._event_thread is not threading.current_thread():
            self._event_thread.join(timeout=2.0)
        if self._worker_thread and self._worker_thread is not threading.current_thread():
            self._worker_thread.join(timeout=2.0)
        self._event_thread = None
        self._worker_thread = None
        self._event_thread_id = 0
        self._publish_status("stopped")

    def emit_current(self, *, force: bool = False) -> None:
        if self._user32 is None:
            return
        try:
            hwnd = int(self._user32.GetForegroundWindow() or 0)
        except Exception:
            return
        if hwnd:
            if force:
                with self._snapshot_lock:
                    self._last_snapshot_key = None
            self._replace_queued_hwnd(hwnd)

    def restore_window(self, hwnd_value: str | int) -> bool:
        if self._user32 is None:
            return False
        try:
            hwnd = int(hwnd_value)
            if not hwnd or not self._user32.IsWindow(hwnd):
                return False
            if self._user32.IsIconic(hwnd):
                self._user32.ShowWindow(hwnd, SW_RESTORE)
            return bool(self._user32.SetForegroundWindow(hwnd))
        except (TypeError, ValueError, OSError):
            return False

    def _replace_queued_hwnd(self, hwnd: Optional[int]) -> None:
        with self._queue_lock:
            try:
                self._latest_hwnd.get_nowait()
            except queue.Empty:
                pass
            try:
                self._latest_hwnd.put_nowait(hwnd)
            except queue.Full:
                pass

    def _reconcile_foreground(self, processed_hwnd: int) -> None:
        """Queue the current foreground if it changed while processing an event."""

        if self._user32 is None or self._stop_event.is_set():
            return
        try:
            foreground = int(self._user32.GetForegroundWindow() or 0)
        except Exception:
            return
        if foreground and foreground != processed_hwnd:
            self._replace_queued_hwnd(foreground)

    def _event_loop(self) -> None:
        assert self._user32 is not None
        assert self._kernel32 is not None

        def on_event(_hook, event, hwnd, _id_object, _id_child, _thread, _time):
            try:
                resolved_hwnd = int(hwnd or 0)
                if not resolved_hwnd:
                    return
                if event == EVENT_OBJECT_NAMECHANGE:
                    foreground = int(self._user32.GetForegroundWindow() or 0)
                    if resolved_hwnd != foreground:
                        return
                self._replace_queued_hwnd(resolved_hwnd)
            except Exception:
                return

        self._event_proc = _WIN_EVENT_PROC_TYPE(on_event)
        flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
        try:
            hooks = [
                self._user32.SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    None,
                    self._event_proc,
                    0,
                    0,
                    flags,
                ),
                self._user32.SetWinEventHook(
                    EVENT_OBJECT_NAMECHANGE,
                    EVENT_OBJECT_NAMECHANGE,
                    None,
                    self._event_proc,
                    0,
                    0,
                    flags,
                ),
            ]
            self._hook_handles = [int(hook) for hook in hooks if hook]
            self._event_thread_id = int(self._kernel32.GetCurrentThreadId())
            self._ready_event.set()
            if not self._hook_handles:
                return

            message = wintypes.MSG()
            while not self._stop_event.is_set():
                result = self._user32.GetMessageW(ctypes.byref(message), None, 0, 0)
                if result in (0, -1):
                    break
                self._user32.TranslateMessage(ctypes.byref(message))
                self._user32.DispatchMessageW(ctypes.byref(message))
        except Exception as exc:
            self._publish_status("failed", str(exc))
            self._ready_event.set()
        finally:
            for hook in self._hook_handles:
                try:
                    self._user32.UnhookWinEvent(hook)
                except Exception:
                    pass
            self._hook_handles = []
            self._event_proc = None
            self._ready_event.set()

    def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                hwnd = self._latest_hwnd.get(timeout=0.25)
            except queue.Empty:
                continue
            if hwnd is None:
                break
            snapshot = self._resolve_snapshot(hwnd)
            if snapshot is None:
                self._reconcile_foreground(hwnd)
                continue
            key = (
                int(snapshot["hwnd"]),
                int(snapshot["pid"]),
                str(snapshot["title"]),
                str(snapshot.get("executablePath") or ""),
            )
            with self._snapshot_lock:
                if key == self._last_snapshot_key:
                    is_duplicate = True
                else:
                    is_duplicate = False
                    self._last_snapshot_key = key
                    self._sequence += 1
                    snapshot["sequence"] = self._sequence
            if is_duplicate:
                self._reconcile_foreground(hwnd)
                continue
            try:
                self._on_snapshot(snapshot)
            finally:
                # Resolving process metadata and publishing over IPC can both
                # overlap a second foreground transition. Re-read once so the
                # latest window is not dependent on another WinEvent arriving.
                self._reconcile_foreground(hwnd)

    def _resolve_snapshot(self, hwnd: int) -> Optional[dict[str, Any]]:
        if self._user32 is None:
            return None
        try:
            foreground = int(self._user32.GetForegroundWindow() or 0)
            if foreground != hwnd:
                return None
            length = int(self._user32.GetWindowTextLengthW(hwnd) or 0)
            buffer = ctypes.create_unicode_buffer(max(1, length + 1))
            self._user32.GetWindowTextW(hwnd, buffer, len(buffer))
            title = buffer.value
            pid_value = wintypes.DWORD()
            self._user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_value))
            pid = int(pid_value.value)
        except Exception:
            return None

        executable_path = ""
        executable_name = ""
        if pid > 0:
            try:
                process = psutil.Process(pid)
                try:
                    executable_path = process.exe() or ""
                except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                    executable_path = ""
                try:
                    executable_name = process.name() or ""
                except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                    executable_name = ""
            except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                pass
        if not executable_name and executable_path:
            executable_name = Path(executable_path).name

        return {
            "hwnd": str(hwnd),
            "pid": pid,
            "title": title,
            "executablePath": executable_path,
            "executableName": executable_name,
            "capturedAt": int(time.time() * 1000),
            "sequence": 0,
        }
