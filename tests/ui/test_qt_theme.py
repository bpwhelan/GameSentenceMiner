import json
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PyQt6.QtGui import QPalette
from PyQt6.QtWidgets import QApplication, QLabel, QWidget

from GameSentenceMiner.ui import qt_theme
from GameSentenceMiner.ui.audio_waveform_widget import AudioWaveformWidget
from GameSentenceMiner.ui.config.labels import LabelColor, build_label


def test_default_qt_palette_uses_gsm_base_colors():
    palette = qt_theme.get_theme_palette("gsm-dark")
    assert palette["surface-0"] == "#1a1a1a"
    assert palette["surface-1"] == "#2a2a2a"
    assert palette["text-primary"] == "#ececef"
    assert palette["accent"] == "#7aa2ff"
    assert qt_theme.get_theme_palette("unknown-theme") == palette


@pytest.mark.parametrize("theme", ["solarized-light", "light", "catppuccin-mocha", "high-contrast", "nord"])
def test_qt_supports_the_desktop_theme_picker_palettes(theme):
    palette = qt_theme.get_theme_palette(theme)
    assert palette["id"] == theme
    assert palette["scheme"] in {"dark", "light"}


@pytest.mark.parametrize("selection", [None, 123, {}, "unknown-theme"])
def test_invalid_saved_theme_falls_back_to_gsm_default(tmp_path, selection):
    app = QApplication.instance() or QApplication([])
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"theme": selection}), encoding="utf-8")
    window = QWidget()
    qt_theme.apply_compact_theme(window, config_path=path)
    assert window.property("gsmTheme") == "gsm-dark"
    window.deleteLater()
    app.processEvents()


def test_qt_windows_follow_saved_theme_without_changing_settings(tmp_path):
    app = QApplication.instance() or QApplication([])
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"theme": "gsm-dark", "unrelated": "preserve"}), encoding="utf-8")
    window = QWidget()
    waveform = AudioWaveformWidget(window)
    status = QLabel("Saved", window)
    required = build_label({}, "section", "label", color=LabelColor.IMPORTANT, bold=True)
    required.setParent(window)
    qt_theme.apply_compact_theme(window, config_path=config_path)
    qt_theme.set_status_style(status, "success")
    window.show()
    app.processEvents()
    controller = window._gsm_theme_controller
    assert controller.timer.isActive()
    assert window.palette().color(QPalette.ColorRole.Window).name() == "#1a1a1a"

    saved = json.dumps({"theme": "solarized-light", "unrelated": "preserve"})
    config_path.write_text(saved, encoding="utf-8")
    controller.refresh()
    palette = qt_theme.get_theme_palette("solarized-light")
    assert window.property("gsmTheme") == "solarized-light"
    assert window.palette().color(QPalette.ColorRole.Window).name() == "#fdf6e3"
    assert waveform.color_background.name() == palette["surface-0"]
    assert waveform.color_waveform_selected.name() == palette["accent"]
    assert palette["success-text"] in status.styleSheet()
    assert palette["text-primary"] in required.styleSheet()
    assert "font-weight: bold" in required.styleSheet()
    assert config_path.read_text(encoding="utf-8") == saved

    # Atomic writes can briefly leave an incomplete document; retain the last
    # valid theme and pick up the next complete save.
    config_path.write_text("{", encoding="utf-8")
    controller.refresh()
    assert window.property("gsmTheme") == "solarized-light"
    window.hide()
    app.processEvents()
    assert not controller.timer.isActive()
    config_path.write_text(json.dumps({"theme": "high-contrast"}), encoding="utf-8")
    window.show()
    app.processEvents()
    assert window.property("gsmTheme") == "high-contrast"
    window.hide()
    window.deleteLater()
    app.processEvents()
