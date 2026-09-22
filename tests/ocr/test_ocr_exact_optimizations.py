"""Output parity for the OCR hot path; timings live in the benchmark script."""

from dataclasses import asdict, dataclass
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from GameSentenceMiner.owocr.owocr import ocr


def legacy_quad(bbox, width, height):
    w, h = bbox.width * width, bbox.height * height
    cx, cy = bbox.center_x * width, bbox.center_y * height
    angle = bbox.rotation_z or 0.0
    local = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]])
    if abs(angle) < 1e-12:
        corners = local + [cx, cy]
    else:
        cos_a, sin_a = np.cos(angle), np.sin(angle)
        corners = local @ np.array([[cos_a, -sin_a], [sin_a, cos_a]]).T + [cx, cy]
    return {axis + str(i + 1): int(corner[j]) for i, corner in enumerate(corners) for j, axis in enumerate("xy")}


@pytest.mark.parametrize("angle", [None, 0.0, -0.0, 1e-13, -1e-13, 1e-12, -0.15, 0.15, np.pi / 2])
def test_pixel_quads_exactly_match_numpy_arithmetic(angle):
    rng = np.random.default_rng(761)
    for _ in range(100):
        bbox = ocr.BoundingBox(*rng.uniform(-0.2, 1.2, 4).tolist(), rotation_z=angle)
        width, height = rng.integers(1, 10001, 2).tolist()
        assert ocr._bounding_box_to_quad(bbox, width, height) == legacy_quad(bbox, width, height)


def test_pixel_quads_preserve_mixed_numpy_precision():
    rng = np.random.default_rng(925)
    for _ in range(500):
        x, y, w, h = rng.uniform(-0.2, 1.2, 4).tolist()
        bbox = ocr.BoundingBox(x, y, np.float32(w), np.float32(h))
        assert ocr._bounding_box_to_quad(bbox, 3840, 2160) == legacy_quad(bbox, 3840, 2160)
    width = np.float32(0.1234567)
    center = (float(width * 3840 / 2) + 200 - 1e-6) / 3840
    bbox = ocr.BoundingBox(center, 0.5, width, np.float32(0.1))
    assert ocr._bounding_box_to_quad(bbox, 3840, 2160) == legacy_quad(bbox, 3840, 2160)


def test_serialized_result_matches_asdict_and_owns_mutable_containers():
    bbox = ocr.BoundingBox(np.float64(0.5), 0.4, 0.2, 0.1, -0.0)
    symbol = ocr.Symbol("字", bbox, separator=" ")
    word = ocr.Word("字", bbox, symbols=[symbol])
    line = ocr.Line(bbox, words=[word], text="字")
    result = ocr.OcrResult(
        ocr.ImageProperties(1920, 1080, window_handle=123),
        ocr.OneOCR.capabilities,
        [ocr.Paragraph(bbox, [line], writing_direction="TOP_TO_BOTTOM")],
    )
    expected = asdict(result)
    actual = ocr._ocr_result_to_dict(result)
    assert actual == expected
    assert type(actual["paragraphs"][0]["bounding_box"]["center_x"]) is np.float64
    actual["paragraphs"][0]["lines"][0]["words"][0]["symbols"].clear()
    actual["engine_capabilities"]["words"] = False
    assert asdict(result) == expected


@pytest.mark.parametrize("mode", ["1", "L", "LA", "P", "RGB", "RGBA", "CMYK", "I", "F"])
def test_oneocr_pixel_buffer_is_byte_identical_to_upstream(mode):
    rng = np.random.default_rng(818)
    image = Image.fromarray(rng.integers(0, 256, (51, 73, 4), dtype=np.uint8)).convert(mode)
    rgba = image if image.mode == "RGBA" else image.convert("RGBA")
    b, g, r, a = rgba.split()
    expected = Image.merge("RGBA", (b, g, r, a)).tobytes()
    captured = {}

    def process(**kwargs):
        captured.update(kwargs)
        return {"lines": []}

    engine = ocr.OneOCR.__new__(ocr.OneOCR)
    engine.model = SimpleNamespace(_process_image=process)
    assert engine._recognize_pil(image) == {"lines": []}
    assert captured == {"cols": 73, "rows": 51, "step": 73 * 4, "data": expected}


