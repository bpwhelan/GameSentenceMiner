import subprocess

import pytest

from GameSentenceMiner.util.media import ffmpeg


def _mock_cropdetect(monkeypatch, dimensions, crop_filter):
    monkeypatch.setattr(ffmpeg, "get_video_dimensions", lambda _video: dimensions)
    monkeypatch.setattr(
        ffmpeg.FFmpegHelper,
        "run",
        lambda command, **_kwargs: subprocess.CompletedProcess(command, 0, stdout="", stderr=crop_filter),
    )


@pytest.mark.parametrize(
    "crop_filter",
    [
        pytest.param("crop=1228:720:26:0", id="screenshot-pillarbox"),
        pytest.param("crop=1280:704:0:8", id="thin-letterbox"),
        pytest.param("crop=1276:716:2:2", id="two-pixel-borders"),
        pytest.param("crop=1278:720:0:0", id="two-pixel-right-border"),
    ],
)
def test_find_black_bars_removes_narrow_borders(monkeypatch, crop_filter):
    _mock_cropdetect(monkeypatch, (1280, 720), crop_filter)

    assert ffmpeg.find_black_bars("source.mp4", 12.5) == crop_filter


@pytest.mark.parametrize(
    "crop_filter",
    [
        pytest.param("crop=1280:720:0:0", id="no-borders"),
        pytest.param("crop=320:180:480:270", id="excessive-area-removal"),
        pytest.param("crop=1280:440:0:140", id="unrecognized-aspect-ratio"),
    ],
)
def test_find_black_bars_skips_unchanged_or_unsafe_crops(monkeypatch, crop_filter):
    _mock_cropdetect(monkeypatch, (1280, 720), crop_filter)

    assert ffmpeg.find_black_bars("source.mp4", 12.5) is None


@pytest.mark.parametrize("original_height", [720, 721])
def test_find_black_bars_preserves_pillarbox_only_crops(monkeypatch, original_height):
    crop_filter = "crop=160:720:560:0"
    _mock_cropdetect(monkeypatch, (1280, original_height), crop_filter)

    assert ffmpeg.find_black_bars("source.mp4", 12.5) == crop_filter
