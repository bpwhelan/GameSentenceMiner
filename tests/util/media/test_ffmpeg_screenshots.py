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
        animated_settings=SimpleNamespace(codec="libsvtav1", extension="avif", scaled_quality=20),
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
