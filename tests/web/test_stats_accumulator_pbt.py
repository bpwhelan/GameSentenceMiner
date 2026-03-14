"""
Property-based tests for single-pass rollup accumulator.

Feature: stats-refactor
Property 1: Single-pass accumulator correctness

Validates: Requirements 1.1, 1.2
"""

from __future__ import annotations

import datetime
import json
import math

from hypothesis import given, settings
from hypothesis import strategies as st

from GameSentenceMiner.web.stats_api import (
    _accumulate_rollup_metrics,
)


# ---------------------------------------------------------------------------
# Fake rollup record for hypothesis generation
# ---------------------------------------------------------------------------


class FakeRollup:
    """Lightweight stand-in for StatsRollupTable rows."""

    def __init__(
        self,
        date: str,
        total_lines: int,
        total_characters: int,
        total_reading_time_seconds: float,
        anki_cards_created: int,
        game_activity_data: str | None,
    ):
        self.date = date
        self.total_lines = total_lines
        self.total_characters = total_characters
        self.total_reading_time_seconds = total_reading_time_seconds
        self.anki_cards_created = anki_cards_created
        self.game_activity_data = game_activity_data


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------

# Generate dates in a realistic range (2020-01-01 to 2025-12-31)
_date_st = st.dates(
    min_value=datetime.date(2020, 1, 1),
    max_value=datetime.date(2025, 12, 31),
).map(lambda d: d.strftime("%Y-%m-%d"))

_game_activity_st = st.one_of(
    st.none(),
    st.dictionaries(
        keys=st.text(
            alphabet=st.characters(categories=("L", "N")),
            min_size=4,
            max_size=12,
        ),
        values=st.fixed_dictionaries(
            {
                "title": st.text(min_size=1, max_size=20),
                "lines": st.integers(min_value=0, max_value=500),
                "chars": st.integers(min_value=0, max_value=10000),
            }
        ),
        min_size=0,
        max_size=3,
    ).map(lambda d: json.dumps(d) if d else None),
)

_rollup_st = st.builds(
    FakeRollup,
    date=_date_st,
    total_lines=st.integers(min_value=0, max_value=1000),
    total_characters=st.integers(min_value=0, max_value=50000),
    # Use integers mapped to float to avoid denormalized floats that cause
    # OverflowError in int(chars / hours) when time is near-zero but non-zero.
    # Real reading times are whole seconds from the rollup table anyway.
    total_reading_time_seconds=st.integers(
        min_value=0,
        max_value=36000,
    ).map(float),
    anki_cards_created=st.integers(min_value=0, max_value=100),
    game_activity_data=_game_activity_st,
)

# Lists of rollups with unique dates (the real table has one row per date)
_rollups_st = st.lists(
    _rollup_st,
    min_size=0,
    max_size=30,
).map(lambda rollups: _deduplicate_by_date(rollups))


def _deduplicate_by_date(rollups: list[FakeRollup]) -> list[FakeRollup]:
    """Keep only the first rollup per date to mirror real DB constraints."""
    seen: set[str] = set()
    result: list[FakeRollup] = []
    for r in rollups:
        if r.date not in seen:
            seen.add(r.date)
            result.append(r)
    return result


# ---------------------------------------------------------------------------
# Property 1: Single-pass accumulator equivalence
# ---------------------------------------------------------------------------


