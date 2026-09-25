import os
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from PyQt6.QtTest import QSignalSpy
from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ui.config.services import ai_models
from GameSentenceMiner.ui.config_gui_qt import ConfigWindow
from GameSentenceMiner.util.config.configuration import OFF, Ai

RECOMMENDED = ["gemini-3.5-flash-lite", "gemma-4-31b-it", "gemma-4-26b-a4b-it"]


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
    window.settings.ai.gemini_model = RECOMMENDED[0]
    window.settings.ai.gemini_backup_model = ""
    window._load_settings_to_ui_safely()
    window._auto_save_timer.stop()
    yield window
    window._auto_save_timer.stop()
    window.close()
    app.processEvents()


def model_names(combo):
    return [combo.itemText(index) for index in range(combo.count())]


def test_gemini_defaults_and_recommendations_use_current_free_tier_models():
    assert ai_models.RECOMMENDED_GEMINI_MODELS == RECOMMENDED
    assert Ai().gemini_model == RECOMMENDED[0]
    assert Ai().gemini_backup_model == RECOMMENDED[1]
    for placeholder in ("RECOMMENDED", "OTHER"):
        assert Ai(gemini_model=placeholder).gemini_model == RECOMMENDED[0]
    assert Ai(gemini_model="gemma-3-27b-it").gemini_model == "gemma-3-27b-it"


@pytest.mark.parametrize("api_key", ["", "test-key"])
def test_gemini_fetch_falls_back_to_recommendations(monkeypatch, api_key):
    from google import genai

    monkeypatch.setattr(ai_models, "get_config", lambda: SimpleNamespace(ai=SimpleNamespace(gemini_api_key=api_key)))
    client = Mock(side_effect=RuntimeError("unavailable"))
    monkeypatch.setattr(genai, "Client", client)

    assert ai_models.AIModelFetcher("")._get_gemini_models() == RECOMMENDED
    assert client.call_count == bool(api_key)


def test_gemini_fetch_uses_form_key_and_lists_other_text_models(monkeypatch):
    from google import genai

    models = [
        SimpleNamespace(name=f"models/{name}", supported_actions=actions)
        for name, actions in [
            (RECOMMENDED[0], ["generateContent"]),
            ("gemini-2.0-flash", ["generateContent"]),
            ("gemini-2.5-flash-lite-preview-06-17", ["generateContent"]),
            ("gemini-3-pro-preview", ["generateContent"]),
            ("gemini-3-pro-preview", ["generateContent"]),
            ("gemini-text-001", ["generateContent"]),
            ("gemini-exp-text", ["generateContent"]),
            ("gemini-image", ["generateContent"]),
            ("gemini-tts", ["generateContent"]),
            ("gemini-embedding", ["embedContent"]),
            ("gemini-live", ["bidiGenerateContent"]),
        ]
    ]
    client = Mock()
    client.return_value.models.list.return_value = models
    monkeypatch.setattr(genai, "Client", client)
    monkeypatch.setattr(ai_models, "get_config", lambda: SimpleNamespace(ai=SimpleNamespace(gemini_api_key="saved")))

    assert ai_models.AIModelFetcher("", gemini_api_key="form-key")._get_gemini_models() == [
        *RECOMMENDED,
        "gemini-3-pro-preview",
        "gemini-text-001",
        "gemini-exp-text",
    ]
    client.assert_called_once_with(api_key="form-key")


def test_gemini_toggle_hides_other_models_and_replaces_stale_recommendations(ai_window):
    window = ai_window
    window._update_ai_model_combos(
        ["RECOMMENDED", "gemini-2.5-flash", "gemma-3-27b-it", "OTHER", "gemini-3-pro-preview"], []
    )

    assert not window.gemini_show_other_models_check.isChecked()
    assert model_names(window.gemini_model_combo) == RECOMMENDED
    assert model_names(window.gemini_backup_model_combo) == [OFF, *RECOMMENDED]

    window._auto_save_timer.stop()
    primary_changes = QSignalSpy(window.gemini_model_combo.currentTextChanged)
    backup_changes = QSignalSpy(window.gemini_backup_model_combo.currentTextChanged)
    window.gemini_show_other_models_check.setChecked(True)
    assert model_names(window.gemini_model_combo) == [*RECOMMENDED, "gemini-3-pro-preview"]
    assert model_names(window.gemini_backup_model_combo) == [OFF, *RECOMMENDED, "gemini-3-pro-preview"]
    window.gemini_show_other_models_check.setChecked(False)
    assert model_names(window.gemini_model_combo) == RECOMMENDED
    assert model_names(window.gemini_backup_model_combo) == [OFF, *RECOMMENDED]
    assert len(primary_changes) == len(backup_changes) == 0
    assert not window._auto_save_timer.isActive()


