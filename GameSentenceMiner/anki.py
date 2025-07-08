import copy
import queue
import time

import base64
import subprocess
import urllib.request
from datetime import datetime, timedelta
from requests import post

from GameSentenceMiner import obs
from GameSentenceMiner.ai.ai_prompting import get_ai_prompt_result
from GameSentenceMiner.util.gsm_utils import wait_for_stable_file, remove_html_and_cloze_tags, combine_dialogue, \
    run_new_thread, open_audio_in_external
from GameSentenceMiner.util import ffmpeg, notification
from GameSentenceMiner.util.configuration import *
from GameSentenceMiner.util.configuration import get_config
from GameSentenceMiner.util.model import AnkiCard
from GameSentenceMiner.util.text_log import get_all_lines, get_text_event, get_mined_line, lines_match
from GameSentenceMiner.obs import get_current_game
from GameSentenceMiner.web import texthooking_page

# Global variables to track state
previous_note_ids = set()
first_run = True
card_queue = []


def update_anki_card(last_note: AnkiCard, note=None, audio_path='', video_path='', tango='', reuse_audio=False,
                     should_update_audio=True, ss_time=0, game_line=None, selected_lines=None, prev_ss_timing=0):
    update_audio = should_update_audio and (get_config().anki.sentence_audio_field and not
    last_note.get_field(get_config().anki.sentence_audio_field) or get_config().anki.overwrite_audio)
    update_picture = (get_config().anki.picture_field and get_config().screenshot.enabled
                      and (get_config().anki.overwrite_picture or not last_note.get_field(get_config().anki.picture_field)))

    audio_in_anki = ''
    screenshot_in_anki = ''
    prev_screenshot_in_anki = ''
    if reuse_audio:
        logger.info("Reusing Audio from last note")
        anki_result = anki_results[game_line.id]
        audio_in_anki = anki_result.audio_in_anki
        screenshot_in_anki = anki_result.screenshot_in_anki
        prev_screenshot_in_anki = anki_result.prev_screenshot_in_anki
    else:
        if update_audio:
            audio_in_anki = store_media_file(audio_path)
            if get_config().audio.external_tool and get_config().audio.external_tool_enabled:
                open_audio_in_external(f"{get_config().audio.anki_media_collection}/{audio_in_anki}")
        if update_picture:
            logger.info("Getting Screenshot...")
            screenshot = ffmpeg.get_screenshot(video_path, ss_time, try_selector=get_config().screenshot.use_screenshot_selector)
            wait_for_stable_file(screenshot)
            screenshot_in_anki = store_media_file(screenshot)
            if get_config().paths.remove_screenshot:
                os.remove(screenshot)
        if get_config().anki.previous_image_field and game_line.prev:
            prev_screenshot = ffmpeg.get_screenshot_for_line(video_path, selected_lines[0].prev if selected_lines else game_line.prev, try_selector=get_config().screenshot.use_screenshot_selector)
            wait_for_stable_file(prev_screenshot)
            prev_screenshot_in_anki = store_media_file(prev_screenshot)
            if get_config().paths.remove_screenshot:
                os.remove(prev_screenshot)
    audio_html = f"[sound:{audio_in_anki}]"
    image_html = f"<img src=\"{screenshot_in_anki}\">"
    prev_screenshot_html = f"<img src=\"{prev_screenshot_in_anki}\">"

    # note = {'id': last_note.noteId, 'fields': {}}

    if update_audio and audio_in_anki:
        note['fields'][get_config().anki.sentence_audio_field] = audio_html

    if update_picture and screenshot_in_anki:
        note['fields'][get_config().anki.picture_field] = image_html
    if not get_config().screenshot.enabled:
        logger.info("Skipping Adding Screenshot to Anki, Screenshot is disabled in settings")

    if note and 'fields' in note and get_config().ai.enabled:
        sentence_field = note['fields'].get(get_config().anki.sentence_field, {})
        sentence_to_translate = sentence_field if sentence_field else last_note.get_field(
            get_config().anki.sentence_field)
        translation = get_ai_prompt_result(get_all_lines(), sentence_to_translate,
                                 game_line, get_current_game())
        logger.info(f"AI prompt Result: {translation}")
        note['fields'][get_config().ai.anki_field] = translation

    if prev_screenshot_in_anki and get_config().anki.previous_image_field != get_config().anki.picture_field:
        note['fields'][get_config().anki.previous_image_field] = prev_screenshot_html


    tags = []
    if get_config().anki.add_game_tag:
        game = get_current_game().replace(" ", "").replace("::", "")
        if get_config().anki.parent_tag:
            game = f"{get_config().anki.parent_tag}::{game}"
        tags.append(game)
    if get_config().anki.custom_tags:
        tags.extend(get_config().anki.custom_tags)
    if tags:
        tag_string = " ".join(tags)
        invoke("addTags", tags=tag_string, notes=[last_note.noteId])


    logger.info(f"Adding {game_line.id} to Anki Results Dict...")
    if not reuse_audio:
        anki_results[game_line.id] = AnkiUpdateResult(
            success=True,
            audio_in_anki=audio_in_anki,
            screenshot_in_anki=screenshot_in_anki,
            prev_screenshot_in_anki=prev_screenshot_in_anki,
            sentence_in_anki=game_line.text if game_line else '',
            multi_line=bool(selected_lines and len(selected_lines) > 1)
        )

    run_new_thread(lambda: check_and_update_note(last_note, note, tags))

def check_and_update_note(last_note, note, tags=[]):
    selected_notes = invoke("guiSelectedNotes")
    if last_note.noteId in selected_notes:
        notification.open_browser_window(1)
    invoke("updateNoteFields", note=note)

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


def get_initial_card_info(last_note: AnkiCard, selected_lines):
    note = {'id': last_note.noteId, 'fields': {}}
    if not last_note:
        return note
    game_line = get_text_event(last_note)
    sentences = []
    sentences_text = ''
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
    return note


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
        card_queue.append((last_card, datetime.now(), lines))
        texthooking_page.reset_checked_lines()
        try:
            obs.save_replay_buffer()
        except Exception as e:
            card_queue.pop(0)
            logger.error(f"Error saving replay buffer: {e}")
            return

def update_card_from_same_sentence(last_card, lines, game_line):
    while game_line.id not in anki_results:
        time.sleep(0.5)
    anki_result = anki_results[game_line.id]
    if anki_result.success:
        update_anki_card(last_card, note=get_initial_card_info(last_card, lines),
                         game_line=get_mined_line(last_card, lines), reuse_audio=True)
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
    # Start monitoring anki
    if get_config().obs.enabled and get_config().features.full_auto:
        obs_thread = threading.Thread(target=monitor_anki)
        obs_thread.daemon = True  # Ensures the thread will exit when the main program exits
        obs_thread.start()

