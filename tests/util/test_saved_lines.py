from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime, timedelta
from itertools import pairwise

import numpy as np
import pytest

from GameSentenceMiner.util import saved_lines
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.text_log import GameLine

requires_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not available",
)

BASE = datetime(2026, 9, 27, 12, 0, 0)


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

    window = saved_lines.plan_clip_window([line])

    assert window.previous_line is prev
    assert window.next_line is nxt
    assert _seconds(window.start_time) == pytest.approx(10 - saved_lines.LEAD_SECONDS)
    assert _seconds(window.end_time) == pytest.approx(25 + saved_lines.NEXT_LINE_CONTEXT_SECONDS)


def test_window_skips_previous_line_that_is_too_far_back():
    _, line = _chain(("p", "前", 0), ("l", "今", 20 + saved_lines.PREVIOUS_LINE_MAX_GAP_SECONDS))

    window = saved_lines.plan_clip_window([line])

    assert window.previous_line is None
    assert window.start_time == line.time - timedelta(seconds=saved_lines.LEAD_SECONDS)


def test_window_end_stops_shortly_after_the_line_following_next():
    _, nxt, after = _chain(("l", "今", 20), ("n", "次", 22), ("a", "後", 24))

    window = saved_lines.plan_clip_window([nxt.prev])

    assert window.end_time == after.time + timedelta(seconds=saved_lines.TRAIL_SECONDS)


def test_window_for_newest_line_leaves_room_for_the_voice():
    (line,) = _chain(("l", "今", 20))

    window = saved_lines.plan_clip_window([line])

    assert window.next_line is None
    assert window.end_time == line.time + timedelta(seconds=saved_lines.NEWEST_LINE_WINDOW_SECONDS)


def test_window_adds_source_padding_before_the_first_line():
    (line,) = _chain(("l", "今", 20))
    line.source_padding = 2.5

    window = saved_lines.plan_clip_window([line])

    assert window.start_time == line.time - timedelta(seconds=saved_lines.LEAD_SECONDS + 2.5)


def test_window_orders_lines_chronologically():
    first, _, last = _chain(("a", "一", 10), ("b", "二", 30), ("c", "三", 50))

    window = saved_lines.plan_clip_window([last, first])

    assert window.lines == [first, last]


def test_wait_is_needed_until_the_planned_end_is_recorded():
    (line,) = _chain(("l", "今", 20))
    now = line.time + timedelta(seconds=3)

    wait = saved_lines.seconds_until_clip_ready([line], now=now)

    assert wait == pytest.approx(saved_lines.NEWEST_LINE_WINDOW_SECONDS - 3)


def test_no_wait_for_old_lines_and_wait_is_capped():
    (line,) = _chain(("l", "今", 20))

    assert saved_lines.seconds_until_clip_ready([line], now=line.time + timedelta(minutes=1)) == 0
    assert saved_lines.seconds_until_clip_ready([line], now=line.time - timedelta(minutes=5)) == pytest.approx(
        saved_lines.MAX_WAIT_SECONDS
    )


# --- save_lines_to_disk -----------------------------------------------------


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


