import os

import pytest
from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


@pytest.fixture
def ai_window(monkeypatch):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.get_latest_version", lambda: "test-version")
    monkeypatch.setattr(ConfigWindow, "_refresh_anki_model_list", lambda self, preserve_selection=True: None)
    monkeypatch.setattr(ConfigWindow, "_load_monitors", lambda self, preferred_index=None: None)
    monkeypatch.setattr(ConfigWindow, "get_online_models", lambda self: None)
    monkeypatch.setattr(ConfigWindow, "_schedule_runtime_reload", lambda self: None)
    window = ConfigWindow()
    yield window
    window._auto_save_timer.stop()
    window.close()
    app.processEvents()


def test_cached_groq_recommendations_use_current_models(ai_window):
    window = ai_window
    window.settings.ai.groq_model = "openai/gpt-oss-120b"
    window.settings.ai.groq_backup_model = "openai/gpt-oss-20b"

    window._update_ai_model_combos(
        [],
        ["RECOMMENDED", "meta-llama/llama-4-scout-17b-16e-instruct", "OTHER", "groq/compound"],
    )

    assert [window.groq_model_combo.itemText(i) for i in range(window.groq_model_combo.count())] == [
        "RECOMMENDED",
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "OTHER",
        "groq/compound",
    ]
    assert window.groq_model_combo.currentText() == "openai/gpt-oss-120b"
    assert window.groq_backup_model_combo.currentText() == "openai/gpt-oss-20b"


def test_cached_groq_models_preserve_explicit_selection(ai_window):
    window = ai_window
    window.settings.ai.groq_model = "meta-llama/llama-4-scout-17b-16e-instruct"
    window.settings.ai.groq_backup_model = "custom/backup"

    window._update_ai_model_combos(
        [],
        ["RECOMMENDED", "meta-llama/llama-4-scout-17b-16e-instruct", "OTHER"],
    )

    assert window.groq_model_combo.currentText() == window.settings.ai.groq_model
    assert window.groq_backup_model_combo.currentText() == window.settings.ai.groq_backup_model
