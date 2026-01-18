# import asyncio
# import copy
# import json
# import os
# import subprocess
# import sys
# import time
# import re
# import tkinter as tk
# from tkinter import filedialog, messagebox, simpledialog, scrolledtext, font
# from PIL import Image, ImageTk

# import pyperclipfix as pyperclip
# import ttkbootstrap as ttk

# from GameSentenceMiner import obs
# from GameSentenceMiner.ui.anki_confirmation import AnkiConfirmationDialog
# from GameSentenceMiner.ui.screenshot_selector_qt import show_screenshot_selector  # from GameSentenceMiner.ui.screenshot_selector import ScreenshotSelectorDialog
# from GameSentenceMiner.util import configuration
# from GameSentenceMiner.util.configuration import Config, Locale, logger, CommonLanguages, ProfileConfig, General, Paths, \
#     Anki, Features, Screenshot, Audio, OBS, Hotkeys, VAD, Overlay, Ai, Advanced, OverlayEngine, get_app_directory, \
#     get_config, is_beangate, AVAILABLE_LANGUAGES, WHISPER_LARGE, WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, \
#     WHISPER_MEDIUM, WHISPER_TURBO, SILERO, WHISPER, OFF, gsm_state, DEFAULT_CONFIG, get_latest_version, \
#     get_current_version, AI_GEMINI, AI_GROQ, AI_OPENAI, save_full_config, get_default_anki_media_collection_path
# from GameSentenceMiner.util.db import AIModelsTable
# from GameSentenceMiner.util.downloader.download_tools import download_ocenaudio_if_needed
    
# settings_saved = False
# on_save = []
# exit_func = None
# RECOMMENDED_GROQ_MODELS = ['meta-llama/llama-4-maverick-17b-128e-instruct',
#                         'meta-llama/llama-4-scout-17b-16e-instruct',
#                         'llama-3.1-8b-instant', 
#                         'qwen/qwen3-32b',
#                         'openai/gpt-oss-120b']
# RECOMMENDED_GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemma-3-27b-it"]


# # It's assumed that a file named 'en_us.json' exists in the same directory
# # or a path that Python can find.
# def load_localization(locale=Locale.English):
#     """Loads the localization file."""
#     try:
#         # Use a path relative to this script file
#         script_dir = os.path.dirname(os.path.abspath(__file__))
#         lang_file = os.path.join(script_dir, '..', 'locales', f'{locale.value}.json')
#         with open(lang_file, 'r', encoding='utf-8') as f:
#             return json.load(f)['python']['config']
#     except (FileNotFoundError, json.JSONDecodeError) as e:
#         print(f"Warning: Could not load localization file '{locale.value}.json'. Error: {e}. Falling back to empty dict.")
#         return {}


# def new_tab(func):
#     def wrapper(self, *args, **kwargs):
#         self.current_row = 0  # Resetting row for the new tab
#         # Perform any other pre-initialization tasks here if needed
#         return func(self, *args, **kwargs)

#     return wrapper


# class HoverInfoWidget:
#     def __init__(self, parent, text, row, column, padx=5, pady=2):
#         self.info_icon = ttk.Label(parent, text="ⓘ", foreground="blue", cursor="hand2")
#         self.info_icon.grid(row=row, column=column, padx=padx, pady=pady)
#         self.info_icon.bind("<Enter>", lambda e: self.show_info_box(text))
#         self.info_icon.bind("<Leave>", lambda e: self.hide_info_box())
#         self.tooltip = None
        
#     def change_text(self, text):
#         """
#         Change the text of the info icon.
#         """
#         if self.tooltip:
#             self.tooltip.destroy()
#             self.tooltip = None
#         self.info_icon.config(text=text)

#     def show_info_box(self, text):
#         x, y, _, _ = self.info_icon.bbox("insert")
#         x += self.info_icon.winfo_rootx() + 25
#         y += self.info_icon.winfo_rooty() + 20
#         self.tooltip = tk.Toplevel(self.info_icon)
#         self.tooltip.wm_overrideredirect(True)
#         self.tooltip.wm_geometry(f"+{x}+{y}")
#         label = ttk.Label(self.tooltip, text=text, relief="solid", borderwidth=1,
#                           font=("tahoma", "12", "normal"))
#         label.pack(ipadx=1)

#     def hide_info_box(self):
#         if self.tooltip:
#             self.tooltip.destroy()
#             self.tooltip = None


# class HoverInfoLabelWidget:
#     def __init__(self, parent, text, tooltip, row, column, padx=5, pady=2, foreground="white", sticky='W',
#                  bootstyle=None, font=("Arial", 10, "normal"), apply_to_parent=False, columnspan=1):
#         self.label_text_value = ttk.StringVar(value=text)
#         self.label = ttk.Label(parent, textvariable=self.label_text_value, foreground=foreground, cursor="hand2", bootstyle=bootstyle, font=font)
#         self.label.grid(row=row, column=column, padx=(0, padx), pady=0, sticky=sticky, columnspan=columnspan)
#         self.label.bind("<Enter>", lambda e: self.show_info_box(tooltip))
#         self.label.bind("<Leave>", lambda e: self.hide_info_box())
#         self.tooltip = None

#     def show_info_box(self, text):
#         x, y, _, _ = self.label.bbox("insert")
#         x += self.label.winfo_rootx() + 25
#         y += self.label.winfo_rooty() + 20
#         self.tooltip = tk.Toplevel(self.label)
#         self.tooltip.wm_overrideredirect(True)
#         self.tooltip.wm_geometry(f"+{x}+{y}")
#         label = ttk.Label(self.tooltip, text=text, relief="solid", borderwidth=1,
#                           font=("tahoma", "12", "normal"))
#         label.pack(ipadx=1)

#     def hide_info_box(self):
#         if self.tooltip:
#             self.tooltip.destroy()
#             self.tooltip = None
            
# class HoverInfoEntryWidget:
#     def __init__(self, parent, text, row, column, padx=5, pady=2, textvariable=None):
#         self.entry = ttk.Entry(parent, textvariable=textvariable)
#         self.entry.grid(row=row, column=column, padx=padx, pady=pady)
#         self.entry.bind("<Enter>", lambda e: self.show_info_box(text))
#         self.entry.bind("<Leave>", lambda e: self.hide_info_box())
#         self.tooltip = None

#     def show_info_box(self, text):
#         x, y, _, _ = self.entry.bbox("insert")
#         x += self.entry.winfo_rootx() + 25
#         y += self.entry.winfo_rooty() + 20
#         self.tooltip = tk.Toplevel(self.entry)
#         self.tooltip.wm_overrideredirect(True)
#         self.tooltip.wm_geometry(f"+{x}+{y}")
#         label = ttk.Label(self.tooltip, text=text, relief="solid", borderwidth=1,
#                           font=("tahoma", "12", "normal"))
#         label.pack(ipadx=1)

#     def hide_info_box(self):
#         if self.tooltip:
#             self.tooltip.destroy()
#             self.tooltip = None


# class ResetToDefaultButton(ttk.Button):
#     def __init__(self, parent, command, text="Reset to Default", tooltip_text="Reset settings", bootstyle="danger", **kwargs):
#         super().__init__(parent, text=text, command=command, bootstyle=bootstyle, **kwargs)
#         self.tooltip_text = tooltip_text
#         self.tooltip = None
#         self.bind("<Enter>", self.show_tooltip)
#         self.bind("<Leave>", self.hide_tooltip)

#     def show_tooltip(self, event):
#         if not self.tooltip:
#             x = self.winfo_rootx() + 20
#             y = self.winfo_rooty() + 20
#             self.tooltip = tk.Toplevel(self)
#             self.tooltip.wm_overrideredirect(True)
#             self.tooltip.wm_geometry(f"+{x}+{y}")
#             label = ttk.Label(self.tooltip, text=self.tooltip_text, relief="solid",
#                               borderwidth=1,
#                               font=("tahoma", "12", "normal"))
#             label.pack(ipadx=1)

#     def hide_tooltip(self, event):
#         if self.tooltip:
#             self.tooltip.destroy()
#             self.tooltip = None

# class ConfigApp:
#     def __init__(self, root):
#         self.window = root
#         self.on_exit = None
#         self.window.tk.call('tk', 'scaling', 1.5)  # Set DPI scaling factor
#         self.window.protocol("WM_DELETE_WINDOW", self.hide)
#         self.obs_scene_listbox_changed = False
#         self.test_func = None

#         self.current_row = 0

#         self.master_config: Config = configuration.load_config()
#         self.i18n = load_localization(self.master_config.get_locale())
        
#         self.window.title(self.i18n.get('app', {}).get('title', 'GameSentenceMiner Configuration'))

#         self.settings = self.master_config.get_config()
#         self.default_master_settings = Config.new()
#         self.default_settings = self.default_master_settings.get_config()

#         self.notebook = ttk.Notebook(self.window)
#         self.notebook.pack(pady=10, expand=True, fill='both')
        
#         self.required_settings_frame = None
#         self.starter_tab = None
#         self.general_tab = None
#         self.paths_tab = None
#         self.anki_tab = None
#         self.vad_tab = None
#         self.features_tab = None
#         self.screenshot_tab = None
#         self.audio_tab = None
#         self.obs_tab = None
#         self.profiles_tab = None
#         self.ai_tab = None
#         self.advanced_tab = None
#         self.overlay_tab = None
#         self.wip_tab = None
#         self.monitors = []
        
#         try:
#             import mss as mss
#             self.monitors = [f"Monitor {i}: width: {monitor['width']}, height: {monitor['height']}" for i, monitor in enumerate(mss.mss().monitors[1:], start=1)]
#             if len(self.monitors) == 0:
#                 self.monitors = [1]
#         except ImportError:
#             self.monitors = []

#         self.create_vars()
#         self.create_tabs()
#         self.get_online_models()
#         self.notebook.bind("<<NotebookTabChanged>>", self.on_profiles_tab_selected)

#         button_frame = ttk.Frame(self.window)
#         button_frame.pack(side="bottom", pady=20, anchor="center")
        
#         buttons_i18n = self.i18n.get('buttons', {})
#         self.save_button = ttk.Button(button_frame, text=buttons_i18n.get('save', 'Save Settings'), command=self.save_settings, bootstyle="success")
#         self.save_button.grid(row=0, column=0, padx=10)
        
#         if len(self.master_config.configs) > 1:
#             self.sync_changes_var = tk.BooleanVar(value=False)
#             sync_btn_i18n = buttons_i18n.get('sync_changes', {})
#             self.sync_changes_checkbutton = ttk.Checkbutton(
#                 button_frame,
#                 text=sync_btn_i18n.get('label', 'Sync Changes to Profiles'),
#                 variable=self.sync_changes_var,
#                 bootstyle="info"
#             )
#             self.sync_changes_checkbutton.grid(row=0, column=1, padx=10)
#             self.sync_changes_hover_info = HoverInfoWidget(
#                 button_frame,
#                 sync_btn_i18n.get('tooltip', 'Syncs CHANGED SETTINGS to all profiles.'),
#                 row=0,
#                 column=2
#             )

#         self.window.update_idletasks()
#         self.window.geometry("")
#         self.window.withdraw()
        
#         # Start checking for OBS error messages
#         self.check_obs_errors()
    
#     def check_obs_errors(self):
#         """Check for queued error messages from OBS and display them."""
#         try:
#             from GameSentenceMiner import obs
#             errors = obs.get_queued_gui_errors()
#             for title, message, recheck_func in errors:
#                 if recheck_func is not None:
#                     if recheck_func():
#                         continue  # Issue resolved, don't show error
#                 messagebox.showerror(title, message)
#         except Exception as e:
#             # Don't let error checking crash the GUI
#             logger.debug(f"Error checking OBS error queue: {e}")
        
#         # Schedule the next check in 1 second
#         self.window.after(1000, self.check_obs_errors)
    
#     def change_locale(self):
#         """Change the locale of the application."""
#         if self.locale_value.get() == self.master_config.get_locale().name:
#             return
#         self.i18n = load_localization(Locale[self.locale_value.get()])
#         self.save_settings()
#         self.reload_settings(force_refresh=True)
        
#         self.window.title(self.i18n.get('app', {}).get('title', 'GameSentenceMiner Configuration'))
#         self.save_button.config(text=self.i18n.get('buttons', {}).get('save', 'Save Settings'))
#         if hasattr(self, 'sync_changes_checkbutton'):
#             self.sync_changes_checkbutton.config(text=self.i18n.get('buttons', {}).get('sync_changes', {}).get('label', 'Sync Changes to Profiles'))

#         logger.info(f"Locale changed to {self.locale_value.get()}.")

#     def set_test_func(self, func):
#         self.test_func = func
        
#     def show_anki_confirmation_dialog(self, expression, sentence, screenshot_path, audio_path, translation, ss_timestamp):
#         """
#         Displays a modal dialog for the user to confirm Anki card details and
#         choose whether to include audio.

#         Args:
#             expression (str): The target word or expression.
#             sentence (str): The full sentence.
#             screenshot_path (str): The file path to the screenshot image.
#             audio_path (str): The file path to the audio clip.
#             translation (str): The translation or definition.

#         Returns:
#             str: 'voice' if the user chooses to add with voice,
#                  'no_voice' if they choose to add without voice,
#                  or None if they cancel.
#         """
#         dialog = AnkiConfirmationDialog(self.window,
#                                         self,
#                                         expression=expression,
#                                         sentence=sentence,
#                                         screenshot_path=screenshot_path,
#                                         audio_path=audio_path,
#                                         translation=translation,
#                                         screenshot_timestamp=ss_timestamp)
#         return dialog.result
    
#     def show_screenshot_selector_tkinter(self, video_path, timestamp, mode='beginning'):
#         """
#         Displays a modal dialog for the user to select the best screenshot from
#         a series of extracted video frames.

#         Args:
#             video_path (str): The file path to the source video.
#             timestamp (str or float): The timestamp (in seconds) around which to extract frames.
#             mode (str): 'beginning', 'middle', or 'end'. Determines the time offset
#                         and which frame is highlighted as the "golden" frame.

#         Returns:
#             str: The file path of the image the user selected, or None if they canceled.
#         """
#         # Qt implementation - non-modal with callback
#         result_container = {'path': None}
        
#         def on_complete(selected_path):
#             result_container['path'] = selected_path
        
#         show_screenshot_selector(self, self, video_path, str(timestamp), mode, on_complete)  # from GameSentenceMiner.ui.screenshot_selector: dialog = ScreenshotSelectorDialog(self.window, self, video_path=video_path, timestamp=str(timestamp), mode=mode)
        
#         # For compatibility with existing code expecting synchronous behavior
#         # This won't work well with Qt's async nature, but maintains the interface
#         return result_container['path']
    
    
#     # IMPLEMENT LATER,FOR NOW JUST RUN THE FILE
#     # def show_furigana_filter_selector(self, current_sensitivity):
#     #     """
#     #     Displays a modal dialog for the user to select the furigana filter sensitivity.

#     #     Args:
#     #         current_sensitivity (int): The current sensitivity setting.
#     #     Returns: int: The selected sensitivity setting, or None if canceled.
#     #     """
#     #     dialog = FuriganaFilterSelectorDialog(self.window,
#     #                                           self,
#     #                                           current_sensitivity=current_sensitivity)
#     #     return dialog.selected_sensitivity

#     def show_minimum_character_size_selector(self, current_size):
#         """
#         Opens an external tool for selecting the minimum character size.

#         Args:
#             current_sensitivity (int): The current sensitivity setting.
#         Returns: int: The selected sensitivity setting, or None if canceled.
#         """
#         from GameSentenceMiner.ui.furigana_filter_preview_qt import show_furigana_filter_preview  # from GameSentenceMiner.tools.furigana_filter_preview subprocess.run
        
#         result_container = {'sensitivity': None}
        
#         def on_complete(selected_sensitivity):
#             result_container['sensitivity'] = selected_sensitivity
        
#         # show_furigana_filter_preview will get the screenshot internally
#         show_furigana_filter_preview(current_sensitivity=current_size, title_suffix="OBS", on_complete=on_complete)
        
#         # For compatibility with existing code expecting synchronous behavior
#         return result_container['sensitivity']

#     def create_vars(self):
#         """
#         Initializes all the tkinter variables used in the configuration GUI.
#         """
#         # General Settings
#         self.websocket_enabled_value = tk.BooleanVar(value=self.settings.general.use_websocket)
#         self.clipboard_enabled_value = tk.BooleanVar(value=self.settings.general.use_clipboard)
#         self.use_both_clipboard_and_websocket_value = tk.BooleanVar(value=self.settings.general.use_both_clipboard_and_websocket)
#         self.merge_matching_sequential_text_value = tk.BooleanVar(value=self.settings.general.merge_matching_sequential_text)
#         self.websocket_uri_value = tk.StringVar(value=self.settings.general.websocket_uri)
#         self.texthook_replacement_regex_value = tk.StringVar(value=self.settings.general.texthook_replacement_regex)
#         self.open_config_on_startup_value = tk.BooleanVar(value=self.settings.general.open_config_on_startup)
#         self.open_multimine_on_startup_value = tk.BooleanVar(value=self.settings.general.open_multimine_on_startup)
#         self.texthooker_port_value = tk.StringVar(value=str(self.settings.general.texthooker_port))
#         self.native_language_value = tk.StringVar(value=CommonLanguages.from_code(self.settings.general.native_language).name.replace('_', ' ').title())

