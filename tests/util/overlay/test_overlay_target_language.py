import asyncio
from dataclasses import asdict
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from PIL import Image

from GameSentenceMiner.owocr.owocr import ocr, ocr_runtime
from GameSentenceMiner.util.config import electron_config
from GameSentenceMiner.util.overlay import get_overlay_coords


@pytest.fixture
def target_config(monkeypatch):
    config = SimpleNamespace(general=SimpleNamespace(target_language="ko"))
    monkeypatch.setattr(get_overlay_coords, "get_config", lambda: config)
    monkeypatch.setattr(
        electron_config, "_get_ocr_value", lambda key, default=None: "ja" if key == "language" else default
    )
    monkeypatch.setattr(get_overlay_coords, "set_dpi_awareness", lambda: None)
    monkeypatch.setattr(ocr_runtime, "get_furigana_filter_sensitivity", lambda: 0)
    return config


def _ocr_result(texts):
    lines = []
    for index, text in enumerate(texts):
        box = ocr.BoundingBox(center_x=0.5, center_y=0.2 + index * 0.3, width=0.8, height=0.1)
        lines.append(ocr.Line(text=text, bounding_box=box, words=[ocr.Word(text=text, bounding_box=box)]))
    return ocr.OcrResult(
        image_properties=ocr.ImageProperties(width=1000, height=1000),
        engine_capabilities=ocr.OneOCR.capabilities,
        paragraphs=[ocr.Paragraph(bounding_box=line.bounding_box, lines=[line]) for line in lines],
    )


@pytest.mark.parametrize("language,text", [("ko", "안녕하세요"), ("en", "hello world")])
@pytest.mark.parametrize("mode", ["python", "native", "shadow"])
def test_overlay_filters_using_target_language(monkeypatch, target_config, language, text, mode):
    target_config.general.target_language = language
    monkeypatch.setenv("GSM_NATIVE_OCR_MODE", mode)
    processor = get_overlay_coords.OverlayProcessor()
    processor.init()

    result = processor._filter_local_ocr_results_by_language(
        [{"text": "こんにちは", "words": []}, {"text": text, "words": []}]
    )

    assert processor.ready
    assert [line["text"] for line in result] == [text]


@pytest.mark.parametrize("engine_name", ["ONEOCR", "MEIKIOCR", "SCREENAI", "LENS"])
def test_overlay_loads_engines_with_target_language(monkeypatch, target_config, engine_name):
    factories = {}
    for class_name in ("OneOCR", "MeikiOCR", "ScreenAIOCR", "GoogleLens"):
        factories[class_name] = Mock()
        monkeypatch.setattr(get_overlay_coords, class_name, factories[class_name])
    monkeypatch.setattr(get_overlay_coords, "is_windows", lambda: True)
    processor = get_overlay_coords.OverlayProcessor()
    monkeypatch.setattr(
        processor, "_get_effective_engine", lambda: getattr(get_overlay_coords.OverlayEngine, engine_name).value
    )
    monkeypatch.setattr(processor, "find_box_for_sentence", AsyncMock(return_value=[]))

    async def scan():
        processor.processing_loop = asyncio.get_running_loop()
        await processor.find_box_and_send_to_overlay()

    asyncio.run(scan())

    called = [factory for factory in factories.values() if factory.called]
    assert len(called) == (2 if engine_name == "LENS" else 1)
    assert all(factory.call_args.kwargs["lang"] == "ko" for factory in called)


@pytest.mark.parametrize("mode", ["python", "native", "shadow"])
def test_overlay_layout_keeps_target_language_text(monkeypatch, target_config, mode):
    monkeypatch.setenv("GSM_NATIVE_OCR_MODE", mode)
    processor = get_overlay_coords.OverlayProcessor()

    result = processor._apply_text_filtering_to_results(asdict(_ocr_result(["안녕하세요", "こんにちは"])))

    assert result is not None
    assert [line["text"] for line in result] == ["안녕하세요"]


@pytest.mark.parametrize("mode", ["python", "native", "shadow"])
def test_layout_uses_explicit_language_for_reading_direction(monkeypatch, target_config, mode):
    monkeypatch.setenv("GSM_NATIVE_OCR_MODE", mode)
    filtering = ocr_runtime.TextFiltering("ar")

    result = filtering.order_paragraphs_and_lines(_ocr_result(["مرحبا بالعالم"]), language="ar")

    assert result.paragraphs[0].writing_direction == "RIGHT_TO_LEFT"


@pytest.mark.parametrize("engine_class", [ocr.OneOCR, ocr.MeikiOCR, ocr.ScreenAIOCR])
def test_local_engine_scan_honors_explicit_language(monkeypatch, target_config, engine_class):
    engine = engine_class.__new__(engine_class)
    engine.available = True
    engine.initial_lang = "ja"
    engine.regex = ocr.get_regex("ja")
    engine.get_furigana_sens_from_file = False
    engine._to_generic_result = lambda *_args: _ocr_result(["안녕하세요", "こんにちは"])
    engine._preprocess_windows = lambda image: image
    engine._recognize_pil = lambda _image: {}
    engine._preprocess = lambda image, **_kwargs: image
    engine._perform_ocr = lambda _image: b"response"
    engine.debug_dump_response = False
    engine.model = SimpleNamespace(
        run_ocr=lambda *_args, **_kwargs: [
            {
                "text": text,
                "chars": [{"char": text, "bbox": [10, 10 + index * 100, 900, 90 + index * 100], "conf": 1.0}],
            }
            for index, text in enumerate(["안녕하세요", "こんにちは"])
        ]
    )
    monkeypatch.setattr(ocr, "sys", SimpleNamespace(platform="win32"))

    result = engine(Image.new("RGB", (1000, 1000)), return_coords=True, language="ko")

    assert result[0] is True
    assert [line["text"] for line in result[2]] == ["안녕하세요"]

    ocr_result = engine(Image.new("RGB", (1000, 1000)), return_coords=True)

    assert ocr_result[0] is True
    assert [line["text"] for line in ocr_result[2]] == ["こんにちは"]


def test_overlay_refreshes_language_when_target_changes(monkeypatch, target_config):
    processor = get_overlay_coords.OverlayProcessor()
    processor.init()
    monkeypatch.setattr(processor, "_should_use_precomputed_overlay_payload", lambda _payload: True)
    monkeypatch.setattr(processor, "_is_supplement_mode_enabled", lambda: False)
    monkeypatch.setattr(processor, "find_box_for_sentence", AsyncMock(return_value=[]))
    target_config.general.target_language = "en"

    async def scan():
        processor.processing_loop = asyncio.get_running_loop()
        await processor.find_box_and_send_to_overlay()

    asyncio.run(scan())

    assert processor.ocr_language == "en"
    assert processor.regex.search("hello")
    assert not processor.regex.search("こんにちは")
