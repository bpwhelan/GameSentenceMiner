r"""Offline smoke benchmark for the experimental auto OCR-area learner.

Examples:
  .venv\Scripts\python.exe scripts\benchmark_auto_ocr_regions.py ^
    "C:\Users\Beangate\Videos\GSM\Output" --engine oneocr --max-frames 120

The report and learner state contain rectangles, hashes-derived confidence, and
timings only. Raw recognized text is never written to disk.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from collections import defaultdict
from pathlib import Path

from PIL import Image

from GameSentenceMiner.ocr.auto_regions import AutoRegionManager, LineObservation, NormalizedRect
from GameSentenceMiner.owocr.owocr.ocr import OneOCR, ScreenAIOCR
from GameSentenceMiner.util.gsm_utils import sanitize_filename

IMAGE_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".webp"}
VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"}
GAME_PREFIX = re.compile(r"^(?P<game>.+?)_\d{4}-")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path, help="Image/video files or directories")
    parser.add_argument("--engine", choices=("oneocr", "screenai"), default="oneocr")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--sample-seconds", type=float, default=2.0)
    parser.add_argument("--max-frames", type=int, default=120, help="Maximum sampled frames per game")
    parser.add_argument("--output", type=Path, default=Path(".auto-region-benchmark"))
    return parser.parse_args()


def _find_media(inputs: list[Path]) -> list[Path]:
    media = []
    for input_path in inputs:
        candidates = input_path.rglob("*") if input_path.is_dir() else (input_path,)
        media.extend(
            path for path in candidates if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
        )
    return sorted(set(media))


def _game_name(path: Path) -> str:
    match = GAME_PREFIX.match(path.stem)
    return match.group("game") if match else path.stem


def _iter_frames(path: Path, sample_seconds: float):
    if path.suffix.lower() in IMAGE_EXTENSIONS:
        with Image.open(path) as image:
            yield image.convert("RGB")
        return

    try:
        import cv2
    except ImportError as exc:
        raise RuntimeError("OpenCV is required to sample video files") from exc

    capture = cv2.VideoCapture(str(path))
    try:
        fps = max(1.0, float(capture.get(cv2.CAP_PROP_FPS) or 1.0))
        step = max(1, round(fps * max(0.1, sample_seconds)))
        frame_index = 0
        while capture.isOpened():
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ok, frame = capture.read()
            if not ok:
                break
            yield Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            frame_index += step
    finally:
        capture.release()


def _line_observations(result, width: int, height: int) -> list[LineObservation]:
    if not isinstance(result, tuple) or len(result) < 4 or result[0] is not True:
        return []
    observations = []
    for entry in result[3] or []:
        if not isinstance(entry, (list, tuple)) or len(entry) < 5:
            continue
        try:
            x1, y1, x2, y2 = (float(entry[index]) for index in range(4))
        except (TypeError, ValueError):
            continue
        padding = 5.0
        observations.append(
            LineObservation(
                str(entry[4]),
                NormalizedRect.from_xyxy(
                    (x1 + padding) / width,
                    (y1 + padding) / height,
                    (x2 - padding) / width,
                    (y2 - padding) / height,
                ),
            )
        )
    return observations


def main() -> int:
    args = _parse_args()
    media_by_game = defaultdict(list)
    for path in _find_media(args.inputs):
        media_by_game[_game_name(path)].append(path)
    if not media_by_game:
        raise SystemExit("No supported image or video files were found (audio-only .opus files are ignored).")

    args.output.mkdir(parents=True, exist_ok=True)
    engine = (
        OneOCR(lang=args.language, get_furigana_sens_from_file=False)
        if args.engine == "oneocr"
        else ScreenAIOCR(lang=args.language)
    )
    if not engine.available:
        raise SystemExit(f"{args.engine} is not available in this environment")

    report = {"engine": args.engine, "language": args.language, "games": {}}
    for game, media_paths in sorted(media_by_game.items()):
        manager = None
        timings = []
        sampled = 0
        observed_lines = 0
        state_path = args.output / f"{sanitize_filename(game)}_auto_regions.json"
        for media_path in media_paths:
            for image in _iter_frames(media_path, args.sample_seconds):
                if sampled >= args.max_frames:
                    break
                if manager is None:
                    manager = AutoRegionManager(
                        game,
                        args.language,
                        state_path,
                        aspect_ratio=image.width / image.height,
                    )
                started = time.perf_counter()
                result = engine(image, furigana_filter_sensitivity=0)
                timings.append((time.perf_counter() - started) * 1000)
                observations = _line_observations(result, image.width, image.height)
                observed_lines += len(observations)
                sampled += 1
                manager.observe(observations, frame_id=sampled, discovery=True)
            if sampled >= args.max_frames:
                break

        if manager is None:
            continue
        manager.save()
        report["games"][game] = {
            "files": len(media_paths),
            "frames": sampled,
            "observed_lines": observed_lines,
            "average_ocr_ms": round(sum(timings) / len(timings), 2) if timings else 0.0,
            "phase": manager.phase,
            "confidence": manager.confidence,
            "regions": [region.to_list() for region in manager.learned_regions],
        }

    report_path = args.output / "report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"Report written to {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
