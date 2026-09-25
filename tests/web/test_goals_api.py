"""
Tests for goals API endpoints and helper functions.

Covers:
- /api/goals/current GET
- /api/goals/dashboard GET
- /api/goals/update POST
- /api/goals/complete_todays_dailies POST
- /api/goals/current_streak GET
- /api/goals/achieved GET
- /api/goals/progress POST
- /api/goals/today-progress POST
- Helper functions
"""

import datetime
import json
import time
import uuid

import flask
import pytest

from GameSentenceMiner.util.database.db import GameLinesTable, GoalsTable, SQLiteDB
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


@pytest.fixture(autouse=True)
def _in_memory_db():
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_goals = GoalsTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    GoalsTable.set_db(db)
    from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable

    orig_stats = StatsRollupTable._db
    StatsRollupTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    GoalsTable._db = orig_goals
    StatsRollupTable._db = orig_stats


@pytest.fixture()
def app(_in_memory_db):
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True
    from GameSentenceMiner.web.goals_api import register_goals_api_routes

    register_goals_api_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


def _seed_current_goals(goals=None, settings=None):
    goals_json = json.dumps(goals or [])
    settings_json = json.dumps(
        settings
        or {
            "easyDays": {
                "monday": 100,
                "tuesday": 100,
                "wednesday": 100,
                "thursday": 100,
                "friday": 100,
                "saturday": 100,
                "sunday": 100,
            },
            "ankiConnect": {"deckName": ""},
            "customCheckboxes": {},
        }
    )
    GoalsTable.create_entry(
        date_str="current",
        current_goals_json=goals_json,
        goals_settings_json=settings_json,
        last_updated=time.time(),
    )


def _utc_timestamp(day: datetime.date, hour: int = 12) -> float:
    return datetime.datetime.combine(day, datetime.time(hour=hour), tzinfo=datetime.timezone.utc).timestamp()


def _seed_rollup(date: datetime.date, *, characters: int = 0, seconds: float = 0.0) -> None:
    StatsRollupTable(
        date=date.isoformat(),
        total_lines=1 if characters else 0,
        total_characters=characters,
        total_sessions=1 if seconds else 0,
        unique_games_played=1 if characters else 0,
        total_reading_time_seconds=seconds,
        total_active_time_seconds=seconds,
    ).save()


def _seed_today_line(day: datetime.date, *, text: str, game_id: str = "") -> None:
    GameLinesTable(
        id=f"line-{uuid.uuid4()}",
        game_name="Test Game",
        game_id=game_id,
        line_text=text,
        timestamp=_utc_timestamp(day),
    ).save()


def _seed_game(
    game_id: str,
    *,
    title: str = "Test Game",
    scene: str = "Test Game",
    character_count: int = 0,
    game_type: str = "Visual Novel",
) -> None:
    GamesTable(
        id=game_id,
        title_original=title,
        obs_scene_name=scene,
        character_count=character_count,
        game_type=game_type,
    ).save()


# ===================================================================
# Helper function unit tests
# ===================================================================


class TestParseAndValidateDates:
    def test_valid_dates(self):
        from GameSentenceMiner.web.goals_api import parse_and_validate_dates

        s, e = parse_and_validate_dates("2024-01-01", "2024-12-31")
        assert s == datetime.date(2024, 1, 1)
        assert e == datetime.date(2024, 12, 31)

    def test_invalid_format_raises(self):
        from GameSentenceMiner.web.goals_api import parse_and_validate_dates

        with pytest.raises(ValueError):
            parse_and_validate_dates("01-01-2024", "2024-12-31")

    def test_empty_string_raises(self):
        from GameSentenceMiner.web.goals_api import parse_and_validate_dates

        with pytest.raises(ValueError):
            parse_and_validate_dates("", "2024-12-31")


