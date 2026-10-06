import asyncio
import importlib
import json
import sys
import time
from types import SimpleNamespace

import pytest


window_state_monitor = importlib.import_module("GameSentenceMiner.util.platform.window_state_monitor")

if sys.platform == "win32":
    _wwm = importlib.import_module("GameSentenceMiner.util.platform.windows_window_monitor")
else:
    _wwm = None


class _FakeUser32ForFind:
    def __init__(self):
        self.windows = [101, 202]
        self.foreground_hwnd = 202
        self.classes = {
            101: "UnrealWindow",
            202: "UnrealWindow",
        }
        self.titles = {
            101: "Tales of Arise",
            202: "Marvel Rivals",
        }

    def EnumWindows(self, callback, extra):
        for hwnd in self.windows:
            if not callback(hwnd, extra):
                break
        return 1

    def IsWindowVisible(self, _hwnd):
        return 1

    def GetClassNameW(self, hwnd, buff, _size):
        value = self.classes.get(hwnd, "")
        buff.value = value
        return len(value)

    def GetForegroundWindow(self):
        return self.foreground_hwnd

    def GetWindowTextLengthW(self, hwnd):
        return len(self.titles.get(hwnd, ""))

    def GetWindowTextW(self, hwnd, buff, _size):
        value = self.titles.get(hwnd, "")
        buff.value = value
        return len(value)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window enumeration APIs")
def test_find_target_hwnd_requires_exe_match_for_same_class_candidates(monkeypatch):
    fake_user32 = _FakeUser32ForFind()
    exe_by_hwnd = {
        101: "Tales of Arise.exe",
        202: "MarvelRivals.exe",
    }
    exe_lookups = []

    monkeypatch.setattr(_wwm, "user32", fake_user32)
    monkeypatch.setattr(_wwm.ctypes, "WINFUNCTYPE", lambda *_args: lambda fn: fn, raising=False)
    monkeypatch.setattr(_wwm, "get_current_scene", lambda: "Game Scene")
    monkeypatch.setattr(_wwm, "get_current_game", lambda: "Tales of Arise")
    monkeypatch.setattr(
        _wwm,
        "get_window_info_from_source",
        lambda scene_name=None: {
            "title": "Tales of Arise",
            "window_class": "UnrealWindow",
            "exe": "Tales of Arise.exe",
        },
    )

    monitor = window_state_monitor.WindowStateMonitor()

    def fake_get_window_exe_name(hwnd):
        exe_lookups.append(hwnd)
        return exe_by_hwnd.get(hwnd, "")

    monkeypatch.setattr(monitor, "_get_window_exe_name", fake_get_window_exe_name)
    monkeypatch.setattr(monitor, "_get_process_memory_usage", lambda hwnd: 10_000 if hwnd == 202 else 1)

    assert monitor.find_target_hwnd() == 101
    assert monitor.found_hwnds == [101]
    assert exe_lookups == [101, 202]


@pytest.mark.parametrize(
    ("executable", "configuration_title"),
    [("eden.exe", "Eden Configuration"), ("yuzu.exe", "yuzu Configuration")],
)
@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window enumeration APIs")
def test_find_target_hwnd_never_selects_eden_yuzu_configuration_window(monkeypatch, executable, configuration_title):
    fake_user32 = _FakeUser32ForFind()
    fake_user32.classes = {
        101: "Qt5152QWindowIcon",
        202: "Qt5152QWindowIcon",
    }
    fake_user32.titles = {
        101: "Eden | v0.0.4 | ANONYMOUS;CODE (64-bit) | 1.0.0 | NVIDIA",
        202: configuration_title,
    }
    monkeypatch.setattr(_wwm, "user32", fake_user32)
    monkeypatch.setattr(_wwm.ctypes, "WINFUNCTYPE", lambda *_args: lambda fn: fn, raising=False)
    monkeypatch.setattr(_wwm, "get_current_scene", lambda: "Game Scene")
    monkeypatch.setattr(_wwm, "get_current_game", lambda: "ANONYMOUS;CODE")
    monkeypatch.setattr(
        _wwm,
        "get_window_info_from_source",
        lambda scene_name=None: {
            "title": fake_user32.titles[101],
            "window_class": "Qt5152QWindowIcon",
            "exe": executable,
        },
    )
    monkeypatch.setattr(
        _wwm.WindowsWindowStateMonitor,
        "_get_window_exe_name",
        lambda _monitor, hwnd: executable,
    )

    monitor = window_state_monitor.WindowStateMonitor()

    assert monitor.find_target_hwnd() == 101
    assert monitor.found_hwnds == [101]


