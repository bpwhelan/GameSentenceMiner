"""
Property-based tests for stats refactor: response equivalence and new endpoints.

Feature: stats-refactor
Properties 1, 2, 3, 4

Validates: Requirements 3.3, 6.1, 6.3, 7.1, 7.3, 8.1
"""

from __future__ import annotations

import datetime
import json
import re

import flask
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _in_memory_db():
    """Swap all table backends to a shared in-memory SQLite DB."""
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_stats


@pytest.fixture()
def app(_in_memory_db):
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True
    from GameSentenceMiner.web.stats_api import register_stats_api_routes

    register_stats_api_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


def _patch_heavy_deps(monkeypatch):
    """Patch expensive or side-effect-heavy functions that aren't under test."""
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.calculate_game_milestones",
        lambda: None,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.get_third_party_stats_by_date",
        lambda start, end: {},
    )


def _seed_rollup(
    date_str: str,
    total_chars: int = 1000,
    total_lines: int = 50,
    reading_time: float = 3600.0,
    anki_cards: int = 5,
    game_activity: dict | None = None,
    kanji_freq: dict | None = None,
):
    """Insert a rollup row into the in-memory DB."""
    ga = game_activity or {
        "abc123": {"title": "Test Game", "lines": total_lines, "chars": total_chars}
    }
    kf = kanji_freq or {}
    rollup = StatsRollupTable(
        date=date_str,
        total_lines=total_lines,
        total_characters=total_chars,
        total_reading_time_seconds=reading_time,
        anki_cards_created=anki_cards,
        game_activity_data=json.dumps(ga),
        kanji_frequency_data=json.dumps(kf),
        hourly_activity_data=json.dumps({"10": 500}),
        hourly_reading_speed_data=json.dumps({"10": 8000}),
        genre_activity_data=json.dumps({}),
        type_activity_data=json.dumps({}),
    )
    rollup.save()


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------

# Dates in a realistic past range (avoid today to keep rollup-only logic clean)
_date_st = st.dates(
    min_value=datetime.date(2022, 1, 1),
    max_value=datetime.date(2025, 6, 1),
)

# Kanji frequency dict: small set of kanji with positive counts
KANJI_POOL = list("漢字語学習日本読書食話聞見思知言作出来行")

_kanji_freq_st = st.one_of(
    st.just({}),
    st.dictionaries(
        keys=st.sampled_from(KANJI_POOL),
        values=st.integers(min_value=1, max_value=500),
        min_size=1,
        max_size=8,
    ),
)

# Whether to seed rollup data or leave DB empty
_seed_data_st = st.one_of(
    st.just(None),  # empty DB
    st.lists(
        st.tuples(
            _date_st,
            st.integers(min_value=1, max_value=10000),  # total_chars
            st.integers(min_value=1, max_value=500),  # total_lines
            st.integers(min_value=60, max_value=36000).map(float),  # reading_time
            _kanji_freq_st,
        ),
        min_size=1,
        max_size=5,
    ),
)

# Optional start/end timestamps
_optional_ts_st = st.one_of(
    st.just(None),
    _date_st.map(lambda d: datetime.datetime.combine(d, datetime.time.min).timestamp()),
)


@st.composite
def request_scenario(draw):
    """Generate a scenario: optional seed data + optional start/end params."""
    seed_data = draw(_seed_data_st)
    start_ts = draw(_optional_ts_st)
    end_ts = draw(_optional_ts_st)

    # Ensure start <= end when both present
    if start_ts is not None and end_ts is not None:
        if start_ts > end_ts:
            start_ts, end_ts = end_ts, start_ts

    return seed_data, start_ts, end_ts


def _apply_scenario(seed_data):
    """Seed the DB with the generated rollup data."""
    if seed_data is None:
        return
    seen_dates: set[str] = set()
    for date_obj, chars, lines, reading_time, kanji_freq in seed_data:
        date_str = date_obj.strftime("%Y-%m-%d")
        if date_str in seen_dates:
            continue
        seen_dates.add(date_str)
        _seed_rollup(
            date_str,
            total_chars=chars,
            total_lines=lines,
            reading_time=reading_time,
            kanji_freq=kanji_freq,
        )


