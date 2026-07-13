from __future__ import annotations

import os
import gzip
import sqlite3
import tempfile
import threading
from datetime import datetime
from pathlib import Path

import pytest

from GameSentenceMiner.util.database import db as db_module
from GameSentenceMiner.util.database.db import (
    AIModelsTable,
    SQLiteDB,
    backup_db,
    get_db_directory,
    schedule_database_backup,
    sync_tokenization_schema_state,
)


def test_set_gemini_groq_models_persist_their_input():
    # Regression: set_gemini_models/set_groq_models used to overwrite the `models`
    # param with cls.all(), silently discarding the caller's list.
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    original_db = AIModelsTable._db
    db = SQLiteDB(path)
    try:
        AIModelsTable.set_db(db)

        # create path (no existing row)
        AIModelsTable.set_gemini_models(["gemini-a", "gemini-b"])
        assert AIModelsTable.get_gemini_models() == ["gemini-a", "gemini-b"]

        # update path (existing row) — previously kept the stale/empty list
        AIModelsTable.set_gemini_models(["gemini-c"])
        assert AIModelsTable.get_gemini_models() == ["gemini-c"]

        # groq stored independently and also preserves its input
        AIModelsTable.set_groq_models(["groq-x"])
        assert AIModelsTable.get_groq_models() == ["groq-x"]
        assert AIModelsTable.get_gemini_models() == ["gemini-c"]
    finally:
        db.close()
        AIModelsTable._db = original_db
        os.unlink(path)


def test_read_only_connection_can_query_without_setting_wal():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    try:
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE sample (value INTEGER)")
        conn.execute("INSERT INTO sample (value) VALUES (1)")
        conn.commit()
        conn.close()

        read_only_db = SQLiteDB(path, read_only=True)
        try:
            assert read_only_db.fetchone("SELECT value FROM sample") == (1,)
        finally:
            read_only_db.close()
    finally:
        os.unlink(path)


def test_sync_tokenization_schema_state_skips_read_only_db(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    try:
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE game_lines (id TEXT PRIMARY KEY)")
        conn.commit()
        conn.close()

        read_only_db = SQLiteDB(path, read_only=True)
        monkeypatch.setattr("GameSentenceMiner.util.database.db._is_tokenization_enabled", lambda: False)

        try:
            sync_tokenization_schema_state(read_only_db)
            assert read_only_db.table_exists("game_lines") is True
            columns = read_only_db.fetchall("PRAGMA table_info(game_lines)")
            assert [column[1] for column in columns] == ["id"]
        finally:
            read_only_db.close()
    finally:
        os.unlink(path)


def test_writes_from_multiple_threads_serialize_through_the_writer():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    db = SQLiteDB(path)

    try:
        db.execute("CREATE TABLE sample (value TEXT)", commit=True)

        errors: list[Exception] = []

        def writer(value: str):
            try:
                db.execute("INSERT INTO sample (value) VALUES (?)", (value,), commit=True)
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)

        thread_a = threading.Thread(target=writer, args=("a",), daemon=True)
        thread_b = threading.Thread(target=writer, args=("b",), daemon=True)

        thread_a.start()
        thread_b.start()
        thread_a.join(timeout=2)
        thread_b.join(timeout=2)

        # No cross-thread lock contention and no "database is locked" errors: both
        # writes are serialized on the single writer thread and both persist.
        assert errors == []
        assert db.fetchone("SELECT COUNT(*) FROM sample") == (2,)
    finally:
        db.close()
        os.unlink(path)


def test_persistent_database_rejects_unscoped_gameline_wipes(monkeypatch, tmp_path):
    monkeypatch.setenv("GAME_SENTENCE_MINER_TESTING", "1")
    test_root = tmp_path / "isolated-tests"
    monkeypatch.setenv("GSM_TEST_DATA_ROOT", str(test_root))
    monkeypatch.delenv("GSM_ALLOW_DESTRUCTIVE_DB_OPERATIONS", raising=False)
    path = test_root / "persistent" / "persistent.db"
    path.parent.mkdir(parents=True)
    db = SQLiteDB(str(path), force_gameline_protection=True)

    try:
        db.execute("CREATE TABLE game_lines (id TEXT PRIMARY KEY)", commit=True)
        db.execute("INSERT INTO game_lines (id) VALUES (?)", ("keep-me",), commit=True)

        with pytest.raises(RuntimeError, match="Refusing to clear the entire game_lines table"):
            db.execute("DELETE FROM game_lines", commit=True)

        with pytest.raises(RuntimeError, match="Refusing to drop the game_lines table"):
            db.execute("DROP TABLE IF EXISTS game_lines", commit=True)

        assert db.fetchone("SELECT id FROM game_lines") == ("keep-me",)

        db.execute("DELETE FROM game_lines WHERE id = ?", ("keep-me",), commit=True)
        assert db.fetchone("SELECT COUNT(*) FROM game_lines") == (0,)
    finally:
        db.close()


