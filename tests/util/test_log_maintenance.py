import os
import zipfile

import pytest

from GameSentenceMiner.util import log_maintenance


def test_migration_consolidates_legacy_logs_and_recovers_temporary_ocr_logs(tmp_path, monkeypatch):
    logs = tmp_path / "logs"
    logs.mkdir()
    monkeypatch.setattr(log_maintenance, "_process_is_running", lambda *_args: False)
    for index in range(8):
        (logs / f"gamesentenceminer.{index + 100}.log").write_text(f"backend event {index}\n")
        (logs / f"error.{index + 100}.log").touch()
    with zipfile.ZipFile(logs / "misc_ocr_utils.100.2026-09-20.log.zip", "w") as archive:
        archive.writestr("ocr.log", "older OCR diagnostic\n")
    temporary = tmp_path / "temp" / "ocr_logs"
    temporary.mkdir(parents=True)
    (temporary / "ocr_process_20260926_000000_100.log").write_text("OCR engine initialized\n")
    (temporary / "ocr_debug_20260926_000000_100.jsonl").write_text('{"event":"ocr.result"}\n')
    native = logs / "ocr"
    native.mkdir()
    (native / "rust-ocr-1790397128541.jsonl").write_text('{"event":"native.start"}\n')
    (logs / "personal-notes.txt").write_text("keep me")

    counts = log_maintenance.maintain_logs(logs)
    assert counts == {"imported": 12, "removed": 8, "skipped": 0}
    assert {p.name for p in logs.iterdir() if p.is_file()} == {"personal-notes.txt", "README.txt"}
    assert "backend event 7" in (logs / "history" / "legacy-backend.log").read_text()
    ocr = (logs / "history" / "legacy-ocr.log").read_text()
    assert "older OCR diagnostic" in ocr
    assert "OCR engine initialized" in ocr
    assert '"event":"ocr.result"' in ocr
    assert '"event":"native.start"' in (logs / "history" / "legacy-native-ocr.log").read_text()
    assert not temporary.exists()
    assert not native.exists()
    before = (logs / "history" / "legacy-backend.log").read_bytes()
    assert log_maintenance.maintain_logs(logs) == {"imported": 0, "removed": 0, "skipped": 0}
    assert (logs / "history" / "legacy-backend.log").read_bytes() == before


def test_cleanup_preserves_active_logs_unknown_files_and_live_legacy_processes(tmp_path):
    history = tmp_path / "history"
    history.mkdir()
    current = tmp_path / "backend.log"
    current.write_text("active log")
    active_legacy = tmp_path / f"gamesentenceminer.{os.getpid()}.log"
    active_legacy.write_text("still open")
    old = history / "ocr.log.1"
    old.write_text("expired")
    unknown = history / "notes.txt"
    unknown.write_text("keep me")
    for file in (current, old, unknown):
        os.utime(file, (1, 1))
    recent = history / "ocr.log.2"
    recent.write_text("recent history")

    counts = log_maintenance.maintain_logs(tmp_path)
    assert counts == {"imported": 0, "removed": 1, "skipped": 1}
    assert all(file.exists() for file in (current, active_legacy, unknown, recent))
    assert not old.exists()


def test_corrupt_legacy_archives_are_left_for_diagnosis(tmp_path):
    source = tmp_path / "gamesentenceminer.log.zip"
    source.write_text("not a zip")
    counts = log_maintenance.maintain_logs(tmp_path)
    assert counts["skipped"] == 1
    assert source.read_text() == "not a zip"


def test_current_process_detection():
    assert log_maintenance._process_is_running(os.getpid())
    assert not log_maintenance._process_is_running(os.getpid(), modified_at=1)


@pytest.mark.skipif(os.name != "nt", reason="Windows keeps old loggers' file handles open")
def test_locked_legacy_log_is_not_repeatedly_copied_into_history(tmp_path):
    source = tmp_path / "anki_card_timing.log"
    with source.open("w") as stream:
        stream.write("still in use")
        stream.flush()
        for _ in range(2):
            assert log_maintenance.maintain_logs(tmp_path)["skipped"] == 1
        assert not (tmp_path / "history").exists()
    assert log_maintenance.maintain_logs(tmp_path)["imported"] == 1
    assert not source.exists()


def test_interrupted_migration_is_recovered(tmp_path, monkeypatch):
    staging = tmp_path / ".migration"
    staging.mkdir()
    source = staging / "gamesentenceminer.12345.log"
    source.write_text("recover this diagnostic")
    monkeypatch.setattr(log_maintenance, "_process_is_running", lambda *_args: False)
    assert log_maintenance.maintain_logs(tmp_path)["imported"] == 1
    assert not staging.exists()
    assert "recover this diagnostic" in (tmp_path / "history" / "legacy-backend.log").read_text()
