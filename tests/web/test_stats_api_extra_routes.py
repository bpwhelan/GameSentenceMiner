"""
Additional endpoint tests for stats APIs not currently covered by existing tests.
"""

from __future__ import annotations

import datetime
import json

import flask
import pytest
from types import SimpleNamespace

from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.web.stats_api import register_stats_api_routes


@pytest.fixture(autouse=True)
def _in_memory_db():
    """Use a fresh in-memory DB for each endpoint test."""
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
    register_stats_api_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


def _seed_rollup(
    date_str: str,
    *,
    total_chars: int = 0,
    total_lines: int = 0,
    reading_time: float = 0,
    kanji_frequency_data: str | None = None,
) -> None:
    StatsRollupTable(
        date=date_str,
        total_lines=total_lines,
        total_characters=total_chars,
        total_reading_time_seconds=reading_time,
        anki_cards_created=0,
        game_activity_data='{"abc": {"title": "Test Game", "lines": 1, "chars": 0}}',
        kanji_frequency_data=kanji_frequency_data,
        hourly_activity_data="{}",
        hourly_reading_speed_data="{}",
        genre_activity_data="{}",
        type_activity_data="{}",
    ).save()


class TestDailyActivityRoute:
    def test_default_route_returns_28_days_and_fills_gaps(self, client):
        today = datetime.date.today()
        two_days_ago = today - datetime.timedelta(days=2)
        yesterday = today - datetime.timedelta(days=1)

        _seed_rollup(
            two_days_ago.isoformat(),
            total_chars=120,
            total_lines=1,
            reading_time=3600,
        )
        _seed_rollup(
            yesterday.isoformat(),
            total_chars=60,
            total_lines=2,
            reading_time=1800,
        )

        resp = client.get("/api/daily-activity")
        assert resp.status_code == 200

        data = resp.get_json()
        expected_start = today - datetime.timedelta(days=27)
        assert data["labels"][0] == expected_start.isoformat()
        assert data["labels"][-1] == today.isoformat()
        assert len(data["labels"]) == 28
        assert len(data["timeData"]) == 28
        assert len(data["charsData"]) == 28
        assert len(data["speedData"]) == 28

        by_date = {
            date: (time, chars, speed)
            for date, time, chars, speed in zip(data["labels"], data["timeData"], data["charsData"], data["speedData"])
        }
        assert by_date[two_days_ago.isoformat()] == (1.0, 120, 120)
        assert by_date[yesterday.isoformat()] == (0.5, 60, 120)
        assert by_date[today.isoformat()] == (0, 0, 0)
        assert by_date[expected_start.isoformat()] == (0, 0, 0)

    def test_explicit_range_returns_inclusive_zero_filled_days(self, client):
        start_date = datetime.date(2026, 3, 10)
        middle_date = datetime.date(2026, 3, 11)
        end_date = datetime.date(2026, 3, 12)

        _seed_rollup(
            start_date.isoformat(),
            total_chars=120,
            total_lines=1,
            reading_time=3600,
        )
        _seed_rollup(
            end_date.isoformat(),
            total_chars=60,
            total_lines=2,
            reading_time=1800,
        )

        start_ts = datetime.datetime.combine(start_date, datetime.time.min).timestamp()
        end_ts = datetime.datetime.combine(end_date, datetime.time.max).timestamp()

        resp = client.get(f"/api/daily-activity?start={start_ts}&end={end_ts}")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["labels"] == [
            start_date.isoformat(),
            middle_date.isoformat(),
            end_date.isoformat(),
        ]
        assert data["timeData"] == [1.0, 0, 0.5]
        assert data["charsData"] == [120, 0, 60]
        assert data["speedData"] == [120, 0, 120]

    def test_all_time_without_rollups_returns_empty_arrays(self, client, monkeypatch):
        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_api.StatsRollupTable.get_first_date",
            lambda: None,
        )
        resp = client.get("/api/daily-activity?all_time=true")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data == {
            "labels": [],
            "timeData": [],
            "charsData": [],
            "speedData": [],
        }


