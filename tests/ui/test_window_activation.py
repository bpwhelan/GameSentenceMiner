import sys
from types import SimpleNamespace

import pytest

from GameSentenceMiner.ui import window_activation


@pytest.fixture
def windows_activation(monkeypatch):
    class WindowsError(Exception):
        pass

    state = SimpleNamespace(foreground=101, locked=True, keys_down=set(), calls=[], valid=True)

    def set_foreground(hwnd):
        state.calls.append(("foreground", hwnd))
        if state.locked:
            raise WindowsError("Foreground activation denied")
        state.foreground = hwnd

    def keybd_event(key, scan, flags, extra):
        state.calls.append(("key", key, scan, flags, extra))
        if flags == 2:
            state.locked = False

    monkeypatch.setitem(sys.modules, "pywintypes", SimpleNamespace(error=WindowsError))
    monkeypatch.setitem(
        sys.modules,
        "win32gui",
        SimpleNamespace(
            GetForegroundWindow=lambda: state.foreground,
            IsWindow=lambda hwnd: state.valid,
            SetForegroundWindow=set_foreground,
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "win32api",
        SimpleNamespace(
            GetAsyncKeyState=lambda key: 0x8000 if key in state.keys_down else 0,
            keybd_event=keybd_event,
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "win32con",
        SimpleNamespace(VK_SHIFT=16, VK_CONTROL=17, VK_MENU=18, VK_LWIN=91, VK_RWIN=92, KEYEVENTF_KEYUP=2),
    )
    return window_activation, state


def test_windows_activation_retries_when_foreground_lock_rejects_request(windows_activation):
    module, state = windows_activation
    hwnd = 0x123456789  # Window handles must retain all bits on 64-bit Windows.

    assert module._set_windows_foreground(hwnd)

    assert state.foreground == hwnd
    assert state.calls == [
        ("foreground", hwnd),
        ("key", 18, 0x38, 0, 0),
        ("key", 18, 0x38, 2, 0),
        ("foreground", hwnd),
    ]


def test_windows_activation_does_not_send_keys_when_direct_request_succeeds(windows_activation):
    module, state = windows_activation
    state.locked = False

    assert module._set_windows_foreground(202)
    assert state.calls == [("foreground", 202)]


def test_windows_activation_does_not_touch_already_foreground_window(windows_activation):
    module, state = windows_activation

    assert module._set_windows_foreground(state.foreground)
    assert state.calls == []


@pytest.mark.parametrize("modifier", [16, 17, 18, 91, 92])
def test_windows_activation_does_not_inject_keys_while_modifier_is_held(windows_activation, modifier):
    module, state = windows_activation
    state.keys_down.add(modifier)

    assert not module._set_windows_foreground(202)
    assert state.calls == [("foreground", 202)]


@pytest.mark.parametrize("hwnd", [0, 202])
def test_windows_activation_ignores_invalid_window(windows_activation, hwnd):
    module, state = windows_activation
    state.valid = False

    assert not module._set_windows_foreground(hwnd)
    assert state.calls == []


def test_windows_activation_reports_failure_if_fallback_is_also_denied(windows_activation, monkeypatch):
    module, state = windows_activation
    monkeypatch.setattr(sys.modules["win32api"], "keybd_event", lambda *_args: None)

    assert not module._set_windows_foreground(202)
    assert state.foreground == 101


@pytest.mark.parametrize("platform_name", ["offscreen", "windows"])
def test_activation_uses_native_foreground_only_for_windows_widgets(monkeypatch, platform_name):
    module = window_activation
    calls = []
    monkeypatch.setattr(module.sys, "platform", "win32")
    monkeypatch.setattr(module, "QApplication", SimpleNamespace(platformName=lambda: platform_name))
    monkeypatch.setattr(module, "_set_windows_foreground", lambda hwnd: calls.append(("native", hwnd)) or True)
    window = SimpleNamespace(
        raise_=lambda: calls.append("raise"),
        activateWindow=lambda: calls.append("activate"),
        winId=lambda: 202,
        isActiveWindow=lambda: False,
    )

    assert module.activate_window(window) is (platform_name == "windows")
    assert calls[:2] == ["raise", "activate"]
    assert calls[2:] == ([("native", 202)] if platform_name == "windows" else [])
