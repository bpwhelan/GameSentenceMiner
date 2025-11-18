import json
import os
import shutil
import threading
from pathlib import Path
import time

import base64
import subprocess
import urllib.request
from datetime import datetime, timedelta
from requests import post

from GameSentenceMiner import obs
from GameSentenceMiner.ai.ai_prompting import get_ai_prompt_result
from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.gsm_utils import make_unique, sanitize_filename, wait_for_stable_file, remove_html_and_cloze_tags, combine_dialogue, \
    run_new_thread, open_audio_in_external
from GameSentenceMiner.util import ffmpeg, notification
from GameSentenceMiner.util.configuration import get_config, AnkiUpdateResult, logger, anki_results, gsm_status, \
    gsm_state
from GameSentenceMiner.util.model import AnkiCard
from GameSentenceMiner.util.text_log import GameLine, get_all_lines, get_text_event, get_mined_line, lines_match
from GameSentenceMiner.obs import get_current_game
from GameSentenceMiner.web import texthooking_page
import re
import platform

from dataclasses import dataclass, field
from typing import Dict, Any, List

# Global variables to track state
previous_note_ids = set()
first_run = True
card_queue = []


@dataclass
class MediaAssets:
    """A simple container for media file paths and their Anki names."""
    # Local temporary paths
    audio_path: str = ''
    screenshot_path: str = ''
    prev_screenshot_path: str = ''
    video_path: str = ''
    
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


def _determine_update_conditions(last_note: 'AnkiCard') -> (bool, bool):
    """Determine if audio and picture fields should be updated."""
    config = get_config()
    update_audio = (config.anki.sentence_audio_field and 
                    (not last_note.get_field(config.anki.sentence_audio_field) or config.anki.overwrite_audio))
    
    update_picture = (config.anki.picture_field and config.screenshot.enabled and
                      (not last_note.get_field(config.anki.picture_field) or config.anki.overwrite_picture))
                      
    return update_audio, update_picture


def _generate_media_files(reuse_audio: bool, game_line: 'GameLine', video_path: str, ss_time: float, start_time: float, vad_result: Any, selected_lines: List['GameLine']) -> MediaAssets:
    """Generates or retrieves paths for all media assets (audio, video, screenshots)."""
    assets = MediaAssets()
    config = get_config()

    if reuse_audio:
        logger.info("Reusing media from last note")
        anki_result: 'AnkiUpdateResult' = anki_results[game_line.id]
        assets.audio_in_anki = anki_result.audio_in_anki
        assets.screenshot_in_anki = anki_result.screenshot_in_anki
        assets.prev_screenshot_in_anki = anki_result.prev_screenshot_in_anki
        assets.video_in_anki = anki_result.video_in_anki
        assets.extra_tags = anki_result.extra_tags
        return assets
    
    assets.extra_tags = []

    # --- Generate new media files ---
    if config.anki.picture_field and config.screenshot.enabled:
        logger.info("Getting Screenshot...")
        if config.screenshot.animated:
            assets.screenshot_path = ffmpeg.get_anki_compatible_video(
                video_path, start_time, vad_result.start, vad_result.end, 
                codec='avif', quality=10, fps=12, audio=False
            )
        else:
            assets.screenshot_path = ffmpeg.get_screenshot(
                video_path, ss_time, try_selector=config.screenshot.use_screenshot_selector
            )
        wait_for_stable_file(assets.screenshot_path)

    if config.anki.video_field and vad_result:
        assets.video_path = ffmpeg.get_anki_compatible_video(
            video_path, start_time, vad_result.start, vad_result.end, 
            codec='avif', quality=10, fps=12, audio=True
        )

    if config.anki.previous_image_field and game_line.prev:
        if anki_results.get(game_line.prev.id):
            assets.prev_screenshot_in_anki = anki_results.get(game_line.prev.id).screenshot_in_anki
        else:
            line_for_prev_ss = selected_lines[0].prev if selected_lines else game_line.prev
            assets.prev_screenshot_path = ffmpeg.get_screenshot_for_line(
                video_path, line_for_prev_ss, try_selector=config.screenshot.use_screenshot_selector
            )
            wait_for_stable_file(assets.prev_screenshot_path)
            assets.prev_screenshot_in_anki = store_media_file(assets.prev_screenshot_path)
            if config.paths.remove_screenshot:
                os.remove(assets.prev_screenshot_path)
                
    return assets


