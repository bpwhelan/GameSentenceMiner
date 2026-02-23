"""
Tests for pure statistics utility functions in GameSentenceMiner/web/stats.py.

These tests cover functions that don't require Flask or database access,
making them fast and reliable to run.
"""

import datetime
from collections import defaultdict
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from GameSentenceMiner.web.stats import (
    is_kanji,
    get_gradient_color,
    interpolate_color,
    calculate_kanji_frequency,
    calculate_actual_reading_time,
    calculate_heatmap_data,
    calculate_mining_heatmap_data,
    format_large_number,
    format_time_human_readable,
    generate_game_colors,
)


# ---------------------------------------------------------------------------
# is_kanji
# ---------------------------------------------------------------------------


class TestIsKanji:
    def test_common_kanji(self):
        assert is_kanji("漢") is True
        assert is_kanji("字") is True
        assert is_kanji("日") is True
        assert is_kanji("本") is True

    def test_hiragana_is_not_kanji(self):
        assert is_kanji("あ") is False
        assert is_kanji("ん") is False

    def test_katakana_is_not_kanji(self):
        assert is_kanji("ア") is False
        assert is_kanji("ン") is False

    def test_ascii_is_not_kanji(self):
        assert is_kanji("A") is False
        assert is_kanji("1") is False
        assert is_kanji(" ") is False

    def test_empty_string_returns_false(self):
        assert is_kanji("") is False

    def test_multi_char_string_returns_false(self):
        assert is_kanji("漢字") is False

    def test_non_string_returns_false(self):
        assert is_kanji(123) is False
        assert is_kanji(None) is False

    def test_boundary_kanji_range_start(self):
        # U+4E00 is the first CJK Unified Ideograph
        assert is_kanji("\u4E00") is True

    def test_boundary_kanji_range_end(self):
        # U+9FAF is the last in the common range
        assert is_kanji("\u9FAF") is True

    def test_just_outside_kanji_range(self):
        assert is_kanji("\u4DFF") is False
        assert is_kanji("\u9FB0") is False


# ---------------------------------------------------------------------------
# get_gradient_color / interpolate_color
# ---------------------------------------------------------------------------


class TestGradientColor:
    def test_zero_frequency_returns_default(self):
        assert get_gradient_color(0, 100) == "#ebedf0"

    def test_zero_max_frequency_returns_default(self):
        assert get_gradient_color(5, 0) == "#ebedf0"

    def test_high_frequency_returns_cyan(self):
        # Frequency > 300 always returns cyan
        assert get_gradient_color(301, 1000) == "#2ee6e0"
        assert get_gradient_color(500, 1000) == "#2ee6e0"

    def test_max_frequency_returns_last_color(self):
        result = get_gradient_color(100, 100)
        # At ratio=1.0, should be the last color (cyan)
        assert result == "#2ee6e0"

    def test_returns_hex_color_string(self):
        result = get_gradient_color(50, 200)
        assert result.startswith("#")
        assert len(result) == 7

    def test_interpolate_color_midpoint(self):
        # Midpoint between white (#ffffff) and black (#000000) should be gray
        result = interpolate_color("#ffffff", "#000000", 0.5)
        assert result == "#7f7f7f" or result == "#808080"  # Allow rounding

    def test_interpolate_color_same_color(self):
        result = interpolate_color("#ff0000", "#ff0000", 0.5)
        assert result == "#ff0000"

    def test_interpolate_color_start(self):
        result = interpolate_color("#ff0000", "#0000ff", 0.0)
        assert result == "#ff0000"

    def test_interpolate_color_end(self):
        result = interpolate_color("#ff0000", "#0000ff", 1.0)
        assert result == "#0000ff"


# ---------------------------------------------------------------------------
# calculate_kanji_frequency
# ---------------------------------------------------------------------------


