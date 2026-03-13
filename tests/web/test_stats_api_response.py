"""
Unit tests for the refactored /api/stats response shape.

Verifies:
- Response contains all expected top-level keys including miningHeatmapData
- miningHeatmapData structure is {year: {date: count}}

Requirements: 1.3, 2.2
"""

from __future__ import annotations

import datetime
import json
import time

import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.game_daily_rollup_table import (
    GameDailyRollupTable,
)
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _in_memory_db():
    """Swap all table backends to a shared in-memory SQLite DB."""
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


@pytest.fixture()
def app(_in_memory_db):
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True
    from GameSentenceMiner.web.stats_api import register_stats_api_routes

    register_stats_api_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


def _seed_rollup(
    date_str: str,
    total_chars: int = 1000,
    total_lines: int = 50,
    reading_time: float = 3600.0,
    anki_cards: int = 5,
    game_activity: dict | None = None,
):
    """Insert a rollup row into the in-memory DB."""
    ga = game_activity or {
        "abc123": {"title": "Test Game", "lines": total_lines, "chars": total_chars}
    }
    rollup = StatsRollupTable(
        date=date_str,
        total_lines=total_lines,
        total_characters=total_chars,
        total_reading_time_seconds=reading_time,
        anki_cards_created=anki_cards,
        game_activity_data=json.dumps(ga),
        kanji_frequency_data=json.dumps({"漢": 3, "字": 2}),
        hourly_activity_data=json.dumps({"10": 500, "14": 300}),
        hourly_reading_speed_data=json.dumps({"10": 8000, "14": 9000}),
        genre_activity_data=json.dumps({}),
        type_activity_data=json.dumps({}),
    )
    rollup.save()


def _patch_heavy_deps(monkeypatch):
    """Patch expensive or side-effect-heavy functions that aren't under test."""
    # Patch calculate_game_milestones to avoid needing full GamesTable data
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.calculate_game_milestones",
        lambda: None,
    )
    # Patch get_third_party_stats_by_date to return empty
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.get_third_party_stats_by_date",
        lambda start, end: {},
    )


def _seed_game_daily_rollup(
    date_str: str,
    game_id: str,
    *,
    chars: int,
    lines: int,
    time_seconds: float,
    cards: int = 0,
):
    GameDailyRollupTable(
        date=date_str,
        game_id=game_id,
        total_characters=chars,
        total_lines=lines,
        total_cards_mined=cards,
        total_reading_time_seconds=time_seconds,
    ).save()


# ---------------------------------------------------------------------------
# Expected top-level keys in the /api/stats response
# ---------------------------------------------------------------------------

EXPECTED_TOP_LEVEL_KEYS = {
    "labels",
    "datasets",
    "cardsMinedLast30Days",
    "heatmapData",
    "totalCharsPerGame",
    "readingTimePerGame",
    "readingSpeedPerGame",
    "currentGameStats",
    "allGamesStats",
    "hourlyActivityData",
    "hourlyReadingSpeedData",
    "peakDailyStats",
    "peakSessionStats",
    "readingSpeedHeatmapData",
    "maxReadingSpeed",
    "dayOfWeekData",
    "difficultySpeedData",
    "gameTypeData",
    "genreTagData",
    "genreStats",
    "typeStats",
    "timePeriodAverages",
    "miningHeatmapData",
}

