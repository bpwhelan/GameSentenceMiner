"""Open Anki windows through AnkiConnect."""

import requests

from GameSentenceMiner.util.config.configuration import logger


def open_browser_window(note_id, query=None):
    url = "http://localhost:8765"
    headers = {"Content-Type": "application/json"}

    data = {
        "action": "guiBrowse",
        "version": 6,
        "params": {
            "query": f"nid:{note_id}" if not query else query,
        },
    }

    try:
        if query:
            blank_req_data = {
                "action": "guiBrowse",
                "version": 6,
                "params": {
                    "query": "nid:1",
                },
            }
            requests.post(url, json=blank_req_data, headers=headers)
        response = requests.post(url, json=data, headers=headers)
        if response.status_code == 200:
            if query:
                logger.info(f"Opened Anki browser with query: {query}")
            else:
                logger.info(f"Opened Anki note in browser with ID {note_id}")
        else:
            logger.error(f"Failed to open Anki note with ID {note_id}")
    except Exception as e:
        logger.info(f"Error connecting to AnkiConnect: {e}")


def open_anki_card(note_id):
    url = "http://localhost:8765"
    headers = {"Content-Type": "application/json"}

    data = {"action": "guiEditNote", "version": 6, "params": {"note": note_id}}

    try:
        response = requests.post(url, json=data, headers=headers)
        if response.status_code == 200:
            logger.info(f"Opened Anki note with ID {note_id}")
        else:
            logger.error(f"Failed to open Anki note with ID {note_id}")
    except Exception as e:
        logger.info(f"Error connecting to AnkiConnect: {e}")
