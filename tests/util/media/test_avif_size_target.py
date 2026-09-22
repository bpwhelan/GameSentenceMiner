from __future__ import annotations

import math
import re
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.media import ffmpeg


@pytest.fixture
def encoder(monkeypatch, tmp_path):
    settings = SimpleNamespace(
        max_width=960,
        adaptive_avif=True,
        faststart=True,
        encoder_fallback=True,
        target_size_kb=40,
        size_priority="balanced",
    )
    config = SimpleNamespace(
        screenshot=SimpleNamespace(
            animated_settings=settings,
            trim_black_bars_wip=True,
            custom_ffmpeg_settings="",
        )
    )
    source = tmp_path / "replay.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "result.avif"
    calls = []
    probe = {"streams": [{"width": 1280, "avg_frame_rate": "30/1"}], "format": {"duration": "60"}}
    monkeypatch.setattr(ffmpeg, "get_config", lambda: config)
    monkeypatch.setattr(ffmpeg, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(ffmpeg.shutil, "which", lambda _name: "ffmpeg")
    monkeypatch.setattr(ffmpeg, "find_black_bars", lambda *_args: "crop=800:450:10:20")
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "get_probe_json", lambda *_args: probe)

    def run(command, **_kwargs):
        calls.append(command)
        if Path(command[-1]).exists() and "-y" not in command:
            raise RuntimeError("Refusing to overwrite an existing sample with stdin disabled")
        vf = command[command.index("-vf") + 1]
        fps = float(re.search(r"fps=([\d.]+)", vf)[1])
        width_match = re.search(r"min\((\d+),iw\)", vf)
        width = int(width_match[1]) if width_match else 960
        crf = int(command[command.index("-crf") + 1])
        duration = float(command[command.index("-t") + 1])
        size = max(1, math.ceil(duration * fps * 1000 * (width / 960) ** 2 * 2 ** ((28 - crf) / 6)))
        Path(command[-1]).write_bytes(b"a" * size)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", run)

    def encode(**kwargs):
        return ffmpeg.video_to_anim(
            source,
            output,
            codec="avif",
            start="00:00:04.5",
            duration=12,
            fps=20,
            quality=28,
            crop="640:360:0:0",
            extra_vf=["setsar=1"],
            **kwargs,
        )

    return SimpleNamespace(
        settings=settings, config=config, source=source, output=output, calls=calls, probe=probe, run=run, encode=encode
    )


@pytest.mark.parametrize("priority", ["prefer_fps", "prefer_quality", "balanced"])
def test_target_selects_measured_settings_with_correct_priority(encoder, priority):
    encoder.settings.size_priority = priority
    assert encoder.encode() == str(encoder.output)
    assert len(encoder.calls) > 1
    assert encoder.output.stat().st_size <= 40 * 1024
    final = encoder.calls[-1]
    vf = final[final.index("-vf") + 1]
    fps = float(re.search(r"fps=([\d.]+)", vf)[1])
    crf = int(final[final.index("-crf") + 1])
    if priority == "prefer_fps":
        assert fps == 20
        assert crf > 28
    elif priority == "prefer_quality":
        assert fps < 20
        assert crf == 28
        assert "min(960,iw)" in vf
    else:
        assert fps < 20
        assert crf > 28
        assert "min(960,iw)" not in vf

    # All probes must use the selected crop/filter chain and stay in the mined window.
    for command in encoder.calls:
        filters = command[command.index("-vf") + 1]
        assert "crop=800:450:10:20" in filters
        assert "crop=640:360:0:0" in filters
        assert "setsar=1" in filters
        assert ":round=up" in filters
        assert ":start_time=0" in filters
        assert command[command.index("-abort_on") + 1] == "empty_output"
        start = float(command[command.index("-ss") + 1])
        duration = float(command[command.index("-t") + 1])
        assert 4.5 <= start < 16.5
        assert start + duration <= 16.5
    sample_starts = {float(command[command.index("-ss") + 1]) for command in encoder.calls[:-1]}
    assert sample_starts == {4.5, 10.0, 15.5}
    assert all(not Path(command[-1]).exists() for command in encoder.calls[:-1])


def test_large_target_keeps_caps_and_overrides_duration_reduction(encoder):
    encoder.settings.target_size_kb = 1000
    encoder.encode()
    assert len(encoder.calls) == 4  # Three samples and the full encode.
    final = encoder.calls[-1]
    assert "fps=20:round=up" in final[final.index("-vf") + 1]
    assert "min(960,iw)" in final[final.index("-vf") + 1]
    assert final[final.index("-crf") + 1] == "28"


