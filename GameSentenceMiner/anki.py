import base64
import json
import os
import platform
import re
import requests
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, Any, List, Tuple, Optional

from GameSentenceMiner import obs
from GameSentenceMiner.ai.ai_prompting import get_ai_prompt_result
from GameSentenceMiner.mecab import mecab
from GameSentenceMiner.obs import get_current_game
from GameSentenceMiner.util.config.configuration import CommonLanguages, get_config, AnkiUpdateResult, logger, \
    anki_results, gsm_status, \
    gsm_state
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.gsm_utils import preserve_html_tags, sanitize_filename, wait_for_stable_file, remove_html_and_cloze_tags, \
    combine_dialogue, \
    run_new_thread, open_audio_in_external
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.models.model import AnkiCard
from GameSentenceMiner.util.platform import notification
from GameSentenceMiner.util.stats.live_stats import live_stats_tracker
from GameSentenceMiner.util.text_log import GameLine, TextSource, get_all_lines, get_text_event, get_mined_line, \
    lines_match, strip_whitespace_and_punctuation
from GameSentenceMiner.web import texthooking_page

# Global variables to track state
previous_note_ids = set()
first_run = True
card_queue = []
sentence_audio_cache = {}


@dataclass
class SentenceAudioCacheEntry:
    line_id: str
    word: str
    created_at: datetime


# --- Migration Utilities ---
def migrate_old_word_folders():
    """
    Move old word folders in the output directory to the new date-based structure (YYYY-MM/DD/WORD),
    using the latest modified date of the files inside each folder.
    """
    config = get_config()
    output_folder = config.paths.output_folder
    if not output_folder or not os.path.exists(output_folder):
        return

    # Regex for new date-based folder: YYYY-MM/DD
    date_folder_pattern = re.compile(r"^\d{4}-\d{2}$")

    file_pattern = re.compile(r"_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}")

    for entry in os.listdir(output_folder):
        entry_path = os.path.join(output_folder, entry)
        if not os.path.isdir(entry_path):
            continue
        # If this is a date folder, skip
        if date_folder_pattern.match(entry):
            continue
        # Otherwise, this is an old-style word folder
        # Check all files for the required pattern
        all_files_match = True
        file_paths = []
        for root, dirs, files in os.walk(entry_path):
            for fname in files:
                fpath = os.path.join(root, fname)
                file_paths.append(fpath)
                if not file_pattern.search(fname):
                    all_files_match = False
                    break
            if not all_files_match:
                break
        if not file_paths or not all_files_match:
            # No files or not all files match the pattern, skip
            continue
        # Find latest modified date among files
        latest_mtime = 0
        for fpath in file_paths:
            try:
                mtime = os.path.getmtime(fpath)
                if mtime > latest_mtime:
                    latest_mtime = mtime
            except Exception:
                continue
        if latest_mtime == 0:
            # No files, skip
            continue
        dt = datetime.fromtimestamp(latest_mtime)
        date_dir = dt.strftime("%Y-%m")
        day_dir = dt.strftime("%d")
        new_base = os.path.join(output_folder, date_dir, day_dir)
        os.makedirs(new_base, exist_ok=True)
        new_path = os.path.join(new_base, entry)
        # Move the folder
        try:
            shutil.move(entry_path, new_path)
            logger.info(f"Migrated old word folder '{entry_path}' to '{new_path}'")
        except Exception as e:
            logger.error(f"Failed to migrate '{entry_path}': {e}")


@dataclass
class MediaAssets:
    """A simple container for media file paths and their Anki names."""
    # Local temporary paths
    audio_path: str = ''
    screenshot_path: str = ''
    prev_screenshot_path: str = ''
    video_path: str = ''
    source_video_path: str = ''
    screenshot_timestamp: float = 0.0
    prev_screenshot_timestamp: float = 0.0
    
    # Filenames after being stored in Anki's media collection
    audio_in_anki: str = ''
    screenshot_in_anki: str = ''
    prev_screenshot_in_anki: str = ''
    video_in_anki: str = ''

    # Paths after being copied to the final output folder
    final_audio_path: str = ''
    final_screenshot_path: str = ''
    final_prev_screenshot_path: str = ''
    final_video_path: str = ''

    extra_tags: List[str] = field(default_factory=list)
    
    # Animated screenshot deferred generation
    pending_animated: bool = False
    animated_video_path: str = ''
    animated_start_time: float = 0.0
    animated_vad_start: float = 0.0
    animated_vad_end: float = 0.0
    animated_prefetch_event: Any = None
    animated_prefetch_path: str = ''
    
    # Video deferred generation
    pending_video: bool = False
    video_params: Dict[str, Any] = field(default_factory=dict)
    
    # Cleanup callback (called after all background processing is complete)
    cleanup_callback: Any = None  # Callable to run after processing
    
    # Success Message Flags
    animated = False
    video = False


def _get_anki_field_config(field_key: str, anki_cfg=None):
    anki_cfg = anki_cfg or get_config().anki
    if hasattr(anki_cfg, "get_field_config"):
        return anki_cfg.get_field_config(field_key)

    field_name = getattr(anki_cfg, field_key, '')
    enabled = bool(getattr(anki_cfg, f"{field_key}_enabled", True))
    append = bool(getattr(anki_cfg, f"{field_key}_append", False))

    legacy_overwrite_key = {
        "sentence_field": "overwrite_sentence",
        "sentence_audio_field": "overwrite_audio",
        "picture_field": "overwrite_picture",
    }.get(field_key)
    overwrite_defaults = {
        "word_field": True,
        "previous_image_field": True,
        "video_field": True,
        "sentence_furigana_field": True,
        "game_name_field": True,
    }
    overwrite_default = overwrite_defaults.get(field_key, False)
    if legacy_overwrite_key:
        overwrite_default = bool(getattr(anki_cfg, legacy_overwrite_key, overwrite_default))
    overwrite = bool(getattr(anki_cfg, f"{field_key}_overwrite", overwrite_default))

    if field_key in {"sentence_field", "sentence_audio_field", "picture_field", "word_field"}:
        enabled = True
    if overwrite and append:
        append = False

    return SimpleNamespace(name=field_name, enabled=enabled, overwrite=overwrite, append=append)


def _field_is_active(field_key: str, anki_cfg=None) -> bool:
    field_cfg = _get_anki_field_config(field_key, anki_cfg=anki_cfg)
    return bool(field_cfg.enabled and field_cfg.name)


def _field_value_in_note_or_anki(note: Dict, last_note: 'AnkiCard', field_name: str) -> str:
    value = note.get('fields', {}).get(field_name, '')
    if (value is None or value == '') and last_note and field_name:
        try:
            value = last_note.get_field(field_name)
        except Exception:
            value = ''
    return value or ''


def _field_should_write(
    last_note: 'AnkiCard',
    field_key: str,
    note: Optional[Dict] = None,
    anki_cfg=None,
) -> bool:
    if field_key == "word_field":
        return False
    field_cfg = _get_anki_field_config(field_key, anki_cfg=anki_cfg)
    if not field_cfg.enabled or not field_cfg.name:
        return False
    existing_value = _field_value_in_note_or_anki(note or {'fields': {}}, last_note, field_cfg.name)
    if field_cfg.overwrite or field_cfg.append:
        return True
    return not bool(existing_value)


