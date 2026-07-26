from __future__ import annotations

import os

from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ui.anki_field_grouping_qt import AnkiFieldGroupingDialog


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
