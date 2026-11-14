"""Report backend events to Electron, which owns notification settings and delivery."""

import os

from GameSentenceMiner.util.communication.electron_ipc import send_message
from GameSentenceMiner.util.config.configuration import logger


def _emit(channel: str, payload: dict) -> None:
    if os.environ.get("GSM_ELECTRON") != "1":
        return
    try:
        send_message(channel, payload)
    except Exception as error:
        logger.debug(f"Could not report desktop event: {error}")


def _event(event: str, message: str, **details) -> None:
    _emit("notification", {"type": event, "message": message, **details})


def card_updated(note_id) -> None:
    _event("AnkiCardUpdated", f"Card updated: {note_id}", noteId=int(note_id))


def screenshot_updated(note_id) -> None:
    _event("AnkiCardUpdated", f"Screenshot updated on note: {note_id}", noteId=int(note_id))


def pending_reviews(count: int) -> None:
    _event(
        "PendingSessionReviews",
        f"You have {count} Anki card{'s' if count != 1 else ''} waiting for review.",
        count=count,
    )


def screenshot_saved(path) -> None:
    _event("ScreenshotSaved", f"Screenshot saved to: {path}", path=str(path))


def audio_generated(path) -> None:
    _event("AudioGenerated", f"Audio trimmed and placed at {path}", path=str(path))


def obs_warning(reason: str) -> None:
    _event("CheckOBS", f"Check OBS settings. Reason: {reason}")


def app_error(message: str) -> None:
    _event("Error", message)


def card_error(message: str) -> None:
    _event("AnkiEnhancementFailed", message)


def ready(message: str) -> None:
    _event("GSMReady", message)


def announce_text_intake_state(paused: bool) -> None:
    _emit("text_intake_state", {"paused": bool(paused)})


def text_intake_paused(relay_outputs_enabled: bool = True) -> None:
    if relay_outputs_enabled:
        message = (
            "Stats collection is paused. Card mining, the overlay, Text Feed, and output relays stay active. "
            "Incoming text will not update live stats, Discord activity, or the database."
        )
    else:
        message = "Clipboard and websocket text intake is paused. Incoming text will be fully ignored until resumed."
    _event("GSMTextIntakePaused", message)


def text_intake_resumed() -> None:
    _event("GSMTextIntakeResumed", "Clipboard and websocket text intake resumed.")


def ocr_pause_state(paused: bool) -> None:
    _event("OCRPaused" if paused else "OCRResumed", "OCR paused." if paused else "OCR resumed.")
