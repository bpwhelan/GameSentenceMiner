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
    now = None
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
        rows: list[tuple] = []
        for note_data in result:
            try:
                note_id = note_data.get("noteId")
                if note_id is None:
                    continue

                rows.append(
                    (
                        note_id,
                        note_data.get("modelName", ""),
                        json.dumps(note_data.get("fields", {})),
                        json.dumps(note_data.get("tags", [])),
                        note_data.get("mod", 0),
                        now,
                    )
                )
                upserted += 1
            except Exception as e:
                logger.error(f"Failed to upsert note {note_data.get('noteId')}: {e}")

        if rows:
            with AnkiNotesTable._db.transaction():
                AnkiNotesTable._db.executemany(
                    "INSERT OR REPLACE INTO anki_notes "
                    "(note_id, model_name, fields_json, tags, mod, synced_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    rows,
                    commit=False,
                )

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
    now = None
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
        rows: list[tuple] = []
        for card_data in result:
            try:
                card_id = card_data.get("cardId")
                if card_id is None:
                    continue

                rows.append(
                    (
                        card_id,
                        card_data.get("note", 0),
                        card_data.get("deckName", ""),
                        card_data.get("queue", 0),
                        card_data.get("type", 0),
                        card_data.get("due", 0),
                        card_data.get("interval", 0),
                        card_data.get("factor", 0),
                        card_data.get("reps", 0),
                        card_data.get("lapses", 0),
                        now,
                    )
                )
                upserted += 1
            except Exception as e:
                logger.error(f"Failed to upsert card {card_data.get('cardId')}: {e}")

        if rows:
            with AnkiCardsTable._db.transaction():
                AnkiCardsTable._db.executemany(
                    "INSERT OR REPLACE INTO anki_cards "
                    "(card_id, note_id, deck_name, queue, type, due, interval, factor, reps, lapses, synced_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rows,
                    commit=False,
                )

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
    from GameSentenceMiner.util.database.anki_tables import (
        AnkiCardsTable,
    )

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

        result_card_ids: list[int] = []
        for raw_card_id in result.keys():
            try:
                result_card_ids.append(int(raw_card_id))
            except (TypeError, ValueError):
                continue
        raw_note_ids_by_card = AnkiCardsTable.get_note_ids_by_card_ids(result_card_ids)
        note_ids_by_card: dict[int, int] = {}
        for raw_card_id, raw_note_id in raw_note_ids_by_card.items():
            try:
                card_id_key = int(raw_card_id)
                note_id_value = int(raw_note_id)
            except (TypeError, ValueError):
                continue
            note_ids_by_card[card_id_key] = note_id_value
        now = time.time()
        rows: list[tuple] = []
        for card_id_str, reviews in result.items():
            try:
                card_id = int(card_id_str)
            except (TypeError, ValueError):
                continue
            # Look up note_id from the cards cache
            note_id = note_ids_by_card.get(card_id, 0)

            for review_data in reviews:
                try:
                    review_time = review_data.get("id", 0)
                    review_id = f"{card_id}_{review_time}"

                    rows.append(
                        (
                            review_id,
                            card_id,
                            note_id,
                            review_time,
                            review_data.get("ease", 0),
                            review_data.get("ivl", 0),
                            review_data.get("lastIvl", 0),
                            review_data.get("time", 0),
                            now,
                        )
                    )
                    upserted += 1
                except Exception as e:
                    logger.error(f"Failed to upsert review for card {card_id}: {e}")

        if rows:
            with AnkiCardsTable._db.transaction():
                AnkiCardsTable._db.executemany(
                    "INSERT OR REPLACE INTO anki_reviews "
                    "(review_id, card_id, note_id, review_time, ease, interval, last_interval, time_taken, synced_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rows,
                    commit=False,
                )

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
# Sync query helper
# ---------------------------------------------------------------------------


