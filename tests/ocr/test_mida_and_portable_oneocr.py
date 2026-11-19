import struct
import threading
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from GameSentenceMiner.ocr.mida import MidaFinder
from GameSentenceMiner.ocr.portable_oneocr import OneOCRLineCache, PortableOneOCR
from GameSentenceMiner.ocr.vocr_onnx import ONNXRuntime


def test_mida_uses_bgr_and_returns_only_clipped_horizontal_lines():
    image = Image.new("RGB", (960, 544), (32, 64, 128))
    maps = np.zeros((1, 4, 68, 120), np.float32)
    maps[:, 0, 0, 0:2] = 1
    maps[:, 0, 5, 5:7] = 1
    maps[:, 1, 5, 5:7] = 1  # A vertical line.
    maps[:, 0, 9, 9] = 1  # A lone grid cell.
    maps[:, 2:] = 1

    def run(outputs, inputs):
        assert outputs == ["maps"]
        np.testing.assert_allclose(inputs["images"][0, :, 0, 0], np.array([128, 64, 32]) / 255)
        return [maps]

    finder = MidaFinder.__new__(MidaFinder)
    finder.classify_polarity = False
    finder.session = SimpleNamespace(run=run)
    boxes, metadata = finder.detect(image)
    assert metadata["finder"] == "mida"
    assert [line["box"] for line in boxes] == [(0, 0, 27, 12)]


def test_vocr_reuses_only_identical_source_lines_and_returns_independent_boxes():
    runtime = ONNXRuntime.__new__(ONNXRuntime)
    runtime._lock = threading.Lock()
    runtime._reading = 0
    runtime._line_cache = {}
    runtime.finder = SimpleNamespace(
        detect=lambda image: ([{"box": (0, 0, 8, 8), "vertical": False, "dark": False}], {})
    )
    calls = []

    def recognize_line(crop, dark):
        calls.append(crop.getpixel((0, 0)))
        return {"text": "文", "characters": [{"box": (0, 0, 1, 1)}]}, {}

    runtime.recognize_line = recognize_line
    image = Image.new("RGB", (16, 16))
    first = runtime.recognize(image)
    first[0]["characters"][0]["box"] = None
    image.putpixel((10, 10), (0, 0, 1))
    assert runtime.recognize(image)[0]["characters"][0]["box"] == (0, 0, 1, 1)
    assert len(calls) == 1
    image.putpixel((0, 0), (0, 0, 1))
    runtime.recognize(image)
    assert len(calls) == 2


def test_portable_line_cache_distinguishes_mode_pixels_and_age():
    calls = []

    def recognize(image, model, mode):
        calls.append((model, mode))
        return len(calls)

    engine = SimpleNamespace(
        analyzer=SimpleNamespace(run_aux=lambda img: {}, run_line_layout=lambda img: (0, 0)),
        recognizer=SimpleNamespace(recognize=recognize),
    )
    cache = OneOCRLineCache(engine)
    read = engine.recognizer.recognize
    image = np.zeros((4, 8, 3), np.uint8)[:, ::2]
    cache.begin()
    assert read(image, "ja", "Auto") == read(image.copy(), "ja", "Auto") == 1
    assert read(image, "ja", "Printed") == 2
    image[0, 0, 0] = 1
    assert read(image, "ja", "Auto") == 3
    for _ in range(5):
        cache.begin()
    assert read(image, "ja", "Auto") == 4


def test_portable_oneocr_failure_closes_worker_and_reports_reason():
    client = PortableOneOCR.__new__(PortableOneOCR)
    client.lock = threading.RLock()
    client.process = SimpleNamespace(poll=lambda: 0)
    sent = []
    client._start = lambda: setattr(client, "process", SimpleNamespace(poll=lambda: None))
    client.close = lambda: setattr(client, "process", None)
    client.socket = SimpleNamespace(sendall=sent.append)
    client._response = lambda: {"error": "unreadable image"}
    with pytest.raises(RuntimeError, match="unreadable image"):
        client.recognize_pil(Image.new("L", (3, 5)))
    assert sent[0] == struct.pack("<II", 3, 5)
    assert len(sent[1]) == 3 * 5 * 4
    assert client.process is None
