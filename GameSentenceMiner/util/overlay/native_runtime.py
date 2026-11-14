"""Application context for the Tauri overlay. No capture or OCR runs here.

The shared game monitor still serves OBS, focus restoration and process pause.
Only its identity/availability is passed to the native overlay worker.
"""

import os
from dataclasses import asdict


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
    target = getattr(monitor, "target_hwnd", None)
    source = (getattr(monitor, "last_target_info", None) or {}).get("source_name") or gsm_state.current_game
    backend = getattr(config.advanced, "screenshot_capture_backend_v2", "auto")
    return {
        "type": "native-overlay-command",
        "action": action,
        "config": {
            "settings": settings,
            "language": config.general.target_language,
            "profile": get_app_directory(),
            "scene": gsm_state.current_game,
            "target_id": target,
            "source_name": source,
            "capture_kind": "obs" if backend == "obs" or (not target and source) else "window",
            "available": bool(get_overlay_capture_state(monitor)["available"]),
            "areas": areas,
        },
        **request,
    }


async def send(processor, action="configure", **request):
    from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager

    await websocket_manager.send(ID_OVERLAY, command(processor, action, **request))


async def accept_result(processor, payload):
    """Keep mining and translation context in sync with completed native scans."""
    if not enabled() or not isinstance(payload, dict) or payload.get("is_final") is not True:
        return
    rows = payload.get("data")
    if not isinstance(rows, list) or len(rows) > 4096:
        return
    text = "\n".join(row["text"] for row in rows if isinstance(row, dict) and isinstance(row.get("text"), str))
    if len(text) > 100_000:
        return
    processor.last_oneocr_result = text
    processor.last_lens_result = ""
    line_id = payload.get("line_id")
    processor.last_overlay_line_id = str(line_id) if line_id is not None else None
    processor.last_overlay_latest_text = payload.get("latest_text") or text
    processor.sentence_is_recycled = processor._is_sentence_recycled(processor.last_overlay_latest_text)
    processor._send_sentence_recycled_status(
        line_id=processor.last_overlay_line_id, sentence=processor.last_overlay_latest_text
    )
    if line_id is None:
        await processor._record_overlay_scan(text, source=payload.get("source"))
