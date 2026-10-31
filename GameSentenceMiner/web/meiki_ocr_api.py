"""Local desktop access to the shared MeikiOCR model selector."""

from flask import Blueprint, jsonify, request

from GameSentenceMiner.ocr.meiki_model_manager import handle_model_request

meiki_ocr_api = Blueprint("meiki_ocr", __name__)


@meiki_ocr_api.route("/api/ocr/meiki-model", methods=["GET", "POST"])
def model_settings():
    if request.remote_addr not in ("127.0.0.1", "::1") or request.headers.get("Origin"):
        return jsonify({"error": "Model settings are only available from the local desktop app"}), 403
    if request.method == "POST" and not request.is_json:
        return jsonify({"error": "Expected JSON model settings"}), 415
    payload = request.get_json(silent=True) if request.method == "POST" else {}
    return jsonify(handle_model_request({"data": payload}))