#         # OBS Settings
#         self.obs_websocket_port_value = tk.StringVar(value=str(self.settings.obs.port))
#         self.obs_host_value = tk.StringVar(value=self.settings.obs.host)
#         self.obs_port_value = tk.StringVar(value=str(self.settings.obs.port))
#         self.obs_password_value = tk.StringVar(value=self.settings.obs.password)
#         self.obs_open_obs_value = tk.BooleanVar(value=self.settings.obs.open_obs)
#         self.obs_close_obs_value = tk.BooleanVar(value=self.settings.obs.close_obs)
#         self.obs_path_value = tk.StringVar(value=self.settings.obs.obs_path)
#         self.obs_minimum_replay_size_value = tk.StringVar(value=str(self.settings.obs.minimum_replay_size))
#         self.automatically_manage_replay_buffer_value = tk.BooleanVar(value=self.settings.obs.automatically_manage_replay_buffer)
        
#         # Paths Settings
#         self.folder_to_watch_value = tk.StringVar(value=self.settings.paths.folder_to_watch)
#         self.output_folder_value = tk.StringVar(value=self.settings.paths.output_folder)
#         self.copy_temp_files_to_output_folder_value = tk.BooleanVar(value=self.settings.paths.copy_temp_files_to_output_folder)
#         self.open_output_folder_on_card_creation_value = tk.BooleanVar(value=self.settings.paths.open_output_folder_on_card_creation)
#         self.copy_trimmed_replay_to_output_folder_value = tk.BooleanVar(value=self.settings.paths.copy_trimmed_replay_to_output_folder)
#         self.remove_video_value = tk.BooleanVar(value=self.settings.paths.remove_video)
#         self.remove_audio_value = tk.BooleanVar(value=self.settings.paths.remove_audio)
#         self.remove_screenshot_value = tk.BooleanVar(value=self.settings.paths.remove_screenshot)

#         # Anki Settings
#         self.update_anki_value = tk.BooleanVar(value=self.settings.anki.update_anki)
#         self.show_update_confirmation_dialog_value = tk.BooleanVar(value=self.settings.anki.show_update_confirmation_dialog)
#         self.anki_url_value = tk.StringVar(value=self.settings.anki.url)
#         self.sentence_field_value = tk.StringVar(value=self.settings.anki.sentence_field)
#         self.sentence_audio_field_value = tk.StringVar(value=self.settings.anki.sentence_audio_field)
#         self.picture_field_value = tk.StringVar(value=self.settings.anki.picture_field)
#         self.word_field_value = tk.StringVar(value=self.settings.anki.word_field)
#         self.previous_sentence_field_value = tk.StringVar(value=self.settings.anki.previous_sentence_field)
#         self.previous_image_field_value = tk.StringVar(value=self.settings.anki.previous_image_field)
#         self.game_name_field_value = tk.StringVar(value=self.settings.anki.game_name_field)
#         self.video_field_value = tk.StringVar(value=self.settings.anki.video_field)
#         self.custom_tags_value = tk.StringVar(value=', '.join(self.settings.anki.custom_tags))
#         self.tags_to_check_value = tk.StringVar(value=', '.join(self.settings.anki.tags_to_check))
#         self.add_game_tag_value = tk.BooleanVar(value=self.settings.anki.add_game_tag)
#         self.polling_rate_value = tk.StringVar(value=str(self.settings.anki.polling_rate))
#         self.overwrite_audio_value = tk.BooleanVar(value=self.settings.anki.overwrite_audio)
#         self.overwrite_picture_value = tk.BooleanVar(value=self.settings.anki.overwrite_picture)
#         self.multi_overwrites_sentence_value = tk.BooleanVar(value=self.settings.anki.multi_overwrites_sentence)
#         self.parent_tag_value = tk.StringVar(value=self.settings.anki.parent_tag)

#         # Features Settings
#         self.full_auto_value = tk.BooleanVar(value=self.settings.features.full_auto)
#         self.notify_on_update_value = tk.BooleanVar(value=self.settings.features.notify_on_update)
#         self.open_anki_edit_value = tk.BooleanVar(value=self.settings.features.open_anki_edit)
#         self.open_anki_browser_value = tk.BooleanVar(value=self.settings.features.open_anki_in_browser)
#         self.browser_query_value = tk.StringVar(value=self.settings.features.browser_query)
#         self.generate_longplay_value = tk.BooleanVar(value=self.settings.features.generate_longplay)
        
#         # Screenshot Settings
#         self.screenshot_enabled_value = tk.BooleanVar(value=self.settings.screenshot.enabled)
#         self.screenshot_width_value = tk.StringVar(value=str(self.settings.screenshot.width))
#         self.screenshot_height_value = tk.StringVar(value=str(self.settings.screenshot.height))
#         self.screenshot_quality_value = tk.StringVar(value=str(self.settings.screenshot.quality))
#         self.screenshot_extension_value = tk.StringVar(value=self.settings.screenshot.extension)
#         self.screenshot_custom_ffmpeg_settings_value = tk.StringVar(value=self.settings.screenshot.custom_ffmpeg_settings)
#         self.screenshot_hotkey_update_anki_value = tk.BooleanVar(value=self.settings.screenshot.screenshot_hotkey_updates_anki)
#         self.seconds_after_line_value = tk.StringVar(value=str(self.settings.screenshot.seconds_after_line))
#         self.screenshot_timing_value = tk.StringVar(value=self.settings.screenshot.screenshot_timing_setting)
#         self.use_screenshot_selector_value = tk.BooleanVar(value=self.settings.screenshot.use_screenshot_selector)
#         self.animated_screenshot_value = tk.BooleanVar(value=self.settings.screenshot.animated)
#         self.trim_black_bars_value = tk.BooleanVar(value=self.settings.screenshot.trim_black_bars_wip)

#         # Audio Settings
#         self.audio_enabled_value = tk.BooleanVar(value=self.settings.audio.enabled)
#         self.audio_extension_value = tk.StringVar(value=self.settings.audio.extension)
#         self.beginning_offset_value = tk.StringVar(value=str(self.settings.audio.beginning_offset))
#         self.end_offset_value = tk.StringVar(value=str(self.settings.audio.end_offset))
#         self.audio_ffmpeg_reencode_options_value = tk.StringVar(value=self.settings.audio.ffmpeg_reencode_options)
#         self.external_tool_value = tk.StringVar(value=self.settings.audio.external_tool)
#         self.anki_media_collection_value = tk.StringVar(value=self.settings.audio.anki_media_collection)
#         self.external_tool_enabled_value = tk.BooleanVar(value=self.settings.audio.external_tool_enabled)
#         self.pre_vad_audio_offset_value = tk.StringVar(value=str(self.settings.audio.pre_vad_end_offset))
        
#         # Hotkeys Settings
#         self.reset_line_hotkey_value = tk.StringVar(value=self.settings.hotkeys.reset_line)
#         self.take_screenshot_hotkey_value = tk.StringVar(value=self.settings.hotkeys.take_screenshot)
#         self.play_latest_audio_hotkey_value = tk.StringVar(value=self.settings.hotkeys.play_latest_audio)
        
#         # VAD Settings
#         self.whisper_model_value = tk.StringVar(value=self.settings.vad.whisper_model)
#         self.do_vad_postprocessing_value = tk.BooleanVar(value=self.settings.vad.do_vad_postprocessing)
#         self.selected_vad_model_value = tk.StringVar(value=self.settings.vad.selected_vad_model)
#         self.backup_vad_model_value = tk.StringVar(value=self.settings.vad.backup_vad_model)
#         self.vad_trim_beginning_value = tk.BooleanVar(value=self.settings.vad.trim_beginning)
#         self.vad_beginning_offset_value = tk.StringVar(value=str(self.settings.vad.beginning_offset))
#         self.add_audio_on_no_results_value = tk.BooleanVar(value=self.settings.vad.add_audio_on_no_results)
#         self.use_tts_as_fallback_value = tk.BooleanVar(value=self.settings.vad.use_tts_as_fallback)
#         self.tts_url_value = tk.StringVar(value=self.settings.vad.tts_url)
#         self.language_value = tk.StringVar(value=self.settings.vad.language)
#         self.cut_and_splice_segments_value = tk.BooleanVar(value=self.settings.vad.cut_and_splice_segments)
#         self.splice_padding_value = tk.StringVar(value=str(self.settings.vad.splice_padding) if self.settings.vad.splice_padding else "")
#         self.use_vad_filter_for_whisper_value = tk.BooleanVar(value=self.settings.vad.use_vad_filter_for_whisper)
        
#         # Advanced Settings
#         self.audio_player_path_value = tk.StringVar(value=self.settings.advanced.audio_player_path)
#         self.video_player_path_value = tk.StringVar(value=self.settings.advanced.video_player_path)
#         self.multi_line_line_break_value = tk.StringVar(value=self.settings.advanced.multi_line_line_break)
#         self.multi_line_sentence_storage_field_value = tk.StringVar(value=self.settings.advanced.multi_line_sentence_storage_field)
#         self.ocr_websocket_port_value = tk.StringVar(value=str(self.settings.advanced.ocr_websocket_port))
#         self.texthooker_communication_websocket_port_value = tk.StringVar(value=str(self.settings.advanced.texthooker_communication_websocket_port))
#         self.plaintext_websocket_export_port_value = tk.StringVar(value=str(self.settings.advanced.plaintext_websocket_port))
#         self.localhost_bind_address_value = tk.StringVar(value=self.settings.advanced.localhost_bind_address)
        
#         # AI Settings
#         self.ai_enabled_value = tk.BooleanVar(value=self.settings.ai.add_to_anki)
#         self.ai_provider_value = tk.StringVar(value=self.settings.ai.provider)
#         self.gemini_model_value = tk.StringVar(value=self.settings.ai.gemini_model)
#         self.use_cpu_for_inference_value = tk.BooleanVar(value=self.settings.vad.use_cpu_for_inference)
#         self.groq_model_value = tk.StringVar(value=self.settings.ai.groq_model)
#         self.gemini_api_key_value = tk.StringVar(value=self.settings.ai.gemini_api_key)
#         self.groq_api_key_value = tk.StringVar(value=self.settings.ai.groq_api_key)
#         self.open_ai_api_key_value = tk.StringVar(value=self.settings.ai.open_ai_api_key)
#         self.open_ai_model_value = tk.StringVar(value=self.settings.ai.open_ai_model)
#         self.open_ai_url_value = tk.StringVar(value=self.settings.ai.open_ai_url)
#         self.ai_anki_field_value = tk.StringVar(value=self.settings.ai.anki_field)
#         self.use_canned_translation_prompt_value = tk.BooleanVar(value=self.settings.ai.use_canned_translation_prompt)
#         self.use_canned_context_prompt_value = tk.BooleanVar(value=self.settings.ai.use_canned_context_prompt)
#         self.ai_dialogue_context_length_value = tk.StringVar(value=str(self.settings.ai.dialogue_context_length))
        
#         # Overlay Settings
#         self.overlay_websocket_port_value = tk.StringVar(value=str(self.settings.overlay.websocket_port))
#         self.overlay_websocket_send_value = tk.BooleanVar(value=self.settings.overlay.monitor_to_capture)
#         self.overlay_engine_value = tk.StringVar(value=self.settings.overlay.engine)
#         self.periodic_value = tk.BooleanVar(value=self.settings.overlay.periodic)
#         self.periodic_ratio_value = tk.StringVar(value=str(self.settings.overlay.periodic_ratio))
#         self.periodic_interval_value = tk.StringVar(value=str(self.settings.overlay.periodic_interval))
#         self.scan_delay_value = tk.StringVar(value=str(self.settings.overlay.scan_delay))
#         self.overlay_minimum_character_size_value = tk.StringVar(value=str(self.settings.overlay.minimum_character_size))
#         self.number_of_local_scans_per_event_value = tk.StringVar(value=str(getattr(self.settings.overlay, 'number_of_local_scans_per_event', 1)))
        
#         # Master Config Settings
#         self.switch_to_default_if_not_found_value = tk.BooleanVar(value=self.master_config.switch_to_default_if_not_found)
#         self.locale_value = tk.StringVar(value=self.master_config.get_locale().name)
        

#     def create_tabs(self):
#         self.create_required_settings_tab()
#         self.create_general_tab()
#         self.create_paths_tab()
#         self.create_anki_tab()
#         self.create_vad_tab()
#         self.create_features_tab()
#         self.create_screenshot_tab()
#         self.create_audio_tab()
#         self.create_obs_tab()
#         self.create_ai_tab()
#         self.create_advanced_tab()
#         self.create_overlay_tab()
#         self.create_profiles_tab()
#         # self.create_wip_tab()

#     def add_reset_button(self, frame, category, row, column=0, recreate_tab=None):
#         """
#         Adds a reset button to the given frame that resets the settings in the frame to default values.
#         """
#         reset_btn_i18n = self.i18n.get('buttons', {}).get('reset_to_default', {})
#         reset_button = ResetToDefaultButton(frame, command=lambda: self.reset_to_default(category, recreate_tab),
#                                             text=reset_btn_i18n.get('text', 'Reset to Default'),
#                                             tooltip_text=reset_btn_i18n.get('tooltip', 'Reset current tab to default.'))
#         reset_button.grid(row=row, column=column, sticky='W', padx=5, pady=5)
#         return reset_button

#     def reset_to_default(self, category, recreate_tab):
#         """
#         Resets the settings in the current tab to default values.
#         """
#         dialog_i18n = self.i18n.get('dialogs', {}).get('reset_to_default', {})
#         if not messagebox.askyesno(dialog_i18n.get('title', 'Reset to Default'),
#                                    dialog_i18n.get('message', 'Are you sure you want to reset all settings in this tab to default?')):
#             return

#         default_category_config = getattr(self.default_settings, category)

#         setattr(self.settings, category, default_category_config)
#         self.create_vars()  # Recreate variables to reflect default values
#         recreate_tab()
#         self.save_settings(profile_change=False)
#         self.reload_settings(force_refresh=True)

#     def show_scene_selection(self, matched_configs):
#         selected_scene = None
#         if matched_configs:
#             dialog_i18n = self.i18n.get('dialogs', {}).get('select_profile', {})
#             buttons_i18n = self.i18n.get('buttons', {})
            
#             selection_window = tk.Toplevel(self.window)
#             selection_window.title(dialog_i18n.get('title', 'Select Profile'))
#             selection_window.transient(self.window)
#             selection_window.grab_set()

#             ttk.Label(selection_window,
#                       text=dialog_i18n.get('message', 'Multiple profiles match... Please select:')).pack(pady=10)
#             profile_var = tk.StringVar(value=matched_configs[0])
#             profile_dropdown = ttk.Combobox(selection_window, textvariable=profile_var, values=matched_configs,
#                                             state="readonly")
#             profile_dropdown.pack(pady=5)
#             ttk.Button(selection_window, text=buttons_i18n.get('ok', 'OK'),
#                        command=lambda: [selection_window.destroy(), setattr(self, 'selected_scene', profile_var.get())],
#                        bootstyle="primary").pack(pady=10)

#             self.window.wait_window(selection_window)
#             selected_scene = self.selected_scene
#         return selected_scene

#     def add_save_hook(self, func):
#         on_save.append(func)

#     def show(self):
#         logger.info("Showing Configuration Window")
#         obs.update_current_game()
#         self.reload_settings()
#         if self.window is not None:
#             self.window.deiconify()
#             self.window.lift()
#             self.window.update_idletasks()
#             return

#     def hide(self):
#         if self.window is not None:
#             self.window.withdraw()

#     def save_settings(self, profile_change=False, sync_changes=False):
#         global settings_saved
        
#         sync_changes = self.sync_changes_checkbutton.instate(['selected']) if hasattr(self, 'sync_changes_checkbutton') else sync_changes
#         # reset checkbox
#         if hasattr(self, 'sync_changes_checkbutton'):
#             self.sync_changes_checkbutton.state(['!selected'])

#         # Create a new Config instance
#         # Validate and clamp periodic_ratio to [0.0, 1.0]
#         try:
#             _periodic_ratio = float(self.periodic_ratio_value.get())
#         except Exception:
#             _periodic_ratio = 0.9
#         # clamp
#         if _periodic_ratio < 0.0:
#             _periodic_ratio = 0.0
#         if _periodic_ratio > 1.0:
#             _periodic_ratio = 1.0
#         # reflect back to UI variable (keep consistent formatting)
#         self.periodic_ratio_value.set(str(_periodic_ratio))

#         # Validate and clamp number_of_local_scans_per_event to positive integer
#         try:
#             _local_scans = int(float(self.number_of_local_scans_per_event_value.get()))
#         except Exception:
#             _local_scans = int(getattr(self.settings.overlay, 'number_of_local_scans_per_event', 1))
#         if _local_scans < 1:
#             _local_scans = 1
#         self.number_of_local_scans_per_event_value.set(str(_local_scans))

