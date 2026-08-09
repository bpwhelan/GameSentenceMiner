import json
import re
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


def _rich_jitendex_payload():
    payload = _payload()
    payload["result"]["term"]["glossaries"] = [
        {
            "dictionary": "Jitendex",
            "glossary": json.dumps(
                [
                    {
                        "type": "structured-content",
                        "content": [
                            {
                                "tag": "div",
                                "data": {
                                    "content": "sense-group",
                                    "senseNumber": "1",
                                    "source_index": "2",
                                },
                                "style": {
                                    "fontWeight": "700",
                                    "marginTop": 0.5,
                                },
                                "content": [
                                    {
                                        "tag": "span",
                                        "data": {"content": "part-of-speech"},
                                        "content": "pronoun",
                                    },
                                    {"tag": "br"},
                                    {
                                        "tag": "ruby",
                                        "content": [
                                            "吾輩",
                                            {"tag": "rt", "content": "わがはい"},
                                        ],
                                    },
                                    {
                                        "tag": "div",
                                        "data": {"content": "example-sentence-a"},
                                        "content": [
                                            "吾輩は猫である。",
                                            {
                                                "tag": "span",
                                                "data": {"content": "example-translation"},
                                                "content": "I am a cat.",
                                            },
                                        ],
                                    },
                                    {
                                        "tag": "a",
                                        "href": "?query=猫",
                                        "content": "猫",
                                    },
                                    {
                                        "tag": "a",
                                        "href": "https://example.com/entry",
                                        "content": "source",
                                    },
                                    {
                                        "tag": "p",
                                        "content": [
                                            {"tag": "code", "content": "code"},
                                            {"tag": "em", "content": "em"},
                                            {"tag": "small", "content": "small"},
                                            {"tag": "strong", "content": "strong"},
                                            {"tag": "sub", "content": "sub"},
                                            {"tag": "sup", "content": "sup"},
                                        ],
                                    },
                                ],
                            }
                        ],
                    }
                ],
                ensure_ascii=False,
            ),
            "definitionTags": "pn",
            "termTags": "common",
        },
        {
            "dictionary": "Jitendex",
            "glossary": "arrogant first-person pronoun",
            "definitionTags": "arch",
            "termTags": "",
        },
        {
            "dictionary": "JMdict",
            "glossary": "I; me\nself",
            "definitionTags": "pronoun",
            "termTags": "common",
        },
    ]
    payload["dictionaryStyles"] = [
        {
            "dictionary": "Jitendex",
            "styles": '[data-sc-content|="example-sentence"] { color: #c44; }',
        },
        {
            "dictionary": "JMdict",
            "styles": ".gloss-sc-li { font-style: italic; }",
        },
        {
            "dictionary": "Not selected",
            "styles": "span { display: none; }",
        },
    ]
    return payload