@pytest.mark.parametrize("size", [(49, 51), (51, 49), (10001, 51)])
def test_oneocr_preserves_upstream_invalid_size_handling(size):
    expected = {"error": "Unsupported image size"}
    engine = ocr.OneOCR.__new__(ocr.OneOCR)
    engine.model = SimpleNamespace(
        recognize_pil=lambda image: expected,
        _process_image=lambda **kwargs: pytest.fail("Invalid dimensions must use the upstream error path"),
    )
    assert engine._recognize_pil(Image.new("RGB", size)) is expected


def test_oneocr_supports_models_without_raw_pixel_api():
    image = Image.new("RGB", (51, 51))
    engine = ocr.OneOCR.__new__(ocr.OneOCR)
    engine.model = SimpleNamespace(recognize_pil=lambda value: value)
    assert engine._recognize_pil(image) is image


def test_oneocr_rgb_encoder_does_not_materialize_an_rgba_image(monkeypatch):
    engine = ocr.OneOCR.__new__(ocr.OneOCR)
    engine.model = SimpleNamespace(_process_image=lambda **kwargs: kwargs["data"])
    image = Image.new("RGB", (51, 51), (12, 34, 56))
    monkeypatch.setattr(image, "convert", lambda *_args: pytest.fail("RGB should encode directly"))
    assert engine._recognize_pil(image) == bytes((12, 34, 56, 255)) * (51 * 51)


def test_oneocr_preserves_rgb_transparency_metadata():
    engine = ocr.OneOCR.__new__(ocr.OneOCR)
    engine.model = SimpleNamespace(_process_image=lambda **kwargs: kwargs["data"])
    image = Image.new("RGB", (51, 51), (12, 34, 56))
    image.info["transparency"] = (12, 34, 56)
    assert engine._recognize_pil(image) == image.convert("RGBA").tobytes()


@pytest.mark.parametrize("mode", ["1", "L", "LA", "P", "RGB", "RGBA", "CMYK", "I", "F"])
def test_rgb_numpy_buffers_preserve_pixels_and_are_writable(mode):
    image = Image.fromarray(np.random.default_rng(123).integers(0, 256, (7, 19, 4), dtype=np.uint8)).convert(mode)
    expected = np.array(image.convert("RGB"))
    actual = ocr.pil_image_to_rgb_numpy_array(image)
    np.testing.assert_array_equal(actual, expected)
    assert actual.flags.writeable
    actual[:] = 0
    np.testing.assert_array_equal(np.array(image.convert("RGB")), expected)


@pytest.mark.parametrize("mode", ["L", "RGBA"])
def test_rgb_array_conversion_does_not_copy_through_an_intermediate_pil_image(mode, monkeypatch):
    pytest.importorskip("cv2")
    image = Image.new(mode, (51, 51))
    monkeypatch.setattr(image, "convert", lambda *_args: pytest.fail("Convert directly into the writable numpy buffer"))
    assert ocr.pil_image_to_rgb_numpy_array(image).shape == (51, 51, 3)


def test_rgb_array_conversion_still_works_without_opencv(monkeypatch):
    image = Image.new("RGBA", (7, 9), (12, 34, 56, 78))
    monkeypatch.setattr(ocr, "_load_cv2_module", lambda: None)
    np.testing.assert_array_equal(ocr.pil_image_to_rgb_numpy_array(image), np.array(image.convert("RGB")))


@pytest.mark.parametrize("mode", ["L", "RGB", "RGBA"])
@pytest.mark.parametrize("size", [(0, 0), (0, 17), (17, 0)])
def test_rgb_array_conversion_preserves_empty_images(mode, size):
    image = Image.new(mode, size)
    np.testing.assert_array_equal(ocr.pil_image_to_rgb_numpy_array(image), np.array(image.convert("RGB")))


@pytest.mark.parametrize("mode", ["L", "RGB", "RGBA", "P"])
def test_fast_png_encoder_preserves_rgba_bytes(mode, monkeypatch):
    image = Image.fromarray(np.random.default_rng(12).integers(0, 256, (9, 17, 4), dtype=np.uint8)).convert(mode)
    if mode == "RGB":
        image.info["transparency"] = tuple(image.getpixel((0, 0)))
    expected = image.convert("RGBA").tobytes()
    fake_fpng = SimpleNamespace(fpng_encode_image_to_memory=lambda data, width, height: (data, width, height))
    monkeypatch.setattr(ocr, "_load_fpng_module", lambda: fake_fpng)
    assert ocr.pil_image_to_bytes(image) == (expected, 17, 9)


