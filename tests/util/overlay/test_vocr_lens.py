import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from GameSentenceMiner.owocr.owocr.ocr import _build_text_detection_result
from GameSentenceMiner.util.overlay import get_overlay_coords
from GameSentenceMiner.util.text_log import TextSource


@pytest.mark.parametrize("empty", [False, True])
def test_detector_only_overlay_crops_lens_input_and_skips_blank_scenes(monkeypatch, empty):
    processor = get_overlay_coords.OverlayProcessor()
    processor.ocr_language = "ja"
    processor.regex = get_overlay_coords.get_regex("ja")
    image = Image.new("RGB", (200, 100), "white")
    boxes = [] if empty else [{"box": [20, 30, 160, 60], "score": 1}]
    detector = lambda *_a, **_k: _build_text_detection_result("vocr_detector", boxes, 200, 100, 0)
    processor.vocr_detector = detector
    calls = []

    def lens(capture, **kwargs):
        calls.append(capture)
        return True, ["本文です"], [], [], None, {"result": True}

    processor.lens = lens
    monkeypatch.setattr(processor, "_get_effective_engine", lambda: "vocr_lens")
    monkeypatch.setattr(processor, "_is_supplement_mode_enabled", lambda: False)
    monkeypatch.setattr(processor, "_get_overlay_minimum_character_size", lambda: 0)
    monkeypatch.setattr(processor, "get_image_to_ocr", lambda: (image, 30, 40, 200, 100))
    monkeypatch.setattr(processor, "_extract_text_with_pixel_boxes", lambda **kwargs: [{"text": "本文です"}])
    send = AsyncMock()
    monkeypatch.setattr(processor, "_send_word_coordinates_with_presence", send)
    monkeypatch.setattr(processor, "_record_overlay_scan", AsyncMock())
    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", lambda: SimpleNamespace(use_text_filtering=False))
    asyncio.run(processor._do_work(source=TextSource.HOTKEY))
    assert send.call_args.args[0]["is_final"] is True
    if empty:
        assert calls == []
        assert send.call_args.args[0]["data"] == []
    else:
        capture = calls[0]
        assert capture.size == image.size
        assert capture.getpixel((10, 10))[3] == 0
        assert capture.getpixel((30, 40)) == (255, 255, 255, 255)
        assert send.call_args.args[0]["data"][0]["text"] == "本文です"


def test_overlay_loads_detector_and_lens_without_loading_a_recognizer(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    monkeypatch.setattr(processor, "_get_effective_engine", lambda: "vocr_lens")
    detector = object()
    monkeypatch.setattr(get_overlay_coords, "VOCRTextDetector", lambda **kwargs: detector)
    processor._load_local_ocr_engine()
    assert processor.vocr_detector is detector
    assert processor.oneocr is processor.vitaocr is processor.meikiocr is None
