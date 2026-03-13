"""
Tokenisation API Endpoints

Exposes word/kanji frequency data, dictionary-form search, and tokenisation
status from the normalised tokenisation tables. All endpoints are guarded by
the ``enable_tokenisation`` experimental config flag and return 404 when the
feature is off.
"""

from __future__ import annotations

import csv
import datetime
import io
import json
from collections import Counter
from dataclasses import dataclass
from functools import cmp_to_key

from flask import Response, jsonify, request

from GameSentenceMiner.util.config.configuration import logger, get_config
from GameSentenceMiner.util.config.feature_flags import is_tokenisation_enabled
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.global_frequency_tables import (
    get_active_global_frequency_source,
)
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.text_utils import is_kanji
from GameSentenceMiner.util.database.tokenisation_tables import WORD_STATS_CACHE_TABLE
from GameSentenceMiner.web.rollup_stats import aggregate_rollup_data


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tokenisation_disabled_response():
    return jsonify({"error": "Tokenisation is not enabled"}), 404


def _get_db():
    """Return the shared SQLiteDB instance from the table classes."""
    return GameLinesTable._db


def _get_card_data_for_words(db, word_ids: list[int]) -> dict:
    """Batch-fetch card-level data for a list of word IDs via the anki cache.

    Returns a dict mapping word_id → {"deck_name": str, "interval": int, "due": int}
    for words that have entries in word_anki_links → anki_cards.
    If a word has multiple cards, the first card (lowest card_id) is used.
    Returns an empty dict if the cache tables don't exist or no links are found.
    """
    if not word_ids:
        return {}
    try:
        placeholders = ", ".join(["?"] * len(word_ids))
        rows = db.fetchall(
            f"""
            SELECT wal.word_id, ac.deck_name, ac.interval, ac.due
            FROM word_anki_links wal
            JOIN anki_cards ac ON ac.note_id = wal.note_id
            WHERE wal.word_id IN ({placeholders})
            ORDER BY wal.word_id, ac.card_id
            """,
            tuple(word_ids),
        )
        result: dict = {}
        for row in rows:
            wid = int(row[0])
            if wid not in result:  # first card wins
                result[wid] = {
                    "deck_name": row[1],
                    "interval": int(row[2]) if row[2] not in (None, "") else None,
                    "due": int(row[3]) if row[3] not in (None, "") else None,
                }
        return result
    except Exception:
        # Cache tables may not exist yet — gracefully return empty
        return {}


def _parse_word_ids_arg(raw_word_ids: str | None, max_ids: int) -> list[int]:
    """Parse a comma-separated word_id list, dropping invalid values and duplicates."""
    if not raw_word_ids:
        return []

    parsed_ids: list[int] = []
    seen: set[int] = set()
    for part in raw_word_ids.split(","):
        value = part.strip()
        if not value:
            continue
        try:
            word_id = int(value)
        except ValueError:
            continue
        if word_id <= 0 or word_id in seen:
            continue
        parsed_ids.append(word_id)
        seen.add(word_id)
        if len(parsed_ids) >= max_ids:
            break

    return parsed_ids


def _get_words_not_in_anki_order_by(
    sort_col: str,
    sort_order: str,
    has_global_rank: bool,
    rank_sql: str = "wgf.rank",
    *,
    frequency_sql: str = "freq",
    word_sql: str = "w.word",
    reading_sql: str = "w.reading",
    pos_sql: str = "w.pos",
    id_sql: str = "w.id",
) -> str:
    """Return a stable ORDER BY clause for the not-in-Anki words query."""
    order_sql = "ASC" if sort_order.lower() == "asc" else "DESC"
    allowed_sorts = {
        "frequency": f"{frequency_sql} {order_sql}, {word_sql} ASC, {id_sql} ASC",
        "word": f"{word_sql} {order_sql}, {reading_sql} ASC, {id_sql} ASC",
        "reading": f"{reading_sql} {order_sql}, {word_sql} ASC, {id_sql} ASC",
        "pos": f"{pos_sql} {order_sql}, {word_sql} ASC, {id_sql} ASC",
    }
    if has_global_rank:
        allowed_sorts["global_rank"] = (
            f"{rank_sql} {order_sql}, {word_sql} ASC, {id_sql} ASC"
        )
    return allowed_sorts.get(sort_col, allowed_sorts["frequency"])


def _has_word_stats_cache(db) -> bool:
    return db.table_exists(WORD_STATS_CACHE_TABLE)


def _parse_optional_positive_int(raw_value: str | None) -> int | None:
    if raw_value is None:
        return None

    value = raw_value.strip()
    if not value:
        return None

    try:
        parsed = int(value)
    except ValueError:
        return None

    return parsed if parsed > 0 else None


def _parse_optional_int(raw_value: str | None) -> int | None:
    if raw_value is None:
        return None

    value = raw_value.strip()
    if not value:
        return None

    try:
        return int(value)
    except ValueError:
        return None


def _is_truthy_query_param(raw_value: str | None) -> bool:
    """Parse common truthy query-string values."""
    if raw_value is None:
        return False
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


def _normalize_query_values(raw_values: list[str] | None) -> tuple[str, ...]:
    """Return stripped, de-duplicated query values while preserving order."""
    normalized_values: list[str] = []
    seen: set[str] = set()
    for raw_value in raw_values or []:
        value = (raw_value or "").strip()
        if not value or value in seen:
            continue
        normalized_values.append(value)
        seen.add(value)
    return tuple(normalized_values)


_VOCAB_ONLY_EXCLUDED_POS = ("助詞", "助動詞", "フィラー", "接頭詞", "連体詞")
_VOCAB_ONLY_EXCLUDED_WORDS = ("こと", "よう", "もの")
# Match words that contain at least one CJK-script character.
_CJK_WORD_GLOB_PATTERN = "*[一-龯㐀-䶿ぁ-ゖゝゞァ-ヺーｦ-ﾟ가-힣]*"
_SCRIPT_FILTER_ALL = "all"
_SCRIPT_FILTER_CJK = "cjk"
_SCRIPT_FILTER_NON_CJK = "non_cjk"
_GAME_SCOPE_SELECTED = "selected"
_VALID_SCRIPT_FILTERS = {
    _SCRIPT_FILTER_ALL,
    _SCRIPT_FILTER_CJK,
    _SCRIPT_FILTER_NON_CJK,
}
_MATURE_INTERVAL_DAYS = 21
_MATURE_WORDS_SERIES_KEY = "mature_words"
_UNIQUE_KANJI_SERIES_KEY = "unique_kanji"
_WORDS_NOT_IN_ANKI_CSV_FILENAME = "gsm_words_not_in_anki.csv"
_UNKNOWN_GAME_LABEL = "Unknown game"


@dataclass(frozen=True)
class WordsNotInAnkiFilters:
    limit: int | None
    offset: int
    search: str | None
    sort_col: str
    sort_order: str
    global_rank_min: int | None
    global_rank_max: int | None
    pos_filter: str | None
    exclude_pos: str | None
    vocab_only: bool
    script_filter: str
    game_ids: tuple[str, ...]
    has_game_scope: bool
    start_timestamp: int | None
    end_timestamp: int | None
    frequency_min: int | None
    frequency_max: int | None
    has_missing_anki_kanji: bool

    @property
    def has_timestamp_scope(self) -> bool:
        return self.start_timestamp is not None or self.end_timestamp is not None


@dataclass(frozen=True)
class WordsNotInAnkiQueryResult:
    rows: list[tuple[int, str, str, str, int, int | None]]
    total_count: int
    frequency_bounds: dict[str, int | None]
    global_rank_bounds: dict[str, int | None]
    global_rank_source: dict | None


def _normalize_optional_query_text(raw_value: str | None) -> str | None:
    if raw_value is None:
        return None

    value = raw_value.strip()
    return value or None


def _normalize_script_filter(
    raw_script_filter: str | None, legacy_cjk_only: str | None
) -> str:
    normalized = (raw_script_filter or "").strip().lower()
    if normalized in _VALID_SCRIPT_FILTERS:
        return normalized
    if _is_truthy_query_param(legacy_cjk_only):
        return _SCRIPT_FILTER_CJK
    return _SCRIPT_FILTER_ALL


def _parse_game_scope_args() -> tuple[tuple[str, ...], bool]:
    game_ids = _normalize_query_values(request.args.getlist("game_id"))
    raw_scope = (request.args.get("game_scope") or "").strip().lower()
    has_game_scope = raw_scope == _GAME_SCOPE_SELECTED or bool(game_ids)
    return game_ids, has_game_scope


