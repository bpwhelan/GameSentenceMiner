from __future__ import annotations

import os
from contextlib import contextmanager
from types import SimpleNamespace

from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from GameSentenceMiner.ui.config.search import ConfigSearchController

_I18N = {
    "search": {
        "match": "1 match",
        "matches": "{count} matches",
        "no_results": "No settings match your search.",
    }
}


def _form_tab(*rows):
    widget = QWidget()
    layout = QFormLayout(widget)
    for text, tooltip in rows:
        label = QLabel(text)
        label.setToolTip(tooltip)
        layout.addRow(label, QLineEdit())
    return widget


@contextmanager
def _search_fixture():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    root = QTabWidget()
    root.addTab(_form_tab(("Furigana", "Show readings"), ("Volume", "Audio level")), "General")
    subtabs = QTabWidget()
    subtabs.addTab(_form_tab(("Furigana Color", "Color of readings")), "Reading")
    subtabs.addTab(_form_tab(("Hotkey", "Keyboard shortcut")), "Keys")
    root.addTab(subtabs, "Overlay")
    count_label = QLabel()
    window = SimpleNamespace(tab_widget=root, i18n=_I18N)
    controller = ConfigSearchController(window, count_label)
    try:
        yield controller, root, subtabs, count_label
    finally:
        root.close()
        app.processEvents()


def test_apply_filters_rows_and_counts_across_tabs():
    with _search_fixture() as (ctrl, root, subtabs, count_label):
        ctrl.apply("furigana")

        general = root.widget(0).layout()
        assert general.isRowVisible(0)  # Furigana
        assert not general.isRowVisible(1)  # Volume

        assert "(1)" in root.tabText(0)
        assert "(1)" in root.tabText(1)  # one match inside the Overlay subtabs
        assert "(1)" in subtabs.tabText(0)  # Reading
        assert not subtabs.isTabEnabled(1)  # Keys has no match
        assert count_label.text() == "2 matches"


def test_tooltip_only_match():
    with _search_fixture() as (ctrl, root, _subtabs, count_label):
        ctrl.apply("level")  # only present in the Volume tooltip, not its label
        general = root.widget(0).layout()
        assert general.isRowVisible(1)
        assert count_label.text() == "1 match"


def test_no_results():
    with _search_fixture() as (ctrl, _root, _subtabs, count_label):
        ctrl.apply("zzzznotfound")
        assert count_label.text() == "No settings match your search."


def test_clear_restores_rows_and_titles():
    with _search_fixture() as (ctrl, root, subtabs, count_label):
        ctrl.apply("furigana")
        ctrl.clear()

        general = root.widget(0).layout()
        assert general.isRowVisible(0)
        assert general.isRowVisible(1)
        assert root.tabText(0) == "General"
        assert root.tabText(1) == "Overlay"
        assert subtabs.isTabEnabled(1)
        assert count_label.text() == ""


def test_results_panel_lists_matches_in_one_page():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    shell = QWidget()
    main_layout = QVBoxLayout(shell)
    root = QTabWidget()
    root.addTab(_form_tab(("Furigana", "Show readings"), ("Volume", "Audio level")), "General")
    subtabs = QTabWidget()
    subtabs.addTab(_form_tab(("Furigana Color", "Color of readings")), "Reading")
    root.addTab(subtabs, "Overlay")
    main_layout.addWidget(root)
    count_label = QLabel()
    window = SimpleNamespace(tab_widget=root, main_layout=main_layout, i18n=_I18N)
    controller = ConfigSearchController(window, count_label)

    try:
        shell.show()
        app.processEvents()
        controller.apply("furigana")

        assert root.isHidden()
        assert controller._results_area is not None
        assert not controller._results_area.isHidden()
        result_text = "\n".join(label.text() for label in controller._results_area.findChildren(QLabel))
        assert "Furigana" in result_text
        assert "Furigana Color" in result_text
        assert count_label.text() == "2 matches"

        controller.clear()
        assert not root.isHidden()
    finally:
        shell.close()
        app.processEvents()


def test_nested_group_stays_visible_when_child_row_matches():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    root = QTabWidget()
    page = QWidget()
    layout = QFormLayout(page)
    process_group = QGroupBox("Game Pausing")
    process_layout = QFormLayout(process_group)
    process_layout.addRow(QLabel("Overlay Requests Pause"), QCheckBox())
    process_layout.addRow(QLabel("Auto Resume Seconds"), QLineEdit())
    layout.addRow(process_group)
    root.addTab(page, "Advanced")
    count_label = QLabel()
    window = SimpleNamespace(tab_widget=root, i18n=_I18N)
    controller = ConfigSearchController(window, count_label)

    try:
        controller.apply("pause")

        assert layout.isRowVisible(0)
        assert process_layout.isRowVisible(0)
        assert not process_layout.isRowVisible(1)
        assert count_label.text() == "1 match"
    finally:
        root.close()
        app.processEvents()


def test_field_container_text_is_searchable():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    root = QTabWidget()
    page = QWidget()
    layout = QFormLayout(page)
    field_container = QWidget()
    field_layout = QHBoxLayout(field_container)
    field_layout.setContentsMargins(0, 0, 0, 0)
    field_layout.addWidget(QLineEdit())
    field_layout.addWidget(QCheckBox("Relay outputs while paused"))
    layout.addRow(QLabel("Text Intake Hotkey"), field_container)
    root.addTab(page, "Hotkeys")
    count_label = QLabel()
    window = SimpleNamespace(tab_widget=root, i18n=_I18N)
    controller = ConfigSearchController(window, count_label)

    try:
        controller.apply("relay")

        assert layout.isRowVisible(0)
        assert count_label.text() == "1 match"
    finally:
        root.close()
        app.processEvents()
