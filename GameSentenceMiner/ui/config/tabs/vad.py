from __future__ import annotations

from PyQt6.QtWidgets import QFormLayout, QHBoxLayout, QWidget
from typing import TYPE_CHECKING

from ..labels import LabelColor

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_vad_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    tabs_i18n = i18n.get("tabs", {})

    layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "do_postprocessing"), window.do_vad_postprocessing_check)

    models_group = window._create_group_box("VAD Models")
    models_layout = QFormLayout()
    models_layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "whisper_model"), window.whisper_model_combo)
    models_layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "selected_model"), window.selected_vad_model_combo)
    models_layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "backup_model"), window.backup_vad_model_combo)
    models_layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "use_cpu_for_inference"), window.use_cpu_for_inference_check)
    models_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "vad", "use_vad_filter_for_whisper"),
        window.use_vad_filter_for_whisper_check,
    )
    models_group.setLayout(models_layout)
    layout.addRow(models_group)

    trimming_group = window._create_group_box("Audio Trimming")
    trimming_layout = QFormLayout()
    trimming_layout.addRow(
        window._create_labeled_widget(tabs_i18n, "vad", "audio_end_offset", color=LabelColor.IMPORTANT, bold=True),
        window.end_offset_edit,
    )

    trim_begin_widget = QWidget()
    trim_begin_layout = QHBoxLayout(trim_begin_widget)
    trim_begin_layout.setContentsMargins(0, 0, 0, 0)
    trim_begin_layout.addWidget(window.vad_trim_beginning_check)
    trim_begin_layout.addWidget(window._create_labeled_widget(tabs_i18n, "vad", "beginning_offset"))
    trim_begin_layout.addWidget(window.vad_beginning_offset_edit)
    trim_begin_layout.addStretch()
    trimming_layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "trim_beginning"), trim_begin_widget)

    splice_widget = QWidget()
    splice_layout = QHBoxLayout(splice_widget)
    splice_layout.setContentsMargins(0, 0, 0, 0)
    splice_layout.addWidget(window.cut_and_splice_segments_check)
    splice_layout.addWidget(window._create_labeled_widget(tabs_i18n, "vad", "splice_padding"))
    splice_layout.addWidget(window.splice_padding_edit)
    splice_layout.addStretch()
    trimming_layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "cut_and_splice"), splice_widget)

    trimming_group.setLayout(trimming_layout)
    layout.addRow(trimming_group)

    layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "add_on_no_results"), window.add_audio_on_no_results_check)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "use_tts_as_fallback"), window.use_tts_as_fallback_check)
    layout.addRow(window._create_labeled_widget(tabs_i18n, "vad", "tts_url"), window.tts_url_edit)

    reset_widget = window._create_reset_button("vad", window._create_vad_tab)
    layout.addRow(reset_widget)
    return widget