def _parse_words_not_in_anki_filters(*, paginated: bool) -> WordsNotInAnkiFilters:
    limit = None
    offset = 0
    if paginated:
        limit = min(max(int(request.args.get("limit", 100)), 0), 1000)
        offset = max(int(request.args.get("offset", 0)), 0)

    global_rank_min = _parse_optional_positive_int(request.args.get("global_rank_min"))
    global_rank_max = _parse_optional_positive_int(request.args.get("global_rank_max"))
    if (
        global_rank_min is not None
        and global_rank_max is not None
        and global_rank_min > global_rank_max
    ):
        global_rank_min, global_rank_max = global_rank_max, global_rank_min

    frequency_min = _parse_optional_positive_int(request.args.get("frequency_min"))
    frequency_max = _parse_optional_positive_int(request.args.get("frequency_max"))
    if (
        frequency_min is not None
        and frequency_max is not None
        and frequency_min > frequency_max
    ):
        frequency_min, frequency_max = frequency_max, frequency_min

    start_timestamp = _parse_optional_int(request.args.get("start_timestamp"))
    end_timestamp = _parse_optional_int(request.args.get("end_timestamp"))
    if (
        start_timestamp is not None
        and end_timestamp is not None
        and start_timestamp > end_timestamp
    ):
        start_timestamp, end_timestamp = end_timestamp, start_timestamp

    game_ids, has_game_scope = _parse_game_scope_args()

    return WordsNotInAnkiFilters(
        limit=limit,
        offset=offset,
        search=_normalize_optional_query_text(request.args.get("search")),
        sort_col=request.args.get("sort", "frequency"),
        sort_order=request.args.get("order", "desc"),
        global_rank_min=global_rank_min,
        global_rank_max=global_rank_max,
        pos_filter=_normalize_optional_query_text(request.args.get("pos")),
        exclude_pos=_normalize_optional_query_text(request.args.get("exclude_pos")),
        vocab_only=_is_truthy_query_param(request.args.get("vocab_only")),
        script_filter=_normalize_script_filter(
            request.args.get("script_filter"),
            request.args.get("cjk_only"),
        ),
        game_ids=game_ids,
        has_game_scope=has_game_scope,
        start_timestamp=start_timestamp,
        end_timestamp=end_timestamp,
        frequency_min=frequency_min,
        frequency_max=frequency_max,
        has_missing_anki_kanji=_is_truthy_query_param(
            request.args.get("has_missing_anki_kanji")
        ),
    )


def _build_words_not_in_anki_word_conditions(
    filters: WordsNotInAnkiFilters,
) -> tuple[list[str], list]:
    """Build shared metadata-only WHERE conditions for the not-in-Anki query."""
    conditions = [
        "(w.in_anki = 0 OR w.in_anki IS NULL)",
        "w.pos NOT IN ('記号', 'その他')",
    ]
    condition_params: list = []

    if filters.vocab_only:
        placeholders = ",".join("?" for _ in _VOCAB_ONLY_EXCLUDED_POS)
        conditions.append(f"w.pos NOT IN ({placeholders})")
        condition_params.extend(_VOCAB_ONLY_EXCLUDED_POS)
        placeholders = ",".join("?" for _ in _VOCAB_ONLY_EXCLUDED_WORDS)
        conditions.append(f"w.word NOT IN ({placeholders})")
        condition_params.extend(_VOCAB_ONLY_EXCLUDED_WORDS)

    if filters.script_filter == _SCRIPT_FILTER_CJK:
        conditions.append("w.word GLOB ?")
        condition_params.append(_CJK_WORD_GLOB_PATTERN)
    elif filters.script_filter == _SCRIPT_FILTER_NON_CJK:
        conditions.append("w.word NOT GLOB ?")
        condition_params.append(_CJK_WORD_GLOB_PATTERN)

    if filters.pos_filter:
        pos_values = _expand_pos_shorthand(filters.pos_filter)
        placeholders = ",".join("?" for _ in pos_values)
        conditions.append(f"w.pos IN ({placeholders})")
        condition_params.extend(pos_values)

    if filters.exclude_pos:
        exclude_values = _expand_pos_shorthand(filters.exclude_pos)
        placeholders = ",".join("?" for _ in exclude_values)
        conditions.append(f"w.pos NOT IN ({placeholders})")
        condition_params.extend(exclude_values)

    if filters.search:
        conditions.append("(w.word LIKE ? OR w.reading LIKE ?)")
        condition_params.extend([f"%{filters.search}%", f"%{filters.search}%"])

    return conditions, condition_params


def _build_words_not_in_anki_occurrence_conditions(
    filters: WordsNotInAnkiFilters,
    *,
    game_id_sql: str = "gl.game_id",
    timestamp_sql: str = "gl.timestamp",
) -> tuple[list[str], list]:
    """Build shared occurrence-scope WHERE conditions for not-in-Anki queries."""
    conditions: list[str] = []
    condition_params: list = []

    if filters.start_timestamp is not None:
        conditions.append(f"{timestamp_sql} >= ?")
        condition_params.append(max(0, filters.start_timestamp / 1000.0))

    if filters.end_timestamp is not None:
        conditions.append(f"{timestamp_sql} <= ?")
        condition_params.append(max(0, filters.end_timestamp / 1000.0))

    if filters.has_game_scope:
        if not filters.game_ids:
            conditions.append("1 = 0")
        else:
            placeholders = ",".join("?" for _ in filters.game_ids)
            conditions.append(f"{game_id_sql} IN ({placeholders})")
            condition_params.extend(filters.game_ids)

    return conditions, condition_params


def _build_words_not_in_anki_metadata_query(
    filters: WordsNotInAnkiFilters,
    active_global_source: dict | None,
) -> tuple[str, list]:
    """Build the cheap metadata query used by cache/rollup-backed word lookups."""
    conditions, condition_params = _build_words_not_in_anki_word_conditions(filters)
    where = " AND ".join(conditions)

    join_sql = ""
    join_params: list = []
    rank_select_sql = "NULL AS global_rank"
    if active_global_source is not None:
        join_sql = """
        LEFT JOIN word_global_frequencies wgf
            ON wgf.word = w.word AND wgf.source_id = ?
        """
        join_params.append(active_global_source["id"])
        rank_select_sql = "wgf.rank AS global_rank"

    query = f"""
        SELECT
            w.id AS word_id,
            w.word AS word,
            w.reading AS reading,
            w.pos AS pos,
            {rank_select_sql}
        FROM words w
        {join_sql}
        WHERE {where}
    """
    return query, join_params + condition_params


def _is_full_day_timestamp_range(
    start_timestamp: int | None, end_timestamp: int | None
) -> bool:
    """Return True when the timestamp range matches whole local calendar days."""
    if start_timestamp is None or end_timestamp is None:
        return False

    try:
        start_dt = datetime.datetime.fromtimestamp(max(0, start_timestamp / 1000.0))
        end_dt = datetime.datetime.fromtimestamp(max(0, end_timestamp / 1000.0))
    except (OverflowError, OSError, ValueError):
        return False

    return start_dt.time() == datetime.time.min and end_dt.time() >= datetime.time(
        23, 59, 59, 900000
    )


def _load_words_not_in_anki_rollup_frequencies(
    filters: WordsNotInAnkiFilters,
) -> Counter[str] | None:
    """Aggregate day-scoped word frequencies from rollups plus today's live token data."""
    if filters.has_game_scope:
        return None

    if not _is_full_day_timestamp_range(filters.start_timestamp, filters.end_timestamp):
        return None

    start_date = datetime.datetime.fromtimestamp(
        max(0, filters.start_timestamp / 1000.0)
    ).date()
    end_date = datetime.datetime.fromtimestamp(
        max(0, filters.end_timestamp / 1000.0)
    ).date()
    today = datetime.date.today()
    frequencies: Counter[str] = Counter()

    historical_end = min(end_date, today - datetime.timedelta(days=1))
    used_rollups = False
    if start_date <= historical_end:
        rollups = StatsRollupTable.get_date_range(
            start_date.isoformat(), historical_end.isoformat()
        )
        if not rollups:
            return None

        rollup_stats = aggregate_rollup_data(rollups)
        rollup_words = rollup_stats.get("word_frequency_data", {})
        if isinstance(rollup_words, dict):
            for word, count in rollup_words.items():
                frequencies[str(word)] += int(count or 0)
        used_rollups = True

    if start_date <= today <= end_date:
        from GameSentenceMiner.util.cron.daily_rollup import (
            analyze_word_data_from_tokens,
        )

        today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
        tomorrow_start = datetime.datetime.combine(
            today + datetime.timedelta(days=1), datetime.time.min
        ).timestamp()
        live_words = analyze_word_data_from_tokens(today_start, tomorrow_start)
        for word, count in live_words.get("frequencies", {}).items():
            frequencies[str(word)] += int(count or 0)

    if not used_rollups and not (start_date <= today <= end_date):
        return None

    return frequencies


def _compare_text(left: str, right: str) -> int:
    if left < right:
        return -1
    if left > right:
        return 1
    return 0


def _compare_int(left: int, right: int) -> int:
    if left < right:
        return -1
    if left > right:
        return 1
    return 0


