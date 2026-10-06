import importlib
import sys
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from GameSentenceMiner.util.config.configuration import (
    SCREENSHOT_CAPTURE_BACKEND_OBS,
    SCREENSHOT_CAPTURE_BACKEND_WGC,
    normalize_screenshot_capture_backend,
)
from GameSentenceMiner.obs.screenshot_capture import (
    ScreenshotCapture,
    _WGCCallbackPacer,
    _WGCSession,
    _resolve_output_size,
)
from scripts import benchmark_obs_screenshot_capture as screenshot_benchmark

screenshot_capture_module = importlib.import_module("GameSentenceMiner.obs.screenshot_capture")


def test_resolve_output_size_preserves_source_when_no_dimensions():
    assert _resolve_output_size(1920, 1080) == (1920, 1080)


def test_resolve_output_size_preserves_aspect_ratio_for_single_axis():
    assert _resolve_output_size(1920, 1080, width=1280) == (1280, 720)
    assert _resolve_output_size(1920, 1080, height=720) == (1280, 720)


def test_resolve_output_size_ignores_non_positive_dimensions():
    assert _resolve_output_size(1920, 1080, width=0, height=-1) == (1920, 1080)
    assert _resolve_output_size(3840, 2160, height=1) == (1, 1)


@pytest.fixture
def monitored_capture(monkeypatch):
    from GameSentenceMiner.obs import actions, active_game
    from GameSentenceMiner.util.platform import window_state_monitor

    monitor = SimpleNamespace(
        target_hwnd=101,
        last_target_scene_name="Browser game",
        last_target_info={"source_name": "Browser capture", "exe": "chrome.exe"},
    )
    state = SimpleNamespace(current_scene="Browser game")
    monkeypatch.setattr(window_state_monitor, "get_window_state_monitor", lambda: monitor)
    monkeypatch.setattr(active_game, "get_obs_state", lambda: state)
    monkeypatch.setattr(actions, "get_current_scene", lambda **kwargs: state.current_scene)
    monkeypatch.setattr(
        actions,
        "get_window_info_from_source",
        lambda **kwargs: {"title": "Browser game", "window_class": "Chrome_WidgetWin_1", "exe": "chrome.exe"},
    )
    capture = ScreenshotCapture()
    monkeypatch.setattr(capture, "_is_hwnd_valid", lambda hwnd: True)
    return capture, monitor, state


@pytest.mark.parametrize("source", ["Browser game", "Browser capture"])
def test_wgc_uses_the_shared_browser_target(monitored_capture, source):
    capture, _, _ = monitored_capture
    assert capture._get_hwnd(source) == 101


@pytest.mark.parametrize("change", ["lost", "source", "scene", "desktop", "replaced"])
def test_wgc_does_not_reuse_a_cached_or_independently_guessed_target(monitored_capture, monkeypatch, change):
    capture, monitor, state = monitored_capture
    stopped = []
    monkeypatch.setattr(screenshot_capture_module, "stop_wgc_session", stopped.append)
    assert capture._get_hwnd("Browser capture") == 101
    if change == "lost":
        monitor.target_hwnd = None
    elif change == "source":
        monitor.last_target_info["source_name"] = "Different capture"
    elif change == "scene":
        state.current_scene = "Different scene"
    elif change == "desktop":
        monitor.last_target_info = {}
    else:
        monitor.target_hwnd = 202
    assert capture._get_hwnd("Browser capture") == (202 if change == "replaced" else None)
    assert stopped == [101]


def test_wgc_does_not_capture_the_browser_for_an_unrelated_obs_source(monitored_capture):
    capture, _, _ = monitored_capture
    assert capture._get_hwnd("Desktop capture") is None


def test_unresolved_browser_capture_uses_obs_instead_of_another_window(monitored_capture, monkeypatch):
    capture, monitor, _ = monitored_capture
    monitor.target_hwnd = None
    obs_image = Image.new("RGB", (4, 3))
    monkeypatch.setattr(capture, "_get_configured_capture_backend", lambda: SCREENSHOT_CAPTURE_BACKEND_WGC)
    monkeypatch.setattr(screenshot_capture_module, "is_windows", lambda: True)
    monkeypatch.setattr(capture, "_find_hwnd", lambda *args: pytest.fail("Must not guess another browser HWND"))
    monkeypatch.setattr(capture, "_capture_obs", lambda *args: obs_image)
    assert capture.capture("Browser capture") is obs_image


