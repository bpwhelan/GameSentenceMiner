import asyncio
import importlib
import json
import sys
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows window coverage")
wwm = (
    importlib.import_module("GameSentenceMiner.util.platform.windows_window_monitor")
    if sys.platform == "win32"
    else None
)


@pytest.fixture
def desktop(monkeypatch):
    windows = [10, 20, 30, 40]
    rects = {10: (0, 0, 1000, 800), 20: (100, 100, 400, 400), 30: (300, 200, 600, 500), 40: (0, 0, 1000, 800)}
    api = SimpleNamespace(
        GetWindow=Mock(side_effect=lambda hwnd, _: windows[windows.index(hwnd) + 1] if hwnd != windows[-1] else 0),
        GetForegroundWindow=lambda: 20,
        IsWindow=lambda hwnd: hwnd in windows,
        IsWindowVisible=lambda hwnd: True,
        IsIconic=lambda hwnd: False,
    )
    monkeypatch.setattr(wwm, "user32", api)
    monkeypatch.setattr(wwm, "get_window_rect_physical", lambda hwnd: rects.get(hwnd))
    monkeypatch.setattr(wwm.WindowsWindowStateMonitor, "_start_event_hooks", lambda self: None)
    monitor = wwm.WindowsWindowStateMonitor(SimpleNamespace(obs_width=None, obs_height=None))
    monkeypatch.setattr(monitor, "_is_overlay_window", lambda hwnd: hwnd == 40)
    monitor.target_hwnd = 10
    return monitor, api, rects


def test_partial_coverage_uses_the_existing_zorder_walk(desktop):
    monitor, api, _ = desktop
    assert not monitor._is_window_obscured(10)
    assert monitor.occlusion_rects == [(100, 100, 400, 400), (300, 200, 600, 500)]
    assert api.GetWindow.call_count == 4


@pytest.mark.parametrize("hidden", ["invisible", "minimized", "overlay"])
def test_non_covering_windows_are_ignored(desktop, hidden):
    monitor, api, _ = desktop
    if hidden == "invisible":
        api.IsWindowVisible = lambda hwnd: hwnd != 20
    elif hidden == "minimized":
        api.IsIconic = lambda hwnd: hwnd == 20
    else:
        monitor._is_overlay_window = lambda hwnd: hwnd in (20, 40)
    assert not monitor._is_window_obscured(10)
    assert monitor.occlusion_rects == [(300, 200, 600, 500)]


def test_full_coverage_preserves_the_existing_padded_test(desktop):
    monitor, _, rects = desktop
    rects[20] = (10, 15, 990, 720)
    assert monitor._is_window_obscured(10)
    assert monitor.occlusion_rects == [(10, 15, 990, 720)]


@pytest.mark.parametrize("focused", [False, True])
def test_coverage_updates_publish_without_rescanning_unchanged_desktop(desktop, monkeypatch, focused):
    monitor, api, rects = desktop
    now = time.time()
    monitor.last_obs_check_time = monitor.last_hwnd_refresh_time = monitor.last_monitor_validation_time = now
    monitor.last_window_rect = rects[10]
    monitor.last_state = "active" if focused else "background"
    expected_state = monitor.last_state
    api.GetForegroundWindow = lambda: 10 if focused else 20
    monitor.last_target_info = {"title": "Game"}
    monitor.last_target_scene_name = "Game"
    sent = []

    async def send(_client, payload):
        sent.append(json.loads(payload))

    monkeypatch.setattr(wwm.websocket_manager, "has_clients", lambda _: True)
    monkeypatch.setattr(wwm.websocket_manager, "send", send)
    monkeypatch.setattr(
        wwm, "get_config", lambda: SimpleNamespace(hotkeys=SimpleNamespace(unmute_target_window_on_focus=False))
    )
    for method in ("_sync_minimized_audio_mute", "_sync_capture_monitor_to_window", "update_magpie_info"):
        monkeypatch.setattr(monitor, method, lambda *args: None)
    for method in ("_is_fullscreen_window", "_is_exclusive_fullscreen", "_is_cursor_hidden"):
        monkeypatch.setattr(monitor, method, lambda *args, **kwargs: False)
    monkeypatch.setattr(monitor, "_build_client_rect_payload", lambda: None)
    reprocess = Mock()
    monkeypatch.setattr(monitor, "_spawn_reprocess_last_results", reprocess)

    asyncio.run(monitor.check_and_send())
    assert len(sent) == 1
    assert sent[-1]["data"] == expected_state
    assert sent[-1]["occlusion_rects"][0]["left"] == 100
    walks = api.GetWindow.call_count
    asyncio.run(monitor.check_and_send())
    assert len(sent) == 1
    assert api.GetWindow.call_count == walks

    rects[20] = (200, 100, 500, 400)
    monitor._zorder_dirty = True
    asyncio.run(monitor.check_and_send())
    assert len(sent) == 2
    assert sent[-1]["data"] == expected_state
    assert sent[-1]["occlusion_rects"][0]["left"] == 200
    reprocess.assert_not_called()

    api.GetForegroundWindow = lambda: 10
    api.GetWindow.side_effect = lambda *_: 0
    monitor._zorder_dirty = True
    asyncio.run(monitor.check_and_send())
    assert sent[-1]["data"] == "active"
    assert sent[-1]["occlusion_rects"] == []


def test_window_events_only_invalidate_top_level_geometry(desktop):
    monitor, _, _ = desktop
    for event in (
        wwm.EVENT_OBJECT_LOCATIONCHANGE,
        wwm.EVENT_OBJECT_SHOW,
        wwm.EVENT_OBJECT_HIDE,
        wwm.EVENT_OBJECT_DESTROY,
    ):
        monitor._zorder_dirty = False
        monitor._on_window_event(event, 20, -4, 0)
        assert not monitor._zorder_dirty
        monitor._on_window_event(event, 20, 0, 0)
        assert monitor._zorder_dirty
    monitor._on_window_event(wwm.EVENT_OBJECT_DESTROY, 10, 0, 0)
    assert monitor._target_destroyed


def test_reset_clears_cached_coverage(desktop):
    monitor, _, _ = desktop
    monitor._is_window_obscured(10)
    monitor._zorder_dirty = False
    monitor._reset_capture_target()
    assert monitor.occlusion_rects == []
    assert monitor._zorder_dirty
