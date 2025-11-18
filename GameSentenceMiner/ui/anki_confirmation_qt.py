import time
import os
import sys
import requests
from urllib.parse import quote
from PyQt6.QtWidgets import (QApplication, QDialog, QVBoxLayout, QHBoxLayout, 
                              QLabel, QTextEdit, QPushButton, QCheckBox, QGridLayout,
                              QMessageBox)
from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QPixmap, QImage
from PIL import Image

from GameSentenceMiner.util.configuration import get_config, logger, gsm_state, get_temporary_directory, save_current_config, reload_config
from GameSentenceMiner.util.audio_player import AudioPlayer
from GameSentenceMiner.util.gsm_utils import make_unique_file_name, remove_html_and_cloze_tags
from GameSentenceMiner.util.model import VADResult


class AnkiConfirmationDialog(QDialog):
    """
    A modal dialog to confirm Anki card details and choose an audio option.
    """
    # Signal to safely update UI from audio callback thread
    audio_finished_signal = pyqtSignal()
    
    def __init__(self, parent, config_app, expression, sentence, screenshot_path, previous_screenshot_path, audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp):
        super().__init__(parent)
        self.config_app = config_app
        self.screenshot_timestamp = screenshot_timestamp
        self.previous_screenshot_timestamp = previous_screenshot_timestamp
        self.translation_text = None
        self.sentence_text = None
        self.sentence = sentence  # Store sentence text for TTS
        # self.vad_result = None
        self.vad_result = gsm_state.vad_result  # Store VAD resultV if provided
        
        # Initialize screenshot_path here, will be updated by button if needed
        self.screenshot_path = screenshot_path
        self.previous_screenshot_path = previous_screenshot_path
        self.audio_path = audio_path  # Store audio path so it can be updated
        if not self.audio_path:
            self.audio_path = self.vad_result.trimmed_audio_path

        # Audio player management
        self.audio_player = AudioPlayer(finished_callback=self._audio_finished)
        self.audio_button = None  # Store reference to audio button
        
        # Connect the signal to the slot for thread-safe UI updates
        self.audio_finished_signal.connect(self._update_audio_button)
        self.audio_path_label = None  # Store reference to audio path label
        self.audio_status_label = None  # Store reference to audio status label (for VAD warnings)
        self.tts_button = None  # Store reference to TTS button
        self.tts_status_label = None  # Store reference to TTS status label
        
        # NSFW tag option
        self.nsfw_tag_checkbox = None
        
        self.result = None  # This will store the user's choice
        
        # Set window properties
        self.setWindowTitle("Confirm Anki Card Details")
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Dialog)
        self.setModal(True)
        
        # Create and lay out widgets
        self._create_widgets(expression, sentence, screenshot_path, self.audio_path, translation)
        
        # Center the dialog on screen
        self._center_on_screen()
        
    def _center_on_screen(self):
        """Center the dialog horizontally and skew towards the top (50px from top)"""
        screen = QApplication.primaryScreen()
        if screen:
            screen_geometry = screen.geometry()
            dialog_geometry = self.frameGeometry()
            center_point = screen_geometry.center()
            dialog_geometry.moveCenter(center_point)
            # Move to 50px from top, keep centered horizontally
            new_x = dialog_geometry.topLeft().x()
            new_y = screen_geometry.top() + 50
            self.move(new_x, new_y)
    
    def _create_widgets(self, expression, sentence, screenshot_path, audio_path, translation):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(20, 20, 20, 20)
        main_layout.setSpacing(10)
        
        # Create grid layout for fields
        grid_layout = QGridLayout()
        grid_layout.setSpacing(5)
        row = 0
        
        # Expression
        expr_label = QLabel(f"{get_config().anki.word_field}:")
        expr_label.setStyleSheet("font-weight: bold;")
        grid_layout.addWidget(expr_label, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        expr_value = QLabel(expression)
        expr_value.setWordWrap(True)
        expr_value.setMaximumWidth(400)
        grid_layout.addWidget(expr_value, row, 1, Qt.AlignmentFlag.AlignLeft)
        row += 1
        
        # Sentence
        sentence_label = QLabel(f"{get_config().anki.sentence_field}:")
        sentence_label.setStyleSheet("font-weight: bold;")
        grid_layout.addWidget(sentence_label, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        self.sentence_text = QTextEdit()
        self.sentence_text.setPlainText(sentence)
        self.sentence_text.setMaximumHeight(100)
        self.sentence_text.setMinimumWidth(400)
        self.sentence_text.setTabChangesFocus(True)  # Tab navigates to next widget instead of inserting tab
        grid_layout.addWidget(self.sentence_text, row, 1)
        row += 1
        
        # Translation (if present)
        if translation:
            translation_label = QLabel(f"{get_config().ai.anki_field}:")
            translation_label.setStyleSheet("font-weight: bold;")
            grid_layout.addWidget(translation_label, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
            self.translation_text = QTextEdit()
            self.translation_text.setPlainText(translation)
            self.translation_text.setMaximumHeight(100)
            self.translation_text.setMinimumWidth(400)
            self.translation_text.setTabChangesFocus(True)  # Tab navigates to next widget instead of inserting tab
            grid_layout.addWidget(self.translation_text, row, 1)
            row += 1
        
        # Screenshot
        screenshot_label = QLabel(f"{get_config().anki.picture_field}:")
        screenshot_label.setStyleSheet("font-weight: bold;")
        grid_layout.addWidget(screenshot_label, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
        
        self.image_label = QLabel()
        try:
            img = Image.open(screenshot_path)
            img.thumbnail((400, 300))
            # Convert PIL to QPixmap
            if img.mode in ('RGBA', 'LA', 'P'):
                if img.mode == 'P':
                    img = img.convert('RGBA')
                rgb_img = Image.new('RGB', img.size, (255, 255, 255))
                rgb_img.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                img = rgb_img
            
            img_data = img.tobytes('raw', 'RGB')
            qimage = QImage(img_data, img.width, img.height, img.width * 3, QImage.Format.Format_RGB888)
            self.photo_pixmap = QPixmap.fromImage(qimage)
            self.image_label.setPixmap(self.photo_pixmap)
        except Exception as e:
            self.image_label.setText(f"Could not load image:\n{screenshot_path}\n{e}")
            self.image_label.setStyleSheet("color: red;")
        
        grid_layout.addWidget(self.image_label, row, 1, Qt.AlignmentFlag.AlignLeft)
        
        # Screenshot selector button
        self.screenshot_button = QPushButton("Select New Screenshot")
        self.screenshot_button.clicked.connect(lambda: self._select_screenshot(previous=False))
        grid_layout.addWidget(self.screenshot_button, row, 2, Qt.AlignmentFlag.AlignLeft)
        row += 1
        
        # Previous Screenshot (if provided)
        if self.previous_screenshot_path and get_config().anki.previous_image_field:
            prev_screenshot_label = QLabel(f"{get_config().anki.previous_image_field}:")
            prev_screenshot_label.setStyleSheet("font-weight: bold;")
            grid_layout.addWidget(prev_screenshot_label, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)
            
            self.prev_image_label = QLabel()
            try:
                img = Image.open(self.previous_screenshot_path)
                img.thumbnail((400, 300))
                # Convert PIL to QPixmap
                if img.mode in ('RGBA', 'LA', 'P'):
                    if img.mode == 'P':
                        img = img.convert('RGBA')
                    rgb_img = Image.new('RGB', img.size, (255, 255, 255))
                    rgb_img.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                    img = rgb_img
                
                img_data = img.tobytes('raw', 'RGB')
                qimage = QImage(img_data, img.width, img.height, img.width * 3, QImage.Format.Format_RGB888)
                self.prev_photo_pixmap = QPixmap.fromImage(qimage)
                self.prev_image_label.setPixmap(self.prev_photo_pixmap)
            except Exception as e:
                self.prev_image_label.setText(f"Could not load image:\n{self.previous_screenshot_path}\n{e}")
                self.prev_image_label.setStyleSheet("color: red;")
            
            grid_layout.addWidget(self.prev_image_label, row, 1, Qt.AlignmentFlag.AlignLeft)
            
            # Previous screenshot selector button
            self.prev_screenshot_button = QPushButton("Select New Previous Screenshot")
            self.prev_screenshot_button.clicked.connect(lambda: self._select_screenshot(previous=True))
            grid_layout.addWidget(self.prev_screenshot_button, row, 2, Qt.AlignmentFlag.AlignLeft)
            row += 1
        else:
            self.prev_image_label = None
            self.prev_screenshot_button = None
        
        # Audio status (concise message instead of full path)
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
                elif self.vad_result.tts_used:
                    status_text = "✔ TTS audio generated"
                    status_style = "color: green;"
                else:
                    status_text = "⚠️ VAD ran and found no voice.\n Keep audio by choosing 'Keep Audio'."
                    status_style = "color: #ff6b00; font-weight: bold; background-color: #fff3cd; padding: 5px; border-radius: 3px;"
            elif not get_config().vad.do_vad_postprocessing:
                status_text = "✔ Audio file available (VAD disabled)"
                status_style = "color: green;"

        audio_label = QLabel("Audio:")
        audio_label.setStyleSheet("font-weight: bold;")
        grid_layout.addWidget(audio_label, row, 0, Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignRight)

        self.audio_status_label = QLabel(status_text)
        self.sentence_text.setMaximumHeight(100)
        self.sentence_text.setMinimumWidth(400)
        if status_style:
            self.audio_status_label.setStyleSheet(status_style)
        # self.audio_status_label.setMaximumWidth(400)
        grid_layout.addWidget(self.audio_status_label, row, 1, Qt.AlignmentFlag.AlignLeft)

        if has_audio_file:
            self.audio_button = QPushButton("▶ Play Audio")
            self.audio_button.clicked.connect(lambda: self._play_audio(self.audio_path))
            self.audio_button.setMaximumWidth(120)
            grid_layout.addWidget(self.audio_button, row, 2, Qt.AlignmentFlag.AlignLeft)

        row += 1

        # TTS Button - only show if TTS is enabled in config
        if get_config().vad.tts_url and get_config().vad.tts_url != "http://127.0.0.1:5050/?term=$s" and sentence:
            self.tts_button = QPushButton("🔊" + ("Regenerate" if self.vad_result.tts_used else "Generate") + " TTS Audio")
            self.tts_button.clicked.connect(self._generate_tts_audio)
            self.tts_button.setMaximumWidth(180)
            grid_layout.addWidget(self.tts_button, row, 1, Qt.AlignmentFlag.AlignLeft)

            # TTS Status Label
            self.tts_status_label = QLabel("")
            self.tts_status_label.setStyleSheet("color: green;")
            grid_layout.addWidget(self.tts_status_label, row, 2, Qt.AlignmentFlag.AlignLeft)

            row += 1
        
        main_layout.addLayout(grid_layout)
        
        # NSFW Tag Option
        self.nsfw_tag_checkbox = QCheckBox("Add NSFW tag?")
        self.nsfw_tag_checkbox.setChecked(False)
        main_layout.addWidget(self.nsfw_tag_checkbox, alignment=Qt.AlignmentFlag.AlignCenter)
        
        # Action Buttons
        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)
        
        if audio_path and os.path.isfile(audio_path):
            self.voice_button = QPushButton("Keep Audio")
            self.voice_button.clicked.connect(self._on_voice)
            self.voice_button.setStyleSheet("background-color: #28a745; color: white; padding: 8px 20px;")
            button_layout.addWidget(self.voice_button)
            
            self.no_voice_button = QPushButton("No Audio")
            self.no_voice_button.clicked.connect(self._on_no_voice)
            self.no_voice_button.setStyleSheet("background-color: #dc3545; color: white; padding: 8px 20px;")
            button_layout.addWidget(self.no_voice_button)
        else:
            self.confirm_button = QPushButton("Confirm")
            self.confirm_button.clicked.connect(self._on_no_voice)
            self.confirm_button.setStyleSheet("background-color: #007bff; color: white; padding: 8px 20px;")
            button_layout.addWidget(self.confirm_button)
            
        self.disable_dialog_checkbox = QCheckBox("Disable this dialogue")
        self.disable_dialog_checkbox.setChecked(False)
        button_layout.addWidget(self.disable_dialog_checkbox, alignment=Qt.AlignmentFlag.AlignLeft)
        
        main_layout.addLayout(button_layout)
        
        # Set the layout
        self.setLayout(main_layout)
        
        # Configure tab order: Sentence -> Translation (if exists) -> Screenshot button -> 
        # Play audio (if exists) -> Generate TTS (if exists) -> NSFW checkbox -> Voice/No Voice buttons
        self._configure_tab_order(translation, audio_path)
    
    def _configure_tab_order(self, translation, audio_path):
        """Configure tab order for all focusable widgets in the dialog"""
        # Build the tab order sequence
        tab_sequence = [self.sentence_text]
        
        # Add translation if it exists
        if translation and self.translation_text:
            tab_sequence.append(self.translation_text)
        
        # Add screenshot button
        tab_sequence.append(self.screenshot_button)
        
        # Add audio button if it exists
        if self.audio_button:
            tab_sequence.append(self.audio_button)
        
        # Add TTS button if it exists
        if self.tts_button:
            tab_sequence.append(self.tts_button)
        
        # Add NSFW checkbox
        tab_sequence.append(self.nsfw_tag_checkbox)
        
        # Add voice/confirm buttons
        if hasattr(self, 'voice_button'):
            tab_sequence.append(self.voice_button)
            tab_sequence.append(self.no_voice_button)
        elif hasattr(self, 'confirm_button'):
            tab_sequence.append(self.confirm_button)
        
        # Set the tab order
        for i in range(len(tab_sequence) - 1):
            self.setTabOrder(tab_sequence[i], tab_sequence[i + 1])
    
    def _select_screenshot(self, previous: bool = False):
        from GameSentenceMiner.ui.qt_main import launch_screenshot_selector
        video_path = gsm_state.current_replay

        timestamp = self.previous_screenshot_timestamp if previous else self.screenshot_timestamp
        selected_path = launch_screenshot_selector(
            video_path,
            timestamp,
            mode=get_config().screenshot.screenshot_timing_setting
        )

        if not selected_path:
            return

        target_attr = 'previous_screenshot_path' if previous else 'screenshot_path'
        try:
            img = Image.open(selected_path)
            img.thumbnail((400, 300))
            # Convert PIL to QPixmap
            if img.mode in ('RGBA', 'LA', 'P'):
                if img.mode == 'P':
                    img = img.convert('RGBA')
                rgb_img = Image.new('RGB', img.size, (255, 255, 255))
                rgb_img.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                img = rgb_img

            img_data = img.tobytes('raw', 'RGB')
            qimage = QImage(img_data, img.width, img.height, img.width * 3, QImage.Format.Format_RGB888)
            pixmap = QPixmap.fromImage(qimage)

            # Assign the selected path to the appropriate attribute
            setattr(self, target_attr, selected_path)

            # Update corresponding UI label
            if previous:
                if self.prev_image_label:
                    self.prev_photo_pixmap = pixmap
                    self.prev_image_label.setPixmap(self.prev_photo_pixmap)
                    self.prev_image_label.setText("")
            else:
                if self.image_label:
                    self.photo_pixmap = pixmap
                    self.image_label.setPixmap(self.photo_pixmap)
                    self.image_label.setText("")
        except Exception as e:
            logger.error(f"Error updating screenshot: {e}")
    
    def _play_audio(self, audio_path):
        if not os.path.isfile(audio_path):
            print(f"Audio file does not exist: {audio_path}")
            return
        
        try:
            # Check if we have a configuration for external audio player
            if get_config().advanced.audio_player_path:
                # Use external audio player
                import platform
                import subprocess
                if platform.system() == "Windows":
                    os.startfile(audio_path)
                elif platform.system() == "Darwin":
                    subprocess.run(["open", audio_path])
                else:
                    subprocess.run(["xdg-open", audio_path])
            else:
                # Use internal audio player
                success = self.audio_player.play_audio_file(audio_path)
                if success:
                    self._update_audio_button()
                
        except Exception as e:
            print(f"Failed to play audio: {e}")
    
    def _audio_finished(self):
        """Called when audio playback finishes (from background thread)"""
        # Emit signal to update UI on main thread
        self.audio_finished_signal.emit()
    
    def _update_audio_button(self):
        """Update the audio button text and style based on playing state"""
        if self.audio_button:
            if self.audio_player.is_playing:
                self.audio_button.setText("⏹ Stop")
                self.audio_button.setStyleSheet("background-color: #ffc107; color: black;")
            else:
                self.audio_button.setText("▶ Play Audio")
                self.audio_button.setStyleSheet("")
    
    def _generate_tts_audio(self):
        """Generate TTS audio from the sentence text"""
        try:
            # Get the current sentence text from the widget
            sentence_text = self.sentence_text.toPlainText().strip()
            
            sentence_text = remove_html_and_cloze_tags(sentence_text)
            
            if not sentence_text:
                QMessageBox.critical(self, "TTS Error", "No sentence text available for TTS generation.")
                return
            
            # URL-encode the sentence text
            encoded_text = quote(sentence_text)
            
            # Build the TTS URL by replacing $s with the encoded text
            tts_url = get_config().vad.tts_url.replace("$s", encoded_text)
            
            logger.info(f"Fetching TTS audio from: {tts_url}")
            
            # Fetch TTS audio from the URL
            response = requests.get(tts_url, timeout=10)
            
            if not response.ok:
                error_msg = f"Failed to fetch TTS audio: HTTP {response.status_code}"
                logger.error(error_msg)
                QMessageBox.critical(self, "TTS Error", f"{error_msg}\n\nIs your TTS service running?")
                return
            
            # Save TTS audio to GSM temporary directory with game name
            game_name = gsm_state.current_game if gsm_state.current_game else "tts"
            filename = f"{game_name}_tts_audio.opus"
            tts_audio_path = make_unique_file_name(
                os.path.join(get_temporary_directory(), filename)
            )
            with open(tts_audio_path, 'wb') as f:
                f.write(response.content)
            
            logger.info(f"TTS audio saved to: {tts_audio_path}")
            
            # Update the audio path
            self.audio_path = tts_audio_path
            
            # Update the audio path label
            if self.audio_status_label:
                self.audio_status_label.setText("✔ TTS audio generated")
                self.audio_status_label.setStyleSheet("color: green;")
            
            # Update the audio button command to use the new path
            if self.audio_button:
                self.audio_button.clicked.disconnect()
                self.audio_button.clicked.connect(lambda: self._play_audio(self.audio_path))
            
            # Update status label to show success
            if self.tts_status_label:
                self.tts_status_label.setText("✓ TTS Audio Generated")
                self.tts_status_label.setStyleSheet("color: green;")
            
            if self.tts_button:
                self.tts_button.setText("Regenerate TTS Audio")
            
        except requests.exceptions.Timeout:
            error_msg = "TTS request timed out. Please check if your TTS service is running."
            logger.error(error_msg)
            QMessageBox.critical(self, "TTS Error", error_msg)
        except requests.exceptions.RequestException as e:
            error_msg = f"Failed to connect to TTS service: {str(e)}"
            logger.error(error_msg)
            QMessageBox.critical(self, "TTS Error", f"{error_msg}\n\nPlease check your TTS URL configuration.")
        except Exception as e:
            error_msg = f"Unexpected error generating TTS: {str(e)}"
            logger.error(error_msg)
            QMessageBox.critical(self, "TTS Error", error_msg)
    
    def _cleanup_audio(self):
        """Clean up audio stream resources"""
        self.audio_player.cleanup()
    
    def _on_voice(self):
        # Clean up audio before closing
        self._cleanup_audio()
        # Update config if disable-dialogue is checked
        if self.disable_dialog_checkbox and self.disable_dialog_checkbox.isChecked():
            config = get_config()
            config.anki.show_update_confirmation_dialog_v2 = False
            save_current_config(config)
            reload_config()
            
        # The screenshot_path is now correctly updated if the user chose a new one
        # Include audio_path in the result tuple so TTS audio can be sent to Anki
        translation = self.translation_text.toPlainText().strip() if self.translation_text else None
        self.result = (True, self.sentence_text.toPlainText().strip(), translation, 
                      self.screenshot_path, self.previous_screenshot_path, self.nsfw_tag_checkbox.isChecked(), self.audio_path)
        self.accept()

    def _on_no_voice(self):
        # Clean up audio before closing
        self._cleanup_audio()
        # Update config if disable-dialogue is checked
        if self.disable_dialog_checkbox and self.disable_dialog_checkbox.isChecked():
            config = get_config()
            config.anki.show_update_confirmation_dialog_v2 = False
            save_current_config(config)
            reload_config()
            
        # Include audio_path in the result tuple so TTS audio can be sent to Anki
        translation = self.translation_text.toPlainText().strip() if self.translation_text else None
        self.result = (False, self.sentence_text.toPlainText().strip(), translation,
                      self.screenshot_path, self.previous_screenshot_path, self.nsfw_tag_checkbox.isChecked(), self.audio_path)
        self.accept()
    
    def closeEvent(self, event):
        """Handle window close event"""
        self._cleanup_audio()
        # Don't block closing via accept/reject, only block direct X button close
        # If result is set, it means a button was clicked and we should allow close
        if self.result is not None:
            event.accept()
        else:
            event.ignore()  # Block closing via X button only
        
    def exec(self):
        """Override exec to ensure proper cleanup"""
        super().exec()
        return self.result


def show_anki_confirmation(parent, config_app, expression, sentence, screenshot_path, previous_screenshot_path,
                          audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp):
    """
    Show the Anki confirmation dialog and return the result.
    
    Returns a tuple: (use_voice, sentence, translation, screenshot_path, previous_screenshot_path, nsfw_tag, audio_path)
    or None if cancelled.
    """
    # Create QApplication if it doesn't exist
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    
    dialog = AnkiConfirmationDialog(
        parent, config_app, expression, sentence, screenshot_path, previous_screenshot_path,
        audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp
    )
    dialog.exec()
    
    return dialog.result


if __name__ == "__main__":
    # Test the dialog
    app = QApplication(sys.argv)
    
    # Create a dummy test screenshot
    import tempfile
    from PIL import Image
    
    # Create a test image
    # test_img = Image.new('RGB', (800, 600), color='lightblue')
    # temp_screenshot = os.path.join(tempfile.gettempdir(), "test_screenshot.png")
    # temp_screenshot = Image.open(r'C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\test\GRlkYdonrE.png')
    temp_screenshot = r'C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\test\GRlkYdonrE.png'
    
    # Create a test audio file path (doesn't need to exist for testing UI)
    temp_audio = os.path.join(tempfile.gettempdir(), "test_audio.opus")
    # Create a dummy audio file
    with open(temp_audio, 'wb') as f:
        f.write(b"dummy audio data")
    
    result = show_anki_confirmation(
        parent=None,
        config_app=None,
        expression="テスト",
        sentence="これはテストの文章です。This is a test sentence.",
        screenshot_path=temp_screenshot,
        audio_path=temp_audio,
        translation="This is a test translation.\nIt can have multiple lines.",
        screenshot_timestamp=0
    )
    
    print(f"Dialog result: {result}")
    
    # Cleanup
    if os.path.exists(temp_screenshot):
        os.remove(temp_screenshot)
    if os.path.exists(temp_audio):
        os.remove(temp_audio)