def test_source_width_and_remaining_duration_cap_samples(encoder):
    encoder.settings.max_width = 0
    encoder.settings.target_size_kb = 1000
    encoder.probe["streams"][0].update(width=320, avg_frame_rate="10/1")
    encoder.probe["format"]["duration"] = "4.75"
    encoder.encode()
    assert len(encoder.calls) == 2
    for command in encoder.calls:
        assert float(command[command.index("-t") + 1]) == 0.25
        assert "min(320,iw)" in command[command.index("-vf") + 1]
        assert "fps=10:round=up" in command[command.index("-vf") + 1]


def test_unattainable_target_uses_minimum_settings(encoder):
    encoder.settings.target_size_kb = 1
    # Even the most compressed sample is too large.
    original = encoder.run

    def oversized(command, **kwargs):
        result = original(command, **kwargs)
        Path(command[-1]).write_bytes(b"a" * 4096)
        return result

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(ffmpeg.FFmpegHelper, "run", oversized)
        encoder.encode()
    assert len(encoder.calls) == 7  # Caps, minimum, final; no unbounded retries.
    final = encoder.calls[-1]
    assert "fps=1:round=up" in final[final.index("-vf") + 1]
    assert "min(240,iw)" in final[final.index("-vf") + 1]
    assert final[final.index("-crf") + 1] == "56"


def test_encoder_fallback_reestimates_and_cleans_samples(encoder, monkeypatch):
    def failing_primary(command, **kwargs):
        if command[command.index("-c:v") + 1] == "libsvtav1":
            encoder.calls.append(command)
            Path(command[-1]).write_bytes(b"partial")
            raise RuntimeError("primary unavailable")
        return encoder.run(command, **kwargs)

    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", failing_primary)
    encoder.encode()
    assert len(encoder.calls) > 3
    assert encoder.calls[0][encoder.calls[0].index("-c:v") + 1] == "libsvtav1"
    assert all(cmd[cmd.index("-c:v") + 1] == "libaom-av1" for cmd in encoder.calls[1:])
    assert encoder.output.stat().st_size <= 40 * 1024
    assert all(not Path(cmd[-1]).exists() for cmd in encoder.calls[:-1])


def test_disabled_target_does_not_probe(encoder, monkeypatch):
    encoder.settings.target_size_kb = 0
    encoder.settings.adaptive_avif = False
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "get_probe_json", lambda *_args: pytest.fail("Unexpected probe"))
    # Legacy mode accepts numeric starts; the target path additionally supports HH:MM:SS.
    ffmpeg.video_to_anim(encoder.source, encoder.output, codec="avif", start=1, duration=4, fps=20, quality=28)
    assert len(encoder.calls) == 1


def test_sample_failure_without_fallback_cleans_partial_files(encoder, monkeypatch):
    encoder.settings.encoder_fallback = False

    def fail(command, **_kwargs):
        encoder.calls.append(command)
        Path(command[-1]).write_bytes(b"partial")
        raise RuntimeError("broken encoder")

    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", fail)
    with pytest.raises(RuntimeError, match="broken encoder"):
        encoder.encode()
    assert len(encoder.calls) == 1
    assert not Path(encoder.calls[0][-1]).exists()
    assert not encoder.output.exists()


def test_size_target_preserves_an_existing_output(encoder):
    encoder.output.write_bytes(b"existing screenshot")
    with pytest.raises(FileExistsError):
        encoder.encode()
    assert encoder.output.read_bytes() == b"existing screenshot"
    assert not encoder.calls


def test_final_encode_failure_reestimates_for_larger_fallback_output(encoder, monkeypatch):
    def run(command, **kwargs):
        codec = command[command.index("-c:v") + 1]
        if codec == "libsvtav1" and command[-1] == str(encoder.output):
            encoder.calls.append(command)
            Path(command[-1]).write_bytes(b"partial")
            raise RuntimeError("primary full encode failed")
        result = encoder.run(command, **kwargs)
        if codec == "libaom-av1":
            path = Path(command[-1])
            path.write_bytes(path.read_bytes() * 2)
        return result

    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", run)
    encoder.encode()
    outputs = [cmd for cmd in encoder.calls if cmd[-1] == str(encoder.output)]
    assert len(outputs) == 2
    assert outputs[0][outputs[0].index("-vf") + 1] != outputs[1][outputs[1].index("-vf") + 1]
    assert encoder.output.stat().st_size <= 40 * 1024
    assert all(not Path(cmd[-1]).exists() for cmd in encoder.calls if cmd not in outputs)