def _prepare_anki_note_fields(note: Dict, last_note: 'AnkiCard', assets: MediaAssets, game_line: 'GameLine') -> Dict:
    """Populates the fields of the Anki note dictionary."""
    config = get_config()
    
    if assets.video_in_anki:
        note['fields'][config.anki.video_field] = assets.video_in_anki

    if assets.prev_screenshot_in_anki and config.anki.previous_image_field != config.anki.picture_field:
        note['fields'][config.anki.previous_image_field] = f"<img src=\"{assets.prev_screenshot_in_anki}\">"

    if game_name_field := config.anki.game_name_field:
        note['fields'][game_name_field] = get_current_game()

    if config.ai.add_to_anki:
        sentence_field = note['fields'].get(config.anki.sentence_field, {})
        sentence_to_translate = sentence_field or last_note.get_field(config.anki.sentence_field)
        translation = get_ai_prompt_result(get_all_lines(), sentence_to_translate, game_line, get_current_game())
        game_line.TL = translation  # Side-effect: updates game_line object
        logger.info(f"AI prompt Result: {translation}")
        note['fields'][config.ai.anki_field] = translation
        
    return note


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


def _handle_file_management(tango: str, reuse_audio: bool, game_line: 'GameLine', assets: MediaAssets, video_path: str, start_time: float, end_time: float):
    """Copies temporary media files to the final output folder if configured."""
    config = get_config()
    if not config.paths.output_folder:
        return

    word_path = os.path.join(config.paths.output_folder, sanitize_filename(tango))
    os.makedirs(word_path, exist_ok=True)
    
    if reuse_audio:
        # If reusing, copy all files from the original word's folder
        anki_result: 'AnkiUpdateResult' = anki_results[game_line.id]
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
        elif video_path and config.paths.copy_trimmed_replay_to_output_folder:
            trimmed_video = ffmpeg.trim_replay_for_gameline(video_path, start_time, end_time, accurate=True)
            if os.path.exists(trimmed_video):
                assets.final_video_path = shutil.copy(trimmed_video, word_path)

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


