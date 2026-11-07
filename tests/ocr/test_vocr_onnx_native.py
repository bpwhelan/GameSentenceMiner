"""Opt-in C/ONNX parity checks. Set GSM_VOCR_ONNX_TEST_MODELS and GSM_VOCR_ONNX_TEST_ASSETS."""

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from GameSentenceMiner.ocr.vita_ocr import VitaOCRRuntime, _Line
from GameSentenceMiner.ocr.vocr_line_finder import VOCRLineFinder
from GameSentenceMiner.ocr.vocr_onnx import ONNXLineFinder, ONNXRuntime, prepare_line
from scripts.benchmark_vocr_onnx import native_best, native_maps, native_preprocess


@pytest.fixture(scope="module")
def directories():
    models, assets = (os.environ.get(name) for name in ("GSM_VOCR_ONNX_TEST_MODELS", "GSM_VOCR_ONNX_TEST_ASSETS"))
    if not models or not assets:
        pytest.skip("Set GSM_VOCR_ONNX_TEST_MODELS and GSM_VOCR_ONNX_TEST_ASSETS")
    return Path(models), Path(assets)


def line_cases():
    rng = np.random.default_rng(876)
    texts = [
        "今日はいい天気ですね。",
        "「本当に？　ありがとう！」",
        "彼女は静かに扉を開けた……。",
        "午前７時３０分、学校へ向かう。",
    ]
    for font_name in ("msgothic.ttc", "msmincho.ttc", "meiryo.ttc"):
        font = Path("C:/Windows/Fonts") / font_name
        if not font.is_file():
            continue
        for size in (16, 26, 40):
            for dark in (False, True):
                loaded = ImageFont.truetype(str(font), size)
                for text in texts:
                    image = Image.new(
                        "RGB", (int(loaded.getlength(text)) + 17, size + 16), "white" if dark else "black"
                    )
                    ImageDraw.Draw(image).text((7, 4), text, font=loaded, fill="black" if dark else "white")
                    yield f"{font_name}-{size}-{dark}-{text}", image, dark
    for width, height in ((1, 1), (7, 33), (641, 31), (1027, 32), (2049, 19)):
        yield (
            f"noise-{width}-{height}",
            Image.fromarray(rng.integers(0, 256, (height, width, 3), dtype=np.uint8)),
            False,
        )


@pytest.mark.parametrize("tier", ["small", "normal", "large"])
def test_recognition_text_frames_and_character_boxes_match_c(directories, tier):
    models, assets = directories
    c = VitaOCRRuntime(models, model=tier)
    onnx = ONNXRuntime(assets, model=tier)
    count = 0
    for name, image, dark in line_cases():
        pixels = np.ascontiguousarray(image.convert("RGBA"), dtype=np.uint8)
        expected = c._recognize_line(pixels, _Line(0, 0, image.width, image.height, int(dark)))
        actual, best = onnx.recognize_line(image, dark=dark)
        assert actual == expected, name
        np.testing.assert_array_equal(best, native_best(c, image, dark), err_msg=name)
        count += 1
    assert count >= 20, "A Japanese test font is required"


def test_preprocessing_is_byte_exact_to_c_at_small_and_clamped_sizes(directories):
    c = VitaOCRRuntime(directories[0])
    for name, image, _ in line_cases():
        for dark in (False, True):
            expected = native_preprocess(c, image, dark).astype(np.float32) / np.float32(127.5) - np.float32(1)
            actual, _ = prepare_line(image, dark=dark)
            np.testing.assert_array_equal(actual[0, 0], expected, err_msg=name)


@pytest.mark.parametrize("size", [(1, 1), (17, 9), (321, 119), (960, 544), (1921, 1081)])
def test_detector_maps_and_boxes_match_c_on_odd_sizes(directories, size):
    rng = np.random.default_rng(71)
    image = Image.fromarray(rng.integers(0, 256, (size[1], size[0], 3), dtype=np.uint8))
    c = VOCRLineFinder(directories[0])
    onnx = ONNXLineFinder(directories[1])
    expected, scaled = native_maps(c, image)
    np.testing.assert_array_equal(onnx.detect_maps(scaled), expected)
    assert onnx.detect(image)[0] == c.detect(image)[0]


def test_shared_runtime_and_empty_captures(directories):
    runtime = ONNXRuntime(directories[1])
    _, image, _ = next(line_cases())
    expected = runtime.recognize(image)
    with ThreadPoolExecutor(max_workers=3) as pool:
        assert list(pool.map(runtime.recognize, [image] * 6)) == [expected] * 6
    for color in ("white", "black"):
        assert runtime.recognize(Image.new("RGB", (1920, 1080), color)) == []


def test_installation_and_live_model_switch_need_no_native_runtime(directories, monkeypatch, tmp_path):
    from GameSentenceMiner.ocr import vita_model_manager, vita_ocr, vocr_line_finder, vocr_runtime
    from GameSentenceMiner.owocr.owocr.ocr import VitaOCR, VOCRTextDetector
    from scripts.export_vocr_onnx import install_export

    monkeypatch.setenv("GSM_VITA_OCR_DIR", str(tmp_path))
    monkeypatch.setenv("GSM_VOCR_BACKEND", "auto")
    monkeypatch.delenv("GSM_VOCR_ONNX_MODE", raising=False)
    monkeypatch.setattr(vita_ocr, "VitaOCRRuntime", lambda *a, **k: pytest.fail("Loaded native recognizer"))
    monkeypatch.setattr(vocr_line_finder, "VOCRLineFinder", lambda *a, **k: pytest.fail("Loaded native detector"))
    monkeypatch.setattr(vocr_runtime, "_install_runtime", lambda *a, **k: pytest.fail("Downloaded C runtime"))
    install_export(directories[1], tmp_path)
    assert not list(tmp_path.glob("*.vocr"))
    assert not (tmp_path / "runtime").exists()
    assert vita_model_manager.get_model_status()["backend"] == "onnx"
    engine = VitaOCR(get_furigana_sens_from_file=False)
    detector = VOCRTextDetector()
    _, image, _ = next(line_cases())
    assert detector(image)[0]
    for tier in ("large", "small", "normal"):
        status = vita_model_manager.select_model(tier)
        assert status["available"] and status["model"] == tier
        result = engine(image)
        assert result[0] and result[5]["gsm_model"]["size"] == tier
        assert result[5]["gsm_model"]["backend"] == "onnx"
    engine.close()
    detector.close()