@pytest.mark.parametrize("codec, audio", [("webp", False), ("avif", True)])
def test_size_target_does_not_change_webp_or_video(encoder, monkeypatch, codec, audio):
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "get_probe_json", lambda *_args: pytest.fail("Unexpected size probe"))
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", lambda cmd, **_kwargs: encoder.calls.append(cmd))
    ffmpeg.video_to_anim(encoder.source, encoder.output, codec=codec, audio=audio, start=1, duration=3)
    assert len(encoder.calls) == 1
    assert ":round=up" not in encoder.calls[0][encoder.calls[0].index("-vf") + 1]


@pytest.mark.parametrize("priority", ["balanced", "prefer_fps", "prefer_quality"])
def test_size_search_stays_within_caps_and_bounds_sampling_work(priority):
    from GameSentenceMiner.util.media.avif_sizing import AvifParameters, choose_size_parameters, size_candidates

    caps = AvifParameters(30, 960, 28)
    candidates = size_candidates(caps, priority)
    assert len(set(candidates)) == len(candidates)
    assert all(1 <= p.fps <= caps.fps and 240 <= p.width <= caps.width and caps.crf <= p.crf <= 56 for p in candidates)
    measurements = []

    def estimate(parameters):
        measurements.append(parameters)
        return (len(candidates) - candidates.index(parameters)) * 1024

    selected, size = choose_size_parameters(candidates, 10 * 1024, estimate)
    assert size <= 10 * 1024
    assert len(measurements) <= math.ceil(math.log2(len(candidates))) + 2
    assert selected == candidates[-10]


@pytest.mark.parametrize("av1_encoder", ["libsvtav1", "libaom-av1"])
def test_real_short_clip_produces_decodable_avif(tmp_path, monkeypatch, av1_encoder):
    binary, probe_binary = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not binary or not probe_binary:
        pytest.skip("FFmpeg and ffprobe are required for the real encoding regression")
    encoders = subprocess.run([binary, "-hide_banner", "-encoders"], capture_output=True, text=True, check=True).stdout
    if av1_encoder not in encoders:
        pytest.skip(f"Installed FFmpeg does not include {av1_encoder}")
    source = tmp_path / "short-source.mp4"
    subprocess.run(
        [
            binary,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=1",
            "-c:v",
            "mpeg4",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    settings = SimpleNamespace(target_size_kb=1, size_priority="balanced", max_width=320, encoder_fallback=False)
    monkeypatch.setattr(
        ffmpeg,
        "get_config",
        lambda: SimpleNamespace(
            screenshot=SimpleNamespace(
                animated_settings=settings,
                trim_black_bars_wip=False,
                custom_ffmpeg_settings="",
            )
        ),
    )
    monkeypatch.setattr(ffmpeg, "get_temporary_directory", lambda: str(tmp_path))
    # Match production's non-interactive command, which does not overwrite by default.
    monkeypatch.setattr(ffmpeg, "ffmpeg_base_command_list", [binary, "-hide_banner", "-loglevel", "error", "-nostdin"])
    monkeypatch.setattr(ffmpeg, "get_ffprobe_path", lambda: probe_binary)
    output = ffmpeg.video_to_anim(
        source,
        tmp_path / "short.avif",
        codec="avif",
        av1_encoder=av1_encoder,
        start=0.92,
        duration=2,
        fps=20,
        quality=28,
    )
    info = ffmpeg.FFmpegHelper.get_probe_json(output, "stream=width,height,nb_frames", "v")
    assert info and info["streams"]
    assert any(int(stream.get("nb_frames", 0)) >= 1 for stream in info["streams"])
    assert all(stream["width"] <= 320 and stream["height"] <= 180 for stream in info["streams"])
    assert not list(tmp_path.glob("gsm-avif-size-*"))


@pytest.mark.parametrize(
    "success, model, tts, expected",
    [
        (True, "silero", False, True),
        (False, "silero", False, False),
        (True, "No VAD", False, False),
        (True, "", False, False),
        (True, "silero", True, False),
    ],
)
def test_vad_retains_original_speech_detection_after_audio_fallback(success, model, tts, expected):
    from GameSentenceMiner.util.models.model import VADResult

    result = VADResult(success, 0, 2, model, tts_used=tts)
    result.success = True  # Keeping raw audio/TTS must not turn prose into voiced dialogue.
    assert result.voice_detected is expected
