"""Send handled notes to the desktop alongside the next AnkiConnect query."""

import threading
import uuid

from GameSentenceMiner.native.runtime import backend_manages

_session = str(uuid.uuid4())
_lock = threading.Lock()
_changes = {}


def managed():
    return backend_manages("GSM_NATIVE_ANKI_POLL")


def acknowledge(note_ids, known=True):
    from GameSentenceMiner.native import anki_monitor

    with _lock:
        _changes.update((int(note), known) for note in note_ids)
    anki_monitor.wake()


def session():
    return _session


def pending_changes():
    with _lock:
        pending = dict(_changes)
    return pending, {
        "remember": [key for key, known in pending.items() if known],
        "forget": [key for key, known in pending.items() if not known],
    }


def confirm_changes(pending, result):
    with _lock:
        for key, value in pending.items():
            if _changes.get(key) is value:
                del _changes[key]
        return {key for key in result if not _changes.get(key, False)}


def query(mode, url):
    from GameSentenceMiner.util.communication import bus_client

    pending, edits = pending_changes()
    # New acknowledgements can arrive while Anki is serving this request.
    result = bus_client.get_bus().request(
        bus_client.MAIN,
        "anki.poll",
        {
            "session": _session,
            "mode": mode,
            "url": url,
            **edits,
        },
        timeout=15,
    )
    return confirm_changes(pending, result)
