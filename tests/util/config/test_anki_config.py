from GameSentenceMiner.util.config.configuration import Anki


def test_same_selected_lines_different_mined_line_reuse_defaults():
    config = Anki()

    assert config.reuse_audio_for_same_selected_lines_different_mined_line is True
    assert config.reuse_screenshot_for_same_selected_lines_different_mined_line is False


def test_field_grouping_defaults_are_opt_in_and_keep_the_newest_context_first():
    config = Anki()

    assert config.field_grouping_enabled is False
    assert config.field_grouping_order == "front"
    assert config.field_grouping_delete_duplicate is True
    assert config.field_grouping_additional_fields == ["SentenceTranslation", "MiscInfo", "Tag"]


def test_existing_anki_config_without_field_grouping_settings_stays_opted_out():
    existing_config = Anki().to_dict()
    existing_config.pop("field_grouping_enabled")
    existing_config.pop("field_grouping_order")
    existing_config.pop("field_grouping_delete_duplicate")
    existing_config.pop("field_grouping_additional_fields")

    config = Anki.from_dict(existing_config)

    assert config.field_grouping_enabled is False


def test_field_grouping_normalizes_invalid_order_and_additional_fields():
    config = Anki(
        field_grouping_order="somewhere",
        field_grouping_additional_fields=[" MiscInfo ", "", "MiscInfo", "CustomContext"],
    )

    assert config.field_grouping_order == "front"
    assert config.field_grouping_additional_fields == ["MiscInfo", "CustomContext"]
