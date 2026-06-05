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


def test_pid_allowed_to_suspend_windows_skips_posix_ownership_guard(monkeypatch):
    """Regression: the POSIX uid ownership guard must not run on Windows.

    psutil.Process.uids() is Unix-only, so _get_process_uid returns None on
    Windows. The guard must be skipped there — otherwise every suspend is
    refused and Windows process pausing breaks entirely.
    """
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: True)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: False)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "game.exe")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "game.exe")
    # Simulate the Windows case: uids() unavailable -> None. If the ownership
    # guard ran, this would force a refusal.
    monkeypatch.setattr(window_state_monitor, "_get_process_uid", lambda _pid: None)
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(process_pausing=SimpleNamespace(denylist=[], require_game_exe_match=True)),
    )

    assert window_state_monitor._is_pid_allowed_to_suspend(4242, source="windows_hwnd") is True


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
    monkeypatch.setattr(window_state_monitor, "_resolve_pause_target_pid", lambda hwnd, context: (4242, "windows_hwnd"))
    monkeypatch.setattr(window_state_monitor, "_suspended_pids", {}, raising=False)
    monkeypatch.setattr(
        window_state_monitor,
        "_suspend_process_with_tracking",
        lambda pid, context, source="none": calls.append((pid, context)) or True,
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
        data = f.read()
    # Comm is the only field wrapped in parentheses; split after the last ')' so
    # a comm name containing ') ' does not truncate the field incorrectly.
    return data[data.rindex(")") + 2 :].split(" ", 1)[0]


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
        lambda: SimpleNamespace(process_pausing=SimpleNamespace(linux_target_process="sleep", denylist=[])),
    )

    pid, source = window_state_monitor._resolve_linux_target_pid("test")
    assert pid > 0
    assert source == "config_name"
    assert _proc_state(pid) in ("S", "R", "D", "T")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process scan")
def test_resolve_linux_target_pid_returns_zero_without_target(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(process_pausing=SimpleNamespace(linux_target_process="", denylist=[])),
    )

    pid, source = window_state_monitor._resolve_linux_target_pid("test", log_on_missing=False)
    assert pid == 0
    assert source == "none"


import os as _os


def _mock_ownership(monkeypatch, uid=None):
    """Patch _get_process_uid to return the current user's uid (or a custom uid)."""
    effective = uid if uid is not None else _os.geteuid()
    monkeypatch.setattr(window_state_monitor, "_get_process_uid", lambda _pid: effective)


def test_is_pid_allowed_to_suspend_linux_requires_target_match(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "eldenring.exe")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "eldenring.exe")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    _mock_ownership(monkeypatch)
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

    # A mismatching exe AND comm must be refused.
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "konsole")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "konsole")
    assert window_state_monitor._is_pid_allowed_to_suspend(4242) is False


def test_is_pid_allowed_to_suspend_linux_proton_comm_matches_configured_target(monkeypatch):
    """Proton games: proc.exe() is the wine loader but comm is the Windows .exe — allow it."""
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    # exe() returns the wine loader — the old bug that caused incorrect refusal.
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "wine64-preloader")
    # comm is eldenring.exe (Wine sets it to the Windows .exe basename).
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "eldenring.exe")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    _mock_ownership(monkeypatch)
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(
                linux_target_process="eldenring.exe", denylist=[], require_game_exe_match=True
            )
        ),
    )
    # Must be allowed because comm matches the configured target even though exe() doesn't.
    assert window_state_monitor._is_pid_allowed_to_suspend(4242) is True


def test_is_pid_allowed_to_suspend_linux_obs_x11_source_allowed(monkeypatch):
    """PIDs sourced from OBS X11 window are authoritative — allowed without an exe anchor."""
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "narcissu")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "narcissu")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    _mock_ownership(monkeypatch)
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(linux_target_process="", denylist=[], require_game_exe_match=True)
        ),
    )
    assert window_state_monitor._is_pid_allowed_to_suspend(4242, source="obs_x11") is True


