"""Durable sync identity/status and an OS lock shared by manual and cron workers."""

from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.kechimochi_client import KechimochiSyncError

_process_lock = threading.Lock()


class KechimochiSyncState:
    def __init__(self):
        self.db = GameLinesTable._db
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS kechimochi_sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            commit=True,
        )
        self.db.execute(
            "INSERT OR IGNORE INTO kechimochi_sync_state(key,value) VALUES ('source_id', ?)",
            (json.dumps(uuid.uuid4().hex),),
            commit=True,
        )
        self.source_id = self.get("source_id")

    def get(self, key, default=None):
        row = self.db.fetchone("SELECT value FROM kechimochi_sync_state WHERE key=?", (key,))
        return json.loads(row[0]) if row else default

    def put(self, key, value):
        self.db.execute(
            "INSERT INTO kechimochi_sync_state(key,value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
            commit=True,
        )

    @contextmanager
    def sync_lock(self):
        if not _process_lock.acquire(blocking=False):
            raise KechimochiSyncError("A Kechimochi sync is already running")
        handle = None
        locked = False
        try:
            if self.db.db_path != ":memory:":
                path = Path(self.db.db_path).resolve().with_suffix(".kechimochi.lock")
                handle = path.open("a+b")
                if path.stat().st_size == 0:
                    handle.write(b"0")
                    handle.flush()
                handle.seek(0)
                try:
                    if os.name == "nt":
                        import msvcrt

                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locked = True
                except OSError as exc:
                    raise KechimochiSyncError("A Kechimochi sync is already running in another GSM process") from exc
            yield
        finally:
            if handle is not None:
                try:
                    if locked:
                        handle.seek(0)
                        if os.name == "nt":
                            import msvcrt

                            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                        else:
                            import fcntl

                            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                finally:
                    handle.close()
            _process_lock.release()
