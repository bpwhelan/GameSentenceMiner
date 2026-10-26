"""Read-only capture previews and leased OCR geometry for the desktop workspace.

Frames use the normal OBS/WGC capture source. Geometry reuses completed OCR
passes, including packed-area offsets; opening the preview never runs OCR.
"""

from __future__ import annotations

import base64
import io
import math
import threading
import time
from collections.abc import Callable
from typing import Any

from GameSentenceMiner.ocr.composite_layout import CompositeLayout

PREVIEW_FRAME_TOPIC = "capture.preview"
PREVIEW_GEOMETRY_TOPIC = "ocr.preview"
_capture_lock = threading.Lock()


def _number(value: Any) -> float | None:
    if not isinstance(value, (float, int)) or isinstance(value, bool):
        return None
    return float(value) if math.isfinite(value) else None


def _quad(value: Any) -> list[tuple[float, float]] | None:
    if isinstance(value, dict):
        values = [_number(value.get(key)) for key in ("x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4")]
        if all(n is not None for n in values):
            return list(zip(values[::2], values[1::2]))
    elif isinstance(value, (list, tuple)) and len(value) >= 4:
        values = [_number(n) for n in value[:4]]
        if all(n is not None for n in values):
            left, top, right, bottom = values
            return [(left, top), (right, top), (right, bottom), (left, bottom)]
    return None


def build_preview_geometry(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    pipeline = payload.get("pipeline") or {}
    processing = pipeline.get("processing") or {}
    if processing.get("coordinate_mode", "source_content") != "source_content":
        return None
    size = (pipeline.get("capture") or {}).get("scaled_size") or {}
    width, height = _number(size.get("width")), _number(size.get("height"))
    if not width or not height or width <= 0 or height <= 0:
        return None

    layout = CompositeLayout.from_metadata(processing.get("crop_offset") or {})
    entries = payload.get("line_coords") or payload.get("boxes") or []
    if not isinstance(entries, list):
        return None
    boxes = []
    for entry in entries[:200]:
        if not isinstance(entry, dict):
            continue
        points = _quad(entry.get("bounding_rect") or entry.get("box"))
        if not points:
            continue
        offset_x, offset_y = layout.offset_for_point(sum(p[0] for p in points) / 4, sum(p[1] for p in points) / 4)
        points = [[max(0, min(1, (x + offset_x) / width)), max(0, min(1, (y + offset_y) / height))] for x, y in points]
        if max(p[0] for p in points) <= min(p[0] for p in points) or max(p[1] for p in points) <= min(
            p[1] for p in points
        ):
            continue
        boxes.append({"points": points, "text": str(entry.get("text") or "")[:256]})
    return {"sourceWidth": width, "sourceHeight": height, "boxes": boxes}


class PreviewGeometry:
    def __init__(self, *, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._lock = threading.Lock()
        self._expires = 0.0
        self._latest: dict[str, Any] | None = None

    @property
    def enabled(self) -> bool:
        with self._lock:
            return self._expires > self._clock()

    def snapshot(self, request: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            if self._expires <= self._clock() or not request.get("enabled"):
                self._latest = None
            # Live previews can wait three seconds between captures, plus the
            # capture request timeout. Keep geometry alive across that gap.
            self._expires = self._clock() + 10 if request.get("enabled") else 0
            if self._latest and self._latest["sceneName"] == request.get("sceneName"):
                return self._latest
            return None

    def update(self, payload: Any, *, scene_name: str, source_name: str) -> None:
        if not self.enabled:
            return
        geometry = build_preview_geometry(payload)
        with self._lock:
            self._latest = (
                {
                    **geometry,
                    "sceneName": scene_name,
                    "sourceName": source_name,
                    "detectedAt": int(time.time() * 1000),
                }
                if geometry
                else None
            )


preview_geometry = PreviewGeometry()


def capture_preview(request: dict[str, Any]) -> dict[str, Any] | None:
    # A timed-out client cannot queue another native capture behind a slow one.
    if not _capture_lock.acquire(blocking=False):
        return None
    image = None
    try:
        from GameSentenceMiner import obs

        scene_name = request.get("sceneName")
        if not scene_name or obs.get_current_scene() != scene_name:
            return None
        source = obs.get_source_from_scene(scene_name)
        source_name = source.get("sourceName") if isinstance(source, dict) else None
        if not source_name:
            return None
        image = obs.get_screenshot_PIL(
            source_name=source_name,
            width=960,
            compression=70,
            img_format="jpg",
            retry=0,
            preprocess_mode="none",
            log_missing_source=False,
            suppress_errors=True,
        )
        if image is None or obs.get_current_scene() != scene_name:
            return None
        # OBS already returns a sized JPEG backed by BytesIO. Forward those
        # bytes without decoding and then recompressing every preview request.
        # Native capture and oversized images still use the normal resize path.
        stream = getattr(image, "fp", None)
        if image.format == "JPEG" and isinstance(stream, io.BytesIO) and image.width <= 960 and image.height <= 720:
            encoded = stream.getvalue()
        else:
            image.thumbnail((960, 720))
            with io.BytesIO() as buffer:
                rgb = image if image.mode == "RGB" else image.convert("RGB")
                try:
                    rgb.save(buffer, format="JPEG", quality=70)
                finally:
                    if rgb is not image:
                        rgb.close()
                encoded = buffer.getvalue()
        image_data = "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii")
        return {
            "sceneId": request.get("sceneId"),
            "sceneName": scene_name,
            "sourceName": source_name,
            "imageData": image_data,
            "width": image.width,
            "height": image.height,
            "capturedAt": int(time.time() * 1000),
        }
    finally:
        if image is not None:
            image.close()
        _capture_lock.release()


async def handle_capture_preview(message: dict[str, Any]) -> dict[str, Any] | None:
    import asyncio

    request = message.get("data")
    if not isinstance(request, dict):
        return None
    return await asyncio.to_thread(capture_preview, request)


def handle_geometry_preview(message: dict[str, Any]) -> dict[str, Any] | None:
    request = message.get("data")
    return preview_geometry.snapshot(request) if isinstance(request, dict) else None
