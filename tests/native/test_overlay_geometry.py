from __future__ import annotations

import copy
import random

import pytest

from GameSentenceMiner import _native
from GameSentenceMiner.util.overlay.get_overlay_coords import OverlayProcessor


def box(x, y, width, height):
    return {"x1": x, "y1": y, "x2": x + width, "y2": y, "x3": x + width, "y3": y + height, "x4": x, "y4": y + height}


@pytest.mark.parametrize("kind", ["minimum_size", "exclusions"])
def test_geometry_filter_uses_native_batch_and_matches_python(monkeypatch, kind):
    function = getattr(_native, f"filter_overlay_{kind}")
    calls = []

    def record(*args):
        result = function(*args)
        assert result is not None
        calls.append(True)
        return result

    monkeypatch.setattr(_native, f"filter_overlay_{kind}", record)
    processor = OverlayProcessor.__new__(OverlayProcessor)
    method = (
        processor._filter_precomputed_results_by_minimum_character_size
        if kind == "minimum_size"
        else processor._filter_precomputed_results_by_exclusion_regions
    )
    rng = random.Random(8714)
    for _ in range(150):
        lines = []
        for index in range(8):
            shared = {"retained": [index, None]}
            words = [
                {
                    "text": rng.choice(["日本語", "ABC", "𠮷🙂", None, ""]),
                    "bounding_rect": box(
                        rng.randrange(-20, 100), rng.randrange(-20, 100), rng.randrange(40), rng.randrange(30)
                    ),
                    "meta": shared,
                }
                for _ in range(rng.randrange(12))
            ]
            lines.append(
                {"text": f"line {index}", "bounding_rect": box(0, 0, 120, 100), "words": words, "metadata": shared}
            )
        parameter = (
            rng.randrange(1, 30)
            if kind == "minimum_size"
            else [
                box(rng.randrange(100), rng.randrange(100), rng.randrange(-40, 50), rng.randrange(-50, 70))
                for _ in range(8)
            ]
        )
        before = copy.deepcopy(lines)
        monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", "python")
        expected = method(lines, parameter)
        monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", "native")
        actual = method(lines, parameter)
        assert actual == expected
        assert lines == before
    assert len(calls) == 150


def test_geometry_filter_threshold_boundaries():
    processor = OverlayProcessor.__new__(OverlayProcessor)
    lines = [{"text": "a", "bounding_rect": box(0, 0, 10, 10), "words": []}]
    assert processor._filter_precomputed_results_by_minimum_character_size(lines, 10) == []
    assert processor._filter_precomputed_results_by_minimum_character_size(lines, 9) == lines
    assert processor._filter_precomputed_results_by_exclusion_regions(lines, [box(5, 0, 5, 10)]) == []
    assert processor._filter_precomputed_results_by_exclusion_regions(lines, [box(5.000000001, 0, 5, 10)]) == lines


def test_geometry_filter_defers_custom_copy_protocols_and_large_integer_thresholds():
    class Metadata:
        def __deepcopy__(self, memo):
            return "custom"

    lines = [{"text": "a", "bounding_rect": box(0, 0, 10, 10), "metadata": Metadata()}]
    assert _native.filter_overlay_minimum_size(lines, 3) is None
    assert _native.filter_overlay_exclusions(lines, [box(100, 100, 10, 10)]) is None
    lines[0].pop("metadata")
    assert _native.filter_overlay_minimum_size(lines, 2**53 + 3) is None


@pytest.mark.parametrize("mode", ["native", "shadow"])
def test_geometry_filter_keeps_aliases_coercions_and_missing_box_behavior(monkeypatch, mode):
    processor = OverlayProcessor.__new__(OverlayProcessor)
    shared = {"text": "one", "bounding_rect": {"x1": "1", "y1": None, "x3": "20", "y3": "10"}}
    lines = [
        {"text": "line", "words": [shared, shared, None, {"text": "no box"}], "metadata": shared},
        {"text": "empty"},
        123,
    ]
    for method, parameter in [
        (processor._filter_precomputed_results_by_minimum_character_size, 3),
        (processor._filter_precomputed_results_by_exclusion_regions, [box(100, 100, 10, 10)]),
    ]:
        # None is supported by size filtering but raises in the legacy overlap
        # routine. Exercise a parseable overlap box for that branch.
        if isinstance(parameter, list):
            shared["bounding_rect"]["y1"] = "0"
        monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", "python")
        expected = method(lines, parameter)
        monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", mode)
        actual = method(lines, parameter)
        assert actual == expected
        assert actual[0]["words"][0] is actual[0]["words"][1] is actual[0]["metadata"]