def test_fast_png_encoder_avoids_copying_an_rgba_image(monkeypatch):
    image = Image.new("RGBA", (7, 9), (1, 2, 3, 4))
    fake_fpng = SimpleNamespace(fpng_encode_image_to_memory=lambda data, width, height: data)
    monkeypatch.setattr(ocr, "_load_fpng_module", lambda: fake_fpng)
    monkeypatch.setattr(image, "convert", lambda *_args: pytest.fail("The image is already RGBA"))
    assert ocr.pil_image_to_bytes(image) == bytes((1, 2, 3, 4)) * (7 * 9)


@pytest.mark.parametrize("mode", ["1", "L", "P", "LA", "RGB", "RGBA", "I", "F"])
def test_sampled_empty_frame_decisions_are_unchanged(mode):
    from GameSentenceMiner.owocr.owocr import ocr_runtime

    rng = np.random.default_rng(92)
    for size in ((1, 1), (3, 2), (40, 30), (129, 257)):
        for kind in ("noise", "black", "color"):
            if kind == "noise":
                pixels = rng.integers(0, 256, (*size[::-1], 4), dtype=np.uint8)
                image = Image.fromarray(pixels).convert(mode)
            else:
                image = Image.new("RGB", size, "black" if kind == "black" else (30, 100, 200)).convert(mode)
            step = max(1, min(64, max(image.height // 4, 1), max(image.width // 4, 1)))
            samples = [
                [image.getpixel((x, y)) for x in range(0, image.width, step)] for y in range(0, image.height, step)
            ]
            expected = ocr_runtime.is_image_empty(np.asarray(samples), sample_step=1)
            assert ocr_runtime._is_capture_frame_empty(image) == expected


def test_serialization_keeps_asdict_rules_for_extended_schema():
    @dataclass
    class ExtendedBox(ocr.BoundingBox):
        custom: object = None

    child = ocr.BoundingBox(0.5, 0.5, 0.2, 0.1)
    bbox = ExtendedBox(0.1, 0.2, 0.3, 0.4, custom={"nested": (child, [child])})
    result = ocr.OcrResult(ocr.ImageProperties(100, 200), ocr.OneOCR.capabilities, [ocr.Paragraph(bbox)])
    assert ocr._ocr_result_to_dict(result) == asdict(result)


def test_text_normalization_caches_strings_without_caching_mutable_inputs(monkeypatch):
    from GameSentenceMiner.ocr import compare

    compare._normalize_comparison_string.cache_clear()
    real_normalize = compare.unicodedata.normalize
    calls = []

    def normalize(form, value):
        calls.append(value)
        return real_normalize(form, value)

    monkeypatch.setattr(compare.unicodedata, "normalize", normalize)
    value = ["Ａ：Ｂ"]
    assert compare.normalize_for_comparison(value) == "AB"
    assert compare.normalize_for_comparison(value) == "AB"
    value[0] = "Ｃ：Ｄ"
    assert compare.normalize_for_comparison(value) == "CD"
    assert len(calls) == 2
    compare._normalize_comparison_string.cache_clear()


def test_matching_block_cache_preserves_settings_and_reuses_repeated_pairs(monkeypatch):
    from GameSentenceMiner.ocr import compare

    compare._matching_block_stats_cached.cache_clear()
    original = compare.native_text.matching_block_stats
    calls = 0

    def matcher(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(compare.native_text, "matching_block_stats", matcher)
    assert compare._matching_block_stats("abcde", "axcye") == (0.0, 1)
    assert compare._matching_block_stats("abcde", "axcye") == (0.0, 1)
    custom = compare.OCRCompareSettings(matching_block_default_min_size=1)
    assert compare._matching_block_stats("abcde", "axcye", custom) == (0.6, 1)
    assert calls == 2
    compare._matching_block_stats_cached.cache_clear()


def test_comparison_caches_do_not_retain_large_texts():
    from GameSentenceMiner.ocr import compare

    compare._normalize_comparison_string.cache_clear()
    compare._matching_block_stats_cached.cache_clear()
    text = "文" * 5000
    assert compare.normalize_for_comparison(text) == text
    assert compare._matching_block_stats(text, "文字") == (0.5, 1)
    assert compare._normalize_comparison_string.cache_info().currsize == 0
    assert compare._matching_block_stats_cached.cache_info().currsize == 0


def test_stability_reference_does_not_build_discarded_signatures(monkeypatch):
    from GameSentenceMiner.util import image_stability as stability

    image = Image.new("RGB", (100, 60), "white")
    gate = stability.ImageStabilityGate()
    payload = {"crop_coords": (5, 5, 95, 55)}
    assert gate.update_reference(image, payload)
    previous = gate._candidate

    def unexpected_signature(*_args, **_kwargs):
        pytest.fail("An unchanged reference region must retain its existing signature")

    monkeypatch.setattr(stability._ImageSignature, "from_gray", unexpected_signature)
    assert gate.update_reference(image, payload)
    assert gate._candidate is previous
    assert not gate.update_reference(image, {"crop_coords": (0, 0, 1, 1)})


@pytest.mark.parametrize("percentile", [0, 50, 88, 100])
def test_image_histogram_percentiles_match_numpy_exactly(percentile):
    from GameSentenceMiner.util import image_stability as stability

    rng = np.random.default_rng(417)
    for length in (1, 2, 3, 100, 511, 512, 513, 1024, 1201, 153600):
        for maximum in (1, 15, 255):
            values = rng.integers(0, maximum + 1, (1, length), dtype=np.uint8)
            assert stability._uint8_percentile(values, percentile) == float(np.percentile(values, percentile))
            assert stability._uint8_percentile(values[:, ::2], percentile) == float(
                np.percentile(values[:, ::2], percentile)
            )


def test_stability_masks_and_similarity_match_legacy_calculation():
    import cv2

    from GameSentenceMiner.util import image_stability as stability

    def legacy_score(reference, current):
        reference_count, current_count = int(reference.sum()), int(current.sum())
        if not reference_count or not current_count:
            return 0.0
        kernel = np.ones((3, 3), dtype=np.uint8)
        recall = float(np.logical_and(reference > 0, cv2.dilate(current, kernel) > 0).sum()) / reference_count
        precision = float(np.logical_and(current > 0, cv2.dilate(reference, kernel) > 0).sum()) / current_count
        return (2.0 * recall * precision) / (recall + precision) if recall + precision > 0 else 0.0

    rng = np.random.default_rng(542)
    for shape in ((3, 3), (31, 48), (240, 640)):
        for maximum in (1, 20, 255):
            gray = rng.integers(0, maximum + 1, shape, dtype=np.uint8)
            blurred = cv2.GaussianBlur(gray, (0, 0), 2.0)
            detail = gray.astype(np.int16) - blurred.astype(np.int16)
            threshold = max(10.0, float(np.percentile(np.abs(detail), 88)))
            bright, dark = stability._contrast_masks(gray)
            np.testing.assert_array_equal(bright, (detail >= threshold).astype(np.uint8))
            np.testing.assert_array_equal(dark, (detail <= -threshold).astype(np.uint8))
            median = float(np.median(gray))
            lower = max(12, int(0.55 * median))
            upper = max(lower + 1, min(255, int(1.45 * median) + 20))
            expected_edge = (cv2.Canny(gray, lower, upper, L2gradient=True) > 0).astype(np.uint8)
            np.testing.assert_array_equal(stability._edge_mask(gray), expected_edge)
            reference = rng.integers(0, 2, shape, dtype=np.uint8)
            assert stability._tolerant_f1(reference, bright) == legacy_score(reference, bright)


def test_changed_stability_frame_builds_its_signature_only_once(monkeypatch):
    from GameSentenceMiner.util import image_stability as stability

    image = Image.fromarray(np.random.default_rng(11).integers(0, 256, (60, 100), dtype=np.uint8))
    gate = stability.ImageStabilityGate(similarity_threshold=1.1)
    assert gate.update_reference(image, {"crop_coords": (0, 0, 100, 60)})
    calls = 0
    original = stability._contrast_masks

    def masks(gray):
        nonlocal calls
        calls += 1
        return original(gray)

    monkeypatch.setattr(stability, "_contrast_masks", masks)
    observation = gate.observe(image)
    assert observation.similarity == 1.0
    assert observation.should_run
    assert calls == 1


def test_perfect_contrast_match_does_not_need_edge_detection(monkeypatch):
    from GameSentenceMiner.util import image_stability as stability

    image = Image.fromarray(np.random.default_rng(12).integers(0, 256, (60, 100), dtype=np.uint8))
    gate = stability.ImageStabilityGate()
    assert gate.update_reference(image, {"crop_coords": (0, 0, 100, 60)})
    monkeypatch.setattr(stability, "_edge_mask", lambda _gray: pytest.fail("Edges cannot improve a perfect score"))
    assert gate.observe(image).similarity == 1.0
