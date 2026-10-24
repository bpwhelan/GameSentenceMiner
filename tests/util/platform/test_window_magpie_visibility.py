"""Magpie's displayed image and its input/capture source have different z-orders."""

import asyncio
import importlib
import sys
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows Magpie integration")
wwm = (
    importlib.import_module("GameSentenceMiner.util.platform.windows_window_monitor")
    if sys.platform == "win32"
    else None
)


@pytest.fixture
def desktop(monkeypatch):
    # Bottom to top: source, an app covering the source, Magpie, another monitor.
    order = [10, 20, 40, 30]
    rects = {10: (300, 200, 1300, 800), 20: (200, 100, 1400, 850), 40: (0, 0, 1600, 1000), 30: (1700, 0, 1900, 200)}
    info = {
        "source_hwnd": 10,
        "scaling_hwnd": 40,
        "windowed": False,
        **{
            f"{prefix}{edge}EdgePosition": value
            for prefix, rect in (("sourceWindow", rects[10]), ("magpieWindow", (0, 50, 1600, 950)))
            for edge, value in zip(("Left", "Top", "Right", "Bottom"), rect)
        },
    }
    state = SimpleNamespace(info=info, foreground=20, order=order, rects=rects)
    api = SimpleNamespace(
        GetWindow=Mock(
            side_effect=lambda hwnd, relation: (
                0 if relation == 4 else (state.order[state.order.index(hwnd) + 1] if hwnd != state.order[-1] else 0)
            )
        ),
        GetForegroundWindow=Mock(side_effect=lambda: state.foreground),
        GetWindowLongW=Mock(return_value=0),
        IsWindow=lambda hwnd: hwnd in state.order,
        IsWindowVisible=lambda hwnd: hwnd in state.order,
        IsIconic=lambda hwnd: False,
        SetWindowPos=Mock(return_value=True),
    )
    monkeypatch.setattr(wwm, "user32", api)
    monkeypatch.setattr(wwm, "get_window_rect_physical", lambda hwnd: rects.get(hwnd))
    monkeypatch.setattr(wwm, "get_magpie_info", lambda hwnd: state.info)
    monkeypatch.setattr(wwm.WindowsWindowStateMonitor, "_start_event_hooks", lambda self: None)
    monitor = wwm.WindowsWindowStateMonitor(SimpleNamespace(obs_width=None, obs_height=None))
    monitor.target_hwnd = 10
    monitor.last_target_info = {"title": "Game"}
    monitor.last_target_scene_name = "Game"
    monitor.last_obs_check_time = monitor.last_hwnd_refresh_time = monitor.last_monitor_validation_time = time.time()
    monitor.last_window_rect = rects[10]
    monkeypatch.setattr(monitor, "_is_overlay_window", lambda hwnd: hwnd == 40)
    for name in ("_sync_minimized_audio_mute", "_sync_capture_monitor_to_window", "_spawn_reprocess_last_results"):
        monkeypatch.setattr(monitor, name, Mock())
    monkeypatch.setattr(monitor, "_build_client_rect_payload", lambda: None)
    monkeypatch.setattr(monitor, "_is_fullscreen_window", Mock(side_effect=lambda hwnd: hwnd == 40))
    monkeypatch.setattr(monitor, "_is_exclusive_fullscreen", Mock(return_value=True))
    monkeypatch.setattr(monitor, "_is_cursor_hidden", lambda: False)
    monkeypatch.setattr(wwm.websocket_manager, "has_clients", lambda _: False)
    monkeypatch.setattr(
        wwm, "get_config", lambda: SimpleNamespace(hotkeys=SimpleNamespace(unmute_target_window_on_focus=False))
    )
    return monitor, state, api


def check(monitor):
    asyncio.run(monitor.check_and_send())
    return monitor.last_window_state_payload


def test_hidden_source_does_not_hide_visible_magpie_image(desktop):
    monitor, state, api = desktop
    payload = check(monitor)
    assert payload["data"] == "background"
    assert payload["is_fullscreen"] is True
    assert payload["target_hwnd"] == 10
    assert payload["target_window_rect"] == {
        "left": 300,
        "top": 200,
        "right": 1300,
        "bottom": 800,
        "width": 1000,
        "height": 600,
    }
    assert monitor.occlusion_rects == [state.rects[30]]
    api.SetWindowPos.assert_not_called()  # An unrelated app owns focus.


def test_app_covering_only_source_sized_area_is_partial_coverage(desktop):
    monitor, state, _ = desktop
    state.order[:] = [10, 40, 20, 30]
    assert check(monitor)["data"] == "background"
    assert monitor.occlusion_rects == [state.rects[20], state.rects[30]]


