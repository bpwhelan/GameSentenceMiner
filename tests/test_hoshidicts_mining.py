import json
from types import SimpleNamespace

import pytest
from flask import Flask

from GameSentenceMiner import hoshidicts_audio, hoshidicts_mining
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


_AUDIO_MEDIA = hoshidicts_audio.AudioMedia(
    data=b"ID3pronunciation",
    content_type="audio/mpeg",
    extension="mp3",
)


def _wire_audio(
    monkeypatch,
    fake_anki,
    *,
    mining_profile=None,
    audio_profile=None,
    media=_AUDIO_MEDIA,
    error=None,
    resolver=None,
):
    _wire(monkeypatch, fake_anki, mining_profile)
    audio_profile = audio_profile or hoshidicts_audio.default_hoshidicts_audio_profile()
    monkeypatch.setattr(
        hoshidicts_audio,
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


def test_profile_defaults_and_normalization(tmp_path):
    missing = tmp_path / "missing.json"
    assert hoshidicts_mining.load_hoshidicts_mining_profile(missing) == _profile()
    saved = tmp_path / "mining-profile.json"
    saved.write_text(json.dumps(_profile(fields={"audio": "WordAudio"})), encoding="utf-8")
    assert hoshidicts_mining.load_hoshidicts_mining_profile(saved)["fields"]["audio"] == "WordAudio"

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
    assert profile["version"] == 2
    assert profile["checkForDuplicates"] is True
    assert profile["duplicateScope"] == "collection"
    assert profile["duplicateScopeCheckAllModels"] is False
    assert profile["duplicateBehavior"] == "new"
    assert set(profile["fieldOverwriteModes"].values()) == {"coalesce"}


def test_profile_normalizes_yomitan_duplicate_settings_and_overwrite_modes():
    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 2,
            "checkForDuplicates": False,
            "duplicateScope": "deck-root",
            "duplicateScopeCheckAllModels": True,
            "duplicateBehavior": "overwrite",
            "fieldOverwriteModes": {
                "expression": "overwrite",
                "reading": "skip",
                "definition": "append",
                "sentence": "prepend",
                "frequency": "coalesce-new",
            },
        }
    )

    assert profile["checkForDuplicates"] is False
    assert profile["duplicateScope"] == "deck-root"
    assert profile["duplicateScopeCheckAllModels"] is True
    assert profile["duplicateBehavior"] == "overwrite"
    assert profile["fieldOverwriteModes"] == {
        "expression": "overwrite",
        "reading": "skip",
        "definition": "append",
        "sentence": "prepend",
        "frequency": "coalesce-new",
        "pitch": "coalesce",
        "audio": "coalesce",
    }


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"duplicateScope": "note"}, "duplicate scope"),
        ({"duplicateBehavior": "allow"}, "duplicate behavior"),
        (
            {"fieldOverwriteModes": {"expression": "replace"}},
            "overwrite mode",
        ),
    ],
)
def test_profile_rejects_invalid_duplicate_settings(overrides, message):
    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match=message):
        hoshidicts_mining.normalize_hoshidicts_mining_profile(overrides)


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
            "audio": "",
        },
        "unmappedFields": ["audio"],
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
            "audio": "",
        },
        "resolvedFields": {
            "expression": "Expression",
            "reading": "ExpressionReading",
            "definition": "Glossary",
            "sentence": "Sentence",
            "frequency": "Frequency",
            "pitch": "PitchPosition",
            "audio": "",
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

    assert result == {
        "success": True,
        "noteId": 42,
        "unmappedFields": ["audio"],
        "audio": {"status": "skipped"},
    }
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
    assert list(add_note["fields"]) == fake_anki.fields
    assert add_note["options"] == {
        "allowDuplicate": False,
        "duplicateScope": "collection",
        "duplicateScopeOptions": {
            "deckName": None,
            "checkChildren": False,
            "checkAllModels": False,
        },
    }
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
    assert result["unmappedFields"] == ["audio"]


def test_mining_reports_optional_data_not_supported_by_the_model(monkeypatch):
    fake_anki = FakeAnki(fields=["Expression", "Sentence"])
    _wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result["unmappedFields"] == [
        "reading",
        "definition",
        "frequency",
        "pitch",
        "audio",
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
        duplicateBehavior="new",
        duplicateScope="deck-root",
        duplicateScopeCheckAllModels=True,
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
    assert add_note["options"] == {
        "allowDuplicate": True,
        "duplicateScope": "deck",
        "duplicateScopeOptions": {
            "deckName": "Mining",
            "checkChildren": True,
            "checkAllModels": True,
        },
    }
    assert "dictionary" in add_note["tags"]


def test_mining_stores_selected_pronunciation_after_note_creation(monkeypatch):
    fake_anki = FakeAnki(fields=[*FakeAnki().fields, "WordAudio"])
    audio_profile = hoshidicts_audio.default_hoshidicts_audio_profile()

    def get_mining_audio(term, reading, selection, *, profile):
        assert (term, reading) == ("食べる", "たべる")
        assert selection == {
            "sourceId": "jisho",
            "candidateIndex": 1,
            "candidateId": "a" * 64,
        }
        assert profile is audio_profile
        return _AUDIO_MEDIA

    _wire_audio(
        monkeypatch,
        fake_anki,
        audio_profile=audio_profile,
        resolver=get_mining_audio,
    )
    payload = _payload()
    payload["audioSelection"] = {
        "sourceId": "jisho",
        "candidateIndex": 1,
        "candidateId": "a" * 64,
    }
    payload["result"]["term"]["expression"] = " 食べる "
    payload["result"]["term"]["reading"] = " たべる "

    result = hoshidicts_mining.mine_hoshidicts_note(payload)

    assert result["audio"]["status"] == "stored"
    assert result["audio"]["filename"].startswith("gsm_hoshidicts_")
    actions = [action for action, _kwargs in fake_anki.calls]
    assert actions.index("addNote") < actions.index("storeMediaFile") < actions.index("updateNoteFields")
    stored = next(kwargs for action, kwargs in fake_anki.calls if action == "storeMediaFile")
    assert stored["filename"] == result["audio"]["filename"]
    assert stored["data"] == "SUQzcHJvbnVuY2lhdGlvbg=="
    updated = next(kwargs for action, kwargs in fake_anki.calls if action == "updateNoteFields")
    assert updated["note"] == {
        "id": 42,
        "fields": {"WordAudio": f"[sound:{result['audio']['filename']}]"},
    }


def test_mining_appends_audio_when_the_field_already_contains_text(monkeypatch):
    fake_anki = FakeAnki(fields=["Front", "Sentence"])
    profile = _profile(
        model="Custom",
        fields={
            "expression": "Front",
            "reading": "",
            "definition": "",
            "sentence": "Sentence",
            "frequency": "",
            "pitch": "",
            "audio": "Front",
        },
        disabledFields=["reading", "definition", "frequency", "pitch"],
    )
    _wire_audio(monkeypatch, fake_anki, mining_profile=profile)

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    updated = next(kwargs for action, kwargs in fake_anki.calls if action == "updateNoteFields")
    assert updated["note"]["fields"]["Front"] == (f"食べる<br>[sound:{result['audio']['filename']}]")


def test_mining_audio_unavailable_is_nonfatal(monkeypatch):
    fake_anki = FakeAnki(fields=[*FakeAnki().fields, "PronunciationAudio"])
    _wire_audio(
        monkeypatch,
        fake_anki,
        error=hoshidicts_audio.HoshidictsAudioError("No pronunciation audio is available.", 404),
    )

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result["success"] is True
    assert result["audio"] == {
        "status": "unavailable",
        "warning": "No pronunciation audio is available.",
    }
    assert [action for action, _kwargs in fake_anki.calls if action in {"storeMediaFile", "updateNoteFields"}] == []
    assert fake_anki.events[-1]["note_id"] == 42


def test_mining_audio_store_failure_is_nonfatal(monkeypatch):
    class StoreFailureAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "storeMediaFile":
                self.calls.append((action, kwargs))
                raise RuntimeError("media collection is locked")
            return super().invoke(action, **kwargs)

    fake_anki = StoreFailureAnki(fields=[*FakeAnki().fields, "Pronunciation"])
    _wire_audio(monkeypatch, fake_anki)

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result["success"] is True
    assert result["audio"]["status"] == "failed"
    assert "media collection is locked" in result["audio"]["warning"]
    assert fake_anki.events[-1]["note_id"] == 42


def test_mining_audio_disabled_is_skipped_without_resolution(monkeypatch):
    fake_anki = FakeAnki(fields=[*FakeAnki().fields, "WordAudio"])
    audio_profile = hoshidicts_audio.default_hoshidicts_audio_profile()
    audio_profile["enabled"] = False

    def unexpected_resolution(*_args, **_kwargs):
        raise AssertionError("disabled audio must not resolve")

    _wire_audio(
        monkeypatch,
        fake_anki,
        audio_profile=audio_profile,
        resolver=unexpected_resolution,
    )

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result["audio"] == {"status": "skipped"}


def test_mining_auto_maps_standard_audio_but_not_sentence_audio(monkeypatch):
    fake_anki = FakeAnki(fields=[*FakeAnki().fields, "Audio", "SentenceAudio"])
    _wire_audio(monkeypatch, fake_anki)

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result["audio"]["status"] == "stored"
    updated = next(kwargs for action, kwargs in fake_anki.calls if action == "updateNoteFields")
    assert updated["note"]["fields"] == {"Audio": f"[sound:{result['audio']['filename']}]"}
    assert "SentenceAudio" not in updated["note"]["fields"]


def test_duplicate_note_rejection_happens_before_audio_download(monkeypatch):
    class DuplicateAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "addNote":
                self.calls.append((action, kwargs))
                raise RuntimeError("cannot create note because it is a duplicate")
            return super().invoke(action, **kwargs)

    fake_anki = DuplicateAnki(fields=[*FakeAnki().fields, "Pronunciation"])
    called = False

    def get_mining_audio(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("audio must not be resolved for a rejected note")

    _wire_audio(monkeypatch, fake_anki, resolver=get_mining_audio)

    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match="already exists"):
        hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert called is False


def test_mining_audio_selection_validation_rejects_urls_and_bad_indexes():
    payload = _payload()
    payload["audioSelection"] = {
        "sourceId": "jisho",
        "candidateIndex": 0,
        "url": "https://attacker.test/audio.mp3",
    }
    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match="audio selection"):
        hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    payload["audioSelection"] = {"sourceId": "jisho", "candidateIndex": True}
    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match="audio selection"):
        hoshidicts_mining.validate_hoshidicts_mining_request(payload)


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
    class DuplicateAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "addNote":
                self.calls.append((action, kwargs))
                raise RuntimeError("cannot create note because it is a duplicate")
            return super().invoke(action, **kwargs)

    fake_anki = DuplicateAnki()
    _wire(monkeypatch, fake_anki)

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="already exists",
    ) as error:
        hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert error.value.status_code == 409
    assert fake_anki.events == []


