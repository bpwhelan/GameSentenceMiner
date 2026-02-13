from __future__ import annotations

import importlib.resources as resources

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QPixmap
from PyQt6.QtWidgets import QDialog, QFormLayout, QFrame, QHBoxLayout, QLabel, QPushButton, QScrollArea, QVBoxLayout, QWidget
from typing import TYPE_CHECKING

from ..labels import LabelColor
from GameSentenceMiner.util.config.configuration import PACKAGE_NAME

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def _create_field_mapping_row(
    combo,
    enabled_check,
    overwrite_check,
    append_check,
    *,
    enabled_locked: bool = False,
) -> QWidget:
    row_widget = QWidget()
    row_layout = QHBoxLayout(row_widget)
    row_layout.setContentsMargins(0, 0, 0, 0)
    row_layout.addWidget(combo, 1)

    enabled_check.setText("Enabled")
    overwrite_check.setText("Overwrite")
    append_check.setText("Append")

    if enabled_locked:
        enabled_check.setChecked(True)
        enabled_check.setEnabled(False)
        enabled_check.setToolTip("This core field is always enabled.")

    row_layout.addWidget(enabled_check)
    row_layout.addWidget(overwrite_check)
    row_layout.addWidget(append_check)
    return row_widget


def _show_full_image_preview(parent: QWidget, pixmap: QPixmap, title: str) -> None:
    dialog = QDialog(parent)
    dialog.setWindowTitle(title)
    dialog.setModal(True)

    layout = QVBoxLayout(dialog)
    layout.setContentsMargins(8, 8, 8, 8)

    scroll = QScrollArea(dialog)
    scroll.setWidgetResizable(True)
    scroll.setAlignment(Qt.AlignmentFlag.AlignCenter)

    image_label = QLabel()
    image_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
    image_label.setPixmap(pixmap)
    scroll.setWidget(image_label)
    layout.addWidget(scroll)

    dialog.resize(min(max(700, pixmap.width() + 40), 1400), min(max(500, pixmap.height() + 80), 1000))
    dialog.exec()


def build_anki_general_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "enabled", color=LabelColor.RECOMMENDED, bold=True),
        window.anki_enabled_check,
    )
    layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "update_anki"), window.update_anki_check)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "url"), window.anki_url_edit)

    note_type_widget = QWidget()
    note_type_layout = QHBoxLayout(note_type_widget)
    note_type_layout.setContentsMargins(0, 0, 0, 0)
    note_type_layout.addWidget(window.anki_note_type_combo)
    window.anki_fields_refresh_button = QPushButton("Refresh Fields")
    window.anki_fields_refresh_button.setToolTip("Refresh available fields from AnkiConnect")
    note_type_layout.addWidget(window.anki_fields_refresh_button)
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "note_type", "Anki note type to pull fields from"),
        note_type_widget,
    )

    fields_group = window._create_group_box("Field Mappings")
    fields_layout = QFormLayout()
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "word_field", color=LabelColor.IMPORTANT, bold=True),
        window.word_field_edit,
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "sentence_field", color=LabelColor.ADVANCED, bold=True),
        _create_field_mapping_row(
            window.sentence_field_edit,
            window.sentence_field_enabled_check,
            window.sentence_field_overwrite_check,
            window.sentence_field_append_check,
            enabled_locked=True,
        ),
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "sentence_audio_field", color=LabelColor.IMPORTANT, bold=True),
        _create_field_mapping_row(
            window.sentence_audio_field_edit,
            window.sentence_audio_field_enabled_check,
            window.sentence_audio_field_overwrite_check,
            window.sentence_audio_field_append_check,
            enabled_locked=True,
        ),
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "picture_field", color=LabelColor.IMPORTANT, bold=True),
        _create_field_mapping_row(
            window.picture_field_edit,
            window.picture_field_enabled_check,
            window.picture_field_overwrite_check,
            window.picture_field_append_check,
            enabled_locked=True,
        ),
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "previous_sentence_field"),
        _create_field_mapping_row(
            window.previous_sentence_field_edit,
            window.previous_sentence_field_enabled_check,
            window.previous_sentence_field_overwrite_check,
            window.previous_sentence_field_append_check,
        ),
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "previous_image_field"),
        _create_field_mapping_row(
            window.previous_image_field_edit,
            window.previous_image_field_enabled_check,
            window.previous_image_field_overwrite_check,
            window.previous_image_field_append_check,
        ),
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "video_field", color=LabelColor.ADVANCED),
        _create_field_mapping_row(
            window.video_field_edit,
            window.video_field_enabled_check,
            window.video_field_overwrite_check,
            window.video_field_append_check,
        ),
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "sentence_furigana_field"),
        _create_field_mapping_row(
            window.sentence_furigana_field_edit,
            window.sentence_furigana_field_enabled_check,
            window.sentence_furigana_field_overwrite_check,
            window.sentence_furigana_field_append_check,
        ),
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "game_name_field"),
        _create_field_mapping_row(
            window.game_name_field_edit,
            window.game_name_field_enabled_check,
            window.game_name_field_overwrite_check,
            window.game_name_field_append_check,
        ),
    )
    fields_group.setLayout(fields_layout)
    layout.addRow(fields_group)

    layout.addRow(window._create_labeled_widget(tabs_i18n, "advanced", "multiline_linebreak"), window.multi_line_line_break_edit)

    reset_widget = window._create_reset_button("anki", window._create_anki_general_tab)
    layout.addRow(reset_widget)
    return widget


