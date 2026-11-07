"""Compare all VOCR ONNX components against GSM's shipped C runtime on CPU.

Writes raw timings, input hashes, per-frame disagreements and stage summaries.
Real screenshots stay local. Synthetic text checks are reported separately;
agreement with C is not an accuracy score against human-labelled game text.
"""

import argparse
import ctypes as C
import hashlib
import json
import platform
import random
import statistics
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from GameSentenceMiner.ocr.vita_ocr import MODELS, UPSTREAM_REVISION, VitaOCRRuntime, _Extra, _Image, _Line
from GameSentenceMiner.ocr.vocr_line_finder import VOCRLineFinder
from GameSentenceMiner.ocr.vocr_onnx import ONNXLineFinder, ONNXRuntime, prepare_line


def samples(images, font):
    frames = []
    for path in images:
        with Image.open(path) as loaded:
            image = loaded.convert("RGB")
        frames.append((path.name, image, "real", hashlib.sha256(path.read_bytes()).hexdigest()))
    lines = [
        "今日はいい天気ですね。",
        "一緒に学校へ行きましょう。",
        "「本当に？　ありがとう！」",
        "彼女は静かに扉を開けた……。",
    ]
    for size in (18, 26, 38):
        for dark in (False, True):
            image = Image.new("RGB", (901, 220), "white" if dark else "black")
            draw = ImageDraw.Draw(image)
            loaded_font = ImageFont.truetype(str(font), size)
            for y, line in zip((8, 60, 112, 164), lines):
                draw.text((24, y), line, font=loaded_font, fill="black" if dark else "white")
            frames.append(
                (
                    f"synthetic-{size}-{'dark' if dark else 'light'}",
                    image,
                    "synthetic",
                    hashlib.sha256(image.tobytes()).hexdigest(),
                )
            )
    for color in ("black", "white"):
        image = Image.new("RGB", (960, 544), color)
        frames.append((f"empty-{color}", image, "empty", hashlib.sha256(image.tobytes()).hexdigest()))
    return frames


def native_best(runtime, image, dark):
    pixels = np.ascontiguousarray(image.convert("RGBA"), dtype=np.uint8)
    native = _Image(pixels.ctypes.data, image.width, image.height, pixels.strides[0], 4 | (0x100 if dark else 0))
    classes = (C.c_uint16 * 256)()
    extra = _Extra(best=C.cast(classes, C.c_void_p), cap_frames=256)
    output = C.create_string_buffer(4096)
    runtime._check(
        runtime.lib.vocr_run(runtime._context.ctypes.data, C.byref(native), output, len(output), C.byref(extra))
    )
    return np.ctypeslib.as_array(classes)[: extra.frames].copy()


def native_preprocess(runtime, image, dark):
    pixels = np.ascontiguousarray(image.convert("RGBA"), dtype=np.uint8)
    native = _Image(pixels.ctypes.data, image.width, image.height, pixels.strides[0], 4 | (0x100 if dark else 0))
    result = np.empty((32, 1024), dtype=np.uint8)
    width, padded = C.c_uint(), C.c_uint()
    function = runtime.lib.vocr_preprocess
    function.argtypes = [
        C.c_void_p,
        C.POINTER(_Image),
        C.c_void_p,
        C.c_size_t,
        C.POINTER(C.c_uint),
        C.POINTER(C.c_uint),
    ]
    function.restype = C.c_int
    runtime._check(
        function(
            runtime._model.ctypes.data,
            C.byref(native),
            result.ctypes.data,
            result.size,
            C.byref(width),
            C.byref(padded),
        )
    )
    return result.ravel()[: 32 * padded.value].reshape(32, padded.value)


def native_maps(finder, image):
    image = image.convert("RGBA")
    image.thumbnail((960, 544), Image.Resampling.LANCZOS)
    pixels = np.ascontiguousarray(image, dtype=np.uint8)
    native = _Image(pixels.ctypes.data, image.width, image.height, pixels.strides[0], 4)
    callback_type = C.CFUNCTYPE(None, C.c_void_p, C.c_uint, C.POINTER(C.c_int8), C.c_uint)
    rows = []

    @callback_type
    def row(_user, index, data, width):
        rows.append(np.ctypeslib.as_array(data, shape=(8 * width,)).copy().reshape(8, width))

    function = finder.lib.vocr_textspot6_maps
    function.argtypes = [C.c_void_p, C.POINTER(_Image), C.c_uint, C.c_void_p, C.c_size_t, callback_type, C.c_void_p]
    function.restype = C.c_int
    size = finder.lib.vocr_textspot6_frame_arena_bytes_flags(finder._model.ctypes.data, image.width, image.height, 4)
    arena = np.empty(size, np.uint8)
    status = function(finder._model.ctypes.data, C.byref(native), 4, arena.ctypes.data, size, row, None)
    if status:
        raise RuntimeError(f"Native maps failed: {status}")
    return np.stack(rows, axis=1), image


def measure(functions, items, repeats, warmup):
    timings = {name: [] for name in functions}
    for _ in range(warmup):
        for function in functions.values():
            for item in items:
                function(item)
    rng = random.Random(130)
    for repeat in range(repeats):
        order = list(functions)
        rng.shuffle(order)
        for name in order:
            measurements = []
            for item in items:
                started = time.perf_counter_ns()
                functions[name](item)
                measurements.append((time.perf_counter_ns() - started) / 1e6)
            timings[name].append(measurements)
    summary = {}
    baseline = statistics.median([statistics.mean(row) for row in timings["c"]])
    for name, rows in timings.items():
        means = [statistics.mean(row) for row in rows]
        median = statistics.median(means)
        summary[name] = {
            "mean_ms_per_item_median_across_repeats": median,
            "min_repeat_ms": min(means),
            "max_repeat_ms": max(means),
            "speedup_over_c": baseline / median,
        }
    return {"summary": summary, "timings_ms": timings, "items": len(items)}


