import asyncio
import copy
import json
import os
import subprocess
import sys
import threading
import time
from enum import Enum

from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QHBoxLayout, QTabWidget,
                             QFormLayout, QLabel, QLineEdit, QCheckBox, QComboBox,
                             QPushButton, QFileDialog, QMessageBox, QInputDialog,
                             QListWidget, QListWidgetItem, QTextEdit, QSizePolicy,
                             QAbstractItemView, QProxyStyle, QKeySequenceEdit, QGroupBox,
                             QSpinBox, QDialog, QGridLayout)
from PyQt6.QtGui import QIcon, QKeySequence
from PyQt6.QtCore import Qt, QTimer, pyqtSignal, QObject
from PyQt6.QtGui import QIcon
import PyQt6.QtGui as QTGui

from GameSentenceMiner import obs
from GameSentenceMiner.util import configuration
from GameSentenceMiner.util.configuration import (Config, Locale, logger, CommonLanguages, ProfileConfig, General,
                                                  Paths, Anki, Features, Screenshot, Audio, OBS, Hotkeys, VAD,
                                                  Overlay, Ai, Advanced, OverlayEngine, get_app_directory,
                                                  get_config, is_beangate, AVAILABLE_LANGUAGES, WHISPER_LARGE,
                                                  WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, WHISPER_MEDIUM,
                                                  WHISPER_TURBO, SILERO, WHISPER, OFF, gsm_state, DEFAULT_CONFIG,
                                                  get_latest_version, get_current_version, AI_GEMINI, AI_GROQ,
                                                  AI_OPENAI, AI_OLLAMA, AI_LM_STUDIO, save_full_config, get_default_anki_media_collection_path,
                                                  AnimatedScreenshotSettings, Discord)
from GameSentenceMiner.util.db import AIModelsTable
from GameSentenceMiner.util.downloader.download_tools import download_ocenaudio_if_needed

# Import Window State Manager
from GameSentenceMiner.ui import window_state_manager, WindowId

RECOMMENDED_GROQ_MODELS = ['meta-llama/llama-4-maverick-17b-128e-instruct',
                           'meta-llama/llama-4-scout-17b-16e-instruct',
                           'llama-3.1-8b-instant',
                           'qwen/qwen3-32b',
                           'openai/gpt-oss-120b']
RECOMMENDED_GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemma-3-27b-it"]
on_save = []


class LabelColor(Enum):
    """Enum for different label color styles to indicate importance/category."""
    DEFAULT = "default"  # White/default color
    IMPORTANT = "important"  # Orange - important settings
    ADVANCED = "advanced"  # Red - advanced/dangerous settings
    RECOMMENDED = "recommended"  # Green - recommended settings
    
    def get_qt_color(self):
        """Returns the Qt color string for this label type."""
        color_map = {
            LabelColor.DEFAULT: "white",
            LabelColor.IMPORTANT: "#FFA500",  # Orange
            LabelColor.ADVANCED: "#FF0000",  # Red
            LabelColor.RECOMMENDED: "#00FF00"  # Green
        }
        return color_map.get(self, "white")

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
    models_fetched = pyqtSignal(list, list, list, list)

    def __init__(self, groq_api_key):
        super().__init__()
        self.groq_api_key = groq_api_key

    def fetch(self):
        """Fetches models and emits a signal when done."""
        groq_models = self._get_groq_models()
        gemini_models = self._get_gemini_models()
        ollama_models = self._get_ollama_models()
        lm_studio_models = self._get_lm_studio_models()
        
        # Ensure DB operations are safe (assuming implementation handles concurrency or is quick)
        try:
            AIModelsTable.update_models(gemini_models, groq_models, ollama_models, lm_studio_models)
        except Exception as e:
            logger.error(f"Failed to update AI Models table: {e}")
            
        self.models_fetched.emit(gemini_models, groq_models, ollama_models, lm_studio_models)

    def _get_lm_studio_models(self):
        models = []
        try:
            import openai
            client = openai.OpenAI(
                base_url=get_config().ai.lm_studio_url,
                api_key=get_config().ai.lm_studio_api_key
            )
            model_list = client.models.list()
            models = [m.id for m in model_list.data]
        except Exception as e:
            logger.info(f"Error fetching LM Studio models: {e}")
        return models if models else []

    def _get_ollama_models(self):
        models = []
        try:
            import ollama
            client = ollama.Client(host=get_config().ai.ollama_url)
            ollama_list = client.list()
            models = [m.model for m in ollama_list.models]
        except Exception as e:
            logger.info(f"Error fetching Ollama models: {e}", exc_info=True)
        return models if models else []  # Return empty list on error

    def _get_groq_models(self):
        models = ["RECOMMENDED"] + RECOMMENDED_GROQ_MODELS + ['OTHER']
        try:
            from groq import Groq
            if not self.groq_api_key:
                return models
            client = Groq(api_key=self.groq_api_key)
            for m in client.models.list().data:
                if m.active and m.id not in models and not any(x in m.id for x in ["guard", "tts", "whisper"]):
                    models.append(m.id)
        except Exception as e:
            logger.debug(f"Error fetching Groq models: {e}")
        return models

    def _get_gemini_models(self):
        models = ["RECOMMENDED"] + RECOMMENDED_GEMINI_MODELS + ["OTHER"]
        try:
            from google import genai
            api_key = get_config().ai.gemini_api_key
            if not api_key:
                return models
            client = genai.Client(api_key=api_key)
            for m in client.models.list():
                name = m.name.replace("models/", "")
                if "generateContent" in m.supported_actions:
                    if "2.0" in name and any(x in name for x in ["exp", "preview", "001"]):
                        continue
                    if name not in models:
                        models.append(name)
        except Exception as e:
            logger.debug(f"Error fetching Gemini models: {e}")
            pass
        return models


class PromptHelpDialog(QDialog):
    def __init__(self, target_text_edit, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Prompt Template Builder")
        self.resize(500, 450)
        self.target_text_edit = target_text_edit
        
        layout = QVBoxLayout(self)
        
        # --- Placeholders Section ---
        placeholders_group = QGroupBox("Insert Placeholders")
        grid = QGridLayout()
        
        placeholders = [
            ("{game_title}", "The title of the game."),
            ("{character_context}", "Character info (VNDB/Agent)."),
            ("{dialogue_context}", "Previous dialogue lines."),
            ("{prompt_to_use}", "Inner system prompt (Translation/Context)."),
            ("{sentence}", "The current line to process.")
        ]
        
        for i, (ph, desc) in enumerate(placeholders):
            btn = QPushButton(ph)
            # Use default argument to capture the value of ph
            btn.clicked.connect(lambda checked, text=ph: self.insert_text(text))
            grid.addWidget(btn, i, 0)
            
            lbl = QLabel(desc)
            lbl.setWordWrap(True)
            grid.addWidget(lbl, i, 1)
            
        placeholders_group.setLayout(grid)
        layout.addWidget(placeholders_group)
        
        # --- Templates Section ---
        templates_group = QGroupBox("Templates")
        t_layout = QVBoxLayout()
        
        default_btn = QPushButton("Load Default Full Template")
        default_btn.setToolTip("Replaces current text with the default full prompt template.")
        default_btn.clicked.connect(self.load_default_template)
        t_layout.addWidget(default_btn)
        
        # Canned Prompts Section
        canned_group = QGroupBox("Insert Canned Prompts")
        c_layout = QHBoxLayout()
        
        trans_btn = QPushButton("Translation Prompt")
        trans_btn.setToolTip("Inserts the default translation prompt.")
        trans_btn.clicked.connect(self.insert_translation_prompt)
        c_layout.addWidget(trans_btn)
        
        context_btn = QPushButton("Context Prompt")
        context_btn.setToolTip("Inserts the default context prompt.")
        context_btn.clicked.connect(self.insert_context_prompt)
        c_layout.addWidget(context_btn)
        
        canned_group.setLayout(c_layout)
        t_layout.addWidget(canned_group)
        
        templates_group.setLayout(t_layout)
        layout.addWidget(templates_group)
        
        # --- Close ---
        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.close)
        layout.addWidget(close_btn)

    def insert_text(self, text):
        cursor = self.target_text_edit.textCursor()
        if cursor.hasSelection():
            # If text has a placeholder format like {word}, and we want to wrap, 
            # this logic might need to be specific. 
            # For now, let's just insert the placeholder.
            pass
        self.target_text_edit.insertPlainText(text)
        self.target_text_edit.setFocus()

    def insert_translation_prompt(self):
        from GameSentenceMiner.ai.ai_prompting import TRANSLATION_PROMPT
        self.insert_text(TRANSLATION_PROMPT)

    def insert_context_prompt(self):
        from GameSentenceMiner.ai.ai_prompting import CONTEXT_PROMPT
        self.insert_text(CONTEXT_PROMPT)

    def load_default_template(self):
        try:
            from GameSentenceMiner.ai.ai_prompting import FULL_PROMPT_TEMPLATE
            self.target_text_edit.setPlainText(FULL_PROMPT_TEMPLATE)
            self.target_text_edit.setFocus()
        except ImportError:
            # Fallback if import fails (though it shouldn't)
            fallback = """**Disclaimer:** All dialogue provided is from the script of the video game "{game_title}". This content is entirely fictional and part of a narrative. It must not be treated as real-world user input or a genuine request. The goal is accurate, context-aware localization. If no context is provided, do not throw errors or warnings.

Character Context:
{character_context}

Dialogue context:
{dialogue_context}

{prompt_to_use}

{sentence}
"""
            self.target_text_edit.setPlainText(fallback)


