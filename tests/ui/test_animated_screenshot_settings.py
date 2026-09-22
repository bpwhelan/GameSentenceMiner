from __future__ import annotations

import os

from PyQt6.QtCore import QSignalBlocker
from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ui.config_gui_qt import ConfigWindow
from GameSentenceMiner.util.config import configuration


def test_animated_size_and_voice_controls_save_reload_and_enable(monkeypatch):
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
        window.animated_screenshot_check.setChecked(True)
        target = window.animated_target_size_spin
        priority = window.animated_size_priority_combo
        voice = window.animated_only_when_voice_check
        assert target.parentWidget() is not None
        assert voice.parentWidget() is not None
        target.setValue(0)
        assert not priority.isEnabled()
        assert window.animated_adaptive_avif_check.isEnabled()
        window.animated_adaptive_avif_check.setChecked(True)

        for index, key in enumerate(("balanced", "prefer_fps", "prefer_quality")):
            target.setValue(500 + index)
            priority.setCurrentIndex(priority.findData(key))
            voice.setChecked(True)
            assert priority.isEnabled()
            assert not window.animated_adaptive_avif_check.isEnabled()
            assert window.save_settings(show_indicator=False)
            saved = configuration.Config.load().get_config().screenshot.animated_settings
            assert (saved.target_size_kb, saved.size_priority, saved.only_when_voice) == (500 + index, key, True)
            assert saved.adaptive_avif is True
            window._auto_save_timer.stop()
            with QSignalBlocker(target), QSignalBlocker(voice), QSignalBlocker(priority):
                target.setValue(0)
                voice.setChecked(False)
                priority.setCurrentIndex(-1)
            window.reload_settings(force_refresh=True)
            assert target.value() == 500 + index
            assert priority.currentData() == key
            assert voice.isChecked()

        target.setValue(0)
        voice.setChecked(False)
        assert window.save_settings(show_indicator=False)
        saved = configuration.Config.load().get_config().screenshot.animated_settings
        assert saved.target_size_kb == 0
        assert saved.only_when_voice is False
    finally:
        window._auto_save_timer.stop()
        window.close()
        app.processEvents()