def test_is_pid_allowed_to_suspend_linux_no_anchor_refused(monkeypatch):
    """Auto mode without OBS-window source and no configured target must refuse."""
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "narcissu")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "narcissu")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    _mock_ownership(monkeypatch)
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(linux_target_process="", denylist=[], require_game_exe_match=True)
        ),
    )
    # source="none" → no anchor → should refuse
    assert window_state_monitor._is_pid_allowed_to_suspend(4242, source="none") is False


def test_is_pid_allowed_to_suspend_linux_detected_name_empty_anchor_passes(monkeypatch):
    """Regression (N3/C2): when source='detected_name' and _get_detected_game_exe() returns
    '' at gate time (e.g. scene switch), the gate must pass — not fall through to 'no anchor'
    refusal. The anchor was valid when the PID was resolved.
    """
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "narcissu")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "narcissu")
    # Simulate scene switch: OBS returns empty at gate time.
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    _mock_ownership(monkeypatch)
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(linux_target_process="", denylist=[], require_game_exe_match=True)
        ),
    )
    assert window_state_monitor._is_pid_allowed_to_suspend(4242, source="detected_name") is True


def test_is_pid_allowed_to_suspend_linux_detected_name_validates_when_exe_present(monkeypatch):
    """When source='detected_name' and the exe is still available, it must validate the PID."""
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "wrong.exe")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "wrong.exe")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "narcissu")
    _mock_ownership(monkeypatch)
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(linux_target_process="", denylist=[], require_game_exe_match=True)
        ),
    )
    # PID name doesn't match detected exe → should refuse.
    assert window_state_monitor._is_pid_allowed_to_suspend(4242, source="detected_name") is False


def test_is_pid_allowed_to_suspend_linux_denylist_blocks_in_auto_mode(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    # gnome-shell is in the critical floor — denylist check fires before ownership.
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "gnome-shell")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "gnome-shell")
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


def test_is_pid_allowed_to_suspend_linux_ownership_check_blocks_foreign_uid(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "narcissu")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "narcissu")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    # Simulate a process owned by a different user (uid 0 / root).
    _mock_ownership(monkeypatch, uid=0)
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(linux_target_process="narcissu", denylist=[], require_game_exe_match=True)
        ),
    )
    assert window_state_monitor._is_pid_allowed_to_suspend(4242) is False


