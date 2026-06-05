import ctypes
import importlib
import json
import sys
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.config import feature_flags


window_state_monitor = importlib.import_module("GameSentenceMiner.util.platform.window_state_monitor")


class _FakeKernel32:
    def __init__(self, thread_entries, resume_sequences):
        self.thread_entries = list(thread_entries)
        self.resume_sequences = {thread_id: list(sequence) for thread_id, sequence in resume_sequences.items()}
        self._enum_index = -1
        self.closed_handles = []

    def OpenProcess(self, _access, _inherit, _pid):
        return 9001

    def CloseHandle(self, handle):
        self.closed_handles.append(handle)
        return 1

    def CreateToolhelp32Snapshot(self, _flags, _pid):
        self._enum_index = -1
        return 7001

    def Thread32First(self, _snapshot, entry_ptr):
        if not self.thread_entries:
            return 0
        self._enum_index = 0
        self._write_entry(entry_ptr, self.thread_entries[self._enum_index])
        return 1

    def Thread32Next(self, _snapshot, entry_ptr):
        self._enum_index += 1
        if self._enum_index >= len(self.thread_entries):
            return 0
        self._write_entry(entry_ptr, self.thread_entries[self._enum_index])
        return 1

    def OpenThread(self, _access, _inherit, thread_id):
        return thread_id if thread_id in self.resume_sequences else 0

    def ResumeThread(self, thread_handle):
        sequence = self.resume_sequences.get(thread_handle, [])
        if not sequence:
            return 0
        return sequence.pop(0)

    @staticmethod
    def _write_entry(entry_ptr, entry):
        thread_entry = entry_ptr._obj
        thread_entry.th32OwnerProcessID = entry["owner_pid"]
        thread_entry.th32ThreadID = entry["thread_id"]


class _FakeNtdll:
    def __init__(self, status):
        self.status = status

    def NtResumeProcess(self, _process_handle):
        return self.status


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only thread snapshot APIs")
def test_force_resume_process_threads_drains_suspend_counts(monkeypatch):
    fake_kernel32 = _FakeKernel32(
        thread_entries=[
            {"owner_pid": 4242, "thread_id": 101},
            {"owner_pid": 4242, "thread_id": 202},
            {"owner_pid": 9999, "thread_id": 303},
        ],
        resume_sequences={
            101: [3, 2, 1],
            202: [1],
        },
    )

    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: True)
    monkeypatch.setattr(window_state_monitor, "kernel32", fake_kernel32)
    monkeypatch.setattr(
        window_state_monitor,
        "INVALID_HANDLE_VALUE",
        ctypes.c_void_p(-1).value,
        raising=False,
    )

    total_threads, forced_resume_calls, failed_threads = window_state_monitor._force_resume_process_threads(4242)

    assert total_threads == 2
    assert forced_resume_calls == 4
    assert failed_threads == 0


@pytest.mark.skipif(
    sys.platform != "win32",
    reason="Windows-only process resume APIs",
)
def test_resume_process_succeeds_when_thread_force_resume_recovers(monkeypatch):
    fake_kernel32 = _FakeKernel32(
        thread_entries=[
            {"owner_pid": 4242, "thread_id": 101},
        ],
        resume_sequences={
            101: [1],
        },
    )

    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: True)
    monkeypatch.setattr(window_state_monitor, "kernel32", fake_kernel32)
    monkeypatch.setattr(window_state_monitor, "ntdll", _FakeNtdll(status=1))
    monkeypatch.setattr(
        window_state_monitor,
        "INVALID_HANDLE_VALUE",
        ctypes.c_void_p(-1).value,
        raising=False,
    )

    assert window_state_monitor._resume_process(4242) is True


def test_force_resume_suspended_processes_resumes_memory_and_persisted_entries(monkeypatch, tmp_path):
    persisted_file = tmp_path / "suspended_pids.json"
    persisted_file.write_text(
        json.dumps(
            {
                "pids": [
                    {"pid": 5252, "created": 2, "exe": "game2.exe"},
                ]
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(window_state_monitor, "_suspended_pids_file", persisted_file, raising=False)
    monkeypatch.setattr(
        window_state_monitor,
        "_suspended_pids",
        {4242: {"created": 1, "exe": "game1.exe", "suspended_at": 123.0}},
        raising=False,
    )
    monkeypatch.setattr(window_state_monitor, "_overlay_pause_request_pid", 4242, raising=False)
    monkeypatch.setattr(window_state_monitor, "_last_process_pausing_activity_ts", 99.0, raising=False)

    resumed = []

    monkeypatch.setattr(
        window_state_monitor,
        "_process_matches_record",
        lambda pid, record: pid in {4242, 5252},
    )
    monkeypatch.setattr(window_state_monitor, "_resume_process", lambda pid: resumed.append(pid) or True)

    result = window_state_monitor.force_resume_suspended_processes()

    assert result == {
        "total_candidates": 2,
        "resumed": 2,
        "failed": 0,
        "stale": 0,
        "legacy_missing_created": 0,
    }
    assert resumed == [4242, 5252]
    assert window_state_monitor._suspended_pids == {}
    assert window_state_monitor._overlay_pause_request_pid is None
    assert window_state_monitor._last_process_pausing_activity_ts == 0.0
    assert not persisted_file.exists()


def test_pid_allowed_to_suspend_ignores_legacy_allowlist_when_game_exe_does_not_match(monkeypatch):
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(
                denylist=[],
                allowlist=["visual-novel.exe"],
                require_game_exe_match=True,
            )
        ),
    )
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "visual-novel.exe")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "actual-game.exe")

    assert window_state_monitor._is_pid_allowed_to_suspend(1234) is False


