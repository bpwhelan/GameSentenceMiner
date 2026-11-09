import json
import os
from concurrent.futures import Future
from datetime import timedelta
from pathlib import Path

import pytest

from GameSentenceMiner import anki, session_review
from GameSentenceMiner.util.text_log import GameLine
from tests.test_session_review import saved_review as saved_review  # noqa: PLC0414


def context_module():
    from GameSentenceMiner import session_review_context

    return session_review_context


def following_lines(entry, count=3):
    original = session_review.load_review(entry).context.mined_line
    return [
        GameLine(
            f"future-{index}",
            f"Future {index}",
            original.time + timedelta(seconds=2 * index),
            None,
            None,
            scene="Game",
            session_id="session",
        )
        for index in range(1, count + 1)
    ]


def queue_future(entry, config, monkeypatch, *, count=3):
    module = context_module()
    anchor = session_review.load_review(entry).context.mined_line
    anchor.session_id = "session"
    module.register(entry, anchor, [anchor], config)
    lines = following_lines(entry, count)
    queued = []
    from GameSentenceMiner import replay_handler

    monkeypatch.setattr(
        replay_handler, "request_session_review_replay", lambda targets: queued.extend(targets) or Future()
    )
    return module, lines, queued


def test_capture_waits_for_configured_lines_and_ignores_revisions_and_other_sessions(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    module, lines, queued = queue_future(entry, config, monkeypatch)
    now = lines[-1].time + timedelta(seconds=3)
    unrelated = GameLine("other", "Different session", lines[-1].time, None, None, scene="Game", session_id="other")
    module.poll(lines=[lines[0], lines[0], lines[1], unrelated], now=now, config=config)
    assert not queued
    module.poll(lines=lines, now=now, config=config)
    assert len(queued) == 1
    assert [line["id"] for line in queued[0].future_lines] == [line.id for line in lines]
    module.poll(lines=lines, now=now, config=config)
    assert len(queued) == 1


def save_future(entry, config, replay, monkeypatch):
    module, lines, queued = queue_future(entry, config, monkeypatch)
    capture_end = lines[-1].time + timedelta(seconds=3)
    module.poll(lines=lines, now=capture_end, config=config)
    later_replay = replay.with_name("later.mkv")
    later_replay.write_bytes(b"future replay")
    os.utime(later_replay, (capture_end.timestamp(), capture_end.timestamp()))
    from GameSentenceMiner.util.media import ffmpeg

    monkeypatch.setattr(ffmpeg, "get_video_duration", lambda path: 30)
    module.capture_replay(str(later_replay), queued)
    return module, later_replay, queued


def test_future_context_survives_restart_but_original_replay_stays_default(saved_review, monkeypatch):
    entry, config, replay, *_ = saved_review
    original_video = session_review.load_review(entry).context.video_path
    module, later, _ = save_future(entry, config, replay, monkeypatch)
    later.unlink()
    module.cancel(entry.id)
    restored = session_review.list_pending_reviews(config)[0]
    prepared = session_review.load_review(restored)
    assert prepared.context.video_path == original_video
    assert prepared.context.mined_line.next.text == "Future 1"
    assert prepared.future_clip is not None
    assert Path(prepared.future_clip.clip_path).read_bytes() == b"future replay"
    assert [line.id for line in prepared.future_clip.lines if line.id.startswith("future-")] == [
        "future-1",
        "future-2",
        "future-3",
    ]


def test_unused_future_replay_is_removed_even_when_retaining_original_review_files(saved_review, monkeypatch):
    entry, config, replay, *_ = saved_review
    module, later, queued = save_future(entry, config, replay, monkeypatch)
    prepared = session_review.load_review(entry)
    future_file = Path(prepared.future_clip.clip_path)
    original_file = Path(prepared.context.video_path)
    config.features.review_after_session.delete_local_after_review = False
    monkeypatch.setattr(anki, "invoke", lambda *args, **kwargs: pytest.fail("Unchanged review contacted Anki"))
    session_review.apply_review(entry, prepared, (False, "Sentence", "Meaning", "", "", False, prepared.audio_path, {}))
    assert not future_file.exists()
    assert original_file.exists()
    # A capture completing late must never resurrect a reviewed card's files.
    monkeypatch.setattr(
        module.ffmpeg, "get_video_duration", lambda *args: pytest.fail("A completed review probed its extra replay")
    )
    module.capture_replay(str(later), queued)
    assert not (entry.folder / "future").exists()
    assert json.loads((entry.folder / "review.json").read_text(encoding="utf-8"))["status"] == "reviewed"


def test_disabled_or_expired_future_capture_does_not_request_obs(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    module, lines, queued = queue_future(entry, config, monkeypatch)
    config.features.review_after_session.max_future_context_lines = 0
    module.register(entry, session_review.load_review(entry).context.mined_line, [], config)
    module.poll(lines=lines, now=lines[-1].time + timedelta(seconds=3), config=config)
    assert not queued
    config.features.review_after_session.max_future_context_lines = 3
    module.register(entry, session_review.load_review(entry).context.mined_line, [], config)
    module.poll(lines=lines, now=lines[-1].time + timedelta(hours=1), config=config)
    assert not queued


def test_selection_uses_future_replay_only_for_future_lines(saved_review, monkeypatch):
    entry, config, replay, *_ = saved_review
    module, _, _ = save_future(entry, config, replay, monkeypatch)
    prepared = session_review.load_review(entry)
    mined = prepared.context.mined_line
    original_path = prepared.context.video_path
    assert module.context_for_selection(prepared, [mined.prev, mined]).video_path == original_path
    expanded = module.context_for_selection(prepared, [mined, mined.next])
    assert expanded.video_path == prepared.future_clip.clip_path
    assert expanded.anki_card_creation_time == prepared.future_clip.clip_end_time
    assert expanded.mined_line.clip is prepared.future_clip
    assert prepared.context.video_path == original_path
    assert module.context_for_selection(prepared, [mined]).video_path == original_path


def test_context_from_another_game_or_after_confirmation_does_not_capture(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    module, lines, queued = queue_future(entry, config, monkeypatch)
    module.poll(lines=lines, now=lines[-1].time + timedelta(seconds=3), config=config, scene="Another game")
    assert not queued
    assert not module.has_pending()
    module, lines, queued = queue_future(entry, config, monkeypatch)
    session_review.finish_review(entry, config.features.review_after_session)
    module.poll(lines=lines, now=lines[-1].time + timedelta(seconds=3), config=config)
    assert not queued


def test_expired_or_missing_extra_replay_keeps_original_review_usable(saved_review, monkeypatch):
    entry, config, replay, *_ = saved_review
    save_future(entry, config, replay, monkeypatch)
    prepared = session_review.load_review(entry)
    Path(prepared.future_clip.clip_path).unlink()
    reloaded = session_review.load_review(entry)
    assert reloaded.future_clip is None
    assert reloaded.context.mined_line.next is None
    assert Path(reloaded.context.video_path).is_file()
