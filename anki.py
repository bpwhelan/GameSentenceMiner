import base64
import urllib.request

import configuration
import ffmpeg
import notification
import util
from configuration import *
from gametext import get_last_two_sentences

audio_in_anki = None
screenshot_in_anki = None


def update_anki_card(last_note, note=None, audio_path='', video_path='', tango='', reuse_audio=False, should_update_audio=True):
    global audio_in_anki, screenshot_in_anki
    update_audio = should_update_audio and (get_config().anki.sentence_audio_field and not last_note['fields'][get_config().anki.sentence_audio_field][
        'value'] or get_config().anki.overwrite_audio)
    update_picture = (get_config().anki.picture_field and get_config().anki.overwrite_picture) or not last_note['fields'][get_config().anki.picture_field][
        'value']

    if not reuse_audio:
        if update_audio:
            audio_in_anki = store_media_file(audio_path)
        if update_picture:
            screenshot = ffmpeg.get_screenshot(video_path)
            screenshot_in_anki = store_media_file(screenshot)
            if get_config().paths.remove_screenshot:
                os.remove(screenshot)
    audio_html = f"[sound:{audio_in_anki}]"
    image_html = f"<img src=\"{screenshot_in_anki}\">"

    # note = {'id': last_note['noteId'], 'fields': {}}

    if update_audio:
        note['fields'][get_config().anki.sentence_audio_field] = audio_html

    if update_picture:
        note['fields'][get_config().anki.picture_field] = image_html

    if get_config().anki.anki_custom_fields:
        for key, value in get_config().anki.anki_custom_fields.items():
            note['fields'][key] = str(value)

    invoke("updateNoteFields", note=note)
    tags = []
    if get_config().anki.custom_tags:
        tags.extend(get_config().anki.custom_tags)
    if get_config().anki.add_game_tag:
        tags.append(configuration.current_game.replace(" ", ""))
    if tags:
        tag_string = " ".join(tags)
        invoke("addTags", tags=tag_string, notes=[last_note['noteId']])
    logger.info(f"UPDATED ANKI CARD FOR {last_note['noteId']}")
    if get_config().features.notify_on_update:
        notification.send_notification(tango)
    if get_config().features.open_anki_edit:
        notification.open_anki_card(last_note['noteId'])


def add_image_to_card(last_note, image_path):
    global screenshot_in_anki
    update_picture = get_config().anki.overwrite_picture or not last_note['fields'][get_config().anki.picture_field][
        'value']

    if update_picture:
        screenshot_in_anki = store_media_file(image_path)
        if get_config().paths.remove_screenshot:
            os.remove(image_path)

    image_html = f"<img src=\"{screenshot_in_anki}\">"

    note = {'id': last_note['noteId'], 'fields': {}}

    if update_picture:
        note['fields'][get_config().anki.picture_field] = image_html

    invoke("updateNoteFields", note=note)

    logger.info(f"UPDATED IMAGE FOR ANKI CARD {last_note['noteId']}")


def get_initial_card_info(last_note):
    note = {'id': last_note['noteId'], 'fields': {}}
    if not last_note:
        return note
    current_line, previous_line = get_last_two_sentences()
    logger.debug(f"Previous Sentence {previous_line}")
    logger.debug(f"Current Sentence {current_line}")
    util.use_previous_audio = True

    logger.debug(
        f"Adding Previous Sentence: {get_config().anki.previous_sentence_field and previous_line and not last_note['fields'][get_config().anki.previous_sentence_field]['value']}")
    if get_config().anki.previous_sentence_field and previous_line and not \
            last_note['fields'][get_config().anki.previous_sentence_field]['value']:
        note['fields'][get_config().anki.previous_sentence_field] = previous_line
    return note


def store_media_file(path):
    return invoke('storeMediaFile', filename=path, data=convert_to_base64(path))


def convert_to_base64(file_path):
    with open(file_path, "rb") as file:
        file_base64 = base64.b64encode(file.read()).decode('utf-8')
    return file_base64


def request(action, **params):
    return {'action': action, 'params': params, 'version': 6}


def invoke(action, **params):
    request_json = json.dumps(request(action, **params)).encode('utf-8')
    logger.debug(f"Hitting Anki. Action: {action}. Data: {request_json}")
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


def get_last_anki_card():
    added_ids = invoke('findNotes', query='added:1')
    if not added_ids:
        return {}
    last_note = invoke('notesInfo', notes=[added_ids[-1]])[0]
    return last_note


def add_wildcards(expression):
    return '*' + '*'.join(expression) + '*'


def get_cards_by_sentence(sentence):
    sentence = sentence.replace(" ", "")
    query = f'{get_config().anki.sentence_audio_field}: {get_config().anki.sentence_field}:{add_wildcards(sentence)}'
    card_ids = invoke("findCards", query=query)

    if not card_ids:
        print(f"Didn't find any cards matching query:\n{query}")
        return {}
    if len(card_ids) > 1:
        print(f'Found more than 1, and not updating cards for query: \n{query}')
        return {}

    last_notes = invoke('notesInfo', notes=[card_ids[0]])[0]

    print(f"Found Card to backfill!: {card_ids[0]}")

    return last_notes
