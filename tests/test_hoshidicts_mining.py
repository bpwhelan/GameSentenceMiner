import json
import re
from types import SimpleNamespace

import pytest
from flask import Flask

from GameSentenceMiner import (
    hoshidicts_anki,
    hoshidicts_audio,
    hoshidicts_audio_profile,
    hoshidicts_markers,
    hoshidicts_mining,
)
from GameSentenceMiner import hoshidicts_mining_note as note_module
from GameSentenceMiner.web import hoshidicts_api
from tests.test_hoshidicts_factories import (
    AUDIO_MEDIA,
    DEFAULT_MODEL_FIELDS,
    DUPLICATE_ERROR,
    FakeAnki,
    duplicate_responses,
    make_audio_profile,
    make_config,
    make_field_templates,
    make_mining_profile,
    make_note_fields,
    make_note_info,
    make_overwrite_modes,
    make_payload,
    make_term_payload,
    wire,
    wire_audio,
)

KIKU_V2_FIELDS = [
    "Expression",
    "ExpressionFurigana",
    "ExpressionReading",
    "ExpressionAudio",
    "RelatedExpression",
    "SelectionText",
    "MainDefinition",
    "DefinitionPicture",
    "Sentence",
    "SentenceFurigana",
    "SentenceTranslation",
    "SentenceAudio",
    "Picture",
    "Glossary",
    "Hint",
    "IsWordAndSentenceCard",
    "IsClickCard",
    "IsSentenceCard",
    "IsAudioCard",
    "PitchPosition",
    "PitchCategories",
    "Frequency",
    "FreqSort",
    "MiscInfo",
]


def _rich_jitendex_payload():
    payload = make_payload()
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


def _validated(payload):
    return hoshidicts_mining.validate_hoshidicts_mining_request(payload)


def _marker_values(payload, markers, **kwargs):
    """Rendered values for templates that only use the given markers."""
    return hoshidicts_mining._template_values_for_fields(
        _validated(payload),
        {"anki": SimpleNamespace()},
        make_field_templates({marker: f"{{{marker}}}" for marker in markers}),
        **kwargs,
    )


def test_profile_defaults_and_normalization(tmp_path):
    missing = tmp_path / "missing.json"
    assert hoshidicts_mining.load_hoshidicts_mining_profile(missing) == make_mining_profile()
    saved = tmp_path / "mining-profile.json"
    saved.write_text(json.dumps(make_mining_profile(fields={"audio": "WordAudio"})), encoding="utf-8")
    assert hoshidicts_mining.load_hoshidicts_mining_profile(saved)["fields"]["audio"] == "WordAudio"

    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "enabled": False,
            "deck": "Mining",
            "model": "Custom",
            "fields": {"reading": "Kana"},
            "disabledFields": ["pitch", "frequency"],
            "tags": ["hoshidicts", "custom"],
            "duplicateBehavior": "new",
        }
    )
    assert profile["enabled"] is False
    assert profile["deck"] == "Mining"
    assert profile["model"] == "Custom"
    assert profile["fields"]["reading"] == "Kana"
    # Fields Electron omitted come from the defaults.
    assert profile["fields"]["expression"] == ""
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

    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 3,
            "fieldTemplates": make_field_templates(
                {
                    "Front": ("  x {expression}  ", "overwrite"),
                    "Extra": ("", "append"),
                }
            ),
        }
    )
    assert profile["fieldTemplates"] == make_field_templates(
        {
            "Front": ("  x {expression}  ", "overwrite"),
            "Extra": ("", "append"),
        }
    )


def test_profile_v3_preserves_exact_case_sensitive_target_keys():
    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 3,
            "fieldTemplates": make_field_templates({" Front ": "one", "front": ("two", "append")}),
        }
    )

    assert list(profile["fieldTemplates"]) == [" Front ", "front"]
    assert profile["fieldTemplates"][" Front "]["value"] == "one"


@pytest.mark.parametrize(
    ("field_templates", "message"),
    [
        ([], "profile is invalid"),
        ({"Front": "{expression}"}, "field template"),
        ({"Front": {}}, "field template"),
        (
            {"Front": {"value": "{expression}", "overwriteMode": "replace"}},
            "field template",
        ),
    ],
)
def test_profile_v3_rejects_invalid_target_field_templates(field_templates, message):
    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match=message):
        hoshidicts_mining.normalize_hoshidicts_mining_profile({"version": 3, "fieldTemplates": field_templates})


def test_profile_normalizes_yomitan_duplicate_settings_and_overwrite_modes():
    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 3,
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
    assert profile["fieldOverwriteModes"] == make_overwrite_modes(
        expression="overwrite",
        reading="skip",
        definition="append",
        sentence="prepend",
        frequency="coalesce-new",
    )


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"fields": []}, "profile is invalid"),
        ({"tags": "hoshidicts"}, "profile is invalid"),
        ({"fieldTemplates": []}, "profile is invalid"),
        ({"version": 4}, "version is unsupported"),
        ({"version": 2}, "version is unsupported"),
    ],
)
def test_profile_rejects_invalid_settings(overrides, message):
    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match=message):
        hoshidicts_mining.normalize_hoshidicts_mining_profile(overrides)


def test_status_inherits_gsm_fields_and_auto_maps_dictionary_fields(monkeypatch):
    fake_anki = FakeAnki()
    wire(monkeypatch, fake_anki)

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
    wire(monkeypatch, fake_anki, make_mining_profile(model="Kiku", deck="Japanese"))

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    kiku_fields = {
        "expression": "Expression",
        "reading": "ExpressionReading",
        "definition": "Glossary",
        "sentence": "Sentence",
        "frequency": "Frequency",
        "pitch": "PitchPosition",
        "audio": "",
    }
    expected = {
        "connected": True,
        "gsmAnkiEnabled": True,
        "decks": ["Default", "Japanese"],
        "noteTypes": ["Basic", "Kiku"],
        "selectedNoteType": "Kiku",
        "fields": fields,
        "suggestedFields": kiku_fields,
        "resolvedFields": kiku_fields,
        "warnings": [],
        "error": None,
    }
    assert {key: options[key] for key in expected} == expected
    assert fake_anki.kwargs_for("modelFieldNames") == {
        "timeout": hoshidicts_anki.ANKI_CONNECT_TIMEOUT_SECONDS,
        "modelName": "Kiku",
    }


@pytest.mark.parametrize(
    ("model", "fields", "expected"),
    [
        pytest.param(
            "",
            [
                "Mystery",
                "ExpressionReading",
                "Glossary",
                "Sentence",
                "Frequency",
                "PitchPosition",
                "WordAudio",
                "Extra",
            ],
            {
                "Mystery": "",
                "ExpressionReading": "{reading}",
                "Glossary": "{glossary}",
                "Sentence": "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
                "Frequency": "{frequencies}",
                "PitchPosition": "{pitch-accent-positions}",
                "WordAudio": "{audio}",
                "Extra": "",
            },
            id="unknown-first-field-is-not-guessed-by-position",
        ),
        pytest.param(
            "Kiku",
            KIKU_V2_FIELDS,
            {
                "Expression": "{expression}",
                "ExpressionFurigana": "{furigana-plain}",
                "ExpressionReading": "{reading}",
                "ExpressionAudio": "{audio}",
                "RelatedExpression": "",
                "SelectionText": "{popup-selection-text}",
                "MainDefinition": "{main-definition}",
                "DefinitionPicture": "",
                "Sentence": "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
                "SentenceFurigana": "{sentence-furigana-plain}",
                "SentenceTranslation": "",
                "SentenceAudio": "",
                "Picture": "",
                "Glossary": "{glossary}",
                "Hint": "",
                "IsWordAndSentenceCard": "",
                "IsClickCard": "",
                "IsSentenceCard": "",
                "IsAudioCard": "",
                "PitchPosition": "{pitch-accent-positions}",
                "PitchCategories": "{pitch-accent-categories}",
                "Frequency": "{frequencies}",
                "FreqSort": "{frequency-harmonic-rank}",
                "MiscInfo": "{document-title}",
            },
            id="kiku-v2-yomitan-field-setup",
        ),
        pytest.param(
            "",
            ["ID", "Expression", "Word", "Reading", "Kana", "Extra"],
            {
                "ID": "",
                "Expression": "{expression}",
                "Word": "",
                "Reading": "{reading}",
                "Kana": "",
                "Extra": "",
            },
            id="only-one-target-per-semantic-field",
        ),
        pytest.param(
            "",
            ["Reading", "Expression", "Extra"],
            {"Reading": "{reading}", "Expression": "{expression}", "Extra": ""},
            id="atypically-ordered-first-field-beats-the-fallback",
        ),
    ],
)
def test_options_suggest_yomitan_field_templates(monkeypatch, model, fields, expected):
    fake_anki = FakeAnki(fields=fields, model_names=["Mining", "Kiku"])
    wire(monkeypatch, fake_anki, make_mining_profile(model=model))

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["suggestedFieldTemplates"] == expected
    assert options["resolvedFieldTemplates"] == make_field_templates(expected)