def _kiku_yomitan_parity_payload():
    return {
        "sentence": "ぶちかましてやれ！",
        "matchOffset": 0,
        "searchQuery": "ぶちかましてやれ",
        "popupSelectionText": "ぶちかまして",
        "documentTitle": "GSM Kiku parity",
        "dictionaryAliases": [
            {
                "dictionary": "Jitendex.org [2026-08-08]",
                "alias": "Jitendex",
            }
        ],
        "dictionaryMedia": [
            {
                "dictionary": "Jitendex.org [2026-08-08]",
                "path": "img/forms.jpeg",
                "mediaType": "image/jpeg",
                "dataBase64": "/9j/4AA=",
            }
        ],
        "dictionaryStyles": [
            {
                "dictionary": "Jitendex.org [2026-08-08]",
                "styles": '[data-sc-content="sense"] { color: #c44; }',
            },
            {
                "dictionary": "JMdict",
                "styles": ".gloss-sc-strong { font-weight: 700; }",
            },
        ],
        "result": {
            "matched": "ぶちかまして",
            "deinflected": "ぶちかます",
            "trace": [
                {"name": "-て", "description": "te-form"},
                {"name": "imperative", "description": "imperative"},
            ],
            "term": {
                "expression": "ぶちかます",
                "reading": "ぶちかます",
                "rules": "v5",
                "glossaries": [
                    {
                        "dictionary": "Jitendex.org [2026-08-08]",
                        "glossary": json.dumps(
                            {
                                "type": "structured-content",
                                "content": {
                                    "tag": "div",
                                    "data": {"content": "sense"},
                                    "content": [
                                        {"tag": "strong", "content": "to let someone have it"},
                                        {
                                            "type": "image",
                                            "path": "img/forms.jpeg",
                                            "width": 67,
                                            "height": 100,
                                        },
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        "definitionTags": "colloquial",
                        "termTags": "v5 common",
                    },
                    {
                        "dictionary": "JMdict",
                        "glossary": "to hit hard; to overwhelm",
                        "definitionTags": "slang",
                        "termTags": "common",
                    },
                ],
                "frequencies": [],
                "pitches": [
                    {
                        "dictionary": "Kanjium",
                        "pitches": [],
                        "transcriptions": ["bɯtɕikamasɯ"],
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
    assert profile["version"] == 3
    assert profile["fieldTemplates"] is None
    assert profile["checkForDuplicates"] is True
    assert profile["duplicateScope"] == "collection"
    assert profile["duplicateScopeCheckAllModels"] is False
    assert profile["duplicateBehavior"] == "new"
    assert set(profile["fieldOverwriteModes"].values()) == {"coalesce"}


def test_profile_v3_normalizes_target_field_templates_without_trimming_values():
    default_profile = hoshidicts_mining.default_hoshidicts_mining_profile()
    assert default_profile["version"] == 3
    assert default_profile["fieldTemplates"] is None

    migrated = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 2,
            "fields": {"expression": "Front"},
            "disabledFields": ["reading"],
            "fieldTemplates": {"Ignored": {"value": "x", "overwriteMode": "overwrite"}},
        }
    )
    assert migrated["version"] == 3
    assert migrated["fieldTemplates"] is None
    assert migrated["fields"]["expression"] == "Front"
    assert migrated["disabledFields"] == ["reading"]

    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 3,
            "fieldTemplates": {
                "Front": {
                    "value": "  x {expression}  ",
                    "overwriteMode": "overwrite",
                },
                "Extra": {"value": "", "overwriteMode": "append"},
            },
        }
    )
    assert profile["fieldTemplates"] == {
        "Front": {
            "value": "  x {expression}  ",
            "overwriteMode": "overwrite",
        },
        "Extra": {"value": "", "overwriteMode": "append"},
    }


def test_profile_v3_preserves_exact_case_sensitive_target_keys():
    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 3,
            "fieldTemplates": {
                " Front ": {"value": "one", "overwriteMode": "coalesce"},
                "front": {"value": "two", "overwriteMode": "append"},
            },
        }
    )

    assert list(profile["fieldTemplates"]) == [" Front ", "front"]
    assert profile["fieldTemplates"][" Front "]["value"] == "one"


@pytest.mark.parametrize(
    ("field_templates", "message"),
    [
        ([], "field templates"),
        ({"Front": "{expression}"}, "field template"),
        ({"Front": {}}, "field template"),
        (
            {"Front": {"value": "{expression}", "overwriteMode": "replace"}},
            "overwrite mode",
        ),
    ],
)
def test_profile_v3_rejects_invalid_target_field_templates(field_templates, message):
    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match=message):
        hoshidicts_mining.normalize_hoshidicts_mining_profile({"version": 3, "fieldTemplates": field_templates})


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

    legacy_options = {
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
    assert {key: options[key] for key in legacy_options} == legacy_options
    assert (
        "modelFieldNames",
        {
            "timeout": hoshidicts_mining.ANKI_CONNECT_TIMEOUT_SECONDS,
            "modelName": "Kiku",
        },
    ) in fake_anki.calls


def test_options_suggest_target_templates_for_every_model_field(monkeypatch):
    fields = [
        "Mystery",
        "ExpressionReading",
        "Glossary",
        "Sentence",
        "Frequency",
        "PitchPosition",
        "WordAudio",
        "Extra",
    ]
    fake_anki = FakeAnki(fields=fields)
    _wire(monkeypatch, fake_anki)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["suggestedFieldTemplates"] == {
        "Mystery": "{expression}",
        "ExpressionReading": "{reading}",
        "Glossary": "{glossary}",
        "Sentence": "{sentence}",
        "Frequency": "{frequency}",
        "PitchPosition": "{pitch-position}",
        "WordAudio": "{audio}",
        "Extra": "",
    }
    assert options["resolvedFieldTemplates"] == {
        field: {"value": value, "overwriteMode": "coalesce"}
        for field, value in options["suggestedFieldTemplates"].items()
    }


def test_options_fill_kiku_rich_fields_without_mapping_flag_or_picture_fields(monkeypatch):
    fields = [
        "Expression",
        "ExpressionFurigana",
        "ExpressionReading",
        "MainDefinition",
        "Glossary",
        "Sentence",
        "SentenceFurigana",
        "ExpressionAudio",
        "Frequency",
        "PitchPosition",
        "Flag",
        "Picture",
        "Sort",
    ]
    fake_anki = FakeAnki(fields=fields, model_names=["Kiku"])
    _wire(monkeypatch, fake_anki, _profile(model="Kiku"))

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["suggestedFieldTemplates"] == {
        "Expression": "{expression}",
        "ExpressionFurigana": "{furigana-plain}",
        "ExpressionReading": "{reading}",
        "MainDefinition": "{main-definition}",
        "Glossary": "{glossary}",
        "Sentence": "{sentence}",
        "SentenceFurigana": "{sentence-furigana-plain}",
        "ExpressionAudio": "{audio}",
        "Frequency": "{frequency}",
        "PitchPosition": "{pitch-position}",
        "Flag": "",
        "Picture": "",
        "Sort": "",
    }


def test_options_suggest_only_one_target_per_semantic_field(monkeypatch):
    fields = ["ID", "Expression", "Word", "Reading", "Kana", "Extra"]
    fake_anki = FakeAnki(fields=fields)
    _wire(monkeypatch, fake_anki)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["suggestedFieldTemplates"] == {
        "ID": "",
        "Expression": "{expression}",
        "Word": "",
        "Reading": "{reading}",
        "Kana": "",
        "Extra": "",
    }


@pytest.mark.parametrize(
    ("fields", "word_field", "sentence_field", "expected"),
    [
        (["Sentence"], "Sentence", "Sentence", "{expression}<br>{sentence}"),
        (["Reading"], "Reading", "Sentence", "{expression}<br>{reading}"),
    ],
)
def test_options_compose_inherited_config_semantics_on_an_alias_target(
    monkeypatch,
    fields,
    word_field,
    sentence_field,
    expected,
):
    fake_anki = FakeAnki(fields=fields)
    config = _config()
    config.anki.word_field = word_field
    config.anki.sentence_field = sentence_field
    _wire(monkeypatch, fake_anki)
    monkeypatch.setattr(hoshidicts_mining, "get_config", lambda: config)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["suggestedFieldTemplates"] == {fields[0]: expected}
    assert options["resolvedFieldTemplates"] == {fields[0]: {"value": expected, "overwriteMode": "coalesce"}}


def test_options_match_an_atypically_ordered_first_field_before_using_fallback(monkeypatch):
    fake_anki = FakeAnki(fields=["Reading", "Expression", "Extra"])
    _wire(monkeypatch, fake_anki)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["suggestedFieldTemplates"] == {
        "Reading": "{reading}",
        "Expression": "{expression}",
        "Extra": "",
    }


def test_options_use_authoritative_templates_and_warn_about_stale_targets(monkeypatch):
    fields = ["Front", "Reading", "Extra"]
    fake_anki = FakeAnki(fields=fields)
    profile = _profile(
        fieldTemplates={
            "Front": {
                "value": "x {expression}",
                "overwriteMode": "overwrite",
            },
            "Reading": {"value": "", "overwriteMode": "append"},
            "Removed": {"value": "stale", "overwriteMode": "coalesce"},
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["suggestedFieldTemplates"] == {
        "Front": "{expression}",
        "Reading": "{reading}",
        "Extra": "",
    }
    assert options["resolvedFieldTemplates"] == {
        "Front": {"value": "x {expression}", "overwriteMode": "overwrite"},
        "Reading": {"value": "", "overwriteMode": "append"},
        "Extra": {"value": "", "overwriteMode": "coalesce"},
    }
    assert options["warnings"] == ['Hoshidicts field template "Removed" is not in note type "Mining".']


def test_status_recognizes_semantics_in_raw_yomitan_templates(monkeypatch):
    fields = ["Front", "Reading", "Definition", "Sentence", "Frequency", "PitchPosition"]
    fake_anki = FakeAnki(fields=fields)
    profile = _profile(
        fieldTemplates={
            "Front": {"value": "{expression}", "overwriteMode": "coalesce"},
            "Reading": {
                "value": "{furigana-plain}",
                "overwriteMode": "coalesce",
            },
            "Definition": {
                "value": "{jpmn-primary-definition}",
                "overwriteMode": "coalesce",
            },
            "Sentence": {
                "value": "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
                "overwriteMode": "coalesce",
            },
            "Frequency": {
                "value": "{single-frequency-number-Frequency}",
                "overwriteMode": "coalesce",
            },
            "PitchPosition": {
                "value": "{pitch-accent-positions}",
                "overwriteMode": "coalesce",
            },
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    status = hoshidicts_mining.get_hoshidicts_mining_status()

    assert status["fields"] == {
        "expression": "Front",
        "reading": "Reading",
        "definition": "Definition",
        "sentence": "Sentence",
        "frequency": "Frequency",
        "pitch": "PitchPosition",
        "audio": "",
    }
    assert status["unmappedFields"] == ["audio"]


def test_status_rejects_a_blank_first_field_template(monkeypatch):
    fake_anki = FakeAnki(fields=["Front", "Expression"])
    profile = _profile(
        fieldTemplates={
            "Front": {"value": "", "overwriteMode": "coalesce"},
            "Expression": {
                "value": "{expression}",
                "overwriteMode": "coalesce",
            },
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    status = hoshidicts_mining.get_hoshidicts_mining_status()

    assert status == {
        "available": False,
        "error": 'The first Anki field "Front" is empty. Map it to a value before mining.',
    }


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


def test_options_selected_different_note_type_ignores_saved_target_templates(monkeypatch):
    fields = ["Expression", "Reading", "Extra"]
    fake_anki = FakeAnki(
        fields=fields,
        model_names=["Old Card", "New Card"],
    )
    profile = _profile(
        model="Old Card",
        fieldTemplates={
            "Expression": {
                "value": "old {definition}",
                "overwriteMode": "append",
            },
            "Reading": {
                "value": "old literal",
                "overwriteMode": "overwrite",
            },
        },
    )
    _wire(monkeypatch, fake_anki, profile)

    options = hoshidicts_mining.get_hoshidicts_mining_options("new card")

    assert options["selectedNoteType"] == "New Card"
    assert options["resolvedFieldTemplates"] == {
        "Expression": {"value": "{expression}", "overwriteMode": "coalesce"},
        "Reading": {"value": "{reading}", "overwriteMode": "coalesce"},
        "Extra": {"value": "", "overwriteMode": "coalesce"},
    }
    assert options["warnings"] == []


def test_options_explicit_automatic_uses_config_model_without_old_legacy_mappings(monkeypatch):
    fields = ["Expression", "Reading", "Sentence"]
    fake_anki = FakeAnki(
        fields=fields,
        model_names=["Old Card", "Configured Card"],
    )
    profile = _profile(
        model="Old Card",
        fields={
            **_profile()["fields"],
            "reading": "Sentence",
        },
        disabledFields=["expression"],
        fieldOverwriteModes={
            **_profile()["fieldOverwriteModes"],
            "reading": "append",
            "sentence": "overwrite",
        },
    )
    config = _config()
    config.anki.note_type = "Configured Card"
    _wire(monkeypatch, fake_anki, profile)
    monkeypatch.setattr(hoshidicts_mining, "get_config", lambda: config)

    options = hoshidicts_mining.get_hoshidicts_mining_options("")

    assert options["selectedNoteType"] == "Configured Card"
    assert options["resolvedFieldTemplates"] == {
        "Expression": {"value": "{expression}", "overwriteMode": "coalesce"},
        "Reading": {"value": "{reading}", "overwriteMode": "coalesce"},
        "Sentence": {"value": "{sentence}", "overwriteMode": "coalesce"},
    }
    assert options["resolvedFields"] == {
        "expression": "Expression",
        "reading": "Reading",
        "definition": "",
        "sentence": "Sentence",
        "frequency": "",
        "pitch": "",
        "audio": "",
    }


def test_options_explicit_same_note_type_keeps_saved_templates(monkeypatch):
    fake_anki = FakeAnki(
        fields=["Expression", "Reading"],
        model_names=["Mining"],
    )
    profile = _profile(
        model="MINING",
        fieldTemplates={
            "Expression": {
                "value": "saved {expression}",
                "overwriteMode": "append",
            },
        },
    )
    _wire(monkeypatch, fake_anki, profile)

    options = hoshidicts_mining.get_hoshidicts_mining_options("mining")

    assert options["resolvedFieldTemplates"] == {
        "Expression": {
            "value": "saved {expression}",
            "overwriteMode": "append",
        },
        "Reading": {"value": "", "overwriteMode": "coalesce"},
    }


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


def test_mining_renders_target_templates_literals_and_all_blank_fields(monkeypatch):
    fields = ["Front", "Reading", "Definition", "Custom", "Unused"]
    fake_anki = FakeAnki(fields=fields)
    profile = _profile(
        fieldTemplates={
            "Front": {
                "value": "prefix {expression} / {reading}",
                "overwriteMode": "coalesce",
            },
            "Definition": {
                "value": "{definition}",
                "overwriteMode": "coalesce",
            },
            "Custom": {"value": "x", "overwriteMode": "coalesce"},
            "Unused": {"value": "", "overwriteMode": "coalesce"},
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    hoshidicts_mining.mine_hoshidicts_note(_payload())

    note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert list(note["fields"]) == fields
    assert note["fields"]["Front"] == "prefix 食べる / たべる"
    assert note["fields"]["Reading"] == ""
    assert "to eat" in note["fields"]["Definition"]
    assert note["fields"]["Custom"] == "x"
    assert note["fields"]["Unused"] == ""


def test_mining_renders_common_raw_yomitan_field_markers(monkeypatch):
    fields = [
        "Front",
        "Reading",
        "Definition",
        "Sentence",
        "Frequency",
        "PitchPosition",
        "PitchGraph",
    ]
    fake_anki = FakeAnki(fields=fields)
    profile = _profile(
        fieldTemplates={
            "Front": {"value": "{expression}", "overwriteMode": "coalesce"},
            "Reading": {
                "value": "{furigana-plain}",
                "overwriteMode": "coalesce",
            },
            "Definition": {
                "value": "{jpmn-primary-definition}",
                "overwriteMode": "coalesce",
            },
            "Sentence": {
                "value": "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
                "overwriteMode": "coalesce",
            },
            "Frequency": {
                "value": "{single-frequency-number-Frequency}",
                "overwriteMode": "coalesce",
            },
            "PitchPosition": {
                "value": "{pitch-accent-positions}",
                "overwriteMode": "coalesce",
            },
            "PitchGraph": {
                "value": "{pitch-accent-graphs}",
                "overwriteMode": "coalesce",
            },
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    hoshidicts_mining.mine_hoshidicts_note(_payload())

    note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert note["fields"]["Front"] == "食べる"
    assert note["fields"]["Reading"] == "食[た]べる"
    assert "to eat" in note["fields"]["Definition"]
    assert note["fields"]["Sentence"] == "昨日、<b>食べた</b>。"
    assert "123 ★" in note["fields"]["Frequency"]
    assert note["fields"]["PitchPosition"] == "2"
    assert "LHL" in note["fields"]["PitchGraph"]


def test_expression_furigana_uses_segmented_anki_syntax_and_ruby():
    payload = _payload()
    payload["result"]["term"]["expression"] = "頭を抱える"
    payload["result"]["term"]["reading"] = "あたまをかかえる"
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    values = hoshidicts_mining._field_template_values(request)

    assert values["{furigana-plain}"] == "頭[あたま]を 抱[かか]える"
    assert values["{furigana}"] == ("<ruby>頭<rt>あたま</rt></ruby>を<ruby>抱<rt>かか</rt></ruby>える")


def test_expression_furigana_skips_equivalent_hiragana_and_katakana():
    payload = _payload()
    payload["result"]["term"]["expression"] = "ワガハイ"
    payload["result"]["term"]["reading"] = "わがはい"
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    values = hoshidicts_mining._field_template_values(request)

    assert values["{furigana-plain}"] == "ワガハイ"
    assert values["{furigana}"] == "ワガハイ"


def test_expression_ruby_furigana_preserves_intentional_source_space(monkeypatch):
    payload = _payload()
    payload["result"]["term"]["expression"] = "foo 食べる"
    payload["result"]["term"]["reading"] = "foo たべる"
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)
    monkeypatch.setattr(
        hoshidicts_mining,
        "_expression_furigana_plain",
        lambda _expression, _reading: "foo 食[た]べる",
    )

    values = hoshidicts_mining._field_template_values(request)

    assert values["{furigana}"] == "foo <ruby>食<rt>た</rt></ruby>べる"
    assert values["{furigana-plain}"] == "foo 食[た]べる"
    assert (
        hoshidicts_mining._render_anki_furigana(
            "foo 食[た]べる",
            ruby=True,
            source="alignment fails",
        )
        == "foo <ruby>食<rt>た</rt></ruby>べる"
    )


def test_sentence_ruby_furigana_preserves_space_before_highlight(monkeypatch):
    request = hoshidicts_mining.validate_hoshidicts_mining_request(
        {
            **_payload(),
            "sentence": "foo 食べる",
            "matchOffset": 4,
            "result": {
                **_payload()["result"],
                "matched": "食べる",
            },
        }
    )
    fake_anki = SimpleNamespace(
        tokenizer=SimpleNamespace(reading=lambda _sentence: "foo  食[た]べる"),
        _preserve_html_tags_for_furigana=lambda source, _reading: source.replace(
            "<gsm-hoshidicts-match>食べる",
            "<gsm-hoshidicts-match> 食[た]べる",
        ),
    )

    rich, plain = hoshidicts_mining._sentence_furigana_values(request, fake_anki, {})

    assert rich == "foo <b><ruby>食<rt>た</rt></ruby>べる</b>"
    assert plain == "foo <b> 食[た]べる</b>"


def test_field_template_unknown_brace_literals_are_not_treated_as_markers():
    request = hoshidicts_mining.validate_hoshidicts_mining_request(_payload())
    values = hoshidicts_mining._field_template_values(
        request,
        audio_value="[sound:test.mp3]",
    )
    unknown_literals = "{audiobook}|{expressionless}|{spreadsheet-reading-list}"

    rendered = hoshidicts_mining._render_field_template(
        f"{unknown_literals}|{{audio}}|{{expression}}",
        values,
    )

    assert rendered == f"{unknown_literals}|[sound:test.mp3]|食べる"
    assert hoshidicts_mining._template_uses_audio(unknown_literals) is False
    assert hoshidicts_mining._semantic_field_targets(
        {
            "Literal": {
                "value": unknown_literals,
                "overwriteMode": "coalesce",
            }
        }
    ) == {key: "" for key in hoshidicts_mining.FIELD_KEYS}

    unsupported = hoshidicts_mining._render_field_template(
        "{url}<br>{document-title}<br>{clipboard-text}<br>{screenshot}<br>{audiobook}",
        values,
    )
    assert unsupported == "{audiobook}"


def test_jitendex_structured_glossary_preserves_semantic_html_without_styles():
    payload = _rich_jitendex_payload()
    payload.pop("dictionaryStyles")
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    rendered = hoshidicts_mining._definition_html(request)

    assert rendered.startswith('<div style="text-align: left;" class="yomitan-glossary"><ol>')
    assert rendered.count('<li data-dictionary="') == 2
    assert '<li data-dictionary="Jitendex">' in rendered
    assert '<li data-dictionary="JMdict">' in rendered
    assert 'class="gloss-sc-div"' in rendered
    assert '<span class="structured-content"><div class="gloss-sc-div"' in rendered
    assert 'data-sc-content="sense-group"' in rendered
    assert 'data-sc-sense-number="1"' in rendered
    assert 'data-sc-source-index="2"' in rendered
    assert "data-sc-source_index" not in rendered
    assert 'style="font-weight: 700; margin-top: 0.5em"' in rendered
    assert '<ruby class="gloss-sc-ruby">吾輩<rt class="gloss-sc-rt">わがはい</rt></ruby>' in rendered
    assert 'data-sc-content="example-sentence-a"' in rendered
    assert (
        '<a class="gloss-link" href="?query=猫" data-external="false"><span class="gloss-link-text">猫</span></a>'
    ) in rendered
    assert (
        '<a class="gloss-link" href="https://example.com/entry" data-external="true">'
        '<span class="gloss-link-text">source</span>'
        '<span class="gloss-link-external-icon icon" data-icon="external-link"></span></a>'
    ) in rendered
    assert (
        '<p class="gloss-sc-p"><code class="gloss-sc-code">code</code>'
        '<em class="gloss-sc-em">em</em><small class="gloss-sc-small">small</small>'
        '<strong class="gloss-sc-strong">strong</strong><sub class="gloss-sc-sub">sub</sub>'
        '<sup class="gloss-sc-sup">sup</sup></p>'
    ) in rendered
    assert "arrogant first-person pronoun" in rendered
    assert "I; me<br>self" in rendered
    assert "吾輩pronoun" not in rendered
    assert "<style>" not in rendered


def test_structured_glossary_outer_list_wraps_each_structured_item_and_preserves_mixed_entries():
    payload = _payload()
    payload["result"]["term"]["glossaries"][0]["glossary"] = json.dumps(
        [
            "plain <one>\nsecond line",
            {
                "type": "structured-content",
                "content": {"tag": "strong", "content": "first structured"},
            },
            {"type": "text", "text": "text <entry>"},
            {
                "type": "structured-content",
                "content": {"tag": "em", "content": "second structured"},
            },
        ]
    )

    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)
    rendered = hoshidicts_mining._definition_html(request)

    assert rendered.count('<span class="structured-content">') == 2
    expected_segments = [
        "plain &lt;one&gt;<br>second line",
        '<span class="structured-content"><strong class="gloss-sc-strong">first structured</strong></span>',
        "text &lt;entry&gt;",
        '<span class="structured-content"><em class="gloss-sc-em">second structured</em></span>',
    ]
    positions = [rendered.index(segment) for segment in expected_segments]
    assert positions == sorted(positions)


def test_dictionary_styles_accept_list_or_object_and_scope_selected_pages():
    request = hoshidicts_mining.validate_hoshidicts_mining_request(_rich_jitendex_payload())

    rendered = hoshidicts_mining._definition_html(request)

    assert request["dictionaryStyles"] == {
        "Jitendex": '[data-sc-content|="example-sentence"] { color: #c44; }',
        "JMdict": ".gloss-sc-li { font-style: italic; }",
        "Not selected": "span { display: none; }",
    }
    assert "@scope" not in rendered
    assert ('.yomitan-glossary [data-dictionary="Jitendex"] [data-sc-content|="example-sentence"]') in rendered
    assert '.yomitan-glossary [data-dictionary="JMdict"] .gloss-sc-li' in rendered
    assert "Not selected" not in rendered

    object_payload = _rich_jitendex_payload()
    object_payload["dictionaryStyles"] = {
        "Jitendex": ("@media (min-width: 10px) {.sense, [data-sc-content=glossary] { color: red; }}"),
    }
    object_request = hoshidicts_mining.validate_hoshidicts_mining_request(object_payload)
    assert object_request["dictionaryStyles"] == {
        "Jitendex": ("@media (min-width: 10px) {.sense, [data-sc-content=glossary] { color: red; }}"),
    }
    object_rendered = hoshidicts_mining._definition_html(object_request)
    assert "@media (min-width: 10px)" in object_rendered
    assert '.yomitan-glossary [data-dictionary="Jitendex"] .sense' in object_rendered
    assert ('.yomitan-glossary [data-dictionary="Jitendex"] [data-sc-content=glossary]') in object_rendered


def test_static_yomitan_glossary_variants_preserve_their_exact_semantics():
    payload = _rich_jitendex_payload()
    payload["result"]["term"]["glossaries"][-1]["glossary"] = "I; me\nself <unsafe>"
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    values = hoshidicts_mining._field_template_values(request)

    full = values["{glossary}"]
    assert full == values["{definition}"]
    assert '<i class="yomitan-glossary-meta">(pn, common, Jitendex)</i>' in full
    assert '<li data-dictionary="Jitendex">' in full
    assert '<li data-dictionary="JMdict">' in full
    assert "Rules: v1" in full
    assert "Deinflection: past" in full

    brief = values["{glossary-brief}"]
    assert "yomitan-glossary-meta" not in brief
    assert "Rules:" not in brief
    assert "Deinflection:" not in brief
    assert '<li data-dictionary="Jitendex">' in brief
    assert '<li data-dictionary="JMdict">' in brief
    assert '.yomitan-glossary [data-dictionary="Jitendex"]' in brief
    assert '.yomitan-glossary [data-dictionary="JMdict"]' in brief

    no_dictionary = values["{glossary-no-dictionary}"]
    assert '<i class="yomitan-glossary-meta">(pn, common)</i>' in no_dictionary
    assert '<i class="yomitan-glossary-meta">(pronoun, common)</i>' in no_dictionary
    assert "(pn, common, Jitendex)" not in no_dictionary
    assert '<li data-dictionary="Jitendex">' in no_dictionary

    plain = values["{glossary-plain}"]
    assert plain.startswith("(Jitendex)<br>")
    assert "(JMdict)<br>I; me<br>self &lt;unsafe&gt;" in plain
    assert "吾輩" in plain
    assert set(re.findall(r"<[^>]+>", plain)) == {"<br>"}

    plain_no_dictionary = values["{glossary-plain-no-dictionary}"]
    assert "Jitendex" not in plain_no_dictionary
    assert "JMdict" not in plain_no_dictionary
    assert "self &lt;unsafe&gt;" in plain_no_dictionary
    assert set(re.findall(r"<[^>]+>", plain_no_dictionary)) == {"<br>"}

    first = values["{glossary-first}"]
    assert first == values["{main-definition}"]
    assert '<li data-dictionary="Jitendex">' in first
    assert '<li data-dictionary="JMdict">' not in first
    assert "yomitan-glossary-meta" in first

    first_brief = values["{glossary-first-brief}"]
    assert '<li data-dictionary="Jitendex">' in first_brief
    assert '<li data-dictionary="JMdict">' not in first_brief
    assert "yomitan-glossary-meta" not in first_brief
    assert "Rules:" not in first_brief

    first_no_dictionary = values["{glossary-first-no-dictionary}"]
    assert '<i class="yomitan-glossary-meta">(pn, common)</i>' in first_no_dictionary
    assert "(pn, common, Jitendex)" not in first_no_dictionary
    assert '<li data-dictionary="JMdict">' not in first_no_dictionary


def test_yomitan_dictionary_kebab_case_matches_unicode_rules():
    assert (
        hoshidicts_mining._yomitan_kebab_case("  Character_Dictionary　東京!! 2026  ")
        == "character-dictionary-東京-2026"
    )
    assert hoshidicts_mining._yomitan_kebab_case("École__猫 $$$") == "école-猫"
    assert hoshidicts_mining._yomitan_kebab_case("A—B---C") == "ab-c"
    assert hoshidicts_mining._yomitan_kebab_case("İ") == "i\u0307"


def test_dynamic_single_glossary_markers_render_only_used_dictionary_variants():
    payload = _rich_jitendex_payload()
    dictionary = "Character Dictionary　東京_2026!"
    for glossary in payload["result"]["term"]["glossaries"][:2]:
        glossary["dictionary"] = dictionary
    payload["dictionaryStyles"][0]["dictionary"] = dictionary
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)
    base = "single-glossary-character-dictionary-東京-2026"
    used_markers = [
        base,
        f"{base}-brief",
        f"{base}-no-dictionary",
        f"{base}-plain",
        f"{base}-plain-no-dictionary",
        "single-glossary-removed-dictionary",
    ]
    templates = {marker: {"value": f"{{{marker}}}", "overwriteMode": "coalesce"} for marker in used_markers}

    values = hoshidicts_mining._template_values_for_fields(
        request,
        {"anki": SimpleNamespace()},
        templates,
    )

    dynamic_values = {key: value for key, value in values.items() if key.startswith("{single-glossary-")}
    assert set(dynamic_values) == {f"{{{marker}}}" for marker in used_markers[:-1]}

    selected = values[f"{{{base}}}"]
    assert f'data-dictionary="{dictionary}"' in selected
    assert 'data-dictionary="JMdict"' not in selected
    assert f'.yomitan-glossary [data-dictionary="{dictionary}"]' in selected
    assert '.yomitan-glossary [data-dictionary="JMdict"]' not in selected

    brief = values[f"{{{base}-brief}}"]
    assert "yomitan-glossary-meta" not in brief
    assert "Rules:" not in brief
    assert f'data-dictionary="{dictionary}"' in brief

    no_dictionary = values[f"{{{base}-no-dictionary}}"]
    assert '<i class="yomitan-glossary-meta">(pn, common)</i>' in no_dictionary
    assert f"(pn, common, {dictionary})" not in no_dictionary

    plain = values[f"{{{base}-plain}}"]
    assert plain.startswith(f"({dictionary})<br>")
    assert "JMdict" not in plain
    assert set(re.findall(r"<[^>]+>", plain)) == {"<br>"}

    plain_no_dictionary = values[f"{{{base}-plain-no-dictionary}}"]
    assert dictionary not in plain_no_dictionary
    assert "JMdict" not in plain_no_dictionary
    assert set(re.findall(r"<[^>]+>", plain_no_dictionary)) == {"<br>"}

    assert (
        hoshidicts_mining._render_field_template(
            "{single-glossary-removed-dictionary}",
            values,
        )
        == ""
    )


def test_dynamic_single_glossary_exact_dictionary_name_wins_suffix_ambiguity():
    payload = _payload()
    payload["result"]["term"]["glossaries"] = [
        {
            "dictionary": "Foo",
            "glossary": "foo definition",
            "definitionTags": "foo-tag",
            "termTags": "",
        },
        {
            "dictionary": "Foo Brief",
            "glossary": "exact dictionary definition",
            "definitionTags": "exact-tag",
            "termTags": "",
        },
    ]
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)
    marker = "single-glossary-foo-brief"
    templates = {
        "Definition": {
            "value": f"{{{marker}}}",
            "overwriteMode": "coalesce",
        }
    }

    values = hoshidicts_mining._template_values_for_fields(
        request,
        {"anki": SimpleNamespace()},
        templates,
    )
    rendered = values[f"{{{marker}}}"]

    assert 'data-dictionary="Foo Brief"' in rendered
    assert 'data-dictionary="Foo"' not in rendered
    assert "exact dictionary definition" in rendered
    assert "foo definition" not in rendered


def test_dictionary_style_grouping_nesting_is_bounded_without_unscoped_fallback():
    payload = _payload()
    payload["dictionaryStyles"] = {
        "JMdict": ("@media all{" * 1100) + ".sense{color:red}" + ("}" * 1100),
    }
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    rendered = hoshidicts_mining._definition_html(request)

    assert rendered.count("@media all") < 100
    assert ".sense{color:red}" not in rendered
    assert '<li data-dictionary="JMdict">' in rendered


def test_dictionary_style_scoping_handles_comments_before_at_rules_and_selector_commas():
    payload = _payload()
    payload["dictionaryStyles"] = {
        "JMdict": ("/* header */ @media all { span { color: red; } }/* a,b */ span, em { font-weight: bold; }"),
    }
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    rendered = hoshidicts_mining._definition_html(request)
    scope = '.yomitan-glossary [data-dictionary="JMdict"]'

    assert f"/* header */ @media all {{ {scope} span" in rendered
    assert f"/* a,b */ {scope} span, {scope} em" in rendered
    assert f"{scope} /* header */" not in rendered
    assert rendered.count("/* a,b */") == 1


def test_dictionary_styles_enforce_count_and_utf8_byte_limits():
    payload = _payload()
    payload["dictionaryStyles"] = {
        "JMdict": "x" * hoshidicts_mining.MAX_DICTIONARY_STYLE_BYTES,
    }
    request = hoshidicts_mining.validate_hoshidicts_mining_request(payload)
    assert len(request["dictionaryStyles"]["JMdict"]) == hoshidicts_mining.MAX_DICTIONARY_STYLE_BYTES

    payload["dictionaryStyles"] = {
        "JMdict": "界" * ((hoshidicts_mining.MAX_DICTIONARY_STYLE_BYTES // 3) + 1),
    }
    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="dictionary styles are invalid",
    ):
        hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    payload["dictionaryStyles"] = {
        f"Dictionary {index}": "" for index in range(hoshidicts_mining.MAX_DICTIONARY_STYLES + 1)
    }
    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="dictionary styles are invalid",
    ):
        hoshidicts_mining.validate_hoshidicts_mining_request(payload)


def test_duplicate_check_endpoint_preserves_dictionary_styles_in_rendered_note(monkeypatch):
    class CheckAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                return [{"canAdd": True, "error": None}]
            return super().invoke(action, **kwargs)

    fake_anki = CheckAnki(fields=["Definition"])
    _wire(
        monkeypatch,
        fake_anki,
        _profile(
            fieldTemplates={
                "Definition": {
                    "value": "{definition}",
                    "overwriteMode": "coalesce",
                }
            }
        ),
    )
    app = Flask(__name__)
    hoshidicts_api.register_hoshidicts_api_routes(app)

    response = app.test_client().post(
        "/api/hoshidicts/mining/check",
        json={"notes": [_rich_jitendex_payload()]},
    )

    assert response.status_code == 200
    assert response.get_json()["success"] is True
    check_note = next(
        kwargs["notes"][0] for action, kwargs in fake_anki.calls if action == "canAddNotesWithErrorDetail"
    )
    definition = check_note["fields"]["Definition"]
    assert '<style>.yomitan-glossary [data-dictionary="Jitendex"]' in definition
    assert '.yomitan-glossary [data-dictionary="JMdict"] .gloss-sc-li' in definition
    assert "Not selected" not in definition


def test_rich_definition_markers_render_primary_full_dictionary_and_furigana(monkeypatch):
    fields = [
        "Expression",
        "ExpressionFurigana",
        "ExpressionRuby",
        "SentenceFurigana",
        "SentenceRuby",
        "MainDefinition",
        "Glossary",
        "Definition",
        "Dictionary",
    ]
    fake_anki = FakeAnki(fields=fields)
    reading_calls = []

    def reading(sentence):
        reading_calls.append(sentence)
        return " 昨日[きのう]、 食[た]べた。"

    def preserve(source, furigana):
        assert source == "昨日、<gsm-hoshidicts-match>食べた</gsm-hoshidicts-match>。"
        assert furigana == " 昨日[きのう]、 食[た]べた。"
        return "昨日[きのう]、<gsm-hoshidicts-match> 食[た]べた</gsm-hoshidicts-match>。"

    fake_anki.tokenizer = SimpleNamespace(reading=reading)
    fake_anki._preserve_html_tags_for_furigana = preserve
    profile = _profile(
        fieldTemplates={
            "Expression": {"value": "{expression}", "overwriteMode": "coalesce"},
            "ExpressionFurigana": {
                "value": "{furigana-plain}",
                "overwriteMode": "coalesce",
            },
            "ExpressionRuby": {"value": "{furigana}", "overwriteMode": "coalesce"},
            "SentenceFurigana": {
                "value": "{sentence-furigana-plain}",
                "overwriteMode": "coalesce",
            },
            "SentenceRuby": {
                "value": "{sentence-furigana}",
                "overwriteMode": "coalesce",
            },
            "MainDefinition": {
                "value": "{main-definition}",
                "overwriteMode": "coalesce",
            },
            "Glossary": {"value": "{glossary}", "overwriteMode": "coalesce"},
            "Definition": {"value": "{definition}", "overwriteMode": "coalesce"},
            "Dictionary": {"value": "{dictionary}", "overwriteMode": "coalesce"},
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    hoshidicts_mining.mine_hoshidicts_note(_rich_jitendex_payload())

    note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert reading_calls == ["昨日、食べた。"]
    assert note["fields"]["ExpressionFurigana"] == "食[た]べる"
    assert note["fields"]["ExpressionRuby"] == "<ruby>食<rt>た</rt></ruby>べる"
    assert note["fields"]["SentenceFurigana"] == "昨日[きのう]、<b> 食[た]べた</b>。"
    assert note["fields"]["SentenceRuby"] == (
        "<ruby>昨日<rt>きのう</rt></ruby>、<b><ruby>食<rt>た</rt></ruby>べた</b>。"
    )
    assert 'data-dictionary="Jitendex"' in note["fields"]["MainDefinition"]
    assert 'data-dictionary="JMdict"' not in note["fields"]["MainDefinition"]
    assert 'data-dictionary="JMdict"' in note["fields"]["Glossary"]
    assert note["fields"]["Definition"] == note["fields"]["Glossary"]
    assert note["fields"]["MainDefinition"] != note["fields"]["Glossary"]
    assert note["fields"]["Dictionary"] == "Jitendex"


def test_kiku_yomitan_parity_check_and_mine_preserve_rich_multi_dictionary_note(monkeypatch):
    class ParityAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                return [{"canAdd": True, "error": None}]
            return super().invoke(action, **kwargs)

    fields = ["Glossary", "MainDefinition", "Expression", "YomitanContext"]
    fake_anki = ParityAnki(fields=fields)
    profile = _profile(
        fieldTemplates={
            "Glossary": {"value": "{glossary}", "overwriteMode": "overwrite"},
            "MainDefinition": {
                "value": "{main-definition}",
                "overwriteMode": "overwrite",
            },
            "Expression": {"value": "{expression}", "overwriteMode": "overwrite"},
            "YomitanContext": {
                "value": (
                    "{dictionary}|{dictionary-alias}|{conjugation}|{part-of-speech}|"
                    "{phonetic-transcriptions}|{tags}|{popup-selection-text}|"
                    "{document-title}|{search-query}"
                ),
                "overwriteMode": "overwrite",
            },
        }
    )
    _wire(monkeypatch, fake_anki, profile)
    payload = _kiku_yomitan_parity_payload()

    check = hoshidicts_mining.check_hoshidicts_notes({"notes": [payload]})
    result = hoshidicts_mining.mine_hoshidicts_note(payload)

    assert check["results"] == [{"state": "addable", "canAdd": True, "duplicate": False}]
    checked_note = next(
        kwargs["notes"][0] for action, kwargs in fake_anki.calls if action == "canAddNotesWithErrorDetail"
    )
    added_note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert checked_note["fields"]["Glossary"] == added_note["fields"]["Glossary"]
    glossary = added_note["fields"]["Glossary"]
    main = added_note["fields"]["MainDefinition"]
    context = added_note["fields"]["YomitanContext"]
    assert 'class="yomitan-glossary"' in glossary
    assert 'data-dictionary="Jitendex.org [2026-08-08]"' in glossary
    assert 'data-dictionary="JMdict"' in glossary
    assert "(colloquial, v5 common, Jitendex)" in glossary
    assert 'data-dictionary="JMdict"' not in main
    assert "yomitan_dictionary_media_37d6f763c8ebb201e600de788daaa4cfe00ba13c.jpeg" in glossary
    assert '.yomitan-glossary [data-dictionary="Jitendex.org [2026-08-08]"]' in glossary
    assert "Jitendex.org [2026-08-08]|Jitendex|-て « imperative|Godan verb" in context
    assert 'data-pronunciation-type="phonetic-transcription">bɯtɕikamasɯ' in context
    assert 'data-details="colloquial"' in context
    assert "ぶちかまして|GSM Kiku parity|ぶちかましてやれ" in context
    media_call = next(kwargs for action, kwargs in fake_anki.calls if action == "storeMediaFile")
    assert media_call["filename"] == ("yomitan_dictionary_media_37d6f763c8ebb201e600de788daaa4cfe00ba13c.jpeg")
    assert media_call["data"] == "/9j/4AA="
    assert result["noteId"] == 42


def test_sentence_furigana_falls_back_to_safe_highlighted_sentence(monkeypatch):
    fields = ["Expression", "SentenceFurigana", "SentenceRuby"]
    fake_anki = FakeAnki(fields=fields)

    def fail_reading(_sentence):
        raise RuntimeError("tokenizer unavailable")

    fake_anki.tokenizer = SimpleNamespace(reading=fail_reading)
    fake_anki._preserve_html_tags_for_furigana = lambda *_args: pytest.fail(
        "preservation should not run after tokenization fails"
    )
    profile = _profile(
        fieldTemplates={
            "Expression": {"value": "{expression}", "overwriteMode": "coalesce"},
            "SentenceFurigana": {
                "value": "{sentence-furigana-plain}",
                "overwriteMode": "coalesce",
            },
            "SentenceRuby": {
                "value": "{sentence-furigana}",
                "overwriteMode": "coalesce",
            },
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    hoshidicts_mining.mine_hoshidicts_note(_payload())

    note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert note["fields"]["SentenceFurigana"] == "昨日、<b>食べた</b>。"
    assert note["fields"]["SentenceRuby"] == "昨日、<b>食べた</b>。"


def test_duplicate_check_batch_caches_sentence_tokenization(monkeypatch):
    class CheckAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "canAddNotesWithErrorDetail":
                self.calls.append((action, kwargs))
                return [{"canAdd": True, "error": None} for _note in kwargs["notes"]]
            return super().invoke(action, **kwargs)

    fake_anki = CheckAnki(fields=["Expression", "SentenceFurigana"])
    reading_calls = []

    def reading(sentence):
        reading_calls.append(sentence)
        return " 昨日[きのう]、 食[た]べた。"

    fake_anki.tokenizer = SimpleNamespace(reading=reading)
    fake_anki._preserve_html_tags_for_furigana = lambda source, _reading: source
    profile = _profile(
        fieldTemplates={
            "Expression": {"value": "{expression}", "overwriteMode": "coalesce"},
            "SentenceFurigana": {
                "value": "{sentence-furigana-plain}",
                "overwriteMode": "coalesce",
            },
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [_payload(), _payload()]})

    assert result["success"] is True
    assert reading_calls == ["昨日、食べた。"]


def test_mining_rejects_an_explicitly_blank_first_model_field(monkeypatch):
    fake_anki = FakeAnki(fields=["Front", "Expression"])
    profile = _profile(
        fieldTemplates={
            "Front": {"value": "", "overwriteMode": "coalesce"},
            "Expression": {
                "value": "{expression}",
                "overwriteMode": "coalesce",
            },
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match='first Anki field "Front" is empty',
    ):
        hoshidicts_mining.mine_hoshidicts_note(_payload())

    assert not any(action == "addNote" for action, _kwargs in fake_anki.calls)


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
    assert note["fields"]["Reading"] == ""
    assert note["fields"]["Frequency"] == ""
    assert note["fields"]["PitchAccent"] == ""
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


def test_migrated_shared_target_keeps_the_first_semantics_overwrite_mode(monkeypatch):
    fake_anki = FakeAnki(fields=["Front"])
    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 2,
            "fields": {
                "expression": "Front",
                "definition": "Front",
            },
            "fieldOverwriteModes": {
                "expression": "append",
                "definition": "overwrite",
            },
        }
    )
    _wire(monkeypatch, fake_anki, profile)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["resolvedFieldTemplates"] == {
        "Front": {
            "value": "{expression}<br>{definition}",
            "overwriteMode": "append",
        }
    }


def test_migrated_shared_target_omits_separators_for_empty_values(monkeypatch):
    fake_anki = FakeAnki(fields=["Front"])
    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 2,
            "fields": {
                "expression": "Front",
                "reading": "Front",
                "frequency": "Front",
            },
        }
    )
    _wire(monkeypatch, fake_anki, profile)
    payload = _payload()
    payload["result"]["term"]["reading"] = ""
    payload["result"]["term"]["frequencies"] = []

    hoshidicts_mining.mine_hoshidicts_note(payload)

    note = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert note["fields"] == {"Front": "食べる"}


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


def test_mining_renders_compound_audio_template_after_storing_media(monkeypatch):
    fake_anki = FakeAnki(fields=["Front", "Sound", "Extra"])
    profile = _profile(
        fieldTemplates={
            "Front": {
                "value": "{expression}",
                "overwriteMode": "coalesce",
            },
            "Sound": {
                "value": "Audio: {audio} ({reading})",
                "overwriteMode": "coalesce",
            },
            "Extra": {"value": "", "overwriteMode": "coalesce"},
        }
    )
    _wire_audio(monkeypatch, fake_anki, mining_profile=profile)

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    added = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "addNote")
    assert added["fields"] == {
        "Front": "食べる",
        "Sound": "Audio:  (たべる)",
        "Extra": "",
    }
    updated = next(kwargs["note"] for action, kwargs in fake_anki.calls if action == "updateNoteFields")
    assert updated == {
        "id": 42,
        "fields": {"Sound": f"Audio: [sound:{result['audio']['filename']}] (たべる)"},
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


def test_validation_preserves_large_glossaries_from_more_than_64_dictionaries():
    payload = _payload()
    tail_marker = "FIRST_DICTIONARY_TAIL"
    structured_glossary = json.dumps(
        {
            "type": "structured-content",
            "content": [*["x" * 32 for _ in range(4096)], tail_marker],
        }
    )
    payload["result"]["term"]["glossaries"] = [
        {
            "dictionary": f"Dictionary {index}",
            "glossary": (structured_glossary if index == 0 else f"definition-{index}:" + "x" * (2 * 1024)),
            "definitionTags": "",
            "termTags": "",
        }
        for index in range(70)
    ]
    assert len(json.dumps(payload).encode("utf-8")) > 256 * 1024

    normalized = hoshidicts_mining.validate_hoshidicts_mining_request(payload)

    glossaries = normalized["term"]["glossaries"]
    assert len(glossaries) == 70
    assert glossaries[0]["glossary"] == structured_glossary
    assert glossaries[-1]["dictionary"] == "Dictionary 69"
    rendered = hoshidicts_mining._definition_html(normalized)
    assert tail_marker in rendered
    assert "definition-69" in rendered
    assert tail_marker in hoshidicts_mining._glossary_text(structured_glossary)


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


def test_v3_target_field_overwrite_modes_include_explicit_blank_values():
    resolved = {
        "fieldTemplates": {
            "Keep": {"value": "{reading}", "overwriteMode": "skip"},
            "Append": {"value": "x", "overwriteMode": "append"},
            "Clear": {"value": "", "overwriteMode": "overwrite"},
            "Audio": {"value": "{audio}", "overwriteMode": "append"},
            "AudioWithSeparator": {
                "value": "<br>{audio}<br/>",
                "overwriteMode": "overwrite",
            },
            "Compound": {
                "value": "{definition}<br>{audio}",
                "overwriteMode": "append",
            },
        }
    }

    overwritten = hoshidicts_mining._overwritten_note_fields(
        {
            "fields": {
                "Keep": "new reading",
                "Append": "x",
                "Clear": "",
                "Audio": "",
                "AudioWithSeparator": "",
                "Compound": "new definition",
            }
        },
        {
            "Keep": "old reading",
            "Append": "old",
            "Clear": "old value",
            "Audio": "[sound:old.mp3]",
            "AudioWithSeparator": "[sound:also-old.mp3]",
            "Compound": "old definition",
        },
        resolved,
    )

    assert overwritten == {
        "Keep": "old reading",
        "Append": "oldx",
        "Clear": "",
        "Compound": "old definitionnew definition",
    }


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


def test_v3_target_audio_overwrite_mode_appends_to_existing_audio(monkeypatch):
    class DirectAudioOverwriteAnki(FakeAnki):
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
                            "Expression": {"value": "食べる", "order": 0},
                            "WordAudio": {
                                "value": "[sound:existing.mp3]",
                                "order": 1,
                            },
                        },
                    }
                ]
            return super().invoke(action, **kwargs)

    fake_anki = DirectAudioOverwriteAnki(fields=["Expression", "WordAudio"])
    profile = _profile(
        duplicateBehavior="overwrite",
        fieldTemplates={
            "Expression": {
                "value": "{expression}",
                "overwriteMode": "coalesce",
            },
            "WordAudio": {"value": "{audio}", "overwriteMode": "append"},
        },
    )
    _wire_audio(monkeypatch, fake_anki, mining_profile=profile)

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    audio_updates = [
        kwargs["note"]
        for action, kwargs in fake_anki.calls
        if action == "updateNoteFields" and "WordAudio" in kwargs["note"]["fields"]
    ]
    assert audio_updates == [
        {
            "id": 42,
            "fields": {"WordAudio": f"[sound:existing.mp3][sound:{result['audio']['filename']}]"},
        }
    ]


@pytest.mark.parametrize(
    ("audio_state", "overwrite_mode", "expected_status"),
    [
        ("disabled", "overwrite", "skipped"),
        ("unavailable", "append", "unavailable"),
        ("stored", "append", "stored"),
    ],
)
def test_duplicate_overwrite_keeps_compound_content_when_audio_cannot_be_added(
    monkeypatch,
    audio_state,
    overwrite_mode,
    expected_status,
):
    class CompoundAudioOverwriteAnki(FakeAnki):
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
                        "fields": {
                            "Expression": {"value": "食べる", "order": 0},
                            "Combined": {"value": "old combined", "order": 1},
                            "WordAudio": {
                                "value": "[sound:existing.mp3]",
                                "order": 2,
                            },
                        },
                    }
                ]
            if action == "addNote":
                raise AssertionError("a duplicate note must be updated, not added")
            return super().invoke(action, **kwargs)

    fake_anki = CompoundAudioOverwriteAnki(fields=["Expression", "Combined", "WordAudio"])
    profile = _profile(
        duplicateBehavior="overwrite",
        fieldTemplates={
            "Expression": {
                "value": "{expression}",
                "overwriteMode": "coalesce",
            },
            "Combined": {
                "value": "{definition}<br>{audio}",
                "overwriteMode": overwrite_mode,
            },
            "WordAudio": {
                "value": "{audio}",
                "overwriteMode": "overwrite",
            },
        },
    )
    audio_profile = hoshidicts_audio.default_hoshidicts_audio_profile()
    audio_profile["enabled"] = audio_state != "disabled"
    audio_error = (
        hoshidicts_audio.HoshidictsAudioError("No pronunciation audio is available.", 404)
        if audio_state == "unavailable"
        else None
    )
    _wire_audio(
        monkeypatch,
        fake_anki,
        mining_profile=profile,
        audio_profile=audio_profile,
        error=audio_error,
    )

    result = hoshidicts_mining.mine_hoshidicts_note(_payload())

    updates = [kwargs["note"] for action, kwargs in fake_anki.calls if action == "updateNoteFields"]
    initial_combined = updates[0]["fields"]["Combined"]
    assert "to eat" in initial_combined
    assert not initial_combined.endswith("<br>")
    assert initial_combined.startswith("old combined") is (overwrite_mode == "append")
    assert "WordAudio" not in updates[0]["fields"]
    assert result["audio"]["status"] == expected_status
    if audio_state == "stored":
        assert len(updates) == 2
        final_combined = updates[1]["fields"]["Combined"]
        assert final_combined.startswith("old combined")
        assert final_combined.count("to eat") == 1
        assert f"<br>[sound:{result['audio']['filename']}]" in final_combined
        assert updates[1]["fields"]["WordAudio"] == f"[sound:{result['audio']['filename']}]"
    else:
        assert len(updates) == 1


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


def test_browse_hoshidicts_word_opens_broad_literal_anki_search(monkeypatch):
    class BrowseAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "guiBrowse":
                self.calls.append((action, kwargs))
                return [101, 202]
            return super().invoke(action, **kwargs)

    fake_anki = BrowseAnki()
    _wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.browse_hoshidicts_word({"word": 'word" OR deck:*_\\:<&>'})

    assert result == {"success": True}
    assert fake_anki.calls == [
        (
            "guiBrowse",
            {
                "query": r'"word\" OR deck\:\*\_\\\:&lt;&amp;&gt;"',
                "timeout": hoshidicts_mining.ANKI_CONNECT_TIMEOUT_SECONDS,
            },
        )
    ]


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"word": None},
        {"word": ""},
        {"word": "   "},
        {"word": "x" * (hoshidicts_mining.MAX_TERM_LENGTH + 1)},
        {"word": "bad\x00word"},
    ],
)
def test_browse_hoshidicts_word_rejects_invalid_words(monkeypatch, payload):
    fake_anki = FakeAnki()
    _wire(monkeypatch, fake_anki)

    with pytest.raises(hoshidicts_mining.HoshidictsMiningError):
        hoshidicts_mining.browse_hoshidicts_word(payload)

    assert fake_anki.calls == []


def test_browse_hoshidicts_word_requires_enabled_anki_integration(monkeypatch):
    fake_anki = FakeAnki()
    config = _config()
    config.anki.enabled = False
    monkeypatch.setattr(hoshidicts_mining, "get_config", lambda: config)
    monkeypatch.setattr(hoshidicts_mining, "_get_anki_module", lambda: fake_anki)

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="GSM Anki integration is disabled",
    ) as error:
        hoshidicts_mining.browse_hoshidicts_word({"word": "食べる"})

    assert error.value.status_code == 503
    assert fake_anki.calls == []


def test_browse_hoshidicts_word_reports_anki_connect_failures(monkeypatch):
    class OfflineAnki(FakeAnki):
        def invoke(self, action, **kwargs):
            if action == "guiBrowse":
                raise RuntimeError("AnkiConnect is offline")
            return super().invoke(action, **kwargs)

    fake_anki = OfflineAnki()
    _wire(monkeypatch, fake_anki)

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="Could not open Anki through GSM: AnkiConnect is offline",
    ) as error:
        hoshidicts_mining.browse_hoshidicts_word({"word": "食べる"})

    assert error.value.status_code == 502


