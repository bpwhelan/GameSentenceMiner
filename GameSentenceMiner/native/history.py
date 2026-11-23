"""Bridge legacy mining callers to the active desktop's SQLite history."""

import math
import os
import re
from typing import Literal

from GameSentenceMiner.native.runtime import backend_manages


def _desktop_schema_ready(db):
    from GameSentenceMiner.util.communication import bus_client

    return os.environ.get("GSM_NATIVE_SCHEMA") == "1" and managed(db) and bus_client.get_bus().connected


def migrate_schema(db, language):
    if _desktop_schema_ready(db):
        db.run_external_write(lambda: request("migrateSchema", language=language, timeout=None))
        return True
    from GameSentenceMiner.native.ocr import _extension

    migrate = getattr(_extension, "migrate_history_schema", None)
    if migrate is None or db.db_path == ":memory:" or db.read_only:
        return False
    db.run_external_write(lambda: migrate(db.db_path, language))
    return True


def managed(db):
    # Imported databases, read-only tools, and the Python writer's nested
    # transactions keep their own connection and transaction boundaries.
    return (
        backend_manages("GSM_NATIVE_HISTORY")
        and not db.read_only
        and not db._on_writer_thread()
        and bool(directory := os.environ.get("GSM_DATA_DIR"))
        and os.path.normcase(os.path.abspath(db.db_path))
        == os.path.normcase(os.path.abspath(os.path.join(directory, "gsm.db")))
    )


def configure_vocabulary_schema(db, enabled) -> Literal["desktop", "extension"] | None:
    """Identify the owner that committed the schema change on this call."""
    if _desktop_schema_ready(db):
        db.run_external_write(lambda: request("configureVocabulary", enabled=enabled, timeout=None))
        return "desktop"
    from GameSentenceMiner.native.ocr import _extension

    configure = getattr(_extension, "configure_vocabulary_schema", None)
    if configure is None or db.read_only or db.db_path == ":memory:" or db._on_writer_thread():
        return None
    db.run_external_write(lambda: configure(db.db_path, enabled))
    return "extension"


def import_reading_stats(db, rows, clear_source):
    if os.environ.get("GSM_NATIVE_SCHEMA") != "1" or not managed(db):
        return None
    # The bus allows 8 MiB per message. Bound escaped strings without encoding
    # a second copy of the payload. Larger batches use the local native extension.
    budget = 7 * 1024 * 1024 - 12 * len(clear_source or "")
    if budget <= 0:
        return None
    for date, characters, seconds, source, label in rows:
        if not -(2**63) <= characters < 2**63 or not math.isfinite(seconds):
            return None
        budget -= 96 + 12 * (len(date) + len(source) + len(label))
        if budget <= 0:
            return None
    return db.run_external_write(
        lambda: request("importReadingStats", rows=rows, clear_source=clear_source, timeout=None)
    )


def request(operation, *, timeout=60, **fields):
    from GameSentenceMiner.util.communication import bus_client

    return bus_client.get_bus().request(
        bus_client.MAIN, "mining.history", {"operation": operation, **fields}, timeout=timeout
    )


def manages_word_index(db):
    return os.environ.get("GSM_NATIVE_WORD_INDEX") == "1" and managed(db)


def manages_anki_sync(db):
    return db is not None and os.environ.get("GSM_NATIVE_ANKI_SYNC") == "1" and managed(db)


def stop_anki_sync():
    if backend_manages("GSM_NATIVE_ANKI_SYNC"):
        from websockets.exceptions import ConnectionClosed

        from GameSentenceMiner.util.communication import bus_client

        try:
            bus_client.get_bus().request(bus_client.MAIN, "anki.sync.stop", {}, timeout=2)
        except (OSError, RuntimeError, ConnectionClosed) as exc:
            from GameSentenceMiner.util.logging_config import logger

            logger.debug(f"Stopping desktop Anki sync: {exc}")


