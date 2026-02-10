from __future__ import annotations

from PyQt6.QtWidgets import QFormLayout, QHBoxLayout, QPushButton, QWidget
from typing import TYPE_CHECKING

from ..labels import LabelColor

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


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
    layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "show_update_confirmation_dialog"),
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
        window._create_labeled_widget(tabs_i18n, "anki", "sentence_field", color=LabelColor.ADVANCED, bold=True),
        window.sentence_field_edit,
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "sentence_audio_field", color=LabelColor.IMPORTANT, bold=True),
        window.sentence_audio_field_edit,
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "picture_field", color=LabelColor.IMPORTANT, bold=True),
        window.picture_field_edit,
    )
    fields_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "anki", "word_field", color=LabelColor.IMPORTANT, bold=True),
        window.word_field_edit,
    )
    fields_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "previous_sentence_field"), window.previous_sentence_field_edit)
    fields_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "previous_image_field"), window.previous_image_field_edit)
    fields_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "video_field", color=LabelColor.ADVANCED), window.video_field_edit)
    fields_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "sentence_furigana_field"), window.sentence_furigana_field_edit)
    fields_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "game_name_field"), window.game_name_field_edit)
    fields_group.setLayout(fields_layout)
    layout.addRow(fields_group)

    overwrite_group = window._create_group_box("Overwrite Settings")
    overwrite_layout = QFormLayout()
    overwrite_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "overwrite_audio"), window.overwrite_audio_check)
    overwrite_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "overwrite_picture"), window.overwrite_picture_check)
    overwrite_layout.addRow(window._create_labeled_widget(tabs_i18n, "anki", "overwrite_sentence"), window.overwrite_sentence_check)
    overwrite_group.setLayout(overwrite_layout)
    layout.addRow(overwrite_group)

    layout.addRow(window._create_labeled_widget(tabs_i18n, "advanced", "multiline_linebreak"), window.multi_line_line_break_edit)

    reset_widget = window._create_reset_button("anki", window._create_anki_general_tab)
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
