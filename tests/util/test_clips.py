from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime, timedelta
from itertools import pairwise
from types import SimpleNamespace

import numpy as np
import pytest

from GameSentenceMiner.util import clips
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.text_log import GameLine
from tests.clip_helpers import BASE, write_clip

requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not available",
)


@pytest.fixture(autouse=True)
def system_ffmpeg(monkeypatch):
    # On Windows GSM looks for ffmpeg in its app folder; use the system binaries, with production's flags.
    command = [shutil.which("ffmpeg") or "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    monkeypatch.setattr(ffmpeg, "ffmpeg_base_command_list", command)
    monkeypatch.setattr(ffmpeg, "get_ffprobe_path", lambda: shutil.which("ffprobe") or "ffprobe")


def _chain(*specs):
    """Build linked GameLines from (id, text, seconds_after_BASE) tuples."""
    lines = [GameLine(id=i, text=t, time=BASE + timedelta(seconds=s), prev=None, next=None) for i, t, s in specs]
    for previous, current in pairwise(lines):
        previous.next = current
        current.prev = previous
    return lines


def _seconds(delta_time):
    return (delta_time - BASE).total_seconds()


# --- plan_clip_window -------------------------------------------------------


def test_window_includes_close_previous_line_and_next_line_context():
    prev, line, nxt = _chain(("p", "前", 10), ("l", "今", 20), ("n", "次", 25))

    window = clips.plan_clip_window(line)

    assert window.previous_line is prev
    assert window.next_line is nxt
    assert _seconds(window.start_time) == pytest.approx(10 - clips.LEAD_SECONDS)
    assert _seconds(window.end_time) == pytest.approx(25 + clips.NEXT_LINE_CONTEXT_SECONDS)


def test_window_skips_previous_line_that_is_too_far_back():
    _, line = _chain(("p", "前", 0), ("l", "今", 20 + clips.PREVIOUS_LINE_MAX_GAP_SECONDS))

    window = clips.plan_clip_window(line)

    assert window.previous_line is None
    assert window.start_time == line.time - timedelta(seconds=clips.LEAD_SECONDS)


def test_window_end_stops_shortly_after_the_line_following_next():
    _, nxt, after = _chain(("l", "今", 20), ("n", "次", 22), ("a", "後", 24))

    window = clips.plan_clip_window(nxt.prev)

    assert window.end_time == after.time + timedelta(seconds=clips.TRAIL_SECONDS)


def test_window_for_newest_line_leaves_room_for_the_voice():
    (line,) = _chain(("l", "今", 20))

    window = clips.plan_clip_window(line)

    assert window.next_line is None
    assert window.end_time == line.time + timedelta(seconds=clips.NEWEST_LINE_WINDOW_SECONDS)


def test_window_adds_source_padding_before_the_line():
    (line,) = _chain(("l", "今", 20))
    line.source_padding = 2.5

    window = clips.plan_clip_window(line)

    assert window.start_time == line.time - timedelta(seconds=clips.LEAD_SECONDS + 2.5)


def test_wait_is_needed_until_the_planned_end_is_recorded():
    (line,) = _chain(("l", "今", 20))
    now = line.time + timedelta(seconds=3)

    wait = clips.seconds_until_clip_ready(line, now=now)

    assert wait == pytest.approx(clips.NEWEST_LINE_WINDOW_SECONDS - 3)


def test_no_wait_for_old_lines_and_wait_is_capped():
    (line,) = _chain(("l", "今", 20))

    assert clips.seconds_until_clip_ready(line, now=line.time + timedelta(minutes=1)) == 0
    assert clips.seconds_until_clip_ready(line, now=line.time - timedelta(minutes=5)) == pytest.approx(
        clips.MAX_WAIT_SECONDS
    )


# --- save_clip -----------------------------------------------------


def _make_replay(path, duration=40, keyframe_interval=3):
    """Synthetic replay whose audio is a frequency sweep, so every moment of it is unique."""
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size=160x120:rate=10:duration={duration}",
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc='sin(2*PI*(300*t+4*t*t))':s=16000:d={duration}",
            "-c:v",
            "libx264",
            "-g",
            str(keyframe_interval * 10),
            "-keyint_min",
            str(keyframe_interval * 10),
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
            "-y",
            str(path),
        ],
        check=True,
    )
    return ffmpeg.get_video_duration(str(path))


def _end_replay_at(replay, end_time):
    """OBS replays end at their modification time."""
    os.utime(replay, (end_time.timestamp(), end_time.timestamp()))


