from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence

MONITOR_ID_PREFIX = "bounds"
MONITOR_BOUNDS_KEYS = ("left", "top", "width", "height")


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def normalize_monitor_bounds(bounds: Optional[Mapping[str, Any]]) -> Dict[str, int]:
    if not isinstance(bounds, Mapping):
        return {}

    left = bounds.get("left", bounds.get("x", 0))
    top = bounds.get("top", bounds.get("y", 0))
    width = bounds.get("width", 0)
    height = bounds.get("height", 0)

    normalized = {
        "left": _safe_int(left),
        "top": _safe_int(top),
        "width": _safe_int(width),
        "height": _safe_int(height),
    }
    if normalized["width"] <= 0 or normalized["height"] <= 0:
        return {}
    return normalized


def monitor_identity_from_bounds(bounds: Optional[Mapping[str, Any]]) -> str:
    normalized = normalize_monitor_bounds(bounds)
    if not normalized:
        return ""
    return f"{MONITOR_ID_PREFIX}:{normalized['left']}:{normalized['top']}:{normalized['width']}:{normalized['height']}"


def build_monitor_descriptor(index: int, monitor: Mapping[str, Any]) -> Dict[str, Any]:
    bounds = normalize_monitor_bounds(monitor)
    return {
        "index": int(index),
        "id": monitor_identity_from_bounds(bounds),
        "bounds": bounds,
    }


def build_monitor_descriptors(monitors: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    descriptors: List[Dict[str, Any]] = []
    for index, monitor in enumerate(monitors):
        descriptor = build_monitor_descriptor(index, monitor)
        if descriptor["id"]:
            descriptors.append(descriptor)
    return descriptors


def get_mss_monitor_descriptors() -> List[Dict[str, Any]]:
    try:
        import mss

        with mss.mss() as sct:
            return build_monitor_descriptors(sct.monitors[1:])
    except Exception:
        return []


def _coerce_monitor_index(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _bounds_match(left: Mapping[str, int], right: Mapping[str, int], tolerance: int = 2) -> bool:
    return all(abs(int(left[key]) - int(right[key])) <= tolerance for key in MONITOR_BOUNDS_KEYS)


def _overlap_area(left: Mapping[str, int], right: Mapping[str, int]) -> int:
    left_x1 = int(left["left"])
    left_y1 = int(left["top"])
    left_x2 = left_x1 + int(left["width"])
    left_y2 = left_y1 + int(left["height"])
    right_x1 = int(right["left"])
    right_y1 = int(right["top"])
    right_x2 = right_x1 + int(right["width"])
    right_y2 = right_y1 + int(right["height"])

    overlap_width = max(0, min(left_x2, right_x2) - max(left_x1, right_x1))
    overlap_height = max(0, min(left_y2, right_y2) - max(left_y1, right_y1))
    return overlap_width * overlap_height


def _find_descriptor_by_bounds(
    descriptors: Sequence[Dict[str, Any]],
    monitor_bounds: Mapping[str, int],
) -> Optional[Dict[str, Any]]:
    if not monitor_bounds:
        return None

    for descriptor in descriptors:
        bounds = descriptor.get("bounds") or {}
        if bounds and _bounds_match(bounds, monitor_bounds):
            return descriptor

    target_area = max(1, int(monitor_bounds["width"]) * int(monitor_bounds["height"]))
    best_descriptor = None
    best_overlap_ratio = 0.0
    for descriptor in descriptors:
        bounds = descriptor.get("bounds") or {}
        if not bounds:
            continue
        overlap_ratio = _overlap_area(bounds, monitor_bounds) / target_area
        if overlap_ratio > best_overlap_ratio:
            best_overlap_ratio = overlap_ratio
            best_descriptor = descriptor

    if best_overlap_ratio >= 0.95:
        return best_descriptor
    return None


def resolve_monitor_descriptor(
    monitors: Sequence[Mapping[str, Any]],
    monitor_index: Any = 0,
    monitor_id: str = "",
    monitor_bounds: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    descriptors = build_monitor_descriptors(monitors)
    requested_index = _coerce_monitor_index(monitor_index)

    if not descriptors:
        return {
            "descriptor": None,
            "requested_index": requested_index,
            "selected_index": 0,
            "method": "none",
            "used_fallback": True,
        }

    normalized_id = str(monitor_id or "").strip()
    if normalized_id:
        for descriptor in descriptors:
            if descriptor["id"] == normalized_id:
                return {
                    "descriptor": descriptor,
                    "requested_index": requested_index,
                    "selected_index": descriptor["index"],
                    "method": "id",
                    "used_fallback": False,
                }

    normalized_bounds = normalize_monitor_bounds(monitor_bounds)
    bounds_descriptor = _find_descriptor_by_bounds(descriptors, normalized_bounds)
    if bounds_descriptor:
        return {
            "descriptor": bounds_descriptor,
            "requested_index": requested_index,
            "selected_index": bounds_descriptor["index"],
            "method": "bounds",
            "used_fallback": False,
        }

    selected_index = min(max(requested_index, 0), len(descriptors) - 1)
    descriptor = descriptors[selected_index]
    return {
        "descriptor": descriptor,
        "requested_index": requested_index,
        "selected_index": selected_index,
        "method": "index" if selected_index == requested_index else "index-clamped",
        "used_fallback": bool(normalized_id or normalized_bounds or selected_index != requested_index),
    }


def apply_monitor_selection_to_overlay(
    overlay_config: Any,
    monitors: Sequence[Mapping[str, Any]],
    monitor_index: Any = None,
) -> Dict[str, Any]:
    requested_index = getattr(overlay_config, "monitor_to_capture", 0) if monitor_index is None else monitor_index
    selection = resolve_monitor_descriptor(
        monitors,
        requested_index,
        getattr(overlay_config, "monitor_to_capture_id", ""),
        getattr(overlay_config, "monitor_to_capture_bounds", {}),
    )
    descriptor = selection.get("descriptor")
    if descriptor:
        overlay_config.monitor_to_capture = int(descriptor["index"])
        overlay_config.monitor_to_capture_id = str(descriptor["id"])
        overlay_config.monitor_to_capture_bounds = dict(descriptor["bounds"])
    return selection


def set_overlay_monitor_identity_from_index(
    overlay_config: Any,
    monitors: Sequence[Mapping[str, Any]],
    monitor_index: Any,
) -> Optional[Dict[str, Any]]:
    descriptors = build_monitor_descriptors(monitors)
    if not descriptors:
        return None

    requested_index = _coerce_monitor_index(monitor_index)
    selected_index = min(max(requested_index, 0), len(descriptors) - 1)
    descriptor = descriptors[selected_index]
    overlay_config.monitor_to_capture = int(descriptor["index"])
    overlay_config.monitor_to_capture_id = str(descriptor["id"])
    overlay_config.monitor_to_capture_bounds = dict(descriptor["bounds"])
    return descriptor
