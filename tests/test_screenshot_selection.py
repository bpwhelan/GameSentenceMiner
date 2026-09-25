from pathlib import Path
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.media.screenshot_selection import (
    ScreenshotChoice,
    ScreenshotMedia,
    ScreenshotSelectionResult,
    export_choices,
)


def test_frame_identity_distinguishes_similar_frames_but_not_decode_rounding():
    first = ScreenshotChoice(2.0, "a.png")
    similar_later = ScreenshotChoice(2.1, "a.png")
    assert first.key() != similar_later.key()
    # Two seeks into one decoded frame can differ by a few microseconds.
    assert ScreenshotChoice(1.300019, "a.png").key() == ScreenshotChoice(1.300039, "b.png").key()


@pytest.mark.parametrize("position", [-0.1, 6])
def test_export_rejects_frames_outside_recording(tmp_path, position):
    raw = tmp_path / "chosen.png"
    raw.write_bytes(b"raw")
    with pytest.raises(ValueError, match="unavailable"):
        export_choices("recording.mp4", (ScreenshotChoice(position, str(raw)),), 5)


def test_export_stills_in_selection_order_using_static_settings(tmp_path, monkeypatch):
    from GameSentenceMiner.util.config import configuration
    from GameSentenceMiner.util.media import ffmpeg

    raw = tmp_path / "chosen.png"
    raw.write_bytes(b"raw")
    calls = []

    def encode(path, **kwargs):
        calls.append(("still", path, kwargs))
        output = Path(kwargs["output_path"])
        output.write_bytes(b"still")
        return output

    monkeypatch.setattr(ffmpeg, "encode_screenshot", encode)
    monkeypatch.setattr(configuration, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(
        configuration,
        "get_config",
        lambda: SimpleNamespace(screenshot=SimpleNamespace(extension="avif")),
    )
    choices = (
        ScreenshotChoice(4.0, str(raw)),
        ScreenshotChoice(1.0, str(raw)),
        ScreenshotChoice(3.0, str(raw)),
    )
    result = export_choices("recording.mp4", choices, 10.0)
    assert [item.start for item in result.items] == [4.0, 1.0, 3.0]
    assert len({item.path for item in result.items}) == 3
    assert all(call[2]["already_processed"] is True for call in calls)


def test_export_failure_discards_previous_outputs(tmp_path, monkeypatch):
    from GameSentenceMiner.util.media import ffmpeg

    raw = tmp_path / "chosen.png"
    raw.write_bytes(b"raw")
    first_output = tmp_path / "first.avif"

    def encode(*args, **kwargs):
        if first_output.exists():
            raise RuntimeError("encoder unavailable")
        first_output.write_bytes(b"first")
        return first_output

    monkeypatch.setattr(ffmpeg, "encode_screenshot", encode)
    with pytest.raises(RuntimeError, match="encoder unavailable"):
        export_choices(
            "recording.mp4",
            (ScreenshotChoice(1, str(raw)), ScreenshotChoice(2, str(raw))),
            10,
        )
    assert not first_output.exists()


def test_cancelled_export_creates_no_result(tmp_path):
    raw = tmp_path / "chosen.png"
    raw.write_bytes(b"raw")
    with pytest.raises(RuntimeError, match="cancelled"):
        export_choices("recording.mp4", (ScreenshotChoice(1, str(raw)),), 10, lambda: True)


def test_result_rejects_empty_or_missing_paths():
    with pytest.raises(ValueError):
        ScreenshotSelectionResult("recording.mp4", ())
    with pytest.raises(ValueError):
        ScreenshotSelectionResult("recording.mp4", (ScreenshotMedia("", 1),))


def test_ffmpeg_selector_handoff_keeps_collection_and_cancellation(monkeypatch):
    from GameSentenceMiner.util.media import ffmpeg

    selected = ScreenshotSelectionResult(
        "recording.mp4",
        (ScreenshotMedia("first.avif", 1), ScreenshotMedia("second.avif", 2)),
    )
    monkeypatch.setattr(ffmpeg, "call_frame_extractor", lambda **kwargs: selected)
    assert ffmpeg.get_screenshot("recording.mp4", 2, try_selector=True) is selected
    assert ffmpeg.get_raw_screenshot("recording.mp4", 2, try_selector=True) is selected
    monkeypatch.setattr(ffmpeg, "call_frame_extractor", lambda **kwargs: None)
    assert ffmpeg.get_screenshot("recording.mp4", 2, try_selector=True) is None
    assert ffmpeg.get_raw_screenshot("recording.mp4", 2, try_selector=True) is None
    requested = []
    monkeypatch.setattr(ffmpeg, "call_frame_extractor", lambda **kwargs: requested.append(kwargs["timestamp"]))
    ffmpeg.get_screenshot("recording.mp4", 0, try_selector=True)
    assert requested == [0]
