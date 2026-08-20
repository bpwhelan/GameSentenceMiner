import os
import numpy as np
import requests
import sys
import time
from html import escape
from PIL import Image
from PyQt6.QtCore import Qt, pyqtSignal, QTimer, QSize, QEventLoop
from PyQt6.QtGui import QPixmap, QImage
from PyQt6.QtWidgets import (
    QApplication,
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QTextEdit,
    QPushButton,
    QCheckBox,
    QGridLayout,
    QMessageBox,
    QWidget,
    QSizePolicy,
)
from urllib.parse import quote

from GameSentenceMiner.ui import window_state_manager, WindowId
from GameSentenceMiner.ui.audio_waveform_widget import AUDIO_EXPAND_SECONDS, AudioWaveformWidget
from GameSentenceMiner.replay_handler import request_dialogue_replay_refresh
from GameSentenceMiner.util.config.configuration import (
    get_config,
    logger,
    gsm_state,
    get_temporary_directory,
    save_current_config,
    reload_config,
)
from GameSentenceMiner.util.gsm_utils import (
    get_file_modification_time,
    make_unique_file_name,
    remove_html_and_cloze_tags,
    sanitize_filename,
)
from GameSentenceMiner.util.media.audio_player import AudioPlayer
from GameSentenceMiner.util.media.ffmpeg import get_audio_length, get_video_duration, splice_audio, trim_audio


# -------------------------------------------------------------------------
# Anki Confirmation Dialog
# -------------------------------------------------------------------------


