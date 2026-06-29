from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QFormLayout, QLabel, QLineEdit, QTabWidget

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
    is_spanning: bool  # row has no label (action/reset buttons)
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
        for form in content.findChildren(QFormLayout):
            for row in range(form.rowCount()):
                entry = self._build_entry(root_index, subtab_widget, subtab_index, form, row, root_title, subtab_title)
                if entry is not None:
                    self._entries.append(entry)

    def _build_entry(self, root_index, subtab_widget, subtab_index, form, row, root_title, subtab_title):
        label_item = form.itemAt(row, QFormLayout.ItemRole.LabelRole)
        field_item = form.itemAt(row, QFormLayout.ItemRole.FieldRole)
        if label_item is None and field_item is None:
            return None
        label_w = label_item.widget() if label_item else None
        field_w = field_item.widget() if field_item else None
        parts = [root_title, subtab_title]
        if isinstance(label_w, QLabel):
            parts.extend((label_w.text(), label_w.toolTip()))
        if field_w is not None:
            parts.append(field_w.toolTip())
        return _RowEntry(
            root_index=root_index,
            subtab_widget=subtab_widget,
            subtab_index=subtab_index,
            form_layout=form,
            row=row,
            is_spanning=label_w is None,
            text=" ".join(p for p in parts if p).lower(),
        )

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
        total = 0
        stale = False
        for entry in self._entries:
            try:
                match = (not entry.is_spanning) and query in entry.text
                entry.form_layout.setRowVisible(entry.row, match)
            except RuntimeError:
                stale = True
                continue
            if match:
                total += 1
                root_counts[entry.root_index] = root_counts.get(entry.root_index, 0) + 1
                if entry.subtab_widget is not None:
                    key = (id(entry.subtab_widget), entry.subtab_index)
                    subtab_counts[key] = subtab_counts.get(key, 0) + 1

        if stale:
            # Index pointed at deleted widgets; rebuild and retry once.
            self.build_index()
            self.apply(raw_query)
            return

        self._update_tab_labels(root_counts, subtab_counts)
        self._set_count_label(total)
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
