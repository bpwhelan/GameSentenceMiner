"""Durable, concurrent SQLite primitives used by GameSentenceMiner.

The application has one writer thread per process and one read connection per
calling thread.  Writes are explicit transactions on the writer connection;
read connections are ``query_only`` so a missing ``commit=True`` cannot create a
second, accidental writer.  WAL keeps reads concurrent with writes, while FULL
synchronous mode preserves acknowledged commits across an OS or power failure.
"""

from __future__ import annotations

import concurrent.futures
import itertools
import os
import queue
import sqlite3
import sys
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple, Union
from urllib.parse import quote


DB_PRIORITY_HIGH = 0
DB_PRIORITY_NORMAL = 50
DB_PRIORITY_LOW = 100

SQLITE_BUSY_TIMEOUT_MS = 30_000
SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1_000
SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024
SQLITE_WRITER_START_TIMEOUT_SECONDS = 10.0
SQLITE_CLOSE_TIMEOUT_SECONDS = 30.0
SQLITE_WRITE_QUEUE_SIZE = 4_096
SQLITE_CACHED_STATEMENTS = 256

_WRITER_SHUTDOWN = object()


class DatabaseIntegrityError(sqlite3.DatabaseError):
    """Raised when SQLite reports structural damage in a database."""


class _WriteResult:
    """Thread-safe subset of a cursor result returned by a routed write."""

    __slots__ = ("lastrowid", "rowcount")

    def __init__(self, lastrowid: Optional[int], rowcount: int):
        self.lastrowid = lastrowid
        self.rowcount = rowcount


def sqlite_file_uri(path: Union[str, os.PathLike[str]], mode: str) -> str:
    """Build an escaped SQLite file URI, including for Windows paths."""

    if mode not in {"ro", "rw", "rwc"}:
        raise ValueError(f"Unsupported SQLite URI mode: {mode}")
    resolved = Path(path).resolve()
    encoded_path = quote(resolved.as_posix(), safe="/:")
    return f"file:{encoded_path}?mode={mode}"


def connection_integrity_errors(
    conn: sqlite3.Connection,
    *,
    full: bool = False,
    max_errors: int = 1,
) -> List[str]:
    """Return SQLite integrity diagnostics; an empty list means the DB is healthy."""

    limit = max(1, int(max_errors))
    pragma = "integrity_check" if full else "quick_check"
    rows = conn.execute(f"PRAGMA {pragma}({limit})").fetchall()
    return [str(row[0]) for row in rows if row and str(row[0]).lower() != "ok"]


def verify_connection_integrity(
    conn: sqlite3.Connection,
    *,
    full: bool = False,
    max_errors: int = 1,
) -> None:
    """Raise :class:`DatabaseIntegrityError` when a check finds corruption."""

    errors = connection_integrity_errors(conn, full=full, max_errors=max_errors)
    if errors:
        raise DatabaseIntegrityError("SQLite integrity check failed: " + "; ".join(errors))


def _sync_file(path: Path) -> None:
    # Windows' FlushFileBuffers rejects the read-only handle returned by ``rb``.
    with path.open("r+b") as handle:
        os.fsync(handle.fileno())


def _sync_parent_directory(path: Path) -> None:
    """Persist a rename on platforms that support fsync on directories."""

    if os.name == "nt":
        return
    descriptor: Optional[int] = None
    try:
        descriptor = os.open(path.parent, os.O_RDONLY)
        os.fsync(descriptor)
    finally:
        if descriptor is not None:
            os.close(descriptor)


def durable_replace(source: Union[str, os.PathLike[str]], destination: Union[str, os.PathLike[str]]) -> None:
    """Atomically replace a file and sync the containing directory when possible."""

    destination_path = Path(destination)
    os.replace(source, destination_path)
    _sync_parent_directory(destination_path)