@pytest.mark.parametrize(
    ("fields", "word_field", "sentence_field", "expected"),
    [
        (
            ["Sentence"],
            "Sentence",
            "Sentence",
            "{expression}<br>{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
        ),
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
    wire(
        monkeypatch,
        fake_anki,
        config=make_config(word_field=word_field, sentence_field=sentence_field),
    )

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["suggestedFieldTemplates"] == {fields[0]: expected}
    assert options["resolvedFieldTemplates"] == make_field_templates({fields[0]: expected})


def test_options_use_authoritative_templates_and_warn_about_stale_targets(monkeypatch):
    fake_anki = FakeAnki(fields=["Front", "Reading", "Extra"])
    profile = make_mining_profile(
        fieldTemplates=make_field_templates(
            {
                "Front": ("x {expression}", "overwrite"),
                "Reading": ("", "append"),
                "Removed": "stale",
            }
        )
    )
    wire(monkeypatch, fake_anki, profile)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["suggestedFieldTemplates"] == {
        "Front": "{expression}",
        "Reading": "{reading}",
        "Extra": "",
    }
    assert options["resolvedFieldTemplates"] == make_field_templates(
        {"Front": ("x {expression}", "overwrite"), "Reading": ("", "append"), "Extra": ""}
    )
    assert options["warnings"] == ['Hoshidicts field template "Removed" is not in note type "Mining".']


def test_status_recognizes_semantics_in_raw_yomitan_templates(monkeypatch):
    fields = ["Front", "Reading", "Definition", "Sentence", "Frequency", "PitchPosition"]
    fake_anki = FakeAnki(fields=fields)
    profile = make_mining_profile(
        fieldTemplates=make_field_templates(
            {
                "Front": "{expression}",
                "Reading": "{furigana-plain}",
                "Definition": "{jpmn-primary-definition}",
                "Sentence": "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
                "Frequency": "{single-frequency-number-Frequency}",
                "PitchPosition": "{pitch-accent-positions}",
            }
        )
    )
    wire(monkeypatch, fake_anki, profile)

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
    profile = make_mining_profile(fieldTemplates=make_field_templates({"Front": "", "Expression": "{expression}"}))
    wire(monkeypatch, fake_anki, profile)

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
    fake_anki = FakeAnki(fields=fields, model_names=["Mining", "My Japanese Card"])
    wire(monkeypatch, fake_anki)

    options = hoshidicts_mining.get_hoshidicts_mining_options("my japanese card")

    assert options["connected"] is True
    assert options["gsmAnkiEnabled"] is True
    assert options["selectedNoteType"] == "My Japanese Card"
    assert options["fields"] == fields
    assert options["suggestedFields"]["definition"] == "Glossary"
    assert options["suggestedFields"]["pitch"] == "PitchPosition"


def test_options_selected_different_note_type_ignores_saved_target_templates(monkeypatch):
    fake_anki = FakeAnki(
        fields=["Expression", "Reading", "Extra"],
        model_names=["Old Card", "New Card"],
    )
    profile = make_mining_profile(
        model="Old Card",
        fieldTemplates=make_field_templates(
            {
                "Expression": ("old {definition}", "append"),
                "Reading": ("old literal", "overwrite"),
            }
        ),
    )
    wire(monkeypatch, fake_anki, profile)

    options = hoshidicts_mining.get_hoshidicts_mining_options("new card")

    assert options["selectedNoteType"] == "New Card"
    assert options["resolvedFieldTemplates"] == make_field_templates(
        {"Expression": "{expression}", "Reading": "{reading}", "Extra": ""}
    )
    assert options["warnings"] == []


def test_options_explicit_automatic_uses_config_model_without_old_legacy_mappings(monkeypatch):
    fake_anki = FakeAnki(
        fields=["Expression", "Reading", "Sentence"],
        model_names=["Old Card", "Configured Card"],
    )
    profile = make_mining_profile(
        model="Old Card",
        fields={**make_mining_profile()["fields"], "reading": "Sentence"},
        disabledFields=["expression"],
        fieldOverwriteModes=make_overwrite_modes(reading="append", sentence="overwrite"),
    )
    wire(monkeypatch, fake_anki, profile, config=make_config(note_type="Configured Card"))

    options = hoshidicts_mining.get_hoshidicts_mining_options("")

    assert options["selectedNoteType"] == "Configured Card"
    assert options["resolvedFieldTemplates"] == make_field_templates(
        {
            "Expression": "{expression}",
            "Reading": "{reading}",
            "Sentence": "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
        }
    )
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
    fake_anki = FakeAnki(fields=["Expression", "Reading"], model_names=["Mining"])
    profile = make_mining_profile(
        model="MINING",
        fieldTemplates=make_field_templates({"Expression": ("saved {expression}", "append")}),
    )
    wire(monkeypatch, fake_anki, profile)

    options = hoshidicts_mining.get_hoshidicts_mining_options("mining")

    assert options["resolvedFieldTemplates"] == make_field_templates(
        {"Expression": ("saved {expression}", "append"), "Reading": ""}
    )


def test_options_probe_ankiconnect_when_gsm_anki_is_disabled(monkeypatch):
    fake_anki = FakeAnki()
    wire(monkeypatch, fake_anki, config=make_config(enabled=False))

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["connected"] is True
    assert options["gsmAnkiEnabled"] is False
    assert options["noteTypes"] == ["Mining"]
    assert options["decks"] == ["Default", "Mining"]
    assert options["fields"] == fake_anki.fields
    assert options["error"] == "GSM Anki integration is disabled."
    assert fake_anki.actions() == ["modelNames", "deckNames", "modelFieldNames"]


def test_options_report_an_ankiconnect_failure(monkeypatch):
    wire(monkeypatch, FakeAnki(responses={"*": RuntimeError("connection refused")}))

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["connected"] is False
    assert options["gsmAnkiEnabled"] is True
    assert options["error"] == "Could not connect to Anki through GSM: connection refused"


def test_options_keep_partial_ankiconnect_results(monkeypatch):
    fake_anki = FakeAnki(responses={"deckNames": TimeoutError("deck lookup timed out")})
    wire(monkeypatch, fake_anki)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["connected"] is True
    assert options["noteTypes"] == ["Mining"]
    assert options["decks"] == []
    assert options["fields"] == fake_anki.fields
    assert options["resolvedFields"]["expression"] == "Expression"
    assert options["error"] is None
    assert options["warnings"] == ["Could not load Anki decks: deck lookup timed out"]


def test_status_deduplicates_short_lived_ankiconnect_checks(monkeypatch):
    fake_anki = FakeAnki()
    wire(monkeypatch, fake_anki)

    first = hoshidicts_mining.get_hoshidicts_mining_status()
    second = hoshidicts_mining.get_hoshidicts_mining_status()

    assert first == second
    assert fake_anki.actions() == ["modelFieldNames", "deckNames"]


def test_mining_preserves_dictionary_metadata_and_queues_gsm_enrichment(monkeypatch):
    fake_anki = FakeAnki()
    wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert result == {
        "success": True,
        "noteId": 42,
        "unmappedFields": ["audio"],
        "audio": {"status": "skipped"},
    }
    add_note = fake_anki.note_for()
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
    assert add_note["tags"] == ["GSM", "Game::Test", "mine", "hoshidicts", "overlay"]
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
    profile = make_mining_profile(
        fieldTemplates=make_field_templates(
            {
                "Front": "prefix {expression} / {reading}",
                "Definition": "{definition}",
                "Custom": "x",
                "Unused": "",
            }
        )
    )
    wire(monkeypatch, fake_anki, profile)

    hoshidicts_mining.mine_hoshidicts_note(make_payload())

    note = fake_anki.note_for()
    assert list(note["fields"]) == fields
    assert note["fields"]["Front"] == "prefix 食べる / たべる"
    assert note["fields"]["Reading"] == ""
    assert "to eat" in note["fields"]["Definition"]
    assert note["fields"]["Custom"] == "x"
    assert note["fields"]["Unused"] == ""


def test_mining_renders_common_raw_yomitan_field_markers(monkeypatch):
    templates = {
        "Front": "{expression}",
        "Reading": "{furigana-plain}",
        "Definition": "{jpmn-primary-definition}",
        "Sentence": "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}",
        "Frequency": "{single-frequency-number-Frequency}",
        "PitchPosition": "{pitch-accent-positions}",
        "PitchGraph": "{pitch-accent-graphs}",
    }
    fake_anki = FakeAnki(fields=list(templates))
    wire(monkeypatch, fake_anki, make_mining_profile(fieldTemplates=make_field_templates(templates)))

    hoshidicts_mining.mine_hoshidicts_note(make_payload())

    note = fake_anki.note_for()
    assert note["fields"]["Front"] == "食べる"
    assert note["fields"]["Reading"] == "食[た]べる"
    assert "to eat" in note["fields"]["Definition"]
    assert note["fields"]["Sentence"] == "昨日、<b>食べた</b>。"
    assert note["fields"]["Frequency"] == "123"
    assert note["fields"]["PitchPosition"] == "2"
    assert "LHL" in note["fields"]["PitchGraph"]


def test_kiku_yomitan_sort_and_pitch_markers_render_matching_values():
    payload = make_payload(documentTitle="Kiku source title", popupSelectionText="食べた")
    payload["result"]["term"]["frequencies"] = [
        {
            "dictionary": "Rank A",
            "frequencyMode": "rank-based",
            "frequencies": [{"value": 100, "displayValue": "100 rank"}],
        },
        {
            "dictionary": "Rank B",
            "frequencyMode": "rank-based",
            "frequencies": [{"value": 400, "displayValue": None}],
        },
        {
            "dictionary": "Occurrence",
            "frequencyMode": "occurrence-based",
            "frequencies": [{"value": 50_000, "displayValue": None}],
        },
    ]

    values = hoshidicts_mining._field_template_values(_validated(payload))

    assert values["{popup-selection-text}"] == "食べた"
    assert values["{document-title}"] == "Kiku source title"
    assert values["{cloze-prefix}"] == "昨日、"
    assert values["{cloze-body}"] == "食べた"
    assert values["{cloze-suffix}"] == "。"
    assert values["{pitch-accent-positions}"] == "2"
    assert values["{pitch-accent-categories}"] == "kifuku"
    assert values["{frequency-harmonic-rank}"] == "160"


@pytest.mark.parametrize(
    ("rules", "reading", "position", "expected"),
    [
        ("", "たべる", 0, "heiban"),
        ("", "たべる", 1, "atamadaka"),
        ("", "たべる", 2, "nakadaka"),
        ("", "たべる", 3, "odaka"),
        ("v1", "たべる", 2, "kifuku"),
        ("vs n", "きょう", 2, "odaka"),
    ],
)
def test_kiku_pitch_categories_match_yomitan(rules, reading, position, expected):
    payload = make_term_payload(rules=rules, reading=reading)
    payload["result"]["term"]["pitches"][0]["pitches"][0]["position"] = position

    values = hoshidicts_mining._field_template_values(_validated(payload))

    assert values["{pitch-accent-categories}"] == expected


@pytest.mark.parametrize(
    ("expression", "reading", "plain", "ruby"),
    [
        (
            "頭を抱える",
            "あたまをかかえる",
            "頭[あたま]を 抱[かか]える",
            "<ruby>頭<rt>あたま</rt></ruby>を<ruby>抱<rt>かか</rt></ruby>える",
        ),
        ("ワガハイ", "わがはい", "ワガハイ", "ワガハイ"),
    ],
)
def test_expression_furigana_uses_segmented_anki_syntax_and_ruby(expression, reading, plain, ruby):
    payload = make_term_payload(expression=expression, reading=reading)

    values = hoshidicts_mining._field_template_values(_validated(payload))

    assert values["{furigana-plain}"] == plain
    assert values["{furigana}"] == ruby


def test_expression_ruby_furigana_preserves_intentional_source_space(monkeypatch):
    payload = make_term_payload(expression="foo 食べる", reading="foo たべる")
    monkeypatch.setattr(
        hoshidicts_mining,
        "_expression_furigana_plain",
        lambda _expression, _reading: "foo 食[た]べる",
    )

    values = hoshidicts_mining._field_template_values(_validated(payload))

    assert values["{furigana}"] == "foo <ruby>食<rt>た</rt></ruby>べる"
    assert values["{furigana-plain}"] == "foo 食[た]べる"
    assert (
        hoshidicts_mining._render_anki_furigana("foo 食[た]べる", ruby=True, source="alignment fails")
        == "foo <ruby>食<rt>た</rt></ruby>べる"
    )


def test_sentence_ruby_furigana_preserves_space_before_highlight():
    payload = make_payload(sentence="foo 食べる", matchOffset=4)
    payload["result"]["matched"] = "食べる"
    fake_anki = SimpleNamespace(
        tokenizer=SimpleNamespace(reading=lambda _sentence: "foo  食[た]べる"),
        _preserve_html_tags_for_furigana=lambda source, _reading: source.replace(
            "<gsm-hoshidicts-match>食べる",
            "<gsm-hoshidicts-match> 食[た]べる",
        ),
    )

    rich, plain = hoshidicts_mining._sentence_furigana_values(_validated(payload), fake_anki, {})

    assert rich == "foo <b><ruby>食<rt>た</rt></ruby>べる</b>"
    assert plain == "foo <b> 食[た]べる</b>"


def test_field_template_unknown_brace_literals_are_not_treated_as_markers():
    values = hoshidicts_mining._field_template_values(
        _validated(make_payload()),
        audio_value="[sound:test.mp3]",
    )
    unknown_literals = "{audiobook}|{expressionless}|{spreadsheet-reading-list}"

    rendered = hoshidicts_markers.render_template(f"{unknown_literals}|{{audio}}|{{expression}}", values)

    assert rendered == f"{unknown_literals}|[sound:test.mp3]|食べる"
    assert hoshidicts_markers.template_uses_audio(unknown_literals) is False
    assert hoshidicts_markers.semantic_field_targets(make_field_templates({"Literal": unknown_literals})) == {
        key: "" for key in hoshidicts_markers.FIELD_KEYS
    }

    unsupported = hoshidicts_markers.render_template(
        "{url}<br>{document-title}<br>{clipboard-text}<br>{screenshot}<br>{audiobook}",
        values,
    )
    assert unsupported == "{audiobook}"


def test_jitendex_structured_glossary_preserves_semantic_html_without_styles():
    payload = _rich_jitendex_payload()
    payload.pop("dictionaryStyles")

    rendered = note_module.definition_html(_validated(payload))

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


@pytest.mark.parametrize(
    "href",
    ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "//evil.test/x"],
)
def test_structured_content_drops_links_yomitan_would_reject(href):
    rendered = note_module._structured_content_html(
        {"tag": "a", "href": href, "content": "click"},
        dictionary="Dict",
        dictionary_media={},
    )

    assert rendered == '<a class="gloss-link"><span class="gloss-link-text">click</span></a>'
    assert href not in rendered
    assert "external-link" not in rendered


def test_structured_img_extreme_dimensions_clamped():
    # A positive-but-subnormal width (e.g. 1e-320) survives the `width > 0`
    # guard yet makes height/width overflow to inf, so the padding-top CSS used
    # to render as "inf%". The ratio must stay finite and bounded.
    rendered = note_module._structured_content_html(
        {
            "type": "image",
            "path": "img/x.png",
            "preferredWidth": 1e-320,
            "preferredHeight": 100,
        },
        dictionary="Dict",
        dictionary_media={("Dict", "img/x.png"): "gsm_img.png"},
    )

    assert "inf" not in rendered
    padding = re.search(r"padding-top:\s*([0-9.eE+-]+)%", rendered)
    assert padding is not None
    ratio = float(padding.group(1))
    assert 0 < ratio < 1_000_000  # finite, bounded percentage


def test_frequency_html_renders_integral_floats_without_a_decimal_point():
    request = note_module.validate_hoshidicts_mining_request(
        make_term_payload(frequencies=[{"dictionary": "BCCWJ", "frequencies": [{"value": 1000.0}]}])
    )

    assert note_module.frequency_html(request) == "<b>BCCWJ</b>: 1000"


def test_structured_glossary_outer_list_wraps_each_structured_item_and_preserves_mixed_entries():
    payload = make_payload()
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

    rendered = note_module.definition_html(_validated(payload))

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
    request = _validated(_rich_jitendex_payload())

    rendered = note_module.definition_html(request)

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
    object_request = _validated(object_payload)
    assert object_request["dictionaryStyles"] == {
        "Jitendex": ("@media (min-width: 10px) {.sense, [data-sc-content=glossary] { color: red; }}"),
    }
    object_rendered = note_module.definition_html(object_request)
    assert "@media (min-width: 10px)" in object_rendered
    assert '.yomitan-glossary [data-dictionary="Jitendex"] .sense' in object_rendered
    assert ('.yomitan-glossary [data-dictionary="Jitendex"] [data-sc-content=glossary]') in object_rendered


def test_static_yomitan_glossary_variants_preserve_their_exact_semantics():
    payload = _rich_jitendex_payload()
    payload["result"]["term"]["glossaries"][-1]["glossary"] = "I; me\nself <unsafe>"

    values = hoshidicts_mining._field_template_values(_validated(payload))

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


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("  Character_Dictionary　東京!! 2026  ", "character-dictionary-東京-2026"),
        ("École__猫 $$$", "école-猫"),
        ("A—B---C", "ab-c"),
        ("İ", "i̇"),
    ],
)
def test_yomitan_dictionary_kebab_case_matches_unicode_rules(value, expected):
    assert hoshidicts_mining._yomitan_kebab_case(value) == expected


