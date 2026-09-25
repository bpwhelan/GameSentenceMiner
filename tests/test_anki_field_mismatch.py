from types import SimpleNamespace

import pytest

from GameSentenceMiner import anki_setup
from GameSentenceMiner.util.config.configuration import ProfileConfig
from GameSentenceMiner.util.models import model


@pytest.mark.parametrize("missing", ["Expression", "Sentence", "SentenceAudio", "Picture"])
def test_missing_core_or_enabled_media_field_is_identified(missing):
    config = ProfileConfig()
    fields = {"Expression", "Sentence", "SentenceAudio", "Picture"} - {missing}
    issue = anki_setup.find_anki_field_mismatch(config, "My cards", fields)

    assert issue.model_name == "My cards"
    assert [name for _, name in issue.missing_fields] == [missing]
    assert issue.blocks_mining == (missing in {"Expression", "Sentence"})
    assert issue.is_current(config)


def test_disabled_or_unmapped_media_does_not_trigger_setup():
    config = ProfileConfig()
    config.audio.enabled = False
    config.screenshot.enabled = False
    assert anki_setup.find_anki_field_mismatch(config, "Text only", ["Expression", "Sentence"]) is None

    config.audio.enabled = True
    config.screenshot.enabled = True
    config.anki.sentence_audio_field = ""
    config.anki.picture_field = ""
    assert anki_setup.find_anki_field_mismatch(config, "Text only", ["Expression", "Sentence"]) is None


def test_unconfigured_required_field_is_reported():
    config = ProfileConfig()
    config.anki.word_field = ""
    issue = anki_setup.find_anki_field_mismatch(config, "My cards", ["Sentence", "SentenceAudio", "Picture"])
    assert issue.missing_fields == (("Word", ""),)
    assert issue.blocks_mining


@pytest.mark.parametrize("change", ["profile", "url", "note_type", "mapping", "capture"])
def test_pending_issue_expires_when_its_settings_change(change):
    config = ProfileConfig()
    issue = anki_setup.find_anki_field_mismatch(config, "My cards", ["Sentence", "Picture"])
    if change == "profile":
        config.name = "Another profile"
    elif change == "url":
        config.anki.url = "http://localhost:9999"
    elif change == "note_type":
        config.anki.note_type = "Lapis"
    elif change == "mapping":
        config.anki.word_field = "Sentence"
    else:
        config.audio.enabled = False
    assert not issue.is_current(config)


def test_existing_case_and_alternative_field_matching_runs_before_validation(monkeypatch):
    config = ProfileConfig()
    monkeypatch.setattr(model, "get_config", lambda: config)
    monkeypatch.setattr(model, "save_current_config", lambda _config: None)
    card = model.AnkiCard(
        noteId=42,
        tags=[],
        cards=[],
        modelName="Custom cards",
        fields={name: SimpleNamespace(value="") for name in ("Front", "Context", "sentenceaudio", "Image")},
    )
    assert anki_setup.find_anki_field_mismatch(config, card.modelName, card.fields) is None


def test_empty_existing_fields_are_valid_destinations():
    config = ProfileConfig()
    fields = {name: {"value": ""} for name in ("Expression", "Sentence", "SentenceAudio", "Picture")}
    assert anki_setup.find_anki_field_mismatch(config, "My cards", fields) is None
