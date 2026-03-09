"""
Tests for third-party stats: table model, Mokuro parsing, and rollup integration.
Pure function tests -- no Flask or database needed for most tests.
"""

import json
import pytest
from types import SimpleNamespace
from datetime import datetime, timezone

from GameSentenceMiner.web.third_party_stats_api import (
    parse_mokuro_volume_data,
    _analyze_page_turns,
    _extract_date_from_volume,
)
from GameSentenceMiner.web.rollup_stats import (
    enrich_aggregated_stats,
    build_heatmap_from_rollup,
    build_daily_chart_data_from_rollup,
    calculate_day_of_week_averages_from_rollup,
)


# ============================================================
# Mokuro Parsing Tests
# ============================================================


class TestExtractDateFromVolume:
    def test_from_last_progress_update(self):
        vol = {"lastProgressUpdate": "2025-12-19T05:31:13.843Z"}
        assert _extract_date_from_volume(vol) == "2025-12-19"

    def test_from_added_on(self):
        vol = {"addedOn": "2025-12-18T15:57:10.837Z"}
        assert _extract_date_from_volume(vol) == "2025-12-18"

    def test_prefers_last_progress_update(self):
        vol = {
            "lastProgressUpdate": "2025-12-20T00:00:00Z",
            "addedOn": "2025-12-18T00:00:00Z",
        }
        assert _extract_date_from_volume(vol) == "2025-12-20"

    def test_returns_none_when_missing(self):
        assert _extract_date_from_volume({}) is None

    def test_invalid_date_string(self):
        vol = {"lastProgressUpdate": "not-a-date", "addedOn": "2025-01-01T00:00:00Z"}
        assert _extract_date_from_volume(vol) == "2025-01-01"


