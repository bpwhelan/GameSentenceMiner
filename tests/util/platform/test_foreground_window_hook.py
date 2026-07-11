from __future__ import annotations

import ctypes
from ctypes import wintypes

from GameSentenceMiner.util.platform import foreground_window_hook as hook_module


class _FakeUser32:
    def GetForegroundWindow(self):
        return 101

    def GetWindowTextLengthW(self, hwnd):
        assert hwnd == 101
        return 9

    def GetWindowTextW(self, hwnd, buffer, _length):
        assert hwnd == 101
        buffer.value = "Game Title"
        return len(buffer.value)

    def GetWindowThreadProcessId(self, hwnd, pid_pointer):
        assert hwnd == 101
        ctypes.cast(pid_pointer, ctypes.POINTER(wintypes.DWORD)).contents.value = 321
        return 1


class _FakeProcess:
    def __init__(self, pid):
        assert pid == 321

    def exe(self):
        return r"C:\Games\game.exe"

    def name(self):
        return "game.exe"


def test_resolve_snapshot_reads_foreground_title_and_executable(monkeypatch):
    monkeypatch.setattr(hook_module.psutil, "Process", _FakeProcess)
    watcher = hook_module.ForegroundWindowHook(
        lambda _snapshot: None,
        user32=_FakeUser32(),
        kernel32=object(),
    )

    snapshot = watcher._resolve_snapshot(101)

    assert snapshot is not None
    assert snapshot["hwnd"] == "101"
    assert snapshot["pid"] == 321
    assert snapshot["title"] == "Game Title"
    assert snapshot["executableName"] == "game.exe"


def test_name_change_is_coalesced_to_the_latest_window():
    watcher = hook_module.ForegroundWindowHook(
        lambda _snapshot: None,
        user32=_FakeUser32(),
        kernel32=object(),
    )

    watcher._replace_queued_hwnd(100)
    watcher._replace_queued_hwnd(200)

    assert watcher._latest_hwnd.get_nowait() == 200


def test_non_windows_hook_reports_unsupported(monkeypatch):
    statuses: list[tuple[str, str]] = []
    monkeypatch.setattr(hook_module, "_load_windows_libraries", lambda: (None, None))
    watcher = hook_module.ForegroundWindowHook(
        lambda _snapshot: None,
        lambda status, error="": statuses.append((status, error)),
    )

    assert watcher.start() is False
    assert statuses == [("unsupported", "")]