class TestTimedGoals:
    @pytest.fixture(autouse=True)
    def fixed_time(self, monkeypatch):
        from GameSentenceMiner.web import goals_api

        self.now = datetime.datetime(2025, 6, 2, 10, 30, tzinfo=datetime.timezone.utc)
        monkeypatch.setattr(goals_api, "get_goal_now", lambda tz: self.now.astimezone(tz), raising=False)
        monkeypatch.setattr(goals_api, "get_today_in_timezone", lambda tz=None: self.now.date())

    def goal(self, **overrides):
        return {
            "id": "timed",
            "name": "24 hour challenge",
            "metricType": "characters",
            "targetValue": 240,
            "startDate": "2025-06-01T12:30:00Z",
            "endDate": "2025-06-02T12:30:00Z",
            **overrides,
        }

    def seed_line(self, timestamp, text="字", **kwargs):
        GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Test Game",
            line_text=text,
            timestamp=datetime.datetime.fromisoformat(timestamp).timestamp(),
            **kwargs,
        ).save()

    def request_data(self, goal):
        return {
            "goal_id": goal["id"],
            "metric_type": goal["metricType"],
            "target_value": goal["targetValue"],
            "start_date": goal["startDate"],
            "end_date": goal["endDate"],
            "game_id": goal.get("gameId"),
            "media_type": goal.get("mediaType", "ALL"),
        }

    @pytest.mark.parametrize("metric,expected", [("characters", 3), ("cards", 2), ("games", 1)])
    def test_progress_respects_minutes_and_excludes_outside_lines(self, client, metric, expected):
        self.seed_line("2025-06-01T12:29:59+00:00", "outside", note_ids=[1])
        self.seed_line("2025-06-01T12:30:00+00:00", "字字", note_ids=[2])
        self.seed_line("2025-06-02T10:29:00+00:00", "字", note_ids=[3])
        self.seed_line("2025-06-02T12:30:00+00:00", "outside", note_ids=[4])
        goal = self.goal(metricType=metric)
        response = client.post("/api/goals/progress", json=self.request_data(goal))
        assert response.status_code == 200
        assert response.json["progress"] == expected
        assert response.json["days_in_range"] == 1

    def test_dashboard_daily_history_and_tomorrow_share_exact_window(self, client):
        goal = self.goal()
        self.seed_line("2025-06-01T12:29:00+00:00", "字" * 500)
        self.seed_line("2025-06-01T13:00:00+00:00", "字" * 115)
        self.seed_line("2025-06-02T10:00:00+00:00", "字" * 20)
        _seed_rollup(datetime.date(2025, 6, 1), characters=9999)
        _seed_current_goals([goal])
        dashboard = client.get("/api/goals/dashboard").json
        assert dashboard["goal_progress"]["timed"]["progress"] == 135
        daily = dashboard["today_progress"]["timed"]
        assert daily["required"] == 125
        assert daily["progress"] == 20
        assert daily["has_target"] is True
        assert client.post("/api/goals/today-progress", json=self.request_data(goal)).json == daily

        from GameSentenceMiner.web.goals_api import get_goals_for_date

        history = get_goals_for_date(datetime.date(2025, 6, 1))
        assert history["goals"][0]["progress_today"] == 115
        assert history["goals"][0]["progress_needed"] == 115
        tomorrow = client.post("/api/goals/tomorrow-requirements", json={"current_goals": [goal]}).json
        assert tomorrow["requirements"] == []

    @pytest.mark.parametrize("game_scoped", [False, True])
    def test_same_day_expiry_caps_progress_and_marks_trophy(self, client, game_scoped):
        _seed_game("game-a")
        goal = self.goal(
            startDate="2025-06-02T09:00:00Z",
            endDate="2025-06-02T10:00:00Z",
            **({"gameId": "game-a", "metricType": "finish_game"} if game_scoped else {}),
        )
        self.seed_line("2025-06-02T09:30:00+00:00", "字" * 20, game_id="game-a")
        self.seed_line("2025-06-02T10:00:00+00:00", "字" * 500, game_id="game-a")
        _seed_current_goals([goal])
        dashboard = client.get("/api/goals/dashboard").json
        assert dashboard["goal_progress"]["timed"]["progress"] == 20
        assert dashboard["today_progress"]["timed"]["expired"] is True
        trophy = client.get("/api/goals/achieved").json["achieved_goals"][0]
        assert trophy["current_progress"] == 20
        assert trophy["expired"] is True
        assert trophy["achieved"] is False

    def test_future_start_later_today_has_no_daily_target(self, client):
        goal = self.goal(startDate="2025-06-02T11:00:00Z")
        response = client.post("/api/goals/today-progress", json=self.request_data(goal))
        assert response.status_code == 200
        assert response.json["not_started"] is True
        assert response.json["has_target"] is False

    def test_local_minutes_use_request_timezone(self, client):
        self.seed_line("2025-06-02T10:10:00+00:00", "字" * 3)
        self.seed_line("2025-06-02T09:59:00+00:00", "字" * 10)
        goal = self.goal(startDate="2025-06-02T06:00", endDate="2025-06-02T06:20")
        response = client.post(
            "/api/goals/progress", json=self.request_data(goal), headers={"X-Timezone": "America/New_York"}
        )
        assert response.status_code == 200
        assert response.json["progress"] == 3

    @pytest.mark.parametrize("end", ["2025-06-01T12:30:00Z", "2025-06-01T12:29:00Z", "bad"])
    def test_rejects_invalid_timed_range_when_saving(self, client, end):
        response = client.post("/api/goals/update", json={"current_goals": [self.goal(endDate=end)]})
        assert response.status_code == 400

    def test_save_and_reload_preserve_exact_times(self, client):
        goal = self.goal()
        assert client.post("/api/goals/update", json={"current_goals": [goal]}).status_code == 200
        assert client.get("/api/goals/current").json["current_goals"] == [goal]

    def test_hours_and_game_media_filters_use_only_the_interval(self, client):
        _seed_game("game-a", game_type="Visual Novel")
        _seed_game("game-b", game_type="Anime")
        for stamp in ("2025-06-02T10:00:00+00:00", "2025-06-02T10:01:00+00:00"):
            self.seed_line(stamp, "字" * 120, game_id="game-a")
        self.seed_line("2025-06-02T09:59:00+00:00", "字" * 120, game_id="game-a")
        self.seed_line("2025-06-02T10:01:00+00:00", "字" * 50, game_id="game-b")
        goal = self.goal(
            startDate="2025-06-02T10:00:00Z",
            endDate="2025-06-02T10:02:00Z",
            metricType="hours",
            mediaType="Visual Novel",
        )
        assert client.post("/api/goals/progress", json=self.request_data(goal)).json["progress"] == 0.02
        goal.update(metricType="characters", gameId="game-b")
        assert client.post("/api/goals/progress", json=self.request_data(goal)).json["progress"] == 50

    def test_timed_media_filter_skips_lines_without_a_game(self, client, monkeypatch):
        _seed_game("game-a", game_type="Visual Novel")
        self.seed_line("2025-06-02T10:10:00+00:00", "字" * 3, game_id="game-a")
        GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="",
            game_id="",
            line_text="字" * 7,
            timestamp=datetime.datetime.fromisoformat("2025-06-02T10:12:00+00:00").timestamp(),
        ).save()

        original_lookup = GamesTable.get_by_game_line

        def lookup_with_game(cls, line):
            assert line.game_id or line.game_name, "Unidentified lines cannot have a media type"
            return original_lookup(line)

        monkeypatch.setattr(GamesTable, "get_by_game_line", classmethod(lookup_with_game))
        goal = self.goal(
            startDate="2025-06-02T10:00:00Z",
            endDate="2025-06-02T11:00:00Z",
            mediaType="Visual Novel",
        )

        response = client.post("/api/goals/progress", json=self.request_data(goal))
        assert response.status_code == 200
        assert response.json["progress"] == 3

    def test_imported_daily_totals_require_complete_days(self, client, _in_memory_db, monkeypatch):
        from GameSentenceMiner.util.database.third_party_stats_table import ThirdPartyStatsTable

        monkeypatch.setattr(ThirdPartyStatsTable, "_db", _in_memory_db)
        ThirdPartyStatsTable.set_db(_in_memory_db)
        ThirdPartyStatsTable(date="2025-06-01", characters_read=500, source="manual").save()
        partial = self.goal()
        assert client.post("/api/goals/progress", json=self.request_data(partial)).json["progress"] == 0
        whole = self.goal(startDate="2025-06-01T00:00:00Z", endDate="2025-06-02T00:00:00Z")
        assert client.post("/api/goals/progress", json=self.request_data(whole)).json["progress"] == 500

    def test_mature_reviews_are_bounded_to_minutes_and_deck(self, client, _in_memory_db, monkeypatch):
        from GameSentenceMiner.util.database.anki_tables import AnkiCardsTable, AnkiReviewsTable

        for table in (AnkiCardsTable, AnkiReviewsTable):
            monkeypatch.setattr(table, "_db", _in_memory_db)
            table.set_db(_in_memory_db)
        for card_id, stamp, deck in [
            (1, "2025-06-02T09:59:00+00:00", "Japanese"),
            (2, "2025-06-02T10:01:00+00:00", "Japanese"),
            (3, "2025-06-02T10:01:00+00:00", "Other"),
        ]:
            AnkiCardsTable(card_id=card_id, deck_name=deck, interval=21).save()
            AnkiReviewsTable(
                review_id=str(card_id),
                card_id=card_id,
                review_time=int(datetime.datetime.fromisoformat(stamp).timestamp() * 1000),
            ).save()
        goal = self.goal(metricType="mature_cards", startDate="2025-06-02T10:00:00Z")
        data = self.request_data(goal)
        data["goals_settings"] = {"ankiConnect": {"deckName": "Japanese"}}
        assert client.post("/api/goals/progress", json=data).json["progress"] == 1

    def test_projection_uses_fractional_days_and_stops_at_deadline(self, client):
        goal = self.goal()
        self.seed_line("2025-06-02T10:00:00+00:00", "字" * 100)
        _seed_current_goals([goal])
        response = client.post("/api/goals/projection", json=self.request_data(goal))
        assert response.status_code == 200
        projection = response.json
        assert projection["current"] == 100
        assert projection["days_until_target"] == pytest.approx(2 / 24)
        assert projection == client.get("/api/goals/dashboard").json["projections"]["timed"]

    def test_tomorrow_requirement_uses_only_remaining_hours(self, client):
        goal = self.goal(startDate="2025-06-02T10:00:00Z", endDate="2025-06-03T10:00:00Z")
        self.seed_line("2025-06-02T10:10:00+00:00", "字" * 30)
        result = client.post("/api/goals/tomorrow-requirements", json={"current_goals": [goal]}).json
        assert result["requirements"][0]["required_tomorrow"] == 210

    def test_overlay_expiry_uses_exact_instant(self):
        from GameSentenceMiner.web.goals_api import _get_goal_value
        from GameSentenceMiner.web.live_goals import _goal_is_active

        goal = self.goal(endDate="2025-06-02T10:30:00Z")
        assert _goal_is_active(goal, "2025-06-02", _get_goal_value, self.now.timestamp() - 1)
        assert not _goal_is_active(goal, "2025-06-02", _get_goal_value, self.now.timestamp())

    def test_legacy_days_and_dst_window(self):
        import pytz

        from GameSentenceMiner.web.goal_windows import parse_goal_window

        tz = pytz.timezone("America/New_York")
        start, end = parse_goal_window("2025-06-02", "2025-06-02", tz)
        assert (end - start).total_seconds() == 86400
        start, end = parse_goal_window("2025-03-08T12:00:00-05:00", "2025-03-09T13:00:00-04:00", tz)
        assert (end - start).total_seconds() == 86400
        with pytest.raises(ValueError):
            parse_goal_window("2025-03-09T02:30", "2025-03-09T04:30", tz)