# Keys that were moved to dedicated lazy-load endpoints
REMOVED_KEYS = {"allLinesData", "kanjiGridData", "gameMilestones"}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestStatsResponseShape:
    """Verify the /api/stats response contains all expected keys."""

    def test_response_contains_all_top_level_keys(self, client, monkeypatch):
        """The JSON response must include every expected top-level key."""
        _patch_heavy_deps(monkeypatch)

        # Seed two days of rollup data (yesterday and day before)
        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        day_before = today - datetime.timedelta(days=2)
        _seed_rollup(yesterday.strftime("%Y-%m-%d"), total_chars=2000, anki_cards=3)
        _seed_rollup(day_before.strftime("%Y-%m-%d"), total_chars=1500, anki_cards=7)

        # Request with explicit date range covering the seeded data
        start_ts = datetime.datetime.combine(day_before, datetime.time.min).timestamp()
        end_ts = datetime.datetime.combine(today, datetime.time.max).timestamp()

        resp = client.get(f"/api/stats?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        actual_keys = set(data.keys())
        missing = EXPECTED_TOP_LEVEL_KEYS - actual_keys
        assert not missing, f"Missing top-level keys: {missing}"

    def test_empty_db_returns_labels_datasets(self, client, monkeypatch):
        """With no rollup data, the endpoint should still return a valid response."""
        _patch_heavy_deps(monkeypatch)

        today = datetime.date.today()
        start_ts = datetime.datetime.combine(
            today - datetime.timedelta(days=7), datetime.time.min
        ).timestamp()
        end_ts = datetime.datetime.combine(today, datetime.time.max).timestamp()

        resp = client.get(f"/api/stats?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        # Empty DB returns the minimal {"labels": [], "datasets": []} shape
        assert "labels" in data
        assert "datasets" in data

    def test_stats_uses_game_daily_rollups_when_rollup_game_activity_is_invalid(
        self, client, monkeypatch
    ):
        _patch_heavy_deps(monkeypatch)

        game = GamesTable(
            id="game-1",
            title_original="Alpha Quest",
            obs_scene_name="ALPHA_SCENE",
            game_type="Visual Novel",
            difficulty=2,
            genres=["Mystery"],
            tags=["Detective"],
        )
        game.save()

        day = datetime.date.today() - datetime.timedelta(days=1)
        StatsRollupTable(
            date=day.isoformat(),
            total_lines=3,
            total_characters=30,
            total_reading_time_seconds=1800.0,
            total_active_time_seconds=1800.0,
            total_sessions=1,
            unique_games_played=1,
            anki_cards_created=2,
            average_reading_speed_chars_per_hour=60,
            peak_reading_speed_chars_per_hour=60,
            longest_session_seconds=1800,
            shortest_session_seconds=1800,
            average_session_seconds=1800,
            max_chars_in_session=30,
            max_time_in_session_seconds=1800,
            game_activity_data="{invalid json",
            kanji_frequency_data=json.dumps({}),
            hourly_activity_data=json.dumps({}),
            hourly_reading_speed_data=json.dumps({}),
            genre_activity_data=json.dumps(
                {"Mystery": {"chars": 30, "time": 1800, "cards": 2}}
            ),
            type_activity_data=json.dumps(
                {"Visual Novel": {"chars": 30, "time": 1800, "cards": 2}}
            ),
        ).save()
        _seed_game_daily_rollup(
            day.isoformat(),
            "game-1",
            chars=30,
            lines=3,
            time_seconds=1800.0,
            cards=2,
        )

        start_ts = datetime.datetime.combine(day, datetime.time.min).timestamp()
        end_ts = datetime.datetime.combine(
            datetime.date.today(), datetime.time.max
        ).timestamp()
        resp = client.get(f"/api/stats?start={start_ts}&end={end_ts}")

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["labels"] == [day.isoformat()]
        assert data["totalCharsPerGame"] == {
            "labels": ["Alpha Quest"],
            "totals": [30],
        }
        assert data["readingTimePerGame"] == {
            "labels": ["Alpha Quest"],
            "totals": [0.5],
        }
        assert data["readingSpeedPerGame"] == {
            "labels": ["Alpha Quest"],
            "totals": [60.0],
        }

    def test_stats_falls_back_to_rollup_game_activity_when_game_daily_rollups_are_partial(
        self, client, monkeypatch
    ):
        _patch_heavy_deps(monkeypatch)

        game = GamesTable(
            id="game-1",
            title_original="Alpha Quest",
            obs_scene_name="ALPHA_SCENE",
            game_type="Visual Novel",
        )
        game.save()

        day_one = datetime.date.today() - datetime.timedelta(days=2)
        day_two = datetime.date.today() - datetime.timedelta(days=1)
        game_activity_day_one = {
            "game-1": {
                "title": "Alpha Quest",
                "lines": 2,
                "chars": 20,
                "time": 1800,
            }
        }
        game_activity_day_two = {
            "game-1": {
                "title": "Alpha Quest",
                "lines": 3,
                "chars": 30,
                "time": 1800,
            }
        }

        StatsRollupTable(
            date=day_one.isoformat(),
            total_lines=2,
            total_characters=20,
            total_reading_time_seconds=1800.0,
            total_active_time_seconds=1800.0,
            total_sessions=1,
            unique_games_played=1,
            anki_cards_created=1,
            average_reading_speed_chars_per_hour=40,
            peak_reading_speed_chars_per_hour=40,
            longest_session_seconds=1800,
            shortest_session_seconds=1800,
            average_session_seconds=1800,
            max_chars_in_session=20,
            max_time_in_session_seconds=1800,
            game_activity_data=json.dumps(game_activity_day_one),
            kanji_frequency_data=json.dumps({}),
            hourly_activity_data=json.dumps({}),
            hourly_reading_speed_data=json.dumps({}),
            genre_activity_data=json.dumps({}),
            type_activity_data=json.dumps({}),
        ).save()
        StatsRollupTable(
            date=day_two.isoformat(),
            total_lines=3,
            total_characters=30,
            total_reading_time_seconds=1800.0,
            total_active_time_seconds=1800.0,
            total_sessions=1,
            unique_games_played=1,
            anki_cards_created=2,
            average_reading_speed_chars_per_hour=60,
            peak_reading_speed_chars_per_hour=60,
            longest_session_seconds=1800,
            shortest_session_seconds=1800,
            average_session_seconds=1800,
            max_chars_in_session=30,
            max_time_in_session_seconds=1800,
            game_activity_data=json.dumps(game_activity_day_two),
            kanji_frequency_data=json.dumps({}),
            hourly_activity_data=json.dumps({}),
            hourly_reading_speed_data=json.dumps({}),
            genre_activity_data=json.dumps({}),
            type_activity_data=json.dumps({}),
        ).save()
        _seed_game_daily_rollup(
            day_one.isoformat(),
            "game-1",
            chars=20,
            lines=2,
            time_seconds=1800.0,
            cards=1,
        )

        start_ts = datetime.datetime.combine(day_one, datetime.time.min).timestamp()
        end_ts = datetime.datetime.combine(
            datetime.date.today(), datetime.time.max
        ).timestamp()
        resp = client.get(f"/api/stats?start={start_ts}&end={end_ts}")

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["labels"] == [day_one.isoformat(), day_two.isoformat()]
        assert data["totalCharsPerGame"] == {
            "labels": ["Alpha Quest"],
            "totals": [50],
        }
        assert data["readingTimePerGame"] == {
            "labels": ["Alpha Quest"],
            "totals": [1.0],
        }
        assert data["readingSpeedPerGame"] == {
            "labels": ["Alpha Quest"],
            "totals": [50.0],
        }


class TestMiningHeatmapDataStructure:
    """Verify miningHeatmapData has the correct {year: {date: count}} shape."""

    def test_mining_heatmap_keyed_by_year_and_date(self, client, monkeypatch):
        """miningHeatmapData must be {year_str: {date_str: int}}."""
        _patch_heavy_deps(monkeypatch)

        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        day_before = today - datetime.timedelta(days=2)
        _seed_rollup(yesterday.strftime("%Y-%m-%d"), anki_cards=4)
        _seed_rollup(day_before.strftime("%Y-%m-%d"), anki_cards=6)

        start_ts = datetime.datetime.combine(day_before, datetime.time.min).timestamp()
        end_ts = datetime.datetime.combine(today, datetime.time.max).timestamp()

        resp = client.get(f"/api/stats?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        heatmap = data["miningHeatmapData"]

        # Top-level keys should be year strings
        for year_key, date_map in heatmap.items():
            assert isinstance(year_key, str)
            assert year_key.isdigit() and len(year_key) == 4, (
                f"Year key should be a 4-digit string, got {year_key!r}"
            )
            # Each value should be a dict of {date_str: int}
            assert isinstance(date_map, dict)
            for date_key, count in date_map.items():
                assert isinstance(date_key, str)
                # Date should be YYYY-MM-DD format
                datetime.date.fromisoformat(date_key)
                assert isinstance(count, int)
                assert count > 0, "Zero-card dates should be excluded"

    def test_mining_heatmap_reflects_seeded_cards(self, client, monkeypatch):
        """Card counts in miningHeatmapData should match seeded anki_cards_created."""
        _patch_heavy_deps(monkeypatch)

        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        yesterday_str = yesterday.strftime("%Y-%m-%d")
        year_str = yesterday.strftime("%Y")
        _seed_rollup(yesterday_str, anki_cards=12)

        start_ts = datetime.datetime.combine(
            yesterday - datetime.timedelta(days=1), datetime.time.min
        ).timestamp()
        end_ts = datetime.datetime.combine(today, datetime.time.max).timestamp()

        resp = client.get(f"/api/stats?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        heatmap = data["miningHeatmapData"]
        assert year_str in heatmap
        assert yesterday_str in heatmap[year_str]
        assert heatmap[year_str][yesterday_str] == 12

    def test_zero_cards_excluded_from_heatmap(self, client, monkeypatch):
        """Dates with anki_cards_created == 0 should not appear in miningHeatmapData."""
        _patch_heavy_deps(monkeypatch)

        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        day_before = today - datetime.timedelta(days=2)
        yesterday_str = yesterday.strftime("%Y-%m-%d")
        day_before_str = day_before.strftime("%Y-%m-%d")

        _seed_rollup(yesterday_str, anki_cards=0)
        _seed_rollup(day_before_str, anki_cards=5)

        start_ts = datetime.datetime.combine(
            day_before - datetime.timedelta(days=1), datetime.time.min
        ).timestamp()
        end_ts = datetime.datetime.combine(today, datetime.time.max).timestamp()

        resp = client.get(f"/api/stats?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        heatmap = data["miningHeatmapData"]

        # Flatten all dates across years
        all_dates = {}
        for year_dates in heatmap.values():
            all_dates.update(year_dates)

        assert yesterday_str not in all_dates, "Date with 0 cards should be excluded"
        assert day_before_str in all_dates
        assert all_dates[day_before_str] == 5


class TestRemovedKeysAbsent:
    """Verify removed keys are no longer in the /api/stats response."""

    def test_removed_keys_absent_with_data(self, client, monkeypatch):
        """allLinesData, kanjiGridData, gameMilestones must not appear in /api/stats."""
        _patch_heavy_deps(monkeypatch)

        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        _seed_rollup(yesterday.strftime("%Y-%m-%d"), total_chars=2000, anki_cards=3)

        start_ts = datetime.datetime.combine(
            yesterday - datetime.timedelta(days=1), datetime.time.min
        ).timestamp()
        end_ts = datetime.datetime.combine(today, datetime.time.max).timestamp()

        resp = client.get(f"/api/stats?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        present = REMOVED_KEYS & set(data.keys())
        assert not present, f"Removed keys still present: {present}"


class TestKanjiGridEndpoint:
    """Verify /api/stats/kanji-grid response shape."""

    def test_kanji_grid_returns_expected_shape(self, client, monkeypatch):
        """/api/stats/kanji-grid must return {kanji_data, unique_count, max_frequency}."""
        _patch_heavy_deps(monkeypatch)

        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        _seed_rollup(yesterday.strftime("%Y-%m-%d"))

        start_ts = datetime.datetime.combine(
            yesterday - datetime.timedelta(days=1), datetime.time.min
        ).timestamp()
        end_ts = datetime.datetime.combine(today, datetime.time.max).timestamp()

        resp = client.get(f"/api/stats/kanji-grid?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        assert "kanji_data" in data
        assert "unique_count" in data
        assert "max_frequency" in data
        assert isinstance(data["kanji_data"], list)
        assert isinstance(data["unique_count"], int)
        assert isinstance(data["max_frequency"], int)

    def test_kanji_grid_empty_db(self, client, monkeypatch):
        """With no data, kanji-grid should return the empty fallback shape."""
        _patch_heavy_deps(monkeypatch)

        resp = client.get("/api/stats/kanji-grid")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["kanji_data"] == []
        assert data["unique_count"] == 0
        assert data["max_frequency"] == 0


class TestGameMilestonesEndpoint:
    """Verify /api/stats/game-milestones response shape."""

    def test_game_milestones_returns_dict_or_null(self, client, monkeypatch):
        """/api/stats/game-milestones must return a dict or null."""
        _patch_heavy_deps(monkeypatch)

        resp = client.get("/api/stats/game-milestones")
        assert resp.status_code == 200

        data = resp.get_json()
        # calculate_game_milestones is patched to return None
        assert data is None or isinstance(data, dict)


class TestAllLinesDataEndpoint:
    """Verify /api/stats/all-lines-data response shape."""

    def test_all_lines_data_returns_array(self, client, monkeypatch):
        """/api/stats/all-lines-data must return an array."""
        _patch_heavy_deps(monkeypatch)

        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        _seed_rollup(yesterday.strftime("%Y-%m-%d"))

        start_ts = datetime.datetime.combine(
            yesterday - datetime.timedelta(days=1), datetime.time.min
        ).timestamp()
        end_ts = datetime.datetime.combine(today, datetime.time.max).timestamp()

        resp = client.get(f"/api/stats/all-lines-data?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        assert isinstance(data, list)

    def test_all_lines_data_element_shape(self, client, monkeypatch):
        """Each element must have timestamp, date, characters, reading_time_seconds."""
        _patch_heavy_deps(monkeypatch)

        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        _seed_rollup(yesterday.strftime("%Y-%m-%d"), total_chars=500, total_lines=10)

        start_ts = datetime.datetime.combine(
            yesterday - datetime.timedelta(days=1), datetime.time.min
        ).timestamp()
        end_ts = datetime.datetime.combine(today, datetime.time.max).timestamp()

        resp = client.get(f"/api/stats/all-lines-data?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        for item in data:
            assert "timestamp" in item
            assert "date" in item
            assert "characters" in item
            assert "reading_time_seconds" in item
            # date should be YYYY-MM-DD
            datetime.date.fromisoformat(item["date"])

    def test_all_lines_data_empty_db(self, client, monkeypatch):
        """With no data, all-lines-data should return an empty array."""
        _patch_heavy_deps(monkeypatch)

        resp = client.get("/api/stats/all-lines-data")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data == []