def sync_anki(db, url, field, query, notes):
    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.util.database.db import DB_PRIORITY_LOW

    generation = db.run_external_write(lambda: request("writerGeneration"), priority=DB_PRIORITY_LOW)
    return bus_client.get_bus().request(
        bus_client.MAIN,
        "anki.sync",
        {"generation": generation, "url": url, "field": field, "query": query, "notes": notes},
        timeout=None,
    )


# Keep this subset aligned with gsm_history::ReportCleaner::compile.
_LITERAL = r"[^\\.^$|?*+()\[\]{}]+"
_PUNCTUATION_TERM = rf"(?:{_LITERAL}(?:\.\*\?{_LITERAL})?|\[(?:[\w ](?:-[\w ])?)+\]\+?)"
_PUNCTUATION_BRANCH = rf"(?:{_PUNCTUATION_TERM}|\(\?<={_LITERAL}\){_PUNCTUATION_TERM}|{_PUNCTUATION_TERM}\(\?={_LITERAL}\)|\({_LITERAL}(?:\|{_LITERAL})*\)\\1)"
_PORTABLE_PUNCTUATION = re.compile(rf"{_PUNCTUATION_BRANCH}(?:\|{_PUNCTUATION_BRANCH})*")


def manages_daily_rollup(db, config):
    if os.environ.get("GSM_NATIVE_DAILY_ROLLUP") != "1" or not managed(db):
        return False
    pattern = (config.extra_punctuation_regex or "").strip()
    return not pattern or _PORTABLE_PUNCTUATION.fullmatch(pattern) is not None


def index_request(action, *, timeout=60, **fields):
    from GameSentenceMiner.util.communication import bus_client

    return bus_client.get_bus().request(
        bus_client.MAIN, "mining.wordIndex", {"action": action, **fields}, timeout=timeout
    )


def run_word_backfill(db):
    if os.environ.get("GSM_NATIVE_WORD_BACKFILL") != "1" or not manages_word_index(db):
        return None
    from GameSentenceMiner.util.database.db import DB_PRIORITY_LOW

    generation = db.run_external_write(lambda: request("writerGeneration"), priority=DB_PRIORITY_LOW)
    return index_request("runBackfill", generation=generation, timeout=None)


def _anki_reports_managed(db):
    return db is not None and os.environ.get("GSM_NATIVE_ANKI_REPORTS") == "1" and managed(db)


def _read_anki_report(operation, **fields):
    from websockets.exceptions import ConnectionClosed

    try:
        return request(operation, **fields)
    except (OSError, ConnectionClosed, RuntimeError) as exc:
        from GameSentenceMiner.util.config.configuration import logger

        logger.debug(f"Reading {operation} locally after desktop report failed: {exc}")
        return None


def maturity_report(db, today, *, weeks=None):
    if not _anki_reports_managed(db):
        return None
    from GameSentenceMiner.util.config.configuration import get_config

    return _read_anki_report(
        "maturityHistory",
        today=today.isoformat(),
        word_field=(get_config().anki.word_field or "").strip(),
        weeks={"start": weeks[0].isoformat(), "end": weeks[1].isoformat()} if weeks else None,
    )


def _bounded_anki_report(db, operation, start, end, **fields):
    if not _anki_reports_managed(db) or any(n is not None and not -(2**63) <= n < 2**63 for n in (start, end)):
        return None
    return _read_anki_report(operation, start=start, end=end, **fields)


def anki_game_stats(db, parent_tag, start, end):
    return _bounded_anki_report(db, "ankiGameStats", start, end, parent_tag=parent_tag)


def anki_content_retention(db, parent_tag, start, end):
    return _bounded_anki_report(db, "ankiContentRetention", start, end, parent_tag=parent_tag)


def anki_note_kanji(db, parent_tag, word_field, start, end):
    return _bounded_anki_report(db, "ankiNoteKanji", start, end, parent_tag=parent_tag, word_field=word_field)


def anki_earliest_note(db, parent_tag):
    return _read_anki_report("ankiEarliestNote", parent_tag=parent_tag) if _anki_reports_managed(db) else None


def _search_managed(db):
    return db is not None and os.environ.get("GSM_NATIVE_SEARCH") == "1" and managed(db)


