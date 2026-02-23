from __future__ import annotations

from PyQt6.QtWidgets import QLabel, QFormLayout, QWidget
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_features_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(window._create_labeled_widget(tabs_i18n, "features", "open_anki_edit"), window.open_anki_edit_check)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "features", "open_anki_browser"), window.open_anki_browser_check)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "features", "browser_query"), window.browser_query_edit)
    layout.addRow(QLabel("Generate LongPlay"), window.generate_longplay_check)
    window.generate_longplay_check.setToolTip(
        "Generate a LongPlay video using OBS recording, and write to a .srt file with all the text coming into gsm. RESTART REQUIRED."
    )

    layout.addRow(window._create_reset_button("features", window._create_features_tab))
    return widget
