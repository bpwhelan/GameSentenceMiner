from __future__ import annotations

import os

import pytest
from PyQt6.QtWidgets import QApplication, QCheckBox, QMessageBox, QSpinBox

from GameSentenceMiner import anki
from GameSentenceMiner.ui.config.labels import LabelColor
from GameSentenceMiner.ui.config_gui_qt import ConfigWindow
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.models.model import VADResult


@pytest.fixture
def confirmation_settings(monkeypatch):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    original = configuration.Config.load()
    configuration.Config.new().save()
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.get_latest_version", lambda: "test-version")
    monkeypatch.setattr(ConfigWindow, "_refresh_anki_model_list", lambda self, preserve_selection=True: None)
    monkeypatch.setattr(ConfigWindow, "_load_monitors", lambda self, preferred_index=None: None)
    monkeypatch.setattr(ConfigWindow, "get_online_models", lambda self: None)
    monkeypatch.setattr(ConfigWindow, "_schedule_runtime_reload", lambda self: None)
    monkeypatch.setattr(ConfigWindow, "_reload_runtime_config", lambda self: None)
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.write_overlay_scene_settings", lambda settings: None)
    window = ConfigWindow()
    window.obs_error_timer.stop()
    window.obs_scene_refresh_timer.stop()
    try:
        yield window
    finally:
        window._auto_save_timer.stop()
        window.close()
        app.processEvents()
        original.save()


def test_confirmation_page_offers_both_modes_and_only_one_session_setting(confirmation_settings):
    window = confirmation_settings
    assert "session_review" not in window._settings_subtab_indices["features"]
    pane = window._settings_subtab_widgets["anki"].widget(window._settings_subtab_indices["anki"]["confirmation"])
    enabled = window.show_update_confirmation_dialog_check
    layout = enabled.parentWidget().layout()
    assert layout.getWidgetPosition(enabled)[0] == 0
    assert layout.labelForField(enabled).text() == "Enabled"
    assert window.anki_confirmation_immediate_radio.text() == "As soon as possible"
    assert window.anki_confirmation_after_session_radio.text() == "After session"
    assert pane.isAncestorOf(window.session_review_future_lines_spin)

    window.anki_confirmation_after_session_radio.click()
    session_panel = window.anki_confirmation_session_settings
    assert session_panel.findChildren(QCheckBox) == []
    assert session_panel.findChildren(QSpinBox) == [window.session_review_future_lines_spin]
    label = (
        window.session_review_future_lines_spin.parentWidget()
        .layout()
        .labelForField(window.session_review_future_lines_spin)
    )
    assert LabelColor.WARNING.get_qt_color() in label.styleSheet()
    assert not session_panel.isHidden()
    assert window.anki_confirmation_immediate_settings.isHidden()
    assert not window.anki_confirmation_audio_settings.isHidden()


@pytest.mark.parametrize("after_session", [False, True])
def test_confirmation_modes_save_reload_and_disable_together(confirmation_settings, after_session):
    window = confirmation_settings
    window.show_update_confirmation_dialog_check.setChecked(True)
    radio = window.anki_confirmation_after_session_radio if after_session else window.anki_confirmation_immediate_radio
    radio.click()
    window.session_review_future_lines_spin.setValue(7)
    window.anki_confirmation_autoplay_audio_check.setChecked(True)
    window.anki_confirmation_replay_audio_on_tts_generation_check.setChecked(False)
    # Hidden settings must retain custom values when changing confirmation modes.
    window.editor.profile.features.review_after_session.delay_seconds = 9
    window.editor.profile.features.review_after_session.cleanup_anki_media = False
    assert window.save_settings(show_indicator=False)
    saved = configuration.Config.load().get_config()
    assert saved.anki.show_update_confirmation_dialog_v2 is True
    assert saved.features.review_after_session.enabled is after_session
    assert anki._should_show_confirmation_dialog(saved, VADResult(True, 0, 1, "test")) is (not after_session)
    assert saved.features.review_after_session.max_future_context_lines == 7
    assert saved.features.review_after_session.delay_seconds == 9
    assert saved.features.review_after_session.cleanup_anki_media is False
    assert saved.anki.autoplay_audio is True
    assert saved.anki.replay_audio_on_tts_generation is False
    window.reload_settings(force_refresh=True)
    assert window.show_update_confirmation_dialog_check.isChecked()
    assert radio.isChecked()
    assert window.anki_confirmation_session_settings.isHidden() is (not after_session)
    assert window.anki_confirmation_immediate_settings.isHidden() is after_session

    window.show_update_confirmation_dialog_check.setChecked(False)
    assert window.save_settings(show_indicator=False)
    saved = configuration.Config.load().get_config()
    assert saved.anki.show_update_confirmation_dialog_v2 is False
    assert saved.features.review_after_session.enabled is False
    assert window.anki_confirmation_session_settings.isHidden()
    assert window.anki_confirmation_immediate_settings.isHidden()
    assert window.anki_confirmation_audio_settings.isHidden()


@pytest.mark.parametrize("immediate", [False, True])
def test_existing_session_review_profiles_load_as_enabled(confirmation_settings, immediate):
    window = confirmation_settings
    window.settings.anki.show_update_confirmation_dialog_v2 = immediate
    window.settings.features.review_after_session.enabled = True
    window._load_settings_to_ui_safely()
    assert window.show_update_confirmation_dialog_check.isChecked()
    assert window.anki_confirmation_after_session_radio.isChecked()
    assert not window.anki_confirmation_session_settings.isHidden()


def test_switching_confirmation_timing_triggers_autosave(confirmation_settings):
    window = confirmation_settings
    window._auto_save_timer.stop()
    window.anki_confirmation_after_session_radio.click()
    assert window._auto_save_timer.isActive()


def test_clearing_search_keeps_inactive_confirmation_settings_hidden(confirmation_settings):
    window = confirmation_settings
    window.anki_confirmation_after_session_radio.click()
    window.search_input.setText("autoplay")
    window.search_input.clear()
    assert window.anki_confirmation_immediate_settings.isHidden()
    assert not window.anki_confirmation_session_settings.isHidden()
    assert not window.anki_confirmation_audio_settings.isHidden()


def test_confirmation_reset_includes_session_settings_without_resetting_other_features(
    confirmation_settings, monkeypatch
):
    window = confirmation_settings
    window.anki_confirmation_after_session_radio.click()
    window.session_review_future_lines_spin.setValue(12)
    window.editor.profile.features.generate_longplay = True
    window.generate_longplay_check.setChecked(True)
    assert window.save_settings(show_indicator=False)
    monkeypatch.setattr(QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
    window._reset_to_default(("anki", "features.review_after_session"), window._create_anki_confirmation_tab)
    saved = configuration.Config.load().get_config()
    assert saved.anki.show_update_confirmation_dialog_v2 is True
    assert saved.features.review_after_session == configuration.ReviewAfterSession()
    assert saved.features.generate_longplay is True
    assert window.anki_confirmation_immediate_radio.isChecked()
