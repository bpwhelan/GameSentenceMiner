"""Opt-in checks against the compiled runtime and downloaded model.

Set GSM_VITA_OCR_TEST_DIR to an automatically installed or source-built asset directory.
The regular suite remains independent of downloads and native build tools.
"""

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from GameSentenceMiner.ocr.vita_ocr import VitaOCRRuntime


@pytest.fixture(scope="module")
def runtime():
    directory = os.environ.get("GSM_VITA_OCR_TEST_DIR")
    if not directory:
        pytest.skip("Set GSM_VITA_OCR_TEST_DIR to test an installed native runtime")
    return VitaOCRRuntime(directory)


def dialogue(background, foreground):
    font_path = Path(os.environ.get("GSM_VITA_OCR_TEST_FONT", "C:/Windows/Fonts/msgothic.ttc"))
    if not font_path.is_file():
        pytest.skip("A Japanese font is required; set GSM_VITA_OCR_TEST_FONT")
    image = Image.new("RGB", (900, 130), background)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(font_path), 26)
    for y, text in [(12, "今日はいい天気ですね。"), (58, "一緒に学校へ行きましょう。")]:
        draw.text((24, y), text, font=font, fill=foreground)
    return image


@pytest.mark.parametrize("background,foreground", [("black", "white"), ("white", "black")])
def test_native_recognition_and_character_geometry(runtime, background, foreground):
    image = dialogue(background, foreground)
    result = runtime.recognize(image)
    assert [line["text"] for line in result] == ["今日はいい天気ですね。", "一緒に学校へ行きましょう。"]
    for line in result:
        assert "".join(char["text"] for char in line["characters"]) == line["text"]
        previous_right = 0
        for char in line["characters"]:
            x, y, width, height = char["box"]
            assert 0 <= x < x + width <= image.width
            assert 0 <= y < y + height <= image.height
            assert x >= previous_right
            previous_right = x + width


def test_native_empty_capture_and_shared_context(runtime):
    assert runtime.recognize(Image.new("RGB", (900, 130), "black")) == []
    image = dialogue("black", "white")
    expected = runtime.recognize(image)
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(runtime.recognize, [image] * 4))
    assert results == [expected] * 4


def test_real_spotter_handles_multiple_lines_and_desktop_scale(runtime):
    from GameSentenceMiner.ocr.vocr_line_finder import VOCRLineFinder

    finder = VOCRLineFinder(runtime.directory)
    if finder.kind != "spotter":
        pytest.skip("Install the optional spotter with setup_vita_ocr.py --spotter-only")
    sample = dialogue("black", "white")
    page = Image.new("RGB", (900, 450), "black")
    for y in (0, 150, 300):
        page.paste(sample, (0, y))
    boxes, metadata = finder.detect(page)
    assert metadata["finder"] == "spotter"
    assert len(boxes) == 6
    assert len(runtime.recognize(page)) == 6
    scaled = sample.resize((2700, 390))
    boxes, _ = finder.detect(scaled)
    assert len(boxes) == 2
    assert boxes[1]["box"][1] > 130
    assert finder.detect(Image.new("RGB", (1920, 1080), "black"))[0] == []