#         config = ProfileConfig(
#             scenes=self.settings.scenes,
#             general=General(
#                 use_websocket=self.websocket_enabled_value.get(),
#                 use_clipboard=self.clipboard_enabled_value.get(),
#                 websocket_uri=self.websocket_uri_value.get(),
#                 merge_matching_sequential_text= self.merge_matching_sequential_text_value.get(),
#                 open_config_on_startup=self.open_config_on_startup_value.get(),
#                 open_multimine_on_startup=self.open_multimine_on_startup_value.get(),
#                 texthook_replacement_regex=self.texthook_replacement_regex_value.get(),
#                 use_both_clipboard_and_websocket=self.use_both_clipboard_and_websocket_value.get(),
#                 texthooker_port=int(self.texthooker_port_value.get()),
#                 native_language=CommonLanguages.from_name(self.native_language_value.get()) if self.native_language_value.get() else CommonLanguages.ENGLISH.value,
#             ),
#             paths=Paths(
#                 folder_to_watch=self.folder_to_watch_value.get(),
#                 output_folder=self.output_folder_value.get(),
#                 open_output_folder_on_card_creation=self.open_output_folder_on_card_creation_value.get(),
#                 remove_video=self.remove_video_value.get(),
#                 copy_temp_files_to_output_folder=self.copy_temp_files_to_output_folder_value.get(),
#                 copy_trimmed_replay_to_output_folder=self.copy_trimmed_replay_to_output_folder_value.get()
#             ),
#             anki=Anki(
#                 update_anki=self.update_anki_value.get(),
#                 show_update_confirmation_dialog=self.show_update_confirmation_dialog_value.get(),
#                 url=self.anki_url_value.get(),
#                 sentence_field=self.sentence_field_value.get(),
#                 sentence_audio_field=self.sentence_audio_field_value.get(),
#                 picture_field=self.picture_field_value.get(),
#                 word_field=self.word_field_value.get(),
#                 previous_sentence_field=self.previous_sentence_field_value.get(),
#                 previous_image_field=self.previous_image_field_value.get(),
#                 video_field=self.video_field_value.get(),
#                 game_name_field=self.game_name_field_value.get(),
#                 custom_tags=[tag.strip() for tag in self.custom_tags_value.get().split(',') if tag.strip()],
#                 tags_to_check=[tag.strip().lower() for tag in self.tags_to_check_value.get().split(',') if tag.strip()],
#                 add_game_tag=self.add_game_tag_value.get(),
#                 polling_rate=int(self.polling_rate_value.get()),
#                 overwrite_audio=self.overwrite_audio_value.get(),
#                 overwrite_picture=self.overwrite_picture_value.get(),
#                 multi_overwrites_sentence=self.multi_overwrites_sentence_value.get(),
#                 parent_tag=self.parent_tag_value.get(),
#             ),
#             features=Features(
#                 full_auto=self.full_auto_value.get(),
#                 notify_on_update=self.notify_on_update_value.get(),
#                 open_anki_edit=self.open_anki_edit_value.get(),
#                 open_anki_in_browser=self.open_anki_browser_value.get(),
#                 browser_query=self.browser_query_value.get(),
#                 generate_longplay=self.generate_longplay_value.get(),
#             ),
#             screenshot=Screenshot(
#                 enabled=self.screenshot_enabled_value.get(),
#                 animated=self.animated_screenshot_value.get(),
#                 width=self.screenshot_width_value.get(),
#                 height=self.screenshot_height_value.get(),
#                 quality=self.screenshot_quality_value.get(),
#                 extension=self.screenshot_extension_value.get(),
#                 custom_ffmpeg_settings=self.screenshot_custom_ffmpeg_settings_value.get(),
#                 screenshot_hotkey_updates_anki=self.screenshot_hotkey_update_anki_value.get(),
#                 seconds_after_line=float(self.seconds_after_line_value.get()) if self.seconds_after_line_value.get() else 0.0,
#                 screenshot_timing_setting=self.screenshot_timing_value.get(),
#                 use_screenshot_selector=self.use_screenshot_selector_value.get(),
#                 trim_black_bars_wip=self.trim_black_bars_value.get(),
#             ),
#             audio=Audio(
#                 enabled=self.audio_enabled_value.get(),
#                 extension=self.audio_extension_value.get(),
#                 beginning_offset=float(self.beginning_offset_value.get()),
#                 end_offset=float(self.end_offset_value.get()),
#                 ffmpeg_reencode_options=self.audio_ffmpeg_reencode_options_value.get(),
#                 external_tool=self.external_tool_value.get(),
#                 anki_media_collection=self.anki_media_collection_value.get(),
#                 external_tool_enabled=self.external_tool_enabled_value.get(),
#                 pre_vad_end_offset=float(self.pre_vad_audio_offset_value.get()),
#             ),
#             obs=OBS(
#                 open_obs=self.obs_open_obs_value.get(),
#                 close_obs=self.obs_close_obs_value.get(),
#                 obs_path=self.obs_path_value.get(),
#                 host=self.obs_host_value.get(),
#                 port=int(self.obs_port_value.get()),
#                 password=self.obs_password_value.get(),
#                 minimum_replay_size=int(self.obs_minimum_replay_size_value.get()),
#                 automatically_manage_replay_buffer=self.automatically_manage_replay_buffer_value.get()
#             ),
#             hotkeys=Hotkeys(
#                 reset_line=self.reset_line_hotkey_value.get(),
#                 take_screenshot=self.take_screenshot_hotkey_value.get(),
#                 play_latest_audio=self.play_latest_audio_hotkey_value.get()
#             ),
#             vad=VAD(
#                 whisper_model=self.whisper_model_value.get(),
#                 do_vad_postprocessing=self.do_vad_postprocessing_value.get(),
#                 selected_vad_model=self.selected_vad_model_value.get(),
#                 backup_vad_model=self.backup_vad_model_value.get(),
#                 trim_beginning=self.vad_trim_beginning_value.get(),
#                 beginning_offset=float(self.vad_beginning_offset_value.get()),
#                 add_audio_on_no_results=self.add_audio_on_no_results_value.get(),
#                 use_tts_as_fallback=self.use_tts_as_fallback_value.get(),
#                 tts_url=self.tts_url_value.get(),
#                 language=self.language_value.get(),
#                 cut_and_splice_segments=self.cut_and_splice_segments_value.get(),
#                 splice_padding=float(self.splice_padding_value.get()) if self.splice_padding_value.get() else 0.0,
#                 use_cpu_for_inference=self.use_cpu_for_inference_value.get(),
#                 use_vad_filter_for_whisper=self.use_vad_filter_for_whisper_value.get(),
#             ),
#             advanced=Advanced(
#                 audio_player_path=self.audio_player_path_value.get(),
#                 video_player_path=self.video_player_path_value.get(),
#                 multi_line_line_break=self.multi_line_line_break_value.get(),
#                 multi_line_sentence_storage_field=self.multi_line_sentence_storage_field_value.get(),
#                 ocr_websocket_port=int(self.ocr_websocket_port_value.get()),
#                 texthooker_communication_websocket_port=int(self.texthooker_communication_websocket_port_value.get()),
#                 plaintext_websocket_port=int(self.plaintext_websocket_export_port_value.get()),
#                 localhost_bind_address=self.localhost_bind_address_value.get(),
#             ),
#             ai=Ai(
#                 add_to_anki=self.ai_enabled_value.get(),
#                 provider=self.ai_provider_value.get(),
#                 gemini_model=self.gemini_model_value.get(),
#                 groq_model=self.groq_model_value.get(),
#                 gemini_api_key=self.gemini_api_key_value.get(),
#                 api_key=self.gemini_api_key_value.get(),
#                 groq_api_key=self.groq_api_key_value.get(),
#                 anki_field=self.ai_anki_field_value.get(),
#                 open_ai_api_key=self.open_ai_api_key_value.get(),
#                 open_ai_model=self.open_ai_model_value.get(),
#                 open_ai_url=self.open_ai_url_value.get(),
#                 use_canned_translation_prompt=self.use_canned_translation_prompt_value.get(),
#                 use_canned_context_prompt=self.use_canned_context_prompt_value.get(),
#                 custom_prompt=self.custom_prompt.get("1.0", tk.END).strip(),
#                 dialogue_context_length=int(self.ai_dialogue_context_length_value.get()),
#                 custom_texthooker_prompt=self.custom_texthooker_prompt.get("1.0", tk.END).strip(),
#             ),
#             overlay=Overlay(
#                 websocket_port=int(self.overlay_websocket_port_value.get()),
#                 monitor_to_capture=int(self.overlay_monitor.current() if self.monitors else 0),
#                 engine=OverlayEngine(self.overlay_engine_value.get()).value if self.overlay_engine_value.get() else OverlayEngine.LENS.value,
#                 scan_delay=float(self.scan_delay_value.get()),
#                 periodic=float(self.periodic_value.get()),
#                 periodic_ratio=_periodic_ratio,
#                 periodic_interval=float(self.periodic_interval_value.get()),
#                 number_of_local_scans_per_event=int(self.number_of_local_scans_per_event_value.get()),
#                 minimum_character_size=int(self.overlay_minimum_character_size_value.get()),
#             )
#             # wip=WIP(
#             #     overlay_websocket_port=int(self.overlay_websocket_port_value.get()),
#             #     overlay_websocket_send=self.overlay_websocket_send_value.get(),
#             #     monitor_to_capture=self.monitor_to_capture.current() if self.monitors else 0
#             # )
#         )

#         # Find the display name for "Custom" to check against
#         audio_i18n = self.i18n.get('tabs', {}).get('audio', {})
#         ffmpeg_preset_i18n = audio_i18n.get('ffmpeg_preset', {}).get('options', {})
#         custom_display_name = ffmpeg_preset_i18n.get('custom', 'Custom')

#         if self.ffmpeg_audio_preset_options.get() == custom_display_name:
#             config.audio.custom_encode_settings = self.audio_ffmpeg_reencode_options_value.get()

#         dialog_i18n = self.i18n.get('dialogs', {}).get('config_error', {})
#         error_title = dialog_i18n.get('title', 'Configuration Error')

#         current_profile = self.profile_combobox.get()
#         prev_config = self.master_config.get_config()
#         self.master_config.switch_to_default_if_not_found = self.switch_to_default_if_not_found_value.get()
#         if profile_change:
#             self.master_config.current_profile = current_profile
#         else:
#             self.master_config.current_profile = current_profile
#             self.master_config.set_config_for_profile(current_profile, config)
            
#         self.master_config.locale = Locale[self.locale_value.get()].value
#         self.master_config.overlay = config.overlay


#         config_backup_folder = os.path.join(get_app_directory(), "backup", "config")
#         os.makedirs(config_backup_folder, exist_ok=True)
#         timestamp = time.strftime("%Y-%m-%d_%H-%M-%S")
#         with open(os.path.join(config_backup_folder, f"config_backup_{timestamp}.json"), 'w') as backup_file:
#             backup_file.write(self.master_config.to_json(indent=4))

#         self.master_config = self.master_config.sync_shared_fields()

#         if sync_changes:
#             self.master_config.sync_changed_fields(prev_config)

#         self.master_config.save()

#         logger.info("Settings saved successfully!")

#         if self.master_config.get_config().restart_required(prev_config):
#             logger.info("Restart Required for some settings to take affect!")

#         settings_saved = True
#         configuration.reload_config()
#         self.settings = get_config()
#         for func in on_save:
#             func()

#     def reload_settings(self, force_refresh=False):
#         new_config = configuration.load_config()
#         current_config = new_config.get_config()

#         title_template = self.i18n.get('app', {}).get('title_with_profile', 'GameSentenceMiner Configuration - {profile_name}')
#         self.window.title(title_template.format(profile_name=current_config.name))
        
#         try:
#             import mss as mss
#             self.monitors = [f"Monitor {i}: width: {monitor['width']}, height: {monitor['height']}" for i, monitor in enumerate(mss.mss().monitors[1:], start=1)]
#             if len(self.monitors) == 0:
#                 self.monitors = [1]
#         except ImportError:
#             self.monitors = []

#         if current_config.name != self.settings.name or self.settings.config_changed(current_config) or force_refresh:
#             logger.info("Config changed, reloading settings.")
#             self.master_config = new_config
#             self.settings = current_config
#             for frame in self.notebook.winfo_children():
#                 frame.destroy()

#             self.required_settings_frame = None
#             self.general_tab = None
#             self.paths_tab = None
#             self.anki_tab = None
#             self.vad_tab = None
#             self.features_tab = None
#             self.screenshot_tab = None
#             self.audio_tab = None
#             self.obs_tab = None
#             self.profiles_tab = None
#             self.ai_tab = None
#             self.advanced_tab = None
#             self.overlay_tab = None
#             # self.wip_tab = None

#             self.create_vars()
#             self.create_tabs()

#     def increment_row(self):
#         self.current_row += 1
#         return self.current_row

#     @new_tab
#     def create_general_tab(self):
#         if self.general_tab is None:
#             general_i18n = self.i18n.get('tabs', {}).get('general', {})
#             self.general_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.general_tab, text=general_i18n.get('title', 'General'))
#         else:
#             for widget in self.general_tab.winfo_children():
#                 widget.destroy()

#         general_i18n = self.i18n.get('tabs', {}).get('general', {})
        
#         ws_i18n = general_i18n.get('websocket_enabled', {})
#         HoverInfoLabelWidget(self.general_tab, text=ws_i18n.get('label', 'Websocket Enabled:'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"),
#                              tooltip=ws_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(self.general_tab, variable=self.websocket_enabled_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         clip_i18n = general_i18n.get('clipboard_enabled', {})
#         HoverInfoLabelWidget(self.general_tab, text=clip_i18n.get('label', 'Clipboard Enabled:'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"),
#                              tooltip=clip_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(self.general_tab, variable=self.clipboard_enabled_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         both_i18n = general_i18n.get('allow_both_simultaneously', {})
#         HoverInfoLabelWidget(self.general_tab, text=both_i18n.get('label', 'Allow Both Simultaneously:'),
#                              foreground="red", font=("Helvetica", 10, "bold"),
#                              tooltip=both_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(self.general_tab, variable=self.use_both_clipboard_and_websocket_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1
        
#         merge_i18n = general_i18n.get('merge_sequential_text', {})
#         HoverInfoLabelWidget(self.general_tab, text=merge_i18n.get('label', 'Merge Matching Sequential Text:'),
#                              foreground="red", font=("Helvetica", 10, "bold"),
#                              tooltip=merge_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(self.general_tab, variable=self.merge_matching_sequential_text_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         uri_i18n = general_i18n.get('websocket_uri', {})
#         HoverInfoLabelWidget(self.general_tab, text=uri_i18n.get('label', 'Websocket URI(s):'),
#                              tooltip=uri_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(self.general_tab, width=50, textvariable=self.websocket_uri_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         regex_i18n = general_i18n.get('texthook_regex', {})
#         HoverInfoLabelWidget(self.general_tab, text=regex_i18n.get('label', 'TextHook Replacement Regex:'),
#                              tooltip=regex_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(self.general_tab, textvariable=self.texthook_replacement_regex_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         open_config_i18n = general_i18n.get('open_config_on_startup', {})
#         HoverInfoLabelWidget(self.general_tab, text=open_config_i18n.get('label', 'Open Config on Startup:'),
#                              tooltip=open_config_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(self.general_tab, variable=self.open_config_on_startup_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         open_texthooker_i18n = general_i18n.get('open_texthooker_on_startup', {})
#         HoverInfoLabelWidget(self.general_tab, text=open_texthooker_i18n.get('label', 'Open GSM Texthooker on Startup:'),
#                              tooltip=open_texthooker_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(self.general_tab, variable=self.open_multimine_on_startup_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         port_i18n = general_i18n.get('texthooker_port', {})
#         HoverInfoLabelWidget(self.general_tab, text=port_i18n.get('label', 'GSM Texthooker Port:'),
#                              tooltip=port_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(self.general_tab, textvariable=self.texthooker_port_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1
        
#         advanced_i18n = self.i18n.get('tabs', {}).get('advanced', {})
#         export_port_i18n = advanced_i18n.get('plaintext_export_port', {})
#         HoverInfoLabelWidget(self.general_tab, text=export_port_i18n.get('label', '...'),
#                              tooltip=export_port_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(self.general_tab, textvariable=self.plaintext_websocket_export_port_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1
        
#         # locale_i18n = general_i18n.get('locale', {})
#         # HoverInfoLabelWidget(self.general_tab, text=locale_i18n.get('label', 'Locale:'),
#         #                      tooltip=locale_i18n.get('tooltip', '...'),
#         #                      row=self.current_row, column=0)
#         # locale_combobox = ttk.Combobox(self.general_tab, textvariable=self.locale_value, values=[Locale.English.name, Locale.日本語.name, Locale.中文.name], state="readonly")
#         # locale_combobox.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         # locale_combobox.bind("<<ComboboxSelected>>", lambda e: self.change_locale())
#         # self.current_row += 1
        
