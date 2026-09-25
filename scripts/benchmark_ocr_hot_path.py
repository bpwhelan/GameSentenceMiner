"""Compare OCR hot paths with a git revision, requiring exact output equality.

Capture once with --input-dir, then reuse --records to measure the same raw OCR
responses without inference noise. Records contain local OCR text and image
paths; only aggregate metrics are written to --output. No remote engines run.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import statistics
import subprocess
import sys
import time
import types
from dataclasses import asdict
from itertools import pairwise
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_reference(module_name: str, revision: str):
    """Load reference code beside its package so relative imports still work."""
    source_path = module_name.replace(".", "/") + ".py"
    source = subprocess.check_output(["git", "show", f"{revision}:{source_path}"], cwd=ROOT)
    package, _, leaf = module_name.rpartition(".")
    name = f"{package}._benchmark_reference_{leaf}"
    module = types.ModuleType(name)
    module.__file__ = str(ROOT / source_path)
    module.__package__ = package
    sys.modules[name] = module
    exec(compile(source, f"{revision}:{source_path}", "exec"), module.__dict__)  # noqa: S102 - explicit local git reference
    return module


def sample_paths(directory: Path, limit: int) -> list[Path]:
    paths = sorted(directory.glob("*.png"))
    if not paths:
        raise ValueError(f"No PNG images in {directory}")
    count = min(limit, len(paths))
    return [paths[i * (len(paths) - 1) // max(1, count - 1)] for i in range(count)]


def capture_records(ocr, directory: Path, limit: int) -> list[dict]:
    engine = ocr.OneOCR(get_furigana_sens_from_file=False)
    if not engine.available:
        raise RuntimeError("OneOCR must be installed to capture raw responses")
    records = []
    paths = sample_paths(directory, limit)
    for index, path in enumerate(paths):
        with Image.open(path) as source:
            image = ocr._pad_image_min_side(source, min_side=51)
            prepared = engine._preprocess_windows(image)
            raw = engine.model.recognize_pil(prepared)
            if "error" in raw:
                raise RuntimeError(f"OneOCR failed for {path.name}: {raw['error']}")
            records.append({"path": str(path), "size": image.size, "prepared_size": prepared.size, "raw": raw})
        if (index + 1) % 128 == 0:
            print(f"Captured {index + 1}/{len(paths)} raw OCR responses", flush=True)
    return records


def convert_result(module, engine, record, sensitivity=0, spacing=True):
    generic = engine._to_generic_result(record["raw"], *record["prepared_size"], *record["size"])
    return module.ocr_result_to_oneocr_tuple((True, generic), sensitivity, prefer_axis_spacing=spacing)


def require_equal(reference, current, context: str):
    if reference != current:
        raise AssertionError(f"Output mismatch: {context}")


def measure_pair(before, after, *, repeats: int, loops: int, calls: int = 1) -> dict:
    before()
    after()
    timings = [[], []]
    for repeat in range(repeats):
        # Alternate order to reduce the effect of CPU load and thermal drift.
        for index in (0, 1) if repeat % 2 else (1, 0):
            function = (before, after)[index]
            started = time.perf_counter_ns()
            for _ in range(loops):
                function()
            timings[index].append((time.perf_counter_ns() - started) / (loops * calls * 1_000_000))
    medians = [statistics.median(values) for values in timings]
    return {
        "before_ms": medians[0],
        "after_ms": medians[1],
        "speedup": medians[0] / medians[1],
        "reduction_percent": (1 - medians[1] / medians[0]) * 100,
        "before_rounds_ms": timings[0],
        "after_rounds_ms": timings[1],
    }


def verify_stability(records, reference, current, limit=128):
    count = min(limit, len(records))
    observations = 0
    for index in range(count):
        record = records[index * (len(records) - 1) // max(1, count - 1)]
        with Image.open(record["path"]) as source:
            frame = source.convert("RGB")
        payload = {"crop_coords": (0, 0, *frame.size)}
        shifted = frame.transform(frame.size, Image.Transform.AFFINE, (1, 0, 1, 0, 1, 0))
        blank = Image.new("RGB", frame.size)
        gates = [module.ImageStabilityGate() for module in (reference, current)]
        for image in (frame, frame, shifted, shifted, blank, blank, frame):
            results = [asdict(gate.observe(image)) for gate in gates]
            require_equal(*results, f"stability sample {index}")
            observations += 1
            if results[0]["should_run"]:
                require_equal(*(gate.update_reference(image, payload) for gate in gates), f"reference update {index}")
    return observations


def benchmark(args) -> dict:
    from GameSentenceMiner.ocr import compare
    from GameSentenceMiner.owocr.owocr import ocr, ocr_runtime
    from GameSentenceMiner.util import image_stability

    revision = subprocess.check_output(["git", "rev-parse", args.reference_ref], cwd=ROOT, text=True).strip()
    ref_ocr = load_reference(ocr.__name__, revision)
    ref_compare = load_reference(compare.__name__, revision)
    ref_stability = load_reference(image_stability.__name__, revision)
    ref_runtime = load_reference(ocr_runtime.__name__, revision)
    ocr.get_ocr_language = ref_ocr.get_ocr_language = lambda: args.language

    if args.input_dir:
        records = capture_records(ocr, args.input_dir, args.max_samples)
        args.records.parent.mkdir(parents=True, exist_ok=True)
        args.records.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
    else:
        records = json.loads(args.records.read_text(encoding="utf-8"))
    if not records:
        raise ValueError("At least one raw OCR record is required")

    stability_observations = verify_stability(records, ref_stability, image_stability)

    modules = (ref_ocr, ocr)
    engines = [module.OneOCR.__new__(module.OneOCR) for module in modules]
    parity_count = 0
    for index, record in enumerate(records):
        for sensitivity in (0, 10, 20, 40, 100):
            for spacing in (False, True):
                outputs = [
                    convert_result(module, engine, record, sensitivity, spacing)
                    for module, engine in zip(modules, engines)
                ]
                require_equal(*outputs, f"record {index}, sensitivity {sensitivity}, spacing {spacing}")
                parity_count += 1

    metrics = {}

    def record_metric(name, before, after, *, calls=1):
        value = measure_pair(before, after, repeats=args.repeats, loops=args.loops, calls=calls)
        metrics[name] = value
        print(f"{name}: {value['before_ms']:.4f} -> {value['after_ms']:.4f} ms ({value['speedup']:.2f}x)", flush=True)

    def replay(module, engine):
        for record in records:
            convert_result(module, engine, record)

    record_metric(
        "result_conversion", lambda: replay(ref_ocr, engines[0]), lambda: replay(ocr, engines[1]), calls=len(records)
    )
    texts = [convert_result(ocr, engines[1], record)[1] for record in records]
    comparisons = [(text, text) for text in texts] + list(pairwise(texts))
    comparisons += [(left.splitlines(), right.splitlines()) for left, right in list(comparisons)]
    for left, right in comparisons:
        require_equal(
            ref_compare.compare_ocr_results(left, right), compare.compare_ocr_results(left, right), "text comparison"
        )

    def compare_all(module):
        for left, right in comparisons:
            module.compare_ocr_results(left, right)

    record_metric(
        "text_comparison", lambda: compare_all(ref_compare), lambda: compare_all(compare), calls=len(comparisons)
    )
    recent_pairs = [(left.splitlines(), right.splitlines()) for left, right in list(pairwise(texts))[:64]]

    def compare_recent(module):
        for left, right in recent_pairs:
            module.compare_ocr_results(left, right)

    if recent_pairs:
        record_metric(
            "recent_text_comparison",
            lambda: compare_recent(ref_compare),
            lambda: compare_recent(compare),
            calls=len(recent_pairs),
        )

    rng = np.random.default_rng(731)
    image = Image.fromarray(rng.integers(0, 256, (240, 640, 3), dtype=np.uint8))
    changed = Image.fromarray(rng.integers(0, 256, (240, 640, 3), dtype=np.uint8))
    payload = {"crop_coords": (0, 0, 640, 240)}
    gates = [module.ImageStabilityGate() for module in (ref_stability, image_stability)]
    for frame in (image, image, changed, changed, image):
        require_equal(*(gate.update_reference(frame, payload) for gate in gates), "stability update")
        require_equal(*(asdict(gate.observe(frame)) for gate in gates), "stability decision and exact score")
    record_metric(
        "stability_reference_update",
        lambda: gates[0].update_reference(image, payload),
        lambda: gates[1].update_reference(image, payload),
    )
    record_metric("stability_observe", lambda: gates[0].observe(image), lambda: gates[1].observe(image))
    alternating_frames = (image, changed) * 4

    def observe_changes(gate):
        for frame in alternating_frames:
            gate.observe(frame)

    record_metric(
        "stability_changing_frames", lambda: observe_changes(gates[0]), lambda: observe_changes(gates[1]), calls=8
    )
    for size in ((640, 240), (1920, 1080), (3840, 2160)):
        frame = Image.new("RGB", size, (31, 88, 197))
        require_equal(
            ref_runtime._is_capture_frame_empty(frame), ocr_runtime._is_capture_frame_empty(frame), "blank frame"
        )
        record_metric(
            f"blank_check_{size[0]}x{size[1]}",
            lambda frame=frame: ref_runtime._is_capture_frame_empty(frame),
            lambda frame=frame: ocr_runtime._is_capture_frame_empty(frame),
        )

    for mode in ("L", "RGBA"):
        frame = Image.new(mode, (1920, 1080), 128)
        np.testing.assert_array_equal(
            ref_ocr.pil_image_to_rgb_numpy_array(frame), ocr.pil_image_to_rgb_numpy_array(frame)
        )
        record_metric(
            f"rgb_array_{mode}_1920x1080",
            lambda frame=frame: ref_ocr.pil_image_to_rgb_numpy_array(frame),
            lambda frame=frame: ocr.pil_image_to_rgb_numpy_array(frame),
        )
    for mode in ("RGB", "RGBA"):
        frame = Image.new(mode, (1920, 1080), (31, 88, 197))
        require_equal(ref_ocr.pil_image_to_bytes(frame), ocr.pil_image_to_bytes(frame), "PNG bytes")
        record_metric(
            f"png_{mode}_1920x1080",
            lambda frame=frame: ref_ocr.pil_image_to_bytes(frame),
            lambda frame=frame: ocr.pil_image_to_bytes(frame),
        )

    # Exercise the installed library's actual encoder with native inference
    # replaced by a byte sink. This isolates copies from model timing noise.
    import oneocr

    raw_model = oneocr.OcrEngine.__new__(oneocr.OcrEngine)
    raw_model.ocr_dll = None  # The byte-only model owns no native resources.
    raw_model._process_image = lambda **kwargs: kwargs["data"]
    wrapper = ocr.OneOCR.__new__(ocr.OneOCR)
    wrapper.model = raw_model
    encode_after = getattr(wrapper, "_recognize_pil", raw_model.recognize_pil)
    for mode in ("RGB", "RGBA"):
        for size in ((640, 240), (1920, 1080), (3840, 2160)):
            frame = Image.new(mode, size, (31, 88, 197))
            require_equal(raw_model.recognize_pil(frame), encode_after(frame), "OneOCR input bytes")
            record_metric(
                f"oneocr_pixels_{mode}_{size[0]}x{size[1]}",
                lambda frame=frame: raw_model.recognize_pil(frame),
                lambda frame=frame: encode_after(frame),
            )

    verified_inferences = 0
    if args.verify_inference:
        real_model = ocr.OneOCR(get_furigana_sens_from_file=False).model
        for engine in engines:
            engine.model = real_model
            engine.initial_lang = args.language
            engine.get_furigana_sens_from_file = False
        live_timings = [[], []]
        count = min(args.verify_inference, len(records))
        selected = [records[i * (len(records) - 1) // max(1, count - 1)] for i in range(count)]
        for index, record in enumerate(selected):
            with Image.open(record["path"]) as frame:
                frame.load()
                outputs = [None, None]
                for side in (0, 1) if index % 2 else (1, 0):
                    start = time.perf_counter_ns()
                    outputs[side] = engines[side](frame, 0)
                    live_timings[side].append((time.perf_counter_ns() - start) / 1_000_000)
                require_equal(*outputs, f"live OneOCR result {index}")
                verified_inferences += 1
        metrics["live_oneocr"] = {
            "before_ms": statistics.median(live_timings[0]),
            "after_ms": statistics.median(live_timings[1]),
            "note": "Unprofiled paired real inference; timing includes model variability.",
        }

    return {
        "reference_revision": revision,
        "python": sys.version,
        "platform": platform.platform(),
        "numpy": np.__version__,
        "dependencies": {
            package: importlib.metadata.version(package)
            for package in ("Pillow", "opencv-python", "oneocr", "rapidfuzz")
        },
        "samples": len(records),
        "records_sha256": hashlib.sha256(args.records.read_bytes()).hexdigest(),
        "exact_result_comparisons": parity_count,
        "exact_stability_observations": stability_observations,
        "verified_live_inferences": verified_inferences,
        "repeats": args.repeats,
        "loops_per_repeat": args.loops,
        "metrics": metrics,
    }


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--records", type=Path, required=True)
    parser.add_argument("--input-dir", type=Path, help="Capture raw responses here before benchmarking")
    parser.add_argument("--max-samples", type=positive_int, default=128)
    parser.add_argument("--reference-ref", default="HEAD")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--repeats", type=positive_int, default=9)
    parser.add_argument("--loops", type=positive_int, default=5)
    parser.add_argument("--verify-inference", type=int, default=0, metavar="SAMPLES")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = benchmark(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        f"Exact result comparisons: {report['exact_result_comparisons']}; live inferences: {report['verified_live_inferences']}"
    )


if __name__ == "__main__":
    main()
