from __future__ import annotations

import os
import sys

import pytest
from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QDialog, QPushButton

from GameSentenceMiner.ui.anki_field_grouping_qt import AnkiFieldGroupingDialog, show_anki_field_grouping_dialog


@pytest.mark.parametrize("topmost_windows", [(False, False), (True, True), (True, False)])
@pytest.mark.parametrize("finish", ["merge", "keep_separate", "escape", "close"])
def test_merge_prompt_stays_accessible_above_blocked_windows(topmost_windows, finish):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    confirmation = QDialog()
    selector = QDialog()
    observations = {}
    try:
        for window, always_on_top in zip((confirmation, selector), topmost_windows):
            window.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, always_on_top)
            window.setModal(True)
            window.show()
        app.processEvents()

        def interact_with_merge():
            dialog = QApplication.activeModalWidget()
            observations["dialog"] = dialog
            observations["parent"] = dialog.parentWidget()
            observations["topmost"] = bool(dialog.windowFlags() & Qt.WindowType.WindowStaysOnTopHint)
            if sys.platform == "win32" and QApplication.platformName() == "windows":
                import win32gui

                z_order = []
                win32gui.EnumWindows(lambda hwnd, _: z_order.append(hwnd), None)
                observations["above_blocked_windows"] = all(
                    z_order.index(int(dialog.winId())) < z_order.index(int(window.winId()))
                    for window in (confirmation, selector)
                )
            if finish in ("merge", "keep_separate"):
                text = "Merge contexts" if finish == "merge" else "Keep as separate note"
                button = next(button for button in dialog.findChildren(QPushButton) if button.text() == text)
                QTest.mouseClick(button, Qt.MouseButton.LeftButton)
            elif finish == "escape":
                QTest.keyClick(dialog, Qt.Key.Key_Escape)
            else:
                dialog.close()

        QTimer.singleShot(0, interact_with_merge)
        result = show_anki_field_grouping_dialog("貢献", [{"note_id": 100, "sentence": "original context"}])

        assert isinstance(observations["dialog"], AnkiFieldGroupingDialog)
        assert observations["parent"] is selector
        assert observations["topmost"] is any(topmost_windows)
        if "above_blocked_windows" in observations:
            assert observations["above_blocked_windows"]
        assert QApplication.activeModalWidget() is selector
        if finish == "merge":
            assert result == {"target_note_id": 100, "order": "front", "delete_duplicate": True}
        else:
            assert result is None
        QTest.keyClick(selector, Qt.Key.Key_Escape)
        assert not selector.isVisible()
        assert QApplication.activeModalWidget() is confirmation
    finally:
        for window in (selector, confirmation):
            window.hide()
            window.deleteLater()
        app.processEvents()


@pytest.mark.parametrize("visible", [False, True])
def test_merge_prompt_handles_topmost_confirmation_without_focus(monkeypatch, visible):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    confirmation = QDialog()
    confirmation.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint)
    confirmation.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
    confirmation.setVisible(visible)
    app.processEvents()
    monkeypatch.setattr(QApplication, "activeWindow", lambda: None)
    dialog = AnkiFieldGroupingDialog("word", [{"note_id": 100}])
    try:
        assert dialog.parentWidget() is None
        assert bool(dialog.windowFlags() & Qt.WindowType.WindowStaysOnTopHint) is visible
    finally:
        dialog.deleteLater()
        confirmation.hide()
        confirmation.deleteLater()
        app.processEvents()


def test_field_grouping_dialog_supports_multiple_targets_and_configured_defaults() -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    dialog = AnkiFieldGroupingDialog(
        expression="貢献",
        candidates=[
            {"note_id": 100, "sentence": "first context", "tags": ["old"]},
            {"note_id": 200, "sentence": "second context", "tags": []},
        ],
        default_order="back",
        default_delete_duplicate=False,
    )
    try:
        assert dialog.target_combo.count() == 2
        assert dialog.target_combo.currentData() == 100
        assert dialog.order_combo.currentData() == "back"
        assert dialog.delete_duplicate_check.isChecked() is False
        dialog.target_combo.setCurrentIndex(1)
        dialog.order_combo.setCurrentIndex(dialog.order_combo.findData("front"))
        dialog.delete_duplicate_check.setChecked(True)
        dialog._accept_merge()
        assert dialog._selection_result == {
            "target_note_id": 200,
            "order": "front",
            "delete_duplicate": True,
        }

        dialog._accept_overwrite()

        assert dialog._selection_result == {
            "target_note_id": 200,
            "order": "front",
            "delete_duplicate": True,
            "overwrite": True,
        }
    finally:
        dialog.deleteLater()
        app.processEvents()