class TestCalculateKanjiFrequency:
    def _make_line(self, text):
        return SimpleNamespace(line_text=text)

    def test_empty_lines(self):
        result = calculate_kanji_frequency([])
        assert result["kanji_data"] == []
        assert result["unique_count"] == 0

    def test_no_kanji_in_lines(self):
        lines = [self._make_line("あいうえお"), self._make_line("hello")]
        result = calculate_kanji_frequency(lines)
        assert result["kanji_data"] == []
        assert result["unique_count"] == 0

    def test_counts_kanji_correctly(self):
        lines = [self._make_line("漢字漢")]  # 漢 appears 2x, 字 appears 1x
        result = calculate_kanji_frequency(lines)
        assert result["unique_count"] == 2
        # Most frequent first
        assert result["kanji_data"][0]["kanji"] == "漢"
        assert result["kanji_data"][0]["frequency"] == 2
        assert result["kanji_data"][1]["kanji"] == "字"
        assert result["kanji_data"][1]["frequency"] == 1

    def test_across_multiple_lines(self):
        lines = [self._make_line("日"), self._make_line("日本"), self._make_line("本語")]
        result = calculate_kanji_frequency(lines)
        freq_map = {k["kanji"]: k["frequency"] for k in result["kanji_data"]}
        assert freq_map["日"] == 2
        assert freq_map["本"] == 2
        assert freq_map["語"] == 1

    def test_none_line_text_skipped(self):
        lines = [self._make_line(None), self._make_line("漢")]
        result = calculate_kanji_frequency(lines)
        assert result["unique_count"] == 1

    def test_kanji_data_has_color(self):
        lines = [self._make_line("漢")]
        result = calculate_kanji_frequency(lines)
        assert "color" in result["kanji_data"][0]
        assert result["kanji_data"][0]["color"].startswith("#")

    def test_max_frequency_set(self):
        lines = [self._make_line("漢漢漢字")]
        result = calculate_kanji_frequency(lines)
        assert result["max_frequency"] == 3


# ---------------------------------------------------------------------------
# calculate_actual_reading_time
# ---------------------------------------------------------------------------


class TestCalculateActualReadingTime:
    def test_empty_timestamps(self):
        assert calculate_actual_reading_time([]) == 0.0

    def test_single_timestamp(self):
        assert calculate_actual_reading_time([100.0]) == 0.0

    def test_two_close_timestamps(self):
        # Gap of 10 seconds, well under any AFK timer
        result = calculate_actual_reading_time([100.0, 110.0], afk_timer_seconds=120)
        assert result == 10.0

    def test_gap_exceeding_afk_timer_is_capped(self):
        # Gap of 500 seconds, but AFK timer is 120
        result = calculate_actual_reading_time([100.0, 600.0], afk_timer_seconds=120)
        assert result == 120.0

    def test_multiple_gaps_mixed(self):
        # Three timestamps: gap1=30s (normal), gap2=500s (capped at 120)
        timestamps = [100.0, 130.0, 630.0]
        result = calculate_actual_reading_time(timestamps, afk_timer_seconds=120)
        assert result == 30.0 + 120.0

    def test_unsorted_timestamps_handled(self):
        # Should sort internally
        timestamps = [200.0, 100.0, 150.0]
        result = calculate_actual_reading_time(timestamps, afk_timer_seconds=120)
        # Sorted: 100, 150, 200 → gaps: 50, 50
        assert result == 100.0

    def test_zero_afk_timer(self):
        # All gaps capped at 0
        result = calculate_actual_reading_time([100.0, 200.0], afk_timer_seconds=0)
        assert result == 0.0


# ---------------------------------------------------------------------------
# calculate_heatmap_data
# ---------------------------------------------------------------------------


class TestCalculateHeatmapData:
    def _make_line(self, text, timestamp):
        return SimpleNamespace(line_text=text, timestamp=timestamp)

    def test_empty_lines(self):
        result = calculate_heatmap_data([])
        assert result == {}

    def test_groups_by_year_and_date(self):
        # Jan 1, 2024 at noon UTC
        ts = datetime.datetime(2024, 1, 1, 12, 0, 0).timestamp()
        lines = [self._make_line("あいう", ts)]
        result = calculate_heatmap_data(lines)
        assert "2024" in result
        assert "2024-01-01" in result["2024"]
        assert result["2024"]["2024-01-01"] == 3  # 3 chars

    def test_accumulates_chars_same_day(self):
        ts = datetime.datetime(2024, 6, 15, 10, 0, 0).timestamp()
        lines = [
            self._make_line("あ", ts),
            self._make_line("いう", ts + 60),
        ]
        result = calculate_heatmap_data(lines)
        assert result["2024"]["2024-06-15"] == 3

    def test_filter_by_year(self):
        ts_2024 = datetime.datetime(2024, 1, 1).timestamp()
        ts_2025 = datetime.datetime(2025, 1, 1).timestamp()
        lines = [
            self._make_line("あ", ts_2024),
            self._make_line("い", ts_2025),
        ]
        result = calculate_heatmap_data(lines, filter_year="2024")
        assert "2024" in result
        assert "2025" not in result

    def test_none_line_text_counts_zero(self):
        ts = datetime.datetime(2024, 3, 1).timestamp()
        lines = [self._make_line(None, ts)]
        result = calculate_heatmap_data(lines)
        assert result["2024"]["2024-03-01"] == 0


