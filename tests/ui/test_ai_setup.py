import os

import pytest
from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ui.config.ai_setup import ai_config_from_form
from GameSentenceMiner.ui.config_gui_qt import ConfigWindow
from GameSentenceMiner.util.config.configuration import AI_GEMINI, AI_ZAI, Config


@pytest.fixture
def ai_window(monkeypatch):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.get_latest_version", lambda: "test-version")
    monkeypatch.setattr(ConfigWindow, "_refresh_anki_model_list", lambda self, preserve_selection=True: None)
    monkeypatch.setattr(ConfigWindow, "_load_monitors", lambda self, preferred_index=None: None)
    monkeypatch.setattr(ConfigWindow, "get_online_models", lambda self: None)
    monkeypatch.setattr(ConfigWindow, "_schedule_runtime_reload", lambda self: None)
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.write_overlay_scene_settings", lambda settings: None)
    window = ConfigWindow()
    yield window
    window._auto_save_timer.stop()
    window.close()
    app.processEvents()


def test_provider_setup_guidance_and_preset_round_trip(ai_window):
    window = ai_window
    window.ai_provider_combo.setCurrentText(AI_GEMINI)
    window.gemini_api_key_edit.setText("test-key")
    window.ai_prompt_preset_combo.setCurrentIndex(window.ai_prompt_preset_combo.findData("grammar"))
    assert window.ai_setup_guide.test_button.isEnabled()
    assert "https://aistudio.google.com/apikey" in window.ai_setup_guide.instructions.text()
    assert not window.gemini_settings_group.isHidden()
    assert window.zai_settings_group.isHidden()
    assert ai_config_from_form(window).is_configured()
    assert window.save_settings(show_indicator=False)
    saved = Config.load().get_config().ai
    assert saved.provider == AI_GEMINI
    assert saved.gemini_api_key == "test-key"
    assert saved.prompt_preset == "grammar"


def test_old_connection_test_result_cannot_confirm_a_new_key(ai_window):
    window = ai_window
    window.ai_provider_combo.setCurrentText(AI_GEMINI)
    window.gemini_api_key_edit.setText("old-key")
    tested = ai_config_from_form(window)
    window.gemini_api_key_edit.setText("new-key")
    window.ai_setup_guide.show_result(tested, True, "Connected")
    assert "Connected" not in window.ai_setup_guide.status.text()
    assert "Ready to test" in window.ai_setup_guide.status.text()


def test_zai_hidden_from_new_provider_setup(ai_window):
    assert AI_ZAI not in ai_window._get_available_ai_providers()
    assert ai_window.ai_provider_combo.findText(AI_ZAI) == -1
    assert "Z.ai" not in ai_window.ai_setup_guide.instructions.text()


def test_existing_zai_profile_keeps_its_provider(ai_window):
    ai_window.settings.ai.provider = AI_ZAI
    ai_window._refresh_ai_provider_options(preferred_provider=AI_ZAI)
    assert ai_window.ai_provider_combo.currentText() == AI_ZAI
    assert not ai_window.zai_settings_group.isHidden()


def test_full_template_validation_explains_missing_sentence(ai_window):
    ai_window.custom_full_prompt_textedit.setPlainText("Explain the grammar.")
    assert "{sentence}" in ai_window.ai_prompt_validation_label.text()
    ai_window.custom_full_prompt_textedit.setPlainText("Explain {sentence} in {native_language}.")
    assert ai_window.ai_prompt_validation_label.text() == ""


def test_ollama_models_can_be_entered_manually_and_survive_refresh(ai_window):
    window = ai_window
    primary = window.ollama_model_combo
    backup = window.ollama_backup_model_combo
    assert primary.isEditable()
    assert backup.isEditable()

    primary.lineEdit().setText("custom-primary:latest")
    backup.lineEdit().setText("custom-backup:latest")
    window._update_ai_model_combos([], [], ["listed-model:latest"], [], preserve_selection=True)

    assert primary.currentText() == "custom-primary:latest"
    assert backup.currentText() == "custom-backup:latest"
    assert window.save_settings(show_indicator=False)
    saved = Config.load().get_config().ai
    assert saved.ollama_model == "custom-primary:latest"
    assert saved.ollama_backup_model == "custom-backup:latest"
    window._auto_save_timer.stop()
    window.reload_settings(force_refresh=True)
    assert primary.currentText() == "custom-primary:latest"
    assert backup.currentText() == "custom-backup:latest"
