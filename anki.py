import base64
import json
import urllib.request

import config_reader
import notification
from config_reader import *
from ffmpeg import get_screenshot

audio_in_anki = None
screenshot_in_anki = None
should_update_audio = True


def update_anki_card(last_note, audio_path='', video_path='', tango='', reuse_audio=False):
    global audio_in_anki, screenshot_in_anki
    if not reuse_audio:
        if should_update_audio:
            audio_in_anki = store_media_file(audio_path)
        screenshot = get_screenshot(video_path)
        screenshot_in_anki = store_media_file(screenshot)
        if remove_screenshot:
            os.remove(screenshot)
    audio_html = f"[sound:{audio_in_anki}]"
    image_html = f"<img src=\"{screenshot_in_anki}\">"
    note = {'id': last_note['noteId'], 'fields': {picture_field: image_html}}

    if should_update_audio:
        note['fields'][sentence_audio_field] = audio_html

    if anki_custom_fields:
        for key, value in anki_custom_fields.items():
            note['fields'][key] = str(value)

    invoke("updateNoteFields", note=note)
    if custom_tags:
        if add_game_tag:
            custom_tags.append(config_reader.current_game.replace(" ", ""))
        for custom_tag in custom_tags:
            invoke("addTags", tags=custom_tag.replace(" ", ""), notes=[last_note['noteId']])
    logger.info(f"UPDATED ANKI CARD FOR {last_note['noteId']}")
    if notify_on_update:
        notification.send_notification(tango)
    if open_anki_edit:
        notification.open_anki_card(last_note['noteId'])


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
    response = json.load(urllib.request.urlopen(urllib.request.Request(anki_url, request_json)))
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
    query = f'{sentence_audio_field}: {sentence_field}:{add_wildcards(sentence)}'
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