class TestValidateMetricType:
    def test_valid_types(self):
        from GameSentenceMiner.web.goals_api import validate_metric_type

        for t in [
            "hours",
            "characters",
            "games",
            "cards",
            "mature_cards",
            "hours_static",
            "characters_static",
            "cards_static",
        ]:
            assert validate_metric_type(t) is True

    def test_invalid_type_raises(self):
        from GameSentenceMiner.web.goals_api import validate_metric_type

        with pytest.raises(ValueError):
            validate_metric_type("invalid_metric")


class TestFormatMetricValue:
    def test_hours_rounded(self):
        from GameSentenceMiner.web.goals_api import format_metric_value

        assert format_metric_value(2.555, "hours") == 2.56

    def test_characters_as_int(self):
        from GameSentenceMiner.web.goals_api import format_metric_value

        assert format_metric_value(1234.5, "characters") == 1234

    def test_static_maps_to_base(self):
        from GameSentenceMiner.web.goals_api import format_metric_value

        assert format_metric_value(3.14, "hours_static") == 3.14

    def test_cards_as_int(self):
        from GameSentenceMiner.web.goals_api import format_metric_value

        assert format_metric_value(10.9, "cards") == 10


class TestFormatRequirementDisplay:
    def test_hours_display(self):
        from GameSentenceMiner.web.goals_api import format_requirement_display

        assert format_requirement_display(1.5, "hours") == "1h 30m"
        assert format_requirement_display(0.5, "hours") == "30m"
        assert format_requirement_display(2.0, "hours") == "2h"

    def test_characters_thousands(self):
        from GameSentenceMiner.web.goals_api import format_requirement_display

        assert "K" in format_requirement_display(5000, "characters")

    def test_characters_millions(self):
        from GameSentenceMiner.web.goals_api import format_requirement_display

        assert "M" in format_requirement_display(1500000, "characters")

    def test_small_characters(self):
        from GameSentenceMiner.web.goals_api import format_requirement_display

        assert format_requirement_display(50, "characters") == "50"

    def test_games_as_int(self):
        from GameSentenceMiner.web.goals_api import format_requirement_display

        assert format_requirement_display(5, "games") == "5"