def _compare_words_not_in_anki_entries(
    left: dict, right: dict, sort_col: str, sort_order: str
) -> int:
    descending = sort_order.lower() != "asc"

    if sort_col == "frequency":
        result = _compare_int(left["frequency"], right["frequency"])
        if descending:
            result = -result
        if result:
            return result
        result = _compare_text(left["word"], right["word"])
        if result:
            return result
        return _compare_int(left["word_id"], right["word_id"])

    if sort_col == "global_rank":
        result = _compare_int(left["global_rank"], right["global_rank"])
        if descending:
            result = -result
        if result:
            return result
        result = _compare_text(left["word"], right["word"])
        if result:
            return result
        return _compare_int(left["word_id"], right["word_id"])

    if sort_col == "word":
        result = _compare_text(left["word"], right["word"])
        if descending:
            result = -result
        if result:
            return result
        result = _compare_text(left["reading"], right["reading"])
        if result:
            return result
        return _compare_int(left["word_id"], right["word_id"])

    if sort_col == "reading":
        result = _compare_text(left["reading"], right["reading"])
        if descending:
            result = -result
        if result:
            return result
        result = _compare_text(left["word"], right["word"])
        if result:
            return result
        return _compare_int(left["word_id"], right["word_id"])

    result = _compare_text(left["pos"], right["pos"])
    if descending:
        result = -result
    if result:
        return result
    result = _compare_text(left["word"], right["word"])
    if result:
        return result
    return _compare_int(left["word_id"], right["word_id"])


def _get_full_collection_anki_kanji() -> set[str]:
    """Return the full cached Anki kanji set using the shared Anki stats logic."""
    from GameSentenceMiner.web.anki_api_endpoints import _get_anki_kanji_from_cache

    return _get_anki_kanji_from_cache()


def _word_has_missing_anki_kanji(word: str, anki_kanji_set: set[str]) -> bool:
    """Return True when the word contains at least one kanji not present in Anki."""
    return any(is_kanji(char) and char not in anki_kanji_set for char in word)


def _build_words_not_in_anki_query_result_from_entries(
    raw_entries: list[dict],
    filters: WordsNotInAnkiFilters,
    active_global_source: dict | None,
) -> WordsNotInAnkiQueryResult:
    """Apply shared filtering, bounds, sorting, and pagination to word entries."""
    has_global_rank_source = active_global_source is not None
    effective_sort_col = filters.sort_col
    if effective_sort_col == "global_rank" and not has_global_rank_source:
        effective_sort_col = "frequency"

    entries = raw_entries
    if filters.has_missing_anki_kanji:
        anki_kanji_set = _get_full_collection_anki_kanji()
        entries = [
            entry
            for entry in entries
            if _word_has_missing_anki_kanji(str(entry["word"] or ""), anki_kanji_set)
        ]

    frequency_bounds = {"min": None, "max": None}
    if entries:
        available_frequencies = [int(entry["frequency"]) for entry in entries]
        frequency_bounds = {
            "min": min(available_frequencies),
            "max": max(available_frequencies),
        }

    if filters.frequency_min is not None:
        entries = [
            entry for entry in entries if int(entry["frequency"]) >= filters.frequency_min
        ]
    if filters.frequency_max is not None:
        entries = [
            entry for entry in entries if int(entry["frequency"]) <= filters.frequency_max
        ]

    rank_bounds = {"min": None, "max": None}
    if has_global_rank_source:
        available_ranks = [
            int(entry["global_rank"])
            for entry in entries
            if entry["global_rank"] is not None
        ]
        if available_ranks:
            rank_bounds = {
                "min": min(available_ranks),
                "max": max(available_ranks),
            }

    if has_global_rank_source and (
        effective_sort_col == "global_rank"
        or filters.global_rank_min is not None
        or filters.global_rank_max is not None
    ):
        entries = [entry for entry in entries if entry["global_rank"] is not None]

    if filters.global_rank_min is not None:
        entries = [
            entry
            for entry in entries
            if entry["global_rank"] is not None
            and int(entry["global_rank"]) >= filters.global_rank_min
        ]
    if filters.global_rank_max is not None:
        entries = [
            entry
            for entry in entries
            if entry["global_rank"] is not None
            and int(entry["global_rank"]) <= filters.global_rank_max
        ]

    entries.sort(
        key=cmp_to_key(
            lambda left, right: _compare_words_not_in_anki_entries(
                left, right, effective_sort_col, filters.sort_order
            )
        )
    )
    total_count = len(entries)

    if filters.limit is not None:
        entries = entries[filters.offset : filters.offset + filters.limit]

    rows = [
        (
            int(entry["word_id"]),
            str(entry["word"] or ""),
            str(entry["reading"] or ""),
            str(entry["pos"] or ""),
            int(entry["frequency"]),
            int(entry["global_rank"]) if entry["global_rank"] is not None else None,
        )
        for entry in entries
    ]
    return WordsNotInAnkiQueryResult(
        rows=rows,
        total_count=total_count,
        frequency_bounds=frequency_bounds,
        global_rank_bounds=rank_bounds,
        global_rank_source=active_global_source,
    )


def _query_words_not_in_anki_from_rollups(
    db, filters: WordsNotInAnkiFilters
) -> WordsNotInAnkiQueryResult | None:
    """Serve day-scoped queries from rollups instead of re-counting occurrences."""
    frequencies = _load_words_not_in_anki_rollup_frequencies(filters)
    if frequencies is None:
        return None

    active_global_source = get_active_global_frequency_source(db)

    metadata_query, metadata_params = _build_words_not_in_anki_metadata_query(
        filters, active_global_source
    )
    metadata_rows = db.fetchall(metadata_query, tuple(metadata_params))

    raw_entries: list[dict] = []
    for row in metadata_rows:
        frequency = int(frequencies.get(str(row[1]), 0) or 0)
        if frequency <= 0:
            continue
        raw_entries.append(
            {
                "word_id": int(row[0]),
                "word": str(row[1] or ""),
                "reading": str(row[2] or ""),
                "pos": str(row[3] or ""),
                "frequency": frequency,
                "global_rank": int(row[4]) if row[4] is not None else None,
            }
        )
    return _build_words_not_in_anki_query_result_from_entries(
        raw_entries, filters, active_global_source
    )


def _build_words_not_in_anki_source_query(
    db, filters: WordsNotInAnkiFilters, active_global_source: dict | None
) -> tuple[str, list]:
    conditions, condition_params = _build_words_not_in_anki_word_conditions(filters)

    use_word_stats_cache = (
        _has_word_stats_cache(db)
        and not filters.has_timestamp_scope
        and not filters.has_game_scope
    )
    has_global_rank_source = active_global_source is not None

    if use_word_stats_cache:
        where = " AND ".join(["ws.occurrence_count > 0", *conditions])
        source_query = f"""
            SELECT
                w.id AS word_id,
                w.word AS word,
                w.reading AS reading,
                w.pos AS pos,
                ws.occurrence_count AS frequency,
                ws.active_global_rank AS global_rank
            FROM {WORD_STATS_CACHE_TABLE} ws
            JOIN words w ON w.id = ws.word_id
            WHERE {where}
        """
        return source_query, condition_params

    occurrence_conditions, occurrence_params = (
        _build_words_not_in_anki_occurrence_conditions(filters)
    )
    conditions.extend(occurrence_conditions)
    condition_params.extend(occurrence_params)

    join_sql = ""
    join_params: list = []
    rank_select_sql = "NULL AS global_rank"
    group_rank_sql = ""
    if has_global_rank_source:
        join_sql = """
        LEFT JOIN word_global_frequencies wgf
            ON wgf.word = w.word AND wgf.source_id = ?
        """
        join_params.append(active_global_source["id"])
        rank_select_sql = "wgf.rank AS global_rank"
        group_rank_sql = ", wgf.rank"

    where = " AND ".join(conditions)
    source_query = f"""
        SELECT
            w.id AS word_id,
            w.word AS word,
            w.reading AS reading,
            w.pos AS pos,
            COUNT(*) AS frequency,
            {rank_select_sql}
        FROM word_occurrences wo
        JOIN words w ON w.id = wo.word_id
        JOIN game_lines gl ON gl.id = wo.line_id
        {join_sql}
        WHERE {where}
        GROUP BY w.id, w.word, w.reading, w.pos{group_rank_sql}
    """
    return source_query, join_params + condition_params


def _build_words_not_in_anki_base_query(
    db, filters: WordsNotInAnkiFilters, active_global_source: dict | None
) -> tuple[str, list]:
    source_query, source_params = _build_words_not_in_anki_source_query(
        db, filters, active_global_source
    )
    base_query = f"SELECT * FROM ({source_query}) base"
    base_params = list(source_params)

    outer_conditions: list[str] = []
    outer_params: list[int] = []
    if filters.frequency_min is not None:
        outer_conditions.append("base.frequency >= ?")
        outer_params.append(filters.frequency_min)
    if filters.frequency_max is not None:
        outer_conditions.append("base.frequency <= ?")
        outer_params.append(filters.frequency_max)

    if outer_conditions:
        base_query = f"{base_query} WHERE {' AND '.join(outer_conditions)}"
        base_params.extend(outer_params)

    return base_query, base_params


