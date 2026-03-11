"""
Tokenise Lines Cron Module

Provides:
- tokenise_line(): Core function to tokenise a single game line
- run_tokenise_backfill(): Weekly cron entry point
- cleanup_orphaned_occurrences(): Remove orphaned occurrence rows
"""

from __future__ import annotations

import time
from typing import Dict

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.config.feature_flags import (
    is_tokenisation_enabled,
    is_tokenisation_low_performance,
)
from GameSentenceMiner.util.text_utils import is_kanji


THROTTLE_SLEEP_SECONDS = 0.05  # 50ms pause between lines in low-performance mode


def tokenise_line(
    line_id: str, line_text: str, line_timestamp: float | None = None
) -> bool:
    """
    Tokenise a single game line and insert word/kanji occurrences.
    If line_timestamp is provided, updates last_seen for each word.
    Returns True on success, False on failure.
    """
    from GameSentenceMiner.mecab import mecab
    from GameSentenceMiner.mecab.basic_types import PartOfSpeech
    from GameSentenceMiner.util.database.tokenisation_tables import (
        WordsTable,
        KanjiTable,
        WordOccurrencesTable,
        KanjiOccurrencesTable,
    )
    from GameSentenceMiner.util.database.db import GameLinesTable

    # Coerce to str in case the ORM returned a non-string (e.g. JSON-parsed dict)
    if not isinstance(line_text, str):
        line_text = str(line_text) if line_text else ""

    # Skip empty or whitespace-only lines
    if not line_text or not line_text.strip():
        GameLinesTable.mark_tokenised(line_id)
        return True

    try:
        tokens = mecab.translate(line_text)
    except Exception as e:
        logger.error(f"MeCab failed for line {line_id}: {e}")
        return False

    try:
        with WordsTable._db.transaction():
            for token in tokens:
                # Skip punctuation and non-word tokens
                if token.part_of_speech in (PartOfSpeech.symbol, PartOfSpeech.other):
                    continue

                # Skip empty headwords (defensive)
                if not token.headword or not token.headword.strip():
                    continue

                # Upsert word: INSERT OR IGNORE on unique headword
                word_id = WordsTable.get_or_create(
                    word=token.headword,
                    reading=token.katakana_reading,
                    pos=token.part_of_speech.value if token.part_of_speech else None,
                )

                # Update last_seen timestamp if provided
                if line_timestamp is not None:
                    WordsTable.update_last_seen(word_id, line_timestamp)

                # Insert occurrence: INSERT OR IGNORE on unique (word_id, line_id)
                WordOccurrencesTable.insert_occurrence(word_id, line_id)

            # Extract kanji characters directly from the line text
            for char in line_text:
                if is_kanji(char):
                    kanji_id = KanjiTable.get_or_create(character=char)
                    KanjiOccurrencesTable.insert_occurrence(kanji_id, line_id)

            # Mark line as tokenised (last — ensures crash recovery works)
            GameLinesTable.mark_tokenised(line_id)

        return True

    except Exception as e:
        logger.error(f"Failed to tokenise line {line_id}: {e}")
        return False


def cleanup_orphaned_occurrences() -> int:
    """
    Delete orphaned tokenisation rows whose backing data no longer exists.

    This removes:
    - word_occurrences rows whose line_id no longer exists in game_lines
    - kanji_occurrences rows whose line_id no longer exists in game_lines
    - words rows with no remaining word_occurrences
    - kanji rows with no remaining kanji_occurrences

    Returns the total number of orphaned rows deleted.
    """
    from GameSentenceMiner.util.database.tokenisation_tables import (
        WordOccurrencesTable,
        KanjiOccurrencesTable,
    )
    from GameSentenceMiner.util.database.db import GameLinesTable

    db = WordOccurrencesTable._db

    # Delete orphaned word occurrences
    cursor = db.execute(
        f"DELETE FROM {WordOccurrencesTable._table} "
        f"WHERE line_id NOT IN (SELECT id FROM {GameLinesTable._table})",
        commit=True,
    )
    word_orphans = cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0

    # Delete orphaned kanji occurrences
    cursor = db.execute(
        f"DELETE FROM {KanjiOccurrencesTable._table} "
        f"WHERE line_id NOT IN (SELECT id FROM {GameLinesTable._table})",
        commit=True,
    )
    kanji_orphans = cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0

    word_cleanup_query = (
        "DELETE FROM words "
        "WHERE id NOT IN (SELECT DISTINCT word_id FROM word_occurrences)"
    )
    if db.table_exists("word_anki_links"):
        # Preserve stable word IDs that are still linked to cached Anki notes.
        word_cleanup_query += (
            " AND id NOT IN (SELECT DISTINCT word_id FROM word_anki_links)"
        )

    cursor = db.execute(word_cleanup_query, commit=True)
    word_rows_deleted = cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0

    kanji_cleanup_query = (
        "DELETE FROM kanji "
        "WHERE id NOT IN (SELECT DISTINCT kanji_id FROM kanji_occurrences)"
    )
    if db.table_exists("card_kanji_links"):
        # Preserve stable kanji IDs that are still linked from cached Anki cards.
        kanji_cleanup_query += (
            " AND id NOT IN (SELECT DISTINCT kanji_id FROM card_kanji_links)"
        )

    cursor = db.execute(kanji_cleanup_query, commit=True)
    kanji_rows_deleted = cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0

    total = word_orphans + kanji_orphans + word_rows_deleted + kanji_rows_deleted
    if total > 0:
        logger.info(
            "Cleaned up "
            f"{total} orphaned tokenisation rows "
            f"({word_orphans} word occurrences, {kanji_orphans} kanji occurrences, "
            f"{word_rows_deleted} words, {kanji_rows_deleted} kanji)"
        )

    return total


def run_tokenise_backfill() -> Dict:
    """
    Weekly cron entry point: clean orphans, then tokenise new lines.

    Returns a summary dict with keys: skipped, orphans_cleaned, processed, errors.
    """
    if not is_tokenisation_enabled():
        return {"skipped": True, "reason": "tokenisation disabled"}

    start_time = time.time()

    # Phase 1: Orphan cleanup
    try:
        orphans_cleaned = cleanup_orphaned_occurrences()
    except Exception as e:
        logger.error(f"Orphan cleanup failed: {e}")
        orphans_cleaned = 0

    # Phase 2: Tokenise untokenised lines
    from GameSentenceMiner.util.database.db import GameLinesTable

    untokenised = GameLinesTable.get_untokenised_lines()
    processed = 0
    errors = 0

    if untokenised:
        logger.info(
            f"Tokenise backfill: processing {len(untokenised)} untokenised lines"
        )

    for line in untokenised:
        try:
            success = tokenise_line(line.id, line.line_text, line.timestamp)
            if success:
                processed += 1
            else:
                errors += 1
        except Exception as e:
            logger.error(f"Failed to tokenise line {line.id}: {e}")
            errors += 1

        # Check throttle on each iteration (runtime-responsive)
        if is_tokenisation_low_performance():
            time.sleep(THROTTLE_SLEEP_SECONDS)

    elapsed = time.time() - start_time

    if processed > 0 or errors > 0:
        logger.info(
            f"Tokenise backfill complete: {processed} processed, {errors} errors, "
            f"{orphans_cleaned} orphans cleaned, {elapsed:.1f}s elapsed"
        )

    return {
        "skipped": False,
        "orphans_cleaned": orphans_cleaned,
        "processed": processed,
        "errors": errors,
        "elapsed_time": elapsed,
    }
