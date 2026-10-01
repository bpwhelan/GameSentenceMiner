import threading
from types import SimpleNamespace

import pytest

import GameSentenceMiner.obs as obs_module
from GameSentenceMiner.obs import actions, active_game
from GameSentenceMiner.obs import service as obs_service


@pytest.fixture
def capture(monkeypatch):
    monitor = SimpleNamespace(
        target_hwnd=123,
        last_state="active",
        last_target_scene_name="Game",
        last_target_info={"exe": "game.exe"},
        ever_had_target_hwnd=True,
    )
    state = SimpleNamespace(
        current_scene="Game",
        source_output_scene="Game",
        source_output_active=True,
        source_output_checked_at=99.0,
        source_output_empty_since=None,
    )
    user32 = SimpleNamespace(IsWindow=lambda hwnd: True)
    monkeypatch.setattr(active_game, "get_obs_state", lambda: state)
    monkeypatch.setattr(active_game, "is_windows", lambda: True)
    monkeypatch.setattr(active_game, "user32", user32)
    monkeypatch.setattr(active_game.time, "time", lambda: 100.0)
    monkeypatch.setattr(active_game, "_last_published_snapshot", None)
    return monitor, state, user32


@pytest.mark.parametrize("window_state", ["active", "background", "obscured", "minimized"])
def test_live_hwnd_keeps_session_active_even_without_output(capture, window_state):
    monitor, state, _ = capture
    monitor.last_state = window_state
    state.source_output_active = False
    assert active_game.get_active_game_snapshot(monitor)["active"] is True


def test_lost_hwnd_cannot_fall_back_to_old_output(capture):
    monitor, _, user32 = capture
    user32.IsWindow = lambda hwnd: False
    assert active_game.get_active_game_snapshot(monitor)["active"] is False
    monitor.target_hwnd = None
    assert active_game.get_active_game_snapshot(monitor)["active"] is False


def test_scene_mismatch_is_unknown(capture):
    monitor, state, _ = capture
    state.current_scene = "Other"
    assert active_game.get_active_game_snapshot(monitor)["active"] is None


def test_live_window_evidence_survives_obs_disconnect(capture, monkeypatch):
    monitor, _, user32 = capture
    monkeypatch.setattr(active_game, "get_obs_state", lambda: None)
    assert active_game.get_active_game_snapshot(monitor) == {"sceneName": "Game", "active": True}
    user32.IsWindow = lambda hwnd: False
    assert active_game.get_active_game_snapshot(monitor)["active"] is False


def test_capture_only_session_requires_fresh_output_for_current_scene(capture, monkeypatch):
    _, state, _ = capture
    monkeypatch.setattr(active_game, "is_windows", lambda: False)
    assert active_game.get_active_game_snapshot(None)["active"] is True
    state.source_output_scene = "Other"
    assert active_game.get_active_game_snapshot(None)["active"] is None
    state.source_output_scene = "Game"
    state.source_output_checked_at = 60
    assert active_game.get_active_game_snapshot(None)["active"] is None


def test_empty_capture_must_be_sustained(capture, monkeypatch):
    _, state, _ = capture
    monkeypatch.setattr(active_game, "is_windows", lambda: False)
    state.source_output_active = False
    state.source_output_empty_since = 90
    assert active_game.get_active_game_snapshot(None)["active"] is None
    state.source_output_empty_since = 80
    assert active_game.get_active_game_snapshot(None)["active"] is False
    state.source_output_active = None
    assert active_game.get_active_game_snapshot(None)["active"] is None


def test_active_capture_can_start_before_a_window_is_found(capture):
    monitor, _, _ = capture
    monitor.target_hwnd = None
    monitor.ever_had_target_hwnd = False
    assert active_game.get_active_game_snapshot(monitor)["active"] is True


def test_source_change_invalidates_old_capture(capture):
    monitor, _, _ = capture
    monitor.target_hwnd = None
    monitor.ever_had_target_hwnd = False
    monitor._capture_target_changed_at = 99.5
    assert active_game.get_active_game_snapshot(monitor)["active"] is None


@pytest.mark.parametrize("items", [[], [{"sceneItemEnabled": False}], [{"inputKind": "wasapi_output_capture"}]])
def test_removed_or_disabled_capture_is_inactive(capture, monkeypatch, items):
    _, state, _ = capture
    monkeypatch.setattr(active_game, "is_windows", lambda: False)
    state.source_output_active = None
    state.scene_items_by_scene = {"Game": items}
    state.scene_items_checked_at = {"Game": 99}
    assert active_game.get_active_game_snapshot(None)["active"] is False
    state.scene_items_checked_at = {"Game": 50}
    assert active_game.get_active_game_snapshot(None)["active"] is None


def test_unknown_or_stale_probe_breaks_continuous_empty_output(capture, monkeypatch):
    _, state, _ = capture
    service = SimpleNamespace(state=state, _state_lock=threading.Lock())
    state.source_output_empty_since = 50
    monkeypatch.setattr(actions, "get_screenshot_PIL", lambda **kwargs: None)
    assert obs_service.OBSService._is_output_active_from_screenshot(service) is None
    assert state.source_output_empty_since is None
    state.source_output_empty_since = 50
    state.source_output_checked_at = 50
    monkeypatch.setattr(actions, "get_screenshot_PIL", lambda **kwargs: object())
    monkeypatch.setattr(obs_service, "is_image_empty", lambda image: True)
    assert obs_service.OBSService._is_output_active_from_screenshot(service) is False
    assert state.source_output_empty_since == 100


def test_publish_includes_evidence_time(capture, monkeypatch):
    monitor, _, _ = capture
    sent = []
    monkeypatch.setattr(active_game, "send_message", lambda name, data: sent.append((name, data)))
    active_game.publish_active_game_state(monitor)
    active_game.publish_active_game_state(monitor)
    assert sent == [("active_game_state", {"sceneName": "Game", "active": True, "observedAt": 100_000})]
    monkeypatch.setattr(active_game.time, "time", lambda: 101.0)
    active_game.publish_active_game_state(monitor)
    assert len(sent) == 2
    monitor.target_hwnd = None
    active_game.publish_active_game_state(monitor)
    assert sent[-1][1]["active"] is False


def test_active_game_detection_wakes_replay_without_waiting_for_window_state_change(capture, monkeypatch):
    monitor, state, _ = capture
    wakeups = []
    monkeypatch.setattr(active_game, "send_message", lambda *args: None)
    monkeypatch.setattr(
        obs_module, "obs_connection_manager", SimpleNamespace(request_tick=lambda: wakeups.append(True))
    )

    active_game.publish_active_game_state(monitor)
    assert len(wakeups) == 1

    # Heartbeats do not repeatedly wake the OBS worker.
    monkeypatch.setattr(active_game.time, "time", lambda: 101.0)
    active_game.publish_active_game_state(monitor)
    assert len(wakeups) == 1

    monitor.target_hwnd = None
    active_game.publish_active_game_state(monitor)
    assert len(wakeups) == 1
    monitor.target_hwnd = 123
    active_game.publish_active_game_state(monitor)
    assert len(wakeups) == 2

    # Two games can have the same window state while their OBS scene changes.
    state.current_scene = monitor.last_target_scene_name = "Other Game"
    active_game.publish_active_game_state(monitor)
    assert len(wakeups) == 3