def update_anki_card(last_note: 'AnkiCard', note=None, audio_path='', video_path='', tango='', use_existing_files=False,
                     should_update_audio=True, ss_time=0, game_line=None, selected_lines=None, prev_ss_timing=0, start_time=None, end_time=None, vad_result=None):
    """
    Main function to handle the entire process of updating an Anki card with new media and data.
    """
    config = get_config()
    
    # 1. Decide what to update based on config and existing note state
    update_audio_flag, update_picture_flag = _determine_update_conditions(last_note)
    update_audio_flag = update_audio_flag and should_update_audio
    
    # 2. Generate or retrieve all necessary media files
    assets = _generate_media_files(use_existing_files, game_line, video_path, ss_time, start_time, vad_result, selected_lines)
    assets.audio_path = audio_path # Assign the passed audio path
    
    # 3. Prepare the basic structure of the Anki note and its tags
    note = note or {'id': last_note.noteId, 'fields': {}}
    note = _prepare_anki_note_fields(note, last_note, assets, game_line)
    tags = _prepare_anki_tags()
    
    # 4. (Optional) Show confirmation dialog to the user, which may alter media
    use_voice = update_audio_flag and assets.audio_in_anki
    translation = game_line.TL if hasattr(game_line, 'TL') else ''
    if config.anki.show_update_confirmation_dialog_v2 and not use_existing_files:
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
        previous_ss_time = ffmpeg.get_screenshot_time(video_path, game_line.prev if game_line else None) if get_config().anki.previous_image_field else 0
        result = launch_anki_confirmation(
            tango, sentence, assets.screenshot_path, assets.prev_screenshot_path, dialog_audio_path, translation, ss_time, previous_ss_time
        )
        
        if result is None:
            # Dialog was cancelled
            logger.info("Anki confirmation dialog was cancelled")
            return
        
        use_voice, sentence, translation, new_ss_path, new_prev_ss_path, add_nsfw_tag, new_audio_path = result
        note['fields'][config.anki.sentence_field] = sentence
        note['fields'][config.ai.anki_field] = translation
        assets.screenshot_path = new_ss_path or assets.screenshot_path
        assets.prev_screenshot_path = new_prev_ss_path or assets.prev_screenshot_path
        # Update audio path if TTS was generated in the dialog
        if new_audio_path:
            assets.audio_path = new_audio_path
        
        # Add NSFW tag if checkbox was selected
        if add_nsfw_tag:
            assets.extra_tags.append("NSFW")

    # 5. If creating new media, store files in Anki's collection. Then update note fields.
    if not use_existing_files:
        # Only store new files in Anki if we are not reusing existing ones.
        if assets.video_path:
            assets.video_in_anki = store_media_file(assets.video_path)
        if assets.screenshot_path:
            assets.screenshot_in_anki = store_media_file(assets.screenshot_path)
        if use_voice:
            assets.audio_in_anki = store_media_file(assets.audio_path)
    
    # Now, update the note fields using the Anki filenames (either from cache or newly stored)
    if assets.video_in_anki:
        note['fields'][config.anki.video_field] = assets.video_in_anki
    
    if update_picture_flag and assets.screenshot_in_anki:
        note['fields'][config.anki.picture_field] = f"<img src=\"{assets.screenshot_in_anki}\">"

    if use_voice:
        note['fields'][config.anki.sentence_audio_field] = f"[sound:{assets.audio_in_anki}]"
        if config.audio.external_tool and config.audio.external_tool_enabled:
            anki_media_audio_path = os.path.join(config.audio.anki_media_collection, assets.audio_in_anki)
            open_audio_in_external(anki_media_audio_path)
            
    for extra_tag in assets.extra_tags:
        tags.append(extra_tag)

    # 6. Asynchronously update the note in Anki
    run_new_thread(lambda: check_and_update_note(last_note, note, tags))

    # 7. Handle post-creation file management (copying to output folder)
    word_path = _handle_file_management(tango, use_existing_files, game_line, assets, video_path, start_time, end_time)

    # 8. Cache the result for potential reuse (e.g., for 'previous screenshot')
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
    
    # 9. Update the local application database with final paths
    anki_audio_path = os.path.join(config.audio.anki_media_collection, assets.audio_in_anki) if assets.audio_in_anki else ''
    anki_screenshot_path = os.path.join(config.audio.anki_media_collection, assets.screenshot_in_anki) if assets.screenshot_in_anki else ''
    
    GameLinesTable.update(
        line_id=game_line.id, 
        screenshot_path=assets.final_screenshot_path, 
        audio_path=assets.final_audio_path, 
        replay_path=assets.final_video_path, 
        audio_in_anki=anki_audio_path, 
        screenshot_in_anki=anki_screenshot_path, 
        translation=translation
    )
    
def check_and_update_note(last_note, note, tags=[]):
    selected_notes = invoke("guiSelectedNotes")
    if last_note.noteId in selected_notes:
        notification.open_browser_window(1)
    invoke("updateNoteFields", note=note)
    
    if tags:
        tag_string = " ".join(tags)
        invoke("addTags", tags=tag_string, notes=[last_note.noteId])

    logger.info(f"UPDATED ANKI CARD FOR {last_note.noteId}")
    if last_note.noteId in selected_notes or get_config().features.open_anki_in_browser:
        notification.open_browser_window(last_note.noteId, get_config().features.browser_query)
    if get_config().features.open_anki_edit:
        notification.open_anki_card(last_note.noteId)
    if get_config().features.notify_on_update:
        notification.send_note_updated(last_note.noteId)
    gsm_status.remove_word_being_processed(last_note.get_field(get_config().anki.word_field))


def add_image_to_card(last_note: AnkiCard, image_path):
    global screenshot_in_anki
    update_picture = get_config().anki.overwrite_picture or not last_note.get_field(get_config().anki.picture_field)

    if update_picture:
        screenshot_in_anki = store_media_file(image_path)
        if get_config().paths.remove_screenshot:
            os.remove(image_path)

    image_html = f"<img src=\"{screenshot_in_anki}\">"

    note = {'id': last_note.noteId, 'fields': {}}

    if update_picture:
        note['fields'][get_config().anki.picture_field] = image_html

    run_new_thread(lambda: check_and_update_note(last_note, note))

    logger.info(f"UPDATED IMAGE FOR ANKI CARD {last_note.noteId}")
    
    
    