def _build_words_not_in_anki_rank_filters(
    filters: WordsNotInAnkiFilters,
    has_global_rank_source: bool,
    effective_sort_col: str,
    *,
    rank_sql: str = "base.global_rank",
) -> tuple[str, list[int]]:
    if not has_global_rank_source:
        return "", []

    rank_conditions: list[str] = []
    rank_params: list[int] = []

    if (
        effective_sort_col == "global_rank"
        or filters.global_rank_min is not None
        or filters.global_rank_max is not None
    ):
        rank_conditions.append(f"{rank_sql} IS NOT NULL")

    if filters.global_rank_min is not None:
        rank_conditions.append(f"{rank_sql} >= ?")
        rank_params.append(filters.global_rank_min)
    if filters.global_rank_max is not None:
        rank_conditions.append(f"{rank_sql} <= ?")
        rank_params.append(filters.global_rank_max)

    if not rank_conditions:
        return "", []

    return f" WHERE {' AND '.join(rank_conditions)}", rank_params


def _query_words_not_in_anki(
    db, filters: WordsNotInAnkiFilters
) -> WordsNotInAnkiQueryResult:
    if filters.has_game_scope and not filters.game_ids:
        return WordsNotInAnkiQueryResult(
            rows=[],
            total_count=0,
            frequency_bounds={"min": None, "max": None},
            global_rank_bounds={"min": None, "max": None},
            global_rank_source=get_active_global_frequency_source(db),
        )

    rollup_result = _query_words_not_in_anki_from_rollups(db, filters)
    if rollup_result is not None:
        return rollup_result

    active_global_source = get_active_global_frequency_source(db)
    has_global_rank_source = active_global_source is not None
    effective_sort_col = filters.sort_col
    if effective_sort_col == "global_rank" and not has_global_rank_source:
        effective_sort_col = "frequency"

    if filters.has_missing_anki_kanji:
        source_query, source_params = _build_words_not_in_anki_source_query(
            db, filters, active_global_source
        )
        raw_entries = [
            {
                "word_id": int(row[0]),
                "word": str(row[1] or ""),
                "reading": str(row[2] or ""),
                "pos": str(row[3] or ""),
                "frequency": int(row[4]),
                "global_rank": int(row[5]) if row[5] is not None else None,
            }
            for row in db.fetchall(source_query, tuple(source_params))
        ]
        return _build_words_not_in_anki_query_result_from_entries(
            raw_entries, filters, active_global_source
        )

    source_query, source_params = _build_words_not_in_anki_source_query(
        db, filters, active_global_source
    )
    frequency_conditions: list[str] = []
    frequency_params: list[int] = []
    if filters.frequency_min is not None:
        frequency_conditions.append("source.frequency >= ?")
        frequency_params.append(filters.frequency_min)
    if filters.frequency_max is not None:
        frequency_conditions.append("source.frequency <= ?")
        frequency_params.append(filters.frequency_max)
    frequency_where_sql = ""
    if frequency_conditions:
        frequency_where_sql = f"WHERE {' AND '.join(frequency_conditions)}"
    annotated_rank_where_sql, rank_params = _build_words_not_in_anki_rank_filters(
        filters,
        has_global_rank_source,
        effective_sort_col,
        rank_sql="annotated.global_rank",
    )
    filtered_order_by_sql = _get_words_not_in_anki_order_by(
        effective_sort_col,
        filters.sort_order,
        has_global_rank_source,
        rank_sql="filtered.global_rank",
        frequency_sql="filtered.frequency",
        word_sql="filtered.word",
        reading_sql="filtered.reading",
        pos_sql="filtered.pos",
        id_sql="filtered.word_id",
    )
    paged_order_by_sql = _get_words_not_in_anki_order_by(
        effective_sort_col,
        filters.sort_order,
        has_global_rank_source,
        rank_sql="paged.global_rank",
        frequency_sql="paged.frequency",
        word_sql="paged.word",
        reading_sql="paged.reading",
        pos_sql="paged.pos",
        id_sql="paged.word_id",
    )

    query = f"""
        WITH source AS (
            {source_query}
        ),
        annotated AS (
            SELECT
                base.word_id,
                base.word,
                base.reading,
                base.pos,
                base.frequency,
                base.global_rank,
                MIN(base.global_rank) OVER () AS global_rank_min,
                MAX(base.global_rank) OVER () AS global_rank_max
            FROM (
                SELECT *
                FROM source
                {frequency_where_sql}
            ) base
        ),
        filtered AS (
            SELECT
                annotated.word_id,
                annotated.word,
                annotated.reading,
                annotated.pos,
                annotated.frequency,
                annotated.global_rank,
                annotated.global_rank_min,
                annotated.global_rank_max,
                COUNT(*) OVER () AS filtered_total
            FROM annotated
            {annotated_rank_where_sql}
        ),
        paged AS (
            SELECT *
            FROM filtered
            ORDER BY {filtered_order_by_sql}
        """
    query_params = list(source_params) + frequency_params + rank_params
    if filters.limit is not None:
        query += "\nLIMIT ? OFFSET ?"
        query_params.extend([filters.limit, filters.offset])
    query += f"""
        ),
        summary AS (
            SELECT
                COALESCE((SELECT MAX(filtered_total) FROM filtered), 0) AS filtered_total,
                (SELECT MIN(global_rank) FROM annotated WHERE global_rank IS NOT NULL) AS global_rank_min,
                (SELECT MAX(global_rank) FROM annotated WHERE global_rank IS NOT NULL) AS global_rank_max,
                (SELECT MIN(frequency) FROM source) AS frequency_min,
                (SELECT MAX(frequency) FROM source) AS frequency_max
        )
        SELECT
            paged.word_id,
            paged.word,
            paged.reading,
            paged.pos,
            paged.frequency,
            paged.global_rank,
            summary.filtered_total,
            summary.global_rank_min,
            summary.global_rank_max,
            summary.frequency_min,
            summary.frequency_max
        FROM summary
        LEFT JOIN paged ON 1 = 1
        ORDER BY {paged_order_by_sql}
    """
    raw_rows = db.fetchall(query, tuple(query_params))

    total_count = 0
    frequency_bounds = {"min": None, "max": None}
    rank_bounds = {"min": None, "max": None}
    if raw_rows:
        total_count = int(raw_rows[0][6] or 0)
        if raw_rows[0][9] is not None and raw_rows[0][10] is not None:
            frequency_bounds = {
                "min": int(raw_rows[0][9]),
                "max": int(raw_rows[0][10]),
            }
        if (
            has_global_rank_source
            and raw_rows[0][7] is not None
            and raw_rows[0][8] is not None
        ):
            rank_bounds = {
                "min": int(raw_rows[0][7]),
                "max": int(raw_rows[0][8]),
            }

    rows = [
        (
            int(row[0]),
            row[1],
            row[2],
            row[3],
            int(row[4]),
            int(row[5]) if row[5] is not None else None,
        )
        for row in raw_rows
        if row[0] is not None
    ]

    return WordsNotInAnkiQueryResult(
        rows=rows,
        total_count=total_count,
        frequency_bounds=frequency_bounds,
        global_rank_bounds=rank_bounds,
        global_rank_source=active_global_source,
    )


def _query_words_not_in_anki_export_game_sentences(
    db,
    filters: WordsNotInAnkiFilters,
    word_ids: list[int],
) -> tuple[list[str], dict[int, dict[str, str]]]:
    """Batch-load per-game sentence cells for the exported not-in-Anki rows."""
    if not word_ids:
        return [], {}

    word_placeholders = ",".join("?" for _ in word_ids)
    occurrence_conditions, occurrence_params = (
        _build_words_not_in_anki_occurrence_conditions(filters)
    )
    where_conditions = [f"wo.word_id IN ({word_placeholders})", *occurrence_conditions]
    query = f"""
        SELECT
            wo.word_id,
            COALESCE(NULLIF(TRIM(gl.game_name), ''), ?) AS export_game_name,
            gl.line_text
        FROM word_occurrences wo
        JOIN game_lines gl ON gl.id = wo.line_id
        WHERE {' AND '.join(where_conditions)}
        ORDER BY wo.word_id ASC, export_game_name ASC, gl.timestamp DESC, gl.id DESC
    """
    rows = db.fetchall(
        query,
        tuple([_UNKNOWN_GAME_LABEL, *word_ids, *occurrence_params]),
    )

    seen_sentence_texts: dict[int, dict[str, set[str]]] = {}
    sentence_lists: dict[int, dict[str, list[str]]] = {}
    game_names: set[str] = set()

    for raw_word_id, raw_game_name, raw_line_text in rows:
        word_id = int(raw_word_id)
        game_name = str(raw_game_name or _UNKNOWN_GAME_LABEL)
        line_text = str(raw_line_text or "")
        if not line_text:
            continue

        word_seen = seen_sentence_texts.setdefault(word_id, {})
        game_seen = word_seen.setdefault(game_name, set())
        if line_text in game_seen:
            continue

        game_seen.add(line_text)
        game_names.add(game_name)
        sentence_lists.setdefault(word_id, {}).setdefault(game_name, []).append(line_text)

    sentence_cells = {
        word_id: {
            game_name: "\n".join(sentences)
            for game_name, sentences in sentences_by_game.items()
        }
        for word_id, sentences_by_game in sentence_lists.items()
    }
    sorted_game_names = sorted(game_names, key=lambda value: (value.casefold(), value))
    return sorted_game_names, sentence_cells


