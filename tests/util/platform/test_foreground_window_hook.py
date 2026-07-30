from __future__ import annotations

import ctypes
import threading
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


class _MutableForegroundUser32:
    def __init__(self, foreground=101):
        self.foreground = foreground

    def GetForegroundWindow(self):
        return self.foreground

    def GetWindowTextLengthW(self, hwnd):
        return len(f"Window {hwnd}")

    def GetWindowTextW(self, hwnd, buffer, _length):
        buffer.value = f"Window {hwnd}"
        return len(buffer.value)

    def GetWindowThreadProcessId(self, hwnd, pid_pointer):
        ctypes.cast(pid_pointer, ctypes.POINTER(wintypes.DWORD)).contents.value = hwnd
        return 1


class _MutableFakeProcess:
    def __init__(self, pid):
        self.pid = pid

    def exe(self):
        return rf"C:\Games\game-{self.pid}.exe"

    def name(self):
        return f"game-{self.pid}.exe"


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


def test_worker_reconciles_foreground_change_when_followup_event_is_missed(monkeypatch):
    monkeypatch.setattr(hook_module.psutil, "Process", _MutableFakeProcess)
    user32 = _MutableForegroundUser32()
    snapshots = []
    received_latest = threading.Event()

    def on_snapshot(snapshot):
        snapshots.append(snapshot)
        if snapshot["hwnd"] == "101":
            # Model the foreground changing while the first snapshot is being
            # published, without a corresponding second WinEvent reaching us.
            user32.foreground = 202
        elif snapshot["hwnd"] == "202":
            received_latest.set()

    watcher = hook_module.ForegroundWindowHook(
        on_snapshot,
        user32=user32,
        kernel32=object(),
    )
    worker = threading.Thread(target=watcher._worker_loop)
    worker.start()
    watcher._replace_queued_hwnd(101)

    try:
        assert received_latest.wait(timeout=1)
        assert [snapshot["hwnd"] for snapshot in snapshots] == ["101", "202"]
    finally:
        watcher._stop_event.set()
        watcher._replace_queued_hwnd(None)
        worker.join(timeout=1)


def test_worker_reconciles_when_queued_event_is_already_stale(monkeypatch):
    monkeypatch.setattr(hook_module.psutil, "Process", _MutableFakeProcess)
    user32 = _MutableForegroundUser32(foreground=202)
    snapshots = []
    received_latest = threading.Event()

    def on_snapshot(snapshot):
        snapshots.append(snapshot)
        received_latest.set()

    watcher = hook_module.ForegroundWindowHook(
        on_snapshot,
        user32=user32,
        kernel32=object(),
    )
    worker = threading.Thread(target=watcher._worker_loop)
    worker.start()
    watcher._replace_queued_hwnd(101)

    try:
        assert received_latest.wait(timeout=1)
        assert [snapshot["hwnd"] for snapshot in snapshots] == ["202"]
    finally:
        watcher._stop_event.set()
        watcher._replace_queued_hwnd(None)
        worker.join(timeout=1)


def test_force_emit_current_republishes_unchanged_foreground(monkeypatch):
    monkeypatch.setattr(hook_module.psutil, "Process", _MutableFakeProcess)
    user32 = _MutableForegroundUser32()
    snapshots = []
    received_once = threading.Event()
    received_twice = threading.Event()

    def on_snapshot(snapshot):
        snapshots.append(snapshot)
        if len(snapshots) == 1:
            received_once.set()
        elif len(snapshots) == 2:
            received_twice.set()

    watcher = hook_module.ForegroundWindowHook(
        on_snapshot,
        user32=user32,
        kernel32=object(),
    )
    worker = threading.Thread(target=watcher._worker_loop)
    worker.start()
    watcher.emit_current()

    try:
        assert received_once.wait(timeout=1)
        watcher.emit_current(force=True)
        assert received_twice.wait(timeout=1)
        assert [snapshot["hwnd"] for snapshot in snapshots] == ["101", "101"]
        assert [snapshot["sequence"] for snapshot in snapshots] == [1, 2]
    finally:
        watcher._stop_event.set()
        watcher._replace_queued_hwnd(None)
        worker.join(timeout=1)


def test_non_windows_hook_reports_unsupported(monkeypatch):
    statuses: list[tuple[str, str]] = []
    monkeypatch.setattr(hook_module, "_load_windows_libraries", lambda: (None, None))
    watcher = hook_module.ForegroundWindowHook(
        lambda _snapshot: None,
        lambda status, error="": statuses.append((status, error)),
    )

    assert watcher.start() is False
    assert statuses == [("unsupported", "")]
