"""
Anki Card Sync Engine

Maintains a local SQLite cache of Anki note, card, and review data.
Two sync strategies keep the cache fresh:
  - Full sync: daily cron (also fires on startup if overdue)
  - Incremental sync: triggered when check_for_new_cards() detects new notes

Supersedes the older anki_word_sync cron.
"""

from __future__ import annotations

import json
import time

from GameSentenceMiner.util.logging_config import logger
from GameSentenceMiner.util.config.configuration import get_config
from GameSentenceMiner.anki import invoke as anki_invoke
from GameSentenceMiner.util.text_utils import is_kanji

# Batch sizes per the design doc
_NOTES_BATCH_SIZE = 500
_CARDS_BATCH_SIZE = 500
_REVIEWS_BATCH_SIZE = 100


# ---------------------------------------------------------------------------
# Fetch-and-upsert helpers
# ---------------------------------------------------------------------------


def _fetch_and_upsert_notes(note_ids: list[int]) -> int:
    """Batch-fetch ``notesInfo`` from AnkiConnect and upsert into ``anki_notes``.

    Args:
        note_ids: List of Anki note IDs to fetch.

    Returns:
        Number of notes successfully upserted.
    """
    from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable

    if not note_ids:
        return 0

    upserted = 0
    for i in range(0, len(note_ids), _NOTES_BATCH_SIZE):
        batch = note_ids[i : i + _NOTES_BATCH_SIZE]
        result = anki_invoke("notesInfo", raise_on_error=False, notes=batch)
        if result is None:
            logger.warning(
                f"Skipping notesInfo batch {i // _NOTES_BATCH_SIZE + 1} "
                f"({len(batch)} notes) due to AnkiConnect error"
            )
            continue

        now = time.time()
        for note_data in result:
            try:
                note_id = note_data.get("noteId")
                if note_id is None:
                    continue

                note = AnkiNotesTable(
                    note_id=note_id,
                    model_name=note_data.get("modelName", ""),
                    fields_json=json.dumps(note_data.get("fields", {})),
                    tags=json.dumps(note_data.get("tags", [])),
                    mod=note_data.get("mod", 0),
                    synced_at=now,
                )
                note.save()
                upserted += 1
            except Exception as e:
                logger.error(f"Failed to upsert note {note_data.get('noteId')}: {e}")

    return upserted


def _fetch_and_upsert_cards(card_ids: list[int]) -> int:
    """Batch-fetch ``cardsInfo`` from AnkiConnect and upsert into ``anki_cards``.

    Args:
        card_ids: List of Anki card IDs to fetch.

    Returns:
        Number of cards successfully upserted.
    """
    from GameSentenceMiner.util.database.anki_tables import AnkiCardsTable

    if not card_ids:
        return 0

    upserted = 0
    for i in range(0, len(card_ids), _CARDS_BATCH_SIZE):
        batch = card_ids[i : i + _CARDS_BATCH_SIZE]
        result = anki_invoke("cardsInfo", raise_on_error=False, cards=batch)
        if result is None:
            logger.warning(
                f"Skipping cardsInfo batch {i // _CARDS_BATCH_SIZE + 1} "
                f"({len(batch)} cards) due to AnkiConnect error"
            )
            continue

        now = time.time()
        for card_data in result:
            try:
                card_id = card_data.get("cardId")
                if card_id is None:
                    continue

                card = AnkiCardsTable(
                    card_id=card_id,
                    note_id=card_data.get("note", 0),
                    deck_name=card_data.get("deckName", ""),
                    queue=card_data.get("queue", 0),
                    type=card_data.get("type", 0),
                    due=card_data.get("due", 0),
                    interval=card_data.get("interval", 0),
                    factor=card_data.get("factor", 0),
                    reps=card_data.get("reps", 0),
                    lapses=card_data.get("lapses", 0),
                    synced_at=now,
                )
                card.save()
                upserted += 1
            except Exception as e:
                logger.error(f"Failed to upsert card {card_data.get('cardId')}: {e}")

    return upserted


