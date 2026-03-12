"""
Tokenisation API Endpoints

Exposes word/kanji frequency data, dictionary-form search, and tokenisation
status from the normalised tokenisation tables. All endpoints are guarded by
the ``enable_tokenisation`` experimental config flag and return 404 when the
feature is off.
"""

from __future__ import annotations

import datetime
from collections import Counter

from flask import request, jsonify

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.config.feature_flags import is_tokenisation_enabled
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.global_frequency_tables import (
    get_active_global_frequency_source,
)
from GameSentenceMiner.util.database.tokenisation_tables import WORD_STATS_CACHE_TABLE


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
) -> str:
    """Return a stable ORDER BY clause for the not-in-Anki words query."""
    order_sql = "ASC" if sort_order.lower() == "asc" else "DESC"
    allowed_sorts = {
        "frequency": f"freq {order_sql}, w.word ASC, w.id ASC",
        "word": f"w.word {order_sql}, w.reading ASC, w.id ASC",
        "reading": f"w.reading {order_sql}, w.word ASC, w.id ASC",
        "pos": f"w.pos {order_sql}, w.word ASC, w.id ASC",
    }
    if has_global_rank:
        allowed_sorts["global_rank"] = f"{rank_sql} {order_sql}, w.word ASC, w.id ASC"
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


def _is_truthy_query_param(raw_value: str | None) -> bool:
    """Parse common truthy query-string values."""
    if raw_value is None:
        return False
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


_VOCAB_ONLY_EXCLUDED_POS = ("助詞", "助動詞", "フィラー", "接頭詞", "連体詞")
_VOCAB_ONLY_EXCLUDED_WORDS = ("こと", "よう", "もの")
# Match words that contain at least one CJK-script character.
_CJK_WORD_GLOB_PATTERN = "*[一-龯㐀-䶿ぁ-ゖゝゞァ-ヺーｦ-ﾟ가-힣]*"
_MATURE_INTERVAL_DAYS = 21
_MATURE_WORDS_SERIES_KEY = "mature_words"
_UNIQUE_KANJI_SERIES_KEY = "unique_kanji"


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


def _row_review_times_to_dates(
    rows: list[tuple[int, int | float | str]]
) -> dict[int, datetime.date]:
    item_dates: dict[int, datetime.date] = {}
    for item_id, review_time in rows:
        if item_id is None or review_time in (None, ""):
            continue
        item_dates[int(item_id)] = datetime.datetime.fromtimestamp(
            float(review_time) / 1000
        ).date()
    return item_dates


def _get_first_mature_word_dates(db) -> dict[int, datetime.date]:
    """Return the first known local mature-review date for each linked word."""
    if db is None or not db.table_exists("word_anki_links") or not db.table_exists(
        "anki_reviews"
    ):
        return {}

    rows = db.fetchall(
        """
        SELECT wal.word_id, MIN(ar.review_time) AS first_mature_review_time
        FROM word_anki_links wal
        JOIN anki_reviews ar ON ar.note_id = wal.note_id
        WHERE ar.interval >= ?
        GROUP BY wal.word_id
        """,
        (_MATURE_INTERVAL_DAYS,),
    )
    return _row_review_times_to_dates(rows)