def test_overlay_pause_request_uses_profile_gate_without_global_experimental_toggle(monkeypatch):
    profile = SimpleNamespace(process_pausing=SimpleNamespace(enabled=True))
    master = SimpleNamespace(
        experimental=SimpleNamespace(enable_experimental_features=False),
        get_config=lambda: profile,
    )
    calls = []

    monkeypatch.setattr(feature_flags, "get_master_config", lambda: master)
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: True)
    monkeypatch.setattr(window_state_monitor, "user32", object(), raising=False)
    monkeypatch.setattr(
        window_state_monitor,
        "_handle_overlay_pause_request",
        lambda source, hwnd: calls.append((source, hwnd)) or True,
    )

    assert window_state_monitor.request_overlay_process_pause("pause", source="manual", hwnd=123) is True
    assert calls == [("manual", 123)]


def test_hotkey_pause_uses_profile_gate_without_global_experimental_toggle(monkeypatch):
    profile = SimpleNamespace(process_pausing=SimpleNamespace(enabled=True))
    master = SimpleNamespace(
        experimental=SimpleNamespace(enable_experimental_features=False),
        get_config=lambda: profile,
    )
    calls = []

    monkeypatch.setattr(feature_flags, "get_master_config", lambda: master)
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: True)
    monkeypatch.setattr(window_state_monitor, "user32", object(), raising=False)
    monkeypatch.setattr(window_state_monitor, "_resolve_pause_target_pid", lambda hwnd, context: 4242)
    monkeypatch.setattr(window_state_monitor, "_suspended_pids", {}, raising=False)
    monkeypatch.setattr(
        window_state_monitor,
        "_suspend_process_with_tracking",
        lambda pid, context: calls.append((pid, context)) or True,
    )
    monkeypatch.setattr(window_state_monitor, "_clear_overlay_pause_request_state", lambda: None)

    assert window_state_monitor.toggle_active_game_pause(hwnd=123) is True
    assert calls == [(4242, "Pause hotkey")]


# ---------------------------------------------------------------------------
# Linux / POSIX process pausing
# ---------------------------------------------------------------------------
import os
import subprocess
import time


def _proc_state(pid):
    with open(f"/proc/{pid}/stat") as f:
        # state is the field after the (comm) parenthesised name
        return f.read().split(") ", 1)[1].split(" ", 1)[0]


@pytest.fixture
def sleeper():
    proc = subprocess.Popen(["sleep", "600"])
    time.sleep(0.2)
    try:
        yield proc
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux /proc state inspection")
def test_posix_suspend_and_resume_roundtrip(monkeypatch, sleeper):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    pid = sleeper.pid

    assert window_state_monitor._suspend_process(pid) is True
    time.sleep(0.1)
    assert _proc_state(pid) == "T"  # stopped

    assert window_state_monitor._resume_process(pid) is True
    time.sleep(0.1)
    assert _proc_state(pid) in ("S", "R", "D")  # running again


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process metadata via psutil")
def test_posix_creation_time_is_stable_and_matches_record(monkeypatch, sleeper):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    pid = sleeper.pid

    created = window_state_monitor._get_process_creation_time(pid)
    assert created is not None
    assert created == window_state_monitor._get_process_creation_time(pid)

    record = {"created": created, "exe": window_state_monitor._get_process_exe_name(pid)}
    assert window_state_monitor._process_matches_record(pid, record) is True
    # A PID that does not exist must not match.
    assert window_state_monitor._process_matches_record(2**31 - 1, record) is False


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process scan")
def test_resolve_linux_target_pid_matches_configured_name(monkeypatch, sleeper):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(linux_target_process="sleep", denylist=[])
        ),
    )

    resolved = window_state_monitor._resolve_linux_target_pid("test")
    assert resolved > 0
    assert _proc_state(resolved) in ("S", "R", "D", "T")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process scan")
def test_resolve_linux_target_pid_returns_zero_without_target(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(process_pausing=SimpleNamespace(linux_target_process="", denylist=[])),
    )

    assert window_state_monitor._resolve_linux_target_pid("test", log_on_missing=False) == 0


def test_is_pid_allowed_to_suspend_linux_requires_target_match(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "eldenring.exe")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(
                linux_target_process="eldenring.exe", denylist=[], require_game_exe_match=True
            )
        ),
    )
    assert window_state_monitor._is_pid_allowed_to_suspend(4242) is True

    # A mismatching exe must be refused.
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "konsole")
    assert window_state_monitor._is_pid_allowed_to_suspend(4242) is False


def test_is_pid_allowed_to_suspend_linux_auto_mode_allows_non_denylisted(monkeypatch):
    # No explicit target and no OBS-detected exe: auto mode. The PID is assumed to
    # come from the authoritative OBS-capture resolver, so a non-denylisted PID is
    # allowed (the denylist is the only guard).
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "narcissu")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(
                linux_target_process="", denylist=[], require_game_exe_match=True
            )
        ),
    )
    assert window_state_monitor._is_pid_allowed_to_suspend(4242) is True


def test_is_pid_allowed_to_suspend_linux_denylist_blocks_in_auto_mode(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "gnome-shell")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(
                linux_target_process="", denylist=["gnome-shell"], require_game_exe_match=True
            )
        ),
    )
    assert window_state_monitor._is_pid_allowed_to_suspend(4242) is False


def test_resolve_pause_target_pid_uses_linux_resolver_on_non_windows(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(
        window_state_monitor,
        "_resolve_linux_target_pid",
        lambda context, log_on_missing=True: 7777,
    )
    assert window_state_monitor._resolve_pause_target_pid(None, "ctx") == 7777
