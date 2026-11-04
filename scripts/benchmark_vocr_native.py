"""Fresh-process VOCR comparisons: latency, CPU time, memory and output parity.

Run preparation once with the shipped C models, then benchmark arbitrary native
builds alongside the bundled faithful ONNX assets. Images and recognized text
stay local; results contain hashes, dimensions, timings and agreement counts.
Never run workers concurrently: that would contaminate latency and CPU results.
"""

import argparse
import hashlib
import json
import os
import platform
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def map_digest(maps):
    import numpy as np

    canonical = maps.astype(np.int8)
    if not np.array_equal(maps, canonical):
        raise ValueError("Detector output cannot be represented as signed 8-bit codes")
    return {"sha256": hashlib.sha256(canonical.tobytes()).hexdigest(), "values": maps.size}


def prepare(args):
    from GameSentenceMiner.ocr.vocr_line_finder import VOCRLineFinder
    from scripts.benchmark_vocr_onnx import samples
    from tests.ocr.test_vocr_onnx_native import line_cases

    directory = args.corpus.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    finder = VOCRLineFinder(args.models)
    if finder.kind != "spotter":
        raise RuntimeError(finder.fallback_reason)
    manifest = {"frames": [], "lines": [], "stress": []}

    def save(group, name, image, kind, dark=False):
        filename = f"{group}-{len(manifest[group]):03d}.png"
        image.save(directory / filename)
        manifest[group].append(
            {
                "name": name,
                "file": filename,
                "size": image.size,
                "kind": kind,
                "dark": dark,
                "sha256": hashlib.sha256((directory / filename).read_bytes()).hexdigest(),
            }
        )

    for name, image, kind, _ in samples(args.images, args.font):
        save("frames", name, image, kind)
        for i, box in enumerate(finder.detect(image)[0]):
            if not box["vertical"]:
                save("lines", f"{name}:{i}", image.crop(box["box"]), kind, box["dark"])
    for i, (_, image, dark) in enumerate(line_cases()):
        save("stress", f"stress-{i}", image, "stress", dark)
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print({key: len(value) for key, value in manifest.items()}, flush=True)


