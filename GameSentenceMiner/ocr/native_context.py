"""Capture identity and scene-checked text ingress for Rust. No pixels or OCR."""


def context_snapshot():
    from GameSentenceMiner.obs import desktop_session

    if desktop_session.enabled():
        return desktop_session.snapshot()

    from GameSentenceMiner.obs.active_game import get_obs_state
    from GameSentenceMiner.util.config.configuration import gsm_state
    from GameSentenceMiner.util.platform.window_state_monitor import get_window_state_monitor

    state = get_obs_state()
    monitor = get_window_state_monitor()
    scene = state.current_scene if state else ""
    matching = bool(monitor and scene and monitor.last_target_scene_name == scene)
    info = (getattr(monitor, "last_target_info", None) or {}) if matching else {}
    target = getattr(monitor, "target_hwnd", None) if matching else None
    items = (getattr(state, "scene_items_by_scene", {}) or {}).get(scene, []) if state else []
    kinds = {item.get("inputKind") for item in items if item.get("sceneItemEnabled", True)}
    # OBS display/video/browser sources have no window to capture through WGC.
    # An unresolved game/window source is different: keep waiting for its HWND.
    obs_capture = bool(kinds and not target and not kinds.intersection({"game_capture", "window_capture"}))
    return {
        "scene": scene,
        "source_name": info.get("source_name", ""),
        "target_id": int(target) if target else None,
        "available": bool(target) or obs_capture,
        "capture_kind": "obs" if obs_capture else "window",
        "capture_source": scene,
        "process_path": getattr(gsm_state, "current_game", "") or scene,
    }


def handle_context(_message):
    return context_snapshot()


def handle_result(message):
    from GameSentenceMiner.gametext import ingest_text_v2_payload

    payload = message.get("data") or {}
    if not isinstance(payload, dict):
        return {"status": "rejected", "reason": "invalid OCR observation"}
    # Scene identities can change during inference or the one-second context
    # lease. Never attribute an old game's capture to the newly active game.
    scene = str(payload.get("ocr_scene") or "")
    if scene and scene != context_snapshot()["scene"]:
        return {"status": "rejected", "observation_id": payload.get("observationId", ""), "reason": "stale OCR scene"}
    return ingest_text_v2_payload(payload)
