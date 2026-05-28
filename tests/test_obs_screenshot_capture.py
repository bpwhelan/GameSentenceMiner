import importlib
from types import SimpleNamespace

from PIL import Image

from GameSentenceMiner.util.config.configuration import (
    SCREENSHOT_CAPTURE_BACKEND_OBS,
    normalize_screenshot_capture_backend,
)
from GameSentenceMiner.obs.screenshot_capture import ScreenshotCapture, _resolve_output_size
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


def test_capture_passes_requested_dimensions_to_winapi(monkeypatch):
    capture = ScreenshotCapture()
    image = Image.new("RGB", (640, 360))
    calls = []

    monkeypatch.setattr(capture, "_should_use_winapi", lambda source_name: source_name == "Game Source")
    monkeypatch.setattr(
        capture,
        "_capture_winapi",
        lambda *, width=None, height=None: calls.append((width, height)) or image,
    )

    def fail_resize(*_args, **_kwargs):
        raise AssertionError("WinAPI captures should be scaled before Pillow sees the image")

    monkeypatch.setattr(capture, "_resize", fail_resize)

    result = capture.capture("Game Source", width=640, height=360)

    assert result is image
    assert calls == [(640, 360)]


def test_capture_falls_back_to_obs_after_winapi_failure(monkeypatch):
    capture = ScreenshotCapture()
    fallback_image = Image.new("RGB", (640, 360))
    obs_calls = []

    monkeypatch.setattr(capture, "_should_use_winapi", lambda _source_name: True)
    monkeypatch.setattr(capture, "_capture_winapi", lambda *, width=None, height=None: None)

    def fake_capture_obs(source_name, compression, img_format, width, height, retry):
        obs_calls.append((source_name, compression, img_format, width, height, retry))
        return fallback_image

    monkeypatch.setattr(capture, "_capture_obs", fake_capture_obs)

    result = capture.capture("Game Source", compression=90, img_format="jpg", width=640, height=360, retry=2)

    assert result is fallback_image
    assert capture._winapi_failed_count == 1
    assert obs_calls == [("Game Source", 90, "jpg", 640, 360, 2)]


def test_capture_configured_obs_backend_skips_winapi(monkeypatch):
    capture = ScreenshotCapture()
    fallback_image = Image.new("RGB", (640, 360))
    obs_calls = []

    monkeypatch.setattr(
        screenshot_capture_module,
        "get_config",
        lambda: SimpleNamespace(screenshot=SimpleNamespace(capture_backend=SCREENSHOT_CAPTURE_BACKEND_OBS)),
    )
    monkeypatch.setattr(
        capture,
        "_should_use_winapi",
        lambda _source_name: (_ for _ in ()).throw(AssertionError("WinAPI should not be checked")),
    )

    def fake_capture_obs(source_name, compression, img_format, width, height, retry):
        obs_calls.append((source_name, compression, img_format, width, height, retry))
        return fallback_image

    monkeypatch.setattr(capture, "_capture_obs", fake_capture_obs)

    result = capture.capture("Game Source", compression=90, img_format="jpg", width=640, height=360, retry=2)

    assert result is fallback_image
    assert obs_calls == [("Game Source", 90, "jpg", 640, 360, 2)]


def test_capture_winapi_unavailable_marks_backend_unavailable(monkeypatch):
    capture = ScreenshotCapture()
    capture._hwnd = 123

    def fail_capture(*_args, **_kwargs):
        raise screenshot_capture_module.WinAPICaptureUnavailable("missing pywin32")

    monkeypatch.setattr(screenshot_capture_module, "_capture_hwnd_winapi", fail_capture)

    assert capture._capture_winapi(width=640, height=360) is None
    assert capture._winapi_available is False


def test_normalize_screenshot_capture_backend_aliases_invalid_to_auto():
    assert normalize_screenshot_capture_backend("obs-websocket") == "obs"
    assert normalize_screenshot_capture_backend("PrintWindow") == "winapi"
    assert normalize_screenshot_capture_backend("unknown") == "auto"


def test_benchmark_build_configs_includes_winapi_resolutions():
    args = SimpleNamespace(
        widths=[1280, 1920],
        heights=[720, 1080],
        formats=["jpg"],
        compressions=[90],
        preprocess_modes=["none"],
    )

    configs = screenshot_benchmark.build_configs(
        args,
        [screenshot_benchmark.CaptureMethod.WINAPI, screenshot_benchmark.CaptureMethod.OBS_SOURCE],
    )

    winapi_configs = [config for config in configs if config.method == screenshot_benchmark.CaptureMethod.WINAPI]
    assert [(config.width, config.height, config.label) for config in winapi_configs] == [
        (1280, 720, "winapi 1280x720"),
        (1920, 1080, "winapi 1920x1080"),
    ]


def test_benchmark_winapi_capture_uses_config_dimensions(monkeypatch):
    image = Image.new("RGB", (640, 360))
    calls = []

    monkeypatch.setattr(
        screenshot_benchmark,
        "_do_winapi_capture",
        lambda hwnd, width=None, height=None: calls.append((hwnd, width, height)) or image,
    )

    config = screenshot_benchmark.CaptureConfig(
        method=screenshot_benchmark.CaptureMethod.WINAPI,
        width=640,
        height=360,
    )
    _elapsed, size, nbytes = screenshot_benchmark.capture_once(config, window_handle=123)

    assert calls == [(123, 640, 360)]
    assert size == (640, 360)
    assert nbytes > 0
