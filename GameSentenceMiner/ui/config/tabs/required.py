from __future__ import annotations

from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QWidget,
)
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config.binding import BindingManager
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow

from GameSentenceMiner.util.config.configuration import CommonLanguages

from ..binding import ValueTransform
from ..labels import LabelColor, build_label
from .websocket_sources import WebsocketSourcesEditor
from .port_widget import make_port_controls


@dataclass(frozen=True)
class FieldSpec:
    path: tuple[str, ...]
    section: str
    key: str
    widget: QWidget
    color: LabelColor = LabelColor.DEFAULT
    bold: bool = False
    default_tooltip: str = "..."
    transform: ValueTransform = ValueTransform()
    label_override: str | None = None


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


def _float_from_text(text: str, default: float = 0.0) -> float:
    try:
        return float(text or default)
    except Exception:
        return default


def _int_from_text(text: str, default: int = 0) -> int:
    try:
        return int(text or default)
    except Exception:
        return default


def build_required_tab(window: ConfigWindow, binder: BindingManager, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    _add_language_row(window, binder, layout, tabs_i18n)
    _add_input_sources(window, binder, layout, tabs_i18n)
    _add_unified_port_row(window, binder, layout, tabs_i18n)

    # Websocket sources editor (replaces legacy CSV URI field)
    window.req_websocket_sources_editor = WebsocketSourcesEditor()
    layout.addRow(
        build_label(tabs_i18n, "general", "websocket_uri", default_tooltip="Named websocket input sources"),
        window.req_websocket_sources_editor,
    )

    window.req_note_type_combo = window._create_anki_field_combo()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "anki", "note_type"),
            "anki",
            "note_type",
            window.req_note_type_combo,
            default_tooltip="Anki note type to pull fields from",
            label_override="Anki Note Type",
        ),
        tabs_i18n,
    )
    
    window.req_word_field_edit = window._create_anki_field_combo()
    _add_row(
        binder,
        layout,
        FieldSpec(("profile", "anki", "word_field"), "anki", "word_field", window.req_word_field_edit),
        tabs_i18n,
    )

    window.req_sentence_field_edit = window._create_anki_field_combo()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "anki", "sentence_field"),
            "anki",
            "sentence_field",
            window.req_sentence_field_edit,
        ),
        tabs_i18n,
    )

    window.req_sentence_audio_field_edit = window._create_anki_field_combo()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "anki", "sentence_audio_field"),
            "anki",
            "sentence_audio_field",
            window.req_sentence_audio_field_edit,
        ),
        tabs_i18n,
    )

    window.req_picture_field_edit = window._create_anki_field_combo()
    _add_row(
        binder,
        layout,
        FieldSpec(("profile", "anki", "picture_field"), "anki", "picture_field", window.req_picture_field_edit),
        tabs_i18n,
    )

    window.req_beginning_offset_edit = QLineEdit()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "audio", "beginning_offset"),
            "audio",
            "beginning_offset",
            window.req_beginning_offset_edit,
            transform=ValueTransform(
                to_model=lambda v: _float_from_text(v, 0.0),
                from_model=lambda v: "" if v is None else str(v),
            ),
        ),
        tabs_i18n,
    )

    window.req_end_offset_edit = QLineEdit()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "audio", "end_offset"),
            "vad",
            "audio_end_offset",
            window.req_end_offset_edit,
            transform=ValueTransform(
                to_model=lambda v: _float_from_text(v, 0.0),
                from_model=lambda v: "" if v is None else str(v),
            ),
        ),
        tabs_i18n,
    )

    _add_anki_features_row(window, binder, layout, tabs_i18n)
    separator = QLabel()
    separator.setFrameStyle(QLabel.Shape.HLine | QLabel.Shadow.Sunken)
    layout.addRow(separator)
    _add_legend(layout, tabs_i18n)

    return widget


def _language_combo() -> QComboBox:
    combo = QComboBox()
    combo.addItems(CommonLanguages.get_all_names_pretty())
    return combo


