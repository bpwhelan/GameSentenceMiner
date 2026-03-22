"""
Property-based test for the /api/tokenization/words/not-in-anki endpoint.

Feature: anki-stats-fixes, Property 4: Word frequency count correctness
**Validates: Requirements 2.3**
"""

from __future__ import annotations

import uuid
from unittest.mock import patch

import flask
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.tokenization_tables import (
    WordsTable,
    KanjiTable,
    WordOccurrencesTable,
    KanjiOccurrencesTable,
    create_tokenization_indexes,
    create_tokenization_trigger,
)
from GameSentenceMiner.web.tokenization_api import register_tokenization_api_routes


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# POS values that are NOT excluded by the endpoint (it excludes 記号 and その他)
_allowed_pos = st.sampled_from(["名詞", "動詞", "形容詞", "副詞", "助詞"])


@st.composite
def word_frequency_scenario(draw):
    """Generate a set of words and word_occurrences for testing frequency correctness.

    Produces:
    - A list of words, each with a random in_anki value (0 or 1) and a POS
    - A mapping of word index -> number of occurrences to create
    """
    n_words = draw(st.integers(min_value=1, max_value=15))

    words = []
    for i in range(n_words):
        in_anki = draw(st.sampled_from([0, 1]))
        pos = draw(_allowed_pos)
        words.append({"in_anki": in_anki, "pos": pos})

    # For each word, decide how many occurrences (0 to 10)
    occurrences: dict[int, int] = {}
    for i in range(n_words):
        count = draw(st.integers(min_value=0, max_value=10))
        occurrences[i] = count

    return {"words": words, "occurrences": occurrences}


# ---------------------------------------------------------------------------
# DB + Flask context
# ---------------------------------------------------------------------------


class _FreqTestContext:
    """Manages an in-memory DB and Flask test client for a single Hypothesis example."""

    def __init__(self):
        self.db: SQLiteDB | None = None
        self.client = None
        self._orig_lines_db = None

    def setup(self):
        self._orig_lines_db = GameLinesTable._db

        self.db = SQLiteDB(":memory:")
        GameLinesTable.set_db(self.db)

        # Ensure the tokenized column exists (set_db creates the table but
        # tokenized may not be in _fields)
        try:
            self.db.execute(
                "ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0",
                commit=True,
            )
        except Exception:
            pass

        for cls in [
            WordsTable,
            KanjiTable,
            WordOccurrencesTable,
            KanjiOccurrencesTable,
        ]:
            cls.set_db(self.db)

        create_tokenization_indexes(self.db)
        create_tokenization_trigger(self.db)

        # Reset column order caches so from_row works with the fresh DB
        WordsTable._column_order_cache = None
        WordOccurrencesTable._column_order_cache = None

        app = flask.Flask(__name__)
        app.config["TESTING"] = True

        with patch(
            "GameSentenceMiner.web.tokenization_api.is_tokenization_enabled",
            return_value=True,
        ):
            register_tokenization_api_routes(app)

        self.client = app.test_client()

    def teardown(self):
        if self.db:
            self.db.close()
        GameLinesTable._db = self._orig_lines_db


# ---------------------------------------------------------------------------
# Property test
# ---------------------------------------------------------------------------


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(scenario=word_frequency_scenario())
def test_word_frequency_matches_actual_occurrence_count(scenario):
    """
    Property 4: Word frequency count correctness

    For any set of words marked in_anki=0 and for any set of live word
    occurrences, the /api/tokenization/words/not-in-anki endpoint SHALL return
    a frequency value for each returned word equal to the exact count of rows
    in word_occurrences where word_id matches that word's id. Words with zero
    live occurrences shall be excluded.

    Feature: anki-stats-fixes, Property 4: Word frequency count correctness
    **Validates: Requirements 2.3**
    """
    ctx = _FreqTestContext()
    ctx.setup()
    try:
        words_data = scenario["words"]
        occurrences = scenario["occurrences"]

        # Insert words and track their IDs
        word_ids: list[int] = []
        for i, w in enumerate(words_data):
            unique_word = f"word_{uuid.uuid4().hex[:8]}"
            wid = WordsTable.get_or_create(unique_word, unique_word, w["pos"])
            # Set in_anki value
            if w["in_anki"] == 1:
                WordsTable.mark_in_anki(wid)
            word_ids.append(wid)

        # Create live game_lines rows so the endpoint's JOIN on game_lines keeps
        # counting these occurrences.
        for word_idx, count in occurrences.items():
            wid = word_ids[word_idx]
            for j in range(count):
                line_id = f"line_{uuid.uuid4().hex[:8]}"
                GameLinesTable(
                    id=line_id,
                    line_text=f"text_{word_idx}_{j}",
                    game_name="TestGame",
                    game_id="test-game-id",
                    timestamp=float(j + 1),
                ).add()
                WordOccurrencesTable.insert_occurrence(wid, line_id)

        # Compute expected frequencies for words with in_anki=0 and at least
        # one live occurrence. Zero-occurrence words are excluded now.
        expected_freq: dict[int, int] = {}
        for i, w in enumerate(words_data):
            if w["in_anki"] == 0 and occurrences[i] > 0:
                expected_freq[word_ids[i]] = occurrences[i]

        # Query the endpoint with a high limit to get all words
        with patch(
            "GameSentenceMiner.web.tokenization_api.is_tokenization_enabled",
            return_value=True,
        ):
            resp = ctx.client.get(f"/api/tokenization/words/not-in-anki?limit=1000&offset=0")

        assert resp.status_code == 200
        data = resp.get_json()

        returned_words = data["words"]

        # Verify: every word with in_anki=0 and at least one live occurrence
        # should appear, and its frequency should match the actual occurrence count
        returned_freq_by_word: dict[str, int] = {w["word"]: w["frequency"] for w in returned_words}

        # Check that no in_anki=1 words appear
        for i, w in enumerate(words_data):
            wid = word_ids[i]
            # Look up the word text from the DB
            row = ctx.db.fetchone("SELECT word FROM words WHERE id = ?", (wid,))
            word_text = row[0]

            if w["in_anki"] == 1:
                assert word_text not in returned_freq_by_word, (
                    f"Word '{word_text}' has in_anki=1 but appeared in results"
                )
            elif occurrences[i] == 0:
                assert word_text not in returned_freq_by_word, (
                    f"Word '{word_text}' has zero live occurrences but appeared in results"
                )
            else:
                assert word_text in returned_freq_by_word, f"Word '{word_text}' has in_anki=0 but missing from results"
                actual_freq = returned_freq_by_word[word_text]
                expected = expected_freq[wid]
                assert actual_freq == expected, f"Word '{word_text}': expected frequency {expected}, got {actual_freq}"

    finally:
        ctx.teardown()
