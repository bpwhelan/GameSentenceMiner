"""Unit tests for the Pending Reviews queue (Phase 1 data layer)."""

from __future__ import annotations

import os
import tempfile
import time
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.database.db import SQLiteDB
from GameSentenceMiner.util.database.pending_reviews_table import PendingReviewsTable
from GameSentenceMiner.util.models.model import VADResult


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    _db = SQLiteDB(path)
    PendingReviewsTable.set_db(_db)
    yield _db
    _db.close()
    try:
        os.unlink(path)
    except OSError:
        pass


@pytest.fixture()
def pending_reviews(db, monkeypatch):
    """Import the module fresh and clear the in-memory video pin map."""
    from GameSentenceMiner.util import pending_reviews as pr
    from GameSentenceMiner.util.config.configuration import gsm_state

    gsm_state.videos_pinned_for_review = {}
    yield pr
    gsm_state.videos_pinned_for_review = {}


# ---------------------------------------------------------------------------
# Snapshot serialization round-trip
# ---------------------------------------------------------------------------


def test_serialize_vad_result_round_trip(pending_reviews):
    original = VADResult(
        success=True,
        start=1.25,
        end=4.5,
        model="silero",
        output_audio="/tmp/out.opus",
        trimmed_audio_path="/tmp/trim.wav",
        tts_used=False,
    )
    data = pending_reviews.serialize_vad_result(original)
    restored = pending_reviews.deserialize_vad_result(data)
    assert restored.success is True
    assert restored.start == pytest.approx(1.25)
    assert restored.end == pytest.approx(4.5)
    assert restored.model == "silero"
    assert restored.output_audio == "/tmp/out.opus"
    assert restored.trimmed_audio_path == "/tmp/trim.wav"
    assert restored.tts_used is False


def test_serialize_vad_result_handles_none(pending_reviews):
    assert pending_reviews.serialize_vad_result(None) == {}
    assert pending_reviews.deserialize_vad_result(None) is None
    assert pending_reviews.deserialize_vad_result({}) is None


def test_serialize_audio_edit_context_from_object(pending_reviews):
    ctx = SimpleNamespace(
        source_audio_path="/tmp/source.wav",
        source_duration=10.0,
        range_start=1.0,
        range_end=8.0,
        rebase_on_selection_trim=True,
    )
    data = pending_reviews.serialize_audio_edit_context(ctx)
    assert data["source_audio_path"] == "/tmp/source.wav"
    assert data["source_duration"] == 10.0
    assert data["range_start"] == 1.0
    assert data["range_end"] == 8.0
    assert data["rebase_on_selection_trim"] is True


def test_serialize_audio_edit_context_from_dict_normalizes(pending_reviews):
    data = pending_reviews.serialize_audio_edit_context(
        {
            "source_audio_path": "/x.wav",
            "source_duration": "5",
            "range_start": "0.5",
            "range_end": "4.5",
            "rebase_on_selection_trim": 1,
        }
    )
    assert data["source_duration"] == 5.0
    assert data["range_start"] == 0.5
    assert data["rebase_on_selection_trim"] is True


# ---------------------------------------------------------------------------
# Enqueue / list / status transitions
# ---------------------------------------------------------------------------


def _build_assets():
    from GameSentenceMiner.anki import MediaAssets

    return MediaAssets(
        screenshot_path="/tmp/ss.png",
        prev_screenshot_path="/tmp/prev.png",
        pending_animated=False,
        pending_video=False,
        extra_tags=["mined"],
    )


def _build_game_line(line_id="line-1"):
    return SimpleNamespace(id=line_id, text="これは文です。", mined_time=None, prev=None)


def test_enqueue_persists_snapshot_and_pins_video(pending_reviews):
    last_note = SimpleNamespace(noteId=42)
    vad = VADResult(success=True, start=0.0, end=2.0, model="silero")
    entry = pending_reviews.enqueue(
        last_note=last_note,
        game_line=_build_game_line(),
        selected_lines=[],
        assets=_build_assets(),
        audio_path="/tmp/audio.opus",
        video_path="/tmp/video.mkv",
        screenshot_timestamp=1.5,
        prev_screenshot_timestamp=0.5,
        vad_result=vad,
        audio_edit_context=None,
        translation="It is a sentence.",
        sentence="これは文です。",
        expression="文",
    )

    assert entry.entry_id
    assert entry.status == "pending"
    fetched = PendingReviewsTable.get(entry.entry_id)
    assert fetched is not None
    assert fetched.expression == "文"
    assert fetched.audio_path == "/tmp/audio.opus"
    assert fetched.source_video_path == "/tmp/video.mkv"
    assert fetched.vad_result_data["success"] is True
    assert fetched.extra_tags == ["mined"]
    assert pending_reviews.is_video_pinned_for_review("/tmp/video.mkv")


