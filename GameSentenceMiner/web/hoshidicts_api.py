from __future__ import annotations

import ipaddress
import json
import re
import unicodedata
from functools import wraps

from flask import Response, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from GameSentenceMiner.hoshidicts_audio import (
    HoshidictsAudioError,
    MAX_AUDIO_REQUEST_BYTES,
    get_audio_candidates,
    get_audio_media,
    load_hoshidicts_audio_profile_or_default as load_hoshidicts_audio_profile,
    validate_audio_api_request,
)

from GameSentenceMiner.hoshidicts_mining import (
    HoshidictsMiningError,
    MAX_DUPLICATE_CHECK_REQUEST_BYTES,
    MAX_REQUEST_BYTES,
    check_hoshidicts_notes,
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
    def audio_error_response(exc: HoshidictsAudioError):
        return jsonify({"error": str(exc)}), exc.status_code

    def require_local_hoshidicts_request():
        try:
            address = ipaddress.ip_address(request.remote_addr or "")
        except ValueError:
            return jsonify({"error": "Hoshidicts is available only on this device."}), 403
        mapped = getattr(address, "ipv4_mapped", None)
        if mapped is not None:
            address = mapped
        if not address.is_loopback:
            return jsonify({"error": "Hoshidicts is available only on this device."}), 403
        return None

    def local_hoshidicts_only(view):
        @wraps(view)
        def guarded(*args, **kwargs):
            denied = require_local_hoshidicts_request()
            return denied if denied is not None else view(*args, **kwargs)

        return guarded

    def read_bounded_json(maximum: int, error_type, label: str):
        if request.mimetype != "application/json":
            raise error_type(f"{label} requests require JSON.", 415)
        if request.content_length is not None and request.content_length > maximum:
            raise error_type(f"{label} request is too large.", 413)
        body = request.stream.read(maximum + 1)
        if len(body) > maximum:
            raise error_type(f"{label} request is too large.", 413)
        try:
            return json.loads(body)
        except (UnicodeDecodeError, ValueError):
            return None

    @app.get("/api/hoshidicts/lookup-stats")
    @local_hoshidicts_only
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
    @local_hoshidicts_only
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

        try:
            seen_count = TermLookupStatsTable.get_seen_count(term)
        except Exception:
            logger.exception("Could not read Hoshidicts seen count")
            seen_count = None

        return jsonify(
            {
                "success": True,
                **_serialize_lookup_stat(stat),
                "seenCount": seen_count,
            }
        )

    @app.post("/api/hoshidicts/audio/candidates")
    @local_hoshidicts_only
    def api_hoshidicts_audio_candidates():
        try:
            payload = validate_audio_api_request(
                read_bounded_json(MAX_AUDIO_REQUEST_BYTES, HoshidictsAudioError, "Hoshidicts audio"),
                include_candidate=False,
            )
            profile = load_hoshidicts_audio_profile()
            return jsonify(
                {
                    "candidates": get_audio_candidates(
                        payload["term"],
                        payload["reading"],
                        payload["sourceId"],
                        profile=profile,
                    )
                }
            )
        except HoshidictsAudioError as exc:
            return audio_error_response(exc)
        except Exception as exc:
            logger.exception(f"Hoshidicts audio candidate discovery failed: {exc}")
            return jsonify({"error": "Hoshidicts could not find pronunciation audio."}), 500

    @app.post("/api/hoshidicts/audio/media")
    @local_hoshidicts_only
    def api_hoshidicts_audio_media():
        try:
            payload = validate_audio_api_request(
                read_bounded_json(MAX_AUDIO_REQUEST_BYTES, HoshidictsAudioError, "Hoshidicts audio"),
                include_candidate=True,
            )
            profile = load_hoshidicts_audio_profile()
            media = get_audio_media(
                payload["term"],
                payload["reading"],
                payload["sourceId"],
                payload["candidateIndex"],
                payload["candidateId"],
                profile=profile,
            )
            response = Response(media.data, mimetype=media.content_type)
            response.headers["Cache-Control"] = "private, max-age=300"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response
        except HoshidictsAudioError as exc:
            return audio_error_response(exc)
        except Exception as exc:
            logger.exception(f"Hoshidicts audio download failed: {exc}")
            return jsonify({"error": "Hoshidicts could not download pronunciation audio."}), 500

    @app.get("/api/hoshidicts/mining/status")
    @local_hoshidicts_only
    def api_hoshidicts_mining_status():
        return jsonify(get_hoshidicts_mining_status())

    @app.get("/api/hoshidicts/mining/options")
    @local_hoshidicts_only
    def api_hoshidicts_mining_options():
        return jsonify(get_hoshidicts_mining_options(request.args.get("model")))

    @app.post("/api/hoshidicts/mining/check")
    @local_hoshidicts_only
    def api_hoshidicts_mining_check():
        try:
            payload = read_bounded_json(
                MAX_DUPLICATE_CHECK_REQUEST_BYTES,
                HoshidictsMiningError,
                "Duplicate check",
            )
            return jsonify(check_hoshidicts_notes(payload))
        except HoshidictsMiningError as exc:
            response = {"success": False, "error": str(exc)}
            if exc.status_code == 409:
                response["code"] = "duplicate"
            return jsonify(response), exc.status_code
        except Exception as exc:
            logger.exception(f"Hoshidicts duplicate check failed: {exc}")
            return (
                jsonify(
                    {
                        "success": False,
                        "error": "Hoshidicts could not check the note through GSM.",
                    }
                ),
                500,
            )

    @app.post("/api/hoshidicts/mine")
    @local_hoshidicts_only
    def api_hoshidicts_mine():
        try:
            payload = read_bounded_json(MAX_REQUEST_BYTES, HoshidictsMiningError, "Mining")
            return jsonify(mine_hoshidicts_note(payload))
        except HoshidictsMiningError as exc:
            response = {"success": False, "error": str(exc)}
            if exc.status_code == 409:
                response["code"] = "duplicate"
            return jsonify(response), exc.status_code
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
