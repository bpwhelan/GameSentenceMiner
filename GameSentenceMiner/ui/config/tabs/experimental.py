from __future__ import annotations

from PyQt6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QFormLayout,
    QWidget,
    QStyle,
    QPushButton,
    QMessageBox,
)
from typing import TYPE_CHECKING

from GameSentenceMiner.ui.config.safety import safe_config_call, safe_config_callback
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.docs import DOCS_URLS

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def _get_force_resume_suspended_processes():
    from GameSentenceMiner.util.platform.window_state_monitor import (
        force_resume_suspended_processes,
    )

    return force_resume_suspended_processes


@safe_config_call(name="experimental.force_resume_suspended_processes")
def _force_resume_suspended_processes(window: "ConfigWindow") -> None:
    reply = QMessageBox.question(
        window,
        "Force Resume Suspended Processes",
        (
            "Force resume all tracked suspended processes and clear the pause-tracking state?\n\n"
            "This uses the same recovery path GSM uses after restart/cleanup."
        ),
        QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
        QMessageBox.StandardButton.Cancel,
    )
    if reply != QMessageBox.StandardButton.Yes:
        return

    try:
        result = _get_force_resume_suspended_processes()()
    except Exception as exc:
        logger.exception(f"Force resume from settings failed: {exc}")
        QMessageBox.critical(
            window,
            "Process Resume Failed",
            f"Could not force resume suspended processes.\n\n{exc}",
        )
        return

    summary = (
        f"Candidates: {result['total_candidates']}\n"
        f"Resumed: {result['resumed']}\n"
        f"Failed: {result['failed']}\n"
        f"Stale skipped: {result['stale']}\n"
        f"Legacy skipped: {result['legacy_missing_created']}"
    )
    QMessageBox.information(window, "Process Resume Complete", summary)


def _append_csv_entry_text(current_text: str, entry: str) -> tuple[str, bool]:
    normalized_entry = str(entry or "").strip()
    entries = [item.strip() for item in str(current_text or "").split(",") if item.strip()]
    if not normalized_entry:
        return ", ".join(entries), False

    existing_entries = {item.lower() for item in entries}
    if normalized_entry.lower() in existing_entries:
        return ", ".join(entries), False

    entries.append(normalized_entry)
    return ", ".join(entries), True


def _get_current_target_window_details() -> tuple[str, str]:
    from GameSentenceMiner.util.config.configuration import is_windows
    from GameSentenceMiner.util.platform.window_state_monitor import (
        WindowStateMonitor,
        get_window_state_monitor,
    )

    if not is_windows():
        raise RuntimeError("Current target window detection is only available on Windows.")

    monitor = get_window_state_monitor()
    if monitor is None:
        monitor = WindowStateMonitor()

    hwnd = monitor.target_hwnd
    exe_name = monitor._get_window_exe_name(hwnd) if hwnd else ""
    title = monitor._get_window_title(hwnd) if hwnd else ""

    if not exe_name:
        hwnd = monitor.find_target_hwnd()
        exe_name = monitor._get_window_exe_name(hwnd) if hwnd else ""
        title = monitor._get_window_title(hwnd) if hwnd else ""

    if not hwnd:
        raise RuntimeError("No current target window found.")
    if not exe_name:
        raise RuntimeError("Found the current target window, but could not resolve its executable name.")

    return exe_name, title


@safe_config_call(name="experimental.add_current_target_window_to_list")
def _add_current_target_window_to_list(window: "ConfigWindow", line_edit, list_name: str) -> None:
    try:
        exe_name, title = _get_current_target_window_details()
    except Exception as exc:
        logger.warning(f"Failed to resolve current target window for {list_name}: {exc}")
        QMessageBox.warning(window, "Add Current Target Failed", str(exc))
        return

    updated_text, added = _append_csv_entry_text(line_edit.text(), exe_name)
    if added:
        line_edit.setText(updated_text)
        target_label = f"{exe_name} ({title})" if title else exe_name
        QMessageBox.information(
            window,
            f"{list_name.capitalize()} Updated",
            f"Added {target_label} to the {list_name}.",
        )
        return

    QMessageBox.information(
        window,
        f"{list_name.capitalize()} Unchanged",
        f"{exe_name} is already in the {list_name}.",
    )


def _create_process_list_row(window: "ConfigWindow", line_edit, list_name: str) -> QWidget:
    row_widget = QWidget()
    row_layout = QHBoxLayout(row_widget)
    row_layout.setContentsMargins(0, 0, 0, 0)
    row_layout.setSpacing(8)
    row_layout.addWidget(line_edit, 1)

    add_button = QPushButton("Add Current Target")
    add_button.setToolTip(f"Resolve the current OBS target window and add its executable to the {list_name}.")
    add_button.clicked.connect(
        safe_config_callback(
            lambda: _add_current_target_window_to_list(window, line_edit, list_name),
            name="experimental.add_current_target_button",
        )
    )
    row_layout.addWidget(add_button)

    return row_widget


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
            tabs_i18n,
            "experimental",
            "enable_experimental_features",
            default_tooltip="Required to enable experimental features.",
        ),
        window.experimental_features_enabled_check,
    )

    # -- Tokenization group --
    tokenization_group = window._create_group_box("Tokenization (Experimental)")
    tokenization_layout = QFormLayout(tokenization_group)
    tokenization_layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)

    tokenization_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "experimental",
            "enable_tokenization",
            default_tooltip="Enable MeCab-based tokenization of game lines. Tracks word/kanji frequency data.",
        ),
        window.enable_tokenization_check,
    )
    weak_mode_label = QLabel("Backfill Throttle (Weak Systems, Backfill Only):")
    weak_mode_label.setToolTip(
        "Slow down tokenization backfill using adaptive pauses to reduce CPU/IO pressure "
        "on weaker hardware. This affects backfill only; newly captured lines are not delayed."
    )
    tokenization_layout.addRow(weak_mode_label, window.tokenize_low_performance_check)

    layout.addRow(tokenization_group)

    layout.addRow(
        QLabel("Documentation:"),
        window._create_docs_links_widget([("Game Pausing Guide", DOCS_URLS["game_pausing"])]),
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
            tabs_i18n,
            "game_pausing",
            "enabled",
            default_tooltip="Enable experimental game pausing features.",
        ),
        window.process_pausing_enabled_check,
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
            "overlay_gamepad_navigation_requests_pause",
            default_tooltip="When enabled, overlay gamepad navigation requests pause on enter and resume on exit.",
        ),
        window.process_pausing_overlay_gamepad_navigation_requests_pause_check,
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
        _create_process_list_row(window, window.process_pausing_allowlist_edit, "allowlist"),
    )
    process_layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "game_pausing",
            "denylist",
            default_tooltip="Comma-separated exe names that are always blocked.",
        ),
        _create_process_list_row(window, window.process_pausing_denylist_edit, "denylist"),
    )

    force_resume_button = QPushButton("Force Resume Suspended Processes")
    force_resume_button.setToolTip("Force resume any tracked suspended game processes and clear pause tracking.")
    force_resume_button.clicked.connect(
        safe_config_callback(
            lambda: _force_resume_suspended_processes(window),
            name="experimental.force_resume_button",
        )
    )
    process_layout.addRow("Recovery:", force_resume_button)

    layout.addRow(process_group)
    return widget