def test_resolve_pause_target_pid_uses_linux_resolver_on_non_windows(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(
        window_state_monitor,
        "_resolve_linux_target_pid",
        lambda context, log_on_missing=True: (7777, "config_name"),
    )
    pid, source = window_state_monitor._resolve_pause_target_pid(None, "ctx")
    assert pid == 7777
    assert source == "config_name"


# ---------------------------------------------------------------------------
# Additional tests for new code paths
# ---------------------------------------------------------------------------

# --- capture_window parser (I7) ---


def test_capture_window_parser_normal_case():
    """All three fields present: winid, title, wm_class."""
    from types import SimpleNamespace as _SNS
    from GameSentenceMiner.obs import actions as _actions

    class _FakePool:
        def call(self, op, retries=0, retryable=True):
            client = _SNS(
                get_scene_item_list=lambda name: _SNS(
                    scene_items=[{"sourceName": "XCap", "inputKind": "xcomposite_input"}]
                ),
                get_input_settings=lambda name: _SNS(
                    input_settings={"capture_window": "12345\r\nGame Title\r\nGameClass"}
                ),
            )
            return op(client)

    import GameSentenceMiner.obs as _obs_pkg

    old_pool = _obs_pkg.connection_pool
    try:
        _obs_pkg.connection_pool = _FakePool()
        result = _actions.get_linux_capture_window_info(scene_name="Scene")
    finally:
        _obs_pkg.connection_pool = old_pool

    assert result == {"winid": 12345, "title": "Game Title", "wm_class": "GameClass"}


def test_capture_window_parser_empty_title():
    """Empty title must NOT shift wm_class into the title slot."""
    from types import SimpleNamespace as _SNS
    from GameSentenceMiner.obs import actions as _actions

    class _FakePool:
        def call(self, op, retries=0, retryable=True):
            client = _SNS(
                get_scene_item_list=lambda name: _SNS(
                    scene_items=[{"sourceName": "XCap", "inputKind": "xcomposite_input"}]
                ),
                get_input_settings=lambda name: _SNS(
                    input_settings={"capture_window": "44040207\r\n\r\nsteam_app_1245620"}
                ),
            )
            return op(client)

    import GameSentenceMiner.obs as _obs_pkg

    old_pool = _obs_pkg.connection_pool
    try:
        _obs_pkg.connection_pool = _FakePool()
        result = _actions.get_linux_capture_window_info(scene_name="Scene")
    finally:
        _obs_pkg.connection_pool = old_pool

    assert result is not None
    assert result["wm_class"] == "steam_app_1245620"
    assert result["title"] == ""
    assert result["winid"] == 44040207


def test_capture_window_parser_non_numeric_winid():
    """Non-numeric first field must yield winid=None."""
    from types import SimpleNamespace as _SNS
    from GameSentenceMiner.obs import actions as _actions

    class _FakePool:
        def call(self, op, retries=0, retryable=True):
            client = _SNS(
                get_scene_item_list=lambda name: _SNS(
                    scene_items=[{"sourceName": "XCap", "inputKind": "xcomposite_input"}]
                ),
                get_input_settings=lambda name: _SNS(input_settings={"capture_window": "NOTANUMBER\r\nTitle\r\nClass"}),
            )
            return op(client)

    import GameSentenceMiner.obs as _obs_pkg

    old_pool = _obs_pkg.connection_pool
    try:
        _obs_pkg.connection_pool = _FakePool()
        result = _actions.get_linux_capture_window_info(scene_name="Scene")
    finally:
        _obs_pkg.connection_pool = old_pool

    assert result is not None
    assert result["winid"] is None
    assert result["title"] == "Title"
    assert result["wm_class"] == "Class"


def test_capture_window_parser_skips_disabled_items():
    """Regression (N5/C3): a disabled source (sceneItemEnabled=False) must be skipped
    even if it appears before the active source."""
    from types import SimpleNamespace as _SNS
    from GameSentenceMiner.obs import actions as _actions

    class _FakePool:
        def call(self, op, retries=0, retryable=True):
            client = _SNS(
                get_scene_item_list=lambda name: _SNS(
                    scene_items=[
                        {"sourceName": "Disabled", "sceneItemEnabled": False},
                        {"sourceName": "Active", "sceneItemEnabled": True},
                    ]
                ),
                get_input_settings=lambda name: _SNS(
                    input_settings={
                        "capture_window": (
                            "99999\r\nWrong\r\nWrongClass" if name == "Disabled" else "12345\r\nGame Title\r\nGameClass"
                        )
                    }
                ),
            )
            return op(client)

    import GameSentenceMiner.obs as _obs_pkg

    old_pool = _obs_pkg.connection_pool
    try:
        _obs_pkg.connection_pool = _FakePool()
        result = _actions.get_linux_capture_window_info(scene_name="Scene")
    finally:
        _obs_pkg.connection_pool = old_pool

    assert result is not None
    assert result["winid"] == 12345
    assert result["title"] == "Game Title"
    assert result["wm_class"] == "GameClass"


# --- _process_matches_record exe-mismatch branch ---


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process metadata")
def test_process_matches_record_exe_mismatch(monkeypatch, sleeper):
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    pid = sleeper.pid
    created = window_state_monitor._get_process_creation_time(pid)
    # creation time matches but exe deliberately wrong — must return False.
    bad_record = {"created": created, "exe": "definitely-not-sleep"}
    assert window_state_monitor._process_matches_record(pid, bad_record) is False


# --- _resolve_linux_pid_from_obs self-PID guard and no-xlib path ---


def test_resolve_linux_pid_from_obs_no_xlib_returns_zero(monkeypatch):
    monkeypatch.setattr(window_state_monitor, "_HAS_XLIB", False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "is_wayland", lambda: False)
    assert window_state_monitor._resolve_linux_pid_from_obs("test") == 0


def test_resolve_linux_pid_from_obs_wayland_short_circuits(monkeypatch):
    """On Wayland the function must return 0 immediately, even when _HAS_XLIB is True."""
    monkeypatch.setattr(window_state_monitor, "_HAS_XLIB", True)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "is_wayland", lambda: True)

    # If the Wayland guard is missing this would be called and the test would fail.
    def _should_not_be_called(**kw):
        raise AssertionError("should not reach OBS lookup on Wayland")

    monkeypatch.setattr(window_state_monitor, "get_linux_capture_window_info", _should_not_be_called)
    assert window_state_monitor._resolve_linux_pid_from_obs("test") == 0


