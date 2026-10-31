"""Local desktop access to the same model selector used by the main message bus."""

from flask import Blueprint, jsonify, request

from GameSentenceMiner.ocr.vita_model_manager import handle_model_request

vita_ocr_api = Blueprint("vita_ocr", __name__)


@vita_ocr_api.route("/api/ocr/vita-model", methods=["GET", "POST"])
def model_settings():
    # The settings window calls from Electron's main process. Browser pages and
    # remote clients cannot initiate downloads or change the local selection.
    if request.remote_addr not in ("127.0.0.1", "::1") or request.headers.get("Origin"):
        return jsonify({"error": "Model settings are only available from the local desktop app"}), 403
    if request.method == "POST" and not request.is_json:
        return jsonify({"error": "Expected JSON model settings"}), 415
    payload = request.get_json(silent=True) if request.method == "POST" else {}
    return jsonify(handle_model_request({"data": payload}))
