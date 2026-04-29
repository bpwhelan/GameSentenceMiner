from __future__ import annotations

import time
from typing import Optional

from GameSentenceMiner.util.database.db import SQLiteDB, SQLiteDBTable


class StatsExportStateTable(SQLiteDBTable):
    """Tracks the most recent successful stats export per format."""

    _table = "stats_export_state"
    _fields = [
        "last_successful_export_at",
        "created_at",
        "updated_at",
    ]
    _types = [
        str,  # format_key (primary key)
        float,
        float,
        float,
    ]
    _pk = "format_key"
    _auto_increment = False

    def __init__(
        self,
        format_key: Optional[str] = None,
        last_successful_export_at: Optional[float] = None,
        created_at: Optional[float] = None,
        updated_at: Optional[float] = None,
    ):
        self.format_key = format_key or ""
        self.last_successful_export_at = last_successful_export_at
        self.created_at = created_at if created_at is not None else time.time()
        self.updated_at = updated_at if updated_at is not None else time.time()

    @classmethod
    def _ensure_bound_db(cls) -> SQLiteDB:
        from GameSentenceMiner.util.database.db import GameLinesTable

        db = GameLinesTable._db
        if db is None:
            raise RuntimeError("StatsExportStateTable is not bound to a database.")
        if cls._db is not db:
            cls.set_db(db)
        return db

    @classmethod
    def get_last_successful_export_at(cls, format_key: str) -> float | None:
        cls._ensure_bound_db()
        row = cls.get(format_key)
        if row is None or row.last_successful_export_at is None:
            return None
        return float(row.last_successful_export_at)

    @classmethod
    def mark_successful_export(cls, format_key: str, exported_at: Optional[float] = None) -> "StatsExportStateTable":
        cls._ensure_bound_db()
        now = exported_at if exported_at is not None else time.time()
        row = cls.get(format_key)
        if row is None:
            row = cls(
                format_key=format_key,
                last_successful_export_at=now,
                created_at=now,
                updated_at=now,
            )
        else:
            row.last_successful_export_at = now
            row.updated_at = now
        row.save()
        return row
