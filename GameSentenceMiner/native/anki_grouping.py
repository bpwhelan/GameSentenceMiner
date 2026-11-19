"""Pass the active profile and confirmed card fields to the desktop grouping service."""

import json

from GameSentenceMiner.util.communication import bus_client


def request(url, action, **fields):
    data = {"action": action, "url": url, **fields}
    # A local compatibility merge is safe only before dispatch or when the
    # desktop explicitly returns null before starting a write.
    try:
        size = len(json.dumps(data, ensure_ascii=False).encode("utf-8"))
    except UnicodeEncodeError:
        return None
    if size > 7 * 1024 * 1024:
        return None
    return bus_client.get_bus().request(bus_client.MAIN, "anki.group", data, timeout=None)
