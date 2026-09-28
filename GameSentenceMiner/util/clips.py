"""Save for later: keep text feed lines as an OBS-shaped replay clip plus a manifest.

A clip keeps the replay's container and streams, and its modification time is the
wall-clock time of its last frame, so the Anki flow can process it later exactly like a
fresh OBS replay.
"""

import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta

from GameSentenceMiner.util.config.configuration import ffmpeg_base_command_list, get_config, logger
from GameSentenceMiner.util.gsm_utils import get_file_modification_time, sanitize_filename
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.text_log import GameLine, find_matching_line

CLIPS_FOLDER_NAME = "Clips"
MANIFEST_NAME = "manifest.json"
MANIFEST_VERSION = 1

LEAD_SECONDS = 5.0
TRAIL_SECONDS = 2.0
PREVIOUS_LINE_MAX_GAP_SECONDS = 15.0
NEXT_LINE_CONTEXT_SECONDS = 10.0
NEWEST_LINE_WINDOW_SECONDS = 10.0
MAX_WAIT_SECONDS = 20.0
AUDIO_LEAD_SECONDS = 0.5


class LineOutsideReplayError(RuntimeError):
    """The selected line is no longer inside the replay buffer."""


@dataclass
class ClipWindow:
    lines: list[GameLine]
    start_time: datetime
    end_time: datetime
    previous_line: GameLine | None = None
    next_line: GameLine | None = None


def plan_clip_window(lines: list[GameLine]) -> ClipWindow:
    """Pick the wall-clock span to keep: the lines plus enough context for later editing."""
    lines = sorted(lines, key=lambda line: line.time)
    first, last = lines[0], lines[-1]

    previous_line = first.prev
    if previous_line and (first.time - previous_line.time).total_seconds() > PREVIOUS_LINE_MAX_GAP_SECONDS:
        previous_line = None
    context_start = previous_line.time if previous_line else first.time
    lead = LEAD_SECONDS + float(getattr(first, "source_padding", 0) or 0)
    start_time = context_start - timedelta(seconds=lead)

    next_line = last.next
    if next_line:
        end_time = next_line.time + timedelta(seconds=NEXT_LINE_CONTEXT_SECONDS)
        if next_line.next:
            end_time = min(end_time, next_line.next.time + timedelta(seconds=TRAIL_SECONDS))
    else:
        # Nothing follows yet, so leave room for the voice line to finish.
        end_time = last.time + timedelta(seconds=NEWEST_LINE_WINDOW_SECONDS)

    return ClipWindow(lines, start_time, end_time, previous_line, next_line)


def seconds_until_clip_ready(lines: list[GameLine], now: datetime | None = None) -> float:
    """How long to wait before saving the replay so it covers the planned window."""
    now = now or datetime.now()
    remaining = (plan_clip_window(lines).end_time - now).total_seconds()
    return min(max(0.0, remaining), MAX_WAIT_SECONDS)


def get_clips_root(output_folder: str | None = None) -> str:
    return os.path.join(output_folder or get_config().paths.output_folder, CLIPS_FOLDER_NAME)


def _line_entry(line: GameLine, role: str) -> dict:
    return {
        "id": line.id,
        "text": line.text,
        "time": line.time.isoformat(),
        "role": role,
        "scene": getattr(line, "scene", "") or "",
        "source": getattr(line, "source", None),
        "source_padding": float(getattr(line, "source_padding", 0) or 0),
    }


def _identity_time(line: GameLine) -> datetime:
    # Revisions can move `time`; first_seen_time stays put, so it identifies the line.
    return getattr(line, "first_seen_time", None) or line.time


def _folder_prefix(line: GameLine) -> tuple[str, str]:
    moment = _identity_time(line)
    return moment.strftime("%Y-%m-%d"), f"{moment.strftime('%H-%M-%S')}-{moment.microsecond // 1000:03d}_"


def find_clip_folder(clips_root: str, lines: list[GameLine]) -> str | None:
    """Return the folder these exact lines were already clip to, if any."""
    lines = sorted(lines, key=lambda line: line.time)
    day, prefix = _folder_prefix(lines[0])
    day_folder = os.path.join(clips_root, day)
    if not os.path.isdir(day_folder):
        return None
    line_ids = [line.id for line in lines]
    for name in sorted(os.listdir(day_folder)):
        if not name.startswith(prefix):
            continue
        folder = os.path.join(day_folder, name)
        try:
            if read_manifest(folder).get("selected_line_ids") == line_ids:
                return folder
        except (OSError, ValueError):
            continue
    return None


def _make_folder(clips_root: str, first_line: GameLine, full_text: str) -> str:
    name = sanitize_filename(full_text.strip())[:32].strip() or "line"
    day, prefix = _folder_prefix(first_line)
    folder = os.path.join(clips_root, day, f"{prefix}{name}")
    suffix = 2
    candidate = folder
    while os.path.exists(candidate):
        candidate = f"{folder}_{suffix}"
        suffix += 1
    os.makedirs(candidate)
    return candidate


