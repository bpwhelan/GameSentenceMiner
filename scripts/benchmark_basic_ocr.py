"""Compare local basic-mode candidates against saved OCR text, without online scans.

Saved text is a reference, not ground truth. Engines run in separate, sequential
processes; image loading, model initialization and warmup are outside scan timings.
The Meiki reuse experiment uses its public recognition-only API on detected lines.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import subprocess
import sys
import time
import unicodedata
from collections import Counter
from pathlib import Path

import regex
from PIL import Image
from rapidfuzz.distance import Levenshtein

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scripts.benchmark_stability_ocr import (
    _current_rss,
    _initialize_engine,
    hardware_metadata,
    load_samples,
    select_stratified_samples,
    summarize_values,
)


def normalized_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("BLANK_LINE", "")
    return regex.sub(r"[\p{P}\p{Z}\p{C}\s]+", "", text)


class RecognitionOnly:
    """Experimental Meiki adapter; no detection or model monkeypatching upstream."""

    def __init__(self, model):
        self.model = model
        self.boxes = []

    def run_ocr(self, image, **kwargs):
        crops, offsets = [], []
        height, width = image.shape[:2]
        for detection in self.boxes:
            x1, y1, x2, y2 = (int(v) for v in detection["box"])
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(width, x2), min(height, y2)
            if x2 > x1 and y2 > y1:
                crops.append(image[y1:y2, x1:x2])
                offsets.append((x1, y1))
        results = self.model.run_recognition(crops, punct_conf_factor=kwargs.get("punct_conf_factor", 0.2))
        for result, (dx, dy) in zip(results, offsets, strict=True):
            for char in result["chars"]:
                x1, y1, x2, y2 = char["bbox"]
                char["bbox"] = [x1 + dx, y1 + dy, x2 + dx, y2 + dy]
        return results


def summarize(rows: list[dict]) -> dict:
    successful = [row for row in rows if row["success"]]
    reference_chars = sum(row["reference_chars"] for row in rows)
    return {
        "samples": len(rows),
        "successes": len(successful),
        "empty_outputs": sum(not row["normalized_text"] for row in rows),
        "latency_ms": summarize_values([row["latency_ms"] for row in rows]),
        "detection_ms": summarize_values([row["detection_ms"] for row in rows]),
        "recognition_ms": summarize_values([row["recognition_ms"] for row in rows]),
        "reference_chars": reference_chars,
        "reference_character_error_rate": sum(row["edit_distance"] for row in rows) / max(1, reference_chars),
        "exact_reference_matches": sum(row["edit_distance"] == 0 for row in rows),
        "mean_character_bag_recall": statistics.mean(row["character_bag_recall"] for row in rows),
    }


def worker(args):
    from GameSentenceMiner.ocr import SharedMeikiOCRModel
    from GameSentenceMiner.util.config import electron_config

    # Keep benchmark language and furigana filtering fixed without saving settings.
    electron_config.get_ocr_language = lambda: args.language
    SharedMeikiOCRModel._detect_device = classmethod(lambda cls, force_cpu=False: "cpu")
    started = time.perf_counter()
    engine = _initialize_engine("meikiocr" if args.worker == "meiki_reuse" else args.worker)
    engine.get_furigana_sens_from_file = False
    detector = None
    if args.worker == "meiki_reuse":
        detector = _initialize_engine("meiki_text_detector")
        engine.model = RecognitionOnly(engine.model)
    initialization_ms = (time.perf_counter() - started) * 1000
    rows = []
    manifest = json.loads((args.output_dir / "manifest.json").read_text(encoding="utf-8"))

    def scan(image):
        started = time.perf_counter()
        detection_ms = 0.0
        if detector is not None:
            detections = detector(image)
            if not detections[0]:
                raise RuntimeError(detections[1])
            engine.model.boxes = detections[5]["boxes"]
            detection_ms = (time.perf_counter() - started) * 1000
        result = engine(image, 0)
        latency_ms = (time.perf_counter() - started) * 1000
        return result, latency_ms, detection_ms

    for sample in manifest[:5]:
        with Image.open(sample["image_path"]) as image:
            scan(image.convert("RGB"))
    output_path = args.output_dir / f"{args.worker}.jsonl"
    with output_path.open("w", encoding="utf-8") as output:
        for index, sample in enumerate(manifest):
            with Image.open(sample["image_path"]) as image:
                image = image.convert("RGB")
            started = time.perf_counter()
            try:
                result, latency_ms, detection_ms = scan(image)
                success, text = bool(result[0]), str(result[1] or "")
                error = "" if success else text
                if not success:
                    text = ""
            except Exception as exc:  # noqa: BLE001 -- Record engine failures without losing the rest of the corpus.
                success, text, error = False, "", str(exc)
                latency_ms, detection_ms = (time.perf_counter() - started) * 1000, 0.0
            reference = normalized_text(sample["reference"])
            prediction = normalized_text(text)
            overlap = sum((Counter(reference) & Counter(prediction)).values())
            row = {
                "sample_id": sample["sample_id"],
                "success": success,
                "error": error,
                "text": text,
                "normalized_text": prediction,
                "latency_ms": latency_ms,
                "detection_ms": detection_ms,
                "recognition_ms": latency_ms - detection_ms,
                "reference_chars": len(reference),
                "edit_distance": Levenshtein.distance(reference, prediction),
                "character_bag_recall": overlap / max(1, len(reference)),
            }
            rows.append(row)
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
            output.flush()
            if (index + 1) % 100 == 0:
                print(f"{args.worker}: {index + 1}/{len(manifest)}", flush=True)
    summary = summarize(rows)
    summary.update(initialization_ms=initialization_ms, rss_bytes=_current_rss())
    (args.output_dir / f"{args.worker}_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({args.worker: summary}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--max-samples", type=int, default=750, help="0 uses all samples")
    parser.add_argument("--engines", default="screenai,oneocr,meikiocr,meiki_reuse")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--worker", default="", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        worker(args)
        return
    args.output_dir.mkdir(parents=True, exist_ok=True)
    samples = select_stratified_samples(load_samples(args.input_dir), args.max_samples)
    for sample in samples:
        metadata = json.loads(Path(sample["metadata_path"]).read_text(encoding="utf-8"))
        sample["reference"] = metadata.get("raw_text") or metadata.get("flattened_text") or ""
        sample["reference_engine"] = metadata.get("pipeline", {}).get("engine", "unknown")
        sample["sha256"] = hashlib.sha256(Path(sample["image_path"]).read_bytes()).hexdigest()
    (args.output_dir / "manifest.json").write_text(json.dumps(samples, ensure_ascii=False, indent=2), encoding="utf-8")
    metadata = hardware_metadata()
    metadata.update(
        language=args.language, provider="CPU", reference_engines=dict(Counter(s["reference_engine"] for s in samples))
    )
    (args.output_dir / "environment.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    for engine in args.engines.split(","):
        with (args.output_dir / f"{engine}.log").open("w", encoding="utf-8") as log:
            command = [
                sys.executable,
                str(Path(__file__).resolve()),
                "--worker",
                engine,
                "--output-dir",
                str(args.output_dir),
                "--language",
                args.language,
            ]
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=7200, check=False)
        print(f"{engine}: exit {result.returncode}", flush=True)
        if result.returncode:
            raise RuntimeError(f"{engine} failed; see {engine}.log")


if __name__ == "__main__":
    main()
