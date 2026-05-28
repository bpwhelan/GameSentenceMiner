"""
Tests for .mov file support in the replay handler.

Covers:
- ReplayFileWatcher recognising macOS OBS .mov files
- Audio extraction from a .mov file (H.264 + AAC), validated via ffprobe
- Video frame extraction from a .mov file, validated via file size/codec
"""

from __future__ import annotations

import json
import subprocess
import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


MOV_ASSET = Path(__file__).resolve().parent / "assets" / "Replay_2025-12-19_22-24-52.mov"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ffprobe(*args: str) -> dict:
    """Run ffprobe and return parsed JSON output."""
    cmd = [
        shutil.which("ffprobe") or "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        *args,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    assert result.returncode == 0, f"ffprobe failed: {result.stderr}"
    return json.loads(result.stdout)


def _ffmpeg(*args: str) -> subprocess.CompletedProcess:
    cmd = [
        shutil.which("ffmpeg") or "ffmpeg",
        "-v",
        "error",
        *args,
    ]
    return subprocess.run(cmd, capture_output=True, text=True)


# ---------------------------------------------------------------------------
# File-watcher unit tests
# ---------------------------------------------------------------------------


def test_replay_file_watcher_accepts_mov():
    """ReplayFileWatcher.on_created should trigger processing for a .mov file."""
    import importlib
    import sys
    from types import ModuleType

    tmp_dir = tempfile.mkdtemp()
    ffmpeg_stub = _ffmpeg_stub(tmp_dir)
    media_pkg = ModuleType("GameSentenceMiner.util.media")
    media_pkg.ffmpeg = ffmpeg_stub

    stubs = {
        "GameSentenceMiner.anki": ModuleType("GameSentenceMiner.anki"),
        "GameSentenceMiner.obs": _obs_stub(),
        "GameSentenceMiner.util.config": _config_pkg_stub(tmp_dir),
        "GameSentenceMiner.util.config.configuration": _config_module_stub(tmp_dir),
        "GameSentenceMiner.util.gsm_utils": _gsm_utils_stub(),
        "GameSentenceMiner.util.media": media_pkg,
        "GameSentenceMiner.util.media.ffmpeg": ffmpeg_stub,
        "GameSentenceMiner.util.models.model": _model_stub(),
        "GameSentenceMiner.vad": _vad_stub_no_init(),
    }

    with _patch_sys_modules(stubs):
        sys.modules.pop("GameSentenceMiner.replay_handler", None)
        rh = importlib.import_module("GameSentenceMiner.replay_handler")

        processed = []

        extractor = MagicMock()
        extractor.process_replay.side_effect = lambda path: processed.append(path)

        watcher = rh.ReplayFileWatcher(extractor)

        # Simulate a .mov file creation event
        event = SimpleNamespace(
            is_directory=False,
            src_path=str(MOV_ASSET),
        )
        with patch("GameSentenceMiner.replay_handler.wait_for_stable_file"):
            watcher.on_created(event)

    assert processed == [str(MOV_ASSET)], "ReplayFileWatcher should call process_replay for a .mov file"


def test_replay_file_watcher_rejects_non_replay_mov(tmp_path):
    """A .mov file without 'Replay' or 'GSM' in its name should be ignored."""
    import importlib
    import sys
    from types import ModuleType

    ffmpeg_stub = _ffmpeg_stub(str(tmp_path))
    media_pkg = ModuleType("GameSentenceMiner.util.media")
    media_pkg.ffmpeg = ffmpeg_stub

    stubs = {
        "GameSentenceMiner.anki": ModuleType("GameSentenceMiner.anki"),
        "GameSentenceMiner.obs": _obs_stub(),
        "GameSentenceMiner.util.config": _config_pkg_stub(str(tmp_path)),
        "GameSentenceMiner.util.config.configuration": _config_module_stub(str(tmp_path)),
        "GameSentenceMiner.util.gsm_utils": _gsm_utils_stub(),
        "GameSentenceMiner.util.media": media_pkg,
        "GameSentenceMiner.util.media.ffmpeg": ffmpeg_stub,
        "GameSentenceMiner.util.models.model": _model_stub(),
        "GameSentenceMiner.vad": _vad_stub_no_init(),
    }

    with _patch_sys_modules(stubs):
        sys.modules.pop("GameSentenceMiner.replay_handler", None)
        rh = importlib.import_module("GameSentenceMiner.replay_handler")

        extractor = MagicMock()
        watcher = rh.ReplayFileWatcher(extractor)

        event = SimpleNamespace(
            is_directory=False,
            src_path=str(tmp_path / "random_game.mov"),
        )
        watcher.on_created(event)

    extractor.process_replay.assert_not_called()


# ---------------------------------------------------------------------------
# FFmpeg integration tests – these use the real .mov asset
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not MOV_ASSET.exists(), reason="Test asset not found")
def test_extract_audio_from_mov(tmp_path):
    """
    Audio extracted from the macOS OBS .mov should be valid opus,
    confirmed by ffprobe reporting a non-zero duration.
    """
    output = tmp_path / "extracted.opus"
    proc = _ffmpeg(
        "-i",
        str(MOV_ASSET),
        "-map",
        "0:a",
        "-c:a",
        "libopus",
        "-t",
        "3",  # first 3 seconds – keeps the test fast
        str(output),
    )
    assert proc.returncode == 0, f"ffmpeg audio extraction failed:\n{proc.stderr}"
    assert output.exists(), "Output audio file was not created"
    assert output.stat().st_size > 0, "Output audio file is empty"

    info = _ffprobe("-show_entries", "format=duration", str(output))
    duration = float(info["format"]["duration"])
    assert duration > 0, "Extracted audio has zero duration"
    assert duration <= 3.5, f"Extracted audio is unexpectedly long: {duration}s"