def test_installed_vita_model_drives_overlay_character_boxes(runtime, monkeypatch, tmp_path):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from GameSentenceMiner.ocr import benchmark
    from GameSentenceMiner.owocr.owocr.ocr import get_regex
    from GameSentenceMiner.util.overlay import get_overlay_coords
    from GameSentenceMiner.util.text_log import TextSource

    monkeypatch.setenv("GSM_VITA_OCR_DIR", os.environ["GSM_VITA_OCR_TEST_DIR"])
    processor = get_overlay_coords.OverlayProcessor()
    processor.ocr_language = "ja"
    processor.regex = get_regex("ja")
    image = dialogue("black", "white")
    config = SimpleNamespace(
        text_appears_instantly=True, adaptive_ocr_retries=False, use_text_filtering=False, use_overlay_area_config=False
    )
    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", lambda: config)
    monkeypatch.setattr(processor, "_get_effective_engine", lambda: "vitaocr")
    monkeypatch.setattr(processor, "_is_supplement_mode_enabled", lambda: False)
    monkeypatch.setattr(processor, "_get_overlay_minimum_character_size", lambda: 0)
    monkeypatch.setattr(processor, "get_image_to_ocr", lambda: (image, 0, 0, *image.size))
    send = AsyncMock()
    monkeypatch.setattr(processor, "_send_word_coordinates_with_presence", send)
    monkeypatch.setattr(processor, "_record_overlay_scan", AsyncMock())
    recorder = benchmark.OCRBenchmarkRecorder(tmp_path)
    monkeypatch.setattr(benchmark, "recorder", recorder)
    recorder.set_enabled(True)
    try:
        assert processor._load_local_ocr_engine().available
        asyncio.run(processor._do_work(source=TextSource.HOTKEY, local_ocr_retry=1))
        payload = send.call_args.args[0]
        assert payload["is_final"] is True
        assert [line["text"] for line in payload["data"]] == ["今日はいい天気ですね。", "一緒に学校へ行きましょう。"]
        assert len(payload["data"][0]["words"]) == len("今日はいい天気ですね。")
        for line in payload["data"]:
            for word in line["words"]:
                box = word["bounding_rect"]
                assert 0 <= box["x1"] < box["x3"] <= 100
                assert 0 <= box["y1"] < box["y3"] <= 100
        assert processor.lens is None
        import csv

        with open(recorder.status()["csv_path"], encoding="utf-8-sig", newline="") as stream:
            row = next(csv.DictReader(stream))
        assert row["model"] == runtime.model
        assert row["model_revision"] == runtime.metadata["revision"]
    finally:
        recorder.set_enabled(False)
        processor._close_ocr_engines()


