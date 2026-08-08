from types import SimpleNamespace

import pytest
from flask import Flask

from GameSentenceMiner import hoshidicts_mining
from GameSentenceMiner.web import hoshidicts_api


def _profile(**overrides):
    profile = hoshidicts_mining.default_hoshidicts_mining_profile()
    profile.update(overrides)
    return profile


def _config():
    return SimpleNamespace(
        anki=SimpleNamespace(
            enabled=True,
            note_type="Mining",
            word_field="Expression",
            sentence_field="Sentence",
            custom_tags=["GSM"],
            tags_to_check=["mine"],
        )
    )


def _payload():
    return {
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


class FakeAnki:
    def __init__(self, fields=None, note_id=42, model_names=None, decks=None):
        self.fields = fields or [
            "Expression",
            "Reading",
            "Definition",
            "Sentence",
            "Frequency",
            "PitchAccent",
        ]
        self.note_id = note_id
        self.model_names = model_names or ["Mining"]
        self.decks = decks or ["Default", "Mining"]
        self.calls = []
        self.events = []

    def invoke(self, action, **kwargs):
        self.calls.append((action, kwargs))
        if action == "modelNames":
            return self.model_names
        if action == "modelFieldNames":
            return self.fields
        if action == "deckNames":
            return self.decks
        if action == "addNote":
            return self.note_id
        raise AssertionError(action)

    def _prepare_anki_tags(self):
        return ["GSM", "Game::Test"]

    def handle_incoming_anki_event(self, payload):
        self.events.append(payload)
        return "note_added"


def _wire(monkeypatch, fake_anki, profile=None):
    hoshidicts_mining._clear_mining_status_cache()
    monkeypatch.setattr(hoshidicts_mining, "get_config", _config)
    monkeypatch.setattr(
        hoshidicts_mining,
        "load_hoshidicts_mining_profile",
        lambda: profile or _profile(),
    )
    monkeypatch.setattr(
        hoshidicts_mining,
        "_get_anki_module",
        lambda: fake_anki,
    )


def test_profile_defaults_and_normalization(tmp_path):
    missing = tmp_path / "missing.json"
    assert hoshidicts_mining.load_hoshidicts_mining_profile(missing) == _profile()

    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "enabled": False,
            "deck": " Mining ",
            "model": " Custom ",
            "fields": {"reading": " Kana "},
            "disabledFields": ["pitch", "pitch", "frequency"],
            "tags": [" hoshidicts ", "HOSHIDICTS", "custom"],
            "duplicatePolicy": "allow",
        }
    )
    assert profile["enabled"] is False
    assert profile["deck"] == "Mining"
    assert profile["model"] == "Custom"
    assert profile["fields"]["reading"] == "Kana"
    assert profile["disabledFields"] == ["pitch", "frequency"]
    assert profile["tags"] == ["hoshidicts", "custom"]
    assert profile["duplicatePolicy"] == "allow"


def test_status_inherits_gsm_fields_and_auto_maps_dictionary_fields(monkeypatch):
    fake_anki = FakeAnki()
    _wire(monkeypatch, fake_anki)

    status = hoshidicts_mining.get_hoshidicts_mining_status()

    assert status == {
        "available": True,
        "deck": "Default",
        "model": "Mining",
        "fields": {
            "expression": "Expression",
            "reading": "Reading",
            "definition": "Definition",
            "sentence": "Sentence",
            "frequency": "Frequency",
            "pitch": "PitchAccent",
        },
        "unmappedFields": [],
    }


