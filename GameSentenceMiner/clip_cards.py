"""Make Anki cards from clips saved for later.

A clip stands in for a fresh OBS replay, so the normal Anki flow (timing, VAD, confirmation
dialog, uploads) and the Text Feed buttons run unchanged on it.
"""

import os
import shutil
from datetime import datetime, timedelta

from GameSentenceMiner import anki
from GameSentenceMiner.util.config.configuration import get_config, gsm_state, logger
from GameSentenceMiner.util.gsm_utils import make_unique_temp_file, remove_html_and_cloze_tags
from GameSentenceMiner.util.clips import Clip
from GameSentenceMiner.util import clips
from GameSentenceMiner.util.media import pause_history
from GameSentenceMiner.util.text_log import find_matching_line, get_all_lines, lines_match


def match_new_card(card):
    """Return the clip line a new card belongs to (its clip is line.clip), else None.

    Live lines always win: the clip lines are only consulted when neither the text log nor the
    last overlay scan matches, which is exactly when the live flow would fall back to the latest
    line.
    """
    # This runs inside the live flow, so it must never stop a card from being processed.
    try:
        if anki._is_overlay_mine(card):
            return None
        config = get_config()
        clips_root = clips.get_clips_root()
        if not clips_root:
            return None
        sentence = remove_html_and_cloze_tags(card.get_field(config.anki.sentence_field) or "")
        if not sentence:
            return None
        scan_line = getattr(gsm_state, "last_overlay_scan_line", None)
        if scan_line is not None and lines_match(scan_line.text, sentence):
            return None
        live_lines = get_all_lines()
        if live_lines and find_matching_line(card, live_lines) is not None:
            return None
        return clips.match_card_to_clip(card, clips_root)
    except Exception as e:
        logger.exception(f"Failed to check the new card against clip lines: {e}")
        return None


def _word(card) -> str:
    try:
        return card.get_field(get_config().anki.word_field)
    except (KeyError, ValueError):
        return ""


def replay_copy(clip: Clip) -> str:
    """A link (or copy) of the clip that the replay flows can use, then delete, like a fresh OBS replay."""
    pause_history.remember_pauses(clip.manifest.get("pauses", []))
    path = make_unique_temp_file(clip.clip_path)
    try:
        os.link(clip.clip_path, path)
    except OSError:  # temp is on another volume
        shutil.copyfile(clip.clip_path, path)
    end = clip.clip_end_time.timestamp()
    os.utime(path, (end, end))
    return path


def replay_for_lines(lines) -> str | None:
    """A saved clip holding lines once they have left the replay buffer, so Text Feed buttons keep working."""
    cutoff = datetime.now() - timedelta(seconds=gsm_state.replay_buffer_length)
    if not lines or lines[0].time >= cutoff:
        return None
    saved = clips.find_saved_line(lines[0].id)
    if saved is None or not {line.id for line in lines} <= {line.id for line in saved.clip.selected}:
        return None
    logger.info(f"Using clip {saved.clip.folder} for a line outside the replay buffer")
    return replay_copy(saved.clip)


def queue_clip_card(card, line, **queue_kwargs):
    """Queue the normal Anki flow for card with line's clip standing in for the OBS replay."""
    clip = line.clip
    selected = clip.selected if len(clip.selected) > 1 else []
    logger.info(f"Making a card from clip {clip.folder}")
    future = anki.queue_card_for_processing(
        card,
        selected,
        line,
        replay_path=replay_copy(clip),
        created_at=clip.clip_end_time,
        **queue_kwargs,
    )

    def record(done):
        context = None if done.cancelled() or done.exception() else done.result()
        if getattr(context, "background_update_started", False):
            clips.record_card(clip.folder, card.noteId, _word(card))

    future.add_done_callback(record)
    return future
