from __future__ import annotations

import datetime
import json
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.web.stats_service import build_current_game_stats


@pytest.fixture(autouse=True)
def _in_memory_db():
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_stats


def _seed_rollup(date_str: str, game_id: str, title: str, chars: int, lines: int, time_seconds: float):
    rollup = StatsRollupTable(
        date=date_str,
        total_lines=lines,
        total_characters=chars,
        total_reading_time_seconds=time_seconds,
        anki_cards_created=0,
        game_activity_data=json.dumps(
            {
                game_id: {
                    "title": title,
                    "lines": lines,
                    "chars": chars,
                    "time": time_seconds,
                }
            }
        ),
        kanji_frequency_data=json.dumps({}),
        hourly_activity_data=json.dumps({}),
        hourly_reading_speed_data=json.dumps({}),
        genre_activity_data=json.dumps({}),
        type_activity_data=json.dumps({}),
    )
    rollup.save()
    return rollup


def test_build_current_game_stats_uses_rollups_for_linked_games(monkeypatch):
    today = datetime.date.today()
    day_before = today - datetime.timedelta(days=2)
    yesterday = today - datetime.timedelta(days=1)

    game = GamesTable(
        title_original="Linked Game",
        obs_scene_name="Linked Game Scene",
        character_count=10_000,
    )
    game.save()

    rollups = [
        _seed_rollup(day_before.isoformat(), game.id, game.title_original, chars=120, lines=3, time_seconds=60.0),
        _seed_rollup(yesterday.isoformat(), game.id, game.title_original, chars=180, lines=4, time_seconds=90.0),
    ]

    now = datetime.datetime.combine(today, datetime.time(12, 0)).timestamp()
    today_lines = [
        SimpleNamespace(
            id="line-1",
            game_name=game.obs_scene_name,
            line_text="abcde",
            timestamp=now,
            game_id=game.id,
        ),
        SimpleNamespace(
            id="line-2",
            game_name=game.obs_scene_name,
            line_text="fghij",
            timestamp=now + 30,
            game_id=game.id,
        ),
    ]

    def _unexpected_query(*_args, **_kwargs):
        raise AssertionError("historical game line query should not be used for linked rollup-backed stats")

    monkeypatch.setattr("GameSentenceMiner.web.stats_service.query_stats_lines", _unexpected_query)

    result = build_current_game_stats(
        today_lines=today_lines,
        start_timestamp=None,
        end_timestamp=None,
        rollups=rollups,
    )

    assert result is not None
    assert result["game_id"] == game.id
    assert result["title_original"] == game.title_original
    assert result["total_characters"] == 310
    assert result["total_sentences"] == 9
    assert result["first_date"] == day_before.isoformat()
    assert result["last_date"] == today.isoformat()
    assert result["daily_activity"][day_before.isoformat()] == 120
    assert result["daily_activity"][yesterday.isoformat()] == 180
    assert result["daily_activity"][today.isoformat()] == 10
