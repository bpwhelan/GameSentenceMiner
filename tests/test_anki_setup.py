import io
import zipfile
from pathlib import Path
from unittest.mock import Mock

import pytest

from GameSentenceMiner import anki_setup as setup


def client_with_anki(tmp_path, preset_id="lapis", installed=True):
    preset = setup.get_preset(preset_id)
    client = setup.AnkiSetupClient("http://127.0.0.1:8765", tmp_path)
    fields = list(preset.yomitan_fields)
    state = {"models": [preset.name] if installed else [], "fields": fields, "decks": ["Mining"]}

    def invoke(action, **params):
        if action == "version":
            return 6
        if action == "modelNames":
            return state["models"]
        if action == "modelFieldNames":
            return state["fields"]
        if action == "deckNames":
            return state["decks"]
        if action == "createDeck":
            state["decks"].append(params["deck"])
            return 123
        if action == "guiImportFile":
            assert Path(params["path"]).is_file()
            return None
        raise AssertionError(action)

    client.invoke = Mock(side_effect=invoke)
    return client, state


@pytest.mark.parametrize("preset_id", ["lapis", "kiku", "senren"])
def test_reuses_installed_note_type_without_downloading_or_replacing_templates(tmp_path, preset_id):
    client, state = client_with_anki(tmp_path, preset_id)
    client.download = Mock(side_effect=AssertionError("Must reuse existing note type"))
    result = client.setup(preset_id, "Mining")
    assert not result.import_pending
    assert result.fields == tuple(state["fields"])
    assert result.model_name == setup.get_preset(preset_id).name
    assert "guiImportFile" not in [c.args[0] for c in client.invoke.call_args_list]


def test_native_import_is_verified_before_creating_deck_or_applying_settings(tmp_path):
    client, state = client_with_anki(tmp_path, installed=False)
    package = tmp_path / "Lapis.apkg"
    package.write_bytes(b"package")
    client.download = Mock(return_value=package)
    result = client.setup("lapis", "New Mining")
    assert result.import_pending
    assert package.exists()  # Anki's asynchronous import still needs it.
    assert state["decks"] == ["Mining"]
    with pytest.raises(setup.AnkiSetupError, match="import"):
        client.setup("lapis", "New Mining", allow_download=False)
    state["models"] = ["Lapis"]
    assert not client.setup("lapis", "New Mining", allow_download=False).import_pending
    assert state["decks"] == ["Mining", "New Mining"]
    assert client.download.call_count == 1


def test_incompatible_installed_model_does_not_create_deck(tmp_path):
    client, state = client_with_anki(tmp_path, "senren")
    state["fields"].remove("sentenceAudio")
    with pytest.raises(setup.AnkiSetupError, match="sentenceAudio"):
        client.setup("senren", "New Mining")
    assert state["decks"] == ["Mining"]


def test_empty_deck_and_unknown_preset_fail_before_network(tmp_path):
    client, _ = client_with_anki(tmp_path)
    for preset_id, deck in [("lapis", "  "), ("unknown", "Mining")]:
        with pytest.raises(setup.AnkiSetupError):
            client.setup(preset_id, deck)
    client.invoke.assert_not_called()


def test_remote_anki_can_be_reused_but_cannot_receive_a_local_import_path(tmp_path):
    client, state = client_with_anki(tmp_path)
    client.url = "http://192.0.2.10:8765"
    assert not client.setup("lapis", "Mining").import_pending
    state["models"] = []
    client.download = Mock()
    with pytest.raises(setup.AnkiSetupError, match="same computer"):
        client.setup("lapis", "Mining")
    client.download.assert_not_called()


def test_field_mappings_use_senren_casing_and_leave_media_for_gsm():
    preset = setup.get_preset("senren")
    assert preset.gsm_fields["word"] == "word"
    assert preset.gsm_fields["game_name"] == "miscInfo"
    assert preset.yomitan_fields["wordAudio"] == "{audio}"
    assert preset.yomitan_fields["sentenceAudio"] == ""
    assert preset.yomitan_fields["picture"] == ""
    assert preset.yomitan_fields["glossary"] == "{glossary}"
    assert setup.get_preset("lapis").yomitan_fields["ExpressionFurigana"] == "{furigana-plain}"


