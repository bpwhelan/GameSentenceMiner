from __future__ import annotations

from typing import Any

from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
)


class AnkiFieldGroupingDialog(QDialog):
    def __init__(
        self,
        expression: str,
        candidates: list[dict[str, Any]],
        default_order: str = "front",
        default_delete_duplicate: bool = True,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self._selection_result: dict[str, Any] | None = None
        self.setWindowTitle("Merge duplicate Anki note")
        self.setModal(True)
        self.setMinimumWidth(620)

        layout = QVBoxLayout(self)
        explanation = QLabel(
            f"An existing note for “{expression}” was found. Choose the original note that should receive "
            "the new sentence, audio, screenshot, and other grouped context fields."
        )
        explanation.setWordWrap(True)
        layout.addWidget(explanation)

        form = QFormLayout()
        self.target_combo = QComboBox()
        for candidate in candidates:
            note_id = int(candidate["note_id"])
            sentence = " ".join(str(candidate.get("sentence") or "").split())
            if len(sentence) > 110:
                sentence = f"{sentence[:107]}..."
            tags = ", ".join(str(tag) for tag in (candidate.get("tags") or []))
            details = sentence or "No sentence context"
            if tags:
                details = f"{details}  [{tags}]"
            self.target_combo.addItem(f"Note {note_id} — {details}", note_id)
        self.target_combo.setToolTip("When several duplicate notes exist, select which original note to merge into.")
        form.addRow("Merge into:", self.target_combo)

        self.order_combo = QComboBox()
        self.order_combo.addItem("Front (show newest context first)", "front")
        self.order_combo.addItem("Back (show newest context last)", "back")
        order_index = self.order_combo.findData(str(default_order or "front").lower())
        self.order_combo.setCurrentIndex(order_index if order_index >= 0 else 0)
        form.addRow("New context order:", self.order_combo)

        self.delete_duplicate_check = QCheckBox("Delete the newly created duplicate note after a successful merge")
        self.delete_duplicate_check.setChecked(bool(default_delete_duplicate))
        self.delete_duplicate_check.setToolTip(
            "The duplicate is deleted only after the selected original note has been updated successfully."
        )
        form.addRow("", self.delete_duplicate_check)
        layout.addLayout(form)

        warning = QLabel(
            "Existing data-group-id values are preserved. Ungrouped context on the original and new notes "
            "is assigned matching group IDs for compatible note types such as Kiku."
        )
        warning.setWordWrap(True)
        layout.addWidget(warning)

        buttons = QDialogButtonBox()
        keep_separate_button = QPushButton("Keep as separate note")
        merge_button = QPushButton("Merge contexts")
        merge_button.setDefault(True)
        buttons.addButton(keep_separate_button, QDialogButtonBox.ButtonRole.RejectRole)
        buttons.addButton(merge_button, QDialogButtonBox.ButtonRole.AcceptRole)
        keep_separate_button.clicked.connect(self.reject)
        merge_button.clicked.connect(self._accept_merge)
        layout.addWidget(buttons)

    def _accept_merge(self) -> None:
        target_note_id = self.target_combo.currentData()
        if target_note_id is None:
            return
        self._selection_result = {
            "target_note_id": int(target_note_id),
            "order": str(self.order_combo.currentData() or "front"),
            "delete_duplicate": self.delete_duplicate_check.isChecked(),
        }
        self.accept()

    def reject(self) -> None:
        self._selection_result = None
        super().reject()

    def exec(self) -> dict[str, Any] | None:
        super().exec()
        return self._selection_result


def show_anki_field_grouping_dialog(
    expression: str,
    candidates: list[dict[str, Any]],
    default_order: str = "front",
    default_delete_duplicate: bool = True,
    parent=None,
) -> dict[str, Any] | None:
    dialog = AnkiFieldGroupingDialog(
        expression=expression,
        candidates=candidates,
        default_order=default_order,
        default_delete_duplicate=default_delete_duplicate,
        parent=parent,
    )
    return dialog.exec()