def _empty_maturity_series(label: str, series_length: int = 0) -> dict:
    return {
        "label": label,
        "daily_new": [0] * series_length if series_length else [],
        "cumulative": [0] * series_length if series_length else [],
        "total": 0,
    }


def _empty_maturity_history_response(labels: list[str] | None = None) -> dict:
    label_list = labels or []
    series_length = len(label_list)
    return {
        "labels": label_list,
        "series": {
            _MATURE_WORDS_SERIES_KEY: _empty_maturity_series(
                "Mature Words", series_length
            ),
            _UNIQUE_KANJI_SERIES_KEY: _empty_maturity_series(
                "Unique Kanji", series_length
            ),
        },
    }


def _row_timestamps_to_dates(
    rows: list[tuple[int, int | float | str]],
    *,
    timestamp_divisor: float,
    fallback_date: datetime.date | None = None,
) -> dict[int, datetime.date]:
    item_dates: dict[int, datetime.date] = {}
    default_date = fallback_date or datetime.date.today()

    for item_id, raw_timestamp in rows:
        if item_id is None:
            continue

        parsed_date = default_date
        if raw_timestamp not in (None, ""):
            try:
                parsed_date = datetime.datetime.fromtimestamp(
                    float(raw_timestamp) / timestamp_divisor
                ).date()
            except (OverflowError, OSError, TypeError, ValueError):
                parsed_date = default_date

        item_dates[int(item_id)] = parsed_date
    return item_dates


def _merge_primary_and_fallback_dates(
    primary_dates: dict[int, datetime.date], fallback_dates: dict[int, datetime.date]
) -> dict[int, datetime.date]:
    merged_dates = dict(primary_dates)
    for item_id, item_date in fallback_dates.items():
        merged_dates.setdefault(item_id, item_date)
    return merged_dates


def _extract_note_word_value(
    fields_json_raw: str | dict | None, configured_word_field: str
) -> str | None:
    if fields_json_raw in (None, ""):
        return None

    fields_obj = fields_json_raw
    if isinstance(fields_obj, str):
        try:
            fields_obj = json.loads(fields_obj)
        except (json.JSONDecodeError, TypeError):
            return None
    if not isinstance(fields_obj, dict):
        return None

    if configured_word_field:
        configured_field_obj = fields_obj.get(configured_word_field)
        if isinstance(configured_field_obj, dict):
            configured_value = configured_field_obj.get("value")
            if isinstance(configured_value, str):
                stripped = configured_value.strip()
                if stripped:
                    return stripped

    for field_obj in fields_obj.values():
        if not isinstance(field_obj, dict):
            continue
        fallback_value = field_obj.get("value")
        if isinstance(fallback_value, str):
            stripped = fallback_value.strip()
            if stripped:
                return stripped

    return None


def _get_note_values_for_ids(db, note_ids: list[int]) -> dict[int, str]:
    if db is None or not db.table_exists("anki_notes") or not note_ids:
        return {}

    configured_word_field = (get_config().anki.word_field or "").strip()
    note_values: dict[int, str] = {}
    chunk_size = 500
    for start in range(0, len(note_ids), chunk_size):
        chunk = note_ids[start : start + chunk_size]
        placeholders = ", ".join(["?"] * len(chunk))
        rows = db.fetchall(
            f"SELECT note_id, fields_json FROM anki_notes WHERE note_id IN ({placeholders})",
            tuple(chunk),
        )
        for note_id_raw, fields_json_raw in rows:
            try:
                note_id = int(note_id_raw)
            except (TypeError, ValueError):
                continue
            note_word = _extract_note_word_value(fields_json_raw, configured_word_field)
            if note_word:
                note_values[note_id] = note_word

    return note_values


def _collapse_note_dates_to_word_dates(
    db, note_dates: dict[int, datetime.date]
) -> dict[str, datetime.date]:
    if not note_dates:
        return {}

    note_values = _get_note_values_for_ids(db, list(note_dates.keys()))
    word_dates: dict[str, datetime.date] = {}
    for note_id, note_date in note_dates.items():
        word_key = note_values.get(note_id)
        if not word_key:
            continue
        existing_date = word_dates.get(word_key)
        if existing_date is None or note_date < existing_date:
            word_dates[word_key] = note_date
    return word_dates


def _get_first_mature_note_review_dates(db) -> dict[int, datetime.date]:
    if db is None or not db.table_exists("anki_reviews"):
        return {}

    if db.table_exists("anki_cards"):
        rows = db.fetchall(
            """
            SELECT merged.note_id, MIN(merged.review_time) AS first_mature_review_time
            FROM (
                SELECT CAST(ar.note_id AS INTEGER) AS note_id, ar.review_time
                FROM anki_reviews ar
                WHERE CAST(ar.interval AS INTEGER) >= ?
                  AND CAST(ar.note_id AS INTEGER) > 0

                UNION ALL

                SELECT CAST(ac.note_id AS INTEGER) AS note_id, ar.review_time
                FROM anki_reviews ar
                -- card_id is already stored as the PK type in both tables; avoid
                -- CAST() on the join so SQLite can use the existing indexes.
                JOIN anki_cards ac ON ac.card_id = ar.card_id
                WHERE CAST(ar.interval AS INTEGER) >= ?
                  AND CAST(ac.note_id AS INTEGER) > 0
            ) merged
            GROUP BY merged.note_id
            """,
            (_MATURE_INTERVAL_DAYS, _MATURE_INTERVAL_DAYS),
        )
    else:
        rows = db.fetchall(
            """
            SELECT CAST(ar.note_id AS INTEGER), MIN(ar.review_time) AS first_mature_review_time
            FROM anki_reviews ar
            WHERE CAST(ar.interval AS INTEGER) >= ?
              AND CAST(ar.note_id AS INTEGER) > 0
            GROUP BY CAST(ar.note_id AS INTEGER)
            """,
            (_MATURE_INTERVAL_DAYS,),
        )
    return _row_timestamps_to_dates(rows, timestamp_divisor=1000)


def _get_first_mature_note_card_dates(db) -> dict[int, datetime.date]:
    if db is None or not db.table_exists("anki_cards"):
        return {}

    rows = db.fetchall(
        """
        SELECT CAST(ac.note_id AS INTEGER), MIN(ac.synced_at) AS first_seen_mature_sync_time
        FROM anki_cards ac
        WHERE CAST(ac.interval AS INTEGER) >= ?
          AND CAST(ac.note_id AS INTEGER) > 0
        GROUP BY CAST(ac.note_id AS INTEGER)
        """,
        (_MATURE_INTERVAL_DAYS,),
    )
    return _row_timestamps_to_dates(rows, timestamp_divisor=1)


def _get_first_mature_word_dates(db) -> dict[str, datetime.date]:
    """Return first mature dates from Anki cache, without requiring tokenisation links."""
    review_dates = _get_first_mature_note_review_dates(db)
    fallback_dates = _get_first_mature_note_card_dates(db)
    note_dates = _merge_primary_and_fallback_dates(review_dates, fallback_dates)
    return _collapse_note_dates_to_word_dates(db, note_dates)


def _get_first_mature_kanji_review_dates(db) -> dict[int, datetime.date]:
    if (
        db is None
        or not db.table_exists("card_kanji_links")
        or not db.table_exists("anki_reviews")
    ):
        return {}

    rows = db.fetchall(
        """
        SELECT ckl.kanji_id, MIN(ar.review_time) AS first_mature_review_time
        FROM card_kanji_links ckl
        JOIN anki_reviews ar ON ar.card_id = ckl.card_id
        WHERE ar.interval >= ?
        GROUP BY ckl.kanji_id
        """,
        (_MATURE_INTERVAL_DAYS,),
    )
    return _row_timestamps_to_dates(rows, timestamp_divisor=1000)


def _get_first_mature_kanji_card_dates(db) -> dict[int, datetime.date]:
    if (
        db is None
        or not db.table_exists("card_kanji_links")
        or not db.table_exists("anki_cards")
    ):
        return {}

    rows = db.fetchall(
        """
        SELECT ckl.kanji_id, MIN(ac.synced_at) AS first_seen_mature_sync_time
        FROM card_kanji_links ckl
        JOIN anki_cards ac ON ac.card_id = ckl.card_id
        WHERE ac.interval >= ?
        GROUP BY ckl.kanji_id
        """,
        (_MATURE_INTERVAL_DAYS,),
    )
    return _row_timestamps_to_dates(rows, timestamp_divisor=1)


def _get_first_mature_kanji_dates(db) -> dict[int, datetime.date]:
    """Return first mature dates for linked kanji, using card-state as a fallback."""
    review_dates = _get_first_mature_kanji_review_dates(db)
    fallback_dates = _get_first_mature_kanji_card_dates(db)
    return _merge_primary_and_fallback_dates(review_dates, fallback_dates)


def _build_maturity_labels(
    start_date: datetime.date, end_date: datetime.date
) -> list[str]:
    labels: list[str] = []
    current_date = start_date
    while current_date <= end_date:
        labels.append(current_date.isoformat())
        current_date += datetime.timedelta(days=1)
    return labels


