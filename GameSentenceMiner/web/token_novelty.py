from __future__ import annotations

import datetime
from collections import Counter

from GameSentenceMiner.util.config.feature_flags import is_tokenization_enabled
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable

DEFAULT_GAME_BUCKET_SIZE = 10_000
GAME_BUCKET_SIZE_OPTIONS = [10_000, 25_000, 50_000, 100_000]


def _get_db():
    return GameLinesTable._db


def _table_has_column(db, table_name: str, column_name: str) -> bool:
    if db is None or not hasattr(db, "fetchall"):
        return False
    try:
        columns = db.fetchall(f"PRAGMA table_info({table_name})")
    except Exception:
        return False
    return any(str(column[1]) == column_name for column in columns)


def _has_word_novelty_support(db) -> bool:
    if db is None or not hasattr(db, "table_exists"):
        return False
    return (
        db.table_exists("words")
        and db.table_exists("word_occurrences")
        and db.table_exists(GameLinesTable._table)
        and _table_has_column(db, "words", "first_seen")
        and _table_has_column(db, "words", "first_seen_line_id")
        and _table_has_column(db, GameLinesTable._table, "tokenized")
    )


def _build_date_labels(start_date_str: str | None, end_date_str: str | None) -> list[str]:
    if not start_date_str or not end_date_str:
        return []

    start_date = datetime.date.fromisoformat(start_date_str)
    end_date = datetime.date.fromisoformat(end_date_str)
    if end_date < start_date:
        start_date, end_date = end_date, start_date

    labels: list[str] = []
    current_date = start_date
    while current_date <= end_date:
        labels.append(current_date.isoformat())
        current_date += datetime.timedelta(days=1)
    return labels


def _build_series(labels: list[str], counts_by_date: Counter[str]) -> dict:
    daily_new = [int(counts_by_date.get(label, 0)) for label in labels]
    cumulative: list[int] = []
    running_total = 0
    for count in daily_new:
        running_total += count
        cumulative.append(running_total)
    return {
        "labels": labels,
        "dailyNew": daily_new,
        "cumulative": cumulative,
    }


def _timestamp_range_for_dates(start_date_str: str, end_date_str: str) -> tuple[float, float]:
    start_date = datetime.date.fromisoformat(start_date_str)
    end_date = datetime.date.fromisoformat(end_date_str)
    if end_date < start_date:
        start_date, end_date = end_date, start_date

    start_timestamp = datetime.datetime.combine(start_date, datetime.time.min).timestamp()
    end_timestamp = datetime.datetime.combine(end_date, datetime.time.max).timestamp()
    return start_timestamp, end_timestamp


def _empty_global_payload(labels: list[str]) -> dict:
    return {
        "vocabularyStats": {
            "uniqueWordsSeen": 0,
            "newWordsFirstSeen": 0,
            "newWordsPer10kChars": 0.0,
        },
        "newWordsSeries": _build_series(labels, Counter()),
        "newWordsByGame": {
            "labels": [],
            "totals": [],
        },
    }


def _empty_game_payload(labels: list[str]) -> dict:
    return {
        "uniqueWordsInGame": 0,
        "globallyNewWordsFromGame": 0,
        "noveltyRate": 0.0,
        "newWordsPer10kChars": 0.0,
        "series": _build_series(labels, Counter()),
        "defaultBucketSize": DEFAULT_GAME_BUCKET_SIZE,
        "bucketSizeOptions": list(GAME_BUCKET_SIZE_OPTIONS),
        "totalTokenizedChars": 0,
        "newWordCharacterPositions": [],
    }