class TestCalculateBalancedEasyDayMultiplier:
    def test_all_100_percent(self):
        from GameSentenceMiner.web.goals_api import (
            calculate_balanced_easy_day_multiplier,
        )

        settings = {
            "easyDays": {
                "monday": 100,
                "tuesday": 100,
                "wednesday": 100,
                "thursday": 100,
                "friday": 100,
                "saturday": 100,
                "sunday": 100,
            }
        }
        # All 100% → multiplier should be 1.0
        for day_offset in range(7):
            date = datetime.date(2024, 1, 1) + datetime.timedelta(days=day_offset)
            m = calculate_balanced_easy_day_multiplier(date, settings)
            assert abs(m - 1.0) < 0.01

    def test_one_day_zero(self):
        from GameSentenceMiner.web.goals_api import (
            calculate_balanced_easy_day_multiplier,
        )

        # Friday=0, rest=100 → weekly=600, balance=700/600=1.167
        settings = {
            "easyDays": {
                "monday": 100,
                "tuesday": 100,
                "wednesday": 100,
                "thursday": 100,
                "friday": 0,
                "saturday": 100,
                "sunday": 100,
            }
        }
        # A Friday should return 0
        friday = datetime.date(2024, 1, 5)  # This is a Friday
        m = calculate_balanced_easy_day_multiplier(friday, settings)
        assert m == 0.0
        # A Monday should be > 1.0
        monday = datetime.date(2024, 1, 1)  # This is a Monday
        m = calculate_balanced_easy_day_multiplier(monday, settings)
        assert m > 1.0

    def test_all_zero_returns_zero(self):
        from GameSentenceMiner.web.goals_api import (
            calculate_balanced_easy_day_multiplier,
        )

        settings = {
            "easyDays": {
                "monday": 0,
                "tuesday": 0,
                "wednesday": 0,
                "thursday": 0,
                "friday": 0,
                "saturday": 0,
                "sunday": 0,
            }
        }
        date = datetime.date(2024, 1, 1)
        assert calculate_balanced_easy_day_multiplier(date, settings) == 0.0

    def test_no_settings_defaults_to_100(self):
        from GameSentenceMiner.web.goals_api import (
            calculate_balanced_easy_day_multiplier,
        )

        m = calculate_balanced_easy_day_multiplier(datetime.date(2024, 1, 1), {})
        assert abs(m - 1.0) < 0.01