@settings(max_examples=150)
@given(rollups=_rollups_st)
def test_single_pass_accumulator_correctness(rollups):
    """
    **Validates: Requirements 1.1, 1.2**

    Property 1: Single-pass accumulator correctness

    For any list of rollup records, the single-pass _accumulate_rollup_metrics
    function produces internally consistent output: heatmap_data character counts
    match rollup inputs, reading_speed_heatmap_data speeds are correctly computed,
    peak_daily_stats reflect the actual maximums, all_lines_data has one entry per
    rollup date, and day_of_week_totals sum correctly.
    """
    filter_year = None
    game_id_to_title: dict[str, str] = {}
    third_party_by_date = None

    acc = _accumulate_rollup_metrics(
        rollups,
        filter_year,
        game_id_to_title,
        third_party_by_date,
    )

    # --- Verify heatmap_data matches rollup inputs ---
    new_heatmap = acc["heatmap_data"]
    for rollup in rollups:
        year = rollup.date.split("-")[0]
        assert year in new_heatmap, f"Year {year} missing from heatmap"
        assert rollup.date in new_heatmap[year], (
            f"Date {rollup.date} missing from heatmap"
        )
        assert new_heatmap[year][rollup.date] == rollup.total_characters, (
            f"Heatmap value for {rollup.date}: expected {rollup.total_characters}, "
            f"got {new_heatmap[year][rollup.date]}"
        )

    # --- Verify reading_speed_heatmap_data correctness ---
    new_speed = acc["reading_speed_heatmap_data"]
    max_speed_seen = 0
    for rollup in rollups:
        if rollup.total_reading_time_seconds > 0 and rollup.total_characters > 0:
            expected_speed = int(
                rollup.total_characters / (rollup.total_reading_time_seconds / 3600)
            )
            year = rollup.date.split("-")[0]
            assert year in new_speed, f"Year {year} missing from speed heatmap"
            assert rollup.date in new_speed[year], (
                f"Date {rollup.date} missing from speed heatmap"
            )
            assert new_speed[year][rollup.date] == expected_speed, (
                f"Speed for {rollup.date}: expected {expected_speed}, got {new_speed[year][rollup.date]}"
            )
            max_speed_seen = max(max_speed_seen, expected_speed)
    assert acc["max_reading_speed"] == max_speed_seen

    # --- Verify peak_daily_stats reflect actual maximums ---
    new_peaks = acc["peak_daily_stats"]
    expected_max_chars = max((r.total_characters for r in rollups), default=0)
    expected_max_hours = max(
        (r.total_reading_time_seconds / 3600 for r in rollups), default=0.0
    )
    assert new_peaks["max_daily_chars"] == expected_max_chars
    assert math.isclose(new_peaks["max_daily_hours"], expected_max_hours, rel_tol=1e-9)

    # --- Verify all_lines_data has one entry per rollup date ---
    new_all = sorted(acc["all_lines_data"], key=lambda x: x["date"])
    rollup_by_date = {r.date: r for r in rollups}
    assert len(new_all) == len(rollups), (
        f"all_lines_data length: {len(new_all)} != rollups: {len(rollups)}"
    )
    for item in new_all:
        r = rollup_by_date[item["date"]]
        assert item["characters"] == r.total_characters
        assert math.isclose(
            item["reading_time_seconds"],
            r.total_reading_time_seconds,
            rel_tol=1e-9,
            abs_tol=1e-9,
        )

    # --- Verify day_of_week_totals sum correctly ---
    new_dow = acc["day_of_week_totals"]
    expected_chars = [0] * 7
    expected_hours = [0.0] * 7
    expected_counts = [0] * 7
    for rollup in rollups:
        try:
            date_obj = datetime.datetime.strptime(rollup.date, "%Y-%m-%d")
            dow = date_obj.weekday()
            expected_chars[dow] += rollup.total_characters
            expected_hours[dow] += rollup.total_reading_time_seconds / 3600
            expected_counts[dow] += 1
        except ValueError:
            pass
    for i in range(7):
        assert new_dow["chars"][i] == expected_chars[i]
        assert math.isclose(
            new_dow["hours"][i], expected_hours[i], rel_tol=1e-9, abs_tol=1e-9
        )
        assert new_dow["counts"][i] == expected_counts[i]


# ---------------------------------------------------------------------------
# Property 2: Mining heatmap from rollup data
# ---------------------------------------------------------------------------


@settings(max_examples=150)
@given(rollups=_rollups_st)
def test_mining_heatmap_from_rollup_data(rollups):
    """
    **Validates: Requirements 2.1**

    Property 2: Mining heatmap from rollup data

    For any list of rollup records, the mining_heatmap_data output from
    _accumulate_rollup_metrics maps each rollup date to its anki_cards_created
    value (grouped by year), and dates with anki_cards_created == 0 are absent.
    """
    filter_year = None
    game_id_to_title: dict[str, str] = {}
    third_party_by_date = None

    acc = _accumulate_rollup_metrics(
        rollups,
        filter_year,
        game_id_to_title,
        third_party_by_date,
    )

    mining_heatmap = acc["mining_heatmap_data"]

    # Collect all (year, date, cards) entries from the heatmap output
    heatmap_entries: dict[str, int] = {}
    for year, dates in mining_heatmap.items():
        for date_str, cards in dates.items():
            # Each date must belong to the correct year bucket
            assert date_str.startswith(year), f"Date {date_str} found under year {year}"
            heatmap_entries[date_str] = cards

    for rollup in rollups:
        if rollup.anki_cards_created > 0:
            # Non-zero card dates must be present with the correct value
            assert rollup.date in heatmap_entries, (
                f"Date {rollup.date} with {rollup.anki_cards_created} cards "
                f"missing from mining_heatmap_data"
            )
            assert heatmap_entries[rollup.date] == rollup.anki_cards_created, (
                f"Date {rollup.date}: expected {rollup.anki_cards_created}, "
                f"got {heatmap_entries[rollup.date]}"
            )
        else:
            # Zero-card dates must be absent
            assert rollup.date not in heatmap_entries, (
                f"Date {rollup.date} with 0 cards should not be in "
                f"mining_heatmap_data but found {heatmap_entries.get(rollup.date)}"
            )

    # No extra dates should appear beyond what's in the rollups
    rollup_dates = {r.date for r in rollups}
    for date_str in heatmap_entries:
        assert date_str in rollup_dates, (
            f"Unexpected date {date_str} in mining_heatmap_data"
        )
