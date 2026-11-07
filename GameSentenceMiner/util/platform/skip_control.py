"""Optional Ctrl evidence, sampled only while the captured game has focus."""

import sys


def game_skip_control_held() -> bool:
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        from GameSentenceMiner.util.platform.base_window_monitor import get_window_state_monitor

        monitor = get_window_state_monitor()
        target = getattr(monitor, "target_hwnd", None)
        if not target:
            return False
        user32 = ctypes.windll.user32
        user32.GetForegroundWindow.restype = ctypes.c_void_p
        if user32.GetForegroundWindow() != target:
            return False

        def down(key):
            return bool(user32.GetAsyncKeyState(key) & 0x8000)

        if not down(0x11):  # VK_CONTROL
            return False
        # Ctrl shortcuts and AltGr aren't skip gestures. Never observe or store
        # character input; these queries merely disqualify a modifier chord.
        return not any(down(key) for key in (0x10, 0x12, 0x5B, 0x5C, *range(0x30, 0x5B)))
    except (AttributeError, OSError):
        return False