def _get_first_mature_kanji_dates(db) -> dict[int, datetime.date]:
    """Return the first known local mature-review date for each linked kanji."""
    if db is None or not db.table_exists("card_kanji_links") or not db.table_exists(
        "anki_reviews"
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
    return _row_review_times_to_dates(rows)


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
    item_dates: dict[int, datetime.date], labels: list[str], label: str
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

            all_dates = list(mature_word_dates.values()) + list(unique_kanji_dates.values())
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
            use_word_stats_cache = _has_word_stats_cache(db) and days is None and not game_id
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

            # Count total matching lines
            total = db.fetchone(
                "SELECT COUNT(*) FROM word_occurrences WHERE word_id = ?",
                (word_id,),
            )[0]

            # Fetch matching lines
            rows = db.fetchall(
                f"""
                SELECT gl.id, gl.line_text, gl.timestamp, gl.game_name
                FROM game_lines gl
                JOIN word_occurrences wo ON gl.id = wo.line_id
                WHERE wo.word_id = ?
                ORDER BY gl.timestamp DESC
                LIMIT ? OFFSET ?
                """,
                (word_id, limit, offset),
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

            if _has_word_stats_cache(db):
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
            if _has_word_stats_cache(db):
                total_occurrences = int(row[4] or 0)
            else:
                total_occurrences = db.fetchone(
                    "SELECT COUNT(*) FROM word_occurrences WHERE word_id = ?",
                    (word_id,),
                )[0]

            # Grab the games this word appears in (top 10 by frequency)
            game_rows = db.fetchall(
                f"""
                SELECT gl.game_name, COUNT(*) AS freq
                FROM word_occurrences wo
                JOIN game_lines gl ON gl.id = wo.line_id
                WHERE wo.word_id = ?
                GROUP BY gl.game_name
                ORDER BY freq DESC
                LIMIT 10
                """,
                (word_id,),
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
          - name: cjk_only
            in: query
            type: boolean
            required: false
            description: Keep only words containing at least one CJK-script character
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

            limit = min(max(int(request.args.get("limit", 100)), 0), 1000)
            offset = max(int(request.args.get("offset", 0)), 0)
            search = request.args.get("search", None)
            sort_col = request.args.get("sort", "frequency")
            sort_order = request.args.get("order", "desc")
            global_rank_min = _parse_optional_positive_int(
                request.args.get("global_rank_min")
            )
            global_rank_max = _parse_optional_positive_int(
                request.args.get("global_rank_max")
            )
            pos_filter = request.args.get("pos", None)
            exclude_pos = request.args.get("exclude_pos", None)
            vocab_only = _is_truthy_query_param(request.args.get("vocab_only"))
            cjk_only = _is_truthy_query_param(request.args.get("cjk_only"))
            if (
                global_rank_min is not None
                and global_rank_max is not None
                and global_rank_min > global_rank_max
            ):
                global_rank_min, global_rank_max = global_rank_max, global_rank_min

            active_global_source = get_active_global_frequency_source(db)
            has_global_rank_source = active_global_source is not None
            if sort_col == "global_rank" and not has_global_rank_source:
                sort_col = "frequency"
            rank_tools_active = has_global_rank_source and (
                sort_col == "global_rank"
                or global_rank_min is not None
                or global_rank_max is not None
            )
            order_by_sql = _get_words_not_in_anki_order_by(
                sort_col,
                sort_order,
                has_global_rank_source,
                rank_sql="ws.active_global_rank",
            )

            conditions = ["(w.in_anki = 0 OR w.in_anki IS NULL)"]
            condition_params: list = []

            # Exclude symbols/other
            conditions.append("w.pos NOT IN ('記号', 'その他')")

            if vocab_only:
                pos_placeholders = ",".join("?" for _ in _VOCAB_ONLY_EXCLUDED_POS)
                word_placeholders = ",".join("?" for _ in _VOCAB_ONLY_EXCLUDED_WORDS)
                conditions.append(f"w.pos NOT IN ({pos_placeholders})")
                conditions.append(f"w.word NOT IN ({word_placeholders})")
                condition_params.extend(_VOCAB_ONLY_EXCLUDED_POS)
                condition_params.extend(_VOCAB_ONLY_EXCLUDED_WORDS)

            if cjk_only:
                conditions.append("w.word GLOB ?")
                condition_params.append(_CJK_WORD_GLOB_PATTERN)

            if pos_filter:
                pos_values = _expand_pos_shorthand(pos_filter)
                placeholders = ",".join("?" for _ in pos_values)
                conditions.append(f"w.pos IN ({placeholders})")
                condition_params.extend(pos_values)

            if exclude_pos:
                exc_values = _expand_pos_shorthand(exclude_pos)
                placeholders = ",".join("?" for _ in exc_values)
                conditions.append(f"w.pos NOT IN ({placeholders})")
                condition_params.extend(exc_values)

            if search:
                conditions.append("(w.word LIKE ? OR w.reading LIKE ?)")
                condition_params.extend([f"%{search}%", f"%{search}%"])

            use_word_stats_cache = _has_word_stats_cache(db)
            if use_word_stats_cache:
                base_where = f"ws.occurrence_count > 0 AND {' AND '.join(conditions)}"
                rank_conditions: list[str] = []
                rank_params: list[int] = []
                if rank_tools_active:
                    rank_conditions.append("ws.active_global_rank IS NOT NULL")
                    if global_rank_min is not None:
                        rank_conditions.append("ws.active_global_rank >= ?")
                        rank_params.append(global_rank_min)
                    if global_rank_max is not None:
                        rank_conditions.append("ws.active_global_rank <= ?")
                        rank_params.append(global_rank_max)

                where_clauses = [base_where]
                if rank_conditions:
                    where_clauses.extend(rank_conditions)
                where = " AND ".join(where_clauses)

                query = f"""
                    SELECT
                        w.id,
                        w.word,
                        w.reading,
                        w.pos,
                        ws.occurrence_count AS freq,
                        ws.active_global_rank AS global_rank
                    FROM {WORD_STATS_CACHE_TABLE} ws
                    JOIN words w ON w.id = ws.word_id
                    WHERE {where}
                    ORDER BY {order_by_sql}
                    LIMIT ? OFFSET ?
                """
                rows = db.fetchall(
                    query,
                    tuple(condition_params + rank_params + [limit, offset]),
                )

                count_query = f"""
                    SELECT COUNT(*)
                    FROM {WORD_STATS_CACHE_TABLE} ws
                    JOIN words w ON w.id = ws.word_id
                    WHERE {where}
                """
                total_count = db.fetchone(
                    count_query, tuple(condition_params + rank_params)
                )[0]

                rank_bounds = {"min": None, "max": None}
                if has_global_rank_source:
                    bounds_query = f"""
                        SELECT MIN(ws.active_global_rank), MAX(ws.active_global_rank)
                        FROM {WORD_STATS_CACHE_TABLE} ws
                        JOIN words w ON w.id = ws.word_id
                        WHERE {base_where} AND ws.active_global_rank IS NOT NULL
                    """
                    bounds_row = db.fetchone(bounds_query, tuple(condition_params))
                    if (
                        bounds_row
                        and bounds_row[0] is not None
                        and bounds_row[1] is not None
                    ):
                        rank_bounds = {
                            "min": int(bounds_row[0]),
                            "max": int(bounds_row[1]),
                        }
            else:
                base_where = " AND ".join(conditions)
                rank_conditions = []
                rank_params = []
                if rank_tools_active:
                    rank_conditions.append("wgf.rank IS NOT NULL")
                    if global_rank_min is not None:
                        rank_conditions.append("wgf.rank >= ?")
                        rank_params.append(global_rank_min)
                    if global_rank_max is not None:
                        rank_conditions.append("wgf.rank <= ?")
                        rank_params.append(global_rank_max)

                where_clauses = [base_where]
                if rank_conditions:
                    where_clauses.extend(rank_conditions)
                where = " AND ".join(where_clauses)

                join_sql = ""
                join_params: list[str] = []
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

                query = f"""
                    SELECT w.id, w.word, w.reading, w.pos, COUNT(*) AS freq, {rank_select_sql}
                    FROM word_occurrences wo
                    JOIN words w ON w.id = wo.word_id
                    JOIN game_lines gl ON gl.id = wo.line_id
                    {join_sql}
                    WHERE {where}
                    GROUP BY w.id, w.word, w.reading, w.pos{group_rank_sql}
                    ORDER BY {_get_words_not_in_anki_order_by(sort_col, sort_order, has_global_rank_source)}
                    LIMIT ? OFFSET ?
                """
                rows = db.fetchall(
                    query,
                    tuple(join_params + condition_params + rank_params + [limit, offset]),
                )

                count_query = f"""
                    SELECT COUNT(DISTINCT w.id)
                    FROM word_occurrences wo
                    JOIN words w ON w.id = wo.word_id
                    JOIN game_lines gl ON gl.id = wo.line_id
                    {join_sql}
                    WHERE {where}
                """
                total_count = db.fetchone(
                    count_query, tuple(join_params + condition_params + rank_params)
                )[0]

                rank_bounds = {"min": None, "max": None}
                if has_global_rank_source:
                    bounds_query = f"""
                        SELECT MIN(wgf.rank), MAX(wgf.rank)
                        FROM word_occurrences wo
                        JOIN words w ON w.id = wo.word_id
                        JOIN game_lines gl ON gl.id = wo.line_id
                        {join_sql}
                        WHERE {base_where} AND wgf.rank IS NOT NULL
                    """
                    bounds_row = db.fetchone(
                        bounds_query, tuple(join_params + condition_params)
                    )
                    if (
                        bounds_row
                        and bounds_row[0] is not None
                        and bounds_row[1] is not None
                    ):
                        rank_bounds = {
                            "min": int(bounds_row[0]),
                            "max": int(bounds_row[1]),
                        }

            words = []
            for row in rows:
                entry = {
                    "word_id": row[0],
                    "word": row[1],
                    "reading": row[2],
                    "pos": row[3],
                    "frequency": row[4],
                    "global_rank": int(row[5]) if row[5] is not None else None,
                }
                words.append(entry)

            return jsonify(
                {
                    "words": words,
                    "total": total_count,
                    "limit": limit,
                    "offset": offset,
                    "global_rank_bounds": rank_bounds,
                    "global_rank_source": active_global_source,
                }
            ), 200

        except Exception as e:
            logger.exception(f"Error in tokenisation words not in anki: {e}")
            return jsonify({"error": "Failed to fetch words not in Anki"}), 500


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
