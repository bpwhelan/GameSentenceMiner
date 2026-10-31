import json
from types import SimpleNamespace

import numpy as np
import pytest

from GameSentenceMiner.ocr import meiki_model_manager as manager
from GameSentenceMiner.ocr import meiki_models


@pytest.fixture
def selection(monkeypatch, tmp_path):
    monkeypatch.setattr(manager, "get_selection_path", lambda: tmp_path / "selection.json")
    monkeypatch.setattr(manager, "create_detection_session", lambda model: object())
    return tmp_path / "selection.json"


def test_selection_defaults_to_existing_large_model_and_persists(selection):
    assert manager.get_selected_model() == "large"
    assert manager.select_model("small")["model"] == "small"
    assert json.loads(selection.read_text())["model"] == "small"
    assert manager.get_selected_model() == "small"
    assert manager.select_model("large")["model"] == "large"


@pytest.mark.parametrize("failure", ["download", "validation", "save"])
def test_failed_selection_keeps_old_model(selection, monkeypatch, failure):
    manager.select_model("large")
    before = selection.read_bytes()
    if failure == "save":
        monkeypatch.setattr(manager.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("read only")))
    else:
        error = OSError("offline") if failure == "download" else ValueError("invalid ONNX")
        monkeypatch.setattr(manager, "create_detection_session", lambda *a: (_ for _ in ()).throw(error))
    result = manager.handle_model_request({"data": {"model": "small"}})
    assert result["model"] == "large"
    assert result["error"]
    assert selection.read_bytes() == before


@pytest.mark.parametrize("payload", [None, [], {"model": "tiny"}, {"model": []}])
def test_rejects_invalid_requests_without_downloading(selection, monkeypatch, payload):
    monkeypatch.setattr(manager, "create_detection_session", lambda *a: pytest.fail("invalid request downloaded"))
    assert manager.handle_model_request({"data": payload})["error"]
    assert not selection.exists()


def test_busy_selection_does_not_change_manifest(selection):
    with manager._selection_lock:
        result = manager.handle_model_request({"data": {"model": "small"}})
        assert result["busy"]
        assert result["error"]
    assert not selection.exists()


@pytest.mark.parametrize("size, dimensions", [("small", (320, 192)), ("large", (960, 544))])
def test_detection_uses_instance_dimensions_and_restores_original_coordinates(size, dimensions):
    from GameSentenceMiner.ocr.meiki_models import MeikiOCRPipeline

    engine = MeikiOCRPipeline.__new__(MeikiOCRPipeline)
    engine.det_width, engine.det_height = dimensions
    engine.det_session = SimpleNamespace(
        get_inputs=lambda: [SimpleNamespace(name="images"), SimpleNamespace(name="sizes")],
        run=lambda _, inputs: inputs,
    )
    image = np.zeros((100, 1000, 3), dtype=np.uint8)
    tensor, scale = engine._preprocess_for_detection(image)
    assert tensor.shape == (1, 3, dimensions[1], dimensions[0])
    inputs = engine._run_detection_inference(tensor, scale)
    np.testing.assert_allclose(inputs["sizes"], [[1000, int(dimensions[1] / scale)]])
    raw = [None, np.array([[[50, 10, 800, 80]]]), np.array([[0.9]])]
    assert engine._postprocess_detection_results(raw, image, 0.5) == [{"bbox": [50, 10, 800, 80]}]
    # Selecting a detector must never modify the dependency's process-wide dimensions.
    import meikiocr.ocr as upstream

    assert upstream.INPUT_DET_WIDTH == 960
    assert upstream.INPUT_DET_HEIGHT == 544


def test_shared_model_reloads_when_selection_changes_and_reuses_same_choice(selection, monkeypatch):
    from GameSentenceMiner.ocr import SharedMeikiOCRModel as shared

    for name, value in {"_model": None, "_model_key": None, "_init_attempted": False, "_init_error": None}.items():
        monkeypatch.setattr(shared, name, value)
    monkeypatch.setattr(shared, "_preload_onnxruntime_dlls", lambda: None)
    monkeypatch.setattr(shared, "_detect_device", lambda **k: "cpu")
    calls = []

    def create(**kwargs):
        calls.append(kwargs["model_name"])
        return SimpleNamespace(model_name=kwargs["model_name"])

    monkeypatch.setattr(shared, "_create_model", create)
    large = shared.get_model()
    assert large is shared.get_model()
    manager.select_model("small")
    small = shared.get_model()
    assert small is not large
    assert small.model_name == "small"
    assert small is shared.get_model()
    assert calls == ["large", "small"]


