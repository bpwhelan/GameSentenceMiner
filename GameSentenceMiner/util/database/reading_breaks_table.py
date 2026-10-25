from math import isfinite
from typing import ClassVar

from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDBTable


class ReadingBreaksTable(SQLiteDBTable):
    """Persist explicit stats pauses so later calculations exclude interrupted gaps.

    A pause marks the current line as interrupted, rather than guessing how much
    reading happened on either side. It does not reset the session's learned pace.
    """

    _table = "stats_reading_breaks"
    _fields: ClassVar[list[str]] = ["timestamp"]
    _types: ClassVar[list[type]] = [int, float]

    def __init__(self, id=None, timestamp=0.0):
        self.id = id
        self.timestamp = timestamp

    @classmethod
    def record(cls, timestamp: float) -> None:
        if not isfinite(timestamp):
            return
        db = GameLinesTable._db
        if cls._db is not db or not db.table_exists(cls._table):
            cls.set_db(db)
        cls(timestamp=timestamp).save()

    @classmethod
    def between(cls, start: float, end: float) -> list[float]:
        db = GameLinesTable._db
        # Older databases can still be opened in read-only mode without a migration.
        if not db.table_exists(cls._table):
            return []
        rows = db.fetchall(
            f"SELECT CAST(timestamp AS REAL) FROM {cls._table} "
            "WHERE CAST(timestamp AS REAL) >= ? AND CAST(timestamp AS REAL) < ? "
            "ORDER BY CAST(timestamp AS REAL)",
            (start, end),
        )
        return [float(row[0]) for row in rows]