#         lang_i18n = general_i18n.get('native_language', {})
#         HoverInfoLabelWidget(self.general_tab, text=lang_i18n.get('label', 'Native Language:'),
#                              tooltip=lang_i18n.get('tooltip', '...'),
#                                 row=self.current_row, column=0)
#         ttk.Combobox(self.general_tab, textvariable=self.native_language_value, values=CommonLanguages.get_all_names_pretty(), state="readonly").grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1
        
#         features_i18n = self.i18n.get('tabs', {}).get('features', {})
#         notify_i18n = features_i18n.get('notify_on_update', {})
#         HoverInfoLabelWidget(self.general_tab, text=notify_i18n.get('label', '...'), tooltip=notify_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(self.general_tab, variable=self.notify_on_update_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1
        
#         if is_beangate:
#             ttk.Button(self.general_tab, text=self.i18n.get('buttons', {}).get('run_function', 'Run Function'), command=self.test_func, bootstyle="info").grid(
#                 row=self.current_row, column=0, pady=5
#             )
#             self.current_row += 1

#         self.add_reset_button(self.general_tab, "general", self.current_row, column=0, recreate_tab=self.create_general_tab)

#         self.general_tab.grid_columnconfigure(0, weight=0)
#         self.general_tab.grid_columnconfigure(1, weight=0)
#         for row in range(self.current_row):
#             self.general_tab.grid_rowconfigure(row, minsize=30)

#         return self.general_tab

#     @new_tab
#     def create_required_settings_tab(self):
#         if self.required_settings_frame is None:
#             self.required_settings_frame = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.required_settings_frame, text=self.i18n.get('tabs', {}).get('key_settings', {}).get('title', 'Key Settings'))
#         else:
#             for widget in self.required_settings_frame.winfo_children():
#                 widget.destroy()
#         required_settings_frame = self.required_settings_frame
                
#         simple_i18n = self.i18n.get('tabs', {}).get('simple', {})

#         # key_settings_i18n = simple_i18n.get('key_settings', {})
#         # HoverInfoLabelWidget(required_settings_frame, text=key_settings_i18n.get('label', 'Key Settings'),
#         #                      tooltip=key_settings_i18n.get('tooltip', "These settings are important..."),
#         #                      row=self.current_row, column=0, columnspan=4, font=("Helvetica", 12, "bold"))
#         # self.current_row += 1

#         # --- General Settings ---
#         general_i18n = self.i18n.get('tabs', {}).get('general', {})
        
#         input_frame = ttk.Frame(required_settings_frame)
#         input_frame.grid(row=self.current_row, column=0, columnspan=4, sticky='W', pady=2)
        
#         ws_i18n = general_i18n.get('websocket_enabled', {})
#         HoverInfoLabelWidget(input_frame, text=ws_i18n.get('label', '...'),
#                              tooltip=ws_i18n.get('tooltip', '...'), row=0, column=0)
#         ttk.Checkbutton(input_frame, variable=self.websocket_enabled_value, bootstyle="round-toggle").grid(row=0, column=1, sticky='W', pady=2)
        
#         clip_i18n = general_i18n.get('clipboard_enabled', {})
#         HoverInfoLabelWidget(input_frame, text=clip_i18n.get('label', '...'),
#                              tooltip=clip_i18n.get('tooltip', '...'), row=0, column=2, padx=5)
#         ttk.Checkbutton(input_frame, variable=self.clipboard_enabled_value, bootstyle="round-toggle").grid(row=0, column=3, sticky='W', pady=2)
#         self.current_row += 1

#         uri_i18n = general_i18n.get('websocket_uri', {})
#         HoverInfoLabelWidget(required_settings_frame, text=uri_i18n.get('label', '...'),
#                              tooltip=uri_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Entry(required_settings_frame, width=50, textvariable=self.websocket_uri_value).grid(row=self.current_row, column=1, columnspan=3, sticky='EW', pady=2)
#         self.current_row += 1

#         locale_i18n = general_i18n.get('locale', {})
#         HoverInfoLabelWidget(required_settings_frame, text=locale_i18n.get('label', '...'),
#                              tooltip=locale_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         locale_combobox_simple = ttk.Combobox(required_settings_frame, textvariable=self.locale_value, values=[Locale.English.name, Locale.日本語.name, Locale.中文.name], state="readonly")
#         locale_combobox_simple.grid(row=self.current_row, column=1, columnspan=2, sticky='EW', pady=2)
#         locale_combobox_simple.bind("<<ComboboxSelected>>", lambda e: self.change_locale())
#         self.current_row += 1

#         # --- Paths Settings ---
#         paths_i18n = self.i18n.get('tabs', {}).get('paths', {})
#         browse_text = self.i18n.get('buttons', {}).get('browse', 'Browse')
#         watch_i18n = paths_i18n.get('folder_to_watch', {})
#         HoverInfoLabelWidget(required_settings_frame, text=watch_i18n.get('label', '...'),
#                              tooltip=watch_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         folder_watch_entry = ttk.Entry(required_settings_frame, width=50, textvariable=self.folder_to_watch_value)
#         folder_watch_entry.grid(row=self.current_row, column=1, columnspan=2, sticky='EW', pady=2)
#         ttk.Button(required_settings_frame, text=browse_text, command=lambda: self.browse_folder(folder_watch_entry),
#                    bootstyle="outline").grid(row=self.current_row, column=3, padx=5, pady=2)
#         self.current_row += 1

#         # --- Anki Settings ---
#         anki_i18n = self.i18n.get('tabs', {}).get('anki', {})
#         sentence_i18n = anki_i18n.get('sentence_field', {})
#         HoverInfoLabelWidget(required_settings_frame, text=sentence_i18n.get('label', '...'),
#                              tooltip=sentence_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Entry(required_settings_frame, textvariable=self.sentence_field_value).grid(row=self.current_row, column=1, columnspan=3, sticky='EW', pady=2)
#         self.current_row += 1

#         sentence_audio_i18n = anki_i18n.get('sentence_audio_field', {})
#         HoverInfoLabelWidget(required_settings_frame, text=sentence_audio_i18n.get('label', '...'),
#                              tooltip=sentence_audio_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Entry(required_settings_frame, textvariable=self.sentence_audio_field_value).grid(row=self.current_row, column=1, columnspan=3, sticky='EW', pady=2)
#         self.current_row += 1

#         pic_i18n = anki_i18n.get('picture_field', {})
#         HoverInfoLabelWidget(required_settings_frame, text=pic_i18n.get('label', '...'),
#                              tooltip=pic_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Entry(required_settings_frame, textvariable=self.picture_field_value).grid(row=self.current_row, column=1, columnspan=3, sticky='EW', pady=2)
#         self.current_row += 1

#         word_i18n = anki_i18n.get('word_field', {})
#         HoverInfoLabelWidget(required_settings_frame, text=word_i18n.get('label', '...'),
#                              tooltip=word_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Entry(required_settings_frame, textvariable=self.word_field_value).grid(row=self.current_row, column=1, columnspan=3, sticky='EW', pady=2)
#         self.current_row += 1

#         # --- Audio Settings ---
#         audio_tab_i18n = self.i18n.get('tabs', {}).get('audio', {})
#         begin_offset_i18n = audio_tab_i18n.get('beginning_offset', {})
#         HoverInfoLabelWidget(required_settings_frame, text=begin_offset_i18n.get('label', '...'),
#                              tooltip=begin_offset_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Entry(required_settings_frame, textvariable=self.beginning_offset_value).grid(row=self.current_row, column=1, columnspan=3, sticky='EW', pady=2)
#         self.current_row += 1
        
#         # Vad end offset

#         vad_i18n = self.i18n.get('tabs', {}).get('vad', {})
#         vad_end_offset_i18n = vad_i18n.get('audio_end_offset', {})
#         HoverInfoLabelWidget(required_settings_frame, text=vad_end_offset_i18n.get('label', '...'),
#                              tooltip=vad_end_offset_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Entry(required_settings_frame, textvariable=self.end_offset_value).grid(row=self.current_row, column=1, columnspan=3, sticky='EW', pady=2)
#         self.current_row += 1
        
#         splice_i18n = vad_i18n.get('cut_and_splice', {})
#         HoverInfoLabelWidget(required_settings_frame, text=splice_i18n.get('label', '...'),
#                              tooltip=splice_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(required_settings_frame, variable=self.cut_and_splice_segments_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
        
#         padding_i18n = vad_i18n.get('splice_padding', {})
#         HoverInfoEntryWidget(required_settings_frame, text=padding_i18n.get('tooltip', '...'),
#                                               row=self.current_row, column=2, textvariable=self.splice_padding_value)

#         self.current_row += 1
        
#         # Ocen Audio

#         ext_tool_i18n = audio_tab_i18n.get('external_tool', {})
#         HoverInfoLabelWidget(required_settings_frame, text=ext_tool_i18n.get('label', '...'),
#                              tooltip=ext_tool_i18n.get('tooltip', '...'),
#                              foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         self.external_tool_entry = ttk.Entry(required_settings_frame, textvariable=self.external_tool_value)
#         self.external_tool_entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        
#         ttk.Button(required_settings_frame, text=audio_tab_i18n.get('install_ocenaudio_button', 'Install Ocenaudio'), command=self.download_and_install_ocen,
#             bootstyle="info").grid(row=self.current_row, column=2, pady=5)
#         self.current_row += 1
        
#         # ext_tool_enabled_i18n = audio_tab_i18n.get('external_tool_enabled', {})
#         # ttk.Checkbutton(required_settings_frame, variable=self.external_tool_enabled_value, bootstyle="round-toggle").grid(
#         #     row=self.current_row, column=3, sticky='W', padx=10, pady=5)
#         # self.current_row += 1

#         # Anki Media Collection

#         # anki_media_collection_i18n = audio_tab_i18n.get('anki_media_collection', {})
#         # HoverInfoLabelWidget(required_settings_frame, text=anki_media_collection_i18n.get('label', '...'),
#         #                      tooltip=anki_media_collection_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         # ttk.Entry(required_settings_frame, textvariable=self.anki_media_collection_value).grid(row=self.current_row, column=1, columnspan=3, sticky='EW', pady=2)
#         # self.current_row += 1

#         # --- Features Settings ---
#         features_i18n = self.i18n.get('tabs', {}).get('features', {})
#         # action_frame = ttk.Frame(required_settings_frame)
#         # action_frame.grid(row=self.current_row, column=0, columnspan=4, sticky='W', pady=2)
        
#         # Feature Toggles, Anki, OBS, Audio, VAD, AI, WIP
#         feature_frame = ttk.Frame(required_settings_frame)
#         feature_frame.grid(row=self.current_row, column=0, columnspan=5, sticky='W', pady=2)

#         # anki_enabled_i18n = simple_i18n.get('anki_enabled', {})
#         # HoverInfoLabelWidget(feature_frame, text=anki_enabled_i18n.get('label', '...'),
#         #                      tooltip=anki_enabled_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         # ttk.Checkbutton(feature_frame, variable=self.update_anki_value, bootstyle="round-toggle").grid(
#         #     row=self.current_row, column=1, sticky='W', pady=2)
         
#         open_edit_i18n = features_i18n.get('open_anki_edit', {})
#         HoverInfoLabelWidget(feature_frame, text=open_edit_i18n.get('label', '...'),
#                              tooltip=open_edit_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(feature_frame, variable=self.open_anki_edit_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)

#         open_browser_i18n = features_i18n.get('open_anki_browser', {})
#         HoverInfoLabelWidget(feature_frame, text=open_browser_i18n.get('label', '...'),
#                              tooltip=open_browser_i18n.get('tooltip', '...'), row=self.current_row, column=2, padx=5)
#         ttk.Checkbutton(feature_frame, variable=self.open_anki_browser_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=3, sticky='W', pady=2)
#         self.current_row += 1
        
#         # Add Horizontal Separator
#         sep = ttk.Separator(feature_frame, orient='horizontal')
#         sep.grid(row=self.current_row, column=0, columnspan=5, sticky='EW', pady=10)
#         self.current_row += 1

#         legend_i18n = general_i18n.get('legend', {})
#         ttk.Label(feature_frame,
#             text=legend_i18n.get('tooltip_info', '...'),
#             font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
#         self.current_row += 1
#         ttk.Label(feature_frame, text=legend_i18n.get('important', '...'), foreground="dark orange",
#                   font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
#         self.current_row += 1
#         ttk.Label(feature_frame, text=legend_i18n.get('advanced', '...'), foreground="red",
#                   font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
#         self.current_row += 1
#         ttk.Label(feature_frame, text=legend_i18n.get('recommended', '...'), foreground="green",
#                   font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
#         self.current_row += 1
        
#         # screenshot_i18n = simple_i18n.get('screenshot_enabled', {})
#         # HoverInfoLabelWidget(feature_frame, text=screenshot_i18n.get('label', '...'),
#         #                      tooltip=screenshot_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         # ttk.Checkbutton(feature_frame, variable=self.screenshot_enabled_value, bootstyle="round-toggle").grid(
#         #     row=self.current_row, column=1, sticky='W', pady=2)
#         # self.current_row += 1

#         # audio_i18n = self.i18n.get('tabs', {}).get('audio', {})
#         # audio_enabled_i18n = simple_i18n.get('audio_enabled', {})
#         # HoverInfoLabelWidget(feature_frame, text=audio_enabled_i18n.get('label', '...'),
#         #                      tooltip=audio_enabled_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         # ttk.Checkbutton(feature_frame, variable=self.audio_enabled_value, bootstyle="round-toggle").grid(
#         #     row=self.current_row, column=1, sticky='W', pady=2)
#         # self.current_row += 1

#         # vad_i18n = self.i18n.get('tabs', {}).get('vad', {})
#         # vad_enabled_i18n = simple_i18n.get('vad_enabled', {})
#         # HoverInfoLabelWidget(feature_frame, text=vad_enabled_i18n.get('label', '...'),
#         #                      tooltip=vad_enabled_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         # ttk.Checkbutton(feature_frame, variable=self.do_vad_postprocessing_value, bootstyle="round-toggle").grid(
#         #     row=self.current_row, column=1, sticky='W', pady=2)
#         # self.current_row += 1

#         # ai_i18n = self.i18n.get('tabs', {}).get('ai', {})
#         # ai_enabled_i18n = simple_i18n.get('ai_enabled', {})
#         # HoverInfoLabelWidget(feature_frame, text=ai_enabled_i18n.get('label', '...'),
#         #                      tooltip=ai_enabled_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         # ttk.Checkbutton(feature_frame, variable=self.ai_enabled_value, bootstyle="round-toggle").grid(
#         #     row=self.current_row, column=1, sticky='W', pady=2)

#         required_settings_frame.grid_columnconfigure(1, weight=1)

#         return required_settings_frame

#     @new_tab
#     def create_vad_tab(self):
#         if self.vad_tab is None:
#             vad_i18n = self.i18n.get('tabs', {}).get('vad', {})
#             self.vad_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.vad_tab, text=vad_i18n.get('title', 'VAD'))
#         else:
#             for widget in self.vad_tab.winfo_children():
#                 widget.destroy()

#         vad_frame = self.vad_tab
#         vad_i18n = self.i18n.get('tabs', {}).get('vad', {})

