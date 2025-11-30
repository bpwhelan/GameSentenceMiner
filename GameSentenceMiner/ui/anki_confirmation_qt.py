import time
import os
import sys
import json
import requests
from urllib.parse import quote
from PyQt6.QtWidgets import (QApplication, QDialog, QVBoxLayout, QHBoxLayout, 
                              QLabel, QTextEdit, QPushButton, QCheckBox, QGridLayout,
                              QMessageBox, QWidget)
from PyQt6.QtCore import Qt, pyqtSignal, QTimer
from PyQt6.QtGui import QPixmap, QImage
from PIL import Image

from GameSentenceMiner.util.configuration import get_config, logger, gsm_state, get_temporary_directory, save_current_config, reload_config
from GameSentenceMiner.util.audio_player import AudioPlayer
from GameSentenceMiner.util.gsm_utils import make_unique_file_name, remove_html_and_cloze_tags
from GameSentenceMiner.util.model import VADResult
from GameSentenceMiner.ui import window_state_manager, WindowId

# -------------------------------------------------------------------------
# Anki Confirmation Dialog
# -------------------------------------------------------------------------

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

        # Auto-accept timer
        self._auto_accept_qtimer = None
        self._auto_accept_countdown_timer = None
        self._auto_accept_remaining = 0
        self.auto_accept_label = None

        # Audio player
        self.audio_player = AudioPlayer(finished_callback=self._audio_finished)
        self.audio_finished_signal.connect(self._update_audio_button)

        self.setWindowTitle("Confirm Anki Card Details")
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Dialog | Qt.WindowType.WindowMinimizeButtonHint)
        self.setModal(True)
        
        self._init_ui()
        
    def _init_ui(self):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(20, 20, 20, 20)
        main_layout.setSpacing(10)

        self.auto_accept_label = QLabel()
        self.auto_accept_label.setStyleSheet("color: #007bff; font-weight: bold; font-size: 14px;")
        self.auto_accept_label.setVisible(False)
        main_layout.addWidget(self.auto_accept_label, alignment=Qt.AlignmentFlag.AlignCenter)
        
        self.grid_layout = QGridLayout()
        self.grid_layout.setSpacing(5)
        row = 0
        
        # 1. Expression
        self.expr_label_title = QLabel(f"{get_config().anki.word_field}:")
        self.expr_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.expr_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
        self.expr_value_label = QLabel()
        self.expr_value_label.setWordWrap(True)
        self.expr_value_label.setMaximumWidth(400)
        self.grid_layout.addWidget(self.expr_value_label, row, 1, Qt.AlignmentFlag.AlignLeft)
        row += 1
        
        # 2. Sentence
        self.sentence_label_title = QLabel(f"{get_config().anki.sentence_field}:")
        self.sentence_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.sentence_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
        self.sentence_text = QTextEdit()
        self.sentence_text.setMaximumHeight(100)
        self.sentence_text.setMinimumWidth(400)
        self.sentence_text.setTabChangesFocus(True)
        self.sentence_text.textChanged.connect(self._cancel_auto_accept)
        self.grid_layout.addWidget(self.sentence_text, row, 1)
        row += 1
        
        # 3. Translation
        self.translation_label_title = QLabel(f"{get_config().ai.anki_field}:")
        self.translation_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.translation_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
        self.translation_text = QTextEdit()
        self.translation_text.setMaximumHeight(100)
        self.translation_text.setMinimumWidth(400)
        self.translation_text.setTabChangesFocus(True)
        self.translation_text.textChanged.connect(self._cancel_auto_accept)
        self.grid_layout.addWidget(self.translation_text, row, 1)
        row += 1
        
        # 4. Screenshot
        self.screenshot_label_title = QLabel(f"{get_config().anki.picture_field}:")
        self.screenshot_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.screenshot_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
        self.image_label = QLabel()
        self.grid_layout.addWidget(self.image_label, row, 1, Qt.AlignmentFlag.AlignLeft)
        
        self.screenshot_button = QPushButton("Select New Screenshot")
        self.screenshot_button.clicked.connect(self._cancel_auto_accept)
        self.screenshot_button.clicked.connect(lambda: self._select_screenshot(previous=False))
        self.grid_layout.addWidget(self.screenshot_button, row, 2, Qt.AlignmentFlag.AlignLeft)
        row += 1
        
        # 5. Previous Screenshot
        self.prev_screenshot_label_title = QLabel(f"{get_config().anki.previous_image_field}:")
        self.prev_screenshot_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.prev_screenshot_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
        self.prev_image_label = QLabel()
        self.grid_layout.addWidget(self.prev_image_label, row, 1, Qt.AlignmentFlag.AlignLeft)
        
        self.prev_screenshot_button = QPushButton("Select New Previous Screenshot")
        self.prev_screenshot_button.clicked.connect(self._cancel_auto_accept)
        self.prev_screenshot_button.clicked.connect(lambda: self._select_screenshot(previous=True))
        self.grid_layout.addWidget(self.prev_screenshot_button, row, 2, Qt.AlignmentFlag.AlignLeft)
        row += 1
        
        # 6. Audio
        self.audio_label_title = QLabel("Audio:")
        self.audio_label_title.setStyleSheet("font-weight: bold;")
        self.grid_layout.addWidget(self.audio_label_title, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)

        self.audio_status_label = QLabel()
        self.grid_layout.addWidget(self.audio_status_label, row, 1, Qt.AlignmentFlag.AlignLeft)

        self.audio_button = QPushButton("▶ Play Audio")
        self.audio_button.clicked.connect(self._cancel_auto_accept)
        self.audio_button.clicked.connect(lambda: self._play_audio(self.audio_path))
        self.audio_button.setMaximumWidth(120)
        self.grid_layout.addWidget(self.audio_button, row, 2, Qt.AlignmentFlag.AlignLeft)
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
        
        main_layout.addLayout(self.grid_layout)
        
        # NSFW Tag
        self.nsfw_tag_checkbox = QCheckBox("Add NSFW tag?")
        self.nsfw_tag_checkbox.stateChanged.connect(self._cancel_auto_accept)
        main_layout.addWidget(self.nsfw_tag_checkbox, alignment=Qt.AlignmentFlag.AlignCenter)
        
        # Action Buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)
        
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
        
        main_layout.addLayout(button_layout)
        
        self.setLayout(main_layout)

    def populate_ui(self, expression, sentence, screenshot_path, previous_screenshot_path, audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp):
        # Store state
        self.screenshot_timestamp = screenshot_timestamp
        self.previous_screenshot_timestamp = previous_screenshot_timestamp
        self.screenshot_path = screenshot_path
        self.previous_screenshot_path = previous_screenshot_path
        self.vad_result = gsm_state.vad_result
        self.result = None
        
        self.expr_value_label.setText(expression)
        
        self.sentence_text.blockSignals(True)
        self.sentence_text.setPlainText(sentence)
        self.sentence_text.blockSignals(False)
        
        self.nsfw_tag_checkbox.setChecked(False)

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
        self.audio_button.setVisible(has_audio_file)
        self.audio_button.setText("▶ Play Audio")
        self.audio_button.setStyleSheet("")

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
            label_widget.setText(f"Image not found")
            return

        try:
            img = Image.open(path)
            img.thumbnail((400, 300))
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
            label_widget.setText(f"Could not load image:\n{e}")
            label_widget.setStyleSheet("color: red;")

    def showEvent(self, event):
        if self.first_launch:
            restored = window_state_manager.restore_geometry(self, WindowId.ANKI_CONFIRMATION)
            if not restored:
                self._center_on_screen()
            self.first_launch = False
        super().showEvent(event)
        
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
    
    def _play_audio(self, audio_path):
        if not audio_path or not os.path.isfile(audio_path):
            print(f"Audio file does not exist: {audio_path}")
            return
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
                    self._update_audio_button()
        except Exception as e:
            print(f"Failed to play audio: {e}")
    
    def _audio_finished(self):
        self.audio_finished_signal.emit()
    
    def _update_audio_button(self):
        if self.audio_button:
            if self.audio_player.is_playing:
                self.audio_button.setText("⏹ Stop")
                self.audio_button.setStyleSheet("background-color: #ffc107; color: black;")
            else:
                self.audio_button.setText("▶ Play Audio")
                self.audio_button.setStyleSheet("")
    
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
            self.audio_status_label.setText("✔ TTS audio generated")
            self.audio_status_label.setStyleSheet("color: green;")
            self.audio_button.setVisible(True)
            self.voice_button.setVisible(True)
            self.no_voice_button.setVisible(True)
            self.confirm_button.setVisible(False)
            self.tts_status_label.setText("✓ TTS Audio Generated")
            self.tts_status_label.setStyleSheet("color: green;")
            self.tts_button.setText("🔊 Regenerate TTS Audio")
        except Exception as e:
            logger.error(f"TTS Error: {e}")
            QMessageBox.critical(self, "TTS Error", str(e))
    
    def _cleanup_audio(self):
        self.audio_player.cleanup()
        
    def _on_voice(self):
        self._cleanup_audio()
        # UPDATE 3: Comment out access to missing checkbox
        # if self.disable_dialog_checkbox.isChecked():
        #    self._save_disable_preference()
            
        translation = self.translation_text.toPlainText().strip()
        self.result = (True, self.sentence_text.toPlainText().strip(), translation, 
                      self.screenshot_path, self.previous_screenshot_path, 
                      self.nsfw_tag_checkbox.isChecked(), self.audio_path)
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
                          audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp):
    global _anki_confirmation_dialog_instance
    
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    
    if _anki_confirmation_dialog_instance is None:
        # Pass the parent!
        _anki_confirmation_dialog_instance = AnkiConfirmationDialog(parent)
    
    _anki_confirmation_dialog_instance.populate_ui(
        expression, sentence, screenshot_path, previous_screenshot_path,
        audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp
    )
    
    result = _anki_confirmation_dialog_instance.exec()
    return result