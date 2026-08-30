from __future__ import annotations

import threading
from typing import Any

from GameSentenceMiner.util.config.configuration import is_windows, logger
from GameSentenceMiner.util.platform.window_state_monitor import (
    get_window_client_physical_geometry,
    get_window_state_monitor,
    user32,
)

_SPECIAL_KEY_NAMES = {
    "AltLeft": "alt_l",
    "AltRight": "alt_r",
    "ArrowDown": "down",
    "ArrowLeft": "left",
    "ArrowRight": "right",
    "ArrowUp": "up",
    "Backspace": "backspace",
    "CapsLock": "caps_lock",
    "ControlLeft": "ctrl_l",
    "ControlRight": "ctrl_r",
    "Delete": "delete",
    "End": "end",
    "Enter": "enter",
    "Home": "home",
    "Insert": "insert",
    "MetaLeft": "cmd_l",
    "MetaRight": "cmd_r",
    "PageDown": "page_down",
    "PageUp": "page_up",
    "Pause": "pause",
    "ShiftLeft": "shift_l",
    "ShiftRight": "shift_r",
    "Space": "space",
    "Tab": "tab",
}
_CODE_CHARACTERS = {
    "Backquote": "`",
    "Backslash": "\\",
    "BracketLeft": "[",
    "BracketRight": "]",
    "Comma": ",",
    "Equal": "=",
    "IntlBackslash": "\\",
    "Minus": "-",
    "Period": ".",
    "Quote": "'",
    "Semicolon": ";",
    "Slash": "/",
}


class WindowsRemoteInputBackend:
    def __init__(self):
        self._lock = threading.RLock()
        self._keyboard = None
        self._mouse = None
        self._keyboard_module = None
        self._mouse_module = None
        self._held_keys: set[Any] = set()
        self._held_buttons: set[Any] = set()
        self._target_hwnd: int | None = None

    @property
    def available(self) -> bool:
        return is_windows() and user32 is not None

    def prepare(self) -> bool:
        with self._lock:
            if not self.available:
                return False
            monitor = get_window_state_monitor()
            if monitor is None:
                return False
            hwnd = monitor.target_hwnd or monitor.find_target_hwnd()
            if not hwnd or not user32.IsWindow(hwnd):
                return False
            monitor.target_hwnd = hwnd
            self._target_hwnd = int(hwnd)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            self._ensure_controllers()
            return user32.GetForegroundWindow() == hwnd

    def dispatch(self, event_type: str, payload: dict) -> bool:
        with self._lock:
            if not self._target_is_foreground():
                return False
            self._ensure_controllers()
            if event_type == "pointer_move":
                return self._move_pointer(payload)
            if event_type == "pointer_button":
                return self._handle_button(payload)
            if event_type == "wheel":
                return self._handle_wheel(payload)
            if event_type in {"key_down", "key_up"}:
                return self._handle_key(event_type, payload)
            return False

    def release_all(self) -> None:
        with self._lock:
            if self._keyboard is not None:
                for key in list(self._held_keys):
                    try:
                        self._keyboard.release(key)
                    except Exception:
                        pass
            if self._mouse is not None:
                for button in list(self._held_buttons):
                    try:
                        self._mouse.release(button)
                    except Exception:
                        pass
            self._held_keys.clear()
            self._held_buttons.clear()
            self._target_hwnd = None

    def _ensure_controllers(self) -> None:
        if self._keyboard is not None and self._mouse is not None:
            return
        from pynput import keyboard, mouse

        self._keyboard_module = keyboard
        self._mouse_module = mouse
        self._keyboard = keyboard.Controller()
        self._mouse = mouse.Controller()

    def _target_is_foreground(self) -> bool:
        hwnd = self._target_hwnd
        return bool(hwnd and user32 and user32.IsWindow(hwnd) and user32.GetForegroundWindow() == hwnd)

    def _move_pointer(self, payload: dict) -> bool:
        geometry = get_window_client_physical_geometry(self._target_hwnd)
        if not geometry:
            return False
        left, top, width, height = geometry
        if width <= 0 or height <= 0:
            return False
        x = max(0.0, min(1.0, float(payload.get("x", 0.0))))
        y = max(0.0, min(1.0, float(payload.get("y", 0.0))))
        self._mouse.position = (left + round(x * (width - 1)), top + round(y * (height - 1)))
        return True

    def _handle_button(self, payload: dict) -> bool:
        button = getattr(self._mouse_module.Button, str(payload.get("button", "left")), None)
        if button is None:
            return False
        if payload.get("pressed"):
            self._mouse.press(button)
            self._held_buttons.add(button)
        else:
            self._mouse.release(button)
            self._held_buttons.discard(button)
        return True

    def _handle_wheel(self, payload: dict) -> bool:
        delta_x = float(payload.get("delta_x", 0.0))
        delta_y = float(payload.get("delta_y", 0.0))
        scroll_x = 0 if delta_x == 0 else (-1 if delta_x > 0 else 1)
        scroll_y = 0 if delta_y == 0 else (-1 if delta_y > 0 else 1)
        self._mouse.scroll(scroll_x, scroll_y)
        return True

    def _handle_key(self, event_type: str, payload: dict) -> bool:
        key = self._resolve_key(str(payload.get("code", "")))
        if key is None:
            return False
        if event_type == "key_down":
            if payload.get("repeat") or key in self._held_keys:
                return True
            self._keyboard.press(key)
            self._held_keys.add(key)
        else:
            self._keyboard.release(key)
            self._held_keys.discard(key)
        return True

    def _resolve_key(self, code: str):
        special_name = _SPECIAL_KEY_NAMES.get(code)
        if special_name:
            return getattr(self._keyboard_module.Key, special_name, None)
        if code.startswith("Key") and len(code) == 4:
            return code[-1].lower()
        if code.startswith("Digit") and len(code) == 6:
            return code[-1]
        if code.startswith("F") and code[1:].isdigit():
            return getattr(self._keyboard_module.Key, code.lower(), None)
        return _CODE_CHARACTERS.get(code)


class UnsupportedRemoteInputBackend:
    available = False

    def prepare(self) -> bool:
        return False

    def dispatch(self, _event_type: str, _payload: dict) -> bool:
        return False

    def release_all(self) -> None:
        return None


def create_remote_input_backend():
    if is_windows():
        try:
            return WindowsRemoteInputBackend()
        except Exception as error:
            logger.warning(f"Remote input backend is unavailable: {error}")
    return UnsupportedRemoteInputBackend()
