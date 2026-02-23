from __future__ import annotations

from PyQt6.QtWidgets import (
    QAbstractItemView,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)
from dataclasses import dataclass
from typing import TYPE_CHECKING

from GameSentenceMiner.util.config.configuration import CommonLanguages
from GameSentenceMiner.util.config.configuration import is_beangate
from ..binding import ValueTransform
from ..labels import LabelColor, build_label

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config.binding import BindingManager
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


@dataclass(frozen=True)
class FieldSpec:
    path: tuple[str, ...]
    section: str
    key: str
    attr: str
    color: LabelColor = LabelColor.DEFAULT
    bold: bool = False
    default_tooltip: str = "..."
    transform: ValueTransform = ValueTransform()


def _language_to_code(text: str, fallback: str) -> str:
    try:
        return CommonLanguages.from_name(text.replace(" ", "_")).value
    except Exception:
        return fallback


def _code_to_language(code: str, fallback: str) -> str:
    try:
        return CommonLanguages.from_code(code).name.replace("_", " ").title()
    except Exception:
        return fallback


def _int_from_text(text: str, default: int = 0) -> int:
    try:
        return int(text or default)
    except Exception:
        return default


GENERAL_FIELDS = [
    FieldSpec(
        ("profile", "general", "use_websocket"),
        "general",
        "websocket_enabled",
        "websocket_enabled_check",
        color=LabelColor.IMPORTANT,
        bold=True,
    ),
    FieldSpec(
        ("profile", "general", "use_clipboard"),
        "general",
        "clipboard_enabled",
        "clipboard_enabled_check",
        color=LabelColor.IMPORTANT,
        bold=True,
    ),
    FieldSpec(
        ("profile", "general", "use_both_clipboard_and_websocket"),
        "general",
        "allow_both_simultaneously",
        "use_both_clipboard_and_websocket_check",
        color=LabelColor.ADVANCED,
        bold=True,
    ),
    FieldSpec(
        ("profile", "general", "merge_matching_sequential_text"),
        "general",
        "merge_sequential_text",
        "merge_matching_sequential_text_check",
        color=LabelColor.ADVANCED,
        bold=True,
    ),
    FieldSpec(("profile", "general", "websocket_uri"), "general", "websocket_uri", "websocket_uri_edit"),
    FieldSpec(("profile", "general", "open_config_on_startup"), "general", "open_config_on_startup", "open_config_on_startup_check"),
    FieldSpec(("profile", "general", "open_multimine_on_startup"), "general", "open_texthooker_on_startup", "open_multimine_on_startup_check"),
    FieldSpec(
        ("profile", "general", "texthooker_port"),
        "general",
        "texthooker_port",
        "texthooker_port_edit",
        transform=ValueTransform(to_model=lambda v: _int_from_text(v, 0), from_model=lambda v: "" if v is None else str(v)),
    ),
    FieldSpec(
        ("profile", "advanced", "plaintext_websocket_port"),
        "advanced",
        "plaintext_export_port",
        "plaintext_websocket_export_port_edit",
        transform=ValueTransform(to_model=lambda v: _int_from_text(v, -1), from_model=lambda v: "" if v is None else str(v)),
    ),
    FieldSpec(
        ("profile", "general", "native_language"),
        "general",
        "native_language",
        "native_language_combo",
        transform=ValueTransform(
            to_model=lambda v: _language_to_code(v, CommonLanguages.ENGLISH.value),
            from_model=lambda v: _code_to_language(v, "English"),
        ),
    ),
    FieldSpec(
        ("profile", "features", "notify_on_update"),
        "features",
        "notify_on_update",
        "notify_on_update_check",
    ),
]


def build_general_tab(window: ConfigWindow, binder: BindingManager, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)

    tabs_i18n = i18n.get("tabs", {})
    window.native_language_combo.clear()
    window.native_language_combo.addItems(CommonLanguages.get_all_names_pretty())
    for spec in GENERAL_FIELDS:
        label = build_label(
            tabs_i18n,
            spec.section,
            spec.key,
            default_tooltip=spec.default_tooltip,
            color=spec.color,
            bold=spec.bold,
        )
        layout.addRow(label, getattr(window, spec.attr))
        binder.bind(spec.path, getattr(window, spec.attr), transform=spec.transform)

    features_group = window._create_group_box("Features")
    features_layout = QFormLayout()
    features_layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    features_layout.addRow(window._create_labeled_widget(tabs_i18n, "features", "open_anki_edit"), window.open_anki_edit_check)
    features_layout.addRow(window._create_labeled_widget(tabs_i18n, "features", "open_anki_browser"), window.open_anki_browser_check)
    features_layout.addRow(window._create_labeled_widget(tabs_i18n, "features", "browser_query"), window.browser_query_edit)
    features_layout.addRow(QLabel("Generate LongPlay"), window.generate_longplay_check)
    window.generate_longplay_check.setToolTip(
        "Generate a LongPlay video using OBS recording, and write to a .srt file with all the text coming into gsm. RESTART REQUIRED."
    )
    features_group.setLayout(features_layout)
    layout.addRow(features_group)

    if is_beangate:
        test_button = QPushButton(i18n.get("buttons", {}).get("run_function", "Run Function"))
        test_button.clicked.connect(lambda: window.test_func() if window.test_func else None)
        layout.addRow(test_button)

    layout.addItem(QVBoxLayout().addStretch())
    layout.addRow(window._create_reset_button(["general", "features"], window._create_general_tab))
    return widget


