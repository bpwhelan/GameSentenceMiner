"""
Deep logic tests for the Anki API endpoints in anki_api_endpoints.py.

Covers:
- _get_note_fields / _get_note_tags helper edge cases
- _fetch_earliest_date with mock tagged notes
- _fetch_game_stats with mock notes, cards, reviews
- _fetch_nsfw_sfw_retention classification and retention math
- _get_anki_kanji_from_cache extraction logic
- invalidate_anki_data_cache / _is_cache_empty behaviour
- _fetch_anki_mining_heatmap delegation
"""

from __future__ import annotations

import json
import sys
import time as _time
import types
import datetime
from dataclasses import dataclass, field
from typing import Optional
from unittest.mock import MagicMock, patch

import flask
import pytest


# ---------------------------------------------------------------------------
# Lightweight dataclasses that mimic the ORM rows
# ---------------------------------------------------------------------------


@dataclass
class FakeNote:
    note_id: int
    mod: Optional[int] = None
    tags: object = None  # list[str] | str | None
    fields_json: object = None  # dict | str | None


@dataclass
class FakeCard:
    card_id: int
    note_id: int


@dataclass
class FakeReview:
    card_id: int
    review_time: int  # ms
    ease: int  # 1 = fail, 2-4 = pass
    time_taken: int  # ms


@dataclass
class FakeRollup:
    date: str
    total_characters: int = 0
    total_reading_time_seconds: float = 0.0
    anki_cards_created: int = 0
    game_activity_data: object = field(default_factory=dict)


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

    # Reset the shared data cache between tests
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


def _stub_config(monkeypatch, anki_mod, parent_tag="Game", word_field="Word"):
    """Stub get_config() to return a config with the given parent_tag."""
    cfg = MagicMock()
    cfg.anki.parent_tag = parent_tag
    cfg.anki.word_field = word_field
    monkeypatch.setattr(anki_mod, "get_config", lambda: cfg)


# ===================================================================
# _get_note_fields
# ===================================================================


class TestGetNoteFields:
    """Tests for _get_note_fields helper."""

    def test_dict_passthrough(self, anki_mod):
        note = FakeNote(note_id=1, fields_json={"Word": {"value": "猫"}})
        assert anki_mod._get_note_fields(note) == {"Word": {"value": "猫"}}

    def test_json_string(self, anki_mod):
        note = FakeNote(note_id=1, fields_json='{"Word": {"value": "犬"}}')
        assert anki_mod._get_note_fields(note) == {"Word": {"value": "犬"}}

    def test_invalid_json_string(self, anki_mod):
        note = FakeNote(note_id=1, fields_json="not json")
        assert anki_mod._get_note_fields(note) == {}

    def test_none_fields_json(self, anki_mod):
        note = FakeNote(note_id=1, fields_json=None)
        assert anki_mod._get_note_fields(note) == {}

    def test_numeric_fields_json(self, anki_mod):
        note = FakeNote(note_id=1, fields_json=42)
        assert anki_mod._get_note_fields(note) == {}

    def test_empty_dict(self, anki_mod):
        note = FakeNote(note_id=1, fields_json={})
        assert anki_mod._get_note_fields(note) == {}

    def test_empty_string(self, anki_mod):
        note = FakeNote(note_id=1, fields_json="")
        assert anki_mod._get_note_fields(note) == {}


# ===================================================================
# _get_note_tags
# ===================================================================


class TestGetNoteTags:
    """Tests for _get_note_tags helper."""

    def test_list_passthrough(self, anki_mod):
        note = FakeNote(note_id=1, tags=["Game::FF7", "NSFW"])
        assert anki_mod._get_note_tags(note) == ["Game::FF7", "NSFW"]

    def test_json_string(self, anki_mod):
        note = FakeNote(note_id=1, tags='["Game::FF7"]')
        assert anki_mod._get_note_tags(note) == ["Game::FF7"]

    def test_invalid_json_string(self, anki_mod):
        note = FakeNote(note_id=1, tags="not json")
        assert anki_mod._get_note_tags(note) == []

    def test_none_tags(self, anki_mod):
        note = FakeNote(note_id=1, tags=None)
        assert anki_mod._get_note_tags(note) == []

    def test_numeric_tags(self, anki_mod):
        note = FakeNote(note_id=1, tags=42)
        assert anki_mod._get_note_tags(note) == []

    def test_empty_list(self, anki_mod):
        note = FakeNote(note_id=1, tags=[])
        assert anki_mod._get_note_tags(note) == []

    def test_empty_json_array(self, anki_mod):
        note = FakeNote(note_id=1, tags="[]")
        assert anki_mod._get_note_tags(note) == []


# ===================================================================
# _fetch_earliest_date
# ===================================================================