def _apply_field_policy(
    note: Dict,
    last_note: Optional['AnkiCard'],
    field_key: str,
    value: str,
    append_separator: str = '',
    anki_cfg=None,
) -> bool:
    if field_key == "word_field":
        return False
    field_cfg = _get_anki_field_config(field_key, anki_cfg=anki_cfg)
    if not field_cfg.enabled or not field_cfg.name:
        return False
    if value is None or value == '':
        return False

    existing_value = _field_value_in_note_or_anki(note, last_note, field_cfg.name)

    if field_cfg.append:
        if existing_value:
            note['fields'][field_cfg.name] = f"{existing_value}{append_separator}{value}"
        else:
            note['fields'][field_cfg.name] = value
        return True

    if field_cfg.overwrite:
        note['fields'][field_cfg.name] = value
        return True

    if existing_value:
        return False

    note['fields'][field_cfg.name] = value
    return True


def _determine_update_conditions(last_note: 'AnkiCard') -> (bool, bool):
    """Determine if audio and picture fields should be updated."""
    config = get_config()
    update_audio = _field_should_write(last_note, "sentence_audio_field", anki_cfg=config.anki)

    update_picture = _field_should_write(last_note, "picture_field", anki_cfg=config.anki) and config.screenshot.enabled
                      
    return update_audio, update_picture


def _generate_media_files(
    reuse_audio: bool,
    game_line: 'GameLine',
    video_path: str,
    ss_time: float,
    start_time: float,
    vad_result: Any,
    selected_lines: List['GameLine'],
    reuse_result_id: Optional[str] = None,
) -> MediaAssets:
    """Generates or retrieves paths for all media assets (audio, video, screenshots)."""
    assets = MediaAssets()
    config = get_config()

    if reuse_audio:
        logger.background("Reusing media from last note")
        result_id = reuse_result_id or (game_line.id if game_line else None)
        if result_id and result_id in anki_results:
            anki_result: 'AnkiUpdateResult' = anki_results[result_id]
            assets.audio_in_anki = anki_result.audio_in_anki
            assets.screenshot_in_anki = anki_result.screenshot_in_anki
            assets.prev_screenshot_in_anki = anki_result.prev_screenshot_in_anki
            assets.video_in_anki = anki_result.video_in_anki
            assets.extra_tags = anki_result.extra_tags
            return assets
        logger.warning("Requested reuse audio, but no cached Anki result found. Falling back to new media.")
    
    assets.extra_tags = []
    assets.source_video_path = video_path or ''
    assets.screenshot_timestamp = ss_time or 0.0

    # --- Generate new media files ---
    if _field_is_active("picture_field") and config.screenshot.enabled:
        if config.screenshot.animated:
            # Defer animated screenshot generation until after confirmation
            logger.info("Animated screenshot will be generated after confirmation...")
            assets.pending_animated = True
            assets.animated_video_path = video_path
            assets.animated_start_time = start_time
            if vad_result:
                assets.animated_vad_start = vad_result.start
                assets.animated_vad_end = vad_result.end
            # Generate a raw PNG as a placeholder for the dialog (fast)
            logger.info("Getting raw placeholder screenshot...")
            assets.screenshot_path = ffmpeg.get_raw_screenshot(
                video_path,
                ss_time,
            )
        else:
            # For static screenshots, get raw PNG quickly for confirmation dialog
            logger.info("Getting raw screenshot...")
            assets.screenshot_path = ffmpeg.get_raw_screenshot(
                video_path,
                ss_time,
            )
        wait_for_stable_file(assets.screenshot_path)

    if _field_is_active("video_field") and vad_result:
        # Store video parameters for deferred generation in background thread
        logger.info("Video for Anki will be generated in background...")
        assets.pending_video = True
        assets.video_params = {
            'video_path': video_path,
            'start_time': start_time,
            'vad_start': vad_result.start,
            'vad_end': vad_result.end
        }

    if _field_is_active("previous_image_field") and game_line and game_line.prev:
        if anki_results.get(game_line.prev.id):
            assets.prev_screenshot_in_anki = anki_results.get(game_line.prev.id).screenshot_in_anki
        else:
            # Get raw PNG for previous screenshot (fast preview)
            line_for_prev_ss = selected_lines[0].prev if selected_lines else game_line.prev
            assets.prev_screenshot_timestamp = ffmpeg.get_screenshot_time(video_path, line_for_prev_ss)
            assets.prev_screenshot_path = ffmpeg.get_raw_screenshot(
                video_path,
                assets.prev_screenshot_timestamp,
            )
            wait_for_stable_file(assets.prev_screenshot_path)
                
    return assets


def _prepare_anki_note_fields(note: Dict, last_note: 'AnkiCard', assets: MediaAssets, game_line: 'GameLine') -> Dict:
    """Populates the fields of the Anki note dictionary."""
    config = get_config()

    if assets.video_in_anki:
        _apply_field_policy(note, last_note, "video_field", assets.video_in_anki, anki_cfg=config.anki)

    if assets.prev_screenshot_in_anki and config.anki.previous_image_field != config.anki.picture_field:
        _apply_field_policy(
            note,
            last_note,
            "previous_image_field",
            f"<img src=\"{assets.prev_screenshot_in_anki}\">",
            anki_cfg=config.anki,
        )

    if _field_is_active("game_name_field"):
        _apply_field_policy(note, last_note, "game_name_field", get_current_game(), anki_cfg=config.anki)
        
    return note


def _resolve_sentence_for_translation(note: Dict, last_note: 'AnkiCard') -> str:
    config = get_config()
    sentence_to_translate = note['fields'].get(config.anki.sentence_field, '')
    if sentence_to_translate:
        return sentence_to_translate
    if last_note:
        return last_note.get_field(config.anki.sentence_field)
    return ''


def prefetch_ai_translation(sentence_to_translate: str, game_line: 'GameLine') -> str:
    if not sentence_to_translate:
        return ''
    try:
        translation = get_ai_prompt_result(get_all_lines(), sentence_to_translate, game_line, get_current_game()) or ''
        logger.info(f"AI prompt Result: {translation}")
        return translation
    except Exception as e:
        logger.exception(f"Failed to prefetch AI translation: {e}")
        return ''


def prefetch_media_assets_for_card(
    game_line: 'GameLine',
    video_path: str,
    ss_time: float,
    selected_lines: Optional[List['GameLine']],
) -> MediaAssets:
    return _generate_media_files(
        reuse_audio=False,
        game_line=game_line,
        video_path=video_path,
        ss_time=ss_time,
        start_time=0,
        vad_result=None,
        selected_lines=selected_lines or [],
    )


def _synchronize_deferred_media_metadata(
    assets: MediaAssets,
    video_path: str,
    start_time: float,
    vad_result: Any,
):
    if not assets:
        return

    config = get_config()
    if video_path:
        assets.source_video_path = video_path

    if assets.pending_animated:
        assets.animated_video_path = video_path
        assets.animated_start_time = start_time or 0.0
        if vad_result:
            assets.animated_vad_start = vad_result.start
            assets.animated_vad_end = vad_result.end

    if _field_is_active("video_field") and vad_result:
        assets.pending_video = True
        assets.video_params = {
            'video_path': video_path,
            'start_time': start_time,
            'vad_start': vad_result.start,
            'vad_end': vad_result.end,
        }


