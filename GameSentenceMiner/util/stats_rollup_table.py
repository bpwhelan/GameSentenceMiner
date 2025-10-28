from datetime import datetime
from typing import Optional
import time

from GameSentenceMiner.util.db import SQLiteDBTable


class StatsRollupTable(SQLiteDBTable):
    _table = "daily_stats_rollup"
    _fields = [
        "date",
        "total_lines",
        "total_characters",
        "total_sessions",
        "unique_games_played",
        "total_reading_time_seconds",
        "total_active_time_seconds",
        "longest_session_seconds",
        "shortest_session_seconds",
        "average_session_seconds",
        "average_reading_speed_chars_per_hour",
        "peak_reading_speed_chars_per_hour",
        "games_completed",
        "games_started",
        "anki_cards_created",
        "lines_with_screenshots",
        "lines_with_audio",
        "lines_with_translations",
        "unique_kanji_seen",
        "kanji_frequency_data",
        "hourly_activity_data",
        "hourly_reading_speed_data",
        "game_activity_data",
        "games_played_ids",
        "max_chars_in_session",
        "max_time_in_session_seconds",
        "created_at",
        "updated_at",
    ]
    _types = [
        int,  # id (primary key)
        str,  # date
        int,
        int,
        int,
        int,  # basic counts: total_lines, total_characters, total_sessions, unique_games_played
        float,
        float,  # time tracking: total_reading_time_seconds, total_active_time_seconds
        float,
        float,
        float,  # session stats: longest_session_seconds, shortest_session_seconds, average_session_seconds
        float,
        float,  # reading performance: average_reading_speed_chars_per_hour, peak_reading_speed_chars_per_hour
        int,
        int,
        int,  # game progress: games_completed, games_started, anki_cards_created
        int,
        int,
        int,  # anki integration: lines_with_screenshots, lines_with_audio, lines_with_translations
        int,
        str,  # kanji stats: unique_kanji_seen, kanji_frequency_data (JSON)
        str,
        str,
        str,  # JSON data fields: hourly_activity_data, hourly_reading_speed_data, game_activity_data
        str,  # games_played_ids (JSON)
        int,
        float,  # peak performance: max_chars_in_session, max_time_in_session_seconds
        float,
        float,  # metadata: created_at, updated_at
    ]
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: Optional[int] = None,
        date: Optional[str] = None,
        total_lines: int = 0,
        total_characters: int = 0,
        total_sessions: int = 0,
        unique_games_played: int = 0,
        total_reading_time_seconds: float = 0.0,
        total_active_time_seconds: float = 0.0,
        longest_session_seconds: float = 0.0,
        shortest_session_seconds: float = 0.0,
        average_session_seconds: float = 0.0,
        average_reading_speed_chars_per_hour: float = 0.0,
        peak_reading_speed_chars_per_hour: float = 0.0,
        games_completed: int = 0,
        games_started: int = 0,
        anki_cards_created: int = 0,
        lines_with_screenshots: int = 0,
        lines_with_audio: int = 0,
        lines_with_translations: int = 0,
        unique_kanji_seen: int = 0,
        kanji_frequency_data: Optional[str] = None,
        hourly_activity_data: Optional[str] = None,
        hourly_reading_speed_data: Optional[str] = None,
        game_activity_data: Optional[str] = None,
        games_played_ids: Optional[str] = None,
        max_chars_in_session: int = 0,
        max_time_in_session_seconds: float = 0.0,
        created_at: Optional[float] = None,
        updated_at: Optional[float] = None,
    ):
        self.id = id
        self.date = date if date is not None else datetime.now().strftime("%Y-%m-%d")
        self.total_lines = total_lines
        self.total_characters = total_characters
        self.total_sessions = total_sessions
        self.unique_games_played = unique_games_played
        self.total_reading_time_seconds = total_reading_time_seconds
        self.total_active_time_seconds = total_active_time_seconds
        self.longest_session_seconds = longest_session_seconds
        self.shortest_session_seconds = shortest_session_seconds
        self.average_session_seconds = average_session_seconds
        self.average_reading_speed_chars_per_hour = average_reading_speed_chars_per_hour
        self.peak_reading_speed_chars_per_hour = peak_reading_speed_chars_per_hour
        self.games_completed = games_completed
        self.games_started = games_started
        self.anki_cards_created = anki_cards_created
        self.lines_with_screenshots = lines_with_screenshots
        self.lines_with_audio = lines_with_audio
        self.lines_with_translations = lines_with_translations
        self.unique_kanji_seen = unique_kanji_seen
        self.kanji_frequency_data = (
            kanji_frequency_data if kanji_frequency_data is not None else "{}"
        )
        self.hourly_activity_data = (
            hourly_activity_data if hourly_activity_data is not None else "{}"
        )
        self.hourly_reading_speed_data = (
            hourly_reading_speed_data if hourly_reading_speed_data is not None else "{}"
        )
        self.game_activity_data = (
            game_activity_data if game_activity_data is not None else "{}"
        )
        self.games_played_ids = (
            games_played_ids if games_played_ids is not None else "[]"
        )
        self.max_chars_in_session = max_chars_in_session
        self.max_time_in_session_seconds = max_time_in_session_seconds
        self.created_at = created_at if created_at is not None else time.time()
        self.updated_at = updated_at if updated_at is not None else time.time()

    @classmethod
    def get_stats_for_date(cls, date: str) -> Optional["StatsRollupTable"]:
        """Get rollup statistics for a specific date."""
        row = cls._db.fetchone(f"SELECT * FROM {cls._table} WHERE date=?", (date,))
        return cls.from_row(row) if row else None

    @classmethod
    def get_by_date(cls, date: str) -> Optional["StatsRollupTable"]:
        """Get rollup statistics for a specific date (alias for get_stats_for_date)."""
        return cls.get_stats_for_date(date)

    @classmethod
    def date_exists(cls, date: str) -> bool:
        """Check if a rollup exists for a specific date."""
        row = cls._db.fetchone(f"SELECT id FROM {cls._table} WHERE date=?", (date,))
        return row is not None

    @classmethod
    def get_date_range(cls, start_date: str, end_date: str) -> list["StatsRollupTable"]:
        """Get rollup statistics for a date range (inclusive)."""
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE date >= ? AND date <= ? ORDER BY date ASC",
            (start_date, end_date),
        )
        return [cls.from_row(row) for row in rows]

    @classmethod
    def get_first_date(cls) -> Optional[str]:
        """Get the earliest date with rollup data."""
        from GameSentenceMiner.util.configuration import logger
        row = cls._db.fetchone(
            f"SELECT date FROM {cls._table} ORDER BY date ASC LIMIT 1"
        )
        result = row[0] if row else None
        return result

    @classmethod
    def get_last_date(cls) -> Optional[str]:
        """Get the most recent date with rollup data."""
        row = cls._db.fetchone(
            f"SELECT date FROM {cls._table} ORDER BY date DESC LIMIT 1"
        )
        return row[0] if row else None

    @classmethod
    def update_stats(
        cls,
        date: str,
        games_played: int = 0,
        lines_mined: int = 0,
        anki_cards_created: int = 0,
        time_spent_mining: float = 0.0,
    ):
        """Legacy method for backward compatibility - updates basic stats only."""
        stats = cls.get_stats_for_date(date)
        if not stats:
            new_stats = cls(
                date=date,
                unique_games_played=games_played,
                total_lines=lines_mined,
                anki_cards_created=anki_cards_created,
                total_reading_time_seconds=time_spent_mining,
            )
            new_stats.save()
            return
        stats.unique_games_played += games_played
        stats.total_lines += lines_mined
        stats.anki_cards_created += anki_cards_created
        stats.total_reading_time_seconds += time_spent_mining
        stats.updated_at = time.time()
        stats.save()
