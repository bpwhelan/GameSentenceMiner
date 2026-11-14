import sys
from types import SimpleNamespace

from GameSentenceMiner.ocr import native_context
from GameSentenceMiner.ocr.native_context import context_snapshot


def test_snapshot_never_reuses_a_different_scenes_window(monkeypatch):
    monitor = SimpleNamespace(last_target_scene_name="Old", target_hwnd=42, last_target_info={"source_name": "Game"})
    monkeypatch.setitem(
        sys.modules,
        "GameSentenceMiner.obs.active_game",
        SimpleNamespace(get_obs_state=lambda: SimpleNamespace(current_scene="New")),
    )
    monkeypatch.setitem(
        sys.modules,
        "GameSentenceMiner.util.platform.window_state_monitor",
        SimpleNamespace(get_window_state_monitor=lambda: monitor),
    )
    result = context_snapshot()
    assert result["scene"] == "New"
    assert result["target_id"] is None
    assert result["available"] is False
    monitor.last_target_scene_name = "New"
    result = context_snapshot()
    assert result["target_id"] == 42
    assert result["source_name"] == "Game"


def test_obs_video_source_selects_native_obs_capture(monkeypatch):
    state = SimpleNamespace(current_scene="Video", scene_items_by_scene={"Video": [{"inputKind": "ffmpeg_source"}]})
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.obs.active_game", SimpleNamespace(get_obs_state=lambda: state))
    monkeypatch.setitem(
        sys.modules,
        "GameSentenceMiner.util.platform.window_state_monitor",
        SimpleNamespace(get_window_state_monitor=lambda: None),
    )
    assert context_snapshot()["capture_kind"] == "obs"
    assert context_snapshot()["available"] is True
    state.scene_items_by_scene["Video"] = [{"inputKind": "game_capture"}]
    assert context_snapshot()["capture_kind"] == "window"


def test_ingress_rejects_a_capture_from_the_previous_game(monkeypatch):
    received = []
    monkeypatch.setattr(native_context, "context_snapshot", lambda: {"scene": "New"})
    monkeypatch.setitem(
        sys.modules,
        "GameSentenceMiner.gametext",
        SimpleNamespace(ingest_text_v2_payload=lambda payload: received.append(payload) or {"status": "accepted"}),
    )
    assert native_context.handle_result({"data": {"ocr_scene": "Old", "text": "古い文章"}})["status"] == "rejected"
    assert not received
    assert native_context.handle_result({"data": {"ocr_scene": "New", "text": "今の文章"}})["status"] == "accepted"
    assert len(received) == 1