def test_dynamic_single_glossary_markers_render_only_used_dictionary_variants():
    payload = _rich_jitendex_payload()
    dictionary = "Character Dictionary　東京_2026!"
    for glossary in payload["result"]["term"]["glossaries"][:2]:
        glossary["dictionary"] = dictionary
    payload["dictionaryStyles"][0]["dictionary"] = dictionary
    base = "single-glossary-character-dictionary-東京-2026"
    used_markers = [
        base,
        f"{base}-brief",
        f"{base}-no-dictionary",
        f"{base}-plain",
        f"{base}-plain-no-dictionary",
        "single-glossary-removed-dictionary",
    ]

    values = _marker_values(payload, used_markers)

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

    assert hoshidicts_markers.render_template("{single-glossary-removed-dictionary}", values) == ""


def test_dynamic_single_glossary_exact_dictionary_name_wins_suffix_ambiguity():
    payload = make_payload()
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
    marker = "single-glossary-foo-brief"

    rendered = _marker_values(payload, [marker])[f"{{{marker}}}"]

    assert 'data-dictionary="Foo Brief"' in rendered
    assert 'data-dictionary="Foo"' not in rendered
    assert "exact dictionary definition" in rendered
    assert "foo definition" not in rendered


def test_dynamic_single_frequency_markers_use_canonical_slug_alias_and_exact_display_html():
    payload = make_payload(
        dictionaryAliases=[{"dictionary": "Corpus Rank 2026!", "alias": "Corpus <Rank>"}],
    )
    payload["result"]["term"]["frequencies"] = [
        {
            "dictionary": "Corpus Rank 2026!",
            "frequencyMode": "occurrence-based",
            "frequencies": [
                {"value": 999, "displayValue": "001 rank"},
                {"value": 321, "displayValue": None},
            ],
        },
        {
            "dictionary": "Other",
            "frequencies": [{"value": 7, "displayValue": "other value"}],
        },
    ]
    display_marker = "single-frequency-corpus-rank-2026"
    number_marker = "single-frequency-number-corpus-rank-2026"
    alias_slug_marker = "single-frequency-corpus-rank"
    missing_marker = "single-frequency-removed-dictionary"

    values = _marker_values(
        payload,
        [display_marker, number_marker, alias_slug_marker, missing_marker],
    )

    assert values[f"{{{display_marker}}}"] == (
        '<ul style="text-align: left;"><li>Corpus &lt;Rank&gt;: 001 rank</li><li>Corpus &lt;Rank&gt;: 321</li></ul>'
    )
    assert values[f"{{{number_marker}}}"] == "1"
    assert f"{{{alias_slug_marker}}}" not in values
    assert f"{{{missing_marker}}}" not in values
    assert hoshidicts_markers.render_template(f"{{{alias_slug_marker}}}", values) == ""
    assert hoshidicts_markers.render_template(f"{{{missing_marker}}}", values) == ""