def save_clip(
    video_path: str,
    lines: list[GameLine],
    clips_root: str,
    game: str = "",
    replay_end_time: datetime | None = None,
) -> str:
    """Copy the replay span around lines into a new folder under clips_root and return its path.

    Saving the same lines again returns their existing folder instead of copying a second clip.
    """
    existing = find_clip_folder(clips_root, lines)
    if existing:
        logger.info(f"Line(s) already clip for later: {existing}")
        return existing

    window = plan_clip_window(lines)
    lines = window.lines
    replay_end_time = replay_end_time or get_file_modification_time(video_path)
    replay_length = ffmpeg.get_video_duration(video_path)

    def offset(moment: datetime) -> float:
        return replay_length - (replay_end_time - moment).total_seconds()

    if offset(lines[0].time) < 0:
        raise LineOutsideReplayError("The line is older than the replay buffer, so it can no longer be clip.")

    requested_start = max(0.0, offset(window.start_time))
    end = min(replay_length, max(offset(window.end_time), offset(lines[-1].time)))

    full_text = "".join(line.text for line in lines if line.text)
    folder = _make_folder(clips_root, lines[0], full_text)
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
    entries.extend(_line_entry(line, "selected") for line in lines)
    if window.next_line and offset(window.next_line.time) <= clip_start + clip_length:
        entries.append(_line_entry(window.next_line, "next"))

    manifest = {
        "version": MANIFEST_VERSION,
        "saved_at": datetime.now().isoformat(),
        "game": game or "",
        "sentence": full_text,
        "selected_line_ids": [line.id for line in lines],
        "lines": entries,
        "clip": {
            "file": clip_name,
            "end_time": clip_end_time.isoformat(),
            "duration": clip_length,
            "source_replay": os.path.basename(video_path),
        },
    }
    with open(os.path.join(folder, MANIFEST_NAME), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    logger.info(f"Saved {len(lines)} line(s) for later: {folder}")
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
    game: str


def load_clip(folder: str) -> Clip:
    """Rebuild a clip line's GameLines, linked like the live text log but only within the clip."""
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
    game = manifest.get("game", "") or ""
    for line in lines:
        # The Anki flow reads these instead of the live session's log and OBS scene.
        line.clip_context_lines = lines
        line.clip_game = game
    return Clip(
        folder=folder,
        manifest=manifest,
        lines=lines,
        selected=selected,
        clip_path=os.path.join(folder, manifest["clip"]["file"]),
        clip_end_time=clip_end_time,
        game=game,
    )


def iter_clips(clips_root: str):
    """Yield every readable clip line under clips_root; restored folders are picked up again."""
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
                logger.debug(f"Skipping unreadable clip line {folder}: {e}")


def match_card_to_clip(card, clips_root: str) -> tuple[Clip, GameLine] | None:
    """Match a card's sentence against every clip line using the live matcher's ranking."""
    owners = {}
    candidates = []
    for clip in iter_clips(clips_root):
        for line in clip.selected:
            owners[id(line)] = clip
            candidates.append(line)
    candidates.sort(key=lambda line: line.time)
    best = find_matching_line(card, candidates, respect_replay_window=False)
    return (owners[id(best)], best) if best is not None else None


def record_card(folder: str, note_id, word: str) -> None:
    manifest = read_manifest(folder)
    manifest.setdefault("cards", []).append(
        {"note_id": note_id, "word": word, "created_at": datetime.now().isoformat()}
    )
    _write_manifest(folder, manifest)


def extract_clip_audio(clip: Clip, output_path: str) -> str:
    """Write the clip line's audio (from just before it to the next line) as an MP3 any browser plays."""
    duration = ffmpeg.get_video_duration(clip.clip_path)

    def offset(moment: datetime) -> float:
        return duration - (clip.clip_end_time - moment).total_seconds()

    first, last = clip.selected[0], clip.selected[-1]
    start = max(0.0, offset(first.time) - first.source_padding - AUDIO_LEAD_SECONDS)
    end = min(duration, offset(last.next.time)) if last.next else duration

    source = clip.clip_path
    cleaned = f"{output_path}.cleaned.{get_config().audio.extension}"
    # Silence left by GSM pausing the game is removed when this build has that feature, as for cards.
    remove_pause_silence = getattr(ffmpeg, "extract_audio_without_pauses", None)
    timeline = remove_pause_silence(clip.clip_path, cleaned, clip.clip_end_time) if remove_pause_silence else None
    if timeline:
        source, start, end = cleaned, timeline.to_audio(start), timeline.to_audio(end)
    try:
        ffmpeg.FFmpegHelper.run(
            ffmpeg_base_command_list
            + ["-ss", str(start), "-to", str(end), "-i", source]
            + ["-vn", "-map", "0:a:0", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", "-y", output_path],
            check=False,
        )
    finally:
        if timeline and os.path.exists(cleaned):
            os.remove(cleaned)
    return output_path
