"""Make Anki cards from clips saved for later.

A clip line's clip stands in for a fresh OBS replay, so the normal Anki flow (timing, VAD,
confirmation dialog, uploads) runs unchanged. Cards reach this module two ways: a new card
whose sentence matches no live line but does match a clip one, and the "Enrich latest card"
button on the Clips to mine page.
"""

import copy
import os
import re
import shutil
from dataclasses import replace
from datetime import datetime, timedelta

from GameSentenceMiner import anki
from GameSentenceMiner.util.config.configuration import get_config, gsm_state, logger
from GameSentenceMiner.util.gsm_utils import make_unique_temp_file, remove_html_and_cloze_tags
from GameSentenceMiner.util.clips import Clip
from GameSentenceMiner.util import clips
from GameSentenceMiner.util.media import pause_history
from GameSentenceMiner.util.text_log import find_matching_line, get_all_lines, lines_match

_BOLD = re.compile(r"<b>(.*?)</b>", re.IGNORECASE | re.DOTALL)


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


def check_enrich(card, clip: Clip) -> dict:
    """Describe why enriching this card from the clip line might be a mistake."""
    config = get_config()
    card_sentence = remove_html_and_cloze_tags(card.get_field(config.anki.sentence_field) or "")
    warnings = []
    if find_matching_line(card, clip.selected, respect_replay_window=False) is None:
        warnings.append({"code": "sentence_mismatch", "message": "The latest card's sentence doesn't match this clip."})

    def has_value(name):
        return bool(name and card.has_field(name) and card.get_field(name))

    card_media = {"audio": has_value(config.anki.sentence_audio_field), "picture": has_value(config.anki.picture_field)}
    if any(card_media.values()):
        warnings.append(
            {"code": "has_media", "message": "The latest card already has audio or a picture; it will be replaced."}
        )
    if any(isinstance(job, tuple) and getattr(job[0], "noteId", None) == card.noteId for job in anki.card_queue):
        warnings.append(
            {"code": "live_pending", "message": "GSM is still adding live media to this card. Wait for it to finish."}
        )
    return {
        "note_id": card.noteId,
        "card_word": _word(card),
        "card_sentence": card_sentence,
        "saved_sentence": clip.manifest.get("sentence", ""),
        "card_media": card_media,
        "warnings": warnings,
    }


def _highlight(saved_sentence: str, card) -> str:
    """Put the looked-up word's bold on the clip sentence, when it can be found there."""
    bold = _BOLD.search(card.get_field(get_config().anki.sentence_field) or "")
    for target in (remove_html_and_cloze_tags(bold.group(1)) if bold else "", _word(card)):
        if target and target in saved_sentence:
            return saved_sentence.replace(target, f"<b>{target}</b>", 1)
    return saved_sentence


def _card_for_rewrite(card, clip: Clip):
    """An in-memory copy that looks freshly created from the clip line, so every field is rewritten.

    The real note is only changed by the normal flow's final update, so cancelling the dialog
    leaves it as it was.
    """
    config = get_config()
    fresh = copy.deepcopy(card)
    generated_fields = (
        config.anki.sentence_audio_field,
        config.anki.picture_field,
        getattr(config.anki, "previous_image_field", ""),
        getattr(config.anki, "video_field", ""),
        getattr(config.anki, "previous_sentence_field", ""),
        getattr(config.anki, "sentence_furigana_field", ""),
        getattr(config.anki, "game_name_field", ""),
        getattr(config.ai, "anki_field", ""),
    )
    for name in generated_fields:
        if name and name in fresh.fields:
            fresh.fields[name] = replace(fresh.fields[name], value="")
    sentence_field = config.anki.sentence_field
    if sentence_field in fresh.fields:
        sentence = clip.manifest.get("sentence") or "".join(line.text for line in clip.selected)
        fresh.fields[sentence_field] = replace(fresh.fields[sentence_field], value=_highlight(sentence, card))
    return fresh


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


def clip_line_audio(clip: Clip) -> str:
    """The clip line's audio cut by the card pipeline, so the preview is what a card would get."""
    from GameSentenceMiner import replay_handler

    pause_history.remember_pauses(clip.manifest.get("pauses", []))
    first, last = clip.selected[0], clip.selected[-1]
    return replay_handler.ReplayAudioExtractor.get_audio(
        first,
        last.get_next_time(),
        clip.clip_path,
        clip.clip_end_time,
        temporary=True,
        use_vad_postprocessing=False,
        full_text="".join(line.text for line in clip.selected),
    )


def queue_clip_card(card, line, *, rewrite: bool = False, **queue_kwargs):
    """Queue the normal Anki flow for card with line's clip standing in for the OBS replay."""
    clip = line.clip
    last_note = _card_for_rewrite(card, clip) if rewrite else card
    selected = clip.selected if len(clip.selected) > 1 else []
    logger.info(f"Making a card from clip {clip.folder}")
    future = anki.queue_card_for_processing(
        last_note,
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


def enrich_from_clip(card, clip: Clip, *, rewrite: bool = False):
    """Make an existing card from the clip, as if it had just been mined from it."""
    gsm_state.clip_note_ids.add(card.noteId)
    line = find_matching_line(card, clip.selected, respect_replay_window=False) or clip.selected[-1]
    return queue_clip_card(card, line, rewrite=rewrite)
