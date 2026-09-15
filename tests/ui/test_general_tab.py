import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from PyQt6.QtWidgets import QApplication, QCheckBox, QLineEdit, QPushButton, QWidget

from GameSentenceMiner.ui.config.binding import BindingManager
from GameSentenceMiner.ui.config.tabs import general


@pytest.mark.parametrize("admin", [True, False])
@pytest.mark.parametrize("saved", [True, False])
def test_admin_disables_startup_option_without_changing_preference(monkeypatch, admin, saved):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr(general, "is_windows_admin", lambda: admin)
    monkeypatch.setattr(general, "_add_input_sources_row", lambda *args: None)
    monkeypatch.setattr(general, "WebsocketSourcesEditor", QWidget)
    monkeypatch.setattr(general, "is_beangate", False)
    window = SimpleNamespace(
        single_port_edit=QLineEdit(),
        _create_general_tab=lambda: None,
        _create_reset_button=lambda *args: QPushButton(),
        **{spec.attr: QCheckBox() for spec in general.GENERAL_FIELDS},
    )
    editor = SimpleNamespace(
        get_value=lambda path: 7275 if path[-1] == "single_port" else saved,
        set_value=Mock(),
        subscribe=lambda *args: None,
    )
    binder = BindingManager(editor)
    locale_path = Path(__file__).resolve().parents[2] / "GameSentenceMiner/locales/en_us.json"
    i18n = json.loads(locale_path.read_text(encoding="utf-8"))["python"]["config"]
    widget = general.build_general_tab(window, binder, i18n)
    try:
        checkbox = window.open_multimine_on_startup_check
        assert checkbox.isEnabled() is not admin
        assert checkbox.isChecked() is saved
        if admin:
            assert "administrator" in checkbox.text()
            assert "Disabled" in checkbox.text()
        else:
            assert checkbox.text() == ""
        assert "administrator" in checkbox.toolTip()
        binder.refresh_all()
        assert checkbox.isEnabled() is not admin
        assert checkbox.isChecked() is saved
        editor.set_value.assert_not_called()
    finally:
        widget.deleteLater()
        app.processEvents()