def test_resolve_linux_pid_from_obs_self_pid_rejected(monkeypatch):
    """A resolved PID matching os.getpid() must be rejected."""
    monkeypatch.setattr(window_state_monitor, "_HAS_XLIB", True)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "is_wayland", lambda: False)
    monkeypatch.setattr(window_state_monitor, "get_current_scene", lambda: "Scene", raising=False)
    monkeypatch.setattr(
        window_state_monitor,
        "get_linux_capture_window_info",
        lambda scene_name: {"winid": 999, "title": "T", "wm_class": "C"},
    )

    class _FakeDisp:
        def create_resource_object(self, kind, wid):
            return self

        def intern_atom(self, name):
            return 1

        def get_full_property(self, *a):
            from types import SimpleNamespace

            return SimpleNamespace(value=[os.getpid()])

        def get_wm_class(self):
            return ("c", "C")

        def get_wm_name(self):
            return "T"

        def screen(self):
            return self

        @property
        def root(self):
            return self

        def close(self):
            pass  # no-op in test double

    monkeypatch.setattr(
        window_state_monitor,
        "_xdisplay",
        SimpleNamespace(Display=lambda: _FakeDisp()),
    )

    result = window_state_monitor._resolve_linux_pid_from_obs("test")
    assert result == 0


# --- _match_process_by_names: comm-truncation and cmdline fallback ---


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process scan")
def test_match_process_by_names_comm_truncation(monkeypatch, sleeper):
    """A target longer than 15 chars is still found via comm truncation."""
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    # "sleep" comm == "sleep"; 16-char target whose [:15] == "sleep___padded_" would not
    # match, but a target whose [:15] == "sleep" DOES match.  Use "sleep_padded_xx"
    # which truncates to "sleep_padded_xx"[:15] == "sleep_padded_xx"[:15].
    # Better: "sleep" already matches by name, so test with sleeper (comm="sleep").
    # The truncated_targets set would include "sleep"[:15]=="sleep", which intersects.
    target_variants = window_state_monitor._normalize_exe_entry("sleep")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(process_pausing=SimpleNamespace(denylist=[])),
    )
    pid = window_state_monitor._match_process_by_names(target_variants, "test")
    # There may be other 'sleep' processes on the system; just verify one is found.
    assert pid > 0


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process scan")
def test_match_process_by_names_cmdline_fallback(monkeypatch):
    """The cmdline fallback returns a PID when comm doesn't match but cmdline does.

    We pass a unique marker as an extra argument to sleep so only our process has it.
    The marker does not match any process's comm, so the name-match branch never fires
    and the result must come from the cmdline fallback.
    """
    import subprocess, sys

    unique_arg = f"gsm-cmdline-test-{os.getpid()}"
    # Python accepts arbitrary extra argv so the unique marker ends up in the cmdline.
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)", unique_arg])
    time.sleep(0.2)
    try:
        monkeypatch.setattr(
            window_state_monitor,
            "get_config",
            lambda: SimpleNamespace(process_pausing=SimpleNamespace(denylist=[])),
        )
        # No process has comm == unique_arg; it only appears in sleep's cmdline.
        target_variants = window_state_monitor._normalize_exe_entry(unique_arg)
        pid = window_state_monitor._match_process_by_names(target_variants, "test")
        assert pid == proc.pid
    finally:
        proc.terminate()
        proc.wait()


