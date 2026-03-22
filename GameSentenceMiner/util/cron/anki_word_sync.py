# DEPRECATED: This module is superseded by anki_card_sync.py
# The anki_card_sync module provides a more comprehensive sync of notes, cards,
# and reviews. This module is kept for reference but is no longer called by the
# cron system. See GameSentenceMiner/util/cron/anki_card_sync.py

"""
Anki Word Sync Cron Module (DEPRECATED)

Daily cron that checks the Expression field in Anki and marks matching
words in the tokenized words table with in_anki = 1.

Only processes words where in_anki is currently 0 (not yet tagged).

.. deprecated::
    Use :mod:`GameSentenceMiner.util.cron.anki_card_sync` instead.
    The anki_card_sync module syncs notes, cards, and reviews into a local
    SQLite cache and handles word/kanji linking. This module is no longer
    invoked by the cron scheduler.
"""

from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Dict

from GameSentenceMiner.util.config.configuration import get_config, logger
from GameSentenceMiner.util.config.feature_flags import is_tokenization_enabled


def _fetch_all_expression_values() -> set[str] | None:
    """Query AnkiConnect for all unique Expression field values.

    Uses the configured word_field name (default "Expression") and
    fetches every note in Anki that has a non-empty value in that field.

    Returns a set of expression strings, or None on failure.
    """
    word_field = get_config().anki.word_field
    if not word_field:
        logger.warning("Anki word_field is not configured, skipping anki_word_sync")
        return None

    url = get_config().anki.url

    try:
        # Step 1: find all notes that have a non-empty Expression field
        find_payload = json.dumps(
            {
                "action": "findNotes",
                "version": 6,
                "params": {"query": f"{word_field}:_*"},
            }
        ).encode("utf-8")

        req = urllib.request.Request(url, data=find_payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("error"):
                logger.warning(f"AnkiConnect findNotes error: {data['error']}")
                return None
            note_ids: list[int] = data.get("result", [])

        if not note_ids:
            logger.debug("No notes found in Anki with a non-empty Expression field")
            return set()

        # Step 2: fetch note info in batches to get the field values
        expressions: set[str] = set()
        batch_size = 500
        for i in range(0, len(note_ids), batch_size):
            batch = note_ids[i : i + batch_size]
            info_payload = json.dumps(
                {
                    "action": "notesInfo",
                    "version": 6,
                    "params": {"notes": batch},
                }
            ).encode("utf-8")

            req = urllib.request.Request(url, data=info_payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("error"):
                    logger.warning(f"AnkiConnect notesInfo error: {data['error']}")
                    continue
                for note in data.get("result", []):
                    fields = note.get("fields", {})
                    value = fields.get(word_field, {}).get("value", "").strip()
                    if value:
                        expressions.add(value)

        return expressions

    except urllib.error.URLError as e:
        logger.warning(f"AnkiConnect not available for word sync: {e}")
        return None
    except Exception as e:
        logger.error(f"Error fetching Anki expressions: {e}")
        return None


def run_anki_word_sync() -> Dict:
    """Daily cron entry point: match tokenized words against Anki Expression field."""
    if not is_tokenization_enabled():
        return {"skipped": True, "reason": "tokenization disabled"}

    from GameSentenceMiner.util.database.tokenization_tables import WordsTable

    expressions = _fetch_all_expression_values()
    if expressions is None:
        return {"skipped": True, "reason": "could not reach AnkiConnect"}

    if not expressions:
        return {"matched": 0, "checked": 0}

    words = WordsTable.get_words_not_in_anki()
    if not words:
        return {"matched": 0, "checked": 0, "reason": "no untagged words"}

    matched = 0
    for word in words:
        if word.word in expressions:
            WordsTable.mark_in_anki(word.id)
            matched += 1

    logger.background(f"Anki word sync complete: {matched}/{len(words)} words matched")
    return {"matched": matched, "checked": len(words)}
