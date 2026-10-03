from __future__ import annotations

import ctypes
import threading
from ctypes import wintypes

import pytest

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


class _BackgroundEdenUser32(_FakeUser32):
    def GetForegroundWindow(self):
        return 999

    def IsWindowVisible(self, hwnd):
        return True

    def GetAncestor(self, hwnd, _flags):
        return hwnd


class _EdenProcess(_FakeProcess):
    def exe(self):
        return r"C:\Eden\eden.exe"

    def name(self):
        return "eden.exe"


class _BitnessKernel:
    def __init__(self, process_machine=0, native_machine=0x8664, *, accessible=True, succeeds=True):
        self.process_machine = process_machine
        self.native_machine = native_machine
        self.accessible = accessible
        self.succeeds = succeeds
        self.closed = []

    def OpenProcess(self, access, inherit, pid):
        assert access == 0x1000 and inherit is False and pid == 321
        return 0x100000001 if self.accessible else 0

    def IsWow64Process2(self, handle, process_machine, native_machine):
        assert handle == 0x100000001
        ctypes.cast(process_machine, ctypes.POINTER(wintypes.WORD)).contents.value = self.process_machine
        ctypes.cast(native_machine, ctypes.POINTER(wintypes.WORD)).contents.value = self.native_machine
        return self.succeeds

    def CloseHandle(self, handle):
        self.closed.append(handle)


@pytest.mark.parametrize(
    "process_machine,native_machine,expected",
    [(0, 0x8664, "x64"), (0x14C, 0x8664, "x86"), (0, 0x14C, "x86"), (0, 0xAA64, None)],
)
def test_snapshot_reports_live_process_architecture_without_a_subprocess(
    monkeypatch, process_machine, native_machine, expected
):
    monkeypatch.setattr(hook_module.psutil, "Process", _FakeProcess)
    kernel = _BitnessKernel(process_machine, native_machine)
    watcher = hook_module.ForegroundWindowHook(lambda _: None, user32=_FakeUser32(), kernel32=kernel)
    snapshot = watcher._resolve_snapshot(101)
    assert snapshot.get("processArchitecture") == expected
    assert kernel.closed == [0x100000001]


@pytest.mark.parametrize("accessible,succeeds,closed", [(False, True, []), (True, False, [0x100000001])])
def test_unavailable_architecture_preserves_the_window_snapshot(monkeypatch, accessible, succeeds, closed):
    monkeypatch.setattr(hook_module.psutil, "Process", _FakeProcess)
    kernel = _BitnessKernel(accessible=accessible, succeeds=succeeds)
    watcher = hook_module.ForegroundWindowHook(lambda _: None, user32=_FakeUser32(), kernel32=kernel)
    snapshot = watcher._resolve_snapshot(101)
    assert snapshot["title"] == "Game Title"
    assert snapshot.get("processArchitecture") is None
    assert kernel.closed == closed


def test_background_eden_title_event_is_published_without_changing_foreground(monkeypatch):
    monkeypatch.setattr(hook_module.psutil, "Process", _EdenProcess)
    foreground = []
    emulator = []
    received = threading.Event()

    def on_emulator(snapshot):
        emulator.append(snapshot)
        received.set()

    watcher = hook_module.ForegroundWindowHook(
        foreground.append, on_emulator_snapshot=on_emulator, user32=_BackgroundEdenUser32(), kernel32=_BitnessKernel()
    )
    worker = threading.Thread(target=watcher._emulator_worker_loop)
    worker.start()
    try:
        watcher._handle_window_event(hook_module.EVENT_OBJECT_NAMECHANGE, 101, 0, 0)
        assert received.wait(timeout=1)
        assert foreground == []
        assert emulator[0]["pid"] == 321
        assert emulator[0]["executableName"] == "eden.exe"
        assert emulator[0]["processArchitecture"] == "x64"
    finally:
        watcher._stop_event.set()
        worker.join(timeout=1)


def test_background_discovery_ignores_unrelated_apps_and_child_windows(monkeypatch):
    user32 = _BackgroundEdenUser32()
    watcher = hook_module.ForegroundWindowHook(
        lambda _: None, on_emulator_snapshot=lambda _: None, user32=user32, kernel32=object()
    )
    monkeypatch.setattr(hook_module.psutil, "Process", _FakeProcess)
    assert watcher._resolve_emulator_snapshot(101) is None
    monkeypatch.setattr(hook_module.psutil, "Process", _EdenProcess)
    monkeypatch.setattr(user32, "GetAncestor", lambda _hwnd, _flags: 500)
    assert watcher._resolve_emulator_snapshot(101) is None
    watcher._handle_window_event(hook_module.EVENT_OBJECT_NAMECHANGE, 101, -4, 0)
    assert watcher._emulator_hwnds.empty()


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
