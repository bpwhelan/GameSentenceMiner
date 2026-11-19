"""Bridge desktop-projected notes into the existing mining and Qt card model."""

import json

from GameSentenceMiner.util.communication import bus_client
from GameSentenceMiner.util.models.model import AnkiCard, AnkiField


def read(url, notes=None):
    if notes is None:
        return bus_client.get_bus().request(
            bus_client.MAIN, "anki.cards", {"url": url, "action": "latest"}, timeout=None
        )
    # Even all 20-digit IDs at this bound fit comfortably in one broker frame.
    if len(notes) > 250_000 or any(type(n) is not int or not -(2**63) <= n < 2**63 for n in notes):
        return None
    return bus_client.get_bus().request(
        bus_client.MAIN, "anki.cards", {"url": url, "action": "notes", "notes": notes}, timeout=15
    )


def unpack(row):
    if isinstance(row, str):
        return AnkiCard.from_dict(json.loads(row))
    if isinstance(row, dict):
        return AnkiCard.from_dict(row)
    note_id, tags, fields, cards, model = row
    return AnkiCard(note_id, tags, {name: AnkiField(value, order) for name, value, order in fields}, cards, model)