def atomic_sqlite_backup(
    source_conn: sqlite3.Connection,
    destination_path: Union[str, os.PathLike[str]],
    *,
    pages: int = -1,
    sleep: float = 0.250,
) -> None:
    """Create, verify, sync, and atomically publish an SQLite snapshot."""

    destination = Path(destination_path)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        backup_conn = sqlite3.connect(
            temporary,
            timeout=SQLITE_BUSY_TIMEOUT_MS / 1_000,
            isolation_level=None,
            check_same_thread=False,
        )
        try:
            backup_conn.execute("PRAGMA synchronous = FULL")
            source_conn.backup(backup_conn, pages=pages, sleep=sleep)
            verify_connection_integrity(backup_conn)
        finally:
            backup_conn.close()

        _sync_file(temporary)
        durable_replace(temporary, destination)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


class SQLiteDB:
    """Crash-resilient SQLite access with concurrent reads and serialized writes.

    ``execute(..., commit=True)``, ``executemany(..., commit=True)``, and
    ``run_transaction`` are routed through one priority-aware writer thread.
    Reads use per-thread query-only connections, which remain concurrent under
    WAL.  Every successful write call is an explicit transaction.
    """

    def __init__(self, db_path: str, read_only: bool = False, force_gameline_protection: bool = False):
        self.db_path = db_path
        self.read_only = read_only
        testing_process = os.environ.get("GAME_SENTENCE_MINER_TESTING", "0") == "1" or "pytest" in sys.modules
        test_data_root = os.environ.get("GSM_TEST_DATA_ROOT", "").strip()
        is_isolated_test_database = (
            testing_process and bool(test_data_root) and self._path_is_within(db_path, test_data_root)
        )
        external_read_allowed = read_only and os.environ.get("GSM_ALLOW_TEST_EXTERNAL_DB_READ_ONLY", "0") == "1"
        if testing_process and db_path != ":memory:" and not is_isolated_test_database and not external_read_allowed:
            raise RuntimeError(f"Refusing to open database outside GSM_TEST_DATA_ROOT from a test process: {db_path}")
        self._allow_destructive_gameline_operations = not force_gameline_protection and (
            db_path == ":memory:"
            or is_isolated_test_database
            or os.environ.get("GSM_ALLOW_DESTRUCTIVE_DB_OPERATIONS", "0") == "1"
        )
        self._resolved_uri, self._uri_mode = self._resolve_connection_target(db_path, read_only)

        self._local = threading.local()
        self._read_connections: List[sqlite3.Connection] = []
        self._read_conn_lock = threading.Lock()

        self._write_queue: queue.PriorityQueue = queue.PriorityQueue(maxsize=SQLITE_WRITE_QUEUE_SIZE)
        self._seq = itertools.count()
        self._savepoint_seq = itertools.count()
        self._writer_thread: Optional[threading.Thread] = None
        self._writer_start_lock = threading.Lock()
        self._lifecycle_lock = threading.RLock()
        self._writer_ready: Optional[threading.Event] = None
        self._writer_start_error: Optional[BaseException] = None
        self._writer_failure: Optional[BaseException] = None
        self._write_conn: Optional[sqlite3.Connection] = None
        self._write_tx_depth = 0
        self._closed = False
        self._shutdown_enqueued = False
        self._pending_futures: set[concurrent.futures.Future] = set()
        self._async_write_errors: List[BaseException] = []

    @staticmethod
    def _resolve_connection_target(db_path: str, read_only: bool) -> Tuple[str, bool]:
        if db_path == ":memory:":
            return f"file:gsm_mem_{uuid.uuid4().hex}?mode=memory&cache=shared", True
        if read_only:
            return sqlite_file_uri(db_path, "ro"), True
        return db_path, False

    @staticmethod
    def _path_is_within(path: str, root: str) -> bool:
        if not path or not root:
            return False
        try:
            normalized_path = os.path.normcase(os.path.abspath(path))
            normalized_root = os.path.normcase(os.path.abspath(root))
            return os.path.commonpath((normalized_path, normalized_root)) == normalized_root
        except (OSError, ValueError):
            return False

    def _on_writer_thread(self) -> bool:
        return threading.current_thread() is self._writer_thread

    def _create_connection(self) -> sqlite3.Connection:
        """Open and configure either the writer or a query-only reader."""

        conn = sqlite3.connect(
            self._resolved_uri,
            uri=self._uri_mode,
            timeout=SQLITE_BUSY_TIMEOUT_MS / 1_000,
            isolation_level=None,
            check_same_thread=False,
            cached_statements=SQLITE_CACHED_STATEMENTS,
        )
        try:
            conn.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
            conn.execute("PRAGMA foreign_keys = ON")
            if self._on_writer_thread() and not self.read_only:
                journal_mode = str(conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]).lower()
                if self.db_path != ":memory:" and journal_mode != "wal":
                    raise sqlite3.OperationalError(f"SQLite refused WAL journal mode (using {journal_mode!r})")
                conn.execute("PRAGMA synchronous = FULL")
                conn.execute(f"PRAGMA wal_autocheckpoint = {SQLITE_WAL_AUTOCHECKPOINT_PAGES}")
                conn.execute(f"PRAGMA journal_size_limit = {SQLITE_JOURNAL_SIZE_LIMIT_BYTES}")
            else:
                conn.execute("PRAGMA query_only = ON")
            return conn
        except BaseException:
            conn.close()
            raise

    def _ensure_writer_started(self) -> None:
        if self.read_only:
            raise RuntimeError("Cannot write in read-only mode.")

        with self._writer_start_lock:
            with self._lifecycle_lock:
                if self._closed:
                    raise RuntimeError("Cannot write to a closed or closing database.")
                if self._writer_failure is not None:
                    raise RuntimeError("Database writer is unavailable.") from self._writer_failure
                thread = self._writer_thread
                if thread is not None and thread.is_alive():
                    return

                ready = threading.Event()
                self._writer_ready = ready
                self._writer_start_error = None
                thread = threading.Thread(
                    target=self._writer_loop,
                    args=(ready,),
                    name="gsm-db-writer",
                    daemon=False,
                )
                self._writer_thread = thread
                thread.start()

            if not ready.wait(timeout=SQLITE_WRITER_START_TIMEOUT_SECONDS):
                error = TimeoutError("Timed out while starting the database writer")
                with self._lifecycle_lock:
                    self._writer_failure = error
                raise RuntimeError("Database writer failed to start.") from error

            with self._lifecycle_lock:
                start_error = self._writer_start_error
                closed = self._closed
            if start_error is not None:
                raise RuntimeError("Database writer failed to start.") from start_error
            if closed:
                raise RuntimeError("Cannot write to a closed or closing database.")

    def _writer_loop(self, ready: threading.Event) -> None:
        conn: Optional[sqlite3.Connection] = None
        graceful_shutdown = False
        try:
            try:
                conn = self._create_connection()
                with self._lifecycle_lock:
                    self._write_conn = conn
            except BaseException as error:
                with self._lifecycle_lock:
                    self._writer_start_error = error
                    self._writer_failure = error
                return
            finally:
                ready.set()

            while True:
                _priority, _seq, fn, future = self._write_queue.get()
                try:
                    if fn is _WRITER_SHUTDOWN:
                        graceful_shutdown = True
                        future.set_result(None)
                        break
                    if not future.set_running_or_notify_cancel():
                        continue
                    try:
                        result = fn(conn)
                    except BaseException as error:  # noqa: BLE001 - delivered through Future
                        if conn.in_transaction:
                            try:
                                conn.rollback()
                            except sqlite3.Error:
                                pass
                        future.set_exception(error)
                    else:
                        future.set_result(result)
                finally:
                    self._write_queue.task_done()
        except BaseException as error:  # noqa: BLE001 - make a dead writer observable
            with self._lifecycle_lock:
                self._writer_failure = error
            self._fail_queued_writes(error)
        finally:
            if conn is not None:
                if conn.in_transaction:
                    try:
                        conn.rollback()
                    except sqlite3.Error:
                        pass
                if graceful_shutdown and self.db_path != ":memory:":
                    try:
                        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
                    except sqlite3.Error:
                        pass
                conn.close()
            with self._lifecycle_lock:
                self._write_conn = None

    def _fail_queued_writes(self, cause: BaseException) -> None:
        while True:
            try:
                _priority, _seq, fn, future = self._write_queue.get_nowait()
            except queue.Empty:
                return
            try:
                if not future.done():
                    future.set_exception(RuntimeError("Database writer stopped before executing this write"))
            finally:
                self._write_queue.task_done()

    def _submit(
        self,
        fn: Callable[[sqlite3.Connection], Any],
        priority: int,
    ) -> concurrent.futures.Future:
        self._ensure_writer_started()
        future: concurrent.futures.Future = concurrent.futures.Future()
        with self._lifecycle_lock:
            if self._closed:
                raise RuntimeError("Cannot write to a closed or closing database.")
            if self._writer_failure is not None:
                raise RuntimeError("Database writer is unavailable.") from self._writer_failure
            thread = self._writer_thread
            if thread is None or not thread.is_alive():
                raise RuntimeError("Database writer stopped unexpectedly.")
            try:
                self._write_queue.put((priority, next(self._seq), fn, future), timeout=0.25)
            except queue.Full as error:
                raise RuntimeError("Database writer mailbox is backpressured") from error
        return future

    def _record_async_result(self, future: concurrent.futures.Future) -> None:
        with self._lifecycle_lock:
            self._pending_futures.discard(future)
            if not future.cancelled():
                error = future.exception()
                if error is not None:
                    self._async_write_errors.append(error)

    def _submit_and_maybe_wait(
        self,
        fn: Callable[[sqlite3.Connection], Any],
        priority: int,
        wait: bool,
    ) -> Any:
        future = self._submit(fn, priority)
        if wait:
            return future.result()
        with self._lifecycle_lock:
            self._pending_futures.add(future)
        future.add_done_callback(self._record_async_result)
        return future

    @contextmanager
    def _transaction_scope(self) -> Iterator[sqlite3.Connection]:
        conn = self._write_conn
        if conn is None:
            raise RuntimeError("Database writer connection is unavailable.")

        is_outermost = self._write_tx_depth == 0
        savepoint = None if is_outermost else f"gsm_nested_{next(self._savepoint_seq)}"
        if is_outermost:
            conn.execute("BEGIN IMMEDIATE")
        else:
            conn.execute(f"SAVEPOINT {savepoint}")
        self._write_tx_depth += 1

        try:
            yield conn
        except BaseException:
            self._write_tx_depth -= 1
            try:
                if is_outermost:
                    if conn.in_transaction:
                        conn.rollback()
                else:
                    conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                    conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            except sqlite3.Error:
                pass
            raise
        else:
            self._write_tx_depth -= 1
            try:
                if is_outermost:
                    conn.commit()
                else:
                    conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            except BaseException:
                try:
                    if is_outermost:
                        if conn.in_transaction:
                            conn.rollback()
                    else:
                        conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                        conn.execute(f"RELEASE SAVEPOINT {savepoint}")
                except sqlite3.Error:
                    pass
                raise

    def _run_tx_inline(self, fn: Callable[[sqlite3.Connection], Any]) -> Any:
        with self._transaction_scope() as conn:
            return fn(conn)

    def run_transaction(
        self,
        fn: Callable[[sqlite3.Connection], Any],
        priority: int = DB_PRIORITY_NORMAL,
        wait: bool = True,
    ) -> Any:
        if self.read_only:
            raise RuntimeError("Cannot start a write transaction in read-only mode.")
        if self._on_writer_thread():
            return self._run_tx_inline(fn)
        return self._submit_and_maybe_wait(lambda _conn: self._run_tx_inline(fn), priority, wait)

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Open a nested-safe transaction from code already on the writer thread."""

        if self.read_only:
            raise RuntimeError("Cannot start a write transaction in read-only mode.")
        if not self._on_writer_thread():
            raise RuntimeError(
                "SQLiteDB.transaction() must run on the writer thread; use run_transaction(fn) from other threads."
            )
        with self._transaction_scope() as conn:
            yield conn

    def delete_where_in(
        self,
        table: str,
        column: str,
        values: List[Any],
        chunk_size: int = 500,
        priority: int = DB_PRIORITY_NORMAL,
    ) -> int:
        unique_values = [value for value in dict.fromkeys(values) if value is not None]
        if not unique_values:
            return 0

        def op(conn: sqlite3.Connection) -> int:
            deleted_count = 0
            for start in range(0, len(unique_values), chunk_size):
                chunk = unique_values[start : start + chunk_size]
                placeholders = ",".join("?" for _ in chunk)
                cursor = conn.execute(
                    f"DELETE FROM {table} WHERE {column} IN ({placeholders})",
                    tuple(chunk),
                )
                if cursor.rowcount is not None and cursor.rowcount > 0:
                    deleted_count += cursor.rowcount
            return deleted_count

        return self.run_transaction(op, priority=priority)

    def backup(self, backup_path: str) -> None:
        """Create a verified snapshot and atomically replace ``backup_path``."""

        if self.read_only:
            raise RuntimeError("Cannot backup a database opened in read-only mode.")
        # First form a barrier behind writes already in the mailbox. The online
        # backup itself then uses this caller's query-only connection so copying
        # and verification do not occupy the sole writer for a large database.
        self._submit(lambda _conn: None, DB_PRIORITY_LOW).result()
        atomic_sqlite_backup(
            self._get_read_connection(),
            backup_path,
            pages=512,
            sleep=0.050,
        )

    def _get_read_connection(self) -> sqlite3.Connection:
        if self._on_writer_thread():
            conn = self._write_conn
            if conn is None:
                raise RuntimeError("Database writer connection is unavailable.")
            return conn
        # This lock-free check is on the read hot path. Application shutdown stops
        # reader owners before close(); a concurrent misuse may still receive the
        # same closed-connection error it would have received after taking a lock.
        if self._closed:
            raise RuntimeError("Cannot read from a closed or closing database.")
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._create_connection()
            self._local.conn = conn
            with self._read_conn_lock:
                self._read_connections.append(conn)
        return conn

    def execute(
        self,
        query: str,
        params: Union[Tuple, Dict] = (),
        commit: bool = False,
        priority: int = DB_PRIORITY_NORMAL,
        wait: bool = True,
    ) -> Any:
        self._assert_safe_gameline_query(query)
        if self.read_only and commit:
            raise RuntimeError("Cannot commit changes in read-only mode.")

        if self._on_writer_thread():
            cursor = self._write_conn.cursor()
            cursor.execute(query, params)
            return cursor

        if not commit:
            cursor = self._get_read_connection().cursor()
            cursor.execute(query, params)
            return cursor

        def op(conn: sqlite3.Connection) -> _WriteResult:
            cursor = conn.cursor()
            cursor.execute(query, params)
            return _WriteResult(cursor.lastrowid, cursor.rowcount)

        return self.run_transaction(op, priority=priority, wait=wait)

    def _assert_safe_gameline_query(self, query: str) -> None:
        if self._allow_destructive_gameline_operations:
            return

        normalized = " ".join(str(query).strip().rstrip(";").split()).lower()
        normalized = normalized.translate(str.maketrans("", "", '"`[]'))
        if normalized in {"delete from game_lines", "delete from main.game_lines"}:
            raise RuntimeError(
                "Refusing to clear the entire game_lines table in a persistent database. "
                "Use a scoped DELETE with a WHERE clause. For intentional maintenance only, "
                "set GSM_ALLOW_DESTRUCTIVE_DB_OPERATIONS=1."
            )
        if normalized in {
            "drop table game_lines",
            "drop table if exists game_lines",
            "drop table main.game_lines",
            "drop table if exists main.game_lines",
        }:
            raise RuntimeError(
                "Refusing to drop the game_lines table in a persistent database. "
                "For intentional maintenance only, set GSM_ALLOW_DESTRUCTIVE_DB_OPERATIONS=1."
            )

    def executemany(
        self,
        query: str,
        seq_of_params: List[Union[Tuple, Dict]],
        commit: bool = False,
        priority: int = DB_PRIORITY_NORMAL,
        wait: bool = True,
    ) -> Any:
        self._assert_safe_gameline_query(query)
        if self.read_only and commit:
            raise RuntimeError("Cannot commit changes in read-only mode.")

        if self._on_writer_thread():
            cursor = self._write_conn.cursor()
            cursor.executemany(query, seq_of_params)
            return cursor

        if not commit:
            cursor = self._get_read_connection().cursor()
            cursor.executemany(query, seq_of_params)
            return cursor

        params_list = list(seq_of_params)

        def op(conn: sqlite3.Connection) -> _WriteResult:
            cursor = conn.cursor()
            cursor.executemany(query, params_list)
            return _WriteResult(cursor.lastrowid, cursor.rowcount)

        return self.run_transaction(op, priority=priority, wait=wait)

    def fetchall(self, query: str, params: Union[Tuple, Dict] = ()) -> List[Tuple]:
        return self._get_read_connection().execute(query, params).fetchall()

    def fetchone(self, query: str, params: Union[Tuple, Dict] = ()) -> Optional[Tuple]:
        return self._get_read_connection().execute(query, params).fetchone()

    def check_integrity(self, *, full: bool = False, max_errors: int = 1) -> List[str]:
        """Run SQLite's quick (default) or full integrity check."""

        return connection_integrity_errors(
            self._get_read_connection(),
            full=full,
            max_errors=max_errors,
        )

    def verify_integrity(self, *, full: bool = False, max_errors: int = 1) -> None:
        verify_connection_integrity(
            self._get_read_connection(),
            full=full,
            max_errors=max_errors,
        )

    def create_table(self, table_sql: str) -> None:
        if self.read_only:
            raise RuntimeError("Cannot create tables in read-only mode.")
        self.execute(table_sql, commit=True)

    def table_exists(self, table: str) -> bool:
        result = self.fetchone("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
        return result is not None

    def async_write_errors(self) -> List[BaseException]:
        """Return a snapshot of failures from fire-and-forget writes."""

        with self._lifecycle_lock:
            return list(self._async_write_errors)

    def close(self, timeout: Optional[float] = SQLITE_CLOSE_TIMEOUT_SECONDS) -> None:
        """Stop accepting work, drain writes, then close owned connections safely."""

        if self._on_writer_thread():
            raise RuntimeError("SQLiteDB.close() must be called outside the database writer thread.")

        shutdown_future: Optional[concurrent.futures.Future] = None
        with self._writer_start_lock:
            with self._lifecycle_lock:
                self._closed = True
                thread = self._writer_thread
                if thread is not None and thread.is_alive() and not self._shutdown_enqueued:
                    shutdown_future = concurrent.futures.Future()
                    self._write_queue.put(
                        (
                            float("inf"),
                            next(self._seq),
                            _WRITER_SHUTDOWN,
                            shutdown_future,
                        )
                    )
                    self._shutdown_enqueued = True

        if thread is not None and thread.is_alive():
            if self._on_writer_thread():
                return
            thread.join(timeout=timeout)
            if thread.is_alive():
                raise TimeoutError("Database writer did not finish draining before the close timeout")

        with self._lifecycle_lock:
            if self._writer_thread is thread:
                self._writer_thread = None

        with self._read_conn_lock:
            connections, self._read_connections = self._read_connections, []
        for conn in connections:
            try:
                conn.close()
            except sqlite3.Error:
                pass
        self._local = threading.local()

    def __enter__(self) -> "SQLiteDB":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()