@pytest.mark.parametrize(
    ("frequencies", "frequency_mode", "expected"),
    [
        ([{"value": 999, "displayValue": "001 rank"}], "rank-based", "1"),
        ([{"value": 999, "displayValue": "12.75 ★"}], "occurrence-based", "12"),
        ([{"value": 12.75, "displayValue": ""}], None, "12.75"),
        ([{"value": 7, "displayValue": " 42"}], None, "7"),
        ([{"value": 5, "displayValue": "0 rank"}], None, "5"),
        ([{"value": 0, "displayValue": None}], None, ""),
        ([{"value": -1.5, "displayValue": "<rare>"}], None, ""),
        (
            [
                {"value": -1.5, "displayValue": "<rare>"},
                {"value": 99, "displayValue": "99 rank"},
            ],
            None,
            "",
        ),
    ],
)
def test_dynamic_single_frequency_number_matches_yomitan_first_value_semantics(
    frequencies,
    frequency_mode,
    expected,
):
    payload = make_payload()
    group = {"dictionary": "Frequency", "frequencies": frequencies}
    if frequency_mode is not None:
        group["frequencyMode"] = frequency_mode
    payload["result"]["term"]["frequencies"] = [group]
    marker = "single-frequency-number-frequency"

    assert _marker_values(payload, [marker])[f"{{{marker}}}"] == expected


@pytest.mark.parametrize(
    ("dictionary_order", "expected"),
    [
        (
            ("Foo", "Number Foo"),
            '<ul style="text-align: left;"><li>Number Foo: 13 rank</li></ul>',
        ),
        (("Number Foo", "Foo"), "7"),
    ],
)
def test_dynamic_single_frequency_marker_collisions_follow_yomitan_last_definition_wins(
    dictionary_order,
    expected,
):
    groups = {
        "Foo": {
            "dictionary": "Foo",
            "frequencies": [{"value": 7, "displayValue": "7 rank"}],
        },
        "Number Foo": {
            "dictionary": "Number Foo",
            "frequencies": [{"value": 13, "displayValue": "13 rank"}],
        },
    }
    payload = make_payload()
    payload["result"]["term"]["frequencies"] = [groups[dictionary] for dictionary in dictionary_order]
    marker = "single-frequency-number-foo"

    assert _marker_values(payload, [marker])[f"{{{marker}}}"] == expected


def test_dynamic_single_frequency_marker_collision_uses_configured_dictionary_order_when_owner_has_no_value():
    payload = make_payload(frequencyDictionaries=["Foo", "Foo!"])
    payload["result"]["term"]["frequencies"] = [
        {
            "dictionary": "Foo",
            "frequencies": [{"value": 7, "displayValue": "7 rank"}],
        }
    ]
    marker = "single-frequency-foo"

    assert _marker_values(payload, [marker])[f"{{{marker}}}"] == ""


def test_dictionary_style_grouping_nesting_is_bounded_without_unscoped_fallback():
    payload = make_payload(
        dictionaryStyles={"JMdict": ("@media all{" * 1100) + ".sense{color:red}" + ("}" * 1100)},
    )

    rendered = note_module.definition_html(_validated(payload))

    assert rendered.count("@media all") < 100
    assert ".sense{color:red}" not in rendered
    assert '<li data-dictionary="JMdict">' in rendered


def test_glossary_text_deep_nesting_is_bounded_by_depth_cap():
    # Drive the public _glossary_text seam (json.loads -> _append_structured_text)
    # rather than the private helper, so the guard is exercised through the real
    # entry point. A leaf nested just past MAX_STRUCTURED_CONTENT_DEPTH is dropped
    # without a RecursionError; a leaf nested exactly at the cap survives. Both
    # depths stay tiny (portable: no json.dumps/loads stack risk from a 5000-deep
    # structure), so removing the depth cap keeps the over-deep leaf and turns
    # this assertion red.
    max_depth = note_module.MAX_STRUCTURED_CONTENT_DEPTH

    def nest(leaf: object, times: int) -> object:
        value = leaf
        for _ in range(times):
            value = [value]
        return value

    over_cap = json.dumps(nest("deep-leaf", max_depth + 1))
    assert note_module._glossary_text(over_cap) == ""

    at_cap = json.dumps(nest("edge-leaf", max_depth))
    assert note_module._glossary_text(at_cap) == "edge-leaf"


def test_dictionary_style_scoping_handles_comments_before_at_rules_and_selector_commas():
    payload = make_payload(
        dictionaryStyles={
            "JMdict": ("/* header */ @media all { span { color: red; } }/* a,b */ span, em { font-weight: bold; }"),
        },
    )

    rendered = note_module.definition_html(_validated(payload))
    scope = '.yomitan-glossary [data-dictionary="JMdict"]'

    assert f"/* header */ @media all {{ {scope} span" in rendered
    assert f"/* a,b */ {scope} span, {scope} em" in rendered
    assert f"{scope} /* header */" not in rendered
    assert rendered.count("/* a,b */") == 1


def test_dictionary_styles_are_bounded_by_count_and_length():
    payload = make_payload(dictionaryStyles={"JMdict": "x" * note_module.MAX_DICTIONARY_STYLE_BYTES})
    assert len(_validated(payload)["dictionaryStyles"]["JMdict"]) == note_module.MAX_DICTIONARY_STYLE_BYTES

    payload["dictionaryStyles"] = {"JMdict": "x" * (note_module.MAX_DICTIONARY_STYLE_BYTES + 100)}
    assert len(_validated(payload)["dictionaryStyles"]["JMdict"]) == note_module.MAX_DICTIONARY_STYLE_BYTES

    payload["dictionaryStyles"] = {f"Dictionary {index}": "" for index in range(note_module.MAX_DICTIONARY_STYLES + 1)}
    assert len(_validated(payload)["dictionaryStyles"]) == note_module.MAX_DICTIONARY_STYLES


def test_duplicate_check_endpoint_preserves_dictionary_styles_in_rendered_note(monkeypatch):
    fake_anki = FakeAnki(
        fields=["Definition"],
        responses={"canAddNotesWithErrorDetail": [{"canAdd": True, "error": None}]},
    )
    wire(
        monkeypatch,
        fake_anki,
        make_mining_profile(fieldTemplates=make_field_templates({"Definition": "{definition}"})),
    )
    app = Flask(__name__)
    hoshidicts_api.register_hoshidicts_api_routes(app)

    response = app.test_client().post(
        "/api/hoshidicts/mining/check",
        json={"notes": [_rich_jitendex_payload()]},
    )

    assert response.status_code == 200
    assert response.get_json()["success"] is True
    definition = fake_anki.kwargs_for("canAddNotesWithErrorDetail")["notes"][0]["fields"]["Definition"]
    assert '<style>.yomitan-glossary [data-dictionary="Jitendex"]' in definition
    assert '.yomitan-glossary [data-dictionary="JMdict"] .gloss-sc-li' in definition
    assert "Not selected" not in definition