def build_anki_confirmation_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n, "anki", "show_update_confirmation_dialog", color=LabelColor.RECOMMENDED, bold=True
        ),
        window.show_update_confirmation_dialog_check,
    )
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "anki",
            "auto_accept_timer",
            "Accept The Result without user input after # of seconds, 0 disables this feature",
        ),
        window.auto_accept_timer_edit,
    )
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "anki",
            "confirmation_always_on_top",
            "Keep the Anki confirmation dialog above other windows while open.",
        ),
        window.anki_confirmation_always_on_top_check,
    )
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "anki",
            "confirmation_focus_on_show",
            "Attempt to focus the Anki confirmation dialog when it opens.",
        ),
        window.anki_confirmation_focus_on_show_check,
    )
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "anki",
            "autoplay_audio",
            "Automatically play the selected audio range when the dialog opens.",
        ),
        window.anki_confirmation_autoplay_audio_check,
    )
    layout.addRow(
        window._create_labeled_widget(
            tabs_i18n,
            "anki",
            "replay_audio_on_tts_generation",
            "Automatically replay audio after generating TTS in the dialog.",
        ),
        window.anki_confirmation_replay_audio_on_tts_generation_check,
    )
    separator = QFrame()
    separator.setFrameShape(QFrame.Shape.HLine)
    separator.setFrameShadow(QFrame.Shadow.Sunken)
    layout.addRow(separator)
    layout.addRow(QLabel("Confirmation Dialog Preview"))

    preview_label = QLabel("Add an image at `GameSentenceMiner/assets/anki_confirmation_example.png` to enable preview.")
    preview_path = resources.files(PACKAGE_NAME).joinpath("assets", "anki_confirmation_example.png")
    if preview_path.is_file():
        pixmap = QPixmap(str(preview_path))
        if not pixmap.isNull():
            preview_trigger = QPushButton("Click or hover here to preview")
            preview_trigger.setToolTip(f"<img src='{preview_path.as_posix()}'>")
            preview_trigger.clicked.connect(lambda: _show_full_image_preview(window, pixmap, "Anki Confirmation Example"))
            layout.addRow("Dialog Example:", preview_trigger)
        else:
            layout.addRow("Dialog Example:", preview_label)
    else:
        layout.addRow("Dialog Example:", preview_label)

    reset_widget = window._create_reset_button("anki", window._create_anki_confirmation_tab)
    layout.addRow(reset_widget)
    return widget


def build_anki_tags_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    tags_group = window._create_group_box("Tag Settings")
    tags_layout = QFormLayout()
    tags_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "custom_tags", color=LabelColor.RECOMMENDED, bold=True),
        window.custom_tags_edit,
    )
    tags_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "tags_to_check"), window.tags_to_check_edit)
    tags_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "add_game_tag", color=LabelColor.RECOMMENDED, bold=True),
        window.add_game_tag_check,
    )
    tags_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "parent_tag", color=LabelColor.RECOMMENDED, bold=True),
        window.parent_tag_edit,
    )
    tags_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "tag_unvoiced_cards"), window.tag_unvoiced_cards_check)
    tags_group.setLayout(tags_layout)
    layout.addRow(tags_group)
    return widget


def build_anki_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    return build_anki_general_tab(window, i18n)
