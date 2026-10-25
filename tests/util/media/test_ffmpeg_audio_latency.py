import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from GameSentenceMiner.util.media import ffmpeg


@pytest.fixture
def audio_config(monkeypatch, tmp_path):
    audio = SimpleNamespace(extension="opus", beginning_offset=0.0, pre_vad_end_offset=0.0)
    monkeypatch.setattr(ffmpeg, "get_config", lambda: SimpleNamespace(audio=audio))
    monkeypatch.setattr(ffmpeg.configuration, "get_temporary_directory", lambda: str(tmp_path))
    return audio


@pytest.mark.parametrize("extension,codec", [(ext, spec["codec"]) for ext, spec in ffmpeg.supported_formats.items()])
def test_replay_encodes_only_the_selected_audio(monkeypatch, audio_config, extension, codec):
    audio_config.extension = extension
    monkeypatch.setattr(ffmpeg, "extract_audio_without_pauses", lambda *args: None)
    monkeypatch.setattr(ffmpeg, "get_audio_codec", lambda *args: "aac")
    monkeypatch.setattr(ffmpeg, "get_video_timings", lambda *args: (150.0, 150.0, 150.0, 180.0))
    commands = []
    monkeypatch.setattr(
        ffmpeg.FFmpegHelper,
        "run",
        lambda command, **kwargs: commands.append(command) or subprocess.CompletedProcess(command, 0),
    )
    line = SimpleNamespace(time=datetime(2026, 10, 21, tzinfo=timezone.utc), source_padding=0.5)

    source, trimmed, start, end, timeline = ffmpeg.get_audio_and_trim(
        "replay.mp4", line, line.time + timedelta(seconds=5), line.time
    )

    extract, select = commands
    assert extract[extract.index("-c:a") + 1] == "copy", "the full replay must not be transcoded"
    assert extract[-1] == source
    if extension == "aac":
        assert select[select.index("-c") + 1] == "copy"
        assert float(select[select.index("-to") + 1]) == 155.0
    else:
        assert select[select.index("-c:a") + 1] == codec
        assert select.index("-ss") < select.index("-i"), "seek before decoding the source audio"
        assert float(select[select.index("-t") + 1]) == 5.5
    assert float(select[select.index("-ss") + 1]) == 149.5
    assert select[-1] == trimmed
    assert (start, end) == (149.5, 155.0)
    assert not timeline


def test_audio_expansion_transcodes_source_container_to_selected_format(monkeypatch, audio_config):
    commands = []
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", lambda command, **kwargs: commands.append(command))

    ffmpeg.trim_audio("source.mka", 150.0, 155.0, "expanded.opus", True, 0, 0)

    command = commands[0]
    assert command[command.index("-c:a") + 1] == "libopus"
    assert "-vn" in command


@pytest.mark.parametrize("end_offset", [0.0, -0.5])
def test_seeked_audio_without_next_line_keeps_replay_end(monkeypatch, audio_config, end_offset):
    audio_config.pre_vad_end_offset = end_offset
    monkeypatch.setattr(ffmpeg, "get_video_timings", lambda *args: (150.0, 150.0, 150.0, 180.0))
    commands = []
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", lambda command, **kwargs: commands.append(command))
    line = SimpleNamespace(time=datetime(2026, 10, 21, tzinfo=timezone.utc), source_padding=0.0)

    _, start, end = ffmpeg.trim_audio_based_on_last_line(
        "source.mka", "replay.mp4", line, None, line.time, ffmpeg.AudioTimeline()
    )

    assert start == 150.0
    if end_offset:
        assert end == 179.5
        assert float(commands[0][commands[0].index("-t") + 1]) == 29.5
    else:
        assert end == 0.0
        assert "-t" not in commands[0]


@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg/ffprobe unavailable")
def test_seeked_replay_audio_and_expansion_preserve_timing_and_format(monkeypatch, tmp_path, audio_config):
    monkeypatch.setattr(
        ffmpeg, "ffmpeg_base_command_list", [shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin"]
    )
    monkeypatch.setattr(ffmpeg, "get_ffprobe_path", lambda: shutil.which("ffprobe"))
    monkeypatch.setattr(ffmpeg, "extract_audio_without_pauses", lambda *args: None)
    sample_rate = 48000
    times = np.arange(sample_rate * 12) / sample_rate
    frequency = np.where(times < 8.0, 440.0, 1000.0)
    wave = tmp_path / "source.wav"
    sf.write(wave, 0.2 * np.sin(2 * np.pi * frequency * times), sample_rate)
    replay = tmp_path / "replay.mp4"
    subprocess.run(
        [
            shutil.which("ffmpeg"),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=32x32:rate=1:duration=12",
            "-i",
            str(wave),
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            str(replay),
        ],
        check=True,
    )
    captured_at = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
    line = SimpleNamespace(time=captured_at - timedelta(seconds=4), source_padding=0.0)

    source, trimmed, start, end, _timeline = ffmpeg.get_audio_and_trim(
        str(replay), line, captured_at - timedelta(seconds=2), captured_at
    )

    assert source != str(replay), "follow-up replays can be deleted while their source audio is still in use"
    assert ffmpeg.get_audio_length(source) == pytest.approx(12.0, abs=0.05)
    assert (start, end) == pytest.approx((8.0, 10.0), abs=0.05)
    assert ffmpeg.get_audio_length(trimmed) == pytest.approx(2.0, abs=0.05)
    samples, rate = sf.read(trimmed)
    spectrum = np.abs(np.fft.rfft(samples[len(samples) // 4 : 3 * len(samples) // 4]))
    peak_frequency = np.argmax(spectrum) * rate / (len(samples) // 2)
    assert peak_frequency == pytest.approx(1000.0, abs=5.0)

    expanded = tmp_path / "expanded.opus"
    ffmpeg.trim_audio(source, 7.5, 10.0, str(expanded), True, 0, 0)
    assert ffmpeg.get_audio_length(str(expanded)) == pytest.approx(2.5, abs=0.05)
    assert ffmpeg.get_audio_codec(str(expanded)) == "opus"
    assert Path(source).is_file()
