"""Automatic local OCR focus for the overlay's adaptive scans."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from rapidfuzz import fuzz

from GameSentenceMiner.util.text_log import normalize_text_for_comparison

CropBox = tuple[int, int, int, int]


def _line_bounds(line: dict, image_size: tuple[int, int], *, anchor: bool = True) -> CropBox | None:
    rect = line.get("bounding_rect")
    if not isinstance(rect, dict):
        return None
    try:
        xs = [float(rect[f"x{index}"]) for index in range(1, 5)]
        ys = [float(rect[f"y{index}"]) for index in range(1, 5)]
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in xs + ys):
        return None
    width, height = image_size
    box = (
        max(0, math.floor(min(xs))),
        max(0, math.floor(min(ys))),
        min(width, math.ceil(max(xs))),
        min(height, math.ceil(max(ys))),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    # A detector box spanning much of the frame is not a useful text anchor.
    if anchor and box[3] - box[1] > height * 0.25:
        return None
    return box


def _normalized(text: Any) -> str:
    return normalize_text_for_comparison(str(text or ""))


def _close_lines(a: CropBox, b: CropBox, frame_width: int) -> bool:
    x_gap = max(0, max(a[0], b[0]) - min(a[2], b[2]))
    y_gap = max(0, max(a[1], b[1]) - min(a[3], b[3]))
    return x_gap <= max(30, frame_width * 0.04) and y_gap <= max(24, max(a[3] - a[1], b[3] - b[1]) * 1.2)


def _expanded_box(box: CropBox, image_size: tuple[int, int]) -> CropBox | None:
    width, height = image_size
    x1, y1, x2, y2 = box
    pad_x = max(48, width * 0.06)
    pad_y = max(36, height * 0.045)
    crop_width = min(width, math.ceil(max(x2 - x1 + 2 * pad_x, width * 0.90)))
    crop_height = min(height, math.ceil(max(y2 - y1 + 2 * pad_y, height * 0.30)))
    left = max(0, min(width - crop_width, math.floor((x1 + x2 - crop_width) / 2)))
    top = max(0, min(height - crop_height, math.floor((y1 + y2 - crop_height) / 2)))
    if crop_width * crop_height >= width * height * 0.80:
        return None
    return left, top, left + crop_width, top + crop_height


def shift_ocr_boxes(lines: list[dict], offset_x: int, offset_y: int) -> None:
    """Move local OCR line and word quadrilaterals into the full image."""
    for line in lines:
        for item in [line, *(line.get("words") or [])]:
            rect = item.get("bounding_rect")
            if not isinstance(rect, dict):
                continue
            for key, value in rect.items():
                if isinstance(value, (int, float)) and key[:1] in ("x", "y"):
                    rect[key] = value + (offset_x if key.startswith("x") else offset_y)


@dataclass
class AdaptiveOverlayCrop:
    """Track one dialogue region, with frequent full-frame reacquisition."""

    FULL_REFRESH_SECONDS = 3.0

    box: CropBox | None = None
    frame_key: Any = None
    last_full_scan_at: float | None = None

    def clear(self) -> None:
        self.box = None
        self.last_full_scan_at = None

    def region_for_frame(self, image_size: tuple[int, int], frame_key: Any, now: float) -> CropBox | None:
        if frame_key != self.frame_key:
            self.clear()
            self.frame_key = frame_key
        if self.box is None or self.last_full_scan_at is None:
            return None
        if now - self.last_full_scan_at >= self.FULL_REFRESH_SECONDS:
            return None
        x1, y1, x2, y2 = self.box
        if x1 < 0 or y1 < 0 or x2 > image_size[0] or y2 > image_size[1]:
            self.clear()
            return None
        return self.box

    @staticmethod
    def needs_full_scan(
        lines: list[dict], reference: str | None, crop_box: CropBox, image_size: tuple[int, int] | None = None
    ) -> bool:
        crop_size = (crop_box[2] - crop_box[0], crop_box[3] - crop_box[1])
        candidates = [
            (line, bounds)
            for line in lines
            if isinstance(line, dict) and (bounds := _line_bounds(line, crop_size, anchor=False)) is not None
        ]
        if not candidates:
            return True
        reference_text = _normalized(reference)
        if reference_text and not any(
            len(text := _normalized(line.get("text"))) >= 2 and fuzz.partial_ratio(text, reference_text) >= 90
            for line, _ in candidates
        ):
            return True
        # A line clipped at an interior focus edge may still produce plausible OCR text.
        full_width, full_height = image_size or (math.inf, math.inf)
        return any(
            (crop_box[0] > 0 and box[0] <= 12)
            or (crop_box[1] > 0 and box[1] <= 12)
            or (crop_box[2] < full_width and box[2] >= crop_size[0] - 12)
            or (crop_box[3] < full_height and box[3] >= crop_size[1] - 12)
            for _, box in candidates
        )

    def observe(
        self,
        lines: list[dict],
        image_size: tuple[int, int],
        reference: str | None,
        now: float,
        *,
        full_scan: bool,
    ) -> None:
        if full_scan:
            self.last_full_scan_at = now
        candidates = [
            (line, bounds, _normalized(line.get("text")))
            for line in lines
            if isinstance(line, dict) and (bounds := _line_bounds(line, image_size)) is not None
        ]
        candidates = [candidate for candidate in candidates if len(candidate[2]) >= 2]
        if not candidates:
            if full_scan:
                self.box = None
            return

        clusters = []
        remaining = candidates[:]
        while remaining:
            cluster = [remaining.pop(0)]
            while remaining:
                adjacent = [
                    candidate
                    for candidate in remaining
                    if any(_close_lines(candidate[1], member[1], image_size[0]) for member in cluster)
                ]
                if not adjacent:
                    break
                cluster.extend(adjacent)
                remaining = [candidate for candidate in remaining if candidate not in adjacent]
            clusters.append(cluster)

        reference_text = _normalized(reference)

        def cluster_score(cluster):
            character_count = sum(len(candidate[2]) for candidate in cluster)
            if not reference_text:
                return 0, character_count, len(cluster)
            ordered = sorted(cluster, key=lambda candidate: (candidate[1][1], candidate[1][0]))
            joined_text = "".join(candidate[2] for candidate in ordered)
            match = max(
                [fuzz.partial_ratio(joined_text, reference_text)]
                + [fuzz.partial_ratio(candidate[2], reference_text) for candidate in cluster]
            )
            return (match if match >= 65 else 0), character_count, len(cluster)

        cluster = max(clusters, key=cluster_score)

        bounds = (
            min(candidate[1][0] for candidate in cluster),
            min(candidate[1][1] for candidate in cluster),
            max(candidate[1][2] for candidate in cluster),
            max(candidate[1][3] for candidate in cluster),
        )
        self.box = _expanded_box(bounds, image_size)
