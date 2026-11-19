"""Card acquisition through production mining entry points and an isolated AnkiConnect fixture."""

import hashlib
import json
import os
from functools import lru_cache
from types import SimpleNamespace
from unittest.mock import patch


def note(note_id, with_long_definition=False):
    fields = {
        "Word": "語",
        "Sentence": f"例文 {note_id}。",
        "SentenceAudio": "[sound:台詞.mp3]",
        "Picture": '<img src="画像.webp">',
        "Glossary": "<ol><li>語義</li></ol>" * (64 if with_long_definition else 2),
        "Alt": "𠀀",
        "Furigana": "例文[れいぶん]",
        "Source": "Game",
    }
    return {
        "noteId": note_id,
        "modelName": "Japanese",
        "mod": 1710000000,
        "tags": ["読書", "game::one"],
        "fields": {name: {"value": v, "order": i} for i, (name, v) in enumerate(fields.items())},
        "cards": [note_id + 900, note_id + 901],
    }


@lru_cache(maxsize=32)
def reply(case, action, ids):
    if action == "findNotes":
        if case == "empty":
            result = []
        elif case == "cards-latest-small":
            result = [21, 22, 15, 24, 12, 18, 11, 7]
        else:
            # Anki's final returned ID is authoritative even if it is smaller.
            result = [*range(10000, 26383), 7]
    elif case == "missing":
        result = []
    else:
        result = [note(i, case == "cards-batch") for i in ids]
        if case == "historical":
            result[0]["noteId"] = str(result[0]["noteId"])
            result[0]["fields"]["Word"]["order"] = "0"
            result.insert(0, {"noteId": 10})
        if case == "oversized":
            result[0]["fields"]["Glossary"]["value"] = "g" * (7 * 1024 * 1024)
    return json.dumps({"result": result, "error": None}, ensure_ascii=False).encode()


def setup(case, mode, port):
    from GameSentenceMiner import anki
    from GameSentenceMiner.util.models import model

    os.environ["GSM_NATIVE_ANKI_CARDS"] = "1" if mode == "rust" else "0"
    cfg = SimpleNamespace(
        anki=SimpleNamespace(
            url=f"http://127.0.0.1:{port}/cards/{case}",
            word_field="Word",
            sentence_field="Sentence",
            picture_field="Picture",
            sentence_audio_field="SentenceAudio",
            sentence_furigana_field="Furigana",
        )
    )
    model.get_config = anki.get_config = lambda: cfg
    received = []
    anki.update_single_card = received.append
    ids = list(range(32, 0, -1)) if case == "cards-batch" else [7]

    def cycle():
        received.clear()
        if case.startswith("cards-latest"):
            received.append(anki.get_last_anki_card())
        else:
            anki.update_new_cards(ids)
        return len(received)

    def digest():
        rows = [
            [c.noteId, c.tags, [(k, f.value, f.order) for k, f in c.fields.items()], c.cards, c.modelName]
            for c in received
        ]
        return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()

    def verify():
        assert [c.noteId for c in received] == ids
        observed = {"mined_cards_sha256": digest(), "notes": len(received)}
        if case == "cards-single":
            with patch.object(cfg.anki, "url", f"http://127.0.0.1:{port}/cards/historical"):
                received.clear()
                anki.update_new_cards([7, 8])
                assert [c.noteId for c in received] == [7, 8]
                observed["historical_sha256"] = digest()
            with patch.object(cfg.anki, "url", f"http://127.0.0.1:{port}/cards/empty"):
                assert anki.get_last_anki_card() == {}
            with patch.object(cfg.anki, "url", f"http://127.0.0.1:{port}/cards/missing"):
                try:
                    anki.get_last_anki_card()
                except (IndexError, RuntimeError):
                    pass
                else:
                    raise AssertionError("A vanished note must report a failed read")
            with patch.object(cfg.anki, "url", f"http://127.0.0.1:{port}/cards/oversized"):
                card = anki.get_last_anki_card()
                assert card.noteId == 7 and len(card.fields["Glossary"].value) == 7 * 1024 * 1024
                received[:] = [card]
                observed["oversized_sha256"] = digest()
        return observed

    return cycle, verify