def _audio(path, start, seconds=2.0):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(start), "-i", str(path), "-t", str(seconds)]
        + ["-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(float)


@requires_ffmpeg
def test_saved_clip_is_shaped_like_an_obs_replay(tmp_path):
    # OBS replays can have keyframes ~17s apart, so the copy starts well before the requested time.
    replay = tmp_path / "Replay 2026-09-27 12-01-30.mkv"
    length = _make_replay(replay, duration=90, keyframe_interval=17)
    replay_end = BASE + timedelta(seconds=length)
    prev, line, nxt = _chain(("p", "前の行", 44), ("l", "保存する行", 50), ("n", "次の行", 54))

    folder = saved_lines.save_lines_to_disk(
        str(replay), [line], str(tmp_path / "Saved"), game="Test Game", replay_end_time=replay_end
    )

    manifest = saved_lines.read_manifest(folder)
    clip = os.path.join(folder, manifest["clip"]["file"])
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
def test_manifest_records_selected_and_context_lines(tmp_path):
    replay = tmp_path / "replay.mkv"
    length = _make_replay(replay)
    _, first, second, _ = _chain(("p", "前", 12), ("a", "一", 16), ("b", "二", 19), ("n", "次", 23))

    folder = saved_lines.save_lines_to_disk(
        str(replay),
        [second, first],
        str(tmp_path / "Saved"),
        game="Test Game",
        replay_end_time=BASE + timedelta(seconds=length),
    )

    manifest = saved_lines.read_manifest(folder)
    assert manifest["version"] == saved_lines.MANIFEST_VERSION
    assert manifest["game"] == "Test Game"
    assert manifest["sentence"] == "一二"
    assert manifest["selected_line_ids"] == ["a", "b"]
    assert [(entry["id"], entry["role"]) for entry in manifest["lines"]] == [
        ("p", "previous"),
        ("a", "selected"),
        ("b", "selected"),
        ("n", "next"),
    ]
    assert datetime.fromisoformat(manifest["lines"][1]["time"]) == first.time
    assert sorted(os.listdir(folder)) == ["clip.mkv", saved_lines.MANIFEST_NAME]
    assert os.path.dirname(os.path.dirname(folder)) == str(tmp_path / "Saved")


@requires_ffmpeg
def test_line_older_than_the_replay_is_refused(tmp_path):
    replay = tmp_path / "replay.mkv"
    length = _make_replay(replay, duration=10)
    (line,) = _chain(("l", "古い", 0))

    with pytest.raises(saved_lines.LineOutsideReplayError):
        saved_lines.save_lines_to_disk(
            str(replay),
            [line],
            str(tmp_path / "Saved"),
            replay_end_time=BASE + timedelta(seconds=length + 30),
        )

    assert not (tmp_path / "Saved").exists()


def test_read_manifest_round_trips(tmp_path):
    (tmp_path / saved_lines.MANIFEST_NAME).write_text(json.dumps({"version": 1}), encoding="utf-8")

    assert saved_lines.read_manifest(str(tmp_path)) == {"version": 1}


@requires_ffmpeg
def test_saving_the_same_line_again_reuses_its_folder(tmp_path):
    replay = tmp_path / "replay.mkv"
    length = _make_replay(replay)
    _, line, _ = _chain(("p", "前", 12), ("l", "今", 16), ("n", "次", 20))
    line.first_seen_time = line.time - timedelta(milliseconds=250)
    kwargs = {"replay_end_time": BASE + timedelta(seconds=length)}

    first = saved_lines.save_lines_to_disk(str(replay), [line], str(tmp_path / "Saved"), **kwargs)
    line.text = "今（改訂）"
    line.time += timedelta(seconds=1)  # a later revision moves `time`, not `first_seen_time`
    second = saved_lines.save_lines_to_disk(str(replay), [line], str(tmp_path / "Saved"), **kwargs)

    assert second == first
    assert os.path.basename(first).startswith("12-00-15-750_")
    assert len(os.listdir(os.path.dirname(first))) == 1


def test_find_saved_folder_matches_the_same_selection_only(tmp_path):
    a, b = _chain(("a", "一", 10), ("b", "二", 12))
    folder = tmp_path / "2026-09-27" / "12-00-10-000_一"
    folder.mkdir(parents=True)
    (folder / saved_lines.MANIFEST_NAME).write_text(json.dumps({"selected_line_ids": ["a"]}), encoding="utf-8")

    assert saved_lines.find_saved_folder(str(tmp_path), [a]) == str(folder)
    assert saved_lines.find_saved_folder(str(tmp_path), [a, b]) is None
    assert saved_lines.find_saved_folder(str(tmp_path), [b]) is None


# --- reading saved lines back ------------------------------------------------


def _write_saved(root, name, entries, end_seconds, game="Game"):
    folder = root / "2026-09-27" / name
    folder.mkdir(parents=True)
    manifest = {
        "version": 1,
        "game": game,
        "sentence": "".join(e[1] for e in entries if e[2] == "selected"),
        "selected_line_ids": [e[0] for e in entries if e[2] == "selected"],
        "lines": [
            {"id": i, "text": t, "time": (BASE + timedelta(seconds=s)).isoformat(), "role": r, "source_padding": 0}
            for i, t, r, s in ((e[0], e[1], e[2], e[3]) for e in entries)
        ],
        "clip": {"file": "clip.mkv", "end_time": (BASE + timedelta(seconds=end_seconds)).isoformat()},
    }
    (folder / saved_lines.MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (folder / "clip.mkv").write_bytes(b"")
    return folder


def _card(sentence, expression=""):
    fields = {"Sentence": sentence, "Expression": expression}
    return type("Card", (), {"get_field": lambda self, field: fields[field]})()


@pytest.fixture
def matcher_config(monkeypatch):
    from types import SimpleNamespace

    from GameSentenceMiner.util import text_log

    monkeypatch.setattr(
        text_log,
        "get_config",
        lambda: SimpleNamespace(anki=SimpleNamespace(sentence_field="Sentence", word_field="Expression")),
    )


def test_load_saved_line_rebuilds_linked_lines_ending_at_the_clip(tmp_path):
    folder = _write_saved(
        tmp_path, "a", [("p", "前", "previous", 10), ("l", "今", "selected", 15), ("n", "次", "next", 20)], 28
    )

    saved = saved_lines.load_saved_line(str(folder))

    prev, line, nxt = saved.lines
    assert [line.id for line in saved.selected] == ["l"]
    assert (prev.next, line.prev, line.next, nxt.prev, nxt.next) == (line, prev, nxt, line, None)
    assert saved.clip_end_time == BASE + timedelta(seconds=28)
    # mined_time lets next_line() cut the audio at the following line, as in the live flow.
    assert line.next_line() is nxt and line.get_next_time() == nxt.time
    assert saved.clip_path == str(folder / "clip.mkv")
    assert saved.game == "Game"


def test_saved_lines_keep_their_neighbours_as_translation_context(tmp_path):
    folder = _write_saved(tmp_path, "a", [("p", "前", "previous", 10), ("l", "今", "selected", 15)], 20)

    saved = saved_lines.load_saved_line(str(folder))

    line = saved.selected[0]
    assert line.saved_context_lines == saved.lines
    assert line.saved_context_lines[line.index] is line


def test_card_is_matched_to_the_saved_line_with_the_same_ranking(tmp_path, matcher_config):
    _write_saved(tmp_path, "a", [("a", "心当たりはねえのかこの声の主", "selected", 10)], 15)
    _write_saved(tmp_path, "b", [("b", "何度も同じ事を言わせるな", "selected", 30)], 35)

    match = saved_lines.match_card_to_saved_line(_card("何度も<b>同じ事</b>を言わせるな", "同じ"), str(tmp_path))

    saved, line = match
    assert line.id == "b" and os.path.basename(saved.folder) == "b"


def test_card_matching_prefers_the_newest_saved_line_on_a_tie(tmp_path, matcher_config):
    _write_saved(tmp_path, "old", [("old", "同じ台詞です", "selected", 10)], 15)
    _write_saved(tmp_path, "new", [("new", "同じ台詞です", "selected", 60)], 65)

    saved, _ = saved_lines.match_card_to_saved_line(_card("同じ台詞です"), str(tmp_path))

    assert os.path.basename(saved.folder) == "new"


def test_no_saved_match_returns_none_and_unreadable_folders_are_skipped(tmp_path, matcher_config):
    _write_saved(tmp_path, "a", [("a", "心当たりはねえのか", "selected", 10)], 15)
    broken = tmp_path / "2026-09-27" / "broken"
    broken.mkdir()
    (broken / saved_lines.MANIFEST_NAME).write_text("{not json", encoding="utf-8")

    assert saved_lines.match_card_to_saved_line(_card("全く関係のない文"), str(tmp_path)) is None
    assert saved_lines.match_card_to_saved_line(_card("x"), str(tmp_path / "missing")) is None
    assert len(list(saved_lines.iter_saved_lines(str(tmp_path)))) == 1


def test_record_card_appends_to_the_manifest(tmp_path):
    folder = _write_saved(tmp_path, "a", [("a", "今", "selected", 10)], 15)

    saved_lines.record_card(str(folder), note_id=123, word="今")
    saved_lines.record_card(str(folder), note_id=456, word="今日")

    cards = saved_lines.read_manifest(str(folder))["cards"]
    assert [(c["note_id"], c["word"]) for c in cards] == [(123, "今"), (456, "今日")]
