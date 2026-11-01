"""Compact styling shared by the Python settings and card review windows.

Applied to individual windows so capture overlays and other Qt tools retain
their own appearance. Native theme assets still supply icons and indicators.
"""

from PyQt6.QtGui import QColor, QPalette
from PyQt6.QtWidgets import QWidget

BACKGROUND = "#1c2027"
SURFACE = "#232831"
BORDER = "#363e4b"
TEXT = "#e4e9f0"
MUTED = "#a2adbd"
ACCENT = "#91b8e8"
SUCCESS = "#9bd0af"
WARNING_STYLE = (
    "color: #ebcd95; background-color: #383125; border: 1px solid #665336; border-radius: 5px; padding: 7px;"
)

COMPACT_STYLESHEET = """
QWidget { color: #e4e9f0; font-size: 12px; }
QWidget[compactWindow="true"] { background: #1c2027; }
QLabel { background: transparent; }
QLabel[role="muted"] { color: #a2adbd; }
QLabel[role="heading"] { font-size: 18px; font-weight: 600; }
QLabel[role="expression"] { font-size: 21px; font-weight: 600; }
QFrame[role="panel"] {
    background: #232831; border: 1px solid #363e4b; border-radius: 7px;
}
QWidget[role="footer"] { border-top: 1px solid #363e4b; }
QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox, QKeySequenceEdit, QTextEdit, QPlainTextEdit {
    background: #191e25; color: #e4e9f0; border: 1px solid #424c5b;
    border-radius: 4px; padding: 5px 7px; selection-background-color: #3b587b;
}
QLineEdit:hover, QComboBox:hover, QSpinBox:hover, QDoubleSpinBox:hover, QKeySequenceEdit:hover {
    border-color: #637188;
}
QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox, QKeySequenceEdit { min-height: 16px; padding: 4px 7px; }
QLineEdit:focus, QComboBox:focus, QSpinBox:focus, QDoubleSpinBox:focus,
QKeySequenceEdit:focus, QTextEdit:focus, QPlainTextEdit:focus { border-color: #91b8e8; }
QComboBox { padding-right: 24px; }
QComboBox QAbstractItemView { background: #232831; selection-background-color: #35465e; }
QPushButton {
    background: #2a313c; color: #dce5f2; border: 1px solid #485467;
    border-radius: 4px; padding: 5px 10px; min-height: 16px;
}
QPushButton:hover { background: #354154; border-color: #91b8e8; }
QPushButton:pressed, QPushButton:checked { background: #3b506c; border-color: #91b8e8; }
QPushButton:focus { border-color: #b8d6ff; }
QPushButton[role="primary"] {
    background: #91b8e8; color: #152339; border-color: #91b8e8;
    font-weight: 600; padding: 7px 20px;
}
QPushButton[role="primary"]:hover { background: #b2d1f5; border-color: #b2d1f5; }
QPushButton[role="primary"]:pressed { background: #79a4db; }
QPushButton:disabled, QLineEdit:disabled, QComboBox:disabled {
    color: #778394; background: #252b34; border-color: #363e4b;
}
QCheckBox { spacing: 7px; background: transparent; }
QCheckBox:disabled { color: #778394; }
QGroupBox {
    background: #232831; border: 1px solid #363e4b; border-radius: 6px;
    margin-top: 12px; padding: 12px 6px 6px 6px; font-weight: 600;
}
QGroupBox::title {
    subcontrol-origin: margin; subcontrol-position: top left;
    left: 10px; padding: 0 5px; color: #c9d7e9;
}
QScrollArea { background: transparent; border: none; }
QScrollArea > QWidget > QWidget { background: #1c2027; }
QScrollBar:vertical { background: transparent; width: 8px; margin: 0; }
QScrollBar::handle:vertical { background: #485467; border-radius: 4px; min-height: 28px; }
QScrollBar::handle:vertical:hover { background: #687c98; }
QScrollBar:horizontal { background: transparent; height: 8px; margin: 0; }
QScrollBar::handle:horizontal { background: #485467; border-radius: 4px; min-width: 28px; }
QScrollBar::add-line, QScrollBar::sub-line { width: 0; height: 0; }
QScrollBar::add-page, QScrollBar::sub-page { background: transparent; }
QAbstractItemView {
    background: #191e25; alternate-background-color: #232831; border: 1px solid #424c5b;
    border-radius: 4px; selection-background-color: #35465e; selection-color: #e4e9f0;
}
QTableWidget { gridline-color: #363e4b; }
QHeaderView::section { background: #2a313c; color: #b9c6d7; border: none; padding: 6px; }
QToolTip { color: #e4e9f0; background: #2a313c; border: 1px solid #637188; }
"""


def apply_compact_theme(window: QWidget) -> None:
    """Set a consistent palette for styled controls and custom-painted content."""
    palette = window.palette()
    for role, color in (
        (QPalette.ColorRole.Window, BACKGROUND),
        (QPalette.ColorRole.WindowText, TEXT),
        (QPalette.ColorRole.Base, "#191e25"),
        (QPalette.ColorRole.AlternateBase, SURFACE),
        (QPalette.ColorRole.Text, TEXT),
        (QPalette.ColorRole.Button, SURFACE),
        (QPalette.ColorRole.ButtonText, TEXT),
        (QPalette.ColorRole.Highlight, "#3b587b"),
        (QPalette.ColorRole.HighlightedText, TEXT),
        (QPalette.ColorRole.PlaceholderText, MUTED),
    ):
        palette.setColor(role, QColor(color))
    window.setPalette(palette)
    window.setProperty("compactWindow", True)
    window.setStyleSheet(COMPACT_STYLESHEET)
