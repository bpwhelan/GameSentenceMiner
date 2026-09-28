import shutil
import subprocess

import numpy as np
import pytest
import soundfile

from GameSentenceMiner.util.media import ffmpeg

requires_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not available")

SR = 48000


@pytest.fixture(autouse=True)
def system_ffmpeg(monkeypatch):
    # On Windows GSM looks for ffmpeg in its app folder; use the system binary, with production's flags.
    command = [shutil.which("ffmpeg") or "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    monkeypatch.setattr(ffmpeg, "ffmpeg_base_command_list", command)
    monkeypatch.setattr(ffmpeg.get_config().audio, "extension", "mp3")


def _levels(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    samples = np.frombuffer(raw, np.float32)
    return lambda start_ms, end_ms: float(np.sqrt(np.mean(samples[start_ms * SR // 1000 : end_ms * SR // 1000] ** 2)))


@requires_ffmpeg
def test_trimmed_start_fades_in_from_the_cut(tmp_path):
    tone = tmp_path / "tone.wav"
    soundfile.write(tone, 0.5 * np.sin(2 * np.pi * 440 * np.arange(6 * SR) / SR), SR)
    output = tmp_path / "trimmed.mp3"

    ffmpeg.trim_audio(str(tone), 2.0, 4.0, str(output), trim_beginning=True)

    level = _levels(output)
    steady = level(200, 400)
    assert level(0, 2) < 0.1 * steady  # starts near silence instead of at full level
    assert level(80, 120) == pytest.approx(steady, rel=0.1)
    assert level(1990, 1998) < 0.5 * steady  # the fade-out still ends the clip