class TestAnalyzePageTurns:
    def test_single_day(self):
        # All page turns on the same day (2025-12-17 UTC)
        ts_base = int(
            datetime(2025, 12, 17, 10, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
        )
        page_turns = [
            [ts_base, 1, 0],
            [ts_base + 60000, 2, 100],
            [ts_base + 120000, 3, 250],
        ]
        result = _analyze_page_turns(page_turns, 250, 600.0, {})
        assert "2025-12-17" in result
        assert result["2025-12-17"]["chars"] == 250  # 250 - 0
        assert result["2025-12-17"]["time"] == 600.0

    def test_multi_day_split(self):
        # Day 1: chars go from 0 to 100
        # Day 2: chars go from 100 to 300
        ts_day1 = int(
            datetime(2025, 12, 17, 10, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
        )
        ts_day2 = int(
            datetime(2025, 12, 18, 10, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
        )

        page_turns = [
            [ts_day1, 1, 0],
            [ts_day1 + 60000, 2, 100],
            [ts_day2, 3, 100],
            [ts_day2 + 60000, 4, 300],
        ]
        result = _analyze_page_turns(page_turns, 300, 600.0, {})

        assert "2025-12-17" in result
        assert "2025-12-18" in result
        # Day 1: 100 chars (100-0), Day 2: 200 chars (300-100)
        assert result["2025-12-17"]["chars"] == 100
        assert result["2025-12-18"]["chars"] == 200
        # Time proportional: day1 = 600 * (100/300), day2 = 600 * (200/300)
        assert abs(result["2025-12-17"]["time"] - 200.0) < 1.0
        assert abs(result["2025-12-18"]["time"] - 400.0) < 1.0

    def test_pre_log_chars_attributed_to_added_on(self):
        # First page turn starts at chars=500 (not 0), addedOn is earlier
        ts_day2 = int(
            datetime(2025, 12, 18, 10, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
        )
        page_turns = [
            [ts_day2, 10, 500],
            [ts_day2 + 60000, 11, 600],
        ]
        volume = {"addedOn": "2025-12-15T00:00:00Z"}
        result = _analyze_page_turns(page_turns, 600, 600.0, volume)

        # Day2 gets 100 chars (600-500), addedOn day gets 500 chars
        assert "2025-12-15" in result
        assert result["2025-12-15"]["chars"] == 500
        assert "2025-12-18" in result
        assert result["2025-12-18"]["chars"] == 100

    def test_backward_page_turns_handled(self):
        # User goes back and forth (chars_so_far oscillates)
        ts = int(
            datetime(2025, 12, 17, 10, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
        )
        page_turns = [
            [ts, 5, 0],
            [ts + 10000, 6, 100],
            [ts + 20000, 5, 50],  # went back
            [ts + 30000, 6, 100],
            [ts + 40000, 7, 200],
        ]
        result = _analyze_page_turns(page_turns, 200, 300.0, {})
        # high-water mark: 0 → 100 → (50 skip) → (100 skip) → 200
        # New chars: 100 + 100 = 200 (backward navigation doesn't double-count)
        assert result["2025-12-17"]["chars"] == 200


class TestParseMokuroVolumeData:
    def test_skips_deleted_volumes(self):
        data = {
            "vol1": {
                "chars": 1000,
                "timeReadInMinutes": 30,
                "deletedOn": "2025-01-01T00:00:00Z",
                "lastProgressUpdate": "2025-01-01T00:00:00Z",
                "series_title": "Test",
                "volume_title": "v1",
            }
        }
        assert parse_mokuro_volume_data(data) == []

    def test_skips_empty_volumes(self):
        data = {
            "vol1": {
                "chars": 0,
                "timeReadInMinutes": 0,
                "series_title": "Test",
                "volume_title": "v1",
            }
        }
        assert parse_mokuro_volume_data(data) == []

    def test_skips_placeholder_entries(self):
        data = {"placeholder-abc": {"addedOn": "2025-01-01T00:00:00Z"}}
        assert parse_mokuro_volume_data(data) == []

    def test_volume_without_page_turns(self):
        data = {
            "vol1": {
                "chars": 5000,
                "timeReadInMinutes": 120,
                "lastProgressUpdate": "2025-06-15T10:00:00Z",
                "series_title": "My Manga",
                "volume_title": "Vol 1",
            }
        }
        results = parse_mokuro_volume_data(data)
        assert len(results) == 1
        assert results[0]["date"] == "2025-06-15"
        assert results[0]["characters_read"] == 5000
        assert results[0]["time_read_seconds"] == 7200.0  # 120 * 60
        assert results[0]["label"] == "My Manga - Vol 1"

    def test_volume_with_page_turns_creates_daily_entries(self):
        ts_day1 = int(
            datetime(2025, 12, 17, 10, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
        )
        ts_day2 = int(
            datetime(2025, 12, 18, 10, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
        )

        data = {
            "vol1": {
                "chars": 300,
                "timeReadInMinutes": 60,
                "series_title": "Test Series",
                "volume_title": "v1",
                "recentPageTurns": [
                    [ts_day1, 1, 0],
                    [ts_day1 + 60000, 2, 100],
                    [ts_day2, 3, 100],
                    [ts_day2 + 60000, 4, 300],
                ],
            }
        }
        results = parse_mokuro_volume_data(data)
        assert len(results) == 2

        by_date = {r["date"]: r for r in results}
        assert by_date["2025-12-17"]["characters_read"] == 100
        assert by_date["2025-12-18"]["characters_read"] == 200
        assert all(r["label"] == "Test Series - v1" for r in results)

    def test_multiple_volumes(self):
        data = {
            "vol1": {
                "chars": 1000,
                "timeReadInMinutes": 30,
                "lastProgressUpdate": "2025-06-01T00:00:00Z",
                "series_title": "A",
                "volume_title": "1",
            },
            "vol2": {
                "chars": 2000,
                "timeReadInMinutes": 60,
                "lastProgressUpdate": "2025-06-02T00:00:00Z",
                "series_title": "B",
                "volume_title": "1",
            },
        }
        results = parse_mokuro_volume_data(data)
        assert len(results) == 2
        total_chars = sum(r["characters_read"] for r in results)
        assert total_chars == 3000


# ============================================================
# Rollup Integration Tests
# ============================================================


def _rollup(date="2024-06-15", **kw):
    """Create a mock rollup object."""
    defaults = dict(
        total_lines=10,
        total_characters=500,
        total_sessions=2,
        total_reading_time_seconds=3600.0,
        total_active_time_seconds=3000.0,
        average_reading_speed_chars_per_hour=500.0,
        peak_reading_speed_chars_per_hour=600.0,
        longest_session_seconds=1800.0,
        shortest_session_seconds=900.0,
        average_session_seconds=1500.0,
        max_chars_in_session=300,
        max_time_in_session_seconds=1800.0,
        games_completed=0,
        anki_cards_created=3,
        lines_with_screenshots=2,
        lines_with_audio=1,
        lines_with_translations=0,
    )
    defaults.update(kw)
    for k in [
        "games_played_ids",
        "game_activity_data",
        "kanji_frequency_data",
        "hourly_activity_data",
        "hourly_reading_speed_data",
        "genre_activity_data",
        "type_activity_data",
    ]:
        defaults.setdefault(k, json.dumps(kw.get(k, {} if "data" in k else [])))
    return SimpleNamespace(date=date, **defaults)


class TestEnrichAggregatedStats:
    def test_no_third_party_data(self):
        stats = {
            "total_characters": 1000,
            "total_reading_time_seconds": 3600.0,
            "total_active_time_seconds": 3000.0,
        }
        result = enrich_aggregated_stats(stats, None)
        assert result["total_characters"] == 1000
        assert result["total_reading_time_seconds"] == 3600.0

    def test_empty_third_party_data(self):
        stats = {
            "total_characters": 1000,
            "total_reading_time_seconds": 3600.0,
            "total_active_time_seconds": 3000.0,
        }
        result = enrich_aggregated_stats(stats, {})
        assert result["total_characters"] == 1000

    def test_adds_third_party_characters_and_time(self):
        stats = {
            "total_characters": 1000,
            "total_reading_time_seconds": 3600.0,
            "total_active_time_seconds": 3000.0,
            "average_reading_speed_chars_per_hour": 1000.0,
        }
        tp_data = {
            "2024-06-15": {"characters": 500, "time_seconds": 1800.0},
            "2024-06-16": {"characters": 300, "time_seconds": 900.0},
        }
        result = enrich_aggregated_stats(stats, tp_data)
        assert result["total_characters"] == 1800  # 1000 + 500 + 300
        assert result["total_reading_time_seconds"] == 6300.0  # 3600 + 1800 + 900
        assert result["total_active_time_seconds"] == 5700.0  # 3000 + 1800 + 900
        # Speed should be recalculated: 1800 / (5700/3600) = ~1136.8
        assert result["average_reading_speed_chars_per_hour"] > 0

    def test_recalculates_speed(self):
        stats = {
            "total_characters": 0,
            "total_reading_time_seconds": 0.0,
            "total_active_time_seconds": 0.0,
            "average_reading_speed_chars_per_hour": 0.0,
        }
        tp_data = {
            "2024-06-15": {"characters": 3600, "time_seconds": 3600.0},
        }
        result = enrich_aggregated_stats(stats, tp_data)
        assert (
            result["average_reading_speed_chars_per_hour"] == 3600.0
        )  # 3600 chars / 1 hour


class TestHeatmapWithThirdParty:
    def test_heatmap_includes_third_party(self):
        rollups = [_rollup(date="2024-06-15", total_characters=500)]
        tp_data = {
            "2024-06-15": {"characters": 200, "time_seconds": 600},
            "2024-06-16": {"characters": 300, "time_seconds": 900},
        }
        result = build_heatmap_from_rollup(rollups, third_party_by_date=tp_data)
        assert result["2024"]["2024-06-15"] == 700  # 500 + 200
        assert result["2024"]["2024-06-16"] == 300  # only 3rd party

    def test_heatmap_without_third_party(self):
        rollups = [_rollup(date="2024-06-15", total_characters=500)]
        result = build_heatmap_from_rollup(rollups)
        assert result["2024"]["2024-06-15"] == 500

    def test_heatmap_year_filter(self):
        rollups = [
            _rollup(date="2024-06-15", total_characters=100),
            _rollup(date="2025-01-01", total_characters=200),
        ]
        tp_data = {
            "2024-06-15": {"characters": 50, "time_seconds": 300},
            "2025-01-01": {"characters": 75, "time_seconds": 300},
        }
        result = build_heatmap_from_rollup(
            rollups, filter_year="2024", third_party_by_date=tp_data
        )
        assert "2024" in result
        assert "2025" not in result
        assert result["2024"]["2024-06-15"] == 150


class TestDailyChartWithThirdParty:
    def test_chart_includes_third_party_pseudo_game(self):
        rollups = [_rollup(date="2024-06-15")]
        tp_data = {
            "2024-06-15": {"characters": 500, "time_seconds": 1800},
        }
        result = build_daily_chart_data_from_rollup(
            rollups, third_party_by_date=tp_data
        )
        assert "3rd Party Reading" in result["2024-06-15"]
        assert result["2024-06-15"]["3rd Party Reading"]["chars"] == 500

    def test_chart_without_third_party(self):
        rollups = [_rollup(date="2024-06-15")]
        result = build_daily_chart_data_from_rollup(rollups)
        assert "3rd Party Reading" not in result.get("2024-06-15", {})


class TestDayOfWeekWithThirdParty:
    def test_dow_includes_third_party(self):
        # 2024-06-17 is Monday (weekday=0)
        rollups = [
            _rollup(
                date="2024-06-17",
                total_characters=1000,
                total_reading_time_seconds=3600,
            )
        ]
        tp_data = {
            "2024-06-17": {"characters": 500, "time_seconds": 1800},
        }
        result = calculate_day_of_week_averages_from_rollup(
            rollups, third_party_by_date=tp_data
        )
        assert result["chars"][0] == 1500  # Monday: 1000 + 500
        assert abs(result["hours"][0] - 1.5) < 0.01  # (3600 + 1800) / 3600 = 1.5h

    def test_dow_third_party_only_date_increments_count(self):
        # 2024-06-18 is Tuesday (weekday=1) - only in 3rd party, not in rollups
        rollups = [_rollup(date="2024-06-17")]  # Monday
        tp_data = {
            "2024-06-18": {"characters": 200, "time_seconds": 600},  # Tuesday
        }
        result = calculate_day_of_week_averages_from_rollup(
            rollups, third_party_by_date=tp_data
        )
        assert result["chars"][1] == 200  # Tuesday
        assert result["counts"][1] == 1  # New day counted


# ============================================================
# Volume data.json integration test (realistic data)
# ============================================================


class TestRealisticMokuroData:
    def test_real_world_volume_structure(self):
        """Test with a structure matching the actual volume-data.json format."""
        ts_base = int(
            datetime(2025, 12, 17, 17, 20, 0, tzinfo=timezone.utc).timestamp() * 1000
        )
        ts_day2 = int(
            datetime(2025, 12, 19, 5, 31, 0, tzinfo=timezone.utc).timestamp() * 1000
        )

        data = {
            "abee6196-61b3-44d6-9076-4c2d59d046b9": {
                "progress": 183,
                "chars": 11845,
                "completed": True,
                "timeReadInMinutes": 285,
                "lastProgressUpdate": "2025-12-19T05:31:13.843Z",
                "settings": {"rightToLeft": True, "hasCover": True},
                "recentPageTurns": [
                    [ts_base, 76, 4992],
                    [ts_base + 60000, 77, 5100],
                    [ts_base + 120000, 78, 5200],
                    [ts_day2, 181, 11442],
                    [ts_day2 + 1000, 182, 11558],
                    [ts_day2 + 2000, 183, 11845],
                ],
                "series_uuid": "054a8102-c0af-4ba1-93e8-e2d5b8103464",
                "series_title": "やがて君になる",
                "volume_title": "第01巻",
                "addedOn": "2025-12-15T00:00:00.000Z",
            }
        }

        results = parse_mokuro_volume_data(data)

        # Should have entries for multiple days
        assert len(results) >= 2

        # All entries should have the correct label
        for r in results:
            assert r["label"] == "やがて君になる - 第01巻"

        # Total chars across all days should not exceed total chars
        total_chars = sum(r["characters_read"] for r in results)
        assert total_chars == 11845  # All chars accounted for

        # Total time should equal original time
        total_time = sum(r["time_read_seconds"] for r in results)
        assert abs(total_time - 285 * 60) < 1.0


# ============================================================
# Batch Import API Validation Tests (pure logic, no Flask)
# ============================================================


class TestBatchImportValidation:
    """
    Tests for the batch import endpoint's validation logic.
    These test the validation patterns that the /api/import-stats endpoint uses.
    """

    def _validate_entry(self, entry, index=0):
        """Replicate the validation logic from the batch import endpoint."""
        errors = []
        if not isinstance(entry, dict):
            errors.append(f"Entry {index}: must be an object")
            return None, errors

        date_str = str(entry.get("date", "")).strip()
        if not date_str:
            errors.append(f"Entry {index}: 'date' is required")
            return None, errors
        try:
            datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            errors.append(
                f"Entry {index}: 'date' must be YYYY-MM-DD (got '{date_str}')"
            )
            return None, errors

        try:
            characters_read = int(entry.get("characters_read", 0))
            time_read_seconds = float(entry.get("time_read_seconds", 0))
        except (ValueError, TypeError):
            errors.append(
                f"Entry {index}: invalid number for characters_read or time_read_seconds"
            )
            return None, errors

        if characters_read < 0 or time_read_seconds < 0:
            errors.append(f"Entry {index}: values cannot be negative")
            return None, errors

        if characters_read == 0 and time_read_seconds == 0:
            return None, []  # Silently skip

        source = str(entry.get("source", "")).strip()
        if not source:
            errors.append(f"Entry {index}: 'source' is required")
            return None, errors

        label = str(entry.get("label", "")).strip() or source

        return {
            "date": date_str,
            "characters_read": characters_read,
            "time_read_seconds": time_read_seconds,
            "source": source,
            "label": label,
        }, errors

    def test_valid_entry(self):
        entry = {
            "date": "2025-03-08",
            "characters_read": 5000,
            "time_read_seconds": 3600,
            "source": "ttsu",
            "label": "Book Title",
        }
        result, errors = self._validate_entry(entry)
        assert result is not None
        assert errors == []
        assert result["date"] == "2025-03-08"
        assert result["characters_read"] == 5000
        assert result["time_read_seconds"] == 3600
        assert result["source"] == "ttsu"
        assert result["label"] == "Book Title"

    def test_missing_date(self):
        entry = {"characters_read": 100, "source": "ttsu"}
        result, errors = self._validate_entry(entry)
        assert result is None
        assert len(errors) == 1
        assert "'date' is required" in errors[0]

    def test_invalid_date_format(self):
        entry = {"date": "March 8", "characters_read": 100, "source": "ttsu"}
        result, errors = self._validate_entry(entry)
        assert result is None
        assert "YYYY-MM-DD" in errors[0]

    def test_missing_source(self):
        entry = {"date": "2025-03-08", "characters_read": 100}
        result, errors = self._validate_entry(entry)
        assert result is None
        assert "'source' is required" in errors[0]

    def test_empty_source(self):
        entry = {"date": "2025-03-08", "characters_read": 100, "source": "  "}
        result, errors = self._validate_entry(entry)
        assert result is None
        assert "'source' is required" in errors[0]

    def test_negative_characters(self):
        entry = {
            "date": "2025-03-08",
            "characters_read": -100,
            "source": "ttsu",
        }
        result, errors = self._validate_entry(entry)
        assert result is None
        assert "negative" in errors[0]

    def test_negative_time(self):
        entry = {
            "date": "2025-03-08",
            "time_read_seconds": -60,
            "source": "ttsu",
        }
        result, errors = self._validate_entry(entry)
        assert result is None
        assert "negative" in errors[0]

    def test_zero_values_skipped(self):
        """Entries with both chars=0 and time=0 should be silently skipped."""
        entry = {
            "date": "2025-03-08",
            "characters_read": 0,
            "time_read_seconds": 0,
            "source": "ttsu",
        }
        result, errors = self._validate_entry(entry)
        assert result is None
        assert errors == []

    def test_label_defaults_to_source(self):
        entry = {
            "date": "2025-03-08",
            "characters_read": 100,
            "source": "kindle",
        }
        result, errors = self._validate_entry(entry)
        assert result is not None
        assert result["label"] == "kindle"

    def test_not_a_dict(self):
        result, errors = self._validate_entry("not a dict")
        assert result is None
        assert "must be an object" in errors[0]

    def test_invalid_number_types(self):
        entry = {
            "date": "2025-03-08",
            "characters_read": "abc",
            "source": "ttsu",
        }
        result, errors = self._validate_entry(entry)
        assert result is None
        assert "invalid number" in errors[0]

    def test_defaults_for_optional_fields(self):
        """Characters and time default to 0 if not provided, but at least one must be > 0."""
        entry = {
            "date": "2025-03-08",
            "characters_read": 500,
            "source": "manual",
        }
        result, errors = self._validate_entry(entry)
        assert result is not None
        assert result["time_read_seconds"] == 0.0
        assert result["characters_read"] == 500

    def test_batch_with_mixed_valid_invalid(self):
        """Validate a batch with some valid and some invalid entries."""
        entries = [
            {
                "date": "2025-03-08",
                "characters_read": 5000,
                "time_read_seconds": 3600,
                "source": "ttsu",
                "label": "Good Entry",
            },
            {"date": "bad-date", "characters_read": 100, "source": "ttsu"},
            {
                "date": "2025-03-09",
                "characters_read": 3000,
                "source": "ttsu",
                "label": "Another Good Entry",
            },
            {"characters_read": 100, "source": "ttsu"},  # missing date
        ]

        validated = []
        all_errors = []
        for i, e in enumerate(entries):
            result, errors = self._validate_entry(e, i)
            if result:
                validated.append(result)
            all_errors.extend(errors)

        assert len(validated) == 2
        assert len(all_errors) == 2
        assert validated[0]["label"] == "Good Entry"
        assert validated[1]["label"] == "Another Good Entry"

    def test_multiple_sources_in_batch(self):
        """Batch can contain entries from different sources."""
        entries = [
            {
                "date": "2025-03-08",
                "characters_read": 1000,
                "source": "ttsu",
                "label": "Book A",
            },
            {
                "date": "2025-03-08",
                "characters_read": 2000,
                "source": "kindle",
                "label": "Book B",
            },
            {
                "date": "2025-03-09",
                "characters_read": 500,
                "time_read_seconds": 1800,
                "source": "ttsu",
                "label": "Book A",
            },
        ]

        validated = []
        for i, e in enumerate(entries):
            result, _ = self._validate_entry(e, i)
            if result:
                validated.append(result)

        assert len(validated) == 3
        sources = set(v["source"] for v in validated)
        assert sources == {"ttsu", "kindle"}