def test_options_load_anki_choices_and_suggest_kiku_lapis_fields(monkeypatch):
    fields = [
        "Expression",
        "ExpressionFurigana",
        "ExpressionReading",
        "MainDefinition",
        "Glossary",
        "Sentence",
        "PitchPosition",
        "Frequency",
        "MiscInfo",
    ]
    fake_anki = FakeAnki(
        fields=fields,
        model_names=["Basic", "Kiku"],
        decks=["Default", "Japanese"],
    )
    _wire(monkeypatch, fake_anki, _profile(model="Kiku", deck="Japanese"))

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options == {
        "connected": True,
        "gsmAnkiEnabled": True,
        "decks": ["Default", "Japanese"],
        "noteTypes": ["Basic", "Kiku"],
        "selectedNoteType": "Kiku",
        "fields": fields,
        "suggestedFields": {
            "expression": "Expression",
            "reading": "ExpressionReading",
            "definition": "Glossary",
            "sentence": "Sentence",
            "frequency": "Frequency",
            "pitch": "PitchPosition",
        },
        "resolvedFields": {
            "expression": "Expression",
            "reading": "ExpressionReading",
            "definition": "Glossary",
            "sentence": "Sentence",
            "frequency": "Frequency",
            "pitch": "PitchPosition",
        },
        "warnings": [],
        "error": None,
    }
    assert (
        "modelFieldNames",
        {
            "timeout": hoshidicts_mining.ANKI_CONNECT_TIMEOUT_SECONDS,
            "modelName": "Kiku",
        },
    ) in fake_anki.calls


def test_options_accept_a_selected_note_type_and_detect_a_renamed_lapis_schema(monkeypatch):
    fields = [
        "Expression",
        "ExpressionReading",
        "MainDefinition",
        "Glossary",
        "Sentence",
        "Frequency",
        "PitchPosition",
    ]
    fake_anki = FakeAnki(
        fields=fields,
        model_names=["Mining", "My Japanese Card"],
    )
    _wire(monkeypatch, fake_anki)

    options = hoshidicts_mining.get_hoshidicts_mining_options("my japanese card")

    assert options["connected"] is True
    assert options["gsmAnkiEnabled"] is True
    assert options["selectedNoteType"] == "My Japanese Card"
    assert options["fields"] == fields
    assert options["suggestedFields"]["definition"] == "Glossary"
    assert options["suggestedFields"]["pitch"] == "PitchPosition"


def test_options_probe_ankiconnect_when_gsm_anki_is_disabled(monkeypatch):
    fake_anki = FakeAnki()
    config = _config()
    config.anki.enabled = False
    monkeypatch.setattr(hoshidicts_mining, "get_config", lambda: config)
    monkeypatch.setattr(hoshidicts_mining, "load_hoshidicts_mining_profile", _profile)
    monkeypatch.setattr(hoshidicts_mining, "_get_anki_module", lambda: fake_anki)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["connected"] is True
    assert options["gsmAnkiEnabled"] is False
    assert options["noteTypes"] == ["Mining"]
    assert options["decks"] == ["Default", "Mining"]
    assert options["fields"] == fake_anki.fields
    assert options["error"] == "GSM Anki integration is disabled."
    assert [action for action, _kwargs in fake_anki.calls] == [
        "modelNames",
        "deckNames",
        "modelFieldNames",
    ]


def test_options_report_an_ankiconnect_failure(monkeypatch):
    class OfflineAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            raise RuntimeError("connection refused")

    _wire(monkeypatch, OfflineAnki())

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["connected"] is False
    assert options["gsmAnkiEnabled"] is True
    assert options["error"] == "Could not connect to Anki through GSM: connection refused"


def test_options_keep_partial_ankiconnect_results(monkeypatch):
    class PartialAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "deckNames":
                self.calls.append((action, kwargs))
                raise TimeoutError("deck lookup timed out")
            return super().invoke(action, **kwargs)

    fake_anki = PartialAnki(model_names=["Mining"])
    _wire(monkeypatch, fake_anki)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["connected"] is True
    assert options["noteTypes"] == ["Mining"]
    assert options["decks"] == []
    assert options["fields"] == fake_anki.fields
    assert options["resolvedFields"]["expression"] == "Expression"
    assert options["error"] is None
    assert options["warnings"] == ["Could not load Anki decks: deck lookup timed out"]


