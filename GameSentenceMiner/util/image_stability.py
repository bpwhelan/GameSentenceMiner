"""Small image-signature helpers for avoiding redundant OCR work."""

from __future__ import annotations

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
    """Crop before conversion so comparisons do not process a full frame."""
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


def _normalize_crop_box(raw_box: Any, width: int, height: int) -> tuple[int, int, int, int] | None:
    if not isinstance(raw_box, (list, tuple)) or len(raw_box) < 4:
        return None
    try:
        x1, y1, x2, y2 = (round(float(raw_box[index])) for index in range(4))
    except (TypeError, ValueError):
        return None
    x1 = min(max(0, x1), width)
    y1 = min(max(0, y1), height)
    x2 = min(max(x1, x2), width)
    y2 = min(max(y1, y2), height)
    if x2 - x1 < 3 or y2 - y1 < 3:
        return None
    return x1, y1, x2, y2


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
    if bounds:
        raw_box = (
            min(bound[0] for bound in bounds) - 1,
            min(bound[1] for bound in bounds) - 1,
            max(bound[2] for bound in bounds) + 1,
            max(bound[3] for bound in bounds) + 1,
        )
    else:
        pipeline = payload.get("pipeline") if isinstance(payload.get("pipeline"), dict) else {}
        ocr_metadata = pipeline.get("ocr") if isinstance(pipeline.get("ocr"), dict) else {}
        raw_box = payload.get("crop_coords") or ocr_metadata.get("crop_coords")

    return _normalize_crop_box(raw_box, width, height)


def _fit_reference_size(width: int, height: int) -> tuple[int, int]:
    scale = min(1.0, MAX_REFERENCE_WIDTH / width, MAX_REFERENCE_HEIGHT / height)
    return max(3, round(width * scale)), max(3, round(height * scale))