def test_covering_scaled_image_hides_even_when_letterbox_is_uncovered(desktop):
    monitor, state, _ = desktop
    state.order[:] = [10, 40, 20, 30]
    state.rects[20] = (0, 50, 1600, 950)
    assert check(monitor)["data"] == "obscured"


def test_scaling_start_move_and_stop_invalidate_cached_coverage(desktop):
    monitor, state, _ = desktop
    info = state.info
    state.info = None
    assert check(monitor)["data"] == "obscured"
    state.info = info
    assert not monitor._zorder_dirty
    assert check(monitor)["data"] == "background"
    # A destination-only movement matters even without a desktop WinEvent.
    state.info = dict(
        info,
        magpieWindowLeftEdgePosition=1700,
        magpieWindowRightEdgePosition=1900,
        magpieWindowTopEdgePosition=0,
        magpieWindowBottomEdgePosition=200,
    )
    assert check(monitor)["data"] == "obscured"
    state.info = None
    assert check(monitor)["data"] == "obscured"
    assert monitor.occlusion_rects == [state.rects[20]]


def test_scaled_fullscreen_does_not_become_exclusive_game_fullscreen(desktop):
    monitor, state, _ = desktop
    state.foreground = 10
    assert check(monitor)["is_fullscreen"] is True
    assert check(monitor)["is_exclusive_fullscreen"] is False
    monitor._is_exclusive_fullscreen.assert_not_called()


def test_windowed_scaling_uses_scaling_window_for_fullscreen_check(desktop, monkeypatch):
    monitor, state, _ = desktop
    state.info["windowed"] = True
    fullscreen = Mock(side_effect=lambda hwnd: hwnd == 10)
    monkeypatch.setattr(monitor, "_is_fullscreen_window", fullscreen)
    assert check(monitor)["is_fullscreen"] is False
    fullscreen.assert_called_once_with(40)


def test_unchanged_magpie_session_reuses_coverage_walk(desktop):
    monitor, _, api = desktop
    check(monitor)
    walks = api.GetWindow.call_count
    check(monitor)
    assert api.GetWindow.call_count == walks


def test_source_never_masks_its_own_scaled_image(desktop):
    monitor, state, _ = desktop
    state.order[:] = [40, 10, 30]
    assert check(monitor)["data"] == "background"
    assert monitor.occlusion_rects == [state.rects[30]]


def test_repair_raises_only_focused_source_without_changing_size_position_or_activation(desktop):
    monitor, state, api = desktop
    state.foreground = 10
    check(monitor)
    api.SetWindowPos.assert_called_once_with(10, wwm.HWND_TOP, 0, 0, 0, 0, 0x4213)
    assert monitor.occlusion_rects == [state.rects[30]]
    # Repeated reorders must not produce an endless retry if Windows refuses.
    monitor._zorder_dirty = True
    check(monitor)
    api.SetWindowPos.assert_called_once()
    state.order[:] = [10, 40, 20, 30]
    monitor._zorder_dirty = True
    check(monitor)
    state.order[:] = [10, 20, 40, 30]
    monitor._zorder_dirty = True
    check(monitor)
    assert api.SetWindowPos.call_count == 2


@pytest.mark.parametrize(
    "condition",
    [
        "other-focus",
        "hidden-source",
        "minimized-source",
        "hidden-scaling",
        "own-dialog",
        "topmost-blocker",
        "scaling-behind-source",
        "no-overlap",
    ],
)
def test_repair_leaves_intentional_or_unsafe_window_order_alone(desktop, condition):
    monitor, state, api = desktop
    state.foreground = 10
    monitor.magpie_info = state.info
    if condition == "other-focus":
        state.foreground = 20
    elif condition.startswith("hidden-"):
        hidden = 10 if condition == "hidden-source" else 40
        api.IsWindowVisible = lambda hwnd: hwnd != hidden
    elif condition == "minimized-source":
        api.IsIconic = lambda hwnd: hwnd == 10
    elif condition == "own-dialog":
        original = api.GetWindow.side_effect
        api.GetWindow.side_effect = lambda hwnd, relation: (
            10 if hwnd == 20 and relation == 4 else original(hwnd, relation)
        )
    elif condition == "topmost-blocker":
        api.GetWindowLongW.side_effect = lambda hwnd, _: 8 if hwnd == 20 else 0
    elif condition == "scaling-behind-source":
        state.order[:] = [40, 10, 20, 30]
    elif condition == "no-overlap":
        state.rects[20] = (1700, 300, 1900, 500)
    monitor._repair_magpie_source_zorder()
    api.SetWindowPos.assert_not_called()


