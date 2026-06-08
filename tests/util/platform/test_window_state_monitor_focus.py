import asyncio
import importlib
import sys
from types import SimpleNamespace

import pytest


window_state_monitor = importlib.import_module("GameSentenceMiner.util.platform.window_state_monitor")

if sys.platform == "win32":
    _wwm = importlib.import_module("GameSentenceMiner.util.platform.windows_window_monitor")
else:
    _wwm = None


class _FakeKernel32:
    def GetCurrentThreadId(self):
        return 999


class _FakeUser32:
    def __init__(self):
        self.foreground_hwnd = 10
        self.set_foreground_attempts = 0
        self.window_pos_calls = []
        self.keybd_event_calls = []
        self.attach_calls = []
        self.spi_calls = []
        self.allow_calls = []

    def GetForegroundWindow(self):
        return self.foreground_hwnd

    def GetWindowThreadProcessId(self, hwnd, _pid_ptr):
        return {10: 111, 20: 222}.get(hwnd, 333)

    def AttachThreadInput(self, a, b, attach):
        self.attach_calls.append((a, b, bool(attach)))
        return 1

    def SystemParametersInfoW(self, action, ui_param, pv_param, flags):
        self.spi_calls.append((action, ui_param, flags))
        return 1

    def AllowSetForegroundWindow(self, pid):
        self.allow_calls.append(pid)
        return 1

    def IsIconic(self, _hwnd):
        return 0

    def ShowWindow(self, _hwnd, _cmd):
        return 1

    def BringWindowToTop(self, _hwnd):
        return 1

    def SetWindowPos(self, hwnd, insert_after, x, y, cx, cy, flags):
        self.window_pos_calls.append((hwnd, insert_after, flags))
        return 1

    def SetActiveWindow(self, _hwnd):
        return 1

    def SetFocus(self, _hwnd):
        return 1

    def SetForegroundWindow(self, hwnd):
        self.set_foreground_attempts += 1
        if self.set_foreground_attempts >= 3:
            self.foreground_hwnd = hwnd
            return 1
        return 0

    def keybd_event(self, vk, scan, flags, extra):
        self.keybd_event_calls.append((vk, scan, flags, extra))


