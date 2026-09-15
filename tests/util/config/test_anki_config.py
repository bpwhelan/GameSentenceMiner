import pytest

from GameSentenceMiner.util.config.configuration import Anki, Config, ProfileConfig


def test_same_selected_lines_different_mined_line_reuse_defaults():
    config = Anki()

    assert config.reuse_audio_for_same_selected_lines_different_mined_line is True
    assert config.reuse_screenshot_for_same_selected_lines_different_mined_line is False


def test_confirmation_gamepad_binding_defaults_preserve_existing_controls():
    config = Anki()

    assert config.confirmation_gamepad_focus_up == "12"
    assert config.confirmation_gamepad_focus_down == "13"
    assert config.confirmation_gamepad_focus_left == "14"
    assert config.confirmation_gamepad_focus_right == "15"
    assert config.confirmation_gamepad_activate == "0"
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


def test_confirmation_edit_gamepad_bindings_round_trip_and_sync_across_profiles():
    bindings = {
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
