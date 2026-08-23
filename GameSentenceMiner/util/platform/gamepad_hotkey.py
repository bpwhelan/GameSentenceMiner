from __future__ import annotations

import json
import os
import re
import threading
from collections.abc import Callable
from typing import Any

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from GameSentenceMiner.util.logging_config import logger


GAMEPAD_BUTTON_OPTIONS: tuple[tuple[str, int], ...] = (
    ("A", 0),
    ("B", 1),
    ("X", 2),
    ("Y", 3),
    ("LB", 4),
    ("RB", 5),
    ("LT", 6),
    ("RT", 7),
    ("Back", 8),
    ("Start", 9),
    ("LS", 10),
    ("RS", 11),
    ("DPad Up", 12),
    ("DPad Down", 13),
    ("DPad Left", 14),
    ("DPad Right", 15),
    ("Guide", 16),
)

_BUTTON_BY_NAME = {re.sub(r"[\s_-]+", "", name).upper(): code for name, code in GAMEPAD_BUTTON_OPTIONS}
_BUTTON_BY_NAME.update(
    {
        "BACK/SELECT": 8,
        "SELECT": 8,
        "HOME": 16,
        "MODE": 16,
        "DPADUP": 12,
        "DPADDOWN": 13,
        "DPADLEFT": 14,
        "DPADRIGHT": 15,
    }
)
_DISABLED_BINDINGS = {"", "-1", "disabled", "none", "off"}


def parse_gamepad_binding(value: Any) -> frozenset[int]:
    """Normalize a button or button chord into stable GSM button codes."""
    if value is None:
        return frozenset()
    if isinstance(value, bool):
        raise ValueError("boolean values aren't valid gamepad bindings")
    if isinstance(value, int):
        if value == -1:
            return frozenset()
        if 0 <= value <= 16:
            return frozenset({value})
        raise ValueError(f"gamepad button code must be between 0 and 16, got {value}")

    text = str(value).strip()
    if text.lower() in _DISABLED_BINDINGS:
        return frozenset()

    buttons: set[int] = set()
    for token in text.split("+"):
        normalized = re.sub(r"[\s_-]+", "", token).upper()
        if not normalized:
            raise ValueError(f"invalid gamepad binding: {text!r}")
        if normalized.isdigit():
            button = int(normalized)
        else:
            button = _BUTTON_BY_NAME.get(normalized, -1)
        if not 0 <= button <= 16:
            raise ValueError(f"unknown gamepad button: {token.strip()!r}")
        buttons.add(button)

    return frozenset(buttons)


class GamepadHotkeyDispatcher:
    """Convert raw service button edges into app-specific hotkey callbacks."""

    def __init__(self) -> None:
        self._registrations: list[tuple[frozenset[int], Callable[[], None]]] = []
        self._pressed_by_device: dict[str, set[int]] = {}
        self._active: set[tuple[int, str]] = set()
        self._lock = threading.Lock()

    def register(self, binding: Any, callback: Callable[[], None]) -> bool:
        buttons = parse_gamepad_binding(binding)
        if not buttons:
            return False
        with self._lock:
            self._registrations.append((buttons, callback))
        return True

    def clear(self) -> None:
        with self._lock:
            self._registrations.clear()
            self._pressed_by_device.clear()
            self._active.clear()

    @staticmethod
    def _snapshot_buttons(message: dict[str, Any]) -> set[int]:
        state = message.get("state") if message.get("type") == "gamepad_connected" else message
        buttons = state.get("buttons", {}) if isinstance(state, dict) else {}
        if not isinstance(buttons, dict):
            return set()
        return {
            int(button)
            for button, pressed in buttons.items()
            if pressed is True and str(button).lstrip("-").isdigit() and 0 <= int(button) <= 16
        }

    def handle_message(self, message: dict[str, Any]) -> None:
        message_type = message.get("type")
        device = str(message.get("device") or "")
        if not device:
            return

        callbacks: list[Callable[[], None]] = []
        with self._lock:
            if message_type in {"gamepad_connected", "gamepad_state"}:
                self._pressed_by_device[device] = self._snapshot_buttons(message)
                self._sync_active_without_firing(device)
                return
            if message_type == "gamepad_disconnected":
                self._pressed_by_device.pop(device, None)
                self._active = {key for key in self._active if key[1] != device}
                return
            if message_type != "button":
                return

            try:
                button = int(message.get("button"))
            except (TypeError, ValueError):
                return
            if not 0 <= button <= 16:
                return

            pressed = self._pressed_by_device.setdefault(device, set())
            if message.get("pressed") is True:
                pressed.add(button)
            else:
                pressed.discard(button)

            for index, (binding, callback) in enumerate(self._registrations):
                key = (index, device)
                active = binding.issubset(pressed)
                was_active = key in self._active
                if active:
                    self._active.add(key)
                    if not was_active:
                        callbacks.append(callback)
                else:
                    self._active.discard(key)

        for callback in callbacks:
            callback()

    def _sync_active_without_firing(self, device: str) -> None:
        pressed = self._pressed_by_device.get(device, set())
        for index, (binding, _) in enumerate(self._registrations):
            key = (index, device)
            if binding.issubset(pressed):
                self._active.add(key)
            else:
                self._active.discard(key)


