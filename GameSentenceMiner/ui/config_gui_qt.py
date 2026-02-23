import PyQt6.QtGui as QTGui
import copy
import os
import requests
import subprocess
import sys
import threading
import time
import webbrowser
from PyQt6.QtCore import Qt, QSignalBlocker, QTimer, pyqtSignal, QSize
from PyQt6.QtGui import QIcon, QKeySequence
from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QHBoxLayout, QTabWidget,
                             QFormLayout, QLabel, QLineEdit, QCheckBox, QComboBox,
                             QPushButton, QFileDialog, QMessageBox, QInputDialog,
                             QListWidget, QListWidgetItem, QTextEdit, QSizePolicy,
                             QAbstractItemView, QKeySequenceEdit, QGroupBox,
                             QSpinBox, QScrollArea, QFrame, QLayout, QTabBar,
                             QStyle, QStylePainter, QStyleOptionTab)

from GameSentenceMiner import obs
# Import Window State Manager
from GameSentenceMiner.ui import window_state_manager, WindowId
# Config UI modules
from GameSentenceMiner.ui.config.binding import BindingManager, ValueTransform
from GameSentenceMiner.ui.config.editor import ConfigEditor
from GameSentenceMiner.ui.config.i18n import load_localization
from GameSentenceMiner.ui.config.labels import LabelColor
from GameSentenceMiner.ui.config.prompt_help import PromptHelpDialog
from GameSentenceMiner.ui.config.services.ai_models import (
    AIModelFetcher,
    RECOMMENDED_GEMINI_MODELS,
    RECOMMENDED_GROQ_MODELS,
)
from GameSentenceMiner.ui.config.styles import FastToolTipStyle
from GameSentenceMiner.ui.config.tabs.advanced import build_advanced_tab
from GameSentenceMiner.ui.config.tabs.ai import build_ai_prompts_tab, build_ai_tab
from GameSentenceMiner.ui.config.tabs.anki import build_anki_confirmation_tab, build_anki_general_tab, build_anki_tags_tab
from GameSentenceMiner.ui.config.tabs.audio import build_audio_tab
from GameSentenceMiner.ui.config.tabs.experimental import build_experimental_tab
from GameSentenceMiner.ui.config.tabs.gsm_cloud import build_gsm_cloud_tab
from GameSentenceMiner.ui.config.tabs.general import build_general_tab, build_discord_tab
from GameSentenceMiner.ui.config.tabs.obs import build_obs_tab
from GameSentenceMiner.ui.config.tabs.overlay import build_overlay_tab
from GameSentenceMiner.ui.config.tabs.paths import build_paths_tab
from GameSentenceMiner.ui.config.tabs.profiles import build_profiles_tab
from GameSentenceMiner.ui.config.tabs.required import build_required_tab
from GameSentenceMiner.ui.config.tabs.screenshot import build_screenshot_tab
from GameSentenceMiner.ui.config.tabs.text_processing import build_text_processing_tab
from GameSentenceMiner.ui.config.tabs.vad import build_vad_tab
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import (Config, Locale, logger, ProfileConfig,
                                                         Paths, Anki, Features, Screenshot, Audio, OBS, Hotkeys, VAD,
                                                         Overlay, Ai, Advanced, OverlayEngine, get_app_directory,
                                                         get_config, WHISPER_LARGE,
                                                         WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, WHISPER_MEDIUM,
                                                         WHISPER_TURBO, SILERO, WHISPER, OFF, gsm_state, DEFAULT_CONFIG,
                                                         get_latest_version, get_current_version, AI_GEMINI, AI_GROQ,
                                                         AI_OPENAI, AI_OLLAMA, AI_LM_STUDIO, AI_GSM_CLOUD,
                                                         GSM_CLOUD_DEFAULT_MODEL, is_gsm_cloud_preview_enabled, save_full_config,
                                                         AnimatedScreenshotSettings, Discord, Experimental,
                                                         AnkiField,
                                                         ProcessPausing)
from GameSentenceMiner.util.cloud_sync import cloud_sync_service
from GameSentenceMiner.util.database.db import AIModelsTable
from GameSentenceMiner.util.downloader.download_tools import download_ocenaudio_if_needed

on_save = []


class HorizontalTextTabBar(QTabBar):
    """Left-side tab bar with horizontal text labels."""

    def tabSizeHint(self, index):
        base_size = super().tabSizeHint(index)
        return QSize(max(190, base_size.height() + 36), 48)

    def paintEvent(self, event):
        painter = QStylePainter(self)
        option = QStyleOptionTab()
        for index in range(self.count()):
            self.initStyleOption(option, index)
            option.shape = QTabBar.Shape.RoundedNorth
            painter.drawControl(QStyle.ControlElement.CE_TabBarTabShape, option)
            painter.drawControl(QStyle.ControlElement.CE_TabBarTabLabel, option)


