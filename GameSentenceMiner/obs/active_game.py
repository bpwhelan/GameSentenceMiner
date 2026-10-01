"""Session activity shared by desktop automation and capture/window monitoring.

Session lifetime differs from overlay visibility: minimizing or covering a live
game window must not tear down the overlay and its dictionaries.
"""

import time

from GameSentenceMiner.util.communication.electron_ipc import send_message
from GameSentenceMiner.util.config.configuration import is_windows
from GameSentenceMiner.util.platform.window_state_monitor import user32

_AUDIO_ONLY_INPUT_KINDS = {"wasapi_input_capture", "wasapi_output_capture", "wasapi_process_output_capture"}
_last_published_snapshot = None
_last_published_at = 0.0


def get_obs_state():
    import GameSentenceMiner.obs as obs_package
    from GameSentenceMiner.util.config.configuration import gsm_status

    service = obs_package.obs_service
    return service.state if service and gsm_status.obs_connected else None


def get_active_game_snapshot(monitor):
    state = get_obs_state()
    scene_name = state.current_scene if state else getattr(monitor, "last_target_scene_name", "")
    payload = {"sceneName": scene_name or "", "active": None}
    if not scene_name:
        return payload

    if is_windows() and monitor is not None:
        if getattr(monitor, "last_target_scene_name", None) != scene_name:
            return payload
        hwnd = getattr(monitor, "target_hwnd", None)
        if hwnd and user32:
            return {**payload, "active": bool(user32.IsWindow(hwnd))}
        # A missing tracked window is stronger evidence than a buffered OBS frame.
        if getattr(monitor, "ever_had_target_hwnd", False):
            return {**payload, "active": False}

    if state is None:
        return payload

    items_checked_at = getattr(state, "scene_items_checked_at", {}).get(state.current_scene, 0)
    items = getattr(state, "scene_items_by_scene", {}).get(state.current_scene)
    if (
        items is not None
        and items_checked_at
        and 0 <= time.time() - items_checked_at <= 15
        and not any(
            item.get("sceneItemEnabled", True) and item.get("inputKind") not in _AUDIO_ONLY_INPUT_KINDS
            for item in items
        )
    ):
        return {**payload, "active": False}

    checked_at = state.source_output_checked_at
    if (
        getattr(state, "source_output_scene", None) != state.current_scene
        or not checked_at
        or checked_at < getattr(monitor, "_capture_target_changed_at", 0)
        or not 0 <= time.time() - checked_at <= 30
    ):
        return payload
    if state.source_output_active is True:
        return {**payload, "active": True}
    empty_since = state.source_output_empty_since
    if state.source_output_active is False and empty_since is not None and time.time() - empty_since >= 15:
        return {**payload, "active": False}
    return payload


def publish_active_game_state(monitor):
    # Heartbeats distinguish missing capture from a missing backend.
    global _last_published_snapshot, _last_published_at
    snapshot = get_active_game_snapshot(monitor)
    now = time.time()
    if snapshot == _last_published_snapshot and now - _last_published_at < 1:
        return
    send_message("active_game_state", {**snapshot, "observedAt": now * 1000})
    _last_published_snapshot, _last_published_at = snapshot, now