class AspectRatioLabel(QLabel):
    HOVER_PREVIEW_SCALE = 2

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(1, 1)
        # Prefer a modest size and avoid uncontrolled expansion.
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)
        self._original_pixmap = None
        self._hover_preview = QLabel(None)
        self._hover_preview.setWindowFlags(Qt.WindowType.ToolTip | Qt.WindowType.FramelessWindowHint)
        self._hover_preview.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self._hover_preview.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self._hover_preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._hover_preview.setStyleSheet("background-color: #111; border: 1px solid #888; padding: 2px;")
        self._hover_preview.hide()

    def setPixmap(self, pixmap):
        self._original_pixmap = QPixmap(pixmap) if pixmap is not None else None
        super().setPixmap(self._scaled_pixmap())
        self.updateGeometry()  # Notify layout that sizeHint might have changed
        if self._hover_preview.isVisible():
            if self._original_pixmap is not None and not self._original_pixmap.isNull():
                self._show_hover_preview()
            else:
                self._hide_hover_preview()

    def resizeEvent(self, event):
        if self._original_pixmap is not None and not self._original_pixmap.isNull():
            super().setPixmap(self._scaled_pixmap())
        if self._hover_preview.isVisible():
            self._position_hover_preview()
        super().resizeEvent(event)

    def sizeHint(self):
        if self._original_pixmap is not None and not self._original_pixmap.isNull():
            # target a width of 320 for the hint, preserving aspect ratio
            # This ensures the layout allocates space for it by default
            w = 320
            h = int(self._original_pixmap.height() * w / self._original_pixmap.width())
            return QSize(w, h)
        return QSize(320, 180)

    def _scaled_pixmap(self):
        if self._original_pixmap is None or self._original_pixmap.isNull():
            return QPixmap()
        return self._original_pixmap.scaled(
            self.size(),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )

    def enterEvent(self, event):
        self._show_hover_preview()
        super().enterEvent(event)

    def leaveEvent(self, event):
        self._hide_hover_preview()
        super().leaveEvent(event)

    def hideEvent(self, event):
        self._hide_hover_preview()
        super().hideEvent(event)

    def _preview_max_size(self):
        max_size = self.maximumSize()
        # Qt uses a very large sentinel when max size is effectively unlimited.
        max_width = max_size.width() if max_size.width() < 16777215 else max(1, self.width())
        max_height = max_size.height() if max_size.height() < 16777215 else max(1, self.height())
        return QSize(
            max(1, int(max_width * self.HOVER_PREVIEW_SCALE)),
            max(1, int(max_height * self.HOVER_PREVIEW_SCALE)),
        )

    def _show_hover_preview(self):
        if self._original_pixmap is None or self._original_pixmap.isNull() or not self.isVisible():
            return

        preview_size = self._preview_max_size()
        preview_pixmap = self._original_pixmap.scaled(
            preview_size,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self._hover_preview.setPixmap(preview_pixmap)
        self._hover_preview.resize(preview_pixmap.size())
        self._position_hover_preview()
        self._hover_preview.show()

    def _position_hover_preview(self):
        preview_pixmap = self._hover_preview.pixmap()
        if preview_pixmap is None or preview_pixmap.isNull():
            return

        anchor = self.mapToGlobal(self.rect().topRight())
        x = anchor.x() + 10
        y = anchor.y()

        screen = QApplication.primaryScreen()
        if screen:
            available = screen.availableGeometry()
            if x + self._hover_preview.width() > available.right():
                x = self.mapToGlobal(self.rect().topLeft()).x() - self._hover_preview.width() - 10
            if y + self._hover_preview.height() > available.bottom():
                y = available.bottom() - self._hover_preview.height()
            x = max(available.left(), x)
            y = max(available.top(), y)

        self._hover_preview.move(x, y)

    def _hide_hover_preview(self):
        if self._hover_preview.isVisible():
            self._hover_preview.hide()


_anki_confirmation_dialog_instance = None

AUTO_ADD_DIALOGUE_LINE_EPSILON_SECONDS = 0.05
AUTO_ADD_DIALOGUE_LINE_DEBOUNCE_MS = 175
AUDIO_PLAYBACK_END_EPSILON_SECONDS = 0.03
CONFIRMATION_CANCEL_ACTION_KEY = "cancel_action"
CONFIRMATION_CANCEL_ACTION_DELETE_CARD = "delete_card"
EXIT_CHOICE_DISCARD = "discard"
EXIT_CHOICE_DELETE_CARD = "delete_card"
EXIT_CHOICE_CANCEL = "cancel"


class AnkiConfirmationDialog(QDialog):
    audio_finished_signal = pyqtSignal()
    WINDOW_ID = "anki_confirmation_dialog"

    # UPDATE 1: Accept parent=None
    def __init__(self, parent=None):
        super().__init__(parent)

        # State placeholders
        self.screenshot_timestamp = 0
        self.previous_screenshot_timestamp = 0
        self.screenshot_path = None
        self.previous_screenshot_path = None
        self.audio_path = None
        self.vad_result = None
        self.reusing_audio = False
        self.reusing_screenshot = False
        self.result = None
        self.first_launch = True
        self._force_autoplay = False
        self._audio_edit_context = None
        self._audio_edit_source_path = None
        self._audio_edit_source_duration = 0.0
        self._audio_edit_source_window = None
        self._audio_edit_range = None
        self._audio_edit_rebase_on_selection_trim = False
        self._has_performed_audio_expand = False
        self._playback_resume_position = None
        self._playback_start_offset = 0.0
        self._playback_cut_ranges = []
        self._playing_full_audio = False
        self._replay_context = None
        self._dialog_selected_lines = []
        self._dialog_original_selected_line_ids = ()
        self._dialog_line_selection_changed = False
        self._dialog_audio_result = None
        self._dialog_translation_regenerated = False
        self._dialogue_line_update_in_progress = False
        self._dialogue_line_start_cache = {}
        self._replay_video_duration = 0.0
        self._replay_file_mod_time = None
        self._pending_auto_line_direction = None
        self._dialogue_neighbor_signature = None
        self._dialogue_replay_future = None
        self._dialogue_replay_selected_lines = None
        self._exit_confirmed = False
        self._rejected_cleanup_done = False

        # Auto-accept timer
        self._auto_accept_qtimer = None
        self._auto_accept_countdown_timer = None
        self._auto_accept_remaining = 0
        self.auto_accept_label = None

        # Audio player
        self.audio_player = AudioPlayer(finished_callback=self._audio_finished)
        self.audio_finished_signal.connect(self._update_audio_buttons)
        self._translation_future = None
        self._translation_pending = False
        self._translation_poll_timer = QTimer(self)
        self._translation_poll_timer.setInterval(100)
        self._translation_poll_timer.timeout.connect(self._poll_translation_future)

        self.playback_timer = QTimer(self)
        self.playback_timer.timeout.connect(self._update_playback_cursor)
        self.playback_timer.setInterval(20)  # Update every 20ms for better precision

        # Autoplay debounce timer for trim updates
        self._trim_autoplay_timer = QTimer(self)
        self._trim_autoplay_timer.setSingleShot(True)
        self._trim_autoplay_timer.setInterval(500)  # Wait 500ms after trim stops changing
        self._trim_autoplay_timer.timeout.connect(self._play_range)

        self._auto_line_expand_timer = QTimer(self)
        self._auto_line_expand_timer.setSingleShot(True)
        self._auto_line_expand_timer.setInterval(AUTO_ADD_DIALOGUE_LINE_DEBOUNCE_MS)
        self._auto_line_expand_timer.timeout.connect(self._apply_pending_auto_line_expand)

        self._dialogue_line_poll_timer = QTimer(self)
        self._dialogue_line_poll_timer.setInterval(250)
        self._dialogue_line_poll_timer.timeout.connect(self._poll_dialogue_line_neighbors)

        self._dialogue_replay_poll_timer = QTimer(self)
        self._dialogue_replay_poll_timer.setInterval(100)
        self._dialogue_replay_poll_timer.timeout.connect(self._poll_dialogue_replay_refresh)

        self.setWindowTitle("Confirm Anki Card Details")
        self._apply_window_behavior_preferences()
        self.setModal(True)
        self.setMinimumSize(500, 600)

        self._init_ui()

    def _init_ui(self):
        # Top-level layout
        dialog_layout = QVBoxLayout(self)
        dialog_layout.setContentsMargins(8, 8, 8, 8)
        dialog_layout.setSpacing(4)

        self.auto_accept_label = QLabel()
        self.auto_accept_label.setStyleSheet("color: #007bff; font-weight: bold; font-size: 14px;")
        self.auto_accept_label.setVisible(False)
        dialog_layout.addWidget(self.auto_accept_label, alignment=Qt.AlignmentFlag.AlignCenter)

        self.grid_layout = QGridLayout()
        self.grid_layout.setSpacing(4)
        # Allow rows to shrink/grow
        self.grid_layout.setColumnStretch(1, 1)
        row = 0

        # 1. Expression
        self.expr_label_title = QLabel(f"{get_config().anki.word_field}:")
        self.expr_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(
            self.expr_label_title,
            row,
            0,
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight,
        )

        self.expr_value_label = QLabel()
        self.expr_value_label.setWordWrap(True)
        # Removed fixed max width to allow resizing
        self.grid_layout.addWidget(self.expr_value_label, row, 1)
        row += 1

        # 2. Sentence
        self.sentence_label_title = QLabel(f"{get_config().anki.sentence_field}:")
        self.sentence_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(
            self.sentence_label_title,
            row,
            0,
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight,
        )

        self.sentence_text = QTextEdit()
        # Keep the edit compact and avoid scrollbars
        self.sentence_text.setFixedHeight(64)
        self.sentence_text.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.sentence_text.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.sentence_text.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.sentence_text.setTabChangesFocus(True)
        self.sentence_text.textChanged.connect(self._cancel_auto_accept)
        self.grid_layout.addWidget(self.sentence_text, row, 1)
        row += 1

        self.dialogue_timeline = QLabel()
        self.dialogue_timeline.setWordWrap(True)
        self.dialogue_timeline.setTextFormat(Qt.TextFormat.RichText)
        self.dialogue_timeline.setStyleSheet(
            "background: palette(alternate-base); border: 1px solid palette(mid); border-radius: 6px; padding: 6px;"
        )
        self.grid_layout.addWidget(self.dialogue_timeline, row, 1, 1, 2)
        row += 1

        self.dialogue_tools_title = QLabel("Dialogue:")
        self.dialogue_tools_title.setStyleSheet("font-weight: bold; color: #ff8c00;")
        self.grid_layout.addWidget(
            self.dialogue_tools_title,
            row,
            0,
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight,
        )

        dialogue_tools_container = QWidget()
        dialogue_tools_layout = QHBoxLayout(dialogue_tools_container)
        dialogue_tools_layout.setContentsMargins(0, 0, 0, 0)
        dialogue_tools_layout.setSpacing(6)

        self.add_prev_line_button = QPushButton("Add Prev Line")
        self.add_prev_line_button.clicked.connect(self._cancel_auto_accept)
        self.add_prev_line_button.clicked.connect(self._add_previous_dialogue_line)
        dialogue_tools_layout.addWidget(self.add_prev_line_button)

        self.add_next_line_button = QPushButton("Add Next Line")
        self.add_next_line_button.clicked.connect(self._cancel_auto_accept)
        self.add_next_line_button.clicked.connect(self._add_next_dialogue_line)
        dialogue_tools_layout.addWidget(self.add_next_line_button)

        self.regen_translation_checkbox = QCheckBox("Regenerate SentenceMeaning")
        self.regen_translation_checkbox.setChecked(True)
        self.regen_translation_checkbox.stateChanged.connect(self._cancel_auto_accept)
        dialogue_tools_layout.addWidget(self.regen_translation_checkbox)

        self.dialogue_tools_status = QLabel("")
        self.dialogue_tools_status.setStyleSheet("color: #666; font-style: italic;")
        dialogue_tools_layout.addWidget(self.dialogue_tools_status)
        dialogue_tools_layout.addStretch()

        self.grid_layout.addWidget(dialogue_tools_container, row, 1, 1, 2)
        row += 1

        # 3. Translation
        self.translation_label_title = QLabel(f"{get_config().ai.anki_field}:")
        self.translation_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(
            self.translation_label_title,
            row,
            0,
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight,
        )

        self.translation_text = QTextEdit()
        self.translation_text.setFixedHeight(64)
        self.translation_text.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.translation_text.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.translation_text.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.translation_text.setTabChangesFocus(True)
        self.translation_text.textChanged.connect(self._cancel_auto_accept)
        self.translation_text.textChanged.connect(self._translation_text_edited)
        self.grid_layout.addWidget(self.translation_text, row, 1)
        row += 1

        # 4. Screenshot
        self.screenshot_label_title = QLabel(f"{get_config().anki.picture_field}:")
        self.screenshot_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(
            self.screenshot_label_title,
            row,
            0,
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight,
        )

        self.image_label = AspectRatioLabel()
        self.image_label.setMinimumSize(QSize(140, 80))
        self.image_label.setMaximumSize(QSize(360, 200))
        self.grid_layout.addWidget(self.image_label, row, 1)

        self.screenshot_button = QPushButton("Select New Screenshot")
        self.screenshot_button.clicked.connect(self._cancel_auto_accept)
        self.screenshot_button.clicked.connect(lambda: self._select_screenshot(previous=False))
        self.grid_layout.addWidget(self.screenshot_button, row, 2, Qt.AlignmentFlag.AlignLeft)
        row += 1

        self.animated_audio_notice_label = QLabel(
            "Heads up: adding audio padding regenerates the AVIF; trimming shorter reuses the background render."
        )
        self.animated_audio_notice_label.setStyleSheet("color: #856404; font-size: 11px;")
        self.animated_audio_notice_label.setWordWrap(True)
        self.animated_audio_notice_label.setVisible(False)
        self.grid_layout.addWidget(self.animated_audio_notice_label, row, 1, 1, 2)
        row += 1

        # 5. Previous Screenshot
        self.prev_screenshot_label_title = QLabel(f"{get_config().anki.previous_image_field}:")
        self.prev_screenshot_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(
            self.prev_screenshot_label_title,
            row,
            0,
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight,
        )

        self.prev_image_label = AspectRatioLabel()
        self.prev_image_label.setMinimumSize(QSize(140, 80))
        self.prev_image_label.setMaximumSize(QSize(360, 200))
        self.grid_layout.addWidget(self.prev_image_label, row, 1)

        self.prev_screenshot_button = QPushButton("Select New Previous Screenshot")
        self.prev_screenshot_button.clicked.connect(self._cancel_auto_accept)
        self.prev_screenshot_button.clicked.connect(lambda: self._select_screenshot(previous=True))
        self.grid_layout.addWidget(self.prev_screenshot_button, row, 2, Qt.AlignmentFlag.AlignLeft)
        row += 1

        # 6. Audio
        self.audio_label_title = QLabel("Audio:")
        self.audio_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(
            self.audio_label_title,
            row,
            0,
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight,
        )

        # Container for audio controls
        audio_container = QWidget()
        audio_layout = QVBoxLayout(audio_container)
        audio_layout.setContentsMargins(0, 0, 0, 0)

        self.audio_status_label = QLabel()
        audio_layout.addWidget(self.audio_status_label)

        # Codec compatibility info label
        self.codec_info_label = QLabel()
        self.codec_info_label.setStyleSheet(
            "color: #856404; background-color: #fff3cd; padding: 5px; border-radius: 3px; font-weight: bold;"
        )
        self.codec_info_label.setWordWrap(True)
        self.codec_info_label.setVisible(False)
        audio_layout.addWidget(self.codec_info_label)

        self.waveform_widget = AudioWaveformWidget()
        self.waveform_widget.setMinimumHeight(54)
        self.waveform_widget.setMaximumHeight(92)
        self.waveform_widget.set_dark_mode()
        # Connect range change to cancel auto accept
        self.waveform_widget.range_changed.connect(lambda _s, _e: self._cancel_auto_accept())
        # Handle start/end handle moves specifically
        self.waveform_widget.handle_moved.connect(self._on_handle_moved)
        self.waveform_widget.seek_requested.connect(self._seek_audio)
        self.waveform_widget.cut_ranges_changed.connect(self._on_cut_ranges_changed)
        self.waveform_widget.expand_start_requested.connect(self._cancel_auto_accept)
        self.waveform_widget.expand_start_requested.connect(self._expand_audio_start)
        self.waveform_widget.expand_end_requested.connect(self._cancel_auto_accept)
        self.waveform_widget.expand_end_requested.connect(self._expand_audio_end)
        audio_layout.addWidget(self.waveform_widget)

        # Audio controls
        audio_controls = QHBoxLayout()

        self.audio_button = QPushButton("▶ Play Range")
        self.audio_button.clicked.connect(self._cancel_auto_accept)
        self.audio_button.clicked.connect(self._play_range)
        audio_controls.addWidget(self.audio_button)

        self.play_original_button = QPushButton("▶ Play Full")
        self.play_original_button.clicked.connect(self._cancel_auto_accept)
        self.play_original_button.clicked.connect(lambda: self._play_audio(self.audio_path, full=True))
        audio_controls.addWidget(self.play_original_button)

        self.cut_audio_button = QPushButton("✂ Add Cut")
        self.cut_audio_button.setCheckable(True)
        self.cut_audio_button.setToolTip(
            "Select this, then drag over unwanted audio. You can also hold Shift and drag without selecting the button."
        )
        self.cut_audio_button.toggled.connect(self._toggle_cut_mode)
        self.cut_audio_button.clicked.connect(self._cancel_auto_accept)
        audio_controls.addWidget(self.cut_audio_button)

        self.undo_audio_cut_button = QPushButton("Undo Cut")
        self.undo_audio_cut_button.setToolTip("Restore the most recently marked section.")
        self.undo_audio_cut_button.clicked.connect(self.waveform_widget.undo_last_cut)
        self.undo_audio_cut_button.clicked.connect(self._cancel_auto_accept)
        self.undo_audio_cut_button.setEnabled(False)
        audio_controls.addWidget(self.undo_audio_cut_button)

        self.reset_audio_button = QPushButton("Reset Edits")
        self.reset_audio_button.clicked.connect(self._reset_audio_trim)
        self.reset_audio_button.clicked.connect(self._cancel_auto_accept)
        audio_controls.addWidget(self.reset_audio_button)

        audio_controls.addStretch()
        audio_layout.addLayout(audio_controls)

        self.cut_status_label = QLabel()
        self.cut_status_label.setStyleSheet("color: #ffb3ad;")
        self.cut_status_label.setVisible(False)
        audio_layout.addWidget(self.cut_status_label)

        self.grid_layout.addWidget(audio_container, row, 1, 1, 2)
        row += 1

        # 7. TTS
        self.tts_container = QWidget()
        self.tts_button = QPushButton("🔊 Generate TTS Audio")
        self.tts_button.clicked.connect(self._cancel_auto_accept)
        self.tts_button.clicked.connect(self._generate_tts_audio)
        self.tts_button.setMaximumWidth(180)
        self.grid_layout.addWidget(self.tts_button, row, 1, Qt.AlignmentFlag.AlignLeft)

        self.tts_status_label = QLabel("")
        self.grid_layout.addWidget(self.tts_status_label, row, 2, Qt.AlignmentFlag.AlignLeft)
        row += 1

        dialog_layout.addLayout(self.grid_layout)

        # NSFW Tag
        checkbox_layout = QHBoxLayout()

        self.nsfw_tag_checkbox = QCheckBox("Add NSFW tag?")
        self.nsfw_tag_checkbox.stateChanged.connect(self._cancel_auto_accept)
        checkbox_layout.addWidget(self.nsfw_tag_checkbox)

        self.autoplay_checkbox = QCheckBox("Autoplay Audio")
        self.autoplay_checkbox.stateChanged.connect(self._on_autoplay_toggled)
        checkbox_layout.addWidget(self.autoplay_checkbox)

        self.disable_session_checkbox = QCheckBox("Disable for this session")
        self.disable_session_checkbox.stateChanged.connect(self._on_disable_session_toggled)
        checkbox_layout.addWidget(self.disable_session_checkbox)

        checkbox_layout.addStretch()
        checkbox_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        dialog_layout.addLayout(checkbox_layout)
        # dialog_layout.addStretch() # Don't add stretch, let widgets expand/contract

        # Action Buttons
        button_container = QWidget()
        button_layout = QHBoxLayout(button_container)
        button_layout.setContentsMargins(16, 8, 16, 12)
        button_layout.setSpacing(8)

        self.voice_button = QPushButton("Keep Audio")
        self.voice_button.clicked.connect(self._on_voice)
        self.voice_button.clicked.connect(self._cancel_auto_accept)
        self.voice_button.setStyleSheet("background-color: #28a745; color: white; padding: 8px 20px;")
        button_layout.addWidget(self.voice_button)

        self.no_voice_button = QPushButton("No Audio")
        self.no_voice_button.clicked.connect(self._on_no_voice)
        self.no_voice_button.clicked.connect(self._cancel_auto_accept)
        self.no_voice_button.setStyleSheet("background-color: #dc3545; color: white; padding: 8px 20px;")
        button_layout.addWidget(self.no_voice_button)

        self.confirm_button = QPushButton("Confirm")
        self.confirm_button.clicked.connect(self._on_no_voice)
        self.confirm_button.clicked.connect(self._cancel_auto_accept)
        self.confirm_button.setStyleSheet("background-color: #007bff; color: white; padding: 8px 20px;")
        button_layout.addWidget(self.confirm_button)

        # NOTE: You commented this out, so it doesn't exist!
        # self.disable_dialog_checkbox = QCheckBox("Disable this dialogue")
        # self.disable_dialog_checkbox.stateChanged.connect(self._cancel_auto_accept)
        # button_layout.addWidget(self.disable_dialog_checkbox, alignment=Qt.AlignmentFlag.AlignLeft)

        dialog_layout.addWidget(button_container)

        self.setLayout(dialog_layout)

    def populate_ui(
        self,
        expression,
        sentence,
        screenshot_path,
        previous_screenshot_path,
        audio_path,
        translation,
        screenshot_timestamp,
        previous_screenshot_timestamp,
        pending_animated=False,
        translation_future=None,
        reusing_audio=False,
        reusing_screenshot=False,
    ):
        self._apply_window_behavior_preferences()

        # Store state
        self.screenshot_timestamp = screenshot_timestamp
        self.previous_screenshot_timestamp = previous_screenshot_timestamp
        self.screenshot_path = screenshot_path
        self.previous_screenshot_path = previous_screenshot_path
        self.vad_result = gsm_state.vad_result
        self.reusing_audio = bool(reusing_audio)
        self.reusing_screenshot = bool(reusing_screenshot)
        self.result = None
        self.pending_animated = pending_animated
        self._audio_edit_context = None
        self._audio_edit_source_path = None
        self._audio_edit_source_duration = 0.0
        self._audio_edit_source_window = None
        self._audio_edit_range = None
        self._audio_edit_rebase_on_selection_trim = False
        self._has_performed_audio_expand = False
        self._playback_resume_position = None
        self._playback_start_offset = 0.0
        self._playback_cut_ranges = []
        self._playing_full_audio = False
        self.cut_audio_button.setChecked(False)
        self._replay_context = gsm_state.current_replay_context
        self._dialog_selected_lines = self._dialogue_lines_from_context(self._replay_context)
        self._dialog_original_selected_line_ids = self._line_ids_for_dialogue(self._dialog_selected_lines)
        self._dialog_line_selection_changed = False
        self._dialog_audio_result = self._replay_context.audio_result if self._replay_context else None
        self._dialog_translation_regenerated = False
        self._dialogue_line_update_in_progress = False
        self._dialogue_line_start_cache = {}
        self._replay_video_duration = 0.0
        self._replay_file_mod_time = None
        self._pending_auto_line_direction = None
        self._dialogue_neighbor_signature = None
        self._dialogue_replay_future = None
        self._dialogue_replay_selected_lines = None
        self._exit_confirmed = False
        self._rejected_cleanup_done = False
        self._auto_line_expand_timer.stop()
        self._initialize_dialogue_line_timeline()
        if self._dialogue_line_expansion_enabled():
            self._dialogue_line_poll_timer.start()
        else:
            self._dialogue_line_poll_timer.stop()

        self.expr_value_label.setText(expression)

        self.sentence_text.blockSignals(True)
        self.sentence_text.setPlainText(sentence)
        self.sentence_text.blockSignals(False)

        self.nsfw_tag_checkbox.setChecked(False)
        self.regen_translation_checkbox.blockSignals(True)
        self.regen_translation_checkbox.setChecked(True)
        self.regen_translation_checkbox.blockSignals(False)
        self.autoplay_checkbox.blockSignals(True)
        self.autoplay_checkbox.setChecked(get_config().anki.autoplay_audio)
        self.autoplay_checkbox.blockSignals(False)

        self.disable_session_checkbox.setChecked(gsm_state.disable_anki_confirmation_session)

        # UPDATE 2: Comment out access to the missing checkbox
        # self.disable_dialog_checkbox.setChecked(False)

        # Handle Audio Path
        self.audio_path = None if self.reusing_audio else audio_path
        if not self.audio_path and self.vad_result:
            self.audio_path = self.vad_result.trimmed_audio_path
        if self.reusing_audio:
            self.audio_path = None
        self._load_audio_edit_context(gsm_state.audio_edit_context)

        # Translation
        self._translation_future = translation_future
        self._translation_pending = bool(translation_future is not None and not translation)
        self._translation_poll_timer.stop()
        has_translation = bool(translation) or self._translation_pending
        self.translation_label_title.setVisible(has_translation)
        self.translation_text.setVisible(has_translation)
        self.translation_text.setPlaceholderText("Translating…" if self._translation_pending else "")
        self.translation_text.blockSignals(True)
        self.translation_text.setPlainText(translation or "")
        self.translation_text.blockSignals(False)
        if has_translation:
            if self._translation_pending:
                self._translation_poll_timer.start()

        if self.reusing_screenshot:
            self.image_label.setPixmap(QPixmap())
            self.image_label.setText("Reusing screenshot from the previous mining operation.")
            self.image_label.setStyleSheet("color: green; font-weight: bold;")
        else:
            self._load_image_to_label(self.screenshot_path, self.image_label)

        # Show animated screenshot status if pending
        if self.reusing_screenshot:
            self.screenshot_button.setText("Reusing screenshot")
            self.screenshot_button.setStyleSheet("color: green; font-weight: bold;")
            self.screenshot_button.setEnabled(False)
        elif pending_animated:
            self.screenshot_button.setText("🎬 Animated (generating after confirmation)")
            self.screenshot_button.setStyleSheet("color: #ff8c00; font-weight: bold;")
            self.screenshot_button.setEnabled(False)
        else:
            self.screenshot_button.setText("Select New Screenshot")
            self.screenshot_button.setStyleSheet("")
            self.screenshot_button.setEnabled(True)
        animated_extension = getattr(get_config().screenshot.animated_settings, "extension", "").lower()
        self.animated_audio_notice_label.setVisible(bool(pending_animated and animated_extension == "avif"))

        use_prev_image = bool(self.previous_screenshot_path and get_config().anki.previous_image_field)
        self.prev_screenshot_label_title.setVisible(use_prev_image)
        self.prev_image_label.setVisible(use_prev_image)
        self.prev_screenshot_button.setVisible(use_prev_image)
        if use_prev_image:
            self._load_image_to_label(self.previous_screenshot_path, self.prev_image_label)
        self._refresh_audio_controls(sentence)
        self._update_dialogue_line_controls(has_translation=has_translation)

        self._configure_tab_order()

    def _poll_translation_future(self):
        future = self._translation_future
        if not self._translation_pending or future is None:
            self._translation_poll_timer.stop()
            return
        if not future.done():
            return

        self._translation_poll_timer.stop()
        try:
            translation = future.result()
        except Exception as e:
            logger.exception(f"Failed loading prefetched translation in confirmation dialog: {e}")
            translation = ""

        self._translation_pending = False
        self.translation_text.setPlaceholderText("")
        if translation and not self.translation_text.toPlainText().strip():
            self.translation_text.blockSignals(True)
            self.translation_text.setPlainText(translation)
            self.translation_text.blockSignals(False)

    def _translation_text_edited(self):
        # A user's edit wins over a late external-service response.
        if self._translation_pending:
            self._translation_pending = False
            self._translation_poll_timer.stop()
            self.translation_text.setPlaceholderText("")

    def _load_image_to_label(self, path, label_widget):
        label_widget.setStyleSheet("")
        if not path or not os.path.exists(path):
            label_widget.setPixmap(QPixmap())
            label_widget.setText("Image not found")
            return

        try:
            img = Image.open(path)
            # Increase thumbnail size since it can be resized dynamically
            # img.thumbnail((1280, 720))
            if img.mode in ("RGBA", "LA", "P"):
                if img.mode == "P":
                    img = img.convert("RGBA")
                rgb_img = Image.new("RGB", img.size, (255, 255, 255))
                rgb_img.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
                img = rgb_img

            img_data = img.tobytes("raw", "RGB")
            qimage = QImage(
                img_data,
                img.width,
                img.height,
                img.width * 3,
                QImage.Format.Format_RGB888,
            )
            pixmap = QPixmap.fromImage(qimage)
            label_widget.setPixmap(pixmap)
        except Exception as e:
            label_widget.setPixmap(QPixmap())
            label_widget.setText(f"Could not load image:\n{e}")
            label_widget.setStyleSheet("color: red;")

    def _apply_window_behavior_preferences(self):
        anki_config = get_config().anki
        focus_on_show = self._should_focus_on_show()
        flags = (
            Qt.WindowType.Dialog
            | Qt.WindowType.WindowSystemMenuHint
            | Qt.WindowType.WindowMinimizeButtonHint
            | Qt.WindowType.WindowMaximizeButtonHint
            | Qt.WindowType.WindowCloseButtonHint
        )
        if getattr(anki_config, "confirmation_always_on_top", True):
            flags |= Qt.WindowType.WindowStaysOnTopHint
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, not focus_on_show)
        self.setWindowFlags(flags)

    def _should_focus_on_show(self):
        return bool(getattr(get_config().anki, "confirmation_focus_on_show", True))

    def showEvent(self, event):
        if self.first_launch:
            restored = window_state_manager.restore_geometry(self, WindowId.ANKI_CONFIRMATION)
            if not restored:
                self._center_on_screen()
            self.first_launch = False
        super().showEvent(event)

        if self._should_focus_on_show():
            self.raise_()
            self.activateWindow()
            self.setFocus(Qt.FocusReason.OtherFocusReason)

        if get_config().anki.auto_accept_timer > 0:
            self._cancel_auto_accept()
            self._auto_accept_remaining = int(get_config().anki.auto_accept_timer)
            self.auto_accept_label.setVisible(True)
            self.auto_accept_label.setText(f"Auto-accepting in {self._auto_accept_remaining} seconds...")

            self._auto_accept_qtimer = QTimer(self)
            self._auto_accept_qtimer.setSingleShot(True)
            self._auto_accept_qtimer.timeout.connect(self._auto_accept_action)
            self._auto_accept_qtimer.start(int(get_config().anki.auto_accept_timer * 1000))

            self._auto_accept_countdown_timer = QTimer(self)
            self._auto_accept_countdown_timer.setSingleShot(False)
            self._auto_accept_countdown_timer.timeout.connect(self._update_auto_accept_countdown)
            self._auto_accept_countdown_timer.start(1000)
        else:
            self.auto_accept_label.setVisible(False)

        if get_config().anki.autoplay_audio and self.audio_path and os.path.exists(self.audio_path):
            # Use QTimer to delay slightly to ensure window is ready/rendered
            QTimer.singleShot(100, self._play_range)

    def _cancel_auto_accept(self):
        if self._auto_accept_qtimer and self._auto_accept_qtimer.isActive():
            self._auto_accept_qtimer.stop()
        if self._auto_accept_countdown_timer and self._auto_accept_countdown_timer.isActive():
            self._auto_accept_countdown_timer.stop()
        if self.auto_accept_label:
            self.auto_accept_label.setText("Auto accept cancelled.")

    def _update_auto_accept_countdown(self):
        self._auto_accept_remaining -= 1
        if self._auto_accept_remaining > 0:
            self.auto_accept_label.setText(f"Auto-accepting in {self._auto_accept_remaining} seconds...")
        else:
            self.auto_accept_label.setText("Auto-accepting...")
            if self._auto_accept_countdown_timer:
                self._auto_accept_countdown_timer.stop()

    def _auto_accept_action(self):
        if not self.isVisible():
            return
        self._cancel_auto_accept()
        vad_ran = self.vad_result is not None and hasattr(self.vad_result, "success")
        vad_detected_voice = vad_ran and bool(self.vad_result.success)
        if vad_detected_voice:
            self._on_voice()
        else:
            self._on_no_voice()

    def _on_autoplay_toggled(self, checked):
        config = get_config()
        config.anki.autoplay_audio = checked
        save_current_config(config)
        if checked:
            QTimer.singleShot(100, self._play_range)

    def _on_disable_session_toggled(self, state):
        gsm_state.disable_anki_confirmation_session = state == Qt.CheckState.Checked.value

    def _on_handle_moved(self, which, start, end):
        self._sync_audio_edit_selection_to_current_clip(start, end)
        self._update_audio_expand_buttons()
        if which == "start":
            self._playback_resume_position = start
            self.waveform_widget.set_playback_position(start)
            # Stop audio and force restart (debounced)
            self.audio_player.stop_audio()
            # Force autoplay even if checkbox is off, per user request
            self._force_autoplay = True
            self._trim_autoplay_timer.start()
        elif which == "end":
            # Do NOT stop audio immediately.
            # Do NOT trigger autoplay timer.
            # Logic in _update_playback_cursor will handle stopping if we pass the new end.
            if self.autoplay_checkbox.isChecked():
                pass  # Explicitly ignore autoplay for end trim changes to avoid restarts

    def _toggle_cut_mode(self, enabled):
        self.waveform_widget.set_cut_mode(enabled)
        self._update_cut_controls()

    def _on_cut_ranges_changed(self, _cut_ranges):
        self._cancel_auto_accept()
        was_playing = self.audio_player.is_playing
        current_position = self._current_source_playback_position()
        if was_playing:
            self.audio_player.stop_audio()
            self.playback_timer.stop()

        position = self._normalize_audio_seek_position(current_position)
        self._playback_resume_position = position
        self.waveform_widget.set_playback_position(position)
        self._update_cut_controls()

        if was_playing and position < self.waveform_widget.end_time:
            self._start_range_playback(position)
        else:
            self._update_audio_buttons()

    def _update_cut_controls(self):
        cut_ranges = self.waveform_widget.get_cut_ranges()
        cut_count = len(cut_ranges)
        cut_duration = sum(end - start for start, end in cut_ranges)
        is_selecting = self.cut_audio_button.isChecked()

        self.cut_audio_button.setText("✂ Finish Cutting" if is_selecting else "✂ Add Cut")
        self.undo_audio_cut_button.setEnabled(bool(cut_ranges))
        if is_selecting:
            status = "Drag over unwanted audio. Drag again to mark another section. Shift+drag also works anytime."
        elif cut_count:
            noun = "section" if cut_count == 1 else "sections"
            status = f"{cut_count} {noun} marked ({cut_duration:.2f}s removed). Playback previews the edit."
        else:
            status = ""
        self.cut_status_label.setText(status)
        self.cut_status_label.setVisible(bool(status))

    def _center_on_screen(self):
        screen = QApplication.primaryScreen()
        if screen:
            screen_geometry = screen.geometry()
            dialog_geometry = self.frameGeometry()
            center_point = screen_geometry.center()
            dialog_geometry.moveCenter(center_point)
            new_x = dialog_geometry.topLeft().x()
            new_y = screen_geometry.top() + 50
            self.move(new_x, new_y)

    def _is_unsupported_audio_codec(self, audio_path):
        """
        Check if the audio file has an unsupported codec for manual trimming.
        Supported: opus, ogg, mp3
        Unsupported: aac, m4a
        """
        if not audio_path or not os.path.isfile(audio_path):
            return False, None

        ext = os.path.splitext(audio_path)[1].lower()
        unsupported_codecs = [".aac", ".m4a"]

        if ext in unsupported_codecs:
            return True, ext[1:].upper()  # Return codec name without dot, uppercase

        return False, None

    def _configure_tab_order(self):
        tab_sequence = [self.sentence_text]
        if self.add_prev_line_button.isVisible():
            tab_sequence.append(self.add_prev_line_button)
        if self.add_next_line_button.isVisible():
            tab_sequence.append(self.add_next_line_button)
        if self.regen_translation_checkbox.isVisible():
            tab_sequence.append(self.regen_translation_checkbox)
        if self.translation_text.isVisible():
            tab_sequence.append(self.translation_text)
        tab_sequence.append(self.screenshot_button)
        if self.prev_screenshot_button.isVisible():
            tab_sequence.append(self.prev_screenshot_button)
        if self.audio_button.isVisible():
            tab_sequence.append(self.audio_button)
        if self.waveform_widget.expand_start_button.isVisible():
            tab_sequence.append(self.waveform_widget.expand_start_button)
        if self.waveform_widget.expand_end_button.isVisible():
            tab_sequence.append(self.waveform_widget.expand_end_button)
        if self.tts_button.isVisible():
            tab_sequence.append(self.tts_button)
        tab_sequence.append(self.nsfw_tag_checkbox)
        tab_sequence.append(self.autoplay_checkbox)
        if self.voice_button.isVisible():
            tab_sequence.append(self.voice_button)
            tab_sequence.append(self.no_voice_button)
        elif self.confirm_button.isVisible():
            tab_sequence.append(self.confirm_button)
        for i in range(len(tab_sequence) - 1):
            self.setTabOrder(tab_sequence[i], tab_sequence[i + 1])

    def _select_screenshot(self, previous: bool = False):
        from GameSentenceMiner.ui.qt_main import launch_screenshot_selector

        video_path = gsm_state.current_replay
        self._cancel_auto_accept()
        timestamp = self.previous_screenshot_timestamp if previous else self.screenshot_timestamp
        selected_path = launch_screenshot_selector(
            video_path,
            timestamp,
            mode=get_config().screenshot.screenshot_timing_setting,
        )
        if not selected_path:
            return
        target_attr = "previous_screenshot_path" if previous else "screenshot_path"
        label_widget = self.prev_image_label if previous else self.image_label
        setattr(self, target_attr, selected_path)
        self._load_image_to_label(selected_path, label_widget)

    @staticmethod
    def _dialogue_lines_from_context(context):
        if not context:
            return []
        if getattr(context, "selected_lines", None):
            return list(context.selected_lines)
        if getattr(context, "mined_line", None):
            return [context.mined_line]
        return []

    @staticmethod
    def _line_ids_for_dialogue(lines):
        return tuple(line.id for line in lines if line)

    def _selected_lines_for_pipeline(self):
        if not self._dialog_selected_lines:
            return []
        if (
            len(self._dialog_selected_lines) == 1
            and self._replay_context
            and getattr(self._replay_context, "mined_line", None)
            and self._dialog_selected_lines[0].id == self._replay_context.mined_line.id
        ):
            return []
        return list(self._dialog_selected_lines)

    def _dialogue_line_expansion_enabled(self):
        return bool(
            self._replay_context and getattr(self._replay_context, "video_path", None) and self._dialog_selected_lines
        )

    def _initialize_dialogue_line_timeline(self):
        if not self._dialogue_line_expansion_enabled():
            return

        try:
            self._replay_video_duration = get_video_duration(self._replay_context.video_path)
        except Exception as e:
            logger.debug(f"Failed to probe replay duration for dialogue expansion: {e}")
            self._replay_video_duration = 0.0

        try:
            self._replay_file_mod_time = self._replay_context.anki_card_creation_time or get_file_modification_time(
                self._replay_context.video_path
            )
        except Exception as e:
            logger.debug(f"Failed to resolve replay timestamp for dialogue expansion: {e}")
            self._replay_file_mod_time = None

    def _previous_dialogue_line(self):
        if not self._dialog_selected_lines:
            return None
        return self._dialog_selected_lines[0].prev

    def _next_dialogue_line(self):
        if not self._dialog_selected_lines:
            return None
        # GameLine.next_line() intentionally hides lines which arrived after the
        # mining timestamp. The confirmation timeline is the one place where we
        # explicitly want to reveal that live neighbor.
        return getattr(self._dialog_selected_lines[-1], "next", None)

    @staticmethod
    def _timeline_line_text(line):
        text = str(getattr(line, "text", "") or "").strip()
        return escape(text or "(empty line)")

    def _refresh_dialogue_timeline(self):
        feature_enabled = self._dialogue_line_expansion_enabled()
        self.dialogue_timeline.setVisible(feature_enabled)
        if not feature_enabled:
            return

        rows = []
        previous_line = self._previous_dialogue_line()
        next_line = self._next_dialogue_line()
        if previous_line:
            rows.append(
                '<div style="color:#888"><span style="color:#777">● Previous</span> '
                f"{self._timeline_line_text(previous_line)}</div>"
            )

        mined_line_id = getattr(getattr(self, "_replay_context", None), "mined_line", None)
        mined_line_id = getattr(mined_line_id, "id", None)
        for line in self._dialog_selected_lines:
            label = "Mined" if getattr(line, "id", None) == mined_line_id else "Selected"
            rows.append(
                '<div style="margin:2px 0;color:palette(text)"><span style="color:#ff8c00">● '
                f"{label}</span> {self._timeline_line_text(line)}</div>"
            )

        if next_line:
            rows.append(
                '<div style="color:#777"><span style="color:#4f8cff">● Next</span> '
                f"{self._timeline_line_text(next_line)}</div>"
            )
        else:
            rows.append('<div style="color:#999"><span>○ Next</span> Waiting for the next line…</div>')
        self.dialogue_timeline.setText("".join(rows))

    def _poll_dialogue_line_neighbors(self):
        if not self._dialogue_line_expansion_enabled():
            self._dialogue_line_poll_timer.stop()
            return
        previous_line = self._previous_dialogue_line()
        next_line = self._next_dialogue_line()
        signature = (
            getattr(previous_line, "id", None),
            self._line_ids_for_dialogue(self._dialog_selected_lines),
            getattr(next_line, "id", None),
        )
        if signature != self._dialogue_neighbor_signature:
            self._dialogue_neighbor_signature = signature
            self._update_dialogue_line_controls()

    def _update_dialogue_line_controls(self, has_translation=None):
        has_translation = (
            bool(self.translation_text.toPlainText().strip()) if has_translation is None else bool(has_translation)
        )
        feature_enabled = self._dialogue_line_expansion_enabled()
        can_regenerate_translation = bool(get_config().ai.add_to_anki)
        prev_line = self._previous_dialogue_line() if feature_enabled else None
        next_line = self._next_dialogue_line() if feature_enabled else None
        visible = bool(feature_enabled)
        replay_pending = self._dialogue_replay_future is not None

        self.dialogue_tools_title.setVisible(visible)
        self.add_prev_line_button.setVisible(bool(visible and prev_line))
        self.add_next_line_button.setVisible(visible)
        self.add_next_line_button.setEnabled(bool(visible and next_line and not replay_pending))
        self.add_next_line_button.setToolTip(
            "Add the next line to this card." if next_line else "Waiting for the next captured line."
        )
        self.regen_translation_checkbox.setVisible(bool(visible and (has_translation or can_regenerate_translation)))
        self.dialogue_tools_status.setVisible(visible)
        self._refresh_dialogue_timeline()

        if not visible:
            return

        line_count = len(self._dialog_selected_lines)
        if replay_pending:
            status_text = "Saving a fresh replay and recalculating audio…"
        else:
            status_text = f"Experimental. {line_count} line{'s' if line_count != 1 else ''} selected."
        if self._dialog_line_selection_changed:
            status_text += " Card fields will use the expanded dialogue."
        self.dialogue_tools_status.setText(status_text)

    def _set_audio_cut_controls_visible(self, visible):
        cut_button = getattr(self, "cut_audio_button", None)
        undo_button = getattr(self, "undo_audio_cut_button", None)
        status_label = getattr(self, "cut_status_label", None)

        if cut_button is not None:
            cut_button.setVisible(visible)
            if not visible and cut_button.isChecked():
                cut_button.setChecked(False)
        if undo_button is not None:
            undo_button.setVisible(visible)
        if status_label is not None and not visible:
            status_label.setVisible(False)
        if visible:
            AnkiConfirmationDialog._update_cut_controls(self)

    def _refresh_audio_controls(self, sentence_text):
        if not self.audio_player.audio_available:
            self.audio_status_label.setText("⚠ No audio player available on this platform.")
            self.audio_status_label.setStyleSheet("color: #856404; font-weight: bold;")
            self.codec_info_label.setVisible(False)
            self.waveform_widget.setVisible(False)
            self.audio_button.setVisible(False)
            self.play_original_button.setVisible(False)
            self.reset_audio_button.setVisible(False)
            AnkiConfirmationDialog._set_audio_cut_controls_visible(self, False)
            self._update_audio_expand_buttons(allow_buttons=False)
            self.tts_button.setVisible(False)
            self.tts_status_label.setVisible(False)
            self.voice_button.setVisible(False)
            self.no_voice_button.setVisible(False)
            self.confirm_button.setVisible(True)
            return

        if self.reusing_audio:
            self.audio_status_label.setText("Reusing audio from the previous mining operation.")
            self.audio_status_label.setStyleSheet("color: green; font-weight: bold;")
            self.codec_info_label.setVisible(False)
            self.waveform_widget.setVisible(False)
            self.audio_button.setVisible(False)
            self.play_original_button.setVisible(False)
            self.reset_audio_button.setVisible(False)
            AnkiConfirmationDialog._set_audio_cut_controls_visible(self, False)
            self._update_audio_expand_buttons(allow_buttons=False)
            self.tts_button.setVisible(False)
            self.tts_status_label.setVisible(False)
            self.voice_button.setVisible(False)
            self.no_voice_button.setVisible(False)
            self.confirm_button.setVisible(True)
            return

        has_audio_file = bool(self.audio_path and os.path.isfile(self.audio_path))

        vad_ran = self.vad_result is not None and hasattr(self.vad_result, "success")
        vad_detected_voice = vad_ran and bool(self.vad_result.success)

        status_text = "No audio"
        status_style = ""

        if has_audio_file:
            if vad_ran:
                if vad_detected_voice:
                    status_text = "✔ Voice audio detected"
                    status_style = "color: green;"
                elif getattr(self.vad_result, "tts_used", False):
                    status_text = "✔ TTS audio generated"
                    status_style = "color: green;"
                else:
                    status_text = "⚠️ VAD ran and found no voice.\n Keep audio by choosing 'Keep Audio'."
                    status_style = (
                        "color: #ff6b00; font-weight: bold; background-color: #fff3cd; "
                        "padding: 5px; border-radius: 3px;"
                    )
            elif not get_config().vad.do_vad_postprocessing:
                status_text = "✔ Audio file available (VAD disabled)"
                status_style = "color: green;"

        self.audio_status_label.setText(status_text)
        self.audio_status_label.setStyleSheet(status_style)

        is_unsupported, codec_name = self._is_unsupported_audio_codec(self.audio_path)

        if has_audio_file:
            if is_unsupported:
                self.codec_info_label.setText(
                    f"ℹ️ {codec_name} codec is not supported for manual trimming. "
                    f"Supported formats: OPUS, OGG, MP3. You can still include the audio in your card."
                )
                self.codec_info_label.setVisible(True)
                self.waveform_widget.setVisible(False)
                self.audio_button.setVisible(False)
                self.play_original_button.setVisible(False)
                self.reset_audio_button.setVisible(False)
                AnkiConfirmationDialog._set_audio_cut_controls_visible(self, False)
                self._update_audio_expand_buttons(allow_buttons=False)
            else:
                self.codec_info_label.setVisible(False)
                self.waveform_widget.load_audio(self.audio_path)
                self.waveform_widget.setVisible(True)
                self._playback_resume_position = None
                self._playing_full_audio = False
                self.audio_button.setVisible(True)
                self.play_original_button.setVisible(True)
                self.reset_audio_button.setVisible(True)
                AnkiConfirmationDialog._set_audio_cut_controls_visible(self, True)
                self.audio_button.setText("▶ Play Range")
                self.audio_button.setStyleSheet("")
                self._update_audio_expand_buttons(allow_buttons=True)
        else:
            self.codec_info_label.setVisible(False)
            self.waveform_widget.setVisible(False)
            self.audio_button.setVisible(False)
            self.play_original_button.setVisible(False)
            self.reset_audio_button.setVisible(False)
            AnkiConfirmationDialog._set_audio_cut_controls_visible(self, False)
            self._update_audio_expand_buttons(allow_buttons=False)

        show_tts = bool(
            get_config().vad.tts_url and get_config().vad.tts_url != "http://127.0.0.1:5050/?term=$s" and sentence_text
        )
        self.tts_button.setVisible(show_tts)
        self.tts_status_label.setVisible(show_tts)
        self.tts_status_label.setText("")

        if show_tts:
            tts_used = getattr(self.vad_result, "tts_used", False) if self.vad_result else False
            self.tts_button.setText("🔊 " + ("Regenerate" if tts_used else "Generate") + " TTS Audio")

        if has_audio_file:
            self.voice_button.setVisible(True)
            self.no_voice_button.setVisible(True)
            self.confirm_button.setVisible(False)
        else:
            self.voice_button.setVisible(False)
            self.no_voice_button.setVisible(False)
            self.confirm_button.setVisible(True)

    def _build_dialogue_sentence(self, selected_lines):
        if not selected_lines:
            return self.sentence_text.toPlainText().strip()

        from GameSentenceMiner import anki

        last_note = getattr(self._replay_context, "last_note", None)
        sentence = anki._build_selected_lines_sentence(last_note, selected_lines)
        return sentence or self.sentence_text.toPlainText().strip()

    def _regenerate_dialogue_translation(self, sentence_text):
        if not self.regen_translation_checkbox.isVisible() or not self.regen_translation_checkbox.isChecked():
            return self.translation_text.toPlainText().strip(), False

        from GameSentenceMiner import anki

        sentence_to_translate = remove_html_and_cloze_tags(sentence_text)
        translation = anki.prefetch_ai_translation(
            sentence_to_translate, getattr(self._replay_context, "mined_line", None)
        )
        return translation or self.translation_text.toPlainText().strip(), True

    def _regenerate_dialogue_audio(self, selected_lines, sentence_text):
        if (
            not self._replay_context
            or not getattr(self._replay_context, "video_path", None)
            or not get_config().audio.enabled
            or not get_config().anki.sentence_audio_field
            or not selected_lines
        ):
            return None

        from GameSentenceMiner.replay_handler import ReplayAudioExtractor

        start_line = selected_lines[0]
        line_cutoff = selected_lines[-1].get_next_time()
        return ReplayAudioExtractor.get_audio(
            start_line,
            line_cutoff,
            self._replay_context.video_path,
            self._replay_context.anki_card_creation_time,
            mined_line=getattr(self._replay_context, "mined_line", None),
            full_text=remove_html_and_cloze_tags(sentence_text),
        )

    def _refresh_dialog_after_line_change(self, sentence_text, translation_text):
        self.sentence_text.blockSignals(True)
        self.sentence_text.setPlainText(sentence_text)
        self.sentence_text.blockSignals(False)

        translation_visible = bool(self.translation_label_title.isVisible() or translation_text)
        self.translation_label_title.setVisible(translation_visible)
        self.translation_text.setVisible(translation_visible)
        if translation_visible:
            self.translation_text.blockSignals(True)
            self.translation_text.setPlainText(translation_text)
            self.translation_text.blockSignals(False)

        self._refresh_audio_controls(sentence_text)
        self._update_dialogue_line_controls(has_translation=translation_visible)
        self._configure_tab_order()

    def _line_audio_anchor(self, line):
        if not line or self._replay_video_duration <= 0 or self._replay_file_mod_time is None:
            return None

        cached = self._dialogue_line_start_cache.get(line.id)
        if cached is not None:
            return cached

        try:
            time_delta = self._replay_file_mod_time - line.time
            anchor = self._replay_video_duration - time_delta.total_seconds() + get_config().audio.beginning_offset
            anchor = max(0.0, min(anchor, self._replay_video_duration))
        except Exception as e:
            logger.debug(f"Failed computing dialogue line anchor: {e}")
            return None

        self._dialogue_line_start_cache[line.id] = anchor
        return anchor

    def _schedule_auto_line_expand(self, which):
        if not self._dialogue_line_expansion_enabled() or self._dialogue_line_update_in_progress:
            return
        if which not in {"start", "end"}:
            return
        self._pending_auto_line_direction = which
        self._auto_line_expand_timer.start()

    def _apply_pending_auto_line_expand(self):
        if (
            not self._dialogue_line_expansion_enabled()
            or self._dialogue_line_update_in_progress
            or not self._audio_edit_range
            or not self._pending_auto_line_direction
        ):
            return

        direction = self._pending_auto_line_direction
        self._pending_auto_line_direction = None

        if direction == "start":
            prev_line = self._previous_dialogue_line()
            prev_anchor = self._line_audio_anchor(prev_line)
            if (
                prev_line
                and prev_anchor is not None
                and self._audio_edit_range[0] <= (prev_anchor + AUTO_ADD_DIALOGUE_LINE_EPSILON_SECONDS)
            ):
                self._add_previous_dialogue_line(auto_trigger=True)
        elif direction == "end":
            next_line = self._next_dialogue_line()
            next_anchor = self._line_audio_anchor(next_line)
            if (
                next_line
                and next_anchor is not None
                and self._audio_edit_range[1] >= (next_anchor - AUTO_ADD_DIALOGUE_LINE_EPSILON_SECONDS)
            ):
                self._add_next_dialogue_line(auto_trigger=True)

    def _apply_dialogue_line_change(self, selected_lines, audio_result_override=None):
        if not self._dialogue_line_expansion_enabled() or not selected_lines:
            return

        self._dialogue_line_update_in_progress = True
        self._auto_line_expand_timer.stop()
        self._pending_auto_line_direction = None
        try:
            self._dialog_selected_lines = list(selected_lines)
            self._dialog_line_selection_changed = (
                self._line_ids_for_dialogue(self._dialog_selected_lines) != self._dialog_original_selected_line_ids
            )

            sentence_text = self._build_dialogue_sentence(self._dialog_selected_lines)
            translation_text, translation_regenerated = self._regenerate_dialogue_translation(sentence_text)
            self._dialog_translation_regenerated = translation_regenerated

            audio_result = audio_result_override or self._regenerate_dialogue_audio(
                self._dialog_selected_lines, sentence_text
            )
            self._dialog_audio_result = None
            if audio_result:
                self._dialog_audio_result = audio_result
                self.vad_result = audio_result.vad_result
                gsm_state.vad_result = audio_result.vad_result
                gsm_state.audio_edit_context = audio_result.audio_edit_context
                self._load_audio_edit_context(audio_result.audio_edit_context)
                self.audio_path = audio_result.final_audio_output or (
                    audio_result.vad_result.output_audio if audio_result.vad_result else self.audio_path
                )

            if self._replay_context:
                self._replay_context.selected_lines = self._selected_lines_for_pipeline()
                self._replay_context.start_line = self._dialog_selected_lines[0]
                self._replay_context.line_cutoff = self._dialog_selected_lines[-1].get_next_time()
                self._replay_context.full_text = remove_html_and_cloze_tags(sentence_text)
                self._replay_context.sentence_for_translation = sentence_text
                self._replay_context.audio_result = audio_result

            self._refresh_dialog_after_line_change(sentence_text, translation_text)
        except Exception as e:
            logger.exception(f"Failed applying dialogue line change: {e}")
            QMessageBox.critical(self, "Dialogue Update Error", str(e))
        finally:
            self._dialogue_line_update_in_progress = False

    def _add_previous_dialogue_line(self, checked=False, auto_trigger=False):
        del checked, auto_trigger
        prev_line = self._previous_dialogue_line()
        if not prev_line:
            return
        self._apply_dialogue_line_change([prev_line, *self._dialog_selected_lines])

    def _selection_requires_fresh_replay(self, selected_lines):
        if not self._replay_file_mod_time:
            return False
        return any(
            getattr(line, "time", self._replay_file_mod_time) > self._replay_file_mod_time for line in selected_lines
        )

    def _start_dialogue_replay_refresh(self, selected_lines):
        if self._dialogue_replay_future is not None:
            return
        sentence_text = self._build_dialogue_sentence(selected_lines)
        self._dialogue_replay_selected_lines = list(selected_lines)
        self._dialogue_replay_future = request_dialogue_replay_refresh(
            selected_lines=selected_lines,
            mined_line=getattr(self._replay_context, "mined_line", None),
            full_text=remove_html_and_cloze_tags(sentence_text),
            timing_context=getattr(self._replay_context, "timing_context", None),
        )
        self._dialogue_replay_poll_timer.start()
        self._update_dialogue_line_controls()

    def _poll_dialogue_replay_refresh(self):
        future = self._dialogue_replay_future
        if future is None or not future.done():
            return

        self._dialogue_replay_poll_timer.stop()
        selected_lines = self._dialogue_replay_selected_lines
        self._dialogue_replay_future = None
        self._dialogue_replay_selected_lines = None
        try:
            replay_result = future.result()
            self._replay_file_mod_time = replay_result.capture_time
            self._dialogue_line_start_cache = {}
            self._apply_dialogue_line_change(selected_lines, audio_result_override=replay_result.audio_result)
        except Exception as exc:
            logger.exception(f"Failed refreshing dialogue replay: {exc}")
            QMessageBox.critical(self, "Dialogue Replay Error", str(exc))
            self._update_dialogue_line_controls()

    def _add_next_dialogue_line(self, checked=False, auto_trigger=False):
        del checked, auto_trigger
        next_line = self._next_dialogue_line()
        if not next_line:
            return
        selected_lines = [*self._dialog_selected_lines, next_line]
        if self._selection_requires_fresh_replay(selected_lines):
            self._start_dialogue_replay_refresh(selected_lines)
            return
        self._apply_dialogue_line_change(selected_lines)

    @staticmethod
    def _calculate_audio_expanded_range(start_time, end_time, duration, expand_start=0.0, expand_end=0.0):
        return max(0.0, start_time - expand_start), min(duration, end_time + expand_end)

    @staticmethod
    def _calculate_audio_keep_ranges(start_time, end_time, cut_ranges):
        start_time = float(start_time)
        end_time = max(start_time, float(end_time))
        normalized_cuts = []
        for cut_start, cut_end in sorted(cut_ranges):
            cut_start = max(start_time, min(float(cut_start), end_time))
            cut_end = max(start_time, min(float(cut_end), end_time))
            if cut_end <= cut_start:
                continue
            if normalized_cuts and cut_start <= normalized_cuts[-1][1]:
                normalized_cuts[-1] = (
                    normalized_cuts[-1][0],
                    max(normalized_cuts[-1][1], cut_end),
                )
            else:
                normalized_cuts.append((cut_start, cut_end))

        keep_ranges = []
        cursor = start_time
        for cut_start, cut_end in normalized_cuts:
            if cut_start > cursor:
                keep_ranges.append((cursor, cut_start))
            cursor = max(cursor, cut_end)
        if cursor < end_time:
            keep_ranges.append((cursor, end_time))
        return keep_ranges

    @staticmethod
    def _build_audio_preview_data(data, samplerate, start_position, cut_ranges):
        if data is None or samplerate <= 0:
            return None

        data = np.asarray(data)
        duration = len(data) / samplerate
        keep_ranges = AnkiConfirmationDialog._calculate_audio_keep_ranges(
            start_position,
            duration,
            cut_ranges,
        )
        segments = [
            data[int(start * samplerate) : int(end * samplerate)]
            for start, end in keep_ranges
            if int(end * samplerate) > int(start * samplerate)
        ]
        if not segments:
            return np.empty((0, *data.shape[1:]), dtype=data.dtype)
        if len(segments) == 1:
            return segments[0]
        return np.concatenate(segments, axis=0)

    @staticmethod
    def _source_position_for_preview_elapsed(start_position, elapsed, cut_ranges):
        source_position = float(start_position) + max(0.0, float(elapsed))
        merged_cuts = []
        for cut_start, cut_end in sorted(cut_ranges):
            cut_start = float(cut_start)
            cut_end = float(cut_end)
            if cut_end <= start_position or cut_end <= cut_start:
                continue
            cut_start = max(float(start_position), cut_start)
            if merged_cuts and cut_start <= merged_cuts[-1][1]:
                merged_cuts[-1] = (merged_cuts[-1][0], max(merged_cuts[-1][1], cut_end))
            else:
                merged_cuts.append((cut_start, cut_end))

        for cut_start, cut_end in merged_cuts:
            if source_position >= cut_start:
                source_position += cut_end - cut_start
        return source_position

    @staticmethod
    def _audio_edit_context_value(context, key, default=None):
        if isinstance(context, dict):
            return context.get(key, default)
        return getattr(context, key, default)

    @staticmethod
    def _normalize_audio_edit_context(context):
        if not context:
            return None

        source_audio_path = AnkiConfirmationDialog._audio_edit_context_value(context, "source_audio_path")
        if not source_audio_path or not os.path.isfile(source_audio_path):
            return None

        source_duration = float(AnkiConfirmationDialog._audio_edit_context_value(context, "source_duration") or 0.0)
        if source_duration <= 0:
            source_duration = get_audio_length(source_audio_path)
        if source_duration <= 0:
            return None

        range_start = max(0.0, float(AnkiConfirmationDialog._audio_edit_context_value(context, "range_start") or 0.0))
        range_end = float(AnkiConfirmationDialog._audio_edit_context_value(context, "range_end") or 0.0)
        if range_end <= 0:
            range_end = source_duration
        range_end = max(range_start, min(range_end, source_duration))
        range_start = min(range_start, range_end)

        return {
            "source_audio_path": source_audio_path,
            "source_duration": source_duration,
            "range_start": range_start,
            "range_end": range_end,
            "rebase_on_selection_trim": bool(
                AnkiConfirmationDialog._audio_edit_context_value(context, "rebase_on_selection_trim", False)
            ),
        }

    def _load_audio_edit_context(self, context):
        normalized = self._normalize_audio_edit_context(context)
        self._audio_edit_context = normalized
        if not normalized:
            self._audio_edit_source_path = None
            self._audio_edit_source_duration = 0.0
            self._audio_edit_source_window = None
            self._audio_edit_range = None
            self._audio_edit_rebase_on_selection_trim = False
            self._has_performed_audio_expand = False
            return

        self._audio_edit_source_path = normalized["source_audio_path"]
        self._audio_edit_source_duration = normalized["source_duration"]
        self._audio_edit_source_window = (normalized["range_start"], normalized["range_end"])
        self._audio_edit_range = self._audio_edit_source_window
        self._audio_edit_rebase_on_selection_trim = normalized["rebase_on_selection_trim"]
        self._has_performed_audio_expand = False

    def _sync_audio_edit_selection_to_current_clip(self, start, end):
        if self.waveform_widget.audio_data is None:
            return

        if not self._audio_edit_source_window:
            return

        window_start, window_end = self._audio_edit_source_window
        window_duration = max(0.0, window_end - window_start)
        clip_duration = float(self.waveform_widget.duration or 0.0)
        selection_start = max(0.0, min(float(start), clip_duration))
        selection_end = max(selection_start, min(float(end), clip_duration))

        if self._audio_edit_rebase_on_selection_trim:
            if clip_duration <= 0 or window_duration <= 0:
                self._audio_edit_range = (window_start, window_end)
                return

            # Preserve the original extracted source so expand controls can continue
            # to reach outside the current rendered clip. For rebased clips
            # (condensed/spliced audio), selection->source mapping is approximate.
            scale = window_duration / clip_duration
            self._audio_edit_range = (
                window_start + (selection_start * scale),
                window_start + (selection_end * scale),
            )
            return

        self._audio_edit_range = (
            window_start + selection_start,
            window_start + selection_end,
        )

    def _get_current_clip_selection(self):
        if self.waveform_widget.audio_data is None:
            return 0.0, 0.0, 0.0

        clip_duration = float(self.waveform_widget.duration or 0.0)
        selection_start, selection_end = self.waveform_widget.get_selection_range()
        selection_start = max(0.0, min(float(selection_start), clip_duration))
        selection_end = max(selection_start, min(float(selection_end), clip_duration))
        return selection_start, selection_end, clip_duration

    def _apply_audio_selection(self, selection_start, selection_end):
        selection_start, selection_end, clip_duration = (
            max(0.0, float(selection_start)),
            max(0.0, float(selection_end)),
            float(self.waveform_widget.duration or 0.0),
        )
        selection_start = min(selection_start, clip_duration)
        selection_end = max(selection_start, min(selection_end, clip_duration))

        self.audio_player.stop_audio()
        self.playback_timer.stop()
        self.waveform_widget.start_time = selection_start
        self.waveform_widget.end_time = selection_end
        self.waveform_widget.set_cut_ranges(
            self.waveform_widget.get_cut_ranges(),
            clear_history=False,
        )
        self._playback_resume_position = selection_start
        self.waveform_widget.set_playback_position(selection_start)
        self._sync_audio_edit_selection_to_current_clip(selection_start, selection_end)
        self._update_audio_buttons()
        self._update_audio_expand_buttons()
        self.waveform_widget.update()

    def _update_audio_expand_buttons(self, allow_buttons=True):
        has_context = bool(
            allow_buttons
            and self._audio_edit_source_path
            and self._audio_edit_range
            and os.path.isfile(self._audio_edit_source_path)
        )

        if not has_context:
            self.waveform_widget.set_expand_controls(False)
            return

        start_time, end_time = self._audio_edit_range
        self.waveform_widget.set_expand_controls(
            True,
            can_expand_start=start_time > 0.01,
            can_expand_end=end_time < self._audio_edit_source_duration - 0.01,
            range_text=f"{start_time:.2f}s -> {end_time:.2f}s",
        )

    def _render_audio_edit_range(self, start_time, end_time, selection_start=0.0, selection_end=None):
        if not self._audio_edit_source_path:
            return

        if end_time <= start_time:
            raise RuntimeError("Expanded audio range is empty.")

        game_name = sanitize_filename(gsm_state.current_game) if gsm_state.current_game else "expanded"
        orig_ext = os.path.splitext(self._audio_edit_source_path)[1] or ".wav"
        filename = f"{game_name}_manual_audio_expand_{int(time.time())}{orig_ext}"
        new_path = make_unique_file_name(os.path.join(get_temporary_directory(), filename))
        previous_cut_ranges = self.waveform_widget.get_cut_ranges()
        previous_window = self._audio_edit_source_window
        previous_clip_duration = float(self.waveform_widget.duration or 0.0)

        trim_audio(
            input_audio=self._audio_edit_source_path,
            start_time=start_time,
            end_time=end_time,
            output_audio=new_path,
            trim_beginning=True,
            fade_in_duration=0,
            fade_out_duration=0,
        )

        self.audio_player.stop_audio()
        self.playback_timer.stop()
        self.audio_path = new_path
        self.waveform_widget.load_audio(self.audio_path)
        self.waveform_widget.setVisible(True)
        self.audio_button.setVisible(True)
        self.play_original_button.setVisible(True)
        self.reset_audio_button.setVisible(True)
        self._set_audio_cut_controls_visible(True)
        self._audio_edit_source_window = (start_time, end_time)
        clip_duration = float(self.waveform_widget.duration or 0.0)
        if selection_end is None:
            selection_end = clip_duration
        selection_start = max(0.0, min(float(selection_start), clip_duration))
        selection_end = max(selection_start, min(float(selection_end), clip_duration))
        self.waveform_widget.start_time = selection_start
        self.waveform_widget.end_time = selection_end
        remapped_cut_ranges = []
        if previous_window and previous_clip_duration > 0:
            previous_window_start, previous_window_end = previous_window
            previous_window_duration = previous_window_end - previous_window_start
            scale = previous_window_duration / previous_clip_duration
            for cut_start, cut_end in previous_cut_ranges:
                if self._audio_edit_rebase_on_selection_trim:
                    absolute_cut_start = previous_window_start + cut_start * scale
                    absolute_cut_end = previous_window_start + cut_end * scale
                else:
                    absolute_cut_start = previous_window_start + cut_start
                    absolute_cut_end = previous_window_start + cut_end
                remapped_cut_ranges.append(
                    (
                        absolute_cut_start - start_time,
                        absolute_cut_end - start_time,
                    )
                )
        self.waveform_widget.set_cut_ranges(remapped_cut_ranges)
        self._playback_resume_position = selection_start
        self._playing_full_audio = False
        self.waveform_widget.set_playback_position(selection_start)
        self._sync_audio_edit_selection_to_current_clip(selection_start, selection_end)
        self._update_audio_buttons()
        self._update_cut_controls()
        self._update_audio_expand_buttons()
        self.waveform_widget.update()

    def _expand_audio_start(self):
        self._expand_audio_window(expand_start=AUDIO_EXPAND_SECONDS)

    def _expand_audio_end(self):
        self._expand_audio_window(expand_end=AUDIO_EXPAND_SECONDS)

    def _expand_audio_window(self, expand_start=0.0, expand_end=0.0):
        if not self._audio_edit_range or not self._audio_edit_source_path or not self._audio_edit_source_window:
            return

        try:
            selection_start, selection_end, clip_duration = self._get_current_clip_selection()
            current_window_start, current_window_end = self._audio_edit_source_window

            if not self._has_performed_audio_expand:
                new_start, new_end = self._calculate_audio_expanded_range(
                    current_window_start,
                    current_window_end,
                    self._audio_edit_source_duration,
                    expand_start=expand_start,
                    expand_end=expand_end,
                )

                if (new_start, new_end) != (current_window_start, current_window_end):
                    self._render_audio_edit_range(new_start, new_end)
                    self._has_performed_audio_expand = True
                    return

                if selection_start > 0.01 or selection_end < clip_duration - 0.01:
                    self._apply_audio_selection(0.0, clip_duration)
                    self._has_performed_audio_expand = True
                return

            if expand_start > 0 and selection_start > 0.01:
                self._apply_audio_selection(0.0, selection_end)
                return

            if expand_end > 0 and selection_end < clip_duration - 0.01:
                self._apply_audio_selection(selection_start, clip_duration)
                return

            new_start, new_end = self._calculate_audio_expanded_range(
                current_window_start,
                current_window_end,
                self._audio_edit_source_duration,
                expand_start=expand_start,
                expand_end=expand_end,
            )
            if (new_start, new_end) == (current_window_start, current_window_end):
                return

            if expand_start > 0:
                start_shift = current_window_start - new_start
                new_selection_start = 0.0
                new_selection_end = selection_end + start_shift
            else:
                new_selection_start = selection_start
                new_selection_end = new_end - new_start

            self._render_audio_edit_range(
                new_start,
                new_end,
                selection_start=new_selection_start,
                selection_end=new_selection_end,
            )
        except Exception as e:
            logger.error(f"Failed to expand audio range: {e}")
            QMessageBox.critical(self, "Audio Expand Error", str(e))

    def _play_audio(self, audio_path, full=False):
        if self.audio_player.is_playing:
            position = self._current_source_playback_position()
            self.audio_player.stop_audio()
            self.playback_timer.stop()
            self._playback_resume_position = self._normalize_audio_seek_position(position)
            self.waveform_widget.set_playback_position(self._playback_resume_position)
            self._playing_full_audio = False
            self._update_audio_buttons()
            return

        if not audio_path or not os.path.isfile(audio_path):
            print(f"Audio file does not exist: {audio_path}")
            return

        # Reset offset for full playback
        if full:
            self._playback_start_offset = 0.0
            self._playback_cut_ranges = []
            self._playing_full_audio = True

        try:
            if get_config().advanced.audio_player_path:
                import platform
                import subprocess

                if platform.system() == "Windows":
                    os.startfile(audio_path)
                elif platform.system() == "Darwin":
                    subprocess.run(["open", audio_path])
                else:
                    subprocess.run(["xdg-open", audio_path])
            else:
                success = self.audio_player.play_audio_file(audio_path)
                if success:
                    self.waveform_widget.set_playback_position(self._playback_start_offset)
                    self._update_audio_buttons()
                    self.playback_timer.start()
        except Exception as e:
            print(f"Failed to play audio: {e}")

    def _play_range(self):
        if self.audio_player.is_playing:
            position = self._current_source_playback_position()
            self.audio_player.stop_audio()
            self.playback_timer.stop()
            self._playback_resume_position = self._normalize_audio_seek_position(position)
            self.waveform_widget.set_playback_position(self._playback_resume_position)
            self._playing_full_audio = False
            self._update_audio_buttons()
            return

        start, end = self.waveform_widget.get_selection_range()
        start_position = self._playback_resume_position
        if (
            start_position is None
            or not start <= start_position < end
            or (start_position > start and end - start_position <= AUDIO_PLAYBACK_END_EPSILON_SECONDS)
        ):
            start_position = start
        self._start_range_playback(start_position)

    def _start_range_playback(self, start_position):
        if not self.audio_path or not os.path.isfile(self.audio_path):
            return

        self.audio_player.stop_audio()
        self.playback_timer.stop()

        start, end = self.waveform_widget.get_selection_range()
        start_position = self._normalize_audio_seek_position(start_position)
        if start_position >= end:
            self._playback_resume_position = start_position
            self.waveform_widget.set_playback_position(start_position)
            self._update_audio_buttons()
            return

        # Get data from widget directly to avoid reloading
        if self.waveform_widget.audio_data is None:
            self.waveform_widget.load_audio(self.audio_path)

        data = self.waveform_widget.audio_data
        sr = self.waveform_widget.samplerate

        if data is None:
            return

        cut_ranges = self.waveform_widget.get_cut_ranges()
        preview_data = self._build_audio_preview_data(data, sr, start_position, cut_ranges)
        if preview_data is None or len(preview_data) == 0:
            return

        success = self.audio_player.play_audio_data(preview_data, sr)
        if success:
            self._playback_start_offset = start_position
            self._playback_cut_ranges = cut_ranges
            self._playback_resume_position = start_position
            self._playing_full_audio = False
            self.waveform_widget.set_playback_position(start_position)
            self._update_audio_buttons()
            self.playback_timer.start()

    def _normalize_audio_seek_position(self, position):
        start, end = self.waveform_widget.get_selection_range()
        position = max(start, min(float(position), end))
        for cut_start, cut_end in self.waveform_widget.get_cut_ranges():
            if cut_start <= position < cut_end:
                position = cut_end
        return min(position, end)

    def _current_source_playback_position(self):
        if not self.audio_player.is_playing:
            position = self._playback_resume_position
            if position is None:
                position = self.waveform_widget.start_time
            return float(position)

        elapsed = self.audio_player.get_current_time()
        if self._playing_full_audio:
            return self._playback_start_offset + elapsed
        return self._source_position_for_preview_elapsed(
            self._playback_start_offset,
            elapsed,
            self._playback_cut_ranges,
        )

    def _seek_audio(self, position):
        self._cancel_auto_accept()
        was_playing = self.audio_player.is_playing
        if was_playing:
            self.audio_player.stop_audio()
            self.playback_timer.stop()

        position = self._normalize_audio_seek_position(position)
        self._playback_resume_position = position
        self._playing_full_audio = False
        self.waveform_widget.set_playback_position(position)
        self._update_audio_buttons()

        if was_playing and position < self.waveform_widget.end_time:
            self._start_range_playback(position)

    def _update_playback_cursor(self):
        if self.audio_player.is_playing:
            absolute_pos = self._current_source_playback_position()
            self._playback_resume_position = absolute_pos
            self.waveform_widget.set_playback_position(absolute_pos)

            if not self._playing_full_audio and absolute_pos >= self.waveform_widget.end_time:
                self.audio_player.stop_audio()
                self.playback_timer.stop()
                self._playback_resume_position = self.waveform_widget.start_time
                self.waveform_widget.set_playback_position(self._playback_resume_position)
                self._update_audio_buttons()
        else:
            self.playback_timer.stop()
            resume_position = self._playback_resume_position
            if (
                resume_position is not None
                and resume_position > self.waveform_widget.start_time
                and self.waveform_widget.end_time - resume_position <= AUDIO_PLAYBACK_END_EPSILON_SECONDS
            ):
                self._playback_resume_position = self.waveform_widget.start_time
                self.waveform_widget.set_playback_position(self._playback_resume_position)
            self._update_audio_buttons()

    def _reset_audio_trim(self):
        if self.waveform_widget.audio_data is not None:
            self.audio_player.stop_audio()
            self.playback_timer.stop()
            self.cut_audio_button.setChecked(False)
            self.waveform_widget.start_time = 0.0
            self.waveform_widget.end_time = self.waveform_widget.duration
            self.waveform_widget.clear_cut_ranges()
            self._playback_resume_position = 0.0
            self._playing_full_audio = False
            self.waveform_widget.set_playback_position(0.0)
            self._sync_audio_edit_selection_to_current_clip(0.0, self.waveform_widget.duration)
            self.waveform_widget.range_changed.emit(0.0, self.waveform_widget.duration)
            self._update_audio_expand_buttons()
            self._update_audio_buttons()
            self.waveform_widget.update()

    def _save_trimmed_audio(self):
        if self.waveform_widget.audio_data is None:
            return self.audio_path

        # Check if trimmed
        start, end = self.waveform_widget.get_selection_range()
        duration = self.waveform_widget.duration
        cut_ranges = self.waveform_widget.get_cut_ranges()
        self._sync_audio_edit_selection_to_current_clip(start, end)

        # Tolerance for float comparison
        if abs(start) < 0.01 and abs(end - duration) < 0.01 and not cut_ranges:
            return self.audio_path  # No significant trim

        game_name = sanitize_filename(gsm_state.current_game) if gsm_state.current_game else "trimmed"
        orig_ext = os.path.splitext(self.audio_path)[1]
        if not orig_ext:
            orig_ext = ".wav"

        filename = f"{game_name}_trimmed_{int(time.time())}{orig_ext}"
        new_path = make_unique_file_name(os.path.join(get_temporary_directory(), filename))

        try:
            if cut_ranges:
                keep_ranges = self._calculate_audio_keep_ranges(start, end, cut_ranges)
                if not keep_ranges:
                    raise RuntimeError("Audio edits would remove the entire selected range.")
                splice_audio(
                    input_audio=self.audio_path,
                    output_audio=new_path,
                    keep_ranges=keep_ranges,
                    fade_duration=0.05,
                )
            else:
                # Use ffmpeg wrapper to trim which handles formats properly
                trim_audio(
                    input_audio=self.audio_path,
                    start_time=start,
                    end_time=end,
                    output_audio=new_path,
                    trim_beginning=True,
                    fade_in_duration=0.05,
                    fade_out_duration=0.05,
                )
            return new_path
        except Exception as e:
            logger.error(f"Failed to save trimmed audio: {e}")
            return self.audio_path

    def _audio_finished(self):
        self.playback_timer.stop()
        self._playing_full_audio = False
        self._playback_resume_position = self.waveform_widget.start_time
        self.waveform_widget.set_playback_position(self._playback_resume_position)
        self.audio_finished_signal.emit()

    def _update_audio_buttons(self):
        """Update both Play Range and Play Full button states based on playback status."""
        is_playing = self.audio_player.is_playing

        if self.audio_button:
            if is_playing:
                self.audio_button.setText("⏹ Stop")
                self.audio_button.setStyleSheet("background-color: #ffc107; color: black;")
            else:
                self.audio_button.setText("▶ Play Range")
                self.audio_button.setStyleSheet("")

        if self.play_original_button:
            if is_playing:
                self.play_original_button.setText("⏹ Stop")
                self.play_original_button.setStyleSheet("background-color: #ffc107; color: black;")
            else:
                self.play_original_button.setText("▶ Play Full")
                self.play_original_button.setStyleSheet("")

    def _generate_tts_audio(self):
        try:
            sentence_text = self.sentence_text.toPlainText().strip()
            sentence_text = remove_html_and_cloze_tags(sentence_text)
            if not sentence_text:
                QMessageBox.critical(self, "TTS Error", "No sentence text available for TTS generation.")
                return
            encoded_text = quote(sentence_text)
            tts_url = get_config().vad.tts_url.replace("$s", encoded_text)
            logger.info(f"Fetching TTS audio from: {tts_url}")
            response = requests.get(tts_url, timeout=10)
            if not response.ok:
                error_msg = f"Failed to fetch TTS audio: HTTP {response.status_code}"
                logger.error(error_msg)
                QMessageBox.critical(self, "TTS Error", f"{error_msg}\n\nIs your TTS service running?")
                return
            game_name = gsm_state.current_game if gsm_state.current_game else "tts"
            filename = f"{game_name}_tts_audio.opus"
            tts_audio_path = make_unique_file_name(os.path.join(get_temporary_directory(), filename))
            with open(tts_audio_path, "wb") as f:
                f.write(response.content)
            self.audio_path = tts_audio_path
            if self.audio_player.is_playing:
                self.audio_player.stop_audio()
                self.playback_timer.stop()
                self.waveform_widget.set_playback_position(-1)

            # Update waveform
            self.waveform_widget.load_audio(self.audio_path)
            self.waveform_widget.setVisible(True)
            self.play_original_button.setVisible(True)
            self.reset_audio_button.setVisible(True)
            self._set_audio_cut_controls_visible(True)
            self._playback_resume_position = None
            self._playing_full_audio = False
            self._audio_edit_context = None
            self._audio_edit_source_path = None
            self._audio_edit_source_duration = 0.0
            self._audio_edit_source_window = None
            self._audio_edit_range = None
            self._audio_edit_rebase_on_selection_trim = False
            self._has_performed_audio_expand = False
            self._dialog_audio_result = None
            self._update_audio_expand_buttons(allow_buttons=False)

            self.audio_status_label.setText("✔ TTS audio generated")
            self.audio_status_label.setStyleSheet("color: green;")
            self.audio_button.setVisible(True)
            self.voice_button.setVisible(True)
            self.no_voice_button.setVisible(True)
            self.confirm_button.setVisible(False)
            self.tts_status_label.setText("✓ TTS Audio Generated")
            self.tts_status_label.setStyleSheet("color: green;")
            self.tts_button.setText("🔊 Regenerate TTS Audio")
            if getattr(get_config().anki, "replay_audio_on_tts_generation", True):
                QTimer.singleShot(100, self._play_range)
        except Exception as e:
            logger.error(f"TTS Error: {e}")
            QMessageBox.critical(self, "TTS Error", str(e))

    def _cleanup_audio(self):
        self.audio_player.cleanup()

    def _stop_dialogue_watchers(self):
        self._dialogue_line_poll_timer.stop()
        self._dialogue_replay_poll_timer.stop()

    def _build_dialog_result_metadata(self):
        audio_edit_range = None
        if self._audio_edit_range:
            audio_edit_range = (float(self._audio_edit_range[0]), float(self._audio_edit_range[1]))

        return {
            "selected_lines": self._selected_lines_for_pipeline(),
            "line_selection_changed": self._dialog_line_selection_changed,
            "audio_result": self._dialog_audio_result if self._dialog_line_selection_changed else None,
            "translation_regenerated": self._dialog_translation_regenerated,
            "translation_pending": getattr(self, "_translation_pending", False),
            "audio_edit_range": audio_edit_range,
        }

    def _on_voice(self):
        self._stop_dialogue_watchers()
        self._cleanup_audio()

        final_audio_path = self._save_trimmed_audio()

        # UPDATE 3: Comment out access to missing checkbox
        # if self.disable_dialog_checkbox.isChecked():
        #    self._save_disable_preference()

        translation = self.translation_text.toPlainText().strip()
        self.result = (
            True,
            self.sentence_text.toPlainText().strip(),
            translation,
            self.screenshot_path,
            self.previous_screenshot_path,
            self.nsfw_tag_checkbox.isChecked(),
            final_audio_path,
            self._build_dialog_result_metadata(),
        )
        self.accept()

    def _on_no_voice(self):
        self._stop_dialogue_watchers()
        self._cleanup_audio()
        # UPDATE 4: Comment out access to missing checkbox
        # if self.disable_dialog_checkbox.isChecked():
        #     self._save_disable_preference()

        translation = self.translation_text.toPlainText().strip()
        self.result = (
            bool(self.reusing_audio),
            self.sentence_text.toPlainText().strip(),
            translation,
            self.screenshot_path,
            self.previous_screenshot_path,
            self.nsfw_tag_checkbox.isChecked(),
            None if self.reusing_audio else self.audio_path,
            self._build_dialog_result_metadata(),
        )
        self.accept()

    def _save_disable_preference(self):
        config = get_config()
        config.anki.show_update_confirmation_dialog_v2 = False
        save_current_config(config)
        reload_config()

    def _show_exit_confirmation_message(self):
        message_box = QMessageBox(self)
        message_box.setIcon(QMessageBox.Icon.Warning)
        message_box.setWindowTitle("Discard Anki update?")
        message_box.setText(
            "Exiting this dialog will throw away the generated audio and will NOT update the Anki card."
        )
        message_box.setInformativeText(
            "Choose OK to discard this update, OK and Delete card to delete the current Anki note too, "
            "or Cancel to keep editing."
        )

        ok_button = message_box.addButton("OK", QMessageBox.ButtonRole.AcceptRole)
        delete_button = message_box.addButton("OK and Delete card", QMessageBox.ButtonRole.DestructiveRole)
        cancel_button = message_box.addButton(QMessageBox.StandardButton.Cancel)
        message_box.setDefaultButton(cancel_button)
        message_box.setEscapeButton(cancel_button)

        message_box.exec()
        clicked_button = message_box.clickedButton()
        if clicked_button == delete_button:
            return EXIT_CHOICE_DELETE_CARD
        if clicked_button == ok_button:
            return EXIT_CHOICE_DISCARD
        return EXIT_CHOICE_CANCEL

    def _apply_exit_choice(self, choice):
        if choice == EXIT_CHOICE_CANCEL:
            return False

        if choice == EXIT_CHOICE_DELETE_CARD:
            self.result = {CONFIRMATION_CANCEL_ACTION_KEY: CONFIRMATION_CANCEL_ACTION_DELETE_CARD}
        else:
            self.result = None
        self._exit_confirmed = True
        return True

    def _confirm_exit_and_apply_result(self):
        if self._exit_confirmed:
            return True
        return self._apply_exit_choice(self._show_exit_confirmation_message())

    def _finish_rejected_dialog(self):
        if self._rejected_cleanup_done:
            return
        self._cancel_auto_accept()
        self._auto_line_expand_timer.stop()
        self._stop_dialogue_watchers()
        self._cleanup_audio()
        window_state_manager.save_geometry(self, WindowId.ANKI_CONFIRMATION)
        self._rejected_cleanup_done = True

    def reject(self):
        if not self._confirm_exit_and_apply_result():
            return
        self._finish_rejected_dialog()
        super().reject()

    def closeEvent(self, event):
        if not self._confirm_exit_and_apply_result():
            event.ignore()
            return
        self._finish_rejected_dialog()
        super().closeEvent(event)

    def _exec_with_activation(self):
        super().exec()
        window_state_manager.save_geometry(self, WindowId.ANKI_CONFIRMATION)
        return self.result

    def _exec_without_activation(self):
        loop = QEventLoop(self)

        def _finish(_result):
            loop.quit()

        self.finished.connect(_finish)
        try:
            QTimer.singleShot(0, self.show)
            loop.exec()
        finally:
            try:
                self.finished.disconnect(_finish)
            except TypeError:
                pass
            window_state_manager.save_geometry(self, WindowId.ANKI_CONFIRMATION)
        return self.result

    def exec(self):
        self._apply_window_behavior_preferences()
        if self._should_focus_on_show():
            return self._exec_with_activation()
        return self._exec_without_activation()


