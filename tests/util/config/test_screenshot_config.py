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