def _audio(path, start, seconds=2.0):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(start), "-i", str(path), "-t", str(seconds)]
        + ["-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(float)


@requires_ffmpeg
def test_clip_is_shaped_like_an_obs_replay(tmp_path, monkeypatch):
    # OBS replays can have keyframes ~17s apart, so the copy starts well before the requested time.
    replay = tmp_path / "Replay 2026-09-27 12-01-30.mkv"
    length = _make_replay(replay, duration=90, keyframe_interval=17)
    _end_replay_at(replay, BASE + timedelta(seconds=length))
    prev, line, nxt = _chain(("p", "前の行", 44), ("l", "保存する行", 50), ("n", "次の行", 54))
    windows = []
    monkeypatch.setattr(
        clips, "pause_history", SimpleNamespace(get_pauses_between=lambda *window: windows.append(window) or [(1, 2)])
    )

    folder = clips.save_clip(str(replay), line, str(tmp_path / "Saved"))

    manifest = clips.read_manifest(folder)
    assert [(entry["id"], entry["role"]) for entry in manifest["lines"]] == [
        ("p", "previous"),
        ("l", "selected"),
        ("n", "next"),
    ]
    clip = os.path.join(folder, manifest["clip"]["file"])
    # The game pauses inside the clip are kept, so their silence can be removed however late it is mined.
    ((pause_start, pause_end),) = windows
    assert pause_end - pause_start == pytest.approx(ffmpeg.get_video_duration(clip))
    assert manifest["pauses"] == [[1, 2]]
    assert clip.endswith(".mkv")
    streams = ffmpeg.FFmpegHelper.get_probe_json(clip, "stream=codec_type", "")["streams"]
    assert {s["codec_type"] for s in streams} == {"video", "audio"}
    clip_end = datetime.fromisoformat(manifest["clip"]["end_time"])
    assert os.path.getmtime(clip) == pytest.approx(clip_end.timestamp(), abs=0.01)

    # The Anki flow finds a line from the file's length and modification time, exactly as for OBS.
    for context_line in (prev, line, nxt):
        _, position_in_clip, _, _ = ffmpeg.get_video_timings(clip, context_line)
        from_clip = _audio(clip, position_in_clip)
        from_replay = _audio(replay, _seconds(context_line.time))
        size = min(len(from_clip), len(from_replay))
        lag = np.argmax(np.correlate(from_clip[:size], from_replay[:size], "full")) - (size - 1)
        assert abs(lag) / 8000 < 0.05, f"{context_line.id} is off by {lag / 8000:.3f}s"


@requires_ffmpeg
def test_line_older_than_the_replay_is_refused(tmp_path):
    replay = tmp_path / "replay.mkv"
    length = _make_replay(replay, duration=10)
    _end_replay_at(replay, BASE + timedelta(seconds=length + 30))
    (line,) = _chain(("l", "古い", 0))

    with pytest.raises(clips.LineOutsideReplayError):
        clips.save_clip(str(replay), line, str(tmp_path / "Saved"))

    assert not (tmp_path / "Saved").exists()


@requires_ffmpeg
def test_saving_the_same_line_again_reuses_its_folder(tmp_path):
    replay = tmp_path / "replay.mkv"
    length = _make_replay(replay)
    _, line, _ = _chain(("p", "前", 12), ("l", "今", 16), ("n", "次", 20))
    line.first_seen_time = line.time - timedelta(milliseconds=250)
    _end_replay_at(replay, BASE + timedelta(seconds=length))

    first = clips.save_clip(str(replay), line, str(tmp_path / "Saved"))
    line.text = "今（改訂）"
    line.time += timedelta(seconds=1)  # a later revision moves `time`, not `first_seen_time`
    second = clips.save_clip(str(replay), line, str(tmp_path / "Saved"))

    assert second == first
    assert os.path.basename(first).startswith("12-00-15-750_")
    assert len(os.listdir(os.path.dirname(first))) == 1


# --- reading clip lines back ------------------------------------------------


def test_load_clip_rebuilds_linked_lines_ending_at_the_clip(tmp_path):
    folder = write_clip(
        tmp_path, "a", [("p", "前", "previous", 10), ("l", "今", "selected", 15), ("n", "次", "next", 20)], 28
    )

    clip = clips.load_clip(str(folder))

    prev, line, nxt = clip.lines
    assert [line.id for line in clip.selected] == ["l"]
    assert (prev.next, line.prev, line.next, nxt.prev, nxt.next) == (line, prev, nxt, line, None)
    assert clip.clip_end_time == BASE + timedelta(seconds=28)
    # mined_time lets next_line() cut the audio at the following line, as in the live flow.
    assert line.next_line() is nxt and line.get_next_time() == nxt.time
    assert clip.clip_path == str(folder / "clip.mkv")
    assert line.scene == "FFVII"
    assert line.clip is clip and clip.lines[line.index] is line


def test_unreadable_clip_folders_are_skipped(tmp_path):
    write_clip(tmp_path, "a", [("a", "今", "selected", 10)], 15)
    broken = tmp_path / "2026-09-27" / "broken"
    broken.mkdir()
    (broken / clips.MANIFEST_NAME).write_text("{not json", encoding="utf-8")

    assert [clip.selected[0].id for clip in clips.iter_clips(str(tmp_path))] == ["a"]
    assert list(clips.iter_clips(str(tmp_path / "missing"))) == []
