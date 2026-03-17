"""
Additional unit tests for stats API helper functions.

These tests focus on helper behavior that is not fully covered in existing
pure-function and property-based suites, especially cumulative merges and
date-range aggregates.
"""

from __future__ import annotations

import datetime
from collections import defaultdict
from types import SimpleNamespace

from GameSentenceMiner.web.stats_api import (
    _add_today_lines_to_daily_data,
    _build_all_games_stats,
    _build_chart_datasets,
    _build_peak_stats,
    _build_time_period_averages,
    _merge_today_into_heatmap,
)


# ---------------------------------------------------------------------------
# _build_chart_datasets
# ---------------------------------------------------------------------------


def test_build_chart_datasets_cumulative_totals_cover_missing_days_and_games():
    daily_data = {
        "2026-01-02": {
            "Game A": {"lines": 4, "chars": 15},
            "Game B": {"lines": 0, "chars": 0},
            "Game C": {"lines": 0, "chars": 0},
        },
        "2026-01-01": {
            "Game A": {"lines": 0, "chars": 0},
            "Game B": {"lines": 1, "chars": 7},
            "Game C": {"lines": 0, "chars": 0},
        },
        "2026-01-03": {
            "Game A": {"lines": 3, "chars": 6},
            "Game B": {"lines": 2, "chars": 8},
            "Game C": {"lines": 0, "chars": 0},
        },
    }

    labels, datasets = _build_chart_datasets(daily_data, ["Game A", "Game B", "Game C"])

    assert labels == ["2026-01-01", "2026-01-02", "2026-01-03"]

    by_for = {}
    for dataset in datasets:
        by_for[(dataset["label"], dataset["for"])] = dataset["data"]

    assert by_for[("Game A", "Lines Received")] == [0, 4, 7]
    assert by_for[("Game A", "Characters Read")] == [0, 15, 21]
    assert by_for[("Game B", "Lines Received")] == [1, 1, 3]
    assert by_for[("Game B", "Characters Read")] == [7, 7, 15]
    assert by_for[("Game C", "Lines Received")] == [0, 0, 0]
    assert by_for[("Game C", "Characters Read")] == [0, 0, 0]


# ---------------------------------------------------------------------------
# Heatmap + daily merge helpers
# ---------------------------------------------------------------------------


def test_merge_today_into_heatmap_adds_and_accumulates_existing_dates():
    heatmap = {"2026": {"2026-01-01": 2}, "2025": {"2025-12-31": 1}}
    today_heatmap = {
        "2026": {"2026-01-01": 3, "2026-01-02": 4},
        "2024": {"2024-12-31": 5},
    }

    _merge_today_into_heatmap(heatmap, today_heatmap)

    assert heatmap["2026"]["2026-01-01"] == 5
    assert heatmap["2026"]["2026-01-02"] == 4
    assert heatmap["2025"]["2025-12-31"] == 1
    assert heatmap["2024"]["2024-12-31"] == 5


def test_add_today_lines_to_daily_data_updates_lines_and_chars():
    timestamp_1 = datetime.datetime(2026, 1, 1, 10, 0, 0).timestamp()
    timestamp_2 = datetime.datetime(2026, 1, 1, 10, 30, 0).timestamp()
    timestamp_3 = datetime.datetime(2026, 1, 2, 9, 0, 0).timestamp()

    lines = [
        SimpleNamespace(timestamp=timestamp_1, game_name="Test Game", line_text="abc"),
        SimpleNamespace(timestamp=timestamp_2, game_name=None, line_text="xyz"),
        SimpleNamespace(timestamp=timestamp_3, game_name="Test Game", line_text="def"),
    ]

    daily_data = defaultdict(lambda: defaultdict(lambda: {"lines": 0, "chars": 0}))
    game_name_to_display = {"Test Game": "Renamed Game"}

    _add_today_lines_to_daily_data(daily_data, lines, game_name_to_display)

    assert daily_data["2026-01-01"]["Renamed Game"]["lines"] == 1
    assert daily_data["2026-01-01"]["Renamed Game"]["chars"] == 3
    assert daily_data["2026-01-01"]["Unknown Game"]["lines"] == 1
    assert daily_data["2026-01-01"]["Unknown Game"]["chars"] == 3
    assert daily_data["2026-01-02"]["Renamed Game"]["lines"] == 1
    assert daily_data["2026-01-02"]["Renamed Game"]["chars"] == 3


# ---------------------------------------------------------------------------
# Peak stats
# ---------------------------------------------------------------------------


