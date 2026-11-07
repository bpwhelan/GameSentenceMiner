"""Shared model selection for main and overlay OCR; never rebuilds the runtime."""

import hashlib
import threading

from GameSentenceMiner.ocr import vocr_runtime
from GameSentenceMiner.ocr.vita_ocr import (
    MODELS,
    RELEASE,
    UPSTREAM_REVISION,
    get_install_directory,
    read_installation,
    read_model_selection,
)

MODEL_TOPIC = "ocr.vita_model"
_selection_lock = threading.Lock()


def _verified(path, digest):
    return path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest


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

        assets = selected_directory()
        if assets is not None:
            status["backend"] = "onnx"
            status["model"] = read_model_selection(directory)
            status["installed"] = installed_models(assets)
            status["available"] = status["model"] in status["installed"]
        else:
            status["backend"] = "c"
            status["supported"] = (
                vocr_runtime.platform_key() in vocr_runtime.RUNTIME_ASSETS or vocr_runtime.runtime_installed(directory)
            )
            try:
                status["model"] = read_installation(directory)["model"]
            except FileNotFoundError:
                pass  # Explicit native backend installs on first use.
            status["installed"] = [
                tier for tier, (name, digest) in MODELS.items() if _verified(directory / name, digest)
            ]
            status["available"] = vocr_runtime.runtime_installed(directory) and status["model"] in status["installed"]
    except (OSError, ValueError, TypeError) as error:
        status["error"] = str(error)
    status["busy"] = status["busy"] or vocr_runtime.is_installing()
    if not status["supported"]:
        status["error"] = f"A prebuilt VOCR runtime is not available for {vocr_runtime.platform_key()}."
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
