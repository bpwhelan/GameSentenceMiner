"""Measure the installed Lens OCR path using a generated, repeatable test image."""

import argparse
import time
from importlib.metadata import PackageNotFoundError, version
from statistics import median
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont

from GameSentenceMiner.owocr.owocr import ocr

TEST_TEXT = "GSM Lens latency test 123"


def _milliseconds(value):
    return f"{value:.1f}" if isinstance(value, (int, float)) else "-"


def run_latency_test(runs=6):
    try:
        gsm_version = version("GameSentenceMiner")
    except PackageNotFoundError:
        gsm_version = "source checkout"
    print(f"GSM {gsm_version} | curl_cffi {ocr.curl_cffi.__version__}", flush=True)
    print(f"Generated 960x240 text image; sending {runs} OCR requests to Google Lens.", flush=True)
    print("Times are milliseconds. New=0 means no new connection was needed.", flush=True)
    metrics = {}

    def collect_metrics(enabled, event, **fields):
        if enabled and event == "google_lens.request":
            metrics.update(fields)

    elapsed_times = []
    reused = 0
    matched = 0
    # These overrides affect only this diagnostic process. They neither enable
    # debug logging in the user's settings nor write diagnostic events to disk.
    with (
        patch.object(ocr, "get_ocr_advanced_debug_logging", return_value=True),
        patch.object(ocr, "emit_ocr_debug", collect_metrics),
        Image.new("RGB", (960, 240), "white") as image,
    ):
        ImageDraw.Draw(image).text((30, 80), TEST_TEXT, font=ImageFont.load_default(size=48), fill="black")
        engine = ocr.GoogleLens(lang=ocr.get_ocr_language(), get_furigana_sens_from_file=False)
        try:
            if not engine.available:
                print("Google Lens is unavailable. Repair or update the GSM Python environment.", flush=True)
                return 1
            print("Run  Total ms  Request ms  TLS end ms  First byte ms  New  HTTP  OCR", flush=True)
            for index in range(runs):
                if index:
                    time.sleep(0.5)
                metrics.clear()
                started = time.perf_counter()
                result = engine(image)
                elapsed = (time.perf_counter() - started) * 1000
                success = bool(result[0])
                text_matches = success and "".join(result[1].split()) == "".join(TEST_TEXT.split())
                print(
                    f"{index + 1:>3}  {elapsed:>8.1f}  "
                    f"{_milliseconds(metrics.get('request_ms')):>10}  "
                    f"{_milliseconds(metrics.get('tls_finished_ms')):>10}  "
                    f"{_milliseconds(metrics.get('first_byte_ms')):>13}  "
                    f"{metrics.get('new_connections', '-')!s:>3}  "
                    f"{metrics.get('status_code', '-')!s:>4}  "
                    f"{'OK' if text_matches else 'different' if success else 'failed'}",
                    flush=True,
                )
                if not success:
                    print(f"Stopped after request {index + 1}: {result[1]}", flush=True)
                    return 1
                elapsed_times.append(elapsed)
                matched += int(text_matches)
                if index and metrics.get("new_connections") == 0:
                    reused += 1
        finally:
            engine.close()

    print(f"PNG upload: {metrics.get('image_bytes', '?')} bytes.")
    print(f"First request: {elapsed_times[0]:.1f} ms.")
    repeats = elapsed_times[1:]
    print(f"Subsequent median: {median(repeats):.1f} ms (range {min(repeats):.1f}-{max(repeats):.1f} ms).")
    print(f"{reused}/{len(repeats)} repeat requests reused a connection; {matched}/{runs} OCR text checks passed.")
    print("Share this output with your country and whether a VPN or proxy was active.")
    return 0 if matched == runs else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=6, help="Number of Lens requests, from 2 to 20 (default: 6).")
    args = parser.parse_args(argv)
    if not 2 <= args.runs <= 20:
        parser.error("--runs must be between 2 and 20")
    try:
        return run_latency_test(args.runs)
    except KeyboardInterrupt:
        print("\nLatency test interrupted.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
