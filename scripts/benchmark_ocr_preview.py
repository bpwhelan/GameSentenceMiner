"""Compare preview CPU with a repeatable in-memory OBS JPEG (no live capture).

Run with .venv/Scripts/python.exe scripts/benchmark_ocr_preview.py [baseline_preview.py].
This measures the capture response's image handling, excluding OBS/network latency.
"""

from __future__ import annotations

import importlib.util
import io
import statistics
import sys
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from GameSentenceMiner import obs
from GameSentenceMiner.ocr import preview


def benchmark(module, encoded: bytes, rounds: int = 120) -> dict:
    timings = []
    for _ in range(5):
        started = time.process_time()
        for _ in range(rounds):
            frame = module.capture_preview({"sceneId": "scene", "sceneName": "Benchmark"})
            assert frame and (frame["width"], frame["height"]) == (960, 540)
        timings.append((time.process_time() - started) * 1000 / rounds)
    return {"median_cpu_ms_per_capture": statistics.median(timings), "jpeg_bytes": len(encoded), "rounds": rounds * 5}


def main():
    import json

    with Image.effect_noise((960, 540), 40).convert("RGB") as image, io.BytesIO() as stream:
        image.save(stream, format="JPEG", quality=70)
        encoded = stream.getvalue()
    originals = {
        name: getattr(obs, name) for name in ("get_current_scene", "get_source_from_scene", "get_screenshot_PIL")
    }
    try:
        obs.get_current_scene = lambda: "Benchmark"
        obs.get_source_from_scene = lambda _: {"sourceName": "Synthetic"}
        obs.get_screenshot_PIL = lambda **_: Image.open(io.BytesIO(encoded))
        result = {}
        if len(sys.argv) > 1:
            spec = importlib.util.spec_from_file_location("preview_baseline", sys.argv[1])
            baseline = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(baseline)
            result["baseline"] = benchmark(baseline, encoded)
        result["current"] = benchmark(preview, encoded)
        print(json.dumps(result, indent=2))
    finally:
        for name, value in originals.items():
            setattr(obs, name, value)


if __name__ == "__main__":
    main()