class TestKanjiFrequencyRoute:
    def test_invalid_kanji_query_returns_400(self, client):
        resp = client.get("/api/kanji-frequency")
        assert resp.status_code == 400
        assert resp.get_json()["error"] == "Invalid kanji parameter"

        resp = client.get("/api/kanji-frequency?kanji=ab")
        assert resp.status_code == 400

    def test_counts_are_aggregated_from_rollups(self, client):
        today = datetime.date.today()
        target = today - datetime.timedelta(days=2)
        invalid = today - datetime.timedelta(days=1)

        _seed_rollup(
            target.isoformat(),
            kanji_frequency_data=json.dumps({"日": 2, "本": 4}),
            total_chars=1,
        )
        _seed_rollup(
            invalid.isoformat(),
            kanji_frequency_data="{bad-json",
            total_chars=1,
        )

        _seed_rollup(
            today.isoformat(),
            kanji_frequency_data=json.dumps({"日": 3}),
            total_chars=1,
        )

        resp = client.get("/api/kanji-frequency?kanji=%E6%97%A5")
        assert resp.status_code == 200
        assert resp.get_json() == {"kanji": "日", "count": 5}


class TestTodayStatsRoute:
    class _FixedDate(datetime.date):
        @classmethod
        def today(cls):
            return cls(2026, 3, 12)

    class _FixedDateTime(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 3, 12, 12, 0, 0, tzinfo=tz)

    def _patch_time(self, monkeypatch):
        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_api.datetime.date",
            self._FixedDate,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_api.datetime.datetime",
            self._FixedDateTime,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_api.get_stats_config",
            lambda: SimpleNamespace(
                session_gap_seconds=5000,
            ),
        )

    def _seed_lines(self):
        lines = [
            ("line-1", "abc", datetime.datetime(2026, 3, 12, 10, 0, 0).timestamp()),
            ("line-2", "de", datetime.datetime(2026, 3, 12, 10, 2, 0).timestamp()),
            ("line-3", "f", datetime.datetime(2026, 3, 12, 10, 5, 0).timestamp()),
        ]

        for line_id, text, ts in lines:
            GameLinesTable(
                id=line_id,
                game_name="Test Game",
                line_text=text,
                timestamp=ts,
            ).add()

    def test_today_stats_empty_without_lines(self, client):
        resp = client.get("/api/today-stats")
        assert resp.status_code == 200

        assert resp.get_json() == {
            "todayTotalChars": 0,
            "todayCharsPerHour": 0,
            "todayTotalHours": 0,
            "todaySessions": 0,
            "sessions": [],
        }

    def test_today_stats_with_session_summary(self, client, monkeypatch):
        self._patch_time(monkeypatch)
        self._seed_lines()

        resp = client.get("/api/today-stats")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["todayTotalChars"] == 6
        assert data["todayTotalHours"] == 0.01
        assert data["todayCharsPerHour"] == 720
        assert data["todaySessions"] == 1
        assert len(data["sessions"]) == 1

        session = data["sessions"][0]
        assert session["totalChars"] == 6
        assert session["totalSeconds"] == 30.0
        assert session["charsPerHour"] == 720

    def test_today_stats_uses_preloaded_game_metadata_for_linked_lines(self, client, monkeypatch):
        self._patch_time(monkeypatch)
        GamesTable(
            id="game-1",
            title_original="Pretty Title",
            obs_scene_name="Scene Name",
            game_type="VN",
            genres=["Mystery"],
            tags=["Story Rich"],
            character_count=1234,
            completed=True,
        ).save()

        GameLinesTable(
            id="line-1",
            game_name="Scene Name",
            game_id="game-1",
            line_text="abcdef",
            timestamp=datetime.datetime(2026, 3, 12, 10, 0, 0).timestamp(),
        ).add()

        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_api.GamesTable.get_by_game_line",
            lambda line: pytest.fail("today-stats should use preloaded game metadata"),
        )

        resp = client.get("/api/today-stats")

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["todaySessions"] == 1
        session = data["sessions"][0]
        assert session["gameName"] == "Pretty Title"
        assert session["gameMetadata"]["game_id"] == "game-1"
        assert session["gameMetadata"]["title_original"] == "Pretty Title"
        assert session["gameMetadata"]["type"] == "VN"
        assert session["gameMetadata"]["genres"] == ["Mystery"]
        assert session["gameMetadata"]["tags"] == ["Story Rich"]
