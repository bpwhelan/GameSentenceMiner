"""Acknowledged, short-lived requests to configure the running overlay's Yomitan."""

import threading
import time
import uuid

from GameSentenceMiner.anki_setup import AnkiSetupError

_pending = {}
_lock = threading.Lock()


def accept_yomitan_setup_result(message: dict) -> bool:
    with _lock:
        pending = _pending.get(message.get("request_id"))
        if pending is None:
            return False
        event, result = pending
        result.update(message)
        event.set()
        return True


def configure_yomitan(payload: dict, *, timeout: float = 25) -> str:
    from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager

    if not websocket_manager.has_clients(ID_OVERLAY):
        raise AnkiSetupError("Start the GSM overlay with Yomitan selected, then retry setup.")
    request_id = str(uuid.uuid4())
    event = threading.Event()
    result = {}
    with _lock:
        _pending[request_id] = (event, result)
    try:
        websocket_manager.send_nowait(
            ID_OVERLAY,
            {
                "type": "anki-setup-yomitan",
                "request_id": request_id,
                "deadline": int((time.time() + timeout - 1) * 1000),
                "data": payload,
            },
        )
        if not event.wait(timeout):
            raise AnkiSetupError("The overlay did not confirm Yomitan setup. Start or restart it, then retry setup.")
        if result.get("success") is not True or not isinstance(result.get("profileName"), str):
            raise AnkiSetupError(result.get("error") or "Yomitan could not apply the selected fields.")
        return result["profileName"]
    finally:
        with _lock:
            _pending.pop(request_id, None)
