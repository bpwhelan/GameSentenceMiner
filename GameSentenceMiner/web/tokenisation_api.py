"""
Tokenisation API Endpoints

Exposes word/kanji frequency data, dictionary-form search, and tokenisation
status from the normalised tokenisation tables.  All endpoints are guarded by
the ``enable_tokenisation`` experimental config flag and return 404 when the feature is off.
"""

from __future__ import annotations

import json
from flask import request, jsonify

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.config.feature_flags import is_tokenisation_enabled
from GameSentenceMiner.util.database.db import GameLinesTable


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
            wid = row[0]
            if wid not in result:  # first card wins
                result[wid] = {
                    "deck_name": row[1],
                    "interval": row[2],
                    "due": row[3],
                }
        return result
    except Exception:
        # Cache tables may not exist yet — gracefully return empty
        return {}



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

            row = db.fetchone(
                "SELECT id, word, reading, pos FROM words WHERE word = ?",
                (word,),
            )
            if not row:
                return jsonify({"error": "Word not found"}), 404

            word_id = row[0]

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
            description: "Sort column: frequency (default), word, reading, pos"
          - name: order
            in: query
            type: string
            required: false
            description: "Sort order: desc (default) or asc"
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

            limit = min(int(request.args.get("limit", 100)), 1000)
            offset = int(request.args.get("offset", 0))
            search = request.args.get("search", None)
            sort_col = request.args.get("sort", "frequency")
            sort_order = request.args.get("order", "desc")
            pos_filter = request.args.get("pos", None)
            exclude_pos = request.args.get("exclude_pos", None)

            # Validate sort params
            allowed_sorts = {
                "frequency": "freq",
                "word": "w.word",
                "reading": "w.reading",
                "pos": "w.pos",
            }
            sort_sql = allowed_sorts.get(sort_col, "freq")
            order_sql = "ASC" if sort_order.lower() == "asc" else "DESC"

            conditions = ["(w.in_anki = 0 OR w.in_anki IS NULL)"]
            params: list = []

            # Exclude symbols/other
            conditions.append("w.pos NOT IN ('記号', 'その他')")

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
                conditions.append("(w.word LIKE ? OR w.reading LIKE ?)")
                params.extend([f"%{search}%", f"%{search}%"])

            where = " AND ".join(conditions)

            query = f"""
                SELECT w.id, w.word, w.reading, w.pos,
                       (SELECT COUNT(*) FROM word_occurrences WHERE word_id = w.id) AS freq
                FROM words w
                WHERE {where}
                ORDER BY {sort_sql} {order_sql}
                LIMIT ? OFFSET ?
            """
            params.extend([limit, offset])

            rows = db.fetchall(query, tuple(params))

            count_query = f"""
                SELECT COUNT(*)
                FROM words w
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
