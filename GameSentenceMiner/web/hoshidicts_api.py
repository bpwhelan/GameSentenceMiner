from __future__ import annotations

from flask import jsonify, request

from GameSentenceMiner.hoshidicts_mining import (
    HoshidictsMiningError,
    MAX_REQUEST_BYTES,
    get_hoshidicts_mining_status,
    mine_hoshidicts_note,
)
from GameSentenceMiner.util.config.configuration import logger


def register_hoshidicts_api_routes(app) -> None:
    @app.get("/api/hoshidicts/mining/status")
    def api_hoshidicts_mining_status():
        return jsonify(get_hoshidicts_mining_status())

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