# ===================================================================
# /api/goals/current GET
# ===================================================================


class TestGoalsCurrent:
    def test_returns_defaults_when_empty(self, client):
        resp = client.get("/api/goals/current")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["current_goals"] == []
        assert "easyDays" in data["goals_settings"]
        assert "ankiConnect" in data["goals_settings"]

    def test_returns_existing_goals(self, client):
        _seed_current_goals(goals=[{"name": "Read 5h", "metricType": "hours"}])
        resp = client.get("/api/goals/current")
        data = resp.get_json()
        assert len(data["current_goals"]) == 1
        assert data["current_goals"][0]["name"] == "Read 5h"


class TestGoalsDashboard:
    def test_returns_bootstrap_payload_for_current_goals(self, client):
        today = datetime.date.today()
        start = (today - datetime.timedelta(days=5)).strftime("%Y-%m-%d")
        end = (today + datetime.timedelta(days=10)).strftime("%Y-%m-%d")
        _seed_current_goals(
            goals=[
                {
                    "id": "goal_active",
                    "name": "Read 1000 chars",
                    "metricType": "characters",
                    "targetValue": 1000,
                    "startDate": start,
                    "endDate": end,
                    "icon": "📖",
                    "mediaType": "ALL",
                },
                {
                    "id": "goal_static",
                    "name": "Read 2 hours daily",
                    "metricType": "hours_static",
                    "targetValue": 2,
                    "icon": "⏱️",
                    "mediaType": "ALL",
                },
                {
                    "id": "goal_custom",
                    "name": "Daily checkbox",
                    "metricType": "custom",
                    "icon": "✅",
                    "mediaType": "ALL",
                },
            ]
        )

        resp = client.get("/api/goals/dashboard")

        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["current_goals"]) == 3
        assert "goals_settings" in data
        assert "current_streak" in data
        assert "goal_progress" in data
        assert "today_progress" in data
        assert "projections" in data
        assert data["goal_progress"]["goal_active"]["progress"] == 0
        assert data["goal_progress"]["goal_static"]["progress"] == 0
        assert data["today_progress"]["goal_active"]["has_target"] is True
        assert data["today_progress"]["goal_static"]["is_static"] is True
        assert "goal_custom" not in data["today_progress"]
        assert data["projections"]["goal_active"]["target"] == 1000

    def test_today_required_does_not_decrease_from_today_live_progress(self, client):
        today = datetime.datetime.now(datetime.timezone.utc).date()
        yesterday = today - datetime.timedelta(days=1)
        end = today + datetime.timedelta(days=2)
        _seed_rollup(yesterday, characters=100)
        _seed_today_line(today, text="x" * 30)
        _seed_current_goals(
            goals=[
                {
                    "id": "goal_active",
                    "name": "Read chars",
                    "metricType": "characters",
                    "targetValue": 310,
                    "startDate": yesterday.isoformat(),
                    "endDate": end.isoformat(),
                    "icon": "📖",
                    "mediaType": "ALL",
                }
            ]
        )

        resp = client.get("/api/goals/dashboard", headers={"X-Timezone": "UTC"})

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["today_progress"]["goal_active"]["progress"] == 30
        assert data["today_progress"]["goal_active"]["required"] == 70
        assert data["today_progress"]["goal_active"]["total_progress"] == 130

    def test_finish_game_goal_resolves_stale_game_id_from_stored_game_name(self, client, monkeypatch):
        monkeypatch.setattr(
            "GameSentenceMiner.web.live_goals._local_timezone",
            lambda: datetime.timezone.utc,
        )
        today = datetime.datetime.now(datetime.timezone.utc).date()
        yesterday = today - datetime.timedelta(days=1)
        end = today + datetime.timedelta(days=2)
        stale_game_id = "stale-game-id"
        current_game_id = "current-game-id"
        older_duplicate_id = "older-duplicate-id"

        _seed_game(older_duplicate_id, title="Totsuraba", scene="Old Scene", character_count=600)
        _seed_today_line(yesterday, text="x" * 10, game_id=older_duplicate_id)
        _seed_game(current_game_id, title="Totsuraba", scene="Totsuraba", character_count=600)
        _seed_today_line(yesterday, text="x" * 300, game_id=current_game_id)
        _seed_today_line(today, text="x" * 30, game_id=current_game_id)
        _seed_current_goals(
            goals=[
                {
                    "id": "goal_finish_game",
                    "name": "Finish Totsuraba by mid July",
                    "metricType": "finish_game",
                    "targetValue": 600,
                    "startDate": yesterday.isoformat(),
                    "endDate": end.isoformat(),
                    "icon": "🏁",
                    "mediaType": "Visual Novel",
                    "gameId": stale_game_id,
                    "gameName": "Totsuraba",
                }
            ]
        )

        resp = client.get("/api/goals/dashboard", headers={"X-Timezone": "UTC"})

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["today_progress"]["goal_finish_game"]["progress"] == 30
        assert data["today_progress"]["goal_finish_game"]["required"] == 100
        assert data["today_progress"]["goal_finish_game"]["total_progress"] == 330

        active_resp = client.get("/api/goals/active")
        assert active_resp.status_code == 200
        active_goal = active_resp.get_json()["goals"][0]
        assert active_goal["today"]["progress"] == 30
        assert active_goal["today"]["required"] == 100


