"""
Tests for goals API endpoints and helper functions.

Covers:
- /api/goals/current GET
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

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable, GoalsTable
from GameSentenceMiner.util.database.games_table import GamesTable


@pytest.fixture(autouse=True)
def _in_memory_db():
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    GoalsTable.set_db(db)
    from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
    StatsRollupTable.set_db(db)
    yield db
    db.close()


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
    settings_json = json.dumps(settings or {
        "easyDays": {"monday": 100, "tuesday": 100, "wednesday": 100,
                     "thursday": 100, "friday": 100, "saturday": 100, "sunday": 100},
        "ankiConnect": {"deckName": ""},
        "customCheckboxes": {},
    })
    GoalsTable.create_entry(
        date_str="current",
        current_goals_json=goals_json,
        goals_settings_json=settings_json,
        last_updated=time.time(),
    )


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


class TestValidateMetricType:
    def test_valid_types(self):
        from GameSentenceMiner.web.goals_api import validate_metric_type
        for t in ["hours", "characters", "games", "cards", "mature_cards",
                   "hours_static", "characters_static", "cards_static"]:
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
        from GameSentenceMiner.web.goals_api import calculate_balanced_easy_day_multiplier
        settings = {"easyDays": {
            "monday": 100, "tuesday": 100, "wednesday": 100,
            "thursday": 100, "friday": 100, "saturday": 100, "sunday": 100,
        }}
        # All 100% → multiplier should be 1.0
        for day_offset in range(7):
            date = datetime.date(2024, 1, 1) + datetime.timedelta(days=day_offset)
            m = calculate_balanced_easy_day_multiplier(date, settings)
            assert abs(m - 1.0) < 0.01

    def test_one_day_zero(self):
        from GameSentenceMiner.web.goals_api import calculate_balanced_easy_day_multiplier
        # Friday=0, rest=100 → weekly=600, balance=700/600=1.167
        settings = {"easyDays": {
            "monday": 100, "tuesday": 100, "wednesday": 100,
            "thursday": 100, "friday": 0, "saturday": 100, "sunday": 100,
        }}
        # A Friday should return 0
        friday = datetime.date(2024, 1, 5)  # This is a Friday
        m = calculate_balanced_easy_day_multiplier(friday, settings)
        assert m == 0.0
        # A Monday should be > 1.0
        monday = datetime.date(2024, 1, 1)  # This is a Monday
        m = calculate_balanced_easy_day_multiplier(monday, settings)
        assert m > 1.0

    def test_all_zero_returns_zero(self):
        from GameSentenceMiner.web.goals_api import calculate_balanced_easy_day_multiplier
        settings = {"easyDays": {
            "monday": 0, "tuesday": 0, "wednesday": 0,
            "thursday": 0, "friday": 0, "saturday": 0, "sunday": 0,
        }}
        date = datetime.date(2024, 1, 1)
        assert calculate_balanced_easy_day_multiplier(date, settings) == 0.0

    def test_no_settings_defaults_to_100(self):
        from GameSentenceMiner.web.goals_api import calculate_balanced_easy_day_multiplier
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


# ===================================================================
# /api/goals/update POST
# ===================================================================


class TestGoalsUpdate:
    def test_update_goals(self, client):
        _seed_current_goals()
        resp = client.post("/api/goals/update", json={
            "current_goals": [{"name": "New Goal", "metricType": "hours"}],
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True

    def test_partial_settings_update(self, client):
        _seed_current_goals()
        resp = client.post("/api/goals/update", json={
            "partial_settings": {"ankiConnect": {"deckName": "Mining"}},
        })
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
        resp = client.post("/api/goals/progress", json={
            "metric_type": "invalid",
            "start_date": "2024-01-01",
            "end_date": "2024-12-31",
        })
        assert resp.status_code == 400

    def test_invalid_dates_returns_400(self, client):
        resp = client.post("/api/goals/progress", json={
            "metric_type": "hours",
            "start_date": "not-a-date",
            "end_date": "2024-12-31",
        })
        assert resp.status_code == 400

    def test_start_after_end_returns_400(self, client):
        resp = client.post("/api/goals/progress", json={
            "metric_type": "hours",
            "start_date": "2024-12-31",
            "end_date": "2024-01-01",
        })
        assert resp.status_code == 400

    def test_valid_request_returns_progress(self, client):
        resp = client.post("/api/goals/progress", json={
            "metric_type": "characters",
            "start_date": "2024-01-01",
            "end_date": "2024-12-31",
        })
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
        today = datetime.date.today()
        resp = client.post("/api/goals/today-progress", json={
            "goal_id": "goal_1",
            "metric_type": "hours_static",
            "target_value": 2,
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["is_static"] is True
        assert data["required"] == 2

    def test_regular_goal_with_dates(self, client):
        today = datetime.date.today()
        start = (today - datetime.timedelta(days=5)).strftime("%Y-%m-%d")
        end = (today + datetime.timedelta(days=25)).strftime("%Y-%m-%d")
        resp = client.post("/api/goals/today-progress", json={
            "goal_id": "goal_2",
            "metric_type": "characters",
            "target_value": 100000,
            "start_date": start,
            "end_date": end,
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["has_target"] is True
        assert "required" in data
        assert "progress" in data

    def test_expired_goal_returns_no_target(self, client):
        resp = client.post("/api/goals/today-progress", json={
            "goal_id": "goal_3",
            "metric_type": "hours",
            "target_value": 100,
            "start_date": "2020-01-01",
            "end_date": "2020-12-31",
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["has_target"] is False
        assert data["expired"] is True