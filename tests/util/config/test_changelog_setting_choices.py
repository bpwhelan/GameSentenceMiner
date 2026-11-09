from GameSentenceMiner.util.config.configuration import (
    Config,
    ProfileConfig,
    apply_changelog_setting_choice,
)


def test_enabling_after_session_review_preserves_profile_preferences_and_other_profiles():
    active = ProfileConfig()
    active.anki.show_update_confirmation_dialog_v2 = False
    active.features.review_after_session.max_future_context_lines = 8
    active.features.review_after_session.cleanup_anki_media = False
    other = ProfileConfig()
    config = Config(current_profile="active", configs={"active": active, "other": other})
    other_before = other.to_dict()
    before = active.to_dict()

    assert apply_changelog_setting_choice(config, "review-after-session:enable") is True

    expected = before
    expected["features"]["review_after_session"]["enabled"] = True
    assert config.get_config().to_dict() == expected
    assert config.configs["other"].to_dict() == other_before
    restored = Config.from_dict(config.to_dict())
    assert restored.get_config().features.review_after_session == active.features.review_after_session


def test_enabling_overlay_presence_invalidation_turns_on_its_required_check():
    profile = ProfileConfig()
    config = Config(configs={"Default": profile})

    assert apply_changelog_setting_choice(config, "overlay-presence-invalidation:enable") is True

    overlay = config.get_config().overlay
    assert overlay.last_sent_ocr_presence_check is True
    assert overlay.last_sent_ocr_presence_invalidate_lookups is True


def test_disabling_overlay_presence_invalidation_keeps_other_presence_actions_unchanged():
    profile = ProfileConfig()
    config = Config(configs={"Default": profile})
    config.overlay.last_sent_ocr_presence_check = True
    config.overlay.last_sent_ocr_presence_remove_notation = True
    config.overlay.last_sent_ocr_presence_invalidate_lookups = True

    assert apply_changelog_setting_choice(config, "overlay-presence-invalidation:disable") is True

    overlay = config.get_config().overlay
    assert overlay.last_sent_ocr_presence_check is True
    assert overlay.last_sent_ocr_presence_remove_notation is True
    assert overlay.last_sent_ocr_presence_invalidate_lookups is False


def test_unknown_changelog_setting_choice_is_rejected_without_changing_config():
    config = Config(configs={"Default": ProfileConfig()})

    assert apply_changelog_setting_choice(config, "not-a-setting:enable") is False
    assert config.get_config().overlay.last_sent_ocr_presence_check is False


def test_loading_a_legacy_default_change_decision_discards_the_obsolete_record():
    raw_config = Config.new().to_dict()
    raw_config["default_config_change_decisions"] = {"2026.7.0:silero-vad-default": "declined"}

    restored = Config.from_dict(Config._migrate_raw_data(raw_config))

    assert not hasattr(restored, "default_config_change_decisions")