def test_null_add_note_result_is_not_misclassified_as_a_duplicate(monkeypatch):
    fake_anki = FakeAnki(note_id=None)
    _wire(monkeypatch, fake_anki)

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="did not return a note ID",
    ) as error:
        hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert error.value.status_code == 502
    assert fake_anki.events == []


def test_duplicate_check_uses_first_model_field_and_error_detail(monkeypatch):
    class DetailAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                return [
                    {"canAdd": True, "error": None},
                    {
                        "canAdd": False,
                        "error": "cannot create note because it is a duplicate",
                    },
                    {"canAdd": False, "error": "first field is empty"},
                ]
            return super().invoke(action, **kwargs)

    fields = ["Sentence", "Expression", "Reading", "Definition", "Frequency", "PitchAccent"]
    fake_anki = DetailAnki(fields=fields)
    _wire(monkeypatch, fake_anki)
    notes = [_payload(), _payload(), _payload()]

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": notes})

    assert result == {
        "success": True,
        "checkForDuplicates": True,
        "duplicateBehavior": "prevent",
        "results": [
            {"state": "addable", "canAdd": True, "duplicate": False},
            {"state": "duplicate", "canAdd": False, "duplicate": True},
            {
                "state": "invalid",
                "canAdd": False,
                "duplicate": False,
                "error": "first field is empty",
            },
        ],
    }
    check_notes = next(kwargs["notes"] for action, kwargs in fake_anki.calls if action == "canAddNotesWithErrorDetail")
    assert [list(note["fields"]) for note in check_notes] == [["Sentence"]] * 3
    assert check_notes[0]["fields"]["Sentence"] == "昨日、<b>食べた</b>。"
    assert check_notes[0]["options"] == {
        "allowDuplicate": False,
        "duplicateScope": "collection",
        "duplicateScopeOptions": {
            "deckName": None,
            "checkChildren": False,
            "checkAllModels": False,
        },
    }


