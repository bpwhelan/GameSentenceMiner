"""Hoshidicts-only test factories.

Private to the Hoshidicts tests so they never depend on GSM's own test
utilities. The file is named ``test_*`` so pytest's collection pattern imports
it; it deliberately contains no tests.
"""

from types import SimpleNamespace

from GameSentenceMiner import (
    hoshidicts_anki,
    hoshidicts_audio,
    hoshidicts_audio_profile,
    hoshidicts_mining,
)

DUPLICATE_ERROR = "cannot create note because it is a duplicate"
DEFAULT_MODEL_FIELDS = [
    "Expression",
    "Reading",
    "Definition",
    "Sentence",
    "Frequency",
    "PitchAccent",
]
AUDIO_MEDIA = hoshidicts_audio.AudioMedia(
    data=b"ID3pronunciation",
    content_type="audio/mpeg",
    extension="mp3",
)
_MISSING = object()


def make_config(**anki_overrides):
    anki = {
        "enabled": True,
        "note_type": "Mining",
        "word_field": "Expression",
        "sentence_field": "Sentence",
        "custom_tags": ["GSM"],
        "tags_to_check": ["mine"],
    }
    anki.update(anki_overrides)
    return SimpleNamespace(anki=SimpleNamespace(**anki))


def make_mining_profile(**overrides):
    profile = hoshidicts_mining.default_hoshidicts_mining_profile()
    profile.update(overrides)
    return profile


def make_field_templates(templates):
    """Per-target templates from ``{field: value}`` or ``{field: (value, mode)}``."""
    return {
        field: (
            {"value": template, "overwriteMode": "coalesce"}
            if isinstance(template, str)
            else {"value": template[0], "overwriteMode": template[1]}
        )
        for field, template in templates.items()
    }


def make_overwrite_modes(**overrides):
    return {**make_mining_profile()["fieldOverwriteModes"], **overrides}


def make_note_fields(field_names, **values):
    """Existing Anki note field values, blank unless overridden."""
    return {name: values.get(name, "") for name in field_names}


def make_note_info(note_id, fields, *, model="Mining", cards=None):
    info = {
        "noteId": note_id,
        "modelName": model,
        "fields": {name: {"value": value, "order": index} for index, (name, value) in enumerate(fields.items())},
    }
    if cards is not None:
        info["cards"] = cards
    return info


def duplicate_responses(existing_fields=None, *, note_id=42, model="Mining", cards=None, **extra):
    """AnkiConnect answers for a note that already exists in the collection."""
    responses = {"canAddNotesWithErrorDetail": [{"canAdd": False, "error": DUPLICATE_ERROR}]}
    if existing_fields is not None:
        responses["findNotes"] = [note_id]
        responses["notesInfo"] = [make_note_info(note_id, existing_fields, model=model, cards=cards)]
    responses.update(extra)
    return responses


def make_payload(**overrides):
    payload = {
        "sentence": "昨日、食べた。",
        "matchOffset": 3,
        "result": {
            "matched": "食べた",
            "deinflected": "食べる",
            "preprocessorSteps": 0,
            "trace": [{"name": "past", "description": "past tense"}],
            "term": {
                "expression": "食べる",
                "reading": "たべる",
                "rules": "v1",
                "score": 100,
                "glossaries": [
                    {
                        "dictionary": "JMdict",
                        "glossary": '["to eat",{"tag":"br"},{"content":"consume"}]',
                        "definitionTags": "food",
                        "termTags": "common",
                    }
                ],
                "frequencies": [
                    {
                        "dictionary": "Frequency",
                        "frequencies": [{"value": 123, "displayValue": "123 ★"}],
                    }
                ],
                "pitches": [
                    {
                        "dictionary": "Pitch",
                        "pitches": [
                            {
                                "position": 2,
                                "pattern": "LHL",
                                "nasal": [1],
                                "devoice": [2],
                            }
                        ],
                        "transcriptions": ["tabeɾɯ"],
                    }
                ],
            },
        },
    }
    payload.update(overrides)
    return payload


def make_term_payload(**term_overrides):
    payload = make_payload()
    payload["result"]["term"].update(term_overrides)
    return payload


