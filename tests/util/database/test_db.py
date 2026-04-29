from __future__ import annotations

import os
import sqlite3
import tempfile
import threading
import time

from GameSentenceMiner.util.database.db import SQLiteDB, sync_tokenization_schema_state


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
