from __future__ import annotations

import copy
import random

import pytest

from GameSentenceMiner import _native
from GameSentenceMiner.util.overlay.get_overlay_coords import OverlayProcessor


def rect(x, y, width, height):
    return {"x1": x, "y1": y, "x2": x + width, "y2": y, "x3": x + width, "y3": y + height, "x4": x, "y4": y + height}


def frame(seed=0, count=5):
    rng = random.Random(seed)
    lines = []
    for index in range(count):
        words = [
            {
                "text": rng.choice(["日本語", "ABC", "𠮷🙂", "", " "]),
                "bounding_rect": rect(
                    rng.uniform(-500, 2000), rng.uniform(-300, 900), rng.uniform(0, 100), rng.uniform(0, 40)
                ),
            }
            for _ in range(rng.randrange(12))
        ]
        lines.append(
            {
                "text": f"line {index}",
                "bounding_rect": rect(
                    rng.uniform(-500, 2000), rng.uniform(-300, 900), rng.uniform(0, 1000), rng.uniform(0, 400)
                ),
                "words": words,
                "extra": {"unchanged": True},
            }
        )
    return lines


def processor():
    result = OverlayProcessor.__new__(OverlayProcessor)
    result.last_monitor_left = -2560
    result.last_monitor_top = -180
    result.calculated_width_scale_factor = 0.73
    result.calculated_height_scale_factor = 1.3
    result.ocr_language = "en"
    return result


def reference_projection(lines, kind, x_axis, y_axis, append_space=False):
    # Frozen legacy arithmetic and copy semantics. Floating point expressions
    # deliberately retain the additions/subtractions of the monitor origin.
    converted = []
    for line in lines:
        box = line.get("bounding_rect", {})
        if not box:
            continue
        output = (
            line
            if kind == "oneocr"
            else {
                "text": line.get("text", ""),
                "bounding_rect": dict(box),
                "words": copy.deepcopy(line.get("words", [])),
            }
        )

        def transform(box):
            for key, value in list(box.items()):
                if kind != "oneocr":
                    try:
                        value = float(value)
                    except (TypeError, ValueError):
                        value = 0.0
                scale, offset, origin, divisor = x_axis if "x" in key else y_axis
                if kind == "absolute":
                    box[key] = ((value + offset) - origin) / divisor
                else:
                    box[key] = (((value * scale) + offset + origin) - origin) / divisor

        transform(output["bounding_rect"])
        for word in output.get("words", []):
            if kind == "oneocr" and append_space:
                word["text"] += " "
            if word.get("bounding_rect"):
                transform(word["bounding_rect"])
        converted.append(output)
    return converted


@pytest.mark.parametrize("kind", ["oneocr", "source", "absolute"])
def test_native_projection_matches_legacy_float_operations_and_copy_semantics(kind):
    assert hasattr(_native, "project_overlay_coordinates")
    rng = random.Random(941)
    for seed in range(120):
        axes = [
            (
                rng.choice([1.0, 1.0 / 0.73, 0.75]),
                rng.uniform(-3000, 3000),
                rng.choice([-2560.0, 0.0, 1e12]),
                rng.choice([1.0, 1920.0, 2560.0]),
            )
            for _ in range(2)
        ]
        before = frame(seed)
        source = copy.deepcopy(before)
        expected = reference_projection(copy.deepcopy(before), kind, *axes, append_space=True)
        actual = _native.project_overlay_coordinates(source, kind, *axes, True)
        assert actual == expected
        if kind == "oneocr":
            assert actual[0] is source[0]
            assert actual[0]["words"] is source[0]["words"]
        else:
            assert source == before
            assert actual[0] is not source[0]
            assert actual[0]["words"] is not source[0]["words"]


