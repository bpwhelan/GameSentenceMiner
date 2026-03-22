"""
Property-based tests for Anki combined endpoint partial failure resilience.

Feature: stats-endpoint-restructure
Property 3: Anki combined endpoint partial failure resilience

Validates: Requirements 3.3
"""

from __future__ import annotations

import types
from unittest.mock import MagicMock

import flask
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st


# ---------------------------------------------------------------------------
# The combined sub-function keys and their corresponding module-level function names
# ---------------------------------------------------------------------------

FETCH_FUNCTIONS = [
    ("earliest_date", "_fetch_earliest_date"),
    ("kanji_stats", "_fetch_kanji_stats"),
    ("game_stats", "_fetch_game_stats"),
    ("nsfw_sfw_retention", "_fetch_nsfw_sfw_retention"),
    ("mining_heatmap", "_fetch_anki_mining_heatmap"),
    ("reading_impact", "_fetch_anki_reading_impact"),
]

# Expected top-level keys in the combined response
EXPECTED_KEYS = {
    "kanji_stats",
    "game_stats",
    "nsfw_sfw_retention",
    "mining_heatmap",
    "earliest_date",
    "reading_impact",
}

# Sentinel return values for each sub-function when it succeeds
SUCCESS_RETURNS = {
    "_fetch_earliest_date": {"earliest_date": 1700000000},
    "_fetch_kanji_stats": {
        "missing_kanji": ["漢"],
        "anki_kanji_count": 5,
        "gsm_kanji_count": 10,
        "coverage_percent": 50.0,
    },
    "_fetch_game_stats": [{"game_name": "TestGame", "card_count": 42}],
    "_fetch_nsfw_sfw_retention": {
        "nsfw_retention": 80.0,
        "sfw_retention": 90.0,
        "nsfw_reviews": 100,
        "sfw_reviews": 200,
        "nsfw_avg_time": 5.0,
        "sfw_avg_time": 4.0,
    },
    "_fetch_anki_mining_heatmap": {"2024": {"2024-01-15": 3}},
    "_fetch_anki_reading_impact": {
        "labels": ["2024-01-01"],
        "reading_chars": [100],
        "cards_mined": [1],
    },
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _stub_heavy_modules(monkeypatch):
    """Prevent heavy imports (torch, Qt, etc.) from loading."""
    fake_anki_tables = types.ModuleType("GameSentenceMiner.util.database.anki_tables")
    fake_anki_tables.AnkiNotesTable = MagicMock()
    fake_anki_tables.AnkiCardsTable = MagicMock()
    fake_anki_tables.AnkiReviewsTable = MagicMock()
    monkeypatch.setitem(
        __import__("sys").modules,
        "GameSentenceMiner.util.database.anki_tables",
        fake_anki_tables,
    )


@pytest.fixture()
def anki_mod():
    """Import the module under test."""
    import GameSentenceMiner.web.anki_api_endpoints as mod

    return mod


@pytest.fixture()
def app_and_client(anki_mod):
    """Create a Flask test app with the Anki endpoints registered."""
    test_app = flask.Flask(__name__)
    test_app.config["TESTING"] = True
    anki_mod.register_anki_api_endpoints(test_app)
    return test_app, test_app.test_client()


# ---------------------------------------------------------------------------
# Hypothesis strategy: random subsets of the 5 sub-functions to fail
# ---------------------------------------------------------------------------

# Generate a subset of function names that should fail.
# This includes the empty set (nothing fails) and the full set (all fail).
_fail_subset_st = st.lists(
    st.sampled_from([fn_name for _, fn_name in FETCH_FUNCTIONS]),
    unique=True,
    min_size=0,
    max_size=len(FETCH_FUNCTIONS),
)


# ---------------------------------------------------------------------------
# Property 3: Anki combined endpoint partial failure resilience
# ---------------------------------------------------------------------------


@settings(max_examples=150, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(failing_fns=_fail_subset_st)
def test_anki_combined_partial_failure_resilience(failing_fns, anki_mod, app_and_client):
    """
    **Validates: Requirements 3.3**

    Property 3: Anki combined endpoint partial failure resilience

    For any subset of the sub-functions that raise exceptions, the
    combined endpoint returns a valid JSON response where failed sections
    contain empty defaults and successful sections contain their normal data.
    """
    app, client = app_and_client
    failing_set = set(failing_fns)

    # Patch each _fetch_* function: raise if in failing set, return sentinel otherwise
    patches = {}
    for _key, fn_name in FETCH_FUNCTIONS:
        if fn_name in failing_set:

            def make_raiser(name):
                def raiser(*args, **kwargs):
                    raise RuntimeError(f"Simulated failure in {name}")

                return raiser

            patches[fn_name] = make_raiser(fn_name)
        else:
            sentinel = SUCCESS_RETURNS[fn_name]

            def make_returner(val):
                def returner(*args, **kwargs):
                    return val

                return returner

            patches[fn_name] = make_returner(sentinel)

    # Apply patches
    originals = {}
    for fn_name, replacement in patches.items():
        originals[fn_name] = getattr(anki_mod, fn_name)
        setattr(anki_mod, fn_name, replacement)

    try:
        with app.test_request_context():
            resp = client.get("/api/anki_stats_combined")

        # Must always return 200 with valid JSON
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"
        data = resp.get_json()
        assert data is not None, "Response is not valid JSON"

        # Must contain all expected top-level keys
        assert set(data.keys()) == EXPECTED_KEYS, f"Expected keys {EXPECTED_KEYS}, got {set(data.keys())}"

        # Check each section based on whether its fetch function failed
        # earliest_date
        if "_fetch_earliest_date" in failing_set:
            # Failed: earliest_date should be the default (0)
            assert data["earliest_date"] == 0, f"earliest_date should be 0 on failure, got {data['earliest_date']}"
        else:
            assert data["earliest_date"] == 1700000000, (
                f"earliest_date should be 1700000000 on success, got {data['earliest_date']}"
            )

        # kanji_stats
        if "_fetch_kanji_stats" in failing_set:
            assert data["kanji_stats"] == {}, f"kanji_stats should be {{}} on failure, got {data['kanji_stats']}"
        else:
            assert data["kanji_stats"]["coverage_percent"] == 50.0

        # game_stats
        if "_fetch_game_stats" in failing_set:
            # Failed: game_stats gets {} from the except block, then
            # combined_response uses results.get("game_stats", []) which
            # returns {} (the stored value), not the default [].
            assert data["game_stats"] == {} or data["game_stats"] == [], (
                f"game_stats should be empty on failure, got {data['game_stats']}"
            )
        else:
            assert isinstance(data["game_stats"], list)
            assert data["game_stats"][0]["game_name"] == "TestGame"

        # nsfw_sfw_retention
        if "_fetch_nsfw_sfw_retention" in failing_set:
            assert data["nsfw_sfw_retention"] == {}, (
                f"nsfw_sfw_retention should be {{}} on failure, got {data['nsfw_sfw_retention']}"
            )
        else:
            assert data["nsfw_sfw_retention"]["nsfw_retention"] == 80.0

        # mining_heatmap
        if "_fetch_anki_mining_heatmap" in failing_set:
            assert data["mining_heatmap"] == {}, (
                f"mining_heatmap should be {{}} on failure, got {data['mining_heatmap']}"
            )
        else:
            assert data["mining_heatmap"] == {"2024": {"2024-01-15": 3}}

        # reading_impact
        if "_fetch_anki_reading_impact" in failing_set:
            assert data["reading_impact"] == {}, (
                f"reading_impact should be {{}} on failure, got {data['reading_impact']}"
            )
        else:
            assert data["reading_impact"]["labels"] == ["2024-01-01"]

    finally:
        # Restore originals
        for fn_name, original in originals.items():
            setattr(anki_mod, fn_name, original)