def test_count_and_list_active(pending_reviews):
    for i in range(3):
        pending_reviews.enqueue(
            last_note=SimpleNamespace(noteId=i),
            game_line=_build_game_line(line_id=f"line-{i}"),
            selected_lines=[],
            assets=_build_assets(),
            audio_path="/tmp/a.opus",
            video_path=f"/tmp/v{i}.mkv",
            screenshot_timestamp=0,
            prev_screenshot_timestamp=0,
            vad_result=None,
            audio_edit_context=None,
            translation="",
            sentence=f"sentence {i}",
            expression=f"word{i}",
        )
    assert pending_reviews.count_pending() == 3
    assert len(pending_reviews.list_active()) == 3


def test_update_status_unpins_video_on_done(pending_reviews):
    entry = pending_reviews.enqueue(
        last_note=SimpleNamespace(noteId=7),
        game_line=_build_game_line(),
        selected_lines=[],
        assets=_build_assets(),
        audio_path="/tmp/a.opus",
        video_path="/tmp/pinned.mkv",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="x",
        expression="x",
    )
    assert pending_reviews.is_video_pinned_for_review("/tmp/pinned.mkv")
    pending_reviews.update_status(entry.entry_id, "done")
    assert not pending_reviews.is_video_pinned_for_review("/tmp/pinned.mkv")


def test_video_pin_release_only_when_last_entry_finalizes(pending_reviews):
    e1 = pending_reviews.enqueue(
        last_note=SimpleNamespace(noteId=1),
        game_line=_build_game_line(line_id="a"),
        selected_lines=[],
        assets=_build_assets(),
        audio_path="",
        video_path="/tmp/shared.mkv",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="a",
        expression="a",
    )
    e2 = pending_reviews.enqueue(
        last_note=SimpleNamespace(noteId=2),
        game_line=_build_game_line(line_id="b"),
        selected_lines=[],
        assets=_build_assets(),
        audio_path="",
        video_path="/tmp/shared.mkv",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="b",
        expression="b",
    )
    pending_reviews.update_status(e1.entry_id, "done")
    assert pending_reviews.is_video_pinned_for_review("/tmp/shared.mkv"), (
        "Video should remain pinned while another entry references it"
    )
    pending_reviews.update_status(e2.entry_id, "done")
    assert not pending_reviews.is_video_pinned_for_review("/tmp/shared.mkv")


def test_update_status_rejects_invalid(pending_reviews):
    with pytest.raises(ValueError):
        pending_reviews.update_status("nope", "wat")


# ---------------------------------------------------------------------------
# Discard + cleanup
# ---------------------------------------------------------------------------


def test_discard_removes_row_and_cleans_temp_files(pending_reviews, tmp_path):
    audio = tmp_path / "audio.opus"
    audio.write_bytes(b"\0")
    ss = tmp_path / "ss.png"
    ss.write_bytes(b"\0")

    last_note = SimpleNamespace(noteId=11)
    assets = _build_assets()
    assets.screenshot_path = str(ss)
    entry = pending_reviews.enqueue(
        last_note=last_note,
        game_line=_build_game_line(),
        selected_lines=[],
        assets=assets,
        audio_path=str(audio),
        video_path="/tmp/persistent.mkv",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="x",
        expression="x",
    )
    pending_reviews.discard(entry.entry_id)
    assert PendingReviewsTable.get(entry.entry_id) is None
    assert not audio.exists()
    assert not ss.exists()
    # Source video should NOT be deleted by discard.
    assert not pending_reviews.is_video_pinned_for_review("/tmp/persistent.mkv")


# ---------------------------------------------------------------------------
# Startup revalidation + sweep
# ---------------------------------------------------------------------------


