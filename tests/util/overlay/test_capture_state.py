import asyncio
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.overlay import capture_state


@pytest.fixture
def capture(monkeypatch):
    monitor = SimpleNamespace(
        target_hwnd=123,
        last_state="active",
        last_target_info={"exe": "game.exe"},
        ever_had_target_hwnd=True,
        last_target_scene_name="Game",
    )
    state = SimpleNamespace(
        current_scene="Game", source_output_scene="Game", source_output_active=True, source_output_checked_at=99.0
    )
    user32 = SimpleNamespace(
        IsWindow=lambda hwnd: True,
        IsWindowVisible=lambda hwnd: True,
        IsIconic=lambda hwnd: False,
    )
    monkeypatch.setattr(capture_state, "is_windows", lambda: True)
    monkeypatch.setattr(capture_state, "user32", user32)
    monkeypatch.setattr(capture_state, "get_obs_state", lambda: state)
    monkeypatch.setattr(capture_state.time, "time", lambda: 100.0)
    return monitor, state, user32


def test_live_captured_hwnd_is_available_even_before_obs_output_probe(capture):
    monitor, state, _ = capture
    state.source_output_active = None
    assert capture_state.get_overlay_capture_state(monitor) == {
        "type": "capture_status",
        "available": True,
        "window_state": "active",
    }


@pytest.mark.parametrize("api,result", [("IsWindow", False), ("IsWindowVisible", False), ("IsIconic", True)])
def test_invalid_or_hidden_hwnd_cannot_fall_back_to_old_obs_output(capture, api, result):
    monitor, _, user32 = capture
    setattr(user32, api, lambda hwnd: result)
    assert capture_state.get_overlay_capture_state(monitor)["available"] is False


def test_lost_game_hwnd_cannot_use_obs_output(capture):
    monitor, _, _ = capture
    monitor.target_hwnd = None
    assert capture_state.get_overlay_capture_state(monitor)["available"] is False


@pytest.mark.parametrize(
    "target_info",
    [{}, {"exe": "chrome.exe", "title": "Browser game"}, {"exe": "game.exe"}],
    ids=["desktop", "browser", "unresolved-window"],
)
def test_untracked_obs_capture_remains_available_with_window_metadata(capture, target_info):
    monitor, state, _ = capture
    monitor.target_hwnd = None
    monitor.ever_had_target_hwnd = False
    monitor.last_target_info = target_info
    monitor.last_state = "unknown"
    assert capture_state.get_overlay_capture_state(monitor) == {
        "type": "capture_status",
        "available": True,
        "window_state": "background",
    }
    state.source_output_active = False
    assert capture_state.get_overlay_capture_state(monitor)["available"] is False


def test_title_only_window_match_cannot_grant_capture_without_obs_output(capture):
    monitor, state, _ = capture
    monitor.last_target_info = {}
    state.source_output_active = None
    assert capture_state.get_overlay_capture_state(monitor)["available"] is False


@pytest.mark.parametrize("windows", [True, False])
def test_capture_without_hwnd_requires_recent_confirmed_output(capture, monkeypatch, windows):
    monitor, state, _ = capture
    monkeypatch.setattr(capture_state, "is_windows", lambda: windows)
    monitor.target_hwnd = None
    monitor.last_target_info = {}
    monitor.ever_had_target_hwnd = False
    monitor.last_state = "unknown"
    assert capture_state.get_overlay_capture_state(monitor)["available"] is True
    assert capture_state.get_overlay_capture_state(monitor)["window_state"] == "background"
    for active, checked_at in [(None, 99), (False, 99), (True, 0), (True, 69)]:
        state.source_output_active, state.source_output_checked_at = active, checked_at
        assert capture_state.get_overlay_capture_state(monitor)["available"] is False


def test_scene_switch_invalidates_old_hwnd(capture):
    monitor, state, _ = capture
    state.current_scene = "Other game"
    assert capture_state.get_overlay_capture_state(monitor)["available"] is False


def test_non_hwnd_capture_cannot_reuse_output_from_previous_scene(capture):
    monitor, state, _ = capture
    monitor.target_hwnd = None
    monitor.last_target_info = {}
    monitor.ever_had_target_hwnd = False
    state.source_output_scene = "Previous game"
    assert capture_state.get_overlay_capture_state(monitor)["available"] is False


def test_removed_window_source_needs_new_output_evidence(capture):
    monitor, _, _ = capture
    monitor.target_hwnd = None
    monitor.last_target_info = {}
    monitor.ever_had_target_hwnd = False
    monitor._capture_target_changed_at = 100
    assert capture_state.get_overlay_capture_state(monitor)["available"] is False


def test_capture_status_heartbeat_repeats_for_reconnected_overlays(capture, monkeypatch):
    monitor, _, _ = capture
    sent = []

    async def send(_client, data):
        sent.append(data)

    monkeypatch.setattr(capture_state.websocket_manager, "send", send)
    asyncio.run(capture_state.publish_overlay_capture_state(monitor))
    asyncio.run(capture_state.publish_overlay_capture_state(monitor))
    assert len(sent) == 1
    monkeypatch.setattr(capture_state.time, "time", lambda: 101.1)
    asyncio.run(capture_state.publish_overlay_capture_state(monitor))
    assert len(sent) == 2
    monitor.target_hwnd = None
    asyncio.run(capture_state.publish_overlay_capture_state(monitor))
    assert len(sent) == 3


def test_manual_scan_and_background_do_not_capture_without_a_target(monkeypatch):
    from GameSentenceMiner.util.overlay import get_overlay_coords

    monkeypatch.setattr(get_overlay_coords, "get_overlay_capture_state", lambda monitor: {"available": False})
    processor = get_overlay_coords.OverlayProcessor.__new__(get_overlay_coords.OverlayProcessor)
    processor.window_monitor = None
    processor._mark_ocr_engine_active = lambda: pytest.fail("OCR must not start without capture")
    processor._capture_full_monitor_mss = lambda: pytest.fail("Desktop must not be captured without a target")
    asyncio.run(processor.find_box_and_send_to_overlay(source=get_overlay_coords.TextSource.HOTKEY))
    asyncio.run(processor.capture_and_send_manual_background())


def test_non_windows_starts_a_capture_monitor(monkeypatch):
    from GameSentenceMiner.util.overlay import get_overlay_coords

    processor = SimpleNamespace()
    monitor = SimpleNamespace(target_hwnd=None)
    monkeypatch.setattr(get_overlay_coords, "overlay_processor", processor)
    monkeypatch.setattr(get_overlay_coords, "is_windows", lambda: False)
    monkeypatch.setattr(get_overlay_coords, "WindowStateMonitor", lambda processor: monitor)
    monkeypatch.setattr(get_overlay_coords, "set_window_state_monitor", lambda monitor: None)
    get_overlay_coords._configure_overlay_processor_for_loop(None)
    assert processor.window_monitor is monitor
