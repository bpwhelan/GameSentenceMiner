import base64
import json

import clipboard
import util
from config_reader import *
import urllib.request
from ffmpeg import get_screenshot

audio_in_anki = None
screenshot_in_anki = None
should_update_audio = True


def update_anki_card(last_note, start_time, audio_path='', video_path='', tango='', reuse_audio=False):
    global audio_in_anki, screenshot_in_anki
    if not reuse_audio:
        if should_update_audio:
            audio_in_anki = store_media_file(audio_path)
        screenshot_in_anki = store_media_file(get_screenshot(video_path, tango))
    audio_html = f"[sound:{audio_in_anki}]"
    image_html = f"<img src=\"{screenshot_in_anki}\">"
    note = {'id': last_note['noteId'], 'fields': {picture_field: image_html}}

    if should_update_audio:
        note['fields'][sentence_audio_field] = audio_html

    invoke("updateNoteFields", note=note)
    if custom_tags:
        if add_game_tag:
            custom_tags.append(current_game.replace(" ", ""))
        for custom_tag in custom_tags:
            invoke("addTags", tags=custom_tag.replace(" ", ""), notes=[last_note['noteId']])
    if clipboard.previous_clipboard_time < start_time:
        util.use_previous_audio = True
    logger.info(f"UPDATED ANKI CARD FOR {last_note['noteId']}")


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
    last_note = invoke('notesInfo', notes=[added_ids[-1]])[0]
    return last_note
