"""Shared model selection for main and overlay OCR; never rebuilds the runtime."""

import threading

from GameSentenceMiner.ocr import vocr_runtime
from GameSentenceMiner.ocr.vita_ocr import (
    MODELS,
    RELEASE,
    UPSTREAM_REVISION,
    get_install_directory,
    read_model_selection,
)

MODEL_TOPIC = "ocr.vita_model"
_selection_lock = threading.Lock()


def get_model_status():
    directory = get_install_directory()
    status = {
        "model": "normal",
        "available": False,
        "busy": _selection_lock.locked(),
        "installed": [],
        "revision": UPSTREAM_REVISION,
        "release": RELEASE,
        "supported": True,
    }
    try:
        from GameSentenceMiner.ocr.vocr_onnx import installed_models, selected_directory

        status["backend"] = "onnx"
        status["model"] = read_model_selection(directory)
        status["installed"] = installed_models(selected_directory())
        status["available"] = status["model"] in status["installed"]
    except (OSError, ValueError, TypeError) as error:
        status["error"] = str(error)
    status["busy"] = status["busy"] or vocr_runtime.is_installing()
    return status


def select_model(model):
    if not isinstance(model, str) or model not in MODELS:
        raise ValueError("Choose a VOCR model: small, normal or large")
    if not _selection_lock.acquire(blocking=False):
        raise RuntimeError("Another VOCR model change is in progress. Try again shortly.")
    try:
        vocr_runtime.ensure_installation(get_install_directory(), model=model)
    finally:
        _selection_lock.release()
    return get_model_status()


def handle_model_request(message):
    payload = message.get("data")
    try:
        if not isinstance(payload, dict):
            raise TypeError("Expected a VOCR model request")
        return select_model(payload["model"]) if "model" in payload else get_model_status()
    except (OSError, ValueError, RuntimeError, TypeError, AttributeError) as error:
        return {**get_model_status(), "error": str(error)}
