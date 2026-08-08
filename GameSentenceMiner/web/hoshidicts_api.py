from __future__ import annotations

import re
import unicodedata

from flask import jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from GameSentenceMiner.hoshidicts_mining import (
    HoshidictsMiningError,
    MAX_REQUEST_BYTES,
    get_hoshidicts_mining_options,
    get_hoshidicts_mining_status,
    mine_hoshidicts_note,
)
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.term_lookup_stats_table import (
    TermLookupStatsTable,
)

MAX_LOOKUP_STATS_REQUEST_BYTES = 4 * 1024
MAX_LOOKUP_STATS_TEXT_LENGTH = 256
DEFAULT_LOOKUP_STATS_LIMIT = 100
MAX_LOOKUP_STATS_LIMIT = 500


def _lookup_stats_error(message: str, status_code: int):
    return jsonify({"success": False, "error": message}), status_code


def _normalize_lookup_text(value, field: str, *, required: bool) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string.")
    normalized = unicodedata.normalize("NFC", value.strip())
    if required and not normalized:
        raise ValueError(f"{field} is required.")
    if len(normalized) > MAX_LOOKUP_STATS_TEXT_LENGTH:
        raise ValueError(f"{field} must be at most {MAX_LOOKUP_STATS_TEXT_LENGTH} characters.")
    return normalized


def _parse_lookup_stats_pagination() -> tuple[int, int]:
    def parse_argument(name: str, default: int) -> int:
        raw_value = request.args.get(name)
        if raw_value is None:
            return default
        if re.fullmatch(r"(?:0|[1-9][0-9]*)", raw_value) is None:
            raise ValueError(f"{name} must be a base-10 integer.")
        return int(raw_value)

    limit = parse_argument("limit", DEFAULT_LOOKUP_STATS_LIMIT)
    offset = parse_argument("offset", 0)
    if not 1 <= limit <= MAX_LOOKUP_STATS_LIMIT:
        raise ValueError(f"limit must be between 1 and {MAX_LOOKUP_STATS_LIMIT}.")
    if offset < 0:
        raise ValueError("offset must be at least 0.")
    return limit, offset


def _serialize_lookup_stat(item: dict) -> dict:
    return {
        "term": item["term"],
        "reading": item["reading"],
        "lookupCount": item["lookup_count"],
        "firstLookedUpAt": item["first_looked_up_at"],
        "lastLookedUpAt": item["last_looked_up_at"],
    }


def register_hoshidicts_api_routes(app) -> None:
    @app.get("/api/hoshidicts/lookup-stats")
    def api_hoshidicts_lookup_stats():
        try:
            limit, offset = _parse_lookup_stats_pagination()
            stats = TermLookupStatsTable.get_stats(limit, offset)
        except ValueError as exc:
            return _lookup_stats_error(str(exc), 400)
        except RuntimeError:
            return _lookup_stats_error("Lookup statistics are unavailable.", 503)
        except Exception:
            logger.exception("Could not read Hoshidicts lookup statistics")
            return _lookup_stats_error("Lookup statistics are unavailable.", 500)
        return jsonify(
            {
                "totalLookups": stats["total_lookups"],
                "uniqueTerms": stats["unique_terms"],
                "limit": limit,
                "offset": offset,
                "items": [_serialize_lookup_stat(item) for item in stats["items"]],
            }
        )

    @app.post("/api/hoshidicts/lookup-stats")
    def api_record_hoshidicts_lookup():
        # Read at most one byte beyond the accepted size so chunked requests
        # without Content-Length can still be distinguished from an exact-limit body.
        request.max_content_length = MAX_LOOKUP_STATS_REQUEST_BYTES + 1
        if request.content_length is not None and request.content_length > MAX_LOOKUP_STATS_REQUEST_BYTES:
            return _lookup_stats_error("Lookup statistics request is too large.", 413)
        try:
            raw_body = request.get_data(cache=True)
            if len(raw_body) > MAX_LOOKUP_STATS_REQUEST_BYTES:
                return _lookup_stats_error("Lookup statistics request is too large.", 413)
            payload = request.get_json(silent=True)
        except RequestEntityTooLarge:
            return _lookup_stats_error("Lookup statistics request is too large.", 413)
        if not isinstance(payload, dict):
            return _lookup_stats_error("A JSON object is required.", 400)
        try:
            term = _normalize_lookup_text(payload.get("term"), "term", required=True)
            reading = _normalize_lookup_text(
                payload.get("reading", ""),
                "reading",
                required=False,
            )
            stat = TermLookupStatsTable.record_lookup(term, reading)
        except ValueError as exc:
            return _lookup_stats_error(str(exc), 400)
        except RuntimeError:
            return _lookup_stats_error("Lookup statistics are unavailable.", 503)
        except Exception:
            logger.exception("Could not record Hoshidicts lookup statistics")
            return _lookup_stats_error("Lookup statistics are unavailable.", 500)
        return jsonify({"success": True, **_serialize_lookup_stat(stat)})

    @app.get("/api/hoshidicts/mining/status")
    def api_hoshidicts_mining_status():
        return jsonify(get_hoshidicts_mining_status())

    @app.get("/api/hoshidicts/mining/options")
    def api_hoshidicts_mining_options():
        return jsonify(get_hoshidicts_mining_options(request.args.get("model")))

    @app.post("/api/hoshidicts/mine")
    def api_hoshidicts_mine():
        if request.content_length is not None and request.content_length > MAX_REQUEST_BYTES:
            return jsonify({"success": False, "error": "Mining request is too large."}), 413
        payload = request.get_json(silent=True)
        try:
            return jsonify(mine_hoshidicts_note(payload))
        except HoshidictsMiningError as exc:
            return (
                jsonify({"success": False, "error": str(exc)}),
                exc.status_code,
            )
        except Exception as exc:
            logger.exception(f"Hoshidicts mining failed: {exc}")
            return (
                jsonify(
                    {
                        "success": False,
                        "error": "Hoshidicts could not add the note through GSM.",
                    }
                ),
                500,
            )