def build_discord_tab(window: ConfigWindow, binder: BindingManager, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    _add_discord_settings(window, binder, layout, tabs_i18n)

    layout.addItem(QVBoxLayout().addStretch())
    return widget


def _add_discord_settings(window: ConfigWindow, binder, layout: QFormLayout, i18n: dict) -> None:
    window.discord_settings_group.setTitle("Discord Rich Presence")
    window.discord_settings_group.setStyleSheet(
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

    discord_layout = QFormLayout()

    enabled_label = QLabel("Enabled:")
    enabled_label.setToolTip("Enable or disable Discord Rich Presence")
    discord_layout.addRow(enabled_label, window.discord_enabled_check)
    binder.bind(("master", "discord", "enabled"), window.discord_enabled_check)

    window.discord_settings_container = QWidget()
    discord_settings_layout = QFormLayout(window.discord_settings_container)
    discord_settings_layout.setContentsMargins(0, 5, 0, 0)

    inactivity_label = QLabel("Inactivity Timer (seconds):")
    inactivity_label.setToolTip("How many seconds of inactivity before Discord Rich Presence stops (120-900)")
    discord_settings_layout.addRow(inactivity_label, window.discord_inactivity_spin)
    binder.bind(("master", "discord", "inactivity_timer"), window.discord_inactivity_spin)

    icon_label = QLabel("Icon:")
    icon_label.setToolTip("Choose which GSM icon to display on Discord")
    window.discord_icon_combo.clear()
    window.discord_icon_combo.addItems(["GSM", "Cute", "Jacked", "Cursed"])
    discord_settings_layout.addRow(icon_label, window.discord_icon_combo)
    binder.bind(("master", "discord", "icon"), window.discord_icon_combo)

    stats_label = QLabel("Show Stats:")
    stats_label.setToolTip("Choose which reading statistics to display on Discord")
    window.discord_show_stats_combo.clear()
    window.discord_show_stats_combo.addItems(
        ["None", "Characters per Hour", "Total Characters", "Cards Mined", "Active Reading Time"]
    )
    discord_settings_layout.addRow(stats_label, window.discord_show_stats_combo)
    binder.bind(("master", "discord", "show_reading_stats"), window.discord_show_stats_combo)

    window.discord_blacklisted_scenes_list.setSelectionMode(QAbstractItemView.SelectionMode.MultiSelection)
    window.discord_blacklisted_scenes_list.setMinimumHeight(260)
    window.discord_blacklisted_scenes_list.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
    window.discord_blacklisted_scenes_list.setToolTip("Select OBS scenes where Discord RPC should be disabled")
    try:
        window.discord_blacklisted_scenes_list.setAlternatingRowColors(True)
    except Exception:
        pass
    window.discord_blacklisted_scenes_list.setStyleSheet(
        """
            QListWidget {
                border: 1px solid #333;
                border-radius: 6px;
                padding: 4px;
                alternate-background-color: transparent;
                color: #e6e6e6;
            }
            QListWidget::item {
                padding: 6px 8px;
            }
            QListWidget::item:selected {
                background: #265a88;
                color: white;
            }
        """
    )

    blacklist_container = QWidget()
    blacklist_container.setStyleSheet("QWidget { padding: 0px; }")
    blacklist_layout = QVBoxLayout(blacklist_container)
    blacklist_layout.setContentsMargins(0, 0, 0, 0)
    blacklist_layout.setSpacing(8)
    blacklist_layout.addWidget(window.discord_blacklisted_scenes_list)

    controls_layout = QHBoxLayout()
    controls_layout.setContentsMargins(0, 0, 0, 0)
    controls_layout.addStretch()
    discord_refresh_button = QPushButton(i18n.get("profiles", {}).get("refresh_scenes_button", "Refresh"))
    discord_refresh_button.setToolTip("Refresh the list of available OBS scenes")
    discord_refresh_button.clicked.connect(window.refresh_obs_scenes)
    controls_layout.addWidget(discord_refresh_button)
    blacklist_layout.addLayout(controls_layout)

    blacklist_label = QLabel("Blacklisted Scenes:")
    blacklist_label.setToolTip("OBS scenes where Discord RPC will be disabled (e.g., private/sensitive content)")
    discord_settings_layout.addRow(blacklist_label, blacklist_container)

    discord_layout.addRow(window.discord_settings_container)
    window.discord_settings_group.setLayout(discord_layout)
    layout.addRow(window.discord_settings_group)

    window._update_discord_settings_visibility()