def test_revalidate_marks_entries_with_missing_files_as_failed(pending_reviews, tmp_path):
    # First entry: has a real on-disk audio file.
    real_audio = tmp_path / "audio.opus"
    real_audio.write_bytes(b"\0")
    pending_reviews.enqueue(
        last_note=SimpleNamespace(noteId=1),
        game_line=_build_game_line(line_id="ok"),
        selected_lines=[],
        assets=_build_assets(),
        audio_path=str(real_audio),
        video_path="",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="ok",
        expression="ok",
    )
    # Second entry: all paths are non-existent.
    pending_reviews.enqueue(
        last_note=SimpleNamespace(noteId=2),
        game_line=_build_game_line(line_id="missing"),
        selected_lines=[],
        assets=_build_assets(),
        audio_path="/does/not/exist.opus",
        video_path="/does/not/exist.mkv",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="missing",
        expression="missing",
    )

    summary = pending_reviews.revalidate_on_startup()
    assert summary == {"loaded": 2, "missing": 1}

    statuses = {row.expression: row.status for row in PendingReviewsTable.all()}
    assert statuses["ok"] == "pending"
    assert statuses["missing"] == "failed"


def test_sweep_finalized_purges_old_done_rows(pending_reviews):
    entry = pending_reviews.enqueue(
        last_note=SimpleNamespace(noteId=99),
        game_line=_build_game_line(),
        selected_lines=[],
        assets=_build_assets(),
        audio_path="",
        video_path="",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="x",
        expression="x",
    )
    pending_reviews.update_status(entry.entry_id, "done")
    # Backdate so the sweeper picks it up.
    row = PendingReviewsTable.get(entry.entry_id)
    row.last_modified = time.time() - 3600
    row.save()

    purged = pending_reviews.sweep_finalized(retention_seconds=60)
    assert purged == 1
    assert PendingReviewsTable.get(entry.entry_id) is None


# ---------------------------------------------------------------------------
# Review actions (Phase 3)
# ---------------------------------------------------------------------------


def test_approve_as_is_drops_row_and_unpins_video(pending_reviews, tmp_path):
    audio = tmp_path / "audio.opus"
    audio.write_bytes(b"\0")
    entry = pending_reviews.enqueue(
        last_note=SimpleNamespace(noteId=5),
        game_line=_build_game_line(),
        selected_lines=[],
        assets=_build_assets(),
        audio_path=str(audio),
        video_path="/tmp/vid.mkv",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="x",
        expression="x",
    )
    assert pending_reviews.is_video_pinned_for_review("/tmp/vid.mkv")
    assert pending_reviews.approve_as_is(entry.entry_id) is True
    assert PendingReviewsTable.get(entry.entry_id) is None
    assert not pending_reviews.is_video_pinned_for_review("/tmp/vid.mkv")
    assert not audio.exists()


def test_approve_as_is_returns_false_for_missing_entry(pending_reviews):
    assert pending_reviews.approve_as_is("nonexistent") is False


def test_start_review_with_missing_anki_note_marks_failed(pending_reviews, monkeypatch):
    """If notesInfo returns no card the entry is marked failed and not deleted."""
    entry = pending_reviews.enqueue(
        last_note=SimpleNamespace(noteId=12345),
        game_line=_build_game_line(),
        selected_lines=[],
        assets=_build_assets(),
        audio_path="",
        video_path="",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="x",
        expression="x",
    )

    monkeypatch.setattr(pending_reviews, "_resolve_anki_card", lambda note_id: None)

    result = pending_reviews.start_review_with_dialog(entry.entry_id)
    assert result is False
    row = PendingReviewsTable.get(entry.entry_id)
    assert row is not None
    assert row.status == "failed"
    assert "no longer exists" in (row.failure_reason or "").lower()


def test_start_review_returns_to_pending_on_dialog_cancel(pending_reviews, monkeypatch):
    entry = pending_reviews.enqueue(
        last_note=SimpleNamespace(noteId=999),
        game_line=_build_game_line(),
        selected_lines=[],
        assets=_build_assets(),
        audio_path="",
        video_path="",
        screenshot_timestamp=0,
        prev_screenshot_timestamp=0,
        vad_result=None,
        audio_edit_context=None,
        translation="",
        sentence="x",
        expression="x",
    )

    fake_card = SimpleNamespace(noteId=999, get_field=lambda _: "")
    monkeypatch.setattr(pending_reviews, "_resolve_anki_card", lambda note_id: fake_card)

    # Stub the modal dialog as cancelled (returns None).
    import sys
    import types

    fake_qt_main = types.ModuleType("GameSentenceMiner.ui.qt_main")
    fake_qt_main.launch_anki_confirmation = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.ui.qt_main", fake_qt_main)

    result = pending_reviews.start_review_with_dialog(entry.entry_id)
    assert result is False
    row = PendingReviewsTable.get(entry.entry_id)
    assert row is not None
    assert row.status == "pending"
