from __future__ import annotations

from typing import TYPE_CHECKING

from PyQt6.QtWidgets import QFormLayout, QLabel, QWidget

from GameSentenceMiner.util.config.configuration import is_windows
from GameSentenceMiner.util.docs import DOCS_URLS

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config.binding import BindingManager
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_features_tab(window: ConfigWindow, binder: BindingManager, i18n: dict) -> QWidget:
    """Build the general quality-of-life features page."""
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    convenience_group = window._create_group_box("Convenience")
    convenience_layout = QFormLayout(convenience_group)
    convenience_layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    convenience_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "features", "notify_on_update"),
        window.notify_on_update_check,
    )
    binder.bind(("profile", "features", "notify_on_update"), window.notify_on_update_check)
    if is_windows():
        convenience_layout.addRow(
            window._create_labeled_widget(tabs_i18n, "advanced", "mute_game_on_minimize"),
            window.mute_game_on_minimize_check,
        )
    layout.addRow(convenience_group)

    longplay_group = window._create_group_box("Longplay Recording")
    longplay_layout = QFormLayout(longplay_group)
    longplay_layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    longplay_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "features",
            "generate_longplay",
            default_tooltip=(
                "Generate a Longplay video from OBS recording and write incoming GSM text to an SRT file. "
                "Restart required."
            ),
        ),
        window.generate_longplay_check,
    )
    longplay_layout.addRow(
        QLabel("Documentation:"),
        window._create_docs_links_widget([("Longplay Guide", DOCS_URLS["longplay"])]),
    )
    layout.addRow(longplay_group)

    return widget
