"""Crash-safety and failure-recovery coverage for the SQLite core."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from GameSentenceMiner.util.database.db import SQLiteDB
from GameSentenceMiner.util.database import sqlite_core


@pytest.fixture
def database(tmp_path: Path):
    db = SQLiteDB(str(tmp_path / "resilience.db"))
    db.execute("CREATE TABLE sample (value INTEGER UNIQUE)", commit=True)
    try:
        yield db
    finally:
        db.close()


def test_connections_enforce_durable_wal_and_read_safety(database: SQLiteDB):
    writer_settings = database.run_transaction(
        lambda conn: {
            "journal_mode": conn.execute("PRAGMA journal_mode").fetchone()[0],
            "synchronous": conn.execute("PRAGMA synchronous").fetchone()[0],
            "foreign_keys": conn.execute("PRAGMA foreign_keys").fetchone()[0],
            "wal_autocheckpoint": conn.execute("PRAGMA wal_autocheckpoint").fetchone()[0],
        }
    )

    assert writer_settings == {
        "journal_mode": "wal",
        "synchronous": 2,
        "foreign_keys": 1,
        "wal_autocheckpoint": 1000,
    }
    assert database.fetchone("PRAGMA query_only") == (1,)
    assert database.fetchone("PRAGMA foreign_keys") == (1,)


def test_commit_false_cannot_accidentally_write_on_a_read_connection(database: SQLiteDB):
    with pytest.raises(sqlite3.OperationalError, match="readonly"):
        database.execute("INSERT INTO sample (value) VALUES (1)")

    assert database.fetchone("SELECT COUNT(*) FROM sample") == (0,)


def test_failed_batch_is_rolled_back_before_the_writer_is_reused(database: SQLiteDB):
    with pytest.raises(sqlite3.IntegrityError):
        database.executemany(
            "INSERT INTO sample (value) VALUES (?)",
            [(1,), (1,)],
            commit=True,
        )

    database.execute("INSERT INTO sample (value) VALUES (2)", commit=True)

    assert database.fetchall("SELECT value FROM sample ORDER BY value") == [(2,)]


def test_nested_transaction_failure_rolls_back_only_its_savepoint(database: SQLiteDB):
    def outer(conn: sqlite3.Connection) -> None:
        conn.execute("INSERT INTO sample (value) VALUES (1)")

        with pytest.raises(RuntimeError, match="inner failed"):
            database.run_transaction(
                lambda inner_conn: (
                    inner_conn.execute("INSERT INTO sample (value) VALUES (2)"),
                    (_ for _ in ()).throw(RuntimeError("inner failed")),
                )
            )

        conn.execute("INSERT INTO sample (value) VALUES (3)")

    database.run_transaction(outer)

    assert database.fetchall("SELECT value FROM sample ORDER BY value") == [(1,), (3,)]


def test_writer_start_failure_is_reported_instead_of_hanging(database: SQLiteDB, monkeypatch):
    database.close()
    broken = SQLiteDB(":memory:")
    monkeypatch.setattr(broken, "_create_connection", lambda: (_ for _ in ()).throw(OSError("open failed")))

    started = time.perf_counter()
    try:
        with pytest.raises(RuntimeError, match="writer.*start"):
            broken._ensure_writer_started()
    finally:
        broken.close()

    assert time.perf_counter() - started < 1


def test_close_rejects_new_writes_after_shutdown_begins(database: SQLiteDB):
    writer_started = threading.Event()
    release_writer = threading.Event()

    def occupy_writer(_conn: sqlite3.Connection) -> None:
        writer_started.set()
        assert release_writer.wait(timeout=5)

    active_write = database.run_transaction(occupy_writer, wait=False)
    assert writer_started.wait(timeout=5)

    close_errors: list[BaseException] = []

    def close_database() -> None:
        try:
            database.close()
        except BaseException as error:  # pragma: no cover - asserted below
            close_errors.append(error)

    closer = threading.Thread(target=close_database)
    closer.start()
    deadline = time.monotonic() + 2
    while not database._closed and time.monotonic() < deadline:
        time.sleep(0.001)

    try:
        with pytest.raises(RuntimeError, match="clos|shut"):
            database.execute("INSERT INTO sample (value) VALUES (9)", commit=True)
    finally:
        release_writer.set()

    active_write.result(timeout=5)
    closer.join(timeout=5)
    assert not closer.is_alive()
    assert close_errors == []


def test_close_drains_queued_writes_regardless_of_numeric_priority(tmp_path: Path):
    db_path = tmp_path / "priority-close.db"
    database = SQLiteDB(str(db_path))
    database.execute("CREATE TABLE sample (value INTEGER)", commit=True)
    writer_started = threading.Event()
    release_writer = threading.Event()

    active = database.run_transaction(
        lambda _conn: (writer_started.set(), release_writer.wait(timeout=5)),
        wait=False,
    )
    assert writer_started.wait(timeout=5)
    queued = database.execute(
        "INSERT INTO sample (value) VALUES (11)",
        commit=True,
        priority=10_000,
        wait=False,
    )
    closer = threading.Thread(target=database.close)
    closer.start()
    release_writer.set()

    active.result(timeout=5)
    queued.result(timeout=5)
    closer.join(timeout=5)
    assert not closer.is_alive()

    recovered = sqlite3.connect(db_path)
    try:
        assert recovered.execute("SELECT value FROM sample").fetchone() == (11,)
    finally:
        recovered.close()


def test_close_timeout_never_closes_an_active_writer_from_another_thread(tmp_path: Path):
    db_path = tmp_path / "slow-close.db"
    database = SQLiteDB(str(db_path))
    database.execute("CREATE TABLE sample (value INTEGER)", commit=True)
    writer_started = threading.Event()
    release_writer = threading.Event()

    def slow_write(conn: sqlite3.Connection) -> None:
        conn.execute("INSERT INTO sample (value) VALUES (1)")
        writer_started.set()
        assert release_writer.wait(timeout=5)

    write = database.run_transaction(slow_write, wait=False)
    assert writer_started.wait(timeout=5)

    with pytest.raises(TimeoutError, match="close timeout"):
        database.close(timeout=0.01)

    assert not write.done()
    release_writer.set()
    write.result(timeout=5)
    database.close()

    recovered = sqlite3.connect(db_path)
    try:
        assert recovered.execute("PRAGMA quick_check(1)").fetchone() == ("ok",)
        assert recovered.execute("SELECT value FROM sample").fetchone() == (1,)
    finally:
        recovered.close()


def test_close_from_writer_callback_is_rejected_without_poisoning_database(database: SQLiteDB):
    def attempt_close(conn: sqlite3.Connection) -> None:
        with pytest.raises(RuntimeError, match="outside the database writer"):
            database.close()
        conn.execute("INSERT INTO sample (value) VALUES (6)")

    database.run_transaction(attempt_close)

    assert database.fetchone("SELECT value FROM sample") == (6,)


def test_backup_validation_failure_preserves_existing_destination(
    database: SQLiteDB,
    tmp_path: Path,
    monkeypatch,
):
    destination = tmp_path / "existing-backup.db"
    destination.write_bytes(b"previous-good-backup")
    monkeypatch.setattr(
        sqlite_core,
        "verify_connection_integrity",
        lambda _conn: (_ for _ in ()).throw(sqlite_core.DatabaseIntegrityError("damaged snapshot")),
    )

    with pytest.raises(sqlite_core.DatabaseIntegrityError, match="damaged snapshot"):
        database.backup(str(destination))

    assert destination.read_bytes() == b"previous-good-backup"
    assert list(tmp_path.glob(f".{destination.name}.*.tmp")) == []
    database.execute("INSERT INTO sample (value) VALUES (4)", commit=True)
    assert database.fetchone("SELECT value FROM sample") == (4,)


def test_online_backup_does_not_occupy_the_writer(database: SQLiteDB, tmp_path: Path, monkeypatch):
    backup_started = threading.Event()
    release_backup = threading.Event()

    def slow_backup(_source_conn, _destination, **_kwargs) -> None:
        backup_started.set()
        assert release_backup.wait(timeout=5)

    monkeypatch.setattr(sqlite_core, "atomic_sqlite_backup", slow_backup)
    backup_thread = threading.Thread(target=database.backup, args=(str(tmp_path / "snapshot.db"),))
    backup_thread.start()
    assert backup_started.wait(timeout=5)

    try:
        write = database.execute("INSERT INTO sample (value) VALUES (8)", commit=True, wait=False)
        write.result(timeout=1)
    finally:
        release_backup.set()

    backup_thread.join(timeout=5)
    assert not backup_thread.is_alive()
    assert database.fetchone("SELECT value FROM sample") == (8,)


@pytest.mark.parametrize("commit_before_crash", [False, True])
def test_database_recovers_cleanly_after_abrupt_process_exit(tmp_path: Path, commit_before_crash: bool):
    db_path = tmp_path / f"crash-{commit_before_crash}.db"
    seed = SQLiteDB(str(db_path))
    seed.execute("CREATE TABLE sample (value INTEGER)", commit=True)
    seed.close()

    script = f"""
