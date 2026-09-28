import os
import shutil
import subprocess
from datetime import datetime, timedelta
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile

from GameSentenceMiner.util.media import ffmpeg, pause_history

requires_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg/ffprobe not available"
)

SR = 48000
# A replay saved moments ago, so its pauses are still in the history. GSM line times are naive local time.
END = datetime.now().replace(microsecond=0) - timedelta(seconds=30)  # noqa: DTZ005


@pytest.fixture(autouse=True)
def history(tmp_path):
    pause_history._reset_for_tests(tmp_path / "process_pause_history.json")
    yield
    pause_history._reset_for_tests()


def _replay_with_pause(tmp_path, seconds=12.0, pause=(4.0, 7.0)):
    """AAC replay, like OBS writes: noise with exact digital silence while the game was paused."""
    rng = np.random.default_rng(0)
    samples = (rng.standard_normal((int(seconds * SR), 2)) * 0.1).astype(np.float32)
    samples[int(pause[0] * SR) : int(pause[1] * SR)] = 0
    wav = tmp_path / "source.wav"
    soundfile.write(wav, samples, SR)
    replay = tmp_path / "replay.mkv"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-c:a", "aac", "-b:a", "192k", str(replay)], check=True
    )
    os.utime(replay, (END.timestamp(), END.timestamp()))
    return replay, ffmpeg.get_video_duration(str(replay))


def _record_pause(replay_length, offset, duration):
    start = END.timestamp() - replay_length + offset
    pause_history.record_pause(start, start + duration)


@requires_ffmpeg
def test_extracts_audio_without_the_recorded_pause(tmp_path):
    replay, length = _replay_with_pause(tmp_path)
    _record_pause(length, offset=3.2, duration=3.0)  # logged ~0.8s early, as replay save latency makes it
    output = tmp_path / "untrimmed.opus"

    timeline = ffmpeg.extract_audio_without_pauses(str(replay), str(output), END)

    assert timeline is not None
    assert timeline.removed_seconds == pytest.approx(3.0, abs=0.05)
    assert ffmpeg.get_audio_length(str(output)) == pytest.approx(length - timeline.removed_seconds, abs=0.05)


@requires_ffmpeg
def test_leaves_extraction_to_the_caller_without_a_matching_pause(tmp_path):
    replay, length = _replay_with_pause(tmp_path)
    output = tmp_path / "untrimmed.opus"

    assert ffmpeg.extract_audio_without_pauses(str(replay), str(output), END) is None
    _record_pause(length, offset=4.0, duration=6.0)  # the audio kept playing for half of it: not this silence
    assert ffmpeg.extract_audio_without_pauses(str(replay), str(output), END) is None
    assert not output.exists()


@requires_ffmpeg
def test_line_trim_lands_on_the_same_audio_after_pause_removal(tmp_path, monkeypatch):
    replay, length = _replay_with_pause(tmp_path)
    _record_pause(length, offset=4.0, duration=3.0)
    monkeypatch.setattr(ffmpeg.get_config().audio, "beginning_offset", 0.0)
    monkeypatch.setattr(ffmpeg.get_config().audio, "pre_vad_end_offset", 0.0)
    replay_start = END - timedelta(seconds=length)
    line = SimpleNamespace(time=replay_start + timedelta(seconds=8.0), source_padding=0.0, source=None)

    _untrimmed, trimmed, start, end, timeline = ffmpeg.get_audio_and_trim(
        str(replay), line, replay_start + timedelta(seconds=10.0), END
    )

    # Trim times stay on the video; 8s and 10s into it are ~5s and ~7s into the cleaned audio.
    assert (start, end) == (pytest.approx(8.0, abs=0.01), pytest.approx(10.0, abs=0.01))
    assert timeline.to_audio(start) == pytest.approx(8.0 - timeline.removed_seconds, abs=0.01)
    assert ffmpeg.get_audio_length(trimmed) == pytest.approx(2.0, abs=0.1)


def test_does_not_probe_replays_when_no_pause_was_recorded(tmp_path, monkeypatch):
    def probe(_path):
        raise AssertionError("replays without a pause should not be probed")

    monkeypatch.setattr(ffmpeg, "get_video_duration", probe)
    assert ffmpeg.extract_audio_without_pauses(str(tmp_path / "replay.mkv"), str(tmp_path / "out.opus"), END) is None
