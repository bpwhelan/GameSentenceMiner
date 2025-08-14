import requests
from plyer import notification
from GameSentenceMiner.util.configuration import logger, is_windows

if is_windows():
    from GameSentenceMiner.util.win10toast import ToastNotifier

if is_windows():
    class MyToastNotifier(ToastNotifier):
        def __init__(self):
            super().__init__()

        def on_destroy(self, hwnd, msg, wparam, lparam):
            super().on_destroy(hwnd, msg, wparam, lparam)
            return 0

if is_windows():
    notifier = MyToastNotifier()
else:
    notifier = notification


def open_browser_window(note_id, query=None):
    url = "http://localhost:8765"
    headers = {'Content-Type': 'application/json'}

    data = {
        "action": "guiBrowse",
        "version": 6,
        "params": {
            "query": f"nid:{note_id}" if not query else query,
        }
    }

    try:
        if query:
            blank_req_data = {
                "action": "guiBrowse",
                "version": 6,
                "params": {
                    "query": "nid:1",
                }
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


def send_notification(title, message, timeout):
    try:
        if is_windows():
            notifier.show_toast(
                title, message, duration=timeout, threaded=True)
        else:
            notification.notify(
                title=title,
                message=message,
                app_name="GameSentenceMiner",
                timeout=timeout  # Notification disappears after 5 seconds
            )
    except Exception as e:
        logger.error(f"Failed to send notification: {e}")


def send_note_updated(tango):
    send_notification(
        title="Anki Card Updated",
        message=f"Audio and/or Screenshot added to note: {tango}",
        timeout=5  # Notification disappears after 5 seconds
    )


def send_screenshot_updated(tango):
    send_notification(
        title="Anki Card Updated",
        message=f"Screenshot updated on note: {tango}",
        timeout=5  # Notification disappears after 5 seconds
    )


def send_screenshot_saved(path):
    send_notification(
        title="Screenshot Saved",
        message=f"Screenshot saved to : {path}",
        timeout=5  # Notification disappears after 5 seconds
    )


def send_audio_generated_notification(audio_path):
    send_notification(
        title="Audio Trimmed",
        message=f"Audio Trimmed and placed at {audio_path}",
        timeout=5  # Notification disappears after 5 seconds
    )


def send_check_obs_notification(reason):
    send_notification(
        title="OBS Replay Invalid",
        message=f"Check OBS Settings! Reason: {reason}",
        timeout=5  # Notification disappears after 5 seconds
    )


def send_error_no_anki_update():
    send_notification(
        title="Error",
        message=f"Anki Card not updated, Check Console for Reason!",
        timeout=5  # Notification disappears after 5 seconds
    )
    
def send_error_notification(message):
    send_notification(
        title="Error",
        message=message,
        timeout=5  # Notification disappears after 5 seconds
    )


if __name__ == "__main__":
    send_note_updated("TestTango")
    send_screenshot_updated("TestTango")
    send_screenshot_saved("C:/Screenshots/test.png")
    send_audio_generated_notification("C:/Audio/test.mp3")
    send_check_obs_notification("Replay buffer not active")
    send_error_no_anki_update()
    send_error_notification("Custom error message for testing")