@pytest.mark.skipif(not MOV_ASSET.exists(), reason="Test asset not found")
def test_extract_audio_aac_stream_copy_from_mov(tmp_path):
    """
    Stream-copying the native AAC from a .mov to an .aac file should succeed
    and produce a decodable file (this mirrors what get_audio_and_trim does
    when the target extension matches the source codec).
    """
    output = tmp_path / "extracted.aac"
    proc = _ffmpeg(
        "-i",
        str(MOV_ASSET),
        "-map",
        "0:a",
        "-c:a",
        "copy",
        "-t",
        "3",
        str(output),
    )
    assert proc.returncode == 0, f"ffmpeg AAC stream-copy failed:\n{proc.stderr}"
    assert output.exists(), "Output .aac file was not created"
    assert output.stat().st_size > 0, "Output .aac file is empty"

    info = _ffprobe(
        "-show_entries",
        "stream=codec_name,duration",
        "-select_streams",
        "a:0",
        str(output),
    )
    stream = info["streams"][0]
    assert stream["codec_name"] == "aac", f"Expected aac codec, got {stream['codec_name']}"
    assert float(stream["duration"]) > 0, "Extracted AAC has zero duration"


@pytest.mark.skipif(not MOV_ASSET.exists(), reason="Test asset not found")
def test_extract_video_frame_from_mov(tmp_path):
    """
    A PNG frame should be extractable from the macOS OBS .mov at any timestamp.
    The resulting PNG must be a valid image (non-trivial file size, PNG magic bytes).
    """
    output = tmp_path / "frame.png"
    proc = _ffmpeg(
        "-ss",
        "1.0",
        "-i",
        str(MOV_ASSET),
        "-vframes",
        "1",
        str(output),
    )
    assert proc.returncode == 0, f"ffmpeg frame extraction failed:\n{proc.stderr}"
    assert output.exists(), "Output frame file was not created"

    # Validate PNG magic bytes
    with open(output, "rb") as f:
        magic = f.read(8)
    assert magic == b"\x89PNG\r\n\x1a\n", "Extracted file is not a valid PNG"

    # 1920×1080 frame should be well over 100 KB
    assert output.stat().st_size > 100_000, f"Frame PNG unexpectedly small: {output.stat().st_size} bytes"


@pytest.mark.skipif(not MOV_ASSET.exists(), reason="Test asset not found")
def test_mov_video_codec_is_h264():
    """The video stream in the macOS OBS .mov should be H.264 (not ProRes, etc.)."""
    info = _ffprobe(
        "-show_entries",
        "stream=codec_name",
        "-select_streams",
        "v:0",
        str(MOV_ASSET),
    )
    assert info["streams"][0]["codec_name"] == "h264", "Expected H.264 video stream in .mov asset"


@pytest.mark.skipif(not MOV_ASSET.exists(), reason="Test asset not found")
def test_mov_audio_codec_is_aac():
    """The audio stream in the macOS OBS .mov should be AAC."""
    info = _ffprobe(
        "-show_entries",
        "stream=codec_name",
        "-select_streams",
        "a:0",
        str(MOV_ASSET),
    )
    assert info["streams"][0]["codec_name"] == "aac", "Expected AAC audio stream in .mov asset"


