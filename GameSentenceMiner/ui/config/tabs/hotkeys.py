from __future__ import annotations

from PyQt6.QtWidgets import QFormLayout, QHBoxLayout, QLabel, QVBoxLayout, QWidget
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def _build_group(window: "ConfigWindow", title: str, rows: list[tuple[QLabel, QWidget]]) -> QWidget:
    group = window._create_group_box(title)
    layout = QFormLayout(group)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    for label, field in rows:
        layout.addRow(label, field)
    return group


def build_hotkeys_tab(window: "ConfigWindow", i18n: dict) -> QWidget:
    widget = QWidget()
    root_layout = QVBoxLayout(widget)
    tabs_i18n = i18n.get("tabs", {})
    hotkeys_i18n = tabs_i18n.get("hotkeys", {})

    intro_label = QLabel(
        hotkeys_i18n.get(
            "description",
            "Centralized hotkeys for GSM. Leave a shortcut blank to disable it.",
        )
    )
    intro_label.setWordWrap(True)
    intro_label.setStyleSheet("color: #9fb7d9;")
    root_layout.addWidget(intro_label)

    intake_widget = QWidget()
    intake_layout = QHBoxLayout(intake_widget)
    intake_layout.setContentsMargins(0, 0, 0, 0)
    intake_layout.setSpacing(10)
    intake_layout.addWidget(window.pause_text_intake_hotkey_edit)

    relay_text = hotkeys_i18n.get("relay_outputs_when_paused", {}).get(
        "checkbox",
        "Relay to texthooker/output clients while paused",
    )
    relay_tooltip = hotkeys_i18n.get("relay_outputs_when_paused", {}).get(
        "tooltip",
        "Keep texthooker and output websocket clients updated while GSM intake is paused.",
    )
    window.relay_outputs_when_text_intake_paused_check.setText(relay_text)
    window.relay_outputs_when_text_intake_paused_check.setToolTip(relay_tooltip)
    intake_layout.addWidget(window.relay_outputs_when_text_intake_paused_check)
    intake_layout.addStretch(1)

    root_layout.addWidget(
        _build_group(
            window,
            hotkeys_i18n.get("groups", {}).get("input", "Input"),
            [
                (
                    window._create_labeled_widget(tabs_i18n, "hotkeys", "pause_text_intake"),
                    intake_widget,
                )
            ],
        )
    )

    root_layout.addWidget(
        _build_group(
            window,
            hotkeys_i18n.get("groups", {}).get("overlay", "Overlay"),
            [
                (
                    window._create_labeled_widget(tabs_i18n, "overlay", "manual_overlay_scan_hotkey"),
                    window.manual_overlay_scan_hotkey_edit,
                )
            ],
        )
    )

    root_layout.addWidget(
        _build_group(
            window,
            hotkeys_i18n.get("groups", {}).get("audio", "Audio"),
            [
                (
                    window._create_labeled_widget(tabs_i18n, "advanced", "play_latest_hotkey"),
                    window.play_latest_audio_hotkey_edit,
                )
            ],
        )
    )

    root_layout.addWidget(
        _build_group(
            window,
            hotkeys_i18n.get("groups", {}).get("experimental", "Experimental"),
            [
                (
                    window._create_labeled_widget(tabs_i18n, "game_pausing", "hotkey"),
                    window.process_pause_hotkey_edit,
                )
            ],
        )
    )

    root_layout.addWidget(window._create_reset_button("hotkeys", window._create_hotkeys_tab))
    return widget
