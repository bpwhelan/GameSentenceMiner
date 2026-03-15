"""
Property-based tests for the tokenization feature.

Feature: search-tokenized-words, Property 1: Last seen equals maximum line timestamp
Validates: Requirements 2.1, 2.2, 2.3
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from GameSentenceMiner.util.database.db import gsm_db
from GameSentenceMiner.util.database.tokenization_tables import (
    WordsTable,
    KanjiTable,
    WordOccurrencesTable,
    KanjiOccurrencesTable,
    create_tokenization_indexes,
)


def _ensure_tokenization_tables():
    """Ensure tokenization tables exist and are empty."""
    for cls in [WordsTable, KanjiTable, WordOccurrencesTable, KanjiOccurrencesTable]:
        cls.set_db(gsm_db)
    create_tokenization_indexes(gsm_db)
    try:
        gsm_db.execute(
            "ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0",
            commit=True,
        )
    except Exception:
        pass
    for table in ["word_occurrences", "kanji_occurrences", "words", "kanji"]:
        gsm_db.execute(f"DELETE FROM {table}", commit=True)


# Reasonable Unix timestamp range: 2020-01-01 to 2030-01-01
_timestamp_strategy = st.floats(
    min_value=1577836800.0,
    max_value=1893456000.0,
    allow_nan=False,
    allow_infinity=False,
)


@settings(max_examples=100)
@given(timestamps=st.lists(_timestamp_strategy, min_size=1, max_size=50))
def test_last_seen_equals_max_timestamp(timestamps):
    """
    Property 1: Last seen equals maximum line timestamp

    For any word that appears in one or more tokenized game lines, the word's
    last_seen value should equal the maximum timestamp among all game lines
    containing that word, regardless of the order timestamps are applied.

    Feature: search-tokenized-words, Property 1: Last seen equals maximum line timestamp
    Validates: Requirements 2.1, 2.2, 2.3
    """
    _ensure_tokenization_tables()

    word_id = WordsTable.get_or_create("テスト", "テスト", "名詞")

    for ts in timestamps:
        WordsTable.update_last_seen(word_id, ts)

    word = WordsTable.get_by_word("テスト")
    assert word is not None
    # SQLite REAL is an 8-byte IEEE 754 float; round-trip may lose the least
    # significant bits, so we compare with a small relative tolerance.
    assert word.last_seen == pytest.approx(max(timestamps), rel=1e-9)
