"""
Property-based tests for Anki stats date filtering.

Feature: anki-stats-fixes
Property 1: Card date filtering uses note creation timestamp

Validates: Requirements 1.1, 1.2, 1.3
"""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass
from typing import Optional
from unittest.mock import MagicMock

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st


# ---------------------------------------------------------------------------
# Lightweight dataclasses that mimic the ORM rows
# ---------------------------------------------------------------------------


@dataclass
class FakeNote:
    note_id: int
    mod: Optional[int] = None
    tags: object = None
    fields_json: object = None


@dataclass
class FakeCard:
    card_id: int
    note_id: int


@dataclass
class FakeReview:
    card_id: int
    review_time: int
    ease: int
    time_taken: int


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _stub_heavy_modules(monkeypatch):
    """Prevent heavy imports from loading."""
    fake_anki_tables = types.ModuleType("GameSentenceMiner.util.database.anki_tables")
    fake_anki_tables.AnkiNotesTable = MagicMock()
    fake_anki_tables.AnkiCardsTable = MagicMock()
    fake_anki_tables.AnkiReviewsTable = MagicMock()
    monkeypatch.setitem(
        sys.modules,
        "GameSentenceMiner.util.database.anki_tables",
        fake_anki_tables,
    )


@pytest.fixture()
def anki_mod():
    """Import the module under test and reset internal caches."""
    import GameSentenceMiner.web.anki_api_endpoints as mod

    mod._anki_data_cache = None
    mod._anki_data_ts = 0.0
    return mod


def _make_anki_data(notes, cards, reviews):
    """Build the dict shape that _get_anki_data() returns."""
    notes_by_id = {n.note_id: n for n in notes}
    reviews_by_card: dict[int, list] = {}
    for r in reviews:
        reviews_by_card.setdefault(r.card_id, []).append(r)
    return {
        "notes_by_id": notes_by_id,
        "all_cards": cards,
        "reviews_by_card": reviews_by_card,
    }


def _stub_config(monkeypatch, anki_mod, parent_tag="Game"):
    """Stub get_config() to return a config with the given parent_tag."""
    cfg = MagicMock()
    cfg.anki.parent_tag = parent_tag
    monkeypatch.setattr(anki_mod, "get_config", lambda: cfg)


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------

# Timestamps in a realistic range (2020-01-01 to 2030-01-01 in ms)
MS_MIN = 1_577_836_800_000  # 2020-01-01 UTC in ms
MS_MAX = 1_893_456_000_000  # 2030-01-01 UTC in ms

# mod values in seconds (independent of note_id)
MOD_MIN = 1_577_836_800  # 2020-01-01 UTC in seconds
MOD_MAX = 1_893_456_000  # 2030-01-01 UTC in seconds

note_id_st = st.integers(min_value=MS_MIN, max_value=MS_MAX)
mod_st = st.integers(min_value=MOD_MIN, max_value=MOD_MAX)


@st.composite
def anki_scenario(draw):
    """Generate a random set of notes, cards, reviews, and a date range.

    Each note gets a unique note_id (ms) and an independent mod (seconds).
    Every note has a "Game::TestGame" tag so it passes the parent-tag filter.
    Each note gets exactly one card and one passing review (ease=2) so the
    card appears in game stats output.
    """
    num_notes = draw(st.integers(min_value=1, max_value=10))

    # Generate unique note_ids
    note_ids = draw(
        st.lists(note_id_st, min_size=num_notes, max_size=num_notes, unique=True)
    )

    notes = []
    cards = []
    reviews = []

    for i, nid in enumerate(note_ids):
        mod_val = draw(mod_st)
        notes.append(
            FakeNote(
                note_id=nid,
                mod=mod_val,
                tags=["Game::TestGame"],
                fields_json={"field1": "テスト"},
            )
        )
        card_id = i + 1
        cards.append(FakeCard(card_id=card_id, note_id=nid))
        # Review within the note's timestamp range so it's always counted
        reviews.append(
            FakeReview(
                card_id=card_id,
                review_time=nid,  # same as note_id so it's always in range
                ease=2,
                time_taken=5000,
            )
        )

    # Generate a date range — two random timestamps, sorted
    ts1 = draw(note_id_st)
    ts2 = draw(note_id_st)
    start_ms = min(ts1, ts2)
    end_ms = max(ts1, ts2)

    return notes, cards, reviews, start_ms, end_ms