def search_sentences(
    db,
    *,
    query,
    game=None,
    start=None,
    end=None,
    sort="relevance",
    page=1,
    page_size=20,
    use_regex=False,
    use_tokenized=False,
):
    if not _search_managed(db):
        return None
    from websockets.exceptions import ConnectionClosed

    try:
        result = request(
            "searchSentences",
            query=query,
            game=game or None,
            start=start,
            end=end,
            sort=sort,
            page=page,
            page_size=page_size,
            use_regex=bool(use_regex),
            use_tokenized=bool(use_tokenized),
        )
    except (OSError, ConnectionClosed, RuntimeError) as exc:
        from GameSentenceMiner.util.config.configuration import logger

        logger.debug(f"Searching sentences locally after desktop query failed: {exc}")
        return None
    if isinstance(result, dict) and "fallback" in result:
        return None
    return result


def search_duplicates(
    db,
    *,
    game=None,
    time_window_minutes=5,
    case_sensitive=False,
    ignore_time_window=False,
):
    if not _search_managed(db):
        return None
    from websockets.exceptions import ConnectionClosed

    try:
        return request(
            "searchDuplicates",
            game=game or None,
            time_window_minutes=float(time_window_minutes),
            case_sensitive=bool(case_sensitive),
            ignore_time_window=bool(ignore_time_window),
        )
    except (OSError, ConnectionClosed, RuntimeError) as exc:
        from GameSentenceMiner.util.config.configuration import logger

        logger.debug(f"Searching duplicates locally after desktop query failed: {exc}")
        return None


def _maintenance_managed(db):
    return db is not None and os.environ.get("GSM_NATIVE_MAINTENANCE") == "1" and managed(db)


def games_list(db):
    if not _maintenance_managed(db):
        return None
    from websockets.exceptions import ConnectionClosed

    try:
        return request("gamesList")
    except (OSError, ConnectionClosed, RuntimeError) as exc:
        from GameSentenceMiner.util.config.configuration import logger

        logger.debug(f"Loading games list locally after desktop query failed: {exc}")
        return None


def _normalize_exact_text(exact_text):
    if exact_text is None:
        return []
    if isinstance(exact_text, str):
        return [exact_text]
    if isinstance(exact_text, list):
        return [t for t in exact_text if isinstance(t, str)]
    return None


def preview_text_deletion(db, *, regex_pattern=None, exact_text=None, case_sensitive=False, use_regex=False):
    if not _maintenance_managed(db):
        return None
    if regex_pattern is not None and use_regex and not isinstance(regex_pattern, str):
        return None
    targets = _normalize_exact_text(exact_text)
    if targets is None:
        return None
    from websockets.exceptions import ConnectionClosed

    try:
        result = request(
            "previewTextDeletion",
            regex_pattern=regex_pattern if isinstance(regex_pattern, str) else None,
            exact_text=targets,
            case_sensitive=bool(case_sensitive),
            use_regex=bool(use_regex),
        )
    except (OSError, ConnectionClosed, RuntimeError) as exc:
        from GameSentenceMiner.util.config.configuration import logger

        logger.debug(f"Previewing text deletion locally after desktop query failed: {exc}")
        return None
    if isinstance(result, dict) and "fallback" in result:
        return None
    return result


def delete_text_lines_native(db, *, regex_pattern=None, exact_text=None, case_sensitive=False, use_regex=False):
    if not _maintenance_managed(db):
        return None
    if regex_pattern is not None and use_regex and not isinstance(regex_pattern, str):
        return None
    targets = _normalize_exact_text(exact_text)
    if targets is None:
        return None
    result = db.run_external_write(
        lambda: request(
            "deleteTextLines",
            regex_pattern=regex_pattern if isinstance(regex_pattern, str) else None,
            exact_text=targets,
            case_sensitive=bool(case_sensitive),
            use_regex=bool(use_regex),
            timeout=None,
        )
    )
    if isinstance(result, dict) and "fallback" in result:
        return None
    return result