def _start_animated_screenshot_prefetch(assets: MediaAssets, config):
    """Start generating animated screenshot while confirmation dialog is open."""
    if not assets or not assets.pending_animated:
        return
    if assets.animated_prefetch_event is not None:
        return

    assets.animated_prefetch_event = threading.Event()

    def _prefetch():
        try:
            logger.info("Prefetching animated screenshot while confirmation is open...")
            settings = config.screenshot.animated_settings
            path = ffmpeg.get_anki_compatible_video(
                assets.animated_video_path,
                assets.animated_start_time,
                assets.animated_vad_start,
                assets.animated_vad_end,
                codec=settings.extension,
                quality=settings.scaled_quality,
                fps=settings.fps,
                audio=False
            )
            if path and os.path.exists(path):
                wait_for_stable_file(path)
                assets.animated_prefetch_path = path
                logger.info(f"Animated screenshot prefetch ready: {path}")
            else:
                logger.warning("Animated screenshot prefetch did not produce a valid file.")
        except Exception as e:
            logger.exception(f"Error prefetching animated screenshot: {e}")
        finally:
            assets.animated_prefetch_event.set()

    run_new_thread(_prefetch)


def _get_prefetched_animated_screenshot_path(assets: MediaAssets) -> str:
    if not assets or not assets.animated_prefetch_event:
        return ''
    if not assets.animated_prefetch_event.is_set():
        logger.info("Waiting for animated screenshot prefetch to complete...")
        assets.animated_prefetch_event.wait()
    path = assets.animated_prefetch_path
    if path and os.path.exists(path):
        return path
    return ''


def _prepare_anki_tags() -> List[str]:
    """Generates a list of tags to be added to the Anki note."""
    config = get_config()
    tags = []
    if config.anki.add_game_tag:
        game = get_current_game().replace(" ", "").replace("::", "")
        if config.anki.parent_tag:
            game = f"{config.anki.parent_tag}::{game}"
        tags.append(game)
    if config.anki.custom_tags:
        tags.extend(config.anki.custom_tags)
    return tags


def _handle_file_management(
    tango: str,
    reuse_audio: bool,
    game_line: 'GameLine',
    assets: MediaAssets,
    video_path: str,
    start_time: float,
    end_time: float,
    reuse_result_id: Optional[str] = None,
):
    """Copies temporary media files to the final output folder if configured."""
    config = get_config()
    if not config.paths.output_folder or not (config.paths.copy_temp_files_to_output_folder):
        return None
        
    date_path = os.path.join(config.paths.output_folder, time.strftime("%Y-%m"), time.strftime("%d"))
    word_path = os.path.join(date_path, sanitize_filename(tango))
    os.makedirs(word_path, exist_ok=True)
    
    if reuse_audio:
        # If reusing, copy all files from the original word's folder
        result_id = reuse_result_id or (game_line.id if game_line else None)
        if not result_id or result_id not in anki_results:
            logger.warning("Requested reuse audio, but no cached Anki result found for file management.")
            return None
        anki_result: 'AnkiUpdateResult' = anki_results[result_id]
        previous_word_path = anki_result.word_path
        if previous_word_path and os.path.exists(previous_word_path):
            shutil.copytree(previous_word_path, word_path, dirs_exist_ok=True)
    elif config.paths.copy_temp_files_to_output_folder:
        # If creating new, copy generated files to the new word's folder
        if assets.audio_path and os.path.exists(assets.audio_path):
            assets.final_audio_path = shutil.copy(assets.audio_path, word_path)
        if assets.screenshot_path and os.path.exists(assets.screenshot_path):
            assets.final_screenshot_path = shutil.copy(assets.screenshot_path, word_path)
        if assets.prev_screenshot_path and os.path.exists(assets.prev_screenshot_path):
            dest_name = "prev_" + Path(assets.prev_screenshot_path).name
            assets.final_prev_screenshot_path = shutil.copy(assets.prev_screenshot_path, os.path.join(word_path, dest_name))
        if assets.video_path and os.path.exists(assets.video_path):
            assets.final_video_path = shutil.copy(assets.video_path, word_path)
        elif video_path and config.paths.copy_trimmed_replay_to_output_folder and os.path.exists(video_path):
            try:
                trimmed_video = ffmpeg.trim_replay_for_gameline(video_path, start_time, end_time, accurate=True)
                if os.path.exists(trimmed_video):
                    assets.final_video_path = shutil.copy(trimmed_video, word_path)
            except Exception as e:
                logger.error(f"Failed to trim replay video: {e}")

    # Open folder if configured
    if config.paths.open_output_folder_on_card_creation:
        try:
            if platform.system() == "Windows":
                os.startfile(word_path)
            elif platform.system() == "Darwin":
                subprocess.Popen(["open", word_path])
            else:
                subprocess.Popen(["xdg-open", word_path])
        except Exception as e:
            logger.error(f"Error opening output folder: {e}")
            
    # Return word_path for storing in AnkiUpdateResult
    return word_path


