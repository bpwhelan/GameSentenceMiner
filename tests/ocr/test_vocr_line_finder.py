import threading
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from GameSentenceMiner.ocr import vocr_line_finder as module
from GameSentenceMiner.ocr.vita_ocr import _Line
from GameSentenceMiner.owocr.owocr import ocr


def fake_finder(*, boxes=(), status=0, truncated=False):
    calls = []
    finder = object.__new__(module.VOCRLineFinder)
    finder.kind, finder.fallback_reason = "spotter", ""
    finder._lock = threading.Lock()
    finder._arena = np.empty(0, dtype=np.uint8)
    finder._model = np.empty(1, dtype=np.uint8)

    def spot(_model, image, _flags, _arena, _size, output):
        calls.append(("spotter", image._obj.width, image._obj.height))
        output._obj.count = len(boxes)
        output._obj.truncated = truncated
        for i, box in enumerate(boxes):
            output._obj.boxes[i] = module._Box(*box)
        return status

    def grad(_image, _mode, _arena, _size, output):
        calls.append(("grad",))
        output._obj.count = 1
        output._obj.lines[0] = _Line(10, 20, 30, 15, 0)
        return 0

    finder.lib = SimpleNamespace(
        vocr_textspot6_frame_arena_bytes_flags=lambda *_a: 16,
        vocr_textspot6_find=spot,
        vocr_lines_arena_bytes=lambda *_a: 16,
        vocr_find_lines=grad,
    )
    return finder, calls


def test_empty_spotter_capture_never_falls_back_to_grad():
    finder, calls = fake_finder()
    boxes, metadata = finder.detect(Image.new("RGB", (900, 130)))
    assert boxes == []
    assert metadata["finder"] == "spotter"
    assert [item[0] for item in calls] == ["spotter"]


@pytest.mark.parametrize("status,truncated", [(-1, False), (0, True)])
def test_only_structural_spotter_failure_uses_grad(status, truncated):
    finder, calls = fake_finder(status=status, truncated=truncated)
    boxes, metadata = finder.detect(Image.new("RGB", (900, 130)))
    assert [item[0] for item in calls] == ["spotter", "grad"]
    assert metadata["finder"] == "grad"
    assert metadata["fallback_reason"]
    assert boxes[0]["box"] == (10, 20, 40, 35)


def test_desktop_scaling_maps_detector_coordinates_back_to_original_capture():
    finder, calls = fake_finder(boxes=[(10, 20, 30, 15, 0, 100, 1, 0, 0, 0)])
    boxes, _ = finder.detect(Image.new("RGB", (1920, 1080)))
    assert calls == [("spotter", 960, 540)]
    assert boxes[0]["box"] == (20, 40, 80, 70)
    assert boxes[0]["dark"] is True
    assert boxes[0]["score"] == pytest.approx(100 / 127)


def test_detector_returns_geometry_without_loading_recognizer(monkeypatch):
    finder, _ = fake_finder(boxes=[(10, 20, 30, 15, 0, 100, 0, 0, 0, 0)])
    monkeypatch.setattr(module, "VOCRLineFinder", lambda: finder)
    engine = ocr.VOCRTextDetector()
    result = engine(Image.new("RGB", (100, 60)))
    assert result[0] is True
    assert result[1] == ""
    assert result[5]["schema"] == "gsm_text_detection_v1"
    assert result[5]["boxes"][0]["box"] == [10, 20, 40, 35]
    assert result[5]["gsm_finder"]["finder"] == "spotter"
    engine.close()
    assert engine(Image.new("RGB", (100, 60)))[0] is False