@pytest.mark.parametrize("preset_id", ["lapis", "kiku", "senren"])
def test_suggested_gsm_mappings_depend_on_fields_and_allow_custom_fields(preset_id):
    preset = setup.get_preset(preset_id)
    fields = [*preset.yomitan_fields, "My extra field"]
    expected = dict(preset.gsm_fields)
    if preset_id != "lapis":
        expected["ai"] = "sentenceTranslation" if preset_id == "senren" else "SentenceTranslation"
    assert setup.suggest_gsm_field_mappings(fields) == expected


def test_suggested_gsm_mappings_support_existing_senren_translation_field():
    preset = setup.get_preset("senren")
    fields = [*preset.gsm_fields.values(), "sentenceEng"]
    assert setup.suggest_gsm_field_mappings(fields) == {**preset.gsm_fields, "ai": "sentenceEng"}


@pytest.mark.parametrize("fields", [[], ["Front", "Back"], ["Expression", "Sentence", "Picture"]])
def test_unrecognized_or_incomplete_fields_do_not_suggest_a_preset(fields):
    assert setup.suggest_gsm_field_mappings(fields) == {}


def test_ambiguous_field_layout_does_not_guess_a_preset():
    fields = [*setup.get_preset("lapis").gsm_fields.values(), *setup.get_preset("senren").gsm_fields.values()]
    assert setup.suggest_gsm_field_mappings(fields) == {}


def test_existing_senren_v4_fields_use_their_original_meanings():
    result = setup.SetupResult(
        "senren",
        "Senren",
        ("word", "reading", "sentenceEng", "pitchPosition", "pitch", "frequency", "picture", "Custom"),
        "Mining",
    )
    assert result.yomitan_payload("http://localhost:8765")["fields"] == {
        "word": "{expression}",
        "reading": "{pitch-accents}",
        "sentenceEng": "",
        "pitchPosition": "{pitch-accent-positions}",
        "pitch": "{pitch-accent-categories}",
        "frequency": "{frequencies}",
        "picture": "",
        "Custom": "",
    }
    current = setup.SetupResult("senren", "Senren", ("reading", "pitchAccents", "pitchCategories"), "Mining")
    assert current.yomitan_payload("http://localhost:8765")["fields"] == {
        "reading": "{reading}",
        "pitchAccents": "{pitch-accents}",
        "pitchCategories": "{pitch-accent-categories}",
    }


def release_response(content=b"bad", asset_url=None, size=None):
    url = asset_url or "https://github.com/donkuri/lapis/releases/download/1.7.0/Lapis.apkg"
    asset = {"name": "Lapis.apkg", "size": len(content) if size is None else size, "browser_download_url": url}
    release = Mock()
    release.json.return_value = {"tag_name": "1.7.0", "assets": [asset]}
    body = Mock()
    body.__enter__ = Mock(return_value=body)
    body.__exit__ = Mock(return_value=False)
    body.iter_content.return_value = [content]
    return release, body


def test_download_checks_package_and_does_not_execute_or_extract_it(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as package:
        package.writestr("collection.anki21b", "compressed collection")
        package.writestr("media", "{}")
    client = setup.AnkiSetupClient("http://localhost:8765", tmp_path)
    client.session.get = Mock(side_effect=release_response(buffer.getvalue()))
    path = client.download(setup.get_preset("lapis"))
    assert path.read_bytes() == buffer.getvalue()
    assert not (tmp_path / "collection.anki21b").exists()


@pytest.mark.parametrize("options", [{}, {"asset_url": "https://example.com/Lapis.apkg"}, {"size": 100_000_000}])
def test_bad_downloads_never_become_installable_packages(tmp_path, options):
    client = setup.AnkiSetupClient("http://localhost:8765", tmp_path)
    client.session.get = Mock(side_effect=release_response(**options))
    with pytest.raises(setup.AnkiSetupError):
        client.download(setup.get_preset("lapis"))
    assert not list(tmp_path.rglob("*.apkg"))


def test_anki_connect_errors_and_malformed_responses_are_not_success(tmp_path):
    client = setup.AnkiSetupClient("http://localhost:8765", tmp_path)
    response = Mock()
    client.session.post = Mock(return_value=response)
    for payload in [{"error": "Anki is busy", "result": None}, {}, [6]]:
        response.json.return_value = payload
        with pytest.raises(setup.AnkiSetupError):
            client.invoke("version")