def update_anki_card(
    last_note: 'AnkiCard',
    note=None,
    audio_path='',
    video_path='',
    tango='',
    use_existing_files=False,
    should_update_audio=True,
    ss_time=0,
    game_line=None,
    selected_lines=None,
    prev_ss_timing=0,
    start_time=None,
    end_time=None,
    vad_result=None,
    reuse_result_id: Optional[str] = None,
    precomputed_assets: Optional[MediaAssets] = None,
    precomputed_translation: Optional[str] = None,
):
    """
    Main function to handle the entire process of updating an Anki card with new media and data.
    """
    config = get_config()
    selected_lines = selected_lines or []
    
    # 1. Decide what to update based on config and existing note state
    update_audio_flag, update_picture_flag = _determine_update_conditions(last_note)
    update_audio_flag = bool(update_audio_flag and should_update_audio)
    
    # 2. Generate or retrieve all necessary media files
    assets = precomputed_assets or _generate_media_files(
        use_existing_files,
        game_line,
        video_path,
        ss_time,
        start_time,
        vad_result,
        selected_lines,
        reuse_result_id=reuse_result_id,
    )
    _synchronize_deferred_media_metadata(assets, video_path, start_time, vad_result)
    assets.audio_path = audio_path  # Assign the passed audio path
    
    # 3. Prepare the basic structure of the Anki note and its tags
    note = note or {'id': last_note.noteId, 'fields': {}}
    note = _prepare_anki_note_fields(note, last_note, assets, game_line)

    translation = ''
    if config.ai.add_to_anki:
        if precomputed_translation is None:
            sentence_to_translate = _resolve_sentence_for_translation(note, last_note)
            translation = prefetch_ai_translation(sentence_to_translate, game_line)
        else:
            translation = precomputed_translation

        if game_line is not None:
            game_line.TL = translation
        if config.ai.anki_field:
            note['fields'][config.ai.anki_field] = translation
    elif game_line and hasattr(game_line, 'TL'):
        translation = game_line.TL

    tags = _prepare_anki_tags()
    
    # 4. (Optional) Show confirmation dialog to the user, which may alter media
    use_voice = update_audio_flag or assets.audio_in_anki
    if config.anki.show_update_confirmation_dialog_v2 and not use_existing_files:
        _start_animated_screenshot_prefetch(assets, config)
        from GameSentenceMiner.ui.qt_main import launch_anki_confirmation
        sentence = note['fields'].get(config.anki.sentence_field, last_note.get_field(config.anki.sentence_field))
        
        # Determine which audio path to pass to the dialog
        # If VAD failed but we have trimmed audio, pass that so user can choose to keep it
        dialog_audio_path = None
        if update_audio_flag:
            if assets.audio_path and os.path.isfile(assets.audio_path):
                dialog_audio_path = assets.audio_path
            elif vad_result and hasattr(vad_result, 'trimmed_audio_path') and vad_result.trimmed_audio_path and os.path.isfile(vad_result.trimmed_audio_path):
                # VAD failed but we have trimmed audio - offer it to the user
                dialog_audio_path = vad_result.trimmed_audio_path
                logger.info(f"VAD did not find voice, but offering trimmed audio to user: {dialog_audio_path}")
        
        gsm_state.vad_result = vad_result  # Pass VAD result to dialog if needed
        previous_ss_time = ffmpeg.get_screenshot_time(video_path, game_line.prev if game_line else None) if _field_is_active("previous_image_field") else 0
        result = launch_anki_confirmation(
            tango, sentence, assets.screenshot_path, assets.prev_screenshot_path, dialog_audio_path, translation, ss_time, previous_ss_time, assets.pending_animated
        )
        
        if result is None:
            # Dialog was cancelled
            logger.info("Anki confirmation dialog was cancelled")
            return False
        
        use_voice, sentence, translation, new_ss_path, new_prev_ss_path, add_nsfw_tag, new_audio_path = result
        _apply_field_policy(note, last_note, "sentence_field", sentence)
        if config.ai.add_to_anki and config.ai.anki_field:
            note['fields'][config.ai.anki_field] = translation
        assets.screenshot_path = new_ss_path or assets.screenshot_path
        assets.prev_screenshot_path = new_prev_ss_path or assets.prev_screenshot_path
        # Update audio path if TTS was generated in the dialog
        if new_audio_path:
            assets.audio_path = new_audio_path
        
        # Add NSFW tag if checkbox was selected
        if add_nsfw_tag:
            assets.extra_tags.append("NSFW")
            
    # 5. Prepare tags
    for extra_tag in assets.extra_tags:
        tags.append(extra_tag)
        
    # All media uploading will be handled in the background thread after processing
    # This ensures proper timing and avoids uploading raw/unprocessed media

    # 6. Asynchronously update the note in Anki (media upload now happens in the same thread)
    # Keep the replay until the background media thread completes. Even static screenshot
    # paths can still probe the source video later (e.g. black-bar detection during re-encode).
    if video_path:
        # Mark video as having pending operations so replay_handler won't delete it early.
        gsm_state.videos_with_pending_operations.add(video_path)

        def cleanup_video():
            if get_config().paths.remove_video and os.path.exists(video_path):
                try:
                    logger.debug(f"Removing source video after background processing: {video_path}")
                    os.remove(video_path)
                except Exception as e:
                    logger.exception(f"Error removing video file {video_path}: {e}")
            # Remove from pending operations set
            gsm_state.videos_with_pending_operations.discard(video_path)

        assets.cleanup_callback = cleanup_video
        
    def add_note_to_result(assets: MediaAssets):
        reuse_key = _build_sentence_audio_key(game_line, selected_lines)
        cache_line_id = reuse_result_id if use_existing_files and reuse_result_id else (game_line.id if game_line else None)
        _set_sentence_audio_cache_entry(reuse_key, cache_line_id, tango)

        # 7. Handle post-creation file management (copying to output folder)
        try:
            word_path = _handle_file_management(
                tango,
                use_existing_files,
                game_line,
                assets,
                video_path,
                start_time,
                end_time,
                reuse_result_id=reuse_result_id,
            )
        except Exception as e:
            logger.exception(f"Files Failed to Copy to Output Folder: {e}")
            word_path = None

        # 9. Update the local application database with final paths
        anki_audio_path = os.path.join(config.audio.anki_media_collection, assets.audio_in_anki) if assets.audio_in_anki else ''
        anki_screenshot_path = os.path.join(config.audio.anki_media_collection, assets.screenshot_in_anki) if assets.screenshot_in_anki else ''
        
        live_stats_tracker.add_mined_line()
        GameLinesTable.update(
            line_id=game_line.id, 
            screenshot_path=assets.final_screenshot_path, 
            audio_path=assets.final_audio_path, 
            replay_path=assets.final_video_path, 
            audio_in_anki=anki_audio_path, 
            screenshot_in_anki=anki_screenshot_path, 
            translation=translation,
            note_id=str(last_note.noteId)
        )
        
        if not use_existing_files:
            anki_results[game_line.id] = AnkiUpdateResult(
                success=True,
                audio_in_anki=assets.audio_in_anki,
                screenshot_in_anki=assets.screenshot_in_anki,
                prev_screenshot_in_anki=assets.prev_screenshot_in_anki,
                sentence_in_anki=game_line.text if game_line else '',
                multi_line=bool(selected_lines and len(selected_lines) > 1),
                video_in_anki=assets.video_in_anki or '',
                word_path=word_path,
                word=tango,
                extra_tags=assets.extra_tags
        )
    
    run_new_thread(lambda: check_and_update_note(last_note, note, tags, assets, use_voice, update_picture_flag, use_existing_files, add_note_to_result, processing_word=tango))
    return True
    
def _encode_and_replace_raw_image(path, source_video_path: str = '', screenshot_timing: float = 0.0):
    if not path:
        return path
    
    # Check if this is a raw PNG that needs encoding
    is_raw = ('_raw' in path and path.endswith('.png')) or 'frame_' in path
    if not is_raw:
        return path
        
    logger.info("Encoding screenshot with user settings...")
    try:
        encoded_path = ffmpeg.encode_screenshot(
            path,
            source_video_path=source_video_path,
            screenshot_timing=screenshot_timing,
        )
        if os.path.exists(path):
            try:
                os.remove(path)
            except Exception as e:
                logger.warning(f"Could not remove raw screenshot: {e}")
        logger.info(f"Screenshot encoded: {encoded_path}")
        return encoded_path
    except Exception as e:
        logger.error(f"Failed to encode screenshot: {e}")
        return path

def _process_screenshot(
    assets: MediaAssets,
    note: dict,
    config,
    update_picture_flag: bool,
    use_existing_files: bool,
    last_note: Optional['AnkiCard'] = None,
):
    if not assets:
        return
    
    # If reusing existing files, just add the field to the note
    if use_existing_files:
        if assets.screenshot_in_anki and update_picture_flag:
            _apply_field_policy(
                note,
                last_note,
                "picture_field",
                f"<img src=\"{assets.screenshot_in_anki}\">",
                anki_cfg=config.anki,
            )
        return

    # In animated mode, the static screenshot is only a placeholder for confirmation.
    # Do not upload it to Anki to avoid storing both static and animated media.
    if assets.pending_animated:
        logger.debug("Skipping static screenshot upload because animated screenshot is pending.")
        return
    
    if not assets.screenshot_path:
        return

    assets.screenshot_path = _encode_and_replace_raw_image(
        assets.screenshot_path,
        source_video_path=assets.source_video_path,
        screenshot_timing=assets.screenshot_timestamp,
    )
    
    if assets.screenshot_path and not assets.screenshot_in_anki:
        logger.info("Uploading encoded screenshot to Anki...")
        assets.screenshot_in_anki = store_media_file(assets.screenshot_path)
        logger.info(f"Stored screenshot in Anki media collection: {assets.screenshot_in_anki}")
        
        if update_picture_flag and assets.screenshot_in_anki:
            _apply_field_policy(
                note,
                last_note,
                "picture_field",
                f"<img src=\"{assets.screenshot_in_anki}\">",
                anki_cfg=config.anki,
            )