# Go through every field in the note and fix whitespace issues
# the issues being, a ton of new lines randomly, nothing else
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


def get_initial_card_info(last_note: AnkiCard, selected_lines, game_line: GameLine):
    note = {'id': last_note.noteId, 'fields': {}}
    if not last_note:
        return note, last_note
    note, last_note = fix_overlay_whitespace(last_note, note, selected_lines)
    if not game_line:
        game_line = get_text_event(last_note)
    sentences = []
    sentences_text = ''
    
    # tags_lower = [tag.lower() for tag in last_note.tags]
    #  and 'overlay' in tags_lower if we want to limit to overlay only
    if get_config().overlay.websocket_port and texthooking_page.overlay_server_thread.has_clients():
        sentence_in_anki = last_note.get_field(get_config().anki.sentence_field).replace("\n", "").replace("\r", "").strip()
        logger.info("Found matching line in Anki, Preserving HTML and fix spacing!")

        html_tag_pattern = r'<(\w+)(\s+[^>]*)?>(.*?)</\1>'
        matches = re.findall(html_tag_pattern, sentence_in_anki)
        
        if matches:
            updated_sentence = game_line.text
            for tag_name, attrs, text_inside_tag in matches:
                cleaned_text = text_inside_tag.replace(" ", "").replace('\n', '').replace('\r', '').strip()
                updated_sentence = updated_sentence.replace(
                    text_inside_tag,
                    f"<{tag_name}{attrs}>{cleaned_text}</{tag_name}>"
                )
                if attrs:
                    logger.info(f"Preserved <{tag_name} {attrs}> tag for Sentence")
                else:
                    logger.info(f"Preserved <{tag_name}> tag for Sentence")
            note['fields'][get_config().anki.sentence_field] = updated_sentence
            logger.info(f"Preserved HTML tags for Sentence: {note['fields'][get_config().anki.sentence_field]}")
        else:
            logger.info("No HTML tags found to preserve, just fixing spacing")
            note['fields'][get_config().anki.sentence_field] = game_line.text
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
        if get_config().anki.multi_overwrites_sentence:
            note['fields'][get_config().anki.sentence_field] = multi_line_sentence
        else:
            logger.info(f"Configured to not overwrite sentence field, Multi-line Sentence If you want it, Note you need to do ctrl+shift+x in anki to paste properly:\n\n" + (sentences_text if sentences_text else get_config().advanced.multi_line_line_break.join(sentences)) + "\n")
        if get_config().advanced.multi_line_sentence_storage_field:
            note['fields'][get_config().advanced.multi_line_sentence_storage_field] = multi_line_sentence

    if get_config().anki.previous_sentence_field and game_line.prev and not \
            last_note.get_field(get_config().anki.previous_sentence_field):
        logger.debug(
            f"Adding Previous Sentence: {get_config().anki.previous_sentence_field and game_line.prev.text and not last_note.get_field(get_config().anki.previous_sentence_field)}")
        if selected_lines and selected_lines[0].prev:
            note['fields'][get_config().anki.previous_sentence_field] = selected_lines[0].prev.text
        else:
            note['fields'][get_config().anki.previous_sentence_field] = game_line.prev.text
    return note, last_note


def store_media_file(path):
    try:
        return invoke('storeMediaFile', filename=path, data=convert_to_base64(path))
    except Exception as e:
        logger.error(f"Error storing media file, check anki card for blank media fields: {e}")
        return None


def convert_to_base64(file_path):
    with open(file_path, "rb") as file:
        file_base64 = base64.b64encode(file.read()).decode('utf-8')
    return file_base64


def request(action, **params):
    return {'action': action, 'params': params, 'version': 6}


def invoke(action, **params):
    request_json = json.dumps(request(action, **params)).encode('utf-8')
    # if action != "storeMediaFile":
    #     logger.debug(f"Hitting Anki. Action: {action}. Data: {request_json}")
    response = json.load(urllib.request.urlopen(urllib.request.Request(get_config().anki.url, request_json)))
    if len(response) != 2:
        raise Exception('response has an unexpected number of fields')
    if 'error' not in response:
        raise Exception('response is missing required error field')
    if 'result' not in response:
        raise Exception('response is missing required result field')
    if response['error'] is not None:
        raise Exception(response['error'])
    return response['result']


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

