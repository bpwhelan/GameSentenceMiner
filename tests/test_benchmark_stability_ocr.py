from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from PIL import Image


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "benchmark_stability_ocr.py"
SPEC = importlib.util.spec_from_file_location("benchmark_stability_ocr", SCRIPT_PATH)
benchmark = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(benchmark)


def _sample(sample_id: str, source: str, width: int, height: int) -> dict:
    return {
        "sample_id": sample_id,
        "source": source,
        "width": width,
        "height": height,
        "image_path": f"{sample_id}.png",
        "metadata_path": f"{sample_id}.json",
        "reference_boxes": [[0, 0, width, height]],
    }


def _engine_summary(
    *,
    score: float,
    p95_ms: float,
    cpu_ms: float,
    incremental_rss: int,
    success_rate: float = 1.0,
) -> dict:
    return {
        "initialized": True,
        "worker_crashed": False,
        "call_success_rate": success_rate,
        "controller_stability_score": score,
        "latency_ms": {"p95": p95_ms},
        "cpu_ms_per_scan": {"mean": cpu_ms},
        "memory": {"incremental_peak_rss_bytes": incremental_rss},
    }


def test_select_stratified_samples_is_deterministic_and_keeps_rare_sources():
    samples = [_sample(f"ocr-{index}", "ocr", 100 + index, 40 + index) for index in range(12)]
    samples.extend(
        [
            _sample("secondary-1", "secondary", 400, 200),
            _sample("screen-cropper-1", "screen_cropper", 800, 600),
        ]
    )

    first = benchmark.select_stratified_samples(samples, 6)
    second = benchmark.select_stratified_samples(list(reversed(samples)), 6)

    assert [sample["sample_id"] for sample in first] == [sample["sample_id"] for sample in second]
    assert {sample["source"] for sample in first} == {
        "ocr",
        "secondary",
        "screen_cropper",
    }


def test_extract_result_boxes_supports_ocr_and_detector_tuples():
    ocr_result = (
        True,
        "text",
        [],
        [(1, 2, 30, 40, "text"), [50, 60, 90, 100, "more"]],
        (1, 2, 90, 100),
        None,
    )
    detector_result = (
        True,
        "",
        [],
        [(5, 6, 20, 25)],
        (5, 6, 20, 25),
        {"boxes": [{"box": [5, 6, 20, 25]}]},
    )

    assert benchmark.extract_result_boxes(ocr_result) == [
        (1, 2, 30, 40),
        (50, 60, 90, 100),
    ]
    assert benchmark.extract_result_boxes(detector_result) == [(5, 6, 20, 25)]


def test_reference_line_recall_counts_covered_reference_lines():
    reference_boxes = [(0, 0, 100, 50), (0, 60, 100, 100)]
    detected_boxes = [(0, 0, 100, 50), (0, 60, 20, 100)]

    assert benchmark.reference_line_recall(reference_boxes, detected_boxes) == 0.5


def test_boxes_stable_uses_controller_three_pixel_tolerance():
    baseline = [(10, 20, 100, 80), (20, 100, 120, 150)]

    assert benchmark.boxes_stable(
        baseline,
        [(13, 18, 102, 83), (18, 103, 123, 148)],
    )
    assert not benchmark.boxes_stable(
        baseline,
        [(14, 20, 100, 80), (20, 100, 120, 150)],
    )
    assert not benchmark.boxes_stable(baseline, baseline[:1])


def test_choose_default_is_stability_first_then_latency_cpu_and_memory():
    summaries = {
        "oneocr": _engine_summary(
            score=0.97,
            p95_ms=10,
            cpu_ms=8,
            incremental_rss=10,
        ),
        "screenai": _engine_summary(
            score=0.995,
            p95_ms=30,
            cpu_ms=20,
            incremental_rss=20,
        ),
        "meiki_text_detector": _engine_summary(
            score=0.994,
            p95_ms=15,
            cpu_ms=12,
            incremental_rss=30,
        ),
    }

    decision = benchmark.choose_default(summaries)

    assert decision["winner"] == "meiki_text_detector"
    assert decision["stability_finalists"] == [
        "meiki_text_detector",
        "screenai",
    ]

    summaries["screenai"] = _engine_summary(
        score=0.995,
        p95_ms=15.5,
        cpu_ms=9,
        incremental_rss=40,
    )
    decision = benchmark.choose_default(summaries)
    assert decision["winner"] == "screenai"


def test_choose_default_rejects_unreliable_or_crashed_workers():
    summaries = {
        "oneocr": _engine_summary(
            score=0.99,
            p95_ms=20,
            cpu_ms=10,
            incremental_rss=20,
        ),
        "screenai": _engine_summary(
            score=1.0,
            p95_ms=5,
            cpu_ms=5,
            incremental_rss=5,
            success_rate=0.99,
        ),
    }
    summaries["oneocr"]["worker_crashed"] = True

    decision = benchmark.choose_default(summaries)

    assert decision["winner"] == "oneocr"
    assert decision["reason"] == "no_eligible_replacement"


def test_loading_and_fingerprinting_corpus_does_not_modify_files(tmp_path):
    image_path = tmp_path / "sample.png"
    metadata_path = tmp_path / "sample.json"
    Image.new("RGB", (80, 40), "white").save(image_path)
    metadata_path.write_text(
        json.dumps(
            {
                "sample_id": "sample",
                "source": "ocr",
                "image_file": image_path.name,
                "pipeline": {
                    "processing": {"processed_size": {"width": 80, "height": 40}},
                    "ocr": {"crop_coords_list": [[2, 3, 70, 30, "text"]]},
                },
            }
        ),
        encoding="utf-8",
    )
    before = benchmark.fingerprint_directory(tmp_path)

    samples = benchmark.load_samples(tmp_path)
    after = benchmark.fingerprint_directory(tmp_path)

    assert len(samples) == 1
    assert samples[0]["reference_boxes"] == [(2, 3, 70, 30)]
    assert before == after
