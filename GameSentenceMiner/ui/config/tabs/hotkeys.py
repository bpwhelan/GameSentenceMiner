from __future__ import annotations

from typing import TYPE_CHECKING

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QMouseEvent
from PyQt6.QtWidgets import (
    QCheckBox,
    QFormLayout,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


class _CheckboxLabel(QLabel):
    def __init__(self, text: str, checkbox: QCheckBox) -> None:
        super().__init__(text)
        self._checkbox = checkbox
        self.setWordWrap(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def mousePressEvent(self, event: QMouseEvent | None) -> None:
        if event is not None and event.button() == Qt.MouseButton.LeftButton and self._checkbox.isEnabled():
            self._checkbox.toggle()
            event.accept()
            return
        super().mousePressEvent(event)


def _build_checkbox_row(checkbox: QCheckBox, text: str, tooltip: str) -> QWidget:
    checkbox.setText("")
    checkbox.setToolTip(tooltip)
    checkbox.setAccessibleName(text)

    label = _CheckboxLabel(text, checkbox)
    label.setToolTip(tooltip)

    widget = QWidget()
    layout = QHBoxLayout(widget)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.setSpacing(6)
    layout.addWidget(checkbox, 0, Qt.AlignmentFlag.AlignTop)
    layout.addWidget(label, 1)
    return widget


def _build_binding_group(
    window: "ConfigWindow",
    title: str,
    action_label: QLabel,
    keyboard_widget: QWidget,
    gamepad_widget: QWidget,
    hotkeys_i18n: dict,
    footer_widget: QWidget | None = None,
) -> QWidget:
    group = window._create_group_box(title)
    form = QFormLayout(group)
    form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
    form.setVerticalSpacing(6)

    bindings_widget = QWidget()
    layout = QGridLayout(bindings_widget)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.setHorizontalSpacing(10)
    layout.setVerticalSpacing(6)
    layout.setColumnStretch(0, 3)
    layout.setColumnStretch(1, 1)

    action_label.setWordWrap(True)

    keyboard_label = QLabel(hotkeys_i18n.get("keyboard_label", "Keyboard"))
    keyboard_widget.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
    layout.addWidget(keyboard_label, 0, 0)
    layout.addWidget(keyboard_widget, 1, 0)

    gamepad_label = QLabel(hotkeys_i18n.get("gamepad_label", "Gamepad"))
    gamepad_widget.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
    layout.addWidget(gamepad_label, 0, 1)
    layout.addWidget(gamepad_widget, 1, 1)

    form.addRow(action_label, bindings_widget)

    if footer_widget is not None:
        form.addRow(footer_widget)

    return group


def build_hotkeys_tab(window: "ConfigWindow", i18n: dict) -> QWidget:
    widget = QWidget()
    root_layout = QVBoxLayout(widget)
    root_layout.setSpacing(10)
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

    relay_text = hotkeys_i18n.get("relay_outputs_when_paused", {}).get(
        "checkbox",
        "Relay to texthooker/output clients while paused",
    )
    relay_tooltip = hotkeys_i18n.get("relay_outputs_when_paused", {}).get(
        "tooltip",
        "Keep texthooker and output websocket clients updated while GSM intake is paused.",
    )
    relay_widget = _build_checkbox_row(
        window.relay_outputs_when_text_intake_paused_check,
        relay_text,
        relay_tooltip,
    )

    root_layout.addWidget(
        _build_binding_group(
            window,
            hotkeys_i18n.get("groups", {}).get("input", "Input"),
            window._create_labeled_widget(tabs_i18n, "hotkeys", "pause_text_intake"),
            window.pause_text_intake_hotkey_edit,
            window.pause_text_intake_gamepad_combo,
            hotkeys_i18n,
            relay_widget,
        )
    )

    root_layout.addWidget(
        _build_binding_group(
            window,
            hotkeys_i18n.get("groups", {}).get("overlay", "Overlay"),
            window._create_labeled_widget(tabs_i18n, "overlay", "manual_overlay_scan_hotkey"),
            window.manual_overlay_scan_hotkey_edit,
            window.manual_overlay_scan_gamepad_combo,
            hotkeys_i18n,
        )
    )

    root_layout.addWidget(
        _build_binding_group(
            window,
            hotkeys_i18n.get("groups", {}).get("audio", "Audio"),
            window._create_labeled_widget(tabs_i18n, "advanced", "play_latest_hotkey"),
            window.play_latest_audio_hotkey_edit,
            window.play_latest_audio_gamepad_combo,
            hotkeys_i18n,
        )
    )

    root_layout.addWidget(
        _build_binding_group(
            window,
            hotkeys_i18n.get("groups", {}).get("experimental", "Experimental"),
            window._create_labeled_widget(tabs_i18n, "game_pausing", "hotkey"),
            window.process_pause_hotkey_edit,
            window.process_pause_gamepad_combo,
            hotkeys_i18n,
        )
    )

    root_layout.addWidget(window._create_reset_button("hotkeys", window._create_hotkeys_tab))
    return widget
