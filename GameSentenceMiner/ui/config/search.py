from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (
    QAbstractButton,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QScrollArea,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


class SearchLineEdit(QLineEdit):
    """Search box that clears itself on Escape (mirrors the overlay settings search)."""

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Escape and self.text():
            self.clear()
            return
        super().keyPressEvent(event)


@dataclass
class _RowEntry:
    root_index: int
    subtab_widget: QTabWidget | None
    subtab_index: int
    form_layout: QFormLayout
    row: int
    parent_rows: tuple[tuple[int, int], ...]
    is_result: bool
    label: str
    detail: str
    path: str
    target_widget: QWidget | None
    text: str


class ConfigSearchController:
    """Live, in-place filtering of every config row across all tabs and sub-tabs.

    Mirrors the GSM Overlay settings search: substring match over each setting's
    label + tooltip + tab path, hiding non-matching rows and surfacing match counts
    on the tab labels.
    """

    def __init__(self, window: "ConfigWindow", count_label: QLabel):
        self.window = window
        self.count_label = count_label
        self._entries: list[_RowEntry] = []
        self._root_titles: dict[int, str] = {}
        # subtab titles keyed by (id(subtab_widget), subtab_index)
        self._subtab_titles: dict[tuple[int, int], str] = {}
        self._active = False
        self._results_area: QScrollArea | None = None
        self._results_content: QWidget | None = None
        self._results_layout: QVBoxLayout | None = None
        self._setup_results_panel()

    def _setup_results_panel(self):
        main_layout = getattr(self.window, "main_layout", None)
        tab_widget = getattr(self.window, "tab_widget", None)
        if main_layout is None or tab_widget is None:
            return

        self._results_content = QWidget()
        self._results_layout = QVBoxLayout(self._results_content)
        self._results_layout.setContentsMargins(10, 10, 10, 10)
        self._results_layout.setSpacing(10)

        self._results_area = QScrollArea()
        self._results_area.setWidgetResizable(True)
        self._results_area.setFrameShape(QScrollArea.Shape.NoFrame)
        self._results_area.setWidget(self._results_content)
        self._results_area.hide()

        index = main_layout.indexOf(tab_widget)
        if index >= 0:
            main_layout.insertWidget(index + 1, self._results_area)

    # --- index ---------------------------------------------------------------
    def build_index(self):
        self._entries.clear()
        self._root_titles.clear()
        self._subtab_titles.clear()
        tabs = self.window.tab_widget
        for i in range(tabs.count()):
            widget = tabs.widget(i)
            self._root_titles[i] = tabs.tabText(i)
            if isinstance(widget, QTabWidget):
                for j in range(widget.count()):
                    self._subtab_titles[(id(widget), j)] = widget.tabText(j)
                    self._index_leaf(i, widget, j, widget.widget(j))
            else:
                self._index_leaf(i, None, -1, widget)

    def _index_leaf(self, root_index, subtab_widget, subtab_index, content):
        if content is None:
            return
        root_title = self._root_titles.get(root_index, "")
        subtab_title = self._subtab_titles.get((id(subtab_widget), subtab_index), "") if subtab_widget else ""
        widget_rows = self._build_widget_row_map(content)
        for form in content.findChildren(QFormLayout):
            for row in range(form.rowCount()):
                entry = self._build_entry(
                    root_index,
                    subtab_widget,
                    subtab_index,
                    form,
                    row,
                    root_title,
                    subtab_title,
                    widget_rows,
                )
                if entry is not None:
                    self._entries.append(entry)

    def _build_widget_row_map(self, content) -> dict[int, tuple[QFormLayout, int]]:
        widget_rows: dict[int, tuple[QFormLayout, int]] = {}
        for form in content.findChildren(QFormLayout):
            for row in range(form.rowCount()):
                for role in (
                    QFormLayout.ItemRole.LabelRole,
                    QFormLayout.ItemRole.FieldRole,
                    QFormLayout.ItemRole.SpanningRole,
                ):
                    item = form.itemAt(row, role)
                    widget = item.widget() if item else None
                    if widget is not None:
                        widget_rows[id(widget)] = (form, row)
        return widget_rows

    def _build_entry(
        self,
        root_index,
        subtab_widget,
        subtab_index,
        form,
        row,
        root_title,
        subtab_title,
        widget_rows,
    ):
        label_item = form.itemAt(row, QFormLayout.ItemRole.LabelRole)
        field_item = form.itemAt(row, QFormLayout.ItemRole.FieldRole)
        spanning_item = form.itemAt(row, QFormLayout.ItemRole.SpanningRole)
        if label_item is None and field_item is None:
            field_item = spanning_item
        if label_item is None and field_item is None:
            return None
        label_w = label_item.widget() if label_item else None
        field_w = field_item.widget() if field_item else None
        parent_rows = self._find_parent_rows(form.parentWidget(), widget_rows)
        parent_context = [self._row_widget_title(row_form, row_index) for row_form, row_index in parent_rows]
        label = self._display_label(label_w, field_w)
        detail = self._display_detail(label_w, field_w)
        path = " > ".join(part for part in (root_title, subtab_title, *parent_context) if part)
        parts = [root_title, subtab_title, *parent_context]
        if label_w is not None:
            parts.append(self._widget_search_text(label_w))
        if field_w is not None:
            parts.append(self._widget_search_text(field_w))
        return _RowEntry(
            root_index=root_index,
            subtab_widget=subtab_widget,
            subtab_index=subtab_index,
            form_layout=form,
            row=row,
            parent_rows=tuple((id(row_form), row_index) for row_form, row_index in parent_rows),
            is_result=label_w is not None,
            label=label,
            detail=detail,
            path=path,
            target_widget=label_w or field_w,
            text=" ".join(p for p in parts if p).lower(),
        )

    def _find_parent_rows(self, widget, widget_rows) -> list[tuple[QFormLayout, int]]:
        rows: list[tuple[QFormLayout, int]] = []
        current = widget
        while current is not None:
            row_ref = widget_rows.get(id(current))
            if row_ref is not None:
                rows.append(row_ref)
            current = current.parentWidget()
        rows.reverse()
        return rows

    def _row_widget_title(self, form: QFormLayout, row: int) -> str:
        for role in (QFormLayout.ItemRole.SpanningRole, QFormLayout.ItemRole.FieldRole):
            item = form.itemAt(row, role)
            widget = item.widget() if item else None
            if isinstance(widget, QGroupBox):
                return widget.title()
        return ""

    def _display_label(self, label_w, field_w) -> str:
        if isinstance(label_w, QLabel):
            return label_w.text().strip()
        if isinstance(field_w, QGroupBox):
            return field_w.title().strip()
        return self._first_widget_text(field_w) or ""

    def _display_detail(self, label_w, field_w) -> str:
        if isinstance(label_w, QLabel) and label_w.toolTip():
            return label_w.toolTip().strip()
        if field_w is not None and field_w.toolTip():
            return field_w.toolTip().strip()
        return ""

    def _first_widget_text(self, widget) -> str:
        for text in self._widget_text_parts(widget, recursive=True):
            if text:
                return text
        return ""

    def _widget_search_text(self, widget) -> str:
        return " ".join(self._widget_text_parts(widget, recursive=True))

    def _widget_text_parts(self, widget, recursive: bool) -> list[str]:
        if widget is None:
            return []

        widgets = [widget]
        if recursive:
            widgets.extend(widget.findChildren(QWidget))

        parts: list[str] = []
        seen: set[int] = set()
        for current in widgets:
            if id(current) in seen:
                continue
            seen.add(id(current))
            if isinstance(current, QLabel):
                parts.append(current.text())
            elif isinstance(current, QAbstractButton):
                parts.append(current.text())
            elif isinstance(current, QGroupBox):
                parts.append(current.title())
            elif isinstance(current, QLineEdit):
                parts.append(current.placeholderText())

            tooltip = current.toolTip()
            if tooltip:
                parts.append(tooltip)
        return [part.strip() for part in parts if part and part.strip()]

    # --- apply / clear -------------------------------------------------------
    def apply(self, raw_query: str):
        query = (raw_query or "").strip().lower()
        if not query:
            self.clear()
            return
        if not self._active:
            # (Re)build at the start of each search; tab content may have been
            # recreated by reset buttons / the GSM-Cloud toggle since last time.
            self.build_index()
            self._active = True

        root_counts: dict[int, int] = {}
        subtab_counts: dict[tuple[int, int], int] = {}
        matched_entries: list[_RowEntry] = []
        visible_rows: set[tuple[int, int]] = set()
        stale = False
        for entry in self._entries:
            try:
                match = entry.is_result and query in entry.text
            except RuntimeError:
                stale = True
                continue
            if match:
                matched_entries.append(entry)
                root_counts[entry.root_index] = root_counts.get(entry.root_index, 0) + 1
                if entry.subtab_widget is not None:
                    key = (id(entry.subtab_widget), entry.subtab_index)
                    subtab_counts[key] = subtab_counts.get(key, 0) + 1
                visible_rows.add((id(entry.form_layout), entry.row))
                visible_rows.update(entry.parent_rows)

        if stale:
            # Index pointed at deleted widgets; rebuild and retry once.
            self.build_index()
            self.apply(raw_query)
            return

        for entry in self._entries:
            try:
                entry.form_layout.setRowVisible(entry.row, (id(entry.form_layout), entry.row) in visible_rows)
            except RuntimeError:
                continue

        self._update_tab_labels(root_counts, subtab_counts)
        self._set_count_label(len(matched_entries))
        self._update_results_panel(matched_entries)
        if self._results_area is None:
            self._auto_jump(root_counts, subtab_counts)

    def clear(self):
        for entry in self._entries:
            try:
                entry.form_layout.setRowVisible(entry.row, True)
            except RuntimeError:
                continue
        tabs = self.window.tab_widget
        for i, title in self._root_titles.items():
            try:
                tabs.setTabText(i, title)
                tabs.setTabEnabled(i, True)
            except RuntimeError:
                continue
        for entry in self._entries:
            sub = entry.subtab_widget
            if sub is None:
                continue
            try:
                title = self._subtab_titles.get((id(sub), entry.subtab_index))
                if title is not None:
                    sub.setTabText(entry.subtab_index, title)
                    sub.setTabEnabled(entry.subtab_index, True)
            except RuntimeError:
                continue
        self.count_label.setText("")
        self._clear_results_panel()
        tab_widget = getattr(self.window, "tab_widget", None)
        if tab_widget is not None:
            tab_widget.show()
        self._active = False

    # --- helpers -------------------------------------------------------------
    def _update_tab_labels(self, root_counts, subtab_counts):
        tabs = self.window.tab_widget
        for i, title in self._root_titles.items():
            n = root_counts.get(i, 0)
            try:
                tabs.setTabText(i, f"{title} ({n})" if n else title)
                tabs.setTabEnabled(i, n > 0)
            except RuntimeError:
                continue
        seen = set()
        for entry in self._entries:
            sub = entry.subtab_widget
            if sub is None or (id(sub), entry.subtab_index) in seen:
                continue
            seen.add((id(sub), entry.subtab_index))
            key = (id(sub), entry.subtab_index)
            title = self._subtab_titles.get(key, "")
            n = subtab_counts.get(key, 0)
            try:
                sub.setTabText(entry.subtab_index, f"{title} ({n})" if n else title)
                sub.setTabEnabled(entry.subtab_index, n > 0)
            except RuntimeError:
                continue

    def _set_count_label(self, total: int):
        i18n = self.window.i18n.get("search", {})
        if total == 1:
            text = i18n.get("match", "1 match")
        elif total == 0:
            text = i18n.get("no_results", "No settings match your search.")
        else:
            text = i18n.get("matches", "{count} matches").format(count=total)
        self.count_label.setText(text)

    def _auto_jump(self, root_counts, subtab_counts):
        if not root_counts:
            return
        tabs = self.window.tab_widget
        target_root = min(root_counts)
        try:
            tabs.setCurrentIndex(target_root)
        except RuntimeError:
            return
        sub = self.window.tab_widget.widget(target_root)
        if isinstance(sub, QTabWidget):
            for j in range(sub.count()):
                if subtab_counts.get((id(sub), j), 0) > 0:
                    sub.setCurrentIndex(j)
                    break

    # --- one-page results ----------------------------------------------------
    def _update_results_panel(self, entries: list[_RowEntry]):
        if self._results_area is None or self._results_layout is None:
            return

        self._clear_result_widgets()
        self.window.tab_widget.hide()
        self._results_area.show()

        if not entries:
            empty = QLabel(self.window.i18n.get("search", {}).get("no_results", "No settings match your search."))
            empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
            empty.setStyleSheet("color: #888; padding: 24px;")
            self._results_layout.addWidget(empty)
            self._results_layout.addStretch(1)
            return

        grouped: dict[str, list[_RowEntry]] = {}
        for entry in entries:
            grouped.setdefault(entry.path, []).append(entry)

        for path, path_entries in grouped.items():
            group = QGroupBox(path)
            layout = QVBoxLayout(group)
            layout.setSpacing(6)
            for entry in path_entries:
                layout.addWidget(self._create_result_row(entry))
            self._results_layout.addWidget(group)
        self._results_layout.addStretch(1)

    def _create_result_row(self, entry: _RowEntry) -> QWidget:
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(8, 6, 8, 6)
        layout.setSpacing(8)

        text_widget = QWidget()
        text_layout = QVBoxLayout(text_widget)
        text_layout.setContentsMargins(0, 0, 0, 0)
        text_layout.setSpacing(2)

        title = QLabel(entry.label or entry.path)
        title.setStyleSheet("font-weight: 600;")
        text_layout.addWidget(title)
        if entry.detail:
            detail = QLabel(entry.detail)
            detail.setWordWrap(True)
            detail.setStyleSheet("color: #888;")
            text_layout.addWidget(detail)

        layout.addWidget(text_widget, 1)

        open_text = self.window.i18n.get("search", {}).get("open_result", "Open")
        open_button = QPushButton(open_text)
        open_button.clicked.connect(lambda _checked=False, result=entry: self._open_entry(result))
        layout.addWidget(open_button)
        return row

    def _clear_result_widgets(self):
        if self._results_layout is None:
            return
        while self._results_layout.count():
            item = self._results_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    def _clear_results_panel(self):
        self._clear_result_widgets()
        if self._results_area is not None:
            self._results_area.hide()

    def _open_entry(self, entry: _RowEntry):
        search_input = getattr(self.window, "search_input", None)
        if search_input is not None:
            search_input.clear()
        else:
            self.clear()

        try:
            self.window.tab_widget.setCurrentIndex(entry.root_index)
            if entry.subtab_widget is not None:
                entry.subtab_widget.setCurrentIndex(entry.subtab_index)
        except RuntimeError:
            return

        if entry.target_widget is not None:
            QTimer.singleShot(0, lambda widget=entry.target_widget: self._scroll_to_widget(widget))

    def _scroll_to_widget(self, widget: QWidget):
        try:
            current = widget.parentWidget()
            while current is not None and not isinstance(current, QScrollArea):
                current = current.parentWidget()
            if isinstance(current, QScrollArea):
                current.ensureWidgetVisible(widget, 40, 40)
            widget.setFocus(Qt.FocusReason.OtherFocusReason)
        except RuntimeError:
            return