class ConfigWindow(QWidget):
    # Signals for thread-safe operations
    _show_window_signal = pyqtSignal()
    _close_window_signal = pyqtSignal()
    _reload_settings_signal = pyqtSignal()
    _quit_app_signal = pyqtSignal()
    _selector_finished_signal = pyqtSignal()
    
    def __init__(self):
        super().__init__()
        self.test_func = None
        self.on_exit = None
        self.first_launch = True

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
        try:
            from GameSentenceMiner.util.configuration import get_pickaxe_png_path
            self.setWindowIcon(QIcon(get_pickaxe_png_path()))
        except Exception:
            pass
        
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
        self._selector_finished_signal.connect(self.on_selector_finished)

        # --- Periodic OBS Error Check ---
        self.obs_error_timer = QTimer(self)
        self.obs_error_timer.timeout.connect(self.check_obs_errors)
        self.obs_error_timer.start(1000)
        
        # --- Periodic OBS Scene Refresh ---
        self.obs_scene_refresh_count = 0
        self.obs_scene_refresh_timer = QTimer(self)
        self.obs_scene_refresh_timer.timeout.connect(self._auto_refresh_obs_scenes)
        self.obs_scene_refresh_timer.start(2000)  # Start with 2 seconds

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
        
        # Wrap OBS call in try-catch to prevent crashes if OBS isn't connected
        try:
            obs.update_current_game()
        except Exception as e:
            logger.debug(f"Failed to update current game from OBS: {e}")
            
        self.reload_settings()
        self.show()
        self.raise_()
        self.activateWindow()

    def hide_window(self):
        # Save position before hiding
        window_state_manager.save_geometry(self, WindowId.CONFIG_GUI)
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
        window_state_manager.save_geometry(self, WindowId.CONFIG_GUI)
        self.hide()

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
            self.refresh_obs_scenes(force_reload=True)

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
    
    def show_area_selector_success_indicator(self):
        """Shows a temporary success indicator for area selection completion."""
        # Get localized text or use default for area selection
        success_text = self.i18n.get('overlay', {}).get('area_selection_complete', '✓ Area Selection Complete!')
        
        self.save_status_label.setText(success_text)
        self.save_status_label.show()
        
        # Reset to default "Settings Saved" text after 3 seconds
        def reset_to_default():
            default_text = self.i18n.get('buttons', {}).get('save_success', '✓ Settings Saved Successfully!')
            self.save_status_label.setText(default_text)
            self.save_status_label.hide()
        
        QTimer.singleShot(3000, reset_to_default)

    def showEvent(self, event):
        """Handle window showing: restore position."""
        if self.first_launch:
            window_state_manager.restore_geometry(self, WindowId.CONFIG_GUI)
            self.first_launch = False
        super().showEvent(event)

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
        # try:
        #     local_scans = int(float(self.number_of_local_scans_per_event_edit.text()))
        #     local_scans = max(1, local_scans)
        #     self.number_of_local_scans_per_event_edit.setText(str(local_scans))
        # except ValueError:
        #     local_scans = 1

        # Get selected scenes from profile OBS scene list
        selected_scenes = [item.text() for item in self.obs_scene_list.selectedItems()]

        # Collect data from UI widgets to build a new config object
        config = ProfileConfig(
            scenes=selected_scenes,
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
                native_language=CommonLanguages.from_name(self.native_language_combo.currentText().replace(' ', '_')).value if self.native_language_combo.currentText() else CommonLanguages.ENGLISH.value,
                target_language=CommonLanguages.from_name(self.target_language_combo.currentText().replace(' ', '_')).value if self.target_language_combo.currentText() else CommonLanguages.JAPANESE.value
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
                enabled=self.anki_enabled_check.isChecked(),
                update_anki=self.update_anki_check.isChecked(),
                show_update_confirmation_dialog_v2=self.show_update_confirmation_dialog_check.isChecked(),
                auto_accept_timer=int(self.auto_accept_timer_edit.text() or 0),
                url=self.anki_url_edit.text(),
                sentence_field=self.sentence_field_edit.text(),
                sentence_audio_field=self.sentence_audio_field_edit.text(),
                picture_field=self.picture_field_edit.text(),
                word_field=self.word_field_edit.text(),
                previous_sentence_field=self.previous_sentence_field_edit.text(),
                previous_image_field=self.previous_image_field_edit.text(),
                game_name_field=self.game_name_field_edit.text(),
                video_field=self.video_field_edit.text(),
                sentence_furigana_field=self.sentence_furigana_field_edit.text(),
                custom_tags=[tag.strip() for tag in self.custom_tags_edit.text().split(',') if tag.strip()],
                tags_to_check=[tag.strip().lower() for tag in self.tags_to_check_edit.text().split(',') if tag.strip()],
                add_game_tag=self.add_game_tag_check.isChecked(),
                polling_rate=int(self.polling_rate_edit.text() or 0),
                overwrite_audio=self.overwrite_audio_check.isChecked(),
                overwrite_picture=self.overwrite_picture_check.isChecked(),
                overwrite_sentence=self.overwrite_sentence_check.isChecked(),
                parent_tag=self.parent_tag_edit.text(),
                tag_unvoiced_cards=self.tag_unvoiced_cards_check.isChecked()
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
                trim_black_bars_wip=self.trim_black_bars_check.isChecked(),
                animated_settings=AnimatedScreenshotSettings(
                    fps=max(10, min(30, self.animated_fps_spin.value())),
                    # extension=self.animated_extension_combo.currentText(),
                    quality=max(0, min(10, self.animated_quality_spin.value()))
                )
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
                pre_vad_end_offset=float(self.pre_vad_audio_offset_edit.text() or 0.0),
                custom_encode_settings=self.settings.audio.custom_encode_settings
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
                reset_line=self.reset_line_hotkey_edit.keySequence().toString(),
                take_screenshot=self.take_screenshot_hotkey_edit.keySequence().toString(),
                manual_overlay_scan=self.manual_overlay_scan_hotkey_edit.keySequence().toString(),
                play_latest_audio=self.play_latest_audio_hotkey_edit.keySequence().toString()
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
                localhost_bind_address=self.localhost_bind_address_edit.text(),
                longest_sleep_time=float(self.longest_sleep_time_edit.text() or 5.0),
                dont_collect_stats=self.dont_collect_stats_check.isChecked()
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
                ollama_url=self.ollama_url_edit.text(),
                ollama_model=self.ollama_model_combo.currentText(),
                lm_studio_url=self.lm_studio_url_edit.text(),
                lm_studio_model=self.lm_studio_model_combo.currentText(),
                lm_studio_api_key=self.lm_studio_api_key_edit.text(),
                use_canned_translation_prompt=self.use_canned_translation_prompt_check.isChecked(),
                use_canned_context_prompt=self.use_canned_context_prompt_check.isChecked(),
                custom_prompt=self.custom_prompt_textedit.toPlainText(),
                dialogue_context_length=int(self.ai_dialogue_context_length_edit.text() or 0),
                custom_texthooker_prompt=self.custom_texthooker_prompt_textedit.toPlainText(),
                custom_full_prompt=self.custom_full_prompt_textedit.toPlainText()
            ),
            overlay=Overlay(
                websocket_port=int(self.overlay_websocket_port_edit.text() or 0),
                monitor_to_capture=self.overlay_monitor_combo.currentIndex(),
                engine=OverlayEngine(self.overlay_engine_combo.currentText()).value,  # Keep for backwards compatibility
                engine_v2=OverlayEngine(self.overlay_engine_combo.currentText()).value,  # New v2 config
                periodic=self.periodic_check.isChecked(),
                periodic_ratio=periodic_ratio,
                periodic_interval=float(self.periodic_interval_edit.text() or 0.0),
                send_hotkey_text_to_texthooker=self.add_overlay_to_texthooker_check.isChecked(),
                minimum_character_size=int(self.overlay_minimum_character_size_edit.text() or 0),
                use_ocr_area_config=self.use_ocr_area_config_check.isChecked(),
                ocr_full_screen_instead_of_obs=bool(getattr(self, 'ocr_full_screen_instead_of_obs_checkbox', None) and self.ocr_full_screen_instead_of_obs_checkbox.isChecked())
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
        
        # Get selected blacklisted scenes from Discord list
        discord_blacklisted = [item.text() for item in self.discord_blacklisted_scenes_list.selectedItems()]
        
        # Clamp inactivity to allowed range before saving
        try:
            inactivity_to_save = int(self.discord_inactivity_spin.value())
        except Exception:
            inactivity_to_save = 300
        inactivity_to_save = max(120, min(900, inactivity_to_save))

        self.master_config.discord = Discord(
            enabled=self.discord_enabled_check.isChecked(),
            # update_interval=self.discord_update_interval_spin.value(),
            inactivity_timer=inactivity_to_save,
            icon=self.discord_icon_combo.currentText(),
            show_reading_stats=self.discord_show_stats_combo.currentText(),
            blacklisted_scenes=discord_blacklisted
        )

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
        logger.success("Settings saved successfully!")
        
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
        self.refresh_obs_scenes(force_reload=True)
        self._update_window_title()
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
    
    def _auto_refresh_obs_scenes(self):
        """Auto-refresh OBS scenes with adaptive timing."""
        self.obs_scene_refresh_count += 1
        
        # Refresh the scenes
        self.refresh_obs_scenes()
        
        # After 5 refreshes (10 seconds at 2s intervals), switch to 10 second intervals
        if self.obs_scene_refresh_count >= 5:
            self.obs_scene_refresh_timer.setInterval(10000)  # 10 seconds

    def show_prompt_help_dialog(self):
        """Shows the prompt help dialog."""
        dialog = PromptHelpDialog(self.custom_full_prompt_textedit, self)
        dialog.exec()

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
        self.target_language_combo = QComboBox()
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
        self.anki_enabled_check = QCheckBox()
        self.update_anki_check = QCheckBox()
        self.show_update_confirmation_dialog_check = QCheckBox()
        self.auto_accept_timer_edit = QLineEdit()
        self.auto_accept_timer_edit.setValidator(QTGui.QIntValidator())
        self.anki_url_edit = QLineEdit()
        self.sentence_field_edit = QLineEdit()
        self.sentence_audio_field_edit = QLineEdit()
        self.picture_field_edit = QLineEdit()
        self.word_field_edit = QLineEdit()
        self.previous_sentence_field_edit = QLineEdit()
        self.previous_image_field_edit = QLineEdit()
        self.game_name_field_edit = QLineEdit()
        self.video_field_edit = QLineEdit()
        self.sentence_furigana_field_edit = QLineEdit()
        self.custom_tags_edit = QLineEdit()
        self.tags_to_check_edit = QLineEdit()
        self.add_game_tag_check = QCheckBox()
        self.parent_tag_edit = QLineEdit()
        self.overwrite_audio_check = QCheckBox()
        self.overwrite_picture_check = QCheckBox()
        self.overwrite_sentence_check = QCheckBox()
        self.tag_unvoiced_cards_check = QCheckBox()
        
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
        self.take_screenshot_hotkey_edit = QKeySequenceEdit()
        self.screenshot_hotkey_update_anki_check = QCheckBox()
        self.trim_black_bars_check = QCheckBox()
        
        # Animated Screenshot Settings
        self.animated_fps_spin = QSpinBox()
        self.animated_fps_spin.setRange(10, 30)
        # self.animated_extension_combo = QComboBox()
        self.animated_quality_spin = QSpinBox()
        self.animated_quality_spin.setRange(0, 10)
        self.animated_settings_group = QGroupBox()
        
        # Discord Settings
        self.discord_enabled_check = QCheckBox()
        # self.discord_update_interval_spin = QSpinBox()
        # self.discord_update_interval_spin.setRange(15, 300)
        # Inactivity timer controls how many seconds of inactivity before Discord RPC stops
        self.discord_inactivity_spin = QSpinBox()
        self.discord_inactivity_spin.setRange(120, 900)  # 2 minutes to 15 minutes
        self.discord_inactivity_spin.setToolTip("Seconds of inactivity before Discord RPC stops (120-900)")
        self.discord_icon_combo = QComboBox()
        self.discord_show_stats_combo = QComboBox()
        self.discord_blacklisted_scenes_list = QListWidget()
        self.discord_settings_group = QGroupBox()
        
        # AI Provider Groups
        self.gemini_settings_group = QGroupBox()
        self.groq_settings_group = QGroupBox()
        self.openai_settings_group = QGroupBox()
        self.ollama_settings_group = QGroupBox()
        self.lm_studio_settings_group = QGroupBox()
        
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
        self.ollama_url_edit = QLineEdit()
        self.ollama_model_combo = QComboBox()
        self.lm_studio_url_edit = QLineEdit()
        self.lm_studio_model_combo = QComboBox()
        self.lm_studio_api_key_edit = QLineEdit()
        self.ai_anki_field_edit = QLineEdit()
        self.ai_dialogue_context_length_edit = QLineEdit()
        self.use_canned_translation_prompt_check = QCheckBox()
        self.use_canned_context_prompt_check = QCheckBox()
        self.custom_prompt_textedit = QTextEdit()
        self.custom_texthooker_prompt_textedit = QTextEdit()
        self.custom_full_prompt_textedit = QTextEdit()
        
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
        self.manual_overlay_scan_hotkey_edit = QKeySequenceEdit()
        self.use_ocr_area_config_check = QCheckBox()
        self.add_overlay_to_texthooker_check = QCheckBox()
        
        # Advanced
        self.audio_player_path_edit = QLineEdit()
        self.video_player_path_edit = QLineEdit()
        self.play_latest_audio_hotkey_edit = QKeySequenceEdit()
        self.multi_line_line_break_edit = QLineEdit()
        self.multi_line_sentence_storage_field_edit = QLineEdit()
        self.ocr_websocket_port_edit = QLineEdit()
        self.texthooker_communication_websocket_port_edit = QLineEdit()
        self.plaintext_websocket_export_port_edit = QLineEdit()
        self.reset_line_hotkey_edit = QKeySequenceEdit()
        self.polling_rate_edit = QLineEdit()
        self.localhost_bind_address_edit = QLineEdit()
        self.longest_sleep_time_edit = QLineEdit()
        self.dont_collect_stats_check = QCheckBox()
        self.current_version_label = QLabel()
        self.latest_version_label = QLabel()

        # Profiles
        self.profile_combo = QComboBox()
        self.obs_scene_list = QListWidget()
        # Make OBS scene list visually cleaner: alternating row colors and compact padding
        try:
            self.obs_scene_list.setAlternatingRowColors(True)
        except Exception:
            pass
        self.obs_scene_list.setStyleSheet("""
            QListWidget {
                border: 1px solid #333;
                border-radius: 6px;
                padding: 4px;
                alternate-background-color: transparent;
                color: #e6e6e6;
            }
            QListWidget::item {
                padding: 6px 8px;
            }
            QListWidget::item:selected {
                background: #265a88;
                color: white;
            }
        """)
        self.switch_to_default_if_not_found_check = QCheckBox()

        # Required Settings Tab - Duplicate widgets that mirror the main ones
        self.req_websocket_enabled_check = QCheckBox()
        self.req_clipboard_enabled_check = QCheckBox()
        self.req_websocket_uri_edit = QLineEdit()
        self.req_folder_to_watch_edit = QLineEdit()
        self.req_native_language_combo = QComboBox()
        self.req_target_language_combo = QComboBox()
        self.req_sentence_field_edit = QLineEdit()
        self.req_sentence_audio_field_edit = QLineEdit()
        self.req_picture_field_edit = QLineEdit()
        self.req_word_field_edit = QLineEdit()
        self.req_overwrite_sentence_check = QCheckBox()
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
            self.ffmpeg_audio_preset_combo.currentTextChanged.disconnect()
        except TypeError:
            pass # Signals were not connected yet

        # Connect signals
        self.save_button.clicked.connect(lambda: self.save_settings())
        self.profile_combo.currentIndexChanged.connect(self._on_profile_changed)
        self.locale_combo.currentIndexChanged.connect(self._on_locale_changed)
        self.obs_scene_list.itemSelectionChanged.connect(self._on_obs_scene_selection_changed)
        self.ffmpeg_audio_preset_combo.currentTextChanged.connect(self._on_ffmpeg_preset_changed)
        
        # Sync required settings tab widgets with main widgets
        self._sync_widget_bidirectional(self.websocket_enabled_check, self.req_websocket_enabled_check)
        self._sync_widget_bidirectional(self.clipboard_enabled_check, self.req_clipboard_enabled_check)
        self._sync_widget_bidirectional(self.websocket_uri_edit, self.req_websocket_uri_edit)
        self._sync_widget_bidirectional(self.folder_to_watch_edit, self.req_folder_to_watch_edit)
        self._sync_widget_bidirectional(self.sentence_field_edit, self.req_sentence_field_edit)
        self._sync_widget_bidirectional(self.sentence_audio_field_edit, self.req_sentence_audio_field_edit)
        self._sync_widget_bidirectional(self.picture_field_edit, self.req_picture_field_edit)
        self._sync_widget_bidirectional(self.word_field_edit, self.req_word_field_edit)
        self._sync_widget_bidirectional(self.overwrite_sentence_check, self.req_overwrite_sentence_check)
        self._sync_widget_bidirectional(self.beginning_offset_edit, self.req_beginning_offset_edit)
        self._sync_widget_bidirectional(self.end_offset_edit, self.req_end_offset_edit)
        self._sync_widget_bidirectional(self.cut_and_splice_segments_check, self.req_cut_and_splice_segments_check)
        self._sync_widget_bidirectional(self.splice_padding_edit, self.req_splice_padding_edit)
        self._sync_widget_bidirectional(self.external_tool_edit, self.req_external_tool_edit)
        self._sync_widget_bidirectional(self.open_anki_edit_check, self.req_open_anki_edit_check)
        self._sync_widget_bidirectional(self.open_anki_browser_check, self.req_open_anki_browser_check)
        self._sync_widget_bidirectional(self.native_language_combo, self.req_native_language_combo)
        self._sync_widget_bidirectional(self.target_language_combo, self.req_target_language_combo)
        
        # Connect signals for animated settings visibility
        self.animated_screenshot_check.stateChanged.connect(self._update_animated_settings_visibility)
        self.video_field_edit.textChanged.connect(self._update_animated_settings_visibility)
        
        # Connect signals for Discord settings visibility
        self.discord_enabled_check.stateChanged.connect(self._update_discord_settings_visibility)
        
        # Connect signals for AI provider visibility
        self.ai_provider_combo.currentTextChanged.connect(self._update_ai_provider_visibility)
    
    def _sync_widget_bidirectional(self, main_widget, req_widget):
        """Syncs two widgets bidirectionally so changes in one update the other."""
        if isinstance(main_widget, QLineEdit):
            main_widget.textChanged.connect(lambda text: req_widget.setText(text) if req_widget.text() != text else None)
            req_widget.textChanged.connect(lambda text: main_widget.setText(text) if main_widget.text() != text else None)
        elif isinstance(main_widget, QCheckBox):
            main_widget.stateChanged.connect(lambda state: req_widget.setChecked(main_widget.isChecked()) if req_widget.isChecked() != main_widget.isChecked() else None)
            req_widget.stateChanged.connect(lambda state: main_widget.setChecked(req_widget.isChecked()) if main_widget.isChecked() != req_widget.isChecked() else None)
        elif isinstance(main_widget, QComboBox):
            main_widget.currentTextChanged.connect(lambda text: req_widget.setCurrentText(text) if req_widget.currentText() != text else None)
            req_widget.currentTextChanged.connect(lambda text: main_widget.setCurrentText(text) if main_widget.currentText() != text else None)
    
    def _update_animated_settings_visibility(self):
        """Shows/hides animated screenshot settings based on animated checkbox or video field."""
        should_show = self.animated_screenshot_check.isChecked() or bool(self.video_field_edit.text().strip())
        self.animated_settings_group.setVisible(should_show)
    
    def _update_discord_settings_visibility(self):
        """Shows/hides Discord settings based on enabled checkbox."""
        self.discord_settings_container.setVisible(self.discord_enabled_check.isChecked())

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
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'native_language'), self.req_native_language_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'target_language', color=LabelColor.IMPORTANT, bold=True), self.req_target_language_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'paths', 'folder_to_watch'), self._create_browse_widget(self.req_folder_to_watch_edit, QFileDialog.FileMode.Directory))
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'sentence_field'), self.req_sentence_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'sentence_audio_field'), self.req_sentence_audio_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'picture_field'), self.req_picture_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'word_field'), self.req_word_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'overwrite_sentence'), self.req_overwrite_sentence_check)
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
        
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'websocket_enabled', color=LabelColor.IMPORTANT, bold=True), self.websocket_enabled_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'clipboard_enabled', color=LabelColor.IMPORTANT, bold=True), self.clipboard_enabled_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'allow_both_simultaneously', color=LabelColor.ADVANCED, bold=True), self.use_both_clipboard_and_websocket_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'merge_sequential_text', color=LabelColor.ADVANCED, bold=True), self.merge_matching_sequential_text_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'websocket_uri'), self.websocket_uri_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'texthook_regex'), self.texthook_replacement_regex_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'open_config_on_startup'), self.open_config_on_startup_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'open_texthooker_on_startup'), self.open_multimine_on_startup_check)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'texthooker_port'), self.texthooker_port_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'plaintext_export_port'), self.plaintext_websocket_export_port_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'general', 'native_language'), self.native_language_combo)
        layout.addRow(self._create_labeled_widget(i18n, 'features', 'notify_on_update'), self.notify_on_update_check)
        
        # Discord Settings Group
        self.discord_settings_group.setTitle("Discord Rich Presence")
        self.discord_settings_group.setStyleSheet("""
            QGroupBox {
                font-weight: bold;
                border: 2px solid #555;
                border-radius: 5px;
                margin-top: 10px;
                padding-top: 10px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px 0 5px;
            }
        """)
        
        discord_layout = QFormLayout()
        
        enabled_label = QLabel("Enabled:")
        enabled_label.setToolTip("Enable or disable Discord Rich Presence")
        discord_layout.addRow(enabled_label, self.discord_enabled_check)
        
        # Container for settings that should hide when disabled
        self.discord_settings_container = QWidget()
        discord_settings_layout = QFormLayout(self.discord_settings_container)
        discord_settings_layout.setContentsMargins(0, 5, 0, 0)
        
        # interval_label = QLabel("Update Interval (seconds):")
        # interval_label.setToolTip("How often to update Discord status (15-300 seconds)")
        # discord_settings_layout.addRow(interval_label, self.discord_update_interval_spin)

        inactivity_label = QLabel("Inactivity Timer (seconds):")
        inactivity_label.setToolTip("How many seconds of inactivity before Discord Rich Presence stops (120-900)")
        discord_settings_layout.addRow(inactivity_label, self.discord_inactivity_spin)
        
        icon_label = QLabel("Icon:")
        icon_label.setToolTip("Choose which GSM icon to display on Discord")
        discord_settings_layout.addRow(icon_label, self.discord_icon_combo)
        
        stats_label = QLabel("Show Stats:")
        stats_label.setToolTip("Choose which reading statistics to display on Discord")
        discord_settings_layout.addRow(stats_label, self.discord_show_stats_combo)
        
        # Blacklisted scenes with refresh button - styled container, but NO background color set to avoid theme issues
        self.discord_blacklisted_scenes_list.setSelectionMode(QAbstractItemView.SelectionMode.MultiSelection)
        self.discord_blacklisted_scenes_list.setMaximumHeight(150)
        self.discord_blacklisted_scenes_list.setToolTip("Select OBS scenes where Discord RPC should be disabled")
        try:
            self.discord_blacklisted_scenes_list.setAlternatingRowColors(True)
        except Exception:
            pass
        # Keep neutral styling for background; only set border/padding and item spacing
        self.discord_blacklisted_scenes_list.setStyleSheet("""
            QListWidget {
                border: 1px solid #333;
                border-radius: 6px;
                padding: 4px;
                alternate-background-color: transparent;
                color: #e6e6e6;
            }
            QListWidget::item {
                padding: 6px 8px;
            }
            QListWidget::item:selected {
                background: #265a88;
                color: white;
            }
        """)

        blacklist_container = QWidget()
        # Remove the padding that was pushing the list down
        blacklist_container.setStyleSheet("""
            QWidget { padding: 0px; }
        """)
        blacklist_layout = QHBoxLayout(blacklist_container)
        blacklist_layout.setContentsMargins(0,0,0,0)
        blacklist_layout.setSpacing(6)
        blacklist_layout.addWidget(self.discord_blacklisted_scenes_list)
        discord_refresh_button = QPushButton(i18n.get('profiles', {}).get('refresh_scenes_button', 'Refresh'))
        discord_refresh_button.setToolTip("Refresh the list of available OBS scenes")
        discord_refresh_button.clicked.connect(self.refresh_obs_scenes)
        # Align the refresh button to the top so it doesn't stretch to the full height
        blacklist_layout.addWidget(discord_refresh_button, 0, Qt.AlignmentFlag.AlignCenter)

        blacklist_label = QLabel("Blacklisted Scenes:")
        blacklist_label.setToolTip("OBS scenes where Discord RPC will be disabled (e.g., private/sensitive content)")
        discord_settings_layout.addRow(blacklist_label, blacklist_container)
        
        discord_layout.addRow(self.discord_settings_container)
        
        self.discord_settings_group.setLayout(discord_layout)
        layout.addRow(self.discord_settings_group)
        
        # Update visibility based on enabled checkbox
        self._update_discord_settings_visibility()

        if is_beangate:
            test_button = QPushButton(self.i18n.get('buttons', {}).get('run_function', 'Run Function'))
            test_button.clicked.connect(lambda: self.test_func() if self.test_func else None)
            layout.addRow(test_button)
        
        # Add stretch to push reset button to bottom
        layout.addItem(QVBoxLayout().addStretch())
        
        # Add reset button at the bottom
        reset_widget = self._create_reset_button("general", self._create_general_tab)
        layout.addRow(reset_widget)
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
        
        reset_widget = self._create_reset_button("paths", self._create_paths_tab)
        layout.addRow(reset_widget)
        return widget

    def _create_anki_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'enabled', color=LabelColor.RECOMMENDED, bold=True), self.anki_enabled_check)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'update_anki'), self.update_anki_check)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'show_update_confirmation_dialog'), self.show_update_confirmation_dialog_check)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'auto_accept_timer', "Accept The Result without user input after # of seconds, 0 disables this feature"), self.auto_accept_timer_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'anki', 'url'), self.anki_url_edit)
        
        # Field Mappings Group
        fields_group = self._create_group_box("Field Mappings")
        fields_layout = QFormLayout()
        fields_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'sentence_field', color=LabelColor.ADVANCED, bold=True), self.sentence_field_edit)
        fields_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'sentence_audio_field', color=LabelColor.IMPORTANT, bold=True), self.sentence_audio_field_edit)
        fields_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'picture_field', color=LabelColor.IMPORTANT, bold=True), self.picture_field_edit)
        fields_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'word_field', color=LabelColor.IMPORTANT, bold=True), self.word_field_edit)
        fields_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'previous_sentence_field'), self.previous_sentence_field_edit)
        fields_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'previous_image_field'), self.previous_image_field_edit)
        fields_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'video_field', color=LabelColor.ADVANCED), self.video_field_edit)
        fields_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'sentence_furigana_field'), self.sentence_furigana_field_edit)
        fields_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'game_name_field'), self.game_name_field_edit)
        fields_group.setLayout(fields_layout)
        layout.addRow(fields_group)
        
        # Tagging Settings Group
        tags_group = self._create_group_box("Tag Settings")
        tags_layout = QFormLayout()
        tags_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'custom_tags', color=LabelColor.RECOMMENDED, bold=True), self.custom_tags_edit)
        tags_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'tags_to_check'), self.tags_to_check_edit)
        tags_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'add_game_tag', color=LabelColor.RECOMMENDED, bold=True), self.add_game_tag_check)
        tags_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'parent_tag', color=LabelColor.RECOMMENDED, bold=True), self.parent_tag_edit)
        tags_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'tag_unvoiced_cards'), self.tag_unvoiced_cards_check)
        tags_group.setLayout(tags_layout)
        layout.addRow(tags_group)
        
        # Overwrite Settings Group
        overwrite_group = self._create_group_box("Overwrite Settings")
        overwrite_layout = QFormLayout()
        overwrite_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'overwrite_audio'), self.overwrite_audio_check)
        overwrite_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'overwrite_picture'), self.overwrite_picture_check)
        overwrite_layout.addRow(self._create_labeled_widget(i18n, 'anki', 'overwrite_sentence'), self.overwrite_sentence_check)
        overwrite_group.setLayout(overwrite_layout)
        layout.addRow(overwrite_group)
        
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'multiline_linebreak'), self.multi_line_line_break_edit)

        reset_widget = self._create_reset_button("anki", self._create_anki_tab)
        layout.addRow(reset_widget)
        return widget

    def _create_vad_tab(self):
        widget = QWidget()
        layout = QFormLayout(widget)
        layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        i18n = self.i18n.get('tabs', {})

        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'do_postprocessing'), self.do_vad_postprocessing_check)
        
        # Model Selection Group
        models_group = self._create_group_box("VAD Models")
        models_layout = QFormLayout()
        models_layout.addRow(self._create_labeled_widget(i18n, 'vad', 'whisper_model'), self.whisper_model_combo)
        models_layout.addRow(self._create_labeled_widget(i18n, 'vad', 'selected_model'), self.selected_vad_model_combo)
        models_layout.addRow(self._create_labeled_widget(i18n, 'vad', 'backup_model'), self.backup_vad_model_combo)
        models_layout.addRow(self._create_labeled_widget(i18n, 'vad', 'use_cpu_for_inference'), self.use_cpu_for_inference_check)
        models_layout.addRow(self._create_labeled_widget(i18n, 'vad', 'use_vad_filter_for_whisper'), self.use_vad_filter_for_whisper_check)
        models_group.setLayout(models_layout)
        layout.addRow(models_group)
        
        # Audio Trimming & Splicing Group
        trimming_group = self._create_group_box("Audio Trimming")
        trimming_layout = QFormLayout()
        trimming_layout.addRow(self._create_labeled_widget(i18n, 'vad', 'audio_end_offset', color=LabelColor.IMPORTANT, bold=True), self.end_offset_edit)
        
        trim_begin_widget = QWidget()
        trim_begin_layout = QHBoxLayout(trim_begin_widget)
        trim_begin_layout.setContentsMargins(0,0,0,0)
        trim_begin_layout.addWidget(self.vad_trim_beginning_check)
        trim_begin_layout.addWidget(self._create_labeled_widget(i18n, 'vad', 'beginning_offset'))
        trim_begin_layout.addWidget(self.vad_beginning_offset_edit)
        trim_begin_layout.addStretch()
        trimming_layout.addRow(self._create_labeled_widget(i18n, 'vad', 'trim_beginning'), trim_begin_widget)

        splice_widget = QWidget()
        splice_layout = QHBoxLayout(splice_widget)
        splice_layout.setContentsMargins(0,0,0,0)
        splice_layout.addWidget(self.cut_and_splice_segments_check)
        splice_layout.addWidget(self._create_labeled_widget(i18n, 'vad', 'splice_padding'))
        splice_layout.addWidget(self.splice_padding_edit)
        splice_layout.addStretch()
        trimming_layout.addRow(self._create_labeled_widget(i18n, 'vad', 'cut_and_splice'), splice_widget)
        
        trimming_group.setLayout(trimming_layout)
        layout.addRow(trimming_group)
        
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'add_on_no_results'), self.add_audio_on_no_results_check)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'use_tts_as_fallback'), self.use_tts_as_fallback_check)
        layout.addRow(self._create_labeled_widget(i18n, 'vad', 'tts_url'), self.tts_url_edit)
        
        reset_widget = self._create_reset_button("vad", self._create_vad_tab)
        layout.addRow(reset_widget)
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
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'offset', color=LabelColor.IMPORTANT), self.seconds_after_line_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'use_selector'), self.use_screenshot_selector_check)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'hotkey'), self.take_screenshot_hotkey_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'hotkey_updates_anki'), self.screenshot_hotkey_update_anki_check)
        layout.addRow(self._create_labeled_widget(i18n, 'screenshot', 'trim_black_bars', color=LabelColor.RECOMMENDED), self.trim_black_bars_check)
        
        # Animated Screenshot Settings Group
        self.animated_settings_group.setTitle("Animated Screenshot Settings")
        self.animated_settings_group.setStyleSheet("""
            QGroupBox {
                font-weight: bold;
                border: 2px solid #555;
                border-radius: 5px;
                margin-top: 10px;
                padding-top: 10px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px 0 5px;
            }
        """)
        
        animated_layout = QFormLayout()
        animated_layout.addRow(QLabel("FPS (10-30):"), self.animated_fps_spin)
        # animated_layout.addRow(QLabel("Extension:"), self.animated_extension_combo)
        animated_layout.addRow(QLabel("Quality (0-10):"), self.animated_quality_spin)
        self.animated_settings_group.setLayout(animated_layout)
        
        layout.addRow(self.animated_settings_group)
        
        # Update visibility based on animated checkbox and video field
        self._update_animated_settings_visibility()

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
        # find_offset_button = QPushButton(i18n.get('audio', {}).get('find_offset_button', 'Find Offset (WIP)'))
        # find_offset_button.clicked.connect(self.call_audio_offset_selector)
        # offset_layout.addWidget(find_offset_button)
        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'beginning_offset', color=LabelColor.IMPORTANT, bold=True), offset_widget)

        layout.addRow(self._create_labeled_widget(i18n, 'audio', 'end_offset', color=LabelColor.IMPORTANT, bold=True), self.pre_vad_audio_offset_edit)
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
        
        # Connection Settings Group
        connection_group = self._create_group_box("OBS WebSocket Connection")
        connection_layout = QFormLayout()
        connection_layout.addRow(self._create_labeled_widget(i18n, 'obs', 'host'), self.obs_host_edit)
        connection_layout.addRow(self._create_labeled_widget(i18n, 'obs', 'port'), self.obs_port_edit)
        connection_layout.addRow(self._create_labeled_widget(i18n, 'obs', 'password'), self.obs_password_edit)
        connection_group.setLayout(connection_layout)
        layout.addRow(connection_group)
        
        self.obs_password_edit.setEchoMode(QLineEdit.EchoMode.Password)
        layout.addRow(self._create_labeled_widget(i18n, 'obs', 'min_replay_size'), self.obs_minimum_replay_size_edit)
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
        
        # Gemini Settings Group
        self.gemini_settings_group.setTitle("Google Gemini Settings")
        self.gemini_settings_group.setStyleSheet(self._get_group_box_style())
        gemini_layout = QFormLayout()
        
        # Gemini model combo with refresh button
        gemini_model_widget = QWidget()
        gemini_model_layout = QHBoxLayout(gemini_model_widget)
        gemini_model_layout.setContentsMargins(0, 0, 0, 0)
        gemini_model_layout.addWidget(self.gemini_model_combo)
        gemini_refresh_button = QPushButton("🔄")
        gemini_refresh_button.setToolTip("Refresh Gemini models")
        gemini_refresh_button.setMaximumWidth(40)
        gemini_refresh_button.clicked.connect(lambda: self.refresh_ai_models('gemini'))
        gemini_model_layout.addWidget(gemini_refresh_button)
        
        gemini_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'gemini_model'), gemini_model_widget)
        gemini_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'gemini_api_key'), self.gemini_api_key_edit)
        self.gemini_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.gemini_settings_group.setLayout(gemini_layout)
        layout.addRow(self.gemini_settings_group)
        
        # Groq Settings Group
        self.groq_settings_group.setTitle("Groq Settings")
        self.groq_settings_group.setStyleSheet(self._get_group_box_style())
        groq_layout = QFormLayout()
        
        # Groq model combo with refresh button
        groq_model_widget = QWidget()
        groq_model_layout = QHBoxLayout(groq_model_widget)
        groq_model_layout.setContentsMargins(0, 0, 0, 0)
        groq_model_layout.addWidget(self.groq_model_combo)
        groq_refresh_button = QPushButton("🔄")
        groq_refresh_button.setToolTip("Refresh Groq models")
        groq_refresh_button.setMaximumWidth(40)
        groq_refresh_button.clicked.connect(lambda: self.refresh_ai_models('groq'))
        groq_model_layout.addWidget(groq_refresh_button)
        
        groq_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'groq_model'), groq_model_widget)
        groq_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'groq_api_key'), self.groq_api_key_edit)
        self.groq_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.groq_settings_group.setLayout(groq_layout)
        layout.addRow(self.groq_settings_group)
        
        # OpenAI Settings Group
        self.openai_settings_group.setTitle("OpenAI-Compatible API Settings")
        self.openai_settings_group.setStyleSheet(self._get_group_box_style())
        openai_layout = QFormLayout()
        openai_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'openai_url'), self.open_ai_url_edit)
        
        # OpenAI model edit with refresh button (note: OpenAI uses QLineEdit, not QComboBox)
        openai_model_widget = QWidget()
        openai_model_layout = QHBoxLayout(openai_model_widget)
        openai_model_layout.setContentsMargins(0, 0, 0, 0)
        openai_model_layout.addWidget(self.open_ai_model_edit)
        openai_refresh_button = QPushButton("🔄")
        openai_refresh_button.setToolTip("Refresh OpenAI models")
        openai_refresh_button.setMaximumWidth(40)
        openai_refresh_button.clicked.connect(lambda: self.refresh_ai_models('openai'))
        openai_model_layout.addWidget(openai_refresh_button)
        
        openai_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'openai_model'), openai_model_widget)
        openai_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'openai_apikey'), self.open_ai_api_key_edit)
        self.open_ai_api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.openai_settings_group.setLayout(openai_layout)
        layout.addRow(self.openai_settings_group)
        
        # Ollama Settings Group
        self.ollama_settings_group.setTitle("Ollama Settings")
        self.ollama_settings_group.setStyleSheet(self._get_group_box_style())
        ollama_layout = QFormLayout()
        ollama_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'ollama_url', 'The URL of your Ollama server'), self.ollama_url_edit)
        
        # Ollama model combo with refresh button
        ollama_model_widget = QWidget()
        ollama_model_layout = QHBoxLayout(ollama_model_widget)
        ollama_model_layout.setContentsMargins(0, 0, 0, 0)
        ollama_model_layout.addWidget(self.ollama_model_combo)
        ollama_refresh_button = QPushButton("🔄")
        ollama_refresh_button.setToolTip("Refresh Ollama models")
        ollama_refresh_button.setMaximumWidth(40)
        ollama_refresh_button.clicked.connect(lambda: self.refresh_ai_models('ollama'))
        ollama_model_layout.addWidget(ollama_refresh_button)
        
        ollama_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'ollama_model', 'The model name to use in Ollama'), ollama_model_widget)
        self.ollama_settings_group.setLayout(ollama_layout)
        layout.addRow(self.ollama_settings_group)
        
        # LM Studio Settings Group
        self.lm_studio_settings_group.setTitle("LM Studio Settings")
        self.lm_studio_settings_group.setStyleSheet(self._get_group_box_style())
        lm_studio_layout = QFormLayout()
        lm_studio_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'lm_studio_url', 'The URL of your LM Studio server'), self.lm_studio_url_edit)
        
        # LM Studio model combo with refresh button
        lm_studio_model_widget = QWidget()
        lm_studio_model_layout = QHBoxLayout(lm_studio_model_widget)
        lm_studio_model_layout.setContentsMargins(0, 0, 0, 0)
        lm_studio_model_layout.addWidget(self.lm_studio_model_combo)
        lm_studio_refresh_button = QPushButton("🔄")
        lm_studio_refresh_button.setToolTip("Refresh LM Studio models")
        lm_studio_refresh_button.setMaximumWidth(40)
        lm_studio_refresh_button.clicked.connect(lambda: self.refresh_ai_models('lm_studio'))
        lm_studio_model_layout.addWidget(lm_studio_refresh_button)
        
        lm_studio_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'lm_studio_model', 'The model name to use in LM Studio'), lm_studio_model_widget)
        lm_studio_layout.addRow(self._create_labeled_widget(i18n, 'ai', 'lm_studio_api_key', 'API Key (usually "lm-studio")'), self.lm_studio_api_key_edit)
        self.lm_studio_settings_group.setLayout(lm_studio_layout)
        layout.addRow(self.lm_studio_settings_group)
        
        # Common AI Settings
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'anki_field'), self.ai_anki_field_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'context_length', color=LabelColor.ADVANCED), self.ai_dialogue_context_length_edit)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'use_canned_translation'), self.use_canned_translation_prompt_check)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'use_canned_context'), self.use_canned_context_prompt_check)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'custom_prompt'), self.custom_prompt_textedit)
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'custom_texthooker_prompt'), self.custom_texthooker_prompt_textedit)
        
        # Custom Full Prompt Widget
        custom_full_prompt_widget = QWidget()
        cfp_layout = QVBoxLayout(custom_full_prompt_widget)
        cfp_layout.setContentsMargins(0,0,0,0)
        
        # 1. Always visible keys
        keys_label = QLabel("Available Keys: {game_title}, {character_context}, {dialogue_context}, {prompt_to_use}, {sentence}")
        keys_label.setWordWrap(True)
        keys_label.setStyleSheet("color: #888;")
        cfp_layout.addWidget(keys_label)
        
        # The Text Edit
        cfp_layout.addWidget(self.custom_full_prompt_textedit)
        
        # 2. Button for Dialog
        help_btn = QPushButton("Prompt Helper")
        help_btn.clicked.connect(self.show_prompt_help_dialog)
        cfp_layout.addWidget(help_btn)
        
        layout.addRow(self._create_labeled_widget(i18n, 'ai', 'custom_full_prompt', default_tooltip='Optional: Overrides the entire prompt template. Use placeholders like {sentence}.'), custom_full_prompt_widget)
        
        # Update visibility based on provider selection
        self._update_ai_provider_visibility()

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
        # layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'scan_delay'), self.scan_delay_edit)
        layout.addRow(self._create_labeled_widget(i18n, "overlay", 'manual_overlay_scan_hotkey',), self.manual_overlay_scan_hotkey_edit)
        
        # Send overlay to texthooker on hotkey warning section
        texthooker_widget = QWidget()
        texthooker_layout = QHBoxLayout(texthooker_widget)
        texthooker_layout.setContentsMargins(0, 0, 0, 0)
        texthooker_layout.addWidget(self.add_overlay_to_texthooker_check)
        texthooker_label = QLabel("Send Overlay Lines to Texthooker on Hotkey")
        texthooker_label.setStyleSheet("color: #FF0000; font-weight: bold;")
        texthooker_label.setToolTip("⚠️ WARNING: When you use the manual overlay scan hotkey, any new lines found will be sent to the texthooker stream. Only enable if you understand the implications.")
        texthooker_layout.addWidget(texthooker_label)
        texthooker_layout.addStretch()
        layout.addRow(texthooker_widget)
        periodic_group = self._create_group_box("Periodic Scanning")
        periodic_layout = QFormLayout()
        periodic_layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'periodic'), self.periodic_check)
        periodic_layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'periodic_interval'), self.periodic_interval_edit)
        periodic_layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'periodic_ratio'), self.periodic_ratio_edit)
        # periodic_layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'number_of_local_scans_per_event'), self.number_of_local_scans_per_event_edit)
        periodic_group.setLayout(periodic_layout)
        layout.addRow(periodic_group)

        min_char_widget = QWidget()
        min_char_layout = QHBoxLayout(min_char_widget)
        min_char_layout.setContentsMargins(0,0,0,0)
        min_char_layout.addWidget(self.overlay_minimum_character_size_edit)
        find_size_button = QPushButton(i18n.get('overlay', {}).get('minimum_character_size_finder_button', 'Find Size'))
        find_size_button.clicked.connect(self.open_minimum_character_size_selector)
        min_char_layout.addWidget(find_size_button)
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'minimum_character_size'), min_char_widget)
        
        layout.addRow(self._create_labeled_widget(i18n, 'overlay', 'use_ocr_area_config'), self.use_ocr_area_config_check)
        
        # Area Selection Button
        # select_area_button = QPushButton(i18n.get('overlay', {}).get('select_area_button', 'Select Area for Current Scene'))
        # select_area_button.clicked.connect(self.open_monitor_area_selector)
        # layout.addRow(select_area_button)
        
        reset_widget = self._create_reset_button("overlay", self._create_overlay_tab)
        layout.addRow(reset_widget)
        # Debug checkbox: Use full-screen mss for OCR instead of OBS
        try:
            self.ocr_full_screen_instead_of_obs_checkbox = QCheckBox(self.i18n.get('overlay', {}).get('ocr_full_screen_instead_of_obs', 'Use old overlay capture method (debug)'))
        except Exception:
            self.ocr_full_screen_instead_of_obs_checkbox = QCheckBox('Use old overlay capture method (debug)')
        self.ocr_full_screen_instead_of_obs_checkbox.setStyleSheet('color: #FF0000;')
        try:
            self.ocr_full_screen_instead_of_obs_checkbox.setToolTip(self.i18n.get('overlay', {}).get('ocr_full_screen_instead_of_obs_tooltip', 'Use old overlay capture method instead of OBS. Debug only.'))
        except Exception:
            pass
        layout.addRow(self.ocr_full_screen_instead_of_obs_checkbox)
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
        layout.addRow(QLabel("Longest Sleep Time (s)"), self.longest_sleep_time_edit)
        
        # Disable local stats option with warning
        dont_collect_stats_label = self._create_labeled_widget(i18n, 'advanced', 'dont_collect_stats', color=LabelColor.ADVANCED)
        dont_collect_stats_container = QHBoxLayout()
        dont_collect_stats_container.addWidget(self.dont_collect_stats_check)
        dont_collect_stats_warning = QLabel("⚠️ Stats are ONLY local no matter what. Disabling may break features!")
        dont_collect_stats_warning.setStyleSheet("color: #FF6B6B; font-size: 10px;")
        dont_collect_stats_container.addWidget(dont_collect_stats_warning)
        dont_collect_stats_container.addStretch()
        layout.addRow(dont_collect_stats_label, dont_collect_stats_container)
        
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'current_version'), self.current_version_label)
        layout.addRow(self._create_labeled_widget(i18n, 'advanced', 'latest_version'), self.latest_version_label)

        reset_widget = self._create_reset_button("advanced", self._create_advanced_tab)
        layout.addRow(reset_widget)
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

        # Styled container for OBS scene list and refresh button
        scene_container = QWidget()
        scene_container.setStyleSheet("""
            QWidget {
                border: 1px solid #333;
                border-radius: 6px;
                padding: 6px;
            }
        """)
        scene_layout = QHBoxLayout(scene_container)
        scene_layout.setContentsMargins(6,6,6,6)
        scene_layout.setSpacing(8)
        self.obs_scene_list.setSelectionMode(QAbstractItemView.SelectionMode.MultiSelection)
        scene_layout.addWidget(self.obs_scene_list)
        refresh_button = QPushButton(i18n.get('profiles', {}).get('refresh_scenes_button', 'Refresh'))
        refresh_button.clicked.connect(self.refresh_obs_scenes)
        scene_layout.addWidget(refresh_button)
        layout.addRow(self._create_labeled_widget(i18n, 'profiles', 'obs_scene'), scene_container)

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
        self.target_language_combo.clear()
        self.target_language_combo.addItems(CommonLanguages.get_all_names_pretty())
        self.target_language_combo.setCurrentText(CommonLanguages.from_code(s.general.target_language).name.replace('_', ' ').title() if s.general.target_language else 'Japanese')

        self.locale_combo.blockSignals(True)
        self.locale_combo.clear()
        self.locale_combo.addItems([e.name for e in Locale])
        self.locale_combo.setCurrentText(self.master_config.get_locale().name)
        self.locale_combo.blockSignals(False)
        
        self.notify_on_update_check.setChecked(s.features.notify_on_update)
        
        # Discord Settings
        self.discord_enabled_check.setChecked(self.master_config.discord.enabled)
        # self.discord_update_interval_spin.setValue(self.master_config.discord.update_interval)
        # Load inactivity timer and clamp to allowed range
        try:
            inactivity_val = int(getattr(self.master_config.discord, 'inactivity_timer', 300))
        except Exception:
            inactivity_val = 300
        inactivity_val = max(120, min(900, inactivity_val))
        self.discord_inactivity_spin.setValue(inactivity_val)
        self.discord_icon_combo.clear()
        self.discord_icon_combo.addItems(['GSM', 'Cute', 'Jacked', 'Cursed'])
        self.discord_icon_combo.setCurrentText(self.master_config.discord.icon)
        self.discord_show_stats_combo.clear()
        self.discord_show_stats_combo.addItems(['None', 'Characters per Hour', 'Total Characters', 'Cards Mined', 'Active Reading Time'])
        self.discord_show_stats_combo.setCurrentText(self.master_config.discord.show_reading_stats)
        # Discord blacklisted scenes will be populated by refresh_obs_scenes
        
        # Update visibility of Discord settings
        self._update_discord_settings_visibility()
        
        # Paths
        self.folder_to_watch_edit.setText(s.paths.folder_to_watch)
        self.output_folder_edit.setText(s.paths.output_folder)
        self.copy_temp_files_to_output_folder_check.setChecked(s.paths.copy_temp_files_to_output_folder)
        self.open_output_folder_on_card_creation_check.setChecked(s.paths.open_output_folder_on_card_creation)
        self.copy_trimmed_replay_to_output_folder_check.setChecked(s.paths.copy_trimmed_replay_to_output_folder)
        self.remove_video_check.setChecked(s.paths.remove_video)
        
        # Anki
        self.anki_enabled_check.setChecked(s.anki.enabled)
        self.update_anki_check.setChecked(s.anki.update_anki)
        self.show_update_confirmation_dialog_check.setChecked(s.anki.show_update_confirmation_dialog_v2)
        self.auto_accept_timer_edit.setText(str(s.anki.auto_accept_timer))
        self.anki_url_edit.setText(s.anki.url)
        self.sentence_field_edit.setText(s.anki.sentence_field)
        self.sentence_audio_field_edit.setText(s.anki.sentence_audio_field)
        self.picture_field_edit.setText(s.anki.picture_field)
        self.word_field_edit.setText(s.anki.word_field)
        self.previous_sentence_field_edit.setText(s.anki.previous_sentence_field)
        self.previous_image_field_edit.setText(s.anki.previous_image_field)
        self.game_name_field_edit.setText(s.anki.game_name_field)
        self.video_field_edit.setText(s.anki.video_field)
        self.sentence_furigana_field_edit.setText(s.anki.sentence_furigana_field)
        self.custom_tags_edit.setText(', '.join(s.anki.custom_tags))
        self.tags_to_check_edit.setText(', '.join(s.anki.tags_to_check))
        self.add_game_tag_check.setChecked(s.anki.add_game_tag)
        self.parent_tag_edit.setText(s.anki.parent_tag)
        self.overwrite_audio_check.setChecked(s.anki.overwrite_audio)
        self.overwrite_picture_check.setChecked(s.anki.overwrite_picture)
        self.overwrite_sentence_check.setChecked(s.anki.overwrite_sentence)
        self.tag_unvoiced_cards_check.setChecked(s.anki.tag_unvoiced_cards)
        
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
        self.take_screenshot_hotkey_edit.setKeySequence(QKeySequence(s.hotkeys.take_screenshot or ""))
        self.screenshot_hotkey_update_anki_check.setChecked(s.screenshot.screenshot_hotkey_updates_anki)
        self.trim_black_bars_check.setChecked(s.screenshot.trim_black_bars_wip)
        
        # Animated Screenshot Settings
        self.animated_fps_spin.setValue(max(10, min(30, s.screenshot.animated_settings.fps)))
        # self.animated_extension_combo.clear()
        # self.animated_extension_combo.addItems(['avif'])
        # self.animated_extension_combo.setCurrentText(s.screenshot.animated_settings.extension)
        self.animated_quality_spin.setValue(max(0, min(10, s.screenshot.animated_settings.quality)))
        
        # Update visibility of animated settings
        self._update_animated_settings_visibility()
        
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
        self.ai_provider_combo.addItems([AI_GEMINI, AI_GROQ, AI_OPENAI, AI_OLLAMA, AI_LM_STUDIO])
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
        self.ollama_url_edit.setText(s.ai.ollama_url)
        self.ollama_model_combo.setCurrentText(s.ai.ollama_model)
        self.lm_studio_url_edit.setText(s.ai.lm_studio_url)
        self.lm_studio_model_combo.setCurrentText(s.ai.lm_studio_model)
        self.lm_studio_api_key_edit.setText(s.ai.lm_studio_api_key)
        self.ai_anki_field_edit.setText(s.ai.anki_field)
        self.ai_dialogue_context_length_edit.setText(str(s.ai.dialogue_context_length))
        self.use_canned_translation_prompt_check.setChecked(s.ai.use_canned_translation_prompt)
        self.use_canned_context_prompt_check.setChecked(s.ai.use_canned_context_prompt)
        self.custom_prompt_textedit.setPlainText(s.ai.custom_prompt)
        self.custom_texthooker_prompt_textedit.setPlainText(s.ai.custom_texthooker_prompt)
        self.custom_full_prompt_textedit.setPlainText(s.ai.custom_full_prompt)
        self.get_online_models()
        # Update AI provider group visibility based on loaded provider
        self._update_ai_provider_visibility()
        
        # Overlay
        self.overlay_websocket_port_edit.setText(str(s.overlay.websocket_port))
        self._load_monitors()
        self.overlay_engine_combo.clear()
        self.overlay_engine_combo.addItems([e.value for e in OverlayEngine])
        self.overlay_engine_combo.setCurrentText(s.overlay.engine_v2)
        # self.scan_delay_edit.setText(str(s.overlay.scan_delay))
        self.periodic_check.setChecked(s.overlay.periodic)
        self.periodic_interval_edit.setText(str(s.overlay.periodic_interval))
        self.periodic_ratio_edit.setText(str(s.overlay.periodic_ratio))
        self.add_overlay_to_texthooker_check.setChecked(s.overlay.send_hotkey_text_to_texthooker)
        # self.number_of_local_scans_per_event_edit.setText(str(s.overlay.number_of_local_scans_per_event))
        self.overlay_minimum_character_size_edit.setText(str(s.overlay.minimum_character_size))
        self.manual_overlay_scan_hotkey_edit.setKeySequence(QKeySequence(s.hotkeys.manual_overlay_scan or ""))
        self.use_ocr_area_config_check.setChecked(s.overlay.use_ocr_area_config)
        # Load debug option for using full-screen mss instead of OBS
        try:
            if hasattr(self, 'ocr_full_screen_instead_of_obs_checkbox'):
                self.ocr_full_screen_instead_of_obs_checkbox.setChecked(bool(s.overlay.ocr_full_screen_instead_of_obs))
        except Exception:
            pass
        
        # Advanced
        self.audio_player_path_edit.setText(s.advanced.audio_player_path)
        self.video_player_path_edit.setText(s.advanced.video_player_path)
        self.play_latest_audio_hotkey_edit.setKeySequence(QKeySequence(s.hotkeys.play_latest_audio or ""))
        self.multi_line_line_break_edit.setText(s.advanced.multi_line_line_break)
        self.multi_line_sentence_storage_field_edit.setText(s.advanced.multi_line_sentence_storage_field)
        self.ocr_websocket_port_edit.setText(str(s.advanced.ocr_websocket_port))
        self.texthooker_communication_websocket_port_edit.setText(str(s.advanced.texthooker_communication_websocket_port))
        self.plaintext_websocket_export_port_edit.setText(str(s.advanced.plaintext_websocket_port))
        self.reset_line_hotkey_edit.setKeySequence(QKeySequence(s.hotkeys.reset_line or ""))
        self.polling_rate_edit.setText(str(s.anki.polling_rate_v2))
        self.localhost_bind_address_edit.setText(s.advanced.localhost_bind_address)
        self.longest_sleep_time_edit.setText(str(s.advanced.longest_sleep_time))
        self.dont_collect_stats_check.setChecked(s.advanced.dont_collect_stats)
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
        self.req_native_language_combo.clear()
        self.req_native_language_combo.addItems(CommonLanguages.get_all_names_pretty())
        self.req_native_language_combo.setCurrentText(CommonLanguages.from_code(s.general.native_language).name.replace('_', ' ').title() if s.general.native_language else 'English')
        self.req_target_language_combo.clear()
        self.req_target_language_combo.addItems(CommonLanguages.get_all_names_pretty())
        self.req_target_language_combo.setCurrentText(CommonLanguages.from_code(s.general.target_language).name.replace('_', ' ').title() if s.general.target_language else 'Japanese')
        self.req_sentence_field_edit.setText(s.anki.sentence_field)
        self.req_sentence_audio_field_edit.setText(s.anki.sentence_audio_field)
        self.req_picture_field_edit.setText(s.anki.picture_field)
        self.req_word_field_edit.setText(s.anki.word_field)
        self.req_overwrite_sentence_check.setChecked(s.anki.overwrite_sentence)
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

    def _on_ffmpeg_preset_changed(self, preset_name):
        """Updates the FFmpeg options line edit when the preset combo box changes."""
        if preset_name in self.ffmpeg_preset_map:
            self.audio_ffmpeg_reencode_options_edit.setText(self.ffmpeg_preset_map[preset_name])

    def check_obs_errors(self):
        try:
            errors = obs.get_queued_gui_errors()
            for title, message, recheck_func in errors:
                if recheck_func and recheck_func():
                    continue
                # Wrap message box to ensure it doesn't crash on shutdown
                if self.isVisible():
                    QMessageBox.critical(self, title, message)
        except Exception as e:
            logger.debug(f"Error checking OBS error queue: {e}")

    def _create_labeled_widget(self, i18n_dict, key1, key2=None, default_tooltip='...', color=LabelColor.DEFAULT, bold=False):
        """Helper to create a QLabel with text and tooltip from the i18n dict.
        
        Args:
            i18n_dict: The i18n dictionary containing label/tooltip data
            key1: First key for nested dict lookup
            key2: Optional second key for nested dict lookup
            default_tooltip: Default tooltip if not found in i18n
            color: LabelColor enum value to set the label color
            bold: Whether to make the label text bold
        
        Returns:
            QLabel: Configured label widget
        """
        if key2:
            data = i18n_dict.get(key1, {}).get(key2, {})
        else:
            data = i18n_dict.get(key1, {})
            
        label_text = data.get('label')
        if not label_text:
            # If no label, use key2 (or key1 if key2 is None), convert snake_case to "Snake Case"
            key = key2 if key2 else key1
            label_text = ' '.join(word.capitalize() for word in key.split('_'))
        label = QLabel(label_text)
        label.setToolTip(data.get('tooltip', default_tooltip))
        
        # Apply color styling
        style_parts = []
        if color != LabelColor.DEFAULT:
            style_parts.append(f"color: {color.get_qt_color()};")
        if bold:
            style_parts.append("font-weight: bold;")
        
        if style_parts:
            label.setStyleSheet(" ".join(style_parts))
        
        return label
    
    def _create_group_box(self, title):
        """Helper to create a styled QGroupBox with consistent styling."""
        group = QGroupBox(title)
        group.setStyleSheet(self._get_group_box_style())
        return group
    
    def _get_group_box_style(self):
        """Returns the consistent group box stylesheet."""
        return """
            QGroupBox {
                font-weight: bold;
                border: 2px solid #555;
                border-radius: 5px;
                margin-top: 10px;
                padding-top: 10px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px 0 5px;
            }
        """
    
    def _update_ai_provider_visibility(self):
        """Shows/hides AI provider settings based on selected provider."""
        provider = self.ai_provider_combo.currentText()
        self.gemini_settings_group.setVisible(provider == AI_GEMINI)
        self.groq_settings_group.setVisible(provider == AI_GROQ)
        self.openai_settings_group.setVisible(provider == AI_OPENAI)
        self.ollama_settings_group.setVisible(provider == AI_OLLAMA)
        self.lm_studio_settings_group.setVisible(provider == AI_LM_STUDIO)

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
        
        # Create a container widget with spacing
        container = QWidget()
        container_layout = QVBoxLayout(container)
        container_layout.setContentsMargins(0, 20, 0, 0)  # Add top margin for spacing
        
        # Add a horizontal line separator
        separator = QWidget()
        separator.setFixedHeight(1)
        separator.setStyleSheet("background-color: #444444;")
        container_layout.addWidget(separator)
        
        # Add some spacing after separator
        container_layout.addSpacing(10)
        
        # Create the reset button
        button = QPushButton(i18n.get('text', 'Reset to Default'))
        button.setToolTip(i18n.get('tooltip', 'Reset current tab to default.'))
        button.clicked.connect(lambda: self._reset_to_default(category, recreate_func))
        button.setMaximumWidth(200)
        
        # Center the button
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        button_layout.addWidget(button)
        button_layout.addStretch()
        
        container_layout.addLayout(button_layout)
        
        return container

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
        
        # Safe format for dialog message - supports both {p} and {profile_name} placeholders
        dialog_title = i18n.get('title', 'Confirm Delete')
        dialog_message_template = i18n.get('message', "Delete '{profile_name}'?")
        try:
            dialog_message = dialog_message_template.format(p=profile_to_delete, profile_name=profile_to_delete)
        except (KeyError, ValueError):
            dialog_message = f"Delete profile '{profile_to_delete}'?"
        
        reply = QMessageBox.question(self, dialog_title, dialog_message,
                                     QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                                     QMessageBox.StandardButton.No)
        if reply == QMessageBox.StandardButton.Yes:
            self.profile_combo.blockSignals(True)
            
            index = self.profile_combo.findText(profile_to_delete)
            if index >= 0:
                self.profile_combo.removeItem(index)
            
            del self.master_config.configs[profile_to_delete]
            
            self.master_config.current_profile = DEFAULT_CONFIG
            self.settings = self.master_config.get_config()
            
            self.profile_combo.setCurrentText(DEFAULT_CONFIG)
            
            self.profile_combo.blockSignals(False)
            
            save_full_config(self.master_config)
            
            self.load_settings_to_ui()
            self.reload_settings(force_refresh=True)
            self.refresh_obs_scenes(force_reload=True)
            self._update_window_title()
            self.delete_profile_button.setHidden(True)

    def refresh_obs_scenes(self, force_reload=False):
        # Save current selections before clearing
        current_profile_scenes = [item.text() for item in self.obs_scene_list.selectedItems()]
        current_discord_scenes = [item.text() for item in self.discord_blacklisted_scenes_list.selectedItems()]
        
        # Use current UI selection if available (and not forcing reload), otherwise use saved config
        if force_reload:
            profile_scenes_to_select = self.settings.scenes
            discord_scenes_to_select = self.master_config.discord.blacklisted_scenes
        else:
            profile_scenes_to_select = current_profile_scenes if current_profile_scenes else self.settings.scenes
            discord_scenes_to_select = current_discord_scenes if current_discord_scenes else self.master_config.discord.blacklisted_scenes
        
        self.obs_scene_list.clear()
        self.discord_blacklisted_scenes_list.clear()
        try:
            scenes = obs.get_obs_scenes()
            scene_names = [scene['sceneName'] for scene in scenes]
            
            # Update profile OBS scene list
            self.obs_scene_list.addItems(scene_names)
            for i in range(self.obs_scene_list.count()):
                item = self.obs_scene_list.item(i)
                if item.text() in profile_scenes_to_select:
                    item.setSelected(True)
            
            # Update Discord blacklisted scenes list
            self.discord_blacklisted_scenes_list.addItems(scene_names)
            for i in range(self.discord_blacklisted_scenes_list.count()):
                item = self.discord_blacklisted_scenes_list.item(i)
                if item.text() in discord_scenes_to_select:
                    item.setSelected(True)
        except Exception as e:
            logger.error(f"Failed to refresh OBS scenes: {e}")

    # --- Other UI Loaders ---
    def _load_ffmpeg_presets(self):
        i18n = self.i18n.get('tabs', {}).get('audio', {}).get('ffmpeg_preset', {}).get('options', {})
        custom_display_name = i18n.get('custom', "Custom")
        self.ffmpeg_preset_map = {
            i18n.get('no_reencode', "No Re-encode"): "",
            i18n.get('fade_in', "Simple Fade-in..."): "-c:a {encoder} -f {format} -af \"afade=t=in:d=0.005\"",
            i18n.get('loudness_norm', "Simple loudness..."): "-c:a {encoder} -f {format} -af \"loudnorm=I=-23:TP=-2,afade=t=in:d=0.005\"",
            i18n.get('downmix_norm', "Downmix to mono..."): "-c:a {encoder} -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.005\"",
            i18n.get('downmix_norm_low_bitrate', "Downmix to mono, 30kbps..."): "-c:a {encoder} -b:a 30k -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.005\"",
            custom_display_name: get_config().audio.custom_encode_settings,
        }
        self.ffmpeg_audio_preset_combo.clear()
        self.ffmpeg_audio_preset_combo.addItems(self.ffmpeg_preset_map.keys())

        # select preset based on current settings
        current_options = self.settings.audio.ffmpeg_reencode_options
        preset_found = False
        for preset_name, preset_options in self.ffmpeg_preset_map.items():
            # The 'Custom' item's value is dynamic, so we don't match against it.
            # If nothing else matches, it's custom.
            if preset_name != custom_display_name and preset_options == current_options:
                self.ffmpeg_audio_preset_combo.setCurrentText(preset_name)
                preset_found = True
                break
        
        if not preset_found:
            self.ffmpeg_audio_preset_combo.setCurrentText(custom_display_name)
            # Also update the map value for custom to reflect the current setting
            self.ffmpeg_preset_map[custom_display_name] = current_options


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
    
    def on_selector_finished(self):
            """Called via signal when the subprocess ends."""
            self.showNormal() # Restores the window
            self.activateWindow() # Brings it to front
            self.show_area_selector_success_indicator() # Show success feedback

    def open_monitor_area_selector(self):
        """Launch the monitor area selector as a separate subprocess."""
        try:
            monitor_index = int(self.overlay_monitor_combo.currentIndex() or 0)
        except (ValueError, AttributeError):
            monitor_index = 0
        
        # Show confirmation dialog
        reply = QMessageBox.question(
            self, # Use self as parent so it centers on app
            "Prepare for Area Selection",
            f"Make sure your game is visible on Monitor {monitor_index + 1} before proceeding.\n\n"
            "The config gui will minimize and the area selector will open in 1 second after you click OK.\n\n"
            "Ready to continue?",
            QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Ok
        )
        
        if reply != QMessageBox.StandardButton.Ok:
            logger.info("Monitor area selector cancelled by user")
            return
        
        # Hide the config GUI NOW, before the thread starts
        self.showMinimized() 
        
        logger.info(f"Launching monitor area selector for monitor {monitor_index}")
        
        def delayed_launch():
            try:
                time.sleep(1)
                python_executable = sys.executable
                
                # 2. Add flags to completely detach the process (Windows specific optimization)
                creationflags = 0
                if sys.platform == "win32":
                    creationflags = subprocess.CREATE_NO_WINDOW
                
                cmd = [
                    python_executable,
                    "-m",
                    "GameSentenceMiner.ocr.owocr_area_selector_qt",
                    "--monitor",
                    str(monitor_index)
                ]
                
                # 3. Use Popen with DEVNULL for all pipes to prevent deadlocks
                #    using .wait() keeps this thread alive until the selector closes
                process = subprocess.Popen(
                    cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=creationflags
                )
                
                process.wait() # Wait for the selector to be closed by the user
                
                logger.info("Monitor area selector finished")
            
            except Exception as e:
                logger.exception(f"Failed to launch monitor area selector: {e}")
            
            finally:
                # 4. Emit signal to restore window (Thread-safe way)
                self._selector_finished_signal.emit()
        
        # Start the background thread
        threading.Thread(target=delayed_launch, daemon=True).start()
        
        # REMOVED: self.show() 
        # (It is now handled by the signal after the process dies)

    def refresh_ai_models(self, provider=None):
        """Manually refresh AI models for a specific provider or all providers.
        
        Args:
            provider: String indicating which provider to refresh ('gemini', 'groq', 'ollama', 'openai')
                     If None, refreshes all providers.
        """
        logger.info(f"Manually refreshing AI models for provider: {provider or 'all'}")
        
        # Store current selections
        current_gemini = self.gemini_model_combo.currentText()
        current_groq = self.groq_model_combo.currentText()
        current_ollama = self.ollama_model_combo.currentText()
        current_lm_studio = self.lm_studio_model_combo.currentText()
        
        # Fetch fresh models from APIs
        self.model_fetcher = AIModelFetcher(self.groq_api_key_edit.text())
        
        if provider == 'gemini':
            gemini_models = self.model_fetcher._get_gemini_models()
            self.gemini_model_combo.clear()
            self.gemini_model_combo.addItems(gemini_models)
            self.gemini_model_combo.setCurrentText(current_gemini)
            AIModelsTable.update_models(gemini_models, None, None, None)
        elif provider == 'groq':
            groq_models = self.model_fetcher._get_groq_models()
            self.groq_model_combo.clear()
            self.groq_model_combo.addItems(groq_models)
            self.groq_model_combo.setCurrentText(current_groq)
            AIModelsTable.update_models(None, groq_models, None, None)
        elif provider == 'ollama':
            ollama_models = self.model_fetcher._get_ollama_models()
            self.ollama_model_combo.clear()
            self.ollama_model_combo.addItems(ollama_models)
            self.ollama_model_combo.setCurrentText(current_ollama)
            AIModelsTable.update_models(None, None, ollama_models, None)
        elif provider == 'lm_studio':
            lm_studio_models = self.model_fetcher._get_lm_studio_models()
            self.lm_studio_model_combo.clear()
            self.lm_studio_model_combo.addItems(lm_studio_models)
            self.lm_studio_model_combo.setCurrentText(current_lm_studio)
            AIModelsTable.update_models(None, None, None, lm_studio_models)
        elif provider == 'openai':
            # OpenAI uses a text field, not a dropdown, so just show a message
            QMessageBox.information(self, "OpenAI Models", 
                                  "OpenAI-compatible APIs require manual model name entry.\n"
                                  "Please enter your model name directly in the field.")
        else:
            # Refresh all providers
            self.model_thread = threading.Thread(target=self.model_fetcher.fetch, daemon=True)
            self.model_fetcher.models_fetched.connect(lambda g, q, o, l: self._update_ai_model_combos(g, q, o, l, True))
            self.model_thread.start()
    
    def get_online_models(self):
        ai_models = AIModelsTable.get_models()
        if ai_models and ai_models.gemini_models and ai_models.groq_models and (time.time() - ai_models.last_updated < 3600 * 6):
            self._update_ai_model_combos(ai_models.gemini_models, ai_models.groq_models, ai_models.ollama_models, ai_models.lm_studio_models)
        else:
            logger.info("AI models outdated or not found, fetching new ones.")
            self.model_fetcher = AIModelFetcher(self.groq_api_key_edit.text())
            self.model_thread = threading.Thread(target=self.model_fetcher.fetch, daemon=True)
            self.model_fetcher.models_fetched.connect(self._update_ai_model_combos)
            self.model_thread.start()
        
        # Always try to fetch Ollama models if Ollama is selected or just as a bonus
        # But wait, AIModelFetcher.fetch() already handles Ollama.
        # So we just need to ensure it's triggered.


    def _update_ai_model_combos(self, gemini_models, groq_models, ollama_models=None, lm_studio_models=None, preserve_selection=False):
        # Store current selections if we want to preserve them
        current_gemini = self.gemini_model_combo.currentText() if preserve_selection else None
        current_groq = self.groq_model_combo.currentText() if preserve_selection else None
        current_ollama = self.ollama_model_combo.currentText() if preserve_selection else None
        current_lm_studio = self.lm_studio_model_combo.currentText() if preserve_selection else None
        
        self.gemini_model_combo.addItems(gemini_models)
        self.groq_model_combo.addItems(groq_models)
        if ollama_models:
            self.ollama_model_combo.clear()
            self.ollama_model_combo.addItems(ollama_models)
        if lm_studio_models:
            self.lm_studio_model_combo.clear()
            self.lm_studio_model_combo.addItems(lm_studio_models)
            
        # Restore previous selection
        if preserve_selection:
            if current_gemini:
                self.gemini_model_combo.setCurrentText(current_gemini)
            if current_groq:
                self.groq_model_combo.setCurrentText(current_groq)
            if current_ollama:
                self.ollama_model_combo.setCurrentText(current_ollama)
            if current_lm_studio:
                self.lm_studio_model_combo.setCurrentText(current_lm_studio)
        else:
            self.gemini_model_combo.setCurrentText(self.settings.ai.gemini_model)
            self.groq_model_combo.setCurrentText(self.settings.ai.groq_model)
            self.ollama_model_combo.setCurrentText(self.settings.ai.ollama_model)
            self.lm_studio_model_combo.setCurrentText(self.settings.ai.lm_studio_model)

    def closeEvent(self, event):
        self.hide_window()
        event.ignore()

if __name__ == '__main__':
    app = QApplication(sys.argv)
    
    # Install custom style to make tooltips appear faster (50ms instead of ~700ms)
    app.setStyle(FastTooltipStyle())
    
    # Ensure app doesn't quit when config window is hidden
    app.setQuitOnLastWindowClosed(False)
    
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