def _process_previous_screenshot(
    assets: MediaAssets,
    note: dict,
    config,
    use_existing_files: bool,
    last_note: Optional['AnkiCard'] = None,
):
    if not assets or not assets.prev_screenshot_path or use_existing_files:
        return

    assets.prev_screenshot_path = _encode_and_replace_raw_image(
        assets.prev_screenshot_path,
        source_video_path=assets.source_video_path,
        screenshot_timing=assets.prev_screenshot_timestamp,
    )
    
    if assets.prev_screenshot_path and not assets.prev_screenshot_in_anki:
        logger.info("Uploading encoded previous screenshot to Anki...")
        assets.prev_screenshot_in_anki = store_media_file(assets.prev_screenshot_path)
        logger.info(f"Stored previous screenshot in Anki media collection: {assets.prev_screenshot_in_anki}")
        
        if assets.prev_screenshot_in_anki and config.anki.previous_image_field != config.anki.picture_field:
            _apply_field_policy(
                note,
                last_note,
                "previous_image_field",
                f"<img src=\"{assets.prev_screenshot_in_anki}\">",
                anki_cfg=config.anki,
            )

def _process_animated_screenshot(
    assets: MediaAssets,
    note: dict,
    config,
    update_picture_flag: bool,
    use_existing_files: bool,
    last_note: Optional['AnkiCard'] = None,
):
    if not assets or not assets.pending_animated or use_existing_files:
        return
        
    try:
        path = _get_prefetched_animated_screenshot_path(assets)
        if path:
            logger.info(f"Using prefetched animated screenshot: {path}")
        else:
            logger.info("Generating animated screenshot...")
            settings = config.screenshot.animated_settings
            
            path = ffmpeg.get_anki_compatible_video(
                assets.animated_video_path,
                assets.animated_start_time,
                assets.animated_vad_start,
                assets.animated_vad_end,
                codec=settings.extension,
                quality=settings.scaled_quality,
                fps=settings.fps,
                audio=False
            )
        
        if path and os.path.exists(path):
            wait_for_stable_file(path)
            logger.info(f"Animated screenshot generated: {path}")
            
            assets.screenshot_in_anki = store_media_file(path)
            logger.info(f"<bold>Stored animated screenshot in Anki: {assets.screenshot_in_anki}</bold>")
            
            if update_picture_flag and assets.screenshot_in_anki:
                _apply_field_policy(
                    note,
                    last_note,
                    "picture_field",
                    f"<img src=\"{assets.screenshot_in_anki}\">",
                    anki_cfg=config.anki,
                )
            
            if assets.screenshot_path and os.path.exists(assets.screenshot_path) and config.paths.remove_screenshot:
                try:
                    os.remove(assets.screenshot_path)
                    logger.debug(f"Removed temporary static screenshot: {assets.screenshot_path}")
                except Exception as e:
                    logger.warning(f"Failed to remove temporary screenshot: {e}")
            
            assets.screenshot_path = path
            assets.pending_animated = False
            assets.animated = True
        else:
            logger.error("Failed to generate animated screenshot")
    except Exception as e:
        logger.exception(f"Error generating animated screenshot: {e}")

def _process_video(
    assets: MediaAssets,
    note: dict,
    config,
    use_existing_files: bool,
    last_note: Optional['AnkiCard'] = None,
):
    if not assets or not assets.pending_video or use_existing_files:
        return

    try:
        logger.info("Generating video for Anki...")
        settings = config.screenshot.animated_settings
        
        path = ffmpeg.get_anki_compatible_video(
            assets.video_params['video_path'],
            assets.video_params['start_time'],
            assets.video_params['vad_start'],
            assets.video_params['vad_end'],
            codec=settings.extension,
            quality=settings.scaled_quality,
            fps=settings.fps,
            audio=True
        )
        
        if path and os.path.exists(path):
            logger.info(f"Video generated: {path}")
            assets.video_path = path
            
            assets.video_in_anki = store_media_file(path)
            logger.info(f"Stored video in Anki: {assets.video_in_anki}")
            
            if assets.video_in_anki:
                _apply_field_policy(note, last_note, "video_field", assets.video_in_anki, anki_cfg=config.anki)
            
            assets.pending_video = False
            assets.video = True
        else:
            logger.error("Failed to generate video")
    except Exception as e:
        logger.exception(f"Error generating video: {e}")

def _process_audio(
    assets: MediaAssets,
    note: dict,
    config,
    use_voice: bool,
    use_existing_files: bool,
    last_note: Optional['AnkiCard'] = None,
):
    if not assets or not use_voice:
        return
    
    # If reusing existing files, just add the field to the note
    if use_existing_files:
        if assets.audio_in_anki:
            _apply_field_policy(
                note,
                last_note,
                "sentence_audio_field",
                f"[sound:{assets.audio_in_anki}]",
                anki_cfg=config.anki,
            )
            
            if config.audio.external_tool and config.audio.external_tool_enabled:
                anki_media_path = os.path.join(config.audio.anki_media_collection, assets.audio_in_anki)
                open_audio_in_external(anki_media_path)
        return
    
    if not assets.audio_path or assets.audio_in_anki:
        return

    logger.info(f"Uploading audio to Anki: {assets.audio_path}...")
    assets.audio_in_anki = store_media_file(assets.audio_path)
    logger.info(f"Stored audio in Anki media collection: {assets.audio_in_anki}")
    
    if assets.audio_in_anki:
        _apply_field_policy(
            note,
            last_note,
            "sentence_audio_field",
            f"[sound:{assets.audio_in_anki}]",
            anki_cfg=config.anki,
        )
        
        if config.audio.external_tool and config.audio.external_tool_enabled:
            anki_media_path = os.path.join(config.audio.anki_media_collection, assets.audio_in_anki)
            open_audio_in_external(anki_media_path)

def _update_anki_note(last_note: AnkiCard, note: dict, tags: list, assets: MediaAssets = None):
    config = get_config()
    selected_notes = invoke("guiSelectedNotes")
    if last_note.noteId in selected_notes:
        notification.open_browser_window(1)
        
    for field in note['fields']:
        if note['fields'][field] is None:
            note['fields'][field] = ''
            
    invoke("updateNoteFields", note=note)
    
    if not assets.audio_in_anki and config.anki.tag_unvoiced_cards:
        tags.append("unvoiced")
    
    if tags:
        invoke("addTags", tags=" ".join(tags), notes=[last_note.noteId])

    # Build detailed success log
    media_info = []
    if assets:
        if assets.audio_in_anki:
            media_info.append("🎵 audio")
        if assets.screenshot_in_anki:
            media_type = "animated" if assets.animated or '.webm' in assets.screenshot_in_anki or '.gif' in assets.screenshot_in_anki else "static"
            media_info.append(f"📸 {media_type} screenshot")
        if assets.prev_screenshot_in_anki:
            media_info.append("📷 prev screenshot")
        if assets.video_in_anki:
            media_info.append("🎬 video")
    
    media_str = f" [{', '.join(media_info)}]" if media_info else ""
    tags_str = f" +tags: {', '.join(tags)}" if tags else ""
    logger.success(f"UPDATED ANKI CARD {last_note.noteId}{media_str}{tags_str}")
    return selected_notes

def _perform_post_update_actions(last_note: AnkiCard, selected_notes, config):
    if last_note.noteId in selected_notes or config.features.open_anki_in_browser:
        notification.open_browser_window(last_note.noteId, config.features.browser_query)
        
    if config.features.open_anki_edit:
        notification.open_anki_card(last_note.noteId)
        
    if config.features.notify_on_update:
        notification.send_note_updated(last_note.noteId)

def _cleanup_assets(assets: MediaAssets):
    if assets and assets.cleanup_callback:
        try:
            logger.debug("Calling cleanup callback after background processing complete")
            assets.cleanup_callback()
        except Exception as e:
            logger.exception(f"Error in cleanup callback: {e}")

