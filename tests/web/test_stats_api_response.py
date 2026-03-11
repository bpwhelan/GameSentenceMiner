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
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_stats


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


def _seed_rollup(date_str: str, total_chars: int = 1000, total_lines: int = 50,
                 reading_time: float = 3600.0, anki_cards: int = 5,
                 game_activity: dict | None = None):
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
    # Patch cron_scheduler if it tries to do anything at import time
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.cron_scheduler",
        type("FakeCron", (), {"get_stats_config": staticmethod(lambda: None)})(),
    )


# ---------------------------------------------------------------------------
# Expected top-level keys in the /api/stats response
# ---------------------------------------------------------------------------

EXPECTED_TOP_LEVEL_KEYS = {
    "labels",
    "datasets",
    "cardsMinedLast30Days",
    "kanjiGridData",
    "heatmapData",
    "totalCharsPerGame",
    "readingTimePerGame",
    "readingSpeedPerGame",
    "currentGameStats",
    "allGamesStats",
    "allLinesData",
    "hourlyActivityData",
    "hourlyReadingSpeedData",
    "peakDailyStats",
    "peakSessionStats",
    "gameMilestones",
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
