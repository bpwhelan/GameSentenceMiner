import json

import pytest

from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import Anki, Config, ProfileConfig


@pytest.mark.parametrize("loader", [Config.load, configuration.load_config])
def test_legacy_anki_toggles_migrate_to_one_enabled_setting(tmp_path, monkeypatch, loader):
    legacy_states = [
        ({"enabled": True, "update_anki": True}, True),
        ({"enabled": True, "update_anki": False}, False),
        ({"enabled": False, "update_anki": True}, False),
        ({"enabled": False, "update_anki": False}, False),
        ({"update_anki": False}, False),
        ({"update_anki": True}, True),
        ({"enabled": False}, False),
        ({"enabled": True}, True),
        ({}, True),
    ]
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "current_profile": "0",
                "configs": {
                    str(index): {"name": str(index), "anki": state} for index, (state, _) in enumerate(legacy_states)
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(configuration, "get_config_path", lambda: str(config_path))

    loaded = loader()

    for index, (_, enabled) in enumerate(legacy_states):
        profile = loaded.configs[str(index)]
        assert profile.anki.enabled is enabled
        assert "update_anki" not in profile.anki.to_dict()

    # Enabling Anki after migration must not leave a hidden switch blocking updates.
    loaded.configs["1"].anki.enabled = True
    loaded.save()
    reloaded = loader()
    assert reloaded.configs["1"].anki.enabled is True
    assert all("update_anki" not in profile.anki.to_dict() for profile in reloaded.configs.values())


def test_profileless_config_preserves_disabled_anki_updates(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"anki": {"enabled": True, "update_anki": False}}), encoding="utf-8")
    monkeypatch.setattr(configuration, "get_config_path", lambda: str(config_path))

    loaded = configuration.load_config()

    assert loaded.get_config().anki.enabled is False
    assert "update_anki" not in loaded.get_config().anki.to_dict()


def test_same_selected_lines_different_mined_line_reuse_defaults():
    config = Anki()

    assert config.reuse_audio_for_same_selected_lines_different_mined_line is True
    assert config.reuse_screenshot_for_same_selected_lines_different_mined_line is False


def test_skip_confirmation_for_unvoiced_defaults_off_for_existing_configs():
    assert Anki().skip_confirmation_for_unvoiced is False
    existing = Anki().to_dict()
    existing.pop("skip_confirmation_for_unvoiced")
    assert Anki.from_dict(existing).skip_confirmation_for_unvoiced is False


def test_skip_confirmation_for_unvoiced_round_trips_and_syncs_across_profiles():
    config = Config(
        current_profile="active",
        configs={
            "active": ProfileConfig(anki=Anki(skip_confirmation_for_unvoiced=True)),
            "other": ProfileConfig(),
        },
    )
    config.sync_shared_fields()
    restored = Config.from_dict(config.to_dict())
    assert all(profile.anki.skip_confirmation_for_unvoiced for profile in restored.configs.values())


def test_confirmation_gamepad_binding_defaults_preserve_existing_controls():
    config = Anki()

    assert config.confirmation_gamepad_focus_up == "12"
    assert config.confirmation_gamepad_focus_down == "13"
    assert config.confirmation_gamepad_focus_left == "14"
    assert config.confirmation_gamepad_focus_right == "15"
    assert config.confirmation_gamepad_activate == "0"
    assert config.confirmation_gamepad_play_audio == "3"
    assert config.confirmation_gamepad_confirm_with_audio == "2"
    assert config.confirmation_gamepad_confirm_without_audio == "1"


def test_existing_anki_config_without_gamepad_bindings_uses_existing_controls():
    existing_config = Anki().to_dict()
    for field_name in (
        "confirmation_gamepad_focus_up",
        "confirmation_gamepad_focus_down",
        "confirmation_gamepad_focus_left",
        "confirmation_gamepad_focus_right",
        "confirmation_gamepad_activate",
        "confirmation_gamepad_play_audio",
        "confirmation_gamepad_confirm_with_audio",
        "confirmation_gamepad_confirm_without_audio",
    ):
        existing_config.pop(field_name)

    config = Anki.from_dict(existing_config)

    assert config.confirmation_gamepad_focus_up == "12"
    assert config.confirmation_gamepad_focus_down == "13"
    assert config.confirmation_gamepad_focus_left == "14"
    assert config.confirmation_gamepad_focus_right == "15"
    assert config.confirmation_gamepad_activate == "0"
    assert config.confirmation_gamepad_play_audio == "3"
    assert config.confirmation_gamepad_confirm_with_audio == "2"
    assert config.confirmation_gamepad_confirm_without_audio == "1"


@pytest.mark.parametrize("existing_config", [False, True])
def test_confirmation_edit_gamepad_defaults_use_triggers_and_bumpers(existing_config):
    defaults = {
        "confirmation_gamepad_add_previous_line": "6",
        "confirmation_gamepad_add_next_line": "7",
        "confirmation_gamepad_expand_audio_start": "4",
        "confirmation_gamepad_expand_audio_end": "5",
    }
    config = Anki()
    if existing_config:
        saved = config.to_dict()
        for name in defaults:
            saved.pop(name, None)
        saved["confirmation_gamepad_activate"] = "9"
        config = Anki.from_dict(saved)
        assert config.confirmation_gamepad_activate == "9"

    for name, value in defaults.items():
        assert getattr(config, name) == value


def test_confirmation_action_gamepad_bindings_round_trip_and_sync_across_profiles():
    bindings = {
        "confirmation_gamepad_play_audio": "11",
        "confirmation_gamepad_add_previous_line": "8",
        "confirmation_gamepad_add_next_line": "9",
        "confirmation_gamepad_expand_audio_start": "",
        "confirmation_gamepad_expand_audio_end": "3",
    }
    config = Config(
        current_profile="active",
        configs={
            "active": ProfileConfig(anki=Anki(**bindings)),
            "other": ProfileConfig(),
        },
    )

    config.sync_shared_fields()
    restored = Config.from_dict(config.to_dict())

    for profile in restored.configs.values():
        for name, value in bindings.items():
            assert getattr(profile.anki, name) == value


def test_field_grouping_defaults_are_opt_in_and_keep_the_newest_context_first():
    config = Anki()

    assert config.field_grouping_enabled is False
    assert config.field_grouping_auto_merge is False
    assert config.field_grouping_order == "front"
    assert config.field_grouping_delete_duplicate is True
    assert config.field_grouping_additional_fields == ["SentenceTranslation", "MiscInfo", "Tag"]


def test_existing_anki_config_without_field_grouping_settings_stays_opted_out():
    existing_config = Anki().to_dict()
    existing_config.pop("field_grouping_enabled")
    existing_config.pop("field_grouping_auto_merge")
    existing_config.pop("field_grouping_order")
    existing_config.pop("field_grouping_delete_duplicate")
    existing_config.pop("field_grouping_additional_fields")

    config = Anki.from_dict(existing_config)

    assert config.field_grouping_enabled is False
    assert config.field_grouping_auto_merge is False


def test_field_grouping_normalizes_invalid_order_and_additional_fields():
    config = Anki(
        field_grouping_order="somewhere",
        field_grouping_additional_fields=[" MiscInfo ", "", "MiscInfo", "CustomContext"],
    )

    assert config.field_grouping_order == "front"
    assert config.field_grouping_additional_fields == ["MiscInfo", "CustomContext"]
