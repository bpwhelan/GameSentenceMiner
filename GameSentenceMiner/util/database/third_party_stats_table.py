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
        "game_id",  # optional link to a GSM game
        "lines_read",  # imported line count, without fabricated sentence text
        "source_id",  # stable identity for an imported session
        "timestamp",  # original session timestamp, when available
    ]
    _types = [
        int,  # id (PK, auto-increment)
        str,  # date
        int,  # characters_read
        float,  # time_read_seconds
        str,  # source
        str,  # label
        float,  # created_at
        str,  # game_id
        int,  # lines_read
        str,  # source_id
        float,  # timestamp
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
        game_id: str = "",
        lines_read: int = 0,
        source_id: str = "",
        timestamp: float | None = None,
    ):
        self.id = id
        self.date = date or ""
        self.characters_read = characters_read
        self.time_read_seconds = time_read_seconds
        self.source = source
        self.label = label
        self.created_at = created_at if created_at is not None else time.time()
        self.game_id = game_id
        self.lines_read = lines_read
        self.source_id = source_id
        self.timestamp = timestamp

    @classmethod
    def set_db(cls, db, *, ensure_schema: bool = True):
        super().set_db(db, ensure_schema=ensure_schema)
        if not db.read_only and ensure_schema:
            db.execute(
                f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{cls._table}_source_id "
                f"ON {cls._table}(source, source_id) WHERE source_id IS NOT NULL AND source_id != ''",
                commit=True,
            )

    @classmethod
    def from_row(cls, row, clean_columns=()):
        entry = super().from_row(row, clean_columns=clean_columns)
        if entry is not None:
            # Columns added to existing databases are NULL until a row is rewritten.
            entry.game_id = entry.game_id or ""
            entry.lines_read = entry.lines_read or 0
            entry.source_id = entry.source_id or ""
        return entry

    @classmethod
    def get_first_date(cls) -> Optional[str]:
        """Get the earliest date with third-party stats data."""
        row = cls._db.fetchone(f"SELECT date FROM {cls._table} ORDER BY date ASC LIMIT 1")
        result = row[0] if row else None
        return result

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
        cls.invalidate_profiles()
        return count

    @staticmethod
    def invalidate_profiles():
        from GameSentenceMiner.web.game_profiles import invalidate_game_profiles_cache

        invalidate_game_profiles_cache()

    @classmethod
    def linked_activity(cls, start_date: str = "0001-01-01", end_date: str = "9999-12-31", game_id: str = "") -> dict:
        """Return imported daily game totals without changing rebuildable native rollups."""
        conditions = "game_id IS NOT NULL AND game_id != '' AND date >= ? AND date <= ?"
        params = [start_date, end_date]
        if game_id:
            conditions += " AND game_id = ?"
            params.append(game_id)
        rows = cls._db.fetchall(
            f"SELECT date, game_id, MAX(label), SUM(characters_read), SUM(time_read_seconds), SUM(lines_read) "
            f"FROM {cls._table} WHERE {conditions} GROUP BY date, game_id ORDER BY date, game_id",
            tuple(params),
        )
        result = {}
        for date, gid, title, chars, seconds, lines in rows:
            result.setdefault(date, {})[gid] = {
                "title": title or "",
                "chars": int(chars or 0),
                "time": float(seconds or 0),
                "lines": int(lines or 0),
            }
        return result

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
            f"SELECT date, SUM(characters_read), SUM(time_read_seconds), SUM(lines_read) "
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
            if row[3]:
                result[date_str]["lines"] = int(row[3])
        for date, activity in cls.linked_activity(start_date, end_date).items():
            result[date]["game_activity_data"] = activity
        session_rows = cls._db.fetchall(
            f"SELECT date, COUNT(*), SUM(time_read_seconds), MAX(time_read_seconds + 0), "
            f"MIN(NULLIF(time_read_seconds + 0, 0)), MAX(characters_read + 0) FROM {cls._table} "
            "WHERE date >= ? AND date <= ? AND source_id IS NOT NULL AND source_id != '' GROUP BY date",
            (start_date, end_date),
        )
        for date, count, seconds, longest, shortest, max_chars in session_rows:
            result[date]["session_stats"] = {
                "count": int(count),
                "time": float(seconds or 0),
                "longest": float(longest or 0),
                "shortest": float(shortest or 0),
                "max_chars": int(max_chars or 0),
            }
        return result
