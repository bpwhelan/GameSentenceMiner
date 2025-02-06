import requests
from plyer import notification

from GameSentenceMiner.configuration import logger


def open_anki_card(note_id):
    url = "http://localhost:8765"
    headers = {'Content-Type': 'application/json'}

    data = {
        "action": "guiEditNote",
        "version": 6,
        "params": {
            "note": note_id
        }
    }

    try:
        response = requests.post(url, json=data, headers=headers)
        if response.status_code == 200:
            logger.info(f"Opened Anki note with ID {note_id}")
        else:
            logger.error(f"Failed to open Anki note with ID {note_id}")
    except Exception as e:
        logger.info(f"Error connecting to AnkiConnect: {e}")


def send_notification(tango):
    notification.notify(
        title="Anki Card Updated",
        message=f"Audio and/or Screenshot added to note: {tango}",
        app_name="GameSentenceMiner",
        timeout=5  # Notification disappears after 5 seconds
    )


def send_screenshot_updated(tango):
    notification.notify(
        title="Anki Card Updated",
        message=f"Screenshot updated on note: {tango}",
        app_name="GameSentenceMiner",
        timeout=5  # Notification disappears after 5 seconds
    )


def send_screenshot_saved(path):
    notification.notify(
        title="Screenshot Saved",
        message=f"Screenshot saved to : {path}",
        app_name="GameSentenceMiner",
        timeout=5  # Notification disappears after 5 seconds
    )


def send_audio_generated_notification(audio_path):
    notification.notify(
        title="Audio Trimmed",
        message=f"Audio Trimmed and placed at {audio_path}",
        app_name="VideoGameMiner",
        timeout=5  # Notification disappears after 5 seconds
    )


def send_check_obs_notification(reason):
    notification.notify(
        title="OBS Replay Invalid",
        message=f"Check OBS Settings! Reason: {reason}",
        app_name="GameSentenceMiner",
        timeout=5  # Notification disappears after 5 seconds
    )
