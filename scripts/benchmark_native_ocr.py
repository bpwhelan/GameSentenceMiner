"""Python half of the equal-input, real WGC capture benchmark."""

import json
import os
import sys
import time
from pathlib import Path

from GameSentenceMiner.obs.screenshot_capture import _capture_hwnd_windows_graphics_capture, stop_wgc_sessions
from GameSentenceMiner.owocr.owocr.ocr import Bing, OneOCR, ScreenAIOCR


def main():
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cold = time.perf_counter()
    cold_cpu = time.process_time()
    engine = (
        Bing(lang="ja")
        if config["engine"] == "bing"
        else (
            ScreenAIOCR(lang="ja")
            if config["engine"] == "screenai"
            else OneOCR(lang="ja", get_furigana_sens_from_file=False)
        )
    )
    if not engine.available:
        raise RuntimeError(f"{config['engine']} is unavailable")
    samples = []
    wall = time.perf_counter()
    cpu = time.process_time()
    try:
        for sample in range(config.get("samples", 20) + 1):
            start = time.perf_counter()
            before = time.process_time()
            image = _capture_hwnd_windows_graphics_capture(config["target_id"])
            if image is None:
                raise RuntimeError("WGC capture failed")
            captured = (time.perf_counter() - start) * 1000
            image_size = image.size
            rectangles = config.get("areas", {}).get("rectangles", [])
            if rectangles:
                x, y, w, h = rectangles[0]["coordinates"]
                original = image
                image = image.crop((x, y, x + w, y + h))
                original.close()
            result = (
                engine(image, furigana_filter_sensitivity=0)
                if config["engine"] == "bing"
                else engine(image, furigana_filter_sensitivity=0, language="ja")
            )
            if not result[0]:
                raise RuntimeError(str(result))
            if not str(result[1]).strip():
                raise RuntimeError("OCR returned no text for the Japanese game fixture")
            entry = {
                "capture_ms": captured,
                "total_ms": (time.perf_counter() - start) * 1000,
                "cpu_ms": (time.process_time() - before) * 1000,
                "text": result[1],
                "image_size": image_size,
                "ocr_size": image.size,
            }
            image.close()
            if sample == 0:
                print(
                    "OCRBENCH_COLD",
                    json.dumps(
                        {
                            "wall_ms": (time.perf_counter() - cold) * 1000,
                            "cpu_ms": (time.process_time() - cold_cpu) * 1000,
                            "sample": entry,
                        },
                        ensure_ascii=False,
                    ),
                )
                wall = time.perf_counter()
                cpu = time.process_time()
            else:
                samples.append(entry)
            time.sleep(0.5)
        elapsed = time.perf_counter() - wall
        used = time.process_time() - cpu
        report = {
            "runtime": "python",
            "engine": config["engine"],
            "samples": samples,
            "wall_seconds": elapsed,
            "cpu_seconds": used,
            "one_core_percent": used / elapsed * 100,
            "logical_cpus": os.cpu_count(),
            "total_machine_percent": used / elapsed * 100 / os.cpu_count(),
        }
        Path(config["result"]).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    finally:
        stop_wgc_sessions()


if __name__ == "__main__":
    main()
