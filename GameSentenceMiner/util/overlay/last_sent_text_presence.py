"""Cheap visual presence signatures for rendered overlay text."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

MAX_REFERENCE_WIDTH = 640
MAX_REFERENCE_HEIGHT = 256


def _to_gray_array(image: Any) -> np.ndarray | None:
    if image is None:
        return None
    try:
        pixels = np.asarray(image if isinstance(image, np.ndarray) else image.convert("L"))
    except (AttributeError, OSError, TypeError, ValueError):
        return None
    if pixels.ndim == 3:
        if pixels.shape[2] == 4:
            pixels = cv2.cvtColor(pixels, cv2.COLOR_RGBA2GRAY)
        else:
            pixels = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
    if pixels.ndim != 2 or pixels.size == 0:
        return None
    return np.ascontiguousarray(pixels.astype(np.uint8, copy=False))


def _crop_gray_array(
    image: Any,
    frame_size: tuple[int, int],
    crop_box: tuple[int, int, int, int],
) -> np.ndarray | None:
    """Crop before conversion so each comparison never processes a full frame."""
    x1, y1, x2, y2 = crop_box
    if isinstance(image, np.ndarray):
        if image.ndim not in (2, 3) or (image.shape[1], image.shape[0]) != frame_size:
            return None
        return _to_gray_array(image[y1:y2, x1:x2])
    try:
        if tuple(image.size) != frame_size:
            return None
        return _to_gray_array(image.crop(crop_box))
    except (AttributeError, OSError, TypeError, ValueError):
        return None


def _rect_bounds(rect: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(rect, dict):
        return None
    try:
        xs = [float(rect[key]) for key in ("x1", "x2", "x3", "x4")]
        ys = [float(rect[key]) for key in ("y1", "y2", "y3", "y4")]
    except (KeyError, TypeError, ValueError):
        return None
    if not all(np.isfinite(value) for value in (*xs, *ys)):
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _payload_crop_box(payload: Any, width: int, height: int) -> tuple[int, int, int, int] | None:
    if not isinstance(payload, dict):
        return None

    bounds = [
        bound
        for line in payload.get("line_coords", []) or []
        if isinstance(line, dict)
        for bound in [_rect_bounds(line.get("bounding_rect"))]
        if bound is not None
    ]
    if not bounds:
        return None
    raw_box = (
        min(bound[0] for bound in bounds) - 1,
        min(bound[1] for bound in bounds) - 1,
        max(bound[2] for bound in bounds) + 1,
        max(bound[3] for bound in bounds) + 1,
    )

    x1, y1, x2, y2 = (round(raw_box[index]) for index in range(4))
    x1 = min(max(0, x1), width)
    y1 = min(max(0, y1), height)
    x2 = min(max(x1, x2), width)
    y2 = min(max(y1, y2), height)
    if x2 - x1 < 3 or y2 - y1 < 3:
        return None
    return x1, y1, x2, y2


def _fit_reference_size(width: int, height: int) -> tuple[int, int]:
    scale = min(1.0, MAX_REFERENCE_WIDTH / width, MAX_REFERENCE_HEIGHT / height)
    return max(3, round(width * scale)), max(3, round(height * scale))


def _resize(gray: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    if (gray.shape[1], gray.shape[0]) == size:
        return gray
    return cv2.resize(gray, size, interpolation=cv2.INTER_AREA)


def _contrast_masks(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    blurred = cv2.GaussianBlur(gray, (0, 0), 2.0)
    detail = gray.astype(np.int16) - blurred.astype(np.int16)
    absolute_detail = np.abs(detail)
    threshold = max(10.0, float(np.percentile(absolute_detail, 88)))
    bright = (detail >= threshold).astype(np.uint8)
    dark = (detail <= -threshold).astype(np.uint8)
    return bright, dark


def _edge_mask(gray: np.ndarray) -> np.ndarray:
    median = float(np.median(gray))
    lower = max(12, int(0.55 * median))
    upper = max(lower + 1, min(255, int(1.45 * median) + 20))
    return (cv2.Canny(gray, lower, upper, L2gradient=True) > 0).astype(np.uint8)


def _tolerant_f1(reference: np.ndarray, current: np.ndarray) -> float:
    reference_count = int(reference.sum())
    current_count = int(current.sum())
    if reference_count == 0 or current_count == 0:
        return 0.0
    kernel = np.ones((3, 3), dtype=np.uint8)
    current_dilated = cv2.dilate(current, kernel, iterations=1)
    reference_dilated = cv2.dilate(reference, kernel, iterations=1)
    recall = float(np.logical_and(reference > 0, current_dilated > 0).sum()) / reference_count
    precision = float(np.logical_and(current > 0, reference_dilated > 0).sum()) / current_count
    if recall + precision <= 0:
        return 0.0
    return (2.0 * recall * precision) / (recall + precision)


@dataclass(frozen=True)
class _ReferenceSignature:
    size: tuple[int, int]
    bright_mask: np.ndarray
    dark_mask: np.ndarray
    edge_mask: np.ndarray

    @classmethod
    def from_gray(cls, gray: np.ndarray) -> _ReferenceSignature:
        size = _fit_reference_size(gray.shape[1], gray.shape[0])
        prepared = _resize(gray, size)
        bright, dark = _contrast_masks(prepared)
        return cls(size=size, bright_mask=bright, dark_mask=dark, edge_mask=_edge_mask(prepared))

    def similarity(self, gray: np.ndarray) -> float:
        prepared = _resize(gray, self.size)
        bright, dark = _contrast_masks(prepared)
        contrast_score = max(
            _tolerant_f1(self.bright_mask, bright),
            _tolerant_f1(self.dark_mask, dark),
        )
        edge_score = _tolerant_f1(self.edge_mask, _edge_mask(prepared))
        return max(contrast_score, (0.75 * contrast_score) + (0.25 * edge_score))


@dataclass(frozen=True)
class PresenceCandidate:
    presence_id: str
    frame_size: tuple[int, int]
    crop_box: tuple[int, int, int, int]
    signature: _ReferenceSignature

    def similarity(self, image: Any) -> float | None:
        gray = _crop_gray_array(image, self.frame_size, self.crop_box)
        if gray is None:
            return None
        return self.signature.similarity(gray)


@dataclass(frozen=True)
class PresenceInvalidation:
    presence_id: str
    similarity: float


def prepare_presence_candidate(
    image: Any,
    payload: Any,
    *,
    presence_id: str | None = None,
) -> PresenceCandidate | None:
    gray = _to_gray_array(image)
    if gray is None:
        return None
    frame_size = (gray.shape[1], gray.shape[0])
    crop_box = _payload_crop_box(payload, *frame_size)
    if crop_box is None:
        return None
    x1, y1, x2, y2 = crop_box
    return PresenceCandidate(
        presence_id=str(presence_id or uuid.uuid4().hex),
        frame_size=frame_size,
        crop_box=crop_box,
        signature=_ReferenceSignature.from_gray(gray[y1:y2, x1:x2]),
    )


class LastSentTextPresenceTracker:
    def __init__(self, *, similarity_threshold: float = 0.65, required_misses: int = 2):
        self.similarity_threshold = float(similarity_threshold)
        self.required_misses = max(1, int(required_misses))
        self._active: PresenceCandidate | None = None
        self._misses = 0
        self._lock = threading.Lock()

    @property
    def has_active_reference(self) -> bool:
        with self._lock:
            return self._active is not None

    def activate(self, candidate: PresenceCandidate | None) -> None:
        with self._lock:
            self._active = candidate
            self._misses = 0

    def clear(self) -> None:
        self.activate(None)

    def observe(self, image: Any, *, enabled: bool) -> PresenceInvalidation | None:
        with self._lock:
            if not enabled:
                self._active = None
                self._misses = 0
                return None
            candidate = self._active
            if candidate is None:
                return None
            similarity = candidate.similarity(image)
            if similarity is None:
                self._active = None
                self._misses = 0
                return None
            if similarity >= self.similarity_threshold:
                self._misses = 0
                return None
            self._misses += 1
            if self._misses < self.required_misses:
                return None
            self._active = None
            self._misses = 0
            return PresenceInvalidation(candidate.presence_id, similarity)