class FakeAnki:
    """Minimal AnkiConnect stand-in.

    ``responses`` maps an action to a value, a callable receiving the invoke
    keyword arguments, or an exception instance to raise. ``"*"`` answers every
    action that has no entry of its own.
    """

    def __init__(self, fields=None, note_id=42, model_names=None, decks=None, responses=None):
        self.fields = fields if fields is not None else list(DEFAULT_MODEL_FIELDS)
        self.note_id = note_id
        self.model_names = model_names or ["Mining"]
        self.decks = decks or ["Default", "Mining"]
        self.responses = dict(responses or {})
        self.calls = []
        self.events = []

    def invoke(self, action, **kwargs):
        self.calls.append((action, kwargs))
        response = self.responses.get(action, self.responses.get("*", _MISSING))
        if response is not _MISSING:
            if isinstance(response, BaseException):
                raise response
            return response(**kwargs) if callable(response) else response
        if action == "modelNames":
            return self.model_names
        if action == "modelFieldNames":
            return self.fields
        if action == "deckNames":
            return self.decks
        if action == "addNote":
            return self.note_id
        if action == "storeMediaFile":
            return kwargs["filename"]
        if action == "updateNoteFields":
            return None
        raise AssertionError(action)

    def _prepare_anki_tags(self):
        return ["GSM", "Game::Test"]

    def handle_incoming_anki_event(self, payload):
        self.events.append(payload)
        return "note_added"

    def actions(self):
        return [action for action, _kwargs in self.calls]

    def all_kwargs(self, action):
        return [kwargs for called_action, kwargs in self.calls if called_action == action]

    def kwargs_for(self, action):
        return self.all_kwargs(action)[0]

    def note_for(self, action="addNote"):
        return self.kwargs_for(action)["note"]

    def notes_for(self, action):
        return [kwargs["note"] for kwargs in self.all_kwargs(action)]


def wire(monkeypatch, fake_anki, profile=None, config=None):
    hoshidicts_mining._clear_mining_status_cache()
    monkeypatch.setattr(hoshidicts_mining, "get_config", lambda: config or make_config())
    monkeypatch.setattr(
        hoshidicts_mining,
        "load_hoshidicts_mining_profile",
        lambda: profile or make_mining_profile(),
    )
    monkeypatch.setattr(hoshidicts_anki, "get_anki_module", lambda: fake_anki)


def wire_audio(
    monkeypatch,
    fake_anki,
    *,
    mining_profile=None,
    audio_profile=None,
    media=AUDIO_MEDIA,
    error=None,
    resolver=None,
):
    wire(monkeypatch, fake_anki, mining_profile)
    audio_profile = audio_profile or make_audio_profile()
    monkeypatch.setattr(
        hoshidicts_audio_profile,
        "load_hoshidicts_audio_profile_or_default",
        lambda: audio_profile,
    )

    if resolver is None:

        def resolver(*_args, **_kwargs):
            if error is not None:
                raise error
            return media

    monkeypatch.setattr(hoshidicts_audio, "get_mining_audio", resolver)
    return audio_profile


def make_audio_profile(*sources, **overrides):
    profile = hoshidicts_audio_profile.default_hoshidicts_audio_profile()
    profile.update(overrides)
    if sources:
        profile["sources"] = list(sources)
    return profile


def make_audio_source(source_id, source_type, *, url="", voice=""):
    return {"id": source_id, "type": source_type, "url": url, "voice": voice}


class FakeResponse:
    def __init__(self, body, *, content_type="text/html", status_code=200, headers=None):
        self._body = body
        self.status_code = status_code
        self.headers = {"Content-Type": content_type, **(headers or {})}

    def iter_content(self, chunk_size=64 * 1024):
        yield from (self._body[index : index + chunk_size] for index in range(0, len(self._body), chunk_size))

    def close(self):
        pass


def mp3_bytes(payload=b"pronunciation"):
    frame = b"\xff\xfb\x90\x64" + payload
    return b"ID3\x04\x00\x00\x00\x00\x00\x00" + frame.ljust(417, b"\x00")


def opus_bytes(payload=b"pronunciation"):
    packet = b"OpusHead" + payload
    return b"OggS" + (b"\x00" * 22) + bytes((1, len(packet))) + packet
