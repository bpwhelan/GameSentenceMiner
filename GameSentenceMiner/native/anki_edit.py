"""Resume a desktop-owned note edit only when Anki explicitly rejected an action."""

import json

from GameSentenceMiner.util.communication import bus_client


def commit(url, note, tags, remove_overlay, *, wait, timing_context=None):
    if not isinstance(note.get("id"), int) or note["id"] < 0:
        return False
    from GameSentenceMiner.util.anki_card_timing import is_anki_card_timing_enabled, log_anki_card_timing

    timed = timing_context is not None and is_anki_card_timing_enabled()
    request = {
        "url": url,
        "note": note,
        "tags": tags,
        "remove_overlay": remove_overlay,
        "step": "updateNoteFields",
        "timed": timed,
    }
    if len(json.dumps(request, ensure_ascii=False).encode("utf-8")) > 7 * 1024 * 1024:
        return False
    delay = 1
    attempt = 1
    while True:
        # Each mutation has its own 10-second Anki timeout. Never replay an
        # uncertain broker reply, even if an earlier stage already succeeded.
        reply = bus_client.get_bus().request(bus_client.MAIN, "anki.edit", request, timeout=35)
        busy = reply["busy"]
        for trace in reply.get("attempts", ()):
            action = trace["action"]
            log_anki_card_timing(
                timing_context,
                "anki_connect.invoke",
                **trace,
                attempt=attempt if action == request["step"] else 1,
                timeout_seconds=10,
                param_keys=["note"] if action == "updateNoteFields" else ["notes", "tags"],
                will_retry=action == busy,
                error=reply.get("error") if trace is reply["attempts"][-1] else None,
            )
        if error := reply.get("error"):
            raise RuntimeError(error)
        if not busy:
            return True
        if busy != request["step"]:
            delay, attempt = 1, 1
        if wait(delay):
            raise RuntimeError("A collection operation is active.")
        request["step"] = busy
        delay = min(5, delay * 2)
        attempt += 1