def test_pytest_process_refuses_database_outside_isolated_root(monkeypatch, tmp_path):
    test_root = tmp_path / "isolated-tests"
    external_path = tmp_path / "production" / "gsm.db"
    monkeypatch.setenv("GAME_SENTENCE_MINER_TESTING", "1")
    monkeypatch.setenv("GSM_TEST_DATA_ROOT", str(test_root))

    with pytest.raises(RuntimeError, match="outside GSM_TEST_DATA_ROOT"):
        SQLiteDB(str(external_path))

    assert not external_path.exists()


def test_testing_database_path_is_separate_from_production(monkeypatch, tmp_path):
    test_root = tmp_path / "isolated-tests"
    monkeypatch.setenv("GAME_SENTENCE_MINER_TESTING", "1")
    monkeypatch.setenv("GSM_TEST_DATA_ROOT", str(test_root))
    monkeypatch.setenv("APPDATA", str(tmp_path / "production-appdata"))

    path = get_db_directory()

    assert Path(path) == test_root / "database" / "gsm_test.db"


def test_pytest_module_database_is_inside_the_isolated_test_root():
    test_root = Path(os.environ["GSM_TEST_DATA_ROOT"]).resolve()
    active_db_path = Path(db_module.db_path).resolve()

    assert active_db_path.is_relative_to(test_root)
    assert active_db_path.name == "gsm_test.db"


def test_backup_db_uses_online_snapshot_that_includes_wal_changes(tmp_path):
    db_path = tmp_path / "wal-source.db"
    restored_path = tmp_path / "restored.db"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE sample (value TEXT)")
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

        conn.execute("INSERT INTO sample (value) VALUES ('from wal')")
        conn.commit()

        backup_path = backup_db(str(db_path), now=datetime(2026, 1, 1))
    finally:
        conn.close()

    assert backup_path is not None
    assert backup_path.endswith(os.path.join("backup", "database", "gsm_2026-01-01.db.gz"))

    with gzip.open(backup_path, "rb") as source, open(restored_path, "wb") as restored:
        restored.write(source.read())

    restored_conn = sqlite3.connect(restored_path)
    try:
        assert restored_conn.execute("SELECT value FROM sample").fetchone() == ("from wal",)
    finally:
        restored_conn.close()


def test_backup_db_skips_existing_daily_backup_without_copying(tmp_path, monkeypatch):
    db_path = tmp_path / "source.db"
    sqlite3.connect(db_path).close()

    backup_dir = tmp_path / "backup" / "database"
    backup_dir.mkdir(parents=True)
    existing_backup = backup_dir / "gsm_2026-01-01.db.gz"
    existing_backup.write_bytes(b"already backed up")

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("backup should not run when today's backup already exists")

    monkeypatch.setattr(db_module, "_create_sqlite_backup", fail_if_called)

    assert backup_db(str(db_path), now=datetime(2026, 1, 1)) is None
    assert existing_backup.read_bytes() == b"already backed up"


def test_backup_db_prunes_expired_daily_backups(tmp_path):
    db_path = tmp_path / "source.db"
    sqlite3.connect(db_path).close()

    backup_dir = tmp_path / "backup" / "database"
    backup_dir.mkdir(parents=True)
    expired_backup = backup_dir / "gsm_2025-12-01.db.gz"
    expired_backup.write_bytes(b"old")
    recent_backup = backup_dir / "gsm_2025-12-31.db.gz"
    recent_backup.write_bytes(b"recent")

    now = datetime(2026, 1, 1)
    now_timestamp = now.timestamp()
    os.utime(
        expired_backup,
        (
            now_timestamp - 6 * 24 * 60 * 60,
            now_timestamp - 6 * 24 * 60 * 60,
        ),
    )
    os.utime(
        recent_backup,
        (
            now_timestamp - 2 * 24 * 60 * 60,
            now_timestamp - 2 * 24 * 60 * 60,
        ),
    )

    backup_db(str(db_path), now=now)

    assert not expired_backup.exists()
    assert recent_backup.exists()


def test_schedule_database_backup_runs_on_daemon_thread_without_waiting(tmp_path, monkeypatch):
    monkeypatch.delenv("GSM_DISABLE_DB_BACKUP", raising=False)
    db_path = tmp_path / "source.db"
    sqlite3.connect(db_path).close()
    backup_started = threading.Event()
    release_backup = threading.Event()

    def fake_backup(path):
        backup_started.set()
        assert path == str(db_path)
        assert release_backup.wait(timeout=2)

    monkeypatch.setattr(db_module, "backup_db", fake_backup)

    thread = schedule_database_backup(str(db_path))

    assert thread is not None
    assert thread.daemon is True
    assert backup_started.wait(timeout=1)
    assert thread.is_alive()

    release_backup.set()
    thread.join(timeout=1)
    assert not thread.is_alive()
