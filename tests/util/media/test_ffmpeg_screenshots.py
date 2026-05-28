from __future__ import annotations

import subprocess
from types import SimpleNamespace

from GameSentenceMiner.util.media import ffmpeg


def _screenshot_config(**overrides):
    screenshot = SimpleNamespace(
        trim_black_bars_wip=False,
        custom_ffmpeg_settings="",
        width=0,
        height=0,
        quality=85,
        extension="webp",
        animated_settings=SimpleNamespace(
            codec="libsvtav1",
            extension="avif",
            scaled_quality=20,
            max_width=960,
            adaptive_avif=False,
            faststart=True,
            encoder_fallback=True,
        ),
    )
    for key, value in overrides.items():
        setattr(screenshot, key, value)
    return SimpleNamespace(screenshot=screenshot)


def test_video_to_anim_uses_configured_av1_encoder(monkeypatch, tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    output = tmp_path / "out.avif"
    commands = []

    monkeypatch.setattr(ffmpeg.shutil, "which", lambda _name: "ffmpeg")
    monkeypatch.setattr(ffmpeg, "get_config", lambda: _screenshot_config())
    monkeypatch.setattr(
        ffmpeg.FFmpegHelper,
        "run",
        lambda command, **_kwargs: (
            commands.append(command) or subprocess.CompletedProcess(command, 0, stdout="", stderr="")
        ),
    )

    result = ffmpeg.video_to_anim(
        source,
        output_path=output,
        codec="avif",
        av1_encoder="libsvtav1",
        start=1,
        duration=2,
        quality=20,
        audio=False,
    )

    assert result == str(output)
    assert commands[0][commands[0].index("-c:v") + 1] == "libsvtav1"
    assert "-preset" in commands[0]


def test_video_to_anim_uses_configured_avif_width_and_faststart(monkeypatch, tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    output = tmp_path / "out.avif"
    commands = []

    monkeypatch.setattr(ffmpeg.shutil, "which", lambda _name: "ffmpeg")
    monkeypatch.setattr(
        ffmpeg,
        "get_config",
        lambda: _screenshot_config(
            animated_settings=SimpleNamespace(
                codec="libsvtav1",
                extension="avif",
                scaled_quality=28,
                max_width=480,
                adaptive_avif=False,
                faststart=True,
                encoder_fallback=True,
            )
        ),
    )
    monkeypatch.setattr(
        ffmpeg.FFmpegHelper,
        "run",
        lambda command, **_kwargs: (
            commands.append(command) or subprocess.CompletedProcess(command, 0, stdout="", stderr="")
        ),
    )

    ffmpeg.video_to_anim(
        source,
        output_path=output,
        codec="avif",
        av1_encoder="libsvtav1",
        start=1,
        duration=2,
        quality=28,
        audio=False,
    )

    assert commands[0][commands[0].index("-vf") + 1] == "fps=12,scale=480:-1,pad=ceil(iw/2)*2:ceil(ih/2)*2"
    assert commands[0][commands[0].index("-movflags") + 1] == "+faststart"


def test_video_to_anim_adaptive_avif_compacts_long_clips(monkeypatch, tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    output = tmp_path / "out.avif"
    commands = []

    monkeypatch.setattr(ffmpeg.shutil, "which", lambda _name: "ffmpeg")
    monkeypatch.setattr(ffmpeg, "get_config", lambda: _screenshot_config())
    monkeypatch.setattr(
        ffmpeg.FFmpegHelper,
        "run",
        lambda command, **_kwargs: (
            commands.append(command) or subprocess.CompletedProcess(command, 0, stdout="", stderr="")
        ),
    )

    ffmpeg.video_to_anim(
        source,
        output_path=output,
        codec="avif",
        av1_encoder="libsvtav1",
        start=1,
        duration=12,
        fps=30,
        max_width=960,
        quality=28,
        adaptive_avif=True,
        audio=False,
    )

    assert commands[0][commands[0].index("-vf") + 1] == "fps=15,scale=720:-1,pad=ceil(iw/2)*2:ceil(ih/2)*2"
    assert commands[0][commands[0].index("-crf") + 1] == "33"


def test_video_to_anim_adaptive_avif_uses_config_as_short_clip_target(monkeypatch, tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    output = tmp_path / "out.avif"
    commands = []

    monkeypatch.setattr(ffmpeg.shutil, "which", lambda _name: "ffmpeg")
    monkeypatch.setattr(ffmpeg, "get_config", lambda: _screenshot_config())
    monkeypatch.setattr(
        ffmpeg.FFmpegHelper,
        "run",
        lambda command, **_kwargs: (
            commands.append(command) or subprocess.CompletedProcess(command, 0, stdout="", stderr="")
        ),
    )

    ffmpeg.video_to_anim(
        source,
        output_path=output,
        codec="avif",
        av1_encoder="libsvtav1",
        start=1,
        duration=4,
        fps=30,
        max_width=960,
        quality=28,
        adaptive_avif=True,
        audio=False,
    )

    assert commands[0][commands[0].index("-vf") + 1] == "fps=30,scale=960:-1,pad=ceil(iw/2)*2:ceil(ih/2)*2"
    assert commands[0][commands[0].index("-crf") + 1] == "28"


def test_trim_animation_maps_animated_avif_stream(monkeypatch, tmp_path):
    source = tmp_path / "source.avif"
    source.write_bytes(b"video")
    output = tmp_path / "out.avif"
    commands = []

    monkeypatch.setattr(ffmpeg, "get_config", lambda: _screenshot_config())
    monkeypatch.setattr(
        ffmpeg.FFmpegHelper,
        "get_probe_json",
        lambda *_args, **_kwargs: {
            "streams": [
                {"index": 0, "avg_frame_rate": "1/1", "nb_frames": "1", "tags": {}},
                {
                    "index": 1,
                    "avg_frame_rate": "30/1",
                    "duration": "2.000000",
                    "nb_frames": "60",
                    "tags": {"handler_name": "PictureHandler"},
                },
            ]
        },
    )
    monkeypatch.setattr(
        ffmpeg.FFmpegHelper,
        "run",
        lambda command, **_kwargs: (
            commands.append(command) or subprocess.CompletedProcess(command, 0, stdout="", stderr="")
        ),
    )

    ffmpeg.trim_animation(
        source,
        start_offset=0.25,
        duration=1,
        output_path=output,
        codec="avif",
        av1_encoder="libsvtav1",
        quality=28,
        fps=30,
    )

    command = commands[0]
    assert command[command.index("-map") + 1] == "0:1"
    assert command.index("-map") > command.index(str(source))
    assert command.index("-map") < command.index("-t")


def test_video_to_anim_retries_avif_with_fallback_encoder(monkeypatch, tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    output = tmp_path / "out.avif"
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        if command[command.index("-c:v") + 1] == "libsvtav1":
            raise RuntimeError("svt unavailable")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(ffmpeg.shutil, "which", lambda _name: "ffmpeg")
    monkeypatch.setattr(ffmpeg, "get_config", lambda: _screenshot_config())
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", fake_run)

    ffmpeg.video_to_anim(
        source,
        output_path=output,
        codec="avif",
        av1_encoder="libsvtav1",
        start=1,
        duration=2,
        quality=28,
        av1_encoder_fallback=True,
        audio=False,
    )

    assert [command[command.index("-c:v") + 1] for command in commands] == ["libsvtav1", "libaom-av1"]


def test_static_webp_encode_falls_back_to_jpeg(monkeypatch, tmp_path):
    input_image = tmp_path / "raw.png"
    input_image.write_bytes(b"image")
    output = tmp_path / "encoded.webp"
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        if command[-1].endswith(".webp"):
            raise RuntimeError("webp encoder missing")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(ffmpeg, "get_config", lambda: _screenshot_config())
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", fake_run)

    result = ffmpeg.encode_screenshot(str(input_image), output_path=str(output))

    assert result.endswith(".jpeg")
    assert commands[0][-1].endswith(".webp")
    assert commands[1][-1].endswith(".jpeg")
    assert "-compression_level" not in commands[1]


def test_static_webp_jpeg_fallback_keeps_black_bar_crop(monkeypatch, tmp_path):
    input_image = tmp_path / "raw.png"
    input_image.write_bytes(b"image")
    output = tmp_path / "encoded.webp"
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        if command[-1].endswith(".webp"):
            raise RuntimeError("webp encoder missing")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(
        ffmpeg,
        "get_config",
        lambda: _screenshot_config(trim_black_bars_wip=True, width=640),
    )
    monkeypatch.setattr(ffmpeg, "find_black_bars", lambda _video, _timing: "crop=1280:720:0:120")
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", fake_run)

    result = ffmpeg.encode_screenshot(
        str(input_image),
        source_video_path="source.mp4",
        screenshot_timing=12.5,
        output_path=str(output),
    )

    assert result.endswith(".jpeg")
    jpeg_command = commands[1]
    assert jpeg_command[jpeg_command.index("-vf") + 1] == "crop=1280:720:0:120,scale=640:-2"


def test_get_screenshot_png_fallback_keeps_black_bar_crop(monkeypatch, tmp_path):
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        if command[-1].endswith(".webp"):
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="webp encoder missing")
        if command[-1].endswith(".jpeg"):
            raise RuntimeError("jpeg encoder missing")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(
        ffmpeg,
        "get_config",
        lambda: _screenshot_config(trim_black_bars_wip=True, width=640),
    )
    monkeypatch.setattr(ffmpeg, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(ffmpeg.obs, "get_current_game", lambda sanitize=True: "game")
    monkeypatch.setattr(ffmpeg, "find_black_bars", lambda _video, _timing: "crop=1280:720:0:120")
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", fake_run)

    result = ffmpeg.get_screenshot("source.mp4", 12.5)

    assert result.endswith(".png")
    png_command = commands[-1]
    assert png_command[png_command.index("-vf") + 1] == "crop=1280:720:0:120,scale=640:-1"


def test_process_image_png_fallback_keeps_screenshot_filters(monkeypatch, tmp_path):
    input_image = tmp_path / "raw.png"
    input_image.write_bytes(b"image")
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        if command[-1].endswith(".webp") or command[-1].endswith(".jpeg"):
            raise RuntimeError("encoder missing")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(
        ffmpeg,
        "get_config",
        lambda: _screenshot_config(trim_black_bars_wip=True, width=320),
    )
    monkeypatch.setattr(ffmpeg, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(ffmpeg.obs, "get_current_game", lambda sanitize=True: "game")
    monkeypatch.setattr(ffmpeg, "find_black_bars", lambda _video, _timing: "crop=1280:720:0:120")
    monkeypatch.setattr(ffmpeg.FFmpegHelper, "run", fake_run)

    result = ffmpeg.process_image(str(input_image), source_video_path="source.mp4", screenshot_timing=12.5)

    assert result.endswith(".png")
    png_command = commands[-1]
    assert png_command[png_command.index("-vf") + 1] == "crop=1280:720:0:120,scale=320:-1"