class _FakeUser32ForUwp:
    """Models the desktop child-list walk EnumWindows cannot do for immersive frames."""

    RE7_TITLE = "BIOHAZARD 7 resident evil グロテスクVer."

    def __init__(self):
        # FindWindowExW iterates these in order; 401 is a title-less helper frame.
        self.frames = [401, 402, 403]
        self.classes = {401: "ApplicationFrameWindow", 402: "ApplicationFrameWindow", 403: "ApplicationFrameWindow"}
        self.titles = {401: "", 402: self.RE7_TITLE, 403: "Xbox"}
        self.foreground_hwnd = 9999

    def FindWindowExW(self, _parent, after, class_name, _window_name):
        if class_name != "ApplicationFrameWindow":
            return 0
        if not after:
            return self.frames[0]
        try:
            idx = self.frames.index(after)
        except ValueError:
            return 0
        return self.frames[idx + 1] if idx + 1 < len(self.frames) else 0

    def IsWindowVisible(self, _hwnd):
        return 1

    def GetClassNameW(self, hwnd, buff, _size):
        value = self.classes.get(hwnd, "")
        buff.value = value
        return len(value)

    def GetForegroundWindow(self):
        return self.foreground_hwnd

    def GetWindowTextLengthW(self, hwnd):
        return len(self.titles.get(hwnd, ""))

    def GetWindowTextW(self, hwnd, buff, _size):
        value = self.titles.get(hwnd, "")
        buff.value = value
        return len(value)


def _patch_uwp_obs_source(monkeypatch):
    monkeypatch.setattr(_wwm, "get_current_scene", lambda: "Game Scene")
    monkeypatch.setattr(_wwm, "get_current_game", lambda: _FakeUser32ForUwp.RE7_TITLE)
    monkeypatch.setattr(
        _wwm,
        "get_window_info_from_source",
        lambda scene_name=None: {
            "title": _FakeUser32ForUwp.RE7_TITLE,
            "window_class": "Windows.UI.Core.CoreWindow",
            "exe": "re7.exe",
        },
    )


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window enumeration APIs")
def test_find_target_hwnd_resolves_uwp_frame_by_title(monkeypatch):
    """Exclusive-fullscreen UWP (RE7 Game Pass) exposes no CoreWindow child; match by title."""
    fake_user32 = _FakeUser32ForUwp()
    monkeypatch.setattr(_wwm, "user32", fake_user32)
    _patch_uwp_obs_source(monkeypatch)

    monitor = window_state_monitor.WindowStateMonitor()
    # No hosted-exe resolvable in fullscreen, so the title anchor must drive the match.
    monkeypatch.setattr(monitor, "_uwp_app_exe_from_frame", lambda hwnd: "")

    assert monitor.find_target_hwnd() == 402


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window enumeration APIs")
def test_find_target_hwnd_resolves_uwp_frame_by_hosted_exe(monkeypatch):
    """Windowed UWP exposes a CoreWindow child whose exe is authoritative over the title."""
    fake_user32 = _FakeUser32ForUwp()
    fake_user32.titles[402] = "Some Renamed Title"  # title no longer matches; exe must win
    monkeypatch.setattr(_wwm, "user32", fake_user32)
    _patch_uwp_obs_source(monkeypatch)

    monitor = window_state_monitor.WindowStateMonitor()
    hosted_exe = {402: "re7.exe", 403: "XboxPcApp.exe"}
    monkeypatch.setattr(monitor, "_uwp_app_exe_from_frame", lambda hwnd: hosted_exe.get(hwnd, ""))

    assert monitor.find_target_hwnd() == 402


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window enumeration APIs")
def test_find_target_hwnd_uwp_prefers_foreground_among_matches(monkeypatch):
    fake_user32 = _FakeUser32ForUwp()
    fake_user32.frames = [402, 404]
    fake_user32.classes[404] = "ApplicationFrameWindow"
    fake_user32.titles[404] = _FakeUser32ForUwp.RE7_TITLE  # two frames match the title
    fake_user32.foreground_hwnd = 404
    monkeypatch.setattr(_wwm, "user32", fake_user32)
    _patch_uwp_obs_source(monkeypatch)

    monitor = window_state_monitor.WindowStateMonitor()
    monkeypatch.setattr(monitor, "_uwp_app_exe_from_frame", lambda hwnd: "")

    assert monitor.find_target_hwnd() == 404


