import ctypes
import importlib
import json


window_state_monitor = importlib.import_module(
    "GameSentenceMiner.util.platform.window_state_monitor"
)


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
    monkeypatch.setattr(window_state_monitor, "INVALID_HANDLE_VALUE", ctypes.c_void_p(-1).value, raising=False)

    total_threads, forced_resume_calls, failed_threads = window_state_monitor._force_resume_process_threads(4242)

    assert total_threads == 2
    assert forced_resume_calls == 4
    assert failed_threads == 0


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
    monkeypatch.setattr(window_state_monitor, "INVALID_HANDLE_VALUE", ctypes.c_void_p(-1).value, raising=False)

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

    monkeypatch.setattr(window_state_monitor, "_process_matches_record", lambda pid, record: pid in {4242, 5252})
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