def test_duplicate_check_still_detects_duplicates_when_new_notes_are_allowed(monkeypatch):
    class DetailAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                assert kwargs["notes"][0]["options"]["allowDuplicate"] is False
                return [
                    {
                        "canAdd": False,
                        "error": "cannot create note because it is a duplicate",
                    }
                ]
            return super().invoke(action, **kwargs)

    fake_anki = DetailAnki()
    _wire(monkeypatch, fake_anki, _profile(duplicateBehavior="new"))

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [_payload()]})

    assert result == {
        "success": True,
        "checkForDuplicates": True,
        "duplicateBehavior": "new",
        "results": [
            {"state": "duplicate", "canAdd": True, "duplicate": True},
        ],
    }


def test_duplicate_check_can_be_disabled_without_calling_ankiconnect(monkeypatch):
    fake_anki = FakeAnki()
    _wire(
        monkeypatch,
        fake_anki,
        _profile(checkForDuplicates=False, duplicateBehavior="prevent"),
    )

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [_payload()]})

    assert result == {
        "success": True,
        "checkForDuplicates": False,
        "duplicateBehavior": "prevent",
        "results": [
            {"state": "addable", "canAdd": True, "duplicate": False},
        ],
    }
    assert not any(action in {"canAddNotes", "canAddNotesWithErrorDetail"} for action, _kwargs in fake_anki.calls)


