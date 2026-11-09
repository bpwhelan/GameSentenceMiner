"""Optional follow-up replays, kept separately from the original card/review media."""

from __future__ import annotations

import copy
import json
import os
import shutil
import tempfile
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from GameSentenceMiner import session_review
from GameSentenceMiner.util.clips import CONTEXT_PADDING_SECONDS, _line_entry, load_clip
from GameSentenceMiner.util.config.configuration import get_config, gsm_state, logger
from GameSentenceMiner.util.media import ffmpeg, pause_history


@dataclass
class PendingContext:
    entry: session_review.ReviewEntry
    manifest: dict
    anchor_id: str
    anchor_time: datetime
    session_id: str
    limit: int
    expires_at: datetime
    future_lines: tuple = ()


_pending: dict[str, PendingContext] = {}


def cancel(entry_id):
    with session_review._lock:
        _pending.pop(entry_id, None)


def has_pending():
    with session_review._lock:
        return bool(_pending)


def register(entry, mined_line, selected_lines, config):
    cancel(entry.id)
    limit = max(0, min(100, int(config.features.review_after_session.max_future_context_lines)))
    if not limit or not mined_line:
        return
    selected = selected_lines or [mined_line]
    anchor = max(selected, key=lambda line: line.time)
    manifest = json.loads((entry.folder / "manifest.json").read_text(encoding="utf-8"))
    buffer_seconds = getattr(gsm_state, "replay_buffer_length", 0) or config.obs.replay_buffer_duration_seconds
    expires_at = min(line.time for line in selected) + timedelta(seconds=buffer_seconds - CONTEXT_PADDING_SECONDS)
    with session_review._lock:
        _pending[entry.id] = PendingContext(
            entry,
            manifest,
            anchor.id,
            anchor.first_seen_time or anchor.time,
            anchor.session_id,
            limit,
            expires_at,
        )


def poll(*, lines=None, now=None, config=None, scene=None):
    """Called on a worker: count distinct live lines, then request one replay for all ready entries."""
    from GameSentenceMiner.replay_handler import request_session_review_replay
    from GameSentenceMiner.util.text_log import get_all_lines

    config = config or get_config()
    now = now or datetime.now(UTC).astimezone().replace(tzinfo=None)
    lines = get_all_lines() if lines is None else lines
    ready = []
    with session_review._lock:
        for key, pending in list(_pending.items()):
            entry = pending.entry
            if (
                not entry.folder.exists()
                or now >= pending.expires_at
                or not session_review.enabled(config)
                or config.features.review_after_session.max_future_context_lines <= 0
                or config.name != entry.data["profile_name"]
                or config.anki.url != entry.data["anki_url"]
                or (scene and scene != entry.data["scene"])
            ):
                _pending.pop(key, None)
                continue
            candidates = {}
            for line in lines:
                if (
                    line.id != pending.anchor_id
                    and (line.first_seen_time or line.time) > pending.anchor_time
                    and line.scene == entry.data["scene"]
                    and (not pending.session_id or line.session_id == pending.session_id)
                    and str(line.text or "").strip()
                ):
                    candidates[line.id] = line
            following = sorted(candidates.values(), key=lambda line: line.first_seen_time or line.time)[: pending.limit]
            if len(following) < pending.limit:
                continue
            if now < following[-1].time + timedelta(seconds=CONTEXT_PADDING_SECONDS):
                continue
            _pending.pop(key, None)
            original_ids = {line["id"] for line in pending.manifest["lines"]}
            if all(line.id in original_ids for line in following):
                continue
            ready.append(replace(pending, future_lines=tuple(_line_entry(line, "context") for line in following)))
    if ready:
        future = request_session_review_replay(ready)

        def completed(result):
            try:
                result.result()
            except Exception:  # noqa: BLE001 - Optional capture must not interfere with mining.
                logger.exception("Could not capture future review context; keeping the original replay.")

        future.add_done_callback(completed)