def _build_sync_query() -> str | None:
    """Build the Anki query used for cache sync.

    Uses the configured word field and optional note type filter.
    """
    anki_config = get_config().anki
    word_field = (anki_config.word_field or "").strip()
    if not word_field:
        logger.warning("Anki word_field is not configured; sync scope is unavailable.")
        return None

    query = f"{word_field}:_*"
    note_type = (anki_config.note_type or "").strip()
    if note_type:
        escaped_note_type = note_type.replace('"', '\\"')
        query += f' note:"{escaped_note_type}"'

    return query


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
    words_to_link: list[tuple[str, int]] = []
    for note in notes:
        try:
            fields = json.loads(note.fields_json)
        except (json.JSONDecodeError, TypeError):
            continue

        value = fields.get(word_field, {}).get("value", "").strip()
        if not value:
            continue

        words_to_link.append((value, note.note_id))

    if not words_to_link:
        logger.info("Rebuilt 0 word→note links")
        return 0

    word_values = [value for value, _ in words_to_link]
    word_ids = WordsTable.get_ids_by_words(word_values)
    links = []
    for value, note_id in words_to_link:
        word_id = word_ids.get(value)
        if word_id is not None:
            links.append((word_id, note_id))

    if links:
        count = WordAnkiLinksTable.bulk_link(links)

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
    from collections import defaultdict

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
        cards = AnkiCardsTable.all()
    else:
        # Incremental: delete links for cards belonging to the specified notes
        if note_ids:
            # Collect card IDs for these notes, then delete their kanji links
            cards = AnkiCardsTable.get_by_note_ids(note_ids)
            card_ids = [card.card_id for card in cards]
            if card_ids:
                db.delete_where_in(CardKanjiLinksTable._table, "card_id", card_ids)
        notes = AnkiNotesTable.get_by_ids(note_ids)
        if not notes:
            notes = []

    cards_by_note_id = defaultdict(list)
    for card in cards:
        cards_by_note_id[card.note_id].append(card)

    kanji_chars: list[str] = []
    for note in notes:
        try:
            fields = json.loads(note.fields_json)
        except (json.JSONDecodeError, TypeError):
            continue

        value = fields.get(word_field, {}).get("value", "").strip()
        if not value:
            continue

        for char in value:
            if is_kanji(char):
                kanji_chars.append(char)

    kanji_ids = KanjiTable.ensure_ids_for_characters(kanji_chars)

    count = 0
    link_rows: list[tuple[int, int]] = []
    for note in notes:
        try:
            fields = json.loads(note.fields_json)
        except (json.JSONDecodeError, TypeError):
            continue

        value = fields.get(word_field, {}).get("value", "").strip()
        if not value:
            continue

        note_cards = cards_by_note_id.get(note.note_id, [])
        if not note_cards:
            continue

        chars = {char for char in value if is_kanji(char)}
        for char in chars:
            kanji_id = kanji_ids.get(char)
            if kanji_id is None:
                continue
            for card in note_cards:
                link_rows.append((card.card_id, kanji_id))

    if link_rows:
        count = CardKanjiLinksTable.bulk_link(link_rows)

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


def _scope_note_ids(note_ids: list[int] | None) -> list[int] | None:
    """Return only incoming note IDs that match the configured sync scope."""
    if not note_ids:
        return []

    sync_query = _build_sync_query()
    if sync_query is None:
        return None

    scoped_note_ids = anki_invoke("findNotes", raise_on_error=False, query=sync_query)
    if scoped_note_ids is None:
        logger.warning("AnkiConnect unreachable while resolving sync scope")
        return None

    scope_set = set(scoped_note_ids)
    return [note_id for note_id in note_ids if note_id in scope_set]


def run_full_sync() -> dict:
    """Daily cron entry point. Performs a complete sync of all Anki data.

    Steps:
      1. Check tokenisation is enabled
      2. Fetch scoped note IDs → upsert notes
      3. Fetch scoped card IDs → upsert cards
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

    # Step 1: Fetch scoped note IDs
    sync_query = _build_sync_query()
    if sync_query is None:
        return {"skipped": True, "reason": "word_field not configured"}

    note_ids = anki_invoke("findNotes", raise_on_error=False, query=sync_query)
    if note_ids is None:
        logger.warning("AnkiConnect unreachable — skipping full sync")
        return {"skipped": True, "reason": "AnkiConnect unreachable"}

    # Step 2: Fetch and upsert notes
    notes_upserted = _fetch_and_upsert_notes(note_ids)

    # Step 3: Fetch scoped card IDs
    card_ids = anki_invoke("findCards", raise_on_error=False, query=sync_query)
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

    scoped_note_ids = _scope_note_ids(note_ids)
    if scoped_note_ids is None:
        logger.warning("AnkiConnect unreachable — skipping incremental sync")
        return {"skipped": True, "reason": "AnkiConnect unreachable"}
    if not scoped_note_ids:
        return {"skipped": True, "reason": "no matching notes in sync scope"}

    note_ids = scoped_note_ids

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
