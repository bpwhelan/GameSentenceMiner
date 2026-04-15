from __future__ import annotations

import argparse
import math
import statistics
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


run = None
obs = None
connect_to_obs_sync = None
disconnect_from_obs = None
get_ocr_ocr1 = None


def ensure_gsm_imports() -> None:
    global run, obs, connect_to_obs_sync, disconnect_from_obs, get_ocr_ocr1
    if run is not None:
        return

    from GameSentenceMiner import obs as gsm_obs
    from GameSentenceMiner.obs import connect_to_obs_sync as gsm_connect_to_obs_sync
    from GameSentenceMiner.obs import disconnect_from_obs as gsm_disconnect_from_obs
    from GameSentenceMiner.owocr.owocr import run as gsm_run
    from GameSentenceMiner.util.config.electron_config import get_ocr_ocr1 as gsm_get_ocr_ocr1

    obs = gsm_obs
    connect_to_obs_sync = gsm_connect_to_obs_sync
    disconnect_from_obs = gsm_disconnect_from_obs
    run = gsm_run
    get_ocr_ocr1 = gsm_get_ocr_ocr1


def flatten_text(text: Any) -> str:
    if text is None:
        return ""
    if isinstance(text, list):
        text = " ".join(str(item) for item in text if item is not None)
    return " ".join(str(text).replace("\r\n", "\n").replace("\r", "\n").split())


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("percentile() requires at least one value")
    if fraction <= 0:
        return min(values)
    if fraction >= 1:
        return max(values)

    sorted_values = sorted(values)
    if len(sorted_values) == 1:
        return sorted_values[0]

    index = (len(sorted_values) - 1) * fraction
    lower_index = int(math.floor(index))
    upper_index = int(math.ceil(index))
    if lower_index == upper_index:
        return sorted_values[lower_index]

    lower_value = sorted_values[lower_index]
    upper_value = sorted_values[upper_index]
    weight = index - lower_index
    return lower_value + (upper_value - lower_value) * weight


def _fps_from_seconds(seconds: float) -> float:
    if seconds <= 0:
        return float("inf")
    return 1.0 / seconds


def summarize_timings(latencies_seconds: list[float]) -> dict[str, float]:
    if not latencies_seconds:
        raise ValueError("No timings recorded")

    sample_count = len(latencies_seconds)
    bucket_size = max(1, math.ceil(sample_count * 0.01))
    sorted_latencies = sorted(latencies_seconds)
    fps_values = [_fps_from_seconds(value) for value in latencies_seconds]
    sorted_fps = sorted(fps_values)
    total_seconds = sum(latencies_seconds)
    avg_seconds = total_seconds / sample_count

    return {
        "count": float(sample_count),
        "total_seconds": total_seconds,
        "avg_seconds": avg_seconds,
        "median_seconds": statistics.median(latencies_seconds),
        "stdev_seconds": statistics.pstdev(latencies_seconds) if sample_count > 1 else 0.0,
        "min_seconds": sorted_latencies[0],
        "max_seconds": sorted_latencies[-1],
        "p01_seconds": percentile(sorted_latencies, 0.01),
        "p05_seconds": percentile(sorted_latencies, 0.05),
        "p95_seconds": percentile(sorted_latencies, 0.95),
        "p99_seconds": percentile(sorted_latencies, 0.99),
        "throughput_fps": sample_count / total_seconds if total_seconds > 0 else float("inf"),
        "avg_fps": _fps_from_seconds(avg_seconds),
        "median_fps": _fps_from_seconds(statistics.median(latencies_seconds)),
        "low_1_percent_fps": statistics.fmean(sorted_fps[:bucket_size]),
        "high_1_percent_fps": statistics.fmean(sorted_fps[-bucket_size:]),
    }


def ms(seconds: float) -> float:
    return seconds * 1000.0


def _resolve_engine_instance(engine_name: str):
    target = (engine_name or "").strip().lower()
    for instance in getattr(run, "engine_instances", []) or []:
        name = str(getattr(instance, "name", "")).strip().lower()
        if name == target:
            return instance
    available_names = [getattr(instance, "name", "?") for instance in getattr(run, "engine_instances", []) or []]
    raise RuntimeError(f"Engine '{target}' is not initialized. Available initialized engines: {available_names}")


