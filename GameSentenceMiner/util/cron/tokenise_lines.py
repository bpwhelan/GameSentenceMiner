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


DEFAULT_BACKFILL_BATCH_SIZE = 250
LOW_PERFORMANCE_BACKFILL_BATCH_SIZE = 50
PROGRESS_MILESTONE_STEP_PERCENT = 10
ADAPTIVE_SLEEP_RATIO = 0.25
MIN_ADAPTIVE_BATCH_SLEEP_SECONDS = 0.05
MAX_ADAPTIVE_BATCH_SLEEP_SECONDS = 1.0

# Legacy alias kept for compatibility with older callers/tests.
THROTTLE_SLEEP_SECONDS = MIN_ADAPTIVE_BATCH_SLEEP_SECONDS


def _get_backfill_batch_size(low_performance_mode: bool) -> int:
    return (
        LOW_PERFORMANCE_BACKFILL_BATCH_SIZE
        if low_performance_mode
        else DEFAULT_BACKFILL_BATCH_SIZE
    )


def _calculate_adaptive_batch_sleep(batch_elapsed_seconds: float) -> float:
    """Derive weak-mode sleep from recent batch work time with hard caps."""
    raw_sleep = batch_elapsed_seconds * ADAPTIVE_SLEEP_RATIO
    return max(
        MIN_ADAPTIVE_BATCH_SLEEP_SECONDS,
        min(MAX_ADAPTIVE_BATCH_SLEEP_SECONDS, raw_sleep),
    )


def _get_progress_milestone(
    attempted_lines: int,
    total_lines: int,
    last_logged_milestone: int,
) -> int | None:
    if total_lines <= 0:
        return None

    current_percent = int((attempted_lines / total_lines) * 100)
    milestone = (current_percent // PROGRESS_MILESTONE_STEP_PERCENT) * (
        PROGRESS_MILESTONE_STEP_PERCENT
    )

    if milestone <= last_logged_milestone:
        return None
    if milestone <= 0:
        return None
    if milestone > 100:
        return 100
    return milestone


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

                if line_timestamp is not None:
                    WordsTable.set_first_seen_if_missing(word_id, line_timestamp, line_id)

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
        rebuild_word_stats_cache,
        recompute_word_first_seen_metadata,
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
    word_rows_deleted = (
        cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
    )

    first_seen_repair_rows = db.fetchall(
        """
        SELECT id
        FROM words
        WHERE (
            first_seen_line_id IS NOT NULL
            AND TRIM(CAST(first_seen_line_id AS TEXT)) != ''
            AND first_seen_line_id NOT IN (SELECT id FROM game_lines)
        )
        OR (
            id NOT IN (SELECT DISTINCT word_id FROM word_occurrences)
            AND (
                first_seen IS NOT NULL
                OR (
                    first_seen_line_id IS NOT NULL
                    AND TRIM(CAST(first_seen_line_id AS TEXT)) != ''
                )
            )
        )
        """
    )
    if first_seen_repair_rows:
        recompute_word_first_seen_metadata(
            db, [int(row[0]) for row in first_seen_repair_rows]
        )

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
    kanji_rows_deleted = (
        cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
    )

    total = word_orphans + kanji_orphans + word_rows_deleted + kanji_rows_deleted
    if total > 0:
        rebuild_word_stats_cache(db)

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

    total_lines = GameLinesTable.count_untokenised_lines()
    processed = 0
    errors = 0
    attempted_lines = 0
    last_logged_milestone = 0
    last_timestamp: float | None = None
    last_id: str | None = None

    if total_lines > 0:
        initial_batch_size = _get_backfill_batch_size(is_tokenisation_low_performance())
        logger.info(
            f"Tokenise backfill: processing {total_lines} untokenised lines "
            f"(batch size up to {initial_batch_size})"
        )

    while attempted_lines < total_lines:
        low_performance_mode = is_tokenisation_low_performance()
        batch_size = _get_backfill_batch_size(low_performance_mode)
        batch_started_at = time.time()

        batch = GameLinesTable.get_untokenised_lines(
            limit=batch_size,
            after_timestamp=last_timestamp,
            after_id=last_id,
        )

        if not batch:
            break

        for line in batch:
            if attempted_lines >= total_lines:
                break

            last_timestamp = line.timestamp
            last_id = line.id

            try:
                success = tokenise_line(line.id, line.line_text, line.timestamp)
                if success:
                    processed += 1
                else:
                    errors += 1
            except Exception as e:
                logger.error(f"Failed to tokenise line {line.id}: {e}")
                errors += 1

            attempted_lines += 1

            milestone = _get_progress_milestone(
                attempted_lines, total_lines, last_logged_milestone
            )
            if milestone is not None:
                logger.info(
                    f"Tokenise backfill progress: {milestone}% "
                    f"({attempted_lines}/{total_lines} attempted, "
                    f"{processed} processed, {errors} errors)"
                )
                last_logged_milestone = milestone

        if low_performance_mode and attempted_lines < total_lines:
            batch_elapsed = time.time() - batch_started_at
            time.sleep(_calculate_adaptive_batch_sleep(batch_elapsed))

    elapsed = time.time() - start_time

    if (
        total_lines > 0
        and attempted_lines == total_lines
        and last_logged_milestone < 100
    ):
        logger.info(
            f"Tokenise backfill progress: 100% "
            f"({attempted_lines}/{total_lines} attempted, "
            f"{processed} processed, {errors} errors)"
        )

    if processed > 0 or errors > 0:
        logger.info(
            f"Tokenise backfill complete: {processed} processed, {errors} errors, "
            f"{attempted_lines}/{total_lines} attempted, "
            f"{orphans_cleaned} orphans cleaned, {elapsed:.1f}s elapsed"
        )

    return {
        "skipped": False,
        "orphans_cleaned": orphans_cleaned,
        "total_lines": total_lines,
        "attempted_lines": attempted_lines,
        "processed": processed,
        "errors": errors,
        "elapsed_time": elapsed,
    }