def test_exe_names_match_normalizes_paths_case_and_extension():
    assert window_state_monitor._exe_names_match(
        r"C:\Games\Tales of Arise\Tales of Arise.exe",
        "tales of arise",
    )
    assert not window_state_monitor._exe_names_match("MarvelRivals.exe", "Tales of Arise.exe")


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window monitor")
def test_capture_card_output_announces_showable_background_state(monkeypatch):
    monitor = _wwm.WindowsWindowStateMonitor.__new__(_wwm.WindowsWindowStateMonitor)
    monitor.hidden_due_to_no_output = False
    monitor.last_state = "unknown"
    monitor.last_game_name = "Capture Card"
    monitor.last_target_info = {}
    monitor.magpie_info = None
    monitor.last_is_fullscreen = False

    monkeypatch.setattr(monitor, "_obs_reports_no_output", lambda: False)
    monkeypatch.setattr(monitor, "_obs_reports_output", lambda: True)

    sent_payloads = []

    async def fake_send(_client_id, payload):
        sent_payloads.append(json.loads(payload))

    monkeypatch.setattr(_wwm.websocket_manager, "has_clients", lambda _client_id: True)
    monkeypatch.setattr(_wwm.websocket_manager, "send", fake_send)

    asyncio.run(monitor._hide_overlay_if_obs_has_no_output())

    assert monitor.last_state == "background"
    assert sent_payloads == [
        {
            "type": "window_state",
            "data": "background",
            "game": "Capture Card",
            "magpie_info": None,
            "is_fullscreen": False,
            "is_exclusive_fullscreen": False,
            "recommend_manual_mode": False,
            "target_window_rect": None,
            "target_client_rect": None,
            "obs_output_active": True,
        }
    ]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window monitor")
def test_minimized_invisible_target_survives_hwnd_revalidation(monkeypatch):
    fake_user32 = SimpleNamespace(
        IsWindow=lambda hwnd: hwnd == 123,
        IsIconic=lambda hwnd: hwnd == 123,
        IsWindowVisible=lambda hwnd: False,
    )
    monkeypatch.setattr(_wwm, "user32", fake_user32)
    monkeypatch.setattr(_wwm.WindowsWindowStateMonitor, "_start_event_hooks", lambda self: None)
    monkeypatch.setattr(_wwm.websocket_manager, "has_clients", lambda client_id: False)

    monitor = _wwm.WindowsWindowStateMonitor(SimpleNamespace(obs_width=None, obs_height=None))
    monitor.target_hwnd = 123
    monitor.last_known_target_hwnd = 123
    monitor.last_state = "background"
    monitor.last_target_scene_name = "Game"
    monitor.last_scene_name = "Game"
    monitor.last_obs_check_time = time.time()
    monitor.last_monitor_validation_time = time.time()
    monitor.last_hwnd_refresh_time = 0.0
    monkeypatch.setattr(monitor, "find_target_hwnd", lambda: pytest.fail("minimized HWND was discarded"))
    monkeypatch.setattr(monitor, "_sync_minimized_audio_mute", lambda state: None)
    monkeypatch.setattr(monitor, "update_magpie_info", lambda: None)
    monkeypatch.setattr(monitor, "_build_client_rect_payload", lambda: None)

    asyncio.run(monitor.check_and_send())

    assert monitor.target_hwnd == 123
    assert monitor.last_state == "minimized"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window monitor")
def test_removing_capture_source_discards_previous_hwnd(monkeypatch):
    monkeypatch.setattr(_wwm.WindowsWindowStateMonitor, "_start_event_hooks", lambda self: None)
    monkeypatch.setattr(
        _wwm, "user32", SimpleNamespace(IsIconic=lambda hwnd: pytest.fail("Old capture HWND was reused"))
    )
    monitor = _wwm.WindowsWindowStateMonitor(SimpleNamespace(obs_width=None, obs_height=None))
    monitor.target_hwnd = 123
    monitor.last_target_info = {"title": "Game", "exe": "game.exe"}
    monitor.last_scene_name = "Game"
    monitor.last_target_scene_name = "Game"
    monitor.last_monitor_validation_time = time.time()
    monitor.last_hwnd_refresh_time = time.time()
    monkeypatch.setattr(_wwm, "get_current_scene", lambda: "Game")
    monkeypatch.setattr(_wwm, "get_window_info_from_source", lambda **kwargs: None)
    monkeypatch.setattr(monitor, "find_target_hwnd", lambda: None)
    monkeypatch.setattr(monitor, "_obs_reports_output", lambda: False)
    monkeypatch.setattr(monitor, "_obs_reports_no_output", lambda: False)
    asyncio.run(monitor.check_and_send())
    assert monitor.target_hwnd is None