@pytest.mark.parametrize(
    ("mode", "existing", "new", "expected"),
    [
        ("overwrite", "old", "new", "new"),
        ("skip", "old", "new", "old"),
        ("append", "old", "new", "oldnew"),
        ("prepend", "old", "new", "newold"),
        ("coalesce", "old", "new", "old"),
        ("coalesce", "", "new", "new"),
        ("coalesce-new", "old", "new", "new"),
        ("coalesce-new", "old", "", "old"),
    ],
)
def test_yomitan_overwrite_field_modes(mode, existing, new, expected):
    assert hoshidicts_mining._overwrite_field(existing, new, mode) == expected


def test_overwrite_mode_can_clear_a_mapped_field_when_the_new_value_is_empty():
    profile = _profile()
    profile["fieldOverwriteModes"]["reading"] = "overwrite"
    fields = {key: "" for key in hoshidicts_mining.FIELD_KEYS}
    fields["expression"] = "Expression"
    fields["reading"] = "Reading"
    resolved = {"profile": profile, "fields": fields}

    overwritten = hoshidicts_mining._overwritten_note_fields(
        {"fields": {"Expression": "食べる"}},
        {"Expression": "old expression", "Reading": "old reading"},
        resolved,
    )

    assert overwritten == {"Expression": "old expression", "Reading": ""}


def test_mining_overwrites_first_same_type_duplicate_in_exact_deck(monkeypatch):
    class OverwriteAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                return [
                    {
                        "canAdd": False,
                        "error": "cannot create note because it is a duplicate",
                    }
                ]
            if action == "findNotes":
                self.calls.append((action, kwargs))
                assert kwargs["query"] == '"deck:Mining" "expression:食べる"'
                return [41, 42]
            if action == "notesInfo":
                self.calls.append((action, kwargs))
                return [
                    {
                        "noteId": 41,
                        "modelName": "Mining",
                        "cards": [410],
                        "fields": {
                            field: {"value": f"child {field}", "order": index}
                            for index, field in enumerate(self.fields)
                        },
                    },
                    {
                        "noteId": 42,
                        "modelName": "Mining",
                        "cards": [420],
                        "fields": {
                            "Expression": {"value": "old expression", "order": 0},
                            "Reading": {"value": "old reading", "order": 1},
                            "Definition": {"value": "old definition", "order": 2},
                            "Sentence": {"value": "old sentence", "order": 3},
                            "Frequency": {"value": "old frequency", "order": 4},
                            "PitchAccent": {"value": "old pitch", "order": 5},
                        },
                    },
                ]
            if action == "cardsInfo":
                self.calls.append((action, kwargs))
                return [
                    {"cardId": 410, "note": 41, "deckName": "Mining::Child"},
                    {"cardId": 420, "note": 42, "deckName": "Mining"},
                ]
            if action == "addNote":
                raise AssertionError("a duplicate note must be updated, not added")
            return super().invoke(action, **kwargs)

    fake_anki = OverwriteAnki(decks=["Default", "Mining", "Mining::Child"])
    overwrite_modes = {
        **_profile()["fieldOverwriteModes"],
        "expression": "overwrite",
        "reading": "skip",
        "definition": "append",
        "sentence": "prepend",
        "frequency": "coalesce-new",
        "pitch": "coalesce",
    }
    _wire(
        monkeypatch,
        fake_anki,
        _profile(
            deck="Mining",
            duplicateScope="deck",
            duplicateBehavior="overwrite",
            fieldOverwriteModes=overwrite_modes,
        ),
    )

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result["noteId"] == 42
    assert result["overwritten"] is True
    assert result["audio"] == {"status": "skipped"}
    update = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "updateNoteFields")
    assert update["id"] == 42
    assert update["fields"]["Expression"] == "食べる"
    assert update["fields"]["Reading"] == "old reading"
    assert update["fields"]["Definition"].startswith("old definition")
    assert update["fields"]["Sentence"].endswith("old sentence")
    assert update["fields"]["Frequency"] != "old frequency"
    assert update["fields"]["PitchAccent"] == "old pitch"
    assert fake_anki.events == []


