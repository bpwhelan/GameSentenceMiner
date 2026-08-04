import base64
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import requests

from GameSentenceMiner.hoshidicts_mining import HoshiDictsMiningService


def _config(**overrides):
    values = {
        "enabled": True,
        "url": "http://127.0.0.1:8765",
        "note_type": "Mining",
        "word_field": "Expression",
        "sentence_field": "Sentence",
        "hoshi_mining_deck": "Japanese::Mining",
        "hoshi_reading_field": "Reading",
        "hoshi_glossary_field": "Glossary",
        "hoshi_dictionary_field": "Dictionary",
        "hoshi_frequency_field": "Frequency",
        "hoshi_pitch_field": "Pitch",
        "custom_tags": ["GSM"],
        "tags_to_check": [],
        "add_game_tag": False,
        "parent_tag": "Game",
    }
    values.update(overrides)
    return SimpleNamespace(anki=SimpleNamespace(**values))


def _request(**overrides):
    payload = {
        "type": "dictionary-mine-request",
        "request_id": "11111111-1111-4111-8111-111111111111",
        "idempotency_key": "22222222-2222-4222-8222-222222222222",
        "session_id": "33333333-3333-4333-8333-333333333333",
        "backend": "hoshidicts",
        "line_id": "44444444-4444-4444-8444-444444444444",
        "source_sentence": "renderer sentence",
        "lookup": {
            "expression": "食べる",
            "reading": "たべる",
            "matched_text": "食べました",
            "dictionary_id": "dict-jitendex",
            "dictionary_title": "Jitendex",
            "glossary_id": "glossary-selected",
            "glossary_text": "to eat",
            "frequency": ["100", "ichi: 500"],
            "pitch": [2],
        },
        "media": [],
    }
    payload.update(overrides)
    return payload


class FakeAnki:
    def __init__(self):
        self.calls = []
        self.added_note_id = 9001
        self.find_notes = []
        self.add_error = None
        self.media_error = None

    def invoke(self, action, **params):
        self.calls.append((action, params))
        if action == "version":
            return 6
        if action == "deckNames":
            return ["Japanese::Mining"]
        if action == "modelNames":
            return ["Mining"]
        if action == "modelFieldNames":
            return [
                "Expression",
                "Reading",
                "Glossary",
                "Sentence",
                "Dictionary",
                "Frequency",
                "Pitch",
            ]
        if action == "findNotes":
            return list(self.find_notes)
        if action == "storeMediaFile":
            if self.media_error:
                raise self.media_error
            return params["filename"]
        if action == "addNote":
            if self.add_error:
                error = self.add_error
                self.add_error = None
                raise error
            return self.added_note_id
        raise AssertionError(f"Unexpected Anki action: {action}")


def _service(fake_anki, **overrides):
    enqueued = []
    options = {
        "config_getter": lambda: _config(),
        "invoke": fake_anki.invoke,
        "line_resolver": lambda line_id: SimpleNamespace(
            id=line_id,
            text="server-owned sentence",
        ),
        "tag_provider": lambda: ["GSM"],
        "note_created": lambda note_id, session_id: enqueued.append((note_id, session_id)),
        "readiness_ttl_seconds": 0,
    }
    options.update(overrides)
    return HoshiDictsMiningService(**options), enqueued


def _calls(fake_anki, action):
    return [params for call_action, params in fake_anki.calls if call_action == action]


def test_creates_selected_hoshi_glossary_with_authoritative_line_and_source_tags():
    fake_anki = FakeAnki()
    service, enqueued = _service(fake_anki)

    result = service.mine(_request())

    assert result.status == "created"
    assert result.note_id == 9001
    assert enqueued == [(9001, "33333333-3333-4333-8333-333333333333")]
    [add_call] = _calls(fake_anki, "addNote")
    note = add_call["note"]
    assert note["deckName"] == "Japanese::Mining"
    assert note["modelName"] == "Mining"
    assert note["fields"] == {
        "Expression": "食べる",
        "Reading": "たべる",
        "Glossary": "to eat",
        "Sentence": "server-owned sentence",
        "Dictionary": "Jitendex",
        "Frequency": "100, ichi: 500",
        "Pitch": "2",
    }
    assert note["options"]["allowDuplicate"] is True
    assert {"overlay", "gsm_hoshidicts", "GSM"} <= set(note["tags"])
    assert any(tag.startswith("gsm_hoshi_id_") for tag in note["tags"])
    assert any(tag.startswith("gsm_line_id_") for tag in note["tags"])


def test_duplicate_policy_uses_stable_source_fingerprint_and_returns_oldest_note():
    fake_anki = FakeAnki()
    fake_anki.find_notes = [42, 17, 23]
    service, enqueued = _service(fake_anki)

    result = service.mine(_request())

    assert result.status == "duplicate"
    assert result.note_id == 17
    assert _calls(fake_anki, "addNote") == []
    assert enqueued == []
    [find_call] = _calls(fake_anki, "findNotes")
    assert "tag:gsm_hoshidicts" in find_call["query"]
    assert "tag:gsm_hoshi_id_" in find_call["query"]


