from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import Qt
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFormLayout,
    QGroupBox,
    QLabel,
    QLineEdit,
    QPushButton,
)

from GameSentenceMiner.ui.config.tabs.hotkeys import build_hotkeys_tab


class _FakeConfigWindow:
    def __init__(self) -> None:
        self.pause_text_intake_hotkey_edit = QLineEdit("F13")
        self.manual_overlay_scan_hotkey_edit = QLineEdit("+")
        self.play_latest_audio_hotkey_edit = QLineEdit("F7")
        self.process_pause_hotkey_edit = QLineEdit()

        self.pause_text_intake_gamepad_combo = self._gamepad_combo()
        self.manual_overlay_scan_gamepad_combo = self._gamepad_combo()
        self.play_latest_audio_gamepad_combo = self._gamepad_combo()
        self.process_pause_gamepad_combo = self._gamepad_combo()
        self.relay_outputs_when_text_intake_paused_check = QCheckBox()

    @staticmethod
    def _gamepad_combo() -> QComboBox:
        combo = QComboBox()
        combo.addItems(["Disabled", "D-Pad Right"])
        return combo

    @staticmethod
    def _create_group_box(title: str) -> QGroupBox:
        return QGroupBox(title)

    @staticmethod
    def _create_labeled_widget(_tabs_i18n, section: str, key: str) -> QLabel:
        labels = {
            ("hotkeys", "pause_text_intake"): "Pause GSM Text Intake Hotkey:",
            ("overlay", "manual_overlay_scan_hotkey"): "Manual Overlay Scan Hotkey",
            ("advanced", "play_latest_hotkey"): "Play Latest Video/Audio Hotkey:",
            ("game_pausing", "hotkey"): "Game Pause Hotkey:",
        }
        return QLabel(labels[(section, key)])

    @staticmethod
    def _create_reset_button(*_args) -> QPushButton:
        return QPushButton("Reset to Default")

    @staticmethod
    def _create_hotkeys_tab() -> None:
        return None


def test_hotkeys_tab_does_not_require_horizontal_scrolling() -> None:
    app = QApplication.instance() or QApplication([])
    window = _FakeConfigWindow()
    i18n = {
        "tabs": {
            "hotkeys": {
                "relay_outputs_when_paused": {
                    "checkbox": "Relay to texthooker/output clients while paused",
                }
            }
        }
    }

    tab = build_hotkeys_tab(window, i18n)
    tab.ensurePolished()
    app.processEvents()

    assert tab.minimumSizeHint().width() < 600
    assert len(tab.findChildren(QFormLayout)) == 4

    relay_label = next(
        label for label in tab.findChildren(QLabel) if label.text() == "Relay to texthooker/output clients while paused"
    )
    assert not window.relay_outputs_when_text_intake_paused_check.isChecked()
    QTest.mouseClick(relay_label, Qt.MouseButton.LeftButton)
    assert window.relay_outputs_when_text_intake_paused_check.isChecked()