def initialize_engine(engine_name: str):
    ensure_gsm_imports()
    run.init_config(parse_args=False)
    run.engine_instances = []
    run.engine_keys = []
    run.engine_index = 0
    run.engine_change_handler_name(engine_name, switch=False)
    return _resolve_engine_instance(engine_name)


def ensure_obs_connected() -> None:
    ensure_gsm_imports()
    if getattr(obs, "obs_service", None):
        return
    connect_to_obs_sync(start_manager=False)
    if not getattr(obs, "obs_service", None):
        raise RuntimeError("Failed to connect to OBS. Make sure OBS is running and the websocket is reachable.")


def capture_obs_image(*, compression: int, img_format: str):
    ensure_obs_connected()
    scene_name = obs.get_current_scene()
    best_source = obs.get_best_source_for_screenshot(log_missing_source=True, suppress_errors=False)
    source_name = best_source.get("sourceName") if isinstance(best_source, dict) else None
    image = obs.get_screenshot_PIL(
        source_name=source_name,
        compression=compression,
        img_format=img_format,
    )
    if image is None:
        raise RuntimeError("Failed to capture screenshot from the active OBS scene.")
    return scene_name, source_name, image


def run_ocr_once(engine_instance, pil_image):
    start = time.perf_counter()
    result = engine_instance(pil_image, 0)
    elapsed_seconds = time.perf_counter() - start
    success, text, coords, crop_coords_list, crop_coords, response_dict = (list(result) + [None] * 6)[:6]
    return {
        "success": bool(success),
        "text": flatten_text(text),
        "coords": coords,
        "crop_coords_list": crop_coords_list,
        "crop_coords": crop_coords,
        "response_dict": response_dict,
        "elapsed_seconds": elapsed_seconds,
    }


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark a single OCR engine from GameSentenceMiner against the current OBS scene."
    )
    parser.add_argument(
        "--engine",
        default="",
        help="OCR engine name from ocr.py, for example: meikiocr, oneocr, screenai, mlkitocr. Defaults to OCR1.",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=1000,
        help="Number of timed iterations to run. Default: 1000.",
    )
    parser.add_argument(
        "--warmup",
        type=int,
        default=10,
        help="Warmup iterations to run before timing. Default: 10.",
    )
    parser.add_argument(
        "--compression",
        type=int,
        default=90,
        help="OBS screenshot quality/compression value passed to OBS. Default: 90.",
    )
    parser.add_argument(
        "--img-format",
        default="jpg",
        choices=("jpg", "png"),
        help="OBS screenshot format. Default: jpg.",
    )
    parser.add_argument(
        "--recapture-each-run",
        action="store_true",
        help="Capture a fresh OBS screenshot for every timed run instead of reusing one still image.",
    )
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="Keep benchmarking if an iteration fails. Failures are counted and excluded from timing stats.",
    )
    parser.add_argument(
        "--preview-chars",
        type=int,
        default=160,
        help="How many characters of the first OCR result to print. Default: 160.",
    )
    return parser