@pytest.mark.skipif(not MOV_ASSET.exists(), reason="Test asset not found")
def test_trim_mov_to_mp4(tmp_path):
    """
    Stream-copying a section of the .mov into .mp4 should succeed and produce
    a valid MP4 – this mirrors trim_replay_for_gameline's fast-trim path.
    """
    output = tmp_path / "trimmed.mp4"
    proc = _ffmpeg(
        "-ss",
        "0",
        "-i",
        str(MOV_ASSET),
        "-t",
        "2",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        str(output),
    )
    assert proc.returncode == 0, f"ffmpeg .mov→.mp4 trim failed:\n{proc.stderr}"
    assert output.exists(), "Trimmed MP4 was not created"

    info = _ffprobe("-show_entries", "format=duration", str(output))
    duration = float(info["format"]["duration"])
    assert 1.5 <= duration <= 2.5, f"Unexpected trimmed duration: {duration}s"


# ---------------------------------------------------------------------------
# Stub helpers (reuse pattern from test_replay_handler_audio.py)
# ---------------------------------------------------------------------------


def _obs_stub():
    from types import ModuleType

    m = ModuleType("GameSentenceMiner.obs")
    m.get_current_game = lambda sanitize=False: "Test Game"
    return m


def _config_module_stub(tmp_dir: str):
    from types import ModuleType

    m = ModuleType("GameSentenceMiner.util.config.configuration")
    m.AnkiUpdateResult = SimpleNamespace
    m.anki_results = {}
    m.get_config = lambda: SimpleNamespace(
        vad=SimpleNamespace(do_vad_postprocessing=False, trim_beginning=True),
        audio=SimpleNamespace(extension="opus", ffmpeg_reencode_options_to_use="-b:a 64k"),
        anki=SimpleNamespace(show_update_confirmation_dialog_v2=True),
        advanced=SimpleNamespace(multi_line_line_break=" "),
    )
    m.get_temporary_directory = lambda: tmp_dir
    m.gsm_state = SimpleNamespace()
    m.gsm_status = SimpleNamespace(remove_word_being_processed=lambda *_a, **_k: None)
    m.logger = _NoopLogger()
    return m


def _config_pkg_stub(tmp_dir: str):
    from types import ModuleType

    m = ModuleType("GameSentenceMiner.util.config")
    m.configuration = _config_module_stub(tmp_dir)
    return m


def _gsm_utils_stub():
    from types import ModuleType

    m = ModuleType("GameSentenceMiner.util.gsm_utils")
    m.combine_dialogue = lambda lines: lines
    m.make_unique_file_name = lambda path: path
    m.remove_html_and_cloze_tags = lambda text: text
    m.wait_for_stable_file = lambda *_a, **_k: None
    return m


def _model_stub():
    from types import ModuleType

    class _VADResult:
        def __init__(self, success, start, end, model, **kw):
            self.success = success
            self.start = start
            self.end = end
            self.model = model
            self.tts_used = kw.get("tts_used", False)
            self.output_audio = kw.get("output_audio")

        def trim_successful_string(self):
            return "ok"

    m = ModuleType("GameSentenceMiner.util.models.model")
    m.VADResult = _VADResult
    return m


def _vad_stub_no_init():
    from types import ModuleType

    m = ModuleType("GameSentenceMiner.vad")
    m.vad_processor = SimpleNamespace(initialized=False)
    return m


def _ffmpeg_stub(tmp_dir: str):
    from types import ModuleType

    m = ModuleType("GameSentenceMiner.util.media.ffmpeg")
    _source = str(Path(tmp_dir) / "source.opus")
    _trimmed = str(Path(tmp_dir) / "trimmed.opus")
    m.get_audio_and_trim = lambda *_a, **_k: (_source, _trimmed, 0.0, 3.0)
    m.get_audio_length = lambda path: 3.0 if path == _trimmed else 30.0
    m.reencode_file_with_user_config = lambda *_a, **_k: None
    return m


class _NoopLogger:
    def __getattr__(self, _name):
        def _noop(*_a, **_k):
            return None

        return _noop


@contextmanager
def _patch_sys_modules(stubs: dict):
    _MISSING = object()
    originals = {}
    for name, module in stubs.items():
        originals[name] = sys.modules.get(name, _MISSING)
        sys.modules[name] = module
    try:
        yield
    finally:
        for name, original in originals.items():
            if original is _MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