def get_input_server_url() -> str:
    explicit_url = str(os.environ.get("GSM_INPUT_SERVER_URL") or "").strip()
    if explicit_url:
        return explicit_url
    raw_port = str(os.environ.get("GSM_INPUT_SERVER_PORT") or "7276").strip()
    try:
        port = int(raw_port)
    except ValueError:
        port = 7276
    if not 1 <= port <= 65535:
        port = 7276
    return f"ws://127.0.0.1:{port}"


class GamepadInputClient:
    """Small reconnecting client for the Electron-owned GSM input service."""

    def __init__(
        self,
        dispatcher: GamepadHotkeyDispatcher,
        url: str | None = None,
        *,
        exclusive: bool = False,
    ) -> None:
        self.dispatcher = dispatcher
        self.url = url or get_input_server_url()
        self.exclusive = exclusive
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._connection = None
        self._connection_lock = threading.Lock()
        self._exclusive_acquired = not exclusive

    def _connection_messages(self) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        if self.exclusive:
            messages.append({"type": "configure_gamepad_capture", "enabled": True})
        messages.extend(({"type": "get_service_info"}, {"type": "get_state"}))
        return messages

    def _handle_message(self, message: dict[str, Any]) -> None:
        if message.get("type") == "gamepad_capture_changed":
            if self.exclusive:
                self._exclusive_acquired = bool(message.get("active") and message.get("owned"))
            return
        if self.exclusive and not self._exclusive_acquired:
            return
        self.dispatcher.handle_message(message)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="gsm-gamepad-hotkeys", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._exclusive_acquired = not self.exclusive
        with self._connection_lock:
            connection = self._connection
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        thread = self._thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2)
        self._thread = None

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                with connect(
                    self.url,
                    open_timeout=2,
                    close_timeout=1,
                    ping_interval=None,  # localhost; we reconnect via recv loop, keepalive only adds noise
                    proxy=None,
                ) as connection:
                    with self._connection_lock:
                        self._connection = connection
                    self._exclusive_acquired = not self.exclusive
                    for message in self._connection_messages():
                        connection.send(json.dumps(message))
                    logger.info(f"Gamepad hotkeys connected to GSM input service at {self.url}.")
                    while not self._stop_event.is_set():
                        try:
                            raw_message = connection.recv(timeout=1)
                        except TimeoutError:
                            continue
                        if not isinstance(raw_message, str):
                            continue
                        message = json.loads(raw_message)
                        if isinstance(message, dict):
                            self._handle_message(message)
            except (ConnectionClosed, OSError, TimeoutError):
                logger.debug(f"Gamepad hotkey client waiting for GSM input service at {self.url}.")
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                logger.warning(f"Ignored invalid GSM input service message: {exc}")
            finally:
                with self._connection_lock:
                    self._connection = None

            self._stop_event.wait(1)