def main() -> int:
    args = build_argument_parser().parse_args()
    if args.iterations <= 0:
        raise SystemExit("--iterations must be greater than 0")
    if args.warmup < 0:
        raise SystemExit("--warmup must be >= 0")

    ensure_gsm_imports()
    engine_name = (args.engine or get_ocr_ocr1() or "").strip().lower()
    if not engine_name:
        raise SystemExit("Could not resolve an OCR engine. Pass --engine explicitly.")

    engine_instance = initialize_engine(engine_name)
    scene_name, source_name, base_image = capture_obs_image(
        compression=args.compression,
        img_format=args.img_format,
    )

    print(f"Python executable: {sys.executable}")
    print(f"Engine: {engine_instance.name} ({engine_instance.readable_name})")
    print(f"Scene: {scene_name or '<unknown>'}")
    print(f"Source: {source_name or '<auto>'}")
    print(f"Image size: {base_image.width}x{base_image.height}")
    print(
        "Capture mode: "
        + ("fresh OBS screenshot every iteration" if args.recapture_each_run else "single OBS screenshot reused")
    )
    print(f"Warmup iterations: {args.warmup}")
    print(f"Timed iterations: {args.iterations}")
    print("")

    first_result = None
    warmup_failures = 0
    for _ in range(args.warmup):
        image = (
            capture_obs_image(compression=args.compression, img_format=args.img_format)[2]
            if args.recapture_each_run
            else base_image
        )
        result = run_ocr_once(engine_instance, image)
        if first_result is None:
            first_result = result
        if not result["success"]:
            warmup_failures += 1
            if not args.keep_going:
                print(f"Warmup failed: {result['text']}")
                return 1

    latencies: list[float] = []
    success_texts: list[str] = []
    failure_messages: list[str] = []
    failure_count = 0
    benchmark_started = time.perf_counter()

    for iteration_index in range(args.iterations):
        image = (
            capture_obs_image(compression=args.compression, img_format=args.img_format)[2]
            if args.recapture_each_run
            else base_image
        )
        result = run_ocr_once(engine_instance, image)
        if first_result is None:
            first_result = result

        if result["success"]:
            latencies.append(result["elapsed_seconds"])
            success_texts.append(result["text"])
            continue

        failure_count += 1
        failure_messages.append(result["text"])
        if not args.keep_going:
            print(f"Timed iteration {iteration_index + 1} failed: {result['text']}")
            return 1

    benchmark_elapsed_seconds = time.perf_counter() - benchmark_started

    if not latencies:
        print("No successful timed iterations were recorded.")
        return 1

    summary = summarize_timings(latencies)
    text_counts = Counter(success_texts)
    unique_text_count = len(text_counts)
    most_common_text, most_common_text_count = text_counts.most_common(1)[0]
    preview_text = flatten_text(first_result["text"])[: args.preview_chars] if first_result else ""
    stability_ratio = most_common_text_count / len(success_texts) if success_texts else 0.0

    print("Summary")
    print("-------")
    print(f"Successful timed iterations: {len(latencies)}/{args.iterations}")
    print(f"Warmup failures: {warmup_failures}")
    print(f"Timed failures: {failure_count}")
    print(f"Total timed wall-clock: {benchmark_elapsed_seconds:.4f}s")
    print(f"Average latency: {ms(summary['avg_seconds']):.3f} ms")
    print(f"Median latency: {ms(summary['median_seconds']):.3f} ms")
    print(f"Latency stdev: {ms(summary['stdev_seconds']):.3f} ms")
    print(f"Min latency: {ms(summary['min_seconds']):.3f} ms")
    print(f"Max latency: {ms(summary['max_seconds']):.3f} ms")
    print(f"P01 latency: {ms(summary['p01_seconds']):.3f} ms")
    print(f"P05 latency: {ms(summary['p05_seconds']):.3f} ms")
    print(f"P95 latency: {ms(summary['p95_seconds']):.3f} ms")
    print(f"P99 latency: {ms(summary['p99_seconds']):.3f} ms")
    print(f"Throughput: {summary['throughput_fps']:.2f} runs/sec")
    print(f"Average FPS-style speed: {summary['avg_fps']:.2f}")
    print(f"Median FPS-style speed: {summary['median_fps']:.2f}")
    print(f"1% low FPS-style speed: {summary['low_1_percent_fps']:.2f}")
    print(f"1% high FPS-style speed: {summary['high_1_percent_fps']:.2f}")
    print(f"Unique OCR outputs: {unique_text_count}")
    print(f"Most common OCR output frequency: {most_common_text_count}/{len(success_texts)} ({stability_ratio:.2%})")
    print(f"First OCR preview: {preview_text or '<blank>'}")
    if unique_text_count > 1:
        print(f"Most common OCR preview: {most_common_text[: args.preview_chars] or '<blank>'}")
    if failure_messages:
        print(f"First failure message: {failure_messages[0]}")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    finally:
        try:
            if disconnect_from_obs is not None:
                disconnect_from_obs()
        except Exception:
            pass
