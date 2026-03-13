from __future__ import annotations

from PyQt6.QtWidgets import QFileDialog, QLabel, QFormLayout, QLineEdit, QWidget
from typing import TYPE_CHECKING

from ..labels import LabelColor

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_obs_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "obs", "open_obs"),
        window.obs_open_obs_check,
    )
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "obs", "close_obs"),
        window.obs_close_obs_check,
    )
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "obs", "obs_path"),
        window._create_browse_widget(
            window.obs_path_edit, QFileDialog.FileMode.ExistingFile
        ),
    )

    connection_group = window._create_group_box("OBS WebSocket Connection")
    connection_layout = QFormLayout()
    connection_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "obs", "host"), window.obs_host_edit
    )
    connection_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "obs", "port"), window.obs_port_edit
    )
    connection_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "obs", "password"),
        window.obs_password_edit,
    )
    connection_group.setLayout(connection_layout)
    layout.addRow(connection_group)

    window.obs_password_edit.setEchoMode(QLineEdit.EchoMode.Password)
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n, "obs", "disable_recording", color=LabelColor.ADVANCED, bold=True
        ),
        window.obs_disable_recording_check,
    )
    disable_recording_warning = QLabel(
        "WARNING: Enabling this will fully disable OBS Replay Buffer and OBS Recording in GSM.\n"
        "Anything Anki-related that depends on OBS capture (audio recording, screenshots, replay/video clips) will NOT work.\n"
        "It will also make Beangate very sad."
    )
    disable_recording_warning.setWordWrap(True)
    disable_recording_warning.setStyleSheet(
        "color: #f8d7da; background-color: rgba(220, 53, 69, 0.18); border: 1px solid #f5c2c7; padding: 10px; border-radius: 4px; font-weight: 600;"
    )
    layout.addRow(disable_recording_warning)

    fps_guidelines = QLabel(
        "Recording FPS guidelines:\n"
        "- Default: 15 FPS\n"
        "- Under 10 FPS: experimental\n"
        "- Over 30 FPS: usually wasteful unless you also record gameplay/content"
    )
    fps_guidelines.setWordWrap(True)
    fps_guidelines.setStyleSheet(
        "color: #8ecae6; background-color: rgba(142, 202, 230, 0.14); border: 1px solid #8ecae6; padding: 8px; border-radius: 4px;"
    )
    layout.addRow(fps_guidelines)

    layout.addRow(
        QLabel("Recording FPS (OBS Video Settings)"), window.obs_recording_fps_spin
    )
    # layout.addRow(QLabel("Disable Desktop Audio On Connect"), window.obs_disable_desktop_audio_on_connect_check)
    window.obs_recording_fps_warning_label.setWordWrap(True)
    layout.addRow(window.obs_recording_fps_warning_label)
    window._update_obs_recording_fps_warning()
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n, "obs", "auto_manage_replay_buffer", color=LabelColor.RECOMMENDED
        ),
        window.automatically_manage_replay_buffer_check,
    )

    layout.addRow(window._create_reset_button("obs", window._create_obs_tab))
    return widget