def test_gemini_load_keeps_saved_models_outside_recommendations(ai_window):
    window = ai_window
    window.settings.ai.gemini_model = "gemini-3-pro-preview"
    window.settings.ai.gemini_backup_model = "gemma-3-27b-it"
    window._load_settings_to_ui_safely()

    assert window.gemini_model_combo.currentText() == "gemini-3-pro-preview"
    assert window.gemini_backup_model_combo.currentText() == "gemma-3-27b-it"
    window._update_ai_model_combos([], [])
    assert window.gemini_model_combo.currentText() == "gemini-3-pro-preview"
    assert window.gemini_backup_model_combo.currentText() == "gemma-3-27b-it"


@pytest.mark.parametrize("saved", [{}, {"gemini_model": "gemini-2.5-pro"}])
def test_gemini_loaded_settings_use_new_defaults(ai_window, saved):
    window = ai_window
    window.settings.ai = Ai.from_dict(saved)
    window._load_settings_to_ui_safely()

    assert window.gemini_model_combo.currentText() == RECOMMENDED[0]
    assert window.gemini_backup_model_combo.currentText() == RECOMMENDED[1]


def test_cached_gemini_2_models_are_upgraded_in_expanded_list(ai_window):
    window = ai_window
    window._update_ai_model_combos(["gemini-2.0-flash", "gemini-2.5-pro", "gemini-3-pro-preview"], [])
    window.gemini_show_other_models_check.setChecked(True)

    assert model_names(window.gemini_model_combo) == [*RECOMMENDED, "gemini-3-pro-preview"]
    assert model_names(window.gemini_backup_model_combo) == [OFF, *RECOMMENDED, "gemini-3-pro-preview"]


def test_gemini_toggle_and_background_update_keep_unsaved_selections(ai_window):
    window = ai_window
    window._update_ai_model_combos([*RECOMMENDED, "gemini-3-pro-preview", "gemma-3-27b-it"], [])
    window.gemini_show_other_models_check.setChecked(True)
    window.gemini_model_combo.setCurrentText("gemini-3-pro-preview")
    window.gemini_backup_model_combo.setCurrentText("gemma-3-27b-it")
    window.gemini_show_other_models_check.setChecked(False)
    window._update_ai_model_combos(RECOMMENDED, [], preserve_selection=True)

    assert window.gemini_model_combo.currentText() == "gemini-3-pro-preview"
    assert window.gemini_backup_model_combo.currentText() == "gemma-3-27b-it"
    assert "RECOMMENDED" not in model_names(window.gemini_model_combo)
    assert "OTHER" not in model_names(window.gemini_model_combo)


@pytest.mark.parametrize("show_other", [False, True])
def test_gemini_refresh_respects_toggle_and_preserves_selections(ai_window, monkeypatch, show_other):
    window = ai_window
    window.gemini_show_other_models_check.setChecked(show_other)
    window.gemini_backup_model_combo.setCurrentText(RECOMMENDED[1])
    available = [*RECOMMENDED, "gemini-3-pro-preview"]
    monkeypatch.setattr(ai_models.AIModelFetcher, "_get_gemini_models", lambda self: available)
    save_models = Mock()
    monkeypatch.setattr(ai_models.AIModelsTable, "update_models", save_models)

    window.refresh_ai_models("gemini")

    assert window.gemini_model_combo.currentText() == RECOMMENDED[0]
    assert window.gemini_backup_model_combo.currentText() == RECOMMENDED[1]
    assert ("gemini-3-pro-preview" in model_names(window.gemini_model_combo)) == show_other
    assert ("gemini-3-pro-preview" in model_names(window.gemini_backup_model_combo)) == show_other
    save_models.assert_called_once_with(available, None, None, None)