def test_overwrite_rejects_a_duplicate_from_another_note_type(monkeypatch):
    class OtherModelAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                return [
                    {
                        "canAdd": False,
                        "error": "cannot create note because it is a duplicate",
                    }
                ]
            if action == "findNotes":
                self.calls.append((action, kwargs))
                return [99]
            if action == "notesInfo":
                self.calls.append((action, kwargs))
                return [
                    {
                        "noteId": 99,
                        "modelName": "Different note type",
                        "cards": [990],
                        "fields": {"Expression": {"value": "食べる", "order": 0}},
                    }
                ]
            if action in {"addNote", "updateNoteFields"}:
                raise AssertionError("a cross-note-type duplicate cannot be changed")
            return super().invoke(action, **kwargs)

    fake_anki = OtherModelAnki()
    _wire(
        monkeypatch,
        fake_anki,
        _profile(
            duplicateBehavior="overwrite",
            duplicateScopeCheckAllModels=True,
        ),
    )

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="different note type",
    ) as error:
        hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert error.value.status_code == 409


def test_duplicate_check_only_offers_overwrite_for_a_resolvable_note(monkeypatch):
    class OverwriteCheckAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                return [
                    {
                        "canAdd": False,
                        "error": "cannot create note because it is a duplicate",
                    }
                ]
            if action == "findNotes":
                self.calls.append((action, kwargs))
                return [42]
            if action == "notesInfo":
                self.calls.append((action, kwargs))
                return [
                    {
                        "noteId": 42,
                        "modelName": "Mining",
                        "cards": [420],
                        "fields": {"Expression": {"value": "食べる", "order": 0}},
                    }
                ]
            return super().invoke(action, **kwargs)

    fake_anki = OverwriteCheckAnki()
    _wire(monkeypatch, fake_anki, _profile(duplicateBehavior="overwrite"))

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [_payload()]})

    assert result == {
        "success": True,
        "checkForDuplicates": True,
        "duplicateBehavior": "overwrite",
        "results": [
            {
                "state": "duplicate",
                "canAdd": True,
                "duplicate": True,
                "action": "overwrite",
            }
        ],
    }


def test_overwrite_coalesce_preserves_existing_audio_without_downloading(monkeypatch):
    class AudioOverwriteAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                return [
                    {
                        "canAdd": False,
                        "error": "cannot create note because it is a duplicate",
                    }
                ]
            if action == "findNotes":
                self.calls.append((action, kwargs))
                return [42]
            if action == "notesInfo":
                self.calls.append((action, kwargs))
                return [
                    {
                        "noteId": 42,
                        "modelName": "Mining",
                        "cards": [420],
                        "fields": {
                            **{field: {"value": "", "order": index} for index, field in enumerate(self.fields)},
                            "Expression": {"value": "食べる", "order": 0},
                            "WordAudio": {
                                "value": "[sound:existing.mp3]",
                                "order": len(self.fields) - 1,
                            },
                        },
                    }
                ]
            return super().invoke(action, **kwargs)

    fake_anki = AudioOverwriteAnki(fields=[*FakeAnki().fields, "WordAudio"])

    def unexpected_audio(*_args, **_kwargs):
        raise AssertionError("coalesce must preserve existing audio without a download")

    _wire_audio(
        monkeypatch,
        fake_anki,
        mining_profile=_profile(duplicateBehavior="overwrite"),
        resolver=unexpected_audio,
    )

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result["overwritten"] is True
    assert result["audio"] == {"status": "preserved"}
    assert not any(action == "storeMediaFile" for action, _kwargs in fake_anki.calls)


