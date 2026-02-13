from __future__ import annotations

from PyQt6.QtWidgets import QLabel, QFormLayout, QWidget
from typing import TYPE_CHECKING

from ..labels import LabelColor

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_screenshot_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(window._create_labeled_widget(tabs_i18n, "screenshot", "enabled"), window.screenshot_enabled_check)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "screenshot", "width"), window.screenshot_width_edit)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "screenshot", "height"), window.screenshot_height_edit)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "screenshot", "quality"), window.screenshot_quality_edit)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "screenshot", "extension"), window.screenshot_extension_combo)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "screenshot", "animated"), window.animated_screenshot_check)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "screenshot", "ffmpeg_options"), window.screenshot_custom_ffmpeg_settings_edit)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "screenshot", "timing"), window.screenshot_timing_combo)
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "screenshot", "offset", color=LabelColor.IMPORTANT),
        window.seconds_after_line_edit,
    )
    layout.addRow(window._create_labeled_widget(tabs_i18n, "screenshot", "use_selector"), window.use_screenshot_selector_check)
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "screenshot", "trim_black_bars", color=LabelColor.RECOMMENDED),
        window.trim_black_bars_check,
    )

    window.animated_settings_group.setTitle("Animated Screenshot Settings")
    window.animated_settings_group.setStyleSheet(
        """
            QGroupBox {
                font-weight: bold;
                border: 2px solid #555;
                border-radius: 5px;
                margin-top: 10px;
                padding-top: 10px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px 0 5px;
            }
        """
    )

    animated_layout = QFormLayout()
    animated_layout.addRow(QLabel("FPS (10-30):"), window.animated_fps_spin)
    animated_layout.addRow(QLabel("Quality (0-10):"), window.animated_quality_spin)
    window.animated_settings_group.setLayout(animated_layout)
    layout.addRow(window.animated_settings_group)

    window._update_animated_settings_visibility()

    reset_widget = window._create_reset_button("screenshot", window._create_screenshot_tab)
    layout.addRow(reset_widget)
    return widget