def _fetch_and_upsert_reviews(card_ids: list[int]) -> int:
    """Batch-fetch ``cardReviews`` from AnkiConnect and upsert into ``anki_reviews``.

    The AnkiConnect ``cardReviews`` action returns a dict keyed by card ID,
    where each value is a list of review entries.

    Args:
        card_ids: List of Anki card IDs whose reviews to fetch.

    Returns:
        Number of reviews successfully upserted.
    """
    from GameSentenceMiner.util.database.anki_tables import AnkiReviewsTable

    if not card_ids:
        return 0

    # We also need note_id for each card — build a lookup from the cache
    from GameSentenceMiner.util.database.anki_tables import AnkiCardsTable

    upserted = 0
    for i in range(0, len(card_ids), _REVIEWS_BATCH_SIZE):
        batch = card_ids[i : i + _REVIEWS_BATCH_SIZE]
        result = anki_invoke("getReviewsOfCards", raise_on_error=False, cards=batch)
        if result is None:
            logger.warning(
                f"Skipping cardReviews batch {i // _REVIEWS_BATCH_SIZE + 1} "
                f"({len(batch)} cards) due to AnkiConnect error"
            )
            continue

        now = time.time()
        for card_id_str, reviews in result.items():
            card_id = int(card_id_str)
            # Look up note_id from the cards cache
            cached_card = AnkiCardsTable.get(card_id)
            note_id = cached_card.note_id if cached_card else 0

            for review_data in reviews:
                try:
                    review_time = review_data.get("id", 0)
                    review_id = f"{card_id}_{review_time}"

                    review = AnkiReviewsTable(
                        review_id=review_id,
                        card_id=card_id,
                        note_id=note_id,
                        review_time=review_time,
                        ease=review_data.get("ease", 0),
                        interval=review_data.get("ivl", 0),
                        last_interval=review_data.get("lastIvl", 0),
                        time_taken=review_data.get("time", 0),
                        synced_at=now,
                    )
                    review.save()
                    upserted += 1
                except Exception as e:
                    logger.error(f"Failed to upsert review for card {card_id}: {e}")

    return upserted


# ---------------------------------------------------------------------------
# Stale row deletion
# ---------------------------------------------------------------------------