def _build_query_string(start_ts, end_ts) -> str:
    """Build URL query string from optional timestamps."""
    params = []
    if start_ts is not None:
        params.append(f"start={start_ts}")
    if end_ts is not None:
        params.append(f"end={end_ts}")
    return "?" + "&".join(params) if params else ""


# ---------------------------------------------------------------------------
# Property 1: Response equivalence for retained keys
# Feature: stats-refactor, Property 1: Response equivalence for retained keys
# ---------------------------------------------------------------------------

# All keys the refactored /api/stats response must contain
EXPECTED_TOP_LEVEL_KEYS = {
    "labels",
    "datasets",
    "cardsMinedLast30Days",
    "heatmapData",
    "totalCharsPerGame",
    "readingTimePerGame",
    "readingSpeedPerGame",
    "currentGameStats",
    "allGamesStats",
    "hourlyActivityData",
    "hourlyReadingSpeedData",
    "peakDailyStats",
    "peakSessionStats",
    "readingSpeedHeatmapData",
    "maxReadingSpeed",
    "dayOfWeekData",
    "difficultySpeedData",
    "gameTypeData",
    "genreTagData",
    "genreStats",
    "typeStats",
    "timePeriodAverages",
    "miningHeatmapData",
}

# Strategy that always produces at least one rollup row so the response
# contains all retained keys (empty DB returns a minimal {"labels":[],"datasets":[]} shape).
_nonempty_seed_st = st.lists(
    st.tuples(
        _date_st,
        st.integers(min_value=1, max_value=10000),  # total_chars
        st.integers(min_value=1, max_value=500),  # total_lines
        st.integers(min_value=60, max_value=36000).map(float),  # reading_time
        _kanji_freq_st,
    ),
    min_size=1,
    max_size=5,
)


