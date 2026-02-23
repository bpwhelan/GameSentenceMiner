from __future__ import annotations

from PyQt6.QtWidgets import QFileDialog, QFormLayout, QHBoxLayout, QLabel, QWidget
from typing import TYPE_CHECKING

from ..labels import LabelColor

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_advanced_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    note_label = QLabel(tabs_i18n.get("advanced", {}).get("player_note", "..."))
    note_label.setStyleSheet("color: red;")
    layout.addRow(note_label)

    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "advanced", "audio_player_path"),
        window._create_browse_widget(window.audio_player_path_edit, QFileDialog.FileMode.ExistingFile),
    )
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "advanced", "video_player_path"),
        window._create_browse_widget(window.video_player_path_edit, QFileDialog.FileMode.ExistingFile),
    )
    layout.addRow(window._create_labeled_widget(tabs_i18n, "advanced", "play_latest_hotkey"), window.play_latest_audio_hotkey_edit)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "advanced", "multiline_storage_field"), window.multi_line_sentence_storage_field_edit)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "advanced", "ocr_port"), window.ocr_websocket_port_edit)
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "advanced", "texthooker_comm_port"),
        window.texthooker_communication_websocket_port_edit,
    )
    layout.addRow(window._create_labeled_widget(tabs_i18n, "advanced", "polling_rate"), window.polling_rate_edit)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "advanced", "localhost_bind_address"), window.localhost_bind_address_edit)
    layout.addRow(QLabel("Longest Sleep Time (s)"), window.longest_sleep_time_edit)

    dont_collect_stats_label = window._create_labeled_widget(tabs_i18n, "advanced", "dont_collect_stats", color=LabelColor.ADVANCED)
    dont_collect_stats_container = QHBoxLayout()
    dont_collect_stats_container.addWidget(window.dont_collect_stats_check)
    dont_collect_stats_warning = QLabel("Stats are ONLY local no matter what. Disabling may break features!")
    dont_collect_stats_warning.setStyleSheet("color: #FF6B6B; font-size: 10px;")
    dont_collect_stats_container.addWidget(dont_collect_stats_warning)
    dont_collect_stats_container.addStretch()
    layout.addRow(dont_collect_stats_label, dont_collect_stats_container)

    layout.addRow(window._create_labeled_widget(tabs_i18n, "advanced", "current_version"), window.current_version_label)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "advanced", "latest_version"), window.latest_version_label)

    reset_widget = window._create_reset_button("advanced", window._create_advanced_tab)
    layout.addRow(reset_widget)
    return widget
