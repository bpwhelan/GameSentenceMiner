from __future__ import annotations

import time
from typing import Iterable, Optional

from GameSentenceMiner.util.database.db import SQLiteDB, SQLiteDBTable


class GameDailyRollupTable(SQLiteDBTable):
    """Stores per-game daily aggregates for fast game stats queries."""

    _table = "game_daily_rollup"
    _fields = [
        "date",
        "game_id",
        "total_characters",
        "total_lines",
        "total_cards_mined",
        "total_reading_time_seconds",
        "created_at",
        "updated_at",
    ]
    _types = [
        int,  # id (primary key)
        str,
        str,
        int,
        int,
        int,
        float,
        float,
        float,
    ]
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: Optional[int] = None,
        date: str = "",
        game_id: str = "",
        total_characters: int = 0,
        total_lines: int = 0,
        total_cards_mined: int = 0,
        total_reading_time_seconds: float = 0.0,
        created_at: Optional[float] = None,
        updated_at: Optional[float] = None,
    ):
        self.id = id
        self.date = date
        self.game_id = game_id
        self.total_characters = total_characters
        self.total_lines = total_lines
        self.total_cards_mined = total_cards_mined
        self.total_reading_time_seconds = total_reading_time_seconds
        self.created_at = created_at if created_at is not None else time.time()
        self.updated_at = updated_at if updated_at is not None else time.time()

    @classmethod
    def set_db(cls, db: SQLiteDB):
        if db.read_only and not db.table_exists(cls._table):
            cls._db = db
            cls._column_order_cache = None
            cls._row_field_mapping_cache = None
            return

        super().set_db(db)
        if db.read_only:
            return
        db.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{cls._table}_date_game_id "
            f"ON {cls._table}(date, game_id)",
            commit=True,
        )
        db.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{cls._table}_game_id_date "
            f"ON {cls._table}(game_id, date)",
            commit=True,
        )

    @classmethod
    def _ensure_bound_db(cls) -> SQLiteDB:
        from GameSentenceMiner.util.database.db import GameLinesTable

        db = GameLinesTable._db
        if db is None:
            raise RuntimeError("GameDailyRollupTable is not bound to a database.")
        if cls._db is not db:
            cls.set_db(db)
        return db

    @classmethod
    def get_date_range_for_game(
        cls,
        game_id: str,
        start_date: str,
        end_date: str,
    ) -> list["GameDailyRollupTable"]:
        db = cls._ensure_bound_db()
        rows = db.fetchall(
            f"""
            SELECT * FROM {cls._table}
            WHERE game_id = ? AND date >= ? AND date <= ?
            ORDER BY date ASC
            """,
            (game_id, start_date, end_date),
        )
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get_date_range(
        cls,
        start_date: str,
        end_date: str,
    ) -> list["GameDailyRollupTable"]:
        db = cls._ensure_bound_db()
        rows = db.fetchall(
            f"""
            SELECT * FROM {cls._table}
            WHERE date >= ? AND date <= ?
            ORDER BY date ASC, game_id ASC
            """,
            (start_date, end_date),
        )
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get_first_date_for_game(cls, game_id: str) -> Optional[str]:
        db = cls._ensure_bound_db()
        row = db.fetchone(
            f"SELECT date FROM {cls._table} WHERE game_id = ? ORDER BY date ASC LIMIT 1",
            (game_id,),
        )
        return str(row[0]) if row and row[0] is not None else None

    @classmethod
    def delete_by_date(cls, date: str) -> None:
        db = cls._ensure_bound_db()
        db.execute(f"DELETE FROM {cls._table} WHERE date = ?", (date,), commit=True)

    @classmethod
    def replace_for_date(
        cls,
        date: str,
        rollups: Iterable["GameDailyRollupTable"],
    ) -> None:
        db = cls._ensure_bound_db()
        rows = list(rollups)
        with db.transaction():
            db.execute(f"DELETE FROM {cls._table} WHERE date = ?", (date,), commit=True)
            if rows:
                db.executemany(
                    f"""
                    INSERT INTO {cls._table} (
                        date,
                        game_id,
                        total_characters,
                        total_lines,
                        total_cards_mined,
                        total_reading_time_seconds,
                        created_at,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            row.date,
                            row.game_id,
                            row.total_characters,
                            row.total_lines,
                            row.total_cards_mined,
                            row.total_reading_time_seconds,
                            row.created_at,
                            row.updated_at,
                        )
                        for row in rows
                    ],
                    commit=True,
                )
