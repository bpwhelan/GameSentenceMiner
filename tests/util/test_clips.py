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


def test_window_includes_two_lines_before_and_after_with_two_seconds_padding():
    before, prev, line, nxt, after = _chain(
        ("p2", "前々", 10), ("p", "前", 15), ("l", "今", 20), ("n", "次", 25), ("n2", "次々", 30)
    )

    window = clips.plan_clip_window(line)

    assert window.previous_lines == [before, prev]
    assert window.next_lines == [nxt, after]
    assert _seconds(window.start_time) == pytest.approx(8)
    assert _seconds(window.end_time) == pytest.approx(32)


def test_window_keeps_two_neighbors_even_when_dialogue_has_long_gaps():
    before, prev, line, nxt, after = _chain(
        ("p2", "前々", 0), ("p", "前", 30), ("l", "今", 60), ("n", "次", 90), ("n2", "次々", 120)
    )

    window = clips.plan_clip_window(line)

    assert window.previous_lines == [before, prev]
    assert window.next_lines == [nxt, after]
    assert _seconds(window.start_time) == pytest.approx(-2)
    assert _seconds(window.end_time) == pytest.approx(122)


def test_window_excludes_neighbors_beyond_two_lines_each_way():
    _, before, prev, line, nxt, after, _ = _chain(
        ("p3", "外", 0),
        ("p2", "前々", 10),
        ("p", "前", 15),
        ("l", "今", 20),
        ("n", "次", 25),
        ("n2", "次々", 30),
        ("n3", "外", 40),
    )

    window = clips.plan_clip_window(line)

    assert window.previous_lines == [before, prev]
    assert window.next_lines == [nxt, after]
    assert _seconds(window.start_time) == pytest.approx(8)
    assert _seconds(window.end_time) == pytest.approx(32)


def test_window_uses_available_lines_at_the_edges_of_history():
    (line,) = _chain(("l", "今", 20))

    window = clips.plan_clip_window(line)

    assert window.previous_lines == []
    assert window.next_lines == []
    assert _seconds(window.start_time) == pytest.approx(18)
    assert _seconds(window.end_time) == pytest.approx(22)


def test_window_uses_exact_padding_regardless_of_text_source():
    (line,) = _chain(("l", "今", 20))
    line.source_padding = 2.5

    window = clips.plan_clip_window(line)

    assert window.start_time == line.time - timedelta(seconds=2)


def test_wait_is_needed_until_the_planned_end_is_recorded():
    line, _, after = _chain(("l", "今", 20), ("n", "次", 25), ("n2", "次々", 30))
    now = after.time + timedelta(seconds=1)

    wait = clips.seconds_until_clip_ready(line, now=now)

    assert wait == pytest.approx(1)


def test_newest_line_waits_for_two_following_lines_with_a_deadline():
    (line,) = _chain(("l", "今", 20))

    assert clips.seconds_until_clip_ready(line, now=line.time + timedelta(seconds=3)) == pytest.approx(17)
    assert clips.seconds_until_clip_ready(line, now=line.time + timedelta(seconds=20)) == 0


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
    before, prev, line, nxt, after = _chain(
        ("p2", "前々の行", 40),
        ("p", "前の行", 44),
        ("l", "保存する行", 50),
        ("n", "次の行", 54),
        ("n2", "次々の行", 60),
    )
    windows = []
    monkeypatch.setattr(
        clips, "pause_history", SimpleNamespace(get_pauses_between=lambda *window: windows.append(window) or [(1, 2)])
    )

    folder = clips.save_clip(str(replay), line, str(tmp_path / "Saved"))

    manifest = clips.read_manifest(folder)
    assert [(entry["id"], entry["role"]) for entry in manifest["lines"]] == [
        ("p2", "previous"),
        ("p", "previous"),
        ("l", "selected"),
        ("n", "next"),
        ("n2", "next"),
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
    for context_line in (before, prev, line, nxt, after):
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


def test_saved_context_only_exposes_dialogue_covered_by_the_replay(tmp_path, monkeypatch):
    replay = tmp_path / "replay.mkv"
    replay.write_bytes(b"replay")
    _end_replay_at(replay, BASE + timedelta(seconds=30))
    _, _, line, _, _ = _chain(
        ("p2", "前々", 5), ("p", "前", 10), ("s", "選択", 20), ("n", "次", 25), ("n2", "次々", 35)
    )
    monkeypatch.setattr(ffmpeg, "get_video_duration", lambda path: 15.0)
    monkeypatch.setattr(clips.pause_history, "get_pauses_between", lambda *args: [])

    def copy_segment(video_path, start, end, output_path):
        assert (start, end) == (0.0, 15.0)
        with open(output_path, "wb") as output:
            output.write(b"clip")
        return 0.0

    monkeypatch.setattr(ffmpeg, "copy_replay_segment", copy_segment)

    folder = clips.save_clip(str(replay), line, str(tmp_path / "Saved"))
    saved = clips.load_clip(folder)

    assert [context.id for context in saved.lines] == ["s", "n"]
    assert saved.selected[0].prev is None
    assert saved.selected[0].next.next is None


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
