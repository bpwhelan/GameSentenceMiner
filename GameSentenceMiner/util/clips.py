"""Clips saved for later: an OBS-shaped replay clip plus a manifest, mined later like a fresh replay.

A clip keeps the replay's streams, and its modification time is the wall-clock time of its last frame.
"""

import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta

from GameSentenceMiner.util.config.configuration import get_config, logger
from GameSentenceMiner.util.gsm_utils import get_file_modification_time, sanitize_filename
from GameSentenceMiner.util.media import ffmpeg, pause_history
from GameSentenceMiner.util.text_log import GameLine, find_matching_line

CLIPS_FOLDER_NAME = "Clips"
MANIFEST_NAME = "manifest.json"

LEAD_SECONDS = 5.0
TRAIL_SECONDS = 2.0
PREVIOUS_LINE_MAX_GAP_SECONDS = 15.0
NEXT_LINE_CONTEXT_SECONDS = 10.0
NEWEST_LINE_WINDOW_SECONDS = 10.0
MAX_WAIT_SECONDS = 20.0


class LineOutsideReplayError(RuntimeError):
    """The selected line is no longer inside the replay buffer."""


@dataclass
class ClipWindow:
    start_time: datetime
    end_time: datetime
    previous_line: GameLine | None = None
    next_line: GameLine | None = None


def plan_clip_window(line: GameLine) -> ClipWindow:
    """Pick the wall-clock span to keep: the line plus enough context for later editing."""
    previous_line = line.prev
    if previous_line and (line.time - previous_line.time).total_seconds() > PREVIOUS_LINE_MAX_GAP_SECONDS:
        previous_line = None
    context_start = previous_line.time if previous_line else line.time
    lead = LEAD_SECONDS + float(line.source_padding or 0)
    start_time = context_start - timedelta(seconds=lead)

    next_line = line.next
    if next_line:
        end_time = next_line.time + timedelta(seconds=NEXT_LINE_CONTEXT_SECONDS)
        if next_line.next:
            end_time = min(end_time, next_line.next.time + timedelta(seconds=TRAIL_SECONDS))
    else:
        # Nothing follows yet, so leave room for the voice line to finish.
        end_time = line.time + timedelta(seconds=NEWEST_LINE_WINDOW_SECONDS)

    return ClipWindow(start_time, end_time, previous_line, next_line)


def seconds_until_clip_ready(line: GameLine, now: datetime | None = None) -> float:
    """How long to wait before saving the replay so it covers the planned window."""
    now = now or datetime.now()
    remaining = (plan_clip_window(line).end_time - now).total_seconds()
    return min(max(0.0, remaining), MAX_WAIT_SECONDS)


def get_clips_root() -> str:
    """The Clips folder in the output folder, or "" when no output folder is set."""
    output_folder = get_config().paths.output_folder
    return os.path.join(output_folder, CLIPS_FOLDER_NAME) if output_folder else ""


def _line_entry(line: GameLine, role: str) -> dict:
    return {
        "id": line.id,
        "text": line.text,
        "time": line.time.isoformat(),
        "role": role,
        "scene": line.scene or "",
        "source": line.source,
        "source_padding": float(line.source_padding or 0),
    }


def _identity_time(line: GameLine) -> datetime:
    # Revisions can move `time`; first_seen_time stays put, so it identifies the line.
    return line.first_seen_time or line.time


def _folder_prefix(line: GameLine) -> tuple[str, str]:
    moment = _identity_time(line)
    return moment.strftime("%Y-%m-%d"), f"{moment.strftime('%H-%M-%S')}-{moment.microsecond // 1000:03d}_"


def find_clip_folder(clips_root: str, line: GameLine) -> str | None:
    """Return the folder this line was already saved to, if any."""
    day, prefix = _folder_prefix(line)
    day_folder = os.path.join(clips_root, day)
    if not os.path.isdir(day_folder):
        return None
    for name in sorted(os.listdir(day_folder)):
        if not name.startswith(prefix):
            continue
        folder = os.path.join(day_folder, name)
        try:
            entries = read_manifest(folder)["lines"]
            if [entry["id"] for entry in entries if entry.get("role") == "selected"] == [line.id]:
                return folder
        except (OSError, ValueError, KeyError):
            continue
    return None


def _make_folder(clips_root: str, line: GameLine) -> str:
    name = sanitize_filename((line.text or "").strip())[:32].strip() or "line"
    day, prefix = _folder_prefix(line)
    folder = os.path.join(clips_root, day, f"{prefix}{name}")
    suffix = 2
    candidate = folder
    while os.path.exists(candidate):
        candidate = f"{folder}_{suffix}"
        suffix += 1
    os.makedirs(candidate)
    return candidate


