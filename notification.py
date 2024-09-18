import requests
from plyer import notification

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
            print(f"Opened Anki note with ID {note_id}")
        else:
            print(f"Failed to open Anki note with ID {note_id}")
    except Exception as e:
        print(f"Error connecting to AnkiConnect: {e}")


# Send a plyer notification
def send_notification(tango):
    notification.notify(
        title="Video Game Miner",
        message=f"Audio and Screenshot added to latest note: {tango}",
        app_name="Anki",
        timeout=5  # Notification disappears after 5 seconds
    )
