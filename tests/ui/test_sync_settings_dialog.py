import os

from PyQt6.QtWidgets import QApplication, QLineEdit

from GameSentenceMiner.ui.config_gui_qt import ConfigWindow
from GameSentenceMiner.ui.sync_settings_dialog import SyncSettingsDialog
from GameSentenceMiner.util.cloud_sync.crypto import SyncCipher
from GameSentenceMiner.util.config import configuration


def test_pairing_preferences_survive_settings_save(monkeypatch):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.get_latest_version", lambda: "test-version")
    monkeypatch.setattr(ConfigWindow, "_refresh_anki_model_list", lambda self, preserve_selection=True: None)
    monkeypatch.setattr(ConfigWindow, "_load_monitors", lambda self, preferred_index=None: None)
    monkeypatch.setattr(ConfigWindow, "get_online_models", lambda self: None)
    monkeypatch.setattr(ConfigWindow, "_schedule_runtime_reload", lambda self: None)
    monkeypatch.setattr(ConfigWindow, "_reload_runtime_config", lambda self: None)
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.write_overlay_scene_settings", lambda settings: None)
    monkeypatch.setattr(
        "GameSentenceMiner.ui.sync_settings_dialog.cloud_sync_service.refresh_background_loop", lambda: None
    )
    window = ConfigWindow()
    dialog = SyncSettingsDialog(window)
    try:
        dialog.key.clear()
        dialog._generate_key()
        pairing = dialog.key.text()
        SyncCipher(pairing)
        assert dialog.key.echoMode() == QLineEdit.EchoMode.Password
        dialog.enabled.setChecked(True)
        dialog.url.setText("https://relay.example.test")
        dialog.token.setText("test-relay-token")
        dialog.groups["language"].setChecked(True)
        assert dialog._save()
        assert window.save_settings(show_indicator=False)
        saved = configuration.Config.load().get_config().advanced
        assert saved.cloud_sync_key == pairing
        assert saved.cloud_sync_settings_groups == ["language"]
        assert saved.cloud_sync_enabled is True
        assert saved.cloud_sync_protocol == "relay-v2"
        if os.getenv("GSM_SYNC_UI_SCREENSHOT"):
            from PyQt6.QtGui import QFont, QFontDatabase

            font_path = os.getenv("GSM_SYNC_UI_FONT")
            if font_path:
                font_id = QFontDatabase.addApplicationFont(font_path)
                families = QFontDatabase.applicationFontFamilies(font_id)
                if families:
                    dialog.setFont(QFont(families[0], 10))
            dialog.show()
            app.processEvents()
            dialog.grab().save(os.environ["GSM_SYNC_UI_SCREENSHOT"])
    finally:
        dialog.close()
        window._auto_save_timer.stop()
        window.close()
        app.processEvents()