def test_hoshidicts_routes_expose_status_and_mining_errors(monkeypatch):
    app = Flask(__name__)
    hoshidicts_api.register_hoshidicts_api_routes(app)
    option_models = []
    monkeypatch.setattr(
        hoshidicts_api,
        "get_hoshidicts_mining_status",
        lambda: {"available": True},
    )

    def mining_options(model=None):
        option_models.append(model)
        return {
            "connected": True,
            "selectedNoteType": "Mining" if model is None else model,
        }

    monkeypatch.setattr(
        hoshidicts_api,
        "get_hoshidicts_mining_options",
        mining_options,
    )
    mining_calls = []

    def mine(payload):
        mining_calls.append(payload)
        raise hoshidicts_mining.HoshidictsMiningError("duplicate", 409)

    monkeypatch.setattr(hoshidicts_api, "mine_hoshidicts_note", mine)
    browse_calls = []
    monkeypatch.setattr(
        hoshidicts_api,
        "browse_hoshidicts_word",
        lambda payload: browse_calls.append(payload) or {"success": True},
    )
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
    assert client.get("/api/hoshidicts/mining/options?model=").get_json() == {
        "connected": True,
        "selectedNoteType": "",
    }
    assert option_models == ["Kiku", ""]
    assert client.post("/api/hoshidicts/mining/check", json={"notes": []}).get_json() == {
        "success": True,
        "duplicateBehavior": "prevent",
        "results": [],
        "payload": {"notes": []},
    }
    response = client.post(
        "/api/hoshidicts/mining/browse",
        json={"word": "食べる"},
    )
    assert response.status_code == 200
    assert response.get_json() == {"success": True}
    assert browse_calls == [{"word": "食べる"}]
    response = client.post("/api/hoshidicts/mine", json={})
    assert response.status_code == 409
    assert response.get_json() == {
        "success": False,
        "error": "duplicate",
        "code": "duplicate",
    }
    assert mining_calls == [{}]

    large_payload = {"lookup": "x" * (300 * 1024)}
    response = client.post("/api/hoshidicts/mine", json=large_payload)
    assert response.status_code == 409
    assert mining_calls[-1] == large_payload