def _set_focus_constants(monkeypatch):
    monkeypatch.setattr(_wwm, "SW_RESTORE", 9, raising=False)
    monkeypatch.setattr(_wwm, "SW_SHOW", 5, raising=False)
    monkeypatch.setattr(_wwm, "SPI_GETFOREGROUNDLOCKTIMEOUT", 0x2000, raising=False)
    monkeypatch.setattr(_wwm, "SPI_SETFOREGROUNDLOCKTIMEOUT", 0x2001, raising=False)
    monkeypatch.setattr(_wwm, "SPIF_SENDCHANGE", 2, raising=False)
    monkeypatch.setattr(_wwm, "HWND_TOPMOST", -1, raising=False)
    monkeypatch.setattr(_wwm, "HWND_NOTOPMOST", -2, raising=False)
    monkeypatch.setattr(_wwm, "SWP_NOSIZE", 0x0001, raising=False)
    monkeypatch.setattr(_wwm, "SWP_NOMOVE", 0x0002, raising=False)
    monkeypatch.setattr(_wwm, "SWP_SHOWWINDOW", 0x0040, raising=False)
    monkeypatch.setattr(_wwm, "KEYEVENTF_EXTENDEDKEY", 0x0001, raising=False)
    monkeypatch.setattr(_wwm, "KEYEVENTF_KEYUP", 0x0002, raising=False)
    monkeypatch.setattr(_wwm, "VK_MENU", 0x12, raising=False)
    monkeypatch.setattr(_wwm, "ASFW_ANY", -1, raising=False)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_set_foreground_aggressive_uses_topmost_and_alt_fallbacks(monkeypatch):
    _set_focus_constants(monkeypatch)
    fake_user32 = _FakeUser32()

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)
    monkeypatch.setattr(_wwm, "user32", fake_user32)
    monkeypatch.setattr(_wwm, "kernel32", _FakeKernel32())
    monkeypatch.setattr(_wwm.time, "sleep", lambda _seconds: None)

    monitor = window_state_monitor.WindowStateMonitor()

    assert monitor._set_foreground_aggressive(20, attempt_number=1) is True
    assert fake_user32.foreground_hwnd == 20
    assert fake_user32.allow_calls == [_wwm.ASFW_ANY]
    assert fake_user32.keybd_event_calls
    assert any(
        insert_after == _wwm.HWND_TOPMOST
        for _hwnd, insert_after, _flags in fake_user32.window_pos_calls
    )
    assert any(attach is False for _a, _b, attach in fake_user32.attach_calls)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_set_foreground_aggressive_skips_paused_target(monkeypatch):
    _set_focus_constants(monkeypatch)
    fake_user32 = _FakeUser32()

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)
    monkeypatch.setattr(_wwm, "user32", fake_user32)
    monkeypatch.setattr(_wwm, "kernel32", _FakeKernel32())
    monkeypatch.setattr(_wwm, "_get_pid_for_hwnd", lambda hwnd: 222 if hwnd == 20 else 0)
    monkeypatch.setattr(_wwm, "_is_tracked_suspended_pid", lambda pid: pid == 222)

    monitor = window_state_monitor.WindowStateMonitor()

    assert monitor._set_foreground_aggressive(20, attempt_number=1) is False
    assert fake_user32.foreground_hwnd == 10
    assert fake_user32.set_foreground_attempts == 0
    assert fake_user32.window_pos_calls == []
    assert fake_user32.keybd_event_calls == []


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_activate_target_window_retries_until_helper_succeeds(monkeypatch):
    monitor = window_state_monitor.WindowStateMonitor()
    monitor.target_hwnd = 20

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)

    attempt_numbers = []

    def fake_focus(hwnd, attempt_number=1):
        attempt_numbers.append((hwnd, attempt_number))
        return attempt_number >= 2

    sleep_delays = []

    async def fake_sleep(delay):
        sleep_delays.append(delay)

    monkeypatch.setattr(monitor, "_set_foreground_aggressive", fake_focus)
    monkeypatch.setattr(_wwm.asyncio, "sleep", fake_sleep)

    assert asyncio.run(monitor.activate_target_window()) is True
    assert attempt_numbers == [(20, 1), (20, 2)]
    assert sleep_delays == [0.08]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_sync_minimized_audio_mute_only_mutes_minimized_windows(monkeypatch):
    monitor = window_state_monitor.WindowStateMonitor()
    monitor.target_hwnd = 20

    calls = []

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)
    monkeypatch.setattr(
        _wwm,
        "get_config",
        lambda: SimpleNamespace(advanced=SimpleNamespace(mute_game_on_minimize=True)),
    )
    monkeypatch.setattr(_wwm, "_get_pid_for_hwnd", lambda hwnd: 222 if hwnd == 20 else 0)
    monkeypatch.setattr(
        _wwm,
        "set_process_mute",
        lambda *args, **kwargs: calls.append((args, kwargs)) or [],
    )

    monitor._sync_minimized_audio_mute("background")

    assert calls == []


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_sync_minimized_audio_mute_restores_only_sessions_it_changed(monkeypatch):
    monitor = window_state_monitor.WindowStateMonitor()
    monitor.target_hwnd = 20

    calls = []

    def fake_set_process_mute(pid, muted, session_instance_ids=None):
        calls.append((pid, muted, session_instance_ids))
        return [SimpleNamespace(changed=True, session_instance_id="session-1")]

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)
    monkeypatch.setattr(
        _wwm,
        "get_config",
        lambda: SimpleNamespace(advanced=SimpleNamespace(mute_game_on_minimize=True)),
    )
    monkeypatch.setattr(_wwm, "_get_pid_for_hwnd", lambda hwnd: 222 if hwnd == 20 else 0)
    monkeypatch.setattr(_wwm, "set_process_mute", fake_set_process_mute)

    monitor._sync_minimized_audio_mute("minimized")
    monitor._sync_minimized_audio_mute("active")

    assert calls == [
        (222, True, None),
        (222, False, {"session-1"}),
    ]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_sync_minimized_audio_mute_leaves_previous_target_muted_when_target_changes(monkeypatch):
    monitor = window_state_monitor.WindowStateMonitor()
    monitor.target_hwnd = 20

    calls = []

    def fake_set_process_mute(pid, muted, session_instance_ids=None):
        calls.append((pid, muted, session_instance_ids))
        return [SimpleNamespace(changed=True, session_instance_id=f"session-{pid}")]

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)
    monkeypatch.setattr(
        _wwm,
        "get_config",
        lambda: SimpleNamespace(advanced=SimpleNamespace(mute_game_on_minimize=True)),
    )
    monkeypatch.setattr(_wwm, "_get_pid_for_hwnd", lambda hwnd: {20: 222, 30: 333}.get(hwnd, 0))
    monkeypatch.setattr(_wwm, "set_process_mute", fake_set_process_mute)

    monitor._sync_minimized_audio_mute("minimized")
    monitor.target_hwnd = 30
    monitor._sync_minimized_audio_mute("minimized")

    assert calls == [
        (222, True, None),
        (333, True, None),
    ]
    assert monitor.minimized_audio_mutes == {
        222: ({"session-222"}, False),
        333: ({"session-333"}, False),
    }


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_sync_minimized_audio_mute_falls_back_when_tracked_session_disappears(monkeypatch):
    monitor = window_state_monitor.WindowStateMonitor()
    monitor.target_hwnd = 20
    monitor.last_state = "minimized"
    monitor.minimized_audio_mutes[222] = ({"session-1"}, False)

    calls = []

    def fake_set_process_mute(pid, muted, session_instance_ids=None):
        calls.append((pid, muted, session_instance_ids))
        if session_instance_ids == {"session-1"}:
            return []
        return [SimpleNamespace(changed=True, session_instance_id="session-2")]

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)
    monkeypatch.setattr(
        _wwm,
        "get_config",
        lambda: SimpleNamespace(advanced=SimpleNamespace(mute_game_on_minimize=True)),
    )
    monkeypatch.setattr(_wwm, "_get_pid_for_hwnd", lambda hwnd: 222 if hwnd == 20 else 0)
    monkeypatch.setattr(_wwm, "set_process_mute", fake_set_process_mute)

    monitor._sync_minimized_audio_mute("active")

    assert calls == [
        (222, False, None),
    ]
    assert monitor.minimized_audio_mutes == {}


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_cleanup_minimized_audio_mutes_restores_all_tracked_targets(monkeypatch):
    monitor = window_state_monitor.WindowStateMonitor()
    monitor.minimized_audio_mutes = {
        222: ({"session-1"}, False),
        333: ({"session-2"}, False),
    }
    window_state_monitor.set_window_state_monitor(monitor)

    calls = []

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)
    monkeypatch.setattr(
        _wwm,
        "set_process_mute",
        lambda pid, muted, session_instance_ids=None: (
            calls.append((pid, muted, session_instance_ids))
            or [SimpleNamespace(changed=True, session_instance_id=f"session-{pid}")]
        ),
    )

    try:
        window_state_monitor.cleanup_minimized_audio_mutes()
    finally:
        window_state_monitor.set_window_state_monitor(None)

    assert calls == [
        (222, False, None),
        (333, False, None),
    ]
    assert monitor.minimized_audio_mutes == {}


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_sync_minimized_audio_mute_force_unmutes_active_target_after_untracked_minimized_state(monkeypatch):
    monitor = window_state_monitor.WindowStateMonitor()
    monitor.target_hwnd = 20
    monitor.last_state = "minimized"

    calls = []

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)
    monkeypatch.setattr(
        _wwm,
        "get_config",
        lambda: SimpleNamespace(advanced=SimpleNamespace(mute_game_on_minimize=True)),
    )
    monkeypatch.setattr(_wwm, "_get_pid_for_hwnd", lambda hwnd: 222 if hwnd == 20 else 0)
    monkeypatch.setattr(
        _wwm,
        "set_process_mute",
        lambda *args, **kwargs: calls.append((args, kwargs)) or [],
    )

    monitor._sync_minimized_audio_mute("active")

    assert calls == [((222, False), {})]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_send_enter_to_target_window_uses_activation_retry_helper(monkeypatch):
    monitor = window_state_monitor.WindowStateMonitor()
    monitor.target_hwnd = 20

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)
    monkeypatch.setattr(monitor, "_set_foreground_aggressive", lambda *_args, **_kwargs: False)

    activation_calls = []

    async def fake_activate():
        activation_calls.append(True)
        return True

    keybd_calls = []

    monkeypatch.setattr(monitor, "activate_target_window", fake_activate)
    monkeypatch.setattr(monitor, "_send_enter_with_keybd_event", lambda: keybd_calls.append(True) or True)

    assert asyncio.run(monitor.send_enter_to_target_window(activate_window=True)) is True
    assert activation_calls == [True]
    assert keybd_calls == [True]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_send_enter_to_target_window_falls_back_to_sendinput(monkeypatch):
    monitor = window_state_monitor.WindowStateMonitor()
    monitor.target_hwnd = 20

    monkeypatch.setattr(_wwm, "is_windows", lambda: True)

    async def fake_activate():
        return True

    keybd_calls = []
    sendinput_calls = []

    monkeypatch.setattr(monitor, "activate_target_window", fake_activate)
    monkeypatch.setattr(monitor, "_send_enter_with_keybd_event", lambda: keybd_calls.append(True) or False)
    monkeypatch.setattr(monitor, "_send_enter_with_sendinput", lambda: sendinput_calls.append(True) or True)

    assert asyncio.run(monitor.send_enter_to_target_window(activate_window=True)) is True
    assert keybd_calls == [True]
    assert sendinput_calls == [True]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_is_exclusive_fullscreen_accepts_tuple_window_rects(monkeypatch):
    if not hasattr(_wwm, "MONITORINFO"):
        pytest.skip("Windows-only monitor APIs")

    class _FakeUser32:
        def GetWindowLongW(self, _hwnd, _index):
            return _wwm.WS_POPUP

        def MonitorFromWindow(self, _hwnd, _flag):
            return 500

        def GetMonitorInfoW(self, _monitor, info_ptr):
            info = info_ptr._obj
            info.rcMonitor.left = 0
            info.rcMonitor.top = 0
            info.rcMonitor.right = 1920
            info.rcMonitor.bottom = 1080
            return 1

    monkeypatch.setattr(_wwm, "user32", _FakeUser32())
    monkeypatch.setattr(_wwm, "get_window_rect_physical", lambda _hwnd: (0, 0, 1920, 1080))

    monitor = window_state_monitor.WindowStateMonitor()

    assert monitor._is_exclusive_fullscreen(123) is True
