from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psutil
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_ENGINES = ("oneocr", "meiki_text_detector", "screenai")
CONTROLLER_BOX_TOLERANCE = 3
MIN_CALL_SUCCESS_RATE = 0.995
STABILITY_FINALIST_MARGIN = 0.01
PERFORMANCE_TIE_MARGIN = 0.10


def default_input_dir() -> Path:
    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        appdata = Path.home() / ".config"
    return appdata / "GameSentenceMiner" / "ocr_metrics" / "pending"


def normalize_box(value: Any) -> tuple[int, int, int, int] | None:
    if isinstance(value, dict):
        value = value.get("box") or value.get("bbox")
    if not isinstance(value, (list, tuple)) or len(value) < 4:
        return None
    try:
        x1, y1, x2, y2 = (int(round(float(value[index]))) for index in range(4))
    except (TypeError, ValueError):
        return None
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1, y1, x2, y2)


def normalize_boxes(values: Any) -> list[tuple[int, int, int, int]]:
    if not isinstance(values, (list, tuple)):
        return []
    boxes = {box for value in values if (box := normalize_box(value)) is not None}
    return sorted(boxes, key=lambda box: (box[1], box[0], box[3], box[2]))


def extract_result_boxes(result: Any) -> list[tuple[int, int, int, int]]:
    parts = list(result) if isinstance(result, (list, tuple)) else []
    parts.extend([None] * max(0, 6 - len(parts)))
    crop_coords_list = parts[3]
    response = parts[5]
    boxes = normalize_boxes(crop_coords_list)
    if boxes:
        return boxes
    if isinstance(response, dict):
        boxes = normalize_boxes(response.get("boxes"))
        if boxes:
            return boxes
        boxes = normalize_boxes(response.get("crop_coords_list"))
        if boxes:
            return boxes
    crop_coords = normalize_box(parts[4])
    return [crop_coords] if crop_coords else []


def boxes_stable(
    previous: list[tuple[int, int, int, int]],
    current: list[tuple[int, int, int, int]],
    tolerance: int = CONTROLLER_BOX_TOLERANCE,
) -> bool:
    previous = normalize_boxes(previous)
    current = normalize_boxes(current)
    if not previous or len(previous) != len(current):
        return False
    return all(
        all(abs(left[index] - right[index]) <= tolerance for index in range(4))
        for left, right in zip(previous, current)
    )


def _intersection_area(
    left: tuple[int, int, int, int],
    right: tuple[int, int, int, int],
) -> int:
    width = max(0, min(left[2], right[2]) - max(left[0], right[0]))
    height = max(0, min(left[3], right[3]) - max(left[1], right[1]))
    return width * height


def reference_line_recall(
    reference_boxes: list[tuple[int, int, int, int]],
    detected_boxes: list[tuple[int, int, int, int]],
    minimum_coverage: float = 0.5,
) -> float:
    references = normalize_boxes(reference_boxes)
    detections = normalize_boxes(detected_boxes)
    if not references:
        return 1.0
    if not detections:
        return 0.0
    covered = 0
    for reference in references:
        reference_area = max(1, (reference[2] - reference[0]) * (reference[3] - reference[1]))
        best_coverage = max(_intersection_area(reference, detected) / reference_area for detected in detections)
        if best_coverage >= minimum_coverage:
            covered += 1
    return covered / len(references)


def _sample_stratum(sample: dict[str, Any]) -> tuple[str, int]:
    area = max(1, int(sample.get("width", 0)) * int(sample.get("height", 0)))
    return (str(sample.get("source") or "unknown"), int(math.log2(area)))