def test_duplicate_check_endpoint_marks_a_rendered_blank_first_field_as_note_specific(monkeypatch):
    fake_anki = FakeAnki(fields=["Reading"])
    wire(
        monkeypatch,
        fake_anki,
        make_mining_profile(fieldTemplates=make_field_templates({"Reading": "{reading}"})),
    )
    app = Flask(__name__)
    hoshidicts_api.register_hoshidicts_api_routes(app)

    response = app.test_client().post(
        "/api/hoshidicts/mining/check",
        json={"notes": [make_term_payload(reading="")]},
    )

    assert response.status_code == 422
    assert response.get_json() == {
        "success": False,
        "error": 'The first Anki field "Reading" is empty. Map it to a value before mining.',
    }
    assert not any(action.startswith("canAddNotes") for action in fake_anki.actions())


def test_rich_definition_markers_render_primary_full_dictionary_and_furigana(monkeypatch):
    templates = {
        "Expression": "{expression}",
        "ExpressionFurigana": "{furigana-plain}",
        "ExpressionRuby": "{furigana}",
        "SentenceFurigana": "{sentence-furigana-plain}",
        "SentenceRuby": "{sentence-furigana}",
        "MainDefinition": "{main-definition}",
        "Glossary": "{glossary}",
        "Definition": "{definition}",
        "Dictionary": "{dictionary}",
    }
    fake_anki = FakeAnki(fields=list(templates))
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
    wire(monkeypatch, fake_anki, make_mining_profile(fieldTemplates=make_field_templates(templates)))

    hoshidicts_mining.mine_hoshidicts_note(_rich_jitendex_payload())

    note = fake_anki.note_for()
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
    templates = {
        "Glossary": ("{glossary}", "overwrite"),
        "MainDefinition": ("{main-definition}", "overwrite"),
        "Expression": ("{expression}", "overwrite"),
        "YomitanContext": (
            "{dictionary}|{dictionary-alias}|{conjugation}|{part-of-speech}|"
            "{phonetic-transcriptions}|{tags}|{popup-selection-text}|"
            "{document-title}|{search-query}",
            "overwrite",
        ),
    }
    fake_anki = FakeAnki(
        fields=list(templates),
        responses={"canAddNotesWithErrorDetail": [{"canAdd": True, "error": None}]},
    )
    wire(monkeypatch, fake_anki, make_mining_profile(fieldTemplates=make_field_templates(templates)))
    payload = _kiku_yomitan_parity_payload()

    check = hoshidicts_mining.check_hoshidicts_notes({"notes": [payload]})
    result = hoshidicts_mining.mine_hoshidicts_note(payload)

    assert check["results"] == [{"state": "addable", "canAdd": True, "duplicate": False}]
    checked_note = fake_anki.kwargs_for("canAddNotesWithErrorDetail")["notes"][0]
    added_note = fake_anki.note_for()
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
    media_call = fake_anki.kwargs_for("storeMediaFile")
    assert media_call["filename"] == ("yomitan_dictionary_media_37d6f763c8ebb201e600de788daaa4cfe00ba13c.jpeg")
    assert media_call["data"] == "/9j/4AA="
    assert result["noteId"] == 42


@pytest.mark.parametrize(
    ("stored_filename", "message"),
    [
        pytest.param("", "did not return a stored dictionary media filename", id="blank-filename"),
        pytest.param(
            RuntimeError("media collection is locked"),
            "Could not store Hoshidicts dictionary media",
            id="storage-error",
        ),
    ],
)
def test_mining_reports_dictionary_media_storage_failures(monkeypatch, stored_filename, message):
    templates = {"Glossary": "{glossary}", "Expression": "{expression}"}
    fake_anki = FakeAnki(fields=list(templates), responses={"storeMediaFile": stored_filename})
    wire(monkeypatch, fake_anki, make_mining_profile(fieldTemplates=make_field_templates(templates)))

    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match=message) as error:
        hoshidicts_mining.mine_hoshidicts_note(_kiku_yomitan_parity_payload())

    assert error.value.status_code == 502
    assert "addNote" not in fake_anki.actions()


def test_sentence_furigana_falls_back_to_safe_highlighted_sentence(monkeypatch):
    templates = {
        "Expression": "{expression}",
        "SentenceFurigana": "{sentence-furigana-plain}",
        "SentenceRuby": "{sentence-furigana}",
    }
    fake_anki = FakeAnki(fields=list(templates))

    def fail_reading(_sentence):
        raise RuntimeError("tokenizer unavailable")

    fake_anki.tokenizer = SimpleNamespace(reading=fail_reading)
    fake_anki._preserve_html_tags_for_furigana = lambda *_args: pytest.fail(
        "preservation should not run after tokenization fails"
    )
    wire(monkeypatch, fake_anki, make_mining_profile(fieldTemplates=make_field_templates(templates)))

    hoshidicts_mining.mine_hoshidicts_note(make_payload())

    note = fake_anki.note_for()
    assert note["fields"]["SentenceFurigana"] == "昨日、<b>食べた</b>。"
    assert note["fields"]["SentenceRuby"] == "昨日、<b>食べた</b>。"


def test_duplicate_check_batch_caches_sentence_tokenization(monkeypatch):
    templates = {"Expression": "{expression}", "SentenceFurigana": "{sentence-furigana-plain}"}
    fake_anki = FakeAnki(
        fields=list(templates),
        responses={
            "canAddNotesWithErrorDetail": lambda notes, **_kwargs: [{"canAdd": True, "error": None} for _note in notes]
        },
    )
    reading_calls = []

    def reading(sentence):
        reading_calls.append(sentence)
        return " 昨日[きのう]、 食[た]べた。"

    fake_anki.tokenizer = SimpleNamespace(reading=reading)
    fake_anki._preserve_html_tags_for_furigana = lambda source, _reading: source
    wire(monkeypatch, fake_anki, make_mining_profile(fieldTemplates=make_field_templates(templates)))

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [make_payload(), make_payload()]})

    assert result["success"] is True
    assert reading_calls == ["昨日、食べた。"]


def test_mining_rejects_an_explicitly_blank_first_model_field(monkeypatch):
    fake_anki = FakeAnki(fields=["Front", "Expression"])
    wire(
        monkeypatch,
        fake_anki,
        make_mining_profile(fieldTemplates=make_field_templates({"Front": "", "Expression": "{expression}"})),
    )

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match='first Anki field "Front" is empty',
    ):
        hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert "addNote" not in fake_anki.actions()


KIKU_LAPIS_FIELDS = [
    "Expression",
    "ExpressionReading",
    "Glossary",
    "Sentence",
    "Frequency",
    "PitchPosition",
]
# The semantic-field profile a legacy Kiku/Lapis setup would have saved, derived
# from the real Kiku mapping so it cannot drift from it.
KIKU_LAPIS_FIELD_MAP = {
    ("definition" if slot == "glossary" else slot): field_name
    for field_name, (slot, _template) in hoshidicts_mining.KIKU_FIELD_TEMPLATES.items()
    if slot in {"expression", "reading", "glossary", "sentence", "frequency", "pitch"}
}


def test_mining_formats_kiku_lapis_pitch_position_as_numeric_positions(monkeypatch):
    fake_anki = FakeAnki(fields=KIKU_LAPIS_FIELDS, model_names=["Kiku"])
    profile = make_mining_profile(model="Kiku", fields=dict(KIKU_LAPIS_FIELD_MAP))
    wire(monkeypatch, fake_anki, profile)

    hoshidicts_mining.mine_hoshidicts_note(make_payload())

    note = fake_anki.note_for()
    assert note["fields"]["PitchPosition"] == "2"
    assert "LHL" not in note["fields"]["PitchPosition"]


def test_mining_automatically_maps_kiku_lapis_without_saved_field_overrides(monkeypatch):
    fake_anki = FakeAnki(fields=KIKU_LAPIS_FIELDS, model_names=["Kiku"])
    wire(monkeypatch, fake_anki, config=make_config(note_type="Kiku"))

    hoshidicts_mining.mine_hoshidicts_note(make_payload())

    note = fake_anki.note_for()
    assert note["fields"]["ExpressionReading"] == "たべる"
    assert "Reading" not in note["fields"]
    assert note["fields"]["Glossary"]
    assert note["fields"]["PitchPosition"] == "2"


def test_mining_honors_explicitly_disabled_fields(monkeypatch):
    fake_anki = FakeAnki()
    wire(monkeypatch, fake_anki, make_mining_profile(disabledFields=["reading", "frequency", "pitch"]))

    options = hoshidicts_mining.get_hoshidicts_mining_options()
    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert options["suggestedFields"]["reading"] == "Reading"
    assert options["resolvedFields"]["reading"] == ""
    note = fake_anki.note_for()
    assert note["fields"]["Reading"] == ""
    assert note["fields"]["Frequency"] == ""
    assert note["fields"]["PitchAccent"] == ""
    assert result["unmappedFields"] == ["audio"]