def test_build_peak_stats_uses_live_totals_and_session_stats():
    accumulated = {"peak_daily_stats": {"max_daily_chars": 10, "max_daily_hours": 1.0}}
    live_stats = {"total_characters": 20, "total_reading_time_seconds": 7200}
    combined_stats = {
        "longest_session_seconds": 3600,
        "max_chars_in_session": 7_500,
    }

    peak_daily_stats, peak_session_stats = _build_peak_stats(
        accumulated, live_stats, combined_stats
    )

    assert peak_daily_stats["max_daily_chars"] == 20
    assert peak_daily_stats["max_daily_hours"] == 2.0
    assert peak_session_stats["longest_session_hours"] == 1.0
    assert peak_session_stats["max_session_chars"] == 7500


def test_build_peak_stats_keeps_rollup_values_without_live_data():
    accumulated = {"peak_daily_stats": {"max_daily_chars": 5, "max_daily_hours": 0.25}}
    combined_stats = {
        "longest_session_seconds": 900,
        "max_chars_in_session": 900,
    }

    peak_daily_stats, peak_session_stats = _build_peak_stats(
        accumulated, None, combined_stats
    )

    assert peak_daily_stats["max_daily_chars"] == 5
    assert peak_daily_stats["max_daily_hours"] == 0.25
    assert peak_session_stats["longest_session_hours"] == 0.25
    assert peak_session_stats["max_session_chars"] == 900


# ---------------------------------------------------------------------------
# Time period averages
# ---------------------------------------------------------------------------


def test_build_time_period_averages_from_rollup_data():
    accumulated = {
        "all_lines_data": [
            {"reading_time_seconds": 3600, "characters": 120},
            {"reading_time_seconds": 1800, "characters": 60},
        ]
    }
    today = datetime.date.today()

    result = _build_time_period_averages(
        accumulated,
        None,
        (today - datetime.timedelta(days=2)).isoformat(),
        today.isoformat(),
    )

    assert result["avgHoursPerDay"] == 0.5
    assert result["avgCharsPerDay"] == 60
    assert result["avgSpeedPerDay"] == 120
    assert result["totalHours"] == 1.5
    assert result["totalChars"] == 180


def test_build_time_period_averages_adds_live_stats_when_today_is_in_range():
    today = datetime.date.today()
    accumulated = {
        "all_lines_data": [
            {"reading_time_seconds": 900, "characters": 180},
        ]
    }
    live_stats = {"total_reading_time_seconds": 600, "total_characters": 90}

    result = _build_time_period_averages(
        accumulated,
        live_stats,
        (today - datetime.timedelta(days=1)).isoformat(),
        None,
    )

    assert result["totalHours"] == 0.42
    assert result["totalChars"] == 270
    assert result["avgHoursPerDay"] == 0.21
    assert result["avgCharsPerDay"] == 135
    assert result["avgSpeedPerDay"] == 630


# ---------------------------------------------------------------------------
# all-games summary
# ---------------------------------------------------------------------------


def test_build_all_games_stats_uses_rollup_metadata_and_completed_games(monkeypatch):
    combined_stats = {
        "total_characters": 1500,
        "total_lines": 3,
        "total_reading_time_seconds": 7200,
        "average_reading_speed_chars_per_hour": 800,
        "total_sessions": 5,
    }

    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.GamesTable.get_all_completed",
        lambda: [SimpleNamespace(), SimpleNamespace(), SimpleNamespace()],
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.StatsRollupTable.get_first_date",
        lambda: "2026-01-01",
    )

    result = _build_all_games_stats(
        combined_stats,
        datetime.datetime(2026, 1, 5).timestamp(),
    )

    assert result["total_characters"] == 1500
    assert result["total_characters_formatted"] == "1.5K"
    assert result["total_sentences"] == 3
    assert result["total_time_hours"] == 2.0
    assert result["total_time_formatted"] == "2h"
    assert result["reading_speed"] == 800
    assert result["reading_speed_formatted"] == "800"
    assert result["sessions"] == 5
    assert result["completed_games"] == 3
    assert result["first_date"] == "2026-01-01"
    assert result["last_date"] == "2026-01-05"


def test_build_all_games_stats_falls_back_to_today_when_no_rollup_dates(monkeypatch):
    combined_stats = {
        "total_characters": 10,
        "total_lines": 1,
        "total_reading_time_seconds": 60,
        "average_reading_speed_chars_per_hour": 600,
        "total_sessions": 1,
    }

    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.GamesTable.get_all_completed",
        lambda: [],
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.StatsRollupTable.get_first_date",
        lambda: None,
    )

    result = _build_all_games_stats(combined_stats, None)

    assert result["first_date"] == datetime.date.today().isoformat()
    assert result["last_date"] == datetime.date.today().isoformat()