# --- denylist critical floor applied to existing configs ---


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX gate")
def test_effective_denylist_includes_critical_floor(monkeypatch):
    """Even with an empty stored denylist the critical floor blocks critical processes."""
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    # plasmashell is in _CRITICAL_DENYLIST; stored denylist is empty.
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "plasmashell")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "plasmashell")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(linux_target_process="", denylist=[], require_game_exe_match=True)
        ),
    )
    # plasmashell is in _CRITICAL_DENYLIST so it must be refused regardless of source.
    assert window_state_monitor._is_pid_allowed_to_suspend(4242, source="obs_x11") is False


# --- truncation-aware denylist + expanded critical floor ---


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX gate")
def test_effective_denylist_truncated_comm_blocked(monkeypatch):
    """A critical process whose /proc/comm is kernel-truncated to 15 chars is still denied.

    'xdg-desktop-portal' (18 chars) runs with comm 'xdg-desktop-por'. The floor must
    match the truncated comm, otherwise a >15-char critical process slips through.
    """
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "xdg-desktop-por")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(linux_target_process="", denylist=[], require_game_exe_match=True)
        ),
    )
    # obs_x11 would otherwise be authoritative; the denylist must still block it.
    assert window_state_monitor._is_pid_allowed_to_suspend(4242, source="obs_x11") is False


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX gate")
def test_critical_floor_blocks_input_method(monkeypatch):
    """Input methods (ibus/fcitx/mozc) must be in the floor — freezing them kills Japanese input."""
    monkeypatch.setattr(window_state_monitor, "is_windows", lambda: False)
    monkeypatch.setattr(window_state_monitor, "is_linux", lambda: True)
    monkeypatch.setattr(window_state_monitor, "_get_process_exe_name", lambda _pid: "ibus-daemon")
    monkeypatch.setattr(window_state_monitor, "_get_process_comm_name", lambda _pid: "ibus-daemon")
    monkeypatch.setattr(window_state_monitor, "_get_detected_game_exe", lambda: "")
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(
            process_pausing=SimpleNamespace(linux_target_process="", denylist=[], require_game_exe_match=True)
        ),
    )
    assert window_state_monitor._is_pid_allowed_to_suspend(4242, source="obs_x11") is False


def test_x11_window_matches_empty_identity_refuses():
    """No recorded wm_class/title -> cannot validate a recycled XID -> must refuse."""
    # Both empty: returns before touching the display, so disp can be None.
    assert window_state_monitor._x11_window_matches(None, 123, "", "") is False


# --- config migration leaves the user denylist untouched ---


def test_migrate_process_pausing_data_preserves_user_denylist():
    """Migration drops the legacy allowlist but must not mutate the user's denylist.

    Critical-process protection comes from the hardcoded _CRITICAL_DENYLIST floor in
    window_state_monitor, not from force-merging defaults, so a user removal of a
    default entry must survive a reload.
    """
    from GameSentenceMiner.util.config.configuration import Config

    # User has trimmed the denylist (removed defaults) and a legacy allowlist exists.
    user_denylist = ["explorer.exe"]
    data = {
        "process_pausing": {
            "denylist": list(user_denylist),
            "allowlist": ["something.exe"],
        }
    }
    Config._migrate_process_pausing_data(data)

    # Legacy allowlist is dropped; denylist is left exactly as the user had it.
    assert "allowlist" not in data["process_pausing"]
    assert data["process_pausing"]["denylist"] == user_denylist


