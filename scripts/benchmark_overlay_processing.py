"""Offline overlay coordinate benchmark against an explicit git revision.

Loads processing methods without starting GSM, OCR, capture or networking.
Requires exact output equality before timing. In-place input copies are prepared
outside the timed region. Run with .venv's Python after a release native build.
"""

from __future__ import annotations
import __future__

import argparse
import ast
import copy
import json
import platform
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import regex

from GameSentenceMiner.native import ocr as native_ocr
from GameSentenceMiner.native import overlay as native_overlay
from GameSentenceMiner.native.runtime import NativeMode, get_native_mode
from GameSentenceMiner.owocr.owocr.ocr import (
    get_regex,
    normalize_japanese_ocr_dashes,
    normalize_japanese_ocr_text_and_segments,
)

SOURCE = "GameSentenceMiner/util/overlay/get_overlay_coords.py"
METHODS = (
    "_convert_oneocr_results_to_percentages",
    "_convert_source_space_results_to_percentages",
    "_convert_absolute_screen_results_to_percentages",
)
FILTER_METHODS = {
    "_filter_local_ocr_results_by_language",
    "_filter_local_ocr_results_by_language_python",
    "_native_overlay_filter_language",
    "_rebuild_native_overlay_filter_result",
    "_matches_overlay_language_filter",
    "_filter_precomputed_results_by_minimum_character_size",
    "_filter_precomputed_results_by_minimum_character_size_python",
    "_filter_precomputed_results_by_exclusion_regions",
    "_filter_precomputed_results_by_exclusion_regions_python",
    "_get_bounding_rect_size",
    "_passes_overlay_minimum_character_size",
    "_merge_bounding_rects",
    "_boxes_overlap_significantly",
}


def load_processor(source):
    tree = ast.parse(source)
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "OverlayProcessor")
    cls.body = [
        node
        for node in cls.body
        if isinstance(node, ast.FunctionDef)
        and (node.name.removesuffix("_python") in METHODS or node.name in FILTER_METHODS)
    ]
    namespace = {
        "copy": copy,
        "native_overlay": native_overlay,
        "native_ocr": native_ocr,
        "get_native_mode": get_native_mode,
        "NativeMode": NativeMode,
        "get_regex": get_regex,
        "get_ocr_language": lambda: "ja",
        "normalize_japanese_ocr_dashes": normalize_japanese_ocr_dashes,
        "normalize_japanese_ocr_text_and_segments": normalize_japanese_ocr_text_and_segments,
        "OVERLAY_VISIBLE_TEXT_REGEX": regex.compile(r"\S"),
        "OVERLAY_EXTENDED_CJK_MARK_REGEX": regex.compile(r"[々〆〇〻ヶヵ]"),
        "logger": native_overlay.logger,
    }
    module = ast.Module(body=[cls], type_ignores=[])
    exec(compile(module, SOURCE, "exec", flags=__future__.annotations.compiler_flag), namespace)  # noqa: S102
    processor = namespace["OverlayProcessor"]()
    processor.last_monitor_left = -2560
    processor.last_monitor_top = -120
    processor.calculated_width_scale_factor = 0.73
    processor.calculated_height_scale_factor = 1.15
    processor.ocr_language = "ja"
    processor.regex = get_regex("ja")
    return processor


def fixture(line_count, words_per_line, seed):
    rng = random.Random(seed)

    def box():
        x, y, width, height = rng.random() * 1900, rng.random() * 1000, rng.random() * 400, rng.random() * 40
        return {
            "x1": x,
            "y1": y,
            "x2": x + width,
            "y2": y,
            "x3": x + width,
            "y3": y + height,
            "x4": x,
            "y4": y + height,
        }

    return [
        {
            "text": "日本語ABC 𠮷🙂。" * words_per_line,
            "bounding_rect": box(),
            "words": [{"text": "日本語ABC 𠮷🙂。", "bounding_rect": box()} for _ in range(words_per_line)],
        }
        for _ in range(line_count)
    ]


def benchmark(args):
    revision = subprocess.check_output(["git", "rev-parse", args.reference_ref], cwd=ROOT, text=True).strip()
    baseline = subprocess.check_output(["git", "show", f"{revision}:{SOURCE}"], cwd=ROOT).decode("utf-8")
    processors = [load_processor(baseline), load_processor((ROOT / SOURCE).read_text(encoding="utf-8"))]
    report = {"reference": revision, "python": sys.version, "platform": platform.platform(), "metrics": {}}
    for line_count, words_per_line in [(3, 20), (20, 40)]:
        frames = [fixture(line_count, words_per_line, seed) for seed in range(args.loops)]
        cases = [
            (method, [getattr(processor, method) for processor in processors], parameters)
            for method, parameters in zip(
                METHODS,
                [
                    (1920, 1080, 10, -20),
                    (1280, 720, 1920, 1080, 2560, 1440, 21, -37),
                    (-1920, -120, 2560, 1440, 33, -79),
                ],
            )
        ]
        cases += [
            ("payload_copy", [copy.deepcopy, native_overlay.copy_payload], ()),
            ("language_filter", [processor._filter_local_ocr_results_by_language for processor in processors], ()),
            (
                "minimum_size_filter",
                [processor._filter_precomputed_results_by_minimum_character_size for processor in processors],
                (10,),
            ),
            (
                "exclusion_filter",
                [processor._filter_precomputed_results_by_exclusion_regions for processor in processors],
                (
                    [
                        {"x1": index * 120, "y1": index * 65, "x3": index * 120 + 170, "y3": index * 65 + 100}
                        for index in range(8)
                    ],
                ),
            ),
        ]
        for method, functions, parameters in cases:
            for frame in frames:
                outputs = [function(copy.deepcopy(frame), *parameters) for function in functions]
                if outputs[0] != outputs[1]:
                    raise AssertionError(f"Coordinate mismatch: {method}")
            timings = [[], []]
            for repeat in range(args.repeats):
                for side in [0, 1] if repeat % 2 else [1, 0]:
                    inputs = copy.deepcopy(frames)
                    started = time.perf_counter_ns()
                    for frame in inputs:
                        functions[side](frame, *parameters)
                    timings[side].append((time.perf_counter_ns() - started) / (len(inputs) * 1e6))
            before, after = [statistics.median(values) for values in timings]
            name = f"{method.removeprefix('_convert_')}_{line_count}x{words_per_line}"
            metric = {"before_ms": before, "after_ms": after, "speedup": before / after, "rounds_ms": timings}
            report["metrics"][name] = metric
            print(f"{name}: {before:.3f} -> {after:.3f} ms ({before / after:.2f}x)", flush=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-ref", default="HEAD")
    parser.add_argument("--repeats", type=int, default=7)
    parser.add_argument("--loops", type=int, default=30)
    parser.add_argument("--output", type=Path)
    benchmark(parser.parse_args())