def test_detection_model_loads_from_pinned_cache_without_network(monkeypatch, tmp_path):
    import hashlib

    path = tmp_path / "model.onnx"
    path.write_bytes(b"model")
    monkeypatch.setattr(meiki_models, "MODELS", {"small": (320, 192, hashlib.sha256(b"model").hexdigest())})
    calls = []

    def cached(**kwargs):
        calls.append(kwargs)
        assert kwargs["local_files_only"] is True
        assert kwargs["revision"] == meiki_models.DETECTION_REVISION
        assert kwargs["filename"] == "meiki.text.detect.v0.1.320x192.onnx"
        return str(path)

    monkeypatch.setattr(meiki_models, "hf_hub_download", cached)
    monkeypatch.setattr(meiki_models.ort, "InferenceSession", lambda *a, **k: "session")
    assert meiki_models.create_detection_session("small") == "session"
    assert len(calls) == 1
    path.write_bytes(b"bad model")
    with pytest.raises(ValueError, match="checksum"):
        meiki_models.create_detection_session("small")


def test_detection_model_downloads_when_missing_from_cache(monkeypatch, tmp_path):
    import hashlib

    from huggingface_hub.errors import LocalEntryNotFoundError

    path = tmp_path / "model.onnx"
    path.write_bytes(b"model")
    monkeypatch.setattr(meiki_models, "MODELS", {"small": (320, 192, hashlib.sha256(b"model").hexdigest())})
    calls = []

    def download(**kwargs):
        calls.append(kwargs)
        if kwargs.get("local_files_only"):
            raise LocalEntryNotFoundError("not cached")
        return str(path)

    monkeypatch.setattr(meiki_models, "hf_hub_download", download)
    monkeypatch.setattr(meiki_models.ort, "InferenceSession", lambda *a, **k: "session")
    assert meiki_models.create_detection_session("small") == "session"
    assert len(calls) == 2


@pytest.mark.parametrize("engine_name", ["MeikiOCR", "MeikiTextDetector"])
def test_existing_engines_use_new_model_on_the_next_scan(monkeypatch, engine_name):
    from PIL import Image

    from GameSentenceMiner.owocr.owocr import ocr

    calls = []

    def pipeline(name):
        def read(*args, **kwargs):
            calls.append(name)
            return [{"text": "字", "chars": [{"char": "字", "bbox": [10, 10, 30, 30], "conf": 1.0}]}]

        def detect(*args, **kwargs):
            calls.append(name)
            return [{"bbox": [10, 10, 30, 30], "conf": 1.0}]

        return SimpleNamespace(run_ocr=read, run_detection=detect)

    selected = [pipeline("large")]
    monkeypatch.setattr(ocr.SharedMeikiOCRModel, "get_model", lambda **k: selected[0])
    monkeypatch.setattr(ocr, "get_config", lambda: SimpleNamespace(vad=SimpleNamespace(use_cpu_for_inference_v2=True)))
    monkeypatch.setattr(ocr, "get_ocr_language", lambda: "ja")
    engine = getattr(ocr, engine_name)()
    engine.get_furigana_sens_from_file = False
    image = Image.new("RGB", (100, 100))
    assert engine(image)[0]
    selected[0] = pipeline("small")
    assert engine(image)[0]
    assert calls == ["large", "small"]


def test_gpu_inference_failure_reuses_cpu_fallback_for_subsequent_scans(monkeypatch):
    from GameSentenceMiner.ocr import SharedMeikiOCRModel as shared

    def fail(*a, **k):
        raise RuntimeError("CUDA out of memory")

    model = SimpleNamespace(active_provider="CUDAExecutionProvider", model_name="small", run_ocr=fail)
    replacement = SimpleNamespace(run_ocr=lambda *a, **k: ["CPU result"])
    monkeypatch.setattr(shared, "_model", model)
    monkeypatch.setattr(shared, "_device", "cuda")
    monkeypatch.setattr(shared, "_create_model", lambda **k: replacement)
    import GameSentenceMiner.ocr as ocr_module

    recorded = []
    monkeypatch.setattr(ocr_module, "record_runtime", lambda *a, **k: recorded.append((a, k)))
    assert shared.run(model, "run_ocr", None) == ["CPU result"]
    assert shared._model is replacement
    assert shared._device == "cpu"
    assert recorded[-1][0] == ("meiki", "cpu")