def save_clip(video_path: str, line: GameLine, clips_root: str) -> str:
    """Copy the replay span around the line into a folder under clips_root (reused if already saved)."""
    existing = find_clip_folder(clips_root, line)
    if existing:
        logger.info(f"Line already saved for later: {existing}")
        return existing

    window = plan_clip_window(line)
    replay_end_time = get_file_modification_time(video_path)
    replay_length = ffmpeg.get_video_duration(video_path)

    def offset(moment: datetime) -> float:
        return replay_length - (replay_end_time - moment).total_seconds()

    if offset(line.time) < 0:
        raise LineOutsideReplayError("The line is older than the replay buffer, so its clip can no longer be saved.")

    requested_start = max(0.0, offset(window.start_time))
    end = min(replay_length, max(offset(window.end_time), offset(line.time)))

    folder = _make_folder(clips_root, line)
    clip_name = "clip" + (os.path.splitext(video_path)[1] or ".mkv")
    clip_path = os.path.join(folder, clip_name)
    clip_start = ffmpeg.copy_replay_segment(video_path, requested_start, end, clip_path)
    if clip_start is None:
        raise RuntimeError(f"ffmpeg did not produce the clip: {clip_path}")

    clip_length = ffmpeg.get_video_duration(clip_path)
    clip_end_time = replay_end_time - timedelta(seconds=replay_length - (clip_start + clip_length))
    os.utime(clip_path, (clip_end_time.timestamp(), clip_end_time.timestamp()))

    entries = []
    if window.previous_line:
        entries.append(_line_entry(window.previous_line, "previous"))
    entries.append(_line_entry(line, "selected"))
    if window.next_line and offset(window.next_line.time) <= clip_start + clip_length:
        entries.append(_line_entry(window.next_line, "next"))

    # Game pauses in the clip (epoch seconds), so their silence can be removed however late it is mined.
    clip_start_time = clip_end_time - timedelta(seconds=clip_length)
    spans = pause_history.get_pauses_between(clip_start_time.timestamp(), clip_end_time.timestamp())
    manifest = {
        "lines": entries,
        "clip": {"file": clip_name, "end_time": clip_end_time.isoformat()},
        "pauses": [list(span) for span in spans],
    }
    _write_manifest(folder, manifest)

    logger.info(f"Saved the line for later: {folder}")
    return folder


def read_manifest(folder: str) -> dict:
    with open(os.path.join(folder, MANIFEST_NAME), encoding="utf-8") as f:
        return json.load(f)


def _write_manifest(folder: str, manifest: dict) -> None:
    path = os.path.join(folder, MANIFEST_NAME)
    staged = f"{path}.tmp"
    with open(staged, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    os.replace(staged, path)


@dataclass
class Clip:
    folder: str
    manifest: dict
    lines: list[GameLine]
    selected: list[GameLine]
    clip_path: str
    clip_end_time: datetime


def load_clip(folder: str) -> Clip:
    """Rebuild a clip's GameLines, linked like the live text log but only within the clip."""
    manifest = read_manifest(folder)
    clip_end_time = datetime.fromisoformat(manifest["clip"]["end_time"])
    lines = []
    selected = []
    for index, entry in enumerate(manifest["lines"]):
        line = GameLine(
            id=entry["id"],
            text=entry["text"],
            time=datetime.fromisoformat(entry["time"]),
            prev=lines[-1] if lines else None,
            next=None,
            index=index,
            scene=entry.get("scene", "") or "",
            source=entry.get("source"),
            source_padding=float(entry.get("source_padding", 0) or 0),
            # next_line() only follows links older than mined_time; the clip end bounds them.
            mined_time=clip_end_time,
        )
        if lines:
            lines[-1].next = line
        lines.append(line)
        if entry.get("role") == "selected":
            selected.append(line)
    clip = Clip(
        folder=folder,
        manifest=manifest,
        lines=lines,
        selected=selected,
        clip_path=os.path.join(folder, manifest["clip"]["file"]),
        clip_end_time=clip_end_time,
    )
    for line in lines:
        # The Anki flow and the AI context read the clip through this instead of the live log.
        line.clip = clip
    return clip


def iter_clips(clips_root: str):
    """Yield every readable clip under clips_root; restored folders are picked up again."""
    if not os.path.isdir(clips_root):
        return
    for day in sorted(os.listdir(clips_root)):
        day_folder = os.path.join(clips_root, day)
        if not os.path.isdir(day_folder):
            continue
        for name in sorted(os.listdir(day_folder)):
            folder = os.path.join(day_folder, name)
            if not os.path.isfile(os.path.join(folder, MANIFEST_NAME)):
                continue
            try:
                yield load_clip(folder)
            except (OSError, ValueError, KeyError, TypeError) as e:
                logger.debug(f"Skipping unreadable clip {folder}: {e}")


def find_saved_line(line_id: str) -> GameLine | None:
    """The saved line with this id (its clip is line.clip), or None."""
    clips_root = get_clips_root()
    if not clips_root:
        return None
    for clip in iter_clips(clips_root):
        for line in clip.selected:
            if line.id == line_id:
                return line
    return None


def match_card_to_clip(card, clips_root: str) -> GameLine | None:
    """Match a card's sentence against every saved line using the live matcher's ranking."""
    candidates = sorted((line for clip in iter_clips(clips_root) for line in clip.selected), key=lambda line: line.time)
    return find_matching_line(card, candidates, respect_replay_window=False)