def test_mining_reports_optional_data_not_supported_by_the_model(monkeypatch):
    fake_anki = FakeAnki(fields=["Expression", "Sentence"])
    wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert result["unmappedFields"] == ["reading", "definition", "frequency", "pitch", "audio"]
    assert fake_anki.note_for()["fields"] == {
        "Expression": "食べる",
        "Sentence": "昨日、<b>食べた</b>。",
    }


def test_mining_honors_profile_overrides(monkeypatch):
    fake_anki = FakeAnki(fields=["Front", "Kana", "Back", "Context", "Rank", "Accent"])
    profile = make_mining_profile(
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
    wire(monkeypatch, fake_anki, profile)

    hoshidicts_mining.mine_hoshidicts_note(make_payload())

    add_note = fake_anki.note_for()
    assert add_note["deckName"] == "Mining"
    assert add_note["modelName"] == "Custom"
    assert set(add_note["fields"]) == {"Front", "Kana", "Back", "Context", "Rank", "Accent"}
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
            "version": 3,
            "fields": {"expression": "Front", "definition": "Front"},
            "fieldOverwriteModes": {"expression": "append", "definition": "overwrite"},
        }
    )
    wire(monkeypatch, fake_anki, profile)

    options = hoshidicts_mining.get_hoshidicts_mining_options()

    assert options["resolvedFieldTemplates"] == make_field_templates(
        {"Front": ("{expression}<br>{definition}", "append")}
    )


def test_migrated_shared_target_omits_separators_for_empty_values(monkeypatch):
    fake_anki = FakeAnki(fields=["Front"])
    profile = hoshidicts_mining.normalize_hoshidicts_mining_profile(
        {
            "version": 3,
            "fields": {"expression": "Front", "reading": "Front", "frequency": "Front"},
        }
    )
    wire(monkeypatch, fake_anki, profile)
    payload = make_term_payload(reading="", frequencies=[])

    hoshidicts_mining.mine_hoshidicts_note(payload)

    assert fake_anki.note_for()["fields"] == {"Front": "食べる"}


def test_mining_stores_selected_pronunciation_after_note_creation(monkeypatch):
    fake_anki = FakeAnki(fields=[*DEFAULT_MODEL_FIELDS, "WordAudio"])
    audio_profile = make_audio_profile(
        {
            "id": "source",
            "type": "custom",
            "url": "https://audio.test/{term}.mp3",
            "voice": "",
        }
    )
    selection = {"sourceId": "source", "candidateIndex": 1, "candidateId": "a" * 64}

    def get_mining_audio(term, reading, requested_selection, *, profile):
        assert (term, reading) == ("食べる", "たべる")
        assert requested_selection == selection
        assert profile is audio_profile
        return AUDIO_MEDIA

    wire_audio(monkeypatch, fake_anki, audio_profile=audio_profile, resolver=get_mining_audio)
    payload = make_term_payload(expression=" 食べる ", reading=" たべる ")
    payload["audioSelection"] = selection

    result = hoshidicts_mining.mine_hoshidicts_note(payload)

    assert result["audio"]["status"] == "stored"
    assert result["audio"]["filename"].startswith("gsm_hoshidicts_")
    actions = fake_anki.actions()
    assert actions.index("addNote") < actions.index("storeMediaFile") < actions.index("updateNoteFields")
    stored = fake_anki.kwargs_for("storeMediaFile")
    assert stored["filename"] == result["audio"]["filename"]
    assert stored["data"] == "SUQzcHJvbnVuY2lhdGlvbg=="
    assert fake_anki.note_for("updateNoteFields") == {
        "id": 42,
        "fields": {"WordAudio": f"[sound:{result['audio']['filename']}]"},
    }


def test_mining_renders_compound_audio_template_after_storing_media(monkeypatch):
    templates = {
        "Front": "{expression}",
        "Sound": "Audio: {audio} ({reading})",
        "Extra": "",
    }
    fake_anki = FakeAnki(fields=list(templates))
    wire_audio(
        monkeypatch,
        fake_anki,
        mining_profile=make_mining_profile(fieldTemplates=make_field_templates(templates)),
    )

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert fake_anki.note_for()["fields"] == {
        "Front": "食べる",
        "Sound": "Audio:  (たべる)",
        "Extra": "",
    }
    assert fake_anki.note_for("updateNoteFields") == {
        "id": 42,
        "fields": {"Sound": f"Audio: [sound:{result['audio']['filename']}] (たべる)"},
    }


def test_mining_appends_audio_when_the_field_already_contains_text(monkeypatch):
    fake_anki = FakeAnki(fields=["Front", "Sentence"])
    profile = make_mining_profile(
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
    wire_audio(monkeypatch, fake_anki, mining_profile=profile)

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert fake_anki.note_for("updateNoteFields")["fields"]["Front"] == (
        f"食べる<br>[sound:{result['audio']['filename']}]"
    )


def test_mining_audio_unavailable_is_nonfatal(monkeypatch):
    fake_anki = FakeAnki(fields=[*DEFAULT_MODEL_FIELDS, "PronunciationAudio"])
    wire_audio(
        monkeypatch,
        fake_anki,
        error=hoshidicts_audio_profile.HoshidictsAudioError("No pronunciation audio is available.", 404),
    )

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert result["success"] is True
    assert result["audio"] == {
        "status": "unavailable",
        "warning": "No pronunciation audio is available.",
    }
    assert not {"storeMediaFile", "updateNoteFields"} & set(fake_anki.actions())
    assert fake_anki.events[-1]["note_id"] == 42


def test_mining_audio_store_failure_is_nonfatal(monkeypatch):
    fake_anki = FakeAnki(
        fields=[*DEFAULT_MODEL_FIELDS, "Pronunciation"],
        responses={"storeMediaFile": RuntimeError("media collection is locked")},
    )
    wire_audio(monkeypatch, fake_anki)

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert result["success"] is True
    assert result["audio"]["status"] == "failed"
    assert "media collection is locked" in result["audio"]["warning"]
    assert fake_anki.events[-1]["note_id"] == 42


def test_enrich_audio_malformed_media_data_returns_warning(monkeypatch):
    # media.data must be bytes for hashlib.sha256(); a downloader returning a
    # non-bytes payload (e.g. a str) used to raise an uncaught TypeError because
    # the digest was computed OUTSIDE the audio-store try/except. It must
    # instead degrade to a non-fatal "failed" warning like every other
    # audio-storage failure.
    fake_anki = FakeAnki(fields=[*DEFAULT_MODEL_FIELDS, "Pronunciation"])
    malformed_media = hoshidicts_audio.AudioMedia(
        data="not-bytes",
        content_type="audio/mpeg",
        extension="mp3",
    )
    wire_audio(monkeypatch, fake_anki, media=malformed_media)

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert result["success"] is True
    assert result["audio"]["status"] == "failed"
    assert "pronunciation audio could not be stored" in result["audio"]["warning"]
    assert fake_anki.events[-1]["note_id"] == 42
    # The malformed digest must not have produced a stored media file.
    assert "storeMediaFile" not in set(fake_anki.actions())


def test_mining_audio_without_sources_is_skipped_without_resolution(monkeypatch):
    fake_anki = FakeAnki(fields=[*DEFAULT_MODEL_FIELDS, "WordAudio"])

    def unexpected_resolution(*_args, **_kwargs):
        raise AssertionError("audio without sources must not resolve")

    wire_audio(
        monkeypatch,
        fake_anki,
        audio_profile=make_audio_profile(),
        resolver=unexpected_resolution,
    )

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert result["audio"] == {"status": "skipped"}


def test_mining_auto_maps_standard_audio_but_not_sentence_audio(monkeypatch):
    fake_anki = FakeAnki(fields=[*DEFAULT_MODEL_FIELDS, "Audio", "SentenceAudio"])
    wire_audio(monkeypatch, fake_anki)

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert result["audio"]["status"] == "stored"
    assert fake_anki.note_for("updateNoteFields")["fields"] == {"Audio": f"[sound:{result['audio']['filename']}]"}


def test_duplicate_note_rejection_happens_before_audio_download(monkeypatch):
    fake_anki = FakeAnki(
        fields=[*DEFAULT_MODEL_FIELDS, "Pronunciation"],
        responses={"addNote": RuntimeError(DUPLICATE_ERROR)},
    )

    def get_mining_audio(*_args, **_kwargs):
        raise AssertionError("audio must not be resolved for a rejected note")

    wire_audio(monkeypatch, fake_anki, resolver=get_mining_audio)

    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match="already exists") as error:
        hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert error.value.status_code == 409
    assert fake_anki.events == []