class ConfigWindow(QWidget):
    # Signals for thread-safe operations
    _show_window_signal = pyqtSignal()
    _close_window_signal = pyqtSignal()
    _reload_settings_signal = pyqtSignal()
    _quit_app_signal = pyqtSignal()
    _selector_finished_signal = pyqtSignal()
    _gsm_cloud_sync_finished_signal = pyqtSignal(dict)
    _AUTO_SAVE_DEBOUNCE_MS = 900
    _RUNTIME_RELOAD_DEBOUNCE_MS = 1200
    _BACKUP_MIN_INTERVAL_SECONDS = 120
    _GSM_CLOUD_AUTH_POLL_MS = 1500
    _GSM_CLOUD_AUTH_TIMEOUT_SECONDS = 240
    
    def __init__(self):
        super().__init__()
        self.test_func = None
        self.on_exit = None
        self.first_launch = True
        self._has_been_shown = False
        self._suppress_anki_field_refresh = False
        self._anki_available_fields = []
        self._last_anki_note_type_refresh = None
        self._autosave_suspended = True
        self._is_saving = False
        self._last_backup_timestamp = 0.0
        self._auto_save_timer = QTimer(self)
        self._auto_save_timer.setSingleShot(True)
        self._auto_save_timer.timeout.connect(self._perform_auto_save)
        self._runtime_reload_timer = QTimer(self)
        self._runtime_reload_timer.setSingleShot(True)
        self._runtime_reload_timer.timeout.connect(self._reload_runtime_config)
        self._gsm_cloud_auth_poll_timer = QTimer(self)
        self._gsm_cloud_auth_poll_timer.setSingleShot(False)
        self._gsm_cloud_auth_poll_timer.setInterval(self._GSM_CLOUD_AUTH_POLL_MS)
        self._gsm_cloud_auth_poll_timer.timeout.connect(self._poll_gsm_cloud_auth_status)
        self._gsm_cloud_auth_session_id = ""
        self._gsm_cloud_auth_secret = ""
        self._gsm_cloud_auth_deadline = 0.0
        self._gsm_cloud_sync_in_progress = False

        # --- Load Configuration and Localization ---
        self.editor = ConfigEditor()
        self.master_config: Config = self.editor.master_config
        self.settings: ProfileConfig = self.editor.profile
        self.default_master_settings = self.editor.default_master
        self.default_settings = self.editor.default_profile
        self.i18n = load_localization(self.master_config.get_locale())
        self.binder = BindingManager(self.editor)
        
        # --- Window Setup ---
        self._update_window_title()
        self.setWindowFlags(self.windowFlags() | Qt.WindowType.Window)  # Ensure it's a standalone window
        self.resize(800, 700)
        self.setMinimumSize(640, 480)
        
        # Set window icon explicitly
        try:
            from GameSentenceMiner.util.config.configuration import get_pickaxe_png_path
            self.setWindowIcon(QIcon(get_pickaxe_png_path()))
        except Exception:
            pass
        
        # --- Enable mouse tracking for faster tooltip response ---
        self.setMouseTracking(True)

        # --- Main Layout ---
        self.main_layout = QVBoxLayout(self)
        self.tab_widget = QTabWidget()
        self._configure_tab_widgets()
        self.main_layout.addWidget(self.tab_widget)

        # --- Create UI Elements (Widgets) ---
        self._create_all_widgets()
        self._register_shared_bindings()
        self._create_tabs()

        # --- Bottom Button Bar ---
        self._create_button_bar()

        # --- Load Data into UI ---
        self._load_settings_to_ui_safely()

        # --- Connect Signals ---
        self._connect_signals()
        self._autosave_suspended = False
        
        # Connect thread-safe window operation signals
        self._show_window_signal.connect(self._show_window_impl)
        self._close_window_signal.connect(self._close_window_impl)
        self._reload_settings_signal.connect(self._reload_settings_impl)
        self._quit_app_signal.connect(QApplication.instance().quit)
        self._selector_finished_signal.connect(self.on_selector_finished)
        self._gsm_cloud_sync_finished_signal.connect(self._on_gsm_cloud_sync_finished)

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
        self._gsm_cloud_auth_poll_timer.stop()
        self._flush_pending_auto_save()
        self._flush_runtime_reload(force=True)
        self._save_window_geometry()
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
        self._gsm_cloud_auth_poll_timer.stop()
        self._flush_pending_auto_save()
        self._flush_runtime_reload(force=True)
        self._save_window_geometry()
        self.hide()

    def reload_settings(self, force_refresh=False):
        """
        Reloads the settings in the UI.
        Thread-safe: Can be called from any thread.
        """
        self._reload_settings_signal.emit()

    def _reload_settings_impl(self, force_refresh=False):
        self._flush_pending_auto_save()
        new_config = configuration.load_config()
        current_config = new_config.get_config()
        
        if force_refresh or current_config.name != self.settings.name or self.settings.config_changed(current_config):
            logger.info("Config changed, reloading UI.")
            self.editor.replace_master_config(new_config)
            self.master_config = self.editor.master_config
            self.settings = self.editor.profile
            self._load_settings_to_ui_safely()
            self.binder.refresh_all()
            self._update_window_title()
            self.refresh_obs_scenes(force_reload=True)

    def add_save_hook(self, func):
        if func not in on_save:
            on_save.append(func)

    def set_test_func(self, func):
        self.test_func = func

    def show_save_success_indicator(self):
        """Shows a temporary success indicator that fades out after a few seconds."""
        success_text = self.i18n.get('buttons', {}).get('save_success', 'Settings Saved Successfully!')
        self.save_status_label.setStyleSheet("color: #28a745; font-weight: bold; padding: 5px;")
        self.save_status_label.setText(success_text)
        self.save_status_label.show()
        QTimer.singleShot(3000, self.save_status_label.hide)

    def show_autosave_pending_indicator(self):
        pending_text = self.i18n.get('buttons', {}).get('autosave_pending', 'Unsaved changes...')
        self.save_status_label.setStyleSheet("color: #d39e00; font-weight: bold; padding: 5px;")
        self.save_status_label.setText(pending_text)
        self.save_status_label.show()

    def show_autosave_success_indicator(self):
        template = self.i18n.get('buttons', {}).get('autosave_success', 'Auto-saved at {time}')
        current_time = time.strftime("%H:%M:%S")
        try:
            success_text = template.format(time=current_time)
        except Exception:
            success_text = f"Auto-saved at {current_time}"
        self.save_status_label.setStyleSheet("color: #28a745; font-weight: bold; padding: 5px;")
        self.save_status_label.setText(success_text)
        self.save_status_label.show()
        QTimer.singleShot(4000, self.save_status_label.hide)

    def show_save_error_indicator(self):
        error_text = self.i18n.get('buttons', {}).get('save_error', 'Failed to save settings')
        self.save_status_label.setStyleSheet("color: #dc3545; font-weight: bold; padding: 5px;")
        self.save_status_label.setText(error_text)
        self.save_status_label.show()

    def show_area_selector_success_indicator(self):
        """Shows a temporary success indicator for area selection completion."""
        # Get localized text or use default for area selection
        success_text = self.i18n.get('overlay', {}).get('area_selection_complete', '笨・Area Selection Complete!')
        
        self.save_status_label.setText(success_text)
        self.save_status_label.show()
        
        # Reset to default "Settings Saved" text after 3 seconds
        def reset_to_default():
            default_text = self.i18n.get('buttons', {}).get('save_success', '笨・Settings Saved Successfully!')
            self.save_status_label.setText(default_text)
            self.save_status_label.hide()
        
        QTimer.singleShot(3000, reset_to_default)

    def showEvent(self, event):
        """Handle window showing: restore position."""
        if self.first_launch:
            restored = window_state_manager.restore_geometry(self, WindowId.CONFIG_GUI)
            if not restored:
                window_state_manager.center_window(self)
            self.first_launch = False
        self._has_been_shown = True
        super().showEvent(event)

    def _save_window_geometry(self):
        """
        Avoid overwriting persisted geometry with startup defaults when the config
        window was never shown during this process.
        """
        if not self._has_been_shown:
            return
        window_state_manager.save_geometry(self, WindowId.CONFIG_GUI)

    def _load_settings_to_ui_safely(self):
        previous_state = self._autosave_suspended
        self._autosave_suspended = True
        try:
            self.load_settings_to_ui()
        finally:
            self._autosave_suspended = previous_state

    def _on_autosave_trigger(self):
        self.request_auto_save()

    def request_auto_save(self, immediate=False):
        if self._autosave_suspended or self._is_saving:
            return
        if immediate:
            self._auto_save_timer.stop()
            self._perform_auto_save()
            return
        self.show_autosave_pending_indicator()
        self._auto_save_timer.start(self._AUTO_SAVE_DEBOUNCE_MS)

    def _perform_auto_save(self):
        if self._autosave_suspended or self._is_saving:
            return
        did_save = self.save_settings(
            target_profile_name=self.settings.name,
            show_indicator=False,
            force_backup=False,
            immediate_reload=False,
        )
        if did_save:
            self.show_autosave_success_indicator()

    def _connect_autosave_signals(self):
        excluded_widgets = {self.profile_combo, self.locale_combo}
        if getattr(self, "sync_changes_check", None):
            excluded_widgets.add(self.sync_changes_check)

        for widget in self.findChildren(QWidget):
            if widget in excluded_widgets:
                continue
            if widget.property("_gsm_autosave_connected"):
                continue

            connected = False
            if isinstance(widget, QLineEdit):
                widget.textChanged.connect(self._on_autosave_trigger)
                connected = True
            elif isinstance(widget, QCheckBox):
                widget.stateChanged.connect(self._on_autosave_trigger)
                connected = True
            elif isinstance(widget, QComboBox):
                widget.currentTextChanged.connect(self._on_autosave_trigger)
                connected = True
            elif isinstance(widget, QSpinBox):
                widget.valueChanged.connect(self._on_autosave_trigger)
                connected = True
            elif isinstance(widget, QTextEdit):
                widget.textChanged.connect(self._on_autosave_trigger)
                connected = True
            elif isinstance(widget, QKeySequenceEdit):
                widget.keySequenceChanged.connect(self._on_autosave_trigger)
                connected = True
            elif isinstance(widget, QListWidget):
                widget.itemSelectionChanged.connect(self._on_autosave_trigger)
                connected = True

            if connected:
                widget.setProperty("_gsm_autosave_connected", True)

    def _flush_pending_auto_save(self, target_profile_name=None):
        should_flush = self._auto_save_timer.isActive() or self.editor.dirty
        if not should_flush or self._autosave_suspended or self._is_saving:
            return

        self._auto_save_timer.stop()
        profile_name = target_profile_name or self.settings.name
        self.save_settings(
            target_profile_name=profile_name,
            show_indicator=False,
            force_backup=False,
            immediate_reload=False,
        )

    def _schedule_runtime_reload(self):
        self._runtime_reload_timer.start(self._RUNTIME_RELOAD_DEBOUNCE_MS)

    def _flush_runtime_reload(self, force=False):
        if force or self._runtime_reload_timer.isActive():
            self._runtime_reload_timer.stop()
            self._reload_runtime_config()

    def _reload_runtime_config(self):
        configuration.reload_config()
        for func in on_save:
            func()

    def _write_config_backup_if_needed(self, force=False):
        now = time.time()
        if not force and (now - self._last_backup_timestamp) < self._BACKUP_MIN_INTERVAL_SECONDS:
            return

        config_backup_folder = os.path.join(get_app_directory(), "backup", "config")
        os.makedirs(config_backup_folder, exist_ok=True)
        timestamp = time.strftime("%Y-%m-%d_%H-%M-%S")
        backup_path = os.path.join(config_backup_folder, f"config_backup_{timestamp}.json")
        with open(backup_path, "w", encoding="utf-8") as backup_file:
            backup_file.write(self.master_config.to_json(indent=4))
        self._last_backup_timestamp = now

    # --- Core Logic Methods ---
    def save_settings(
        self,
        profile_change=False,
        target_profile_name=None,
        show_indicator=True,
        force_backup=False,
        immediate_reload=False,
    ):
        if self._is_saving:
            return False
        self._is_saving = True
        saved_ok = False

        # Validate and clamp periodic_ratio
        try:
            try:
                periodic_ratio = float(self.periodic_ratio_edit.text())
                periodic_ratio = max(0.0, min(1.0, periodic_ratio))
                self.periodic_ratio_edit.setText(str(periodic_ratio))
            except ValueError:
                periodic_ratio = 0.9

            self._sync_obs_recording_fps_with_animated()

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
            general=copy.deepcopy(self.editor.profile.general),
            text_processing=copy.deepcopy(self.editor.profile.text_processing),
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
                note_type=self.anki_note_type_combo.currentText(),
                available_fields=list(self._anki_available_fields),
                sentence=AnkiField(
                    name=self.sentence_field_edit.currentText(),
                    enabled=self.sentence_field_enabled_check.isChecked(),
                    overwrite=self.sentence_field_overwrite_check.isChecked(),
                    append=self.sentence_field_append_check.isChecked(),
                    core=True,
                ),
                sentence_audio=AnkiField(
                    name=self.sentence_audio_field_edit.currentText(),
                    enabled=self.sentence_audio_field_enabled_check.isChecked(),
                    overwrite=self.sentence_audio_field_overwrite_check.isChecked(),
                    append=self.sentence_audio_field_append_check.isChecked(),
                    core=True,
                ),
                picture=AnkiField(
                    name=self.picture_field_edit.currentText(),
                    enabled=self.picture_field_enabled_check.isChecked(),
                    overwrite=self.picture_field_overwrite_check.isChecked(),
                    append=self.picture_field_append_check.isChecked(),
                    core=True,
                ),
                word=AnkiField(
                    name=self.word_field_edit.currentText(),
                    enabled=True,
                    overwrite=False,
                    append=False,
                    core=True,
                ),
                previous_sentence=AnkiField(
                    name=self.previous_sentence_field_edit.currentText(),
                    enabled=self.previous_sentence_field_enabled_check.isChecked(),
                    overwrite=self.previous_sentence_field_overwrite_check.isChecked(),
                    append=self.previous_sentence_field_append_check.isChecked(),
                ),
                previous_image=AnkiField(
                    name=self.previous_image_field_edit.currentText(),
                    enabled=self.previous_image_field_enabled_check.isChecked(),
                    overwrite=self.previous_image_field_overwrite_check.isChecked(),
                    append=self.previous_image_field_append_check.isChecked(),
                ),
                game_name=AnkiField(
                    name=self.game_name_field_edit.currentText(),
                    enabled=self.game_name_field_enabled_check.isChecked(),
                    overwrite=self.game_name_field_overwrite_check.isChecked(),
                    append=self.game_name_field_append_check.isChecked(),
                ),
                video=AnkiField(
                    name=self.video_field_edit.currentText(),
                    enabled=self.video_field_enabled_check.isChecked(),
                    overwrite=self.video_field_overwrite_check.isChecked(),
                    append=self.video_field_append_check.isChecked(),
                ),
                sentence_furigana=AnkiField(
                    name=self.sentence_furigana_field_edit.currentText(),
                    enabled=self.sentence_furigana_field_enabled_check.isChecked(),
                    overwrite=self.sentence_furigana_field_overwrite_check.isChecked(),
                    append=self.sentence_furigana_field_append_check.isChecked(),
                ),
                custom_tags=[tag.strip() for tag in self.custom_tags_edit.text().split(',') if tag.strip()],
                tags_to_check=[tag.strip().lower() for tag in self.tags_to_check_edit.text().split(',') if tag.strip()],
                add_game_tag=self.add_game_tag_check.isChecked(),
                polling_rate=int(self.polling_rate_edit.text() or 0),
                parent_tag=self.parent_tag_edit.text(),
                autoplay_audio=self.anki_confirmation_autoplay_audio_check.isChecked(),
                tag_unvoiced_cards=self.tag_unvoiced_cards_check.isChecked(),
                confirmation_always_on_top=self.anki_confirmation_always_on_top_check.isChecked(),
                confirmation_focus_on_show=self.anki_confirmation_focus_on_show_check.isChecked(),
                replay_audio_on_tts_generation=self.anki_confirmation_replay_audio_on_tts_generation_check.isChecked(),
            ),
            features=Features(
                full_auto=self.full_auto_check.isChecked(),
                notify_on_update=self.editor.profile.features.notify_on_update,
                open_anki_edit=self.editor.profile.features.open_anki_edit,
                open_anki_in_browser=self.editor.profile.features.open_anki_in_browser,
                browser_query=self.browser_query_edit.text(),
                generate_longplay=self.generate_longplay_check.isChecked(),
            ),
            screenshot=Screenshot(
                enabled=self.screenshot_enabled_check.isChecked(),
                width=self.screenshot_width_edit.text(),
                height=self.screenshot_height_edit.text(),
                quality=self.screenshot_quality_edit.text(),
                extension=self.screenshot_extension_combo.currentText(),
                custom_ffmpeg_settings=self.screenshot_custom_ffmpeg_settings_edit.text(),
                screenshot_hotkey_updates_anki=self.settings.screenshot.screenshot_hotkey_updates_anki,
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
                automatically_manage_replay_buffer=self.automatically_manage_replay_buffer_check.isChecked(),
                recording_fps=max(1, min(120, self.obs_recording_fps_spin.value())),
                disable_desktop_audio_on_connect=self.obs_disable_desktop_audio_on_connect_check.isChecked(),
            ),
            hotkeys=Hotkeys(
                manual_overlay_scan=self.manual_overlay_scan_hotkey_edit.keySequence().toString(),
                play_latest_audio=self.play_latest_audio_hotkey_edit.keySequence().toString(),
                process_pause=self.process_pause_hotkey_edit.keySequence().toString()
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
                use_cpu_for_inference_v2=self.use_cpu_for_inference_check.isChecked(),
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
                gemini_backup_model=(
                    ""
                    if self.gemini_backup_model_combo.currentText() == OFF
                    else self.gemini_backup_model_combo.currentText()
                ),
                groq_model=self.groq_model_combo.currentText(),
                groq_backup_model=(
                    ""
                    if self.groq_backup_model_combo.currentText() == OFF
                    else self.groq_backup_model_combo.currentText()
                ),
                gemini_api_key=self.gemini_api_key_edit.text(),
                api_key=self.gemini_api_key_edit.text(),
                groq_api_key=self.groq_api_key_edit.text(),
                anki_field=self.ai_anki_field_edit.currentText(),
                open_ai_api_key=self.open_ai_api_key_edit.text(),
                open_ai_model=self.open_ai_model_edit.text(),
                open_ai_backup_model=self.open_ai_backup_model_edit.text(),
                open_ai_url=self.open_ai_url_edit.text(),
                gsm_cloud_api_url=self.gsm_cloud_api_url_edit.text(),
                gsm_cloud_auth_url=self.gsm_cloud_auth_url_edit.text(),
                gsm_cloud_client_id=self.gsm_cloud_client_id_edit.text(),
                gsm_cloud_access_token=self.gsm_cloud_access_token_edit.text(),
                gsm_cloud_refresh_token=self.gsm_cloud_refresh_token_edit.text(),
                gsm_cloud_user_id=self.gsm_cloud_user_id_edit.text(),
                gsm_cloud_token_expires_at=self._gsm_cloud_token_expires_at_value,
                gsm_cloud_models=self._get_selected_gsm_cloud_models(),
                ollama_url=self.ollama_url_edit.text(),
                ollama_model=self.ollama_model_combo.currentText(),
                ollama_backup_model=(
                    ""
                    if self.ollama_backup_model_combo.currentText() == OFF
                    else self.ollama_backup_model_combo.currentText()
                ),
                lm_studio_url=self.lm_studio_url_edit.text(),
                lm_studio_model=self.lm_studio_model_combo.currentText(),
                lm_studio_backup_model=(
                    ""
                    if self.lm_studio_backup_model_combo.currentText() == OFF
                    else self.lm_studio_backup_model_combo.currentText()
                ),
                lm_studio_api_key=self.lm_studio_api_key_edit.text(),
                use_canned_translation_prompt=self.use_canned_translation_prompt_check.isChecked(),
                use_canned_context_prompt=self.use_canned_context_prompt_check.isChecked(),
                custom_prompt=self.custom_prompt_textedit.toPlainText(),
                dialogue_context_length=int(self.ai_dialogue_context_length_edit.text() or 0),
                temperature=float(self.ai_temperature_edit.text() or 0.0),
                max_output_tokens=int(self.ai_max_output_tokens_edit.text() or 0),
                top_p=float(self.ai_top_p_edit.text() or 0.0),
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
            current_profile_name = target_profile_name or self.settings.name or self.profile_combo.currentText()

            if profile_change:
                self.master_config.current_profile = current_profile_name
            else:
                self.master_config.current_profile = current_profile_name
                self.master_config.set_config_for_profile(current_profile_name, config)

            self.master_config.locale = self.editor.master_config.locale
            self.master_config.overlay = config.overlay

            auto_resume_seconds = self.process_pausing_auto_resume_seconds_edit.value()

            self.master_config.experimental = Experimental(
                enable_experimental_features=self.experimental_features_enabled_check.isChecked()
            )
            self.master_config.process_pausing = ProcessPausing(
                enabled=self.process_pausing_enabled_check.isChecked(),
                auto_resume_seconds=auto_resume_seconds,
                require_game_exe_match=True,  # Always true
                overlay_manual_hotkey_requests_pause=self.process_pausing_overlay_manual_hotkey_requests_pause_check.isChecked(),
                overlay_texthooker_hotkey_requests_pause=self.process_pausing_overlay_texthooker_hotkey_requests_pause_check.isChecked(),
                allowlist=[item.strip().lower() for item in self.process_pausing_allowlist_edit.text().split(',') if item.strip()],
                denylist=[item.strip().lower() for item in self.process_pausing_denylist_edit.text().split(',') if item.strip()],
            )
        
            # Get selected blacklisted scenes from Discord list
            discord_blacklisted = [item.text() for item in self.discord_blacklisted_scenes_list.selectedItems()]
        
            # Clamp inactivity to allowed range before saving
            try:
                inactivity_to_save = int(self.discord_inactivity_spin.value())
            except Exception:
                inactivity_to_save = 300
            inactivity_to_save = max(120, min(900, inactivity_to_save))

            self.master_config.discord = Discord(
                enabled=self.editor.master_config.discord.enabled,
                # update_interval=self.discord_update_interval_spin.value(),
                inactivity_timer=inactivity_to_save,
                icon=self.editor.master_config.discord.icon,
                show_reading_stats=self.editor.master_config.discord.show_reading_stats,
                blacklisted_scenes=discord_blacklisted,
            )

            self._write_config_backup_if_needed(force=force_backup)

            self.master_config = self.master_config.sync_shared_fields()

            if self.sync_changes_check and self.sync_changes_check.isChecked():
                self.master_config.sync_changed_fields(prev_config)
                self.sync_changes_check.setChecked(False)

            self.master_config.save()
            logger.success("Settings saved successfully!")
            if show_indicator:
                self.show_save_success_indicator()

            if self.master_config.get_config().restart_required(prev_config):
                logger.info("Restart Required for some settings to take affect!")

            self.editor.replace_master_config(self.master_config)
            self.master_config = self.editor.master_config
            self.settings = self.editor.profile
            try:
                obs.apply_obs_performance_settings(config_override=self.settings)
            except Exception:
                pass
            if immediate_reload:
                self._flush_runtime_reload(force=True)
            else:
                self._schedule_runtime_reload()
            saved_ok = True
        except Exception as e:
            logger.error(f"Failed to save settings: {e}", exc_info=True)
            self.show_save_error_indicator()
        finally:
            self._is_saving = False
        return saved_ok

    # --- UI Event Handlers (Slots) ---
    def _on_profile_changed(self):
        new_profile_name = self.profile_combo.currentText()
        previous_profile_name = self.settings.name
        if new_profile_name == previous_profile_name:
            return

        self._flush_pending_auto_save(target_profile_name=previous_profile_name)
        self.master_config.current_profile = new_profile_name
        self.master_config.save()
        self.editor.replace_master_config(self.master_config)
        self.master_config = self.editor.master_config
        self.settings = self.editor.profile
        self._schedule_runtime_reload()
        self._load_settings_to_ui_safely()
        self.refresh_obs_scenes(force_reload=True)
        self._update_window_title()
        is_default = new_profile_name == DEFAULT_CONFIG
        self.delete_profile_button.setHidden(is_default)

    def _on_locale_changed(self):
        if self.locale_combo.currentText() == self.master_config.get_locale().name:
            return
        
        self._flush_pending_auto_save()
        self.save_settings(show_indicator=False, force_backup=True, immediate_reload=True)
        self.i18n = load_localization(Locale[self.locale_combo.currentText()])
        self.editor.clear_listeners()
        self.binder = BindingManager(self.editor)
        self._register_shared_bindings()
        
        # This is a bit drastic, but easiest way to re-translate everything
        self.tab_widget.clear()
        self._create_tabs()
        self._create_button_bar() # Re-create to update text
        self._load_settings_to_ui_safely() # Reload data
        self._connect_signals() # Reconnect signals
        self._update_window_title()

        logger.info(f"Locale changed to {self.locale_combo.currentText()}.")
    
    def _on_obs_scene_selection_changed(self):
        selected_items = self.obs_scene_list.selectedItems()
        self.settings.scenes = [item.text() for item in selected_items]
        self.request_auto_save()

    def _on_root_tab_changed(self, index):
        if index == getattr(self, "overlay_tab_index", -1):
            self._load_monitors(preferred_index=self.overlay_monitor_combo.currentIndex())
    
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
        self.open_config_on_startup_check = QCheckBox()
        self.open_multimine_on_startup_check = QCheckBox()
        self.texthooker_port_edit = QLineEdit()
        self.native_language_combo = QComboBox()
        self.locale_combo = QComboBox()
        self.notify_on_update_check = QCheckBox()

        # Text Processing
        self.string_replacement_enabled_check = QCheckBox()
        self.string_replacement_edit_button = QPushButton()
        self.string_replacement_rules_count_label = QLabel("")
        
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
        self.anki_confirmation_always_on_top_check = QCheckBox()
        self.anki_confirmation_focus_on_show_check = QCheckBox()
        self.anki_confirmation_autoplay_audio_check = QCheckBox()
        self.anki_confirmation_replay_audio_on_tts_generation_check = QCheckBox()
        self.anki_url_edit = QLineEdit()
        self.anki_note_type_combo = self._create_anki_field_combo()
        self.sentence_field_edit = self._create_anki_field_combo()
        self.sentence_audio_field_edit = self._create_anki_field_combo()
        self.picture_field_edit = self._create_anki_field_combo()
        self.word_field_edit = self._create_anki_field_combo()
        self.previous_sentence_field_edit = self._create_anki_field_combo()
        self.previous_image_field_edit = self._create_anki_field_combo()
        self.game_name_field_edit = self._create_anki_field_combo()
        self.video_field_edit = self._create_anki_field_combo()
        self.sentence_furigana_field_edit = self._create_anki_field_combo()
        self.sentence_field_enabled_check = QCheckBox()
        self.sentence_field_overwrite_check = QCheckBox()
        self.sentence_field_append_check = QCheckBox()
        self.sentence_audio_field_enabled_check = QCheckBox()
        self.sentence_audio_field_overwrite_check = QCheckBox()
        self.sentence_audio_field_append_check = QCheckBox()
        self.picture_field_enabled_check = QCheckBox()
        self.picture_field_overwrite_check = QCheckBox()
        self.picture_field_append_check = QCheckBox()
        self.previous_sentence_field_enabled_check = QCheckBox()
        self.previous_sentence_field_overwrite_check = QCheckBox()
        self.previous_sentence_field_append_check = QCheckBox()
        self.previous_image_field_enabled_check = QCheckBox()
        self.previous_image_field_overwrite_check = QCheckBox()
        self.previous_image_field_append_check = QCheckBox()
        self.video_field_enabled_check = QCheckBox()
        self.video_field_overwrite_check = QCheckBox()
        self.video_field_append_check = QCheckBox()
        self.sentence_furigana_field_enabled_check = QCheckBox()
        self.sentence_furigana_field_overwrite_check = QCheckBox()
        self.sentence_furigana_field_append_check = QCheckBox()
        self.game_name_field_enabled_check = QCheckBox()
        self.game_name_field_overwrite_check = QCheckBox()
        self.game_name_field_append_check = QCheckBox()
        self.custom_tags_edit = QLineEdit()
        self.tags_to_check_edit = QLineEdit()
        self.add_game_tag_check = QCheckBox()
        self.parent_tag_edit = QLineEdit()
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
        self.gsm_cloud_settings_group = QGroupBox()
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
        self.obs_recording_fps_spin = QSpinBox()
        self.obs_recording_fps_spin.setRange(1, 120)
        self.obs_recording_fps_spin.setValue(15)
        self.obs_disable_desktop_audio_on_connect_check = QCheckBox()
        self.obs_recording_fps_warning_label = QLabel()
        
        # AI
        self.ai_enabled_check = QCheckBox()
        self.ai_provider_combo = QComboBox()
        self.gemini_model_combo = QComboBox()
        self.gemini_backup_model_combo = QComboBox()
        self.gemini_api_key_edit = QLineEdit()
        self.groq_model_combo = QComboBox()
        self.groq_backup_model_combo = QComboBox()
        self.groq_api_key_edit = QLineEdit()
        self.open_ai_url_edit = QLineEdit()
        self.open_ai_model_edit = QLineEdit()
        self.open_ai_backup_model_edit = QLineEdit()
        self.open_ai_api_key_edit = QLineEdit()
        self.gsm_cloud_model_list = QListWidget()
        self.gsm_cloud_model_list.setSelectionMode(QAbstractItemView.SelectionMode.NoSelection)
        self.gsm_cloud_model_list.setMinimumHeight(80)
        self.gsm_cloud_access_token_edit = QLineEdit()
        self.gsm_cloud_refresh_token_edit = QLineEdit()
        self.gsm_cloud_access_token_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.gsm_cloud_refresh_token_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.gsm_cloud_api_url_edit = QLineEdit()
        self.gsm_cloud_auth_url_edit = QLineEdit()
        self.gsm_cloud_client_id_edit = QLineEdit()
        self.ollama_url_edit = QLineEdit()
        self.ollama_model_combo = QComboBox()
        self.ollama_backup_model_combo = QComboBox()
        self.lm_studio_url_edit = QLineEdit()
        self.lm_studio_model_combo = QComboBox()
        self.lm_studio_backup_model_combo = QComboBox()
        self.lm_studio_api_key_edit = QLineEdit()
        self.ai_anki_field_edit = self._create_anki_field_combo()
        self.ai_dialogue_context_length_edit = QLineEdit()
        self.ai_temperature_edit = QLineEdit()
        self.ai_max_output_tokens_edit = QLineEdit()
        self.ai_top_p_edit = QLineEdit()
        self.use_canned_translation_prompt_check = QCheckBox()
        self.use_canned_context_prompt_check = QCheckBox()
        self.custom_prompt_textedit = QTextEdit()
        self.custom_texthooker_prompt_textedit = QTextEdit()
        self.custom_full_prompt_textedit = QTextEdit()

        # GSM Cloud
        self.gsm_cloud_status_label = QLabel("Not authenticated")
        self.gsm_cloud_status_label.setWordWrap(True)
        self.gsm_cloud_user_id_edit = QLineEdit()
        self.gsm_cloud_user_id_edit.setReadOnly(True)
        self.gsm_cloud_token_expiry_edit = QLineEdit()
        self.gsm_cloud_token_expiry_edit.setReadOnly(True)
        self.gsm_cloud_authenticate_button = QPushButton("Authenticate with GSM Cloud")
        self.gsm_cloud_sign_out_button = QPushButton("Sign Out")
        self.gsm_cloud_sync_now_button = QPushButton("Sync Local DB Now")
        self.gsm_cloud_sync_now_button.setEnabled(False)
        self._gsm_cloud_token_expires_at_value = 0
        
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

        # Experimental
        self.experimental_features_enabled_check = QCheckBox()
        self.process_pausing_enabled_check = QCheckBox()
        self.process_pausing_require_game_exe_match_check = QCheckBox()
        self.process_pausing_overlay_manual_hotkey_requests_pause_check = QCheckBox()
        self.process_pausing_overlay_texthooker_hotkey_requests_pause_check = QCheckBox()
        self.process_pausing_allowlist_edit = QLineEdit()
        self.process_pausing_denylist_edit = QLineEdit()
        self.process_pausing_auto_resume_seconds_edit = QSpinBox()
        self.process_pausing_auto_resume_seconds_edit.setRange(5, 300)
        self.process_pausing_auto_resume_seconds_edit.setToolTip("Number of seconds to auto-resume after pausing (5-300) NON-NEGOTIABLE.")
        
        self.process_pause_hotkey_edit = QKeySequenceEdit()
        self.process_pausing_allowlist_edit.setPlaceholderText("game.exe, foo.exe")
        self.process_pausing_denylist_edit.setPlaceholderText("explorer.exe, steam.exe")

    def _register_shared_bindings(self):
        def int_from_text(value, default=0):
            try:
                return int(value or default)
            except Exception:
                return default

        def float_from_text(value, default=0.0):
            try:
                return float(value or default)
            except Exception:
                return default

        self.binder.bind(("profile", "paths", "folder_to_watch"), self.folder_to_watch_edit)
        self.binder.bind(("profile", "anki", "note_type"), self.anki_note_type_combo)
        self.binder.bind(("profile", "anki", "sentence_field"), self.sentence_field_edit)
        self.binder.bind(("profile", "anki", "sentence_field_enabled"), self.sentence_field_enabled_check)
        self.binder.bind(("profile", "anki", "sentence_field_overwrite"), self.sentence_field_overwrite_check)
        self.binder.bind(("profile", "anki", "sentence_field_append"), self.sentence_field_append_check)
        self.binder.bind(("profile", "anki", "sentence_audio_field"), self.sentence_audio_field_edit)
        self.binder.bind(("profile", "anki", "sentence_audio_field_enabled"), self.sentence_audio_field_enabled_check)
        self.binder.bind(("profile", "anki", "sentence_audio_field_overwrite"), self.sentence_audio_field_overwrite_check)
        self.binder.bind(("profile", "anki", "sentence_audio_field_append"), self.sentence_audio_field_append_check)
        self.binder.bind(("profile", "anki", "picture_field"), self.picture_field_edit)
        self.binder.bind(("profile", "anki", "picture_field_enabled"), self.picture_field_enabled_check)
        self.binder.bind(("profile", "anki", "picture_field_overwrite"), self.picture_field_overwrite_check)
        self.binder.bind(("profile", "anki", "picture_field_append"), self.picture_field_append_check)
        self.binder.bind(("profile", "anki", "word_field"), self.word_field_edit)
        self.binder.bind(("profile", "anki", "previous_sentence_field"), self.previous_sentence_field_edit)
        self.binder.bind(("profile", "anki", "previous_sentence_field_enabled"), self.previous_sentence_field_enabled_check)
        self.binder.bind(("profile", "anki", "previous_sentence_field_overwrite"), self.previous_sentence_field_overwrite_check)
        self.binder.bind(("profile", "anki", "previous_sentence_field_append"), self.previous_sentence_field_append_check)
        self.binder.bind(("profile", "anki", "previous_image_field"), self.previous_image_field_edit)
        self.binder.bind(("profile", "anki", "previous_image_field_enabled"), self.previous_image_field_enabled_check)
        self.binder.bind(("profile", "anki", "previous_image_field_overwrite"), self.previous_image_field_overwrite_check)
        self.binder.bind(("profile", "anki", "previous_image_field_append"), self.previous_image_field_append_check)
        self.binder.bind(("profile", "anki", "video_field"), self.video_field_edit)
        self.binder.bind(("profile", "anki", "video_field_enabled"), self.video_field_enabled_check)
        self.binder.bind(("profile", "anki", "video_field_overwrite"), self.video_field_overwrite_check)
        self.binder.bind(("profile", "anki", "video_field_append"), self.video_field_append_check)
        self.binder.bind(("profile", "anki", "sentence_furigana_field"), self.sentence_furigana_field_edit)
        self.binder.bind(("profile", "anki", "sentence_furigana_field_enabled"), self.sentence_furigana_field_enabled_check)
        self.binder.bind(("profile", "anki", "sentence_furigana_field_overwrite"), self.sentence_furigana_field_overwrite_check)
        self.binder.bind(("profile", "anki", "sentence_furigana_field_append"), self.sentence_furigana_field_append_check)
        self.binder.bind(("profile", "anki", "game_name_field"), self.game_name_field_edit)
        self.binder.bind(("profile", "anki", "game_name_field_enabled"), self.game_name_field_enabled_check)
        self.binder.bind(("profile", "anki", "game_name_field_overwrite"), self.game_name_field_overwrite_check)
        self.binder.bind(("profile", "anki", "game_name_field_append"), self.game_name_field_append_check)
        self.binder.bind(
            ("profile", "audio", "beginning_offset"),
            self.beginning_offset_edit,
            transform=ValueTransform(
                to_model=lambda v: float_from_text(v, 0.0),
                from_model=lambda v: "" if v is None else str(v),
            ),
        )
        self.binder.bind(
            ("profile", "audio", "end_offset"),
            self.end_offset_edit,
            transform=ValueTransform(
                to_model=lambda v: float_from_text(v, 0.0),
                from_model=lambda v: "" if v is None else str(v),
            ),
        )
        self.binder.bind(("profile", "vad", "cut_and_splice_segments"), self.cut_and_splice_segments_check)
        self.binder.bind(
            ("profile", "vad", "splice_padding"),
            self.splice_padding_edit,
            transform=ValueTransform(
                to_model=lambda v: float_from_text(v, 0.0),
                from_model=lambda v: "" if v is None else str(v),
            ),
        )
        self.binder.bind(("profile", "audio", "external_tool"), self.external_tool_edit)
        self.binder.bind(("profile", "features", "open_anki_edit"), self.open_anki_edit_check)
        self.binder.bind(("profile", "features", "open_anki_in_browser"), self.open_anki_browser_check)

    def _is_gsm_cloud_preview_enabled(self) -> bool:
        try:
            return bool(is_gsm_cloud_preview_enabled())
        except Exception:
            return False

    def _is_gsm_cloud_authenticated(self) -> bool:
        return bool((self.gsm_cloud_access_token_edit.text() or "").strip())

    def _format_gsm_cloud_expiry(self, expires_at: int) -> str:
        if not expires_at:
            return ""
        try:
            return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(expires_at)))
        except Exception:
            return ""

    def _set_gsm_cloud_auth_state(self, access_token: str, refresh_token: str, user_id: str, expires_at: int) -> None:
        self.gsm_cloud_access_token_edit.setText(str(access_token or "").strip())
        self.gsm_cloud_refresh_token_edit.setText(str(refresh_token or "").strip())
        self.gsm_cloud_user_id_edit.setText(str(user_id or "").strip())
        try:
            self._gsm_cloud_token_expires_at_value = max(0, int(expires_at or 0))
        except (TypeError, ValueError):
            self._gsm_cloud_token_expires_at_value = 0
        self.gsm_cloud_token_expiry_edit.setText(self._format_gsm_cloud_expiry(self._gsm_cloud_token_expires_at_value))

        if self._is_gsm_cloud_authenticated():
            suffix = f" as {self.gsm_cloud_user_id_edit.text()}" if self.gsm_cloud_user_id_edit.text() else ""
            self.gsm_cloud_status_label.setText(f"Authenticated{suffix}")
        else:
            self.gsm_cloud_status_label.setText("Not authenticated")

        self.gsm_cloud_sign_out_button.setEnabled(self._is_gsm_cloud_authenticated())
        self.gsm_cloud_sync_now_button.setEnabled(
            self._is_gsm_cloud_authenticated() and not self._gsm_cloud_sync_in_progress
        )

    def _get_selected_gsm_cloud_models(self) -> list[str]:
        selected: list[str] = []
        for index in range(self.gsm_cloud_model_list.count()):
            item = self.gsm_cloud_model_list.item(index)
            if item and item.checkState() == Qt.CheckState.Checked:
                model_name = str(item.text() or "").strip()
                if model_name and model_name not in selected:
                    selected.append(model_name)
        return selected or [GSM_CLOUD_DEFAULT_MODEL]

    def _populate_gsm_cloud_models(self, selected_models: list[str] | None) -> None:
        normalized = []
        for model in selected_models or []:
            text = str(model or "").strip()
            if text and text not in normalized:
                normalized.append(text)
        if not normalized:
            normalized = [GSM_CLOUD_DEFAULT_MODEL]

        self.gsm_cloud_model_list.blockSignals(True)
        try:
            self.gsm_cloud_model_list.clear()
            supported_models = [GSM_CLOUD_DEFAULT_MODEL]
            for model_name in supported_models:
                item = QListWidgetItem(model_name)
                item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable | Qt.ItemFlag.ItemIsEnabled)
                item.setCheckState(
                    Qt.CheckState.Checked if model_name in normalized else Qt.CheckState.Unchecked
                )
                self.gsm_cloud_model_list.addItem(item)

            if all(
                self.gsm_cloud_model_list.item(i).checkState() != Qt.CheckState.Checked
                for i in range(self.gsm_cloud_model_list.count())
            ):
                first_item = self.gsm_cloud_model_list.item(0)
                if first_item:
                    first_item.setCheckState(Qt.CheckState.Checked)
        finally:
            self.gsm_cloud_model_list.blockSignals(False)

    def _get_available_ai_providers(self) -> list[str]:
        providers = [AI_GEMINI, AI_GROQ, AI_OPENAI, AI_OLLAMA, AI_LM_STUDIO]
        if self._is_gsm_cloud_preview_enabled() and self._is_gsm_cloud_authenticated():
            providers.append(AI_GSM_CLOUD)
        return providers

    def _refresh_ai_provider_options(self, preferred_provider: str | None = None) -> None:
        providers = self._get_available_ai_providers()
        if not providers:
            providers = [AI_GEMINI]

        desired_provider = str(preferred_provider or self.ai_provider_combo.currentText() or "").strip()
        if desired_provider not in providers:
            desired_provider = AI_GEMINI if AI_GEMINI in providers else providers[0]

        self.ai_provider_combo.blockSignals(True)
        try:
            self.ai_provider_combo.clear()
            self.ai_provider_combo.addItems(providers)
            self.ai_provider_combo.setCurrentText(desired_provider)
        finally:
            self.ai_provider_combo.blockSignals(False)
        self._update_ai_provider_visibility()

    def _get_gsm_cloud_api_base_url(self) -> str:
        base_url = str(self.gsm_cloud_api_url_edit.text() or "").strip().rstrip("/")
        if not base_url:
            base_url = "https://api.gamesentenceminer.com"
        return base_url

    def _get_gsm_cloud_auth_base_url(self) -> str:
        base_url = str(self.gsm_cloud_auth_url_edit.text() or "").strip().rstrip("/")
        if not base_url:
            base_url = "https://auth.gamesentenceminer.com"
        return base_url

    def _clear_gsm_cloud_auth_poll_state(self) -> None:
        self._gsm_cloud_auth_session_id = ""
        self._gsm_cloud_auth_secret = ""
        self._gsm_cloud_auth_deadline = 0.0
        self._gsm_cloud_auth_poll_timer.stop()

    def _on_gsm_cloud_authenticate_clicked(self) -> None:
        if not self._is_gsm_cloud_preview_enabled():
            QMessageBox.warning(self, "GSM Cloud", "GSM Cloud preview is currently disabled.")
            return
        if self._gsm_cloud_auth_poll_timer.isActive():
            # Allow re-starting auth while a previous session is still polling.
            self._clear_gsm_cloud_auth_poll_state()
            self.gsm_cloud_status_label.setText("Restarting browser authentication...")

        auth_base = self._get_gsm_cloud_auth_base_url()
        client_id = str(self.gsm_cloud_client_id_edit.text() or "").strip() or "gsm-desktop"
        try:
            response = requests.post(
                f"{auth_base}/gsm-cloud/session/start",
                json={"client_id": client_id},
                timeout=12,
            )
            if response.status_code >= 400:
                raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
            payload = response.json()
            session_id = str(payload.get("session_id") or "").strip()
            session_secret = str(payload.get("session_secret") or "").strip()
            auth_url = str(payload.get("auth_url") or "").strip()
            if not session_id or not session_secret or not auth_url:
                raise RuntimeError("Auth start response is missing required fields.")

            self._gsm_cloud_auth_session_id = session_id
            self._gsm_cloud_auth_secret = session_secret
            self._gsm_cloud_auth_deadline = time.time() + self._GSM_CLOUD_AUTH_TIMEOUT_SECONDS
            self.gsm_cloud_status_label.setText("Waiting for browser authentication...")
            self._gsm_cloud_auth_poll_timer.start()
            webbrowser.open(auth_url)
        except Exception as exc:
            self._clear_gsm_cloud_auth_poll_state()
            QMessageBox.warning(self, "GSM Cloud", f"Failed to start authentication: {exc}")

    def _poll_gsm_cloud_auth_status(self) -> None:
        if not self._gsm_cloud_auth_session_id or not self._gsm_cloud_auth_secret:
            self._clear_gsm_cloud_auth_poll_state()
            return
        if self._gsm_cloud_auth_deadline and time.time() > self._gsm_cloud_auth_deadline:
            self._clear_gsm_cloud_auth_poll_state()
            self.gsm_cloud_status_label.setText("Authentication timed out.")
            QMessageBox.warning(self, "GSM Cloud", "Authentication timed out. Please try again.")
            return

        auth_base = self._get_gsm_cloud_auth_base_url()
        try:
            response = requests.get(
                f"{auth_base}/gsm-cloud/session/status/{self._gsm_cloud_auth_session_id}",
                params={"secret": self._gsm_cloud_auth_secret},
                timeout=10,
            )
            if response.status_code == 404:
                # Session may still be propagating/expired. Keep polling until timeout.
                return
            if response.status_code >= 400:
                raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")

            payload = response.json()
            status = str(payload.get("status") or "").strip().lower()
            if status in {"pending", "started"}:
                return

            self._clear_gsm_cloud_auth_poll_state()
            if status == "authenticated":
                access_token = str(payload.get("access_token") or "").strip()
                refresh_token = str(payload.get("refresh_token") or "").strip()
                user_id = str(payload.get("user_id") or "").strip()
                expires_at = payload.get("expires_at")
                if not expires_at:
                    expires_in = int(payload.get("expires_in") or 0)
                    expires_at = int(time.time()) + max(0, expires_in)
                self._set_gsm_cloud_auth_state(access_token, refresh_token, user_id, int(expires_at or 0))
                self._refresh_ai_provider_options(preferred_provider=AI_GSM_CLOUD)
                self.request_auto_save(immediate=True)
                return

            error_message = str(payload.get("error") or "Authentication failed.")
            self.gsm_cloud_status_label.setText(error_message)
            QMessageBox.warning(self, "GSM Cloud", error_message)
        except Exception as exc:
            self._clear_gsm_cloud_auth_poll_state()
            self.gsm_cloud_status_label.setText("Authentication failed.")
            QMessageBox.warning(self, "GSM Cloud", f"Failed while polling authentication: {exc}")

    def _on_gsm_cloud_sign_out_clicked(self) -> None:
        self._clear_gsm_cloud_auth_poll_state()
        self._set_gsm_cloud_auth_state("", "", "", 0)
        if self.ai_provider_combo.currentText() == AI_GSM_CLOUD:
            self._refresh_ai_provider_options(preferred_provider=AI_GEMINI)
        else:
            self._refresh_ai_provider_options()
        self.request_auto_save(immediate=True)

    def _on_gsm_cloud_sync_now_clicked(self) -> None:
        if self._gsm_cloud_sync_in_progress:
            return
        if not self._is_gsm_cloud_authenticated():
            QMessageBox.warning(self, "GSM Cloud Sync", "Authenticate with GSM Cloud before running sync.")
            return

        reply = QMessageBox.question(
            self,
            "GSM Cloud Sync",
            "Run a full sync using your local DB now?\n"
            "This queues current local lines and may take a while on large databases.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.Yes,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # Save latest token/API URL edits before sync reads runtime config.
        self._flush_pending_auto_save()
        if not self.save_settings(show_indicator=False, force_backup=False, immediate_reload=True):
            QMessageBox.warning(self, "GSM Cloud Sync", "Could not save current settings before sync.")
            return

        sync_status = cloud_sync_service.get_status()
        include_existing = bool(
            int(sync_status.get("since_seq", 0) or 0) == 0
            and int(sync_status.get("pending_changes", 0) or 0) == 0
        )

        self._gsm_cloud_sync_in_progress = True
        self.gsm_cloud_sync_now_button.setEnabled(False)
        self.gsm_cloud_sync_now_button.setText("Syncing...")
        if include_existing:
            self.gsm_cloud_status_label.setText("Running initial GSM Cloud sync...")
        else:
            self.gsm_cloud_status_label.setText("Running incremental GSM Cloud sync...")

        threading.Thread(
            target=lambda: self._run_gsm_cloud_sync_worker(include_existing),
            daemon=True,
        ).start()

    def _run_gsm_cloud_sync_worker(self, include_existing: bool) -> None:
        try:
            result = cloud_sync_service.sync_once(
                manual=True,
                include_existing=include_existing,
                max_rounds=None,
            )
        except Exception as exc:
            result = {
                "status": "error",
                "last_error": str(exc),
            }
        self._gsm_cloud_sync_finished_signal.emit(dict(result or {}))

    def _on_gsm_cloud_sync_finished(self, result: dict) -> None:
        self._gsm_cloud_sync_in_progress = False
        self.gsm_cloud_sync_now_button.setText("Sync Local DB Now")
        self.gsm_cloud_sync_now_button.setEnabled(self._is_gsm_cloud_authenticated())

        status = str(result.get("status") or "").strip().lower()
        if status == "success":
            sent = int(result.get("sent_changes", 0) or 0)
            received = int(result.get("received_changes", 0) or 0)
            queued_existing = int(result.get("queued_existing", 0) or 0)
            since_seq = int(result.get("since_seq", 0) or 0)
            stop_reason = str(result.get("stop_reason") or "").strip()
            stop_suffix = "" if not stop_reason else f" ({stop_reason})"
            self.gsm_cloud_status_label.setText(
                f"Sync complete. Queued {queued_existing} local lines, "
                f"sent {sent}, received {received}, cursor {since_seq}{stop_suffix}."
            )
            QMessageBox.information(
                self,
                "GSM Cloud Sync",
                "Sync complete.\n"
                f"Queued local lines: {queued_existing}\n"
                f"Sent changes: {sent}\n"
                f"Received changes: {received}\n"
                f"Cursor: {since_seq}\n"
                f"Stop reason: {stop_reason or 'completed'}",
            )
            return

        reason = str(
            result.get("last_error")
            or result.get("reason")
            or "Unknown error."
        ).strip()
        if status == "skipped":
            self.gsm_cloud_status_label.setText(f"Sync skipped: {reason}")
            QMessageBox.warning(self, "GSM Cloud Sync", f"Sync skipped: {reason}")
            return

        self.gsm_cloud_status_label.setText("Sync failed.")
        QMessageBox.warning(self, "GSM Cloud Sync", f"Sync failed: {reason}")

    def _on_gsm_cloud_model_item_changed(self, _item=None) -> None:
        if self._autosave_suspended:
            return
        has_checked = any(
            self.gsm_cloud_model_list.item(i).checkState() == Qt.CheckState.Checked
            for i in range(self.gsm_cloud_model_list.count())
        )
        if not has_checked:
            first_item = self.gsm_cloud_model_list.item(0)
            if first_item:
                with QSignalBlocker(self.gsm_cloud_model_list):
                    first_item.setCheckState(Qt.CheckState.Checked)
        self.request_auto_save()

    def _create_tabs(self):
        tabs_i18n = self.i18n.get('tabs', {})
        text_filter_title = tabs_i18n.get('text_processing', {}).get('title', 'Text Filtering')
        if text_filter_title == 'Text Processing':
            text_filter_title = 'Text Filtering'
        self.tab_widget.setTabPosition(QTabWidget.TabPosition.West)
        self.tab_widget.addTab(
            self._wrap_tab_in_scroll_area(self._create_required_settings_tab()),
            tabs_i18n.get('key_settings', {}).get('title', 'Key Settings'),
        )

        general_subtabs = self._create_subtab_widget([
            (self._create_general_tab(), tabs_i18n.get('general', {}).get('title', 'General')),
            (self._create_paths_tab(), tabs_i18n.get('paths', {}).get('title', 'Paths')),
            (self._create_discord_tab(), 'Discord'),
            (self._create_text_processing_tab(), text_filter_title),
        ])
        self.tab_widget.addTab(general_subtabs, tabs_i18n.get('general', {}).get('title', 'General'))

        anki_subtabs = self._create_subtab_widget([
            (self._create_anki_general_tab(), 'General'),
            (self._create_anki_confirmation_tab(), 'Confirmation'),
            (self._create_anki_tags_tab(), 'Tags'),
        ])
        self.tab_widget.addTab(anki_subtabs, tabs_i18n.get('anki', {}).get('title', 'Anki'))

        self.tab_widget.addTab(
            self._wrap_tab_in_scroll_area(self._create_screenshot_tab()),
            tabs_i18n.get('screenshot', {}).get('title', 'Screenshot'),
        )

        audio_subtabs = self._create_subtab_widget([
            (self._create_audio_tab(), tabs_i18n.get('audio', {}).get('title', 'Audio')),
            (self._create_vad_tab(), tabs_i18n.get('vad', {}).get('title', 'Voice Detection')),
        ])
        self.tab_widget.addTab(audio_subtabs, tabs_i18n.get('audio', {}).get('title', 'Audio'))

        self.tab_widget.addTab(self._wrap_tab_in_scroll_area(self._create_obs_tab()), tabs_i18n.get('obs', {}).get('title', 'OBS'))
        ai_subtabs = self._create_subtab_widget([
            (self._create_ai_tab(), tabs_i18n.get('general', {}).get('title', 'General')),
            (self._create_ai_prompts_tab(), 'Prompts'),
        ])
        self.tab_widget.addTab(ai_subtabs, tabs_i18n.get('ai', {}).get('title', 'AI / Translation'))
        if self._is_gsm_cloud_preview_enabled():
            self.tab_widget.addTab(
                self._wrap_tab_in_scroll_area(self._create_gsm_cloud_tab()),
                tabs_i18n.get('gsm_cloud', {}).get('title', 'GSM Cloud'),
            )
        self.overlay_tab_index = self.tab_widget.addTab(
            self._wrap_tab_in_scroll_area(self._create_overlay_tab()),
            tabs_i18n.get('overlay', {}).get('title', 'Overlay'),
        )

        advanced_subtabs = self._create_subtab_widget([
            (self._create_advanced_tab(), tabs_i18n.get('advanced', {}).get('title', 'Advanced')),
            (self._create_experimental_tab(), tabs_i18n.get('experimental', {}).get('title', 'Experimental')),
        ])
        self.tab_widget.addTab(advanced_subtabs, tabs_i18n.get('advanced', {}).get('title', 'Advanced'))

        self.tab_widget.addTab(
            self._wrap_tab_in_scroll_area(self._create_profiles_tab()),
            tabs_i18n.get('profiles', {}).get('title', 'Profiles'),
        )

    def _configure_tab_widgets(self):
        self.tab_widget.setObjectName("ConfigRootTabs")
        root_tab_bar = HorizontalTextTabBar()
        root_tab_bar.setObjectName("ConfigRootTabBar")
        root_tab_bar.setDrawBase(False)
        self.tab_widget.setTabBar(root_tab_bar)
        self.tab_widget.setDocumentMode(True)
        self.tab_widget.setStyleSheet(self._get_root_tabs_style())

    def _create_subtab_widget(self, tabs):
        sub_tab_widget = QTabWidget()
        sub_tab_widget.setObjectName("ConfigSubTabs")
        sub_tab_widget.setDocumentMode(True)
        sub_tab_widget.tabBar().setObjectName("ConfigSubTabBar")
        sub_tab_widget.tabBar().setDrawBase(False)
        sub_tab_widget.setStyleSheet(self._get_sub_tabs_style())
        for widget, title in tabs:
            sub_tab_widget.addTab(self._wrap_tab_in_scroll_area(widget), title)
        return sub_tab_widget

    def _wrap_tab_in_scroll_area(self, widget):
        if widget.layout():
            widget.layout().setSizeConstraint(QLayout.SizeConstraint.SetMinimumSize)
        widget.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        scroll_area = QScrollArea()
        scroll_area.setWidgetResizable(True)
        scroll_area.setFrameShape(QFrame.Shape.NoFrame)
        scroll_area.setWidget(widget)
        return scroll_area

    def _create_button_bar(self):
        # Clear existing button bar if it exists
        if hasattr(self, 'button_bar_widget') and self.button_bar_widget:
            self.main_layout.removeWidget(self.button_bar_widget)
            self.button_bar_widget.deleteLater()

        self.button_bar_widget = QWidget()
        button_layout = QHBoxLayout(self.button_bar_widget)
        button_layout.addStretch(1)

        buttons_i18n = self.i18n.get('buttons', {})
        autosave_label = QLabel(buttons_i18n.get('autosave', 'Changes are saved automatically.'))
        autosave_label.setStyleSheet("color: #9ca7ba;")
        button_layout.addWidget(autosave_label)
        self.sync_changes_check = None

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
        try:
            self.tab_widget.currentChanged.disconnect(self._on_root_tab_changed)
        except TypeError:
            pass

        # Disconnect first to avoid multiple connections on reload
        try:
            self.profile_combo.currentIndexChanged.disconnect()
            self.locale_combo.currentIndexChanged.disconnect()
            self.obs_scene_list.itemSelectionChanged.disconnect()
            self.ffmpeg_audio_preset_combo.currentTextChanged.disconnect()
            self.anki_note_type_combo.currentIndexChanged.disconnect()
            if self.anki_note_type_combo.lineEdit():
                self.anki_note_type_combo.lineEdit().editingFinished.disconnect()
            if hasattr(self, "req_note_type_combo"):
                self.req_note_type_combo.currentIndexChanged.disconnect()
                if self.req_note_type_combo.lineEdit():
                    self.req_note_type_combo.lineEdit().editingFinished.disconnect()
            if hasattr(self, 'anki_fields_refresh_button'):
                self.anki_fields_refresh_button.clicked.disconnect()
            self.video_field_edit.currentTextChanged.disconnect()
            self.obs_recording_fps_spin.valueChanged.disconnect()
            self.animated_fps_spin.valueChanged.disconnect()
            self.animated_screenshot_check.stateChanged.disconnect()
            self.gsm_cloud_authenticate_button.clicked.disconnect()
            self.gsm_cloud_sign_out_button.clicked.disconnect()
            self.gsm_cloud_sync_now_button.clicked.disconnect()
            self.gsm_cloud_model_list.itemChanged.disconnect()
        except TypeError:
            pass # Signals were not connected yet

        # Connect signals
        self.profile_combo.currentIndexChanged.connect(self._on_profile_changed)
        self.locale_combo.currentIndexChanged.connect(self._on_locale_changed)
        self.obs_scene_list.itemSelectionChanged.connect(self._on_obs_scene_selection_changed)
        self.ffmpeg_audio_preset_combo.currentTextChanged.connect(self._on_ffmpeg_preset_changed)
        self.anki_note_type_combo.currentIndexChanged.connect(lambda: self._on_anki_note_type_changed(self.anki_note_type_combo.currentText()))
        if self.anki_note_type_combo.lineEdit():
            self.anki_note_type_combo.lineEdit().editingFinished.connect(lambda: self._on_anki_note_type_changed(self.anki_note_type_combo.currentText()))
        if hasattr(self, "req_note_type_combo"):
            self.req_note_type_combo.currentIndexChanged.connect(
                lambda: self._on_anki_note_type_changed(self.req_note_type_combo.currentText())
            )
            if self.req_note_type_combo.lineEdit():
                self.req_note_type_combo.lineEdit().editingFinished.connect(
                    lambda: self._on_anki_note_type_changed(self.req_note_type_combo.currentText())
                )
        if hasattr(self, 'anki_fields_refresh_button'):
            self.anki_fields_refresh_button.clicked.connect(self._on_anki_fields_refresh_clicked)
        
        # Connect signals for animated settings visibility
        self.animated_screenshot_check.stateChanged.connect(self._update_animated_settings_visibility)
        self.video_field_edit.currentTextChanged.connect(self._update_animated_settings_visibility)
        
        # Connect signals for Discord settings visibility
        self.discord_enabled_check.stateChanged.connect(self._update_discord_settings_visibility)
        
        # Connect signals for AI provider visibility
        self.ai_provider_combo.currentTextChanged.connect(self._update_ai_provider_visibility)
        
        # Connect signal for game pausing warning
        self.process_pausing_enabled_check.stateChanged.connect(self._handle_game_pausing_toggle)
        self.obs_recording_fps_spin.valueChanged.connect(self._update_obs_recording_fps_warning)
        self.obs_recording_fps_spin.valueChanged.connect(self._sync_obs_recording_fps_with_animated)
        self.animated_fps_spin.valueChanged.connect(self._sync_obs_recording_fps_with_animated)
        self.animated_screenshot_check.stateChanged.connect(self._sync_obs_recording_fps_with_animated)
        self.gsm_cloud_authenticate_button.clicked.connect(self._on_gsm_cloud_authenticate_clicked)
        self.gsm_cloud_sign_out_button.clicked.connect(self._on_gsm_cloud_sign_out_clicked)
        self.gsm_cloud_sync_now_button.clicked.connect(self._on_gsm_cloud_sync_now_clicked)
        self.gsm_cloud_model_list.itemChanged.connect(self._on_gsm_cloud_model_item_changed)
        self.tab_widget.currentChanged.connect(self._on_root_tab_changed)
        self._connect_anki_field_policy_signals()
        self._connect_autosave_signals()

    def _anki_field_policy_pairs(self):
        return [
            (self.sentence_field_overwrite_check, self.sentence_field_append_check),
            (self.sentence_audio_field_overwrite_check, self.sentence_audio_field_append_check),
            (self.picture_field_overwrite_check, self.picture_field_append_check),
            (self.previous_sentence_field_overwrite_check, self.previous_sentence_field_append_check),
            (self.previous_image_field_overwrite_check, self.previous_image_field_append_check),
            (self.video_field_overwrite_check, self.video_field_append_check),
            (self.sentence_furigana_field_overwrite_check, self.sentence_furigana_field_append_check),
            (self.game_name_field_overwrite_check, self.game_name_field_append_check),
        ]

    def _apply_anki_field_policy_states(self):
        for overwrite_check, append_check in self._anki_field_policy_pairs():
            if overwrite_check.isChecked():
                with QSignalBlocker(append_check):
                    append_check.setChecked(False)
            if append_check.isChecked():
                with QSignalBlocker(overwrite_check):
                    overwrite_check.setChecked(False)
            append_check.setEnabled(not overwrite_check.isChecked())
            overwrite_check.setEnabled(not append_check.isChecked())

        for core_enabled_check in (
            self.sentence_field_enabled_check,
            self.sentence_audio_field_enabled_check,
            self.picture_field_enabled_check,
        ):
            with QSignalBlocker(core_enabled_check):
                core_enabled_check.setChecked(True)
            core_enabled_check.setEnabled(False)

    def _connect_anki_field_policy_signals(self):
        if getattr(self, "_anki_field_policy_signals_connected", False):
            self._apply_anki_field_policy_states()
            return

        for overwrite_check, append_check in self._anki_field_policy_pairs():
            overwrite_check.stateChanged.connect(self._apply_anki_field_policy_states)
            append_check.stateChanged.connect(self._apply_anki_field_policy_states)

        self._anki_field_policy_signals_connected = True
        self._apply_anki_field_policy_states()
    
    def _create_anki_field_combo(self):
        combo = QComboBox()
        combo.setEditable(True)
        combo.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        return combo
    
    def _update_animated_settings_visibility(self):
        """Shows/hides animated screenshot settings based on animated checkbox or video field."""
        should_show = self.animated_screenshot_check.isChecked() or bool(self.video_field_edit.currentText().strip())
        self.animated_settings_group.setVisible(should_show)
    
    def _update_discord_settings_visibility(self):
        """Shows/hides Discord settings based on enabled checkbox."""
        self.discord_settings_container.setVisible(self.discord_enabled_check.isChecked())

    def _update_obs_recording_fps_warning(self, *_):
        fps = self.obs_recording_fps_spin.value()
        lock_min = self.obs_recording_fps_spin.minimum()
        if self.animated_screenshot_check.isChecked() and lock_min > 1 and fps <= lock_min:
            self.obs_recording_fps_warning_label.setText(
                f"Locked by Animated Screenshot FPS: OBS recording FPS cannot go below {lock_min} while Animated Screenshots are enabled."
            )
            self.obs_recording_fps_warning_label.setStyleSheet(
                "color: #8ecae6; background-color: rgba(142, 202, 230, 0.14); border: 1px solid #8ecae6; padding: 6px; border-radius: 4px;"
            )
            return

        if fps < 10:
            self.obs_recording_fps_warning_label.setText(
                "Experimental: under 10 FPS can hurt OCR timing/clarity and miss short lines."
            )
            self.obs_recording_fps_warning_label.setStyleSheet(
                "color: #ffb347; background-color: rgba(255, 179, 71, 0.14); border: 1px solid #ffb347; padding: 6px; border-radius: 4px;"
            )
            return
        if fps > 30:
            self.obs_recording_fps_warning_label.setText(
                "High FPS warning: over 30 is usually wasted resources unless you also record gameplay for content creation."
            )
            self.obs_recording_fps_warning_label.setStyleSheet(
                "color: #ff6b6b; background-color: rgba(255, 107, 107, 0.14); border: 1px solid #ff6b6b; padding: 6px; border-radius: 4px;"
            )
            return

        self.obs_recording_fps_warning_label.setText("Recommended range for GSM-only capture: 10-30 FPS (default: 15).")
        self.obs_recording_fps_warning_label.setStyleSheet(
            "color: #8bc34a; background-color: rgba(139, 195, 74, 0.14); border: 1px solid #8bc34a; padding: 6px; border-radius: 4px;"
        )

    def _sync_obs_recording_fps_with_animated(self, *_):
        if self.animated_screenshot_check.isChecked():
            animated_fps = self.animated_fps_spin.value()
            self.obs_recording_fps_spin.setMinimum(max(1, animated_fps))
            self.obs_recording_fps_spin.setToolTip(
                f"Animated Screenshots are enabled, so OBS FPS is locked to {animated_fps}+."
            )
            if self.obs_recording_fps_spin.value() < animated_fps:
                self.obs_recording_fps_spin.setValue(animated_fps)
        else:
            self.obs_recording_fps_spin.setMinimum(1)
            self.obs_recording_fps_spin.setToolTip("")

        self._update_obs_recording_fps_warning()
    
    def _handle_game_pausing_toggle(self, state):
        """Handles the game pausing enabled checkbox toggle with warning confirmation."""
        if self.process_pausing_enabled_check.isChecked():  # Qt.CheckState.Checked
            if not self._show_game_pausing_warning():
                self.process_pausing_enabled_check.setChecked(False)

    def _anki_invoke(self, action, **params):
        url = (self.anki_url_edit.text() or get_config().anki.url).strip()
        payload = {"action": action, "version": 6, "params": params}
        headers = {"Content-Type": "application/json"}
        response = requests.post(url, json=payload, headers=headers, timeout=8)
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict) or "error" not in data or "result" not in data:
            raise RuntimeError(f"Unexpected AnkiConnect response: {data}")
        if data["error"]:
            raise RuntimeError(data["error"])
        return data["result"]

    def _set_available_anki_fields(self, fields, preserve_selection=True):
        if not fields:
            fields = []
        self._anki_available_fields = list(fields)
        combos = [
            self.sentence_field_edit,
            self.sentence_audio_field_edit,
            self.picture_field_edit,
            self.word_field_edit,
            self.previous_sentence_field_edit,
            self.previous_image_field_edit,
            self.video_field_edit,
            self.sentence_furigana_field_edit,
            self.game_name_field_edit,
            self.ai_anki_field_edit,
        ]
        if hasattr(self, "req_sentence_field_edit"):
            combos.append(self.req_sentence_field_edit)
        if hasattr(self, "req_sentence_audio_field_edit"):
            combos.append(self.req_sentence_audio_field_edit)
        if hasattr(self, "req_picture_field_edit"):
            combos.append(self.req_picture_field_edit)
        if hasattr(self, "req_word_field_edit"):
            combos.append(self.req_word_field_edit)
        for combo in combos:
            current = combo.currentText()
            combo.blockSignals(True)
            combo.clear()
            combo.addItems(fields)
            if preserve_selection and current:
                combo.setCurrentText(current)
            else:
                combo.setCurrentIndex(-1)
                if combo.lineEdit():
                    combo.lineEdit().clear()
            combo.blockSignals(False)

    def _refresh_anki_model_list(self, preserve_selection=True):
        models = self._anki_invoke("modelNames")
        if not isinstance(models, list):
            models = []
        current = self.anki_note_type_combo.currentText()
        self.anki_note_type_combo.blockSignals(True)
        self.anki_note_type_combo.clear()
        self.anki_note_type_combo.addItems(models)
        selected = current if preserve_selection and current in models else (models[0] if models else "")
        if selected:
            self.anki_note_type_combo.setCurrentText(selected)
        self.anki_note_type_combo.blockSignals(False)
        
        # Do the same for req_note_type_combo
        if hasattr(self, "req_note_type_combo"):
            current_req = self.req_note_type_combo.currentText()
            self.req_note_type_combo.blockSignals(True)
            self.req_note_type_combo.clear()
            self.req_note_type_combo.addItems(models)
            selected_req = current_req if preserve_selection and current_req in models else (models[0] if models else "")
            if selected_req:
                self.req_note_type_combo.setCurrentText(selected_req)
            self.req_note_type_combo.blockSignals(False)
        
        return selected

    def _refresh_anki_fields_for_model(self, model_name, preserve_selection=True):
        if not model_name:
            return []
        fields = self._anki_invoke("modelFieldNames", modelName=model_name)
        if not isinstance(fields, list):
            fields = []
        self._set_available_anki_fields(fields, preserve_selection=preserve_selection)
        return fields

    def _on_anki_note_type_changed(self, note_type):
        if self._suppress_anki_field_refresh:
            return
        if note_type == self._last_anki_note_type_refresh:
            return
        self._last_anki_note_type_refresh = note_type
        try:
            if note_type:
                self._refresh_anki_fields_for_model(note_type, preserve_selection=True)
        except Exception as e:
            logger.debug(f"Failed to refresh Anki fields for model '{note_type}': {e}")

    def _on_anki_fields_refresh_clicked(self):
        try:
            selected_model = self._refresh_anki_model_list(preserve_selection=True)
            if not selected_model:
                QMessageBox.warning(self, "Anki", "No note types found in Anki.")
                return
            self._refresh_anki_fields_for_model(selected_model, preserve_selection=True)
        except Exception as e:
            QMessageBox.warning(self, "Anki", f"Failed to refresh fields: {e}")

    # --- Individual Tab Creation Methods ---
    def _create_required_settings_tab(self):
        return build_required_tab(self, self.binder, self.i18n)

    def _create_general_tab(self):
        return build_general_tab(self, self.binder, self.i18n)

    def _create_discord_tab(self):
        return build_discord_tab(self, self.binder, self.i18n)

    def _create_text_processing_tab(self):
        return build_text_processing_tab(self, self.binder, self.i18n)

    def _create_paths_tab(self):
        return build_paths_tab(self, self.i18n)

    def _create_anki_general_tab(self):
        return build_anki_general_tab(self, self.i18n)

    def _create_anki_confirmation_tab(self):
        return build_anki_confirmation_tab(self, self.i18n)

    def _create_anki_tags_tab(self):
        return build_anki_tags_tab(self, self.i18n)

    def _create_vad_tab(self):
        return build_vad_tab(self, self.i18n)

    def _create_screenshot_tab(self):
        return build_screenshot_tab(self, self.i18n)

    def _create_audio_tab(self):
        return build_audio_tab(self, self.i18n)

    def _create_obs_tab(self):
        return build_obs_tab(self, self.i18n)

    def _create_ai_tab(self):
        return build_ai_tab(self, self.i18n)

    def _create_ai_prompts_tab(self):
        return build_ai_prompts_tab(self, self.i18n)

    def _create_gsm_cloud_tab(self):
        return build_gsm_cloud_tab(self, self.i18n)

    def _create_overlay_tab(self):
        return build_overlay_tab(self, self.i18n)

    def _create_experimental_tab(self):
        return build_experimental_tab(self, self.i18n)

    def _show_game_pausing_warning(self):
        warning_msg = (
            "Enabling Game Pausing can lead to system instability, "
            "data loss, or crashes. Use at your own risk. "
            "Any games that have online components or anti-cheat mechanisms may result in bans or other negative consequences if paused improperly. "
            "Do NOT enable this feature unless you fully understand the implications."
        )
        reply = QMessageBox.question(
            self, 
            "Game Pausing Warning", 
            warning_msg,
            QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel
        )
        return reply == QMessageBox.StandardButton.Ok

    def _create_advanced_tab(self):
        return build_advanced_tab(self, self.i18n)

    def _create_profiles_tab(self):
        return build_profiles_tab(self, self.i18n)

    # --- UI Population and Data Loading ---
    def load_settings_to_ui(self):
        """Populates all UI widgets with data from the current self.settings object."""
        s = self.settings # shorthand
        
        # General + Discord are now handled via bindings.
        self._update_string_replacement_rules_count(s.text_processing.string_replacement.rules)
        self.string_replacement_edit_button.setEnabled(s.text_processing.string_replacement.enabled)

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
        self.anki_confirmation_always_on_top_check.setChecked(bool(getattr(s.anki, "confirmation_always_on_top", True)))
        self.anki_confirmation_focus_on_show_check.setChecked(bool(getattr(s.anki, "confirmation_focus_on_show", True)))
        self.anki_confirmation_autoplay_audio_check.setChecked(bool(s.anki.autoplay_audio))
        self.anki_confirmation_replay_audio_on_tts_generation_check.setChecked(
            bool(getattr(s.anki, "replay_audio_on_tts_generation", True))
        )
        self.anki_url_edit.setText(s.anki.url)
        self._suppress_anki_field_refresh = True
        self.anki_note_type_combo.setCurrentText(s.anki.note_type)
        try:
            self._refresh_anki_model_list(preserve_selection=True)
        except Exception as e:
            logger.debug(f"Failed to load Anki note types: {e}")
        self._set_available_anki_fields(s.anki.available_fields, preserve_selection=False)
        self.sentence_field_edit.setCurrentText(s.anki.sentence_field)
        self.sentence_audio_field_edit.setCurrentText(s.anki.sentence_audio_field)
        self.picture_field_edit.setCurrentText(s.anki.picture_field)
        self.word_field_edit.setCurrentText(s.anki.word_field)
        self.previous_sentence_field_edit.setCurrentText(s.anki.previous_sentence_field)
        self.previous_image_field_edit.setCurrentText(s.anki.previous_image_field)
        self.game_name_field_edit.setCurrentText(s.anki.game_name_field)
        self.video_field_edit.setCurrentText(s.anki.video_field)
        self.sentence_furigana_field_edit.setCurrentText(s.anki.sentence_furigana_field)
        self.sentence_field_enabled_check.setChecked(s.anki.sentence_field_enabled)
        self.sentence_field_overwrite_check.setChecked(s.anki.sentence_field_overwrite)
        self.sentence_field_append_check.setChecked(s.anki.sentence_field_append)
        self.sentence_audio_field_enabled_check.setChecked(s.anki.sentence_audio_field_enabled)
        self.sentence_audio_field_overwrite_check.setChecked(s.anki.sentence_audio_field_overwrite)
        self.sentence_audio_field_append_check.setChecked(s.anki.sentence_audio_field_append)
        self.picture_field_enabled_check.setChecked(s.anki.picture_field_enabled)
        self.picture_field_overwrite_check.setChecked(s.anki.picture_field_overwrite)
        self.picture_field_append_check.setChecked(s.anki.picture_field_append)
        self.previous_sentence_field_enabled_check.setChecked(s.anki.previous_sentence_field_enabled)
        self.previous_sentence_field_overwrite_check.setChecked(s.anki.previous_sentence_field_overwrite)
        self.previous_sentence_field_append_check.setChecked(s.anki.previous_sentence_field_append)
        self.previous_image_field_enabled_check.setChecked(s.anki.previous_image_field_enabled)
        self.previous_image_field_overwrite_check.setChecked(s.anki.previous_image_field_overwrite)
        self.previous_image_field_append_check.setChecked(s.anki.previous_image_field_append)
        self.video_field_enabled_check.setChecked(s.anki.video_field_enabled)
        self.video_field_overwrite_check.setChecked(s.anki.video_field_overwrite)
        self.video_field_append_check.setChecked(s.anki.video_field_append)
        self.sentence_furigana_field_enabled_check.setChecked(s.anki.sentence_furigana_field_enabled)
        self.sentence_furigana_field_overwrite_check.setChecked(s.anki.sentence_furigana_field_overwrite)
        self.sentence_furigana_field_append_check.setChecked(s.anki.sentence_furigana_field_append)
        self.game_name_field_enabled_check.setChecked(s.anki.game_name_field_enabled)
        self.game_name_field_overwrite_check.setChecked(s.anki.game_name_field_overwrite)
        self.game_name_field_append_check.setChecked(s.anki.game_name_field_append)
        self._apply_anki_field_policy_states()
        self._suppress_anki_field_refresh = False
        self.custom_tags_edit.setText(', '.join(s.anki.custom_tags))
        self.tags_to_check_edit.setText(', '.join(s.anki.tags_to_check))
        self.add_game_tag_check.setChecked(s.anki.add_game_tag)
        self.parent_tag_edit.setText(s.anki.parent_tag)
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
        self.use_cpu_for_inference_check.setChecked(getattr(s.vad, 'use_cpu_for_inference_v2', s.vad.use_cpu_for_inference))
        self.use_vad_filter_for_whisper_check.setChecked(s.vad.use_vad_filter_for_whisper)
        
        # OBS
        self.obs_open_obs_check.setChecked(s.obs.open_obs)
        self.obs_close_obs_check.setChecked(s.obs.close_obs)
        self.obs_path_edit.setText(s.obs.obs_path)
        self.obs_host_edit.setText(s.obs.host)
        self.obs_port_edit.setText(str(s.obs.port))
        self.obs_password_edit.setText(s.obs.password)
        self.automatically_manage_replay_buffer_check.setChecked(s.obs.automatically_manage_replay_buffer)
        self.obs_recording_fps_spin.setValue(max(1, min(120, getattr(s.obs, "recording_fps", 15))))
        self.obs_disable_desktop_audio_on_connect_check.setChecked(getattr(s.obs, "disable_desktop_audio_on_connect", False))
        self._sync_obs_recording_fps_with_animated()
        
        # AI
        self.ai_enabled_check.setChecked(s.ai.add_to_anki)
        self.gemini_model_combo.clear()
        self.gemini_model_combo.addItems(RECOMMENDED_GEMINI_MODELS)
        self.gemini_model_combo.setCurrentText(s.ai.gemini_model)
        self.gemini_backup_model_combo.clear()
        self.gemini_backup_model_combo.addItems([OFF] + RECOMMENDED_GEMINI_MODELS)
        self.gemini_backup_model_combo.setCurrentText(s.ai.gemini_backup_model or OFF)
        self.gemini_api_key_edit.setText(s.ai.gemini_api_key)
        self.groq_model_combo.clear()
        self.groq_model_combo.addItems(RECOMMENDED_GROQ_MODELS)
        self.groq_model_combo.setCurrentText(s.ai.groq_model)
        self.groq_backup_model_combo.clear()
        self.groq_backup_model_combo.addItems([OFF] + RECOMMENDED_GROQ_MODELS)
        self.groq_backup_model_combo.setCurrentText(s.ai.groq_backup_model or OFF)
        self.groq_api_key_edit.setText(s.ai.groq_api_key)
        self.open_ai_url_edit.setText(s.ai.open_ai_url)
        self.open_ai_model_edit.setText(s.ai.open_ai_model)
        self.open_ai_backup_model_edit.setText(s.ai.open_ai_backup_model)
        self.open_ai_api_key_edit.setText(s.ai.open_ai_api_key)
        self.gsm_cloud_api_url_edit.setText(s.ai.gsm_cloud_api_url)
        self.gsm_cloud_auth_url_edit.setText(s.ai.gsm_cloud_auth_url)
        self.gsm_cloud_client_id_edit.setText(s.ai.gsm_cloud_client_id)
        self._set_gsm_cloud_auth_state(
            s.ai.gsm_cloud_access_token,
            s.ai.gsm_cloud_refresh_token,
            s.ai.gsm_cloud_user_id,
            s.ai.gsm_cloud_token_expires_at,
        )
        self._populate_gsm_cloud_models(s.ai.gsm_cloud_models)
        self._refresh_ai_provider_options(preferred_provider=s.ai.provider)
        self.ollama_url_edit.setText(s.ai.ollama_url)
        self.ollama_backup_model_combo.clear()
        initial_ollama_models = [OFF]
        if s.ai.ollama_model:
            initial_ollama_models.append(s.ai.ollama_model)
        if s.ai.ollama_backup_model:
            initial_ollama_models.append(s.ai.ollama_backup_model)
        self.ollama_backup_model_combo.addItems(list(dict.fromkeys(initial_ollama_models)))
        self.ollama_model_combo.setCurrentText(s.ai.ollama_model)
        self.ollama_backup_model_combo.setCurrentText(s.ai.ollama_backup_model or OFF)
        self.lm_studio_url_edit.setText(s.ai.lm_studio_url)
        self.lm_studio_backup_model_combo.clear()
        initial_lm_models = [OFF]
        if s.ai.lm_studio_model:
            initial_lm_models.append(s.ai.lm_studio_model)
        if s.ai.lm_studio_backup_model:
            initial_lm_models.append(s.ai.lm_studio_backup_model)
        self.lm_studio_backup_model_combo.addItems(list(dict.fromkeys(initial_lm_models)))
        self.lm_studio_model_combo.setCurrentText(s.ai.lm_studio_model)
        self.lm_studio_backup_model_combo.setCurrentText(s.ai.lm_studio_backup_model or OFF)
        self.lm_studio_api_key_edit.setText(s.ai.lm_studio_api_key)
        self.ai_anki_field_edit.setCurrentText(s.ai.anki_field)
        self.ai_dialogue_context_length_edit.setText(str(s.ai.dialogue_context_length))
        self.ai_temperature_edit.setText(str(s.ai.temperature))
        self.ai_max_output_tokens_edit.setText(str(s.ai.max_output_tokens))
        self.ai_top_p_edit.setText(str(s.ai.top_p))
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

        # Safety / Experimental
        experimental_cfg = getattr(self.master_config, 'experimental', Experimental())
        self.experimental_features_enabled_check.setChecked(experimental_cfg.enable_experimental_features)
        process_cfg = getattr(self.master_config, 'process_pausing', ProcessPausing())
        self.process_pausing_enabled_check.setChecked(process_cfg.enabled)
        self.process_pausing_auto_resume_seconds_edit.setValue(process_cfg.auto_resume_seconds)
        self.process_pausing_require_game_exe_match_check.setChecked(True)  # Always true
        self.process_pausing_require_game_exe_match_check.setEnabled(False)  # Always disabled
        self.process_pausing_overlay_manual_hotkey_requests_pause_check.setChecked(
            bool(getattr(process_cfg, "overlay_manual_hotkey_requests_pause", False))
        )
        self.process_pausing_overlay_texthooker_hotkey_requests_pause_check.setChecked(
            bool(getattr(process_cfg, "overlay_texthooker_hotkey_requests_pause", False))
        )
        self.process_pausing_allowlist_edit.setText(", ".join(process_cfg.allowlist))
        self.process_pausing_denylist_edit.setText(", ".join(process_cfg.denylist))
        self.process_pause_hotkey_edit.setKeySequence(QKeySequence(s.hotkeys.process_pause or ""))
        
        # Advanced
        self.audio_player_path_edit.setText(s.advanced.audio_player_path)
        self.video_player_path_edit.setText(s.advanced.video_player_path)
        self.play_latest_audio_hotkey_edit.setKeySequence(QKeySequence(s.hotkeys.play_latest_audio or ""))
        self.multi_line_line_break_edit.setText(s.advanced.multi_line_line_break)
        self.multi_line_sentence_storage_field_edit.setText(s.advanced.multi_line_sentence_storage_field)
        self.ocr_websocket_port_edit.setText(str(s.advanced.ocr_websocket_port))
        self.texthooker_communication_websocket_port_edit.setText(str(s.advanced.texthooker_communication_websocket_port))
        self.plaintext_websocket_export_port_edit.setText(str(s.advanced.plaintext_websocket_port))
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

        self.binder.refresh_all()
        self._update_discord_settings_visibility()
        
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
    
    def _create_group_box(self, title, tooltip=None):
        """Helper to create a styled QGroupBox with consistent styling."""
        group = QGroupBox(title)
        group.setStyleSheet(self._get_group_box_style())
        if tooltip:
            group.setToolTip(tooltip)
        return group

    def _update_string_replacement_rules_count(self, rules):
        count = len(rules or [])
        template = (
            self.i18n.get("tabs", {})
            .get("text_processing", {})
            .get("string_replacement", {})
            .get("rules_count", "{count} rules")
        )
        try:
            text = template.format(count=count)
        except Exception:
            text = f"{count} rules"
        self.string_replacement_rules_count_label.setText(text)
        self.string_replacement_edit_button.setEnabled(self.string_replacement_enabled_check.isChecked())
    
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

    def _get_root_tabs_style(self):
        """Returns stylesheet for the left-side primary navigation tabs."""
        return """
            QTabWidget#ConfigRootTabs::pane {
                border: 1px solid #3a4049;
                border-radius: 0px;
                background-color: transparent;
                margin-left: 10px;
            }
            QTabBar#ConfigRootTabBar {
                background: transparent;
                border-right: 1px solid #3a4049;
            }
            QTabBar#ConfigRootTabBar::tab {
                background-color: transparent;
                color: #d7deea;
                border: 0px;
                border-radius: 0px;
                padding: 9px 12px;
                margin: 4px 12px 4px 4px;
                text-align: center;
                min-width: 190px;
                font-size: 12pt;
                font-weight: 600;
            }
            QTabBar#ConfigRootTabBar::tab:hover {
                background-color: #262d38;
                color: #f1f5ff;
            }
            QTabBar#ConfigRootTabBar::tab:selected {
                background-color: rgba(42, 100, 214, 0.28);
                color: #ffffff;
                border-left: 3px solid #82a8ff;
                font-weight: 700;
            }
        """

    def _get_sub_tabs_style(self):
        """Returns stylesheet for horizontal sub-tab groups."""
        return """
            QTabWidget#ConfigSubTabs::pane {
                border: 1px solid #333943;
                border-radius: 10px;
                background-color: rgba(16, 18, 22, 0.72);
                margin-top: 0px;
            }
            QTabBar#ConfigSubTabBar {
                border-bottom: 1px solid #333943;
            }
            QTabBar#ConfigSubTabBar::tab {
                background-color: #1d2229;
                color: #b8bfcc;
                border: 1px solid #333943;
                border-radius: 8px;
                padding: 8px 12px;
                margin: 0 6px 6px 0;
                min-width: 120px;
            }
            QTabBar#ConfigSubTabBar::tab:hover {
                background-color: #272d36;
                color: #e3e8f2;
                border-color: #4a5564;
            }
            QTabBar#ConfigSubTabBar::tab:selected {
                background-color: #285ec7;
                color: #ffffff;
                border-color: #5a84d9;
                font-weight: 600;
            }
        """
    
    def _update_ai_provider_visibility(self):
        """Shows/hides AI provider settings based on selected provider."""
        provider = self.ai_provider_combo.currentText()
        self.gemini_settings_group.setVisible(provider == AI_GEMINI)
        self.groq_settings_group.setVisible(provider == AI_GROQ)
        self.openai_settings_group.setVisible(provider == AI_OPENAI)
        self.gsm_cloud_settings_group.setVisible(provider == AI_GSM_CLOUD)
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
            categories = category if isinstance(category, (list, tuple, set)) else [category]
            for category_name in categories:
                default_category_config = getattr(self.default_settings, category_name)
                setattr(self.settings, category_name, copy.deepcopy(default_category_config))
            self._load_settings_to_ui_safely()
            self.save_settings(force_backup=True, immediate_reload=True)

    # --- Profile & OBS Scene Management ---
    def add_profile(self):
        i18n = self.i18n.get('dialogs', {}).get('add_profile', {})
        name, ok = QInputDialog.getText(self, i18n.get('title', 'Add Profile'), i18n.get('prompt', 'Enter new profile name:'))
        if ok and name:
            self.master_config.configs[name] = self.master_config.get_default_config()
            self.master_config.configs[name].name = name
            self._create_button_bar()
            self._connect_signals()
            self.profile_combo.addItem(name)
            self.profile_combo.setCurrentText(name) # This will trigger the change handler

    def copy_profile(self):
        source_profile = self.profile_combo.currentText()
        i18n = self.i18n.get('dialogs', {}).get('copy_profile', {})
        name, ok = QInputDialog.getText(self, i18n.get('title', 'Copy Profile'), i18n.get('prompt', 'Enter new profile name:'))
        if ok and name and source_profile in self.master_config.configs:
            self.master_config.configs[name] = copy.deepcopy(self.master_config.configs[source_profile])
            self.master_config.configs[name].name = name
            self._create_button_bar()
            self._connect_signals()
            self.profile_combo.addItem(name)
            self.profile_combo.setCurrentText(name)

    def delete_profile(self):
        self._flush_pending_auto_save()
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
            self._create_button_bar()
            self._connect_signals()
            
            self._load_settings_to_ui_safely()
            self._schedule_runtime_reload()
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
        
        previous_suspend = self._autosave_suspended
        self._autosave_suspended = True
        self.obs_scene_list.clear()
        self.discord_blacklisted_scenes_list.clear()
        try:
            scenes = obs.get_obs_scenes()
            if not scenes:
                logger.debug("OBS scenes not available yet; skipping refresh.")
                return
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
        finally:
            self._autosave_suspended = previous_suspend

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


    def _load_monitors(self, preferred_index=None):
        previous_index = self.overlay_monitor_combo.currentIndex()
        if preferred_index is None:
            preferred_index = self.settings.overlay.monitor_to_capture

        self.overlay_monitor_combo.blockSignals(True)
        try:
            import mss
            self.overlay_monitor_combo.clear()
            with mss.mss() as sct:
                monitors = [f"Monitor {i}" for i, _ in enumerate(sct.monitors[1:], start=1)]
            self.overlay_monitor_combo.addItems(monitors if monitors else ["Monitor 1"])
            if 0 <= preferred_index < self.overlay_monitor_combo.count():
                self.overlay_monitor_combo.setCurrentIndex(preferred_index)
            else:
                self.overlay_monitor_combo.setCurrentIndex(0)
        except (ImportError, Exception) as e:
            logger.warning(f"Could not list monitors: {e}")
            self.overlay_monitor_combo.clear()
            self.overlay_monitor_combo.addItem("Monitor 1")
            self.overlay_monitor_combo.setCurrentIndex(0)
        finally:
            self.overlay_monitor_combo.blockSignals(False)

        if previous_index != self.overlay_monitor_combo.currentIndex() and not self._autosave_suspended:
            self.request_auto_save()

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
        current_gemini_backup = self.gemini_backup_model_combo.currentText()
        current_groq = self.groq_model_combo.currentText()
        current_groq_backup = self.groq_backup_model_combo.currentText()
        current_ollama = self.ollama_model_combo.currentText()
        current_ollama_backup = self.ollama_backup_model_combo.currentText()
        current_lm_studio = self.lm_studio_model_combo.currentText()
        current_lm_studio_backup = self.lm_studio_backup_model_combo.currentText()
        
        # Fetch fresh models from APIs
        self.model_fetcher = AIModelFetcher(self.groq_api_key_edit.text())
        
        if provider == 'gemini':
            gemini_models = self.model_fetcher._get_gemini_models()
            self.gemini_model_combo.clear()
            self.gemini_model_combo.addItems(gemini_models)
            self.gemini_model_combo.setCurrentText(current_gemini)
            self.gemini_backup_model_combo.clear()
            self.gemini_backup_model_combo.addItems([OFF] + [m for m in gemini_models if m not in {OFF, "RECOMMENDED", "OTHER"}])
            self.gemini_backup_model_combo.setCurrentText(current_gemini_backup)
            AIModelsTable.update_models(gemini_models, None, None, None)
        elif provider == 'groq':
            groq_models = self.model_fetcher._get_groq_models()
            self.groq_model_combo.clear()
            self.groq_model_combo.addItems(groq_models)
            self.groq_model_combo.setCurrentText(current_groq)
            self.groq_backup_model_combo.clear()
            self.groq_backup_model_combo.addItems([OFF] + [m for m in groq_models if m not in {OFF, "RECOMMENDED", "OTHER"}])
            self.groq_backup_model_combo.setCurrentText(current_groq_backup)
            AIModelsTable.update_models(None, groq_models, None, None)
        elif provider == 'ollama':
            ollama_models = self.model_fetcher._get_ollama_models()
            self.ollama_model_combo.clear()
            self.ollama_model_combo.addItems(ollama_models)
            self.ollama_model_combo.setCurrentText(current_ollama)
            self.ollama_backup_model_combo.clear()
            self.ollama_backup_model_combo.addItems([OFF] + [m for m in ollama_models if m != OFF])
            self.ollama_backup_model_combo.setCurrentText(current_ollama_backup)
            AIModelsTable.update_models(None, None, ollama_models, None)
        elif provider == 'lm_studio':
            lm_studio_models = self.model_fetcher._get_lm_studio_models()
            self.lm_studio_model_combo.clear()
            self.lm_studio_model_combo.addItems(lm_studio_models)
            self.lm_studio_model_combo.setCurrentText(current_lm_studio)
            self.lm_studio_backup_model_combo.clear()
            self.lm_studio_backup_model_combo.addItems([OFF] + [m for m in lm_studio_models if m != OFF])
            self.lm_studio_backup_model_combo.setCurrentText(current_lm_studio_backup)
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
        current_gemini_backup = self.gemini_backup_model_combo.currentText() if preserve_selection else None
        current_groq = self.groq_model_combo.currentText() if preserve_selection else None
        current_groq_backup = self.groq_backup_model_combo.currentText() if preserve_selection else None
        current_ollama = self.ollama_model_combo.currentText() if preserve_selection else None
        current_ollama_backup = self.ollama_backup_model_combo.currentText() if preserve_selection else None
        current_lm_studio = self.lm_studio_model_combo.currentText() if preserve_selection else None
        current_lm_studio_backup = self.lm_studio_backup_model_combo.currentText() if preserve_selection else None

        def _unique(items):
            seen = set()
            ordered = []
            for item in items or []:
                if not item or item in seen:
                    continue
                ordered.append(item)
                seen.add(item)
            return ordered

        gemini_models = _unique(gemini_models)
        groq_models = _unique(groq_models)
        ollama_models = _unique(ollama_models)
        lm_studio_models = _unique(lm_studio_models)

        self.gemini_model_combo.clear()
        self.gemini_model_combo.addItems(gemini_models)
        backup_gemini_models = [OFF] + [m for m in gemini_models if m not in {OFF, "RECOMMENDED", "OTHER"}]
        self.gemini_backup_model_combo.clear()
        self.gemini_backup_model_combo.addItems(_unique(backup_gemini_models))

        self.groq_model_combo.clear()
        self.groq_model_combo.addItems(groq_models)
        backup_groq_models = [OFF] + [m for m in groq_models if m not in {OFF, "RECOMMENDED", "OTHER"}]
        self.groq_backup_model_combo.clear()
        self.groq_backup_model_combo.addItems(_unique(backup_groq_models))
        if ollama_models:
            self.ollama_model_combo.clear()
            self.ollama_model_combo.addItems(ollama_models)
            self.ollama_backup_model_combo.clear()
            self.ollama_backup_model_combo.addItems(_unique([OFF] + [m for m in ollama_models if m != OFF]))
        if lm_studio_models:
            self.lm_studio_model_combo.clear()
            self.lm_studio_model_combo.addItems(lm_studio_models)
            self.lm_studio_backup_model_combo.clear()
            self.lm_studio_backup_model_combo.addItems(_unique([OFF] + [m for m in lm_studio_models if m != OFF]))
            
        # Restore previous selection
        if preserve_selection:
            if current_gemini:
                self.gemini_model_combo.setCurrentText(current_gemini)
            if current_gemini_backup:
                self.gemini_backup_model_combo.setCurrentText(current_gemini_backup)
            if current_groq:
                self.groq_model_combo.setCurrentText(current_groq)
            if current_groq_backup:
                self.groq_backup_model_combo.setCurrentText(current_groq_backup)
            if current_ollama:
                self.ollama_model_combo.setCurrentText(current_ollama)
            if current_ollama_backup:
                self.ollama_backup_model_combo.setCurrentText(current_ollama_backup)
            if current_lm_studio:
                self.lm_studio_model_combo.setCurrentText(current_lm_studio)
            if current_lm_studio_backup:
                self.lm_studio_backup_model_combo.setCurrentText(current_lm_studio_backup)
        else:
            self.gemini_model_combo.setCurrentText(self.settings.ai.gemini_model)
            self.gemini_backup_model_combo.setCurrentText(self.settings.ai.gemini_backup_model or OFF)
            self.groq_model_combo.setCurrentText(self.settings.ai.groq_model)
            self.groq_backup_model_combo.setCurrentText(self.settings.ai.groq_backup_model or OFF)
            self.ollama_model_combo.setCurrentText(self.settings.ai.ollama_model)
            self.ollama_backup_model_combo.setCurrentText(self.settings.ai.ollama_backup_model or OFF)
            self.lm_studio_model_combo.setCurrentText(self.settings.ai.lm_studio_model)
            self.lm_studio_backup_model_combo.setCurrentText(self.settings.ai.lm_studio_backup_model or OFF)

    def closeEvent(self, event):
        self.hide_window()
        event.ignore()

if __name__ == '__main__':
    app = QApplication(sys.argv)
    
    # Install custom style to make tooltips appear faster (50ms instead of ~700ms)
    app.setStyle(FastToolTipStyle())
    
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

