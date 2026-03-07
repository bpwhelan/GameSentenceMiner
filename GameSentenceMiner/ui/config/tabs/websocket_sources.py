"""Reusable WebSocket Sources Editor widget for the config GUI."""
from __future__ import annotations

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import (
    QCheckBox,
    QHBoxLayout,
    QHeaderView,
    QPushButton,
    QSizePolicy,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)
from typing import List

from GameSentenceMiner.util.config.configuration import (
    DEFAULT_WEBSOCKET_SOURCES,
    WebsocketInputSource,
)


class WebsocketSourcesEditor(QWidget):
    """A compact table editor for named websocket input sources."""

    sources_changed = pyqtSignal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._building = False
        self._init_ui()

    # ---- UI setup ----
    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

        # Table: [Enabled] [Name] [URI]
        self.table = QTableWidget(0, 3)
        self.table.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.table.setHorizontalHeaderLabels(["On", "Name", "URI"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Interactive)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.table.setColumnWidth(0, 36)
        self.table.setColumnWidth(1, 140)
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.table.setFixedHeight(200)
        self.table.setStyleSheet("""
            QTableWidget {
                border: 1px solid #333;
                border-radius: 4px;
                gridline-color: #2a2a2a;
            }
            QHeaderView::section {
                background-color: #1e1e1e;
                color: #ccc;
                border: none;
                padding: 4px;
                font-size: 11px;
            }
        """)
        layout.addWidget(self.table)

        # Buttons row
        btn_layout = QHBoxLayout()
        btn_layout.setContentsMargins(0, 2, 0, 0)
        self.add_btn = QPushButton("+ Add Source")
        self.add_btn.setFixedWidth(100)
        self.add_btn.clicked.connect(self._on_add)
        self.remove_btn = QPushButton("− Remove")
        self.remove_btn.setFixedWidth(90)
        self.remove_btn.clicked.connect(self._on_remove)
        self.reset_btn = QPushButton("Reset Defaults")
        self.reset_btn.setFixedWidth(110)
        self.reset_btn.clicked.connect(self._on_reset)
        btn_layout.addWidget(self.add_btn)
        btn_layout.addWidget(self.remove_btn)
        btn_layout.addWidget(self.reset_btn)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)
        self.setFixedHeight(240)

    # ---- Data <-> UI ----
    def set_sources(self, sources: List[WebsocketInputSource]) -> None:
        """Populate the table from a list of sources."""
        self._building = True
        self.table.setRowCount(0)
        for src in sources:
            self._append_row(src)
        self._building = False

    def get_sources(self) -> List[WebsocketInputSource]:
        """Read the current table state back into source objects."""
        sources: List[WebsocketInputSource] = []
        for row in range(self.table.rowCount()):
            enabled_widget = self.table.cellWidget(row, 0)
            enabled = enabled_widget.isChecked() if isinstance(enabled_widget, QCheckBox) else True
            name_item = self.table.item(row, 1)
            uri_item = self.table.item(row, 2)
            name = name_item.text().strip() if name_item else ""
            uri = uri_item.text().strip() if uri_item else ""
            if uri:  # skip completely empty rows
                sources.append(WebsocketInputSource(name=name, uri=uri, enabled=enabled))
        return sources

    # ---- Slots ----
    def _on_add(self) -> None:
        self._append_row(WebsocketInputSource(name="", uri="localhost:", enabled=True))
        # Select and start editing the new row's name cell
        new_row = self.table.rowCount() - 1
        self.table.setCurrentCell(new_row, 1)
        self.table.editItem(self.table.item(new_row, 1))
        self._emit_changed()

    def _on_remove(self) -> None:
        row = self.table.currentRow()
        if row >= 0:
            self.table.removeRow(row)
            self._emit_changed()

    def _on_reset(self) -> None:
        self.set_sources([WebsocketInputSource(**s) for s in DEFAULT_WEBSOCKET_SOURCES])
        self._emit_changed()

    # ---- Helpers ----
    def _append_row(self, source: WebsocketInputSource) -> None:
        row = self.table.rowCount()
        self.table.insertRow(row)

        # Column 0: enabled checkbox
        cb = QCheckBox()
        cb.setChecked(source.enabled)
        cb.stateChanged.connect(lambda _: self._emit_changed())
        self.table.setCellWidget(row, 0, cb)

        # Column 1: name
        name_item = QTableWidgetItem(source.name)
        self.table.setItem(row, 1, name_item)

        # Column 2: uri
        uri_item = QTableWidgetItem(source.uri)
        self.table.setItem(row, 2, uri_item)

        # Connect cell-change signal for autosave
        if not self._building:
            self.table.cellChanged.connect(self._on_cell_changed)

    def _on_cell_changed(self, row: int, col: int) -> None:
        if not self._building:
            self._emit_changed()

    def _emit_changed(self) -> None:
        if not self._building:
            self.sources_changed.emit()
