"""
Unit tests for anki_card_sync.py core sync logic.

Tests:
- _fetch_and_upsert_notes() with mocked notesInfo response
- _fetch_and_upsert_cards() with mocked cardsInfo response
- _delete_stale_rows() correctly identifies and removes stale rows
- save() upsert works end-to-end for Anki tables

Validates: Requirements 12.1, 12.2, 12.3
"""

from __future__ import annotations

import json
import os
import tempfile
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.database.db import SQLiteDB
from GameSentenceMiner.util.database.anki_tables import (
    AnkiCardsTable,
    AnkiNotesTable,
    AnkiReviewsTable,
    CardKanjiLinksTable,
    WordAnkiLinksTable,
    setup_anki_tables,
)
from GameSentenceMiner.util.cron import anki_card_sync as sync_mod


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_config(url: str = "http://127.0.0.1:8765", word_field: str = "Expression"):
    return SimpleNamespace(
        anki=SimpleNamespace(url=url, word_field=word_field),
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def db():
    """Yield a temporary in-memory-like SQLite DB with all Anki tables registered."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    _db = SQLiteDB(path)
    setup_anki_tables(_db)
    yield _db
    _db.close()
    try:
        os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Tests for _fetch_and_upsert_notes
# ---------------------------------------------------------------------------


class TestFetchAndUpsertNotes:
    """Tests for _fetch_and_upsert_notes with mocked AnkiConnect."""

    def test_empty_note_ids_returns_zero(self, db):
        assert sync_mod._fetch_and_upsert_notes([]) == 0

    def test_upserts_notes_from_anki_response(self, db, monkeypatch):
        notes_response = [
            {
                "noteId": 100,
                "modelName": "Basic",
                "fields": {"Front": {"value": "hello"}, "Back": {"value": "world"}},
                "tags": ["vocab"],
                "mod": 1700000000,
            },
            {
                "noteId": 200,
                "modelName": "Cloze",
                "fields": {"Text": {"value": "test"}},
                "tags": [],
                "mod": 1700000001,
            },
        ]

        monkeypatch.setattr(
            sync_mod,
            "anki_invoke",
            lambda *a, **kw: notes_response,
        )

        count = sync_mod._fetch_and_upsert_notes([100, 200])
        assert count == 2

        note1 = AnkiNotesTable.get(100)
        assert note1 is not None
        assert note1.model_name == "Basic"
        assert json.loads(note1.fields_json) == notes_response[0]["fields"]

        note2 = AnkiNotesTable.get(200)
        assert note2 is not None
        assert note2.model_name == "Cloze"

    def test_skips_batch_on_anki_error(self, db, monkeypatch):
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: None)

        count = sync_mod._fetch_and_upsert_notes([100])
        assert count == 0
        assert AnkiNotesTable.get(100) is None

    def test_skips_note_without_noteId(self, db, monkeypatch):
        response = [{"modelName": "Basic", "fields": {}, "tags": [], "mod": 0}]
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: response)

        count = sync_mod._fetch_and_upsert_notes([100])
        assert count == 0

    def test_upsert_updates_existing_note(self, db, monkeypatch):
        """Second upsert with same note_id should update, not duplicate."""
        # First insert
        resp1 = [
            {"noteId": 300, "modelName": "Basic", "fields": {}, "tags": [], "mod": 1}
        ]
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: resp1)
        sync_mod._fetch_and_upsert_notes([300])

        # Second upsert with updated model
        resp2 = [
            {
                "noteId": 300,
                "modelName": "Cloze",
                "fields": {},
                "tags": ["updated"],
                "mod": 2,
            }
        ]
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: resp2)
        sync_mod._fetch_and_upsert_notes([300])

        rows = db.fetchall("SELECT * FROM anki_notes WHERE note_id = ?", (300,))
        assert len(rows) == 1
        note = AnkiNotesTable.get(300)
        assert note.model_name == "Cloze"


# ---------------------------------------------------------------------------
# Tests for _fetch_and_upsert_cards
# ---------------------------------------------------------------------------


class TestFetchAndUpsertCards:
    """Tests for _fetch_and_upsert_cards with mocked AnkiConnect."""

    def test_empty_card_ids_returns_zero(self, db):
        assert sync_mod._fetch_and_upsert_cards([]) == 0

    def test_upserts_cards_from_anki_response(self, db, monkeypatch):
        cards_response = [
            {
                "cardId": 1001,
                "note": 100,
                "deckName": "Japanese::Vocab",
                "queue": 2,
                "type": 2,
                "due": 500,
                "interval": 30,
                "factor": 2500,
                "reps": 10,
                "lapses": 1,
            },
            {
                "cardId": 1002,
                "note": 200,
                "deckName": "Japanese::Grammar",
                "queue": 1,
                "type": 1,
                "due": 100,
                "interval": 0,
                "factor": 0,
                "reps": 0,
                "lapses": 0,
            },
        ]

        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: cards_response)

        count = sync_mod._fetch_and_upsert_cards([1001, 1002])
        assert count == 2

        card1 = AnkiCardsTable.get(1001)
        assert card1 is not None
        assert card1.note_id == 100
        assert card1.deck_name == "Japanese::Vocab"
        assert card1.reps == 10

        card2 = AnkiCardsTable.get(1002)
        assert card2 is not None
        assert card2.note_id == 200

    def test_skips_batch_on_anki_error(self, db, monkeypatch):
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: None)

        count = sync_mod._fetch_and_upsert_cards([1001])
        assert count == 0

    def test_upsert_updates_existing_card(self, db, monkeypatch):
        resp1 = [
            {
                "cardId": 2001,
                "note": 100,
                "deckName": "Deck1",
                "queue": 0,
                "type": 0,
                "due": 0,
                "interval": 0,
                "factor": 0,
                "reps": 0,
                "lapses": 0,
            }
        ]
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: resp1)
        sync_mod._fetch_and_upsert_cards([2001])

        resp2 = [
            {
                "cardId": 2001,
                "note": 100,
                "deckName": "Deck2",
                "queue": 2,
                "type": 2,
                "due": 50,
                "interval": 10,
                "factor": 2500,
                "reps": 5,
                "lapses": 1,
            }
        ]
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: resp2)
        sync_mod._fetch_and_upsert_cards([2001])

        rows = db.fetchall("SELECT * FROM anki_cards WHERE card_id = ?", (2001,))
        assert len(rows) == 1
        card = AnkiCardsTable.get(2001)
        assert card.deck_name == "Deck2"
        assert card.reps == 5


# ---------------------------------------------------------------------------
# Tests for _fetch_and_upsert_reviews
# ---------------------------------------------------------------------------


class TestFetchAndUpsertReviews:
    """Tests for _fetch_and_upsert_reviews with mocked AnkiConnect."""

    def test_upserts_reviews_with_string_card_ids_and_preserves_note_mapping(
        self, db, monkeypatch
    ):
        # Seed the cards cache so review rows can resolve note_id by card_id.
        AnkiCardsTable(
            card_id=3001,
            note_id=901,
            deck_name="Deck",
            queue=2,
            type=2,
            due=0,
            interval=25,
            factor=2500,
            reps=10,
            lapses=0,
            synced_at=0.0,
        ).save()

        reviews_response = {
            "3001": [
                {
                    "id": 1710000000000,
                    "ease": 3,
                    "ivl": 30,
                    "lastIvl": 20,
                    "time": 1200,
                }
            ]
        }
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: reviews_response)

        count = sync_mod._fetch_and_upsert_reviews([3001])
        assert count == 1

        rows = db.fetchall(
            "SELECT card_id, note_id, review_time, interval, last_interval, time_taken "
            "FROM anki_reviews WHERE card_id = ?",
            (3001,),
        )
        assert len(rows) == 1
        card_id, note_id, review_time, interval, last_interval, time_taken = rows[0]
        assert int(card_id) == 3001
        assert int(note_id) == 901
        assert int(review_time) == 1710000000000
        assert int(interval) == 30
        assert int(last_interval) == 20
        assert int(time_taken) == 1200

    def test_skips_reviews_without_card_note_mapping(self, db, monkeypatch):
        reviews_response = {
            "3001": [
                {
                    "id": 1710000000000,
                    "ease": 3,
                    "ivl": 30,
                    "lastIvl": 20,
                    "time": 1200,
                }
            ]
        }
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: reviews_response)

        count = sync_mod._fetch_and_upsert_reviews([3001])
        assert count == 0
        assert db.fetchone("SELECT COUNT(*) FROM anki_reviews")[0] == 0


# ---------------------------------------------------------------------------
# Tests for _delete_stale_rows
# ---------------------------------------------------------------------------


class TestDeleteStaleRows:
    """Tests for _delete_stale_rows correctly identifying and removing stale rows."""

    def _seed_note(self, note_id: int):
        note = AnkiNotesTable(
            note_id=note_id,
            model_name="Basic",
            fields_json="{}",
            tags="[]",
            mod=0,
            synced_at=0.0,
        )
        note.save()

    def _seed_card(self, card_id: int, note_id: int):
        card = AnkiCardsTable(
            card_id=card_id,
            note_id=note_id,
            deck_name="Deck",
            queue=0,
            type=0,
            due=0,
            interval=0,
            factor=0,
            reps=0,
            lapses=0,
            synced_at=0.0,
        )
        card.save()

    def test_no_stale_rows_returns_zeros(self, db):
        self._seed_note(1)
        self._seed_note(2)
        result = sync_mod._delete_stale_rows({1, 2})
        assert result["stale_notes"] == 0
        assert result["deleted_notes"] == 0

    def test_deletes_stale_notes_and_cards(self, db):
        # Note 1 is live, note 2 is stale
        self._seed_note(1)
        self._seed_note(2)
        self._seed_card(10, 1)
        self._seed_card(20, 2)
        self._seed_card(21, 2)

        result = sync_mod._delete_stale_rows({1})  # only note 1 is live

        assert result["stale_notes"] == 1
        assert result["deleted_notes"] == 1
        assert result["deleted_cards"] == 2

        # Note 1 and its card should survive
        assert AnkiNotesTable.get(1) is not None
        assert AnkiCardsTable.get(10) is not None

        # Note 2 and its cards should be gone
        assert AnkiNotesTable.get(2) is None
        assert AnkiCardsTable.get(20) is None
        assert AnkiCardsTable.get(21) is None

    def test_deletes_all_when_no_live_notes(self, db):
        self._seed_note(1)
        self._seed_note(2)
        self._seed_card(10, 1)

        result = sync_mod._delete_stale_rows(set())  # nothing is live

        assert result["stale_notes"] == 2
        assert result["deleted_notes"] == 2
        assert result["deleted_cards"] == 1
        assert len(AnkiNotesTable.all()) == 0

    def test_empty_cache_returns_zeros(self, db):
        result = sync_mod._delete_stale_rows({1, 2, 3})
        assert result["stale_notes"] == 0

    def test_deletes_stale_cards_for_live_notes(self, db):
        self._seed_note(1)
        self._seed_card(10, 1)
        self._seed_card(11, 1)

        AnkiReviewsTable(
            review_id="11_1710000000000",
            card_id=11,
            note_id=1,
            review_time=1710000000000,
            ease=3,
            interval=10,
            last_interval=5,
            time_taken=1200,
            synced_at=0.0,
        ).save()
        CardKanjiLinksTable.link(11, 501)
        WordAnkiLinksTable.link(701, 1)

        result = sync_mod._delete_stale_rows({1}, {10})

        assert result["stale_notes"] == 0
        assert result["stale_cards"] == 1
        assert result["deleted_cards"] == 1
        assert result["deleted_reviews"] == 1
        assert result["deleted_card_kanji_links"] == 1
        assert result["deleted_word_anki_links"] == 0
        assert AnkiCardsTable.get(10) is not None
        assert AnkiCardsTable.get(11) is None
        assert db.fetchone("SELECT COUNT(*) FROM anki_reviews WHERE card_id = ?", (11,))[
            0
        ] == 0
        assert db.fetchone(
            "SELECT COUNT(*) FROM card_kanji_links WHERE card_id = ?", (11,)
        )[0] == 0
        assert db.fetchone("SELECT COUNT(*) FROM word_anki_links WHERE note_id = ?", (1,))[
            0
        ] == 1


# ---------------------------------------------------------------------------
# End-to-end: save() upsert works for Anki tables via sync functions
# ---------------------------------------------------------------------------


class TestSaveUpsertEndToEnd:
    """Verify save() upsert semantics work end-to-end through the sync functions."""

    def test_note_first_insert_then_update_via_fetch(self, db, monkeypatch):
        """Full round-trip: fetch note from AnkiConnect, save, fetch again with changes, save again."""
        # First sync — inserts
        resp1 = [
            {
                "noteId": 500,
                "modelName": "Basic",
                "fields": {"Front": {"value": "a"}},
                "tags": [],
                "mod": 1,
            }
        ]
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: resp1)
        sync_mod._fetch_and_upsert_notes([500])

        note = AnkiNotesTable.get(500)
        assert note is not None
        assert note.model_name == "Basic"

        # Second sync — updates
        resp2 = [
            {
                "noteId": 500,
                "modelName": "Cloze",
                "fields": {"Text": {"value": "b"}},
                "tags": ["new"],
                "mod": 2,
            }
        ]
        monkeypatch.setattr(sync_mod, "anki_invoke", lambda *a, **kw: resp2)
        sync_mod._fetch_and_upsert_notes([500])

        note = AnkiNotesTable.get(500)
        assert note.model_name == "Cloze"
        assert json.loads(note.tags) == ["new"]

        # Only one row in the table
        rows = db.fetchall("SELECT * FROM anki_notes WHERE note_id = ?", (500,))
        assert len(rows) == 1


class TestRunFullSync:
    def test_skips_before_writes_when_card_lookup_fails(self, db, monkeypatch):
        import GameSentenceMiner.web.anki_api_endpoints as anki_api_mod

        invalidations: list[str] = []

        monkeypatch.setattr(
            "GameSentenceMiner.util.config.feature_flags.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(sync_mod, "_build_sync_query", lambda: "deck:All")
        monkeypatch.setattr(
            sync_mod,
            "_fetch_and_upsert_notes",
            lambda *args, **kwargs: (_ for _ in ()).throw(
                AssertionError("notes should not be fetched before card lookup succeeds")
            ),
        )

        def fake_anki_invoke(action, raise_on_error=False, **kwargs):
            if action == "findNotes":
                return [100]
            if action == "findCards":
                return None
            raise AssertionError(f"Unexpected action: {action}")

        monkeypatch.setattr(sync_mod, "anki_invoke", fake_anki_invoke)
        monkeypatch.setattr(
            anki_api_mod, "invalidate_anki_data_cache", lambda: invalidations.append("x")
        )

        result = sync_mod.run_full_sync()

        assert result == {"skipped": True, "reason": "AnkiConnect unreachable"}
        assert invalidations == []
        assert AnkiNotesTable.all() == []

    def test_rolls_back_partial_writes_when_card_sync_fails(self, db, monkeypatch):
        import GameSentenceMiner.web.anki_api_endpoints as anki_api_mod

        invalidations: list[str] = []

        monkeypatch.setattr(
            "GameSentenceMiner.util.config.feature_flags.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(sync_mod, "_build_sync_query", lambda: "deck:All")

        def fake_anki_invoke(action, raise_on_error=False, **kwargs):
            if action == "findNotes":
                return [100]
            if action == "findCards":
                return [200]
            raise AssertionError(f"Unexpected action: {action}")

        def fake_fetch_notes(note_ids, *, strict=False):
            assert strict is True
            AnkiNotesTable(
                note_id=100,
                model_name="Basic",
                fields_json="{}",
                tags="[]",
                mod=0,
                synced_at=0.0,
            ).save()
            return 1

        monkeypatch.setattr(sync_mod, "anki_invoke", fake_anki_invoke)
        monkeypatch.setattr(sync_mod, "_fetch_and_upsert_notes", fake_fetch_notes)
        monkeypatch.setattr(
            sync_mod,
            "_fetch_and_upsert_cards",
            lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError("cardsInfo failed")
            ),
        )
        monkeypatch.setattr(
            anki_api_mod, "invalidate_anki_data_cache", lambda: invalidations.append("x")
        )

        result = sync_mod.run_full_sync()

        assert result == {"skipped": True, "reason": "cardsInfo failed"}
        assert invalidations == []
        assert AnkiNotesTable.get(100) is None