def show_anki_confirmation(
    parent,
    expression,
    sentence,
    screenshot_path,
    previous_screenshot_path,
    audio_path,
    translation,
    screenshot_timestamp,
    previous_screenshot_timestamp,
    pending_animated=False,
    translation_future=None,
    reusing_audio=False,
    reusing_screenshot=False,
):
    global _anki_confirmation_dialog_instance

    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)

    if gsm_state.disable_anki_confirmation_session:
        vad_result = gsm_state.vad_result
        vad_ran = vad_result is not None and hasattr(vad_result, "success")
        vad_detected_voice = vad_ran and bool(vad_result.success)

        final_audio_path = audio_path
        if not final_audio_path and vad_result:
            final_audio_path = vad_result.trimmed_audio_path

        logger.info(
            "Anki confirmation skipped (Session disabled). Restart app or wait 15m after replay buffer stops to re-enable."
        )
        return (
            True if reusing_audio else vad_detected_voice,
            sentence,
            translation,
            screenshot_path,
            previous_screenshot_path,
            False,
            None if reusing_audio else final_audio_path,
            {},
        )

    if _anki_confirmation_dialog_instance is None:
        # Pass the parent!
        _anki_confirmation_dialog_instance = AnkiConfirmationDialog(parent)

    _anki_confirmation_dialog_instance.populate_ui(
        expression,
        sentence,
        screenshot_path,
        previous_screenshot_path,
        audio_path,
        translation,
        screenshot_timestamp,
        previous_screenshot_timestamp,
        pending_animated,
        translation_future,
        reusing_audio,
        reusing_screenshot,
    )

    result = _anki_confirmation_dialog_instance.exec()
    return result
