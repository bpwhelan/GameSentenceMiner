from __future__ import annotations

import pytest

from GameSentenceMiner.util.config.configuration import (
    ANIMATED_SCREENSHOT_CODEC_LABELS,
    SCREENSHOT_CAPTURE_BACKENDS,
    Advanced,
    AnimatedScreenshotSettings,
    Screenshot,
)


def test_static_screenshot_defaults_to_avif():
    assert Screenshot().extension == "avif"


def test_animated_screenshot_codec_defaults_to_svt_av1():
    settings = AnimatedScreenshotSettings()

    assert settings.codec == "libsvtav1"


def test_animated_screenshot_codec_round_trip_and_backward_compatibility():
    data = AnimatedScreenshotSettings(codec="libaom-av1").to_dict()

    assert AnimatedScreenshotSettings.from_dict(data).codec == "libaom-av1"

    data_without_codec = dict(data)
    data_without_codec.pop("codec")
    assert AnimatedScreenshotSettings.from_dict(data_without_codec).codec == "libsvtav1"


def test_animated_screenshot_codec_ui_labels():
    assert ANIMATED_SCREENSHOT_CODEC_LABELS == {
        "libsvtav1": "libsvtav1 (fast)",
        "libaom-av1": "libaom-av1 (slow, but higher quality, not recommended)",
    }


def test_animated_screenshot_quality_uses_encoder_specific_av1_scale():
    assert AnimatedScreenshotSettings(codec="libaom-av1", quality=8).scaled_quality == 17
    assert AnimatedScreenshotSettings(codec="libsvtav1", quality=8).scaled_quality == 28


def test_animated_screenshot_avif_options_round_trip():
    settings = AnimatedScreenshotSettings(
        max_width=480,
        adaptive_avif=True,
        faststart=False,
        encoder_fallback=False,
    )
    loaded = AnimatedScreenshotSettings.from_dict(settings.to_dict())

    assert loaded.max_width == 480
    assert loaded.adaptive_avif is True
    assert loaded.faststart is False
    assert loaded.encoder_fallback is False


def test_animated_size_and_voice_defaults_preserve_existing_profiles():
    settings = AnimatedScreenshotSettings.from_dict({"adaptive_avif": True})
    assert settings.target_size_kb == 0
    assert settings.size_priority == "balanced"
    assert settings.only_when_voice is False
    assert settings.adaptive_avif is True


@pytest.mark.parametrize("priority", ["prefer_fps", "prefer_quality", "balanced"])
def test_animated_size_and_voice_options_round_trip(priority):
    settings = AnimatedScreenshotSettings(target_size_kb=500, size_priority=priority, only_when_voice=True)
    loaded = AnimatedScreenshotSettings.from_dict(settings.to_dict())
    assert loaded.target_size_kb == 500
    assert loaded.size_priority == priority
    assert loaded.only_when_voice is True


@pytest.mark.parametrize("target", [-1, None, "bad", float("inf")])
def test_invalid_animated_size_options_use_safe_defaults(target):
    settings = AnimatedScreenshotSettings(target_size_kb=target, size_priority="invalid")
    assert settings.target_size_kb == 0
    assert settings.size_priority == "balanced"


def test_screenshot_capture_backends_expose_wgc_not_legacy_winapi():
    assert SCREENSHOT_CAPTURE_BACKENDS == ("auto", "obs", "wgc")


def test_main_wgc_capture_fps_is_independent_and_clamped():
    assert Advanced(wgc_capture_fps=4).wgc_capture_fps == 4
    assert Advanced(wgc_capture_fps=0).wgc_capture_fps == 1
    assert Advanced(wgc_capture_fps=500).wgc_capture_fps == 60
    assert Advanced(wgc_capture_fps="bad").wgc_capture_fps == 5


def test_direct_websocket_port_is_optional_and_validated():
    assert Advanced().direct_websocket_port == 0
    assert Advanced(direct_websocket_port="8383").direct_websocket_port == 8383
    assert Advanced(direct_websocket_port=-1).direct_websocket_port == 0
    assert Advanced(direct_websocket_port=65536).direct_websocket_port == 0
    assert Advanced(direct_websocket_port="not-a-port").direct_websocket_port == 0