def _resize(gray: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    if (gray.shape[1], gray.shape[0]) == size:
        return gray
    return cv2.resize(gray, size, interpolation=cv2.INTER_AREA)


def _uint8_percentile(pixels: np.ndarray, percentile: float) -> float:
    """Exact linear percentile of bounded 8-bit images, without sorting pixels."""
    if pixels.dtype != np.uint8 or pixels.ndim != 2 or not 0 < pixels.size <= 2**24:
        return float(np.percentile(pixels, percentile))
    # OpenCV's float32 histogram counts are exact up to 2**24 pixels. OCR
    # signatures have at most 640*256; larger/unusual inputs use numpy above.
    counts = cv2.calcHist([pixels], [0], None, [256], [0, 256]).ravel()
    cumulative = np.cumsum(counts, dtype=np.int64)
    index = (pixels.size - 1) * (percentile / 100.0)
    lower_index = int(index)
    fraction = index - lower_index
    lower, upper = np.searchsorted(cumulative, [lower_index, min(lower_index + 1, pixels.size - 1)], side="right")
    # Match numpy's linear interpolation order, including the upper-half
    # subtraction that avoids rounding differences near a pixel threshold.
    difference = int(upper - lower)
    if fraction >= 0.5:
        return float(upper - difference * (1.0 - fraction))
    return float(lower + difference * fraction)


def _contrast_masks(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    blurred = cv2.GaussianBlur(gray, (0, 0), 2.0)
    detail = gray.astype(np.int16) - blurred.astype(np.int16)
    absolute_detail = np.abs(detail).astype(np.uint8)
    threshold = max(10.0, _uint8_percentile(absolute_detail, 88))
    bright = (detail >= threshold).astype(np.uint8)
    dark = (detail <= -threshold).astype(np.uint8)
    return bright, dark


def _edge_mask(gray: np.ndarray) -> np.ndarray:
    median = _uint8_percentile(gray, 50)
    lower = max(12, int(0.55 * median))
    upper = max(lower + 1, min(255, int(1.45 * median) + 20))
    return (cv2.Canny(gray, lower, upper, L2gradient=True) > 0).astype(np.uint8)


def _tolerant_f1(reference: np.ndarray, current: np.ndarray) -> float:
    """Compare the binary uint8 (0/1) masks produced by the signature helpers."""
    reference_count = cv2.countNonZero(reference)
    current_count = cv2.countNonZero(current)
    if reference_count == 0 or current_count == 0:
        return 0.0
    kernel = np.ones((3, 3), dtype=np.uint8)
    current_dilated = cv2.dilate(current, kernel, iterations=1)
    reference_dilated = cv2.dilate(reference, kernel, iterations=1)
    recall = float(cv2.countNonZero(cv2.bitwise_and(reference, current_dilated))) / reference_count
    precision = float(cv2.countNonZero(cv2.bitwise_and(current, reference_dilated))) / current_count
    if recall + precision <= 0:
        return 0.0
    return (2.0 * recall * precision) / (recall + precision)


@dataclass(frozen=True)
class _ImageSignature:
    size: tuple[int, int]
    bright_mask: np.ndarray
    dark_mask: np.ndarray
    edge_mask: np.ndarray

    @classmethod
    def from_gray(cls, gray: np.ndarray) -> _ImageSignature:
        size = _fit_reference_size(gray.shape[1], gray.shape[0])
        prepared = _resize(gray, size)
        bright, dark = _contrast_masks(prepared)
        return cls(size=size, bright_mask=bright, dark_mask=dark, edge_mask=_edge_mask(prepared))

    def similarity(self, gray: np.ndarray) -> float:
        return self._compare(gray)[0]

    def _compare(self, gray: np.ndarray, rebase_threshold: float | None = None) -> tuple[float, _ImageSignature | None]:
        prepared = _resize(gray, self.size)
        bright, dark = _contrast_masks(prepared)
        contrast_score = max(
            _tolerant_f1(self.bright_mask, bright),
            _tolerant_f1(self.dark_mask, dark),
        )
        # F1 cannot exceed 1, so edges cannot improve a perfect contrast score.
        # A caller rebasing even perfect matches still needs the complete mask.
        if contrast_score == 1.0 and (rebase_threshold is None or rebase_threshold <= 1.0):
            return 1.0, None
        edges = _edge_mask(prepared)
        edge_score = _tolerant_f1(self.edge_mask, edges)
        score = max(contrast_score, (0.75 * contrast_score) + (0.25 * edge_score))
        return score, _ImageSignature(self.size, bright, dark, edges)


@dataclass(frozen=True)
class _ImageCandidate:
    frame_size: tuple[int, int]
    crop_box: tuple[int, int, int, int]
    signature: _ImageSignature

    def similarity(self, image: Any) -> float | None:
        gray = _crop_gray_array(image, self.frame_size, self.crop_box)
        if gray is None:
            return None
        return self.signature.similarity(gray)


def _prepare_image_crop(
    image: Any,
    payload: Any = None,
    *,
    crop_box: tuple[int, int, int, int] | None = None,
) -> tuple[np.ndarray, tuple[int, int], tuple[int, int, int, int]] | None:
    if isinstance(image, np.ndarray):
        if image.ndim not in (2, 3) or image.shape[1] <= 0 or image.shape[0] <= 0:
            return None
        frame_size = (int(image.shape[1]), int(image.shape[0]))
    else:
        try:
            frame_size = tuple(int(value) for value in image.size)
        except (AttributeError, TypeError, ValueError):
            return None
        if len(frame_size) != 2 or min(frame_size) <= 0:
            return None

    if len(frame_size) != 2:
        return None
    resolved_crop_box = crop_box or _payload_crop_box(payload, *frame_size)
    if resolved_crop_box is None:
        return None
    resolved_crop_box = _normalize_crop_box(resolved_crop_box, *frame_size)
    if resolved_crop_box is None:
        return None
    gray = _crop_gray_array(image, frame_size, resolved_crop_box)
    if gray is None:
        return None
    return gray, frame_size, resolved_crop_box


def prepare_image_candidate(
    image: Any,
    payload: Any = None,
    *,
    crop_box: tuple[int, int, int, int] | None = None,
) -> _ImageCandidate | None:
    prepared = _prepare_image_crop(image, payload, crop_box=crop_box)
    if prepared is None:
        return None
    gray, frame_size, resolved_crop_box = prepared
    return _ImageCandidate(
        frame_size=frame_size,
        crop_box=resolved_crop_box,
        signature=_ImageSignature.from_gray(gray),
    )


@dataclass(frozen=True)
class ImageStabilityObservation:
    should_run: bool
    similarity: float | None
    stable_frames: int


class ImageStabilityGate:
    """Skip redundant image consumers after a short OCR warm-up."""

    def __init__(self, *, similarity_threshold: float = 0.985, required_ocr_calls: int = 2):
        self.similarity_threshold = float(similarity_threshold)
        self.required_ocr_calls = max(1, int(required_ocr_calls))
        self._candidate: _ImageCandidate | None = None
        self._stable_frames = 0

    def reset(self) -> None:
        self._candidate = None
        self._stable_frames = 0

    def update_reference(self, image: Any, payload: Any = None) -> bool:
        prepared = _prepare_image_crop(image, payload)
        if prepared is None:
            return False
        gray, frame_size, crop_box = prepared
        if self._candidate is None or self._candidate.frame_size != frame_size or self._candidate.crop_box != crop_box:
            # An unchanged region deliberately retains its existing reference.
            # Do not compute blur, contrast masks and edges just to discard them.
            self._candidate = _ImageCandidate(frame_size, crop_box, _ImageSignature.from_gray(gray))
            self._stable_frames = 1
        return True

    def observe(self, image: Any, *, allow_skip: bool = True) -> ImageStabilityObservation:
        candidate = self._candidate
        if candidate is None:
            return ImageStabilityObservation(should_run=True, similarity=None, stable_frames=0)

        gray = _crop_gray_array(image, candidate.frame_size, candidate.crop_box)
        if gray is None:
            return ImageStabilityObservation(should_run=True, similarity=None, stable_frames=self._stable_frames)

        similarity, current_signature = candidate.signature._compare(gray, self.similarity_threshold)
        if similarity < self.similarity_threshold:
            # The comparison already produced this frame's complete signature.
            # Reuse it instead of cropping, blurring and detecting edges twice.
            self._candidate = _ImageCandidate(candidate.frame_size, candidate.crop_box, current_signature)
            self._stable_frames = 1
            return ImageStabilityObservation(should_run=True, similarity=similarity, stable_frames=1)

        self._stable_frames += 1
        should_run = not allow_skip or self._stable_frames <= self.required_ocr_calls
        return ImageStabilityObservation(
            should_run=should_run,
            similarity=similarity,
            stable_frames=self._stable_frames,
        )