# Check for new Anki cards and save replay buffer if detected
def check_for_new_cards():
    global previous_note_ids, first_run, last_connection_error
    current_note_ids = set()
    try:
        current_note_ids = get_note_ids()
        gsm_status.anki_connected = True
    except Exception as e:
        gsm_status.anki_connected = False
        if datetime.now() - last_connection_error > timedelta(seconds=10):
            logger.error(f"Error fetching Anki notes, Make sure Anki is running, ankiconnect add-on is installed, and url/port is configured correctly in GSM Settings")
            last_connection_error = datetime.now()
        return
    new_card_ids = current_note_ids - previous_note_ids
    if new_card_ids and not first_run:
        try:
            update_new_card()
        except Exception as e:
            logger.error("Error updating new card, Reason:", e)
    first_run = False
    previous_note_ids.update(new_card_ids)  # Update the list of known notes

def update_new_card():
    last_card = get_last_anki_card()
    if not last_card or not check_tags_for_should_update(last_card):
        return
    gsm_status.add_word_being_processed(last_card.get_field(get_config().anki.word_field))
    logger.debug(f"last mined line: {gsm_state.last_mined_line}, current sentence: {get_sentence(last_card)}")
    lines = texthooking_page.get_selected_lines()
    game_line = get_mined_line(last_card, lines)
    use_prev_audio = sentence_is_same_as_previous(last_card, lines) or game_line.id in anki_results
    logger.info(f"New card using previous audio: {use_prev_audio}")
    if get_config().obs.get_game_from_scene:
        obs.update_current_game()
    if use_prev_audio:
        run_new_thread(lambda: update_card_from_same_sentence(last_card, lines=lines, game_line=get_mined_line(last_card, lines)))
        texthooking_page.reset_checked_lines()
    else:
        logger.info("New card(s) detected! Added to Processing Queue!")
        gsm_state.last_mined_line = game_line
        queue_card_for_processing(last_card, lines, game_line)
        
def queue_card_for_processing(last_card, lines, last_mined_line):
    card_queue.append((last_card, datetime.now(), lines, last_mined_line))
    texthooking_page.reset_checked_lines()
    try:
        obs.save_replay_buffer()
    except Exception as e:
        card_queue.pop(0)
        logger.error(f"Error saving replay buffer: {e}")
        return

def update_card_from_same_sentence(last_card, lines, game_line):
    time_elapsed = 0
    while game_line.id not in anki_results:
        time.sleep(0.5)
        time_elapsed += 0.5
        if time_elapsed > 15:
            logger.info(f"Timed out waiting for Anki update for card {last_card.noteId}, retrieving new audio")
            queue_card_for_processing(last_card, lines, game_line)
            return
    anki_result = anki_results[game_line.id]
    
    if anki_result.word == last_card.get_field(get_config().anki.word_field):
        logger.info(f"Same word detected, attempting to get new audio for card {last_card.noteId}")
        queue_card_for_processing(last_card, lines, game_line)
        return
    
    if anki_result.success:
        note, last_card = get_initial_card_info(last_card, lines, game_line)
        tango = last_card.get_field(get_config().anki.word_field)
        update_anki_card(last_card, note=note,
                         game_line=get_mined_line(last_card, lines), use_existing_files=True, tango=tango)
    else:
        logger.error(f"Anki update failed for card {last_card.noteId}")
        notification.send_error_no_anki_update()


def sentence_is_same_as_previous(last_card, lines=None):
    if not gsm_state.last_mined_line:
        return False
    return gsm_state.last_mined_line.id == get_mined_line(last_card, lines).id

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
            logger.info(f"Card not tagged properly! Not updating! Note Tags: {last_card.tags}, Tags_To_Check {get_config().anki.tags_to_check}")
        return found
    else:
        return True


# Main function to handle the script lifecycle
def monitor_anki():
    try:
        # Continuously check for new cards
        while True:
            check_for_new_cards()
            time.sleep(get_config().anki.polling_rate / 1000.0)  # Check every 200ms
    except KeyboardInterrupt:
        print("Stopped Checking For Anki Cards...")


# Fetch recent note IDs from Anki
def get_note_ids():
    response = post(get_config().anki.url, json={
        "action": "findNotes",
        "version": 6,
        "params": {"query": "added:1"}
    })
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