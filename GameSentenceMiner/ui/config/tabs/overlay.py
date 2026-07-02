from __future__ import annotations

from PyQt6.QtWidgets import (
    QFormLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)
from typing import TYPE_CHECKING

from GameSentenceMiner.ui.config.safety import safe_config_call, safe_config_callback
from GameSentenceMiner.util.docs import DOCS_URLS

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


@safe_config_call(name="overlay.open_connected_overlay_settings")
def _open_connected_overlay_settings(window: "ConfigWindow") -> None:
    from GameSentenceMiner.web.gsm_websocket import request_overlay_settings_open

    if request_overlay_settings_open():
        return

    QMessageBox.information(
        window,
        "Overlay Not Connected",
        "The main overlay is not connected to /ws/overlay right now.",
    )


def build_overlay_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    # OCR/capture and other overlay settings are now edited in the overlay's own
    # settings window (the single home for them); this tab just links there.
    widget = QWidget()
    root_layout = QVBoxLayout(widget)
    tabs_i18n = i18n.get("tabs", {})

    docs_form = QFormLayout()
    docs_form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    docs_form.addRow(
        "Documentation:",
        window._create_docs_links_widget([("Overlay Guide", DOCS_URLS["overlay"])]),
    )
    root_layout.addLayout(docs_form)

    notice = QLabel(
        "OCR / capture and other overlay settings now live in the overlay's own settings "
        "window (Capture tab), which edits them directly for your active GSM profile. "
        "Open it below to change the OCR engine, monitor, capture areas, periodic scanning, "
        "and OCR-result options."
    )
    notice.setWordWrap(True)
    notice.setStyleSheet("color: #9fb7d9;")
    root_layout.addWidget(notice)

    open_overlay_settings_button = QPushButton(
        tabs_i18n.get("overlay", {}).get("open_connected_overlay_settings_button", "Open Main Overlay Settings")
    )
    open_overlay_settings_button.setToolTip(
        tabs_i18n.get("overlay", {}).get(
            "open_connected_overlay_settings_tooltip",
            "Open the Electron overlay settings window through the connected /ws/overlay session.",
        )
    )
    open_overlay_settings_button.clicked.connect(
        safe_config_callback(
            lambda: _open_connected_overlay_settings(window),
            name="overlay.open_connected_overlay_settings_button",
        )
    )
    root_layout.addWidget(open_overlay_settings_button)
    root_layout.addStretch(1)
    return widget