@pytest.fixture
def browser_target(monkeypatch):
    if _wwm is None:
        pytest.skip("Windows-only window monitor")
    desktop = _FakeUser32ForFind()
    desktop.classes = {101: "Chrome_WidgetWin_1", 202: "Chrome_WidgetWin_1"}
    desktop.titles = {101: "Browser game - Google Chrome", 202: "Unrelated tab - Google Chrome"}
    desktop.foreground_hwnd = 101
    desktop.IsWindow = lambda hwnd: hwnd in desktop.windows
    desktop.IsIconic = lambda hwnd: False
    pids = {101: 1001, 202: 2002}
    exes = {101: "chrome.exe", 202: "chrome.exe"}
    source = {
        "title": desktop.titles[101],
        "window_class": "Chrome_WidgetWin_1",
        "exe": "chrome.exe",
        "source_name": "Browser capture",
    }
    scene = {"name": "Browser game"}
    monkeypatch.setattr(_wwm, "user32", desktop)
    monkeypatch.setattr(_wwm, "_get_pid_for_hwnd", lambda hwnd: pids.get(hwnd, 0))
    monkeypatch.setattr(_wwm.WindowsWindowStateMonitor, "_start_event_hooks", lambda self: None)
    monkeypatch.setattr(_wwm.ctypes, "WINFUNCTYPE", lambda *_args: lambda fn: fn, raising=False)
    monkeypatch.setattr(_wwm, "get_current_scene", lambda: scene["name"])
    monkeypatch.setattr(_wwm, "get_current_game", lambda: "Browser game")
    monkeypatch.setattr(_wwm, "get_window_info_from_source", lambda **kwargs: dict(source))
    monitor = _wwm.WindowsWindowStateMonitor(SimpleNamespace(obs_width=None, obs_height=None))
    monkeypatch.setattr(monitor, "_get_window_exe_name", lambda hwnd: exes.get(hwnd, ""))
    return monitor, desktop, source, scene, pids, exes


def test_browser_target_is_remembered_after_focus_and_title_changes(browser_target):
    monitor, desktop, _, _, _, _ = browser_target
    assert monitor.find_target_hwnd() == 101
    desktop.foreground_hwnd = 202
    desktop.titles[101] = "A different tab - Google Chrome"
    desktop.titles[202] = "Browser game - Google Chrome"
    assert monitor.find_target_hwnd() == 101


@pytest.mark.parametrize("mismatch", ["title", "exe", "class", "hidden", "minimized", "pid"])
def test_browser_target_needs_a_matching_focused_window(browser_target, mismatch):
    monitor, desktop, _, _, pids, exes = browser_target
    if mismatch == "title":
        desktop.foreground_hwnd = 202
    elif mismatch == "exe":
        exes[101] = "electron.exe"
    elif mismatch == "class":
        desktop.classes[101] = "OtherClass"
    elif mismatch == "hidden":
        desktop.IsWindowVisible = lambda hwnd: False
    elif mismatch == "minimized":
        desktop.IsIconic = lambda hwnd: True
    else:
        pids[101] = 0
    assert monitor.find_target_hwnd() is None


@pytest.mark.parametrize("change", ["closed", "reused-handle", "scene", "source", "removed-source"])
def test_browser_target_is_invalidated_without_adopting_another_browser(browser_target, change):
    monitor, desktop, source, scene, pids, _ = browser_target
    monitor.target_hwnd = monitor.find_target_hwnd()
    assert monitor.target_hwnd == 101
    monitor.last_known_target_hwnd = 101
    desktop.foreground_hwnd = 202
    if change == "closed":
        desktop.windows.remove(101)
    elif change == "reused-handle":
        pids[101] = 9999
    elif change == "scene":
        scene["name"] = "Another scene"
    elif change == "source":
        source["source_name"] = "Another browser capture"
    else:
        source.clear()
    assert monitor.find_target_hwnd() is None
    assert monitor.last_known_target_hwnd is None


