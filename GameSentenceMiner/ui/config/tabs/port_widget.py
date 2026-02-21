from __future__ import annotations

from PyQt6.QtCore import QUrl
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLineEdit,
    QPushButton,
    QToolButton,
    QWidget,
)

_DEFAULT_PORT = 7275


def _get_port(line_edit: QLineEdit) -> int:
    try:
        return int(line_edit.text() or _DEFAULT_PORT)
    except Exception:
        return _DEFAULT_PORT


def _make_tooltip(port: int) -> str:
    return (
        f"Routes hosted on port {port}:\n"
        f"\n"
        f"  http://127.0.0.1:{port}/             Texthooker / multimine page\n"
        f"  http://127.0.0.1:{port}/texthooker   Texthooker (alias)\n"
        f"  http://127.0.0.1:{port}/stats         Reading statistics dashboard\n"
        f"  http://127.0.0.1:{port}/database      Sentence database browser\n"
        f"\n"
        f"WebSocket endpoints:\n"
        f"  ws://127.0.0.1:{port}/ws/texthooker   Text input (texthooker UI & tools)\n"
        f"  ws://127.0.0.1:{port}/ws/overlay       GSM Overlay\n"
        f"  ws://127.0.0.1:{port}/ws/plaintext     Plaintext output (JL / clipboard tools)"
    )


def make_port_controls(line_edit: QLineEdit) -> QWidget:
    """
    Wraps *line_edit* with:
      - a ? button whose tooltip shows all routes on the current port (updates live)
      - an "Open Texthooker" button
      - an "Open Stats" button
      - a "WS to Clipboard" button (copies ws://127.0.0.1:{port}/ws/texthooker)
    """
    container = QWidget()
    h = QHBoxLayout(container)
    h.setContentsMargins(0, 0, 0, 0)
    h.setSpacing(4)
    h.addWidget(line_edit)

    # ? help button – tooltip adapts to the current port value
    help_btn = QToolButton()
    help_btn.setText("?")
    help_btn.setToolTip(_make_tooltip(_get_port(line_edit)))

    def _refresh_tooltip() -> None:
        help_btn.setToolTip(_make_tooltip(_get_port(line_edit)))

    line_edit.textChanged.connect(_refresh_tooltip)
    h.addWidget(help_btn)

    # Open Texthooker
    texthooker_btn = QPushButton("Open Texthooker")
    texthooker_btn.setToolTip("Open the texthooker page in your browser")
    texthooker_btn.clicked.connect(
        lambda: QDesktopServices.openUrl(QUrl(f"http://127.0.0.1:{_get_port(line_edit)}/"))
    )
    h.addWidget(texthooker_btn)

    # Open Stats
    stats_btn = QPushButton("Open Stats")
    stats_btn.setToolTip("Open the reading statistics page in your browser")
    stats_btn.clicked.connect(
        lambda: QDesktopServices.openUrl(QUrl(f"http://127.0.0.1:{_get_port(line_edit)}/stats"))
    )
    h.addWidget(stats_btn)

    # WS URL to clipboard
    ws_btn = QPushButton("Copy WS URL")
    ws_btn.setToolTip("Copy ws://127.0.0.1:{port} to clipboard")
    ws_btn.clicked.connect(
        lambda: QApplication.clipboard().setText(
            f"ws://127.0.0.1:{_get_port(line_edit)}"
        )
    )
    h.addWidget(ws_btn)

    return container
