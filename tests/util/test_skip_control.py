import ctypes
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.platform import base_window_monitor, skip_control


@pytest.mark.parametrize(
    "focused,pressed,expected",
    [
        (123, {0x11}, True),
        (456, {0x11}, False),
        (123, set(), False),
        (123, {0x11, 0x12}, False),
        (123, {0x11, ord("C")}, False),
        (123, {0x11, 0x10}, False),
    ],
)
def test_ctrl_evidence_requires_focused_game_and_no_shortcut(monkeypatch, focused, pressed, expected):
    monkeypatch.setattr(skip_control.sys, "platform", "win32")
    monkeypatch.setattr(base_window_monitor, "get_window_state_monitor", lambda: SimpleNamespace(target_hwnd=123))
    user32 = SimpleNamespace(
        GetForegroundWindow=lambda: focused, GetAsyncKeyState=lambda key: 0x8000 if key in pressed else 0
    )
    monkeypatch.setattr(ctypes, "windll", SimpleNamespace(user32=user32), raising=False)
    assert skip_control.game_skip_control_held() is expected


def test_missing_game_target_is_not_skip_evidence(monkeypatch):
    monkeypatch.setattr(base_window_monitor, "get_window_state_monitor", lambda: None)
    assert not skip_control.game_skip_control_held()