def _delete_stale_rows(live_note_ids: set[int]) -> dict:
    """Delete cache rows for notes no longer present in Anki.

    Compares cached note IDs against *live_note_ids* (from AnkiConnect) and
    removes stale entries from all five cache tables in the correct order to
    respect foreign-key-like relationships.

    Deletion order (children first):
      1. card_kanji_links  (by card_id)
      2. word_anki_links   (by note_id)
      3. anki_reviews      (by card_id)
      4. anki_cards         (by note_id)
      5. anki_notes         (by note_id)

    Args:
        live_note_ids: The complete set of note IDs currently in Anki.

    Returns:
        Dict with keys ``stale_notes``, ``deleted_card_kanji_links``,
        ``deleted_word_anki_links``, ``deleted_reviews``, ``deleted_cards``,
        ``deleted_notes``.
    """
    from GameSentenceMiner.util.database.anki_tables import (
        AnkiCardsTable,
        AnkiNotesTable,
        CardKanjiLinksTable,
        WordAnkiLinksTable,
    )

    result = {
        "stale_notes": 0,
        "deleted_card_kanji_links": 0,
        "deleted_word_anki_links": 0,
        "deleted_reviews": 0,
        "deleted_cards": 0,
        "deleted_notes": 0,
    }

    # 1. Determine stale note IDs
    cached_notes = AnkiNotesTable.all()
    cached_note_ids = {n.note_id for n in cached_notes}
    stale_note_ids = cached_note_ids - live_note_ids

    if not stale_note_ids:
        return result

    result["stale_notes"] = len(stale_note_ids)
    stale_note_list = list(stale_note_ids)

    # 2. Collect card IDs belonging to stale notes (batch query)
    stale_card_ids: list[int] = []
    chunk_size = 500  # stay within SQLite's 999-variable limit
    for start in range(0, len(stale_note_list), chunk_size):
        chunk = stale_note_list[start : start + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        rows = AnkiCardsTable._db.fetchall(
            f"SELECT card_id FROM {AnkiCardsTable._table} "
            f"WHERE note_id IN ({placeholders})",
            tuple(chunk),
        )
        stale_card_ids.extend(row[0] for row in rows)

    db = AnkiNotesTable._db

    # 3. Delete from child tables first, then parent tables
    if stale_card_ids:
        result["deleted_card_kanji_links"] = db.delete_where_in(
            "card_kanji_links", "card_id", stale_card_ids
        )
        result["deleted_reviews"] = db.delete_where_in(
            "anki_reviews", "card_id", stale_card_ids
        )

    result["deleted_word_anki_links"] = db.delete_where_in(
        "word_anki_links", "note_id", stale_note_list
    )
    result["deleted_cards"] = db.delete_where_in(
        "anki_cards", "note_id", stale_note_list
    )
    result["deleted_notes"] = db.delete_where_in(
        "anki_notes", "note_id", stale_note_list
    )

    logger.info(
        f"Deleted stale rows: {result['stale_notes']} notes, "
        f"{result['deleted_cards']} cards, {result['deleted_reviews']} reviews, "
        f"{result['deleted_word_anki_links']} word links, "
        f"{result['deleted_card_kanji_links']} kanji links"
    )

    return result


# ---------------------------------------------------------------------------
# Kanji detection helper
# ---------------------------------------------------------------------------





# ---------------------------------------------------------------------------
# Link rebuild helpers
# ---------------------------------------------------------------------------


def _rebuild_word_links(note_ids: list[int] | None = None) -> int:
    """Rebuild ``word_anki_links`` by matching the configured word field in each
    note against the ``words`` table.

    When *note_ids* is ``None`` (full sync), all existing word links are deleted
    first and then rebuilt from every cached note.  When *note_ids* is provided
    (incremental sync), only links for those notes are deleted and rebuilt.

    Returns the number of links created.
    """
    from GameSentenceMiner.util.database.anki_tables import (
        AnkiNotesTable,
        WordAnkiLinksTable,
    )
    from GameSentenceMiner.util.database.tokenisation_tables import WordsTable

    word_field = get_config().anki.word_field
    if not word_field:
        logger.warning("Word field not configured — skipping word link rebuild")
        return 0

    db = AnkiNotesTable._db

    # Delete existing links before rebuilding
    if note_ids is None:
        # Full sync: wipe all word links
        db.execute(f"DELETE FROM {WordAnkiLinksTable._table}", commit=True)
        notes = AnkiNotesTable.all()
    else:
        # Incremental: delete links for the specified notes only
        if note_ids:
            db.delete_where_in(WordAnkiLinksTable._table, "note_id", note_ids)
        notes = AnkiNotesTable.get_by_ids(note_ids)

    count = 0
    for note in notes:
        try:
            fields = json.loads(note.fields_json)
        except (json.JSONDecodeError, TypeError):
            continue

        value = fields.get(word_field, {}).get("value", "").strip()
        if not value:
            continue

        word = WordsTable.get_by_word(value)
        if word:
            WordAnkiLinksTable.link(word.id, note.note_id)
            count += 1

    logger.info(f"Rebuilt {count} word→note links")
    return count


def _rebuild_kanji_links(note_ids: list[int] | None = None) -> int:
    """Rebuild ``card_kanji_links`` by extracting kanji characters from the
    configured word field and linking each (card, kanji) pair.

    When *note_ids* is ``None`` (full sync), all existing kanji links are
    deleted first and then rebuilt.  When *note_ids* is provided (incremental
    sync), only links for cards belonging to those notes are deleted and rebuilt.

    Returns the number of links created.
    """
    from GameSentenceMiner.util.database.anki_tables import (
        AnkiCardsTable,
        AnkiNotesTable,
        CardKanjiLinksTable,
    )
    from GameSentenceMiner.util.database.tokenisation_tables import KanjiTable

    word_field = get_config().anki.word_field
    if not word_field:
        logger.warning("Word field not configured — skipping kanji link rebuild")
        return 0

    db = AnkiNotesTable._db

    # Delete existing links before rebuilding
    if note_ids is None:
        # Full sync: wipe all kanji links
        db.execute(f"DELETE FROM {CardKanjiLinksTable._table}", commit=True)
        notes = AnkiNotesTable.all()
    else:
        # Incremental: delete links for cards belonging to the specified notes
        if note_ids:
            # Collect card IDs for these notes, then delete their kanji links
            card_ids: list[int] = []
            for nid in note_ids:
                cards = AnkiCardsTable.get_by_note_id(nid)
                card_ids.extend(c.card_id for c in cards)
            if card_ids:
                db.delete_where_in(CardKanjiLinksTable._table, "card_id", card_ids)
        notes = AnkiNotesTable.get_by_ids(note_ids)

    count = 0
    for note in notes:
        try:
            fields = json.loads(note.fields_json)
        except (json.JSONDecodeError, TypeError):
            continue

        value = fields.get(word_field, {}).get("value", "").strip()
        if not value:
            continue

        # Get all cards for this note
        cards = AnkiCardsTable.get_by_note_id(note.note_id)
        for char in value:
            if is_kanji(char):
                kanji_id = KanjiTable.get_or_create(char)
                for card in cards:
                    CardKanjiLinksTable.link(card.card_id, kanji_id)
                    count += 1

    logger.info(f"Rebuilt {count} card→kanji links")
    return count


# ---------------------------------------------------------------------------
# Stubs for functions implemented in subsequent tasks (3.4 – 3.6)
# ---------------------------------------------------------------------------


def _update_in_anki_flags() -> int:
    """Set ``in_anki`` flag on the ``words`` table based on ``word_anki_links``.

    Words with at least one entry in ``word_anki_links`` get ``in_anki = 1``;
    words with no entries get ``in_anki = 0``.

    Returns:
        Total number of rows updated across both statements.
    """
    from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable

    db = AnkiNotesTable._db

    cur_set = db.execute(
        "UPDATE words SET in_anki = 1 "
        "WHERE id IN (SELECT DISTINCT word_id FROM word_anki_links)",
        commit=True,
    )
    rows_set = cur_set.rowcount

    cur_cleared = db.execute(
        "UPDATE words SET in_anki = 0 "
        "WHERE id NOT IN (SELECT DISTINCT word_id FROM word_anki_links)",
        commit=True,
    )
    rows_cleared = cur_cleared.rowcount

    total = rows_set + rows_cleared
    logger.info(f"Updated in_anki flags: {rows_set} set, {rows_cleared} cleared")
    return total


def run_full_sync() -> dict:
    """Daily cron entry point. Performs a complete sync of all Anki data.

    Steps:
      1. Check tokenisation is enabled
      2. Fetch all note IDs → upsert notes
      3. Fetch all card IDs → upsert cards
      4. Fetch reviews for all cards
      5. Delete stale rows (notes in cache but not in Anki)
      6. Rebuild word_anki_links
      7. Rebuild card_kanji_links
      8. Update in_anki flags on words table

    Returns:
        Summary dict with counts for each step.
    """
    from GameSentenceMiner.util.config.feature_flags import is_tokenisation_enabled

    if not is_tokenisation_enabled():
        return {"skipped": True, "reason": "tokenisation disabled"}

    # Step 1: Fetch all note IDs
    note_ids = anki_invoke("findNotes", raise_on_error=False, query="deck:*")
    if note_ids is None:
        logger.warning("AnkiConnect unreachable — skipping full sync")
        return {"skipped": True, "reason": "AnkiConnect unreachable"}

    # Step 2: Fetch and upsert notes
    notes_upserted = _fetch_and_upsert_notes(note_ids)

    # Step 3: Fetch all card IDs
    card_ids = anki_invoke("findCards", raise_on_error=False, query="deck:*")
    if card_ids is None:
        card_ids = []

    # Step 4: Fetch and upsert cards
    cards_upserted = _fetch_and_upsert_cards(card_ids)

    # Step 5: Fetch and upsert reviews
    reviews_upserted = _fetch_and_upsert_reviews(card_ids)

    # Step 6: Delete stale rows
    deletion_counts = _delete_stale_rows(set(note_ids))

    # Step 7: Rebuild word links (full rebuild)
    word_links = _rebuild_word_links()

    # Step 8: Rebuild kanji links (full rebuild)
    kanji_links = _rebuild_kanji_links()

    # Step 9: Update in_anki flags
    flags_updated = _update_in_anki_flags()

    summary = {
        "skipped": False,
        "notes_upserted": notes_upserted,
        "cards_upserted": cards_upserted,
        "reviews_upserted": reviews_upserted,
        "deletion": deletion_counts,
        "word_links": word_links,
        "kanji_links": kanji_links,
        "flags_updated": flags_updated,
    }
    logger.info(f"Full sync complete: {summary}")

    # Invalidate the in-memory Anki stats cache so the next API request
    # picks up the freshly synced data.
    try:
        from GameSentenceMiner.web.anki_api_endpoints import invalidate_anki_data_cache

        invalidate_anki_data_cache()
    except Exception:
        pass  # Non-critical; cache will expire naturally via TTL

    return summary


def run_incremental_sync(note_ids: list[int]) -> dict:
    """Sync specific notes immediately. Called from ``check_for_new_cards()``.

    Steps:
      1. Check tokenisation is enabled
      2. Fetch and upsert the given notes
      3. Find card IDs belonging to those notes via AnkiConnect
      4. Fetch and upsert those cards
      5. Fetch and upsert reviews for those cards
      6. Rebuild word_anki_links for these notes only
      7. Rebuild card_kanji_links for these notes only
      8. Update in_anki flags

    Args:
        note_ids: Anki note IDs to sync.

    Returns:
        Summary dict with counts for each step.
    """
    from GameSentenceMiner.util.config.feature_flags import is_tokenisation_enabled

    if not is_tokenisation_enabled():
        return {"skipped": True, "reason": "tokenisation disabled"}

    if not note_ids:
        return {"skipped": True, "reason": "no note IDs provided"}

    # Step 1: Fetch and upsert notes
    notes_upserted = _fetch_and_upsert_notes(note_ids)

    # Step 2: Find card IDs for these notes via AnkiConnect
    nid_query = " OR ".join(f"nid:{nid}" for nid in note_ids)
    card_ids = anki_invoke("findCards", raise_on_error=False, query=nid_query)
    if card_ids is None:
        logger.warning("AnkiConnect unreachable — skipping incremental sync")
        return {"skipped": True, "reason": "AnkiConnect unreachable"}

    # Step 3: Fetch and upsert cards
    cards_upserted = _fetch_and_upsert_cards(card_ids)

    # Step 4: Fetch and upsert reviews
    reviews_upserted = _fetch_and_upsert_reviews(card_ids)

    # Step 5: Rebuild word links for these notes only
    word_links = _rebuild_word_links(note_ids)

    # Step 6: Rebuild kanji links for these notes only
    kanji_links = _rebuild_kanji_links(note_ids)

    # Step 7: Update in_anki flags
    flags_updated = _update_in_anki_flags()

    summary = {
        "skipped": False,
        "notes_upserted": notes_upserted,
        "cards_upserted": cards_upserted,
        "reviews_upserted": reviews_upserted,
        "word_links": word_links,
        "kanji_links": kanji_links,
        "flags_updated": flags_updated,
    }
    logger.info(f"Incremental sync complete for {len(note_ids)} notes: {summary}")

    try:
        from GameSentenceMiner.web.anki_api_endpoints import invalidate_anki_data_cache

        invalidate_anki_data_cache()
    except Exception:
        pass

    return summary