def select_stratified_samples(samples: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    ordered = sorted(samples, key=lambda sample: str(sample["sample_id"]))
    if limit <= 0 or limit >= len(ordered):
        return ordered

    groups: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for sample in ordered:
        groups[_sample_stratum(sample)].append(sample)

    exact_targets = {key: limit * len(group) / len(ordered) for key, group in groups.items()}
    targets = {key: int(math.floor(exact_targets[key])) for key in groups}
    source_keys = [
        max(
            (key for key in groups if key[0] == source),
            key=lambda key: (len(groups[key]), key),
        )
        for source in {key[0] for key in groups}
    ]
    required_keys = set(sorted(source_keys, key=lambda key: (-len(groups[key]), key))[:limit])
    for key in required_keys:
        targets[key] = max(1, targets[key])

    while sum(targets.values()) < limit:
        candidates = [key for key, group in groups.items() if targets[key] < len(group)]
        key = max(
            candidates,
            key=lambda candidate: (
                exact_targets[candidate] - targets[candidate],
                len(groups[candidate]),
                candidate,
            ),
        )
        targets[key] += 1
    while sum(targets.values()) > limit:
        candidates = [key for key in groups if targets[key] > (1 if key in required_keys else 0)]
        key = min(
            candidates,
            key=lambda candidate: (
                exact_targets[candidate] - targets[candidate],
                -len(groups[candidate]),
                candidate,
            ),
        )
        targets[key] -= 1

    selected: list[dict[str, Any]] = []
    for key in sorted(groups):
        group = groups[key]
        target = targets[key]
        if target <= 0:
            continue
        if target == 1:
            indices = [len(group) // 2]
        else:
            indices = [round(index * (len(group) - 1) / (target - 1)) for index in range(target)]
        selected.extend(group[index] for index in indices)
    return sorted(selected, key=lambda sample: str(sample["sample_id"]))


def load_samples(input_dir: Path) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for metadata_path in sorted(input_dir.glob("*.json")):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        image_name = metadata.get("image_file")
        image_path = input_dir / str(image_name or "")
        if not image_name or not image_path.is_file():
            continue

        processing = metadata.get("pipeline", {}).get("processing", {})
        processed_size = processing.get("processed_size", {})
        width = int(processed_size.get("width") or 0)
        height = int(processed_size.get("height") or 0)
        if width <= 0 or height <= 0:
            with Image.open(image_path) as image:
                width, height = image.size

        reference_values = metadata.get("pipeline", {}).get("ocr", {}).get("crop_coords_list", [])
        samples.append(
            {
                "sample_id": str(metadata.get("sample_id") or metadata_path.stem),
                "source": str(metadata.get("source") or "unknown"),
                "image_path": str(image_path.resolve()),
                "metadata_path": str(metadata_path.resolve()),
                "width": width,
                "height": height,
                "reference_boxes": normalize_boxes(reference_values),
            }
        )
    return samples


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        while chunk := file_handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint_directory(directory: Path) -> dict[str, dict[str, Any]]:
    fingerprint: dict[str, dict[str, Any]] = {}
    for path in sorted(directory.iterdir(), key=lambda item: item.name):
        if not path.is_file():
            continue
        stat = path.stat()
        fingerprint[path.name] = {
            "size": stat.st_size,
            "sha256": _file_sha256(path),
        }
    return fingerprint


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * min(1.0, max(0.0, fraction))
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def summarize_values(values: list[float]) -> dict[str, float]:
    if not values:
        return {key: 0.0 for key in ("mean", "median", "p95", "p99", "min", "max", "stdev")}
    return {
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "p95": percentile(values, 0.95),
        "p99": percentile(values, 0.99),
        "min": min(values),
        "max": max(values),
        "stdev": statistics.pstdev(values) if len(values) > 1 else 0.0,
    }


def choose_default(summaries: dict[str, dict[str, Any]]) -> dict[str, Any]:
    eligible = {
        engine: summary
        for engine, summary in summaries.items()
        if summary.get("initialized")
        and not summary.get("worker_crashed")
        and float(summary.get("call_success_rate", 0.0)) >= MIN_CALL_SUCCESS_RATE
    }
    if not eligible:
        fallback = "oneocr" if "oneocr" in summaries else sorted(summaries)[0]
        return {
            "winner": fallback,
            "reason": "no_eligible_replacement",
            "eligible": [],
            "stability_finalists": [],
        }

    best_stability = max(float(summary["controller_stability_score"]) for summary in eligible.values())
    stability_finalists = sorted(
        engine
        for engine, summary in eligible.items()
        if best_stability - float(summary["controller_stability_score"]) <= STABILITY_FINALIST_MARGIN
    )

    best_latency = min(float(eligible[engine]["latency_ms"]["p95"]) for engine in stability_finalists)
    latency_finalists = [
        engine
        for engine in stability_finalists
        if float(eligible[engine]["latency_ms"]["p95"]) <= best_latency * (1 + PERFORMANCE_TIE_MARGIN)
    ]

    best_cpu = min(float(eligible[engine]["cpu_ms_per_scan"]["mean"]) for engine in latency_finalists)
    cpu_finalists = [
        engine
        for engine in latency_finalists
        if float(eligible[engine]["cpu_ms_per_scan"]["mean"]) <= best_cpu * (1 + PERFORMANCE_TIE_MARGIN)
    ]

    best_memory = min(int(eligible[engine]["memory"]["incremental_peak_rss_bytes"]) for engine in cpu_finalists)
    memory_finalists = sorted(
        engine
        for engine in cpu_finalists
        if int(eligible[engine]["memory"]["incremental_peak_rss_bytes"]) == best_memory
    )
    winner = "oneocr" if "oneocr" in memory_finalists else memory_finalists[0]
    return {
        "winner": winner,
        "reason": "stability_then_latency_cpu_memory",
        "eligible": sorted(eligible),
        "stability_finalists": stability_finalists,
        "latency_finalists": sorted(latency_finalists),
        "cpu_finalists": sorted(cpu_finalists),
        "memory_finalists": memory_finalists,
        "thresholds": {
            "minimum_call_success_rate": MIN_CALL_SUCCESS_RATE,
            "stability_finalist_margin": STABILITY_FINALIST_MARGIN,
            "performance_tie_margin": PERFORMANCE_TIE_MARGIN,
        },
    }


def _initialize_engine(engine_name: str):
    from GameSentenceMiner.owocr.owocr import ocr_runtime

    ocr_runtime.init_config(parse_args=False)
    ocr_runtime.engine_instances = []
    ocr_runtime.engine_keys = []
    ocr_runtime.engine_index = 0
    ocr_runtime.engine_change_handler_name(engine_name, switch=False)
    for instance in ocr_runtime.engine_instances:
        if str(getattr(instance, "name", "")).strip().lower() == engine_name:
            return instance
    available = [getattr(instance, "name", "?") for instance in ocr_runtime.engine_instances]
    raise RuntimeError(f"Engine '{engine_name}' did not initialize. Available: {available}")


def _current_rss() -> int:
    process = psutil.Process()
    total = process.memory_info().rss
    for child in process.children(recursive=True):
        try:
            total += child.memory_info().rss
        except (psutil.Error, OSError):
            continue
    return total


def _text_hash(text: Any) -> str:
    normalized = " ".join(str(text or "").replace("\r", "\n").split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else ""


def _call_engine(engine_instance: Any, image: Image.Image) -> dict[str, Any]:
    started_wall = time.perf_counter()
    started_cpu = time.process_time()
    try:
        result = engine_instance(image, 0)
        elapsed_cpu_ms = (time.process_time() - started_cpu) * 1000.0
        elapsed_ms = (time.perf_counter() - started_wall) * 1000.0
        parts = list(result) if isinstance(result, (list, tuple)) else []
        parts.extend([None] * max(0, 6 - len(parts)))
        success = bool(parts[0])
        return {
            "success": success,
            "latency_ms": elapsed_ms,
            "cpu_ms": elapsed_cpu_ms,
            "boxes": extract_result_boxes(parts),
            "text_hash": _text_hash(parts[1]) if success else "",
            "error": "" if success else str(parts[1] or "OCR call failed"),
        }
    except Exception as error:
        return {
            "success": False,
            "latency_ms": (time.perf_counter() - started_wall) * 1000.0,
            "cpu_ms": (time.process_time() - started_cpu) * 1000.0,
            "boxes": [],
            "text_hash": "",
            "error": f"{type(error).__name__}: {error}",
        }


def _worker_provider(engine_instance: Any) -> str:
    model = getattr(engine_instance, "model", None)
    active_provider = getattr(model, "active_provider", None)
    if active_provider:
        return str(active_provider)
    return "native_cpu"


def run_worker(args: argparse.Namespace) -> int:
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    output_path = Path(args.worker_output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    initialized = False
    payload: dict[str, Any] = {
        "engine": args.engine,
        "initialized": False,
        "worker_crashed": False,
        "results": [],
    }
    try:
        init_wall = time.perf_counter()
        init_cpu = time.process_time()
        engine_instance = _initialize_engine(args.engine)
        payload["initialization_ms"] = (time.perf_counter() - init_wall) * 1000.0
        payload["initialization_cpu_ms"] = (time.process_time() - init_cpu) * 1000.0
        payload["post_initialization_rss_bytes"] = _current_rss()
        payload["provider"] = _worker_provider(engine_instance)
        payload["initialized"] = True
        initialized = True
        Path(args.phase_marker).write_text("inference", encoding="utf-8")

        for sample in manifest[: max(0, args.warmup_samples)]:
            with Image.open(sample["image_path"]) as source_image:
                _call_engine(engine_instance, source_image.convert("RGB"))

        for sample in manifest:
            with Image.open(sample["image_path"]) as source_image:
                result = _call_engine(engine_instance, source_image.convert("RGB"))
            result.update(
                {
                    "sample_id": sample["sample_id"],
                    "source": sample["source"],
                    "width": sample["width"],
                    "height": sample["height"],
                    "reference_line_recall": reference_line_recall(sample["reference_boxes"], result["boxes"]),
                }
            )
            payload["results"].append(result)

        consistency_samples = [sample for sample in manifest if sample.get("consistency")]
        stable_pairs = 0
        empty_agreement_pairs = 0
        text_agreement_pairs = 0
        repeat_pairs = 0
        repeat_successes = 0
        repeat_calls = 0
        for sample in consistency_samples:
            repeated_results = []
            with Image.open(sample["image_path"]) as source_image:
                image = source_image.convert("RGB")
                for _ in range(max(2, args.repeats)):
                    repeated_results.append(_call_engine(engine_instance, image))
            repeat_calls += len(repeated_results)
            repeat_successes += sum(bool(result["success"]) for result in repeated_results)
            for previous, current in zip(repeated_results, repeated_results[1:]):
                repeat_pairs += 1
                if boxes_stable(previous["boxes"], current["boxes"]):
                    stable_pairs += 1
                if bool(previous["boxes"]) == bool(current["boxes"]):
                    empty_agreement_pairs += 1
                if previous["text_hash"] == current["text_hash"]:
                    text_agreement_pairs += 1

        payload["consistency"] = {
            "samples": len(consistency_samples),
            "repeats": max(2, args.repeats),
            "pair_comparisons": repeat_pairs,
            "repeat_calls": repeat_calls,
            "repeat_success_rate": repeat_successes / repeat_calls if repeat_calls else 0.0,
            "box_stability_rate": stable_pairs / repeat_pairs if repeat_pairs else 0.0,
            "empty_nonempty_agreement_rate": empty_agreement_pairs / repeat_pairs if repeat_pairs else 0.0,
            "text_repeatability_rate": text_agreement_pairs / repeat_pairs if repeat_pairs else 0.0,
        }
        output_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return 0
    except Exception as error:
        payload["initialized"] = initialized
        payload["worker_error"] = f"{type(error).__name__}: {error}"
        output_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return 1


def _process_tree_rss(process: psutil.Process) -> int:
    total = 0
    try:
        candidates = [process, *process.children(recursive=True)]
    except (psutil.Error, OSError):
        candidates = []
    for candidate in candidates:
        try:
            total += candidate.memory_info().rss
        except (psutil.Error, OSError):
            continue
    return total


def run_engine_worker(
    *,
    engine: str,
    manifest_path: Path,
    run_dir: Path,
    warmup_samples: int,
    repeats: int,
    poll_ms: int,
) -> tuple[dict[str, Any], dict[str, int]]:
    worker_output = run_dir / f"{engine}_worker.json"
    worker_log = run_dir / f"{engine}_worker.log"
    phase_marker = run_dir / f"{engine}_inference.started"
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--engine",
        engine,
        "--manifest",
        str(manifest_path),
        "--worker-output",
        str(worker_output),
        "--phase-marker",
        str(phase_marker),
        "--warmup-samples",
        str(warmup_samples),
        "--repeats",
        str(repeats),
    ]
    peak_initialization = 0
    peak_inference = 0
    with worker_log.open("w", encoding="utf-8") as log_handle:
        child = subprocess.Popen(
            command,
            cwd=REPO_ROOT,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
        )
        try:
            process = psutil.Process(child.pid)
        except psutil.NoSuchProcess:
            process = None
        while child.poll() is None:
            if process is None:
                try:
                    process = psutil.Process(child.pid)
                except psutil.NoSuchProcess:
                    time.sleep(max(1, poll_ms) / 1000.0)
                    continue
            rss = _process_tree_rss(process)
            if phase_marker.exists():
                peak_inference = max(peak_inference, rss)
            else:
                peak_initialization = max(peak_initialization, rss)
            time.sleep(max(1, poll_ms) / 1000.0)
        return_code = child.wait()

    if worker_output.exists():
        payload = json.loads(worker_output.read_text(encoding="utf-8"))
    else:
        payload = {
            "engine": engine,
            "initialized": False,
            "results": [],
            "worker_error": f"Worker exited {return_code} without output",
        }
    payload["worker_crashed"] = return_code != 0
    return payload, {
        "peak_initialization_rss_bytes": peak_initialization,
        "peak_inference_rss_bytes": peak_inference,
        "peak_rss_bytes": max(peak_initialization, peak_inference),
    }


def aggregate_worker_result(worker: dict[str, Any], memory: dict[str, int]) -> dict[str, Any]:
    rows = list(worker.get("results") or [])
    successful = [row for row in rows if row.get("success")]
    latencies = [float(row["latency_ms"]) for row in successful]
    cpu_values = [float(row["cpu_ms"]) for row in successful]
    success_rate = len(successful) / len(rows) if rows else 0.0
    nonempty_rate = sum(bool(row.get("boxes")) for row in successful) / len(rows) if rows else 0.0
    geometry_recall = (
        statistics.fmean(float(row.get("reference_line_recall", 0.0)) for row in successful) if successful else 0.0
    )
    consistency = worker.get("consistency") or {}
    box_stability_rate = float(consistency.get("box_stability_rate", 0.0))
    post_initialization = int(worker.get("post_initialization_rss_bytes", 0))
    peak_initialization = max(int(memory.get("peak_initialization_rss_bytes", 0)), post_initialization)
    peak_inference = max(int(memory.get("peak_inference_rss_bytes", 0)), post_initialization)
    memory = {
        **memory,
        "peak_initialization_rss_bytes": peak_initialization,
        "peak_inference_rss_bytes": peak_inference,
        "peak_rss_bytes": max(peak_initialization, peak_inference),
    }
    latency_summary = summarize_values(latencies)
    cpu_summary = summarize_values(cpu_values)
    logical_cpu_count = max(1, int(psutil.cpu_count(logical=True) or 1))
    core_equivalent_percent = (
        100.0 * cpu_summary["mean"] / latency_summary["mean"] if latency_summary["mean"] > 0 else 0.0
    )
    summary = {
        "initialized": bool(worker.get("initialized")),
        "worker_crashed": bool(worker.get("worker_crashed")),
        "worker_error": str(worker.get("worker_error") or ""),
        "provider": str(worker.get("provider") or "unknown"),
        "samples": len(rows),
        "successes": len(successful),
        "failures": len(rows) - len(successful),
        "call_success_rate": success_rate,
        "nonempty_geometry_rate": nonempty_rate,
        "reference_line_recall": geometry_recall,
        "repeat_box_stability_rate": box_stability_rate,
        "empty_nonempty_agreement_rate": float(consistency.get("empty_nonempty_agreement_rate", 0.0)),
        "text_repeatability_rate": float(consistency.get("text_repeatability_rate", 0.0)),
        "controller_stability_score": min(
            success_rate,
            nonempty_rate,
            geometry_recall,
            box_stability_rate,
        ),
        "initialization_ms": float(worker.get("initialization_ms", 0.0)),
        "initialization_cpu_ms": float(worker.get("initialization_cpu_ms", 0.0)),
        "latency_ms": latency_summary,
        "cpu_ms_per_scan": cpu_summary,
        "cpu_usage": {
            "core_equivalent_percent": core_equivalent_percent,
            "total_machine_capacity_percent": core_equivalent_percent / logical_cpu_count,
            "logical_cpu_count": logical_cpu_count,
        },
        "throughput_scans_per_second": 1000.0 / statistics.fmean(latencies) if latencies else 0.0,
        "memory": {
            **memory,
            "post_initialization_rss_bytes": post_initialization,
            "incremental_peak_rss_bytes": max(0, peak_inference - peak_initialization),
        },
    }
    return summary


def _package_version(package_name: str) -> str:
    try:
        return importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        return "not-installed"


def hardware_metadata() -> dict[str, Any]:
    return {
        "platform": platform.platform(),
        "python": sys.version,
        "processor": platform.processor(),
        "physical_cpu_cores": psutil.cpu_count(logical=False),
        "logical_cpu_cores": psutil.cpu_count(logical=True),
        "total_memory_bytes": psutil.virtual_memory().total,
        "packages": {
            "oneocr": _package_version("oneocr"),
            "meikiocr": _package_version("meikiocr"),
            "onnxruntime": _package_version("onnxruntime"),
            "pillow": _package_version("pillow"),
            "psutil": _package_version("psutil"),
        },
    }


def _percent(value: float) -> str:
    return f"{value * 100:.2f}%"


def _mib(value: int) -> str:
    return f"{value / (1024 * 1024):.1f}"


def write_report(payload: dict[str, Any], report_path: Path) -> None:
    lines = [
        "# Windows Stability OCR Benchmark",
        "",
        f"Run: `{payload['run_id']}`  ",
        f"Samples: {payload['sample_count']} of {payload['available_sample_count']}  ",
        f"Consistency subset: {payload['consistency_sample_count']} × {payload['repeats']} repeats  ",
        f"Winner: **{payload['decision']['winner']}**",
        "",
        "| Engine | Stability | Success | Geometry | Lens line recall | Box repeatability | P95 ms | CPU ms/scan | CPU capacity | Peak MiB | Incremental MiB |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for engine, summary in payload["engines"].items():
        lines.append(
            "| "
            + " | ".join(
                [
                    engine,
                    _percent(summary["controller_stability_score"]),
                    _percent(summary["call_success_rate"]),
                    _percent(summary["nonempty_geometry_rate"]),
                    _percent(summary["reference_line_recall"]),
                    _percent(summary["repeat_box_stability_rate"]),
                    f"{summary['latency_ms']['p95']:.2f}",
                    f"{summary['cpu_ms_per_scan']['mean']:.2f}",
                    f"{summary['cpu_usage']['total_machine_capacity_percent']:.2f}%",
                    _mib(summary["memory"]["peak_rss_bytes"]),
                    _mib(summary["memory"]["incremental_peak_rss_bytes"]),
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "The stability score is the minimum of call success, non-empty geometry, Lens line recall, and repeated box stability. Engines within one percentage point of the best score advance to latency, CPU, and memory tie-breakers.",
            "",
            f"Pending corpus unchanged: **{str(payload['corpus_unchanged']).lower()}**",
            "",
        ]
    )
    report_path.write_text("\n".join(lines), encoding="utf-8")


def write_per_sample_csv(worker_results: dict[str, dict[str, Any]], csv_path: Path) -> None:
    fieldnames = [
        "engine",
        "sample_id",
        "source",
        "width",
        "height",
        "success",
        "latency_ms",
        "cpu_ms",
        "box_count",
        "reference_line_recall",
        "error",
    ]
    with csv_path.open("w", encoding="utf-8", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for engine, worker in worker_results.items():
            for row in worker.get("results") or []:
                writer.writerow(
                    {
                        "engine": engine,
                        "sample_id": row.get("sample_id"),
                        "source": row.get("source"),
                        "width": row.get("width"),
                        "height": row.get("height"),
                        "success": row.get("success"),
                        "latency_ms": row.get("latency_ms"),
                        "cpu_ms": row.get("cpu_ms"),
                        "box_count": len(row.get("boxes") or []),
                        "reference_line_recall": row.get("reference_line_recall"),
                        "error": row.get("error"),
                    }
                )


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    input_dir = Path(args.input_dir).expanduser().resolve()
    if not input_dir.is_dir():
        raise FileNotFoundError(f"OCR metrics input directory does not exist: {input_dir}")
    all_samples = load_samples(input_dir)
    if not all_samples:
        raise RuntimeError(f"No paired OCR metric samples found in {input_dir}")

    corpus_before = fingerprint_directory(input_dir)
    selected = select_stratified_samples(all_samples, args.max_samples)
    consistency = select_stratified_samples(selected, min(args.consistency_samples, len(selected)))
    consistency_ids = {sample["sample_id"] for sample in consistency}
    manifest = [{**sample, "consistency": sample["sample_id"] in consistency_ids} for sample in selected]

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else input_dir.parent / "stability_benchmark" / f"run_{run_id}"
    )
    run_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = run_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    worker_results: dict[str, dict[str, Any]] = {}
    summaries: dict[str, dict[str, Any]] = {}
    for engine in args.engines:
        print(f"Benchmarking {engine} ({len(selected)} samples)...", flush=True)
        worker, memory = run_engine_worker(
            engine=engine,
            manifest_path=manifest_path,
            run_dir=run_dir,
            warmup_samples=args.warmup_samples,
            repeats=args.repeats,
            poll_ms=args.poll_ms,
        )
        worker_results[engine] = worker
        summaries[engine] = aggregate_worker_result(worker, memory)
        summary = summaries[engine]
        print(
            f"  stability={_percent(summary['controller_stability_score'])} "
            f"p95={summary['latency_ms']['p95']:.2f}ms "
            f"cpu={summary['cpu_ms_per_scan']['mean']:.2f}ms/scan "
            f"peak={_mib(summary['memory']['peak_rss_bytes'])}MiB",
            flush=True,
        )

    corpus_after = fingerprint_directory(input_dir)
    corpus_unchanged = corpus_before == corpus_after
    decision = choose_default(summaries)
    payload = {
        "run_id": run_id,
        "input_dir": str(input_dir),
        "output_dir": str(run_dir),
        "available_sample_count": len(all_samples),
        "sample_count": len(selected),
        "consistency_sample_count": len(consistency),
        "repeats": args.repeats,
        "warmup_samples": args.warmup_samples,
        "corpus_unchanged": corpus_unchanged,
        "hardware": hardware_metadata(),
        "engines": summaries,
        "decision": decision,
    }
    (run_dir / "summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    write_per_sample_csv(worker_results, run_dir / "per_sample_results.csv")
    write_report(payload, run_dir / "report.md")
    if not corpus_unchanged:
        raise RuntimeError("Pending OCR corpus changed while the benchmark was running")
    return payload


def parse_engines(value: str) -> list[str]:
    engines = []
    for item in value.split(","):
        engine = item.strip().lower()
        if engine and engine not in engines:
            engines.append(engine)
    if not engines:
        raise argparse.ArgumentTypeError("At least one engine is required")
    return engines


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Benchmark Windows stability OCR engines on saved GSM OCR samples.")
    parser.add_argument("--input-dir", default=str(default_input_dir()))
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--engines", type=parse_engines, default=list(DEFAULT_ENGINES))
    parser.add_argument("--max-samples", type=int, default=750)
    parser.add_argument("--warmup-samples", type=int, default=10)
    parser.add_argument("--consistency-samples", type=int, default=128)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--poll-ms", type=int, default=10)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--engine", default="", help=argparse.SUPPRESS)
    parser.add_argument("--manifest", default="", help=argparse.SUPPRESS)
    parser.add_argument("--worker-output", default="", help=argparse.SUPPRESS)
    parser.add_argument("--phase-marker", default="", help=argparse.SUPPRESS)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.worker:
        return run_worker(args)
    if args.max_samples <= 0:
        raise SystemExit("--max-samples must be greater than zero")
    if args.consistency_samples <= 0:
        raise SystemExit("--consistency-samples must be greater than zero")
    if args.repeats < 2:
        raise SystemExit("--repeats must be at least two")
    try:
        payload = run_benchmark(args)
    except Exception as error:
        print(f"Benchmark failed: {error}", file=sys.stderr)
        return 1
    print(f"Winner: {payload['decision']['winner']}")
    print(f"Report: {Path(payload['output_dir']) / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