def preview_deduplication(db, *, games, time_window_minutes=5, case_sensitive=False, ignore_time_window=False):
    if not _maintenance_managed(db) or not isinstance(games, list) or not all(isinstance(g, str) for g in games):
        return None
    from websockets.exceptions import ConnectionClosed

    try:
        return request(
            "previewDeduplication",
            games=games,
            time_window_minutes=float(time_window_minutes),
            case_sensitive=bool(case_sensitive),
            ignore_time_window=bool(ignore_time_window),
        )
    except (OSError, ConnectionClosed, RuntimeError) as exc:
        from GameSentenceMiner.util.config.configuration import logger

        logger.debug(f"Previewing deduplication locally after desktop query failed: {exc}")
        return None


def deduplicate_lines_native(
    db, *, games, time_window_minutes=5, case_sensitive=False, preserve_newest=False, ignore_time_window=False
):
    if not _maintenance_managed(db) or not isinstance(games, list) or not all(isinstance(g, str) for g in games):
        return None
    return db.run_external_write(
        lambda: request(
            "deduplicateLines",
            games=games,
            time_window_minutes=float(time_window_minutes),
            case_sensitive=bool(case_sensitive),
            preserve_newest=bool(preserve_newest),
            ignore_time_window=bool(ignore_time_window),
            timeout=None,
        )
    )


def _tokenization_managed(db):
    return db is not None and os.environ.get("GSM_NATIVE_TOKENIZATION") == "1" and managed(db)


def _read_tokenization(operation, **fields):
    from websockets.exceptions import ConnectionClosed

    try:
        return request(operation, **fields)
    except (OSError, ConnectionClosed, RuntimeError) as exc:
        from GameSentenceMiner.util.config.configuration import logger

        logger.debug(f"Reading {operation} locally after desktop query failed: {exc}")
        return None


def tokenization_status(db):
    return _read_tokenization("tokenizationStatus") if _tokenization_managed(db) else None


def tokenization_words(db, *, limit, offset, days=None, game_id=None, pos=None, exclude_pos=None, search=None):
    if not _tokenization_managed(db):
        return None
    return _read_tokenization(
        "tokenizationWords",
        limit=limit,
        offset=offset,
        days=days,
        game_id=game_id,
        pos=pos,
        exclude_pos=exclude_pos,
        search=search,
    )


def tokenization_kanji(db, *, limit, offset, days=None, game_id=None):
    if not _tokenization_managed(db):
        return None
    return _read_tokenization("tokenizationKanji", limit=limit, offset=offset, days=days, game_id=game_id)


def tokenization_search(db, *, query, limit, offset, game_ids=(), has_game_scope=False):
    if not _tokenization_managed(db):
        return None
    return _read_tokenization(
        "tokenizationSearch",
        query=query,
        limit=limit,
        offset=offset,
        game_ids=list(game_ids),
        has_game_scope=bool(has_game_scope),
    )


def tokenization_word_card_data(db, *, word_ids):
    if not _tokenization_managed(db):
        return None
    return _read_tokenization("tokenizationWordCardData", word_ids=list(word_ids))


def tokenization_word_detail(db, *, word, game_ids=(), has_game_scope=False):
    if not _tokenization_managed(db):
        return None
    return _read_tokenization(
        "tokenizationWordDetail",
        word=word,
        game_ids=list(game_ids),
        has_game_scope=bool(has_game_scope),
    )


def tokenization_words_by_game(db, *, limit):
    if not _tokenization_managed(db):
        return None
    return _read_tokenization("tokenizationWordsByGame", limit=limit)


