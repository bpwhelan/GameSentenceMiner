from __future__ import annotations

from PyQt6.QtWidgets import QFileDialog, QFormLayout, QHBoxLayout, QWidget
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_paths_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "paths", "folder_to_watch"),
        window._create_browse_widget(window.folder_to_watch_edit, QFileDialog.FileMode.Directory),
    )

    output_folder_widget = QWidget()
    output_folder_layout = QHBoxLayout(output_folder_widget)
    output_folder_layout.setContentsMargins(0, 0, 0, 0)
    output_folder_layout.addWidget(window.output_folder_edit)
    output_folder_layout.addWidget(
        window._create_browse_button(window.output_folder_edit, QFileDialog.FileMode.Directory)
    )
    output_folder_layout.addWidget(window.copy_temp_files_to_output_folder_check)
    output_folder_layout.addWidget(
        window._create_labeled_widget(tabs_i18n, "paths", "copy_temp_files_to_output_folder")
    )
    output_folder_layout.addStretch()
    layout.addRow(window._create_labeled_widget(tabs_i18n, "paths", "output_folder"), output_folder_widget)

    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "paths", "copy_trimmed_replay_to_output_folder"),
        window.copy_trimmed_replay_to_output_folder_check,
    )
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "paths", "open_output_folder_on_card_creation"),
        window.open_output_folder_on_card_creation_check,
    )
    layout.addRow(window._create_labeled_widget(tabs_i18n, "paths", "remove_video"), window.remove_video_check)

    reset_widget = window._create_reset_button("paths", window._create_paths_tab)
    layout.addRow(reset_widget)
    return widget