def test_shared_target_retries_wgc_after_failure_backoff(monitored_capture, monkeypatch):
    capture, _, _ = monitored_capture
    monkeypatch.setattr(screenshot_capture_module, "is_windows", lambda: True)
    monkeypatch.setattr(screenshot_capture_module.time, "monotonic", lambda: 100.0)
    assert capture._should_use_wgc("Browser capture") is True
    capture._wgc_failed_count = capture._wgc_max_consecutive_failures
    assert capture._should_use_wgc("Browser capture") is False
    monkeypatch.setattr(
        screenshot_capture_module.time, "monotonic", lambda: 100.0 + screenshot_capture_module._HWND_CACHE_TTL
    )
    assert capture._should_use_wgc("Browser capture") is True


def test_wgc_callback_pacer_compensates_for_native_delivery_lag(monkeypatch):
    clock = iter([10.005, 10.050, 10.068, 10.083])
    monkeypatch.setattr(screenshot_capture_module.time, "perf_counter", lambda: next(clock))
    pacer = _WGCCallbackPacer(20)
    waits = []
    monkeypatch.setattr(pacer._stop_event, "wait", lambda seconds: waits.append(seconds))

    pacer.wait_after_frame(10.000)
    pacer.wait_after_frame(10.067)

    assert waits == [pytest.approx(0.045), pytest.approx(0.015)]


def test_wgc_session_paces_after_publishing_outside_frame_lock(monkeypatch):
    captures = []

    class FakeControl:
        def is_finished(self):
            return False

        def stop(self):
            return None

    class FakeWindowsCapture:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            captures.append(self)

        def event(self, handler):
            setattr(self, handler.__name__, handler)
            return handler

        def start_free_threaded(self):
            return FakeControl()

    fake_module = SimpleNamespace(
        WindowsCapture=FakeWindowsCapture,
        Frame=object,
        InternalCaptureControl=object,
    )
    monkeypatch.setitem(sys.modules, "windows_capture", fake_module)
    session = _WGCSession(123, fps=20)
    clock = iter([10.000, 10.005, 10.050])
    monkeypatch.setattr(screenshot_capture_module.time, "perf_counter", lambda: next(clock))
    waits = []

    def wait_outside_frame_lock(seconds):
        assert session._ready.is_set()
        assert session._lock.acquire(blocking=False)
        session._lock.release()
        waits.append(seconds)

    monkeypatch.setattr(session._pacer._stop_event, "wait", wait_outside_frame_lock)
    frame_buffer = np.zeros((2, 3, 4), dtype=np.uint8)
    captures[0].on_frame_arrived(
        SimpleNamespace(frame_buffer=frame_buffer, width=3, height=2),
        None,
    )

    captured_buffer, width, height = session.grab(timeout=0)

    assert "minimum_update_interval" not in captures[0].kwargs
    assert waits == [pytest.approx(0.045)]
    assert (width, height) == (3, 2)
    assert np.array_equal(captured_buffer, frame_buffer)
    assert captured_buffer is not frame_buffer


def test_wgc_session_cache_restarts_when_fps_changes(monkeypatch):
    created = []

    class FakeSession:
        def __init__(self, hwnd, *, include_cursor=False, draw_border=False, fps):
            self.hwnd = hwnd
            self.fps = fps
            self.include_cursor = include_cursor
            self.draw_border = draw_border
            self.alive = True
            self.stopped = False
            created.append(self)

        def stop(self):
            self.stopped = True
            self.alive = False

    monkeypatch.setattr(screenshot_capture_module, "_WGCSession", FakeSession)
    screenshot_capture_module._wgc_sessions.clear()

    first = screenshot_capture_module._get_wgc_session(123, fps=5)
    assert screenshot_capture_module._get_wgc_session(123, fps=5) is first
    second = screenshot_capture_module._get_wgc_session(123, fps=12)

    assert second is not first
    assert first.stopped is True
    assert [session.fps for session in created] == [5, 12]

    screenshot_capture_module._wgc_sessions.clear()


def test_capture_passes_requested_dimensions_and_fps_to_wgc(monkeypatch):
    capture = ScreenshotCapture()
    image = Image.new("RGB", (640, 360))
    calls = []

    monkeypatch.setattr(capture, "_get_configured_capture_backend", lambda: SCREENSHOT_CAPTURE_BACKEND_WGC)
    monkeypatch.setattr(capture, "_should_use_wgc", lambda source_name: source_name == "Game Source")
    monkeypatch.setattr(
        capture,
        "_capture_windows",
        lambda *, width=None, height=None, fps=None: calls.append((width, height, fps)) or image,
    )

    def fail_resize(*_args, **_kwargs):
        raise AssertionError("WGC captures should be scaled before Pillow sees the image")

    monkeypatch.setattr(capture, "_resize", fail_resize)

    result = capture.capture("Game Source", width=640, height=360, capture_fps=12)

    assert result is image
    assert calls == [(640, 360, 12)]