@pytest.mark.parametrize("changed", ["focus", "session", "geometry"])
def test_repair_revalidates_before_touching_source(desktop, monkeypatch, changed):
    monitor, state, api = desktop
    state.foreground = 10
    monitor.magpie_info = state.info
    if changed == "focus":
        api.GetForegroundWindow.side_effect = [10, 20]
    elif changed == "session":
        monkeypatch.setattr(wwm, "get_magpie_info", lambda hwnd: None)
    else:
        rects = Mock(side_effect=lambda hwnd: state.rects[hwnd])

        def changing_rect(hwnd):
            rect = rects(hwnd)
            return (500, 500, 1000, 1000) if hwnd == 10 and rects.call_count > 1 else rect

        monkeypatch.setattr(wwm, "get_window_rect_physical", changing_rect)
    monitor._repair_magpie_source_zorder()
    api.SetWindowPos.assert_not_called()


def test_native_repair_preserves_focus_geometry_and_non_topmost_style(monkeypatch):
    """Exercise SetWindowPos on owned, off-screen fixtures, never the user's game."""
    import ctypes
    from ctypes import wintypes

    native = ctypes.windll.user32
    create = native.CreateWindowExW
    create.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        ctypes.c_void_p,
    ]
    create.restype = wintypes.HWND
    native.DestroyWindow.argtypes = [wintypes.HWND]
    native.DestroyWindow.restype = wintypes.BOOL
    # Place every fixture beyond the whole virtual desktop; NOACTIVATE also
    # prevents creating or reordering these windows from changing keyboard focus.
    x = native.GetSystemMetrics(76) + native.GetSystemMetrics(78) + 500
    y = native.GetSystemMetrics(77) + native.GetSystemMetrics(79) + 500
    windows = []
    foreground = native.GetForegroundWindow()
    try:
        for label in ("source", "blocker", "scaling", "overlay"):
            owner = windows[0] if label == "scaling" else None
            hwnd = create(
                0x08000080 | (8 if label in ("scaling", "overlay") else 0),
                "STATIC",
                f"GSM Magpie test {label}",
                0x90000000,
                x,
                y,
                100,
                100,
                owner,
                None,
                None,
                None,
            )
            assert hwnd
            windows.append(hwnd)
        source, blocker, scaling, overlay = windows
        # Creating the owned scaling window can also raise its owner. Simulate
        # the later non-activating app reorder that causes the real separation.
        assert native.SetWindowPos(blocker, 0, 0, 0, 0, 0, 0x213)

        def rect(hwnd):
            value = wintypes.RECT()
            assert native.GetWindowRect(hwnd, ctypes.byref(value))
            return value.left, value.top, value.right, value.bottom

        def above(hwnd):
            result = []
            hwnd = native.GetWindow(hwnd, 3)
            while hwnd and hwnd not in result and len(result) < 1000:
                result.append(hwnd)
                hwnd = native.GetWindow(hwnd, 3)
            return result

        assert blocker in above(source)
        assert scaling in above(blocker)
        assert overlay in above(scaling)
        original_rect = rect(source)
        original_style = native.GetWindowLongW(source, -20)
        monitor = wwm.WindowsWindowStateMonitor.__new__(wwm.WindowsWindowStateMonitor)
        monitor.target_hwnd = source
        monitor.magpie_info = {"source_hwnd": source, "scaling_hwnd": scaling}
        monitor._is_overlay_window = lambda hwnd: hwnd == scaling
        # Only the policy's foreground observation is simulated. All window
        # inspection and the actual reorder use Win32; real focus must not move.
        api = SimpleNamespace(
            **{
                name: getattr(native, name)
                for name in ("GetWindow", "IsWindowVisible", "IsIconic", "GetWindowLongW", "SetWindowPos")
            },
            GetForegroundWindow=lambda: source,
        )
        monkeypatch.setattr(wwm, "user32", api)
        monkeypatch.setattr(wwm, "get_window_rect_physical", rect)
        monkeypatch.setattr(wwm, "get_magpie_info", lambda hwnd: monitor.magpie_info)
        assert monitor._repair_magpie_source_zorder()
        assert blocker not in above(source)
        assert scaling in above(source)
        assert overlay in above(scaling), "Source repair must leave GSM above Magpie"
        assert rect(source) == original_rect
        assert native.GetWindowLongW(source, -20) == original_style
        assert native.GetForegroundWindow() == foreground
    finally:
        for hwnd in reversed(windows):
            native.DestroyWindow(hwnd)