def check_and_update_note(last_note, note, tags=[], assets:MediaAssets=None, use_voice=False, update_picture_flag=False, use_existing_files=False, assets_ready_callback=None, processing_word: str = ""):
    """Update note in Anki, including uploading media files."""
    config = get_config()
    if not processing_word and last_note:
        try:
            processing_word = last_note.get_field(config.anki.word_field)
        except Exception:
            processing_word = ""
    try:
        if assets:
            _process_screenshot(assets, note, config, update_picture_flag, use_existing_files, last_note=last_note)
            _process_previous_screenshot(assets, note, config, use_existing_files, last_note=last_note)
            _process_animated_screenshot(assets, note, config, update_picture_flag, use_existing_files, last_note=last_note)
            _process_video(assets, note, config, use_existing_files, last_note=last_note)
            _process_audio(assets, note, config, use_voice, use_existing_files, last_note=last_note)
        
        if assets_ready_callback:
            assets_ready_callback(assets)
            
        selected_notes = _update_anki_note(last_note, note, tags, assets)
        _perform_post_update_actions(last_note, selected_notes, config)
    finally:
        _cleanup_assets(assets)
        if processing_word:
            gsm_status.remove_word_being_processed(processing_word)


def add_image_to_card(last_note: AnkiCard, image_path):
    global screenshot_in_anki
    update_picture = _field_should_write(last_note, "picture_field")

    # Create a MediaAssets object for just the screenshot
    assets = MediaAssets()
    if update_picture:
        assets.screenshot_path = image_path

    note = {'id': last_note.noteId, 'fields': {}}

    # Media upload and field update will happen in check_and_update_note
    run_new_thread(lambda: check_and_update_note(last_note, note, tags=[], assets=assets, use_voice=False, update_picture_flag=update_picture, use_existing_files=False))

    logger.info(f"UPDATED IMAGE FOR ANKI CARD {last_note.noteId}")
    
    
    
# Go through every field in the note and fix whitespace issues
# the issues being, a ton of new lines randomly, nothing else
# Handlebars problem, should be fixed but keeping this just in case
def fix_overlay_whitespace(last_note: AnkiCard, note, lines=None):
    for field in last_note.fields:
        if not last_note.fields[field]:
            continue
        text = last_note.get_field(field)
        # Count occurrences of excessive whitespace patterns using regex
        whitespace_patterns = [
            r'(\r?\n){3,}',      # 3 or more consecutive newlines
            r'(\r){3,}',         # 3 or more consecutive carriage returns
            r'(\n\r\n){2,}',     # 2 or more consecutive \n\r\n
            r'(\r\n\r){2,}',     # 2 or more consecutive \r\n\r
            r'(<br>\s*){3,}'     # 3 or more consecutive <br>
        ]
        for pattern in whitespace_patterns:
            if re.search(pattern, text):
                fixed_text = re.sub(pattern, '', text)
                note['fields'][field] = fixed_text
                last_note.fields[field].value = fixed_text
                break
    return note, last_note


def _preserve_html_tags_for_furigana(source_sentence: str, furigana_text: str) -> str:
    """
    Preserve HTML tags from source_sentence while keeping mecab furigana bracket blocks intact.
    """
    if not furigana_text:
        return furigana_text

    tokens: List[str] = []
    idx = 0
    while idx < len(furigana_text):
        ch = furigana_text[idx]
        token = ch
        if idx + 1 < len(furigana_text) and furigana_text[idx + 1] == "[":
            closing = furigana_text.find("]", idx + 1)
            if closing != -1:
                token = furigana_text[idx:closing + 1]
                idx = closing + 1
            else:
                idx += 1
        else:
            idx += 1
        tokens.append(token)

    base_text = "".join(token[0] for token in tokens if token)
    tagged_base = preserve_html_tags(source_sentence, base_text)

    rebuilt: List[str] = []
    token_idx = 0
    pos = 0
    while pos < len(tagged_base):
        if tagged_base[pos] == "<":
            tag_end = tagged_base.find(">", pos)
            if tag_end == -1:
                rebuilt.append(tagged_base[pos:])
                break
            rebuilt.append(tagged_base[pos:tag_end + 1])
            pos = tag_end + 1
            continue

        if token_idx < len(tokens):
            rebuilt.append(tokens[token_idx])
            token_idx += 1
        else:
            rebuilt.append(tagged_base[pos])
        pos += 1

    return "".join(rebuilt)


def get_initial_card_info(last_note: AnkiCard, selected_lines, game_line: GameLine):
    note = {'id': last_note.noteId, 'fields': {}}
    if not last_note:
        return note, last_note
    note, last_note = fix_overlay_whitespace(last_note, note, selected_lines)
    if not game_line:
        game_line = get_text_event(last_note)
    sentences = []
    sentences_text = ''

    if game_line.source != TextSource.HOTKEY and _field_should_write(last_note, "sentence_field", note):
        sentence_in_anki = last_note.get_field(get_config().anki.sentence_field).replace("\n", "").replace("\r", "").strip()
        sentence_cfg = _get_anki_field_config("sentence_field")

        if sentence_cfg.append:
            updated_sentence = game_line.text
        elif sentence_in_anki:
            logger.info("Found matching line in Anki, preserving sentence HTML and spacing.")
            updated_sentence = preserve_html_tags(sentence_in_anki, game_line.text)
        else:
            updated_sentence = game_line.text

        wrote_sentence = _apply_field_policy(
            note,
            last_note,
            "sentence_field",
            updated_sentence,
            append_separator=get_config().advanced.multi_line_line_break,
        )
        if wrote_sentence:
            logger.info(f"Prepared sentence field update: {get_config().anki.sentence_field}")

        if wrote_sentence and _field_is_active("sentence_furigana_field") and get_config().general.target_language == CommonLanguages.JAPANESE.value:
            try:
                furigana = mecab.reading(updated_sentence)
                furigana_html = _preserve_html_tags_for_furigana(updated_sentence, furigana)
                _apply_field_policy(
                    note,
                    last_note,
                    "sentence_furigana_field",
                    furigana_html,
                    append_separator=get_config().advanced.multi_line_line_break,
                )
                logger.info(f"Added furigana to {get_config().anki.sentence_furigana_field}: {furigana_html}")
            except Exception as e:
                logger.warning(f"Failed to generate furigana: {e}")
                
    if selected_lines:
        try:
            sentence_in_anki = last_note.get_field(get_config().anki.sentence_field)
            logger.info(f"Attempting Preserve HTML for multi-line")
            for line in selected_lines:
                if lines_match(line.text, remove_html_and_cloze_tags(sentence_in_anki)):
                    sentences.append(sentence_in_anki)
                    logger.info("Found matching line in Anki, Preserving HTML!")
                else:
                    sentences.append(line.text)

            logger.debug(f"Attempting to Fix Character Dialogue Format")
            logger.debug([f"{line}" for line in sentences])
            try:
                combined_lines = combine_dialogue(sentences)
                logger.debug(combined_lines)
                if combined_lines:
                    sentences_text = "".join(combined_lines)
            except Exception as e:
                logger.debug(f'Error combining dialogue: {e}, defaulting')
                pass
        except Exception as e:
            logger.debug(f"Error preserving HTML for multi-line: {e}")
            pass
        multi_line_sentence = sentences_text if sentences_text else get_config().advanced.multi_line_line_break.join(sentences)
        _apply_field_policy(
            note,
            last_note,
            "sentence_field",
            multi_line_sentence,
            append_separator=get_config().advanced.multi_line_line_break,
        )
        
        # Add furigana for multi-line sentences
        if _field_is_active("sentence_furigana_field") and get_config().general.target_language == 'ja':
            try:
                furigana = mecab.reading(multi_line_sentence)
                furigana_html = _preserve_html_tags_for_furigana(multi_line_sentence, furigana)
                _apply_field_policy(
                    note,
                    last_note,
                    "sentence_furigana_field",
                    furigana_html,
                    append_separator=get_config().advanced.multi_line_line_break,
                )
                logger.info(f"Added furigana to {get_config().anki.sentence_furigana_field}: {furigana_html}")
            except Exception as e:
                logger.warning(f"Failed to generate furigana for multi-line: {e}")

    if _field_is_active("previous_sentence_field") and game_line.prev:
        previous_sentence_text = selected_lines[0].prev.text if selected_lines and selected_lines[0].prev else game_line.prev.text
        _apply_field_policy(
            note,
            last_note,
            "previous_sentence_field",
            previous_sentence_text,
            append_separator=get_config().advanced.multi_line_line_break,
        )
    return note, last_note


