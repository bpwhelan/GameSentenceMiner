"""Application context for the Tauri overlay. No capture or OCR runs here.

The shared game monitor still serves OBS, focus restoration and process pause.
Only its identity/availability is passed to the native overlay worker.
"""

import os
from dataclasses import asdict

from GameSentenceMiner.obs import desktop_session


def enabled() -> bool:
    return os.environ.get("GSM_NATIVE_OVERLAY") == "1"


def command(processor, action="configure", **request) -> dict:
    from GameSentenceMiner.ocr.gsm_ocr_config import get_overlay_area_config
    from GameSentenceMiner.util.config.configuration import get_config, gsm_state
    from GameSentenceMiner.util.data_directory import get_app_directory
    from GameSentenceMiner.util.overlay.capture_state import get_overlay_capture_state

    config = get_config()
    settings = asdict(config.overlay)
    settings["minimum_character_size"] = processor._get_overlay_minimum_character_size()
    area = get_overlay_area_config() if config.overlay.use_overlay_area_config else None
    areas = asdict(area) if area is not None else None
    if areas and areas.get("pre_scale_rectangles") is not None:
        areas["rectangles"] = areas["pre_scale_rectangles"]
    if areas:
        areas["overlay_coordinate_space"] = getattr(
            area, "overlay_coordinate_space", "window" if area.window_geometry else "monitor"
        )
    monitor = processor.window_monitor
    backend = getattr(config.advanced, "screenshot_capture_backend_v2", "auto")
    if desktop_session.enabled():
        state = desktop_session.snapshot()
        scene, target, source = state["scene"], state["target_id"], state["source_name"] or state["scene"]
        kind, available = state["capture_kind"], state["available"]
        if state.get("obs_fallback_available"):
            kind, available = "obs", True
    else:
        target = getattr(monitor, "target_hwnd", None)
        source = (getattr(monitor, "last_target_info", None) or {}).get("source_name") or gsm_state.current_game
        scene = gsm_state.current_game
        available = bool(get_overlay_capture_state(monitor)["available"])
        kind = "obs" if not target and source else "window"
    return {
        "type": "native-overlay-command",
        "action": action,
        "config": {
            "settings": settings,
            "language": config.general.target_language,
            "profile": get_app_directory(),
            "scene": scene,
            "target_id": target,
            "source_name": source,
            "capture_kind": "obs" if backend == "obs" else kind,
            "available": available,
            "areas": areas,
        },
        **request,
    }


async def send(processor, action="configure", **request):
    from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager

    await websocket_manager.send(ID_OVERLAY, command(processor, action, **request))


async def accept_result(processor, payload):
    """Record unbacked native overlay scans (no line_id) for mining and skip recovery.

    Text-driven scans (line_id present) are handled end-to-end in Rust without
    bouncing results, logs, or recycled-line status back through Python.
    """
    if not enabled() or not isinstance(payload, dict) or payload.get("is_final") is not True:
        return
    if payload.get("line_id") is not None:
        return
    rows = payload.get("data")
    if not isinstance(rows, list) or len(rows) > 4096:
        return
    text = "\n".join(row["text"] for row in rows if isinstance(row, dict) and isinstance(row.get("text"), str))
    if not text.strip() or len(text) > 100_000:
        return
    processor.last_oneocr_result = text
    processor.last_lens_result = ""
    await processor._record_overlay_scan(text, source=payload.get("source"))