#         postproc_i18n = vad_i18n.get('do_postprocessing', {})
#         HoverInfoLabelWidget(vad_frame, text=postproc_i18n.get('label', '...'),
#                              tooltip=postproc_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(vad_frame, variable=self.do_vad_postprocessing_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         lang_i18n = vad_i18n.get('language', {})
#         HoverInfoLabelWidget(vad_frame, text=lang_i18n.get('label', '...'),
#                              tooltip=lang_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Combobox(vad_frame, textvariable=self.language_value, values=AVAILABLE_LANGUAGES, state="readonly").grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         whisper_i18n = vad_i18n.get('whisper_model', {})
#         HoverInfoLabelWidget(vad_frame, text=whisper_i18n.get('label', '...'), tooltip=whisper_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Combobox(vad_frame, textvariable=self.whisper_model_value, values=[WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, WHISPER_MEDIUM,
#                                                              WHISPER_LARGE, WHISPER_TURBO], state="readonly").grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         selected_model_i18n = vad_i18n.get('selected_model', {})
#         HoverInfoLabelWidget(vad_frame, text=selected_model_i18n.get('label', '...'), tooltip=selected_model_i18n.get('tooltip', '...'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Combobox(vad_frame, textvariable=self.selected_vad_model_value, values=[SILERO, WHISPER], state="readonly").grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         backup_model_i18n = vad_i18n.get('backup_model', {})
#         HoverInfoLabelWidget(vad_frame, text=backup_model_i18n.get('label', '...'),
#                              tooltip=backup_model_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Combobox(vad_frame, textvariable=self.backup_vad_model_value, values=[OFF, SILERO, WHISPER], state="readonly").grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         no_results_i18n = vad_i18n.get('add_on_no_results', {})
#         HoverInfoLabelWidget(vad_frame, text=no_results_i18n.get('label', '...'),
#                              tooltip=no_results_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(vad_frame, variable=self.add_audio_on_no_results_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         # TODO ADD LOCALIZATION
#         tts_fallback_i18n = vad_i18n.get('use_tts_as_fallback', {})
#         HoverInfoLabelWidget(vad_frame, text=tts_fallback_i18n.get('label', 'Use TTS as Fallback.'), tooltip=tts_fallback_i18n.get('tooltip', 'Use TTS if no audio is detected'), row=self.current_row, column=0)
#         ttk.Checkbutton(vad_frame, variable=self.use_tts_as_fallback_value, bootstyle="round-toggle").grid(row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         tts_url_i18n = vad_i18n.get('tts_url', {})
#         HoverInfoLabelWidget(vad_frame, text=tts_url_i18n.get('label', 'TTS URL'), tooltip=tts_url_i18n.get('tooltip', 'The URL for the TTS service'), row=self.current_row, column=0)
#         ttk.Entry(vad_frame, textvariable=self.tts_url_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         end_offset_i18n = vad_i18n.get('audio_end_offset', {})
#         HoverInfoLabelWidget(vad_frame, text=end_offset_i18n.get('label', '...'),
#                              tooltip=end_offset_i18n.get('tooltip', '...'), foreground="dark orange",
#                              font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(vad_frame, textvariable=self.end_offset_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         trim_begin_i18n = vad_i18n.get('trim_beginning', {})
#         HoverInfoLabelWidget(vad_frame, text=trim_begin_i18n.get('label', '...'),
#                              tooltip=trim_begin_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(vad_frame, variable=self.vad_trim_beginning_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)

#         begin_offset_i18n = vad_i18n.get('beginning_offset', {})
#         HoverInfoLabelWidget(vad_frame, text=begin_offset_i18n.get('label', '...'),
#                              tooltip=begin_offset_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=2)
#         ttk.Entry(vad_frame, textvariable=self.vad_beginning_offset_value).grid(row=self.current_row, column=3, sticky='EW', pady=2)
#         self.current_row += 1

#         splice_i18n = vad_i18n.get('cut_and_splice', {})
#         HoverInfoLabelWidget(vad_frame, text=splice_i18n.get('label', '...'),
#                              tooltip=splice_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(vad_frame, variable=self.cut_and_splice_segments_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
        
#         padding_i18n = vad_i18n.get('splice_padding', {})
#         HoverInfoLabelWidget(vad_frame, text=padding_i18n.get('label', '...'),
#                              tooltip=padding_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=2)
#         ttk.Entry(vad_frame, textvariable=self.splice_padding_value).grid(row=self.current_row, column=3, sticky='EW', pady=2)
#         self.current_row += 1

#         # Force CPU for Whisper
#         use_cpu_i18n = vad_i18n.get('use_cpu_for_inference', {})
#         HoverInfoLabelWidget(vad_frame, text=use_cpu_i18n.get('label', 'Force CPU'), tooltip=use_cpu_i18n.get('tooltip', 'Even if CUDA is installed, use CPU for Whisper'), row=self.current_row, column=0)
#         ttk.Checkbutton(vad_frame, variable=self.use_cpu_for_inference_value, bootstyle="round-toggle").grid(row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1
        
#         # TODO Add Localization
#         use_vad_filter_for_whisper_i18n = vad_i18n.get('use_vad_filter_for_whisper', {})
#         HoverInfoLabelWidget(vad_frame, text=use_vad_filter_for_whisper_i18n.get('label', 'Use VAD Filter for Whisper'), tooltip=use_vad_filter_for_whisper_i18n.get('tooltip', 'Uses Silero to Filter out Non-Voiced Segments before Transcribing with Whisper.'), row=self.current_row, column=0)
#         ttk.Checkbutton(vad_frame, variable=self.use_vad_filter_for_whisper_value, bootstyle="round-toggle").grid(row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1
        
#         # Add Reset Button
#         self.add_reset_button(vad_frame, "vad", self.current_row, column=0, recreate_tab=self.create_vad_tab)

#         for col in range(3):
#             vad_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             vad_frame.grid_rowconfigure(row, minsize=30)

#         return vad_frame

#     @new_tab
#     def create_paths_tab(self):
#         if self.paths_tab is None:
#             paths_i18n = self.i18n.get('tabs', {}).get('paths', {})
#             self.paths_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.paths_tab, text=paths_i18n.get('title', 'Paths'))
#         else:
#             for widget in self.paths_tab.winfo_children():
#                 widget.destroy()

#         paths_frame = self.paths_tab
#         paths_i18n = self.i18n.get('tabs', {}).get('paths', {})
#         browse_text = self.i18n.get('buttons', {}).get('browse', 'Browse')

#         watch_i18n = paths_i18n.get('folder_to_watch', {})
#         HoverInfoLabelWidget(paths_frame, text=watch_i18n.get('label', '...'), tooltip=watch_i18n.get('tooltip', '...'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         folder_watch_entry = ttk.Entry(paths_frame, width=50, textvariable=self.folder_to_watch_value)
#         folder_watch_entry.grid(row=self.current_row, column=1, sticky='W', pady=2)
#         ttk.Button(paths_frame, text=browse_text, command=lambda: self.browse_folder(folder_watch_entry),
#                    bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
#         self.current_row += 1

#         # Combine "Copy temp files to output folder" and "Output folder" on one row
#         copy_to_output_i18n = paths_i18n.get('copy_temp_files_to_output_folder', {})
#         combined_i18n = paths_i18n.get('output_folder', {})
        
#         # Output folder and "Copy temp files to output folder" on one row
#         HoverInfoLabelWidget(paths_frame, text=combined_i18n.get('label', '...'),
#                      tooltip=combined_i18n.get('tooltip', '...'), foreground="dark orange",
#                      font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         output_folder_entry = ttk.Entry(paths_frame, width=30, textvariable=self.output_folder_value)
#         output_folder_entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         ttk.Button(paths_frame, text=browse_text, command=lambda: self.browse_folder(output_folder_entry),
#                bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)

#         HoverInfoLabelWidget(paths_frame, text=copy_to_output_i18n.get('label', '...'),
#                      tooltip=copy_to_output_i18n.get('tooltip', '...'), row=self.current_row, column=3)
#         ttk.Checkbutton(paths_frame, variable=self.copy_temp_files_to_output_folder_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=4, sticky='W', pady=2)
#         self.current_row += 1
        
        
#         copy_to_output_i18n = paths_i18n.get('copy_trimmed_replay_to_output_folder', {})
#         HoverInfoLabelWidget(paths_frame, text=copy_to_output_i18n.get('label', '...'),
#                              tooltip=copy_to_output_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(paths_frame, variable=self.copy_trimmed_replay_to_output_folder_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         open_output_folder_i18n = paths_i18n.get('open_output_folder_on_card_creation', {})
#         HoverInfoLabelWidget(paths_frame, text=open_output_folder_i18n.get('label', '...'),
#                              tooltip=open_output_folder_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(paths_frame, variable=self.open_output_folder_on_card_creation_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                                 column=1, sticky='W', pady=2)
#         self.current_row += 1
        
#         rm_video_i18n = paths_i18n.get('remove_video', {})
#         HoverInfoLabelWidget(paths_frame, text=rm_video_i18n.get('label', '...'), tooltip=rm_video_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(paths_frame, variable=self.remove_video_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                          column=1, sticky='W', pady=2)
#         self.current_row += 1

#         # rm_audio_i18n = paths_i18n.get('remove_audio', {})
#         # HoverInfoLabelWidget(paths_frame, text=rm_audio_i18n.get('label', '...'), tooltip=rm_audio_i18n.get('tooltip', '...'),
#         #                      row=self.current_row, column=0)
#         # ttk.Checkbutton(paths_frame, variable=self.remove_audio_value, bootstyle="round-toggle").grid(row=self.current_row,
#         #                                                                                         column=1, sticky='W', pady=2)
#         # self.current_row += 1

#         # rm_ss_i18n = paths_i18n.get('remove_screenshot', {})
#         # HoverInfoLabelWidget(paths_frame, text=rm_ss_i18n.get('label', '...'), tooltip=rm_ss_i18n.get('tooltip', '...'),
#         #                      row=self.current_row, column=0)
#         # ttk.Checkbutton(paths_frame, variable=self.remove_screenshot_value, bootstyle="round-toggle").grid(
#         #     row=self.current_row, column=1, sticky='W', pady=2)
#         # self.current_row += 1

#         self.add_reset_button(paths_frame, "paths", self.current_row, 0, self.create_paths_tab)

#         for col in range(3):
#             paths_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             paths_frame.grid_rowconfigure(row, minsize=30)

#         return paths_frame

#     def browse_file(self, entry_widget):
#         file_selected = filedialog.askopenfilename()
#         if file_selected:
#             # The entry widget's textvariable will be updated automatically
#             entry_widget.delete(0, tk.END)
#             entry_widget.insert(0, file_selected)

#     def browse_folder(self, entry_widget):
#         folder_selected = filedialog.askdirectory()
#         if folder_selected:
#             # The entry widget's textvariable will be updated automatically
#             entry_widget.delete(0, tk.END)
#             entry_widget.insert(0, folder_selected)

#     @new_tab
#     def create_anki_tab(self):
#         if self.anki_tab is None:
#             anki_i18n = self.i18n.get('tabs', {}).get('anki', {})
#             self.anki_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.anki_tab, text=anki_i18n.get('title', 'Anki'))
#         else:
#             for widget in self.anki_tab.winfo_children():
#                 widget.destroy()

#         anki_frame = self.anki_tab
#         anki_i18n = self.i18n.get('tabs', {}).get('anki', {})

#         update_i18n = anki_i18n.get('update_anki', {})
#         HoverInfoLabelWidget(anki_frame, text=update_i18n.get('label', '...'), tooltip=update_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(anki_frame, variable=self.update_anki_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                               column=1, sticky='W', pady=2)
#         self.current_row += 1

#         show_confirmation_i18n = anki_i18n.get('show_update_confirmation_dialog', {})
#         HoverInfoLabelWidget(anki_frame, text=show_confirmation_i18n.get('label', '...'), tooltip=show_confirmation_i18n.get('tooltip', '...'),
#                              foreground="red", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Checkbutton(anki_frame, variable=self.show_update_confirmation_dialog_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                               column=1, sticky='W', pady=2)
#         self.current_row += 1

#         url_i18n = anki_i18n.get('url', {})
#         HoverInfoLabelWidget(anki_frame, text=url_i18n.get('label', '...'), tooltip=url_i18n.get('tooltip', '...'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(anki_frame, width=50, textvariable=self.anki_url_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         sentence_i18n = anki_i18n.get('sentence_field', {})
#         HoverInfoLabelWidget(anki_frame, text=sentence_i18n.get('label', '...'), tooltip=sentence_i18n.get('tooltip', '...'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(anki_frame, textvariable=self.sentence_field_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         audio_i18n = anki_i18n.get('sentence_audio_field', {})
#         HoverInfoLabelWidget(anki_frame, text=audio_i18n.get('label', '...'),
#                              tooltip=audio_i18n.get('tooltip', '...'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(anki_frame, textvariable=self.sentence_audio_field_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         pic_i18n = anki_i18n.get('picture_field', {})
#         HoverInfoLabelWidget(anki_frame, text=pic_i18n.get('label', '...'), tooltip=pic_i18n.get('tooltip', '...'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(anki_frame, textvariable=self.picture_field_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         word_i18n = anki_i18n.get('word_field', {})
#         HoverInfoLabelWidget(anki_frame, text=word_i18n.get('label', '...'), tooltip=word_i18n.get('tooltip', '...'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(anki_frame, textvariable=self.word_field_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         prev_sent_i18n = anki_i18n.get('previous_sentence_field', {})
#         HoverInfoLabelWidget(anki_frame, text=prev_sent_i18n.get('label', '...'),
#                              tooltip=prev_sent_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(anki_frame, textvariable=self.previous_sentence_field_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         prev_img_i18n = anki_i18n.get('previous_image_field', {})
#         HoverInfoLabelWidget(anki_frame, text=prev_img_i18n.get('label', '...'),
#                              tooltip=prev_img_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(anki_frame, textvariable=self.previous_image_field_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         video_img_i18n = anki_i18n.get('video_field', {})
#         HoverInfoLabelWidget(anki_frame, text=video_img_i18n.get('label', '...'),
#                              tooltip=video_img_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(anki_frame, textvariable=self.video_field_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1
        
#         game_name_field_i18n = anki_i18n.get('game_name_field', {})
#         HoverInfoLabelWidget(anki_frame, text=game_name_field_i18n.get('label', 'Game Name Field:'),
#                     tooltip=game_name_field_i18n.get('tooltip', 'Field in Anki for the game name.'), row=self.current_row, column=0)
#         ttk.Entry(anki_frame, textvariable=self.game_name_field_value).grid(row=self.current_row, column=1, columnspan=3, sticky='EW', pady=2)
#         self.current_row += 1

#         tags_i18n = anki_i18n.get('custom_tags', {})
#         HoverInfoLabelWidget(anki_frame, text=tags_i18n.get('label', '...'), tooltip=tags_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(anki_frame, width=50, textvariable=self.custom_tags_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         tags_check_i18n = anki_i18n.get('tags_to_check', {})
#         HoverInfoLabelWidget(anki_frame, text=tags_check_i18n.get('label', '...'),
#                              tooltip=tags_check_i18n.get('tooltip', '...'),
#                              foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(anki_frame, width=50, textvariable=self.tags_to_check_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         game_tag_i18n = anki_i18n.get('add_game_tag', {})
#         HoverInfoLabelWidget(anki_frame, text=game_tag_i18n.get('label', '...'),
#                              tooltip=game_tag_i18n.get('tooltip', '...'), foreground="green",
#                              font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Checkbutton(anki_frame, variable=self.add_game_tag_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                                column=1, sticky='W', pady=2)
#         self.current_row += 1

#         parent_tag_i18n = anki_i18n.get('parent_tag', {})
#         HoverInfoLabelWidget(anki_frame, text=parent_tag_i18n.get('label', '...'),
#                              foreground="green", font=("Helvetica", 10, "bold"),
#                              tooltip=parent_tag_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(anki_frame, width=50, textvariable=self.parent_tag_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         ow_audio_i18n = anki_i18n.get('overwrite_audio', {})
#         HoverInfoLabelWidget(anki_frame, text=ow_audio_i18n.get('label', '...'), tooltip=ow_audio_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(anki_frame, variable=self.overwrite_audio_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                                   column=1, sticky='W', pady=2)
#         self.current_row += 1

#         ow_pic_i18n = anki_i18n.get('overwrite_picture', {})
#         HoverInfoLabelWidget(anki_frame, text=ow_pic_i18n.get('label', '...'),
#                              tooltip=ow_pic_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(anki_frame, variable=self.overwrite_picture_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         multi_ow_i18n = anki_i18n.get('multi_overwrites_sentence', {})
#         HoverInfoLabelWidget(anki_frame, text=multi_ow_i18n.get('label', '...'),
#                              tooltip=multi_ow_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(anki_frame, variable=self.multi_overwrites_sentence_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1
        
#         advanced_i18n = anki_i18n.get('advanced_settings', {})
#         linebreak_i18n = advanced_i18n.get('multiline_linebreak', {})
#         HoverInfoLabelWidget(anki_frame, text=linebreak_i18n.get('label', '...'),
#                              tooltip=linebreak_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(anki_frame, textvariable=self.multi_line_line_break_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         self.add_reset_button(anki_frame, "anki", self.current_row, 0, self.create_anki_tab)

#         for col in range(2):
#             anki_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             anki_frame.grid_rowconfigure(row, minsize=30)

#         return anki_frame

#     def on_profiles_tab_selected(self, event):
#         try:
#             profiles_i18n = self.i18n.get('tabs', {}).get('profiles', {})
#             if self.window.state() != "withdrawn" and self.notebook.tab(self.notebook.select(), "text") == profiles_i18n.get('title', 'Profiles'):
#                 self.refresh_obs_scenes()
#         except Exception as e:
#             logger.debug(e)

#     @new_tab
#     def create_features_tab(self):
#         if self.features_tab is None:
#             features_i18n = self.i18n.get('tabs', {}).get('features', {})
#             self.features_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.features_tab, text=features_i18n.get('title', 'Features'))
#         else:
#             for widget in self.features_tab.winfo_children():
#                 widget.destroy()

#         features_frame = self.features_tab
#         features_i18n = self.i18n.get('tabs', {}).get('features', {})