# ---------------------------------------------------------------------------
# Property 1: Card date filtering uses note creation timestamp
# ---------------------------------------------------------------------------


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(scenario=anki_scenario())
def test_card_date_filtering_uses_note_creation_timestamp(
    scenario, anki_mod, monkeypatch
):
    """
    **Validates: Requirements 1.1, 1.2, 1.3**

    Property 1: Card date filtering uses note creation timestamp

    For any set of Anki notes with distinct note_id (creation ms) and mod
    (modification seconds) values, and for any date range [start_ms, end_ms],
    calling _fetch_game_stats(start_ms, end_ms) SHALL include a card if and
    only if start_ms <= note.note_id <= end_ms. A note whose mod * 1000 falls
    inside the range but whose note_id falls outside SHALL NOT be included.
    """
    notes, cards, reviews, start_ms, end_ms = scenario

    _stub_config(monkeypatch, anki_mod, parent_tag="Game")

    anki_data = _make_anki_data(notes, cards, reviews)
    monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
    monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: anki_data)

    result = anki_mod._fetch_game_stats(start_ms, end_ms)

    # Compute expected: notes whose note_id is within [start_ms, end_ms]
    expected_card_count = sum(1 for n in notes if start_ms <= n.note_id <= end_ms)

    # Result is a list of game stat dicts; sum up card_count across all games
    actual_card_count = sum(g["card_count"] for g in result)

    assert actual_card_count == expected_card_count, (
        f"Expected {expected_card_count} cards in range "
        f"[{start_ms}, {end_ms}], got {actual_card_count}. "
        f"note_ids={[n.note_id for n in notes]}, "
        f"mod_ms={[n.mod * 1000 for n in notes]}"
    )

    # Specifically verify: notes where mod*1000 is in range but note_id is NOT
    # in range must NOT contribute cards.
    for note in notes:
        mod_ms = note.mod * 1000
        note_in_range = start_ms <= note.note_id <= end_ms
        mod_in_range = start_ms <= mod_ms <= end_ms

        if mod_in_range and not note_in_range:
            # This note's card must NOT appear in results
            # (already covered by the count assertion above, but let's be explicit)
            assert actual_card_count < len(notes), (
                f"Note {note.note_id} has mod*1000={mod_ms} in range but "
                f"note_id={note.note_id} outside range — should be excluded"
            )


# ---------------------------------------------------------------------------
# Hypothesis strategies for Property 2
# ---------------------------------------------------------------------------

# A small pool of kanji characters to draw from
KANJI_POOL = list("漢字語学習日本読書食")


@st.composite
def kanji_note_scenario(draw):
    """Generate random notes with kanji in fields, plus a date range.

    Each note gets:
    - A unique note_id (ms timestamp, used for creation-time filtering)
    - An independent mod value (seconds, must NOT affect filtering)
    - Tags including "Game::SomeGame"
    - fields_json with kanji characters in the first field value
    """
    num_notes = draw(st.integers(min_value=1, max_value=10))

    note_ids = draw(
        st.lists(note_id_st, min_size=num_notes, max_size=num_notes, unique=True)
    )

    notes = []
    for nid in note_ids:
        mod_val = draw(mod_st)
        # Pick 1-3 kanji for this note's first field
        kanji_chars = draw(
            st.lists(st.sampled_from(KANJI_POOL), min_size=1, max_size=3, unique=True)
        )
        field_text = "".join(kanji_chars)
        notes.append(
            FakeNote(
                note_id=nid,
                mod=mod_val,
                tags=["Game::TestGame"],
                fields_json={"Expression": {"value": field_text}},
            )
        )

    # Generate a date range
    ts1 = draw(note_id_st)
    ts2 = draw(note_id_st)
    start_ms = min(ts1, ts2)
    end_ms = max(ts1, ts2)

    return notes, start_ms, end_ms


