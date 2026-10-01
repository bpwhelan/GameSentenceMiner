"""Capture evidence shared by overlay activation and manual capture requests."""

import json
import time

from GameSentenceMiner.obs.active_game import get_obs_state
from GameSentenceMiner.util.config.configuration import is_windows
from GameSentenceMiner.util.platform.window_state_monitor import user32
from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager


def get_overlay_capture_state(monitor):
    payload = {"type": "capture_status", "available": False, "window_state": "unknown"}
    state = get_obs_state()
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
        # Output from an old frame or another source cannot stand in for a missing game.
        elif getattr(monitor, "ever_had_target_hwnd", False) or getattr(monitor, "last_target_info", {}):
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
