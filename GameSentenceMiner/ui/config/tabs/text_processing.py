from __future__ import annotations

import copy
from typing import TYPE_CHECKING, Iterable, List

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
    QHeaderView,
)

from GameSentenceMiner.util.config.configuration import TextReplacementRule

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config.binding import BindingManager
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


class StringReplacementDialog(QDialog):
    def __init__(self, parent: QWidget, rules: Iterable[TextReplacementRule], i18n: dict):
        super().__init__(parent)
        self._rules: List[TextReplacementRule] = list(copy.deepcopy(list(rules or [])))
        self._i18n = i18n
        string_i18n = i18n.get("string_replacement", {})
        dialog_i18n = string_i18n.get("dialog", {})

        self.setWindowTitle(dialog_i18n.get("title", "String Replacement Rules"))
        self.resize(900, 500)

        layout = QVBoxLayout(self)
        self.table = QTableWidget(0, 6, self)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setHorizontalHeaderLabels(
            [
                dialog_i18n.get("enabled", "Enabled"),
                dialog_i18n.get("mode", "Mode"),
                dialog_i18n.get("find", "Find"),
                dialog_i18n.get("replace", "Replace"),
                dialog_i18n.get("case_sensitive", "Case Sensitive"),
                dialog_i18n.get("whole_word", "Whole Word"),
            ]
        )
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)

        layout.addWidget(self.table)

        buttons_layout = QHBoxLayout()
        add_button = QPushButton(dialog_i18n.get("add", "Add Rule"))
        remove_button = QPushButton(dialog_i18n.get("remove", "Remove Rule"))
        move_up_button = QPushButton(dialog_i18n.get("move_up", "Move Up"))
        move_down_button = QPushButton(dialog_i18n.get("move_down", "Move Down"))
        buttons_layout.addWidget(add_button)
        buttons_layout.addWidget(remove_button)
        buttons_layout.addStretch()
        buttons_layout.addWidget(move_up_button)
        buttons_layout.addWidget(move_down_button)
        layout.addLayout(buttons_layout)

        dialog_buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        layout.addWidget(dialog_buttons)

        add_button.clicked.connect(self._add_empty_rule)
        remove_button.clicked.connect(self._remove_selected_rule)
        move_up_button.clicked.connect(lambda: self._move_selected(-1))
        move_down_button.clicked.connect(lambda: self._move_selected(1))
        dialog_buttons.accepted.connect(self.accept)
        dialog_buttons.rejected.connect(self.reject)

        for rule in self._rules:
            self._append_rule_row(rule)

    def get_rules(self) -> List[TextReplacementRule]:
        return self._collect_rules()

    def _add_empty_rule(self) -> None:
        self._append_rule_row(TextReplacementRule())

    def _remove_selected_rule(self) -> None:
        rows = self._selected_rows()
        if not rows:
            return
        for row in reversed(rows):
            self.table.removeRow(row)

    def _move_selected(self, direction: int) -> None:
        rows = self._selected_rows()
        if len(rows) != 1:
            return
        row = rows[0]
        target = row + direction
        if target < 0 or target >= self.table.rowCount():
            return
        self._swap_rows(row, target)
        self.table.selectRow(target)

    def _swap_rows(self, row_a: int, row_b: int) -> None:
        for col in range(self.table.columnCount()):
            item_a = self.table.takeItem(row_a, col)
            item_b = self.table.takeItem(row_b, col)
            self.table.setItem(row_a, col, item_b)
            self.table.setItem(row_b, col, item_a)

            widget_a = self.table.cellWidget(row_a, col)
            widget_b = self.table.cellWidget(row_b, col)
            if widget_a or widget_b:
                self.table.removeCellWidget(row_a, col)
                self.table.removeCellWidget(row_b, col)
                if widget_a:
                    self.table.setCellWidget(row_b, col, widget_a)
                if widget_b:
                    self.table.setCellWidget(row_a, col, widget_b)

    def _selected_rows(self) -> List[int]:
        return sorted({index.row() for index in self.table.selectedIndexes()})

    def _append_rule_row(self, rule: TextReplacementRule) -> None:
        dialog_i18n = self._i18n.get("string_replacement", {}).get("dialog", {})
        mode_labels = {
            "plain": dialog_i18n.get("mode_plain", "Plain Text"),
            "regex": dialog_i18n.get("mode_regex", "Regex"),
        }

        row = self.table.rowCount()
        self.table.insertRow(row)

        enabled_item = self._make_checkbox_item(rule.enabled)
        self.table.setItem(row, 0, enabled_item)

        mode_combo = QComboBox()
        for key, label in mode_labels.items():
            mode_combo.addItem(label, key)
        mode_key = (rule.mode or "plain").strip().lower()
        mode_index = mode_combo.findData(mode_key)
        if mode_index < 0:
            mode_index = mode_combo.findData("plain")
        mode_combo.setCurrentIndex(mode_index)
        self.table.setCellWidget(row, 1, mode_combo)

        find_item = QTableWidgetItem(rule.find or "")
        replace_item = QTableWidgetItem(rule.replace or "")
        self.table.setItem(row, 2, find_item)
        self.table.setItem(row, 3, replace_item)

        case_item = self._make_checkbox_item(rule.case_sensitive)
        whole_item = self._make_checkbox_item(rule.whole_word)
        self.table.setItem(row, 4, case_item)
        self.table.setItem(row, 5, whole_item)

    def _collect_rules(self) -> List[TextReplacementRule]:
        rules: List[TextReplacementRule] = []
        for row in range(self.table.rowCount()):
            find = self._item_text(row, 2)
            replace = self._item_text(row, 3)
            if not find:
                continue
            enabled = self._item_checked(row, 0)
            case_sensitive = self._item_checked(row, 4)
            whole_word = self._item_checked(row, 5)
            mode = self._mode_value(row)
            rules.append(
                TextReplacementRule(
                    enabled=enabled,
                    mode=mode,
                    find=find,
                    replace=replace,
                    case_sensitive=case_sensitive,
                    whole_word=whole_word,
                )
            )
        return rules

    def _mode_value(self, row: int) -> str:
        widget = self.table.cellWidget(row, 1)
        if isinstance(widget, QComboBox):
            return str(widget.currentData() or widget.currentText() or "plain").strip().lower()
        return "plain"

    def _item_text(self, row: int, col: int) -> str:
        item = self.table.item(row, col)
        return item.text().strip() if item else ""

    def _item_checked(self, row: int, col: int) -> bool:
        item = self.table.item(row, col)
        return bool(item and item.checkState() == Qt.CheckState.Checked)

    @staticmethod
    def _make_checkbox_item(checked: bool) -> QTableWidgetItem:
        item = QTableWidgetItem()
        item.setFlags(Qt.ItemFlag.ItemIsUserCheckable | Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        item.setCheckState(Qt.CheckState.Checked if checked else Qt.CheckState.Unchecked)
        return item


def build_text_processing_tab(window: ConfigWindow, binder: BindingManager, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QVBoxLayout(widget)
    tabs_i18n = i18n.get("tabs", {})
    text_i18n = tabs_i18n.get("text_processing", {})
    string_i18n = text_i18n.get("string_replacement", {})

    group = window._create_group_box(
        string_i18n.get("group_title", "String Replacement"),
        string_i18n.get("group_tooltip"),
    )
    group_layout = QFormLayout()
    group_layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)

    group_layout.addRow(
        window._create_labeled_widget(text_i18n, "string_replacement", "enabled"),
        window.string_replacement_enabled_check,
    )
    binder.bind(
        ("profile", "text_processing", "string_replacement", "enabled"),
        window.string_replacement_enabled_check,
    )

    rules_widget = QWidget()
    rules_layout = QHBoxLayout(rules_widget)
    rules_layout.setContentsMargins(0, 0, 0, 0)
    window.string_replacement_edit_button.setText(
        string_i18n.get("edit_rules", {}).get("label", "Edit Rules")
    )
    window.string_replacement_edit_button.setToolTip(
        string_i18n.get("edit_rules", {}).get("tooltip", "Manage string replacement rules.")
    )
    rules_layout.addWidget(window.string_replacement_edit_button)
    rules_layout.addWidget(window.string_replacement_rules_count_label)
    rules_layout.addStretch()

    group_layout.addRow(
        window._create_labeled_widget(text_i18n, "string_replacement", "rules"),
        rules_widget,
    )
    group.setLayout(group_layout)
    layout.addWidget(group)
    layout.addStretch()

    def open_dialog() -> None:
        dialog = StringReplacementDialog(
            window,
            window.editor.profile.text_processing.string_replacement.rules,
            text_i18n,
        )
        if dialog.exec():
            new_rules = dialog.get_rules()
            window.editor.set_value(
                ("profile", "text_processing", "string_replacement", "rules"),
                new_rules,
            )
            window._update_string_replacement_rules_count(new_rules)
            window.request_auto_save()

    window.string_replacement_edit_button.clicked.connect(open_dialog)
    window.string_replacement_enabled_check.stateChanged.connect(
        lambda *_: window._update_string_replacement_rules_count(
            window.editor.profile.text_processing.string_replacement.rules
        )
    )
    window._update_string_replacement_rules_count(
        window.editor.profile.text_processing.string_replacement.rules
    )

    layout.addWidget(window._create_reset_button("text_processing", window._create_text_processing_tab))
    return widget
