"""Tests for the daily_goals_completion cron module backfill behavior.

Backfill is intentionally narrow: only *today* and the day the cron last ran are
evaluated. A day can only end un-snapshotted if goals were met after that session's
final hourly check, which makes it the last-run day; earlier missed days were already
the last-run day on a prior run and got backfilled then.
"""

from __future__ import annotations

import datetime
import json
import time

import pytest
import pytz

from GameSentenceMiner.util.cron import daily_goals_completion as mod
from GameSentenceMiner.util.cron.run_crons import Crons
from GameSentenceMiner.util.database.cron_table import CronTable
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
    orig_cron = CronTable._db

    db = SQLiteDB(":memory:")
    GoalsTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    ThirdPartyStatsTable.set_db(db)
    CronTable.set_db(db)

    yield db

    db.close()
    GoalsTable._db = orig_goals
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_rollup
    ThirdPartyStatsTable._db = orig_third_party
    CronTable._db = orig_cron


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


def _set_last_run(date: datetime.date | None):
    """Seed the cron row so `_get_last_run_date` resolves to `date` (UTC)."""
    if date is None:
        return
    ts = datetime.datetime(date.year, date.month, date.day, 12, 0, tzinfo=pytz.UTC).timestamp()
    CronTable(
        name=Crons.DAILY_GOALS_COMPLETION.value,
        description="daily goals completion",
        last_run=ts,
        next_run=time.time(),
        schedule="hourly",
    ).save()


def _history_dates() -> list[str]:
    return sorted([row.date for row in GoalsTable.all() if row.date != "current"])


def _set_fixed_today(monkeypatch, today: datetime.date):
    monkeypatch.setattr(mod, "get_user_timezone_from_settings", lambda: pytz.UTC)
    monkeypatch.setattr(mod, "get_today_in_timezone", lambda _tz: today)


class TestDailyGoalsCompletionBackfill:
    def test_backfills_missed_last_run_day(self, monkeypatch):
        # Goal finished on the last-run day (03-11) after that session's final check;
        # today (03-12) is not yet complete. Only the missed last-run day is backfilled.
        _set_fixed_today(monkeypatch, datetime.date(2026, 3, 12))
        _set_last_run(datetime.date(2026, 3, 11))
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
            progress = 2 if day == "2026-03-11" else 0
            return {
                "date": day,
                "goals": [
                    {
                        "goal_name": "Read daily",
                        "progress_today": progress,
                        "progress_needed": 1,
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

    def test_only_evaluates_today_and_last_run(self, monkeypatch):
        # Even with an always-valid goal, only today + last_run are checked — never the
        # span between them.
        _set_fixed_today(monkeypatch, datetime.date(2026, 1, 3))
        _set_last_run(datetime.date(2026, 1, 2))
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
        assert result["completed_count"] == 2
        assert sorted(called_dates) == ["2026-01-02", "2026-01-03"]
        assert _history_dates() == ["2026-01-02", "2026-01-03"]

    def test_no_last_run_checks_only_today(self, monkeypatch):
        # First-ever run (no cron row) evaluates today and nothing else.
        _set_fixed_today(monkeypatch, datetime.date(2026, 1, 12))
        _set_last_run(None)
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
        assert result["completed_dates"] == ["2026-01-12"]
        assert called_dates == ["2026-01-12"]

    def test_zero_requirement_day_is_auto_completed(self, monkeypatch):
        _set_fixed_today(monkeypatch, datetime.date(2026, 2, 2))
        _set_last_run(datetime.date(2026, 2, 2))
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

    def test_far_past_last_run_does_not_scan_the_gap(self, monkeypatch):
        # A last_run far in the past must not expand into a multi-day scan — only the two
        # endpoints are evaluated (this is the property that replaced the bounded window).
        today = datetime.date(2026, 6, 1)
        _set_fixed_today(monkeypatch, today)
        _set_last_run(datetime.date(2024, 6, 1))
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
        assert sorted(called_dates) == ["2024-06-01", "2026-06-01"]
        assert _history_dates() == ["2024-06-01", "2026-06-01"]

    def test_rerun_is_idempotent(self, monkeypatch):
        _set_fixed_today(monkeypatch, datetime.date(2026, 4, 2))
        _set_last_run(datetime.date(2026, 4, 1))
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
