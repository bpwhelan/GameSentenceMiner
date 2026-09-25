import copy

import pytest

from GameSentenceMiner.util.cloud_sync.settings import apply_portable_settings, export_portable_settings
from GameSentenceMiner.util.config.configuration import ProfileConfig


def test_allowlist_excludes_credentials_machine_paths_and_ports():
    config = ProfileConfig()
    config.ai.api_key = "secret"
    config.obs.password = "secret"
    config.paths.output_folder = "machine-only"
    exported = export_portable_settings(config, ["language", "anki", "text_processing"])
    assert exported["general.target_language"] == config.general.target_language
    assert all(not key.startswith(("ai.", "obs.", "paths.", "advanced.")) for key in exported)
    assert "anki.url" not in exported
    assert export_portable_settings(config, []) == {}


def test_settings_are_validated_before_any_mutation():
    config = ProfileConfig()
    original = config.general.target_language
    with pytest.raises(ValueError):
        apply_portable_settings(
            config, {"general.target_language": "fr", "anki.url": "https://unsafe"}, ["language", "anki"]
        )
    assert config.general.target_language == original
    with pytest.raises(ValueError):
        apply_portable_settings(config, {"general.target_language": 1}, ["language"])


def test_only_selected_groups_apply_and_anki_objects_remain_typed():
    config = ProfileConfig()
    apply_portable_settings(
        config, {"anki.sentence": {"name": "Example", "enabled": True, "overwrite": True, "append": False}}, ["anki"]
    )
    assert config.anki.sentence.name == "Example"
    with pytest.raises(ValueError):
        apply_portable_settings(config, {"general.target_language": "fr"}, ["anki"])


def test_background_sync_merges_with_open_editor_without_overwriting_edits():
    from GameSentenceMiner.util.cloud_sync.settings import preserve_synced_settings

    baseline = ProfileConfig()
    edited, latest = copy.deepcopy(baseline), copy.deepcopy(baseline)
    edited.general.native_language = "uk"
    latest.general.native_language = "fr"
    latest.general.target_language = "de"
    preserve_synced_settings(baseline, edited, latest, ["language"])
    assert edited.general.native_language == "uk"
    assert edited.general.target_language == "de"