@pytest.mark.parametrize("kind", ["source", "absolute"])
def test_native_copy_preserves_word_metadata_aliases_and_numeric_coercion(kind):
    box = {"x1": " 1.25 ", "x3": None, "y1": "bad", "y3": False, "extra_x": 5, "other": 2}
    metadata = {"nested": [1, "two", {"three": 3}]}
    word = {"text": "word", "bounding_rect": box, "metadata": metadata}
    source = [{"text": "line", "bounding_rect": box, "words": [word, word]}]
    axes = ((0.37, -10.0, -1920.0, 1080.0), (2.0, 20.0, 100.0, 1920.0))
    expected = reference_projection(source, kind, *axes)
    actual = _native.project_overlay_coordinates(source, kind, *axes, False)
    assert actual == expected
    assert actual[0]["words"][0] is actual[0]["words"][1]
    assert actual[0]["words"][0]["metadata"] is not metadata


def test_native_rejects_unsupported_in_place_input_without_any_mutation():
    source = frame()
    source[-1]["words"] = [{"text": "bad", "bounding_rect": {"x1": "not-a-number"}}]
    before = copy.deepcopy(source)
    axes = ((1.0, 2.0, 3.0, 4.0),) * 2
    assert _native.project_overlay_coordinates(source, "oneocr", *axes, True) is None
    assert source == before


def test_native_defers_aliased_in_place_boxes_to_reference_before_mutation():
    source = frame(count=1)
    source[0]["words"] = [{"text": "a", "bounding_rect": source[0]["bounding_rect"]}]
    before = copy.deepcopy(source)
    axes = ((1.0, 2.0, 3.0, 4.0),) * 2
    assert _native.project_overlay_coordinates(source, "oneocr", *axes, True) is None
    assert source == before


@pytest.mark.parametrize("mode", ["native", "python", "shadow"])
def test_overlay_processor_dispatch_preserves_input_mutation(monkeypatch, mode):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", mode)
    subject = processor()
    source = frame()
    axes = ((1 / 0.73, 15.0, -2560.0, 1920.0), (1 / 1.3, -7.0, -180.0, 1080.0))
    expected = reference_projection(copy.deepcopy(source), "oneocr", *axes, append_space=True)
    actual = subject._convert_oneocr_results_to_percentages(source, 1920, 1080, 15, -7)
    assert actual == expected
    assert actual[0] is source[0]


def test_overlay_uses_native_projection_by_default(monkeypatch):
    monkeypatch.delenv("GSM_NATIVE_MODE", raising=False)
    monkeypatch.delenv("GSM_NATIVE_OVERLAY_MODE", raising=False)
    calls = []
    original = _native.project_overlay_coordinates

    def record_call(*args):
        calls.append(args[1])
        return original(*args)

    monkeypatch.setattr(_native, "project_overlay_coordinates", record_call)
    subject = processor()
    subject._convert_oneocr_results_to_percentages(frame(), 1920, 1080)
    subject._convert_source_space_results_to_percentages(frame(), 1000, 800, 1200, 900, 1920, 1080)
    subject._convert_absolute_screen_results_to_percentages(frame(), -2560, 0, 1920, 1080)
    assert calls == ["oneocr", "source", "absolute"]


def test_shadow_in_place_projection_does_not_copy_custom_metadata(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", "shadow")

    class Metadata:
        def __deepcopy__(self, memo):
            raise AssertionError("The in-place reference never copies metadata")

    source = frame()
    metadata = Metadata()
    source[0]["metadata"] = metadata
    result = processor()._convert_oneocr_results_to_percentages(source, 1920, 1080)
    assert result[0] is source[0]
    assert result[0]["metadata"] is metadata


@pytest.mark.parametrize("kind", ["oneocr", "source", "absolute"])
def test_shadow_projection_preserves_recursive_metadata(monkeypatch, kind):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", "shadow")
    subject = processor()
    source = frame(count=1)
    cycle = []
    cycle.append(cycle)
    source[0]["words"][0]["metadata"] = cycle
    if kind == "oneocr":
        result = subject._convert_oneocr_results_to_percentages(source, 1920, 1080)
    elif kind == "source":
        result = subject._convert_source_space_results_to_percentages(source, 1280, 720, 1920, 1080, 1920, 1080)
    else:
        result = subject._convert_absolute_screen_results_to_percentages(source, -2560, 0, 1920, 1080)
    result_cycle = result[0]["words"][0]["metadata"]
    assert result_cycle[0] is result_cycle