def test_overwrite_append_adds_new_audio_after_existing_audio(monkeypatch):
    class AudioAppendAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                return [
                    {
                        "canAdd": False,
                        "error": "cannot create note because it is a duplicate",
                    }
                ]
            if action == "findNotes":
                self.calls.append((action, kwargs))
                return [42]
            if action == "notesInfo":
                self.calls.append((action, kwargs))
                return [
                    {
                        "noteId": 42,
                        "modelName": "Mining",
                        "cards": [420],
                        "fields": {
                            **{field: {"value": "", "order": index} for index, field in enumerate(self.fields)},
                            "Expression": {"value": "食べる", "order": 0},
                            "WordAudio": {
                                "value": "[sound:existing.mp3]",
                                "order": len(self.fields) - 1,
                            },
                        },
                    }
                ]
            return super().invoke(action, **kwargs)

    fake_anki = AudioAppendAnki(fields=[*FakeAnki().fields, "WordAudio"])
    profile = _profile(duplicateBehavior="overwrite")
    profile["fieldOverwriteModes"]["audio"] = "append"
    _wire_audio(monkeypatch, fake_anki, mining_profile=profile)

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert result["audio"]["status"] == "stored"
    audio_update = [
        kwargs["note"]
        for action, kwargs in fake_anki.calls
        if action == "updateNoteFields" and "WordAudio" in kwargs["note"]["fields"]
    ]
    assert audio_update == [
        {
            "id": 42,
            "fields": {"WordAudio": (f"[sound:existing.mp3][sound:{result['audio']['filename']}]")},
        }
    ]


def test_duplicate_check_falls_back_to_paired_can_add_notes_for_older_ankiconnect(monkeypatch):
    class LegacyAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                raise RuntimeError("unsupported action")
            if action == "canAddNotes":
                self.calls.append((action, kwargs))
                allow_duplicate = kwargs["notes"][0]["options"]["allowDuplicate"]
                return [True] if allow_duplicate else [False]
            return super().invoke(action, **kwargs)

    fake_anki = LegacyAnki()
    _wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [_payload()]})

    assert result["results"] == [{"state": "duplicate", "canAdd": False, "duplicate": True}]
    can_add_calls = [
        kwargs["notes"][0]["options"]["allowDuplicate"] for action, kwargs in fake_anki.calls if action == "canAddNotes"
    ]
    assert can_add_calls == [True, False]


def test_duplicate_check_does_not_hide_non_compatibility_errors(monkeypatch):
    class BrokenAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                raise RuntimeError("collection is unavailable")
            return super().invoke(action, **kwargs)

    fake_anki = BrokenAnki()
    _wire(monkeypatch, fake_anki)

    with pytest.raises(RuntimeError, match="collection is unavailable"):
        hoshidicts_mining.check_hoshidicts_notes({"notes": [_payload()]})

    assert not any(action == "canAddNotes" for action, _kwargs in fake_anki.calls)


def test_duplicate_check_rejects_oversized_batches(monkeypatch):
    fake_anki = FakeAnki()
    _wire(monkeypatch, fake_anki)

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="between 1 and 16",
    ):
        hoshidicts_mining.check_hoshidicts_notes({"notes": [_payload()] * 17})

    assert fake_anki.calls == []


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
    mining_calls = []

    def mine(payload):
        mining_calls.append(payload)
        raise hoshidicts_mining.HoshidictsMiningError("duplicate", 409)

    monkeypatch.setattr(hoshidicts_api, "mine_hoshidicts_note", mine)
    monkeypatch.setattr(
        hoshidicts_api,
        "check_hoshidicts_notes",
        lambda payload: {
            "success": True,
            "duplicateBehavior": "prevent",
            "results": [],
            "payload": payload,
        },
    )

    client = app.test_client()
    assert client.get("/api/hoshidicts/mining/status").get_json() == {"available": True}
    assert client.get("/api/hoshidicts/mining/options?model=Kiku").get_json() == {
        "connected": True,
        "selectedNoteType": "Kiku",
    }
    assert client.post("/api/hoshidicts/mining/check", json={"notes": []}).get_json() == {
        "success": True,
        "duplicateBehavior": "prevent",
        "results": [],
        "payload": {"notes": []},
    }
    response = client.post("/api/hoshidicts/mine", json={})
    assert response.status_code == 409
    assert response.get_json() == {
        "success": False,
        "error": "duplicate",
        "code": "duplicate",
    }
    assert mining_calls == [{}]