def test_mining_preserves_dictionary_metadata_and_queues_gsm_enrichment(monkeypatch):
    fake_anki = FakeAnki()
    _wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result == {"success": True, "noteId": 42, "unmappedFields": []}
    add_note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert add_note["deckName"] == "Default"
    assert add_note["modelName"] == "Mining"
    assert add_note["fields"]["Expression"] == "食べる"
    assert add_note["fields"]["Reading"] == "たべる"
    assert add_note["fields"]["Sentence"] == "昨日、<b>食べた</b>。"
    assert "JMdict" in add_note["fields"]["Definition"]
    assert "to eat" in add_note["fields"]["Definition"]
    assert "consume" in add_note["fields"]["Definition"]
    assert "past" in add_note["fields"]["Definition"]
    assert "123 ★" in add_note["fields"]["Frequency"]
    assert "LHL" in add_note["fields"]["PitchAccent"]
    assert "nasal 1" in add_note["fields"]["PitchAccent"]
    assert "tabeɾɯ" in add_note["fields"]["PitchAccent"]
    assert add_note["options"] == {"allowDuplicate": False}
    assert add_note["tags"] == [
        "GSM",
        "Game::Test",
        "mine",
        "hoshidicts",
        "overlay",
    ]
    assert fake_anki.events == [
        {
            "event": "note_added",
            "session_id": "hoshidicts",
            "note_id": 42,
        }
    ]


def test_mining_formats_kiku_lapis_pitch_position_as_numeric_positions(monkeypatch):
    fields = [
        "Expression",
        "ExpressionReading",
        "Glossary",
        "Sentence",
        "Frequency",
        "PitchPosition",
    ]
    fake_anki = FakeAnki(fields=fields, model_names=["Kiku"])
    profile = _profile(
        model="Kiku",
        fields={key: value for key, value in hoshidicts_mining.KIKU_LAPIS_FIELD_MAP.items()},
    )
    _wire(monkeypatch, fake_anki, profile)

    hoshidicts_mining.mine_hoshidicts_note(_payload())

    note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert note["fields"]["PitchPosition"] == "2"
    assert "LHL" not in note["fields"]["PitchPosition"]


def test_mining_automatically_maps_kiku_lapis_without_saved_field_overrides(monkeypatch):
    fields = [
        "Expression",
        "ExpressionReading",
        "Glossary",
        "Sentence",
        "Frequency",
        "PitchPosition",
    ]
    fake_anki = FakeAnki(fields=fields, model_names=["Kiku"])
    config = _config()
    config.anki.note_type = "Kiku"
    _wire(monkeypatch, fake_anki)
    monkeypatch.setattr(hoshidicts_mining, "get_config", lambda: config)

    hoshidicts_mining.mine_hoshidicts_note(_payload())

    note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert note["fields"]["ExpressionReading"] == "たべる"
    assert "Reading" not in note["fields"]
    assert note["fields"]["Glossary"]
    assert note["fields"]["PitchPosition"] == "2"


def test_mining_honors_explicitly_disabled_fields(monkeypatch):
    fake_anki = FakeAnki()
    _wire(
        monkeypatch,
        fake_anki,
        _profile(disabledFields=["reading", "frequency", "pitch"]),
    )

    options = hoshidicts_mining.get_hoshidicts_mining_options()
    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert options["suggestedFields"]["reading"] == "Reading"
    assert options["resolvedFields"]["reading"] == ""
    note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert "Reading" not in note["fields"]
    assert "Frequency" not in note["fields"]
    assert "PitchAccent" not in note["fields"]
    assert result["unmappedFields"] == []


def test_mining_reports_optional_data_not_supported_by_the_model(monkeypatch):
    fake_anki = FakeAnki(fields=["Expression", "Sentence"])
    _wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result["unmappedFields"] == [
        "reading",
        "definition",
        "frequency",
        "pitch",
    ]
    add_note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert add_note["fields"] == {
        "Expression": "食べる",
        "Sentence": "昨日、<b>食べた</b>。",
    }


def test_mining_honors_profile_overrides(monkeypatch):
    fake_anki = FakeAnki(fields=["Front", "Kana", "Back", "Context", "Rank", "Accent"])
    profile = _profile(
        deck="Mining",
        model="Custom",
        fields={
            "expression": "Front",
            "reading": "Kana",
            "definition": "Back",
            "sentence": "Context",
            "frequency": "Rank",
            "pitch": "Accent",
        },
        tags=["dictionary"],
        duplicatePolicy="allow",
    )
    _wire(monkeypatch, fake_anki, profile)

    hoshidicts_mining.mine_hoshidicts_note(_payload())

    add_note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert add_note["deckName"] == "Mining"
    assert add_note["modelName"] == "Custom"
    assert set(add_note["fields"]) == {
        "Front",
        "Kana",
        "Back",
        "Context",
        "Rank",
        "Accent",
    }
    assert add_note["options"] == {"allowDuplicate": True}
    assert "dictionary" in add_note["tags"]


