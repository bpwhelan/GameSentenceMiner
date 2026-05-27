from __future__ import annotations

from GameSentenceMiner.util.config.configuration import (
    ANIMATED_SCREENSHOT_CODEC_LABELS,
    AnimatedScreenshotSettings,
)


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
