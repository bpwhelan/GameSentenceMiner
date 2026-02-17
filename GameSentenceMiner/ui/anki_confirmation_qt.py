import json
import os
import requests
import soundfile as sf
import sys
import time
from PIL import Image
from PyQt6.QtCore import Qt, pyqtSignal, QTimer, QSize
from PyQt6.QtGui import QPixmap, QImage
from PyQt6.QtWidgets import (QApplication, QDialog, QVBoxLayout, QHBoxLayout,
                             QLabel, QTextEdit, QPushButton, QCheckBox, QGridLayout,
                             QMessageBox, QWidget, QSizePolicy)
from urllib.parse import quote

from GameSentenceMiner.ui import window_state_manager, WindowId
from GameSentenceMiner.ui.audio_waveform_widget import AudioWaveformWidget
from GameSentenceMiner.util.config.configuration import get_config, logger, gsm_state, get_temporary_directory, \
    save_current_config, reload_config
from GameSentenceMiner.util.gsm_utils import make_unique_file_name, remove_html_and_cloze_tags, sanitize_filename
from GameSentenceMiner.util.media.audio_player import AudioPlayer
from GameSentenceMiner.util.media.ffmpeg import trim_audio


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
        self.updateGeometry() # Notify layout that sizeHint might have changed
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
            Qt.TransformationMode.SmoothTransformation
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
        self.result = None
        self.first_launch = True
        self._force_autoplay = False

        # Auto-accept timer
        self._auto_accept_qtimer = None
        self._auto_accept_countdown_timer = None
        self._auto_accept_remaining = 0
        self.auto_accept_label = None

        # Audio player
        self.audio_player = AudioPlayer(finished_callback=self._audio_finished)
        self.audio_finished_signal.connect(self._update_audio_buttons)

        self.playback_timer = QTimer(self)
        self.playback_timer.timeout.connect(self._update_playback_cursor)
        self.playback_timer.setInterval(20) # Update every 20ms for better precision

        # Autoplay debounce timer for trim updates
        self._trim_autoplay_timer = QTimer(self)
        self._trim_autoplay_timer.setSingleShot(True)
        self._trim_autoplay_timer.setInterval(500) # Wait 500ms after trim stops changing
        self._trim_autoplay_timer.timeout.connect(self._play_range)

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
        self.grid_layout.addWidget(self.expr_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
        self.expr_value_label = QLabel()
        self.expr_value_label.setWordWrap(True)
        # Removed fixed max width to allow resizing
        self.grid_layout.addWidget(self.expr_value_label, row, 1)
        row += 1
        
        # 2. Sentence
        self.sentence_label_title = QLabel(f"{get_config().anki.sentence_field}:")
        self.sentence_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.sentence_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
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
        
        # 3. Translation
        self.translation_label_title = QLabel(f"{get_config().ai.anki_field}:")
        self.translation_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.translation_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
        self.translation_text = QTextEdit()
        self.translation_text.setFixedHeight(64)
        self.translation_text.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.translation_text.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.translation_text.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.translation_text.setTabChangesFocus(True)
        self.translation_text.textChanged.connect(self._cancel_auto_accept)
        self.grid_layout.addWidget(self.translation_text, row, 1)
        row += 1
        
        # 4. Screenshot
        self.screenshot_label_title = QLabel(f"{get_config().anki.picture_field}:")
        self.screenshot_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.screenshot_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
        self.image_label = AspectRatioLabel()
        self.image_label.setMinimumSize(QSize(140, 80))
        self.image_label.setMaximumSize(QSize(360, 200))
        self.grid_layout.addWidget(self.image_label, row, 1)
        
        self.screenshot_button = QPushButton("Select New Screenshot")
        self.screenshot_button.clicked.connect(self._cancel_auto_accept)
        self.screenshot_button.clicked.connect(lambda: self._select_screenshot(previous=False))
        self.grid_layout.addWidget(self.screenshot_button, row, 2, Qt.AlignmentFlag.AlignLeft)
        row += 1
        
        # 5. Previous Screenshot
        self.prev_screenshot_label_title = QLabel(f"{get_config().anki.previous_image_field}:")
        self.prev_screenshot_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.prev_screenshot_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
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
        self.grid_layout.addWidget(self.audio_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)

        # Container for audio controls
        audio_container = QWidget()
        audio_layout = QVBoxLayout(audio_container)
        audio_layout.setContentsMargins(0, 0, 0, 0)
        
        self.audio_status_label = QLabel()
        audio_layout.addWidget(self.audio_status_label)
        
        # Codec compatibility info label
        self.codec_info_label = QLabel()
        self.codec_info_label.setStyleSheet("color: #856404; background-color: #fff3cd; padding: 5px; border-radius: 3px; font-weight: bold;")
        self.codec_info_label.setWordWrap(True)
        self.codec_info_label.setVisible(False)
        audio_layout.addWidget(self.codec_info_label)
        
        self.waveform_widget = AudioWaveformWidget()
        self.waveform_widget.setMinimumHeight(36) # Allow shrinking
        self.waveform_widget.setMaximumHeight(80)
        self.waveform_widget.set_dark_mode()
        # Connect range change to cancel auto accept
        self.waveform_widget.range_changed.connect(lambda _s, _e: self._cancel_auto_accept())
        # Handle start/end handle moves specifically
        self.waveform_widget.handle_moved.connect(self._on_handle_moved)
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
        
        self.reset_audio_button = QPushButton("Reset Trim")
        self.reset_audio_button.clicked.connect(self._reset_audio_trim)
        self.reset_audio_button.clicked.connect(self._cancel_auto_accept)
        audio_controls.addWidget(self.reset_audio_button)
        
        audio_controls.addStretch()
        audio_layout.addLayout(audio_controls)
        
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

    def populate_ui(self, expression, sentence, screenshot_path, previous_screenshot_path, audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp, pending_animated=False):
        self._apply_window_behavior_preferences()

        # Store state
        self.screenshot_timestamp = screenshot_timestamp
        self.previous_screenshot_timestamp = previous_screenshot_timestamp
        self.screenshot_path = screenshot_path
        self.previous_screenshot_path = previous_screenshot_path
        self.vad_result = gsm_state.vad_result
        self.result = None
        self.pending_animated = pending_animated
        
        self.expr_value_label.setText(expression)
        
        self.sentence_text.blockSignals(True)
        self.sentence_text.setPlainText(sentence)
        self.sentence_text.blockSignals(False)
        
        self.nsfw_tag_checkbox.setChecked(False)
        self.autoplay_checkbox.blockSignals(True)
        self.autoplay_checkbox.setChecked(get_config().anki.autoplay_audio)
        self.autoplay_checkbox.blockSignals(False)

        self.disable_session_checkbox.setChecked(gsm_state.disable_anki_confirmation_session)

        # UPDATE 2: Comment out access to the missing checkbox
        # self.disable_dialog_checkbox.setChecked(False) 

        # Handle Audio Path
        self.audio_path = audio_path
        if not self.audio_path and self.vad_result:
            self.audio_path = self.vad_result.trimmed_audio_path
        
        # Translation
        has_translation = bool(translation)
        self.translation_label_title.setVisible(has_translation)
        self.translation_text.setVisible(has_translation)
        if has_translation:
            self.translation_text.blockSignals(True)
            self.translation_text.setPlainText(translation)
            self.translation_text.blockSignals(False)
            
        self._load_image_to_label(self.screenshot_path, self.image_label)
        
        # Show animated screenshot status if pending
        if pending_animated:
            self.screenshot_button.setText("🎬 Animated (generating after confirmation)")
            self.screenshot_button.setStyleSheet("color: #ff8c00; font-weight: bold;")
            self.screenshot_button.setEnabled(False)
        else:
            self.screenshot_button.setText("Select New Screenshot")
            self.screenshot_button.setStyleSheet("")
            self.screenshot_button.setEnabled(True)
        
        use_prev_image = bool(self.previous_screenshot_path and get_config().anki.previous_image_field)
        self.prev_screenshot_label_title.setVisible(use_prev_image)
        self.prev_image_label.setVisible(use_prev_image)
        self.prev_screenshot_button.setVisible(use_prev_image)
        if use_prev_image:
            self._load_image_to_label(self.previous_screenshot_path, self.prev_image_label)

        # Audio Status
        has_audio_file = bool(self.audio_path and os.path.isfile(self.audio_path))
        
        vad_ran = self.vad_result is not None and hasattr(self.vad_result, 'success')
        vad_detected_voice = vad_ran and bool(self.vad_result.success)
        
        status_text = "No audio"
        status_style = ""
        
        if has_audio_file:
            if vad_ran:
                if vad_detected_voice:
                    status_text = "✔ Voice audio detected"
                    status_style = "color: green;"
                elif getattr(self.vad_result, 'tts_used', False):
                    status_text = "✔ TTS audio generated"
                    status_style = "color: green;"
                else:
                    status_text = "⚠️ VAD ran and found no voice.\n Keep audio by choosing 'Keep Audio'."
                    status_style = "color: #ff6b00; font-weight: bold; background-color: #fff3cd; padding: 5px; border-radius: 3px;"
            elif not get_config().vad.do_vad_postprocessing:
                status_text = "✔ Audio file available (VAD disabled)"
                status_style = "color: green;"
        
        self.audio_status_label.setText(status_text)
        self.audio_status_label.setStyleSheet(status_style)
        
        # Check for unsupported codecs
        is_unsupported, codec_name = self._is_unsupported_audio_codec(self.audio_path)
        
        if has_audio_file:
            if is_unsupported:
                # Show informational message and hide waveform controls
                self.codec_info_label.setText(
                    f"ℹ️ {codec_name} codec is not supported for manual trimming. "
                    f"Supported formats: OPUS, OGG, MP3. You can still include the audio in your card."
                )
                self.codec_info_label.setVisible(True)
                self.waveform_widget.setVisible(False)
                self.audio_button.setVisible(False)
                self.play_original_button.setVisible(False)
                self.reset_audio_button.setVisible(False)
            else:
                # Supported format - show waveform and trimming controls
                self.codec_info_label.setVisible(False)
                self.waveform_widget.load_audio(self.audio_path)
                self.waveform_widget.setVisible(True)
                self.audio_button.setVisible(True)
                self.play_original_button.setVisible(True)
                self.reset_audio_button.setVisible(True)
                self.audio_button.setText("▶ Play Range")
                self.audio_button.setStyleSheet("")
        else:
            self.codec_info_label.setVisible(False)
            self.waveform_widget.setVisible(False)
            self.audio_button.setVisible(False)
            self.play_original_button.setVisible(False)
            self.reset_audio_button.setVisible(False)

        # TTS
        show_tts = False
        if get_config().vad.tts_url and get_config().vad.tts_url != "http://127.0.0.1:5050/?term=$s" and sentence:
            show_tts = True
            
        self.tts_button.setVisible(show_tts)
        self.tts_status_label.setVisible(show_tts)
        self.tts_status_label.setText("")
        
        if show_tts:
            tts_used = getattr(self.vad_result, 'tts_used', False) if self.vad_result else False
            self.tts_button.setText("🔊 " + ("Regenerate" if tts_used else "Generate") + " TTS Audio")

        # Buttons
        if has_audio_file:
            self.voice_button.setVisible(True)
            self.no_voice_button.setVisible(True)
            self.confirm_button.setVisible(False)
        else:
            self.voice_button.setVisible(False)
            self.no_voice_button.setVisible(False)
            self.confirm_button.setVisible(True)

        self._configure_tab_order()

    def _load_image_to_label(self, path, label_widget):
        if not path or not os.path.exists(path):
            label_widget.setPixmap(QPixmap())
            label_widget.setText(f"Image not found")
            return

        try:
            img = Image.open(path)
            # Increase thumbnail size since it can be resized dynamically
            # img.thumbnail((1280, 720)) 
            if img.mode in ('RGBA', 'LA', 'P'):
                if img.mode == 'P':
                    img = img.convert('RGBA')
                rgb_img = Image.new('RGB', img.size, (255, 255, 255))
                rgb_img.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                img = rgb_img
            
            img_data = img.tobytes('raw', 'RGB')
            qimage = QImage(img_data, img.width, img.height, img.width * 3, QImage.Format.Format_RGB888)
            pixmap = QPixmap.fromImage(qimage)
            label_widget.setPixmap(pixmap)
        except Exception as e:
            label_widget.setPixmap(QPixmap())
            label_widget.setText(f"Could not load image:\n{e}")
            label_widget.setStyleSheet("color: red;")

    def _apply_window_behavior_preferences(self):
        anki_config = get_config().anki
        flags = Qt.WindowType.Dialog | Qt.WindowType.WindowMinimizeButtonHint | Qt.WindowType.WindowMaximizeButtonHint
        if getattr(anki_config, "confirmation_always_on_top", True):
            flags |= Qt.WindowType.WindowStaysOnTopHint
        self.setWindowFlags(flags)

    def showEvent(self, event):
        if self.first_launch:
            restored = window_state_manager.restore_geometry(self, WindowId.ANKI_CONFIRMATION)
            if not restored:
                self._center_on_screen()
            self.first_launch = False
        super().showEvent(event)

        if getattr(get_config().anki, "confirmation_focus_on_show", True):
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
        vad_ran = self.vad_result is not None and hasattr(self.vad_result, 'success')
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
        gsm_state.disable_anki_confirmation_session = (state == Qt.CheckState.Checked.value)

    def _on_handle_moved(self, which, start, end):
        if which == 'start':
            # Stop audio and force restart (debounced)
            self.audio_player.stop_audio()
            # Force autoplay even if checkbox is off, per user request
            self._force_autoplay = True 
            self._trim_autoplay_timer.start()
        elif which == 'end':
            # Do NOT stop audio immediately.
            # Do NOT trigger autoplay timer.
            # Logic in _update_playback_cursor will handle stopping if we pass the new end.
            if self.autoplay_checkbox.isChecked():
                 pass # Explicitly ignore autoplay for end trim changes to avoid restarts

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
        unsupported_codecs = ['.aac', '.m4a']
        
        if ext in unsupported_codecs:
            return True, ext[1:].upper()  # Return codec name without dot, uppercase
        
        return False, None
    
    def _configure_tab_order(self):
        tab_sequence = [self.sentence_text]
        if self.translation_text.isVisible():
            tab_sequence.append(self.translation_text)
        tab_sequence.append(self.screenshot_button)
        if self.prev_screenshot_button.isVisible():
            tab_sequence.append(self.prev_screenshot_button)
        if self.audio_button.isVisible():
            tab_sequence.append(self.audio_button)
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
            mode=get_config().screenshot.screenshot_timing_setting
        )
        if not selected_path:
            return
        target_attr = 'previous_screenshot_path' if previous else 'screenshot_path'
        label_widget = self.prev_image_label if previous else self.image_label
        setattr(self, target_attr, selected_path)
        self._load_image_to_label(selected_path, label_widget)
    
    def _play_audio(self, audio_path, full=False):
        if self.audio_player.is_playing:
             self.audio_player.stop_audio()
             self._update_audio_buttons()
             return

        if not audio_path or not os.path.isfile(audio_path):
            print(f"Audio file does not exist: {audio_path}")
            return
        
        # Reset offset for full playback
        if full:
             self._playback_start_offset = 0.0
        
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
                    self._update_audio_buttons()
                    self.playback_timer.start()
        except Exception as e:
            print(f"Failed to play audio: {e}")

    def _play_range(self):
        if self.audio_player.is_playing:
             self.audio_player.stop_audio()
             self._update_audio_buttons()
             return

        if not self.audio_path or not os.path.isfile(self.audio_path):
            return

        # Stop any existing playback (already handled by check above but for safety)
        self.audio_player.stop_audio()
        self.playback_timer.stop()
        
        start, end = self.waveform_widget.get_selection_range()
        
        # Get data from widget directly to avoid reloading
        if self.waveform_widget.audio_data is None:
             self.waveform_widget.load_audio(self.audio_path)
        
        data = self.waveform_widget.audio_data
        sr = self.waveform_widget.samplerate
        
        if data is None:
            return

        # Slice data with small padding at the end to prevent premature cutoff
        start_sample = int(start * sr)
        # We play until the end of the file to allow dynamic extension of the end handle
        # The _update_playback_cursor method handles stopping at the specific end time
        end_sample = len(data) 
        
        if start_sample >= len(data):
            start_sample = 0
            
        sliced_data = data[start_sample:end_sample]
        
        success = self.audio_player.play_audio_data(sliced_data, sr)
        if success:
            self._update_audio_buttons()
            self.playback_timer.start()
            # Store start offset for cursor calculation
            self._playback_start_offset = start

    def _update_playback_cursor(self):
        if self.audio_player.is_playing:
            current_time = self.audio_player.get_current_time()
            offset = getattr(self, '_playback_start_offset', 0.0)
            absolute_pos = offset + current_time
            self.waveform_widget.set_playback_position(absolute_pos)
            
            # Check if we've exceeded the end trim
            # Add a small buffer/epsilon if needed, but strict check is usually fine
            if absolute_pos > self.waveform_widget.end_time:
                 self.audio_player.stop_audio()
                 self._update_audio_buttons()
        else:
             self.playback_timer.stop()
             self.waveform_widget.set_playback_position(-1)
             self._update_audio_buttons()

    def _reset_audio_trim(self):
        if self.waveform_widget.audio_data is not None:
            self.waveform_widget.start_time = 0.0
            self.waveform_widget.end_time = self.waveform_widget.duration
            self.waveform_widget.range_changed.emit(0.0, self.waveform_widget.duration)
            self.waveform_widget.update()

    def _save_trimmed_audio(self):
        if self.waveform_widget.audio_data is None:
             return self.audio_path

        # Check if trimmed
        start, end = self.waveform_widget.get_selection_range()
        duration = self.waveform_widget.duration
        
        # Tolerance for float comparison
        if abs(start) < 0.01 and abs(end - duration) < 0.01:
            return self.audio_path # No significant trim
            
        game_name = sanitize_filename(gsm_state.current_game) if gsm_state.current_game else "trimmed"
        orig_ext = os.path.splitext(self.audio_path)[1]
        if not orig_ext: orig_ext = ".wav" 
        
        filename = f"{game_name}_trimmed_{int(time.time())}{orig_ext}"
        new_path = make_unique_file_name(
            os.path.join(get_temporary_directory(), filename)
        )
        
        try:
            # Use ffmpeg wrapper to trim which handles formats properly
            trim_audio(
                input_audio=self.audio_path,
                start_time=start,
                end_time=end,
                output_audio=new_path,
                trim_beginning=True,
                fade_in_duration=0.05,
                fade_out_duration=0.05
            )
            return new_path
        except Exception as e:
            logger.error(f"Failed to save trimmed audio: {e}")
            return self.audio_path
    
    def _audio_finished(self):
        self.playback_timer.stop()
        self.waveform_widget.set_playback_position(-1)
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
            tts_audio_path = make_unique_file_name(
                os.path.join(get_temporary_directory(), filename)
            )
            with open(tts_audio_path, 'wb') as f:
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
        
    def _on_voice(self):
        self._cleanup_audio()
        
        final_audio_path = self._save_trimmed_audio()
        
        # UPDATE 3: Comment out access to missing checkbox
        # if self.disable_dialog_checkbox.isChecked():
        #    self._save_disable_preference()
            
        translation = self.translation_text.toPlainText().strip()
        self.result = (True, self.sentence_text.toPlainText().strip(), translation, 
                      self.screenshot_path, self.previous_screenshot_path, 
                      self.nsfw_tag_checkbox.isChecked(), final_audio_path)
        self.accept()

    def _on_no_voice(self):
        self._cleanup_audio()
        # UPDATE 4: Comment out access to missing checkbox
        # if self.disable_dialog_checkbox.isChecked():
        #     self._save_disable_preference()
            
        translation = self.translation_text.toPlainText().strip()
        self.result = (False, self.sentence_text.toPlainText().strip(), translation,
                      self.screenshot_path, self.previous_screenshot_path, 
                      self.nsfw_tag_checkbox.isChecked(), self.audio_path)
        self.accept()

    def _save_disable_preference(self):
        config = get_config()
        config.anki.show_update_confirmation_dialog_v2 = False
        save_current_config(config)
        reload_config()
    
    def closeEvent(self, event):
        self._cancel_auto_accept()
        self._cleanup_audio()
        window_state_manager.save_geometry(self, WindowId.ANKI_CONFIRMATION)
        super().closeEvent(event)
        
    def exec(self):
        super().exec()
        window_state_manager.save_geometry(self, WindowId.ANKI_CONFIRMATION)
        return self.result

def show_anki_confirmation(parent, expression, sentence, screenshot_path, previous_screenshot_path,
                          audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp, pending_animated=False):
    global _anki_confirmation_dialog_instance
    
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    
    if gsm_state.disable_anki_confirmation_session:
        vad_result = gsm_state.vad_result
        vad_ran = vad_result is not None and hasattr(vad_result, 'success')
        vad_detected_voice = vad_ran and bool(vad_result.success)
        
        final_audio_path = audio_path
        if not final_audio_path and vad_result:
            final_audio_path = vad_result.trimmed_audio_path
            
        logger.info("Anki confirmation skipped (Session disabled). Restart app or wait 15m after replay buffer stops to re-enable.")
        return (vad_detected_voice, sentence, translation, screenshot_path, previous_screenshot_path, False, final_audio_path)

    if _anki_confirmation_dialog_instance is None:
        # Pass the parent!
        _anki_confirmation_dialog_instance = AnkiConfirmationDialog(parent)
    
    _anki_confirmation_dialog_instance.populate_ui(
        expression, sentence, screenshot_path, previous_screenshot_path,
        audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp, pending_animated
    )
    
    result = _anki_confirmation_dialog_instance.exec()
    return result
