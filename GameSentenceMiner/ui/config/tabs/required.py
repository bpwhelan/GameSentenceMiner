from __future__ import annotations

from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QWidget,
)
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config.binding import BindingManager
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow

from GameSentenceMiner.util.config.configuration import CommonLanguages, Locale

from ..binding import ValueTransform
from ..labels import LabelColor, build_label


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


def _float_from_text(text: str, default: float = 0.0) -> float:
    try:
        return float(text or default)
    except Exception:
        return default


def build_required_tab(window: ConfigWindow, binder: BindingManager, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    _add_input_sources(window, binder, layout, tabs_i18n)

    window.req_websocket_uri_edit = QLineEdit()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "general", "websocket_uri"),
            "general",
            "websocket_uri",
            window.req_websocket_uri_edit,
        ),
        tabs_i18n,
    )

    window.locale_combo.clear()
    window.locale_combo.addItems([e.name for e in Locale])
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("master", "locale"),
            "general",
            "locale",
            window.locale_combo,
            transform=ValueTransform(
                to_model=lambda v: Locale[v].value if v in Locale.__members__ else Locale.from_any(v).value,
                from_model=lambda v: Locale.from_any(v).name,
            ),
        ),
        tabs_i18n,
    )

    window.req_native_language_combo = _language_combo()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "general", "native_language"),
            "general",
            "native_language",
            window.req_native_language_combo,
            transform=ValueTransform(
                to_model=lambda v: _language_to_code(v, CommonLanguages.ENGLISH.value),
                from_model=lambda v: _code_to_language(v, "English"),
            ),
        ),
        tabs_i18n,
    )

    window.req_target_language_combo = _language_combo()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "general", "target_language"),
            "general",
            "target_language",
            window.req_target_language_combo,
            color=LabelColor.IMPORTANT,
            bold=True,
            transform=ValueTransform(
                to_model=lambda v: _language_to_code(v, CommonLanguages.JAPANESE.value),
                from_model=lambda v: _code_to_language(v, "Japanese"),
            ),
        ),
        tabs_i18n,
    )

    window.req_folder_to_watch_edit = QLineEdit()
    folder_widget = window._create_browse_widget(
        window.req_folder_to_watch_edit, QFileDialog.FileMode.Directory
    )
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "paths", "folder_to_watch"),
            "paths",
            "folder_to_watch",
            folder_widget,
        ),
        tabs_i18n,
        bind_widget=window.req_folder_to_watch_edit,
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
        ),
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

    window.req_word_field_edit = window._create_anki_field_combo()
    _add_row(
        binder,
        layout,
        FieldSpec(("profile", "anki", "word_field"), "anki", "word_field", window.req_word_field_edit),
        tabs_i18n,
    )

    window.req_sentence_field_overwrite_check = QCheckBox()
    _add_row(
        binder,
        layout,
        FieldSpec(
            ("profile", "anki", "sentence_field_overwrite"),
            "anki",
            "sentence_field_overwrite",
            window.req_sentence_field_overwrite_check,
        ),
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

    _add_splice_row(window, binder, layout, tabs_i18n)
    _add_ocenaudio_row(window, binder, layout, tabs_i18n)
    _add_anki_features_row(window, binder, layout, tabs_i18n)
    _add_legend(layout, tabs_i18n)

    return widget


def _language_combo() -> QComboBox:
    combo = QComboBox()
    combo.addItems(CommonLanguages.get_all_names_pretty())
    return combo


def _add_input_sources(window, binder, layout: QFormLayout, i18n: dict) -> None:
    window.req_websocket_enabled_check = QCheckBox()
    window.req_clipboard_enabled_check = QCheckBox()
    binder.bind(("profile", "general", "use_websocket"), window.req_websocket_enabled_check)
    binder.bind(("profile", "general", "use_clipboard"), window.req_clipboard_enabled_check)

    input_widget = QWidget()
    input_layout = QHBoxLayout(input_widget)
    input_layout.setContentsMargins(0, 0, 0, 0)
    input_layout.addWidget(window.req_websocket_enabled_check)
    input_layout.addWidget(QLabel(i18n.get("general", {}).get("websocket_enabled", {}).get("label", "...")))
    input_layout.addWidget(window.req_clipboard_enabled_check)
    input_layout.addWidget(QLabel(i18n.get("general", {}).get("clipboard_enabled", {}).get("label", "...")))
    input_layout.addStretch()
    layout.addRow(input_widget)


def _add_splice_row(window, binder, layout: QFormLayout, i18n: dict) -> None:
    window.req_cut_and_splice_segments_check = QCheckBox()
    window.req_splice_padding_edit = QLineEdit()
    binder.bind(("profile", "vad", "cut_and_splice_segments"), window.req_cut_and_splice_segments_check)
    binder.bind(
        ("profile", "vad", "splice_padding"),
        window.req_splice_padding_edit,
        transform=ValueTransform(
            to_model=lambda v: _float_from_text(v, 0.0),
            from_model=lambda v: "" if v is None else str(v),
        ),
    )

    splice_widget = QWidget()
    splice_layout = QHBoxLayout(splice_widget)
    splice_layout.setContentsMargins(0, 0, 0, 0)
    splice_layout.addWidget(window.req_cut_and_splice_segments_check)
    splice_layout.addWidget(build_label(i18n, "vad", "splice_padding"))
    splice_layout.addWidget(window.req_splice_padding_edit)
    splice_layout.addStretch()

    layout.addRow(build_label(i18n, "vad", "cut_and_splice"), splice_widget)


def _add_ocenaudio_row(window, binder, layout: QFormLayout, i18n: dict) -> None:
    window.req_external_tool_edit = QLineEdit()
    binder.bind(("profile", "audio", "external_tool"), window.req_external_tool_edit)

    ocen_widget = QWidget()
    ocen_layout = QHBoxLayout(ocen_widget)
    ocen_layout.setContentsMargins(0, 0, 0, 0)
    ocen_layout.addWidget(window.req_external_tool_edit)
    install_ocen_button = QPushButton(i18n.get("audio", {}).get("install_ocenaudio_button", "Install Ocenaudio"))
    install_ocen_button.clicked.connect(window.download_and_install_ocen)
    ocen_layout.addWidget(install_ocen_button)
    layout.addRow(build_label(i18n, "audio", "external_tool"), ocen_widget)


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
        f"<p><font color='#FFA500'>{legend_i18n.get('important', '...')}</font></p>"
        f"<p><font color='#FF0000'>{legend_i18n.get('advanced', '...')}</font></p>"
        f"<p><font color='#00FF00'>{legend_i18n.get('recommended', '...')}</font></p>"
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
    )
    layout.addRow(label, spec.widget)
    binder.bind(spec.path, bind_widget or spec.widget, transform=spec.transform)
