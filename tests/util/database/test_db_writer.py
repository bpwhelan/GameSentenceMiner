"""Tests for the single-writer SQLiteDB architecture.

All writes are funneled through one dedicated writer thread per SQLiteDB
instance via a priority queue; reads stay on per-thread connections. These tests
pin the behavior that makes the design safe: cross-thread serialization,
foreground-over-background priority, transaction atomicity, no deadlock when a
transaction body issues further writes, non-blocking reads during a write, and
shared-cache visibility for in-memory databases.
"""

from __future__ import annotations

import os
import tempfile
import threading

import pytest

from GameSentenceMiner.util.database.db import (
    DB_PRIORITY_HIGH,
    DB_PRIORITY_LOW,
    DB_PRIORITY_NORMAL,
    SQLiteDB,
)


@pytest.fixture
def db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    database = SQLiteDB(path)
    database.execute("CREATE TABLE sample (value INTEGER)", commit=True)
    try:
        yield database
    finally:
        database.close()
        os.unlink(path)


def test_basic_write_then_read(db):
    result = db.execute("INSERT INTO sample (value) VALUES (?)", (7,), commit=True)
    assert result.lastrowid is not None
    assert db.fetchone("SELECT value FROM sample") == (7,)


def test_writes_from_many_threads_all_persist(db):
    def writer(n: int) -> None:
        db.execute("INSERT INTO sample (value) VALUES (?)", (n,), commit=True)

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(50)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert db.fetchone("SELECT COUNT(*) FROM sample") == (50,)
    assert db.fetchone("SELECT COUNT(DISTINCT value) FROM sample") == (50,)


def test_high_priority_runs_before_low_when_queued_behind_a_busy_writer(db):
    completion_order: list[str] = []
    writer_busy = threading.Event()
    release = threading.Event()

    def occupy(_conn):
        writer_busy.set()
        assert release.wait(timeout=5)

    def record(tag: str):
        def op(_conn):
            completion_order.append(tag)

        return op

    # Occupy the writer so the next two jobs queue up behind it.
    busy = db.run_transaction(occupy, priority=DB_PRIORITY_NORMAL, wait=False)
    assert writer_busy.wait(timeout=5)

    low = db.run_transaction(record("low"), priority=DB_PRIORITY_LOW, wait=False)
    high = db.run_transaction(record("high"), priority=DB_PRIORITY_HIGH, wait=False)

    release.set()
    busy.result(timeout=5)
    low.result(timeout=5)
    high.result(timeout=5)

    assert completion_order == ["high", "low"]


def test_transaction_rolls_back_on_exception(db):
    def op(conn):
        conn.execute("INSERT INTO sample (value) VALUES (99)")
        raise ValueError("boom")

    with pytest.raises(ValueError):
        db.run_transaction(op)

    assert db.fetchone("SELECT COUNT(*) FROM sample") == (0,)


def test_transaction_commits_on_success(db):
    def op(conn):
        conn.execute("INSERT INTO sample (value) VALUES (1)")
        conn.execute("INSERT INTO sample (value) VALUES (2)")
        return "done"

    assert db.run_transaction(op) == "done"
    assert db.fetchone("SELECT COUNT(*) FROM sample") == (2,)


def test_nested_execute_inside_transaction_does_not_deadlock(db):
    def op(_conn):
        # These calls run on the writer thread and must execute inline rather than
        # re-submitting to the queue (which would deadlock).
        db.execute("INSERT INTO sample (value) VALUES (?)", (10,), commit=True)
        db.execute("INSERT INTO sample (value) VALUES (?)", (20,), commit=True)
        # Read-your-writes within the same transaction.
        return db.fetchone("SELECT COUNT(*) FROM sample")

    assert db.run_transaction(op) == (2,)
    assert db.fetchone("SELECT SUM(value) FROM sample") == (30,)


def test_nested_execute_rolls_back_with_the_outer_transaction(db):
    def op(_conn):
        db.execute("INSERT INTO sample (value) VALUES (?)", (10,), commit=True)
        raise RuntimeError("abort")

    with pytest.raises(RuntimeError):
        db.run_transaction(op)

    assert db.fetchone("SELECT COUNT(*) FROM sample") == (0,)


def test_reads_are_not_blocked_by_an_open_write_transaction(db):
    db.execute("INSERT INTO sample (value) VALUES (1)", commit=True)

    writing = threading.Event()
    release = threading.Event()

    def slow_write(conn):
        conn.execute("INSERT INTO sample (value) VALUES (2)")
        writing.set()
        assert release.wait(timeout=5)

    future = db.run_transaction(slow_write, priority=DB_PRIORITY_LOW, wait=False)
    assert writing.wait(timeout=5)

    # The writer is mid-transaction; a reader on this thread still returns the last
    # committed snapshot promptly instead of blocking until the writer commits.
    assert db.fetchone("SELECT COUNT(*) FROM sample") == (1,)

    release.set()
    future.result(timeout=5)
    assert db.fetchone("SELECT COUNT(*) FROM sample") == (2,)


def test_fire_and_forget_write_persists():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    database = SQLiteDB(path)
    try:
        database.execute("CREATE TABLE t (v INTEGER)", commit=True)
        future = database.execute("INSERT INTO t (v) VALUES (5)", commit=True, wait=False)
        future.result(timeout=5)
        assert database.fetchone("SELECT v FROM t") == (5,)
    finally:
        database.close()
        os.unlink(path)


def test_in_memory_database_is_visible_across_threads():
    database = SQLiteDB(":memory:")
    try:
        database.execute("CREATE TABLE t (v INTEGER)", commit=True)
        database.execute("INSERT INTO t (v) VALUES (42)", commit=True)

        seen: list = []

        def reader():
            seen.append(database.fetchone("SELECT v FROM t"))

        thread = threading.Thread(target=reader)
        thread.start()
        thread.join(timeout=5)

        assert seen == [(42,)]
    finally:
        database.close()


def test_read_only_database_rejects_writes():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        seed = SQLiteDB(path)
        seed.execute("CREATE TABLE t (v INTEGER)", commit=True)
        seed.execute("INSERT INTO t (v) VALUES (1)", commit=True)
        seed.close()

        read_only = SQLiteDB(path, read_only=True)
        try:
            assert read_only.fetchone("SELECT v FROM t") == (1,)
            with pytest.raises(RuntimeError):
                read_only.execute("INSERT INTO t (v) VALUES (2)", commit=True)
            with pytest.raises(RuntimeError):
                read_only.run_transaction(lambda conn: conn.execute("INSERT INTO t (v) VALUES (2)"))
        finally:
            read_only.close()
    finally:
        os.unlink(path)


def test_transaction_context_manager_rejects_non_writer_threads(db):
    # The legacy context manager is only valid on the writer thread; cross-thread
    # callers must use run_transaction(fn).
    with pytest.raises(RuntimeError):
        with db.transaction():
            pass