@st.composite
def seeded_scenario(draw):
    """Generate a scenario that always has rollup data and a covering date range."""
    seed_data = draw(_nonempty_seed_st)
    # Compute the date range that covers all seeded dates
    dates = [t[0] for t in seed_data]
    min_date = min(dates) - datetime.timedelta(days=1)
    max_date = max(dates) + datetime.timedelta(days=1)
    start_ts = datetime.datetime.combine(min_date, datetime.time.min).timestamp()
    end_ts = datetime.datetime.combine(max_date, datetime.time.max).timestamp()
    return seed_data, start_ts, end_ts


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(scenario=seeded_scenario())
def test_response_equivalence_for_retained_keys(scenario, client, monkeypatch):
    """
    **Validates: Requirements 3.3**

    # Feature: stats-refactor, Property 1: Response equivalence for retained keys

    For any valid set of rollup records, the /api/stats response contains all
    expected retained keys with correct types and internally consistent values.
    """
    seed_data, start_ts, end_ts = scenario
    _patch_heavy_deps(monkeypatch)
    _apply_scenario(seed_data)

    qs = _build_query_string(start_ts, end_ts)
    resp = client.get(f"/api/stats{qs}")
    assert resp.status_code == 200

    data = resp.get_json()

    # 1. All retained keys are present
    missing = EXPECTED_TOP_LEVEL_KEYS - set(data.keys())
    assert not missing, f"Missing retained keys: {missing}"

    # 2. labels is a sorted list of date strings
    labels = data["labels"]
    assert isinstance(labels, list), "labels must be a list"
    for lbl in labels:
        assert isinstance(lbl, str), f"label must be a string, got {type(lbl).__name__}"
        assert _DATE_PATTERN.match(lbl), f"label '{lbl}' does not match YYYY-MM-DD"
    assert labels == sorted(labels), "labels must be sorted chronologically"

    # 3. datasets is a list of dicts with required Chart.js fields
    datasets = data["datasets"]
    assert isinstance(datasets, list), "datasets must be a list"
    for ds in datasets:
        assert isinstance(ds, dict), "each dataset must be a dict"
        assert "label" in ds, "dataset missing 'label' field"
        assert "data" in ds, "dataset missing 'data' field"
        assert isinstance(ds["data"], list), "dataset 'data' must be a list"

    # 4. Numeric fields are non-negative
    assert isinstance(data["maxReadingSpeed"], (int, float)), (
        "maxReadingSpeed must be numeric"
    )
    assert data["maxReadingSpeed"] >= 0, "maxReadingSpeed must be non-negative"

    # hourlyActivityData and hourlyReadingSpeedData are lists of non-negative numbers
    for key in ("hourlyActivityData", "hourlyReadingSpeedData"):
        arr = data[key]
        assert isinstance(arr, list), f"{key} must be a list"
        for v in arr:
            assert isinstance(v, (int, float)), f"{key} elements must be numeric"
            assert v >= 0, f"{key} elements must be non-negative"

    # 5. heatmapData has {year_str: {date_str: count}} structure
    heatmap = data["heatmapData"]
    assert isinstance(heatmap, dict), "heatmapData must be a dict"
    for year_key, dates_map in heatmap.items():
        assert isinstance(year_key, str), "heatmap year key must be a string"
        assert isinstance(dates_map, dict), f"heatmap[{year_key}] must be a dict"
        for date_key, count in dates_map.items():
            assert isinstance(date_key, str), "heatmap date key must be a string"
            assert _DATE_PATTERN.match(date_key), f"heatmap date '{date_key}' invalid"
            assert isinstance(count, (int, float)), "heatmap count must be numeric"

    # 6. Per-game stats have matching labels/totals lengths
    for key in ("totalCharsPerGame", "readingTimePerGame", "readingSpeedPerGame"):
        pg = data[key]
        assert isinstance(pg, dict), f"{key} must be a dict"
        assert "labels" in pg, f"{key} missing 'labels'"
        assert "totals" in pg, f"{key} missing 'totals'"
        assert len(pg["labels"]) == len(pg["totals"]), (
            f"{key}: labels length ({len(pg['labels'])}) != totals length ({len(pg['totals'])})"
        )

    # 7. timePeriodAverages has the expected keys
    tpa = data["timePeriodAverages"]
    assert isinstance(tpa, dict), "timePeriodAverages must be a dict"
    expected_tpa_keys = {
        "avgHoursPerDay",
        "avgCharsPerDay",
        "avgSpeedPerDay",
        "totalHours",
        "totalChars",
    }
    missing_tpa = expected_tpa_keys - set(tpa.keys())
    assert not missing_tpa, f"timePeriodAverages missing keys: {missing_tpa}"


# ---------------------------------------------------------------------------
# Property 2: Removed keys are absent from stats response
# Feature: stats-refactor, Property 2: Removed keys are absent from stats response
# ---------------------------------------------------------------------------

REMOVED_KEYS = {"allLinesData", "kanjiGridData", "gameMilestones"}


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(scenario=request_scenario())
def test_removed_keys_absent_from_stats_response(scenario, client, monkeypatch):
    """
    **Validates: Requirements 6.1, 7.1, 8.1**

    # Feature: stats-refactor, Property 2: Removed keys are absent from stats response

    For any valid request to /api/stats (with or without start/end parameters,
    with or without seeded rollup data), the JSON response SHALL NOT contain
    the keys allLinesData, kanjiGridData, or gameMilestones.
    """
    seed_data, start_ts, end_ts = scenario
    _patch_heavy_deps(monkeypatch)
    _apply_scenario(seed_data)

    qs = _build_query_string(start_ts, end_ts)
    resp = client.get(f"/api/stats{qs}")
    assert resp.status_code == 200

    data = resp.get_json()
    present = REMOVED_KEYS & set(data.keys())
    assert not present, f"Removed keys still present in /api/stats response: {present}"


