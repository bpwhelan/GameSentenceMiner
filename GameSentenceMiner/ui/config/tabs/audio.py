from __future__ import annotations

from PyQt6.QtWidgets import QFormLayout, QHBoxLayout, QPushButton, QWidget
from typing import TYPE_CHECKING

from ..labels import LabelColor

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_audio_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(window._create_labeled_widget(tabs_i18n, "audio", "enabled"), window.audio_enabled_check)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "audio", "extension"), window.audio_extension_combo)

    offset_widget = QWidget()
    offset_layout = QHBoxLayout(offset_widget)
    offset_layout.setContentsMargins(0, 0, 0, 0)
    offset_layout.addWidget(window.beginning_offset_edit)
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "audio", "beginning_offset", color=LabelColor.IMPORTANT, bold=True),
        offset_widget,
    )

    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "audio", "end_offset", color=LabelColor.IMPORTANT, bold=True),
        window.pre_vad_audio_offset_edit,
    )
    layout.addRow(window._create_labeled_widget(tabs_i18n, "audio", "ffmpeg_preset"), window.ffmpeg_audio_preset_combo)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "audio", "ffmpeg_options"), window.audio_ffmpeg_reencode_options_edit)
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "audio", "anki_media_collection"), window.anki_media_collection_edit
    )

    ext_tool_widget = QWidget()
    ext_tool_layout = QHBoxLayout(ext_tool_widget)
    ext_tool_layout.setContentsMargins(0, 0, 0, 0)
    ext_tool_layout.addWidget(window.external_tool_edit)
    ext_tool_layout.addWidget(window.external_tool_enabled_check)
    ext_tool_layout.addWidget(window._create_labeled_widget(tabs_i18n, "audio", "external_tool_enabled"))
    ext_tool_layout.addStretch()
    layout.addRow(window._create_labeled_widget(tabs_i18n, "audio", "external_tool"), ext_tool_widget)

    button_widget = QWidget()
    button_layout = QHBoxLayout(button_widget)
    button_layout.setContentsMargins(0, 0, 0, 0)
    install_ocen_button = QPushButton(tabs_i18n.get("audio", {}).get("install_ocenaudio_button", "Install Ocenaudio"))
    install_ocen_button.clicked.connect(window.download_and_install_ocen)
    button_layout.addWidget(install_ocen_button)
    button_layout.addStretch()
    layout.addRow(button_widget)

    layout.addRow(window._create_reset_button("audio", window._create_audio_tab))
    return widget
