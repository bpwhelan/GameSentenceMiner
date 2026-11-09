"""Durable Anki review queue. Only files owned by a queue entry may be removed here."""

from __future__ import annotations

import copy
import json
import os
import re
import shutil
import threading
import uuid
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
from html import unescape
from pathlib import Path
from types import SimpleNamespace

from GameSentenceMiner.util.config.configuration import get_app_directory, get_config, logger, use_profile_config
from GameSentenceMiner.util.media import pause_history

_lock = threading.RLock()
_in_flight: set[str] = set()


def get_review_root() -> Path:
    return Path(get_app_directory()) / "session_review"


def _media_copy_name(source):
    # Preserve the encoder's raw-frame marker without copying a possibly long game title.
    raw = "_raw" if source.suffix.lower() == ".png" and ("_raw" in source.name or "frame_" in source.name) else ""
    return f"{uuid.uuid4().hex}{raw}{source.suffix}"


def enabled(config=None) -> bool:
    settings = getattr(getattr(config or get_config(), "features", None), "review_after_session", None)
    return bool(settings and settings.enabled)


@dataclass
class ReviewEntry:
    folder: Path
    data: dict

    @property
    def id(self):
        return self.folder.name

    def path(self, name):
        if not name:
            return ""
        path = (self.folder / name).resolve()
        if not path.is_relative_to(self.folder.resolve()):
            raise ValueError("Review media must be inside its saved folder.")
        return str(path)

    def save(self):
        with _lock:
            staged = self.folder / "review.json.tmp"
            with staged.open("w", encoding="utf-8") as stream:
                json.dump(self.data, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            staged.replace(self.folder / "review.json")


def claim_entry(entry):
    with _lock:
        if entry.id in _in_flight:
            raise RuntimeError("This card is still being processed.")
        _in_flight.add(entry.id)


def release_entry(entry):
    with _lock:
        _in_flight.discard(entry.id)


def list_pending_reviews(config=None, scene=None):
    config = config or get_config()
    entries = []
    with _lock:
        for manifest in get_review_root().glob("*/review.json"):
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
                if (
                    data.get("version") != 1
                    or data.get("status") != "pending"
                    or data.get("profile_name") != config.name
                    or data.get("anki_url") != config.anki.url
                    or manifest.parent.name in _in_flight
                    or (scene is not None and data.get("scene") != scene)
                ):
                    continue
                entries.append(ReviewEntry(manifest.parent, data))
            except (OSError, ValueError, TypeError):
                logger.warning(f"Could not read saved Anki review: {manifest}")
    return sorted(entries, key=lambda entry: entry.data["created_at"])


def save_pending_review(
    card,
    assets,
    *,
    video_path,
    game_line,
    selected_lines,
    sentence,
    translation,
    ss_time,
    start_time,
    end_time,
    vad_result,
    config,
    replay_context,
):
    from GameSentenceMiner import anki
    from GameSentenceMiner.util.clips import _line_entry
    from GameSentenceMiner.util.media import ffmpeg

    if not video_path or not Path(video_path).is_file():
        raise RuntimeError("The replay could not be saved for later review.")
    # Bind note IDs to the Anki collection that actually owns them.
    anki_profile = anki.invoke("getActiveProfile")
    if not isinstance(anki_profile, str) or not anki_profile:
        raise RuntimeError("AnkiConnect could not identify the active Anki profile.")
    folder = get_review_root() / uuid.uuid4().hex
    folder.mkdir(parents=True)
    entry = ReviewEntry(folder, {})
    claim_entry(entry)
    copied = {}

    def keep(path, *, link=False):
        if not path or not Path(path).is_file():
            return ""
        source = Path(path)
        if str(source) in copied:
            return copied[str(source)]
        name = _media_copy_name(source)
        target = folder / name
        if link:
            try:
                os.link(source, target)
            except OSError:
                shutil.copy2(source, target)
        else:
            shutil.copy2(source, target)
        copied[str(source)] = name
        return name

    try:
        replay = keep(video_path, link=True)
        capture_end = datetime.fromtimestamp(os.path.getmtime(video_path), UTC).astimezone().replace(tzinfo=None)
        duration = ffmpeg.get_video_duration(video_path)
        capture_start = capture_end - timedelta(seconds=max(0, duration))
        selected = selected_lines or ([game_line] if game_line else [])
        selected_ids = {line.id for line in selected}
        neighbors = {line.id: line for line in selected}
        # Preserve the linked log, bounded by this replay, just like saved clips.
        for direction in ("prev", "next"):
            neighbor = getattr(selected[0 if direction == "prev" else -1], direction, None) if selected else None
            seen = set(neighbors)
            while neighbor and neighbor.id not in seen:
                seen.add(neighbor.id)
                if duration > 0 and not capture_start <= neighbor.time <= capture_end:
                    break
                neighbors[neighbor.id] = neighbor
                neighbor = getattr(neighbor, direction, None)
        if game_line:
            neighbors[game_line.id] = game_line
        lines = sorted(neighbors.values(), key=lambda line: line.time)
        manifest = {
            "clip": {"file": replay, "end_time": capture_end.isoformat()},
            "lines": [_line_entry(line, "selected" if line.id in selected_ids else "context") for line in lines],
            "pauses": [
                list(span)
                for span in pause_history.get_pauses_between(capture_start.timestamp(), capture_end.timestamp())
            ],
        }
        (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        edit_context = getattr(replay_context, "audio_edit_context", None)
        edit_data = asdict(edit_context) if edit_context else None
        if edit_data:
            edit_data["source_audio_path"] = keep(edit_context.source_audio_path)
        vad_data = dict(vars(vad_result)) if vad_result else None
        if vad_data:
            vad_data["segments"] = [asdict(segment) for segment in vad_result.segments]
            for key in ("output_audio", "trimmed_audio_path"):
                vad_data[key] = keep(vad_data.get(key))
        entry.data = {
            "version": 1,
            "status": "pending",
            "created_at": datetime.now(UTC).astimezone().isoformat(),
            "profile_name": config.name,
            "anki_url": config.anki.url,
            "anki_profile": anki_profile,
            "anki_config": config.anki.to_dict(),
            "note_id": int(card.noteId),
            "model_name": card.modelName,
            "audio_config": config.audio.to_dict(),
            "screenshot_config": config.screenshot.to_dict(),
            "translation_field": config.ai.anki_field if config.ai.add_to_anki else "",
            "expression": card.get_field(config.anki.word_field),
            "sentence": sentence,
            "translation": translation,
            "scene": (game_line.scene if game_line else "") or assets.game_name,
            "line_id": game_line.id if game_line else None,
            "selected_ids": [line.id for line in selected],
            "fields": {name: field.value for name, field in card.fields.items()},
            "tags": list(card.tags),
            "screenshot": keep(assets.screenshot_path),
            "previous_screenshot": keep(assets.prev_screenshot_path),
            "audio": keep(assets.audio_path),
            "vad": vad_data,
            "audio_edit_context": edit_data,
            "screenshot_time": ss_time,
            "previous_screenshot_time": assets.prev_screenshot_timestamp,
            "start_time": start_time or 0,
            "end_time": end_time or 0,
            "pending_animated": assets.pending_animated,
            "pending_video": assets.pending_video,
            "video_params": dict(assets.video_params),
            "owned_media": [],
            "cleanup_pending": [],
        }
        entry.save()
        if not getattr(game_line, "clip", None):
            from GameSentenceMiner import session_review_context

            try:
                session_review_context.register(entry, game_line, selected, config)
            except Exception:  # noqa: BLE001 - Future context is optional; the original review is already durable.
                logger.exception("Could not watch for future context; keeping the original review.")
        return entry
    except Exception:
        release_entry(entry)
        _remove_owned_folder(folder)
        raise


def record_initial_update(entry, note, assets):
    entry.data["fields"].update(note["fields"])
    entry.data["owned_media"] = media_names(assets)
    entry.save()


def media_names(assets):
    return sorted(
        {
            name
            for name in [
                assets.audio_in_anki,
                assets.screenshot_in_anki,
                assets.prev_screenshot_in_anki,
                assets.video_in_anki,
                *assets.screenshot_media_in_anki,
                *assets.prev_screenshot_media_in_anki,
            ]
            if name
        }
    )


def review_config(entry):
    from GameSentenceMiner.util.config.configuration import Anki, Audio, Screenshot

    config = copy.deepcopy(get_config())
    if config.name != entry.data["profile_name"] or config.anki.url != entry.data["anki_url"]:
        raise RuntimeError(f"Switch GSM to profile {entry.data['profile_name']} to review this card.")
    config.anki = Anki.from_dict(entry.data["anki_config"])
    config.audio = Audio.from_dict(entry.data["audio_config"])
    config.screenshot = Screenshot.from_dict(entry.data["screenshot_config"])
    config.ai.anki_field = entry.data.get("translation_field") or config.ai.anki_field
    # Explicit edits replace the corresponding GSM fields even when normal mining appends.
    for field_config in vars(config.anki).values():
        if hasattr(field_config, "overwrite"):
            field_config.overwrite = True
            field_config.append = False
    return config


def open_in_anki(entry):
    from GameSentenceMiner import anki

    config = review_config(entry)
    with use_profile_config(config):
        _current_note(entry, config)
        anki.invoke("guiEditNote", note=entry.data["note_id"])
    return "Opened this card in Anki."


def notify_pending_on_startup():
    from GameSentenceMiner.util.platform import notification

    config = get_config()
    if not config.features.review_after_session.notify_on_startup:
        return False
    pending = list_pending_reviews(config)
    if not pending:
        return False
    notification.send_pending_reviews_notification(len(pending))
    return True


def load_review(entry):
    from GameSentenceMiner import session_review_context
    from GameSentenceMiner.replay_handler import AudioEditContext, ReplayAudioResult, ReplayProcessingContext
    from GameSentenceMiner.util.clips import load_clip
    from GameSentenceMiner.util.media.pause_gaps import AudioTimeline
    from GameSentenceMiner.util.models.model import AnkiCard, VADResult
    from GameSentenceMiner.vad import Segment

    clip = load_clip(str(entry.folder))
    if not Path(clip.clip_path).is_file():
        raise RuntimeError("The saved replay is missing. The Anki card has not been changed.")
    pause_history.remember_pauses(clip.manifest.get("pauses", []))
    config = review_config(entry)
    with use_profile_config(config):
        card = AnkiCard.from_dict(
            {
                "noteId": entry.data["note_id"],
                "modelName": entry.data["model_name"],
                "tags": entry.data["tags"],
                "cards": [],
                "fields": {
                    name: {"value": value, "order": i} for i, (name, value) in enumerate(entry.data["fields"].items())
                },
            }
        )
    vad = None
    if entry.data["vad"]:
        vad = VADResult(False, 0, 0, "")
        vad.__dict__.update(entry.data["vad"])
        vad.segments = [Segment(**segment) for segment in vad.segments]
        vad.output_audio = entry.path(vad.output_audio)
        vad.trimmed_audio_path = entry.path(vad.trimmed_audio_path)
    edit = copy.deepcopy(entry.data["audio_edit_context"])
    if edit:
        edit["source_audio_path"] = entry.path(edit["source_audio_path"])
        if edit.get("timeline") is not None:
            edit["timeline"] = AudioTimeline(tuple(tuple(span) for span in edit["timeline"]["cuts"]))
        edit = AudioEditContext(**edit)
    audio = ReplayAudioResult(
        entry.path(entry.data["audio"]),
        vad,
        vad.trimmed_audio_path if vad else "",
        entry.data["start_time"],
        entry.data["end_time"],
        edit,
    )
    line = next((line for line in clip.lines if line.id == entry.data["line_id"]), None)
    context = ReplayProcessingContext(
        video_path=clip.clip_path,
        skip_delete=True,
        mined_line=line,
        last_note=card,
        selected_lines=[line for line in clip.lines if line.id in entry.data["selected_ids"]],
        anki_card_creation_time=clip.clip_end_time,
        audio_result=audio,
    )
    context.saved_review = True
    future_clip = session_review_context.load_future_clip(entry, clip)
    return SimpleNamespace(
        context=context,
        config=config,
        audio_path=audio.final_audio_output,
        screenshot_path=entry.path(entry.data["screenshot"]),
        previous_screenshot_path=entry.path(entry.data["previous_screenshot"]),
        original_clip=clip,
        future_clip=future_clip,
    )


def _remove_owned_folder(folder):
    root, target = get_review_root().resolve(), Path(folder).resolve()
    if target.parent != root or not re.fullmatch(r"[0-9a-f]{32}", target.name):
        raise ValueError("Refusing to remove a folder outside the saved review queue.")
    shutil.rmtree(target)


def prepare_dialogue_change(prepared, selected_lines, *, translation, refresh_translation):
    """Generate context edits on a worker, using the extra replay only when needed."""
    from GameSentenceMiner import anki, session_review_context
    from GameSentenceMiner.replay_handler import ReplayAudioExtractor
    from GameSentenceMiner.util.gsm_utils import remove_html_and_cloze_tags
    from GameSentenceMiner.util.media import ffmpeg

    context = session_review_context.context_for_selection(prepared, selected_lines)
    selected = context.selected_lines
    with use_profile_config(prepared.config):
        sentence = anki._build_selected_lines_sentence(context.last_note, selected)
        regenerated = False
        if refresh_translation:
            translated = anki.prefetch_ai_translation(remove_html_and_cloze_tags(sentence), context.mined_line)
            if translated:
                translation, regenerated = translated, True
        audio = None
        if prepared.config.audio.enabled and anki._field_is_active("sentence_audio_field", prepared.config.anki):
            audio = ReplayAudioExtractor.get_audio(
                selected[0],
                selected[-1].get_next_time(),
                context.video_path,
                context.anki_card_creation_time,
                mined_line=context.mined_line,
                full_text=remove_html_and_cloze_tags(sentence),
            )
        return SimpleNamespace(
            context=context,
            audio=audio,
            translation=translation,
            translation_regenerated=regenerated,
            duration=ffmpeg.get_video_duration(context.video_path),
        )


def finish_review(entry, settings):
    from GameSentenceMiner import session_review_context

    with _lock:
        entry.data["status"] = "reviewed"
        entry.save()
        session_review_context.cancel(entry.id)
        future_folder = Path(entry.path("future"))
        if future_folder.exists():
            try:
                shutil.rmtree(future_folder)
            except OSError:
                logger.exception("Could not remove the extra context replay; cleanup can be retried.")
    if settings.delete_local_after_review and not entry.data.get("cleanup_pending"):
        try:
            _remove_owned_folder(entry.folder)
        except OSError:
            logger.exception("Review completed, but local media is still in use; cleanup can be retried.")
            if entry.folder.exists():
                entry.save()


def _invalidate_media_reuse(line_id, media):
    from GameSentenceMiner import anki

    invalid_ids = {line_id}
    for key, result in list(anki.anki_results.items()):
        referenced = {
            getattr(result, name, "")
            for name in ("audio_in_anki", "screenshot_in_anki", "prev_screenshot_in_anki", "video_in_anki")
        }
        referenced.update(getattr(result, "screenshot_media_in_anki", []))
        referenced.update(getattr(result, "prev_screenshot_media_in_anki", []))
        if key == line_id or referenced.intersection(media):
            invalid_ids.add(key)
            anki.anki_results.pop(key, None)
    for key, cached in list(anki.sentence_audio_cache.items()):
        if cached.line_id in invalid_ids:
            anki.sentence_audio_cache.pop(key, None)


def _current_note(entry, config):
    from GameSentenceMiner import anki
    from GameSentenceMiner.util.models.model import AnkiCard

    if anki.invoke("getActiveProfile") != entry.data["anki_profile"]:
        raise RuntimeError(f"Open Anki profile {entry.data['anki_profile']} before saving this review.")
    notes = anki.invoke("notesInfo", notes=[entry.data["note_id"]])
    if not notes or not notes[0] or not notes[0].get("fields"):
        raise RuntimeError("This note no longer exists in Anki. Use Keep card / remove from queue to dismiss it.")
    info = notes[0]
    if (
        info.get("modelName") != entry.data["model_name"]
        or info["fields"].get(config.anki.word_field, {}).get("value") != entry.data["expression"]
    ):
        raise RuntimeError("This note's expression or note type changed in Anki. Check the note before reviewing it.")
    return AnkiCard.from_dict(info)


@dataclass(frozen=True)
class ReviewAudioEdit:
    """Audio export instructions captured on Qt's thread, rendered by a worker."""

    source_path: str
    duration: float
    keep_ranges: tuple[tuple[float, float], ...]

    @property
    def needs_render(self):
        return not (
            len(self.keep_ranges) == 1
            and abs(self.keep_ranges[0][0]) < 0.01
            and abs(self.keep_ranges[0][1] - self.duration) < 0.01
        )

    def render(self, destination):
        from GameSentenceMiner.util.media import ffmpeg

        if not self.keep_ranges:
            raise RuntimeError("Audio edits would remove the entire selected range.")
        if len(self.keep_ranges) == 1:
            start, end = self.keep_ranges[0]
            ffmpeg.trim_audio(
                input_audio=self.source_path,
                start_time=start,
                end_time=end,
                output_audio=str(destination),
                trim_beginning=True,
                fade_in_duration=0.05,
                fade_out_duration=0.05,
            )
        else:
            ffmpeg.splice_audio(
                input_audio=self.source_path,
                output_audio=str(destination),
                keep_ranges=list(self.keep_ranges),
                fade_duration=0.05,
            )
        if not destination.is_file() or destination.stat().st_size == 0:
            raise RuntimeError("Could not export the edited audio. Your review is still pending.")
        return str(destination)


def _media_key(value):
    if hasattr(value, "items") and hasattr(value, "source_path"):
        return (_media_key(value.source_path), tuple((_media_key(item.path), item.start) for item in value.items))
    return os.path.normcase(os.path.abspath(value)) if value else ""


def _review_changes(entry, prepared, values, config):
    from GameSentenceMiner import anki

    voice, sentence, translation, screenshot, previous, nsfw, audio, metadata = values
    changes = set()
    for key, field_key, value in (
        ("sentence", "sentence_field", sentence),
        ("previous", "previous_image_field", previous),
        ("screenshot", "picture_field", screenshot),
    ):
        if not anki._field_is_active(field_key, config.anki):
            continue
        if key == "sentence":
            changed = sentence.strip() != (entry.data["sentence"] or "").strip()
        else:
            baseline = prepared.previous_screenshot_path if key == "previous" else prepared.screenshot_path
            changed = _media_key(value) != _media_key(baseline)
        if changed:
            changes.add(key)
    if entry.data.get("translation_field") and translation.strip() != (entry.data["translation"] or "").strip():
        changes.add("translation")
    if nsfw and "NSFW" not in entry.data["tags"]:
        changes.add("nsfw")
    if anki._field_is_active("sentence_audio_field", config.anki):
        had_audio = bool(entry.data["fields"].get(config.anki.sentence_audio_field, "").strip())
        edit = metadata.get("review_audio_edit")
        if bool(voice) != had_audio or (
            voice and (_media_key(audio) != _media_key(prepared.audio_path) or (edit and edit.needs_render))
        ):
            changes.add("audio")
    selected = metadata.get("selected_lines")
    if (
        selected is not None
        and [line.id for line in selected] != entry.data["selected_ids"]
        and anki._field_is_active("previous_sentence_field", config.anki)
    ):
        changes.add("previous_sentence")
    return changes


def _referenced_media(names, fields):
    values = [unescape(value or "").strip() for value in fields]
    references = set(values)  # Video fields can contain a bare filename.
    for value in values:
        references.update(re.findall(r"\[sound:([^\]]+)\]", value))
        references.update(re.findall(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", value, re.IGNORECASE))
    return set(names) & references


def apply_review(entry, prepared, result):
    """Apply only explicit edits; an unchanged confirmation is entirely local."""
    from GameSentenceMiner import anki
    from GameSentenceMiner.util.database.db import GameLinesTable

    config = review_config(entry)
    with use_profile_config(config):
        values = anki._parse_confirmation_dialog_result(result)
        voice, sentence, translation, screenshot, previous, _nsfw, audio, metadata = values
        changes = _review_changes(entry, prepared, values, config)
        settings = config.features.review_after_session
        if not changes:
            finish_review(entry, settings)
            return "Confirmed. Removed from the review queue."

        last_note = _current_note(entry, config)
        note = {"id": last_note.noteId, "fields": {}}
        if "sentence" in changes:
            anki._apply_confirmed_sentence_fields(note, last_note, sentence)
            if not sentence:
                note["fields"][config.anki.sentence_field] = ""
                if anki._field_is_active("sentence_furigana_field", config.anki):
                    note["fields"][config.anki.sentence_furigana_field] = ""
        if "translation" in changes:
            note["fields"][entry.data["translation_field"]] = translation
        selected = metadata.get("selected_lines") or prepared.context.selected_lines
        if "previous_sentence" in changes:
            previous_line = selected[0].prev if selected else None
            note["fields"][config.anki.previous_sentence_field] = previous_line.text if previous_line else ""
        scratch = entry.folder / f"work-{uuid.uuid4().hex}"

        def work_directory():
            scratch.mkdir(exist_ok=True)
            return scratch

        def working_copy(path):
            if not path:
                return ""
            source = Path(path)
            if not source.is_file():
                raise RuntimeError(f"Review media is missing: {source.name}")
            target = work_directory() / _media_copy_name(source)
            shutil.copy2(source, target)
            return str(target)

        assets = anki.MediaAssets(
            source_video_path=metadata.get("review_video_path") or prepared.context.video_path,
            screenshot_timestamp=metadata.get("review_screenshot_time", entry.data["screenshot_time"]),
            prev_screenshot_timestamp=metadata.get(
                "review_previous_screenshot_time", entry.data["previous_screenshot_time"]
            ),
            game_name=entry.data["scene"],
        )
        media_fields = set()
        try:
            requirements = []
            for key, selection, field_key, path_attr, selected_attr, stored_attr in (
                (
                    "screenshot",
                    screenshot,
                    "picture_field",
                    "screenshot_path",
                    "selected_screenshots",
                    "screenshot_in_anki",
                ),
                (
                    "previous",
                    previous,
                    "previous_image_field",
                    "prev_screenshot_path",
                    "selected_prev_screenshots",
                    "prev_screenshot_in_anki",
                ),
            ):
                if key not in changes:
                    continue
                field_name = getattr(config.anki, field_key)
                media_fields.add(field_name)
                if not selection:
                    note["fields"][field_name] = ""
                    continue
                if anki._is_screenshot_selection(selection):
                    copied = replace(
                        selection, items=tuple(replace(item, path=working_copy(item.path)) for item in selection.items)
                    )
                    setattr(assets, selected_attr, copied)
                    setattr(assets, path_attr, copied.items[0].path)
                else:
                    setattr(assets, path_attr, working_copy(selection))
                requirements.append((field_key, stored_attr))
            if assets.selected_screenshots or assets.selected_prev_screenshots:
                anki._process_selected_screenshots(assets, note, config, last_note)
            if assets.screenshot_path and not assets.selected_screenshots:
                anki._process_screenshot(assets, note, config, True, False, last_note=last_note)
            if assets.prev_screenshot_path and not assets.selected_prev_screenshots:
                anki._process_previous_screenshot(assets, note, config, False, last_note=last_note)
            if "audio" in changes:
                media_fields.add(config.anki.sentence_audio_field)
                if voice:
                    if not audio or not Path(audio).is_file():
                        raise RuntimeError(
                            "No audio is available. Choose Confirm without audio or generate audio first."
                        )
                    edit = metadata.get("review_audio_edit")
                    if edit and edit.needs_render:
                        destination = work_directory() / f"audio-{uuid.uuid4().hex}{Path(audio).suffix or '.wav'}"
                        assets.audio_path = edit.render(destination)
                    else:
                        assets.audio_path = working_copy(audio)
                    requirements.append(("sentence_audio_field", "audio_in_anki"))
                    anki._process_audio(assets, note, config, True, False, last_note=last_note)
                else:
                    note["fields"][config.anki.sentence_audio_field] = ""
            for field_key, asset_key in requirements:
                if not getattr(assets, asset_key) or getattr(config.anki, field_key) not in note["fields"]:
                    raise RuntimeError(
                        "Some media could not be uploaded. Your review is still pending; try saving again."
                    )
            missing = set(note["fields"]) - set(last_note.fields)
            if missing:
                raise RuntimeError("These Anki fields are missing: " + ", ".join(sorted(missing)))
            anki._normalize_anki_sentence_line_breaks(note, config.anki)
            # Recheck immediately before writing, and don't replace edits made in Anki since loading.
            current = _current_note(entry, config)
            for name, value in note["fields"].items():
                baseline = entry.data["fields"].get(name, "")
                if current.get_field(name) not in (baseline, value):
                    raise RuntimeError(
                        f"The {name} field was changed in Anki. Keep that card and remove it from this queue, or restore the field before saving."
                    )
            note["fields"] = {name: value for name, value in note["fields"].items() if current.get_field(name) != value}
            verified = current
            if note["fields"]:
                anki._release_note_from_browser(last_note.noteId)
                anki.invoke("updateNoteFields", note=note)
                # An open Anki editor can overwrite an acknowledged field update.
                verified = _current_note(entry, config)
                if any(verified.get_field(name) != value for name, value in note["fields"].items()):
                    raise RuntimeError("Anki did not retain every edited field. Close its note editor and save again.")
            if "nsfw" in changes and "NSFW" not in current.tags:
                anki.invoke("addTags", notes=[last_note.noteId], tags="NSFW")
            if "audio" in changes and config.anki.tag_unvoiced_cards and (("unvoiced" in current.tags) == bool(voice)):
                anki.invoke("removeTags" if voice else "addTags", notes=[last_note.noteId], tags="unvoiced")
            anki._trigger_incremental_anki_cache_sync([last_note.noteId])
            history_updates = {}
            if "translation" in changes:
                history_updates["translation"] = translation
            if "audio" in changes:
                history_updates["audio_in_anki"] = (
                    os.path.join(config.audio.anki_media_collection, assets.audio_in_anki)
                    if assets.audio_in_anki
                    else ""
                )
            if "screenshot" in changes:
                history_updates["screenshot_in_anki"] = (
                    os.path.join(config.audio.anki_media_collection, assets.screenshot_in_anki)
                    if assets.screenshot_in_anki
                    else ""
                )
            try:
                if entry.data["line_id"] and history_updates:
                    GameLinesTable.update(line_id=entry.data["line_id"], **history_updates)
            except Exception:  # noqa: BLE001 - Anki is already updated; local history must not lose the review.
                logger.exception("Review saved, but its local history could not be refreshed.")
            owned = set(entry.data["owned_media"])
            obsolete = _referenced_media(owned, [entry.data["fields"].get(name, "") for name in media_fields])
            obsolete -= _referenced_media(owned, [field.value for field in verified.fields.values()])
            if media_fields:
                _invalidate_media_reuse(entry.data["line_id"], obsolete)
            if obsolete and settings.cleanup_anki_media:
                entry.data["cleanup_pending"] = sorted(
                    set(entry.data.get("cleanup_pending", [])) | set(cleanup_unused_media(obsolete))
                )
            entry.data["owned_media"] = sorted((owned - obsolete) | set(media_names(assets)))
            entry.data["fields"].update(note["fields"])
            if "sentence" in changes:
                entry.data["sentence"] = sentence
            if "translation" in changes:
                entry.data["translation"] = translation
            finish_review(entry, settings)
            return "Saved to Anki."
        except Exception:
            # Keep track of any uploads from a failed attempt; cleanup must never run before a verified update.
            entry.data["owned_media"] = sorted(set(entry.data["owned_media"]) | set(media_names(assets)))
            entry.save()
            raise
        finally:
            # scratch is constructed inside this entry, never taken from a manifest.
            if scratch.exists():
                shutil.rmtree(scratch)


def cleanup_unused_media(names):
    """Delete only tracked GSM media, after checking note and template references."""
    from GameSentenceMiner import anki

    if not names:
        return []
    pending = []
    try:
        templates = []
        for model in anki.invoke("modelNames"):
            templates.append(json.dumps(anki.invoke("modelTemplates", modelName=model), ensure_ascii=False))
            templates.append(json.dumps(anki.invoke("modelStyling", modelName=model), ensure_ascii=False))
    except Exception:  # noqa: BLE001 - Cleanup is optional and must preserve files when Anki is unavailable.
        return sorted(set(names))
    for name in sorted(set(names)):
        # Such names cannot be searched literally with this conservative query.
        if not name or any(char in name for char in '*?"\\/\n\r') or name.startswith("_"):
            continue
        try:
            if any(name in template for template in templates) or anki.invoke("findNotes", query=f'"{name}"'):
                continue
            anki.invoke("deleteMediaFile", filename=name)
        except Exception:  # noqa: BLE001 - Any API failure leaves this owned file available for retry.
            logger.exception(f"Could not clean replaced Anki media {name}; keeping it for retry.")
            pending.append(name)
    return pending


def discard_review(entry, *, delete_note=False):
    from GameSentenceMiner import anki

    config = review_config(entry)
    with use_profile_config(config):
        if delete_note:
            _current_note(entry, config)
            anki.invoke("deleteNotes", notes=[entry.data["note_id"]])
            if any(anki.invoke("notesInfo", notes=[entry.data["note_id"]])):
                raise RuntimeError("Anki did not delete the note. The review is still pending.")
            _invalidate_media_reuse(entry.data["line_id"], set(entry.data["owned_media"]))
            if config.features.review_after_session.cleanup_anki_media:
                entry.data["cleanup_pending"] = cleanup_unused_media(entry.data["owned_media"])
        finish_review(entry, config.features.review_after_session)
    return "Card deleted." if delete_note else "Kept the Anki card and removed it from the review queue."


def retry_media_cleanup():
    """Retry only cleanup recorded by completed reviews in this collection."""
    from GameSentenceMiner import anki

    config = get_config()
    profile = anki.invoke("getActiveProfile")
    remaining = 0
    for manifest in get_review_root().glob("*/review.json"):
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if (
            data.get("status") != "reviewed"
            or data.get("profile_name") != config.name
            or data.get("anki_url") != config.anki.url
            or data.get("anki_profile") != profile
        ):
            continue
        entry = ReviewEntry(manifest.parent, data)
        data["cleanup_pending"] = cleanup_unused_media(data.get("cleanup_pending", []))
        remaining += len(data["cleanup_pending"])
        finish_review(entry, config.features.review_after_session)
    return remaining


class SessionCloseGate:
    """Debounce a known active -> closed transition, ignoring unknown capture state."""

    def __init__(self):
        self.scene = None
        self.was_active = False
        self.closed_since = None

    def observe(self, snapshot, now, delay):
        scene, active = snapshot.get("sceneName"), snapshot.get("active")
        if scene != self.scene:
            self.scene, self.was_active, self.closed_since = scene, False, None
        if active is True:
            self.was_active, self.closed_since = True, None
        elif active is False and self.was_active:
            if self.closed_since is None:
                self.closed_since = now
            if now - self.closed_since >= delay:
                self.was_active = False
                return scene
        else:
            self.closed_since = None
        return None