def worker(args):
    import numpy as np
    import psutil
    from PIL import Image

    from GameSentenceMiner.ocr.vita_ocr import VitaOCRRuntime, _Line
    from GameSentenceMiner.ocr.vocr_onnx import ONNXRuntime
    from scripts.benchmark_vocr_onnx import native_best, native_maps

    spec = json.loads(args.worker.read_text(encoding="utf-8"))
    directory = Path(spec["corpus"])
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    loaded = {}
    for group, rows in manifest.items():
        loaded[group] = []
        for row in rows:
            path = directory / row["file"]
            if hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
                raise ValueError(f"Corpus checksum failed: {path}")
            with Image.open(path) as image:
                loaded[group].append((image.convert("RGB"), row["dark"]))
    process = psutil.Process()

    def memory():
        info = process.memory_info()._asdict()
        return {key: value / 1048576 for key, value in info.items() if key in ("rss", "private", "peak_wset", "vms")}

    before = memory()
    start = time.perf_counter_ns()
    if spec["kind"] == "native":
        runtime = VitaOCRRuntime(Path(spec["directory"]), model=spec["tier"])
        if spec.get("tile_frames") or spec.get("head_frames"):
            import ctypes as C

            from GameSentenceMiner.ocr.vita_ocr import _aligned, _Options

            options = _Options(
                spec["tile_frames"],
                spec.get("head_frames", 0),
                0,
                3,
                int(spec["tier"] == "normal"),
                int(spec["tier"] != "small"),
            )
            size = runtime.lib.vocr_arena_bytes(runtime._model.ctypes.data, C.byref(options))
            runtime._arena = _aligned(size)
            runtime._check(
                runtime.lib.vocr_init(
                    runtime._context.ctypes.data,
                    runtime._model.ctypes.data,
                    C.byref(options),
                    runtime._arena.ctypes.data,
                    size,
                )
            )
        if spec.get("threads", 1) > 1:
            import ctypes as C

            for library in (runtime.lib, runtime.finder.lib):
                function = library.gsm_vocr_benchmark_threads
                function.argtypes, function.restype = [C.c_uint], None
                function(spec["threads"])
    else:
        runtime = ONNXRuntime(Path(spec["directory"]), model=spec["tier"], mode=spec.get("mode", "faithful"))
    load_ms = (time.perf_counter_ns() - start) / 1e6
    after_load = memory()
    if spec["kind"] == "native" and runtime.finder.kind != "spotter":
        raise RuntimeError(runtime.finder.fallback_reason)

    def line(item):
        image, dark = item
        if spec["kind"] != "native":
            return runtime.recognize_line(image, dark=dark)[0]
        return runtime._recognize_line(
            np.ascontiguousarray(image.convert("RGBA"), dtype=np.uint8),
            _Line(0, 0, image.width, image.height, int(dark)),
        )

    stages = {
        "detection": (lambda item: runtime.finder.detect(item[0])[0], loaded["frames"]),
        "recognition": (line, loaded["lines"]),
        "whole_image": (lambda item: runtime.recognize(item[0]), loaded["frames"]),
    }
    records, parity = {}, {}
    for name, (function, items) in stages.items():
        for _ in range(spec["warmup"]):
            for item in items:
                function(item)
        parity[name] = [digest(function(item)) for item in items]
        passes = []
        for _ in range(spec["passes"]):
            per_item = []
            cpu0, wall0 = time.process_time_ns(), time.perf_counter_ns()
            for item in items:
                start = time.perf_counter_ns()
                function(item)
                per_item.append((time.perf_counter_ns() - start) / 1e6)
            wall_ms = (time.perf_counter_ns() - wall0) / 1e6
            cpu_ms = (time.process_time_ns() - cpu0) / 1e6
            passes.append(
                {
                    "mean_ms": statistics.mean(per_item),
                    "item_ms": per_item,
                    "cpu_ms_per_item": cpu_ms / len(items),
                    "wall_ms": wall_ms,
                    "cpu_ms": cpu_ms,
                    "core_percent": 100 * cpu_ms / wall_ms,
                }
            )
        records[name] = passes
    after_warm = memory()
    cpu0, wall0 = time.process_time_ns(), time.perf_counter_ns()
    time.sleep(1)
    idle = 100 * (time.process_time_ns() - cpu0) / (time.perf_counter_ns() - wall0)
    paced = None
    if spec.get("paced_scans", 0):
        cpu0, wall0 = time.process_time_ns(), time.perf_counter()
        elapsed, late = [], 0
        for i in range(spec["paced_scans"]):
            start = time.perf_counter()
            runtime.recognize(loaded["frames"][i % len(loaded["frames"])][0])
            elapsed.append((time.perf_counter() - start) * 1000)
            delay = wall0 + (i + 1) * spec["interval"] - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            else:
                late += 1
        cpu_ms = (time.process_time_ns() - cpu0) / 1e6
        wall_ms = (time.perf_counter() - wall0) * 1000
        paced = {
            "scans": len(elapsed),
            "interval_seconds": spec["interval"],
            "cpu_ms": cpu_ms,
            "wall_ms": wall_ms,
            "core_percent": 100 * cpu_ms / wall_ms,
            "host_percent": 100 * cpu_ms / wall_ms / psutil.cpu_count(),
            "missed_deadlines": late,
            "item_ms": elapsed,
        }

    # Validation is outside timings and the warm memory snapshot.
    parity["line_detail"] = []
    for item in loaded["lines"] + loaded["stress"]:
        image, dark = item
        result = line(item)
        best = (
            native_best(runtime, image, dark)
            if spec["kind"] == "native"
            else runtime.recognize_line(image, dark=dark)[1]
        )
        parity["line_detail"].append(
            {
                "text": digest(result["text"]),
                "characters": digest(result["characters"]),
                "frames": digest(best.tolist()),
                "frame_count": len(best),
            }
        )
    parity["maps"] = []
    rng = np.random.default_rng(71)
    map_images = [image for image, _ in loaded["frames"]]
    map_images += [
        Image.fromarray(rng.integers(0, 256, (h, w, 3), dtype=np.uint8))
        for w, h in ((1, 1), (17, 9), (321, 119), (960, 544), (1921, 1081))
    ]
    for image in map_images:
        if spec["kind"] == "native":
            maps, _ = native_maps(runtime.finder, image)
        else:
            scaled = image.convert("RGBA")
            scaled.thumbnail((960, 544), Image.Resampling.LANCZOS)
            maps = runtime.finder.detect_maps(scaled)
        parity["maps"].append(map_digest(maps))
    result = {
        "spec": spec,
        "load_ms": load_ms,
        "memory_mib": {"before": before, "loaded": after_load, "warm": after_warm},
        "idle_core_percent": idle,
        "timings": records,
        "parity": parity,
        "threads_after_warm": process.num_threads(),
        "paced": paced,
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def compare(args):
    import numpy as np
    import onnxruntime as ort
    import psutil

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    work = output.parent / (output.stem + "-workers")
    work.mkdir(exist_ok=True)
    variants = [{"name": "onnx-faithful", "kind": "onnx", "directory": str(args.onnx.resolve())}]
    if args.fast:
        variants.append({"name": "onnx-fast", "kind": "onnx", "mode": "fast", "directory": str(args.fast.resolve())})
    for entry in args.native:
        name, path = entry.split("=", 1)
        variants.append({"name": name, "kind": "native", "directory": str(Path(path).resolve())})
    for entry in args.native_options:
        name, values = entry.split("=", 1)
        threads, tile, head = map(int, values.split(","))
        variant = next(v for v in variants if v["name"] == name and v["kind"] == "native")
        variant.update(threads=threads, tile_frames=tile, head_frames=head)
    if args.native_only:
        variants = [variant for variant in variants if variant["kind"] == "native"]
    jobs = [(tier, variant, round_) for round_ in range(args.rounds) for tier in args.tiers for variant in variants]
    random.Random(args.seed).shuffle(jobs)
    report = {
        "environment": {
            "platform": platform.platform(),
            "processor": platform.processor(),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "onnxruntime": ort.__version__,
            "logical_cpus": psutil.cpu_count(),
            "physical_cores": psutil.cpu_count(logical=False),
            "inference_threads": 1,
            "seed": args.seed,
        },
        "corpus": json.loads((args.corpus / "manifest.json").read_text(encoding="utf-8")),
        "runs": [],
    }
    for i, (tier, variant, round_) in enumerate(jobs):
        spec = {
            **variant,
            "tier": tier,
            "round": round_,
            "corpus": str(args.corpus.resolve()),
            "passes": args.passes,
            "warmup": args.warmup,
            "paced_scans": args.paced_scans,
            "interval": args.interval,
        }
        jobfile, resultfile = work / f"{i:03d}-job.json", work / f"{i:03d}-result.json"
        jobfile.write_text(json.dumps(spec), encoding="utf-8")
        print(f"{i + 1}/{len(jobs)} {tier} {variant['name']} round {round_ + 1}", flush=True)
        with (work / f"{i:03d}.log").open("w", encoding="utf-8") as log:
            subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "worker",
                    "--worker",
                    str(jobfile),
                    "--output",
                    str(resultfile),
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
                env={**os.environ, "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"},
            )
        report["runs"].append(json.loads(resultfile.read_text(encoding="utf-8")))
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(str(output), flush=True)