def store_media_file(path, retries=5):
    """Store media file in Anki with retry logic.
    
    Args:
        path: Path to the media file
        retries: Number of retries (default 5)
    """
    try:
        path_obj = Path(path)
        original_filename = path_obj.name
        sanitized_filename = sanitize_filename(original_filename)
        
        if original_filename != sanitized_filename:
            new_path = path_obj.parent / sanitized_filename
            logger.warning(f"File contains unsafe characters. Reading and rewriting '{original_filename}' to '{sanitized_filename}', Report this in Discord/Github Please!")
            
            try:
                with open(path, 'rb') as src_file:
                    file_content = src_file.read()
                with open(new_path, 'wb') as dst_file:
                    dst_file.write(file_content)
                try:
                    os.remove(path)
                except Exception as remove_error:
                    logger.debug(f"Could not remove original file with invalid name: {remove_error}")
                path = str(new_path)
                logger.info(f"Successfully created sanitized file: {sanitized_filename}")
            except Exception as rewrite_error:
                logger.exception(f"Failed to read/write file to sanitized path: {rewrite_error}. Attempting upload with original path.")
        
        return invoke('storeMediaFile', filename=path, data=convert_to_base64(path), retries=retries, timeout=60)
    except Exception as e:
        logger.error(f"Error storing media file after retries, check anki card for blank media fields: {e}")
        return None


def convert_to_base64(file_path):
    with open(file_path, "rb") as file:
        file_base64 = base64.b64encode(file.read()).decode('utf-8')
    return file_base64


def request(action, **params):
    return {'action': action, 'params': params, 'version': 6}


def invoke(action, retries: int = 0, timeout=10, **params):
    payload = request(action, **params)
    url = get_config().anki.url
    headers = {"Content-Type": "application/json"}

    if action in ["updateNoteFields"]:
        logger.debug(f"Hitting Anki. Action: {action}. Data: {json.dumps(payload)}")

    attempt = 0
    backoff = 0.5
    max_backoff = 5.0
    while True:
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
            resp.raise_for_status()
            response = resp.json()

            if not isinstance(response, dict) or len(response.keys()) != 2:
                logger.error(f"Unexpected response from Anki: {response}")
                raise Exception('response has an unexpected number of fields')
            if 'error' not in response:
                logger.error(f"Unexpected response from Anki: {response}")
                raise Exception('response is missing required error field')
            if 'result' not in response:
                logger.error(f"Unexpected response from Anki: {response}")
                raise Exception('response is missing required result field')
            if response['error'] is not None:
                logger.error(f"Anki returned an error: {response['error']}")
                raise Exception(response['error'])
            return response['result']
        except Exception as e:
            # If no retries requested, raise immediately
            if retries <= 0 or attempt >= retries:
                logger.error(f"Anki request failed (action={action}): {e}")
                raise

            # Exponential backoff: 2^attempt seconds, capped at max_backoff
            backoff = min((backoff * 2), max_backoff)
            attempt += 1
            logger.warning(f"Anki request failed, retrying in {backoff}s (attempt {attempt}/{retries})... Error: {e}")
            time.sleep(backoff)


def get_last_anki_card() -> AnkiCard | dict:
    added_ids = invoke('findNotes', query='added:1')
    if not added_ids:
        return {}

    card_dict = invoke('notesInfo', notes=[added_ids[-1]])[0]
    try:
        return AnkiCard.from_dict(card_dict)
    except Exception as e:
        logger.error(f"Error fetching last card: {e}")
        logger.info(card_dict)
        raise e


def add_wildcards(expression):
    return '*' + '*'.join(expression) + '*'


def get_cards_by_sentence(sentence):
    sentence = sentence.replace(" ", "")
    query = f'{get_config().anki.sentence_audio_field}: {get_config().anki.sentence_field}:{add_wildcards(sentence)}'
    card_ids = invoke("findCards", query=query)

    if not card_ids:
        logger.warning(f"Didn't find any cards matching query:\n{query}")
        return {}
    if len(card_ids) > 1:
        logger.warning(f'Found more than 1, and not updating cards for query: \n{query}')
        return {}

    card_dict = invoke('notesInfo', notes=[card_ids[-1]])[0]
    try:
        return AnkiCard.from_dict(card_dict)
    except Exception as e:
        logger.error(f"Error fetching last card: {e}")
        logger.info(card_dict)
        raise e

last_connection_error = datetime.now()
errors_shown = 0
final_warning_shown = False

# Check for new Anki cards and save replay buffer if detected
def check_for_new_cards():
    global previous_note_ids, first_run, last_connection_error, errors_shown, final_warning_shown
    current_note_ids = set()
    try:
        current_note_ids = get_note_ids()
        gsm_status.anki_connected = True
        errors_shown = 0
        final_warning_shown = False
    except Exception as e:
        gsm_status.anki_connected = False
        if datetime.now() - last_connection_error > timedelta(seconds=10):
            if final_warning_shown:
                return False
            if errors_shown >= 5:
                logger.warning("Too many errors fetching Anki notes. Suppressing further warnings.")
                final_warning_shown = True
                return False
            errors_shown += 1
            logger.warning("Error fetching Anki notes, Make sure Anki is running, ankiconnect add-on is installed, " +
                           f"and url/port is configured correctly in GSM Settings, This warning will be shown {5 - errors_shown} more times")
            last_connection_error = datetime.now()
        return False
    new_card_ids = current_note_ids - previous_note_ids
    if new_card_ids and not first_run:
        try:
            update_new_cards(new_card_ids)
        except Exception as e:
            logger.error("Error updating new card, Reason:", e)
    first_run = False
    previous_note_ids.update(new_card_ids)  # Update the list of known notes
    return True

def update_new_cards(new_card_ids):
    """Process multiple new cards by looping through each card ID."""
    # Get info for all new cards
    cards_info = invoke('notesInfo', notes=list(new_card_ids))
    
    for card_dict in cards_info:
        try:
            card = AnkiCard.from_dict(card_dict)
            update_single_card(card)
        except Exception as e:
            logger.error(f"Error processing card {card_dict.get('noteId', 'unknown')}: {e}")
            continue

