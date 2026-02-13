from __future__ import annotations

from PyQt6.QtWidgets import QCheckBox, QFormLayout, QHBoxLayout, QLabel, QPushButton, QWidget
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_overlay_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(window._create_labeled_widget(tabs_i18n, "overlay", "websocket_port"), window.overlay_websocket_port_edit)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "overlay", "overlay_monitor"), window.overlay_monitor_combo)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "overlay", "overlay_engine"), window.overlay_engine_combo)
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "overlay", "manual_overlay_scan_hotkey"),
        window.manual_overlay_scan_hotkey_edit,
    )

    texthooker_widget = QWidget()
    texthooker_layout = QHBoxLayout(texthooker_widget)
    texthooker_layout.setContentsMargins(0, 0, 0, 0)
    texthooker_layout.addWidget(window.add_overlay_to_texthooker_check)
    texthooker_label = QLabel("Send Overlay Lines to Texthooker on Hotkey")
    texthooker_label.setStyleSheet("color: #FF0000; font-weight: bold;")
    texthooker_label.setToolTip(
        "WARNING: When you use the manual overlay scan hotkey, any new lines found will be sent to the texthooker stream. Only enable if you understand the implications."
    )
    texthooker_layout.addWidget(texthooker_label)
    texthooker_layout.addStretch()
    layout.addRow(texthooker_widget)

    periodic_group = window._create_group_box("Periodic Scanning")
    periodic_layout = QFormLayout()
    periodic_layout.addRow(window._create_labeled_widget(tabs_i18n, "overlay", "periodic"), window.periodic_check)
    periodic_layout.addRow(window._create_labeled_widget(tabs_i18n, "overlay", "periodic_interval"), window.periodic_interval_edit)
    periodic_layout.addRow(window._create_labeled_widget(tabs_i18n, "overlay", "periodic_ratio"), window.periodic_ratio_edit)
    periodic_group.setLayout(periodic_layout)
    layout.addRow(periodic_group)

    min_char_widget = QWidget()
    min_char_layout = QHBoxLayout(min_char_widget)
    min_char_layout.setContentsMargins(0, 0, 0, 0)
    min_char_layout.addWidget(window.overlay_minimum_character_size_edit)
    find_size_button = QPushButton(tabs_i18n.get("overlay", {}).get("minimum_character_size_finder_button", "Find Size"))
    find_size_button.clicked.connect(window.open_minimum_character_size_selector)
    min_char_layout.addWidget(find_size_button)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "overlay", "minimum_character_size"), min_char_widget)

    layout.addRow(window._create_labeled_widget(tabs_i18n, "overlay", "use_ocr_area_config"), window.use_ocr_area_config_check)

    reset_widget = window._create_reset_button("overlay", window._create_overlay_tab)
    layout.addRow(reset_widget)

    try:
        window.ocr_full_screen_instead_of_obs_checkbox = QCheckBox(
            window.i18n.get("overlay", {}).get("ocr_full_screen_instead_of_obs", "Use old overlay capture method (debug)")
        )
    except Exception:
        window.ocr_full_screen_instead_of_obs_checkbox = QCheckBox("Use old overlay capture method (debug)")
    window.ocr_full_screen_instead_of_obs_checkbox.setStyleSheet("color: #FF0000;")
    try:
        window.ocr_full_screen_instead_of_obs_checkbox.setToolTip(
            window.i18n.get("overlay", {}).get(
                "ocr_full_screen_instead_of_obs_tooltip", "Use old overlay capture method instead of OBS. Debug only."
            )
        )
    except Exception:
        pass
    layout.addRow(window.ocr_full_screen_instead_of_obs_checkbox)
    return widget
