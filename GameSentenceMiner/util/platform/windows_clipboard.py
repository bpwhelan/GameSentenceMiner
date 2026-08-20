"""Windows clipboard change notifications.

The Win32 clipboard listener is deliberately kept in its own thread because
Windows delivers ``WM_CLIPBOARDUPDATE`` through a window message pump.  The
listener only reports that the clipboard changed; the caller remains
responsible for reading and processing the clipboard contents.
"""

from __future__ import annotations

import ctypes
import os
import threading
from collections.abc import Callable

from GameSentenceMiner.util.config.configuration import logger

WM_CLIPBOARDUPDATE = 0x031D
WM_CLOSE = 0x0010
WM_DESTROY = 0x0002
WM_QUIT = 0x0012


class WindowsClipboardListener:
    """Listen for Win32 clipboard changes without polling the clipboard."""

    def __init__(self, on_change: Callable[[], None]) -> None:
        self._on_change = on_change
        self._class_name = f"GSMClipboardListener_{os.getpid()}_{id(self)}"
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._thread_id: int | None = None
        self._hwnd = None
        self._hinstance = None
        self._win32api = None
        self._win32gui = None
        self._error: Exception | None = None
        self._registered = False

    @property
    def supported(self) -> bool:
        return os.name == "nt"

    def start(self, timeout: float = 2.0) -> bool:
        """Start the listener and return whether its window was registered."""
        if not self.supported or (self._thread is not None and self._thread.is_alive()):
            return False

        self._ready.clear()
        self._error = None
        self._thread = threading.Thread(target=self._run, name="GSM-ClipboardListener", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout):
            logger.warning("Windows clipboard listener did not start in time; falling back to polling.")
            self.stop()
            return False
        if self._error is not None:
            logger.warning(f"Windows clipboard listener unavailable; falling back to polling: {self._error}")
            return False
        return self._registered

    def stop(self, timeout: float = 2.0) -> None:
        """Stop the message-pump thread and unregister its hidden window."""
        thread = self._thread
        if thread is None:
            return

        if thread.is_alive():
            try:
                if self._hwnd is not None and self._win32gui is not None:
                    self._win32gui.PostMessage(self._hwnd, WM_CLOSE, 0, 0)
                elif self._thread_id is not None and self._win32api is not None:
                    self._win32api.PostThreadMessage(self._thread_id, WM_QUIT, 0, 0)
            except Exception as error:  # noqa: BLE001 - shutdown must not mask the caller's exit
                logger.debug(f"Failed to stop Windows clipboard listener cleanly: {error}")
            thread.join(timeout)

        if thread.is_alive():
            logger.warning("Windows clipboard listener did not stop cleanly.")
        else:
            self._thread = None

    def _run(self) -> None:
        window_class = None
        class_atom = None
        try:
            import win32api
            import win32gui

            self._win32api = win32api
            self._win32gui = win32gui
            self._thread_id = win32api.GetCurrentThreadId()
            window_class = win32gui.WNDCLASS()
            window_class.hInstance = win32api.GetModuleHandle(None)
            window_class.lpszClassName = self._class_name
            window_class.lpfnWndProc = {
                WM_CLIPBOARDUPDATE: self._handle_clipboard_update,
                WM_CLOSE: self._handle_close,
                WM_DESTROY: self._handle_destroy,
            }
            class_atom = win32gui.RegisterClass(window_class)
            self._hinstance = window_class.hInstance
            self._hwnd = win32gui.CreateWindow(
                class_atom,
                self._class_name,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                window_class.hInstance,
                None,
            )
            if not self._hwnd:
                raise ctypes.WinError()
            if not ctypes.windll.user32.AddClipboardFormatListener(self._hwnd):
                raise ctypes.WinError()

            self._registered = True
            self._ready.set()
            win32gui.PumpMessages()
        except Exception as error:  # noqa: BLE001 - report listener setup failures and fall back
            self._error = error
            self._ready.set()
        finally:
            if self._hwnd is not None:
                try:
                    ctypes.windll.user32.RemoveClipboardFormatListener(self._hwnd)
                except Exception as error:  # noqa: BLE001 - cleanup must be best effort
                    logger.debug(f"Failed to remove Windows clipboard listener: {error}")
                try:
                    if self._win32gui is not None and self._win32gui.IsWindow(self._hwnd):
                        self._win32gui.DestroyWindow(self._hwnd)
                except Exception as error:  # noqa: BLE001 - cleanup must be best effort
                    logger.debug(f"Failed to destroy Windows clipboard listener window: {error}")
            if class_atom is not None and self._win32gui is not None and self._hinstance is not None:
                try:
                    self._win32gui.UnregisterClass(self._class_name, self._hinstance)
                except Exception as error:  # noqa: BLE001 - cleanup must be best effort
                    logger.debug(f"Failed to unregister Windows clipboard listener class: {error}")
            self._hwnd = None
            self._registered = False
            if not self._ready.is_set():
                self._ready.set()

    def _handle_clipboard_update(self, _hwnd, _message, _wparam, _lparam):
        try:
            self._on_change()
        except Exception as error:  # noqa: BLE001 - callbacks must not break the message pump
            logger.debug(f"Windows clipboard change callback failed: {error}")
        return 0

    def _handle_close(self, hwnd, _message, _wparam, _lparam):
        if self._win32gui is not None:
            self._win32gui.DestroyWindow(hwnd)
        return 0

    def _handle_destroy(self, _hwnd, _message, _wparam, _lparam):
        if self._win32api is not None:
            self._win32api.PostQuitMessage(0)
        return 0
