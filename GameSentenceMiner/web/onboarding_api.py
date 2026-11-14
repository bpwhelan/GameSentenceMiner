"""Small, acknowledged setup actions for the desktop's first-run guide."""

import threading
import time
import uuid

from flask import jsonify, request

from GameSentenceMiner.util.config.configuration import CommonLanguages, get_config, save_current_config

_pending = {}
_lock = threading.Lock()


def accept_dictionary_setup_result(message):
    with _lock:
        pending = _pending.get(message.get("request_id"))
        if pending is None:
            return False
        event, result = pending
        result.update(message)
        event.set()
        return True


def request_dictionary_setup(payload, timeout=20):
    from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager

    if not websocket_manager.has_clients(ID_OVERLAY):
        raise ConnectionError("The overlay is starting. Try again in a moment.")
    request_id = str(uuid.uuid4())
    event, result = threading.Event(), {}
    with _lock:
        _pending[request_id] = (event, result)
    try:
        websocket_manager.send_nowait(
            ID_OVERLAY,
            {
                "type": "dictionary-setup",
                "request_id": request_id,
                "deadline": int((time.time() + timeout - 1) * 1000),
                "data": payload,
            },
        )
        if not event.wait(timeout):
            raise TimeoutError("The overlay did not reply. Restart the overlay and retry.")
        if result.get("success") is not True:
            raise RuntimeError(result.get("error") or "Dictionary setup failed.")
        return result.get("status", {})
    finally:
        with _lock:
            _pending.pop(request_id, None)


def register_onboarding_routes(app):
    @app.post("/api/onboarding/sudachi")
    def onboarding_sudachi():
        from GameSentenceMiner.sudachi.setup import dictionary_status, install_dictionary

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or payload.get("action") not in ("status", "install"):
            return jsonify(error="Invalid Sudachi setup action."), 400
        dictionary = payload.get("dictionary")
        if dictionary is not None and dictionary not in ("small", "core", "full"):
            return jsonify(error="Invalid Sudachi dictionary edition."), 400
        if payload["action"] == "install":
            return jsonify(install_dictionary(dictionary))
        return jsonify(dictionary_status())

    @app.post("/api/onboarding/language")
    def onboarding_language():
        payload = request.get_json(silent=True)
        language = payload.get("language") if isinstance(payload, dict) else None
        if not isinstance(language, str) or language not in {item.value for item in CommonLanguages}:
            return jsonify(error="Unsupported learning language."), 400
        config = get_config()
        previous = config.general.target_language
        try:
            config.general.target_language = language
            save_current_config(config)
        except Exception:
            config.general.target_language = previous
            raise
        return jsonify(success=True, language=language)

    @app.post("/api/onboarding/dictionary")
    def onboarding_dictionary():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or payload.get("action") not in ("status", "install", "open", "select"):
            return jsonify(error="Invalid dictionary setup action."), 400
        if payload.get("action") == "select" and payload.get("reader") not in ("yomitan", "hachidori"):
            return jsonify(error="Invalid dictionary reader."), 400
        # Language and download sources come from GSM and the bundled catalogue,
        # never arbitrary URLs submitted by a web client.
        data = {"action": payload["action"], "language": get_config().general.target_language}
        if payload["action"] == "select":
            data["reader"] = payload["reader"]
        try:
            return jsonify(request_dictionary_setup(data))
        except ConnectionError as error:
            return jsonify(error=str(error), code="overlay_starting"), 503
        except (TimeoutError, RuntimeError) as error:
            return jsonify(error=str(error)), 502