def _build_maturity_series(
    item_dates: dict[int | str, datetime.date], labels: list[str], label: str
) -> dict:
    counts_by_date = Counter(date.isoformat() for date in item_dates.values())
    daily_new: list[int] = []
    cumulative: list[int] = []
    running_total = 0

    for date_label in labels:
        count = counts_by_date.get(date_label, 0)
        daily_new.append(count)
        running_total += count
        cumulative.append(running_total)

    return {
        "label": label,
        "daily_new": daily_new,
        "cumulative": cumulative,
        "total": len(item_dates),
    }


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------


def register_tokenisation_api_routes(app):
    """Register tokenisation API routes with the Flask app."""

    # ------------------------------------------------------------------
    # GET /api/tokenisation/status
    # ------------------------------------------------------------------
    @app.route("/api/tokenisation/status", methods=["GET"])
    def api_tokenisation_status():
        """
        Return tokenisation progress: total lines, tokenised count, and
        whether the feature is enabled.
        ---
        tags:
          - Tokenisation
        responses:
          200:
            description: Tokenisation status
            schema:
              type: object
              properties:
                enabled: {type: boolean}
                total_lines: {type: integer}
                tokenised_lines: {type: integer}
                untokenised_lines: {type: integer}
                percent_complete: {type: number}
                total_words: {type: integer}
                total_kanji: {type: integer}
        """
        try:
            enabled = is_tokenisation_enabled()

            if not enabled:
                return jsonify(
                    {
                        "enabled": False,
                        "total_lines": 0,
                        "tokenised_lines": 0,
                        "untokenised_lines": 0,
                        "percent_complete": 0,
                        "total_words": 0,
                        "total_kanji": 0,
                    }
                ), 200

            db = _get_db()

            total = db.fetchone(f"SELECT COUNT(*) FROM {GameLinesTable._table}")[0]
            tokenised = db.fetchone(
                f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE tokenised = 1"
            )[0]
            untokenised = total - tokenised
            pct = round((tokenised / total) * 100, 2) if total > 0 else 0

            total_words = db.fetchone("SELECT COUNT(*) FROM words")[0]
            total_kanji = db.fetchone("SELECT COUNT(*) FROM kanji")[0]

            return jsonify(
                {
                    "enabled": True,
                    "total_lines": total,
                    "tokenised_lines": tokenised,
                    "untokenised_lines": untokenised,
                    "percent_complete": pct,
                    "total_words": total_words,
                    "total_kanji": total_kanji,
                }
            ), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation status: {e}")
            return jsonify({"error": "Failed to fetch tokenisation status"}), 500

    # ------------------------------------------------------------------
    # GET /api/tokenisation/maturity-history
    # ------------------------------------------------------------------
    @app.route("/api/tokenisation/maturity-history", methods=["GET"])
    def api_tokenisation_maturity_history():
        """
        Return cumulative maturity history for linked words and kanji.
        ---
        tags:
          - Tokenisation
        responses:
          200:
            description: Cumulative maturity history for overview charts
          404:
            description: Tokenisation not enabled
        """
        if not is_tokenisation_enabled():
            return _tokenisation_disabled_response()

        try:
            db = _get_db()
            mature_word_dates = _get_first_mature_word_dates(db)
            unique_kanji_dates = _get_first_mature_kanji_dates(db)

            all_dates = list(mature_word_dates.values()) + list(
                unique_kanji_dates.values()
            )
            if not all_dates:
                return jsonify(_empty_maturity_history_response()), 200

            labels = _build_maturity_labels(min(all_dates), datetime.date.today())
            response = _empty_maturity_history_response(labels)
            response["series"][_MATURE_WORDS_SERIES_KEY] = _build_maturity_series(
                mature_word_dates, labels, "Mature Words"
            )
            response["series"][_UNIQUE_KANJI_SERIES_KEY] = _build_maturity_series(
                unique_kanji_dates, labels, "Unique Kanji"
            )
            return jsonify(response), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation maturity history: {e}")
            return jsonify({"error": "Failed to fetch maturity history"}), 500

    # ------------------------------------------------------------------
    # GET /api/tokenisation/words
    # ------------------------------------------------------------------
    @app.route("/api/tokenisation/words", methods=["GET"])
    def api_tokenisation_words():
        """
        Return the most frequent words across tokenised game lines.
        ---
        tags:
          - Tokenisation
        parameters:
          - name: limit
            in: query
            type: integer
            required: false
            description: Max words to return (default 100, max 500)
          - name: offset
            in: query
            type: integer
            required: false
            description: Pagination offset (default 0)
          - name: days
            in: query
            type: integer
            required: false
            description: Restrict to the last N days
          - name: game_id
            in: query
            type: string
            required: false
            description: Filter by game UUID
          - name: pos
            in: query
            type: string
            required: false
            description: >
              Comma-separated POS filter.  Use ``content`` as shorthand for
              noun, verb, i_adjective, adverb.  Otherwise pass raw POS values
              stored in the ``words.pos`` column.
          - name: exclude_pos
            in: query
            type: string
            required: false
            description: >
              Comma-separated POS values to exclude.  Use ``particles`` as
              shorthand for 助詞,助動詞.
          - name: search
            in: query
            type: string
            required: false
            description: Filter words whose headword contains this substring
        responses:
          200:
            description: List of words with frequencies
          404:
            description: Tokenisation not enabled
        """
        if not is_tokenisation_enabled():
            return _tokenisation_disabled_response()

        try:
            db = _get_db()

            limit = min(int(request.args.get("limit", 100)), 500)
            offset = int(request.args.get("offset", 0))
            days = request.args.get("days", None)
            game_id = request.args.get("game_id", None)
            pos_filter = request.args.get("pos", None)
            exclude_pos = request.args.get("exclude_pos", None)
            search = request.args.get("search", None)

            # Build WHERE clauses
            conditions = []
            params: list = []

            # Always exclude symbol / other POS
            conditions.append("w.pos NOT IN ('記号', 'その他')")

            if days is not None:
                conditions.append("gl.timestamp >= strftime('%s', 'now', ?)")
                params.append(f"-{int(days)} days")

            if game_id:
                conditions.append("gl.game_id = ?")
                params.append(game_id)

            if pos_filter:
                pos_values = _expand_pos_shorthand(pos_filter)
                placeholders = ",".join("?" for _ in pos_values)
                conditions.append(f"w.pos IN ({placeholders})")
                params.extend(pos_values)

            if exclude_pos:
                exc_values = _expand_pos_shorthand(exclude_pos)
                placeholders = ",".join("?" for _ in exc_values)
                conditions.append(f"w.pos NOT IN ({placeholders})")
                params.extend(exc_values)

            if search:
                conditions.append("w.word LIKE ?")
                params.append(f"%{search}%")

            where = " AND ".join(conditions)
            use_word_stats_cache = (
                _has_word_stats_cache(db) and days is None and not game_id
            )
            if use_word_stats_cache:
                where = f"{where} AND ws.occurrence_count > 0"
                query = f"""
                    SELECT w.id, w.word, w.reading, w.pos, ws.occurrence_count AS freq
                    FROM {WORD_STATS_CACHE_TABLE} ws
                    JOIN words w ON w.id = ws.word_id
                    WHERE {where}
                    ORDER BY freq DESC, w.word ASC, w.id ASC
                    LIMIT ? OFFSET ?
                """
                params.extend([limit, offset])
                rows = db.fetchall(query, tuple(params))

                count_query = f"""
                    SELECT COUNT(*)
                    FROM {WORD_STATS_CACHE_TABLE} ws
                    JOIN words w ON w.id = ws.word_id
                    WHERE {where}
                """
                total_count = db.fetchone(count_query, tuple(params[:-2]))[0]
            else:
                query = f"""
                    SELECT w.id, w.word, w.reading, w.pos, COUNT(*) AS freq
                    FROM word_occurrences wo
                    JOIN words w ON w.id = wo.word_id
                    JOIN game_lines gl ON gl.id = wo.line_id
                    WHERE {where}
                    GROUP BY w.id
                    ORDER BY freq DESC
                    LIMIT ? OFFSET ?
                """
                params.extend([limit, offset])

                rows = db.fetchall(query, tuple(params))

                # Also get total count for pagination
                count_query = f"""
                    SELECT COUNT(DISTINCT w.id)
                    FROM word_occurrences wo
                    JOIN words w ON w.id = wo.word_id
                    JOIN game_lines gl ON gl.id = wo.line_id
                    WHERE {where}
                """
                total_count = db.fetchone(count_query, tuple(params[:-2]))[0]

            # Enrich with card data from the anki cache
            word_ids = [row[0] for row in rows]
            card_data = _get_card_data_for_words(db, word_ids)

            words = []
            for row in rows:
                entry = {
                    "word": row[1],
                    "reading": row[2],
                    "pos": row[3],
                    "frequency": row[4],
                }
                cd = card_data.get(row[0])
                if cd:
                    entry["deck_name"] = cd["deck_name"]
                    entry["interval"] = cd["interval"]
                    entry["due"] = cd["due"]
                words.append(entry)

            return jsonify(
                {
                    "words": words,
                    "total": total_count,
                    "limit": limit,
                    "offset": offset,
                }
            ), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation words: {e}")
            return jsonify({"error": "Failed to fetch word frequency data"}), 500

    # ------------------------------------------------------------------
    # GET /api/tokenisation/kanji
    # ------------------------------------------------------------------
    @app.route("/api/tokenisation/kanji", methods=["GET"])
    def api_tokenisation_kanji():
        """
        Return the most frequent kanji across tokenised game lines.
        ---
        tags:
          - Tokenisation
        parameters:
          - name: limit
            in: query
            type: integer
            required: false
            description: Max kanji to return (default 100, max 500)
          - name: offset
            in: query
            type: integer
            required: false
            description: Pagination offset (default 0)
          - name: days
            in: query
            type: integer
            required: false
            description: Restrict to the last N days
          - name: game_id
            in: query
            type: string
            required: false
            description: Filter by game UUID
        responses:
          200:
            description: List of kanji with frequencies
          404:
            description: Tokenisation not enabled
        """
        if not is_tokenisation_enabled():
            return _tokenisation_disabled_response()

        try:
            db = _get_db()

            limit = min(int(request.args.get("limit", 100)), 500)
            offset = int(request.args.get("offset", 0))
            days = request.args.get("days", None)
            game_id = request.args.get("game_id", None)

            conditions: list[str] = []
            params: list = []

            if days is not None:
                conditions.append("gl.timestamp >= strftime('%s', 'now', ?)")
                params.append(f"-{int(days)} days")

            if game_id:
                conditions.append("gl.game_id = ?")
                params.append(game_id)

            where = (" AND " + " AND ".join(conditions)) if conditions else ""

            query = f"""
                SELECT k.character, COUNT(*) AS freq
                FROM kanji_occurrences ko
                JOIN kanji k ON k.id = ko.kanji_id
                JOIN game_lines gl ON gl.id = ko.line_id
                WHERE 1=1 {where}
                GROUP BY k.id
                ORDER BY freq DESC
                LIMIT ? OFFSET ?
            """
            params.extend([limit, offset])

            rows = db.fetchall(query, tuple(params))

            count_query = f"""
                SELECT COUNT(DISTINCT k.id)
                FROM kanji_occurrences ko
                JOIN kanji k ON k.id = ko.kanji_id
                JOIN game_lines gl ON gl.id = ko.line_id
                WHERE 1=1 {where}
            """
            total_count = db.fetchone(count_query, tuple(params[:-2]))[0]

            kanji_list = [{"character": row[0], "frequency": row[1]} for row in rows]

            return jsonify(
                {
                    "kanji": kanji_list,
                    "total": total_count,
                    "limit": limit,
                    "offset": offset,
                }
            ), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation kanji: {e}")
            return jsonify({"error": "Failed to fetch kanji frequency data"}), 500

    # ------------------------------------------------------------------
    # GET /api/tokenisation/search
    # ------------------------------------------------------------------
    @app.route("/api/tokenisation/search", methods=["GET"])
    def api_tokenisation_search():
        """
        Search game lines by dictionary form of a word.  For example,
        searching for ``食べる`` returns lines containing ``食べた``,
        ``食べない``, ``食べられる``, etc.
        ---
        tags:
          - Tokenisation
        parameters:
          - name: q
            in: query
            type: string
            required: true
            description: Word to search for (headword / dictionary form)
          - name: limit
            in: query
            type: integer
            required: false
            description: Max lines to return (default 50, max 200)
          - name: offset
            in: query
            type: integer
            required: false
            description: Pagination offset (default 0)
        responses:
          200:
            description: Matching game lines
          400:
            description: Missing search query
          404:
            description: Tokenisation not enabled
        """
        if not is_tokenisation_enabled():
            return _tokenisation_disabled_response()

        try:
            q = request.args.get("q", "").strip()
            if not q:
                return jsonify({"error": "Search query is required"}), 400

            db = _get_db()
            limit = min(int(request.args.get("limit", 50)), 200)
            offset = int(request.args.get("offset", 0))
            game_ids, has_game_scope = _parse_game_scope_args()

            # Look up the word in the words table
            word_row = db.fetchone(
                "SELECT id, word, reading, pos FROM words WHERE word = ?",
                (q,),
            )
            if not word_row:
                return jsonify(
                    {
                        "query": q,
                        "lines": [],
                        "total": 0,
                        "limit": limit,
                        "offset": offset,
                    }
                ), 200

            word_id = word_row[0]

            where_conditions = ["wo.word_id = ?"]
            where_params: list = [word_id]
            if game_ids:
                placeholders = ",".join("?" for _ in game_ids)
                where_conditions.append(f"gl.game_id IN ({placeholders})")
                where_params.extend(game_ids)
            where_sql = " AND ".join(where_conditions)

            if has_game_scope and not game_ids:
                return jsonify(
                    {
                        "query": q,
                        "word": {
                            "word": word_row[1],
                            "reading": word_row[2],
                            "pos": word_row[3],
                        },
                        "lines": [],
                        "total": 0,
                        "limit": limit,
                        "offset": offset,
                    }
                ), 200

            # Count total matching lines
            total = db.fetchone(
                f"""
                SELECT COUNT(*)
                FROM game_lines gl
                JOIN word_occurrences wo ON gl.id = wo.line_id
                WHERE {where_sql}
                """,
                tuple(where_params),
            )[0]

            # Fetch matching lines
            rows = db.fetchall(
                f"""
                SELECT gl.id, gl.line_text, gl.timestamp, gl.game_name
                FROM game_lines gl
                JOIN word_occurrences wo ON gl.id = wo.line_id
                WHERE {where_sql}
                ORDER BY gl.timestamp DESC
                LIMIT ? OFFSET ?
                """,
                tuple([*where_params, limit, offset]),
            )

            lines = [
                {
                    "id": row[0],
                    "text": row[1],
                    "timestamp": row[2],
                    "game_name": row[3],
                }
                for row in rows
            ]

            return jsonify(
                {
                    "query": q,
                    "word": {
                        "word": word_row[1],
                        "reading": word_row[2],
                        "pos": word_row[3],
                    },
                    "lines": lines,
                    "total": total,
                    "limit": limit,
                    "offset": offset,
                }
            ), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation search: {e}")
            return jsonify({"error": "Failed to search game lines"}), 500

    # ------------------------------------------------------------------
    # GET /api/tokenisation/words/card-data
    # ------------------------------------------------------------------
    @app.route("/api/tokenisation/words/card-data", methods=["GET"])
    def api_tokenisation_word_card_data():
        """
        Return cached Anki card metadata for a batch of word IDs.
        ---
        tags:
          - Tokenisation
        parameters:
          - name: word_ids
            in: query
            type: string
            required: false
            description: Comma-separated list of word IDs, capped to 100 entries
        responses:
          200:
            description: Card metadata keyed by word_id
          404:
            description: Tokenisation not enabled
        """
        if not is_tokenisation_enabled():
            return _tokenisation_disabled_response()

        try:
            db = _get_db()
            word_ids = _parse_word_ids_arg(request.args.get("word_ids"), max_ids=100)
            if not word_ids:
                return jsonify({"cards": []}), 200

            card_data = _get_card_data_for_words(db, word_ids)
            cards = []
            for word_id in word_ids:
                data = card_data.get(word_id)
                if not data:
                    continue
                cards.append(
                    {
                        "word_id": word_id,
                        "deck_name": data["deck_name"],
                        "interval": data["interval"],
                        "due": data["due"],
                    }
                )

            return jsonify({"cards": cards}), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation word card data: {e}")
            return jsonify({"error": "Failed to fetch word card data"}), 500

    # ------------------------------------------------------------------
    # GET /api/tokenisation/word/<word>
    # ------------------------------------------------------------------
    @app.route("/api/tokenisation/word/<path:word>", methods=["GET"])
    def api_tokenisation_word_detail(word: str):
        """
        Get details about a single word: its stored metadata and total
        occurrence count.
        ---
        tags:
          - Tokenisation
        parameters:
          - name: word
            in: path
            type: string
            required: true
            description: Headword / dictionary form to look up
        responses:
          200:
            description: Word detail with occurrence count
          404:
            description: Word not found or tokenisation not enabled
        """
        if not is_tokenisation_enabled():
            return _tokenisation_disabled_response()

        try:
            db = _get_db()
            game_ids, has_game_scope = _parse_game_scope_args()

            use_cached_total = _has_word_stats_cache(db) and not has_game_scope
            if use_cached_total:
                row = db.fetchone(
                    f"""
                    SELECT w.id, w.word, w.reading, w.pos, COALESCE(ws.occurrence_count, 0)
                    FROM words w
                    LEFT JOIN {WORD_STATS_CACHE_TABLE} ws ON ws.word_id = w.id
                    WHERE w.word = ?
                    """,
                    (word,),
                )
            else:
                row = db.fetchone(
                    "SELECT id, word, reading, pos FROM words WHERE word = ?",
                    (word,),
                )
            if not row:
                return jsonify({"error": "Word not found"}), 404

            word_id = row[0]
            game_scope_conditions = ["wo.word_id = ?"]
            game_scope_params: list = [word_id]
            if game_ids:
                placeholders = ",".join("?" for _ in game_ids)
                game_scope_conditions.append(f"gl.game_id IN ({placeholders})")
                game_scope_params.extend(game_ids)
            game_scope_where_sql = " AND ".join(game_scope_conditions)

            if use_cached_total:
                total_occurrences = int(row[4] or 0)
            elif has_game_scope and not game_ids:
                total_occurrences = 0
            else:
                total_occurrences = db.fetchone(
                    f"""
                    SELECT COUNT(*)
                    FROM word_occurrences wo
                    JOIN game_lines gl ON gl.id = wo.line_id
                    WHERE {game_scope_where_sql}
                    """,
                    tuple(game_scope_params),
                )[0]

            # Grab the games this word appears in (top 10 by frequency)
            if has_game_scope and not game_ids:
                game_rows = []
            else:
                game_rows = db.fetchall(
                    f"""
                    SELECT gl.game_name, COUNT(*) AS freq
                    FROM word_occurrences wo
                    JOIN game_lines gl ON gl.id = wo.line_id
                    WHERE {game_scope_where_sql}
                    GROUP BY gl.game_name
                    ORDER BY freq DESC
                    LIMIT 10
                    """,
                    tuple(game_scope_params),
                )

            games = [{"game_name": gr[0], "frequency": gr[1]} for gr in game_rows]

            # Enrich with card data from the anki cache
            card_data = _get_card_data_for_words(db, [word_id])
            cd = card_data.get(word_id)

            result = {
                "word": row[1],
                "reading": row[2],
                "pos": row[3],
                "total_occurrences": total_occurrences,
                "games": games,
            }
            if cd:
                result["deck_name"] = cd["deck_name"]
                result["interval"] = cd["interval"]
                result["due"] = cd["due"]

            return jsonify(result), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation word detail: {e}")
            return jsonify({"error": "Failed to fetch word detail"}), 500

    # ------------------------------------------------------------------
    # GET /api/tokenisation/words/by-game
    # ------------------------------------------------------------------
    @app.route("/api/tokenisation/words/by-game", methods=["GET"])
    def api_tokenisation_words_by_game():
        """
        Return per-game word counts.  Useful for comparing vocabulary
        breadth across different games.
        ---
        tags:
          - Tokenisation
        parameters:
          - name: limit
            in: query
            type: integer
            required: false
            description: Max games to return (default 20)
        responses:
          200:
            description: Per-game unique word counts
          404:
            description: Tokenisation not enabled
        """
        if not is_tokenisation_enabled():
            return _tokenisation_disabled_response()

        try:
            db = _get_db()
            limit = min(int(request.args.get("limit", 20)), 100)

            rows = db.fetchall(
                f"""
                SELECT gl.game_name, COUNT(DISTINCT wo.word_id) AS unique_words
                FROM word_occurrences wo
                JOIN game_lines gl ON gl.id = wo.line_id
                JOIN words w ON w.id = wo.word_id
                WHERE w.pos NOT IN ('記号', 'その他')
                GROUP BY gl.game_name
                ORDER BY unique_words DESC
                LIMIT ?
                """,
                (limit,),
            )

            games = [{"game_name": row[0], "unique_words": row[1]} for row in rows]

            return jsonify({"games": games}), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation words by game: {e}")
            return jsonify({"error": "Failed to fetch per-game word data"}), 500

    # ------------------------------------------------------------------
    # GET /api/tokenisation/words/not-in-anki
    # ------------------------------------------------------------------
    @app.route("/api/tokenisation/words/not-in-anki", methods=["GET"])
    def api_tokenisation_words_not_in_anki():
        """
        Return tokenised words that are NOT in Anki, with occurrence
        frequency.  Supports search, sorting, and pagination.
        ---
        tags:
          - Tokenisation
        parameters:
          - name: limit
            in: query
            type: integer
            required: false
            description: Max words to return (default 100, max 1000)
          - name: offset
            in: query
            type: integer
            required: false
            description: Pagination offset (default 0)
          - name: start_timestamp
            in: query
            type: integer
            required: false
            description: Inclusive lower-bound game-line timestamp in milliseconds
          - name: end_timestamp
            in: query
            type: integer
            required: false
            description: Inclusive upper-bound game-line timestamp in milliseconds
          - name: search
            in: query
            type: string
            required: false
            description: Filter words containing this substring
          - name: sort
            in: query
            type: string
            required: false
            description: "Sort column: frequency (default), global_rank, word, reading, pos"
          - name: order
            in: query
            type: string
            required: false
            description: "Sort order: desc (default) or asc"
          - name: global_rank_min
            in: query
            type: integer
            required: false
            description: Minimum active-source global rank (inclusive)
          - name: global_rank_max
            in: query
            type: integer
            required: false
            description: Maximum active-source global rank (inclusive)
          - name: pos
            in: query
            type: string
            required: false
            description: Comma-separated POS filter (supports 'content' shorthand)
          - name: exclude_pos
            in: query
            type: string
            required: false
            description: Comma-separated POS values to exclude (supports 'particles' shorthand)
          - name: vocab_only
            in: query
            type: boolean
            required: false
            description: Exclude common grammar-heavy tokens to focus on vocabulary words
          - name: frequency_min
            in: query
            type: integer
            required: false
            description: Minimum occurrence frequency (inclusive)
          - name: frequency_max
            in: query
            type: integer
            required: false
            description: Maximum occurrence frequency (inclusive)
          - name: script_filter
            in: query
            type: string
            required: false
            description: "Script filter: all (default), cjk, non_cjk"
          - name: has_missing_anki_kanji
            in: query
            type: boolean
            required: false
            description: Only keep words containing at least one kanji not present in the cached Anki collection
          - name: cjk_only
            in: query
            type: boolean
            required: false
            description: Legacy alias for script_filter=cjk
        responses:
          200:
            description: List of words not in Anki with frequencies
          404:
            description: Tokenisation not enabled
        """
        if not is_tokenisation_enabled():
            return _tokenisation_disabled_response()

        try:
            db = _get_db()
            filters = _parse_words_not_in_anki_filters(paginated=True)
            result = _query_words_not_in_anki(db, filters)

            words = []
            for row in result.rows:
                words.append(
                    {
                        "word_id": row[0],
                        "word": row[1],
                        "reading": row[2],
                        "pos": row[3],
                        "frequency": row[4],
                        "global_rank": int(row[5]) if row[5] is not None else None,
                    }
                )

            return jsonify(
                {
                    "words": words,
                    "total": result.total_count,
                    "limit": filters.limit,
                    "offset": filters.offset,
                    "frequency_bounds": result.frequency_bounds,
                    "global_rank_bounds": result.global_rank_bounds,
                    "global_rank_source": result.global_rank_source,
                }
            ), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation words not in anki: {e}")
            return jsonify({"error": "Failed to fetch words not in Anki"}), 500

    @app.route("/api/tokenisation/words/not-in-anki/export", methods=["GET"])
    def api_tokenisation_words_not_in_anki_export():
        """Export the current not-in-Anki word list as UTF-8 BOM CSV."""
        if not is_tokenisation_enabled():
            return _tokenisation_disabled_response()

        try:
            db = _get_db()
            filters = _parse_words_not_in_anki_filters(paginated=False)
            result = _query_words_not_in_anki(db, filters)
            game_headers, sentence_cells = _query_words_not_in_anki_export_game_sentences(
                db,
                filters,
                [row[0] for row in result.rows],
            )

            output = io.StringIO()
            writer = csv.writer(output, lineterminator="\n")
            writer.writerow(
                ["word", "reading", "pos", "frequency", "global_rank", *game_headers]
            )
            for row in result.rows:
                word_sentence_cells = sentence_cells.get(row[0], {})
                writer.writerow(
                    [
                        row[1],
                        row[2],
                        row[3],
                        row[4],
                        row[5] if row[5] is not None else "",
                        *[
                            word_sentence_cells.get(game_name, "")
                            for game_name in game_headers
                        ],
                    ]
                )

            csv_body = f"\ufeff{output.getvalue()}"
            response = Response(csv_body, content_type="text/csv; charset=utf-8")
            response.headers["Content-Disposition"] = (
                f'attachment; filename="{_WORDS_NOT_IN_ANKI_CSV_FILENAME}"'
            )
            return response

        except Exception as e:
            logger.exception(f"Error exporting words not in Anki CSV: {e}")
            return jsonify({"error": "Failed to export words not in Anki"}), 500


# ---------------------------------------------------------------------------
# POS shorthand expansion
# ---------------------------------------------------------------------------

# Map of convenience names → stored POS values in the words table.
# The stored values match PartOfSpeech enum .value strings.
_POS_SHORTHANDS = {
    "content": ["名詞", "動詞", "形容詞", "副詞"],
    "particles": ["助詞", "助動詞"],
}


def _expand_pos_shorthand(raw: str) -> list[str]:
    """Expand comma-separated POS string, resolving shorthands like 'content'."""
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    result: list[str] = []
    for p in parts:
        if p.lower() in _POS_SHORTHANDS:
            result.extend(_POS_SHORTHANDS[p.lower()])
        else:
            result.append(p)
    return result
