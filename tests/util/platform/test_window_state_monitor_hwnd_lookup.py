import importlib
import sys

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