def test_status_deduplicates_short_lived_ankiconnect_checks(monkeypatch):
    fake_anki = FakeAnki()
    _wire(monkeypatch, fake_anki)

    first = hoshidicts_mining.get_hoshidicts_mining_status()
    second = hoshidicts_mining.get_hoshidicts_mining_status()

    assert first == second
    assert [action for action, _kwargs in fake_anki.calls] == [
        "modelFieldNames",
        "deckNames",
    ]


def test_validation_uses_the_overlay_utf16_offset():
    payload = _payload()
    payload["sentence"] = "😀食べた"
    payload["matchOffset"] = 2

    validated = hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    assert validated["matched"] == "食べた"

    payload["matchOffset"] = 1
    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="splits a Unicode character",
    ):
        hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    payload = _payload()
    payload["sentence"] = "<食べた&"
    payload["matchOffset"] = 1
    validated = hoshidicts_mining.validate_hoshidicts_mining_request(payload)
    assert hoshidicts_mining._highlight_sentence_match(validated) == ("&lt;<b>食べた</b>&amp;")


def test_validation_preserves_decimal_and_nullable_frequency_displays():
    payload = _payload()
    payload["result"]["term"]["frequencies"][0]["frequencies"] = [
        {"value": 12.75, "displayValue": None},
        {"value": 8, "displayValue": ""},
        {"value": -1.5, "displayValue": "<rare>"},
    ]

    validated = hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    assert validated["term"]["frequencies"][0]["frequencies"] == [
        {"value": 12.75, "displayValue": None},
        {"value": 8, "displayValue": ""},
        {"value": -1.5, "displayValue": "<rare>"},
    ]
    assert hoshidicts_mining._frequency_html(validated) == ("<b>Frequency</b>: 12.75, , &lt;rare&gt;")


@pytest.mark.parametrize(
    "value",
    [True, float("nan"), float("inf"), float("-inf")],
)
def test_validation_rejects_non_finite_or_boolean_frequency_values(value):
    payload = _payload()
    payload["result"]["term"]["frequencies"][0]["frequencies"] = [{"value": value, "displayValue": None}]

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="frequency is invalid",
    ):
        hoshidicts_mining.validate_hoshidicts_mining_request(payload)


def test_duplicate_rejection_returns_a_conflict(monkeypatch):
    fake_anki = FakeAnki(note_id=None)
    _wire(monkeypatch, fake_anki)

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="already exists",
    ) as error:
        hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert error.value.status_code == 409
    assert fake_anki.events == []


def test_hoshidicts_routes_expose_status_and_mining_errors(monkeypatch):
    app = Flask(__name__)
    hoshidicts_api.register_hoshidicts_api_routes(app)
    monkeypatch.setattr(
        hoshidicts_api,
        "get_hoshidicts_mining_status",
        lambda: {"available": True},
    )
    monkeypatch.setattr(
        hoshidicts_api,
        "get_hoshidicts_mining_options",
        lambda model=None: {"connected": True, "selectedNoteType": model or "Mining"},
    )
    monkeypatch.setattr(
        hoshidicts_api,
        "mine_hoshidicts_note",
        lambda _payload: (_ for _ in ()).throw(hoshidicts_mining.HoshidictsMiningError("duplicate", 409)),
    )

    client = app.test_client()
    assert client.get("/api/hoshidicts/mining/status").get_json() == {"available": True}
    assert client.get("/api/hoshidicts/mining/options?model=Kiku").get_json() == {
        "connected": True,
        "selectedNoteType": "Kiku",
    }
    response = client.post("/api/hoshidicts/mine", json={})
    assert response.status_code == 409
    assert response.get_json() == {"success": False, "error": "duplicate"}
