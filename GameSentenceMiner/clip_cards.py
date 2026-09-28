"""Make Anki cards from lines clip for later.

A clip line's clip stands in for a fresh OBS replay, so the normal Anki flow (timing, VAD,
confirmation dialog, uploads) runs unchanged. Cards reach this module two ways: a new card
whose sentence matches no live line but does match a clip one, and the "Enrich latest card"
button on the Clips to mine page.
"""

import copy
import os
import re
import shutil
import tempfile
from dataclasses import replace

from GameSentenceMiner import anki
from GameSentenceMiner.util.config.configuration import (
    get_config,
    get_temporary_directory,
    gsm_state,
    gsm_status,
    logger,
)
from GameSentenceMiner.util.gsm_utils import remove_html_and_cloze_tags
from GameSentenceMiner.util.clips import Clip
from GameSentenceMiner.util import clips
from GameSentenceMiner.util.text_log import find_matching_line, get_all_lines, lines_match

_BOLD = re.compile(r"<b>(.*?)</b>", re.IGNORECASE | re.DOTALL)


def match_new_card(card):
    """Return (clip line, matched line) when a new card belongs to a clip line, else None.

    Live lines always win: the clip lines are only consulted when neither the text log nor the
    last overlay scan matches, which is exactly when the live flow would fall back to the latest
    line.
    """
    # This runs inside the live flow, so it must never stop a card from being processed.
    try:
        if anki._is_overlay_mine(card):
            return None
        config = get_config()
        if not config.paths.output_folder:
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
        return clips.match_card_to_clip(card, clips.get_clips_root(config.paths.output_folder))
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


def _copy_clip(clip: Clip) -> str:
    """The Anki flow may delete its video afterwards, so it gets a copy shaped like the original."""
    extension = os.path.splitext(clip.clip_path)[1] or ".mkv"
    fd, path = tempfile.mkstemp(prefix="clip_copy_", suffix=extension, dir=get_temporary_directory())
    os.close(fd)
    shutil.copyfile(clip.clip_path, path)
    end = clip.clip_end_time.timestamp()
    os.utime(path, (end, end))
    return path


def _process_replay(video_path, queued_job):
    from GameSentenceMiner import replay_handler

    return replay_handler.get_replay_extractor().process_replay(video_path, queued_job=queued_job)


def clip_line_audio(clip: Clip) -> str:
    """The clip line's audio cut by the card pipeline, so the preview is what a card would get."""
    from GameSentenceMiner import replay_handler

    first, last = clip.selected[0], clip.selected[-1]
    next_line = getattr(last, "next", None)
    cutoff = next_line.time if next_line is not None and next_line.time <= clip.clip_end_time else 0
    return replay_handler.ReplayAudioExtractor.get_audio(
        first,
        cutoff,
        clip.clip_path,
        clip.clip_end_time,
        temporary=True,
        use_vad_postprocessing=False,
        full_text="".join(line.text for line in clip.selected),
    )


def _process_clip_card(card, clip: Clip, line, rewrite: bool) -> None:
    try:
        clip_path = _copy_clip(clip)
        last_note = _card_for_rewrite(card, clip) if rewrite else card
        selected = clip.selected if len(clip.selected) > 1 else []
        # Same shape as a queued live card; the creation time is the clip's end, as with its mtime.
        job = (last_note, clip.clip_end_time, selected, line, None, None, None, None)
        context = _process_replay(clip_path, job)
        if context is not None and getattr(context, "background_update_started", False):
            clips.record_card(clip.folder, card.noteId, _word(card))
    except Exception as e:
        logger.exception(f"Failed to make a card from clip line {clip.folder}: {e}")
        gsm_status.remove_word_being_processed(_word(card))
        from GameSentenceMiner.util.platform import notification

        notification.send_anki_enhancement_failed(f"Could not use the clip: {e}")


def enrich_from_clip(card, clip: Clip, line=None, *, rewrite: bool = False):
    """Queue the Anki flow for card on the clip, on the same worker as live cards."""
    from GameSentenceMiner import replay_handler

    gsm_state.clip_note_ids.add(card.noteId)
    line = line or find_matching_line(card, clip.selected, respect_replay_window=False) or clip.selected[-1]
    return replay_handler.get_card_executor().submit(_process_clip_card, card, clip, line, rewrite)
