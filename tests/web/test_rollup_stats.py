"""
Tests for rollup statistics aggregation in GameSentenceMiner/web/rollup_stats.py.
Pure function tests — no Flask or database needed.
"""

import json
from types import SimpleNamespace
import pytest

from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data,
    combine_rollup_and_live_stats,
    build_heatmap_from_rollup,
)


def _rollup(date="2024-06-15", **kw):
    defaults = dict(
        total_lines=10, total_characters=500, total_sessions=2,
        total_reading_time_seconds=3600.0, total_active_time_seconds=3000.0,
        average_reading_speed_chars_per_hour=500.0,
        peak_reading_speed_chars_per_hour=600.0,
        longest_session_seconds=1800.0, shortest_session_seconds=900.0,
        average_session_seconds=1500.0, max_chars_in_session=300,
        max_time_in_session_seconds=1800.0, games_completed=0,
        anki_cards_created=3, lines_with_screenshots=2,
        lines_with_audio=1, lines_with_translations=0,
    )
    defaults.update(kw)
    for k in ["games_played_ids", "game_activity_data", "kanji_frequency_data",
              "hourly_activity_data", "hourly_reading_speed_data",
              "genre_activity_data", "type_activity_data"]:
        defaults.setdefault(k, json.dumps(kw.get(k, {} if "data" in k else [])))
    return SimpleNamespace(date=date, **defaults)


class TestAggregateRollupData:
    def test_empty(self):
        r = aggregate_rollup_data([])
        assert r["total_lines"] == 0

    def test_single(self):
        r = aggregate_rollup_data([_rollup(total_lines=10)])
        assert r["total_lines"] == 10

    def test_sums_additive(self):
        r = aggregate_rollup_data([
            _rollup(total_lines=10, total_characters=100, anki_cards_created=2),
            _rollup(total_lines=20, total_characters=200, anki_cards_created=3),
        ])
        assert r["total_lines"] == 30
        assert r["total_characters"] == 300
        assert r["anki_cards_created"] == 5

    def test_max_fields(self):
        r = aggregate_rollup_data([
            _rollup(peak_reading_speed_chars_per_hour=500, longest_session_seconds=1000),
            _rollup(peak_reading_speed_chars_per_hour=800, longest_session_seconds=600),
        ])
        assert r["peak_reading_speed_chars_per_hour"] == 800
        assert r["longest_session_seconds"] == 1000

    def test_shortest_session_min_nonzero(self):
        r = aggregate_rollup_data([
            _rollup(shortest_session_seconds=100),
            _rollup(shortest_session_seconds=200),
        ])
        assert r["shortest_session_seconds"] == 100

    def test_shortest_session_ignores_zero(self):
        r = aggregate_rollup_data([
            _rollup(shortest_session_seconds=0),
            _rollup(shortest_session_seconds=300),
        ])
        assert r["shortest_session_seconds"] == 300

    def test_games_union(self):
        r = aggregate_rollup_data([
            _rollup(games_played_ids=json.dumps(["a", "b"])),
            _rollup(games_played_ids=json.dumps(["b", "c"])),
        ])
        assert r["unique_games_played"] == 3

    def test_kanji_merged(self):
        r = aggregate_rollup_data([
            _rollup(kanji_frequency_data=json.dumps({"漢": 5, "字": 3})),
            _rollup(kanji_frequency_data=json.dumps({"漢": 2, "語": 1})),
        ])
        assert r["kanji_frequency_data"]["漢"] == 7
        assert r["kanji_frequency_data"]["字"] == 3
        assert r["unique_kanji_seen"] == 3

    def test_hourly_summed(self):
        r = aggregate_rollup_data([
            _rollup(hourly_activity_data=json.dumps({"10": 100, "11": 200})),
            _rollup(hourly_activity_data=json.dumps({"10": 50, "12": 300})),
        ])
        assert r["hourly_activity_data"]["10"] == 150

    def test_game_activity_merged(self):
        g = {"g1": {"title": "G", "chars": 100, "time": 3600, "lines": 10}}
        g2 = {"g1": {"title": "G", "chars": 200, "time": 1800, "lines": 5}}
        r = aggregate_rollup_data([
            _rollup(game_activity_data=json.dumps(g)),
            _rollup(game_activity_data=json.dumps(g2)),
        ])
        assert r["game_activity_data"]["g1"]["chars"] == 300
        assert r["game_activity_data"]["g1"]["lines"] == 15

    def test_weighted_avg_speed(self):
        r = aggregate_rollup_data([
            _rollup(average_reading_speed_chars_per_hour=1000, total_active_time_seconds=3600),
            _rollup(average_reading_speed_chars_per_hour=2000, total_active_time_seconds=3600),
        ])
        assert abs(r["average_reading_speed_chars_per_hour"] - 1500) < 1


