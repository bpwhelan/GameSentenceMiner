import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from GameSentenceMiner.ui import screenshot_selector_qt as selector


@pytest.fixture
def worker(tmp_path, monkeypatch):
    monkeypatch.setattr(selector.tempfile, "mkdtemp", lambda **kwargs: str(tmp_path))
    monkeypatch.setattr(
        selector,
        "get_config",
        lambda: SimpleNamespace(screenshot=SimpleNamespace(trim_black_bars_wip=True, width=0, height=0)),
    )
    instance = selector.FrameWorker(1, "recording.mp4")
    instance.duration = 200
    return instance


@pytest.fixture
def decoder(monkeypatch):
    calls = []
    crops = []

    class Process:
        returncode = 0

        def __init__(self, command, **kwargs):
            calls.append(command)
            count = int(command[command.index("-frames:v") + 1])
            for index in range(count):
                Path(command[-1] % (index + 1)).write_bytes(b"frame")

        def communicate(self, **kwargs):
            return "", ""

        def poll(self):
            return self.returncode

    monkeypatch.setattr(selector.subprocess, "Popen", Process)
    monkeypatch.setattr(selector.ffmpeg, "find_black_bars", lambda *args: crops.append(args) or "crop=1280:720:0:0")
    return calls, crops


def test_page_uses_one_decoder_and_one_crop_detection_then_reuses_cache(worker, decoder):
    calls, crops = decoder
    positions = tuple(14 + index * 0.5 for index in range(25))
    frames = worker._extract_page(positions, 0)
    assert [position for position, _ in frames] == list(positions)
    assert all(Path(path).is_file() for _, path in frames)
    assert len(calls) == len(crops) == 1
    filters = calls[0][calls[0].index("-vf") + 1]
    assert filters.startswith("fps=2")
    assert "crop=1280:720:0:0" in filters
    assert worker._extract_page(positions, 0) == frames
    assert len(calls) == len(crops) == 1


def test_cache_keeps_selections_and_two_unselected_pages(worker, decoder):
    for page in range(5):
        frames = worker._extract_page(tuple(page * 12.5 + index * 0.5 for index in range(25)), 0)
        assert all(Path(path).is_file() for _, path in frames)
        if page < 3:
            for _, path in frames:
                worker.pin(path)
    assert len(worker.pinned) == 75
    assert all(Path(path).is_file() for path in worker.pinned)
    worker._extract_page(tuple(62.5 + index * 0.5 for index in range(25)), 0)
    assert len(worker.cache) == 125
    assert all(Path(path).is_file() for path in worker.pinned)


def test_partly_cached_page_reuses_pinned_file(worker, decoder):
    positions = tuple(index * 0.5 for index in range(25))
    original = worker._extract_page(positions, 0)
    worker.pin(original[0][1])
    for page in range(1, 4):
        worker._extract_page(tuple(page * 12.5 + index * 0.5 for index in range(25)), 0)
    assert not Path(original[1][1]).exists()
    refreshed = worker._extract_page(positions, 0)
    assert refreshed[0] == original[0]
    assert Path(original[0][1]).is_file()
    assert len(list(Path(worker.directory).glob("*.png"))) == len(worker.cache)


def test_obsolete_page_kills_running_decoder_and_removes_partial_frames(worker, monkeypatch):
    monkeypatch.setattr(selector.ffmpeg, "find_black_bars", lambda *args: "")
    killed = []

    class Process:
        returncode = None

        def __init__(self, command, **kwargs):
            self.command = command
            Path(command[-1] % 1).write_bytes(b"partial")

        def communicate(self, **kwargs):
            if self.returncode is None:
                worker.latest_generation = 2
                raise selector.subprocess.TimeoutExpired(self.command, 0.1)
            return "", ""

        def poll(self):
            return self.returncode

        def kill(self):
            self.returncode = -1
            killed.append(True)

    monkeypatch.setattr(selector.subprocess, "Popen", Process)
    assert worker._extract_page((0, 0.5), 0) == []
    assert killed == [True]
    assert list(Path(worker.directory).iterdir()) == []
    assert worker.cache == {}


def test_failed_batch_removes_partial_files(worker, decoder, monkeypatch):
    def failed(command, generation):
        Path(command[-1] % 1).write_bytes(b"partial")
        return SimpleNamespace(returncode=1, stderr="decode failed")

    monkeypatch.setattr(worker, "_run_batch", failed)
    with pytest.raises(RuntimeError, match="decode failed"):
        worker._extract_page((0, 0.5), 0)
    assert list(Path(worker.directory).iterdir()) == []


def test_queued_obsolete_pages_are_skipped(worker, monkeypatch):
    calls = []
    monkeypatch.setattr(worker, "_probe", lambda: None)

    def extract(positions, generation):
        calls.append((generation, positions))
        worker.stop()
        return []

    monkeypatch.setattr(worker, "_extract_page", extract)
    worker.request_page(1, (0, 0.5))
    worker.request_page(2, (12.5, 13))
    worker.run()
    assert calls == [(2, (12.5, 13))]


@pytest.mark.parametrize(
    "duration,start,count",
    [(14, 0.017, 25), (0.02, 0, 1), (0.8, 0, 2), (1, 0.966666, 1)],
)
def test_real_decoder_handles_batches_and_recording_boundaries(worker, tmp_path, monkeypatch, duration, start, count):
    encoder = shutil.which("ffmpeg")
    if not encoder:
        pytest.skip("FFmpeg is unavailable")
    video = tmp_path / "source.mp4"
    subprocess.run(
        [
            encoder,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=30",
            "-t",
            str(duration),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            str(video),
        ],
        capture_output=True,
        check=True,
        timeout=30,
    )
    worker.source_path = str(video)
    monkeypatch.setattr(selector, "ffmpeg_base_command_list", [encoder, "-hide_banner", "-loglevel", "error"])
    monkeypatch.setattr(
        selector,
        "get_config",
        lambda: SimpleNamespace(screenshot=SimpleNamespace(trim_black_bars_wip=False, width=0, height=0)),
    )
    positions = tuple(start + index * 0.5 for index in range(count))
    frames = worker._extract_page(positions, 0)
    assert [position for position, _ in frames] == list(positions)
    assert all(Path(path).stat().st_size > 0 for _, path in frames)
