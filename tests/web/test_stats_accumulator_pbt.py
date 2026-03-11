"""
Property-based tests for single-pass rollup accumulator equivalence.

Feature: stats-endpoint-restructure
Property 1: Single-pass accumulator equivalence

Validates: Requirements 1.3
"""

from __future__ import annotations

import datetime
import json
import math

from hypothesis import given, settings
from hypothesis import strategies as st

from GameSentenceMiner.web.stats_api import (
    _accumulate_rollup_metrics,
    _build_reading_speed_heatmap,
    _build_peak_daily_stats,
    _build_all_lines_data,
)
from GameSentenceMiner.web.rollup_stats import (
    build_heatmap_from_rollup,
    calculate_day_of_week_averages_from_rollup,
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
        values=st.fixed_dictionaries({
            "title": st.text(min_size=1, max_size=20),
            "lines": st.integers(min_value=0, max_value=500),
            "chars": st.integers(min_value=0, max_value=10000),
        }),
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
        min_value=0, max_value=36000,
    ).map(float),
    anki_cards_created=st.integers(min_value=0, max_value=100),
    game_activity_data=_game_activity_st,
)

# Lists of rollups with unique dates (the real table has one row per date)
_rollups_st = st.lists(
    _rollup_st, min_size=0, max_size=30,
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
def test_single_pass_accumulator_equivalence(rollups):
    """
    **Validates: Requirements 1.3**

    Property 1: Single-pass accumulator equivalence

    For any list of rollup records, the single-pass _accumulate_rollup_metrics
    function produces heatmap_data, reading_speed_heatmap_data, peak_daily_stats,
    all_lines_data, and day_of_week_totals equivalent to the old multi-pass helpers.
    """
    filter_year = None
    game_id_to_title: dict[str, str] = {}
    third_party_by_date = None

    # --- New single-pass ---
    acc = _accumulate_rollup_metrics(
        rollups, filter_year, game_id_to_title, third_party_by_date,
    )

    # --- Old multi-pass helpers ---
    old_heatmap = build_heatmap_from_rollup(rollups, filter_year, third_party_by_date)
    old_speed, old_max_speed = _build_reading_speed_heatmap(
        rollups, [], False, filter_year,
    )
    old_peaks = _build_peak_daily_stats(rollups, None)
    old_all_lines = _build_all_lines_data(rollups, [], False, third_party_by_date)
    old_dow = calculate_day_of_week_averages_from_rollup(rollups, third_party_by_date)

    # --- Assert heatmap_data equivalence ---
    # The old helper uses defaultdict(int) so convert both to plain dicts
    new_heatmap = acc["heatmap_data"]
    for year in set(list(new_heatmap.keys()) + list(old_heatmap.keys())):
        new_dates = new_heatmap.get(year, {})
        old_dates = old_heatmap.get(year, {})
        assert set(new_dates.keys()) == set(old_dates.keys()), (
            f"Heatmap date keys differ for year {year}"
        )
        for date_key in new_dates:
            assert new_dates[date_key] == old_dates[date_key], (
                f"Heatmap value differs for {date_key}: "
                f"new={new_dates[date_key]}, old={old_dates[date_key]}"
            )

    # --- Assert reading_speed_heatmap_data equivalence ---
    new_speed = acc["reading_speed_heatmap_data"]
    for year in set(list(new_speed.keys()) + list(old_speed.keys())):
        new_dates = new_speed.get(year, {})
        old_dates = old_speed.get(year, {})
        assert set(new_dates.keys()) == set(old_dates.keys()), (
            f"Speed heatmap date keys differ for year {year}"
        )
        for date_key in new_dates:
            assert new_dates[date_key] == old_dates[date_key], (
                f"Speed value differs for {date_key}"
            )
    assert acc["max_reading_speed"] == old_max_speed, (
        f"max_reading_speed: new={acc['max_reading_speed']}, old={old_max_speed}"
    )

    # --- Assert peak_daily_stats equivalence ---
    new_peaks = acc["peak_daily_stats"]
    assert new_peaks["max_daily_chars"] == old_peaks["max_daily_chars"], (
        f"max_daily_chars: new={new_peaks['max_daily_chars']}, "
        f"old={old_peaks['max_daily_chars']}"
    )
    assert math.isclose(
        new_peaks["max_daily_hours"], old_peaks["max_daily_hours"], rel_tol=1e-9,
    ), (
        f"max_daily_hours: new={new_peaks['max_daily_hours']}, "
        f"old={old_peaks['max_daily_hours']}"
    )

    # --- Assert all_lines_data equivalence ---
    new_all = sorted(acc["all_lines_data"], key=lambda x: x["date"])
    old_all = sorted(old_all_lines, key=lambda x: x["date"])
    assert len(new_all) == len(old_all), (
        f"all_lines_data length: new={len(new_all)}, old={len(old_all)}"
    )
    for new_item, old_item in zip(new_all, old_all):
        assert new_item["date"] == old_item["date"]
        assert new_item["characters"] == old_item["characters"], (
            f"all_lines characters differ for {new_item['date']}"
        )
        assert math.isclose(
            new_item["reading_time_seconds"],
            old_item["reading_time_seconds"],
            rel_tol=1e-9,
            abs_tol=1e-9,
        ), (
            f"all_lines reading_time_seconds differ for {new_item['date']}"
        )
        assert math.isclose(
            new_item["timestamp"], old_item["timestamp"], rel_tol=1e-9,
        ), (
            f"all_lines timestamp differ for {new_item['date']}"
        )

    # --- Assert day_of_week_totals equivalence ---
    new_dow = acc["day_of_week_totals"]
    for i in range(7):
        assert new_dow["chars"][i] == old_dow["chars"][i], (
            f"day_of_week chars[{i}]: new={new_dow['chars'][i]}, old={old_dow['chars'][i]}"
        )
        assert math.isclose(
            new_dow["hours"][i], old_dow["hours"][i], rel_tol=1e-9, abs_tol=1e-9,
        ), (
            f"day_of_week hours[{i}]: new={new_dow['hours'][i]}, old={old_dow['hours'][i]}"
        )
        assert new_dow["counts"][i] == old_dow["counts"][i], (
            f"day_of_week counts[{i}]: new={new_dow['counts'][i]}, old={old_dow['counts'][i]}"
        )


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
        rollups, filter_year, game_id_to_title, third_party_by_date,
    )

    mining_heatmap = acc["mining_heatmap_data"]

    # Collect all (year, date, cards) entries from the heatmap output
    heatmap_entries: dict[str, int] = {}
    for year, dates in mining_heatmap.items():
        for date_str, cards in dates.items():
            # Each date must belong to the correct year bucket
            assert date_str.startswith(year), (
                f"Date {date_str} found under year {year}"
            )
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