def test_native_main_pipeline_keeps_model_metadata(runtime, monkeypatch):
    from types import SimpleNamespace

    from GameSentenceMiner.owocr.owocr import ocr, ocr_runtime

    engine = ocr.VitaOCR(get_furigana_sens_from_file=False)
    engine.runtime = runtime
    engine.available = True
    monkeypatch.setattr(
        ocr_runtime,
        "config",
        SimpleNamespace(get_general=lambda key: {"engine_color": "cyan", "notifications": False}.get(key)),
    )
    monkeypatch.setattr(ocr_runtime, "engine_instances", [engine], raising=False)
    monkeypatch.setattr(ocr_runtime, "engine_index", 0, raising=False)
    monkeypatch.setattr(ocr_runtime, "auto_pause_handler", None, raising=False)
    monkeypatch.setattr(
        ocr_runtime, "logger", SimpleNamespace(opt=lambda **_kw: SimpleNamespace(info=lambda *_a, **_k: None))
    )
    monkeypatch.setattr(ocr_runtime, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(ocr_runtime, "get_ocr_advanced_debug_logging", lambda: False)
    monkeypatch.setattr(ocr_runtime, "do_configured_ocr_replacements", lambda text: text)

    class Filtering:
        def __call__(self, text, *_args, **_kwargs):
            return text, [text]

        def extract_text_from_ocr_result(self, result):
            return "\n".join(line.text for paragraph in result.paragraphs for line in paragraph.lines)

        def order_paragraphs_and_lines(self, result):
            return result

    _, text, payload = ocr_runtime.process_and_write_results(
        dialogue("black", "white"),
        filtering=Filtering(),
        return_payload=True,
        apply_area_filters=False,
    )
    assert text
    assert payload["pipeline"]["model"] == runtime.metadata


@pytest.mark.skipif(os.environ.get("GSM_VITA_OCR_TEST_MODEL_SWITCH") != "1", reason="Opt-in real model downloads")
def test_native_model_switch_downloads_and_reloads_all_sizes(runtime, monkeypatch, tmp_path):
    import shutil

    from GameSentenceMiner.ocr import vita_model_manager, vita_ocr, vocr_runtime
    from GameSentenceMiner.ocr.vocr_line_finder import spotter_library_name
    from GameSentenceMiner.owocr.owocr.ocr import VitaOCR

    source = runtime.directory
    runtime_source = vocr_runtime.get_runtime_directory(source)
    shutil.copy2(runtime_source / vita_ocr.library_name(), tmp_path / vita_ocr.library_name())
    for filename in ("installation.json", vita_ocr.MODELS[runtime.model][0]):
        shutil.copy2(source / filename, tmp_path / filename)
    shutil.copy2(runtime_source / spotter_library_name(), tmp_path / spotter_library_name())
    for filename in vocr_runtime.SUPPORT_ASSETS:
        if (source / filename).is_file():
            shutil.copy2(source / filename, tmp_path / filename)
    monkeypatch.setenv("GSM_VITA_OCR_DIR", str(tmp_path))
    engine = VitaOCR(get_furigana_sens_from_file=False)
    image = dialogue("black", "white")
    try:
        for tier in ("small", "large", "normal"):
            assert vita_model_manager.select_model(tier)["model"] == tier
            result = engine(image)
            assert result[0] is True
            expected = VitaOCRRuntime(tmp_path, model=tier).recognize(image)
            assert len(expected) == 2
            assert result[1].splitlines() == [line["text"] for line in expected]
            assert result[5]["gsm_model"]["size"] == tier
            assert result[5]["gsm_model"]["revision"] == vita_ocr.UPSTREAM_REVISION
        assert vita_model_manager.get_model_status()["installed"] == ["normal", "small", "large"]
    finally:
        engine.close()


def test_spotter_only_installation_needs_no_recognition_model(runtime, monkeypatch, tmp_path):
    import shutil

    from GameSentenceMiner.ocr import vocr_runtime
    from GameSentenceMiner.ocr.vocr_line_finder import SPOTTER_FILE, VOCRLineFinder, spotter_library_name
    from GameSentenceMiner.owocr.owocr.ocr import VOCRTextDetector

    if not (runtime.directory / SPOTTER_FILE).is_file():
        pytest.skip("Install the optional spotter")
    native_directory = vocr_runtime.get_runtime_directory(runtime.directory)
    if native_directory != runtime.directory:
        shutil.copytree(native_directory, tmp_path / native_directory.relative_to(runtime.directory))
    else:
        # Source-built fixtures may contain only the standalone spotter.
        shutil.copy2(native_directory / spotter_library_name(), tmp_path / spotter_library_name())
        from GameSentenceMiner.ocr.vita_ocr import write_installation

        write_installation(tmp_path, runtime.model)
        monkeypatch.setattr(vocr_runtime, "_install_runtime", lambda directory: None)
    for filename in vocr_runtime.SUPPORT_ASSETS:
        if filename != "VOCR6-ATTRIBUTION.md":
            shutil.copy2(runtime.directory / filename, tmp_path / filename)
    monkeypatch.setenv("GSM_VITA_OCR_DIR", str(tmp_path))
    detector = VOCRTextDetector()
    result = detector(dialogue("black", "white"))
    assert result[0] is True
    assert result[1] == ""
    assert len(result[5]["boxes"]) == 2
    assert result[5]["gsm_finder"]["finder"] == "spotter"
    assert not list(tmp_path.glob("*.vocr"))
    # Corrupt weights are refused before native parsing; the standalone
    # library still supplies GRAD without requiring the recognizer DLL.
    (tmp_path / SPOTTER_FILE).write_bytes(b"corrupt")
    finder = VOCRLineFinder(tmp_path)
    boxes, metadata = finder.detect(dialogue("black", "white"))
    assert metadata["finder"] == "grad"
    assert "checksum" in metadata["fallback_reason"]
    assert len(boxes) == 2
