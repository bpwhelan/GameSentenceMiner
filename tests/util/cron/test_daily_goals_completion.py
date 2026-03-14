"""Tests for the daily_goals_completion cron module historical backfill behavior."""

from __future__ import annotations

import datetime
import json
import time

import pytest
import pytz

from GameSentenceMiner.util.cron import daily_goals_completion as mod
from GameSentenceMiner.util.database.db import GameLinesTable, GoalsTable, SQLiteDB
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.database.third_party_stats_table import ThirdPartyStatsTable
from GameSentenceMiner.web import goals_api


@pytest.fixture(autouse=True)
def _in_memory_db():
    orig_goals = GoalsTable._db
    orig_lines = GameLinesTable._db
    orig_rollup = StatsRollupTable._db
    orig_third_party = ThirdPartyStatsTable._db

    db = SQLiteDB(":memory:")
    GoalsTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    ThirdPartyStatsTable.set_db(db)

    yield db

    db.close()
    GoalsTable._db = orig_goals
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_rollup
    ThirdPartyStatsTable._db = orig_third_party


def _default_settings() -> dict:
    return {
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


def _seed_current_goals(goals: list[dict], settings: dict | None = None):
    GoalsTable.create_entry(
        date_str="current",
        current_goals_json=json.dumps(goals),
        goals_settings_json=json.dumps(settings or _default_settings()),
        last_updated=time.time(),
    )


def _seed_historical_completion(date_str: str):
    current = GoalsTable.get_by_date("current")
    GoalsTable.create_entry(
        date_str=date_str,
        current_goals_json=current.current_goals if current else "[]",
        goals_settings_json=current.goals_settings if current else "{}",
        last_updated=time.time(),
    )


def _history_dates() -> list[str]:
    return sorted([row.date for row in GoalsTable.all() if row.date != "current"])


def _set_fixed_today(monkeypatch, today: datetime.date):
    monkeypatch.setattr(mod, "get_user_timezone_from_settings", lambda: pytz.UTC)
    monkeypatch.setattr(mod, "get_today_in_timezone", lambda _tz: today)


class TestDailyGoalsCompletionBackfill:
    def test_backfills_missed_completed_dates(self, monkeypatch):
        _set_fixed_today(monkeypatch, datetime.date(2026, 3, 12))
        _seed_current_goals(
            [
                {
                    "id": "goal_1",
                    "name": "Read daily",
                    "metricType": "hours",
                    "targetValue": 10,
                    "startDate": "2026-03-10",
                    "endDate": "2026-03-12",
                }
            ]
        )
        _seed_historical_completion("2026-03-10")

        def fake_get_goals_for_date(target_date, **kwargs):
            day = target_date.strftime("%Y-%m-%d")
            if day == "2026-03-11":
                progress = 2
                required = 1
            else:
                progress = 0
                required = 1
            return {
                "date": day,
                "goals": [
                    {
                        "goal_name": "Read daily",
                        "progress_today": progress,
                        "progress_needed": required,
                        "metric_type": "hours",
                    }
                ],
            }

        monkeypatch.setattr(goals_api, "get_goals_for_date", fake_get_goals_for_date)

        result = mod.run_daily_goals_completion()
        assert result["success"] is True
        assert result["action"] == "completed"
        assert result["completed_dates"] == ["2026-03-11"]
        assert _history_dates() == ["2026-03-10", "2026-03-11"]

    def test_does_not_backfill_outside_goal_window(self, monkeypatch):
        _set_fixed_today(monkeypatch, datetime.date(2026, 1, 3))
        _seed_current_goals(
            [
                {
                    "id": "goal_2",
                    "name": "Year goal",
                    "metricType": "characters",
                    "targetValue": 1000,
                    "startDate": "2026-01-01",
                    "endDate": "2026-12-31",
                }
            ]
        )

        called_dates = []

        def fake_get_goals_for_date(target_date, **kwargs):
            day = target_date.strftime("%Y-%m-%d")
            called_dates.append(day)
            return {
                "date": day,
                "goals": [
                    {
                        "goal_name": "Year goal",
                        "progress_today": 1,
                        "progress_needed": 1,
                        "metric_type": "characters",
                    }
                ],
            }

        monkeypatch.setattr(goals_api, "get_goals_for_date", fake_get_goals_for_date)

        result = mod.run_daily_goals_completion()
        assert result["success"] is True
        assert result["completed_count"] == 3
        assert min(called_dates) == "2026-01-01"
        assert all(day >= "2026-01-01" for day in _history_dates())

    def test_static_goals_start_backfill_from_first_data_date(self, monkeypatch):
        _set_fixed_today(monkeypatch, datetime.date(2026, 1, 12))
        _seed_current_goals(
            [
                {
                    "id": "goal_static",
                    "name": "Static reading",
                    "metricType": "hours_static",
                    "targetValue": 1,
                }
            ]
        )

        # First known data date for static backfill.
        StatsRollupTable(date="2026-01-10").save()

        called_dates = []

        def fake_get_goals_for_date(target_date, **kwargs):
            day = target_date.strftime("%Y-%m-%d")
            called_dates.append(day)
            return {
                "date": day,
                "goals": [
                    {
                        "goal_name": "Static reading",
                        "progress_today": 1,
                        "progress_needed": 1,
                        "metric_type": "hours_static",
                    }
                ],
            }

        monkeypatch.setattr(goals_api, "get_goals_for_date", fake_get_goals_for_date)

        result = mod.run_daily_goals_completion()
        assert result["success"] is True
        assert result["completed_dates"] == [
            "2026-01-10",
            "2026-01-11",
            "2026-01-12",
        ]
        assert called_dates == ["2026-01-10", "2026-01-11", "2026-01-12"]

    def test_zero_requirement_day_is_auto_completed(self, monkeypatch):
        _set_fixed_today(monkeypatch, datetime.date(2026, 2, 2))
        _seed_current_goals(
            [
                {
                    "id": "goal_3",
                    "name": "Easy day",
                    "metricType": "hours",
                    "targetValue": 10,
                    "startDate": "2026-02-02",
                    "endDate": "2026-02-02",
                }
            ]
        )

        def fake_get_goals_for_date(target_date, **kwargs):
            day = target_date.strftime("%Y-%m-%d")
            return {
                "date": day,
                "goals": [
                    {
                        "goal_name": "Easy day",
                        "progress_today": 0,
                        "progress_needed": 0,
                        "metric_type": "hours",
                    }
                ],
            }

        monkeypatch.setattr(goals_api, "get_goals_for_date", fake_get_goals_for_date)

        result = mod.run_daily_goals_completion()
        assert result["success"] is True
        assert result["action"] == "completed"
        assert result["completed_dates"] == ["2026-02-02"]
        assert _history_dates() == ["2026-02-02"]

    def test_rerun_is_idempotent(self, monkeypatch):
        _set_fixed_today(monkeypatch, datetime.date(2026, 4, 2))
        _seed_current_goals(
            [
                {
                    "id": "goal_4",
                    "name": "Two-day goal",
                    "metricType": "characters",
                    "targetValue": 100,
                    "startDate": "2026-04-01",
                    "endDate": "2026-04-02",
                }
            ]
        )

        def fake_get_goals_for_date(target_date, **kwargs):
            day = target_date.strftime("%Y-%m-%d")
            return {
                "date": day,
                "goals": [
                    {
                        "goal_name": "Two-day goal",
                        "progress_today": 1,
                        "progress_needed": 1,
                        "metric_type": "characters",
                    }
                ],
            }

        monkeypatch.setattr(goals_api, "get_goals_for_date", fake_get_goals_for_date)

        first_run = mod.run_daily_goals_completion()
        assert first_run["completed_count"] == 2
        dates_after_first = _history_dates()
        assert dates_after_first == ["2026-04-01", "2026-04-02"]

        second_run = mod.run_daily_goals_completion()
        assert second_run["completed_count"] == 0
        assert second_run["action"] == "already_completed"
        assert _history_dates() == dates_after_first