import os
from GameSentenceMiner.util.database.db import SQLiteDB

db = SQLiteDB({json.dumps(str(db_path))})
if {commit_before_crash!r}:
    db.execute("INSERT INTO sample (value) VALUES (1)", commit=True)
    os._exit(91)

def crash_mid_transaction(conn):
    conn.execute("INSERT INTO sample (value) VALUES (1)")
    os._exit(92)

db.run_transaction(crash_mid_transaction)
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).resolve().parents[3],
        env=os.environ.copy(),
        check=False,
        timeout=15,
    )

    assert result.returncode in {91, 92}
    recovered = SQLiteDB(str(db_path), read_only=True)
    try:
        assert recovered.check_integrity() == []
        expected_count = 1 if commit_before_crash else 0
        assert recovered.fetchone("SELECT COUNT(*) FROM sample") == (expected_count,)
    finally:
        recovered.close()


def test_read_only_uri_handles_reserved_path_characters(tmp_path: Path):
    db_path = tmp_path / "reserved # percent %.db"
    writable = SQLiteDB(str(db_path))
    writable.execute("CREATE TABLE sample (value INTEGER)", commit=True)
    writable.execute("INSERT INTO sample (value) VALUES (7)", commit=True)
    writable.close()

    read_only = SQLiteDB(str(db_path), read_only=True)
    try:
        assert read_only.fetchone("SELECT value FROM sample") == (7,)
    finally:
        read_only.close()
