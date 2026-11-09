from __future__ import annotations

import os

from PyQt6.QtCore import QSignalBlocker
from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def test_openai_reasoning_can_be_saved_reloaded_and_autosaved(monkeypatch):
    from GameSentenceMiner.util.config import configuration

    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.get_latest_version", lambda: "test-version")
    monkeypatch.setattr(ConfigWindow, "_refresh_anki_model_list", lambda self, preserve_selection=True: None)
    monkeypatch.setattr(ConfigWindow, "_load_monitors", lambda self, preferred_index=None: None)
    monkeypatch.setattr(ConfigWindow, "get_online_models", lambda self: None)
    monkeypatch.setattr(ConfigWindow, "_schedule_runtime_reload", lambda self: None)
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.write_overlay_scene_settings", lambda settings: None)
    window = ConfigWindow()
    try:
        combo = window.open_ai_reasoning_effort_combo
        assert not combo.isEditable()
        assert combo.parentWidget() is window.openai_settings_group
        assert window.openai_settings_group.layout().labelForField(combo).text() == "Reasoning effort"
        assert [combo.itemData(i) for i in range(combo.count())] == [
            "",
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        ]
        for effort in ("high", "none", "max", ""):
            combo.setCurrentIndex(combo.findData(effort))
            assert window._auto_save_timer.isActive()
            assert window.save_settings(show_indicator=False)
            assert configuration.Config.load().get_config().ai.open_ai_reasoning_effort == effort
            window._auto_save_timer.stop()
            with QSignalBlocker(combo):
                combo.setCurrentIndex(-1)
            window.reload_settings(force_refresh=True)
            assert window.open_ai_reasoning_effort_combo.currentData() == effort
            combo = window.open_ai_reasoning_effort_combo
    finally:
        window._auto_save_timer.stop()
        window.close()
        app.processEvents()
