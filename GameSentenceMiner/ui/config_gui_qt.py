import asyncio
import copy
import json
import os
import subprocess
import sys
import threading
import time

from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QHBoxLayout, QTabWidget,
                             QFormLayout, QLabel, QLineEdit, QCheckBox, QComboBox,
                             QPushButton, QFileDialog, QMessageBox, QInputDialog,
                             QListWidget, QListWidgetItem, QTextEdit, QSizePolicy,
                             QAbstractItemView, QProxyStyle)
from PyQt6.QtCore import Qt, QTimer, pyqtSignal, QObject
from PyQt6.QtGui import QIcon

from GameSentenceMiner import obs
from GameSentenceMiner.util import configuration
from GameSentenceMiner.util.configuration import (Config, Locale, logger, CommonLanguages, ProfileConfig, General,
                                                  Paths, Anki, Features, Screenshot, Audio, OBS, Hotkeys, VAD,
                                                  Overlay, Ai, Advanced, OverlayEngine, get_app_directory,
                                                  get_config, is_beangate, AVAILABLE_LANGUAGES, WHISPER_LARGE,
                                                  WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, WHISPER_MEDIUM,
                                                  WHISPER_TURBO, SILERO, WHISPER, OFF, gsm_state, DEFAULT_CONFIG,
                                                  get_latest_version, get_current_version, AI_GEMINI, AI_GROQ,
                                                  AI_OPENAI, save_full_config, get_default_anki_media_collection_path)
from GameSentenceMiner.util.db import AIModelsTable
from GameSentenceMiner.util.downloader.download_tools import download_ocenaudio_if_needed

RECOMMENDED_GROQ_MODELS = ['meta-llama/llama-4-maverick-17b-128e-instruct',
                           'meta-llama/llama-4-scout-17b-16e-instruct',
                           'llama-3.1-8b-instant',
                           'qwen/qwen3-32b',
                           'openai/gpt-oss-120b']
RECOMMENDED_GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemma-3-27b-it"]
on_save = []

class FastTooltipStyle(QProxyStyle):
    """Custom style to make tooltips appear faster (reduced hover delay)."""
    def styleHint(self, hint, option=None, widget=None, returnData=None):
        if hint == QProxyStyle.StyleHint.SH_ToolTip_WakeUpDelay:
            # Reduce tooltip wake-up delay from default ~700ms to 200ms
            return 50
        elif hint == QProxyStyle.StyleHint.SH_ToolTip_FallAsleepDelay:
            # How long until tooltip hides: keep at default (around 5000ms)
            return 5000
        return super().styleHint(hint, option, widget, returnData)


def load_localization(locale=Locale.English):
    """Loads the localization file."""
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        lang_file = os.path.join(script_dir, '..', 'locales', f'{locale.value}.json')
        with open(lang_file, 'r', encoding='utf-8') as f:
            return json.load(f)['python']['config']
    except (FileNotFoundError, json.JSONDecodeError) as e:
        logger.warning(f"Could not load localization file '{locale.value}.json'. Error: {e}. Falling back to empty dict.")
        return {}


class AIModelFetcher(QObject):
    """Worker object to fetch AI models in a background thread."""
    models_fetched = pyqtSignal(list, list)

    def __init__(self, groq_api_key):
        super().__init__()
        self.groq_api_key = groq_api_key

    def fetch(self):
        """Fetches models and emits a signal when done."""
        groq_models = self._get_groq_models()
        gemini_models = self._get_gemini_models()
        AIModelsTable.update_models(gemini_models, groq_models)
        self.models_fetched.emit(gemini_models, groq_models)

    def _get_groq_models(self):
        models = ["RECOMMENDED"] + RECOMMENDED_GROQ_MODELS + ['OTHER']
        try:
            from groq import Groq
            client = Groq(api_key=self.groq_api_key)
            for m in client.models.list().data:
                if m.active and m.id not in models and not any(x in m.id for x in ["guard", "tts", "whisper"]):
                    models.append(m.id)
        except Exception as e:
            logger.error(f"Error fetching Groq models: {e}")
        return models

    def _get_gemini_models(self):
        models = ["RECOMMENDED"] + RECOMMENDED_GEMINI_MODELS + ["OTHER"]
        try:
            from google import genai
            client = genai.Client()
            for m in client.models.list():
                name = m.name.replace("models/", "")
                if "generateContent" in m.supported_actions:
                    if "2.0" in name and any(x in name for x in ["exp", "preview", "001"]):
                        continue
                    if name not in models:
                        models.append(name)
        except Exception as e:
            logger.error(f"Error fetching Gemini models: {e}")
        return models


