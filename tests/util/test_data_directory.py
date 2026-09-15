import json
import os
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest

from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.data_directory import get_pointer_path, read_data_dir_pointer
from GameSentenceMiner.util.database import db
from GameSentenceMiner.util.database.data_dir_migration import recover_legacy_database


@pytest.fixture(autouse=True)
def isolated_directories(monkeypatch, tmp_path):
    monkeypatch.setenv("APPDATA", str(tmp_path / "AppData"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    monkeypatch.delenv("GSM_DATA_DIR", raising=False)


def write_pointer(pointer, data):
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(json.dumps(data), encoding="utf-8-sig")


def test_stable_pointer_survives_original_folder_removal(tmp_path):
    legacy_dir = Path(configuration.get_default_app_directory())
    target = tmp_path / "日本語 GSM"
    write_pointer(legacy_dir / "data_dir.json", {"dataDir": str(target)})
    assert configuration.get_app_directory() == str(target)
    pointer = Path.home() / ".config" / "GameSentenceMiner" / "data_dir.json"
    assert json.loads(pointer.read_text(encoding="utf-8"))["version"] == 2
    # On Linux/macOS the original data directory is already the bootstrap directory.
    if legacy_dir != pointer.parent:
        shutil.rmtree(legacy_dir)
        assert configuration.get_app_directory() == str(target)


def test_stable_pointer_and_env_precedence(monkeypatch, tmp_path):
    target = tmp_path / "selected"
    pointer = Path.home() / ".config" / "GameSentenceMiner" / "data_dir.json"
    write_pointer(pointer, {"version": 2, "dataDir": str(target)})
    assert configuration.get_app_directory() == str(target)
    monkeypatch.setenv("GSM_DATA_DIR", str(tmp_path / "override"))
    assert configuration.get_app_directory() == str(tmp_path / "override")


@pytest.mark.parametrize("data", [{"dataDir": None}, {"dataDir": "relative/path"}, [], {"dataDir": " "}])
def test_invalid_stable_pointer_does_not_silently_reset(data):
    write_pointer(Path.home() / ".config" / "GameSentenceMiner" / "data_dir.json", data)
    with pytest.raises(ValueError, match="data_dir.json"):
        configuration.get_app_directory()


def test_database_uses_the_selected_folder(monkeypatch, tmp_path):
    target = tmp_path / "selected"
    monkeypatch.setenv("GSM_DATA_DIR", str(target))
    monkeypatch.setenv("GAME_SENTENCE_MINER_TESTING", "0")
    monkeypatch.delitem(sys.modules, "pytest")
    assert Path(db.get_db_directory()) == target / "gsm.db"


def test_database_test_isolation_still_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("GSM_DATA_DIR", str(tmp_path / "selected"))
    assert Path(db.get_db_directory()).parent == Path(os.environ["GSM_TEST_DATA_ROOT"]) / "database"


def test_database_environment_override_can_bypass_invalid_pointer(monkeypatch, tmp_path):
    write_pointer(get_pointer_path(), {"dataDir": None})
    target = tmp_path / "override"
    monkeypatch.setenv("GSM_DATA_DIR", str(target))
    monkeypatch.setenv("GAME_SENTENCE_MINER_TESTING", "0")
    monkeypatch.delitem(sys.modules, "pytest")
    assert Path(db.get_db_directory()) == target / "gsm.db"


def test_legacy_database_recovery_preserves_newer_wal_and_old_copy(monkeypatch, tmp_path):
    legacy = Path(configuration.get_default_app_directory())
    target = tmp_path / "selected"
    target.mkdir()
    write_pointer(legacy / "data_dir.json", {"dataDir": str(target)})
    with closing(sqlite3.connect(target / "gsm.db")) as connection, connection:
        connection.execute("CREATE TABLE sentences (text TEXT)")
        connection.execute("INSERT INTO sentences VALUES ('stale copy')")
    source = sqlite3.connect(legacy / "gsm.db")
    source.execute("PRAGMA journal_mode=WAL")
    source.execute("CREATE TABLE sentences (text TEXT)")
    source.execute("INSERT INTO sentences VALUES ('newest sentence')")
    source.commit()
    monkeypatch.setenv("GAME_SENTENCE_MINER_TESTING", "0")
    monkeypatch.delitem(sys.modules, "pytest")
    try:
        assert Path(db.get_db_directory()) == target / "gsm.db"
        with closing(sqlite3.connect(target / "gsm.db")) as connection, connection:
            assert connection.execute("SELECT text FROM sentences").fetchall() == [("newest sentence",)]
            connection.execute("INSERT INTO sentences VALUES ('after upgrade')")
        archived = list((target / "backup" / "data-directory-migration").glob("*/gsm.db"))
        assert len(archived) == 1
        with closing(sqlite3.connect(archived[0])) as connection:
            assert connection.execute("SELECT text FROM sentences").fetchall() == [("stale copy",)]
        # Restart must not import the original database a second time.
        db.get_db_directory()
        with closing(sqlite3.connect(target / "gsm.db")) as connection:
            assert connection.execute("SELECT COUNT(*) FROM sentences").fetchone()[0] == 2
        assert source.execute("SELECT text FROM sentences").fetchall() == [("newest sentence",)]
    finally:
        source.close()


def test_failed_recovery_keeps_destination_and_retries_after_source_is_repaired(tmp_path):
    legacy = Path(configuration.get_default_app_directory())
    target = tmp_path / "selected"
    write_pointer(legacy / "data_dir.json", {"dataDir": str(target)})
    configuration.get_app_directory()
    (legacy / "gsm.db").write_bytes(b"broken source")
    (target / "gsm.db").write_bytes(b"keep existing copy")
    with pytest.raises(sqlite3.DatabaseError):
        recover_legacy_database(str(target))
    assert (target / "gsm.db").read_bytes() == b"keep existing copy"
    assert read_data_dir_pointer()["legacyDatabaseDir"] == str(legacy)
    assert not list(target.glob(".gsm-db-migration-*"))
    (legacy / "gsm.db").unlink()
    with closing(sqlite3.connect(legacy / "gsm.db")) as connection:
        connection.execute("CREATE TABLE recovered (value TEXT)")
    recover_legacy_database(str(target))
    assert "legacyDatabaseDir" not in read_data_dir_pointer()
    with closing(sqlite3.connect(target / "gsm.db")) as connection:
        assert connection.execute("SELECT * FROM recovered").fetchall() == []


def test_deleted_legacy_database_does_not_replace_the_destination(tmp_path):
    legacy = Path(configuration.get_default_app_directory())
    target = tmp_path / "selected"
    write_pointer(legacy / "data_dir.json", {"dataDir": str(target)})
    configuration.get_app_directory()
    (target / "gsm.db").write_bytes(b"keep existing copy")
    recover_legacy_database(str(target))
    assert (target / "gsm.db").read_bytes() == b"keep existing copy"
    assert "legacyDatabaseDir" not in read_data_dir_pointer()


def test_environment_override_leaves_another_selection_pending(tmp_path):
    legacy = Path(configuration.get_default_app_directory())
    target = tmp_path / "selected"
    write_pointer(legacy / "data_dir.json", {"dataDir": str(target)})
    configuration.get_app_directory()
    recover_legacy_database(str(tmp_path / "override"))
    assert read_data_dir_pointer()["legacyDatabaseDir"] == str(legacy)


def test_logging_and_speech_resolve_stable_pointer_without_import_cycles(tmp_path):
    target = tmp_path / "selected"
    write_pointer(get_pointer_path(), {"version": 2, "dataDir": str(target)})
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import json; from GameSentenceMiner.util.logging_config import LoggerManager; "
                "from GameSentenceMiner.windows_speech_recognition import get_windows_speech_cache_dir; "
                "print('PATHS=' + json.dumps([str(LoggerManager()._get_app_directory()), str(get_windows_speech_cache_dir())]))"
            ),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    )
    paths = next(line.removeprefix("PATHS=") for line in result.stdout.splitlines() if line.startswith("PATHS="))
    assert json.loads(paths) == [str(target), str(target / "windows-speech")]
