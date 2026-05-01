"""High-level API for the Anki batch review queue.

Phase 1 — data layer only. Higher phases wire enqueue/restore into ``anki.py``
and the new ``Pending Reviews`` Qt window.

Glossary
--------
* **Snapshot** - the dict captured at enqueue time, preserved per-row in
  :class:`PendingReviewsTable`. Carries everything the confirmation dialog
  needs to be re-opened later, even after :data:`gsm_state` globals have been
  clobbered by subsequent mining events.
* **Restored context** - a lightweight, dialog-friendly recreation produced by
  :func:`build_restored_context` when the user opens an entry from the queue.
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from GameSentenceMiner.util.config.configuration import get_config, gsm_state, logger
from GameSentenceMiner.util.database.pending_reviews_table import PendingReviewsTable
from GameSentenceMiner.util.gsm_utils import remove_html_and_cloze_tags
from GameSentenceMiner.util.models.model import VADResult


STATUS_PENDING = "pending"
STATUS_REVIEWING = "reviewing"
STATUS_DONE = "done"
STATUS_FAILED = "failed"

_VALID_STATUSES = {STATUS_PENDING, STATUS_REVIEWING, STATUS_DONE, STATUS_FAILED}


# ---------------------------------------------------------------------------
# Snapshot helpers (pure functions — easy to unit-test)
# ---------------------------------------------------------------------------


def serialize_vad_result(vad_result: Any) -> Dict[str, Any]:
    """Capture a :class:`VADResult` (or duck-typed object) as a JSON-safe dict."""
    if not vad_result:
        return {}
    return {
        "success": bool(getattr(vad_result, "success", False)),
        "start": float(getattr(vad_result, "start", 0.0) or 0.0),
        "end": float(getattr(vad_result, "end", 0.0) or 0.0),
        "model": str(getattr(vad_result, "model", "") or ""),
        "output_audio": getattr(vad_result, "output_audio", "") or "",
        "trimmed_audio_path": getattr(vad_result, "trimmed_audio_path", "") or "",
        "tts_used": bool(getattr(vad_result, "tts_used", False)),
    }


def deserialize_vad_result(data: Optional[Dict[str, Any]]) -> Optional[VADResult]:
    if not data:
        return None
    return VADResult(
        success=bool(data.get("success", False)),
        start=float(data.get("start") or 0.0),
        end=float(data.get("end") or 0.0),
        model=str(data.get("model") or ""),
        output_audio=data.get("output_audio") or None,
        trimmed_audio_path=data.get("trimmed_audio_path") or None,
        tts_used=bool(data.get("tts_used", False)),
    )


def serialize_audio_edit_context(context: Any) -> Dict[str, Any]:
    """Capture an :class:`AudioEditContext` (or dict) snapshot."""
    if not context:
        return {}
    if isinstance(context, dict):
        return {
            "source_audio_path": str(context.get("source_audio_path", "") or ""),
            "source_duration": float(context.get("source_duration") or 0.0),
            "range_start": float(context.get("range_start") or 0.0),
            "range_end": float(context.get("range_end") or 0.0),
            "rebase_on_selection_trim": bool(context.get("rebase_on_selection_trim", False)),
        }
    return {
        "source_audio_path": str(getattr(context, "source_audio_path", "") or ""),
        "source_duration": float(getattr(context, "source_duration", 0.0) or 0.0),
        "range_start": float(getattr(context, "range_start", 0.0) or 0.0),
        "range_end": float(getattr(context, "range_end", 0.0) or 0.0),
        "rebase_on_selection_trim": bool(getattr(context, "rebase_on_selection_trim", False)),
    }


# ---------------------------------------------------------------------------
# Restored context (read-only view passed to the dialog)
# ---------------------------------------------------------------------------


@dataclass
class RestoredReplayContext:
    """Stand-in for :class:`replay_handler.ReplayProcessingContext` rebuilt from a snapshot.

    Only attributes consumed by :mod:`anki_confirmation_qt` are populated.
    """

    video_path: str = ""
    mined_line: Any = None
    last_note: Any = None
    selected_lines: List[Any] = field(default_factory=list)
    audio_result: Any = None
    anki_card_creation_time: Any = None


# ---------------------------------------------------------------------------
# Video pinning helpers
# ---------------------------------------------------------------------------


def _pin_video(video_path: str, entry_id: str) -> None:
    if not video_path:
        return
    pinned = gsm_state.videos_pinned_for_review
    pinned.setdefault(video_path, set()).add(entry_id)


def _unpin_video(video_path: str, entry_id: str) -> None:
    if not video_path:
        return
    pinned = gsm_state.videos_pinned_for_review
    refs = pinned.get(video_path)
    if not refs:
        return
    refs.discard(entry_id)
    if not refs:
        pinned.pop(video_path, None)


def is_video_pinned_for_review(video_path: str) -> bool:
    """Used by replay_handler cleanup to defer video deletion."""
    if not video_path:
        return False
    return bool(gsm_state.videos_pinned_for_review.get(video_path))


def restore_video_pins_from_db() -> None:
    """Re-populate ``gsm_state.videos_pinned_for_review`` from persisted rows.

    Called once at startup so OBS/replay-handler honors restored pins for any
    cards that were left in the queue from a previous session.
    """
    try:
        rows = PendingReviewsTable.list_active()
    except Exception:
        logger.exception("Failed to load pending review rows for video pin restore")
        return
    for row in rows:
        if row.source_video_path:
            _pin_video(row.source_video_path, row.entry_id)


# ---------------------------------------------------------------------------
# Enqueue / list / finalize
# ---------------------------------------------------------------------------


def _sentence_preview(text: str, limit: int = 200) -> str:
    if not text:
        return ""
    cleaned = remove_html_and_cloze_tags(text).replace("\r", " ").replace("\n", " ").strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1] + "\u2026"


def enqueue(
    *,
    last_note: Any,
    game_line: Any,
    selected_lines: Optional[List[Any]],
    assets: Any,
    audio_path: str,
    video_path: str,
    screenshot_timestamp: float,
    prev_screenshot_timestamp: float,
    vad_result: Any,
    audio_edit_context: Any,
    translation: str,
    sentence: str,
    expression: str,
    anki_card_creation_time: Any = None,
) -> PendingReviewsTable:
    """Persist a snapshot for later batch review.

    Inputs intentionally mirror :func:`anki.update_anki_card` parameters so the
    call site can pass them through unchanged.
    """
    entry_id = str(uuid.uuid4())
    now = time.time()
    selected_ids = [getattr(line, "id", None) for line in (selected_lines or []) if getattr(line, "id", None)]

    creation_epoch = 0.0
    if anki_card_creation_time is not None:
        try:
            creation_epoch = float(anki_card_creation_time.timestamp())
        except AttributeError:
            try:
                creation_epoch = float(anki_card_creation_time)
            except (TypeError, ValueError):
                creation_epoch = 0.0

    extra_tags = list(getattr(assets, "extra_tags", []) or [])

    row = PendingReviewsTable(
        entry_id=entry_id,
        created_at=now,
        status=STATUS_PENDING,
        game=str(getattr(gsm_state, "current_game", "") or ""),
        expression=str(expression or ""),
        sentence_preview=_sentence_preview(sentence),
        anki_note_id=str(getattr(last_note, "noteId", "") or ""),
        mined_line_id=str(getattr(game_line, "id", "") or ""),
        selected_line_ids=selected_ids,
        audio_path=str(audio_path or ""),
        screenshot_path=str(getattr(assets, "screenshot_path", "") or ""),
        prev_screenshot_path=str(getattr(assets, "prev_screenshot_path", "") or ""),
        source_video_path=str(video_path or ""),
        screenshot_timestamp=float(screenshot_timestamp or 0.0),
        prev_screenshot_timestamp=float(prev_screenshot_timestamp or 0.0),
        vad_result_data=serialize_vad_result(vad_result),
        audio_edit_context_data=serialize_audio_edit_context(audio_edit_context),
        translation=str(translation or ""),
        pending_animated=bool(getattr(assets, "pending_animated", False)),
        pending_video=bool(getattr(assets, "pending_video", False)),
        extra_tags=extra_tags,
        anki_card_creation_time=creation_epoch,
        last_modified=now,
        failure_reason="",
    )
    row.add()

    if video_path:
        _pin_video(video_path, entry_id)

    logger.info(
        "Queued card '{}' for batch review (entry_id={}, queue_size={})",
        expression or sentence[:20],
        entry_id,
        PendingReviewsTable.count_pending(),
    )
    return row


def list_active() -> List[PendingReviewsTable]:
    return PendingReviewsTable.list_active()


def list_pending() -> List[PendingReviewsTable]:
    return PendingReviewsTable.list_by_status(STATUS_PENDING)


def count_pending() -> int:
    return PendingReviewsTable.count_pending()


def get(entry_id: str) -> Optional[PendingReviewsTable]:
    return PendingReviewsTable.get(entry_id)


def update_status(entry_id: str, status: str, failure_reason: str = "") -> None:
    if status not in _VALID_STATUSES:
        raise ValueError(f"Invalid pending-review status: {status!r}")
    row = PendingReviewsTable.get(entry_id)
    if not row:
        logger.warning("update_status: pending-review entry not found: {}", entry_id)
        return
    row.status = status
    row.last_modified = time.time()
    if failure_reason:
        row.failure_reason = failure_reason
    row.save()

    if status in (STATUS_DONE, STATUS_FAILED):
        _unpin_video(row.source_video_path, row.entry_id)


def discard(entry_id: str, *, cleanup_files: bool = True) -> None:
    """Drop an entry from the queue and (optionally) clean its temp media."""
    row = PendingReviewsTable.get(entry_id)
    if not row:
        return
    _unpin_video(row.source_video_path, row.entry_id)
    if cleanup_files:
        for path in _snapshot_temp_paths(row):
            _safe_remove(path)
    row.delete()


# ---------------------------------------------------------------------------
# Review actions used by the Pending Reviews window
# ---------------------------------------------------------------------------


def approve_as_is(entry_id: str) -> bool:
    """Accept the auto-applied (VAD-based) media that was already uploaded.

    Removes the snapshot row and cleans the snapshot temp files. The Anki
    note is **not** modified — it already received the auto-accept upload at
    capture time. Returns ``True`` on success.
    """
    row = PendingReviewsTable.get(entry_id)
    if not row:
        return False
    _unpin_video(row.source_video_path, row.entry_id)
    for path in _snapshot_temp_paths(row):
        _safe_remove(path)
    row.delete()
    logger.info("Approved batch-review entry as-is (entry_id={})", entry_id)
    return True


def _resolve_anki_card(anki_note_id: str):
    """Fetch the latest :class:`AnkiCard` for ``anki_note_id`` (or ``None``)."""
    if not anki_note_id:
        return None
    try:
        from GameSentenceMiner import anki as anki_module
        from GameSentenceMiner.util.models.model import AnkiCard
    except Exception:
        logger.exception("Failed to import anki module for review")
        return None
    try:
        info = anki_module.invoke("notesInfo", notes=[int(anki_note_id)])
        if not info:
            return None
        return AnkiCard.from_dict(info[0])
    except Exception:
        logger.exception("notesInfo failed for note {}", anki_note_id)
        return None


def _resolve_lines(line_ids: List[str]):
    from GameSentenceMiner.util import text_log

    resolved = []
    for line_id in line_ids or []:
        line = text_log.get_line_by_id(line_id)
        if line is not None:
            resolved.append(line)
    return resolved


def start_review_with_dialog(entry_id: str) -> bool:
    """Open the Anki confirmation dialog for ``entry_id`` and apply the result.

    On accept, updates the existing Anki note (overwriting the auto-applied
    media) and finalizes the entry. On cancel, returns the row to ``pending``.

    Must be called from a background thread — it shows a modal dialog through
    :func:`launch_anki_confirmation` which marshals to the Qt main thread.
    """
    row = PendingReviewsTable.get(entry_id)
    if not row:
        logger.warning("start_review_with_dialog: entry not found ({})", entry_id)
        return False
    if row.status == STATUS_REVIEWING:
        logger.info("Entry already being reviewed: {}", entry_id)
        return False

    update_status(entry_id, STATUS_REVIEWING)

    try:
        last_note = _resolve_anki_card(row.anki_note_id)
        if last_note is None:
            update_status(entry_id, STATUS_FAILED, failure_reason="Anki note no longer exists")
            return False

        game_line = None
        try:
            from GameSentenceMiner.util import text_log

            if row.mined_line_id:
                game_line = text_log.get_line_by_id(row.mined_line_id)
        except Exception:
            logger.exception("Failed to resolve mined line for review")

        selected_lines = _resolve_lines(row.selected_line_ids or [])

        # Restore globals the dialog inspects.
        gsm_state.vad_result = deserialize_vad_result(row.vad_result_data)
        gsm_state.audio_edit_context = row.audio_edit_context_data or None

        from GameSentenceMiner.ui.qt_main import launch_anki_confirmation

        sentence_for_dialog = row.sentence_preview
        if last_note is not None:
            try:
                from GameSentenceMiner.util.config.configuration import get_config

                cfg = get_config()
                sentence_for_dialog = last_note.get_field(cfg.anki.sentence_field) or row.sentence_preview
            except Exception:
                pass

        result = launch_anki_confirmation(
            row.expression,
            sentence_for_dialog,
            row.screenshot_path,
            row.prev_screenshot_path,
            row.audio_path or None,
            row.translation,
            row.screenshot_timestamp,
            row.prev_screenshot_timestamp,
            row.pending_animated,
        )

        if result is None:
            logger.info("Review cancelled for entry {}; restoring to pending", entry_id)
            update_status(entry_id, STATUS_PENDING)
            return False

        from GameSentenceMiner import anki as anki_module

        # Build a fresh note dict and assets snapshot, then run the standard
        # post-dialog pipeline + Anki upload.
        note, last_note = anki_module.get_initial_card_info(last_note, selected_lines, game_line)

        assets = anki_module.MediaAssets()
        assets.audio_path = row.audio_path
        assets.screenshot_path = row.screenshot_path
        assets.prev_screenshot_path = row.prev_screenshot_path
        assets.source_video_path = row.source_video_path
        assets.screenshot_timestamp = row.screenshot_timestamp
        assets.prev_screenshot_timestamp = row.prev_screenshot_timestamp
        assets.pending_animated = bool(row.pending_animated)
        assets.pending_video = bool(row.pending_video)
        assets.extra_tags = list(row.extra_tags or [])
        if row.pending_animated:
            assets.animated_video_path = row.source_video_path
            assets.animated_start_time = 0.0
            vad = gsm_state.vad_result
            if vad is not None:
                assets.animated_vad_start = float(getattr(vad, "start", 0.0) or 0.0)
                assets.animated_vad_end = float(getattr(vad, "end", 0.0) or 0.0)

        start_time = 0.0
        end_time = 0.0
        vad_result = gsm_state.vad_result

        use_voice, selected_lines, start_time, end_time, vad_result, _translation = (
            anki_module._apply_confirmation_dialog_result(
                result,
                note,
                last_note,
                assets,
                game_line,
                selected_lines,
                start_time,
                end_time,
                vad_result,
            )
        )

        tags = anki_module._prepare_anki_tags()
        for extra_tag in assets.extra_tags:
            if extra_tag not in tags:
                tags.append(extra_tag)

        anki_module.check_and_update_note(
            last_note,
            note,
            tags,
            assets,
            use_voice,
            update_picture_flag=True,
            use_existing_files=False,
            assets_ready_callback=None,
            processing_word=row.expression,
            failure_result_id=None,
        )

        # Success — drop the row and clean up snapshot temp files.
        _unpin_video(row.source_video_path, row.entry_id)
        for path in _snapshot_temp_paths(row):
            _safe_remove(path)
        row.delete()
        logger.info("Finalized batch-review entry {}", entry_id)
        return True
    except Exception as e:
        logger.exception("Error during start_review_with_dialog: {}", e)
        update_status(entry_id, STATUS_FAILED, failure_reason=str(e))
        return False


def revalidate_on_startup() -> Dict[str, int]:
    """Verify snapshot files for active rows; mark missing ones as ``failed``.

    Returns a small summary dict (``{"loaded": N, "missing": M}``) for logging.
    """
    rows = PendingReviewsTable.list_active()
    missing = 0
    for row in rows:
        # Re-pin any video that still exists.
        if row.source_video_path:
            _pin_video(row.source_video_path, row.entry_id)

        critical = [row.audio_path, row.screenshot_path, row.source_video_path]
        critical = [p for p in critical if p]
        if critical and not any(os.path.exists(p) for p in critical):
            row.status = STATUS_FAILED
            row.failure_reason = "Snapshot files missing on startup"
            row.last_modified = time.time()
            row.save()
            missing += 1
    return {"loaded": len(rows), "missing": missing}


def sweep_finalized(retention_seconds: float = 600.0) -> int:
    """Purge ``done`` rows older than ``retention_seconds``."""
    cutoff = time.time() - max(0.0, retention_seconds)
    return PendingReviewsTable.delete_done_older_than(cutoff)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _snapshot_temp_paths(row: PendingReviewsTable) -> List[str]:
    """Files that a snapshot owns and may delete when the entry is finalized.

    Note: ``source_video_path`` is intentionally excluded — replay video
    deletion is owned by the regular replay-handler cleanup path.
    """
    paths = [
        row.audio_path,
        row.screenshot_path,
        row.prev_screenshot_path,
    ]
    audio_ctx = row.audio_edit_context_data or {}
    src_audio = audio_ctx.get("source_audio_path") if isinstance(audio_ctx, dict) else None
    if src_audio:
        paths.append(src_audio)
    return [p for p in paths if p]


def _safe_remove(path: str) -> None:
    if not path:
        return
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError as e:  # pragma: no cover — best-effort cleanup
        logger.debug("Could not remove pending-review temp file {}: {}", path, e)


def feature_enabled() -> bool:
    """Convenience check used by ``anki.update_anki_card``."""
    try:
        return bool(get_config().anki.batch_review_queue_enabled)
    except Exception:
        return False