# ---------------------------------------------------------------------------
# calculate_mining_heatmap_data
# ---------------------------------------------------------------------------


class TestCalculateMiningHeatmapData:
    def _make_line(self, timestamp, screenshot_in_anki="", audio_in_anki="", note_ids=None):
        return SimpleNamespace(
            line_text="テスト",
            timestamp=timestamp,
            screenshot_in_anki=screenshot_in_anki,
            audio_in_anki=audio_in_anki,
            note_ids=note_ids,
        )

    def test_empty_lines(self):
        result = calculate_mining_heatmap_data([])
        assert result == {}

    def test_line_with_screenshot_counted(self):
        ts = datetime.datetime(2024, 5, 10).timestamp()
        lines = [self._make_line(ts, screenshot_in_anki="img.png")]
        result = calculate_mining_heatmap_data(lines)
        assert result["2024"]["2024-05-10"] == 1

    def test_line_with_audio_counted(self):
        ts = datetime.datetime(2024, 5, 10).timestamp()
        lines = [self._make_line(ts, audio_in_anki="audio.mp3")]
        result = calculate_mining_heatmap_data(lines)
        assert result["2024"]["2024-05-10"] == 1

    def test_line_with_note_ids_counted(self):
        ts = datetime.datetime(2024, 5, 10).timestamp()
        lines = [self._make_line(ts, note_ids=["12345"])]
        result = calculate_mining_heatmap_data(lines)
        assert result["2024"]["2024-05-10"] == 1

    def test_unmined_line_not_counted(self):
        ts = datetime.datetime(2024, 5, 10).timestamp()
        lines = [self._make_line(ts)]
        result = calculate_mining_heatmap_data(lines)
        assert result == {}


# ---------------------------------------------------------------------------
# format_large_number
# ---------------------------------------------------------------------------


class TestFormatLargeNumber:
    def test_small_number(self):
        assert format_large_number(42) == "42"
        assert format_large_number(999) == "999"

    def test_thousands(self):
        assert format_large_number(1000) == "1.0K"
        assert format_large_number(1500) == "1.5K"
        assert format_large_number(999999) == "1000.0K"

    def test_millions(self):
        assert format_large_number(1000000) == "1.0M"
        assert format_large_number(2500000) == "2.5M"

    def test_zero(self):
        assert format_large_number(0) == "0"


# ---------------------------------------------------------------------------
# format_time_human_readable
# ---------------------------------------------------------------------------


class TestFormatTimeHumanReadable:
    def test_minutes_only(self):
        assert format_time_human_readable(0.5) == "30m"

    def test_hours_only(self):
        assert format_time_human_readable(3.0) == "3h"

    def test_hours_and_minutes(self):
        assert format_time_human_readable(2.5) == "2h 30m"

    def test_days(self):
        assert format_time_human_readable(48.0) == "2d"

    def test_days_and_hours(self):
        assert format_time_human_readable(26.0) == "1d 2h"

    def test_zero(self):
        assert format_time_human_readable(0) == "0m"


# ---------------------------------------------------------------------------
# generate_game_colors
# ---------------------------------------------------------------------------


class TestGenerateGameColors:
    def test_returns_correct_count(self):
        assert len(generate_game_colors(5)) == 5

    def test_returns_hex_colors_for_small_count(self):
        colors = generate_game_colors(3)
        for c in colors:
            assert c.startswith("#")

    def test_handles_large_count(self):
        colors = generate_game_colors(30)
        assert len(colors) == 30

    def test_zero_games(self):
        assert generate_game_colors(0) == []