class TestFetchEarliestDate:
    """Tests for _fetch_earliest_date logic."""

    def test_cache_empty_returns_zero(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: True)
        result = anki_mod._fetch_earliest_date(None, None)
        assert result["earliest_date"] == 0
        assert result.get("cache_empty") is True

    def test_no_tagged_notes_returns_zero(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [FakeNote(note_id=1700000000000, tags=["Vocab"], mod=9999999)]
        data = _make_anki_data(notes, [], [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_earliest_date(None, None)
        assert result["earliest_date"] == 0

    def test_finds_earliest_among_tagged(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        # note_id is creation timestamp in ms; result = min(note_id) / 1000
        notes = [
            FakeNote(note_id=1700000000000, tags=["Game::FF7"], mod=9999999),
            FakeNote(note_id=1600000000000, tags=["Game::Persona5"], mod=9999999),
            FakeNote(
                note_id=1500000000000, tags=["Vocab"], mod=9999999
            ),  # not Game-tagged
        ]
        data = _make_anki_data(notes, [], [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_earliest_date(None, None)
        # min(note_id) among tagged = 1600000000000 → / 1000 = 1600000000
        assert result["earliest_date"] == 1600000000

    def test_note_with_no_mod_is_skipped(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        # note_id is always set (it's the primary key), so both notes are considered
        # The earliest note_id among tagged notes wins
        notes = [
            FakeNote(note_id=1600000000000, tags=["Game::FF7"], mod=None),
            FakeNote(note_id=1700000000000, tags=["Game::Persona5"], mod=None),
        ]
        data = _make_anki_data(notes, [], [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_earliest_date(None, None)
        # min(note_id) = 1600000000000 → / 1000 = 1600000000
        assert result["earliest_date"] == 1600000000

    def test_custom_parent_tag(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Mining")

        notes = [
            FakeNote(note_id=1700000000000, tags=["Mining::FF7"], mod=9999999),
            FakeNote(note_id=1600000000000, tags=["Game::Persona5"], mod=9999999),
        ]
        data = _make_anki_data(notes, [], [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_earliest_date(None, None)
        # Only note 1 matches Mining::, note 2 is Game:: (not matching)
        # min(note_id) = 1700000000000 → / 1000 = 1700000000
        assert result["earliest_date"] == 1700000000


# ===================================================================
# _fetch_game_stats
# ===================================================================


class TestFetchGameStats:
    """Tests for _fetch_game_stats logic."""

    def test_cache_empty_returns_empty_list(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: True)
        result = anki_mod._fetch_game_stats(None, None)
        assert result == []

    def test_no_cards_returns_empty_list(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [FakeNote(note_id=1, tags=["Game::FF7"], mod=1700000000)]
        data = _make_anki_data(notes, [], [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_game_stats(None, None)
        assert result == []

    def test_single_game_perfect_retention(self, anki_mod, monkeypatch):
        """All reviews pass (ease > 1) → 100% retention."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [FakeNote(note_id=1, tags=["Game::FF7"], mod=1700000000)]
        cards = [FakeCard(card_id=100, note_id=1)]
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=5000),
            FakeReview(card_id=100, review_time=1700000002000, ease=4, time_taken=3000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_game_stats(None, None)
        assert len(result) == 1
        assert result[0]["game_name"] == "FF7"
        assert result[0]["retention_pct"] == 100.0
        assert result[0]["card_count"] == 1
        assert result[0]["total_reviews"] == 2
        assert result[0]["avg_time_per_card"] == 4.0  # (5000+3000)/2/1000

    def test_single_game_50_percent_retention(self, anki_mod, monkeypatch):
        """One pass, one fail → 50% retention."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [FakeNote(note_id=1, tags=["Game::FF7"], mod=1700000000)]
        cards = [FakeCard(card_id=100, note_id=1)]
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=5000),
            FakeReview(card_id=100, review_time=1700000002000, ease=1, time_taken=3000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_game_stats(None, None)
        assert result[0]["retention_pct"] == 50.0

    def test_multiple_games_sorted_by_name(self, anki_mod, monkeypatch):
        """Results are sorted alphabetically by game_name."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [
            FakeNote(note_id=1, tags=["Game::Zelda"], mod=1700000000),
            FakeNote(note_id=2, tags=["Game::Persona"], mod=1700000000),
        ]
        cards = [
            FakeCard(card_id=100, note_id=1),
            FakeCard(card_id=200, note_id=2),
        ]
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=5000),
            FakeReview(card_id=200, review_time=1700000001000, ease=3, time_taken=5000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_game_stats(None, None)
        assert len(result) == 2
        assert result[0]["game_name"] == "Persona"
        assert result[1]["game_name"] == "Zelda"

    def test_cards_without_matching_note_ignored(self, anki_mod, monkeypatch):
        """Cards whose note_id doesn't exist in notes_by_id are skipped."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [FakeNote(note_id=1, tags=["Game::FF7"], mod=1700000000)]
        cards = [
            FakeCard(card_id=100, note_id=1),
            FakeCard(card_id=200, note_id=999),  # no matching note
        ]
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=5000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_game_stats(None, None)
        assert len(result) == 1
        assert result[0]["game_name"] == "FF7"

    def test_cards_without_game_tag_not_grouped(self, anki_mod, monkeypatch):
        """Cards tagged with parent but no :: sub-tag are skipped."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [FakeNote(note_id=1, tags=["Game"], mod=1700000000)]
        cards = [FakeCard(card_id=100, note_id=1)]
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=5000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_game_stats(None, None)
        assert result == []

    def test_timestamp_filtering(self, anki_mod, monkeypatch):
        """When start/end timestamps are provided, only matching cards are included."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        # note_id is creation timestamp in ms — filtering compares note.note_id directly
        notes = [
            FakeNote(note_id=1700000000, tags=["Game::FF7"], mod=9999999),
            FakeNote(
                note_id=1500000000, tags=["Game::Persona"], mod=9999999
            ),  # too old
        ]
        cards = [
            FakeCard(card_id=100, note_id=1700000000),
            FakeCard(card_id=200, note_id=1500000000),
        ]
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=5000),
            FakeReview(card_id=200, review_time=1700000001000, ease=3, time_taken=5000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        # note 1: note_id=1700000000 → inside range
        # note 2: note_id=1500000000 → outside range
        # mod values are irrelevant for filtering
        start_ts = 1600000000
        end_ts = 1800000000

        result = anki_mod._fetch_game_stats(start_ts, end_ts)
        assert len(result) == 1
        assert result[0]["game_name"] == "FF7"

    def test_game_with_no_reviews(self, anki_mod, monkeypatch):
        """A game with cards but no reviews still appears with zero stats."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [FakeNote(note_id=1, tags=["Game::FF7"], mod=1700000000)]
        cards = [FakeCard(card_id=100, note_id=1)]
        data = _make_anki_data(notes, cards, [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_game_stats(None, None)
        assert len(result) == 1
        assert result[0]["retention_pct"] == 0
        assert result[0]["total_reviews"] == 0
        assert result[0]["avg_time_per_card"] == 0

    def test_multiple_notes_per_game_retention_averaged(self, anki_mod, monkeypatch):
        """Retention is averaged per-note, not per-review."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        # Note 1: 2 pass, 0 fail → 100% retention
        # Note 2: 0 pass, 2 fail → 0% retention
        # Average: (100 + 0) / 2 = 50%
        notes = [
            FakeNote(note_id=1, tags=["Game::FF7"], mod=1700000000),
            FakeNote(note_id=2, tags=["Game::FF7"], mod=1700000000),
        ]
        cards = [
            FakeCard(card_id=100, note_id=1),
            FakeCard(card_id=200, note_id=2),
        ]
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=5000),
            FakeReview(card_id=100, review_time=1700000002000, ease=4, time_taken=3000),
            FakeReview(card_id=200, review_time=1700000001000, ease=1, time_taken=5000),
            FakeReview(card_id=200, review_time=1700000002000, ease=1, time_taken=3000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_game_stats(None, None)
        assert result[0]["retention_pct"] == 50.0

    def test_review_timestamp_filtering(self, anki_mod, monkeypatch):
        """When timestamps are set, reviews outside the range are excluded."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        # note_id must be inside the timestamp range for the card to be included
        notes = [FakeNote(note_id=1700000, tags=["Game::FF7"], mod=9999)]
        cards = [FakeCard(card_id=100, note_id=1700000)]
        reviews = [
            # In range:
            FakeReview(card_id=100, review_time=1700001, ease=3, time_taken=5000),
            # Out of range:
            FakeReview(card_id=100, review_time=1900001, ease=1, time_taken=5000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_game_stats(1600000, 1800000)
        assert len(result) == 1
        # Only the in-range review (ease=3) counts
        assert result[0]["retention_pct"] == 100.0
        assert result[0]["total_reviews"] == 1


# ===================================================================
# _fetch_nsfw_sfw_retention
# ===================================================================


class TestFetchNsfwSfwRetention:
    """Tests for _fetch_nsfw_sfw_retention classification and math."""

    def test_cache_empty(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: True)
        result = anki_mod._fetch_nsfw_sfw_retention(None, None)
        assert result["nsfw_retention"] == 0
        assert result["sfw_retention"] == 0
        assert result.get("cache_empty") is True

    def test_nsfw_classification(self, anki_mod, monkeypatch):
        """Notes with 'NSFW' tag are classified as NSFW, others as SFW."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [
            FakeNote(note_id=1, tags=["Game::FF7", "NSFW"], mod=1700000000),
            FakeNote(note_id=2, tags=["Game::Persona"], mod=1700000000),
        ]
        cards = [
            FakeCard(card_id=100, note_id=1),
            FakeCard(card_id=200, note_id=2),
        ]
        # NSFW card: all pass → 100%
        # SFW card: all fail → 0%
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=5000),
            FakeReview(card_id=200, review_time=1700000001000, ease=1, time_taken=5000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_nsfw_sfw_retention(None, None)
        assert result["nsfw_retention"] == 100.0
        assert result["sfw_retention"] == 0.0
        assert result["nsfw_reviews"] == 1
        assert result["sfw_reviews"] == 1

    def test_notes_without_parent_tag_excluded(self, anki_mod, monkeypatch):
        """Notes that don't have the parent tag at all are excluded from both categories."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [
            FakeNote(note_id=1, tags=["Vocab"], mod=1700000000),  # no Game tag
        ]
        cards = [FakeCard(card_id=100, note_id=1)]
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=5000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_nsfw_sfw_retention(None, None)
        assert result["nsfw_retention"] == 0
        assert result["sfw_retention"] == 0
        assert result["nsfw_reviews"] == 0
        assert result["sfw_reviews"] == 0

    def test_avg_time_calculation(self, anki_mod, monkeypatch):
        """avg_time is total_time / total_reviews / 1000 (ms → seconds)."""
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [FakeNote(note_id=1, tags=["Game::FF7"], mod=1700000000)]
        cards = [FakeCard(card_id=100, note_id=1)]
        reviews = [
            FakeReview(card_id=100, review_time=1700000001000, ease=3, time_taken=6000),
            FakeReview(card_id=100, review_time=1700000002000, ease=4, time_taken=4000),
        ]
        data = _make_anki_data(notes, cards, reviews)
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._fetch_nsfw_sfw_retention(None, None)
        # SFW (no NSFW tag): total_time=10000ms, total_reviews=2 → 10000/2/1000=5.0s
        assert result["sfw_avg_time"] == 5.0


# ===================================================================
# _get_anki_kanji_from_cache
# ===================================================================


class TestGetAnkiKanjiFromCache:
    """Tests for _get_anki_kanji_from_cache extraction logic."""

    def test_cache_empty_returns_empty_set(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: True)
        assert anki_mod._get_anki_kanji_from_cache() == set()

    def test_extracts_kanji_from_first_field(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [
            FakeNote(
                note_id=1,
                tags=["Game::FF7"],
                mod=1700000000,
                fields_json={"Word": {"value": "漢字テスト"}},
            ),
        ]
        data = _make_anki_data(notes, [], [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._get_anki_kanji_from_cache()
        assert "漢" in result
        assert "字" in result
        # Non-kanji characters should not be included
        assert "テ" not in result

    def test_notes_without_parent_tag_excluded(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [
            FakeNote(
                note_id=1,
                tags=["Vocab"],
                mod=1700000000,
                fields_json={"Word": {"value": "漢字"}},
            ),
        ]
        data = _make_anki_data(notes, [], [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._get_anki_kanji_from_cache()
        assert result == set()

    def test_timestamp_filtering(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        # note_id is creation timestamp in ms — filtering compares note.note_id directly
        notes = [
            FakeNote(
                note_id=1700000,
                tags=["Game::FF7"],
                mod=9999,  # mod is irrelevant for filtering
                fields_json={"Word": {"value": "漢"}},
            ),
            FakeNote(
                note_id=1500000,
                tags=["Game::Persona"],
                mod=9999,  # mod is irrelevant for filtering
                fields_json={"Word": {"value": "字"}},
            ),
        ]
        data = _make_anki_data(notes, [], [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._get_anki_kanji_from_cache(
            start_timestamp=1600000, end_timestamp=1800000
        )
        assert "漢" in result
        assert "字" not in result

    def test_multiple_notes_kanji_merged(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")

        notes = [
            FakeNote(
                note_id=1,
                tags=["Game::FF7"],
                mod=1700000000,
                fields_json={"Word": {"value": "漢字"}},
            ),
            FakeNote(
                note_id=2,
                tags=["Game::Persona"],
                mod=1700000000,
                fields_json={"Word": {"value": "字体"}},
            ),
        ]
        data = _make_anki_data(notes, [], [])
        monkeypatch.setattr(anki_mod, "_get_anki_data", lambda: data)

        result = anki_mod._get_anki_kanji_from_cache()
        assert result == {"漢", "字", "体"}

    def test_exception_returns_empty_set(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: False)
        _stub_config(monkeypatch, anki_mod, "Game")
        monkeypatch.setattr(
            anki_mod,
            "_get_anki_data",
            lambda: (_ for _ in ()).throw(RuntimeError("boom")),
        )

        result = anki_mod._get_anki_kanji_from_cache()
        assert result == set()


# ===================================================================
# invalidate_anki_data_cache / _is_cache_empty
# ===================================================================


class TestCacheManagement:
    """Tests for cache invalidation."""

    def test_invalidate_clears_cache(self, anki_mod):
        # Manually set cache to something
        anki_mod._anki_data_cache = {"some": "data"}
        anki_mod._anki_data_ts = _time.monotonic()

        anki_mod.invalidate_anki_data_cache()

        assert anki_mod._anki_data_cache is None
        assert anki_mod._anki_data_ts == 0.0

    def test_is_cache_empty_when_no_notes(self, anki_mod, monkeypatch):
        """_is_cache_empty returns True when AnkiNotesTable.one() is None."""
        from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable

        AnkiNotesTable.one.return_value = None
        assert anki_mod._is_cache_empty() is True

    def test_is_cache_empty_when_notes_exist(self, anki_mod, monkeypatch):
        """_is_cache_empty returns False when notes exist."""
        from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable

        AnkiNotesTable.one.return_value = MagicMock()
        assert anki_mod._is_cache_empty() is False

    def test_is_cache_empty_on_exception(self, anki_mod, monkeypatch):
        """_is_cache_empty returns True on exception."""
        from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable

        AnkiNotesTable.one.side_effect = RuntimeError("DB error")
        assert anki_mod._is_cache_empty() is True


# ===================================================================
# _fetch_anki_mining_heatmap
# ===================================================================


class TestFetchMiningHeatmap:
    """Tests for _fetch_anki_mining_heatmap delegation."""

    def test_delegates_to_calculate_mining_heatmap_data(self, anki_mod, monkeypatch):
        sentinel = {"2024": {"2024-01-15": 3}}
        monkeypatch.setattr(
            anki_mod,
            "GameLinesTable",
            MagicMock(all=MagicMock(return_value=["line1", "line2"])),
        )
        monkeypatch.setattr(
            anki_mod, "calculate_mining_heatmap_data", lambda lines: sentinel
        )

        result = anki_mod._fetch_anki_mining_heatmap(None, None)
        assert result == sentinel

    def test_with_timestamp_uses_filtered_query(self, anki_mod, monkeypatch):
        mock_table = MagicMock()
        mock_table.get_lines_filtered_by_timestamp.return_value = ["line1"]
        monkeypatch.setattr(anki_mod, "GameLinesTable", mock_table)
        monkeypatch.setattr(
            anki_mod, "calculate_mining_heatmap_data", lambda lines: {"result": True}
        )

        # Timestamps in ms
        result = anki_mod._fetch_anki_mining_heatmap(1000000, 2000000)
        assert result == {"result": True}
        mock_table.get_lines_filtered_by_timestamp.assert_called_once_with(
            start=1000.0, end=2000.0, for_stats=True
        )

    def test_exception_returns_empty_dict(self, anki_mod, monkeypatch):
        monkeypatch.setattr(
            anki_mod,
            "GameLinesTable",
            MagicMock(all=MagicMock(side_effect=RuntimeError("boom"))),
        )
        monkeypatch.setattr(
            anki_mod,
            "calculate_mining_heatmap_data",
            MagicMock(side_effect=RuntimeError("boom")),
        )

        result = anki_mod._fetch_anki_mining_heatmap(None, None)
        assert result == {}


# ===================================================================
# Route-level integration: combined endpoint
# ===================================================================


class TestCombinedEndpointIntegration:
    """Integration tests for /api/anki_stats_combined using real-ish mock data."""

    @pytest.fixture()
    def app_and_client(self, anki_mod):
        test_app = flask.Flask(__name__)
        test_app.config["TESTING"] = True
        anki_mod.register_anki_api_endpoints(test_app)
        return test_app, test_app.test_client()

    def test_all_sections_present(self, app_and_client, anki_mod, monkeypatch):
        """Verify all expected top-level keys in combined response."""
        # Stub all fetch functions to return minimal data
        monkeypatch.setattr(
            anki_mod, "_fetch_earliest_date", lambda s, e: {"earliest_date": 42}
        )
        monkeypatch.setattr(anki_mod, "_fetch_kanji_stats", lambda s, e: {"k": 1})
        monkeypatch.setattr(anki_mod, "_fetch_game_stats", lambda s, e: [])
        monkeypatch.setattr(
            anki_mod, "_fetch_nsfw_sfw_retention", lambda s, e: {"n": 1}
        )
        monkeypatch.setattr(
            anki_mod, "_fetch_anki_mining_heatmap", lambda s, e: {"h": 1}
        )
        monkeypatch.setattr(
            anki_mod, "_fetch_anki_reading_impact", lambda s, e, lag_weeks=3: {"r": 1}
        )

        app, client = app_and_client
        resp = client.get("/api/anki_stats_combined")
        assert resp.status_code == 200
        data = resp.get_json()
        expected_keys = {
            "kanji_stats",
            "game_stats",
            "nsfw_sfw_retention",
            "mining_heatmap",
            "earliest_date",
            "reading_impact",
        }
        assert set(data.keys()) == expected_keys

    def test_earliest_date_extracted_from_nested_dict(
        self, app_and_client, anki_mod, monkeypatch
    ):
        """earliest_date should be the value, not the dict wrapper."""
        monkeypatch.setattr(
            anki_mod, "_fetch_earliest_date", lambda s, e: {"earliest_date": 1700000000}
        )
        monkeypatch.setattr(anki_mod, "_fetch_kanji_stats", lambda s, e: {})
        monkeypatch.setattr(anki_mod, "_fetch_game_stats", lambda s, e: [])
        monkeypatch.setattr(anki_mod, "_fetch_nsfw_sfw_retention", lambda s, e: {})
        monkeypatch.setattr(anki_mod, "_fetch_anki_mining_heatmap", lambda s, e: {})
        monkeypatch.setattr(
            anki_mod,
            "_fetch_anki_reading_impact",
            lambda s, e, lag_weeks=3, **kwargs: {},
        )

        app, client = app_and_client
        resp = client.get("/api/anki_stats_combined")
        data = resp.get_json()
        assert data["earliest_date"] == 1700000000

    def test_timestamp_params_forwarded(self, app_and_client, anki_mod, monkeypatch):
        """Query params start_timestamp and end_timestamp are forwarded to sub-functions."""
        captured = {}

        def capture_fn(name):
            def fn(start, end):
                captured[name] = (start, end)
                if name == "_fetch_game_stats":
                    return []
                if name == "_fetch_earliest_date":
                    return {"earliest_date": 0}
                return {}

            return fn

        monkeypatch.setattr(
            anki_mod, "_fetch_earliest_date", capture_fn("_fetch_earliest_date")
        )
        monkeypatch.setattr(
            anki_mod, "_fetch_kanji_stats", capture_fn("_fetch_kanji_stats")
        )
        monkeypatch.setattr(
            anki_mod, "_fetch_game_stats", capture_fn("_fetch_game_stats")
        )
        monkeypatch.setattr(
            anki_mod,
            "_fetch_nsfw_sfw_retention",
            capture_fn("_fetch_nsfw_sfw_retention"),
        )
        monkeypatch.setattr(
            anki_mod,
            "_fetch_anki_mining_heatmap",
            capture_fn("_fetch_anki_mining_heatmap"),
        )

        def capture_reading_impact(start, end, lag_weeks=3, **kwargs):
            captured["_fetch_anki_reading_impact"] = (start, end, lag_weeks, kwargs)
            return {}

        monkeypatch.setattr(
            anki_mod,
            "_fetch_anki_reading_impact",
            capture_reading_impact,
        )

        app, client = app_and_client
        resp = client.get(
            "/api/anki_stats_combined?start_timestamp=1000&end_timestamp=2000"
        )
        assert resp.status_code == 200
        for name, values in captured.items():
            assert values[0] == 1000, f"{name} got wrong start_timestamp"
            assert values[1] == 2000, f"{name} got wrong end_timestamp"
        assert captured["_fetch_anki_reading_impact"][3] == {
            "include_lagged_pairs": False,
            "include_per_game": False,
        }

    def test_sections_query_param_limits_work_to_requested_sections(
        self, app_and_client, anki_mod, monkeypatch
    ):
        called: list[str] = []

        monkeypatch.setattr(
            anki_mod,
            "_fetch_earliest_date",
            lambda s, e: called.append("earliest_date") or {"earliest_date": 42},
        )
        monkeypatch.setattr(
            anki_mod,
            "_fetch_kanji_stats",
            lambda s, e: called.append("kanji_stats") or {"k": 1},
        )
        monkeypatch.setattr(
            anki_mod,
            "_fetch_game_stats",
            lambda s, e: called.append("game_stats") or [],
        )
        monkeypatch.setattr(
            anki_mod,
            "_fetch_nsfw_sfw_retention",
            lambda s, e: called.append("nsfw_sfw_retention") or {"n": 1},
        )
        monkeypatch.setattr(
            anki_mod,
            "_fetch_anki_mining_heatmap",
            lambda s, e: called.append("mining_heatmap") or {"h": 1},
        )
        monkeypatch.setattr(
            anki_mod,
            "_fetch_anki_reading_impact",
            lambda s, e, lag_weeks=3, **kwargs: (
                called.append("reading_impact") or {"r": 1}
            ),
        )

        app, client = app_and_client
        resp = client.get(
            "/api/anki_stats_combined?sections=kanji_stats,reading_impact"
        )
        assert resp.status_code == 200
        data = resp.get_json()

        assert set(data.keys()) == {"kanji_stats", "reading_impact"}
        assert called == ["kanji_stats", "reading_impact"]


class TestReadingImpactEndpoint:
    """Tests for /api/anki-reading-impact."""

    @pytest.fixture()
    def app_and_client(self, anki_mod):
        test_app = flask.Flask(__name__)
        test_app.config["TESTING"] = True
        anki_mod.register_anki_api_endpoints(test_app)
        return test_app, test_app.test_client()

    def test_returns_weekly_series_and_lagged_pairs(
        self, app_and_client, anki_mod, monkeypatch
    ):
        rollups = [
            FakeRollup(
                date="2024-01-02",
                total_characters=1000,
                total_reading_time_seconds=3600,
                anki_cards_created=2,
                game_activity_data={
                    "ff7": {"title": "FF7", "chars": 1000, "time": 3600, "lines": 10}
                },
            ),
            FakeRollup(
                date="2024-01-09",
                total_characters=500,
                total_reading_time_seconds=1800,
                anki_cards_created=1,
                game_activity_data={
                    "ff7": {"title": "FF7", "chars": 500, "time": 1800, "lines": 5}
                },
            ),
        ]

        fake_tokenisation = types.ModuleType("GameSentenceMiner.web.tokenisation_api")
        fake_tokenisation.is_tokenisation_enabled = lambda: True
        fake_tokenisation._get_db = lambda: object()
        fake_tokenisation._get_first_mature_word_dates = lambda db: {
            "猫": datetime.date(2024, 1, 22),
            "犬": datetime.date(2024, 1, 29),
        }
        fake_tokenisation._get_first_mature_kanji_dates = lambda db: {
            1: datetime.date(2024, 1, 22)
        }
        monkeypatch.setitem(
            sys.modules,
            "GameSentenceMiner.web.tokenisation_api",
            fake_tokenisation,
        )

        mock_rollup_table = MagicMock()
        mock_rollup_table.get_date_range.return_value = rollups
        monkeypatch.setattr(anki_mod, "StatsRollupTable", mock_rollup_table)
        monkeypatch.setattr(
            anki_mod,
            "_fetch_game_stats",
            lambda start, end: [
                {
                    "game_name": "FF7",
                    "card_count": 3,
                    "avg_time_per_card": 5.5,
                    "retention_pct": 82.5,
                    "total_reviews": 12,
                }
            ],
        )

        start_ts = int(datetime.datetime(2024, 1, 1).timestamp() * 1000)
        end_ts = int(datetime.datetime(2024, 1, 31, 23, 59, 59).timestamp() * 1000)

        app, client = app_and_client
        resp = client.get(
            f"/api/anki-reading-impact?start_timestamp={start_ts}&end_timestamp={end_ts}"
        )
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["tokenisation_enabled"] is True
        assert data["labels"] == [
            "2024-01-01",
            "2024-01-08",
            "2024-01-15",
            "2024-01-22",
            "2024-01-29",
        ]
        assert data["reading_chars"] == [1000, 500, 0, 0, 0]
        assert data["reading_hours"] == [1.0, 0.5, 0.0, 0.0, 0.0]
        assert data["cards_mined"] == [2, 1, 0, 0, 0]
        assert data["mature_words"] == [0, 0, 0, 1, 1]
        assert data["mature_kanji"] == [0, 0, 0, 1, 0]
        assert data["lagged_mature_words"] == [1, 1, None, None, None]
        assert data["lagged_mature_kanji"] == [1, 0, None, None, None]
        assert data["lagged_pairs"] == [
            {
                "source_label": "2024-01-01",
                "target_label": "2024-01-22",
                "reading_chars": 1000,
                "reading_hours": 1.0,
                "cards_mined": 2,
                "mature_words": 1,
                "mature_kanji": 1,
            },
            {
                "source_label": "2024-01-08",
                "target_label": "2024-01-29",
                "reading_chars": 500,
                "reading_hours": 0.5,
                "cards_mined": 1,
                "mature_words": 1,
                "mature_kanji": 0,
            },
        ]
        assert data["per_game"] == [
            {
                "game_name": "FF7",
                "reading_chars": 1500,
                "reading_hours": 1.5,
                "card_count": 3,
                "retention_pct": 82.5,
                "avg_time_per_card": 5.5,
                "total_reviews": 12,
            }
        ]

    def test_returns_empty_maturity_when_tokenisation_disabled(
        self, app_and_client, anki_mod, monkeypatch
    ):
        rollups = [
            FakeRollup(
                date="2024-01-02",
                total_characters=800,
                total_reading_time_seconds=1800,
                anki_cards_created=1,
                game_activity_data={
                    "ff7": {"title": "FF7", "chars": 800, "time": 1800, "lines": 8}
                },
            )
        ]

        fake_tokenisation = types.ModuleType("GameSentenceMiner.web.tokenisation_api")
        fake_tokenisation.is_tokenisation_enabled = lambda: False
        fake_tokenisation._get_db = lambda: object()
        fake_tokenisation._get_first_mature_word_dates = lambda db: {}
        fake_tokenisation._get_first_mature_kanji_dates = lambda db: {}
        monkeypatch.setitem(
            sys.modules,
            "GameSentenceMiner.web.tokenisation_api",
            fake_tokenisation,
        )

        mock_rollup_table = MagicMock()
        mock_rollup_table.get_date_range.return_value = rollups
        monkeypatch.setattr(anki_mod, "StatsRollupTable", mock_rollup_table)
        monkeypatch.setattr(
            anki_mod,
            "_fetch_game_stats",
            lambda start, end: [
                {
                    "game_name": "FF7",
                    "card_count": 1,
                    "avg_time_per_card": 4.0,
                    "retention_pct": 90.0,
                    "total_reviews": 4,
                }
            ],
        )

        start_ts = int(datetime.datetime(2024, 1, 1).timestamp() * 1000)
        end_ts = int(datetime.datetime(2024, 1, 31, 23, 59, 59).timestamp() * 1000)

        app, client = app_and_client
        resp = client.get(
            f"/api/anki-reading-impact?start_timestamp={start_ts}&end_timestamp={end_ts}"
        )
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["tokenisation_enabled"] is False
        assert data["reading_chars"][0] == 800
        assert data["cards_mined"][0] == 1
        assert data["mature_words"] == [0, 0, 0, 0, 0]
        assert data["mature_kanji"] == [0, 0, 0, 0, 0]
        assert data["lagged_pairs"] == [
            {
                "source_label": "2024-01-01",
                "target_label": "2024-01-22",
                "reading_chars": 800,
                "reading_hours": 0.5,
                "cards_mined": 1,
                "mature_words": 0,
                "mature_kanji": 0,
            },
            {
                "source_label": "2024-01-08",
                "target_label": "2024-01-29",
                "reading_chars": 0,
                "reading_hours": 0.0,
                "cards_mined": 0,
                "mature_words": 0,
                "mature_kanji": 0,
            },
        ]


class TestKanjiStatsFetch:
    def test_default_range_uses_rollups_instead_of_falling_back_to_all_lines(
        self, anki_mod, monkeypatch
    ):
        mock_rollup_table = MagicMock()
        mock_rollup_table.get_first_date.return_value = "2024-01-01"
        mock_rollup_table.get_date_range.return_value = ["rollup"]
        monkeypatch.setattr(anki_mod, "StatsRollupTable", mock_rollup_table)
        monkeypatch.setattr(
            anki_mod,
            "aggregate_rollup_data",
            lambda rollups: {"kanji_frequency_data": {"漢": 3, "字": 1}},
        )
        monkeypatch.setattr(
            anki_mod,
            "combine_rollup_and_live_stats",
            lambda rollup_stats, live_stats: rollup_stats or live_stats or {},
        )

        mock_game_lines_table = MagicMock()
        mock_game_lines_table.get_lines_filtered_by_timestamp.return_value = []
        mock_game_lines_table.all.side_effect = AssertionError(
            "default range should not fall back to GameLinesTable.all() when rollups exist"
        )
        monkeypatch.setattr(anki_mod, "GameLinesTable", mock_game_lines_table)
        monkeypatch.setattr(
            anki_mod,
            "_get_anki_kanji_from_cache",
            lambda start, end: {"字"},
        )

        result = anki_mod._fetch_kanji_stats(None, None)

        assert result["anki_kanji_count"] == 1
        assert result["gsm_kanji_count"] == 2
        assert result["coverage_percent"] == 50.0
        assert result["missing_kanji"] == [{"kanji": "漢", "frequency": 3}]
        mock_rollup_table.get_first_date.assert_called_once_with()
        mock_rollup_table.get_date_range.assert_called_once()