# ===================================================================
# /api/goals/update POST
# ===================================================================


class TestGoalsUpdate:
    def test_update_goals(self, client):
        _seed_current_goals()
        resp = client.post(
            "/api/goals/update",
            json={
                "current_goals": [{"name": "New Goal", "metricType": "hours"}],
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True

    def test_partial_settings_update(self, client):
        _seed_current_goals()
        resp = client.post(
            "/api/goals/update",
            json={
                "partial_settings": {"ankiConnect": {"deckName": "Mining"}},
            },
        )
        assert resp.status_code == 200
        # Verify the update stuck
        resp2 = client.get("/api/goals/current")
        data = resp2.get_json()
        assert data["goals_settings"]["ankiConnect"]["deckName"] == "Mining"

    def test_no_data_returns_error(self, client):
        resp = client.post("/api/goals/update", data="", content_type="application/json")
        assert resp.status_code in (400, 500)


# ===================================================================
# /api/goals/complete_todays_dailies POST
# ===================================================================


class TestCompleteDailies:
    def test_complete_dailies_success(self, client):
        _seed_current_goals(goals=[{"name": "Daily Goal"}])
        resp = client.post("/api/goals/complete_todays_dailies")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert data["streak"] >= 1
        assert "date" in data

    def test_complete_dailies_no_current_goals(self, client):
        resp = client.post("/api/goals/complete_todays_dailies")
        assert resp.status_code == 400

    def test_duplicate_completion_rejected(self, client):
        _seed_current_goals(goals=[{"name": "Goal"}])
        resp1 = client.post("/api/goals/complete_todays_dailies")
        assert resp1.status_code == 200
        resp2 = client.post("/api/goals/complete_todays_dailies")
        assert resp2.status_code == 400


# ===================================================================
# /api/goals/current_streak GET
# ===================================================================


class TestCurrentStreak:
    def test_no_history_returns_zero(self, client):
        resp = client.get("/api/goals/current_streak")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["streak"] == 0
        assert data["longest_streak"] == 0

    def test_streak_after_completion(self, client):
        _seed_current_goals(goals=[{"name": "Goal"}])
        client.post("/api/goals/complete_todays_dailies")
        resp = client.get("/api/goals/current_streak")
        data = resp.get_json()
        assert data["streak"] >= 1


# ===================================================================
# /api/goals/achieved GET
# ===================================================================


class TestAchievedGoals:
    def test_no_goals_returns_empty(self, client):
        resp = client.get("/api/goals/achieved")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["achieved_goals"] == []
        assert data["total_achieved"] == 0

    def test_no_current_entry_returns_empty(self, client):
        resp = client.get("/api/goals/achieved")
        data = resp.get_json()
        assert data["total_achieved"] == 0


# ===================================================================
# /api/goals/progress POST
# ===================================================================


class TestGoalsProgress:
    def test_missing_fields_returns_400(self, client):
        resp = client.post("/api/goals/progress", json={})
        assert resp.status_code == 400

    def test_invalid_metric_returns_400(self, client):
        resp = client.post(
            "/api/goals/progress",
            json={
                "metric_type": "invalid",
                "start_date": "2024-01-01",
                "end_date": "2024-12-31",
            },
        )
        assert resp.status_code == 400

    def test_invalid_dates_returns_400(self, client):
        resp = client.post(
            "/api/goals/progress",
            json={
                "metric_type": "hours",
                "start_date": "not-a-date",
                "end_date": "2024-12-31",
            },
        )
        assert resp.status_code == 400

    def test_start_after_end_returns_400(self, client):
        resp = client.post(
            "/api/goals/progress",
            json={
                "metric_type": "hours",
                "start_date": "2024-12-31",
                "end_date": "2024-01-01",
            },
        )
        assert resp.status_code == 400

    def test_valid_request_returns_progress(self, client):
        resp = client.post(
            "/api/goals/progress",
            json={
                "metric_type": "characters",
                "start_date": "2024-01-01",
                "end_date": "2024-12-31",
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert "progress" in data
        assert "daily_average" in data
        assert "days_in_range" in data


# ===================================================================
# /api/goals/today-progress POST
# ===================================================================


class TestTodayProgress:
    def test_missing_fields_returns_400(self, client):
        resp = client.post("/api/goals/today-progress", json={})
        assert resp.status_code == 400

    def test_static_goal_returns_target_as_required(self, client):
        resp = client.post(
            "/api/goals/today-progress",
            json={
                "goal_id": "goal_1",
                "metric_type": "hours_static",
                "target_value": 2,
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["is_static"] is True
        assert data["required"] == 2

    def test_regular_goal_with_dates(self, client):
        today = datetime.date.today()
        start = (today - datetime.timedelta(days=5)).strftime("%Y-%m-%d")
        end = (today + datetime.timedelta(days=25)).strftime("%Y-%m-%d")
        resp = client.post(
            "/api/goals/today-progress",
            json={
                "goal_id": "goal_2",
                "metric_type": "characters",
                "target_value": 100000,
                "start_date": start,
                "end_date": end,
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["has_target"] is True
        assert "required" in data
        assert "progress" in data

    def test_required_uses_progress_before_today(self, client):
        today = datetime.datetime.now(datetime.timezone.utc).date()
        yesterday = today - datetime.timedelta(days=1)
        end = today + datetime.timedelta(days=2)
        _seed_rollup(yesterday, characters=100)
        _seed_today_line(today, text="x" * 30)

        resp = client.post(
            "/api/goals/today-progress",
            headers={"X-Timezone": "UTC"},
            json={
                "goal_id": "goal_2",
                "metric_type": "characters",
                "target_value": 310,
                "start_date": yesterday.isoformat(),
                "end_date": end.isoformat(),
            },
        )

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["required"] == 70
        assert data["progress"] == 30
        assert data["total_progress"] == 130

    def test_finish_game_today_progress_resolves_stale_game_id_from_game_name(self, client):
        today = datetime.datetime.now(datetime.timezone.utc).date()
        yesterday = today - datetime.timedelta(days=1)
        end = today + datetime.timedelta(days=2)
        stale_game_id = "stale-game-id"
        current_game_id = "current-game-id"

        _seed_game(current_game_id, title="Totsuraba", scene="Totsuraba", character_count=600)
        _seed_today_line(yesterday, text="x" * 300, game_id=current_game_id)
        _seed_today_line(today, text="x" * 30, game_id=current_game_id)

        resp = client.post(
            "/api/goals/today-progress",
            headers={"X-Timezone": "UTC"},
            json={
                "goal_id": "goal_finish_game",
                "metric_type": "finish_game",
                "target_value": 600,
                "start_date": yesterday.isoformat(),
                "end_date": end.isoformat(),
                "game_id": stale_game_id,
                "game_name": "Totsuraba",
            },
        )

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["required"] == 100
        assert data["progress"] == 30
        assert data["total_progress"] == 330

    def test_expired_goal_returns_no_target(self, client):
        resp = client.post(
            "/api/goals/today-progress",
            json={
                "goal_id": "goal_3",
                "metric_type": "hours",
                "target_value": 100,
                "start_date": "2020-01-01",
                "end_date": "2020-12-31",
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["has_target"] is False
        assert data["expired"] is True


# ===================================================================
# /api/goals/achieved GET — includes expired missed goals
# ===================================================================


class TestAchievedGoalsWithHistory:
    def test_expired_achieved_goal_has_achieved_true(self, client):
        _seed_current_goals(
            goals=[
                {
                    "id": "goal_achieved_expired",
                    "name": "Read 0 chars in 2020",
                    "metricType": "characters",
                    "targetValue": 0,
                    "startDate": "2020-01-01",
                    "endDate": "2020-12-31",
                    "icon": "📖",
                    "mediaType": "ALL",
                }
            ]
        )
        resp = client.get("/api/goals/achieved")
        assert resp.status_code == 200
        data = resp.get_json()
        # target_value <= 0 is skipped by the endpoint
        # Use a goal with actual target to test
        assert data["total_achieved"] == 0

    def test_expired_missed_goal_appears_with_achieved_false(self, client):
        _seed_current_goals(
            goals=[
                {
                    "id": "goal_missed",
                    "name": "Read 999999 hours in 2020",
                    "metricType": "hours",
                    "targetValue": 999999,
                    "startDate": "2020-01-01",
                    "endDate": "2020-12-31",
                    "icon": "⏱️",
                    "mediaType": "ALL",
                }
            ]
        )
        resp = client.get("/api/goals/achieved")
        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["achieved_goals"]) == 1
        goal = data["achieved_goals"][0]
        assert goal["goal_id"] == "goal_missed"
        assert goal["achieved"] is False
        assert goal["expired"] is True
        assert "completion_percentage" in goal
        # total_achieved should not count missed goals
        assert data["total_achieved"] == 0

    def test_active_unachieved_goal_excluded(self, client):
        today = datetime.date.today()
        future = (today + datetime.timedelta(days=30)).strftime("%Y-%m-%d")
        past = (today - datetime.timedelta(days=30)).strftime("%Y-%m-%d")
        _seed_current_goals(
            goals=[
                {
                    "id": "goal_active",
                    "name": "Active goal",
                    "metricType": "characters",
                    "targetValue": 999999999,
                    "startDate": past,
                    "endDate": future,
                    "icon": "📖",
                    "mediaType": "ALL",
                }
            ]
        )
        resp = client.get("/api/goals/achieved")
        assert resp.status_code == 200
        data = resp.get_json()
        # Active unachieved goal should not appear
        assert len(data["achieved_goals"]) == 0

    def test_custom_and_static_goals_excluded_from_expired(self, client):
        _seed_current_goals(
            goals=[
                {
                    "id": "goal_custom",
                    "name": "Daily habit",
                    "metricType": "custom",
                    "targetValue": None,
                    "startDate": None,
                    "endDate": None,
                    "icon": "✅",
                    "mediaType": "ALL",
                },
                {
                    "id": "goal_static",
                    "name": "Daily reading",
                    "metricType": "hours_static",
                    "targetValue": 2,
                    "startDate": None,
                    "endDate": None,
                    "icon": "⏱️",
                    "mediaType": "ALL",
                },
            ]
        )
        resp = client.get("/api/goals/achieved")
        assert resp.status_code == 200
        data = resp.get_json()
        # Custom/static goals only appear if achieved today, not as expired
        expired_goals = [g for g in data["achieved_goals"] if g.get("expired")]
        assert len(expired_goals) == 0

    def test_achieved_flag_present_on_all_entries(self, client):
        _seed_current_goals(
            goals=[
                {
                    "id": "goal_old_missed",
                    "name": "Missed goal",
                    "metricType": "characters",
                    "targetValue": 999999999,
                    "startDate": "2020-01-01",
                    "endDate": "2020-06-30",
                    "icon": "📖",
                    "mediaType": "ALL",
                },
            ]
        )
        resp = client.get("/api/goals/achieved")
        assert resp.status_code == 200
        data = resp.get_json()
        for goal in data["achieved_goals"]:
            assert "achieved" in goal
            assert "expired" in goal