def _full_stats(**kw):
    base = dict(
        total_lines=0, total_characters=0, total_sessions=0,
        total_reading_time_seconds=0, total_active_time_seconds=0,
        average_reading_speed_chars_per_hour=0,
        peak_reading_speed_chars_per_hour=0,
        longest_session_seconds=0, shortest_session_seconds=0,
        average_session_seconds=0, max_chars_in_session=0,
        max_time_in_session_seconds=0, games_completed=0,
        anki_cards_created=0, lines_with_screenshots=0,
        lines_with_audio=0, lines_with_translations=0,
        games_played_ids=[], kanji_frequency_data={},
        hourly_activity_data={}, hourly_reading_speed_data={},
        game_activity_data={}, genre_activity_data={}, type_activity_data={},
    )
    base.update(kw)
    return base


class TestCombineRollupAndLive:
    def test_both_none(self):
        assert combine_rollup_and_live_stats(None, None)["total_lines"] == 0

    def test_only_rollup(self):
        r = combine_rollup_and_live_stats(_full_stats(total_lines=100), None)
        assert r["total_lines"] == 100

    def test_only_live(self):
        r = combine_rollup_and_live_stats(None, _full_stats(total_lines=50))
        assert r["total_lines"] == 50

    def test_additive_sum(self):
        r = combine_rollup_and_live_stats(
            _full_stats(total_lines=100, total_characters=5000, anki_cards_created=10),
            _full_stats(total_lines=50, total_characters=2000, anki_cards_created=5),
        )
        assert r["total_lines"] == 150
        assert r["total_characters"] == 7000
        assert r["anki_cards_created"] == 15

    def test_max_fields(self):
        r = combine_rollup_and_live_stats(
            _full_stats(longest_session_seconds=3600, max_chars_in_session=1000),
            _full_stats(longest_session_seconds=2000, max_chars_in_session=1500),
        )
        assert r["longest_session_seconds"] == 3600
        assert r["max_chars_in_session"] == 1500

    def test_games_union(self):
        r = combine_rollup_and_live_stats(
            _full_stats(games_played_ids=["g1", "g2"]),
            _full_stats(games_played_ids=["g2", "g3"]),
        )
        assert r["unique_games_played"] == 3

    def test_kanji_combined(self):
        r = combine_rollup_and_live_stats(
            _full_stats(kanji_frequency_data={"漢": 5}),
            _full_stats(kanji_frequency_data={"漢": 3, "語": 1}),
        )
        assert r["kanji_frequency_data"]["漢"] == 8
        assert r["kanji_frequency_data"]["語"] == 1

    def test_shortest_session_min_nonzero(self):
        r = combine_rollup_and_live_stats(
            _full_stats(shortest_session_seconds=600),
            _full_stats(shortest_session_seconds=300),
        )
        assert r["shortest_session_seconds"] == 300

    def test_shortest_session_one_zero(self):
        r = combine_rollup_and_live_stats(
            _full_stats(shortest_session_seconds=0),
            _full_stats(shortest_session_seconds=500),
        )
        assert r["shortest_session_seconds"] == 500


class TestBuildHeatmapFromRollup:
    def test_empty(self):
        assert build_heatmap_from_rollup([]) == {}

    def test_single_day(self):
        r = _rollup(date="2024-06-15", total_characters=500)
        result = build_heatmap_from_rollup([r])
        assert result["2024"]["2024-06-15"] == 500

    def test_multiple_days(self):
        r1 = _rollup(date="2024-06-15", total_characters=500)
        r2 = _rollup(date="2024-06-16", total_characters=300)
        result = build_heatmap_from_rollup([r1, r2])
        assert result["2024"]["2024-06-15"] == 500
        assert result["2024"]["2024-06-16"] == 300

    def test_year_filter(self):
        r1 = _rollup(date="2024-06-15", total_characters=500)
        r2 = _rollup(date="2025-01-01", total_characters=300)
        result = build_heatmap_from_rollup([r1, r2], filter_year="2024")
        assert "2024" in result
        assert "2025" not in result