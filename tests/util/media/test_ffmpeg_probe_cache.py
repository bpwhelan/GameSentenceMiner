import json
import subprocess
import wave

import pytest

from GameSentenceMiner.util.media import ffmpeg


def test_audio_duration_reads_local_metadata_without_launching_ffprobe(monkeypatch, tmp_path):
    audio = tmp_path / "trimmed.wav"
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\0\0" * 32000)
    monkeypatch.setattr(
        ffmpeg.FFmpegHelper, "get_probe_json", lambda *args: pytest.fail("supported audio must not launch ffprobe")
    )

    assert ffmpeg.get_audio_length(str(audio)) == 2.0


def test_probe_reuses_unchanged_file_and_returns_independent_results(monkeypatch, tmp_path):
    media = tmp_path / "replay.mkv"
    media.write_bytes(b"media")
    calls = []

    def probe(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, json.dumps({"format": {"duration": "30"}}))

    monkeypatch.setattr(ffmpeg.subprocess, "run", probe)
    first = ffmpeg.FFmpegHelper.get_probe_json(str(media), "format=duration", "")
    first["format"]["duration"] = "999"

    assert ffmpeg.get_video_duration(str(media)) == 30
    assert ffmpeg.get_audio_length(str(media)) == 30
    assert len(calls) == 1


def test_probe_invalidates_when_media_is_replaced(monkeypatch, tmp_path):
    media = tmp_path / "audio.opus"
    media.write_bytes(b"old")
    durations = iter(["10", "20"])
    calls = []

    def probe(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, json.dumps({"format": {"duration": next(durations)}}))

    monkeypatch.setattr(ffmpeg.subprocess, "run", probe)
    assert ffmpeg.get_audio_length(str(media)) == 10
    media.write_bytes(b"re-encoded audio")
    assert ffmpeg.get_audio_length(str(media)) == 20
    assert ffmpeg.get_audio_length(str(media)) == 20
    assert len(calls) == 2


def test_failed_probe_is_retried_and_queries_keep_their_stream_selection(monkeypatch, tmp_path):
    media = tmp_path / "replay.mkv"
    media.write_bytes(b"media")
    calls = []

    def probe(command, **kwargs):
        calls.append(command)
        if len(calls) == 1:
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, '{"streams": [{"codec_name": "opus"}]}')

    monkeypatch.setattr(ffmpeg.subprocess, "run", probe)
    assert ffmpeg.FFmpegHelper.get_probe_json(str(media), "stream=codec_name", "a:0") is None
    assert ffmpeg.get_audio_codec(str(media)) == "opus"
    assert ffmpeg.get_audio_codec(str(media)) == "opus"
    assert len(calls) == 2
    assert calls[1][calls[1].index("-select_streams") + 1] == "a:0"
