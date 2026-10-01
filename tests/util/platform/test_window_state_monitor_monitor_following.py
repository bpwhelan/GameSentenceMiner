import asyncio
import importlib
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner.util.platform.monitor_selection import build_monitor_descriptors

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window monitor")
wwm = (
    importlib.import_module("GameSentenceMiner.util.platform.windows_window_monitor")
    if sys.platform == "win32"
    else None
)

MONITORS = [
    {"left": 0, "top": 0, "width": 2560, "height": 1440},
    {"left": 2560, "top": 164, "width": 1920, "height": 1080},
]
GAME_RECT = (2560, 164, 4480, 1244)


@pytest.fixture
def following(monkeypatch):
    monkeypatch.setattr(wwm.WindowsWindowStateMonitor, "_start_event_hooks", lambda self: None)
    monkeypatch.setattr(wwm.time, "time", lambda: 100.0)
    user32 = SimpleNamespace(
        IsIconic=lambda hwnd: False,
        IsWindowVisible=lambda hwnd: True,
        GetForegroundWindow=lambda: 123,
    )
    monkeypatch.setattr(wwm, "user32", user32)
    monkeypatch.setattr(wwm, "get_window_rect_physical", lambda hwnd: GAME_RECT)
    monkeypatch.setattr(wwm.websocket_manager, "has_clients", lambda client: False)
    descriptors = build_monitor_descriptors(MONITORS)

    class Capture:
        def __init__(self):
            self.monitors = [{}, *MONITORS]

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    enumeration = Mock(side_effect=Capture)
    monkeypatch.setattr(wwm, "mss", SimpleNamespace(mss=enumeration))
    selected = descriptors[1]
    overlay = SimpleNamespace(
        monitor_to_capture=selected["index"],
        monitor_to_capture_id=selected["id"],
        monitor_to_capture_bounds=dict(selected["bounds"]),
    )
    monkeypatch.setattr(wwm, "get_overlay_config", lambda: overlay)
    save = Mock()
    monkeypatch.setattr(wwm, "get_master_config", lambda: SimpleNamespace(save=save))
    monitor = wwm.WindowsWindowStateMonitor(SimpleNamespace(obs_width=None, obs_height=None))
    monitor.target_hwnd = 123
    monitor.last_state = "active"
    monitor.last_window_rect = GAME_RECT
    monitor.window_stable_count = 10
    monitor.last_obs_check_time = 100.0
    monitor.last_monitor_validation_time = 100.0
    monitor.last_hwnd_refresh_time = 100.0
    monitor.last_monitor_layout_signature = tuple((m["left"], m["top"], m["width"], m["height"]) for m in MONITORS)
    for method in ("_sync_minimized_audio_mute", "update_magpie_info", "_build_client_rect_payload"):
        monkeypatch.setattr(monitor, method, lambda *args: None)
    for method in ("_is_fullscreen_window", "_is_exclusive_fullscreen", "_is_cursor_hidden"):
        monkeypatch.setattr(monitor, method, lambda *args, **kwargs: False)
    reprocess = Mock()
    monkeypatch.setattr(monitor, "_spawn_reprocess_last_results", reprocess)
    return SimpleNamespace(
        monitor=monitor, overlay=overlay, save=save, reprocess=reprocess, enumeration=enumeration, user32=user32
    )


def test_stationary_game_recovers_monitor_overwritten_by_settings_save(following):
    monitor, overlay = following.monitor, following.overlay
    asyncio.run(monitor.check_and_send())
    following.save.assert_not_called()

    old_monitor = build_monitor_descriptors(MONITORS)[0]
    overlay.monitor_to_capture = old_monitor["index"]
    overlay.monitor_to_capture_id = old_monitor["id"]
    overlay.monitor_to_capture_bounds = dict(old_monitor["bounds"])
    asyncio.run(monitor.check_and_send())

    assert overlay.monitor_to_capture == 1
    assert overlay.monitor_to_capture_id == "bounds:2560:164:1920:1080"
    assert overlay.monitor_to_capture_bounds == MONITORS[1]
    following.save.assert_called_once_with()
    following.reprocess.assert_called_once_with()
    asyncio.run(monitor.check_and_send())
    following.save.assert_called_once_with()


@pytest.mark.parametrize("stale_field", ["monitor_to_capture_id", "monitor_to_capture_bounds"])
def test_correct_index_with_stale_identity_is_repaired(following, stale_field):
    old_monitor = build_monitor_descriptors(MONITORS)[0]
    setattr(following.overlay, stale_field, old_monitor["id" if stale_field.endswith("_id") else "bounds"])
    asyncio.run(following.monitor.check_and_send())

    assert following.overlay.monitor_to_capture == 1
    assert following.overlay.monitor_to_capture_id == "bounds:2560:164:1920:1080"
    assert following.overlay.monitor_to_capture_bounds == MONITORS[1]
    following.save.assert_called_once_with()


def test_waits_for_game_to_settle_before_changing_monitors(following):
    following.monitor.last_window_rect = (0, 0, 1920, 1080)
    following.overlay.monitor_to_capture = 0
    for _ in range(2):
        asyncio.run(following.monitor.check_and_send())
        following.save.assert_not_called()
    asyncio.run(following.monitor.check_and_send())
    assert following.overlay.monitor_to_capture == 1
    following.save.assert_called_once_with()


def test_minimized_game_does_not_change_capture_monitor(following):
    following.user32.IsIconic = lambda hwnd: True
    following.overlay.monitor_to_capture = 0
    asyncio.run(following.monitor.check_and_send())
    assert following.overlay.monitor_to_capture == 0
    following.save.assert_not_called()


def test_stable_monitor_does_not_keep_saving_or_reprocessing(following):
    for _ in range(5):
        asyncio.run(following.monitor.check_and_send())
    following.save.assert_not_called()
    following.reprocess.assert_not_called()
    following.enumeration.assert_not_called()


def test_monitor_reordering_repairs_index_without_moving_game(following):
    following.monitor.last_monitor_layout_signature = tuple(reversed(following.monitor.last_monitor_layout_signature))
    asyncio.run(following.monitor.check_and_send())
    assert following.overlay.monitor_to_capture == 0
    assert following.overlay.monitor_to_capture_id == "bounds:2560:164:1920:1080"
    assert following.overlay.monitor_to_capture_bounds == MONITORS[1]
    following.save.assert_called_once_with()


def test_no_monitor_topology_does_not_replace_selection(following):
    following.monitor.last_monitor_layout_signature = ()
    asyncio.run(following.monitor.check_and_send())
    assert following.overlay.monitor_to_capture == 1
    following.save.assert_not_called()


@pytest.mark.parametrize(
    ("rect", "expected"),
    [
        ((-1900, -850, -100, 150), 0),
        ((-100, 0, 900, 900), 1),
        ((2700, 100, 2900, 900), 1),
        ((0, 0, 0, 900), -1),
    ],
)
def test_monitor_detection_uses_desktop_coordinates(following, rect, expected):
    monitors = [
        {"left": -1920, "top": -900, "width": 1920, "height": 1080},
        MONITORS[0],
    ]
    assert following.monitor._detect_current_monitor(rect, monitors) == expected