def test_capture_falls_back_to_obs_after_wgc_failure(monkeypatch):
    capture = ScreenshotCapture()
    fallback_image = Image.new("RGB", (640, 360))
    obs_calls = []

    monkeypatch.setattr(capture, "_get_configured_capture_backend", lambda: SCREENSHOT_CAPTURE_BACKEND_WGC)
    monkeypatch.setattr(capture, "_should_use_wgc", lambda _source_name: True)
    monkeypatch.setattr(capture, "_capture_windows", lambda *, width=None, height=None, fps=None: None)

    def fake_capture_obs(source_name, compression, img_format, width, height, retry):
        obs_calls.append((source_name, compression, img_format, width, height, retry))
        return fallback_image

    monkeypatch.setattr(capture, "_capture_obs", fake_capture_obs)

    result = capture.capture("Game Source", compression=90, img_format="jpg", width=640, height=360, retry=2)

    assert result is fallback_image
    assert capture._wgc_failed_count == 1
    assert obs_calls == [("Game Source", 90, "jpg", 640, 360, 2)]


def test_capture_configured_obs_backend_skips_wgc(monkeypatch):
    capture = ScreenshotCapture()
    fallback_image = Image.new("RGB", (640, 360))
    obs_calls = []

    monkeypatch.setattr(
        screenshot_capture_module,
        "get_config",
        lambda: SimpleNamespace(advanced=SimpleNamespace(screenshot_capture_backend_v2=SCREENSHOT_CAPTURE_BACKEND_OBS)),
    )
    monkeypatch.setattr(
        capture,
        "_should_use_wgc",
        lambda _source_name: (_ for _ in ()).throw(AssertionError("WGC should not be checked")),
    )

    def fake_capture_obs(source_name, compression, img_format, width, height, retry):
        obs_calls.append((source_name, compression, img_format, width, height, retry))
        return fallback_image

    monkeypatch.setattr(capture, "_capture_obs", fake_capture_obs)

    result = capture.capture("Game Source", compression=90, img_format="jpg", width=640, height=360, retry=2)

    assert result is fallback_image
    assert obs_calls == [("Game Source", 90, "jpg", 640, 360, 2)]


def test_capture_wgc_unavailable_marks_backend_unavailable(monkeypatch):
    capture = ScreenshotCapture()
    capture._hwnd = 123

    def fail_capture(*_args, **_kwargs):
        raise screenshot_capture_module.WinGraphicsCaptureUnavailable("missing windows-capture")

    monkeypatch.setattr(screenshot_capture_module, "_capture_hwnd_windows_graphics_capture", fail_capture)

    assert capture._capture_windows(width=640, height=360, fps=10) is None
    assert capture._wgc_available is False


def test_normalize_screenshot_capture_backend_aliases_invalid_to_auto():
    assert normalize_screenshot_capture_backend("obs-websocket") == "obs"
    assert normalize_screenshot_capture_backend("winapi") == "wgc"
    assert normalize_screenshot_capture_backend("unknown") == "auto"


def test_benchmark_build_configs_includes_wgc_resolutions():
    args = SimpleNamespace(
        widths=[1280, 1920],
        heights=[720, 1080],
        formats=["jpg"],
        compressions=[90],
        preprocess_modes=["none"],
    )

    configs = screenshot_benchmark.build_configs(
        args,
        [screenshot_benchmark.CaptureMethod.WGC, screenshot_benchmark.CaptureMethod.OBS_SOURCE],
    )

    wgc_configs = [config for config in configs if config.method == screenshot_benchmark.CaptureMethod.WGC]
    assert [(config.width, config.height, config.label) for config in wgc_configs] == [
        (1280, 720, "wgc 1280x720"),
        (1920, 1080, "wgc 1920x1080"),
    ]


def test_benchmark_wgc_capture_uses_config_dimensions(monkeypatch):
    image = Image.new("RGB", (640, 360))
    calls = []

    monkeypatch.setattr(
        screenshot_benchmark,
        "_do_wgc_capture",
        lambda hwnd, width=None, height=None: calls.append((hwnd, width, height)) or image,
    )

    config = screenshot_benchmark.CaptureConfig(
        method=screenshot_benchmark.CaptureMethod.WGC,
        width=640,
        height=360,
    )
    _elapsed, size, nbytes = screenshot_benchmark.capture_once(config, window_handle=123)

    assert calls == [(123, 640, 360)]
    assert size == (640, 360)
    assert nbytes > 0
