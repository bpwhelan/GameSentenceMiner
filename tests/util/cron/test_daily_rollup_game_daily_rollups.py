from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.cron import daily_rollup
from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.database.game_daily_rollup_table import (
    GameDailyRollupTable,
)
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


@pytest.fixture(autouse=True)
def _in_memory_db():
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    orig_game_daily = GameDailyRollupTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    GameDailyRollupTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_stats
    GameDailyRollupTable._db = orig_game_daily


def test_managed_rollup_registers_before_releasing_database_queue(monkeypatch, _in_memory_db):
    from GameSentenceMiner.native import history
    from GameSentenceMiner.util.database.db import DB_PRIORITY_LOW

    calls = []
    monkeypatch.setattr(history, "managed", lambda db: True)
    monkeypatch.setenv("GSM_NATIVE_DAILY_ROLLUP", "1")
    monkeypatch.setattr(
        daily_rollup,
        "get_stats_config",
        lambda: SimpleNamespace(regex_out_repetitions=False, extra_punctuation_regex="", session_gap_seconds=300),
    )

    def request(operation, **fields):
        calls.append((operation, fields))
        if operation == "beginRollup":
            return 73
        assert fields["generation"] == 73 and fields["timeout"] is None
        return {"processed": 1, "overwritten": 0, "errors": 0, "fallback_dates": []}

    def ordered(fn, *, priority):
        assert priority == DB_PRIORITY_LOW
        calls.append(("ordered", {}))
        return fn()

    monkeypatch.setattr(history, "request", request)
    monkeypatch.setattr(_in_memory_db, "run_external_write", ordered)
    result = daily_rollup.run_daily_rollup()
    assert result["processed"] == 1 and result["errors"] == 0
    assert [name for name, _ in calls] == ["ordered", "beginRollup", "rebuildRollups"]


@pytest.mark.parametrize(
    ("pattern", "managed"),
    [
        ("[A-Za-z0-9本]+|猫犬", True),
        ("", True),
        (r"\p{Script=Latin}", False),
        (r"(?<=文)字", False),
        (r"a.*?b", False),
    ],
)
def test_custom_punctuation_preserves_regex_engine_for_advanced_expressions(monkeypatch, pattern, managed):
    from GameSentenceMiner.native import history

    monkeypatch.setattr(history, "managed", lambda db: True)
    monkeypatch.setenv("GSM_NATIVE_DAILY_ROLLUP", "1")
    assert history.manages_daily_rollup(None, SimpleNamespace(extra_punctuation_regex=pattern)) is managed


def test_run_daily_rollup_replaces_game_daily_rollups(monkeypatch):
    date_str = "2026-01-10"
    stale = GameDailyRollupTable(
        date=date_str,
        game_id="stale-game",
        total_characters=999,
        total_lines=9,
        total_cards_mined=9,
        total_reading_time_seconds=999.0,
        created_at=time.time(),
        updated_at=time.time(),
    )
    stale.save()

    monkeypatch.setattr(daily_rollup, "get_first_data_date", lambda: date_str)
    monkeypatch.setattr(daily_rollup, "get_all_data_dates", lambda: [date_str])
    monkeypatch.setattr(
        daily_rollup,
        "calculate_daily_stats",
        lambda _date: {
            "date": date_str,
            "total_lines": 5,
            "total_characters": 200,
            "total_sessions": 2,
            "unique_games_played": 2,
            "total_reading_time_seconds": 5400.0,
            "total_active_time_seconds": 5400.0,
            "longest_session_seconds": 3600.0,
            "shortest_session_seconds": 1800.0,
            "average_session_seconds": 2700.0,
            "average_reading_speed_chars_per_hour": 133.3,
            "peak_reading_speed_chars_per_hour": 200.0,
            "games_completed": 0,
            "games_started": 2,
            "anki_cards_created": 3,
            "lines_with_screenshots": 0,
            "lines_with_audio": 0,
            "lines_with_translations": 0,
            "unique_kanji_seen": 0,
            "kanji_frequency_data": "{}",
            "hourly_activity_data": "{}",
            "hourly_reading_speed_data": "{}",
            "game_activity_data": "{}",
            "games_played_ids": "[]",
            "genre_activity_data": "{}",
            "type_activity_data": "{}",
            "max_chars_in_session": 120,
            "max_time_in_session_seconds": 3600.0,
            "unique_words_seen": 0,
            "word_frequency_data": "{}",
            "per_game_daily_rollups": {
                "game-1": {
                    "chars": 120,
                    "lines": 3,
                    "cards": 2,
                    "time": 3600.0,
                },
                "game-2": {
                    "chars": 80,
                    "lines": 2,
                    "cards": 1,
                    "time": 1800.0,
                },
            },
        },
    )

    result = daily_rollup.run_daily_rollup()

    assert result["success"] is True
    rows_one = GameDailyRollupTable.get_date_range_for_game("game-1", date_str, date_str)
    rows_two = GameDailyRollupTable.get_date_range_for_game("game-2", date_str, date_str)
    stale_rows = GameDailyRollupTable.get_date_range_for_game("stale-game", date_str, date_str)

    assert [(row.total_characters, row.total_lines, row.total_cards_mined) for row in rows_one] == [(120, 3, 2)]
    assert [(row.total_characters, row.total_lines, row.total_cards_mined) for row in rows_two] == [(80, 2, 1)]
    assert stale_rows == []