def summarize(args):
    import numpy as np

    report = json.loads(args.input.read_text(encoding="utf-8"))
    results = {}
    tiers = sorted({run["spec"]["tier"] for run in report["runs"]})
    for tier in tiers:
        runs = [run for run in report["runs"] if run["spec"]["tier"] == tier]
        reference = next(run["parity"] for run in runs if run["spec"]["name"] == args.reference)
        results[tier] = {}
        for name in sorted({run["spec"]["name"] for run in runs}):
            rows = [run for run in runs if run["spec"]["name"] == name]
            result = {
                "processes": len(rows),
                "timings": {},
                "memory_mib": {},
                "load_ms": statistics.median(row["load_ms"] for row in rows),
                "idle_core_percent_max": max(row["idle_core_percent"] for row in rows),
            }
            for stage in ("detection", "recognition", "whole_image"):
                passes = [p for row in rows for p in row["timings"][stage]]
                items = [value for p in passes for value in p["item_ms"]]
                cpu = statistics.median(p["cpu_ms_per_item"] for p in passes)
                result["timings"][stage] = {
                    "passes": len(passes),
                    "mean_ms_median": statistics.median(p["mean_ms"] for p in passes),
                    "mean_ms_range": [min(p["mean_ms"] for p in passes), max(p["mean_ms"] for p in passes)],
                    "call_p50_ms": float(np.percentile(items, 50)),
                    "call_p95_ms": float(np.percentile(items, 95)),
                    "cpu_ms_per_item_median": cpu,
                    "active_core_percent_median": statistics.median(p["core_percent"] for p in passes),
                    "host_percent_at_5_scans_per_second": cpu * 5 / 10 / report["environment"]["logical_cpus"],
                }
                group = "lines" if stage == "recognition" else "frames"
                for kind in {item["kind"] for item in report["corpus"][group]}:
                    indices = [i for i, item in enumerate(report["corpus"][group]) if item["kind"] == kind]
                    result["timings"][stage][f"{kind}_mean_ms"] = statistics.median(
                        statistics.mean(p["item_ms"][i] for i in indices) for p in passes
                    )
            for phase in ("before", "loaded", "warm"):
                result["memory_mib"][phase] = {
                    key: statistics.median(row["memory_mib"][phase][key] for row in rows)
                    for key in rows[0]["memory_mib"][phase]
                }
            for key in ("rss", "private"):
                if key in rows[0]["memory_mib"]["warm"]:
                    result["memory_mib"][f"warm_increment_{key}"] = statistics.median(
                        row["memory_mib"]["warm"][key] - row["memory_mib"]["before"][key] for row in rows
                    )
            parity = rows[0]["parity"]
            agreement = {
                "reference": args.reference,
                "repeat_output_changes": sum(row["parity"] != parity for row in rows),
                "detector_images": len(reference["detection"]),
                "whole_images": len(reference["whole_image"]),
                "line_cases": len(reference["line_detail"]),
                "detector_map_values": sum(row["values"] for row in reference["maps"]),
            }
            for stage in ("detection", "recognition", "whole_image", "maps"):
                if len(reference[stage]) != len(parity[stage]):
                    raise ValueError("Cannot compare different corpora")
                agreement[f"{stage}_changed"] = sum(a != b for a, b in zip(reference[stage], parity[stage]))
            for key in ("text", "characters", "frames"):
                if len(reference["line_detail"]) != len(parity["line_detail"]):
                    raise ValueError("Cannot compare different line validation corpora")
                agreement[f"line_{key}_changed"] = sum(
                    a[key] != b[key] for a, b in zip(reference["line_detail"], parity["line_detail"])
                )
            result["agreement"] = agreement
            paced = [row["paced"] for row in rows if row.get("paced")]
            if paced:
                result["paced"] = {
                    "scans": sum(row["scans"] for row in paced),
                    "host_percent_median": statistics.median(row["host_percent"] for row in paced),
                    "core_percent_median": statistics.median(row["core_percent"] for row in paced),
                    "missed_deadlines": sum(row["missed_deadlines"] for row in paced),
                }
            results[tier][name] = result
    compact = {"environment": report["environment"], "corpus": report["corpus"], "results": results}
    args.output.write_text(json.dumps(compact, indent=2) + "\n", encoding="utf-8")
    for tier, variants in results.items():
        for name, result in variants.items():
            full = result["timings"]["whole_image"]
            print(
                tier,
                name,
                round(full["mean_ms_median"], 2),
                "ms/image",
                round(full["cpu_ms_per_item_median"], 2),
                "CPU ms/image",
                round(result["memory_mib"]["warm"]["rss"], 1),
                "MiB RSS",
                result["agreement"],
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("--models", type=Path, required=True)
    prep.add_argument("--images", type=Path, nargs="*", default=[])
    prep.add_argument("--font", type=Path, default=Path("C:/Windows/Fonts/msgothic.ttc"))
    prep.add_argument("--corpus", type=Path, required=True)
    run = commands.add_parser("compare")
    run.add_argument("--corpus", type=Path, required=True)
    run.add_argument("--onnx", type=Path, default=ROOT / "GameSentenceMiner/assets/vocr")
    run.add_argument("--fast", type=Path)
    run.add_argument("--native", action="append", default=[], help="name=directory; include the shipped baseline")
    run.add_argument("--native-options", action="append", default=[], help="name=threads,tile_frames,head_frames")
    run.add_argument("--native-only", action="store_true")
    run.add_argument("--tiers", nargs="+", default=["small", "normal", "large"])
    run.add_argument("--rounds", type=int, default=3)
    run.add_argument("--passes", type=int, default=3)
    run.add_argument("--warmup", type=int, default=2)
    run.add_argument("--seed", type=int, default=20261102)
    run.add_argument("--paced-scans", type=int, default=0)
    run.add_argument("--interval", type=float, default=0.2)
    run.add_argument("--output", type=Path, required=True)
    child = commands.add_parser("worker")
    child.add_argument("--worker", type=Path, required=True)
    child.add_argument("--output", type=Path, required=True)
    summary = commands.add_parser("summarize")
    summary.add_argument("--input", type=Path, required=True)
    summary.add_argument("--reference", default="shipped-c")
    summary.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    {"prepare": prepare, "compare": compare, "worker": worker, "summarize": summarize}[args.command](args)


if __name__ == "__main__":
    main()