def get_tokenization_status_snapshot() -> dict:
    try:
        enabled = bool(is_tokenization_enabled())
    except Exception:
        enabled = False

    if not enabled:
        return {"enabled": False, "percentComplete": 0.0}

    db = _get_db()
    if (
        db is None
        or not hasattr(db, "table_exists")
        or not db.table_exists(GameLinesTable._table)
        or not _table_has_column(db, GameLinesTable._table, "tokenized")
    ):
        return {"enabled": True, "percentComplete": 0.0}

    total_row = db.fetchone(f"SELECT COUNT(*) FROM {GameLinesTable._table}")
    tokenized_row = db.fetchone(f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE tokenized = 1")
    total_lines = int(total_row[0]) if total_row and total_row[0] is not None else 0
    tokenized_lines = int(tokenized_row[0]) if tokenized_row and tokenized_row[0] is not None else 0
    percent_complete = round((tokenized_lines / total_lines) * 100, 2) if total_lines > 0 else 0.0
    return {"enabled": True, "percentComplete": percent_complete}


def _get_game_display_titles() -> dict[str, str]:
    titles: dict[str, str] = {}
    try:
        games = GamesTable.all_without_images()
    except Exception:
        return titles

    for game in games:
        game_id = getattr(game, "id", None)
        if not game_id:
            continue
        title = (
            getattr(game, "title_original", None)
            or getattr(game, "title_romaji", None)
            or getattr(game, "title_english", None)
            or ""
        )
        if title:
            titles[str(game_id)] = title
    return titles


def _build_new_words_by_game(db, start_timestamp: float, end_timestamp: float) -> dict[str, list]:
    game_titles = _get_game_display_titles()
    rows = db.fetchall(
        f"""
        SELECT gl.game_id, gl.game_name, COUNT(*) AS new_word_count
        FROM words w
        JOIN {GameLinesTable._table} gl ON gl.id = w.first_seen_line_id
        WHERE w.first_seen IS NOT NULL
          AND gl.tokenized = 1
          AND CAST(w.first_seen AS REAL) >= ?
          AND CAST(w.first_seen AS REAL) <= ?
        GROUP BY gl.game_id, gl.game_name
        """,
        (start_timestamp, end_timestamp),
    )

    ranked_games: list[tuple[str, int]] = []
    for game_id, game_name, new_word_count in rows:
        count = int(new_word_count or 0)
        if count <= 0:
            continue
        resolved_title = game_titles.get(str(game_id)) or str(game_name or "").strip() or str(game_id or "").strip()
        if not resolved_title:
            continue
        ranked_games.append((resolved_title, count))

    ranked_games.sort(key=lambda item: (-item[1], item[0].lower(), item[0]))
    return {
        "labels": [title for title, _ in ranked_games],
        "totals": [count for _, count in ranked_games],
    }


def _get_game_new_word_character_positions(db, game_id: str) -> tuple[int, list[int]]:
    tokenized_line_rows = db.fetchall(
        f"""
        SELECT id, LENGTH(COALESCE(line_text, '')) AS char_count
        FROM {GameLinesTable._table}
        WHERE game_id = ? AND tokenized = 1
        ORDER BY CAST(timestamp AS REAL) ASC, id ASC
        """,
        (game_id,),
    )

    cumulative_chars = 0
    line_end_positions: dict[str, int] = {}
    for line_id, char_count in tokenized_line_rows:
        cumulative_chars += int(char_count or 0)
        line_end_positions[str(line_id)] = cumulative_chars

    if not line_end_positions:
        return 0, []

    first_seen_rows = db.fetchall(
        f"""
        SELECT w.first_seen_line_id
        FROM words w
        JOIN {GameLinesTable._table} gl ON gl.id = w.first_seen_line_id
        WHERE w.first_seen_line_id IS NOT NULL
          AND gl.game_id = ?
          AND gl.tokenized = 1
        ORDER BY CAST(w.first_seen AS REAL) ASC, w.first_seen_line_id ASC
        """,
        (game_id,),
    )

    positions = [
        line_end_positions[str(line_id)] for (line_id,) in first_seen_rows if str(line_id) in line_end_positions
    ]
    return cumulative_chars, positions


def build_global_word_novelty(start_date_str: str, end_date_str: str) -> tuple[dict, dict, dict, dict]:
    labels = _build_date_labels(start_date_str, end_date_str)
    tokenization_status = get_tokenization_status_snapshot()
    empty_payload = _empty_global_payload(labels)
    if not tokenization_status["enabled"]:
        return (
            tokenization_status,
            empty_payload["vocabularyStats"],
            empty_payload["newWordsSeries"],
            empty_payload["newWordsByGame"],
        )

    db = _get_db()
    if not _has_word_novelty_support(db):
        return (
            tokenization_status,
            empty_payload["vocabularyStats"],
            empty_payload["newWordsSeries"],
            empty_payload["newWordsByGame"],
        )

    start_timestamp, end_timestamp = _timestamp_range_for_dates(start_date_str, end_date_str)
    unique_words_row = db.fetchone(
        f"""
        SELECT COUNT(DISTINCT wo.word_id)
        FROM word_occurrences wo
        JOIN {GameLinesTable._table} gl ON gl.id = wo.line_id
        WHERE gl.tokenized = 1 AND CAST(gl.timestamp AS REAL) >= ? AND CAST(gl.timestamp AS REAL) <= ?
        """,
        (start_timestamp, end_timestamp),
    )
    tokenized_chars_row = db.fetchone(
        f"""
        SELECT COALESCE(SUM(LENGTH(COALESCE(line_text, ''))), 0)
        FROM {GameLinesTable._table}
        WHERE tokenized = 1 AND CAST(timestamp AS REAL) >= ? AND CAST(timestamp AS REAL) <= ?
        """,
        (start_timestamp, end_timestamp),
    )
    first_seen_rows = db.fetchall(
        """
        SELECT first_seen
        FROM words
        WHERE first_seen IS NOT NULL
          AND CAST(first_seen AS REAL) >= ?
          AND CAST(first_seen AS REAL) <= ?
        ORDER BY CAST(first_seen AS REAL) ASC
        """,
        (start_timestamp, end_timestamp),
    )

    counts_by_date: Counter[str] = Counter()
    for row in first_seen_rows:
        first_seen = row[0]
        if first_seen is None:
            continue
        counts_by_date[datetime.datetime.fromtimestamp(float(first_seen)).date().isoformat()] += 1

    series = _build_series(labels, counts_by_date)
    unique_words_seen = int(unique_words_row[0]) if unique_words_row and unique_words_row[0] is not None else 0
    tokenized_chars = int(tokenized_chars_row[0]) if tokenized_chars_row and tokenized_chars_row[0] is not None else 0
    new_words_first_seen = sum(series["dailyNew"])
    new_words_per_10k_chars = round((new_words_first_seen / tokenized_chars) * 10000, 1) if tokenized_chars > 0 else 0.0
    new_words_by_game = _build_new_words_by_game(db, start_timestamp, end_timestamp)

    return (
        tokenization_status,
        {
            "uniqueWordsSeen": unique_words_seen,
            "newWordsFirstSeen": new_words_first_seen,
            "newWordsPer10kChars": new_words_per_10k_chars,
        },
        series,
        new_words_by_game,
    )


def build_game_word_novelty(game_id: str, first_date_str: str | None, last_date_str: str | None) -> tuple[dict, dict]:
    labels = _build_date_labels(first_date_str, last_date_str)
    tokenization_status = get_tokenization_status_snapshot()
    empty_payload = _empty_game_payload(labels)
    if not tokenization_status["enabled"] or not game_id:
        return tokenization_status, empty_payload

    db = _get_db()
    if not _has_word_novelty_support(db):
        return tokenization_status, empty_payload

    unique_words_row = db.fetchone(
        f"""
        SELECT COUNT(DISTINCT wo.word_id)
        FROM word_occurrences wo
        JOIN {GameLinesTable._table} gl ON gl.id = wo.line_id
        WHERE gl.game_id = ? AND gl.tokenized = 1
        """,
        (game_id,),
    )
    tokenized_chars_row = db.fetchone(
        f"""
        SELECT COALESCE(SUM(LENGTH(COALESCE(line_text, ''))), 0)
        FROM {GameLinesTable._table}
        WHERE game_id = ? AND tokenized = 1
        """,
        (game_id,),
    )
    first_seen_rows = db.fetchall(
        f"""
        SELECT w.first_seen
        FROM words w
        JOIN {GameLinesTable._table} gl ON gl.id = w.first_seen_line_id
        WHERE w.first_seen IS NOT NULL AND gl.game_id = ?
        ORDER BY CAST(w.first_seen AS REAL) ASC
        """,
        (game_id,),
    )

    counts_by_date: Counter[str] = Counter()
    for row in first_seen_rows:
        first_seen = row[0]
        if first_seen is None:
            continue
        counts_by_date[datetime.datetime.fromtimestamp(float(first_seen)).date().isoformat()] += 1

    series = _build_series(labels, counts_by_date)
    unique_words_in_game = int(unique_words_row[0]) if unique_words_row and unique_words_row[0] is not None else 0
    tokenized_chars = int(tokenized_chars_row[0]) if tokenized_chars_row and tokenized_chars_row[0] is not None else 0
    globally_new_words_from_game = sum(series["dailyNew"])
    novelty_rate = (
        round((globally_new_words_from_game / unique_words_in_game) * 100, 1) if unique_words_in_game > 0 else 0.0
    )
    new_words_per_10k_chars = (
        round((globally_new_words_from_game / tokenized_chars) * 10000, 1) if tokenized_chars > 0 else 0.0
    )
    total_tokenized_chars, new_word_character_positions = _get_game_new_word_character_positions(db, game_id)

    return tokenization_status, {
        "uniqueWordsInGame": unique_words_in_game,
        "globallyNewWordsFromGame": globally_new_words_from_game,
        "noveltyRate": novelty_rate,
        "newWordsPer10kChars": new_words_per_10k_chars,
        "series": series,
        "defaultBucketSize": DEFAULT_GAME_BUCKET_SIZE,
        "bucketSizeOptions": list(GAME_BUCKET_SIZE_OPTIONS),
        "totalTokenizedChars": total_tokenized_chars,
        "newWordCharacterPositions": new_word_character_positions,
    }
