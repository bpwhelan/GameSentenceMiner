from __future__ import annotations

import os
import gzip
import sqlite3
import tempfile
import threading
import time
from datetime import datetime

from GameSentenceMiner.util.database import db as db_module
from GameSentenceMiner.util.database.db import (
    AIModelsTable,
    SQLiteDB,
    backup_db,
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


def test_transaction_serializes_writers_across_threads():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    db = SQLiteDB(path)

    try:
        db.execute("CREATE TABLE sample (value TEXT)", commit=True)

        writer_started = threading.Event()
        release_writer = threading.Event()
        writer_b_errors: list[Exception] = []

        def writer_a():
            with db.transaction():
                db.execute("INSERT INTO sample (value) VALUES (?)", ("a",), commit=True)
                writer_started.set()
                assert release_writer.wait(timeout=2)

        def writer_b():
            try:
                conn = db._get_connection()
                conn.execute("PRAGMA busy_timeout = 0")
                db.execute("INSERT INTO sample (value) VALUES (?)", ("b",), commit=True)
            except Exception as exc:  # pragma: no cover - asserted below
                writer_b_errors.append(exc)

        thread_a = threading.Thread(target=writer_a, daemon=True)
        thread_b = threading.Thread(target=writer_b, daemon=True)

        thread_a.start()
        assert writer_started.wait(timeout=1)

        thread_b.start()
        time.sleep(0.1)
        release_writer.set()

        thread_a.join(timeout=1)
        thread_b.join(timeout=1)

        assert writer_b_errors == []
        assert db.fetchone("SELECT COUNT(*) FROM sample") == (2,)
    finally:
        db.close()
        os.unlink(path)


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
