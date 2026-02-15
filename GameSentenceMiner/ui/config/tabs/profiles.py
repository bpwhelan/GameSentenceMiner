from __future__ import annotations

from PyQt6.QtWidgets import QAbstractItemView, QFormLayout, QHBoxLayout, QPushButton, QWidget
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_profiles_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(window._create_labeled_widget(tabs_i18n, "profiles", "select_profile"), window.profile_combo)

    button_widget = QWidget()
    button_layout = QHBoxLayout(button_widget)
    button_layout.setContentsMargins(0, 0, 0, 0)
    add_button = QPushButton(tabs_i18n.get("profiles", {}).get("add_button", "Add"))
    add_button.clicked.connect(window.add_profile)
    copy_button = QPushButton(tabs_i18n.get("profiles", {}).get("copy_button", "Copy"))
    copy_button.clicked.connect(window.copy_profile)
    window.delete_profile_button = QPushButton(tabs_i18n.get("profiles", {}).get("delete_button", "Delete"))
    window.delete_profile_button.clicked.connect(window.delete_profile)
    button_layout.addWidget(add_button)
    button_layout.addWidget(copy_button)
    button_layout.addWidget(window.delete_profile_button)
    button_layout.addStretch()
    layout.addRow(button_widget)

    scene_container = QWidget()
    scene_container.setStyleSheet(
        """
            QWidget {
                border: 1px solid #333;
                border-radius: 6px;
                padding: 6px;
            }
        """
    )
    scene_layout = QHBoxLayout(scene_container)
    scene_layout.setContentsMargins(6, 6, 6, 6)
    scene_layout.setSpacing(8)
    window.obs_scene_list.setSelectionMode(QAbstractItemView.SelectionMode.MultiSelection)
    scene_layout.addWidget(window.obs_scene_list)
    refresh_button = QPushButton(tabs_i18n.get("profiles", {}).get("refresh_scenes_button", "Refresh"))
    refresh_button.clicked.connect(window.refresh_obs_scenes)
    scene_layout.addWidget(refresh_button)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "profiles", "obs_scene"), scene_container)

    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "profiles", "switch_to_default"),
        window.switch_to_default_if_not_found_check,
    )

    return widget