def test_desktop_capture_does_not_guess_a_target_from_scene_title(browser_target):
    monitor, desktop, source, _, _, exes = browser_target
    source.clear()
    desktop.classes[101] = "GameWindow"
    exes[101] = "game.exe"
    assert monitor.find_target_hwnd() is None
    assert monitor.last_target_scene_name == "Browser game"


def test_browser_focus_tracking_and_switch_to_desktop_share_capture_state(browser_target, monkeypatch):
    from GameSentenceMiner.util.overlay import capture_state

    monitor, desktop, source, scene, _, _ = browser_target
    clock = {"now": 100.0}
    output = SimpleNamespace(
        current_scene=scene["name"],
        source_output_scene=scene["name"],
        source_output_active=True,
        source_output_checked_at=100.0,
    )
    sent = []

    async def send(_client, payload):
        sent.append(json.loads(payload))

    monkeypatch.setattr(_wwm.time, "time", lambda: clock["now"])
    monkeypatch.setattr(_wwm.websocket_manager, "has_clients", lambda client: True)
    monkeypatch.setattr(_wwm.websocket_manager, "send", send)
    monkeypatch.setattr(
        _wwm, "get_config", lambda: SimpleNamespace(hotkeys=SimpleNamespace(unmute_target_window_on_focus=False))
    )
    monkeypatch.setattr(_wwm, "get_window_rect_physical", lambda hwnd: (50, 60, 450, 360))
    monkeypatch.setattr(monitor, "_check_monitor_topology_changes", lambda: False)
    monkeypatch.setattr(monitor, "_obs_reports_no_output", lambda: False)
    monkeypatch.setattr(monitor, "_obs_reports_output", lambda: True)
    monkeypatch.setattr(monitor, "_sync_minimized_audio_mute", lambda state: None)
    monkeypatch.setattr(monitor, "_is_window_obscured", lambda hwnd: False)
    monkeypatch.setattr(monitor, "_is_fullscreen_window", lambda hwnd: False)
    monkeypatch.setattr(monitor, "_is_exclusive_fullscreen", lambda *args, **kwargs: False)
    monkeypatch.setattr(monitor, "_is_cursor_hidden", lambda: False)
    monkeypatch.setattr(monitor, "update_magpie_info", lambda: None)
    monkeypatch.setattr(monitor, "_spawn_reprocess_last_results", lambda: None)
    monkeypatch.setattr(
        monitor, "_build_client_rect_payload", lambda: {"left": 50, "top": 60, "width": 400, "height": 300}
    )
    monkeypatch.setattr(capture_state, "user32", desktop)
    monkeypatch.setattr(capture_state, "is_windows", lambda: True)
    monkeypatch.setattr(capture_state, "get_obs_state", lambda: output)

    desktop.foreground_hwnd = 202
    asyncio.run(monitor.check_and_send())
    assert monitor.target_hwnd is None
    assert capture_state.get_overlay_capture_state(monitor)["available"] is True
    assert sent[-1]["target_client_rect"] is None

    desktop.foreground_hwnd = 101
    clock["now"] = 101.0
    asyncio.run(monitor.check_and_send())
    assert monitor.target_hwnd == monitor.last_known_target_hwnd == 101
    assert monitor.last_state == "active"
    assert capture_state.get_overlay_capture_state(monitor)["available"] is True

    # A full periodic revalidation must retain the same browser after tab/focus changes.
    desktop.foreground_hwnd = 202
    desktop.titles[101] = "Another tab"
    clock["now"] = 135.0
    asyncio.run(monitor.check_and_send())
    assert monitor.target_hwnd == 101
    assert monitor.last_state == "background"

    source.clear()
    clock["now"] = output.source_output_checked_at = 138.0
    asyncio.run(monitor.check_and_send())
    assert monitor.target_hwnd is None
    assert monitor.last_known_target_hwnd is None
    assert monitor.ever_had_target_hwnd is False
    assert sent[-1]["target_window_rect"] is None
    assert sent[-1]["target_client_rect"] is None
    assert capture_state.get_overlay_capture_state(monitor)["available"] is True
