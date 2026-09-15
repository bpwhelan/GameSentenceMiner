import sys

from PyQt6.QtWidgets import QApplication, QWidget

from GameSentenceMiner.util.logging_config import logger


def activate_window(window: QWidget) -> bool:
    """Activate a visible Qt window, including when Windows keeps another app focused."""
    window.raise_()
    window.activateWindow()
    if sys.platform == "win32" and QApplication.platformName() == "windows":
        return _set_windows_foreground(int(window.winId()))
    return window.isActiveWindow()


def _set_windows_foreground(hwnd: int) -> bool:
    try:
        import pywintypes
        import win32api
        import win32con
        import win32gui
    except ImportError as exc:
        logger.debug(f"Native window activation unavailable: {exc}")
        return False

    try:
        if not hwnd or not win32gui.IsWindow(hwnd):
            return False
        if win32gui.GetForegroundWindow() == hwnd:
            return True

        def request_foreground() -> bool:
            try:
                win32gui.SetForegroundWindow(hwnd)
            except pywintypes.error:
                # Windows can reject a background process even with no Win32 error code.
                pass
            return win32gui.GetForegroundWindow() == hwnd

        if request_foreground():
            return True

        modifiers = (win32con.VK_SHIFT, win32con.VK_CONTROL, win32con.VK_MENU, win32con.VK_LWIN, win32con.VK_RWIN)
        if any(win32api.GetAsyncKeyState(key) & 0x8000 for key in modifiers):
            return False

        # An Alt tap releases Windows' foreground lock. Do this only after a
        # rejected activation, with no held modifiers, and always release Alt.
        # https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-locksetforegroundwindow
        try:
            win32api.keybd_event(win32con.VK_MENU, 0x38, 0, 0)
        finally:
            win32api.keybd_event(win32con.VK_MENU, 0x38, win32con.KEYEVENTF_KEYUP, 0)
        return request_foreground()
    except (pywintypes.error, OSError) as exc:
        logger.debug(f"Failed to activate window {hwnd} on Windows: {exc}")
        return False