def capture_replay(video_path, targets):
    """Keep an OBS replay without extracting, encoding or uploading any media."""
    with session_review._lock:
        targets = [pending for pending in targets if _still_pending(pending.entry)]
    if not targets:
        return
    capture_end = datetime.fromtimestamp(os.path.getmtime(video_path), UTC).astimezone().replace(tzinfo=None)
    capture_start = capture_end - timedelta(seconds=ffmpeg.get_video_duration(video_path))
    for pending in targets:
        entry = pending.entry
        original_lines = pending.manifest["lines"]
        selected = [line for line in original_lines if line["id"] in entry.data["selected_ids"]]
        required = [*selected, *pending.future_lines]
        if any(not capture_start <= datetime.fromisoformat(line["time"]) <= capture_end for line in required):
            logger.info("Future context no longer fits in the replay buffer; retaining the original review.")
            continue
        # Stage outside the entry so confirmation can delete it while this copy is
        # in progress. Commit only if the durable review is still pending.
        with tempfile.TemporaryDirectory(prefix="future-", dir=session_review.get_review_root()) as staging:
            staged = Path(staging) / "future"
            staged.mkdir()
            destination = staged / ("replay" + Path(video_path).suffix)
            try:
                os.link(video_path, destination)
            except OSError:
                shutil.copy2(video_path, destination)
            merged = {line["id"]: line for line in [*original_lines, *pending.future_lines]}
            manifest = {
                "clip": {"file": destination.name, "end_time": capture_end.isoformat()},
                "lines": sorted(
                    (
                        line
                        for line in merged.values()
                        if capture_start <= datetime.fromisoformat(line["time"]) <= capture_end
                    ),
                    key=lambda line: line["time"],
                ),
                "pauses": [
                    list(span)
                    for span in pause_history.get_pauses_between(capture_start.timestamp(), capture_end.timestamp())
                ],
            }
            (staged / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            with session_review._lock:
                if not _still_pending(entry) or (entry.folder / "future").exists():
                    continue
                staged.rename(entry.folder / "future")


def _still_pending(entry):
    try:
        current = json.loads((entry.folder / "review.json").read_text(encoding="utf-8"))
        return isinstance(current, dict) and current.get("status") == "pending"
    except (OSError, ValueError):
        return False


def load_future_clip(entry, original_clip):
    folder = entry.folder / "future"
    if not (folder / "manifest.json").exists():
        return None
    try:
        future = load_clip(str(folder))
        if not Path(future.clip_path).is_file() or not Path(future.clip_path).resolve().is_relative_to(
            folder.resolve()
        ):
            return None
        pause_history.remember_pauses(future.manifest.get("pauses", []))
        # Give the original dialogue future neighbors without changing its replay,
        # timestamps, audio or screenshots. Future nodes retain their own clip.
        known = {line.id for line in original_clip.lines}
        tail = original_clip.lines[-1] if original_clip.lines else None
        for line in future.lines:
            if line.id not in known and tail is not None and line.time > tail.time:
                neighbor = replace(line, prev=tail, next=None)
                neighbor.clip = future
                tail.next = neighbor
                tail = neighbor
        return future
    except (OSError, ValueError, KeyError, TypeError):
        logger.exception("Could not load future review context; using the original saved replay.")
        return None


def context_for_selection(prepared, selected_lines):
    original_ids = {line.id for line in prepared.original_clip.lines}
    use_future = any(line.id not in original_ids for line in selected_lines)
    clip = prepared.future_clip if use_future else prepared.original_clip
    if clip is None:
        raise RuntimeError("The future dialogue replay is not available.")
    by_id = {line.id: line for line in clip.lines}
    if any(line.id not in by_id for line in selected_lines):
        raise RuntimeError(
            "The extra replay does not cover all selected lines. Undo the earlier context before adding future dialogue."
        )
    context = copy.copy(prepared.context)
    context.video_path = clip.clip_path
    context.anki_card_creation_time = clip.clip_end_time
    context.mined_line = by_id.get(prepared.context.mined_line.id, prepared.context.mined_line)
    context.selected_lines = [by_id[line.id] for line in selected_lines]
    return context
