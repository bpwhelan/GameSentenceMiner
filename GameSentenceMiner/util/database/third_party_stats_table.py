import time
from typing import Optional, List

from GameSentenceMiner.util.database.db import SQLiteDBTable


class ThirdPartyStatsTable(SQLiteDBTable):
    """
    Stores pre-computed reading stats imported from external apps (Mokuro, manual entry, etc.).
    Each row represents reading activity for a single date, from a single source.
    These are merged into the rolled-up stats pipeline to give a unified view.
    """

    _table = "third_party_stats"
    _fields = [
        "date",  # YYYY-MM-DD
        "characters_read",  # int
        "time_read_seconds",  # float (seconds)
        "source",  # str: "mokuro", "manual", etc.
        "label",  # str: volume title, user note, etc.
        "created_at",  # float: unix timestamp
    ]
    _types = [
        int,  # id (PK, auto-increment)
        str,  # date
        int,  # characters_read
        float,  # time_read_seconds
        str,  # source
        str,  # label
        float,  # created_at
    ]
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: Optional[int] = None,
        date: Optional[str] = None,
        characters_read: int = 0,
        time_read_seconds: float = 0.0,
        source: str = "",
        label: str = "",
        created_at: Optional[float] = None,
    ):
        self.id = id
        self.date = date or ""
        self.characters_read = characters_read
        self.time_read_seconds = time_read_seconds
        self.source = source
        self.label = label
        self.created_at = created_at if created_at is not None else time.time()

    @classmethod
    def get_date_range(cls, start_date: str, end_date: str) -> List["ThirdPartyStatsTable"]:
        """Get all third-party stats rows within a date range (inclusive)."""
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE date >= ? AND date <= ? ORDER BY date ASC",
            (start_date, end_date),
        )
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get_all_by_source(cls, source: str) -> List["ThirdPartyStatsTable"]:
        """Get all entries for a given source (e.g. 'mokuro')."""
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE source = ? ORDER BY date ASC",
            (source,),
        )
        return [cls.from_row(row) for row in rows]

    @classmethod
    def delete_by_source(cls, source: str) -> int:
        """Delete all entries for a given source. Returns count deleted."""
        count_row = cls._db.fetchone(f"SELECT COUNT(*) FROM {cls._table} WHERE source = ?", (source,))
        count = count_row[0] if count_row else 0
        cls._db.execute(f"DELETE FROM {cls._table} WHERE source = ?", (source,), commit=True)
        return count

    @classmethod
    def get_summary(cls) -> dict:
        """Get summary stats: total entries, total chars, total time, by source."""
        rows = cls._db.fetchall(
            f"SELECT source, COUNT(*), SUM(characters_read), SUM(time_read_seconds) FROM {cls._table} GROUP BY source"
        )
        summary = {}
        total_entries = 0
        total_chars = 0
        total_time = 0.0
        for row in rows:
            source = row[0] or "unknown"
            count = row[1] or 0
            chars = row[2] or 0
            time_s = row[3] or 0.0
            summary[source] = {
                "count": count,
                "characters": chars,
                "time_seconds": time_s,
            }
            total_entries += count
            total_chars += chars
            total_time += time_s
        return {
            "total_entries": total_entries,
            "total_characters": total_chars,
            "total_time_seconds": total_time,
            "by_source": summary,
        }

    @classmethod
    def aggregate_by_date(cls, start_date: str, end_date: str) -> dict:
        """
        Aggregate third-party stats by date for a given range.
        Returns dict: date_str -> {"characters": int, "time_seconds": float}
        """
        rows = cls._db.fetchall(
            f"SELECT date, SUM(characters_read), SUM(time_read_seconds) "
            f"FROM {cls._table} WHERE date >= ? AND date <= ? GROUP BY date",
            (start_date, end_date),
        )
        result = {}
        for row in rows:
            date_str = row[0]
            result[date_str] = {
                "characters": int(row[1] or 0),
                "time_seconds": float(row[2] or 0.0),
            }
        return result