def update_single_card(card):
    """Process a single card (extracted from update_new_card for reusability)."""
    if not card or not check_tags_for_should_update(card):
        return
    gsm_status.add_word_being_processed(card.get_field(get_config().anki.word_field))
    logger.debug(f"last mined line: {gsm_state.last_mined_line}, current sentence: {get_sentence(card)}")
    lines = texthooking_page.get_selected_lines()
    game_line = get_mined_line(card, lines)
    game_line.mined_time = datetime.now()
    current_word = card.get_field(get_config().anki.word_field) if card else ""
    reuse_key = _build_sentence_audio_key(game_line, lines)
    reuse_result_id = None
    use_prev_audio = False

    _prune_sentence_audio_cache()

    if reuse_key:
        cached_entry = sentence_audio_cache.get(reuse_key)
        if cached_entry:
            if cached_entry.word != current_word:
                use_prev_audio = True
                reuse_result_id = cached_entry.line_id
            else:
                logger.info("Same word detected for cached sentence, generating new audio.")
        elif game_line.id in anki_results:
            cached_result = anki_results[game_line.id]
            if cached_result.word != current_word:
                use_prev_audio = True
                reuse_result_id = game_line.id
                _set_sentence_audio_cache_entry(reuse_key, game_line.id, cached_result.word)
            else:
                logger.info("Same word detected for existing sentence, generating new audio.")
    elif game_line.id in anki_results:
        cached_result = anki_results[game_line.id]
        if cached_result.word != current_word:
            use_prev_audio = True
            reuse_result_id = game_line.id
    logger.info(f"New card using previous audio: {use_prev_audio}")
    if get_config().obs.get_game_from_scene:
        obs.update_current_game()
    if use_prev_audio:
        run_new_thread(lambda: update_card_from_same_sentence(
            card,
            lines=lines,
            game_line=game_line,
            reuse_result_id=reuse_result_id,
        ))
        texthooking_page.reset_checked_lines()
    else:
        logger.info("New card(s) detected! Added to Processing Queue!")
        gsm_state.last_mined_line = game_line
        queue_card_for_processing(card, lines, game_line)
        
def queue_card_for_processing(last_card, lines, last_mined_line):
    card_queue.append((last_card, datetime.now(), lines, last_mined_line))
    reuse_key = _build_sentence_audio_key(last_mined_line, lines)
    current_word = last_card.get_field(get_config().anki.word_field) if last_card else ""
    previous_entry = sentence_audio_cache.get(reuse_key) if reuse_key else None
    _set_sentence_audio_cache_entry(reuse_key, last_mined_line.id, current_word)
    texthooking_page.reset_checked_lines()
    try:
        obs.save_replay_buffer()
    except Exception as e:
        card_queue.pop(0)
        if reuse_key:
            if previous_entry:
                sentence_audio_cache[reuse_key] = previous_entry
            else:
                sentence_audio_cache.pop(reuse_key, None)
        logger.error(f"Error saving replay buffer: {e}")
        return

def update_card_from_same_sentence(last_card, lines, game_line, reuse_result_id: Optional[str] = None):
    reuse_key = _build_sentence_audio_key(game_line, lines)
    reuse_entry = sentence_audio_cache.get(reuse_key) if reuse_key else None
    reuse_result_id = reuse_result_id or (reuse_entry.line_id if reuse_entry else game_line.id)

    time_elapsed = 0
    while reuse_result_id not in anki_results:
        time.sleep(0.5)
        time_elapsed += 0.5
        if time_elapsed > 30 + get_config().anki.auto_accept_timer:
            logger.info(f"Timed out waiting for Anki update for card {last_card.noteId}, retrieving new audio")
            queue_card_for_processing(last_card, lines, game_line)
            return
    anki_result = anki_results[reuse_result_id]
    
    if anki_result.word == last_card.get_field(get_config().anki.word_field):
        logger.info(f"Same word detected, attempting to get new audio for card {last_card.noteId}")
        queue_card_for_processing(last_card, lines, game_line)
        return
    
    if anki_result.success:
        note, last_card = get_initial_card_info(last_card, lines, game_line)
        tango = last_card.get_field(get_config().anki.word_field)
        update_anki_card(last_card, note=note,
                         game_line=get_mined_line(last_card, lines), use_existing_files=True, tango=tango,
                         reuse_result_id=reuse_result_id)
    else:
        logger.error(f"Anki update failed for card {last_card.noteId}")
        notification.send_error_no_anki_update()


def sentence_is_same_as_previous(last_card, lines=None):
    if not gsm_state.last_mined_line:
        return False
    return gsm_state.last_mined_line.id == get_mined_line(last_card, lines).id


def _normalize_for_signature(text: str) -> str:
    return strip_whitespace_and_punctuation(remove_html_and_cloze_tags(text or "")).lower()


def _build_sentence_audio_key(game_line: GameLine, selected_lines: Optional[List[GameLine]]) -> Optional[Tuple[str, Tuple[str, ...]]]:
    if selected_lines:
        line_sig = tuple(
            _normalize_for_signature(line.text)
            for line in selected_lines
            if line and line.text
        )
    elif game_line and game_line.text:
        line_sig = (_normalize_for_signature(game_line.text),)
    else:
        line_sig = tuple()

    if not line_sig or all(not part for part in line_sig):
        return None

    sentence_sig = "".join(line_sig)
    return (sentence_sig, line_sig)


def _set_sentence_audio_cache_entry(key: Optional[Tuple[str, Tuple[str, ...]]], line_id: Optional[str], word: str):
    if not key or not line_id:
        return
    sentence_audio_cache[key] = SentenceAudioCacheEntry(line_id=line_id, word=word or "", created_at=datetime.now())


def _prune_sentence_audio_cache():
    if not sentence_audio_cache:
        return
    ttl_seconds = max(120, gsm_state.replay_buffer_length + 120)
    cutoff = datetime.now() - timedelta(seconds=ttl_seconds)
    stale_keys = [key for key, entry in sentence_audio_cache.items() if entry.created_at < cutoff]
    for key in stale_keys:
        sentence_audio_cache.pop(key, None)

def get_sentence(card):
    return card.get_field(get_config().anki.sentence_field)

def check_tags_for_should_update(last_card):
    if get_config().anki.tags_to_check:
        found = False
        for tag in last_card.tags:
            if tag.lower() in get_config().anki.tags_to_check:
                found = True
                break
        if not found:
            logger.info(f"Card does not contain required tags. Not updating. Note Tags: {last_card.tags}, Tags_To_Check {get_config().anki.tags_to_check}")
        return found
    else:
        return True


# Main function to handle the script lifecycle
def monitor_anki():
    try:
        # Continuously check for new cards
        unsuccessful_count = 0
        scaled_polling_rate = get_config().anki.polling_rate_v2 / 1000.0
        while True:
            if not get_config().anki.enabled:
                time.sleep(5)
                continue
            successful = check_for_new_cards()

            if successful:
                unsuccessful_count = 0
            else:
                unsuccessful_count += 1
                if unsuccessful_count >= 5:
                    scaled_polling_rate = min(scaled_polling_rate * 2, 5)  # Cap at 5 seconds
            time.sleep(scaled_polling_rate)  # Check every 200ms
    except KeyboardInterrupt:
        print("Stopped Checking For Anki Cards...")


# Fetch recent note IDs from Anki
def get_note_ids():
    response = requests.post(get_config().anki.url, json={
        "action": "findNotes",
        "version": 6,
        "params": {"query": "added:1"}
    }, timeout=10)
    response.raise_for_status()
    result = response.json()
    return set(result['result'])


def start_monitoring_anki():
    obs_thread = threading.Thread(target=monitor_anki)
    obs_thread.daemon = True
    obs_thread.start()


# --- Anki Stats Utilities ---
# Note: Individual query functions have been removed in favor of the combined endpoint
# All Anki statistics are now fetched through /api/anki_stats_combined



if __name__ == "__main__":
    print(invoke("getIntervals", cards=["1754694986036"]))