class ConfigWindow(QWidget):
    # Signals for thread-safe operations
    _show_window_signal = pyqtSignal()
    _close_window_signal = pyqtSignal()
    _reload_settings_signal = pyqtSignal()
    _quit_app_signal = pyqtSignal()
    
    def __init__(self):
        super().__init__()
        self.test_func = None
        self.on_exit = None

        # --- Load Configuration and Localization ---
        self.master_config: Config = configuration.load_config()
        self.settings: ProfileConfig = self.master_config.get_config()
        self.default_master_settings = Config.new()
        self.default_settings = self.default_master_settings.get_config()
        self.i18n = load_localization(self.master_config.get_locale())
        
        # --- Window Setup ---
        self._update_window_title()
        self.setWindowFlags(self.windowFlags() | Qt.WindowType.Window)  # Ensure it's a standalone window
        self.resize(800, 700)
        
        # Set window icon explicitly
        from GameSentenceMiner.util.configuration import get_pickaxe_png_path
        self.setWindowIcon(QIcon(get_pickaxe_png_path()))
        
        # --- Enable mouse tracking for faster tooltip response ---
        self.setMouseTracking(True)

        # --- Main Layout ---
        self.main_layout = QVBoxLayout(self)
        self.tab_widget = QTabWidget()
        self.main_layout.addWidget(self.tab_widget)

        # --- Create UI Elements (Widgets) ---
        self._create_all_widgets()
        self._create_tabs()

        # --- Bottom Button Bar ---
        self._create_button_bar()

        # --- Load Data into UI ---
        self.load_settings_to_ui()

        # --- Connect Signals ---
        self._connect_signals()
        
        # Connect thread-safe window operation signals
        self._show_window_signal.connect(self._show_window_impl)
        self._close_window_signal.connect(self._close_window_impl)
        self._reload_settings_signal.connect(self._reload_settings_impl)
        self._quit_app_signal.connect(QApplication.instance().quit)

        # --- Periodic OBS Error Check ---
        self.obs_error_timer = QTimer(self)
        self.obs_error_timer.timeout.connect(self.check_obs_errors)
        self.obs_error_timer.start(1000)

    # --- Public Methods (API for other parts of the app) ---
    def show_window(self):
        """
        Shows the configuration window.
        Thread-safe: Can be called from any thread.
        """
        # Emit signal to show window on the GUI thread
        self._show_window_signal.emit()
    
    def _show_window_impl(self):
        """Internal implementation of show_window that runs on the GUI thread."""
        logger.info("Showing Configuration Window")
        obs.update_current_game()
        self.reload_settings()
        self.show()
        self.raise_()
        self.activateWindow()

    def hide_window(self):
        self.hide()
    
    def close_window(self):
        """
        Closes the configuration window and cleans up.
        Thread-safe: Can be called from any thread.
        """
        # Emit signal to close window on the GUI thread
        self._close_window_signal.emit()
    
    def _close_window_impl(self):
        """Internal implementation of close_window that runs on the GUI thread."""
        logger.info("Closing Configuration Window")
        self.close()
        self.deleteLater()

    def reload_settings(self, force_refresh=False):
        """
        Reloads the settings in the UI.
        Thread-safe: Can be called from any thread.
        """
        self._reload_settings_signal.emit()

    def _reload_settings_impl(self, force_refresh=False):
        new_config = configuration.load_config()
        current_config = new_config.get_config()
        
        if force_refresh or current_config.name != self.settings.name or self.settings.config_changed(current_config):
            logger.info("Config changed, reloading UI.")
            self.master_config = new_config
            self.settings = current_config
            self.load_settings_to_ui()
            self._update_window_title()

    def add_save_hook(self, func):
        if func not in on_save:
            on_save.append(func)

    def set_test_func(self, func):
        self.test_func = func

    def show_save_success_indicator(self):
        """Shows a temporary success indicator that fades out after a few seconds."""
        # Get localized text or use default
        success_text = self.i18n.get('buttons', {}).get('save_success', '✓ Settings Saved Successfully!')
        
        self.save_status_label.setText(success_text)
        self.save_status_label.show()
        
        # Hide the label after 3 seconds
        QTimer.singleShot(3000, self.save_status_label.hide)

    # --- Core Logic Methods ---
    def save_settings(self, profile_change=False):
        # Validate and clamp periodic_ratio
        try:
            periodic_ratio = float(self.periodic_ratio_edit.text())
            periodic_ratio = max(0.0, min(1.0, periodic_ratio))
            self.periodic_ratio_edit.setText(str(periodic_ratio))
        except ValueError:
            periodic_ratio = 0.9

        # Validate local scans
        try:
            local_scans = int(float(self.number_of_local_scans_per_event_edit.text()))
            local_scans = max(1, local_scans)
            self.number_of_local_scans_per_event_edit.setText(str(local_scans))
        except ValueError:
            local_scans = 1

        # Collect data from UI widgets to build a new config object
        config = ProfileConfig(
            scenes=self.settings.scenes, # This is handled separately in profile tab logic
            general=General(
                use_websocket=self.websocket_enabled_check.isChecked(),
                use_clipboard=self.clipboard_enabled_check.isChecked(),
                use_both_clipboard_and_websocket=self.use_both_clipboard_and_websocket_check.isChecked(),
                merge_matching_sequential_text=self.merge_matching_sequential_text_check.isChecked(),
                websocket_uri=self.websocket_uri_edit.text(),
                texthook_replacement_regex=self.texthook_replacement_regex_edit.text(),
                open_config_on_startup=self.open_config_on_startup_check.isChecked(),
                open_multimine_on_startup=self.open_multimine_on_startup_check.isChecked(),
                texthooker_port=int(self.texthooker_port_edit.text() or 0),
                native_language=CommonLanguages.from_name(self.native_language_combo.currentText()).value if self.native_language_combo.currentText() else CommonLanguages.ENGLISH.value
            ),
            paths=Paths(
                folder_to_watch=self.folder_to_watch_edit.text(),
                output_folder=self.output_folder_edit.text(),
                copy_temp_files_to_output_folder=self.copy_temp_files_to_output_folder_check.isChecked(),
                open_output_folder_on_card_creation=self.open_output_folder_on_card_creation_check.isChecked(),
                copy_trimmed_replay_to_output_folder=self.copy_trimmed_replay_to_output_folder_check.isChecked(),
                remove_video=self.remove_video_check.isChecked()
            ),
            anki=Anki(
                update_anki=self.update_anki_check.isChecked(),
                show_update_confirmation_dialog_v2=self.show_update_confirmation_dialog_check.isChecked(),
                url=self.anki_url_edit.text(),
                sentence_field=self.sentence_field_edit.text(),
                sentence_audio_field=self.sentence_audio_field_edit.text(),
                picture_field=self.picture_field_edit.text(),
                word_field=self.word_field_edit.text(),
                previous_sentence_field=self.previous_sentence_field_edit.text(),
                previous_image_field=self.previous_image_field_edit.text(),
                game_name_field=self.game_name_field_edit.text(),
                video_field=self.video_field_edit.text(),
                custom_tags=[tag.strip() for tag in self.custom_tags_edit.text().split(',') if tag.strip()],
                tags_to_check=[tag.strip().lower() for tag in self.tags_to_check_edit.text().split(',') if tag.strip()],
                add_game_tag=self.add_game_tag_check.isChecked(),
                polling_rate=int(self.polling_rate_edit.text() or 0),
                overwrite_audio=self.overwrite_audio_check.isChecked(),
                overwrite_picture=self.overwrite_picture_check.isChecked(),
                multi_overwrites_sentence=self.multi_overwrites_sentence_check.isChecked(),
                parent_tag=self.parent_tag_edit.text()
            ),
            features=Features(
                full_auto=self.full_auto_check.isChecked(),
                notify_on_update=self.notify_on_update_check.isChecked(),
                open_anki_edit=self.open_anki_edit_check.isChecked(),
                open_anki_in_browser=self.open_anki_browser_check.isChecked(),
                browser_query=self.browser_query_edit.text(),
                generate_longplay=self.generate_longplay_check.isChecked()
            ),
            screenshot=Screenshot(
                enabled=self.screenshot_enabled_check.isChecked(),
                width=self.screenshot_width_edit.text(),
                height=self.screenshot_height_edit.text(),
                quality=self.screenshot_quality_edit.text(),
                extension=self.screenshot_extension_combo.currentText(),
                custom_ffmpeg_settings=self.screenshot_custom_ffmpeg_settings_edit.text(),
                screenshot_hotkey_updates_anki=self.screenshot_hotkey_update_anki_check.isChecked(),
                seconds_after_line=float(self.seconds_after_line_edit.text() or 0.0),
                screenshot_timing_setting=self.screenshot_timing_combo.currentText(),
                use_screenshot_selector=self.use_screenshot_selector_check.isChecked(),
                animated=self.animated_screenshot_check.isChecked(),
                trim_black_bars_wip=self.trim_black_bars_check.isChecked()
            ),
            audio=Audio(
                enabled=self.audio_enabled_check.isChecked(),
                extension=self.audio_extension_combo.currentText(),
                beginning_offset=float(self.beginning_offset_edit.text() or 0.0),
                end_offset=float(self.end_offset_edit.text() or 0.0),
                ffmpeg_reencode_options=self.audio_ffmpeg_reencode_options_edit.text(),
                external_tool=self.external_tool_edit.text(),
                anki_media_collection=self.anki_media_collection_edit.text(),
                external_tool_enabled=self.external_tool_enabled_check.isChecked(),
                pre_vad_end_offset=float(self.pre_vad_audio_offset_edit.text() or 0.0)
            ),
            obs=OBS(
                host=self.obs_host_edit.text(),
                port=int(self.obs_port_edit.text() or 0),
                password=self.obs_password_edit.text(),
                open_obs=self.obs_open_obs_check.isChecked(),
                close_obs=self.obs_close_obs_check.isChecked(),
                obs_path=self.obs_path_edit.text(),
                minimum_replay_size=int(self.obs_minimum_replay_size_edit.text() or 0),
                automatically_manage_replay_buffer=self.automatically_manage_replay_buffer_check.isChecked()
            ),
            hotkeys=Hotkeys(
                reset_line=self.reset_line_hotkey_edit.text(),
                take_screenshot=self.take_screenshot_hotkey_edit.text(),
                play_latest_audio=self.play_latest_audio_hotkey_edit.text()
            ),
            vad=VAD(
                whisper_model=self.whisper_model_combo.currentText(),
                do_vad_postprocessing=self.do_vad_postprocessing_check.isChecked(),
                selected_vad_model=self.selected_vad_model_combo.currentText(),
                backup_vad_model=self.backup_vad_model_combo.currentText(),
                trim_beginning=self.vad_trim_beginning_check.isChecked(),
                beginning_offset=float(self.vad_beginning_offset_edit.text() or 0.0),
                add_audio_on_no_results=self.add_audio_on_no_results_check.isChecked(),
                use_tts_as_fallback=self.use_tts_as_fallback_check.isChecked(),
                tts_url=self.tts_url_edit.text(),
                language=self.language_combo.currentText(),
                cut_and_splice_segments=self.cut_and_splice_segments_check.isChecked(),
                splice_padding=float(self.splice_padding_edit.text() or 0.0),
                use_cpu_for_inference=self.use_cpu_for_inference_check.isChecked(),
                use_vad_filter_for_whisper=self.use_vad_filter_for_whisper_check.isChecked()
            ),
            advanced=Advanced(
                audio_player_path=self.audio_player_path_edit.text(),
                video_player_path=self.video_player_path_edit.text(),
                multi_line_line_break=self.multi_line_line_break_edit.text(),
                multi_line_sentence_storage_field=self.multi_line_sentence_storage_field_edit.text(),
                ocr_websocket_port=int(self.ocr_websocket_port_edit.text() or 0),
                texthooker_communication_websocket_port=int(self.texthooker_communication_websocket_port_edit.text() or 0),
                plaintext_websocket_port=int(self.plaintext_websocket_export_port_edit.text() or 0),
                localhost_bind_address=self.localhost_bind_address_edit.text()
            ),
            ai=Ai(
                add_to_anki=self.ai_enabled_check.isChecked(),
                provider=self.ai_provider_combo.currentText(),
                gemini_model=self.gemini_model_combo.currentText(),
                groq_model=self.groq_model_combo.currentText(),
                gemini_api_key=self.gemini_api_key_edit.text(),
                api_key=self.gemini_api_key_edit.text(),
                groq_api_key=self.groq_api_key_edit.text(),
                anki_field=self.ai_anki_field_edit.text(),
                open_ai_api_key=self.open_ai_api_key_edit.text(),
                open_ai_model=self.open_ai_model_edit.text(),
                open_ai_url=self.open_ai_url_edit.text(),
                use_canned_translation_prompt=self.use_canned_translation_prompt_check.isChecked(),
                use_canned_context_prompt=self.use_canned_context_prompt_check.isChecked(),
                custom_prompt=self.custom_prompt_textedit.toPlainText(),
                dialogue_context_length=int(self.ai_dialogue_context_length_edit.text() or 0),
                custom_texthooker_prompt=self.custom_texthooker_prompt_textedit.toPlainText()
            ),
            overlay=Overlay(
                websocket_port=int(self.overlay_websocket_port_edit.text() or 0),
                monitor_to_capture=self.overlay_monitor_combo.currentIndex(),
                engine=OverlayEngine(self.overlay_engine_combo.currentText()).value,
                scan_delay=float(self.scan_delay_edit.text() or 0.0),
                periodic=self.periodic_check.isChecked(),
                periodic_ratio=periodic_ratio,
                periodic_interval=float(self.periodic_interval_edit.text() or 0.0),
                number_of_local_scans_per_event=local_scans,
                minimum_character_size=int(self.overlay_minimum_character_size_edit.text() or 0)
            )
        )

        # Handle custom audio encode settings
        custom_display_name = self.i18n.get('tabs', {}).get('audio', {}).get('ffmpeg_preset', {}).get('options', {}).get('custom', 'Custom')
        if self.ffmpeg_audio_preset_combo.currentText() == custom_display_name:
            config.audio.custom_encode_settings = self.audio_ffmpeg_reencode_options_edit.text()

        # Perform the save operation
        prev_config = self.master_config.get_config()
        self.master_config.switch_to_default_if_not_found = self.switch_to_default_if_not_found_check.isChecked()
        current_profile_name = self.profile_combo.currentText()

        if profile_change:
            self.master_config.current_profile = current_profile_name
        else:
            self.master_config.current_profile = current_profile_name
            self.master_config.set_config_for_profile(current_profile_name, config)

        self.master_config.locale = Locale[self.locale_combo.currentText()].value
        self.master_config.overlay = config.overlay

        # Backup and save
        config_backup_folder = os.path.join(get_app_directory(), "backup", "config")
        os.makedirs(config_backup_folder, exist_ok=True)
        timestamp = time.strftime("%Y-%m-%d_%H-%M-%S")
        with open(os.path.join(config_backup_folder, f"config_backup_{timestamp}.json"), 'w') as backup_file:
            backup_file.write(self.master_config.to_json(indent=4))

        self.master_config = self.master_config.sync_shared_fields()

        if hasattr(self, 'sync_changes_check') and self.sync_changes_check.isChecked():
            self.master_config.sync_changed_fields(prev_config)
            self.sync_changes_check.setChecked(False)

        self.master_config.save()
        logger.info("Settings saved successfully!")
        
        # Show save success indicator
        self.show_save_success_indicator()

        if self.master_config.get_config().restart_required(prev_config):
            logger.info("Restart Required for some settings to take affect!")
        
        configuration.reload_config()
        self.settings = get_config()
        for func in on_save:
            func()

    # --- UI Event Handlers (Slots) ---
    def _on_profile_changed(self):
        self.save_settings(profile_change=True)
        self.load_settings_to_ui()
        self.reload_settings(force_refresh=True)
        self.refresh_obs_scenes()
        is_default = self.profile_combo.currentText() == DEFAULT_CONFIG
        self.delete_profile_button.setHidden(is_default)

    def _on_locale_changed(self):
        if self.locale_combo.currentText() == self.master_config.get_locale().name:
            return
        
        self.save_settings()
        self.i18n = load_localization(Locale[self.locale_combo.currentText()])
        
        # This is a bit drastic, but easiest way to re-translate everything
        self.tab_widget.clear()
        self._create_tabs()
        self._create_button_bar() # Re-create to update text
        self.load_settings_to_ui() # Reload data
        self._connect_signals() # Reconnect signals
        self._update_window_title()

        logger.info(f"Locale changed to {self.locale_combo.currentText()}.")
    
    def _on_obs_scene_selection_changed(self):
        selected_items = self.obs_scene_list.selectedItems()
        self.settings.scenes = [item.text() for item in selected_items]

    # --- UI Creation Helpers ---
    def _create_all_widgets(self):
        """Initializes all QWidget instances used in the UI."""
        # General
        self.websocket_enabled_check = QCheckBox()
        self.clipboard_enabled_check = QCheckBox()
        self.use_both_clipboard_and_websocket_check = QCheckBox()
        self.merge_matching_sequential_text_check = QCheckBox()
        self.websocket_uri_edit = QLineEdit()
        self.texthook_replacement_regex_edit = QLineEdit()
        self.open_config_on_startup_check = QCheckBox()
        self.open_multimine_on_startup_check = QCheckBox()
        self.texthooker_port_edit = QLineEdit()
        self.native_language_combo = QComboBox()
        self.locale_combo = QComboBox()
        self.notify_on_update_check = QCheckBox()
        
        # Paths
        self.folder_to_watch_edit = QLineEdit()
        self.output_folder_edit = QLineEdit()
        self.copy_temp_files_to_output_folder_check = QCheckBox()
        self.open_output_folder_on_card_creation_check = QCheckBox()
        self.copy_trimmed_replay_to_output_folder_check = QCheckBox()
        self.remove_video_check = QCheckBox()
        
        # Anki
        self.update_anki_check = QCheckBox()
        self.show_update_confirmation_dialog_check = QCheckBox()
        self.anki_url_edit = QLineEdit()
        self.sentence_field_edit = QLineEdit()
        self.sentence_audio_field_edit = QLineEdit()
        self.picture_field_edit = QLineEdit()
        self.word_field_edit = QLineEdit()
        self.previous_sentence_field_edit = QLineEdit()
        self.previous_image_field_edit = QLineEdit()
        self.game_name_field_edit = QLineEdit()
        self.video_field_edit = QLineEdit()
        self.custom_tags_edit = QLineEdit()
        self.tags_to_check_edit = QLineEdit()
        self.add_game_tag_check = QCheckBox()
        self.parent_tag_edit = QLineEdit()
        self.overwrite_audio_check = QCheckBox()
        self.overwrite_picture_check = QCheckBox()
        self.multi_overwrites_sentence_check = QCheckBox()
        
        # Features
        self.full_auto_check = QCheckBox() # Note: This setting seems unused in the original save logic.
        self.open_anki_edit_check = QCheckBox()
        self.open_anki_browser_check = QCheckBox()
        self.browser_query_edit = QLineEdit()
        self.generate_longplay_check = QCheckBox()
        
        # Screenshot
        self.screenshot_enabled_check = QCheckBox()
        self.screenshot_width_edit = QLineEdit()
        self.screenshot_height_edit = QLineEdit()
        self.screenshot_quality_edit = QLineEdit()
        self.screenshot_extension_combo = QComboBox()
        self.animated_screenshot_check = QCheckBox()
        self.screenshot_custom_ffmpeg_settings_edit = QLineEdit()
        self.screenshot_timing_combo = QComboBox()
        self.seconds_after_line_edit = QLineEdit()
        self.use_screenshot_selector_check = QCheckBox()
        self.take_screenshot_hotkey_edit = QLineEdit()
        self.screenshot_hotkey_update_anki_check = QCheckBox()
        self.trim_black_bars_check = QCheckBox()
        
        # Audio
        self.audio_enabled_check = QCheckBox()
        self.audio_extension_combo = QComboBox()
        self.beginning_offset_edit = QLineEdit()
        self.pre_vad_audio_offset_edit = QLineEdit()
        self.ffmpeg_audio_preset_combo = QComboBox()
        self.audio_ffmpeg_reencode_options_edit = QLineEdit()
        self.anki_media_collection_edit = QLineEdit()
        self.external_tool_edit = QLineEdit()
        self.external_tool_enabled_check = QCheckBox()
        
        # VAD
        self.do_vad_postprocessing_check = QCheckBox()
        self.language_combo = QComboBox()
        self.whisper_model_combo = QComboBox()
        self.selected_vad_model_combo = QComboBox()
        self.backup_vad_model_combo = QComboBox()
        self.add_audio_on_no_results_check = QCheckBox()
        self.use_tts_as_fallback_check = QCheckBox()
        self.tts_url_edit = QLineEdit()
        self.end_offset_edit = QLineEdit()
        self.vad_trim_beginning_check = QCheckBox()
        self.vad_beginning_offset_edit = QLineEdit()
        self.cut_and_splice_segments_check = QCheckBox()
        self.splice_padding_edit = QLineEdit()
        self.use_cpu_for_inference_check = QCheckBox()
        self.use_vad_filter_for_whisper_check = QCheckBox()
        
        # OBS
        self.obs_open_obs_check = QCheckBox()
        self.obs_close_obs_check = QCheckBox()
        self.obs_path_edit = QLineEdit()
        self.obs_host_edit = QLineEdit()
        self.obs_port_edit = QLineEdit()
        self.obs_password_edit = QLineEdit()
        self.automatically_manage_replay_buffer_check = QCheckBox()
        self.obs_minimum_replay_size_edit = QLineEdit()
        
        # AI
        self.ai_enabled_check = QCheckBox()
        self.ai_provider_combo = QComboBox()
        self.gemini_model_combo = QComboBox()
        self.gemini_api_key_edit = QLineEdit()
        self.groq_model_combo = QComboBox()
        self.groq_api_key_edit = QLineEdit()
        self.open_ai_url_edit = QLineEdit()
        self.open_ai_model_edit = QLineEdit()
        self.open_ai_api_key_edit = QLineEdit()
        self.ai_anki_field_edit = QLineEdit()
        self.ai_dialogue_context_length_edit = QLineEdit()
        self.use_canned_translation_prompt_check = QCheckBox()
        self.use_canned_context_prompt_check = QCheckBox()
        self.custom_prompt_textedit = QTextEdit()
        self.custom_texthooker_prompt_textedit = QTextEdit()
        
        # Overlay
        self.overlay_websocket_port_edit = QLineEdit()
        self.overlay_monitor_combo = QComboBox()
        self.overlay_engine_combo = QComboBox()
        self.scan_delay_edit = QLineEdit()
        self.periodic_check = QCheckBox()
        self.periodic_interval_edit = QLineEdit()
        self.periodic_ratio_edit = QLineEdit()
        self.number_of_local_scans_per_event_edit = QLineEdit()
        self.overlay_minimum_character_size_edit = QLineEdit()
        
        # Advanced
        self.audio_player_path_edit = QLineEdit()
        self.video_player_path_edit = QLineEdit()
        self.play_latest_audio_hotkey_edit = QLineEdit()
        self.multi_line_line_break_edit = QLineEdit()
        self.multi_line_sentence_storage_field_edit = QLineEdit()
        self.ocr_websocket_port_edit = QLineEdit()
        self.texthooker_communication_websocket_port_edit = QLineEdit()
        self.plaintext_websocket_export_port_edit = QLineEdit()
        self.reset_line_hotkey_edit = QLineEdit()
        self.polling_rate_edit = QLineEdit()
        self.localhost_bind_address_edit = QLineEdit()
        self.current_version_label = QLabel()
        self.latest_version_label = QLabel()

        # Profiles
        self.profile_combo = QComboBox()
        self.obs_scene_list = QListWidget()
        self.switch_to_default_if_not_found_check = QCheckBox()

        # Required Settings Tab - Duplicate widgets that mirror the main ones
        self.req_websocket_enabled_check = QCheckBox()
        self.req_clipboard_enabled_check = QCheckBox()
        self.req_websocket_uri_edit = QLineEdit()
        self.req_folder_to_watch_edit = QLineEdit()
        self.req_sentence_field_edit = QLineEdit()
        self.req_sentence_audio_field_edit = QLineEdit()
        self.req_picture_field_edit = QLineEdit()
        self.req_word_field_edit = QLineEdit()
        self.req_beginning_offset_edit = QLineEdit()
        self.req_end_offset_edit = QLineEdit()
        self.req_cut_and_splice_segments_check = QCheckBox()
        self.req_splice_padding_edit = QLineEdit()
        self.req_external_tool_edit = QLineEdit()
        self.req_open_anki_edit_check = QCheckBox()
        self.req_open_anki_browser_check = QCheckBox()

    def _create_tabs(self):
        tabs_i18n = self.i18n.get('tabs', {})
        self.tab_widget.addTab(self._create_required_settings_tab(), tabs_i18n.get('key_settings', {}).get('title', 'Key Settings'))
        self.tab_widget.addTab(self._create_general_tab(), tabs_i18n.get('general', {}).get('title', 'General'))
        self.tab_widget.addTab(self._create_paths_tab(), tabs_i18n.get('paths', {}).get('title', 'Paths'))
        self.tab_widget.addTab(self._create_anki_tab(), tabs_i18n.get('anki', {}).get('title', 'Anki'))
        self.tab_widget.addTab(self._create_vad_tab(), tabs_i18n.get('vad', {}).get('title', 'VAD'))
        self.tab_widget.addTab(self._create_features_tab(), tabs_i18n.get('features', {}).get('title', 'Features'))
        self.tab_widget.addTab(self._create_screenshot_tab(), tabs_i18n.get('screenshot', {}).get('title', 'Screenshot'))
        self.tab_widget.addTab(self._create_audio_tab(), tabs_i18n.get('audio', {}).get('title', 'Audio'))
        self.tab_widget.addTab(self._create_obs_tab(), tabs_i18n.get('obs', {}).get('title', 'OBS'))
        self.tab_widget.addTab(self._create_ai_tab(), tabs_i18n.get('ai', {}).get('title', 'AI'))
        self.tab_widget.addTab(self._create_overlay_tab(), tabs_i18n.get('overlay', {}).get('title', 'Overlay'))
        self.tab_widget.addTab(self._create_advanced_tab(), tabs_i18n.get('advanced', {}).get('title', 'Advanced'))
        self.tab_widget.addTab(self._create_profiles_tab(), tabs_i18n.get('profiles', {}).get('title', 'Profiles'))

    def _create_button_bar(self):
        # Clear existing button bar if it exists
        if hasattr(self, 'button_bar_widget') and self.button_bar_widget:
            self.main_layout.removeWidget(self.button_bar_widget)
            self.button_bar_widget.deleteLater()

        self.button_bar_widget = QWidget()
        button_layout = QHBoxLayout(self.button_bar_widget)
        button_layout.addStretch(1)

        buttons_i18n = self.i18n.get('buttons', {})
        self.save_button = QPushButton(buttons_i18n.get('save', 'Save Settings'))
        self.save_button.setStyleSheet("background-color: #28a745; color: white;")
        button_layout.addWidget(self.save_button)

        if len(self.master_config.configs) > 1:
            sync_btn_i18n = buttons_i18n.get('sync_changes', {})
            self.sync_changes_check = QCheckBox(sync_btn_i18n.get('label', 'Sync Changes to Profiles'))
            self.sync_changes_check.setToolTip(sync_btn_i18n.get('tooltip', 'Syncs CHANGED SETTINGS to all profiles.'))
            button_layout.addWidget(self.sync_changes_check)

        button_layout.addStretch(1)
        self.main_layout.addWidget(self.button_bar_widget)
        
        self.save_status_label = QLabel("")
        self.save_status_label.setStyleSheet(
            "color: #28a745; font-weight: bold; padding: 5px;"
        )
        self.save_status_label.hide()
        self.save_status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        
        # Add save status label in its own row above buttons
        self.main_layout.addWidget(self.save_status_label)

    def _connect_signals(self):
        # Disconnect first to avoid multiple connections on reload
        try:
            self.save_button.clicked.disconnect()
            self.profile_combo.currentIndexChanged.disconnect()
            self.locale_combo.currentIndexChanged.disconnect()
            self.obs_scene_list.itemSelectionChanged.disconnect()
        except TypeError:
            pass # Signals were not connected yet

        # Connect signals
        self.save_button.clicked.connect(lambda: self.save_settings())
        self.profile_combo.currentIndexChanged.connect(self._on_profile_changed)
        self.locale_combo.currentIndexChanged.connect(self._on_locale_changed)
        self.obs_scene_list.itemSelectionChanged.connect(self._on_obs_scene_selection_changed)
        
        # Sync required settings tab widgets with main widgets
        self._sync_widget_bidirectional(self.websocket_enabled_check, self.req_websocket_enabled_check)
        self._sync_widget_bidirectional(self.clipboard_enabled_check, self.req_clipboard_enabled_check)
        self._sync_widget_bidirectional(self.websocket_uri_edit, self.req_websocket_uri_edit)
        self._sync_widget_bidirectional(self.folder_to_watch_edit, self.req_folder_to_watch_edit)
        self._sync_widget_bidirectional(self.sentence_field_edit, self.req_sentence_field_edit)
        self._sync_widget_bidirectional(self.sentence_audio_field_edit, self.req_sentence_audio_field_edit)
        self._sync_widget_bidirectional(self.picture_field_edit, self.req_picture_field_edit)
        self._sync_widget_bidirectional(self.word_field_edit, self.req_word_field_edit)
        self._sync_widget_bidirectional(self.beginning_offset_edit, self.req_beginning_offset_edit)
        self._sync_widget_bidirectional(self.end_offset_edit, self.req_end_offset_edit)
        self._sync_widget_bidirectional(self.cut_and_splice_segments_check, self.req_cut_and_splice_segments_check)
        self._sync_widget_bidirectional(self.splice_padding_edit, self.req_splice_padding_edit)
        self._sync_widget_bidirectional(self.external_tool_edit, self.req_external_tool_edit)
        self._sync_widget_bidirectional(self.open_anki_edit_check, self.req_open_anki_edit_check)
        self._sync_widget_bidirectional(self.open_anki_browser_check, self.req_open_anki_browser_check)
    
    def _sync_widget_bidirectional(self, main_widget, req_widget):
        """Syncs two widgets bidirectionally so changes in one update the other."""
        if isinstance(main_widget, QLineEdit):
            main_widget.textChanged.connect(lambda text: req_widget.setText(text) if req_widget.text() != text else None)
            req_widget.textChanged.connect(lambda text: main_widget.setText(text) if main_widget.text() != text else None)
        elif isinstance(main_widget, QCheckBox):
            main_widget.stateChanged.connect(lambda state: req_widget.setChecked(main_widget.isChecked()) if req_widget.isChecked() != main_widget.isChecked() else None)
            req_widget.stateChanged.connect(lambda state: main_widget.setChecked(req_widget.isChecked()) if main_widget.isChecked() != req_widget.isChecked() else None)

    # --- Individual Tab Creation Methods ---
    def _create_required_settings_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        # Input Sources
        input_widget = QWidget()
        input_layout = QHBoxLayout(input_widget)
        input_layout.setContentsMargins(0,0,0,0)
        input_layout.addWidget(self.req_websocket_enabled_check)
        input_layout.addWidget(QLabel(i18n.get('general', {}).get('websocket_enabled', {}).get('label', '...')))
        input_layout.addWidget(self.req_clipboard_enabled_check)
        input_layout.addWidget(QLabel(i18n.get('general', {}).get('clipboard_enabled', {}).get('label', '...')))
        input_layout.addStretch()
        layout.addRow(input_widget)

        # Other key settings
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'websocket_uri'), self.req_websocket_uri_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'locale'), self.locale_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'paths', 'folder_to_watch'), self._create_browse_widget(self.req_folder_to_watch_edit, QFileDialog.FileMode.Directory))
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'sentence_field'), self.req_sentence_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'sentence_audio_field'), self.req_sentence_audio_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'picture_field'), self.req_picture_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'word_field'), self.req_word_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'beginning_offset'), self.req_beginning_offset_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'audio_end_offset'), self.req_end_offset_edit)
        
        # Splicing
        splice_widget = QWidget()
        splice_layout = QHBoxLayout(splice_widget)
        splice_layout.setContentsMargins(0,0,0,0)
        splice_layout.addWidget(self.req_cut_and_splice_segments_check)
        splice_layout.addWidget(self._create_labeled_widget(i18n, 'vad', 'splice_padding'))
        splice_layout.addWidget(self.req_splice_padding_edit)
        splice_layout.addStretch()
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'cut_and_splice'), splice_widget)
        
        # OcenAudio
        ocen_widget = QWidget()
        ocen_layout = QHBoxLayout(ocen_widget)
        ocen_layout.setContentsMargins(0,0,0,0)
        ocen_layout.addWidget(self.req_external_tool_edit)
        install_ocen_button = QPushButton(i18n.get('audio', {}).get('install_ocenaudio_button', 'Install Ocenaudio'))
        install_ocen_button.clicked.connect(self.download_and_install_ocen)
        ocen_layout.addWidget(install_ocen_button)
        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'external_tool'), ocen_widget)
        
        # Anki Features
        anki_features_widget = QWidget()
        anki_features_layout = QHBoxLayout(anki_features_widget)
        anki_features_layout.setContentsMargins(0,0,0,0)
        anki_features_layout.addWidget(self.req_open_anki_edit_check)
        anki_features_layout.addWidget(self._create_labeled_widget(i18n, 'features', 'open_anki_edit'))
        anki_features_layout.addWidget(self.req_open_anki_browser_check)
        anki_features_layout.addWidget(self._create_labeled_widget(i18n, 'features', 'open_anki_browser'))
        anki_features_layout.addStretch()
        layout.addRow(anki_features_widget)

        # Legend
        legend_i18n = i18n.get('general', {}).get('legend', {})
        legend_label = QLabel(
            f"<p>{legend_i18n.get('tooltip_info', '...')}</p>"
            f"<p><font color='#FFA500'>{legend_i18n.get('important', '...')}</font></p>"
            f"<p><font color='#FF0000'>{legend_i18n.get('advanced', '...')}</font></p>"
            f"<p><font color='#00FF00'>{legend_i18n.get('recommended', '...')}</font></p>"
        )
        legend_label.setWordWrap(True)
        layout.addRow(legend_label)

        return widget

    def _create_general_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})
        
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'websocket_enabled'), self.websocket_enabled_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'clipboard_enabled'), self.clipboard_enabled_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'allow_both_simultaneously'), self.use_both_clipboard_and_websocket_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'merge_sequential_text'), self.merge_matching_sequential_text_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'websocket_uri'), self.websocket_uri_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'texthook_regex'), self.texthook_replacement_regex_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'open_config_on_startup'), self.open_config_on_startup_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'open_texthooker_on_startup'), self.open_multimine_on_startup_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'texthooker_port'), self.texthooker_port_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'plaintext_export_port'), self.plaintext_websocket_export_port_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'native_language'), self.native_language_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'features', 'notify_on_update'), self.notify_on_update_check)

        if is_beangate:
            test_button = QPushButton(self.i18n.get('buttons', {}).get('run_function', 'Run Function'))
            test_button.clicked.connect(lambda: self.test_func() if self.test_func else None)
            layout.addRow(test_button)
            
        layout.addRow(self._create_reset_button("general", self._create_general_tab))
        return widget

    def _create_paths_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'paths', 'folder_to_watch'), self._create_browse_widget(self.folder_to_watch_edit, QFileDialog.FileMode.Directory))
        
        output_folder_widget = QWidget()
        output_folder_layout = QHBoxLayout(output_folder_widget)
        output_folder_layout.setContentsMargins(0,0,0,0)
        output_folder_layout.addWidget(self.output_folder_edit)
        output_folder_layout.addWidget(self._create_browse_button(self.output_folder_edit, QFileDialog.FileMode.Directory))
        output_folder_layout.addWidget(self.copy_temp_files_to_output_folder_check)
        output_folder_layout.addWidget(self._create_labeled_widget(i18n, 'paths', 'copy_temp_files_to_output_folder'))
        output_folder_layout.addStretch()
        layout.addRow(self._create_labeled_widget(i18n, 'paths', 'output_folder'), output_folder_widget)

        layout.addRow(self._create_labeled_widget(i18n, 'paths', 'copy_trimmed_replay_to_output_folder'), self.copy_trimmed_replay_to_output_folder_check)
        layout.addRow(self._create_labeled_widget(i18n, 'paths', 'open_output_folder_on_card_creation'), self.open_output_folder_on_card_creation_check)
        layout.addRow(self._create_labeled_widget(i18n, 'paths', 'remove_video'), self.remove_video_check)
        
        layout.addRow(self._create_reset_button("paths", self._create_paths_tab))
        return widget

    def _create_anki_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'update_anki'), self.update_anki_check)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'show_update_confirmation_dialog'), self.show_update_confirmation_dialog_check)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'url'), self.anki_url_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'sentence_field'), self.sentence_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'sentence_audio_field'), self.sentence_audio_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'picture_field'), self.picture_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'word_field'), self.word_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'previous_sentence_field'), self.previous_sentence_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'previous_image_field'), self.previous_image_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'video_field'), self.video_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'game_name_field'), self.game_name_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'custom_tags'), self.custom_tags_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'tags_to_check'), self.tags_to_check_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'add_game_tag'), self.add_game_tag_check)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'parent_tag'), self.parent_tag_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'overwrite_audio'), self.overwrite_audio_check)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'overwrite_picture'), self.overwrite_picture_check)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'multi_overwrites_sentence'), self.multi_overwrites_sentence_check)
        
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'multiline_linebreak'), self.multi_line_line_break_edit)

        layout.addRow(self._create_reset_button("anki", self._create_anki_tab))
        return widget

    def _create_vad_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'do_postprocessing'), self.do_vad_postprocessing_check)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'language'), self.language_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'whisper_model'), self.whisper_model_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'selected_model'), self.selected_vad_model_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'backup_model'), self.backup_vad_model_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'add_on_no_results'), self.add_audio_on_no_results_check)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'use_tts_as_fallback'), self.use_tts_as_fallback_check)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'tts_url'), self.tts_url_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'audio_end_offset'), self.end_offset_edit)
        
        trim_begin_widget = QWidget()
        trim_begin_layout = QHBoxLayout(trim_begin_widget)
        trim_begin_layout.setContentsMargins(0,0,0,0)
        trim_begin_layout.addWidget(self.vad_trim_beginning_check)
        trim_begin_layout.addWidget(self._create_labeled_widget(i18n, 'vad', 'beginning_offset'))
        trim_begin_layout.addWidget(self.vad_beginning_offset_edit)
        trim_begin_layout.addStretch()
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'trim_beginning'), trim_begin_widget)

        splice_widget = QWidget()
        splice_layout = QHBoxLayout(splice_widget)
        splice_layout.setContentsMargins(0,0,0,0)
        splice_layout.addWidget(self.cut_and_splice_segments_check)
        splice_layout.addWidget(self._create_labeled_widget(i18n, 'vad', 'splice_padding'))
        splice_layout.addWidget(self.splice_padding_edit)
        splice_layout.addStretch()
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'cut_and_splice'), splice_widget)
        
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'use_cpu_for_inference'), self.use_cpu_for_inference_check)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'use_vad_filter_for_whisper'), self.use_vad_filter_for_whisper_check)
        
        layout.addRow(self._create_reset_button("vad", self._create_vad_tab))
        return widget

    def _create_features_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'features', 'open_anki_edit'), self.open_anki_edit_check)
        layout.addRow(self._create_labeled_widget(i18n, 'features', 'open_anki_browser'), self.open_anki_browser_check)
        layout.addRow(self._create_labeled_widget(i18n, 'features', 'browser_query'), self.browser_query_edit)
        layout.addRow(QLabel("Generate LongPlay"), self.generate_longplay_check) # Simple label as i18n is missing
        self.generate_longplay_check.setToolTip("Generate a LongPlay video using OBS recording, and write to a .srt file with all the text coming into gsm. RESTART REQUIRED.")

        layout.addRow(self._create_reset_button("features", self._create_features_tab))
        return widget

    def _create_screenshot_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'enabled'), self.screenshot_enabled_check)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'width'), self.screenshot_width_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'height'), self.screenshot_height_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'quality'), self.screenshot_quality_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'extension'), self.screenshot_extension_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'animated'), self.animated_screenshot_check)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'ffmpeg_options'), self.screenshot_custom_ffmpeg_settings_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'timing'), self.screenshot_timing_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'offset'), self.seconds_after_line_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'use_selector'), self.use_screenshot_selector_check)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'hotkey'), self.take_screenshot_hotkey_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'hotkey_updates_anki'), self.screenshot_hotkey_update_anki_check)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'trim_black_bars'), self.trim_black_bars_check)

        layout.addRow(self._create_reset_button("screenshot", self._create_screenshot_tab))
        return widget

    def _create_audio_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'enabled'), self.audio_enabled_check)
        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'extension'), self.audio_extension_combo)
        
        offset_widget = QWidget()
        offset_layout = QHBoxLayout(offset_widget)
        offset_layout.setContentsMargins(0,0,0,0)
        offset_layout.addWidget(self.beginning_offset_edit)
        find_offset_button = QPushButton(i18n.get('audio', {}).get('find_offset_button', 'Find Offset (WIP)'))
        find_offset_button.clicked.connect(self.call_audio_offset_selector)
        offset_layout.addWidget(find_offset_button)
        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'beginning_offset'), offset_widget)

        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'end_offset'), self.pre_vad_audio_offset_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'ffmpeg_preset'), self.ffmpeg_audio_preset_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'ffmpeg_options'), self.audio_ffmpeg_reencode_options_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'anki_media_collection'), self.anki_media_collection_edit)
        
        ext_tool_widget = QWidget()
        ext_tool_layout = QHBoxLayout(ext_tool_widget)
        ext_tool_layout.setContentsMargins(0,0,0,0)
        ext_tool_layout.addWidget(self.external_tool_edit)
        ext_tool_layout.addWidget(self.external_tool_enabled_check)
        ext_tool_layout.addWidget(self._create_labeled_widget(i18n, 'audio', 'external_tool_enabled'))
        ext_tool_layout.addStretch()
        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'external_tool'), ext_tool_widget)

        button_widget = QWidget()
        button_layout = QHBoxLayout(button_widget)
        button_layout.setContentsMargins(0,0,0,0)
        install_ocen_button = QPushButton(i18n.get('audio', {}).get('install_ocenaudio_button', 'Install Ocenaudio'))
        install_ocen_button.clicked.connect(self.download_and_install_ocen)
        button_layout.addWidget(install_ocen_button)
        button_layout.addStretch()
        layout.addRow(button_widget)

        layout.addRow(self._create_reset_button("audio", self._create_audio_tab))
        return widget

    def _create_obs_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'obs', 'open_obs'), self.obs_open_obs_check)
        layout.addRow(self._create_labeled_widget(i18n, 'obs', 'close_obs'), self.obs_close_obs_check)
        layout.addRow(self._create_labeled_widget(i18n, 'obs', 'obs_path'), self._create_browse_widget(self.obs_path_edit, QFileDialog.FileMode.ExistingFile))
        layout.addRow(self._create_labeled_widget(i18n, 'obs', 'host'), self.obs_host_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'obs', 'port'), self.obs_port_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'obs', 'password'), self.obs_password_edit)
        self.obs_password_edit.setEchoMode(QLineEdit.EchoMode.Password)
        layout.addRow(self._create_labeled_widget(i18n, 'obs', 'min_replay_size'), self.obs_minimum_replay_size_edit)
        # The 'automatically_manage_replay_buffer' setting seems to be missing from the original Tkinter UI, adding it here for completeness.
        layout.addRow(QLabel("Auto-Manage Replay Buffer"), self.automatically_manage_replay_buffer_check)
        
        layout.addRow(self._create_reset_button("obs", self._create_obs_tab))
        return widget

    def _create_ai_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'enabled'), self.ai_enabled_check)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'provider'), self.ai_provider_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'gemini_model'), self.gemini_model_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'gemini_api_key'), self.gemini_api_key_edit)
        self.gemini_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'groq_model'), self.groq_model_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'groq_api_key'), self.groq_api_key_edit)
        self.groq_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'openai_url'), self.open_ai_url_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'openai_model'), self.open_ai_model_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'openai_apikey'), self.open_ai_api_key_edit)
        self.open_ai_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'anki_field'), self.ai_anki_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'context_length'), self.ai_dialogue_context_length_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'use_canned_translation'), self.use_canned_translation_prompt_check)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'use_canned_context'), self.use_canned_context_prompt_check)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'custom_prompt'), self.custom_prompt_textedit)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'custom_texthooker_prompt'), self.custom_texthooker_prompt_textedit)

        layout.addRow(self._create_reset_button("ai", self._create_ai_tab))
        return widget
        
    def _create_overlay_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'websocket_port'), self.overlay_websocket_port_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'overlay_monitor'), self.overlay_monitor_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'overlay_engine'), self.overlay_engine_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'scan_delay'), self.scan_delay_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'periodic'), self.periodic_check)
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'periodic_interval'), self.periodic_interval_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'periodic_ratio'), self.periodic_ratio_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'number_of_local_scans_per_event'), self.number_of_local_scans_per_event_edit)

        min_char_widget = QWidget()
        min_char_layout = QHBoxLayout(min_char_widget)
        min_char_layout.setContentsMargins(0,0,0,0)
        min_char_layout.addWidget(self.overlay_minimum_character_size_edit)
        find_size_button = QPushButton(i18n.get('overlay', {}).get('minimum_character_size_finder_button', 'Find Size'))
        find_size_button.clicked.connect(self.open_minimum_character_size_selector)
        min_char_layout.addWidget(find_size_button)
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'minimum_character_size'), min_char_widget)
        
        layout.addRow(self._create_reset_button("overlay", self._create_overlay_tab))
        return widget

    def _create_advanced_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        note_label = QLabel(i18n.get('advanced', {}).get('player_note', '...'))
        note_label.setStyleSheet("color: red;")
        layout.addRow(note_label)

        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'audio_player_path'), self._create_browse_widget(self.audio_player_path_edit, QFileDialog.FileMode.ExistingFile))
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'video_player_path'), self._create_browse_widget(self.video_player_path_edit, QFileDialog.FileMode.ExistingFile))
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'play_latest_hotkey'), self.play_latest_audio_hotkey_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'multiline_storage_field'), self.multi_line_sentence_storage_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'ocr_port'), self.ocr_websocket_port_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'texthooker_comm_port'), self.texthooker_communication_websocket_port_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'reset_line_hotkey'), self.reset_line_hotkey_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'polling_rate'), self.polling_rate_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'localhost_bind_address'), self.localhost_bind_address_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'current_version'), self.current_version_label)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'latest_version'), self.latest_version_label)

        layout.addRow(self._create_reset_button("advanced", self._create_advanced_tab))
        return widget

    def _create_profiles_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'profiles', 'select_profile'), self.profile_combo)

        button_widget = QWidget()
        button_layout = QHBoxLayout(button_widget)
        button_layout.setContentsMargins(0,0,0,0)
        add_button = QPushButton(i18n.get('profiles', {}).get('add_button', 'Add'))
        add_button.clicked.connect(self.add_profile)
        copy_button = QPushButton(i18n.get('profiles', {}).get('copy_button', 'Copy'))
        copy_button.clicked.connect(self.copy_profile)
        self.delete_profile_button = QPushButton(i18n.get('profiles', {}).get('delete_button', 'Delete'))
        self.delete_profile_button.clicked.connect(self.delete_profile)
        button_layout.addWidget(add_button)
        button_layout.addWidget(copy_button)
        button_layout.addWidget(self.delete_profile_button)
        button_layout.addStretch()
        layout.addRow(button_widget)

        scene_widget = QWidget()
        scene_layout = QHBoxLayout(scene_widget)
        scene_layout.setContentsMargins(0,0,0,0)
        self.obs_scene_list.setSelectionMode(QAbstractItemView.SelectionMode.MultiSelection)
        scene_layout.addWidget(self.obs_scene_list)
        refresh_button = QPushButton(i18n.get('profiles', {}).get('refresh_scenes_button', 'Refresh'))
        refresh_button.clicked.connect(self.refresh_obs_scenes)
        scene_layout.addWidget(refresh_button)
        layout.addRow(self._create_labeled_widget(i18n, 'profiles', 'obs_scene'), scene_widget)

        layout.addRow(self._create_labeled_widget(i18n, 'profiles', 'switch_to_default'), self.switch_to_default_if_not_found_check)

        return widget

    # --- UI Population and Data Loading ---
    def load_settings_to_ui(self):
        """Populates all UI widgets with data from the current self.settings object."""
        s = self.settings # shorthand
        
        # General
        self.websocket_enabled_check.setChecked(s.general.use_websocket)
        self.clipboard_enabled_check.setChecked(s.general.use_clipboard)
        self.use_both_clipboard_and_websocket_check.setChecked(s.general.use_both_clipboard_and_websocket)
        self.merge_matching_sequential_text_check.setChecked(s.general.merge_matching_sequential_text)
        self.websocket_uri_edit.setText(s.general.websocket_uri)
        self.texthook_replacement_regex_edit.setText(s.general.texthook_replacement_regex)
        self.open_config_on_startup_check.setChecked(s.general.open_config_on_startup)
        self.open_multimine_on_startup_check.setChecked(s.general.open_multimine_on_startup)
        self.texthooker_port_edit.setText(str(s.general.texthooker_port))
        
        self.native_language_combo.blockSignals(True)
        self.native_language_combo.clear()
        self.native_language_combo.addItems(CommonLanguages.get_all_names_pretty())
        self.native_language_combo.setCurrentText(CommonLanguages.from_code(s.general.native_language).name.replace('_', ' ').title() if s.general.native_language else 'English')
        self.native_language_combo.blockSignals(False)

        self.locale_combo.blockSignals(True)
        self.locale_combo.clear()
        self.locale_combo.addItems([e.name for e in Locale])
        self.locale_combo.setCurrentText(self.master_config.get_locale().name)
        self.locale_combo.blockSignals(False)
        
        self.notify_on_update_check.setChecked(s.features.notify_on_update)
        
        # Paths
        self.folder_to_watch_edit.setText(s.paths.folder_to_watch)
        self.output_folder_edit.setText(s.paths.output_folder)
        self.copy_temp_files_to_output_folder_check.setChecked(s.paths.copy_temp_files_to_output_folder)
        self.open_output_folder_on_card_creation_check.setChecked(s.paths.open_output_folder_on_card_creation)
        self.copy_trimmed_replay_to_output_folder_check.setChecked(s.paths.copy_trimmed_replay_to_output_folder)
        self.remove_video_check.setChecked(s.paths.remove_video)
        
        # Anki
        self.update_anki_check.setChecked(s.anki.update_anki)
        self.show_update_confirmation_dialog_check.setChecked(s.anki.show_update_confirmation_dialog_v2)
        self.anki_url_edit.setText(s.anki.url)
        self.sentence_field_edit.setText(s.anki.sentence_field)
        self.sentence_audio_field_edit.setText(s.anki.sentence_audio_field)
        self.picture_field_edit.setText(s.anki.picture_field)
        self.word_field_edit.setText(s.anki.word_field)
        self.previous_sentence_field_edit.setText(s.anki.previous_sentence_field)
        self.previous_image_field_edit.setText(s.anki.previous_image_field)
        self.game_name_field_edit.setText(s.anki.game_name_field)
        self.video_field_edit.setText(s.anki.video_field)
        self.custom_tags_edit.setText(', '.join(s.anki.custom_tags))
        self.tags_to_check_edit.setText(', '.join(s.anki.tags_to_check))
        self.add_game_tag_check.setChecked(s.anki.add_game_tag)
        self.parent_tag_edit.setText(s.anki.parent_tag)
        self.overwrite_audio_check.setChecked(s.anki.overwrite_audio)
        self.overwrite_picture_check.setChecked(s.anki.overwrite_picture)
        self.multi_overwrites_sentence_check.setChecked(s.anki.multi_overwrites_sentence)
        
        # Features
        self.full_auto_check.setChecked(s.features.full_auto)
        self.open_anki_edit_check.setChecked(s.features.open_anki_edit)
        self.open_anki_browser_check.setChecked(s.features.open_anki_in_browser)
        self.browser_query_edit.setText(s.features.browser_query)
        self.generate_longplay_check.setChecked(s.features.generate_longplay)
        
        # Screenshot
        self.screenshot_enabled_check.setChecked(s.screenshot.enabled)
        self.screenshot_width_edit.setText(s.screenshot.width)
        self.screenshot_height_edit.setText(s.screenshot.height)
        self.screenshot_quality_edit.setText(s.screenshot.quality)
        self.screenshot_extension_combo.clear()
        self.screenshot_extension_combo.addItems(['webp', 'avif', 'png', 'jpeg'])
        self.screenshot_extension_combo.setCurrentText(s.screenshot.extension)
        self.animated_screenshot_check.setChecked(s.screenshot.animated)
        self.screenshot_custom_ffmpeg_settings_edit.setText(s.screenshot.custom_ffmpeg_settings)
        self.screenshot_timing_combo.clear()
        self.screenshot_timing_combo.addItems(['beginning', 'middle', 'end'])
        self.screenshot_timing_combo.setCurrentText(s.screenshot.screenshot_timing_setting)
        self.seconds_after_line_edit.setText(str(s.screenshot.seconds_after_line))
        self.use_screenshot_selector_check.setChecked(s.screenshot.use_screenshot_selector)
        self.take_screenshot_hotkey_edit.setText(s.hotkeys.take_screenshot)
        self.screenshot_hotkey_update_anki_check.setChecked(s.screenshot.screenshot_hotkey_updates_anki)
        self.trim_black_bars_check.setChecked(s.screenshot.trim_black_bars_wip)
        
        # Audio
        self.audio_enabled_check.setChecked(s.audio.enabled)
        self.audio_extension_combo.clear()
        self.audio_extension_combo.addItems(['opus', 'mp3', 'ogg', 'aac', 'm4a'])
        self.audio_extension_combo.setCurrentText(s.audio.extension)
        self.beginning_offset_edit.setText(str(s.audio.beginning_offset))
        self.pre_vad_audio_offset_edit.setText(str(s.audio.pre_vad_end_offset))
        self._load_ffmpeg_presets()
        self.audio_ffmpeg_reencode_options_edit.setText(s.audio.ffmpeg_reencode_options)
        self.anki_media_collection_edit.setText(s.audio.anki_media_collection)
        self.external_tool_edit.setText(s.audio.external_tool)
        self.external_tool_enabled_check.setChecked(s.audio.external_tool_enabled)
        
        # VAD
        self.do_vad_postprocessing_check.setChecked(s.vad.do_vad_postprocessing)
        self.language_combo.clear()
        self.language_combo.addItems(AVAILABLE_LANGUAGES)
        self.language_combo.setCurrentText(s.vad.language)
        self.whisper_model_combo.clear()
        self.whisper_model_combo.addItems([WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, WHISPER_MEDIUM, WHISPER_LARGE, WHISPER_TURBO])
        self.whisper_model_combo.setCurrentText(s.vad.whisper_model)
        self.selected_vad_model_combo.clear()
        self.selected_vad_model_combo.addItems([SILERO, WHISPER])
        self.selected_vad_model_combo.setCurrentText(s.vad.selected_vad_model)
        self.backup_vad_model_combo.clear()
        self.backup_vad_model_combo.addItems([OFF, SILERO, WHISPER])
        self.backup_vad_model_combo.setCurrentText(s.vad.backup_vad_model)
        self.add_audio_on_no_results_check.setChecked(s.vad.add_audio_on_no_results)
        self.use_tts_as_fallback_check.setChecked(s.vad.use_tts_as_fallback)
        self.tts_url_edit.setText(s.vad.tts_url)
        self.end_offset_edit.setText(str(s.audio.end_offset))
        self.vad_trim_beginning_check.setChecked(s.vad.trim_beginning)
        self.vad_beginning_offset_edit.setText(str(s.vad.beginning_offset))
        self.cut_and_splice_segments_check.setChecked(s.vad.cut_and_splice_segments)
        self.splice_padding_edit.setText(str(s.vad.splice_padding))
        self.use_cpu_for_inference_check.setChecked(s.vad.use_cpu_for_inference)
        self.use_vad_filter_for_whisper_check.setChecked(s.vad.use_vad_filter_for_whisper)
        
        # OBS
        self.obs_open_obs_check.setChecked(s.obs.open_obs)
        self.obs_close_obs_check.setChecked(s.obs.close_obs)
        self.obs_path_edit.setText(s.obs.obs_path)
        self.obs_host_edit.setText(s.obs.host)
        self.obs_port_edit.setText(str(s.obs.port))
        self.obs_password_edit.setText(s.obs.password)
        self.automatically_manage_replay_buffer_check.setChecked(s.obs.automatically_manage_replay_buffer)
        self.obs_minimum_replay_size_edit.setText(str(s.obs.minimum_replay_size))
        
        # AI
        self.ai_enabled_check.setChecked(s.ai.add_to_anki)
        self.ai_provider_combo.clear()
        self.ai_provider_combo.addItems([AI_GEMINI, AI_GROQ, AI_OPENAI])
        self.ai_provider_combo.setCurrentText(s.ai.provider)
        self.gemini_model_combo.clear()
        self.gemini_model_combo.addItems(RECOMMENDED_GEMINI_MODELS)
        self.gemini_model_combo.setCurrentText(s.ai.gemini_model)
        self.gemini_api_key_edit.setText(s.ai.gemini_api_key)
        self.groq_model_combo.clear()
        self.groq_model_combo.addItems(RECOMMENDED_GROQ_MODELS)
        self.groq_model_combo.setCurrentText(s.ai.groq_model)
        self.groq_api_key_edit.setText(s.ai.groq_api_key)
        self.open_ai_url_edit.setText(s.ai.open_ai_url)
        self.open_ai_model_edit.setText(s.ai.open_ai_model)
        self.open_ai_api_key_edit.setText(s.ai.open_ai_api_key)
        self.ai_anki_field_edit.setText(s.ai.anki_field)
        self.ai_dialogue_context_length_edit.setText(str(s.ai.dialogue_context_length))
        self.use_canned_translation_prompt_check.setChecked(s.ai.use_canned_translation_prompt)
        self.use_canned_context_prompt_check.setChecked(s.ai.use_canned_context_prompt)
        self.custom_prompt_textedit.setPlainText(s.ai.custom_prompt)
        self.custom_texthooker_prompt_textedit.setPlainText(s.ai.custom_texthooker_prompt)
        self.get_online_models()
        
        # Overlay
        self.overlay_websocket_port_edit.setText(str(s.overlay.websocket_port))
        self._load_monitors()
        self.overlay_engine_combo.clear()
        self.overlay_engine_combo.addItems([e.value for e in OverlayEngine])
        self.overlay_engine_combo.setCurrentText(s.overlay.engine)
        self.scan_delay_edit.setText(str(s.overlay.scan_delay))
        self.periodic_check.setChecked(s.overlay.periodic)
        self.periodic_interval_edit.setText(str(s.overlay.periodic_interval))
        self.periodic_ratio_edit.setText(str(s.overlay.periodic_ratio))
        self.number_of_local_scans_per_event_edit.setText(str(getattr(s.overlay, 'number_of_local_scans_per_event', 1)))
        self.overlay_minimum_character_size_edit.setText(str(s.overlay.minimum_character_size))
        
        # Advanced
        self.audio_player_path_edit.setText(s.advanced.audio_player_path)
        self.video_player_path_edit.setText(s.advanced.video_player_path)
        self.play_latest_audio_hotkey_edit.setText(s.hotkeys.play_latest_audio)
        self.multi_line_line_break_edit.setText(s.advanced.multi_line_line_break)
        self.multi_line_sentence_storage_field_edit.setText(s.advanced.multi_line_sentence_storage_field)
        self.ocr_websocket_port_edit.setText(str(s.advanced.ocr_websocket_port))
        self.texthooker_communication_websocket_port_edit.setText(str(s.advanced.texthooker_communication_websocket_port))
        self.plaintext_websocket_export_port_edit.setText(str(s.advanced.plaintext_websocket_port))
        self.reset_line_hotkey_edit.setText(s.hotkeys.reset_line)
        self.polling_rate_edit.setText(str(s.anki.polling_rate))
        self.localhost_bind_address_edit.setText(s.advanced.localhost_bind_address)
        self.current_version_label.setText(get_current_version())
        self.latest_version_label.setText(get_latest_version())
        
        # Profiles
        self.profile_combo.blockSignals(True)
        self.profile_combo.clear()
        self.profile_combo.addItems(list(self.master_config.configs.keys()))
        self.profile_combo.setCurrentText(s.name)
        self.profile_combo.blockSignals(False)
        self.switch_to_default_if_not_found_check.setChecked(self.master_config.switch_to_default_if_not_found)
        self.delete_profile_button.setHidden(s.name == DEFAULT_CONFIG)
        
        # Required Settings Tab - Initialize duplicate widgets
        self.req_websocket_enabled_check.setChecked(s.general.use_websocket)
        self.req_clipboard_enabled_check.setChecked(s.general.use_clipboard)
        self.req_websocket_uri_edit.setText(s.general.websocket_uri)
        self.req_folder_to_watch_edit.setText(s.paths.folder_to_watch)
        self.req_sentence_field_edit.setText(s.anki.sentence_field)
        self.req_sentence_audio_field_edit.setText(s.anki.sentence_audio_field)
        self.req_picture_field_edit.setText(s.anki.picture_field)
        self.req_word_field_edit.setText(s.anki.word_field)
        self.req_beginning_offset_edit.setText(str(s.audio.beginning_offset))
        self.req_end_offset_edit.setText(str(s.audio.end_offset))
        self.req_cut_and_splice_segments_check.setChecked(s.vad.cut_and_splice_segments)
        self.req_splice_padding_edit.setText(str(s.vad.splice_padding))
        self.req_external_tool_edit.setText(s.audio.external_tool)
        self.req_open_anki_edit_check.setChecked(s.features.open_anki_edit)
        self.req_open_anki_browser_check.setChecked(s.features.open_anki_in_browser)

    # --- Misc Helper Methods ---
    def _update_window_title(self):
        title_template = self.i18n.get('app', {}).get('title_with_profile', 'GameSentenceMiner Config - {profile_name}')
        self.setWindowTitle(title_template.format(profile_name=self.settings.name))

    def check_obs_errors(self):
        try:
            errors = obs.get_queued_gui_errors()
            for title, message, recheck_func in errors:
                if recheck_func and recheck_func():
                    continue
                QMessageBox.critical(self, title, message)
        except Exception as e:
            logger.debug(f"Error checking OBS error queue: {e}")

    def _create_labeled_widget(self, i18n_dict, key1, key2=None):
        """Helper to create a QLabel with text and tooltip from the i18n dict."""
        if key2:
            data = i18n_dict.get(key1, {}).get(key2, {})
        else:
            data = i18n_dict.get(key1, {})
            
        label = QLabel(data.get('label', f'{key1}.{key2}'))
        label.setToolTip(data.get('tooltip', '...'))
        return label

    def _create_browse_widget(self, line_edit, mode):
        """Helper to create a LineEdit with a Browse button."""
        widget = QWidget()
        layout = QHBoxLayout(widget)
        layout.setContentsMargins(0,0,0,0)
        layout.addWidget(line_edit)
        browse_button = self._create_browse_button(line_edit, mode)
        layout.addWidget(browse_button)
        return widget

    def _create_browse_button(self, line_edit, mode):
        button = QPushButton(self.i18n.get('buttons', {}).get('browse', 'Browse'))
        button.clicked.connect(lambda: self._browse_for_path(line_edit, mode))
        return button

    def _browse_for_path(self, line_edit, mode):
        if mode == QFileDialog.FileMode.Directory:
            path = QFileDialog.getExistingDirectory(self, "Select Folder", line_edit.text())
        else:
            path, _ = QFileDialog.getOpenFileName(self, "Select File", line_edit.text())
        
        if path:
            line_edit.setText(path)
            
    def _create_reset_button(self, category, recreate_func):
        i18n = self.i18n.get('buttons', {}).get('reset_to_default', {})
        button = QPushButton(i18n.get('text', 'Reset to Default'))
        button.setToolTip(i18n.get('tooltip', 'Reset current tab to default.'))
        button.clicked.connect(lambda: self._reset_to_default(category, recreate_func))
        return button

    def _reset_to_default(self, category, recreate_func):
        i18n = self.i18n.get('dialogs', {}).get('reset_to_default', {})
        reply = QMessageBox.question(self, i18n.get('title', 'Reset to Default'),
                                     i18n.get('message', 'Are you sure?'),
                                     QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                                     QMessageBox.StandardButton.No)
        if reply == QMessageBox.StandardButton.Yes:
            default_category_config = getattr(self.default_settings, category)
            setattr(self.settings, category, copy.deepcopy(default_category_config))
            self.load_settings_to_ui()
            self.save_settings()
            self.reload_settings(force_refresh=True)

    # --- Profile & OBS Scene Management ---
    def add_profile(self):
        i18n = self.i18n.get('dialogs', {}).get('add_profile', {})
        name, ok = QInputDialog.getText(self, i18n.get('title', 'Add Profile'), i18n.get('prompt', 'Enter new profile name:'))
        if ok and name:
            self.master_config.configs[name] = self.master_config.get_default_config()
            self.profile_combo.addItem(name)
            self.profile_combo.setCurrentText(name) # This will trigger the change handler

    def copy_profile(self):
        source_profile = self.profile_combo.currentText()
        i18n = self.i18n.get('dialogs', {}).get('copy_profile', {})
        name, ok = QInputDialog.getText(self, i18n.get('title', 'Copy Profile'), i18n.get('prompt', 'Enter new profile name:'))
        if ok and name and source_profile in self.master_config.configs:
            self.master_config.configs[name] = copy.deepcopy(self.master_config.configs[source_profile])
            self.master_config.configs[name].name = name
            self.profile_combo.addItem(name)
            self.profile_combo.setCurrentText(name)

    def delete_profile(self):
        profile_to_delete = self.profile_combo.currentText()
        i18n = self.i18n.get('dialogs', {}).get('delete_profile', {})
        if profile_to_delete == DEFAULT_CONFIG:
            QMessageBox.critical(self, i18n.get('error_title', 'Error'), i18n.get('error_cannot_delete_default', 'Cannot delete Default profile.'))
            return
        
        reply = QMessageBox.question(self, i18n.get('title', 'Confirm Delete'),
                                     i18n.get('message', "Delete '{p}'?").format(p=profile_to_delete),
                                     QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                                     QMessageBox.StandardButton.No)
        if reply == QMessageBox.StandardButton.Yes:
            del self.master_config.configs[profile_to_delete]
            self.master_config.current_profile = DEFAULT_CONFIG
            save_full_config(self.master_config)
            self.reload_settings(force_refresh=True)

    def refresh_obs_scenes(self):
        self.obs_scene_list.clear()
        try:
            scenes = obs.get_obs_scenes()
            scene_names = [scene['sceneName'] for scene in scenes]
            self.obs_scene_list.addItems(scene_names)
            for i in range(self.obs_scene_list.count()):
                item = self.obs_scene_list.item(i)
                if item.text() in self.settings.scenes:
                    item.setSelected(True)
        except Exception as e:
            logger.error(f"Failed to refresh OBS scenes: {e}")

    # --- Other UI Loaders ---
    def _load_ffmpeg_presets(self):
        i18n = self.i18n.get('tabs', {}).get('audio', {}).get('ffmpeg_preset', {}).get('options', {})
        self.ffmpeg_preset_map = {
            i18n.get('no_reencode', "No Re-encode"): "",
            i18n.get('fade_in', "Simple Fade-in..."): "-c:a {encoder} -f {format} -af \"afade=t=in:d=0.005\"",
            i18n.get('loudness_norm', "Simple loudness..."): "-c:a {encoder} -f {format} -af \"loudnorm=I=-23:TP=-2,afade=t=in:d=0.005\"",
            i18n.get('downmix_norm', "Downmix to mono..."): "-c:a {encoder} -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.005\"",
            i18n.get('downmix_norm_low_bitrate', "Downmix to mono, 30kbps..."): "-c:a {encoder} -b:a 30k -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.005\"",
            i18n.get('custom', "Custom"): get_config().audio.custom_encode_settings,
        }
        self.ffmpeg_audio_preset_combo.clear()
        self.ffmpeg_audio_preset_combo.addItems(self.ffmpeg_preset_map.keys())

    def _load_monitors(self):
        self.overlay_monitor_combo.clear()
        try:
            import mss
            monitors = [f"Monitor {i}" for i, _ in enumerate(mss.mss().monitors[1:], start=1)]
            self.overlay_monitor_combo.addItems(monitors if monitors else ["Monitor 1"])
            if 0 <= self.settings.overlay.monitor_to_capture < self.overlay_monitor_combo.count():
                self.overlay_monitor_combo.setCurrentIndex(self.settings.overlay.monitor_to_capture)
        except (ImportError, Exception) as e:
            logger.warning(f"Could not list monitors: {e}")
            self.overlay_monitor_combo.addItem("Monitor 1")

    # --- External Tool Installers ---
    def download_and_install_ocen(self):
        i18n = self.i18n.get('dialogs', {}).get('install_ocenaudio', {})
        reply = QMessageBox.question(self, i18n.get('title', 'Download OcenAudio?'),
                                     i18n.get('message', 'Download and configure Ocenaudio?'),
                                     QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        if reply == QMessageBox.StandardButton.Yes:
            self.external_tool_edit.setText(i18n.get('downloading_message', 'Downloading...'))
            QApplication.processEvents() # Update UI
            exe_path = download_ocenaudio_if_needed()
            QMessageBox.information(self, i18n.get('success_title', 'Download Complete'),
                                    i18n.get('success_message', 'Downloaded to {path}').format(path=exe_path))
            self.external_tool_edit.setText(exe_path)
            self.save_settings()

    def call_audio_offset_selector(self):
        try:
            path, beginning_offset, end_offset = gsm_state.previous_trim_args
            command = [sys.executable, "-m", "GameSentenceMiner.tools.audio_offset_selector",
                       "--path", path, "--beginning_offset", str(beginning_offset), "--end_offset", str(end_offset)]
            logger.info(' '.join(command))
            result = subprocess.run(command, capture_output=True, text=True, check=True)
            logger.info(f"Audio offset selector output: {result.stdout.strip()}")
            QApplication.clipboard().setText(result.stdout.strip())
            i18n = self.i18n.get('dialogs', {}).get('offset_copied', {})
            QMessageBox.information(self, i18n.get('title', 'Clipboard'), i18n.get('message', 'Offset copied!'))
        except Exception as e:
            logger.error(f"Error calling audio offset selector: {e}")
            QMessageBox.critical(self, "Error", f"Could not run audio offset tool. Error: {e}")

    def open_minimum_character_size_selector(self):
        from GameSentenceMiner.ui.qt_main import launch_minimum_character_size_selector
        current_size = int(self.overlay_minimum_character_size_edit.text() or 0)
        new_size = launch_minimum_character_size_selector(current_size, for_overlay=True)
        if new_size is not None:
            self.overlay_minimum_character_size_edit.setText(str(new_size))
        self.save_settings()

    def get_online_models(self):
        ai_models = AIModelsTable.one()
        if ai_models and ai_models.gemini_models and ai_models.groq_models and (time.time() - ai_models.last_updated < 3600 * 6):
            self.gemini_model_combo.addItems(ai_models.gemini_models)
            self.groq_model_combo.addItems(ai_models.groq_models)
        else:
            logger.info("AI models outdated or not found, fetching new ones.")
            self.model_fetcher = AIModelFetcher(self.groq_api_key_edit.text())
            self.model_thread = threading.Thread(target=self.model_fetcher.fetch, daemon=True)
            self.model_fetcher.models_fetched.connect(self._update_ai_model_combos)
            self.model_thread.start()

    def _update_ai_model_combos(self, gemini_models, groq_models):
        self.gemini_model_combo.addItems(gemini_models)
        self.groq_model_combo.addItems(groq_models)
        # Restore previous selection
        self.gemini_model_combo.setCurrentText(self.settings.ai.gemini_model)
        self.groq_model_combo.setCurrentText(self.settings.ai.groq_model)

    def closeEvent(self, event):
        self.hide_window()
        event.ignore()


# Module-level singleton for config window management
_config_window = None
_qt_app = None


def get_config_window_manager():
    """
    Get or create the singleton ConfigWindow instance.
    
    Returns:
        ConfigWindow: The singleton ConfigWindow instance
    """
    global _config_window, _qt_app
    
    if _config_window is None:
        # Create QApplication if it doesn't exist
        if _qt_app is None:
            _qt_app = QApplication.instance()
            if _qt_app is None:
                _qt_app = QApplication(sys.argv)
                
                try:
                    import qdarktheme
                    base_stylesheet = qdarktheme.load_stylesheet(theme="dark")
                except ImportError:
                    logger.warning("qdarktheme not found. Using system default theme.")
                    base_stylesheet = ""
                
                _qt_app.setStyleSheet(base_stylesheet)
        
        _config_window = ConfigWindow()
    
    return _config_window



def start_qt(show_immediately=True):
    """
    Start the Qt event loop.
    
    Args:
        show_immediately (bool): If True, show the config window immediately
    
    Note:
        This is a blocking call that runs the Qt event loop.
        It should be called from the main thread.
    """
    global _config_window, _qt_app
    
    window = get_config_window_manager()
    
    if show_immediately:
        window.show_window()
    
    # Start the Qt event loop (blocking)
    # Don't call sys.exit() - just run the event loop
    _qt_app.exec()


if __name__ == '__main__':
    app = QApplication(sys.argv)
    
    # Install custom style to make tooltips appear faster (50ms instead of ~700ms)
    app.setStyle(FastTooltipStyle())
    
    try:
        import qdarktheme
        base_stylesheet = qdarktheme.load_stylesheet(theme="dark")
    except ImportError:
        logger.warning("qdarktheme not found. Using system default theme.")
        base_stylesheet = ""
    
    # Enhanced tooltip styling
    tooltip_style = """
        QToolTip {
            border: 1px solid palette(dark);
            padding: 4px;
            border-radius: 3px;
            opacity: 240;
        }
    """
    app.setStyleSheet(base_stylesheet + tooltip_style)
    
    window = ConfigWindow()
    window.show_window()
    sys.exit(app.exec())