#         open_edit_i18n = features_i18n.get('open_anki_edit', {})
#         HoverInfoLabelWidget(features_frame, text=open_edit_i18n.get('label', '...'),
#                              tooltip=open_edit_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(features_frame, variable=self.open_anki_edit_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         open_browser_i18n = features_i18n.get('open_anki_browser', {})
#         HoverInfoLabelWidget(features_frame, text=open_browser_i18n.get('label', '...'),
#                              tooltip=open_browser_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(features_frame, variable=self.open_anki_browser_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         query_i18n = features_i18n.get('browser_query', {})
#         HoverInfoLabelWidget(features_frame, text=query_i18n.get('label', '...'),
#                              tooltip=query_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(features_frame, width=50, textvariable=self.browser_query_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         HoverInfoLabelWidget(features_frame, text="Generate LongPlay", tooltip="Generate a LongPlay video using OBS recording, and write to a .srt file with all the text coming into gsm. RESTART REQUIRED FOR SETTING TO TAKE EFFECT.",
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(features_frame, variable=self.generate_longplay_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         self.add_reset_button(features_frame, "features", self.current_row, 0, self.create_features_tab)

#         for col in range(3):
#             features_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             features_frame.grid_rowconfigure(row, minsize=30)

#         return features_frame

#     @new_tab
#     def create_screenshot_tab(self):
#         if self.screenshot_tab is None:
#             ss_i18n = self.i18n.get('tabs', {}).get('screenshot', {})
#             self.screenshot_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.screenshot_tab, text=ss_i18n.get('title', 'Screenshot'))
#         else:
#             for widget in self.screenshot_tab.winfo_children():
#                 widget.destroy()

#         screenshot_frame = self.screenshot_tab
#         ss_i18n = self.i18n.get('tabs', {}).get('screenshot', {})

#         enabled_i18n = ss_i18n.get('enabled', {})
#         HoverInfoLabelWidget(screenshot_frame, text=enabled_i18n.get('label', '...'), tooltip=enabled_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(screenshot_frame, variable=self.screenshot_enabled_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         width_i18n = ss_i18n.get('width', {})
#         HoverInfoLabelWidget(screenshot_frame, text=width_i18n.get('label', '...'), tooltip=width_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(screenshot_frame, textvariable=self.screenshot_width_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         height_i18n = ss_i18n.get('height', {})
#         HoverInfoLabelWidget(screenshot_frame, text=height_i18n.get('label', '...'), tooltip=height_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(screenshot_frame, textvariable=self.screenshot_height_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         quality_i18n = ss_i18n.get('quality', {})
#         HoverInfoLabelWidget(screenshot_frame, text=quality_i18n.get('label', '...'), tooltip=quality_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(screenshot_frame, textvariable=self.screenshot_quality_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         ext_i18n = ss_i18n.get('extension', {})
#         HoverInfoLabelWidget(screenshot_frame, text=ext_i18n.get('label', '...'), tooltip=ext_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Combobox(screenshot_frame, textvariable=self.screenshot_extension_value, values=['webp', 'avif', 'png', 'jpeg'],
#                                                  state="readonly").grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1
        
#         animated_i18n = ss_i18n.get('animated', {})
#         HoverInfoLabelWidget(screenshot_frame, text=animated_i18n.get('label', '...'), tooltip=animated_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(screenshot_frame, variable=self.animated_screenshot_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         ffmpeg_i18n = ss_i18n.get('ffmpeg_options', {})
#         HoverInfoLabelWidget(screenshot_frame, text=ffmpeg_i18n.get('label', '...'),
#                              tooltip=ffmpeg_i18n.get('tooltip', '...'), foreground="red",
#                              font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(screenshot_frame, width=50, textvariable=self.screenshot_custom_ffmpeg_settings_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         timing_i18n = ss_i18n.get('timing', {})
#         HoverInfoLabelWidget(screenshot_frame, text=timing_i18n.get('label', '...'),
#                              tooltip=timing_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Combobox(screenshot_frame, textvariable=self.screenshot_timing_value, values=['beginning', 'middle', 'end'], state="readonly").grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         offset_i18n = ss_i18n.get('offset', {})
#         HoverInfoLabelWidget(screenshot_frame, text=offset_i18n.get('label', '...'),
#                              tooltip=offset_i18n.get('tooltip', '...'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(screenshot_frame, textvariable=self.seconds_after_line_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         selector_i18n = ss_i18n.get('use_selector', {})
#         HoverInfoLabelWidget(screenshot_frame, text=selector_i18n.get('label', '...'),
#                              tooltip=selector_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(screenshot_frame, variable=self.use_screenshot_selector_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         hotkey_i18n = ss_i18n.get('hotkey', {})
#         HoverInfoLabelWidget(screenshot_frame, text=hotkey_i18n.get('label', '...'), tooltip=hotkey_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(screenshot_frame, textvariable=self.take_screenshot_hotkey_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         hotkey_update_i18n = ss_i18n.get('hotkey_updates_anki', {})
#         HoverInfoLabelWidget(screenshot_frame, text=hotkey_update_i18n.get('label', '...'),
#                              tooltip=hotkey_update_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(screenshot_frame, variable=self.screenshot_hotkey_update_anki_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         trim_black_bars_i18n = ss_i18n.get('trim_black_bars', {})
#         HoverInfoLabelWidget(screenshot_frame, text=trim_black_bars_i18n.get('label', '...'),
#                              tooltip=trim_black_bars_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(screenshot_frame, variable=self.trim_black_bars_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         self.add_reset_button(screenshot_frame, "screenshot", self.current_row, 0, self.create_screenshot_tab)

#         for col in range(3):
#             screenshot_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             screenshot_frame.grid_rowconfigure(row, minsize=30)

#         return screenshot_frame

#     def update_audio_ffmpeg_settings(self, event):
#         selected_option = self.ffmpeg_audio_preset_options.get()
#         if selected_option in self.ffmpeg_audio_preset_options_map:
#             self.audio_ffmpeg_reencode_options_value.set(self.ffmpeg_audio_preset_options_map[selected_option])
#         else:
#             self.audio_ffmpeg_reencode_options_value.set("")

#     @new_tab
#     def create_audio_tab(self):
#         if self.audio_tab is None:
#             audio_i18n = self.i18n.get('tabs', {}).get('audio', {})
#             self.audio_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.audio_tab, text=audio_i18n.get('title', 'Audio'))
#         else:
#             for widget in self.audio_tab.winfo_children():
#                 widget.destroy()

#         audio_frame = self.audio_tab
#         audio_i18n = self.i18n.get('tabs', {}).get('audio', {})

#         enabled_i18n = audio_i18n.get('enabled', {})
#         HoverInfoLabelWidget(audio_frame, text=enabled_i18n.get('label', '...'), tooltip=enabled_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(audio_frame, variable=self.audio_enabled_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                                  column=1, sticky='W', pady=2)
#         self.current_row += 1

#         ext_i18n = audio_i18n.get('extension', {})
#         HoverInfoLabelWidget(audio_frame, text=ext_i18n.get('label', '...'), tooltip=ext_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Combobox(audio_frame, textvariable=self.audio_extension_value, values=['opus', 'mp3', 'ogg', 'aac', 'm4a'], state="readonly").grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         begin_offset_i18n = audio_i18n.get('beginning_offset', {})
#         HoverInfoLabelWidget(audio_frame, text=begin_offset_i18n.get('label', '...'),
#                              tooltip=begin_offset_i18n.get('tooltip', '...'),
#                              foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(audio_frame, textvariable=self.beginning_offset_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)

#         ttk.Button(audio_frame, text=audio_i18n.get('find_offset_button', 'Find Offset (WIP)'), command=self.call_audio_offset_selector,
#                    bootstyle="info").grid(row=self.current_row, column=2, sticky='EW', pady=2, padx=5)
#         self.current_row += 1

#         end_offset_i18n = audio_i18n.get('end_offset', {})
#         HoverInfoLabelWidget(audio_frame, text=end_offset_i18n.get('label', '...'),
#                              tooltip=end_offset_i18n.get('tooltip', '...'),
#                              foreground="red", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(audio_frame, textvariable=self.pre_vad_audio_offset_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         ffmpeg_preset_i18n = audio_i18n.get('ffmpeg_preset', {})
#         HoverInfoLabelWidget(audio_frame, text=ffmpeg_preset_i18n.get('label', '...'),
#                              tooltip=ffmpeg_preset_i18n.get('tooltip', '...'), row=self.current_row, column=0)

#         preset_options_i18n = ffmpeg_preset_i18n.get('options', {})
#         self.ffmpeg_audio_preset_options_map = {
#             preset_options_i18n.get('no_reencode', "No Re-encode"): "",
#             preset_options_i18n.get('fade_in', "Simple Fade-in..."): "-c:a {encoder} -f {format} -af \"afade=t=in:d=0.005\"",
#             preset_options_i18n.get('loudness_norm', "Simple loudness..."): "-c:a {encoder} -f {format} -af \"loudnorm=I=-23:TP=-2,afade=t=in:d=0.005\"",
#             preset_options_i18n.get('downmix_norm', "Downmix to mono..."): "-c:a {encoder} -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.005\"",
#             preset_options_i18n.get('downmix_norm_low_bitrate', "Downmix to mono, 30kbps..."): "-c:a {encoder} -b:a 30k -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.005\"",
#             preset_options_i18n.get('custom', "Custom"): get_config().audio.custom_encode_settings,
#         }

#         self.ffmpeg_audio_preset_options = ttk.Combobox(audio_frame,
#                                                         values=list(self.ffmpeg_audio_preset_options_map.keys()),
#                                                         width=50, state="readonly")
#         self.ffmpeg_audio_preset_options.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.ffmpeg_audio_preset_options.bind("<<ComboboxSelected>>", self.update_audio_ffmpeg_settings)
#         self.current_row += 1

#         ffmpeg_options_i18n = audio_i18n.get('ffmpeg_options', {})
#         HoverInfoLabelWidget(audio_frame, text=ffmpeg_options_i18n.get('label', '...'),
#                              tooltip=ffmpeg_options_i18n.get('tooltip', '...'), foreground="red",
#                              font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(audio_frame, width=50, textvariable=self.audio_ffmpeg_reencode_options_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         anki_media_i18n = audio_i18n.get('anki_media_collection', {})
#         HoverInfoLabelWidget(audio_frame, text=anki_media_i18n.get('label', '...'),
#                              tooltip=anki_media_i18n.get('tooltip', '...'),
#                              foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         self.anki_media_collection_entry = ttk.Entry(audio_frame, textvariable=self.anki_media_collection_value)
#         self.anki_media_collection_entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         ext_tool_i18n = audio_i18n.get('external_tool', {})
#         HoverInfoLabelWidget(audio_frame, text=ext_tool_i18n.get('label', '...'),
#                              tooltip=ext_tool_i18n.get('tooltip', '...'),
#                              foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         self.external_tool_entry = ttk.Entry(audio_frame, textvariable=self.external_tool_value)
#         self.external_tool_entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        
#         ext_tool_enabled_i18n = audio_i18n.get('external_tool_enabled', {})
#         HoverInfoLabelWidget(audio_frame, text=ext_tool_enabled_i18n.get('label', '...'), tooltip=ext_tool_enabled_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=2, foreground="green", font=("Helvetica", 10, "bold"))
#         ttk.Checkbutton(audio_frame, variable=self.external_tool_enabled_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=3, sticky='W', padx=10, pady=5)
#         self.current_row += 1

#         ttk.Button(audio_frame, text=audio_i18n.get('install_ocenaudio_button', 'Install Ocenaudio'), command=self.download_and_install_ocen,
#                    bootstyle="info").grid(row=self.current_row, column=0, pady=5)
#         # ttk.Button(audio_frame, text=audio_i18n.get('get_anki_media_button', 'Get Anki Media Collection'),
#         #            command=self.set_default_anki_media_collection, bootstyle="info").grid(row=self.current_row,
#         #                                                                                   column=1, pady=5)
#         self.current_row += 1

#         self.add_reset_button(audio_frame, "audio", self.current_row, 0, self.create_audio_tab)

#         for col in range(5):
#             audio_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             audio_frame.grid_rowconfigure(row, minsize=30)

#         return audio_frame

#     def call_audio_offset_selector(self):
#         try:
#             path, beginning_offset, end_offset = gsm_state.previous_trim_args

#             logger.info(' '.join([sys.executable, "-m", "GameSentenceMiner.tools.audio_offset_selector",
#                                   "--path", path, "--beginning_offset", str(beginning_offset), "--end_offset", str(end_offset)]))

#             result = subprocess.run(
#                 [sys.executable, "-m", "GameSentenceMiner.tools.audio_offset_selector",
#                  "--path", path, "--beginning_offset", str(beginning_offset), "--end_offset", str(end_offset)],
#                 capture_output=True, text=True, check=False
#             )
#             if result.returncode != 0:
#                 logger.error(f"Script failed with return code: {result.returncode}")
#                 return None
            
#             logger.info(result)
#             logger.info(f"Audio offset selector script output: {result.stdout.strip()}")
#             pyperclip.copy(result.stdout.strip())
            
#             dialog_i18n = self.i18n.get('dialogs', {}).get('offset_copied', {})
#             messagebox.showinfo(dialog_i18n.get('title', 'Clipboard'), dialog_i18n.get('message', 'Offset copied!'))
#             return result.stdout.strip()

#         except subprocess.CalledProcessError as e:
#             logger.error(f"Error calling script: {e}\nStderr: {e.stderr.strip()}")
#             return None
#         except Exception as e:
#             logger.error(f"An unexpected error occurred: {e}")
#             return None

#     @new_tab
#     def create_obs_tab(self):
#         if self.obs_tab is None:
#             obs_i18n = self.i18n.get('tabs', {}).get('obs', {})
#             self.obs_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.obs_tab, text=obs_i18n.get('title', 'OBS'))
#         else:
#             for widget in self.obs_tab.winfo_children():
#                 widget.destroy()

#         obs_frame = self.obs_tab
#         obs_i18n = self.i18n.get('tabs', {}).get('obs', {})

#         open_i18n = obs_i18n.get('open_obs', {})
#         HoverInfoLabelWidget(obs_frame, text=open_i18n.get('label', '...'), tooltip=open_i18n.get('tooltip', '...'), row=self.current_row,
#                              column=0)
#         ttk.Checkbutton(obs_frame, variable=self.obs_open_obs_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                           column=1, sticky='W', pady=2)
#         self.current_row += 1

#         close_i18n = obs_i18n.get('close_obs', {})
#         HoverInfoLabelWidget(obs_frame, text=close_i18n.get('label', '...'), tooltip=close_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(obs_frame, variable=self.obs_close_obs_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                            column=1, sticky='W', pady=2)
#         self.current_row += 1

#         obs_path_i18n = obs_i18n.get('obs_path', {})
#         browse_text = self.i18n.get('buttons', {}).get('browse', 'Browse')
#         HoverInfoLabelWidget(obs_frame, text=obs_path_i18n.get('label', '...'), tooltip=obs_path_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         obs_path_entry = ttk.Entry(obs_frame, width=50, textvariable=self.obs_path_value)
#         obs_path_entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         ttk.Button(obs_frame, text=browse_text, command=lambda: self.browse_file(obs_path_entry),
#                    bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
#         self.current_row += 1

#         host_i18n = obs_i18n.get('host', {})
#         HoverInfoLabelWidget(obs_frame, text=host_i18n.get('label', '...'), tooltip=host_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(obs_frame, textvariable=self.obs_host_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         port_i18n = obs_i18n.get('port', {})
#         HoverInfoLabelWidget(obs_frame, text=port_i18n.get('label', '...'), tooltip=port_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(obs_frame, textvariable=self.obs_port_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         pass_i18n = obs_i18n.get('password', {})
#         HoverInfoLabelWidget(obs_frame, text=pass_i18n.get('label', '...'), tooltip=pass_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(obs_frame, show="*", textvariable=self.obs_password_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         min_size_i18n = obs_i18n.get('min_replay_size', {})
#         HoverInfoLabelWidget(obs_frame, text=min_size_i18n.get('label', '...'),
#                              tooltip=min_size_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(obs_frame, textvariable=self.obs_minimum_replay_size_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         # turn_off_output_check_i18n = obs_i18n.get('turn_off_replay_buffer_management', {})
#         # HoverInfoLabelWidget(obs_frame, text=turn_off_output_check_i18n.get('label', '...'),
#         #                      tooltip=turn_off_output_check_i18n.get('tooltip', '...'),
#         #                      row=self.current_row, column=0)
#         # ttk.Checkbutton(obs_frame, variable=self.obs_turn_off_output_check_value, bootstyle="round-toggle").grid(
#         #     row=self.current_row, column=1, sticky='W', pady=2)
#         # self.current_row += 1

#         self.add_reset_button(obs_frame, "obs", self.current_row, 0, self.create_obs_tab)

#         for col in range(3):
#             obs_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             obs_frame.grid_rowconfigure(row, minsize=30)

#         return obs_frame

#     @new_tab
#     def create_profiles_tab(self):
#         if self.profiles_tab is None:
#             profiles_i18n = self.i18n.get('tabs', {}).get('profiles', {})
#             self.profiles_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.profiles_tab, text=profiles_i18n.get('title', 'Profiles'))
#         else:
#             for widget in self.profiles_tab.winfo_children():
#                 widget.destroy()

#         profiles_frame = self.profiles_tab
#         profiles_i18n = self.i18n.get('tabs', {}).get('profiles', {})

#         select_i18n = profiles_i18n.get('select_profile', {})
#         HoverInfoLabelWidget(profiles_frame, text=select_i18n.get('label', '...'), tooltip=select_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         self.profile_var = tk.StringVar(value=self.settings.name)
#         self.profile_combobox = ttk.Combobox(profiles_frame, textvariable=self.profile_var,
#                                              values=list(self.master_config.configs.keys()), state="readonly")
#         self.profile_combobox.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.profile_combobox.bind("<<ComboboxSelected>>", self.on_profile_change)
#         self.current_row += 1

#         button_row = self.current_row
#         ttk.Button(profiles_frame, text=profiles_i18n.get('add_button', 'Add Profile'), command=self.add_profile, bootstyle="primary").grid(
#             row=button_row, column=0, pady=5)
#         ttk.Button(profiles_frame, text=profiles_i18n.get('copy_button', 'Copy Profile'), command=self.copy_profile, bootstyle="secondary").grid(
#             row=button_row, column=1, pady=5)
#         self.delete_profile_button = ttk.Button(profiles_frame, text=profiles_i18n.get('delete_button', 'Delete Config'), command=self.delete_profile,
#                                                 bootstyle="danger")
#         if self.master_config.current_profile != DEFAULT_CONFIG:
#             self.delete_profile_button.grid(row=button_row, column=2, pady=5)
#         else:
#             self.delete_profile_button.grid_remove()
#         self.current_row += 1

#         scene_i18n = profiles_i18n.get('obs_scene', {})
#         HoverInfoLabelWidget(profiles_frame, text=scene_i18n.get('label', '...'),
#                              tooltip=scene_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         self.obs_scene_var = tk.StringVar(value="")
#         self.obs_scene_listbox = tk.Listbox(profiles_frame, listvariable=self.obs_scene_var, selectmode=tk.MULTIPLE,
#                                             height=10, width=50, selectbackground=ttk.Style().colors.primary)
#         self.obs_scene_listbox.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.obs_scene_listbox.bind("<<ListboxSelect>>", self.on_obs_scene_select)
#         ttk.Button(profiles_frame, text=profiles_i18n.get('refresh_scenes_button', 'Refresh Scenes'), command=self.refresh_obs_scenes, bootstyle="outline").grid(
#             row=self.current_row, column=2, pady=5)
#         self.current_row += 1

#         switch_i18n = profiles_i18n.get('switch_to_default', {})
#         HoverInfoLabelWidget(profiles_frame, text=switch_i18n.get('label', '...'),
#                              tooltip=switch_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(profiles_frame, variable=self.switch_to_default_if_not_found_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         for col in range(4):
#             profiles_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             profiles_frame.grid_rowconfigure(row, minsize=30)

#         return profiles_frame

#     def on_obs_scene_select(self, event):
#         self.settings.scenes = [self.obs_scene_listbox.get(i) for i in
#                                 self.obs_scene_listbox.curselection()]
#         self.obs_scene_listbox_changed = True

#     def refresh_obs_scenes(self):
#         scenes = obs.get_obs_scenes()
#         obs_scene_names = [scene['sceneName'] for scene in scenes]
#         self.obs_scene_listbox.delete(0, tk.END)
#         for scene_name in obs_scene_names:
#             self.obs_scene_listbox.insert(tk.END, scene_name)
#         for i, scene in enumerate(obs_scene_names):
#             if scene.strip() in self.settings.scenes:
#                 self.obs_scene_listbox.select_set(i)
#                 self.obs_scene_listbox.activate(i)
#         self.obs_scene_listbox.update_idletasks()

#     @new_tab
#     def create_advanced_tab(self):
#         if self.advanced_tab is None:
#             advanced_i18n = self.i18n.get('tabs', {}).get('advanced', {})
#             self.advanced_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.advanced_tab, text=advanced_i18n.get('title', 'Advanced'))
#         else:
#             for widget in self.advanced_tab.winfo_children():
#                 widget.destroy()

#         advanced_frame = self.advanced_tab
#         advanced_i18n = self.i18n.get('tabs', {}).get('advanced', {})
#         browse_text = self.i18n.get('buttons', {}).get('browse', 'Browse')

#         ttk.Label(advanced_frame, text=advanced_i18n.get('player_note', '...'),
#                   foreground="red", font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=3,
#                                                                          sticky='W', pady=5)
#         self.current_row += 1

#         audio_player_i18n = advanced_i18n.get('audio_player_path', {})
#         HoverInfoLabelWidget(advanced_frame, text=audio_player_i18n.get('label', '...'),
#                              tooltip=audio_player_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         audio_player_entry = ttk.Entry(advanced_frame, width=50, textvariable=self.audio_player_path_value)
#         audio_player_entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         ttk.Button(advanced_frame, text=browse_text, command=lambda: self.browse_file(audio_player_entry),
#                    bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
#         self.current_row += 1

#         video_player_i18n = advanced_i18n.get('video_player_path', {})
#         HoverInfoLabelWidget(advanced_frame, text=video_player_i18n.get('label', '...'),
#                              tooltip=video_player_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         video_player_entry = ttk.Entry(advanced_frame, width=50, textvariable=self.video_player_path_value)
#         video_player_entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         ttk.Button(advanced_frame, text=browse_text, command=lambda: self.browse_file(video_player_entry),
#                    bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
#         self.current_row += 1

#         play_hotkey_i18n = advanced_i18n.get('play_latest_hotkey', {})
#         HoverInfoLabelWidget(advanced_frame, text=play_hotkey_i18n.get('label', '...'),
#                              tooltip=play_hotkey_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Entry(advanced_frame, textvariable=self.play_latest_audio_hotkey_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         storage_field_i18n = advanced_i18n.get('multiline_storage_field', {})
#         HoverInfoLabelWidget(advanced_frame, text=storage_field_i18n.get('label', '...'),
#                              tooltip=storage_field_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(advanced_frame, textvariable=self.multi_line_sentence_storage_field_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         ocr_port_i18n = advanced_i18n.get('ocr_port', {})
#         HoverInfoLabelWidget(advanced_frame, text=ocr_port_i18n.get('label', '...'),
#                              tooltip=ocr_port_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(advanced_frame, textvariable=self.ocr_websocket_port_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         comm_port_i18n = advanced_i18n.get('texthooker_comm_port', {})
#         HoverInfoLabelWidget(advanced_frame, text=comm_port_i18n.get('label', '...'),
#                              tooltip=comm_port_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(advanced_frame, textvariable=self.texthooker_communication_websocket_port_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         reset_hotkey_i18n = advanced_i18n.get('reset_line_hotkey', {})
#         HoverInfoLabelWidget(advanced_frame, text=reset_hotkey_i18n.get('label', '...'),
#                              tooltip=reset_hotkey_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Entry(advanced_frame, textvariable=self.reset_line_hotkey_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         polling_i18n = advanced_i18n.get('polling_rate', {})
#         HoverInfoLabelWidget(advanced_frame, text=polling_i18n.get('label', '...'),
#                              tooltip=polling_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(advanced_frame, textvariable=self.polling_rate_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1
        
#         localhost_bind_address_i18n = advanced_i18n.get('localhost_bind_address', {})
#         HoverInfoLabelWidget(advanced_frame, text=localhost_bind_address_i18n.get('label', 'LocalHost Bind Address:'),
#                              tooltip=localhost_bind_address_i18n.get('tooltip', 'Set this to 0.0.0.0 if you want to connect from another device in your LAN, otherwise leave as is.'), row=self.current_row, column=0)
#         ttk.Entry(advanced_frame, textvariable=self.localhost_bind_address_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         current_ver_i18n = advanced_i18n.get('current_version', {})
#         HoverInfoLabelWidget(advanced_frame, text=current_ver_i18n.get('label', 'Current Version:'), bootstyle="secondary",
#                              tooltip=current_ver_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         self.current_version = ttk.Label(advanced_frame, text=get_current_version(), bootstyle="secondary")
#         self.current_version.grid(row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         latest_ver_i18n = advanced_i18n.get('latest_version', {})
#         HoverInfoLabelWidget(advanced_frame, text=latest_ver_i18n.get('label', 'Latest Version:'), bootstyle="secondary",
#                              tooltip=latest_ver_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         self.latest_version = ttk.Label(advanced_frame, text=get_latest_version(), bootstyle="secondary")
#         self.latest_version.grid(row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         self.add_reset_button(advanced_frame, "advanced", self.current_row, 0, self.create_advanced_tab)

#         for col in range(4):
#             advanced_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             advanced_frame.grid_rowconfigure(row, minsize=30)

#         return advanced_frame

#     @new_tab
#     def create_ai_tab(self):
#         if self.ai_tab is None:
#             ai_i18n = self.i18n.get('tabs', {}).get('ai', {})
#             self.ai_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.ai_tab, text=ai_i18n.get('title', 'AI'))
#         else:
#             for widget in self.ai_tab.winfo_children():
#                 widget.destroy()

#         ai_frame = self.ai_tab
#         ai_i18n = self.i18n.get('tabs', {}).get('ai', {})

#         enabled_i18n = ai_i18n.get('enabled', {})
#         HoverInfoLabelWidget(ai_frame, text=enabled_i18n.get('label', '...'), tooltip=enabled_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(ai_frame, variable=self.ai_enabled_value, bootstyle="round-toggle").grid(row=self.current_row,
#                                                                                            column=1, sticky='W', pady=2)
#         self.current_row += 1

#         provider_i18n = ai_i18n.get('provider', {})
#         HoverInfoLabelWidget(ai_frame, text=provider_i18n.get('label', '...'), tooltip=provider_i18n.get('tooltip', '...'), row=self.current_row,
#                              column=0)
#         ttk.Combobox(ai_frame, textvariable=self.ai_provider_value, values=[AI_GEMINI, AI_GROQ, AI_OPENAI], state="readonly").grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         gemini_model_i18n = ai_i18n.get('gemini_model', {})
#         HoverInfoLabelWidget(ai_frame, text=gemini_model_i18n.get('label', '...'), tooltip=gemini_model_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)

#         self.gemini_model_combobox = ttk.Combobox(ai_frame, textvariable=self.gemini_model_value, values=RECOMMENDED_GEMINI_MODELS, state="readonly")
#         self.gemini_model_combobox.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         gemini_key_i18n = ai_i18n.get('gemini_api_key', {})
#         HoverInfoLabelWidget(ai_frame, text=gemini_key_i18n.get('label', '...'),
#                              tooltip=gemini_key_i18n.get('tooltip', '...'),
#                              foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(ai_frame, show="*", textvariable=self.gemini_api_key_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         groq_model_i18n = ai_i18n.get('groq_model', {})
#         HoverInfoLabelWidget(ai_frame, text=groq_model_i18n.get('label', '...'), tooltip=groq_model_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         self.groq_models_combobox = ttk.Combobox(ai_frame, textvariable=self.groq_model_value, values=RECOMMENDED_GROQ_MODELS, state="readonly")
#         self.groq_models_combobox.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         # Force CPU for Whisper
#         use_cpu_i18n = ai_i18n.get('use_cpu_for_inference', {})
#         HoverInfoLabelWidget(ai_frame, text=use_cpu_i18n.get('label', 'Force CPU'), tooltip=use_cpu_i18n.get('tooltip', 'Even if CUDA is installed, use CPU for Whisper'), row=self.current_row, column=0)
#         ttk.Checkbutton(ai_frame, variable=self.use_cpu_for_inference_value, bootstyle="round-toggle").grid(row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1
                
#         groq_key_i18n = ai_i18n.get('groq_api_key', {})
#         HoverInfoLabelWidget(ai_frame, text=groq_key_i18n.get('label', '...'), tooltip=groq_key_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         groq_apikey_entry = ttk.Entry(ai_frame, show="*", textvariable=self.groq_api_key_value)
#         groq_apikey_entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         groq_apikey_entry.bind("<FocusOut>", lambda e, row=self.current_row: self.get_online_models())
#         groq_apikey_entry.bind("<Return>", lambda e, row=self.current_row: self.get_online_models())
#         self.current_row += 1
        
#         openai_url_i18n = ai_i18n.get('openai_url', {})
#         HoverInfoLabelWidget(ai_frame, text=openai_url_i18n.get('label', '...'), tooltip=openai_url_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         entry = ttk.Entry(ai_frame, textvariable=self.open_ai_url_value)
#         entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         entry.bind("<FocusOut>", lambda e, row=self.current_row: self.update_models_element(ai_frame, row))
#         entry.bind("<Return>", lambda e, row=self.current_row: self.update_models_element(ai_frame, row))

#         self.openai_model_options = []
#         self.update_models_element(ai_frame, self.current_row)
#         # threading.Thread(target=self.update_models_element, args=(ai_frame, self.current_row)).start()
#         self.current_row += 1
            
        
#         openai_key_i18n = ai_i18n.get('openai_apikey', {})
#         HoverInfoLabelWidget(ai_frame, text=openai_key_i18n.get('label', '...'), tooltip=openai_key_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(ai_frame, show="*", textvariable=self.open_ai_api_key_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         anki_field_i18n = ai_i18n.get('anki_field', {})
#         HoverInfoLabelWidget(ai_frame, text=anki_field_i18n.get('label', '...'), tooltip=anki_field_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(ai_frame, textvariable=self.ai_anki_field_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         context_i18n = ai_i18n.get('context_length', {})
#         HoverInfoLabelWidget(ai_frame, text=context_i18n.get('label', '...'), tooltip=context_i18n.get('tooltip', '...'),
#                              foreground="red", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
#         ttk.Entry(ai_frame, textvariable=self.ai_dialogue_context_length_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         canned_trans_i18n = ai_i18n.get('use_canned_translation', {})
#         HoverInfoLabelWidget(ai_frame, text=canned_trans_i18n.get('label', '...'),
#                              tooltip=canned_trans_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(ai_frame, variable=self.use_canned_translation_prompt_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         canned_context_i18n = ai_i18n.get('use_canned_context', {})
#         HoverInfoLabelWidget(ai_frame, text=canned_context_i18n.get('label', '...'),
#                              tooltip=canned_context_i18n.get('tooltip', '...'), row=self.current_row, column=0)
#         ttk.Checkbutton(ai_frame, variable=self.use_canned_context_prompt_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1

#         custom_prompt_i18n = ai_i18n.get('custom_prompt', {})
#         HoverInfoLabelWidget(ai_frame, text=custom_prompt_i18n.get('label', '...'), tooltip=custom_prompt_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         self.custom_prompt = scrolledtext.ScrolledText(ai_frame, width=50, height=5, font=("TkDefaultFont", 9),
#                                                        relief="solid", borderwidth=1,
#                                                        highlightbackground=ttk.Style().colors.border)
#         self.custom_prompt.insert(tk.END, self.settings.ai.custom_prompt)
#         self.custom_prompt.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1
        
#         custom_texthooker_prompt_i18n = ai_i18n.get('custom_texthooker_prompt', {})
#         HoverInfoLabelWidget(ai_frame, text=custom_texthooker_prompt_i18n.get('label', 'Custom Texthooker Prompt:'), tooltip=custom_texthooker_prompt_i18n.get('tooltip', 'Custom Prompt to use for Texthooker Translate Button.'),
#                              row=self.current_row, column=0)
#         self.custom_texthooker_prompt = scrolledtext.ScrolledText(ai_frame, width=50, height=5, font=("TkDefaultFont", 9),
#                                                                    relief="solid", borderwidth=1,
#                                                                    highlightbackground=ttk.Style().colors.border)
#         self.custom_texthooker_prompt.insert(tk.END, self.settings.ai.custom_texthooker_prompt)
#         self.custom_texthooker_prompt.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         self.add_reset_button(ai_frame, "ai", self.current_row, 0, self.create_ai_tab)

#         for col in range(3):
#             ai_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             ai_frame.grid_rowconfigure(row, minsize=30)

#         return ai_frame
    
    
#     def get_online_models(self):
#         ai_models = AIModelsTable.one()

#         def get_models():
#             groq_models = get_groq_models()
#             gemini_models = get_gemini_models()
#             AIModelsTable.update_models(gemini_models, groq_models)

#         def get_groq_models():
#             list_of_groq_models = ["RECOMMENDED"] + RECOMMENDED_GROQ_MODELS + ['OTHER']
#             try:
#                 from groq import Groq
#                 client = Groq(api_key=self.settings.ai.groq_api_key)
#                 models = client.models.list()
#                 for m in models.data:
#                     if not m.active:
#                         continue
#                     name = m.id
#                     if name not in list_of_groq_models and not any(x in name for x in ["guard", "tts", "whisper"]):
#                         list_of_groq_models.append(name)
#             except Exception as e:
#                 print(f"Error occurred while fetching Groq models: {e}")
#                 list_of_groq_models = RECOMMENDED_GROQ_MODELS
#             with open(os.path.join(get_app_directory(), "ai_last_groq_models"), "w") as f:
#                 f.write("\n".join(list_of_groq_models))
#             self.groq_models_combobox['values'] = list_of_groq_models
#             return list_of_groq_models
            
#         def get_gemini_models():
#             full_list_of_models = ["RECOMMENDED"] + RECOMMENDED_GEMINI_MODELS + ["OTHER"]
#             try:
#                 from google import genai
                    
#                 client = genai.Client()
#                 for m in client.models.list():
#                     name = m.name.replace("models/", "")
#                     for action in m.supported_actions:
#                         if action == "generateContent":
#                             if "1.5" not in name:
#                                 if "2.0" in name and any(x in name for x in ["exp", "preview", "001"]):
#                                     continue
#                                 if name not in full_list_of_models:
#                                     full_list_of_models.append(name)
#             except Exception as e:
#                 print(f"Error occurred while fetching models: {e}")
#                 full_list_of_models = RECOMMENDED_GEMINI_MODELS
#             self.gemini_model_combobox['values'] = full_list_of_models
#             return full_list_of_models
        
#         if ai_models and ai_models.gemini_models and ai_models.groq_models:
#             if time.time() - ai_models.last_updated > 3600 * 6:
#                 print("AI models are outdated, fetching new ones.")
#                 self.window.after(100, get_models)
#             self.gemini_model_combobox['values'] = ai_models.gemini_models
#             self.groq_models_combobox['values'] = ai_models.groq_models
#         else:
#             print("No AI models found, fetching new ones.")
#             self.window.after(100, get_models)
#             # get_models()
    
#     def update_models_element(self, frame, row):
#         if hasattr(self, 'last_url') and self.last_url == self.open_ai_url_value.get().strip():
#             print("OpenAI URL unchanged, skipping model update.")
#             return
#         self.last_url = self.open_ai_url_value.get().strip()
#         if self.open_ai_url_value.get().strip() != "" and any(c in self.open_ai_url_value.get() for c in ["localhost", "127.0.0.1"]):
#             import openai
#             # get models from openai compatible url
#             client = openai.Client(api_key=self.settings.ai.open_ai_api_key, base_url=self.open_ai_url_value.get().strip(), timeout=1)
#             try:
#                 models = client.models.list()
#                 if models:
#                     self.openai_model_options = [model.id for model in models.data]
#                 else:
#                     self.openai_model_options = []
#             except Exception as e:
#                 self.openai_model_options = []
#         for widget in frame.grid_slaves(row=row, column=0):
#             widget.destroy()
                
#         ai_i18n = self.i18n.get('tabs', {}).get('ai', {})
#         openai_model_i18n = ai_i18n.get('openai_model', {})
#         HoverInfoLabelWidget(frame, text=openai_model_i18n.get('label', '...'), tooltip=openai_model_i18n.get('tooltip', '...'),
#                                 row=row, column=0)
#         if not self.openai_model_options:
#             self.openai_model_combobox = ttk.Entry(frame, textvariable=self.open_ai_model_value)
#             self.openai_model_combobox.grid(row=row, column=1, sticky='EW', pady=2)
#         else:
#             self.openai_model_combobox = ttk.Combobox(frame, textvariable=self.open_ai_model_value,
#                                                      values=self.openai_model_options, state="readonly")
#             self.openai_model_combobox.grid(row=row, column=1, sticky='EW', pady=2)
    
    
#     # Settings for Official Overlay
#     @new_tab
#     def create_overlay_tab(self):
#         if self.overlay_tab is None:
#             overlay_i18n = self.i18n.get('tabs', {}).get('overlay', {})
#             self.overlay_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.overlay_tab, text=overlay_i18n.get('title', 'Overlay'))
#         else:
#             for widget in self.overlay_tab.winfo_children():
#                 widget.destroy()
                
#         overlay_frame = self.overlay_tab
#         overlay_i18n = self.i18n.get('tabs', {}).get('overlay', {})
#         websocket_port_i18n = overlay_i18n.get('websocket_port', {})
#         HoverInfoLabelWidget(overlay_frame, text=websocket_port_i18n.get('label', '...'),
#                              tooltip=websocket_port_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         ttk.Entry(overlay_frame, textvariable=self.overlay_websocket_port_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1
        
#         overlay_monitor_i18n = overlay_i18n.get('overlay_monitor', {})
#         HoverInfoLabelWidget(overlay_frame, text=overlay_monitor_i18n.get('label', '...'),
#                      tooltip=overlay_monitor_i18n.get('tooltip', '...'),
#                     row=self.current_row, column=0)
#         self.overlay_monitor = ttk.Combobox(overlay_frame, values=self.monitors)
#         self.overlay_monitor.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         # disable selection for now, default to value 1
#         if self.settings.overlay.monitor_to_capture >= len(self.monitors):
#             self.settings.overlay.monitor_to_capture = 0
#         self.overlay_monitor.current(self.settings.overlay.monitor_to_capture)
#         self.current_row += 1

#         # Overlay Engine Selection
#         overlay_engine_i18n = overlay_i18n.get('overlay_engine', {})
#         HoverInfoLabelWidget(overlay_frame, text=overlay_engine_i18n.get('label', '...'),
#                              tooltip=overlay_engine_i18n.get('tooltip', '...'),
#                              row=self.current_row, column=0)
#         self.overlay_engine = ttk.Combobox(overlay_frame, values=[e.value for e in OverlayEngine], state="readonly",
#                                            textvariable=self.overlay_engine_value)
#         self.overlay_engine.grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         # Scan Delay
#         scan_delay_i18n = overlay_i18n.get('scan_delay', {})
#         HoverInfoLabelWidget(overlay_frame, text=scan_delay_i18n.get('label', 'Scan Delay:'),
#                              tooltip=scan_delay_i18n.get('tooltip', 'Delay between GSM Receiving Text, and Scanning for Overlay. Increase this value if your game\'s text appears slowly.'),
#                              row=self.current_row, column=0)
#         ttk.Entry(overlay_frame, textvariable=self.scan_delay_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         # Periodic Settings
#         periodic_i18n = overlay_i18n.get('periodic', {})
#         HoverInfoLabelWidget(overlay_frame, text=periodic_i18n.get('label', 'Periodic:'),
#                              tooltip=periodic_i18n.get('tooltip', 'Enable periodic Scanning.'),
#                              row=self.current_row, column=0)
#         ttk.Checkbutton(overlay_frame, variable=self.periodic_value, bootstyle="round-toggle").grid(
#             row=self.current_row, column=1, sticky='W', pady=2)
#         self.current_row += 1
#         periodic_interval_i18n = overlay_i18n.get('periodic_interval', {})
#         HoverInfoLabelWidget(overlay_frame, text=periodic_interval_i18n.get('label', 'Periodic Interval:'),
#                              tooltip=periodic_interval_i18n.get('tooltip', 'Interval for periodic scanning.'),
#                              row=self.current_row, column=0)
#         ttk.Entry(overlay_frame, textvariable=self.periodic_interval_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         # Periodic Ratio (how much of the screen must match to count)
#         periodic_ratio_i18n = overlay_i18n.get('periodic_ratio', {})
#         HoverInfoLabelWidget(overlay_frame, text=periodic_ratio_i18n.get('label', 'Periodic Ratio:'),
#                              tooltip=periodic_ratio_i18n.get('tooltip', 'Ratio (0-1) used during periodic scanning to determine matching threshold.'),
#                              row=self.current_row, column=0)
#         ttk.Entry(overlay_frame, textvariable=self.periodic_ratio_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         # Number of Local Scans Per Event
#         local_scans_i18n = overlay_i18n.get('number_of_local_scans_per_event', {})
#         HoverInfoLabelWidget(overlay_frame, text=local_scans_i18n.get('label', 'Local Scans Per Event:'),
#                              tooltip=local_scans_i18n.get('tooltip', 'How many local scans to perform per event before stopping or sending to lens.'),
#                              row=self.current_row, column=0)
#         ttk.Entry(overlay_frame, textvariable=self.number_of_local_scans_per_event_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         self.current_row += 1

#         # Minimum Character Size
#         minimum_character_size_i18n = overlay_i18n.get('minimum_character_size', {})
#         HoverInfoLabelWidget(overlay_frame, text=minimum_character_size_i18n.get('label', 'Minimum Character Size:'),
#                              tooltip=minimum_character_size_i18n.get('tooltip', 'Minimum size of characters to be detected.'),
#                              row=self.current_row, column=0)
#         ttk.Entry(overlay_frame, textvariable=self.overlay_minimum_character_size_value).grid(row=self.current_row, column=1, sticky='EW', pady=2)
#         # button to open minimum character size Finder
#         ttk.Button(overlay_frame, text=overlay_i18n.get('minimum_character_size_finder_button', 
#                                                         'Minimum Character Size Finder'), 
#                    command=lambda: self.open_minimum_character_size_selector(self.overlay_minimum_character_size_value.get()), bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)

#         self.current_row += 1

#         if self.monitors:
#             # Ensure the index is valid
#             monitor_index = self.settings.overlay.monitor_to_capture
#             if 0 <= monitor_index < len(self.monitors):
#                 self.overlay_monitor.current(monitor_index)
#             else:
#                 self.overlay_monitor.current(0)
        
#         self.add_reset_button(overlay_frame, "overlay", self.current_row, 0, self.create_overlay_tab)

#     def open_minimum_character_size_selector(self, size):
#         new_size = self.show_minimum_character_size_selector(size)
#         self.overlay_minimum_character_size_value.set(new_size)

#     @new_tab
#     def create_wip_tab(self):
#         if self.wip_tab is None:
#             wip_i18n = self.i18n.get('tabs', {}).get('wip', {})
#             self.wip_tab = ttk.Frame(self.notebook, padding=15)
#             self.notebook.add(self.wip_tab, text=wip_i18n.get('title', 'WIP'))
#         else:
#             for widget in self.wip_tab.winfo_children():
#                 widget.destroy()

#         wip_frame = self.wip_tab
#         wip_i18n = self.i18n.get('tabs', {}).get('wip', {})
#         try:
#             pass
#             # from GameSentenceMiner.util.controller import ControllerInput, ControllerInputManager
#             # HoverInfoLabelWidget(wip_frame, text=wip_i18n.get('note', 'This tab is a work in progress...'),
#             #                      tooltip=wip_i18n.get('tooltip', '...'), foreground="blue", font=("Helvetica", 10, "bold"),
#             #                      row=self.current_row, column=0, columnspan=2)
#             # self.current_row += 1

#             # # Controller OCR Input
#             # controller_ocr_input_i18n = wip_i18n.get('controller_ocr_input', {})
#             # HoverInfoLabelWidget(wip_frame, text=controller_ocr_input_i18n.get('label', 'Controller OCR Input:'), tooltip=controller_ocr_input_i18n.get('tooltip', '...'),
#             #                      row=self.current_row, column=0)
#             # self.controller_ocr_input_value = tk.StringVar(value=getattr(self.settings.wip, 'controller_ocr_input', ''))
#             # self.controller_hotkey_entry = ttk.Entry(wip_frame, textvariable=self.controller_ocr_input_value, width=50)
#             # self.controller_hotkey_entry.grid(row=self.current_row, column=1, sticky='EW', pady=2)
            
#             # listen_for_input_button = ttk.Button(wip_frame, text="Listen for Input", command=lambda: self.listen_for_controller_input())
#             # listen_for_input_button.grid(row=self.current_row, column=2, sticky='EW', pady=2, padx=5)
#             # self.current_row += 1

#         except Exception as e:
#             logger.error(f"Error setting up wip tab to capture: {e}")
#             ttk.Label(wip_frame, text=wip_i18n.get('error_setup', 'Error setting up WIP tab'), foreground="red").grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=5)

#         self.add_reset_button(wip_frame, "wip", self.current_row, 0, self.create_wip_tab)

#         for col in range(2):
#             wip_frame.grid_columnconfigure(col, weight=0)
#         for row in range(self.current_row):
#             wip_frame.grid_rowconfigure(row, minsize=30)

#         return wip_frame
    
#     # def listen_for_controller_input(self):
#     #     from GameSentenceMiner.util.controller import ControllerInput, ControllerInputManager
#     #     def listen_for_controller_thread():
#     #         controller = ControllerInputManager()
#     #         controller.start()
#     #         start_time = time.time()
#     #         while time.time() - start_time < 10:
#     #             try:
#     #                 event = controller.event_queue.get(timeout=1)
#     #                 input = ''
#     #                 for key in event:
#     #                     input += key.readable_name + '+'
#     #                 input = input[:-1]  # Remove trailing '+'
#     #                 self.controller_hotkey_entry.delete(0, tk.END)
#     #                 self.controller_hotkey_entry.insert(0, input)
#     #             except Exception:
#     #                 continue
#     #         controller.stop()
#     #     listen_thread = threading.Thread(target=listen_for_controller_thread)
#     #     listen_thread.start()

#     def on_profile_change(self, event):
#         self.save_settings(profile_change=True)
#         self.reload_settings(force_refresh=True)
#         self.refresh_obs_scenes()
#         if self.master_config.current_profile != DEFAULT_CONFIG:
#             self.delete_profile_button.grid(row=1, column=2, pady=5)
#         else:
#             self.delete_profile_button.grid_remove()

#     def add_profile(self):
#         dialog_i18n = self.i18n.get('dialogs', {}).get('add_profile', {})
#         new_profile_name = simpledialog.askstring(dialog_i18n.get('title', 'Input'), dialog_i18n.get('prompt', 'Enter new profile name:'))
#         if new_profile_name:
#             self.master_config.configs[new_profile_name] = self.master_config.get_default_config()
#             self.profile_combobox['values'] = list(self.master_config.configs.keys())
#             self.profile_combobox.set(new_profile_name)
#             self.save_settings()
#             self.reload_settings()

#     def copy_profile(self):
#         source_profile = self.profile_combobox.get()
#         dialog_i18n = self.i18n.get('dialogs', {}).get('copy_profile', {})
#         new_profile_name = simpledialog.askstring(dialog_i18n.get('title', 'Input'), dialog_i18n.get('prompt', 'Enter new profile name:'), parent=self.window)
#         if new_profile_name and source_profile in self.master_config.configs:
#             import copy
#             self.master_config.configs[new_profile_name] = copy.deepcopy(self.master_config.configs[source_profile])
#             self.master_config.configs[new_profile_name].name = new_profile_name
#             self.profile_combobox['values'] = list(self.master_config.configs.keys())
#             self.profile_combobox.set(new_profile_name)
#             self.save_settings()
#             self.reload_settings()

#     def delete_profile(self):
#         profile_to_delete = self.profile_combobox.get()
#         dialog_i18n = self.i18n.get('dialogs', {}).get('delete_profile', {})
#         error_title = dialog_i18n.get('error_title', 'Error')
        
#         if profile_to_delete == "Default":
#             messagebox.showerror(error_title, dialog_i18n.get('error_cannot_delete_default', 'Cannot delete the Default profile.'))
#             return

#         if profile_to_delete and profile_to_delete in self.master_config.configs:
#             confirm = messagebox.askyesno(dialog_i18n.get('title', 'Confirm Delete'),
#                                           dialog_i18n.get('message', "Are you sure... '{profile_name}'?").format(profile_name=profile_to_delete),
#                                           parent=self.window, icon='warning')
#             if confirm:
#                 del self.master_config.configs[profile_to_delete]
#                 self.profile_combobox['values'] = list(self.master_config.configs.keys())
#                 self.profile_combobox.set("Default")
#                 self.master_config.current_profile = "Default"
#                 save_full_config(self.master_config)
#                 self.reload_settings()

#     def download_and_install_ocen(self):
#         dialog_i18n = self.i18n.get('dialogs', {}).get('install_ocenaudio', {})
#         confirm = messagebox.askyesno(dialog_i18n.get('title', 'Download OcenAudio?'),
#                                       dialog_i18n.get('message', 'Would you like to download...?'),
#                                       parent=self.window, icon='question')
#         if confirm:
#             self.external_tool_value.set(dialog_i18n.get('downloading_message', 'Downloading...'))
#             exe_path = download_ocenaudio_if_needed()
#             messagebox.showinfo(dialog_i18n.get('success_title', 'Download Complete'),
#                                 dialog_i18n.get('success_message', 'Downloaded to {path}').format(path=exe_path),
#                                 parent=self.window)
#             self.external_tool_value.set(exe_path)
#             self.save_settings()

#     def set_default_anki_media_collection(self):
#         dialog_i18n = self.i18n.get('dialogs', {}).get('set_anki_media', {})
#         confirm = messagebox.askyesno(dialog_i18n.get('title', 'Set Default Path?'),
#                                       dialog_i18n.get('message', 'Would you like to set...?'),
#                                       parent=self.window, icon='question')
#         if confirm:
#             default_path = get_default_anki_media_collection_path()
#             if default_path != self.anki_media_collection_value.get():
#                 self.anki_media_collection_value.set(default_path)
               
#                 self.save_settings()


# if __name__ == '__main__':
#     # Ensure 'en_us.json' is in the same directory as this script to run this example
#     root = ttk.Window(themename='darkly')
#     window = ConfigApp(root)
#     window.show()
#     window.window.mainloop()