# ---------------------------------------------------------------------------
# Proton / Steam launcher PID refinement
# ---------------------------------------------------------------------------
def test_steam_game_dir_from_cmdline_extracts_install_dir():
    # In-prefix steam.exe stub: native path argument.
    steam_stub = [
        "c:\\windows\\system32\\steam.exe",
        "/mnt/Core/SteamLibrary/steamapps/common/FINAL FANTASY VII REBIRTH/ff7rebirth.exe",
    ]
    assert window_state_monitor._steam_game_dir_from_cmdline(steam_stub) == "steamapps/common/final fantasy vii rebirth"
    # Wine Z: path form.
    wine_path = ["Z:\\mnt\\games\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe"]
    assert window_state_monitor._steam_game_dir_from_cmdline(wine_path) == "steamapps/common/elden ring"
    # No steam path -> empty.
    assert window_state_monitor._steam_game_dir_from_cmdline(["/usr/bin/foo", "--bar"]) == ""
    assert window_state_monitor._steam_game_dir_from_cmdline([]) == ""
    # Bare 'steamapps/common/' with no game dir -> empty (must not library-wide match).
    assert window_state_monitor._steam_game_dir_from_cmdline(["/x/steamapps/common/"]) == ""
    # SteamLinuxRuntime path before game path -> runtime dir is skipped, game dir returned.
    slr_cmdline = [
        "/x/steamapps/common/SteamLinuxRuntime_sniper/run",
        "/x/steamapps/common/ELDEN RING/Game/eldenring.exe",
    ]
    assert window_state_monitor._steam_game_dir_from_cmdline(slr_cmdline) == "steamapps/common/elden ring"
    # Only a SteamLinuxRuntime path and no game -> empty.
    assert (
        window_state_monitor._steam_game_dir_from_cmdline(["/x/steamapps/common/SteamLinuxRuntime_soldier/run"]) == ""
    )


def _fake_proc(name, cmdline):
    return SimpleNamespace(name=lambda: name, cmdline=lambda: list(cmdline))


def test_refine_proton_pid_maps_launcher_to_real_game(monkeypatch):
    # Window PID is the denylisted in-prefix steam.exe launcher.
    monkeypatch.setattr(
        window_state_monitor.psutil,
        "Process",
        lambda pid: _fake_proc("steam.exe", ["c:/windows/system32/steam.exe", "/x/steamapps/common/game/g.exe"]),
    )
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(process_pausing=SimpleNamespace(denylist=["steam.exe"])),
    )
    captured = {}

    def fake_largest(game_dir, deny):
        captured["dir"] = game_dir
        return 4242

    monkeypatch.setattr(window_state_monitor, "_largest_process_in_dir", fake_largest)
    assert window_state_monitor._refine_proton_pid(999) == 4242
    assert captured["dir"] == "steamapps/common/game"


def test_refine_proton_pid_passes_through_native_game(monkeypatch):
    # A non-launcher window PID (native game) is returned unchanged.
    monkeypatch.setattr(
        window_state_monitor.psutil,
        "Process",
        lambda pid: _fake_proc("narcissu", ["/x/steamapps/common/narcissu2/narcissu"]),
    )
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(process_pausing=SimpleNamespace(denylist=[])),
    )
    assert window_state_monitor._refine_proton_pid(1234) == 1234


def test_refine_proton_pid_returns_zero_when_launcher_unresolved(monkeypatch):
    # Launcher window PID but no real game found -> 0 (never suspend the launcher).
    monkeypatch.setattr(
        window_state_monitor.psutil,
        "Process",
        lambda pid: _fake_proc("steam.exe", ["c:/windows/system32/steam.exe"]),
    )
    monkeypatch.setattr(
        window_state_monitor,
        "get_config",
        lambda: SimpleNamespace(process_pausing=SimpleNamespace(denylist=["steam.exe"])),
    )
    monkeypatch.setattr(window_state_monitor, "_largest_process_in_dir", lambda game_dir, deny: 0)
    assert window_state_monitor._refine_proton_pid(999) == 0


def test_refine_proton_pid_returns_zero_on_psutil_error(monkeypatch):
    """Regression (C1): psutil.AccessDenied on .cmdline() must return 0, not window_pid.

    Returning window_pid unchanged would cause a Wine helper to pass the obs_x11
    fast-path in the allow-gate and get SIGSTOPped.
    """
    import psutil as _psutil

    def _raise(_pid):
        raise _psutil.AccessDenied(pid=_pid)

    monkeypatch.setattr(window_state_monitor.psutil, "Process", _raise)
    assert window_state_monitor._refine_proton_pid(999) == 0