# ---------------------------------------------------------------------------
# Property 3: Kanji grid endpoint returns valid shape
# Feature: stats-refactor, Property 3: Kanji grid endpoint returns valid shape
# ---------------------------------------------------------------------------


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(scenario=request_scenario())
def test_kanji_grid_endpoint_returns_valid_shape(scenario, client, monkeypatch):
    """
    **Validates: Requirements 7.3**

    # Feature: stats-refactor, Property 3: Kanji grid endpoint returns valid shape

    For any valid request to /api/stats/kanji-grid (with or without start/end
    parameters, with any combination of seeded rollup data), the JSON response
    SHALL contain exactly the keys kanji_data (array), unique_count (integer),
    and max_frequency (integer), and unique_count SHALL equal the length of
    kanji_data.
    """
    seed_data, start_ts, end_ts = scenario
    _patch_heavy_deps(monkeypatch)
    _apply_scenario(seed_data)

    qs = _build_query_string(start_ts, end_ts)
    resp = client.get(f"/api/stats/kanji-grid{qs}")
    assert resp.status_code == 200

    data = resp.get_json()

    # Exactly the expected keys
    expected_keys = {"kanji_data", "unique_count", "max_frequency"}
    assert set(data.keys()) == expected_keys, (
        f"Expected keys {expected_keys}, got {set(data.keys())}"
    )

    # Type checks
    assert isinstance(data["kanji_data"], list), "kanji_data must be an array"
    assert isinstance(data["unique_count"], int), "unique_count must be an integer"
    assert isinstance(data["max_frequency"], int), "max_frequency must be an integer"

    # unique_count == len(kanji_data)
    assert data["unique_count"] == len(data["kanji_data"]), (
        f"unique_count ({data['unique_count']}) != len(kanji_data) ({len(data['kanji_data'])})"
    )


# ---------------------------------------------------------------------------
# Property 4: All-lines-data endpoint returns valid shape
# Feature: stats-refactor, Property 4: All-lines-data endpoint returns valid shape
# ---------------------------------------------------------------------------

_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(scenario=request_scenario())
def test_all_lines_data_endpoint_returns_valid_shape(scenario, client, monkeypatch):
    """
    **Validates: Requirements 6.3**

    # Feature: stats-refactor, Property 4: All-lines-data endpoint returns valid shape

    For any valid request to /api/stats/all-lines-data (with or without start/end
    parameters, with any combination of seeded rollup data), the JSON response
    SHALL be an array where every element contains the keys timestamp (number),
    date (string matching YYYY-MM-DD), characters (integer), and
    reading_time_seconds (number).
    """
    seed_data, start_ts, end_ts = scenario
    _patch_heavy_deps(monkeypatch)
    _apply_scenario(seed_data)

    qs = _build_query_string(start_ts, end_ts)
    resp = client.get(f"/api/stats/all-lines-data{qs}")
    assert resp.status_code == 200

    data = resp.get_json()

    # Must be an array
    assert isinstance(data, list), f"Expected array, got {type(data).__name__}"

    required_keys = {"timestamp", "date", "characters", "reading_time_seconds"}

    for i, item in enumerate(data):
        # All required keys present
        missing = required_keys - set(item.keys())
        assert not missing, f"Item {i} missing keys: {missing}. Got: {set(item.keys())}"

        # Type: timestamp is a number
        assert isinstance(item["timestamp"], (int, float)), (
            f"Item {i}: timestamp must be a number, got {type(item['timestamp']).__name__}"
        )

        # Type: date is a string matching YYYY-MM-DD
        assert isinstance(item["date"], str), (
            f"Item {i}: date must be a string, got {type(item['date']).__name__}"
        )
        assert _DATE_PATTERN.match(item["date"]), (
            f"Item {i}: date '{item['date']}' does not match YYYY-MM-DD"
        )

        # Type: characters is an integer
        assert isinstance(item["characters"], int), (
            f"Item {i}: characters must be an integer, got {type(item['characters']).__name__}"
        )

        # Type: reading_time_seconds is a number
        assert isinstance(item["reading_time_seconds"], (int, float)), (
            f"Item {i}: reading_time_seconds must be a number, got {type(item['reading_time_seconds']).__name__}"
        )
