from __future__ import annotations

from PyQt6.QtWidgets import QLabel, QFormLayout, QWidget, QStyle
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_experimental_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    warning_label = QLabel("Warning: These features are experimental, use at your own risk.")
    warning_label.setStyleSheet("color: #FF6B6B;")
    layout.addRow(warning_label)

    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n, "experimental", "enable_experimental_features", default_tooltip="Required to enable experimental features."
        ),
        window.experimental_features_enabled_check,
    )

    process_group = window._create_group_box("Game Pausing (VERY EXPERIMENTAL)")
    process_layout = QFormLayout(process_group)
    process_layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)

    # --- Help Icon Setup ---
    help_icon = QLabel()
    icon = window.style().standardIcon(QStyle.StandardPixmap.SP_MessageBoxInformation)
    help_icon.setPixmap(icon.pixmap(16, 16))
    
    help_tooltip = (
        "<p>This feature allows you to pause and resume the game process that is currently being targeted by OBS.</p>"
        "<p>When enabled, you can use the configured hotkey to suspend the game's execution, "
        "which can be useful for games that do not have push to continue.</p>"
        "<p>The game will automatically resume after the specified number of seconds, "
        "or you can manually resume it with the same hotkey."
        "If you need longer pauses, check out https://github.com/Merrit/nyrna</p>"
        "<hr>"
        "<p><b><span style='color: #FF6B6B;'>WARNING: This is an extremely experimental feature that directly manipulates process execution.</span></b></p>"
        "<ul>"
        "<li>While potentially rare, it can cause crashes, so use with caution.</li>"
        "<li>Games with online components or anti-cheat mechanisms may detect this and result in bans or other penalties.</li>"
        "</ul>"
        "<p>Only use this feature if you fully understand the risks and are prepared for potential consequences.</p>"
        "<p>The 'Require Game EXE Match' option ensures pausing only works when the target executable matches the detected game.</p>"
        "<hr>"
        "GSM is not responsible for any issues caused by this feature."
    )
    help_icon.setToolTip(help_tooltip)
    
    # Add help icon to the layout
    process_layout.addRow("Information:", help_icon)

    process_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n, "game_pausing", "enabled", default_tooltip="Enable experimental game pausing features."
        ),
        window.process_pausing_enabled_check,
    )
    process_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n, "game_pausing", "hotkey", default_tooltip="Hotkey to pause/resume the active game process."
        ),
        window.process_pause_hotkey_edit,
    )
    process_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "game_pausing",
            "overlay_manual_hotkey_requests_pause",
            default_tooltip="When enabled, overlay manual hotkey requests pause on enter and resume on exit.",
        ),
        window.process_pausing_overlay_manual_hotkey_requests_pause_check,
    )
    process_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "game_pausing",
            "overlay_texthooker_hotkey_requests_pause",
            default_tooltip="When enabled, overlay texthooker hotkey requests pause on enter and resume on exit.",
        ),
        window.process_pausing_overlay_texthooker_hotkey_requests_pause_check,
    )
    process_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "game_pausing",
            "auto_resume_seconds",
            default_tooltip="Auto-resume suspended processes after this many seconds.",
        ),
        window.process_pausing_auto_resume_seconds_edit,
    )
    process_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "game_pausing",
            "require_game_exe_match",
            default_tooltip="Only allow pausing when the target exe matches the detected game exe.",
        ),
        window.process_pausing_require_game_exe_match_check,
    )
    # Disable the checkbox but keep it displayed and always checked
    window.process_pausing_require_game_exe_match_check.setChecked(True)
    window.process_pausing_require_game_exe_match_check.setEnabled(False)
    process_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "game_pausing",
            "allowlist",
            default_tooltip="Comma-separated exe names that are always allowed.",
        ),
        window.process_pausing_allowlist_edit,
    )
    process_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "game_pausing",
            "denylist",
            default_tooltip="Comma-separated exe names that are always blocked.",
        ),
        window.process_pausing_denylist_edit,
    )

    layout.addRow(process_group)
    return widget