def main(args):
    import onnxruntime as ort

    frames = samples(args.images, args.font)
    report = {
        "revision": UPSTREAM_REVISION,
        "platform": platform.platform(),
        "processor": platform.processor(),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "onnxruntime": ort.__version__,
        "provider": "CPUExecutionProvider",
        "threads": args.threads,
        "warmup_passes": args.warmup,
        "repeats": args.repeats,
        "c_build": "GSM shipped portable runtime; MSVC /O2 /fp:strict on Windows",
        "frames": [{"name": n, "size": im.size, "kind": k, "sha256": sha} for n, im, k, sha in frames],
        "detection": {},
        "recognition": {},
        "end_to_end": {},
        "agreement": {},
    }
    finder = VOCRLineFinder(args.models)
    if finder.kind != "spotter":
        raise RuntimeError(f"C baseline is using fallback: {finder.fallback_reason}")
    finders = {"c": finder, **{mode: ONNXLineFinder(args.onnx, mode=mode, threads=args.threads) for mode in args.modes}}
    crops = []
    detection_agreement = {mode: [] for mode in args.modes}
    for name, image, kind, _ in frames:
        boxes, _ = finder.detect(image)
        reference, scaled = native_maps(finder, image)
        for mode in args.modes:
            result, _ = finders[mode].detect(image)
            maps = finders[mode].detect_maps(scaled)
            detection_agreement[mode].append(
                {
                    "sample": name,
                    "boxes_equal": result == boxes,
                    "map_values": int(reference.size),
                    "map_mismatches": int(np.count_nonzero(reference != maps)),
                    "max_map_error": int(np.max(np.abs(reference.astype(np.int64) - maps))),
                    "c_boxes": boxes if result != boxes else None,
                    "onnx_boxes": result if result != boxes else None,
                }
            )
        for i, box in enumerate(boxes):
            if not box["vertical"]:
                crops.append((f"{name}:{i}", image.crop(box["box"]), box["dark"], kind))
    report["agreement"]["detection"] = detection_agreement
    report["detection"] = measure(
        {name: lambda image, f=f: f.detect(image) for name, f in finders.items()},
        [im for _, im, _, _ in frames],
        args.repeats,
        args.warmup,
    )
    print("Detection:", json.dumps(report["detection"]["summary"]), flush=True)
    report["crops"] = [{"name": n, "size": im.size, "dark": d, "kind": k} for n, im, d, k in crops]
    for tier in args.tiers:
        native = VitaOCRRuntime(args.models, model=tier)
        runtimes = {
            "c": native,
            **{mode: ONNXRuntime(args.onnx, model=tier, mode=mode, threads=args.threads) for mode in args.modes},
        }
        functions = {
            "c": lambda crop, runtime=native: runtime._recognize_line(
                np.ascontiguousarray(crop[1].convert("RGBA"), dtype=np.uint8),
                _Line(0, 0, crop[1].width, crop[1].height, int(crop[2])),
            )
        }
        functions.update(
            {mode: lambda crop, r=runtimes[mode]: r.recognize_line(crop[1], dark=crop[2])[0] for mode in args.modes}
        )
        agreement = {mode: [] for mode in args.modes}
        for crop in crops:
            name, im, dark, _ = crop
            baseline = functions["c"](crop)
            best = native_best(native, im, dark)
            prep = native_preprocess(native, im, dark)
            tensor, _ = prepare_line(im, dark=dark)
            if not np.array_equal(prep.astype(np.float32) / np.float32(127.5) - np.float32(1), tensor[0, 0]):
                raise AssertionError(f"Preprocessing mismatch on {name}")
            for mode in args.modes:
                result, onnx_best = runtimes[mode].recognize_line(im, dark=dark)
                agreement[mode].append(
                    {
                        "sample": name,
                        "text_equal": baseline["text"] == result["text"],
                        "characters_equal": baseline["characters"] == result["characters"],
                        "frames": len(best),
                        "frame_mismatches": int(np.count_nonzero(best != onnx_best)),
                        "c_text": baseline["text"],
                        "onnx_text": result["text"],
                    }
                )
        report["agreement"][tier] = agreement
        report["recognition"][tier] = measure(functions, crops, args.repeats, args.warmup)
        report["end_to_end"][tier] = measure(
            {name: lambda image, r=r: r.recognize(image) for name, r in runtimes.items()},
            [im for _, im, _, _ in frames],
            args.repeats,
            args.warmup,
        )
        report["agreement"][f"{tier}_end_to_end"] = {
            mode: [
                {"sample": n, "equal": native.recognize(im) == runtimes[mode].recognize(im)} for n, im, _, _ in frames
            ]
            for mode in args.modes
        }
        print(tier, "recognition:", json.dumps(report["recognition"][tier]["summary"]), flush=True)
        print(tier, "end-to-end:", json.dumps(report["end_to_end"][tier]["summary"]), flush=True)
        print(
            tier,
            "disagreements:",
            {mode: sum(not r["text_equal"] for r in rows) for mode, rows in agreement.items()},
            flush=True,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(args.output, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--onnx", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--images", type=Path, nargs="*", default=[])
    parser.add_argument("--font", type=Path, default=Path("C:/Windows/Fonts/msgothic.ttc"))
    parser.add_argument("--repeats", type=int, default=9)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--modes", nargs="+", choices=["fast", "faithful"], default=["fast", "faithful"])
    parser.add_argument("--tiers", nargs="+", choices=list(MODELS), default=list(MODELS))
    main(parser.parse_args())
