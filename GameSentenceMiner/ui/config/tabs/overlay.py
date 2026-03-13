from __future__ import annotations

from PyQt6.QtWidgets import (
    QCheckBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)
from typing import TYPE_CHECKING

from GameSentenceMiner.util.docs import DOCS_URLS

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


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
    widget = QWidget()
    root_layout = QVBoxLayout(widget)
    tabs_i18n = i18n.get("tabs", {})

    docs_form = QFormLayout()
    docs_form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    docs_form.addRow(
        "Documentation:",
        window._create_docs_links_widget([("Overlay Guide", DOCS_URLS["overlay"])]),
    )
    settings_hub_notice = QLabel(
        "Desktop app settings live in the Electron Settings hub. "
        "Use that hub to find overlay-local settings, startup behavior, and other non-profile options."
    )
    settings_hub_notice.setWordWrap(True)
    settings_hub_notice.setStyleSheet("color: #9fb7d9;")
    docs_form.addRow("Open Other Settings:", settings_hub_notice)
    root_layout.addLayout(docs_form)

    subtabs = QTabWidget()

    main_tab = QWidget()
    main_layout = QFormLayout(main_tab)
    main_layout.setFieldGrowthPolicy(
        QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow
    )

    main_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "overlay", "overlay_monitor"),
        window.overlay_monitor_combo,
    )
    main_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "overlay", "overlay_engine"),
        window.overlay_engine_combo,
    )
    main_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n, "overlay", "manual_overlay_scan_hotkey"
        ),
        window.manual_overlay_scan_hotkey_edit,
    )

    min_char_widget = QWidget()
    min_char_layout = QHBoxLayout(min_char_widget)
    min_char_layout.setContentsMargins(0, 0, 0, 0)
    min_char_layout.addWidget(window.overlay_minimum_character_size_edit)
    find_size_button = QPushButton(
        tabs_i18n.get("overlay", {}).get(
            "minimum_character_size_finder_button", "Find Size"
        )
    )
    find_size_button.clicked.connect(window.open_minimum_character_size_selector)
    min_char_layout.addWidget(find_size_button)
    main_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "overlay", "minimum_character_size"),
        min_char_widget,
    )
    main_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "overlay", "use_ocr_area_config"),
        window.use_ocr_area_config_check,
    )
    main_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "overlay", "use_ocr_result"),
        window.use_ocr_result_check,
    )

    open_overlay_settings_button = QPushButton(
        tabs_i18n.get("overlay", {}).get(
            "open_connected_overlay_settings_button", "Open Main Overlay Settings"
        )
    )
    open_overlay_settings_button.setToolTip(
        tabs_i18n.get("overlay", {}).get(
            "open_connected_overlay_settings_tooltip",
            "Open the Electron overlay settings window through the connected /ws/overlay session.",
        )
    )
    open_overlay_settings_button.clicked.connect(
        lambda: _open_connected_overlay_settings(window)
    )
    main_layout.addRow(open_overlay_settings_button)

    legacy_tab = QWidget()
    legacy_layout = QFormLayout(legacy_tab)
    legacy_layout.setFieldGrowthPolicy(
        QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow
    )
    legacy_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "overlay", "periodic"),
        window.periodic_check,
    )
    legacy_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "overlay", "periodic_interval"),
        window.periodic_interval_edit,
    )
    legacy_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "overlay", "periodic_ratio"),
        window.periodic_ratio_edit,
    )

    old_capture_label = tabs_i18n.get("overlay", {}).get(
        "ocr_full_screen_instead_of_obs", "Use old overlay capture method"
    )
    old_capture_tooltip = tabs_i18n.get("overlay", {}).get(
        "ocr_full_screen_instead_of_obs_tooltip",
        "Use old overlay capture method instead of OBS. Legacy/debug only.",
    )
    window.ocr_full_screen_instead_of_obs_checkbox = QCheckBox(old_capture_label)
    window.ocr_full_screen_instead_of_obs_checkbox.setToolTip(old_capture_tooltip)
    window.ocr_full_screen_instead_of_obs_checkbox.setStyleSheet("color: #FF0000;")
    legacy_layout.addRow(window.ocr_full_screen_instead_of_obs_checkbox)

    subtabs.addTab(main_tab, "Main")
    subtabs.addTab(legacy_tab, "Legacy")
    root_layout.addWidget(subtabs)

    reset_widget = window._create_reset_button("overlay", window._create_overlay_tab)
    root_layout.addWidget(reset_widget)
    return widget
