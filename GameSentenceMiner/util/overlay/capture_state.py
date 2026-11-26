"""Capture evidence shared by overlay activation and manual capture requests."""

import json
import time

from GameSentenceMiner.obs import desktop_session
from GameSentenceMiner.obs.active_game import get_obs_state
from GameSentenceMiner.obs.browser_source import is_browser_window_source
from GameSentenceMiner.obs.launch import get_preferred_video_source, parse_obs_window_target
from GameSentenceMiner.util.config.configuration import is_windows
from GameSentenceMiner.util.platform.window_state_monitor import user32
from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager


def is_browser_capture_source(monitor):
    if desktop_session.enabled():
        return desktop_session.snapshot().get("browser_source") is True
    state = get_obs_state()
    info = getattr(monitor, "last_target_info", None) or {}
    tracked_scene = getattr(monitor, "last_target_scene_name", None)
    if is_browser_window_source(info) and (not state or not tracked_scene or tracked_scene == state.current_scene):
        return True
    if not state:
        return False
    items = state.scene_items_by_scene.get(state.current_scene, [])
    selected = get_preferred_video_source(
        [
            item
            for item in items
            if item.get("sceneItemEnabled", True)
            and not (item.get("inputKind") or "").startswith(("wasapi_", "pulse_", "alsa_", "coreaudio_"))
            and "audio" not in (item.get("inputKind") or "")
        ],
        state.input_active_by_name,
        state.input_show_by_name,
    )
    if not selected:
        return False
    if selected.get("inputKind") == "browser_source":
        return True
    settings = state.input_settings_by_name.get(selected.get("sourceName")) or {}
    info = parse_obs_window_target(settings.get("window")) or {}
    x11_fields = (settings.get("capture_window") or "").splitlines()
    if len(x11_fields) >= 3:
        info["wm_class"] = x11_fields[2]
    return is_browser_window_source(info)


def get_overlay_capture_state(monitor):
    if desktop_session.enabled():
        state = desktop_session.snapshot()
        available = state["available"] or state.get("obs_fallback_available", False)
        window_state = "background" if available else "unknown"
        if state.get("target_id") and getattr(monitor, "target_hwnd", None) == state["target_id"]:
            window_state = getattr(monitor, "last_state", window_state)
        return {
            "type": "capture_status",
            **({"desktop_projection": True} if is_windows() else {}),
            "available": available,
            "scene_name": state["scene"],
            "window_state": window_state,
        }
    state = get_obs_state()
    payload = {
        "type": "capture_status",
        "available": False,
        "window_state": "unknown",
        "scene_name": state.current_scene if state else "",
    }
    if monitor is None or state is None:
        return payload

    tracked_scene = getattr(monitor, "last_target_scene_name", None)
    if tracked_scene and tracked_scene != state.current_scene:
        return payload

    if is_windows():
        hwnd = monitor.target_hwnd
        if hwnd:
            valid = bool(
                user32 and user32.IsWindow(hwnd) and user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd)
            )
            if not valid:
                return {**payload, "window_state": "closed"}
            if getattr(monitor, "last_target_info", {}):
                return {**payload, "available": True, "window_state": monitor.last_state}
            # A title-only match without an OBS window source still needs capture output.
        # Losing a positively identified window differs from never resolving one.
        # Browsers and other untracked OBS sources still support monitor-based OCR.
        elif getattr(monitor, "ever_had_target_hwnd", False):
            return payload

    checked_at = state.source_output_checked_at
    available = bool(
        state.source_output_active is True
        and state.source_output_scene == state.current_scene
        and checked_at
        and checked_at >= getattr(monitor, "_capture_target_changed_at", 0)
        and 0 <= time.time() - checked_at <= 30
    )
    return {**payload, "available": available, "window_state": "background" if available else "unknown"}


async def publish_overlay_capture_state(monitor):
    payload = get_overlay_capture_state(monitor)
    now = time.time()
    if (
        payload == getattr(monitor, "_last_capture_status", None)
        and now - getattr(monitor, "_last_capture_status_at", 0) < 1
    ):
        return
    await websocket_manager.send(ID_OVERLAY, json.dumps(payload))
    monitor._last_capture_status = payload
    monitor._last_capture_status_at = now
