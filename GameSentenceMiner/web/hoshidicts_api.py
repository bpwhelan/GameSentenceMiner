from __future__ import annotations

import hmac
import ipaddress
import json
import os
import re
from functools import wraps

from flask import Response, jsonify, request

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
    MAX_REQUEST_BYTES,
    get_hoshidicts_mining_options,
    get_hoshidicts_mining_status,
    mine_hoshidicts_note,
)
from GameSentenceMiner.util.config.configuration import logger

_BROKER_TOKEN_PATTERN = re.compile(r"^[a-f0-9]{64}$")


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
        expected_token = os.environ.get("GSM_BROKER_TOKEN", "")
        if _BROKER_TOKEN_PATTERN.fullmatch(expected_token) is None:
            return jsonify({"error": "Hoshidicts authentication is unavailable."}), 503
        authorization = request.headers.get("Authorization", "")
        supplied_token = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not hmac.compare_digest(supplied_token, expected_token):
            response = jsonify({"error": "Hoshidicts authentication failed."})
            response.status_code = 401
            response.headers["WWW-Authenticate"] = "Bearer"
            return response
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
                payload["candidateToken"],
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

    @app.post("/api/hoshidicts/mine")
    @local_hoshidicts_only
    def api_hoshidicts_mine():
        try:
            payload = read_bounded_json(MAX_REQUEST_BYTES, HoshidictsMiningError, "Mining")
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