def test_invalid_mapping_is_reported_before_note_creation():
    fake_anki = FakeAnki()
    service, _ = _service(
        fake_anki,
        config_getter=lambda: _config(hoshi_glossary_field="MissingField"),
    )

    result = service.mine(_request())

    assert result.status == "invalid-config"
    assert "MissingField" in result.message
    assert _calls(fake_anki, "addNote") == []


def test_missing_model_is_invalid_config_without_querying_its_fields():
    fake_anki = FakeAnki()
    original_invoke = fake_anki.invoke

    def missing_model(action, **params):
        if action == "modelNames":
            fake_anki.calls.append((action, params))
            return ["Other"]
        if action == "modelFieldNames":
            raise AssertionError("Missing models must not be queried for fields")
        return original_invoke(action, **params)

    service, _ = _service(fake_anki, invoke=missing_model)

    result = service.mine(_request())

    assert result.status == "invalid-config"
    assert "Mining" in result.message
    assert _calls(fake_anki, "addNote") == []


def test_unavailable_anki_is_explicit_and_retryable():
    attempts = 0

    def unavailable(action, **params):
        nonlocal attempts
        attempts += 1
        raise requests.ConnectionError("Anki is offline")

    service = HoshiDictsMiningService(
        config_getter=lambda: _config(),
        invoke=unavailable,
        readiness_ttl_seconds=0,
    )

    first = service.mine(_request())
    second = service.mine(_request())

    assert first.status == "anki-unavailable"
    assert second.status == "anki-unavailable"
    assert attempts == 2


def test_failed_request_id_can_retry_without_creating_two_notes():
    fake_anki = FakeAnki()
    fake_anki.add_error = requests.ConnectionError("response lost")
    service, enqueued = _service(fake_anki)

    first = service.mine(_request())
    second = service.mine(_request())

    assert first.status == "anki-unavailable"
    assert second.status == "created"
    assert len(_calls(fake_anki, "addNote")) == 2
    assert enqueued == [(9001, "33333333-3333-4333-8333-333333333333")]


def test_concurrent_repeats_share_one_anki_creation():
    fake_anki = FakeAnki()
    add_started = threading.Event()
    release_add = threading.Event()
    original_invoke = fake_anki.invoke

    def delayed_invoke(action, **params):
        if action == "addNote":
            fake_anki.calls.append((action, params))
            add_started.set()
            assert release_add.wait(timeout=2)
            return fake_anki.added_note_id
        return original_invoke(action, **params)

    service, enqueued = _service(fake_anki, invoke=delayed_invoke)
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(service.mine, _request()) for _ in range(8)]
        assert add_started.wait(timeout=2)
        time.sleep(0.05)
        release_add.set()
        results = [future.result(timeout=2) for future in futures]

    assert {result.status for result in results} == {"created"}
    assert {result.note_id for result in results} == {9001}
    assert len(_calls(fake_anki, "addNote")) == 1
    assert enqueued == [(9001, "33333333-3333-4333-8333-333333333333")]


def test_media_failure_warns_but_preserves_text_note():
    fake_anki = FakeAnki()
    fake_anki.media_error = RuntimeError("media storage failed")
    service, _ = _service(fake_anki)
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 16).decode("ascii")
    request = _request(
        media=[
            {
                "dictionary_id": "dict-jitendex",
                "path": "images/meal.png",
                "mime_type": "image/png",
                "data_base64": png,
            }
        ]
    )

    result = service.mine(request)

    assert result.status == "created"
    assert result.warnings == ("Dictionary media could not be stored.",)
    [add_call] = _calls(fake_anki, "addNote")
    assert add_call["note"]["fields"]["Glossary"] == "to eat"


def test_renderer_sentence_is_bounded_fallback_when_line_id_cannot_resolve():
    fake_anki = FakeAnki()
    service, _ = _service(fake_anki, line_resolver=lambda _line_id: None)

    result = service.mine(_request(source_sentence="<b>fallback</b>"))

    assert result.status == "created"
    [add_call] = _calls(fake_anki, "addNote")
    assert add_call["note"]["fields"]["Sentence"] == "&lt;b&gt;fallback&lt;/b&gt;"


def test_same_idempotency_key_rejects_a_different_selected_glossary():
    fake_anki = FakeAnki()
    service, _ = _service(fake_anki)
    first = service.mine(_request())
    changed = _request(
        lookup={
            **_request()["lookup"],
            "glossary_id": "different",
            "glossary_text": "consume",
        }
    )

    second = service.mine(changed)

    assert first.status == "created"
    assert second.status == "failed"
    assert "idempotency" in second.message.lower()
    assert len(_calls(fake_anki, "addNote")) == 1