def tokenization_words_not_in_anki(db, filters, *, today, export_csv=False):
    if not _tokenization_managed(db):
        return None
    from GameSentenceMiner.util.config.configuration import get_config

    cfg = get_config().anki
    return _read_tokenization(
        "tokenizationWordsNotInAnki",
        limit=filters.limit,
        offset=filters.offset,
        search=filters.search,
        sort_col=filters.sort_col,
        sort_order=filters.sort_order,
        global_rank_min=filters.global_rank_min,
        global_rank_max=filters.global_rank_max,
        pos_filter=filters.pos_filter,
        exclude_pos=filters.exclude_pos,
        vocab_only=bool(filters.vocab_only),
        script_filter=filters.script_filter,
        game_ids=list(filters.game_ids),
        has_game_scope=bool(filters.has_game_scope),
        start_timestamp=filters.start_timestamp,
        end_timestamp=filters.end_timestamp,
        frequency_min=filters.frequency_min,
        frequency_max=filters.frequency_max,
        has_missing_anki_kanji=bool(filters.has_missing_anki_kanji),
        parent_tag=(cfg.parent_tag or "").strip() or "Game",
        word_field=(getattr(cfg, "word_field", "") or "").strip(),
        today=today.isoformat(),
        export_csv=bool(export_csv),
    )


def _dashboard_stats_managed(db):
    return db is not None and os.environ.get("GSM_NATIVE_DASHBOARD_STATS") == "1" and managed(db)


def _read_dashboard_stats(operation, **fields):
    from websockets.exceptions import ConnectionClosed

    try:
        return request(operation, **fields)
    except (OSError, ConnectionClosed, RuntimeError) as exc:
        from GameSentenceMiner.util.config.configuration import logger

        logger.debug(f"Reading {operation} locally after desktop query failed: {exc}")
        return None


def global_word_novelty(db, *, start_date, end_date, tokenization_enabled):
    if not _dashboard_stats_managed(db):
        return None
    return _read_dashboard_stats(
        "globalWordNovelty",
        start_date=start_date or None,
        end_date=end_date or None,
        tokenization_enabled=bool(tokenization_enabled),
    )


def game_word_novelty(db, *, game_id, first_date, last_date, tokenization_enabled):
    if not _dashboard_stats_managed(db):
        return None
    return _read_dashboard_stats(
        "gameWordNovelty",
        game_id=game_id,
        first_date=first_date or None,
        last_date=last_date or None,
        tokenization_enabled=bool(tokenization_enabled),
    )


def game_stats(db, *, game_id, today, session_gap, tokenization_enabled):
    if not _dashboard_stats_managed(db):
        return None
    return _read_dashboard_stats(
        "gameStats",
        game_id=game_id,
        today=today.isoformat(),
        session_gap=float(session_gap),
        tokenization_enabled=bool(tokenization_enabled),
    )


def dashboard_stats(
    db,
    *,
    today,
    session_gap,
    filter_year=None,
    start_timestamp=None,
    end_timestamp=None,
    include_tokenization=True,
    tokenization_enabled=False,
):
    if not _dashboard_stats_managed(db):
        return None
    return _read_dashboard_stats(
        "dashboardStats",
        today=today.isoformat(),
        session_gap=float(session_gap),
        filter_year=filter_year or None,
        start_timestamp=start_timestamp,
        end_timestamp=end_timestamp,
        include_tokenization=bool(include_tokenization),
        tokenization_enabled=bool(tokenization_enabled),
    )


def update_mined_line(db, **fields):
    # Make the transport choice before dispatch. A timeout after dispatch
    # cannot distinguish an uncommitted update from a lost reply.
    for key, value in fields.items():
        if value is None or isinstance(value, str):
            continue
        if key == "note_id" and type(value) is int and -(2**63) <= value < 2**63:
            continue
        return None
    if 512 + 6 * sum(len(value) for value in fields.values() if isinstance(value, str)) > 7 * 1024 * 1024:
        return None
    return db.run_external_write(lambda: request("updateMinedLine", **fields))


def capture_payload(lines, language, mode):
    # Keep whole imports atomic. Very large imports stay with the local writer
    # if their serialized request could exceed the 8 MiB broker frame.
    payload = []
    size_bound = 256 + 6 * len(language)
    for line in lines:
        size_bound += 128 + 6 * (len(line.id) + len(line.text) + len(line.scene or ""))
        if size_bound > 7 * 1024 * 1024:
            return None
        payload.append({"id": line.id, "scene": line.scene, "text": line.text, "timestamp": line.time.timestamp()})
    return {"mode": mode, "lines": payload, "language": language}