@pytest.mark.parametrize(
    "audio_selection",
    [
        {
            "sourceId": "source",
            "candidateIndex": 0,
            "url": "https://attacker.test/audio.mp3",
        },
        {"sourceId": "source", "candidateIndex": True},
        {"sourceId": "source", "candidateIndex": 0, "candidateId": "short"},
        {"sourceId": "bad id", "candidateIndex": 0, "candidateId": "a" * 64},
    ],
)
def test_mining_audio_selection_validation_rejects_unsafe_selections(audio_selection):
    payload = make_payload(audioSelection=audio_selection)

    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match="audio selection"):
        _validated(payload)


def test_validation_uses_the_overlay_utf16_offset():
    payload = make_payload(sentence="😀食べた", matchOffset=2)

    assert _validated(payload)["matched"] == "食べた"

    payload["matchOffset"] = 1
    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="splits a Unicode character",
    ):
        _validated(payload)

    escaped = _validated(make_payload(sentence="<食べた&", matchOffset=1))
    assert note_module.highlight_sentence_match(escaped) == "&lt;<b>食べた</b>&amp;"


def test_validation_preserves_large_glossaries_from_more_than_64_dictionaries():
    payload = make_payload()
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

    normalized = _validated(payload)

    glossaries = normalized["term"]["glossaries"]
    assert len(glossaries) == 70
    assert glossaries[0]["glossary"] == structured_glossary
    assert glossaries[-1]["dictionary"] == "Dictionary 69"
    rendered = note_module.definition_html(normalized)
    assert tail_marker in rendered
    assert "definition-69" in rendered
    assert tail_marker in note_module._glossary_text(structured_glossary)


def test_validation_preserves_decimal_and_nullable_frequency_displays():
    payload = make_payload()
    frequencies = [
        {"value": 12.75, "displayValue": None},
        {"value": 8, "displayValue": ""},
        {"value": -1.5, "displayValue": "<rare>"},
    ]
    payload["result"]["term"]["frequencies"][0]["frequencies"] = frequencies

    validated = _validated(payload)

    assert validated["term"]["frequencies"][0]["frequencies"] == frequencies
    assert note_module.frequency_html(validated) == "<b>Frequency</b>: 12.75, , &lt;rare&gt;"


def test_validation_normalizes_configured_frequency_dictionary_registry():
    payload = make_payload(frequencyDictionaries=["Foo", "Foo", "Foo!"])

    assert _validated(payload)["frequencyDictionaries"] == ["Foo", "Foo!"]

    # A blank name is dropped rather than failing the whole card.
    payload["frequencyDictionaries"] = [""]
    assert _validated(payload)["frequencyDictionaries"] == []


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), float("-inf")])
def test_validation_drops_non_finite_or_boolean_frequency_values(value):
    payload = make_payload()
    payload["result"]["term"]["frequencies"][0]["frequencies"] = [
        {"value": value, "displayValue": None},
        {"value": 42, "displayValue": None},
    ]

    # Anki cannot render NaN, but one bad entry must not lose the whole card.
    frequencies = _validated(payload)["term"]["frequencies"][0]["frequencies"]
    assert frequencies == [{"value": 42, "displayValue": None}]


def test_null_add_note_result_is_not_misclassified_as_a_duplicate(monkeypatch):
    fake_anki = FakeAnki(note_id=None)
    wire(monkeypatch, fake_anki)

    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match="did not return a note ID") as error:
        hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert error.value.status_code == 502
    assert fake_anki.events == []


def test_duplicate_check_uses_first_model_field_and_error_detail(monkeypatch):
    fake_anki = FakeAnki(
        fields=["Sentence", "Expression", "Reading", "Definition", "Frequency", "PitchAccent"],
        responses={
            "canAddNotesWithErrorDetail": [
                {"canAdd": True, "error": None},
                {"canAdd": False, "error": DUPLICATE_ERROR},
                {"canAdd": False, "error": "first field is empty"},
            ]
        },
    )
    wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [make_payload() for _ in range(3)]})

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
    check_notes = fake_anki.kwargs_for("canAddNotesWithErrorDetail")["notes"]
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
    fake_anki = FakeAnki(responses=duplicate_responses())
    wire(monkeypatch, fake_anki, make_mining_profile(duplicateBehavior="new"))

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [make_payload()]})

    assert result == {
        "success": True,
        "checkForDuplicates": True,
        "duplicateBehavior": "new",
        "results": [{"state": "duplicate", "canAdd": True, "duplicate": True}],
    }
    # Duplicates stay detectable because the check itself never allows them.
    assert fake_anki.kwargs_for("canAddNotesWithErrorDetail")["notes"][0]["options"]["allowDuplicate"] is False


def test_duplicate_check_can_be_disabled_without_calling_ankiconnect(monkeypatch):
    fake_anki = FakeAnki()
    wire(
        monkeypatch,
        fake_anki,
        make_mining_profile(checkForDuplicates=False, duplicateBehavior="prevent"),
    )

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [make_payload()]})

    assert result == {
        "success": True,
        "checkForDuplicates": False,
        "duplicateBehavior": "prevent",
        "results": [{"state": "addable", "canAdd": True, "duplicate": False}],
    }
    assert not any(action.startswith("canAddNotes") for action in fake_anki.actions())


def test_duplicate_check_accepts_more_than_the_legacy_sixteen_note_limit(monkeypatch):
    wire(monkeypatch, FakeAnki(), make_mining_profile(checkForDuplicates=False))

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [make_payload()] * 33})

    assert result["success"] is True
    assert len(result["results"]) == 33


def test_duplicate_check_falls_back_to_paired_can_add_notes_for_older_ankiconnect(monkeypatch):
    fake_anki = FakeAnki(
        responses={
            "canAddNotesWithErrorDetail": RuntimeError("unsupported action"),
            "canAddNotes": lambda notes, **_kwargs: [notes[0]["options"]["allowDuplicate"]],
        }
    )
    wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [make_payload()]})

    assert result["results"] == [{"state": "duplicate", "canAdd": False, "duplicate": True}]
    assert [kwargs["notes"][0]["options"]["allowDuplicate"] for kwargs in fake_anki.all_kwargs("canAddNotes")] == [
        True,
        False,
    ]


def test_duplicate_check_does_not_hide_non_compatibility_errors(monkeypatch):
    fake_anki = FakeAnki(responses={"canAddNotesWithErrorDetail": RuntimeError("collection is unavailable")})
    wire(monkeypatch, fake_anki)

    with pytest.raises(RuntimeError, match="collection is unavailable"):
        hoshidicts_mining.check_hoshidicts_notes({"notes": [make_payload()]})

    assert "canAddNotes" not in fake_anki.actions()


@pytest.mark.parametrize(
    ("mode", "existing", "new", "expected"),
    [
        ("overwrite", "old", "new", "new"),
        ("overwrite", "old", "", ""),
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
    assert hoshidicts_markers.overwrite_field(existing, new, mode) == expected


def test_v3_target_field_overwrite_modes_include_explicit_blank_values():
    field_templates = make_field_templates(
        {
            "Keep": ("{reading}", "skip"),
            "Append": ("x", "append"),
            "Clear": ("", "overwrite"),
            "Audio": ("{audio}", "append"),
            "AudioWithSeparator": ("<br>{audio}<br/>", "overwrite"),
            "Compound": ("{definition}<br>{audio}", "append"),
        }
    )

    overwritten = hoshidicts_markers.overwritten_note_fields(
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
        field_templates,
    )

    assert overwritten == {
        "Keep": "old reading",
        "Append": "oldx",
        "Clear": "",
        "Compound": "old definitionnew definition",
    }


def test_mining_overwrites_first_same_type_duplicate_in_exact_deck(monkeypatch):
    fields = list(DEFAULT_MODEL_FIELDS)
    fake_anki = FakeAnki(
        decks=["Default", "Mining", "Mining::Child"],
        responses=duplicate_responses(
            findNotes=[41, 42],
            notesInfo=[
                make_note_info(41, {field: f"child {field}" for field in fields}, cards=[410]),
                make_note_info(
                    42,
                    {
                        "Expression": "old expression",
                        "Reading": "old reading",
                        "Definition": "old definition",
                        "Sentence": "old sentence",
                        "Frequency": "old frequency",
                        "PitchAccent": "old pitch",
                    },
                    cards=[420],
                ),
            ],
            cardsInfo=[
                {"cardId": 410, "note": 41, "deckName": "Mining::Child"},
                {"cardId": 420, "note": 42, "deckName": "Mining"},
            ],
            addNote=AssertionError("a duplicate note must be updated, not added"),
        ),
    )
    wire(
        monkeypatch,
        fake_anki,
        make_mining_profile(
            deck="Mining",
            duplicateScope="deck",
            duplicateBehavior="overwrite",
            fieldOverwriteModes=make_overwrite_modes(
                expression="overwrite",
                reading="skip",
                definition="append",
                sentence="prepend",
                frequency="coalesce-new",
                pitch="coalesce",
            ),
        ),
    )

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert result["noteId"] == 42
    assert result["overwritten"] is True
    assert result["audio"] == {"status": "skipped"}
    assert fake_anki.kwargs_for("findNotes")["query"] == '"deck:Mining" "expression:食べる"'
    update = fake_anki.note_for("updateNoteFields")
    assert update["id"] == 42
    assert update["fields"]["Expression"] == "食べる"
    assert update["fields"]["Reading"] == "old reading"
    assert update["fields"]["Definition"].startswith("old definition")
    assert update["fields"]["Sentence"].endswith("old sentence")
    assert update["fields"]["Frequency"] != "old frequency"
    assert update["fields"]["PitchAccent"] == "old pitch"
    assert fake_anki.events == []


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("食べる", "食べる"),
        # Unescaped wildcards would let the overwrite target a different note.
        ("te*t", "te\\*t"),
        ("te_t", "te\\_t"),
        # A trailing backslash would otherwise escape the closing quote.
        ("path\\", "path\\\\"),
        ('say "hi"', 'say \\"hi\\"'),
        ("a:b", "a\\:b"),
    ],
)
def test_duplicate_note_query_escapes_anki_search_syntax(value, expected):
    query = hoshidicts_anki.duplicate_note_query(
        {"deckName": "Mining", "fields": {"Expression": value}},
        "Expression",
        "collection",
    )

    assert query == f'"expression:{expected}"'