def _add_language_row(window, binder, layout: QFormLayout, i18n: dict) -> None:
    window.req_native_language_combo = _language_combo()
    window.req_target_language_combo = _language_combo()

    binder.bind(
        ("profile", "general", "native_language"),
        window.req_native_language_combo,
        transform=ValueTransform(
            to_model=lambda v: _language_to_code(v, CommonLanguages.ENGLISH.value),
            from_model=lambda v: _code_to_language(v, "English"),
        ),
    )
    binder.bind(
        ("profile", "general", "target_language"),
        window.req_target_language_combo,
        transform=ValueTransform(
            to_model=lambda v: _language_to_code(v, CommonLanguages.JAPANESE.value),
            from_model=lambda v: _code_to_language(v, "Japanese"),
        ),
    )

    languages_widget = QWidget()
    languages_layout = QHBoxLayout(languages_widget)
    languages_layout.setContentsMargins(0, 0, 0, 0)
    languages_layout.addWidget(build_label(i18n, "general", "native_language"))
    languages_layout.addWidget(window.req_native_language_combo)
    languages_layout.addWidget(build_label(i18n, "general", "target_language", color=LabelColor.IMPORTANT, bold=True))
    languages_layout.addWidget(window.req_target_language_combo)
    languages_layout.addStretch()

    layout.addRow(languages_widget)


def _add_input_sources(window, binder, layout: QFormLayout, i18n: dict) -> None:
    window.req_websocket_enabled_check = QCheckBox()
    window.req_clipboard_enabled_check = QCheckBox()
    binder.bind(("profile", "general", "use_websocket"), window.req_websocket_enabled_check)
    binder.bind(("profile", "general", "use_clipboard"), window.req_clipboard_enabled_check)

    input_widget = QWidget()
    input_layout = QHBoxLayout(input_widget)
    input_layout.setContentsMargins(0, 0, 0, 0)
    input_layout.addWidget(build_label(i18n, "general", "websocket_enabled", color=LabelColor.RECOMMENDED))
    input_layout.addWidget(window.req_websocket_enabled_check)
    input_layout.addWidget(build_label(i18n, "general", "clipboard_enabled"))
    input_layout.addWidget(window.req_clipboard_enabled_check)
    input_layout.addStretch()
    layout.addRow(QLabel("Input Sources:"), input_widget)


def _add_unified_port_row(window, binder, layout: QFormLayout, i18n: dict) -> None:
    window.req_single_port_edit = QLineEdit()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "general", "single_port"),
            "general",
            "single_port",
            make_port_controls(window.req_single_port_edit),
            color=LabelColor.RECOMMENDED,
            bold=True,
            default_tooltip="Primary web + websocket port. Changing this restarts GSM.",
            transform=ValueTransform(
                to_model=lambda v: _int_from_text(v, 7275),
                from_model=lambda v: "" if v is None else str(v),
            ),
        ),
        i18n,
        bind_widget=window.req_single_port_edit,
    )


def _add_anki_features_row(window, binder, layout: QFormLayout, i18n: dict) -> None:
    window.req_open_anki_edit_check = QCheckBox()
    window.req_open_anki_browser_check = QCheckBox()
    binder.bind(("profile", "features", "open_anki_edit"), window.req_open_anki_edit_check)
    binder.bind(("profile", "features", "open_anki_in_browser"), window.req_open_anki_browser_check)

    anki_features_widget = QWidget()
    anki_features_layout = QHBoxLayout(anki_features_widget)
    anki_features_layout.setContentsMargins(0, 0, 0, 0)
    anki_features_layout.addWidget(window.req_open_anki_edit_check)
    anki_features_layout.addWidget(build_label(i18n, "features", "open_anki_edit"))
    anki_features_layout.addWidget(window.req_open_anki_browser_check)
    anki_features_layout.addWidget(build_label(i18n, "features", "open_anki_browser"))
    anki_features_layout.addStretch()
    layout.addRow(anki_features_widget)


def _add_legend(layout: QFormLayout, i18n: dict) -> None:
    legend_i18n = i18n.get("general", {}).get("legend", {})
    legend_label = QLabel(
        f"<p>{legend_i18n.get('tooltip_info', '...')}</p>"
        f"<p><font color='#cc7a7a'>{legend_i18n.get('advanced', '...')}</font></p>"
        f"<p><font color='#7fbf7f'>{legend_i18n.get('recommended', '...')}</font></p>"
    )
    legend_label.setWordWrap(True)
    layout.addRow(legend_label)


def _add_row(
    binder,
    layout: QFormLayout,
    spec: FieldSpec,
    i18n: dict,
    bind_widget: QWidget | None = None,
) -> None:
    label = build_label(
        i18n,
        spec.section,
        spec.key,
        default_tooltip=spec.default_tooltip,
        color=spec.color,
        bold=spec.bold,
        label_override=spec.label_override,
    )
    layout.addRow(label, spec.widget)
    binder.bind(spec.path, bind_widget or spec.widget, transform=spec.transform)
