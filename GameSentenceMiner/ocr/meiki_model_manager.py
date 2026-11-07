"""Atomic, shared MeikiOCR detector selection for main and overlay OCR."""

import importlib.util
import json
import os
import tempfile
import threading
from pathlib import Path

from GameSentenceMiner.util.data_directory import get_app_directory

MODEL_TOPIC = "ocr.meiki_model"
MODEL_NAMES = ("small", "large")
_selection_lock = threading.Lock()


def get_selection_path():
    return Path(get_app_directory()) / "ocr" / "meikiocr" / "selection.json"


def get_selected_model():
    try:
        selection = json.loads(get_selection_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return "large"
    model = selection.get("model") if isinstance(selection, dict) else None
    if not isinstance(model, str) or model not in MODEL_NAMES:
        raise ValueError("Invalid MeikiOCR model selection. Choose small or large again.")
    return model


def create_detection_session(model):
    # Status checks stay lightweight and work without the optional OCR package.
    from GameSentenceMiner.ocr.meiki_models import create_detection_session as create

    return create(model)


def get_model_status():
    status = {
        "model": "large",
        "available": importlib.util.find_spec("meikiocr") is not None,
        "busy": _selection_lock.locked(),
    }
    try:
        status["model"] = get_selected_model()
    except (OSError, ValueError, TypeError) as error:
        status["error"] = str(error)
    return status


def select_model(model):
    if not isinstance(model, str) or model not in MODEL_NAMES:
        raise ValueError("Choose a MeikiOCR detector: small or large")
    if not _selection_lock.acquire(blocking=False):
        raise RuntimeError("Another MeikiOCR model change is in progress. Try again shortly.")
    temporary = None
    try:
        # Download, checksum and open the candidate before publishing a choice.
        # Existing scans retain their old pipeline until the next scan.
        create_detection_session(model)
        path = get_selection_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False
        ) as file:
            temporary = file.name
            json.dump({"model": model}, file)
            file.write("\n")
        os.replace(temporary, path)
    finally:
        try:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)
        finally:
            _selection_lock.release()
    return get_model_status()


def handle_model_request(message):
    try:
        payload = message.get("data")
        if not isinstance(payload, dict):
            raise TypeError("Expected a MeikiOCR model request")
        return select_model(payload["model"]) if "model" in payload else get_model_status()
    except Exception as error:  # noqa: BLE001 - Serialize provider-specific ONNX and download errors for the UI.
        return {**get_model_status(), "error": str(error)}