def test_browse_word_escapes_search_syntax_and_html(monkeypatch):
    queries = []
    monkeypatch.setattr(hoshidicts_anki, "invoke", lambda action, **kwargs: queries.append(kwargs["query"]))

    hoshidicts_anki.browse_word('a*b_c\\d"e<f&g')

    assert queries == ['"a\\*b\\_c\\\\d\\"e&lt;f&amp;g"']


def test_overwrite_rejects_a_duplicate_from_another_note_type(monkeypatch):
    fake_anki = FakeAnki(
        responses=duplicate_responses(
            {"Expression": "食べる"},
            note_id=99,
            model="Different note type",
            cards=[990],
            addNote=AssertionError("a cross-note-type duplicate cannot be changed"),
            updateNoteFields=AssertionError("a cross-note-type duplicate cannot be changed"),
        )
    )
    wire(
        monkeypatch,
        fake_anki,
        make_mining_profile(duplicateBehavior="overwrite", duplicateScopeCheckAllModels=True),
    )

    with pytest.raises(hoshidicts_mining.HoshidictsMiningError, match="different note type") as error:
        hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert error.value.status_code == 409


@pytest.mark.parametrize(
    ("existing_fields", "expected"),
    [
        pytest.param(
            {"Expression": "食べる"},
            {
                "state": "duplicate",
                "canAdd": True,
                "duplicate": True,
                "action": "overwrite",
            },
            id="resolvable-duplicate",
        ),
        pytest.param(
            None,
            {
                "state": "duplicate",
                "canAdd": False,
                "duplicate": True,
                "error": (
                    "A duplicate exists, but it uses a different note type "
                    "or is outside the selected deck scope and cannot be overwritten."
                ),
            },
            id="unresolvable-duplicate",
        ),
    ],
)
def test_duplicate_check_only_offers_overwrite_for_a_resolvable_note(monkeypatch, existing_fields, expected):
    responses = (
        duplicate_responses(existing_fields, cards=[420])
        if existing_fields is not None
        else duplicate_responses(findNotes=[])
    )
    fake_anki = FakeAnki(responses=responses)
    wire(monkeypatch, fake_anki, make_mining_profile(duplicateBehavior="overwrite"))

    result = hoshidicts_mining.check_hoshidicts_notes({"notes": [make_payload()]})

    assert result == {
        "success": True,
        "checkForDuplicates": True,
        "duplicateBehavior": "overwrite",
        "results": [expected],
    }


@pytest.mark.parametrize(
    ("profile_overrides", "fields", "expected_status"),
    [
        pytest.param({}, None, "preserved", id="semantic-coalesce-preserves-existing-audio"),
        pytest.param(
            {"fieldOverwriteModes": make_overwrite_modes(audio="append")},
            None,
            "stored",
            id="semantic-append-adds-new-audio",
        ),
        pytest.param(
            {
                "fieldTemplates": make_field_templates(
                    {"Expression": "{expression}", "WordAudio": ("{audio}", "append")}
                )
            },
            ["Expression", "WordAudio"],
            "stored",
            id="v3-target-append-adds-new-audio",
        ),
    ],
)
def test_duplicate_overwrite_applies_the_audio_overwrite_mode(
    monkeypatch,
    profile_overrides,
    fields,
    expected_status,
):
    fields = fields or [*DEFAULT_MODEL_FIELDS, "WordAudio"]
    fake_anki = FakeAnki(
        fields=fields,
        responses=duplicate_responses(
            make_note_fields(fields, Expression="食べる", WordAudio="[sound:existing.mp3]"),
            cards=[420],
        ),
    )

    def unexpected_audio(*_args, **_kwargs):
        raise AssertionError("coalesce must preserve existing audio without a download")

    wire_audio(
        monkeypatch,
        fake_anki,
        mining_profile=make_mining_profile(duplicateBehavior="overwrite", **profile_overrides),
        resolver=unexpected_audio if expected_status == "preserved" else None,
    )

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    assert result["overwritten"] is True
    assert result["audio"]["status"] == expected_status
    audio_updates = [note for note in fake_anki.notes_for("updateNoteFields") if "WordAudio" in note["fields"]]
    if expected_status == "preserved":
        assert result["audio"] == {"status": "preserved"}
        assert "storeMediaFile" not in fake_anki.actions()
        assert audio_updates == []
    else:
        assert audio_updates == [
            {
                "id": 42,
                "fields": {"WordAudio": f"[sound:existing.mp3][sound:{result['audio']['filename']}]"},
            }
        ]


@pytest.mark.parametrize(
    ("audio_state", "overwrite_mode", "expected_status"),
    [
        ("no-sources", "overwrite", "skipped"),
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
    fields = ["Expression", "Combined", "WordAudio"]
    fake_anki = FakeAnki(
        fields=fields,
        responses=duplicate_responses(
            {
                "Expression": "食べる",
                "Combined": "old combined",
                "WordAudio": "[sound:existing.mp3]",
            },
            addNote=AssertionError("a duplicate note must be updated, not added"),
        ),
    )
    profile = make_mining_profile(
        duplicateBehavior="overwrite",
        fieldTemplates=make_field_templates(
            {
                "Expression": "{expression}",
                "Combined": ("{definition}<br>{audio}", overwrite_mode),
                "WordAudio": ("{audio}", "overwrite"),
            }
        ),
    )
    wire_audio(
        monkeypatch,
        fake_anki,
        mining_profile=profile,
        audio_profile=(
            make_audio_profile()
            if audio_state == "no-sources"
            else make_audio_profile(
                {
                    "id": "source",
                    "type": "custom",
                    "url": "https://audio.test/{term}.mp3",
                    "voice": "",
                }
            )
        ),
        error=(
            hoshidicts_audio_profile.HoshidictsAudioError("No pronunciation audio is available.", 404)
            if audio_state == "unavailable"
            else None
        ),
    )

    result = hoshidicts_mining.mine_hoshidicts_note(make_payload())

    updates = fake_anki.notes_for("updateNoteFields")
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


def test_browse_hoshidicts_word_opens_broad_literal_anki_search(monkeypatch):
    fake_anki = FakeAnki(responses={"guiBrowse": [101, 202]})
    wire(monkeypatch, fake_anki)

    result = hoshidicts_mining.browse_hoshidicts_word({"word": "食べる"})

    assert result == {"success": True}
    assert fake_anki.calls == [
        (
            "guiBrowse",
            {
                "query": '"食べる"',
                "timeout": hoshidicts_anki.ANKI_CONNECT_TIMEOUT_SECONDS,
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
    wire(monkeypatch, fake_anki)

    with pytest.raises(hoshidicts_mining.HoshidictsMiningError):
        hoshidicts_mining.browse_hoshidicts_word(payload)

    assert fake_anki.calls == []


def test_browse_hoshidicts_word_requires_enabled_anki_integration(monkeypatch):
    fake_anki = FakeAnki()
    wire(monkeypatch, fake_anki, config=make_config(enabled=False))

    with pytest.raises(
        hoshidicts_mining.HoshidictsMiningError,
        match="GSM Anki integration is disabled",
    ) as error:
        hoshidicts_mining.browse_hoshidicts_word({"word": "食べる"})

    assert error.value.status_code == 503
    assert fake_anki.calls == []


def test_browse_hoshidicts_word_reports_anki_connect_failures(monkeypatch):
    wire(monkeypatch, FakeAnki(responses={"guiBrowse": RuntimeError("AnkiConnect is offline")}))

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
    monkeypatch.setattr(hoshidicts_api, "get_hoshidicts_mining_status", lambda: {"available": True})

    def mining_options(model=None):
        option_models.append(model)
        return {
            "connected": True,
            "selectedNoteType": "Mining" if model is None else model,
        }

    monkeypatch.setattr(hoshidicts_api, "get_hoshidicts_mining_options", mining_options)
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
    response = client.post("/api/hoshidicts/mining/browse", json={"word": "食べる"})
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
