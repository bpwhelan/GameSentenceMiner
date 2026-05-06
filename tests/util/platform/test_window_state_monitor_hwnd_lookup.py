import importlib


window_state_monitor = importlib.import_module("GameSentenceMiner.util.platform.window_state_monitor")


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


def test_find_target_hwnd_requires_exe_match_for_same_class_candidates(monkeypatch):
    fake_user32 = _FakeUser32ForFind()
    exe_by_hwnd = {
        101: "Tales of Arise.exe",
        202: "MarvelRivals.exe",
    }
    exe_lookups = []

    monkeypatch.setattr(window_state_monitor, "user32", fake_user32)
    monkeypatch.setattr(window_state_monitor.ctypes, "WINFUNCTYPE", lambda *_args: lambda fn: fn, raising=False)
    monkeypatch.setattr(window_state_monitor, "get_current_scene", lambda: "Game Scene")
    monkeypatch.setattr(window_state_monitor, "get_current_game", lambda: "Tales of Arise")
    monkeypatch.setattr(
        window_state_monitor,
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


def test_exe_names_match_normalizes_paths_case_and_extension():
    assert window_state_monitor._exe_names_match(
        r"C:\Games\Tales of Arise\Tales of Arise.exe",
        "tales of arise",
    )
    assert not window_state_monitor._exe_names_match("MarvelRivals.exe", "Tales of Arise.exe")