# ---------------------------------------------------------------------------
# Property 2: Kanji cache filtering uses note creation timestamp
# ---------------------------------------------------------------------------


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(scenario=kanji_note_scenario())
def test_kanji_cache_filtering_uses_note_creation_timestamp(
    scenario, anki_mod, monkeypatch
):
    """
    **Validates: Requirements 1.4**

    Property 2: Kanji cache filtering uses note creation timestamp

    For any set of Anki notes containing kanji in their first field, and for
    any date range [start_ms, end_ms], calling
    _get_anki_kanji_from_cache(start_ms, end_ms) SHALL return kanji only from
    notes where start_ms <= note.note_id <= end_ms. Notes whose mod * 1000
    falls inside the range but whose note_id falls outside SHALL NOT
    contribute kanji.
    """
    notes, start_ms, end_ms = scenario

    _stub_config(monkeypatch, anki_mod, parent_tag="Game")

    anki_data = _make_anki_data(notes, cards=[], reviews=[])
    monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
    monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: anki_data)

    result = anki_mod._get_anki_kanji_from_cache(start_ms, end_ms)

    # Compute expected kanji: union of kanji from notes whose note_id is in range
    from GameSentenceMiner.util.text_utils import is_kanji

    expected_kanji: set[str] = set()
    for note in notes:
        if start_ms <= note.note_id <= end_ms:
            fields = note.fields_json
            first_field = next(iter(fields.values()), None)
            if first_field and isinstance(first_field, dict) and "value" in first_field:
                for char in first_field["value"]:
                    if is_kanji(char):
                        expected_kanji.add(char)

    assert result == expected_kanji, (
        f"Expected kanji {expected_kanji}, got {result}. "
        f"Range=[{start_ms}, {end_ms}], "
        f"note_ids={[n.note_id for n in notes]}, "
        f"mod_ms={[n.mod * 1000 for n in notes]}"
    )

    # Explicitly verify: notes where mod*1000 is in range but note_id is NOT
    # must NOT contribute kanji.
    for note in notes:
        mod_ms = note.mod * 1000
        note_in_range = start_ms <= note.note_id <= end_ms
        mod_in_range = start_ms <= mod_ms <= end_ms

        if mod_in_range and not note_in_range:
            fields = note.fields_json
            first_field = next(iter(fields.values()), None)
            if first_field and isinstance(first_field, dict) and "value" in first_field:
                note_kanji = {c for c in first_field["value"] if is_kanji(c)}
                # These kanji should not appear in result UNLESS another
                # in-range note also contributed them
                in_range_kanji = set()
                for other in notes:
                    if other.note_id == note.note_id:
                        continue
                    if start_ms <= other.note_id <= end_ms:
                        of = other.fields_json
                        off = next(iter(of.values()), None)
                        if off and isinstance(off, dict) and "value" in off:
                            in_range_kanji.update(
                                c for c in off["value"] if is_kanji(c)
                            )
                leaked = note_kanji - in_range_kanji
                assert not (leaked & result), (
                    f"Note {note.note_id} has mod*1000={mod_ms} in range but "
                    f"note_id outside range — kanji {leaked & result} should "
                    f"not appear in result"
                )


# ---------------------------------------------------------------------------
# Hypothesis strategies for Property 3
# ---------------------------------------------------------------------------


@st.composite
def earliest_date_scenario(draw):
    """Generate random tagged notes with varying note_id and mod values.

    Each note gets:
    - A unique note_id (ms timestamp, used for creation-time filtering)
    - An independent mod value (seconds, must NOT affect the result)
    - Tags including "Game::SomeGame" so they pass the parent-tag filter
    """
    num_notes = draw(st.integers(min_value=1, max_value=10))

    note_ids = draw(
        st.lists(note_id_st, min_size=num_notes, max_size=num_notes, unique=True)
    )

    notes = []
    for nid in note_ids:
        mod_val = draw(mod_st)
        notes.append(
            FakeNote(
                note_id=nid,
                mod=mod_val,
                tags=["Game::TestGame"],
                fields_json={"field1": "テスト"},
            )
        )

    return notes


# ---------------------------------------------------------------------------
# Property 3: Earliest date uses note creation timestamp
# ---------------------------------------------------------------------------


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(scenario=earliest_date_scenario())
def test_earliest_date_uses_note_creation_timestamp(scenario, anki_mod, monkeypatch):
    """
    **Validates: Requirements 1.5**

    Property 3: Earliest date uses note creation timestamp

    For any non-empty set of tagged Anki notes, _fetch_earliest_date() SHALL
    return min(note.note_id) / 1000 (converted to seconds). The result SHALL
    NOT depend on note.mod values.
    """
    notes = scenario

    _stub_config(monkeypatch, anki_mod, parent_tag="Game")

    anki_data = _make_anki_data(notes, cards=[], reviews=[])
    monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
    monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: anki_data)

    result = anki_mod._fetch_earliest_date(None, None)

    expected_earliest_sec = min(n.note_id for n in notes) / 1000

    assert result["earliest_date"] == expected_earliest_sec, (
        f"Expected earliest_date={expected_earliest_sec}, "
        f"got {result['earliest_date']}. "
        f"note_ids={[n.note_id for n in notes]}, "
        f"mods={[n.mod for n in notes]}"
    )
