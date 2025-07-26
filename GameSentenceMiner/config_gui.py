import asyncio
import json
import subprocess
import time
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, scrolledtext, font

import pyperclip
import ttkbootstrap as ttk

from GameSentenceMiner import obs
from GameSentenceMiner.util import configuration
from GameSentenceMiner.util.communication.send import send_restart_signal
from GameSentenceMiner.util.configuration import *
from GameSentenceMiner.util.downloader.download_tools import download_ocenaudio_if_needed
from GameSentenceMiner.util.package import get_current_version, get_latest_version

settings_saved = False
on_save = []
exit_func = None


# It's assumed that a file named 'en_us.json' exists in the same directory
# or a path that Python can find.
def load_localization(locale=Locale.English):
    """Loads the localization file."""
    try:
        # Use a path relative to this script file
        script_dir = os.path.dirname(os.path.abspath(__file__))
        lang_file = os.path.join(script_dir, 'locales', f'{locale.value}.json')
        with open(lang_file, 'r', encoding='utf-8') as f:
            return json.load(f)['config']
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"Warning: Could not load localization file '{locale.value}.json'. Error: {e}. Falling back to empty dict.")
        return {}


def new_tab(func):
    def wrapper(self, *args, **kwargs):
        self.current_row = 0  # Resetting row for the new tab
        # Perform any other pre-initialization tasks here if needed
        return func(self, *args, **kwargs)

    return wrapper


class HoverInfoWidget:
    def __init__(self, parent, text, row, column, padx=5, pady=2):
        self.info_icon = ttk.Label(parent, text="ⓘ", foreground="blue", cursor="hand2")
        self.info_icon.grid(row=row, column=column, padx=padx, pady=pady)
        self.info_icon.bind("<Enter>", lambda e: self.show_info_box(text))
        self.info_icon.bind("<Leave>", lambda e: self.hide_info_box())
        self.tooltip = None

    def show_info_box(self, text):
        x, y, _, _ = self.info_icon.bbox("insert")
        x += self.info_icon.winfo_rootx() + 25
        y += self.info_icon.winfo_rooty() + 20
        self.tooltip = tk.Toplevel(self.info_icon)
        self.tooltip.wm_overrideredirect(True)
        self.tooltip.wm_geometry(f"+{x}+{y}")
        label = ttk.Label(self.tooltip, text=text, relief="solid", borderwidth=1,
                          font=("tahoma", "12", "normal"))
        label.pack(ipadx=1)

    def hide_info_box(self):
        if self.tooltip:
            self.tooltip.destroy()
            self.tooltip = None


class HoverInfoLabelWidget:
    def __init__(self, parent, text, tooltip, row, column, padx=5, pady=2, foreground="white", sticky='W',
                 bootstyle=None, font=("Arial", 10, "normal")):
        self.label = ttk.Label(parent, text=text, foreground=foreground, cursor="hand2", bootstyle=bootstyle, font=font)
        self.label.grid(row=row, column=column, padx=(0, padx), pady=0, sticky=sticky)
        self.label.bind("<Enter>", lambda e: self.show_info_box(tooltip))
        self.label.bind("<Leave>", lambda e: self.hide_info_box())
        self.tooltip = None

    def show_info_box(self, text):
        x, y, _, _ = self.label.bbox("insert")
        x += self.label.winfo_rootx() + 25
        y += self.label.winfo_rooty() + 20
        self.tooltip = tk.Toplevel(self.label)
        self.tooltip.wm_overrideredirect(True)
        self.tooltip.wm_geometry(f"+{x}+{y}")
        label = ttk.Label(self.tooltip, text=text, relief="solid", borderwidth=1,
                          font=("tahoma", "12", "normal"))
        label.pack(ipadx=1)

    def hide_info_box(self):
        if self.tooltip:
            self.tooltip.destroy()
            self.tooltip = None


class ResetToDefaultButton(ttk.Button):
    def __init__(self, parent, command, text="Reset to Default", tooltip_text="Reset settings", bootstyle="danger", **kwargs):
        super().__init__(parent, text=text, command=command, bootstyle=bootstyle, **kwargs)
        self.tooltip_text = tooltip_text
        self.tooltip = None
        self.bind("<Enter>", self.show_tooltip)
        self.bind("<Leave>", self.hide_tooltip)

    def show_tooltip(self, event):
        if not self.tooltip:
            x = self.winfo_rootx() + 20
            y = self.winfo_rooty() + 20
            self.tooltip = tk.Toplevel(self)
            self.tooltip.wm_overrideredirect(True)
            self.tooltip.wm_geometry(f"+{x}+{y}")
            label = ttk.Label(self.tooltip, text=self.tooltip_text, relief="solid",
                              borderwidth=1,
                              font=("tahoma", "12", "normal"))
            label.pack(ipadx=1)

    def hide_tooltip(self, event):
        if self.tooltip:
            self.tooltip.destroy()
            self.tooltip = None


class ConfigApp:
    def __init__(self, root):
        self.window = root
        self.on_exit = None
        self.window.tk.call('tk', 'scaling', 1.5)  # Set DPI scaling factor
        self.window.protocol("WM_DELETE_WINDOW", self.hide)
        self.obs_scene_listbox_changed = False
        self.test_func = None

        self.current_row = 0

        self.master_config: Config = configuration.load_config()
        self.i18n = load_localization(self.master_config.locale)
        
        self.window.title(self.i18n.get('app', {}).get('title', 'GameSentenceMiner Configuration'))

        self.settings = self.master_config.get_config()
        self.default_master_settings = Config.new()
        self.default_settings = self.default_master_settings.get_config()

        self.notebook = ttk.Notebook(self.window)
        self.notebook.pack(pady=10, expand=True, fill='both')

        self.general_tab = None
        self.paths_tab = None
        self.anki_tab = None
        self.vad_tab = None
        self.features_tab = None
        self.screenshot_tab = None
        self.audio_tab = None
        self.obs_tab = None
        self.profiles_tab = None
        self.ai_tab = None
        self.advanced_tab = None
        self.wip_tab = None
        self.monitors = []
        
        try:
            import mss as mss
            self.monitors = [f"Monitor {i}: width: {monitor['width']}, height: {monitor['height']}" for i, monitor in enumerate(mss.mss().monitors[1:], start=1)]
            if len(self.monitors) == 0:
                self.monitors = [1]
        except ImportError:
            self.monitors = []

        self.create_tabs()
        self.notebook.bind("<<NotebookTabChanged>>", self.on_profiles_tab_selected)

        button_frame = ttk.Frame(self.window)
        button_frame.pack(side="bottom", pady=20, anchor="center")
        
        buttons_i18n = self.i18n.get('buttons', {})
        ttk.Button(button_frame, text=buttons_i18n.get('save', 'Save Settings'), command=self.save_settings, bootstyle="success").grid(row=0,
                                                                                                             column=0,
                                                                                                             padx=10)
        if len(self.master_config.configs) > 1:
            sync_btn_i18n = buttons_i18n.get('save_and_sync', {})
            ttk.Button(button_frame, text=sync_btn_i18n.get('text', 'Save and Sync Changes'),
                       command=lambda: self.save_settings(profile_change=False, sync_changes=True),
                       bootstyle="info").grid(row=0, column=1, padx=10)
            HoverInfoWidget(button_frame,
                            sync_btn_i18n.get('tooltip', 'Saves Settings and Syncs CHANGED SETTINGS to all profiles.'), row=0,
                            column=2)

        self.window.update_idletasks()
        self.window.geometry("")
        self.window.withdraw()
    
    def change_locale(self):
        """Change the locale of the application."""
        self.i18n = load_localization(Locale[self.locale.get()])
        self.save_settings()
        self.reload_settings(force_refresh=True)
        self.window.title(self.i18n.get('app', {}).get('title', 'GameSentenceMiner Configuration'))
        logger.info(f"Locale changed to {self.locale.get()}.")

    def set_test_func(self, func):
        self.test_func = func

    def create_tabs(self):
        self.create_general_tab()
        self.create_paths_tab()
        self.create_anki_tab()
        self.create_vad_tab()
        self.create_features_tab()
        self.create_screenshot_tab()
        self.create_audio_tab()
        self.create_obs_tab()
        self.create_profiles_tab()
        self.create_ai_tab()
        self.create_advanced_tab()
        self.create_wip_tab()

    def add_reset_button(self, frame, category, row, column=0, recreate_tab=None):
        """
        Adds a reset button to the given frame that resets the settings in the frame to default values.
        """
        reset_btn_i18n = self.i18n.get('buttons', {}).get('reset_to_default', {})
        reset_button = ResetToDefaultButton(frame, command=lambda: self.reset_to_default(category, recreate_tab),
                                            text=reset_btn_i18n.get('text', 'Reset to Default'),
                                            tooltip_text=reset_btn_i18n.get('tooltip', 'Reset current tab to default.'))
        reset_button.grid(row=row, column=column, sticky='W', padx=5, pady=5)
        return reset_button

    def reset_to_default(self, category, recreate_tab):
        """
        Resets the settings in the current tab to default values.
        """
        dialog_i18n = self.i18n.get('dialogs', {}).get('reset_to_default', {})
        if not messagebox.askyesno(dialog_i18n.get('title', 'Reset to Default'),
                                   dialog_i18n.get('message', 'Are you sure you want to reset all settings in this tab to default?')):
            return

        default_category_config = getattr(self.default_settings, category)

        setattr(self.settings, category, default_category_config)
        recreate_tab()
        self.save_settings(profile_change=False)
        self.reload_settings()

    def show_scene_selection(self, matched_configs):
        selected_scene = None
        if matched_configs:
            dialog_i18n = self.i18n.get('dialogs', {}).get('select_profile', {})
            buttons_i18n = self.i18n.get('buttons', {})
            
            selection_window = tk.Toplevel(self.window)
            selection_window.title(dialog_i18n.get('title', 'Select Profile'))
            selection_window.transient(self.window)
            selection_window.grab_set()

            ttk.Label(selection_window,
                      text=dialog_i18n.get('message', 'Multiple profiles match... Please select:')).pack(pady=10)
            profile_var = tk.StringVar(value=matched_configs[0])
            profile_dropdown = ttk.Combobox(selection_window, textvariable=profile_var, values=matched_configs,
                                            state="readonly")
            profile_dropdown.pack(pady=5)
            ttk.Button(selection_window, text=buttons_i18n.get('ok', 'OK'),
                       command=lambda: [selection_window.destroy(), setattr(self, 'selected_scene', profile_var.get())],
                       bootstyle="primary").pack(pady=10)

            self.window.wait_window(selection_window)
            selected_scene = self.selected_scene
        return selected_scene

    def add_save_hook(self, func):
        on_save.append(func)

    def show(self):
        logger.info("Showing Configuration Window")
        obs.update_current_game()
        self.reload_settings()
        if self.window is not None:
            self.window.deiconify()
            self.window.lift()
            self.window.update_idletasks()
            return

    def hide(self):
        if self.window is not None:
            self.window.withdraw()

    def save_settings(self, profile_change=False, sync_changes=False):
        global settings_saved

        # Create a new Config instance
        config = ProfileConfig(
            scenes=self.settings.scenes,
            general=General(
                use_websocket=self.websocket_enabled.get(),
                use_clipboard=self.clipboard_enabled.get(),
                websocket_uri=self.websocket_uri.get(),
                merge_matching_sequential_text= self.merge_matching_sequential_text.get(),
                open_config_on_startup=self.open_config_on_startup.get(),
                open_multimine_on_startup=self.open_multimine_on_startup.get(),
                texthook_replacement_regex=self.texthook_replacement_regex.get(),
                use_both_clipboard_and_websocket=self.use_both_clipboard_and_websocket.get(),
                texthooker_port=int(self.texthooker_port.get()),
                native_language=CommonLanguages.from_name(self.native_language.get()) if self.native_language.get() else CommonLanguages.ENGLISH.value,
            ),
            paths=Paths(
                folder_to_watch=self.folder_to_watch.get(),
                audio_destination=self.audio_destination.get(),
                screenshot_destination=self.screenshot_destination.get(),
                remove_video=self.remove_video.get(),
                remove_audio=self.remove_audio.get(),
                remove_screenshot=self.remove_screenshot.get()
            ),
            anki=Anki(
                update_anki=self.update_anki.get(),
                url=self.anki_url.get(),
                sentence_field=self.sentence_field.get(),
                sentence_audio_field=self.sentence_audio_field.get(),
                picture_field=self.picture_field.get(),
                word_field=self.word_field.get(),
                previous_sentence_field=self.previous_sentence_field.get(),
                previous_image_field=self.previous_image_field.get(),
                custom_tags=[tag.strip() for tag in self.custom_tags.get().split(',') if tag.strip()],
                tags_to_check=[tag.strip().lower() for tag in self.tags_to_check.get().split(',') if tag.strip()],
                add_game_tag=self.add_game_tag.get(),
                polling_rate=int(self.polling_rate.get()),
                overwrite_audio=self.overwrite_audio.get(),
                overwrite_picture=self.overwrite_picture.get(),
                multi_overwrites_sentence=self.multi_overwrites_sentence.get(),
                parent_tag=self.parent_tag.get(),
            ),
            features=Features(
                full_auto=self.full_auto.get(),
                notify_on_update=self.notify_on_update.get(),
                open_anki_edit=self.open_anki_edit.get(),
                open_anki_in_browser=self.open_anki_browser.get(),
                backfill_audio=self.backfill_audio.get(),
                browser_query=self.browser_query.get(),
            ),
            screenshot=Screenshot(
                enabled=self.screenshot_enabled.get(),
                width=self.screenshot_width.get(),
                height=self.screenshot_height.get(),
                quality=self.screenshot_quality.get(),
                extension=self.screenshot_extension.get(),
                custom_ffmpeg_settings=self.screenshot_custom_ffmpeg_settings.get(),
                screenshot_hotkey_updates_anki=self.screenshot_hotkey_update_anki.get(),
                seconds_after_line=float(self.seconds_after_line.get()) if self.seconds_after_line.get() else 0.0,
                screenshot_timing_setting=self.screenshot_timing.get(),
                use_screenshot_selector=self.use_screenshot_selector.get(),
            ),
            audio=Audio(
                enabled=self.audio_enabled.get(),
                extension=self.audio_extension.get(),
                beginning_offset=float(self.beginning_offset.get()),
                end_offset=float(self.end_offset.get()),
                ffmpeg_reencode_options=self.audio_ffmpeg_reencode_options.get(),
                external_tool=self.external_tool.get(),
                anki_media_collection=self.anki_media_collection.get(),
                external_tool_enabled=self.external_tool_enabled.get(),
                pre_vad_end_offset=float(self.pre_vad_audio_offset.get()),
            ),
            obs=OBS(
                enabled=self.obs_enabled.get(),
                open_obs=self.open_obs.get(),
                close_obs=self.close_obs.get(),
                host=self.obs_host.get(),
                port=int(self.obs_port.get()),
                password=self.obs_password.get(),
                get_game_from_scene=self.get_game_from_scene_name.get(),
                minimum_replay_size=int(self.minimum_replay_size.get())
            ),
            hotkeys=Hotkeys(
                reset_line=self.reset_line_hotkey.get(),
                take_screenshot=self.take_screenshot_hotkey.get(),
                play_latest_audio=self.play_latest_audio_hotkey.get()
            ),
            vad=VAD(
                whisper_model=self.whisper_model.get(),
                do_vad_postprocessing=self.do_vad_postprocessing.get(),
                selected_vad_model=self.selected_vad_model.get(),
                backup_vad_model=self.backup_vad_model.get(),
                trim_beginning=self.vad_trim_beginning.get(),
                beginning_offset=float(self.vad_beginning_offset.get()),
                add_audio_on_no_results=self.add_audio_on_no_results.get(),
                language=self.language.get(),
                cut_and_splice_segments=self.cut_and_splice_segments.get(),
                splice_padding=float(self.splice_padding.get()) if self.splice_padding.get() else 0.0,
            ),
            advanced=Advanced(
                audio_player_path=self.audio_player_path.get(),
                video_player_path=self.video_player_path.get(),
                multi_line_line_break=self.multi_line_line_break.get(),
                multi_line_sentence_storage_field=self.multi_line_sentence_storage_field.get(),
                ocr_websocket_port=int(self.ocr_websocket_port.get()),
                texthooker_communication_websocket_port=int(self.texthooker_communication_websocket_port.get()),
                plaintext_websocket_port=int(self.plaintext_websocket_export_port.get()),
            ),
            ai=Ai(
                enabled=self.ai_enabled.get(),
                provider=self.ai_provider.get(),
                gemini_model=self.gemini_model.get(),
                groq_model=self.groq_model.get(),
                gemini_api_key=self.gemini_api_key.get(),
                api_key=self.gemini_api_key.get(),
                groq_api_key=self.groq_api_key.get(),
                local_model=self.local_ai_model.get(),
                anki_field=self.ai_anki_field.get(),
                use_canned_translation_prompt=self.use_canned_translation_prompt.get(),
                use_canned_context_prompt=self.use_canned_context_prompt.get(),
                custom_prompt=self.custom_prompt.get("1.0", tk.END),
                dialogue_context_length=int(self.ai_dialogue_context_length.get()),
            ),
            wip=WIP(
                overlay_websocket_port=int(self.overlay_websocket_port.get()),
                overlay_websocket_send=self.overlay_websocket_send.get(),
                monitor_to_capture=self.monitor_to_capture.current()
            )
        )

        # Find the display name for "Custom" to check against
        audio_i18n = self.i18n.get('tabs', {}).get('audio', {})
        ffmpeg_preset_i18n = audio_i18n.get('ffmpeg_preset', {}).get('options', {})
        custom_display_name = ffmpeg_preset_i18n.get('custom', 'Custom')

        if self.ffmpeg_audio_preset_options.get() == custom_display_name:
            config.audio.custom_encode_settings = self.audio_ffmpeg_reencode_options.get()

        dialog_i18n = self.i18n.get('dialogs', {}).get('config_error', {})
        error_title = dialog_i18n.get('title', 'Configuration Error')

        if config.features.backfill_audio and config.features.full_auto:
            messagebox.showerror(error_title,
                                 dialog_i18n.get('full_auto_and_backfill', 'Cannot have Full Auto and Backfill...'))
            return

        if not config.general.use_websocket and not config.general.use_clipboard:
            messagebox.showerror(error_title, dialog_i18n.get('no_input_method', 'Cannot have both...'))
            return

        current_profile = self.profile_combobox.get()
        prev_config = self.master_config.get_config()
        self.master_config.switch_to_default_if_not_found = self.switch_to_default_if_not_found.get()
        if profile_change:
            self.master_config.current_profile = current_profile
        else:
            self.master_config.current_profile = current_profile
            self.master_config.set_config_for_profile(current_profile, config)
            
        self.master_config.locale = Locale[self.locale.get()].value


        config_backup_folder = os.path.join(get_app_directory(), "backup", "config")
        os.makedirs(config_backup_folder, exist_ok=True)
        timestamp = time.strftime("%Y-%m-%d_%H-%M-%S")
        with open(os.path.join(config_backup_folder, f"config_backup_{timestamp}.json"), 'w') as backup_file:
            backup_file.write(self.master_config.to_json(indent=4))

        self.master_config = self.master_config.sync_shared_fields()

        if sync_changes:
            self.master_config.sync_changed_fields(prev_config)

        with open(get_config_path(), 'w') as file:
            file.write(self.master_config.to_json(indent=4))

        logger.info("Settings saved successfully!")

        if self.master_config.get_config().restart_required(prev_config):
            logger.info("Restart Required for some settings to take affect!")
            asyncio.run(send_restart_signal())

        settings_saved = True
        configuration.reload_config()
        self.settings = get_config()
        for func in on_save:
            func()

    def reload_settings(self, force_refresh=False):
        new_config = configuration.load_config()
        current_config = new_config.get_config()

        title_template = self.i18n.get('app', {}).get('title_with_profile', 'GameSentenceMiner Configuration - {profile_name}')
        self.window.title(title_template.format(profile_name=current_config.name))

        if current_config.name != self.settings.name or self.settings.config_changed(current_config) or force_refresh:
            logger.info("Config changed, reloading settings.")
            self.master_config = new_config
            self.settings = current_config
            for frame in self.notebook.winfo_children():
                frame.destroy()

            self.general_tab = None
            self.paths_tab = None
            self.anki_tab = None
            self.vad_tab = None
            self.features_tab = None
            self.screenshot_tab = None
            self.audio_tab = None
            self.obs_tab = None
            self.profiles_tab = None
            self.ai_tab = None
            self.advanced_tab = None
            self.wip_tab = None

            self.create_tabs()

    def increment_row(self):
        self.current_row += 1
        return self.current_row

    @new_tab
    def create_general_tab(self):
        if self.general_tab is None:
            general_i18n = self.i18n.get('tabs', {}).get('general', {})
            self.general_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.general_tab, text=general_i18n.get('title', 'General'))
        else:
            for widget in self.general_tab.winfo_children():
                widget.destroy()

        general_i18n = self.i18n.get('tabs', {}).get('general', {})
        
        ws_i18n = general_i18n.get('websocket_enabled', {})
        HoverInfoLabelWidget(self.general_tab, text=ws_i18n.get('label', 'Websocket Enabled:'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"),
                             tooltip=ws_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.websocket_enabled = tk.BooleanVar(value=self.settings.general.use_websocket)
        ttk.Checkbutton(self.general_tab, variable=self.websocket_enabled, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        clip_i18n = general_i18n.get('clipboard_enabled', {})
        HoverInfoLabelWidget(self.general_tab, text=clip_i18n.get('label', 'Clipboard Enabled:'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"),
                             tooltip=clip_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.clipboard_enabled = tk.BooleanVar(value=self.settings.general.use_clipboard)
        ttk.Checkbutton(self.general_tab, variable=self.clipboard_enabled, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        both_i18n = general_i18n.get('allow_both_simultaneously', {})
        HoverInfoLabelWidget(self.general_tab, text=both_i18n.get('label', 'Allow Both Simultaneously:'),
                             foreground="red", font=("Helvetica", 10, "bold"),
                             tooltip=both_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.use_both_clipboard_and_websocket = tk.BooleanVar(value=self.settings.general.use_both_clipboard_and_websocket)
        ttk.Checkbutton(self.general_tab, variable=self.use_both_clipboard_and_websocket, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1
        
        merge_i18n = general_i18n.get('merge_sequential_text', {})
        HoverInfoLabelWidget(self.general_tab, text=merge_i18n.get('label', 'Merge Matching Sequential Text:'),
                             foreground="red", font=("Helvetica", 10, "bold"),
                             tooltip=merge_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.merge_matching_sequential_text = tk.BooleanVar(value=self.settings.general.merge_matching_sequential_text)
        ttk.Checkbutton(self.general_tab, variable=self.merge_matching_sequential_text, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1
        
        HoverInfoLabelWidget(self.general_tab, text="Merge Matching Sequential Text:",
                             foreground="red", font=("Helvetica", 10, "bold"),
                             tooltip="Enable to merge matching sequential text into a single entry. Designed for Luna's Speech Recognition feature. Very niche.",
                             row=self.current_row, column=0)
        
        self.merge_matching_sequential_text = tk.BooleanVar(
            value=self.settings.general.merge_matching_sequential_text)
        ttk.Checkbutton(self.general_tab, variable=self.merge_matching_sequential_text,
                        bootstyle="round-toggle").grid(
            row=self.current_row, column=1,
            sticky='W', pady=2)
        self.current_row += 1

        uri_i18n = general_i18n.get('websocket_uri', {})
        HoverInfoLabelWidget(self.general_tab, text=uri_i18n.get('label', 'Websocket URI(s):'),
                             tooltip=uri_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.websocket_uri = ttk.Entry(self.general_tab, width=50)
        self.websocket_uri.insert(0, self.settings.general.websocket_uri)
        self.websocket_uri.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        regex_i18n = general_i18n.get('texthook_regex', {})
        HoverInfoLabelWidget(self.general_tab, text=regex_i18n.get('label', 'TextHook Replacement Regex:'),
                             tooltip=regex_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.texthook_replacement_regex = ttk.Entry(self.general_tab)
        self.texthook_replacement_regex.insert(0, self.settings.general.texthook_replacement_regex)
        self.texthook_replacement_regex.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        open_config_i18n = general_i18n.get('open_config_on_startup', {})
        HoverInfoLabelWidget(self.general_tab, text=open_config_i18n.get('label', 'Open Config on Startup:'),
                             tooltip=open_config_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.open_config_on_startup = tk.BooleanVar(value=self.settings.general.open_config_on_startup)
        ttk.Checkbutton(self.general_tab, variable=self.open_config_on_startup, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        open_texthooker_i18n = general_i18n.get('open_texthooker_on_startup', {})
        HoverInfoLabelWidget(self.general_tab, text=open_texthooker_i18n.get('label', 'Open GSM Texthooker on Startup:'),
                             tooltip=open_texthooker_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.open_multimine_on_startup = tk.BooleanVar(value=self.settings.general.open_multimine_on_startup)
        ttk.Checkbutton(self.general_tab, variable=self.open_multimine_on_startup, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        port_i18n = general_i18n.get('texthooker_port', {})
        HoverInfoLabelWidget(self.general_tab, text=port_i18n.get('label', 'GSM Texthooker Port:'),
                             tooltip=port_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.texthooker_port = ttk.Entry(self.general_tab)
        self.texthooker_port.insert(0, str(self.settings.general.texthooker_port))
        self.texthooker_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1
        
        locale_i18n = general_i18n.get('locale', {})
        HoverInfoLabelWidget(self.general_tab, text=locale_i18n.get('label', 'Locale:'),
                             tooltip=locale_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.locale = ttk.Combobox(self.general_tab, values=[Locale.English.name, Locale.日本語.name, Locale.中文.name], state="readonly")
        self.locale.set(self.master_config.locale.name)
        self.locale.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.locale.bind("<<ComboboxSelected>>", lambda e: self.change_locale())
        self.current_row += 1
        
        lang_i18n = general_i18n.get('native_language', {})
        HoverInfoLabelWidget(self.general_tab, text=lang_i18n.get('label', 'Native Language:'),
                             tooltip=lang_i18n.get('tooltip', '...'),
                                row=self.current_row, column=0)
        self.native_language = ttk.Combobox(self.general_tab, values=CommonLanguages.get_all_names_pretty(), state="readonly")
        self.native_language.set(CommonLanguages.from_code(self.settings.general.native_language).name.replace('_', ' ').title())
        self.native_language.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        legend_i18n = general_i18n.get('legend', {})
        ttk.Label(self.general_tab, text=legend_i18n.get('important', '...'), foreground="dark orange",
                  font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
        self.current_row += 1
        ttk.Label(self.general_tab, text=legend_i18n.get('advanced', '...'), foreground="red",
                  font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
        self.current_row += 1
        ttk.Label(self.general_tab, text=legend_i18n.get('recommended', '...'), foreground="green",
                  font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
        self.current_row += 1
        ttk.Label(self.general_tab,
                  text=legend_i18n.get('tooltip_info', '...'),
                  font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
        self.current_row += 1
        
        if is_beangate:
            ttk.Button(self.general_tab, text=self.i18n.get('buttons', {}).get('run_function', 'Run Function'), command=self.test_func, bootstyle="info").grid(
                row=self.current_row, column=0, pady=5
            )
            self.current_row += 1

        self.add_reset_button(self.general_tab, "general", self.current_row, column=0, recreate_tab=self.create_general_tab)

        self.general_tab.grid_columnconfigure(0, weight=0)
        self.general_tab.grid_columnconfigure(1, weight=0)
        for row in range(self.current_row):
            self.general_tab.grid_rowconfigure(row, minsize=30)

        return self.general_tab

    @new_tab
    def create_vad_tab(self):
        if self.vad_tab is None:
            vad_i18n = self.i18n.get('tabs', {}).get('vad', {})
            self.vad_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.vad_tab, text=vad_i18n.get('title', 'VAD'))
        else:
            for widget in self.vad_tab.winfo_children():
                widget.destroy()

        vad_frame = self.vad_tab
        vad_i18n = self.i18n.get('tabs', {}).get('vad', {})

        postproc_i18n = vad_i18n.get('do_postprocessing', {})
        HoverInfoLabelWidget(vad_frame, text=postproc_i18n.get('label', '...'),
                             tooltip=postproc_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.do_vad_postprocessing = tk.BooleanVar(value=self.settings.vad.do_vad_postprocessing)
        ttk.Checkbutton(vad_frame, variable=self.do_vad_postprocessing, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        lang_i18n = vad_i18n.get('language', {})
        HoverInfoLabelWidget(vad_frame, text=lang_i18n.get('label', '...'),
                             tooltip=lang_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.language = ttk.Combobox(vad_frame, values=AVAILABLE_LANGUAGES, state="readonly")
        self.language.set(self.settings.vad.language)
        self.language.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        whisper_i18n = vad_i18n.get('whisper_model', {})
        HoverInfoLabelWidget(vad_frame, text=whisper_i18n.get('label', '...'), tooltip=whisper_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.whisper_model = ttk.Combobox(vad_frame, values=[WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, WHISPER_MEDIUM,
                                                             WHSIPER_LARGE, WHISPER_TURBO], state="readonly")
        self.whisper_model.set(self.settings.vad.whisper_model)
        self.whisper_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        selected_model_i18n = vad_i18n.get('selected_model', {})
        HoverInfoLabelWidget(vad_frame, text=selected_model_i18n.get('label', '...'), tooltip=selected_model_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.selected_vad_model = ttk.Combobox(vad_frame, values=[SILERO, WHISPER], state="readonly")
        self.selected_vad_model.set(self.settings.vad.selected_vad_model)
        self.selected_vad_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        backup_model_i18n = vad_i18n.get('backup_model', {})
        HoverInfoLabelWidget(vad_frame, text=backup_model_i18n.get('label', '...'),
                             tooltip=backup_model_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.backup_vad_model = ttk.Combobox(vad_frame, values=[OFF, SILERO, WHISPER], state="readonly")
        self.backup_vad_model.set(self.settings.vad.backup_vad_model)
        self.backup_vad_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        no_results_i18n = vad_i18n.get('add_on_no_results', {})
        HoverInfoLabelWidget(vad_frame, text=no_results_i18n.get('label', '...'),
                             tooltip=no_results_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.add_audio_on_no_results = tk.BooleanVar(value=self.settings.vad.add_audio_on_no_results)
        ttk.Checkbutton(vad_frame, variable=self.add_audio_on_no_results, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        end_offset_i18n = vad_i18n.get('audio_end_offset', {})
        HoverInfoLabelWidget(vad_frame, text=end_offset_i18n.get('label', '...'),
                             tooltip=end_offset_i18n.get('tooltip', '...'), foreground="dark orange",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.end_offset = ttk.Entry(vad_frame)
        self.end_offset.insert(0, str(self.settings.audio.end_offset))
        self.end_offset.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        trim_begin_i18n = vad_i18n.get('trim_beginning', {})
        HoverInfoLabelWidget(vad_frame, text=trim_begin_i18n.get('label', '...'),
                             tooltip=trim_begin_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.vad_trim_beginning = tk.BooleanVar(value=self.settings.vad.trim_beginning)
        ttk.Checkbutton(vad_frame, variable=self.vad_trim_beginning, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)

        begin_offset_i18n = vad_i18n.get('beginning_offset', {})
        HoverInfoLabelWidget(vad_frame, text=begin_offset_i18n.get('label', '...'),
                             tooltip=begin_offset_i18n.get('tooltip', '...'),
                             row=self.current_row, column=2)
        self.vad_beginning_offset = ttk.Entry(vad_frame)
        self.vad_beginning_offset.insert(0, str(self.settings.vad.beginning_offset))
        self.vad_beginning_offset.grid(row=self.current_row, column=3, sticky='EW', pady=2)
        self.current_row += 1

        splice_i18n = vad_i18n.get('cut_and_splice', {})
        HoverInfoLabelWidget(vad_frame, text=splice_i18n.get('label', '...'),
                             tooltip=splice_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.cut_and_splice_segments = tk.BooleanVar(value=self.settings.vad.cut_and_splice_segments)
        ttk.Checkbutton(vad_frame, variable=self.cut_and_splice_segments, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        
        padding_i18n = vad_i18n.get('splice_padding', {})
        HoverInfoLabelWidget(vad_frame, text=padding_i18n.get('label', '...'),
                             tooltip=padding_i18n.get('tooltip', '...'),
                             row=self.current_row, column=2)
        self.splice_padding = ttk.Entry(vad_frame)
        self.splice_padding.insert(0, str(self.settings.vad.splice_padding))
        self.splice_padding.grid(row=self.current_row, column=3, sticky='EW', pady=2)
        self.current_row += 1

        self.add_reset_button(vad_frame, "vad", self.current_row, 0, self.create_vad_tab)

        for col in range(5): vad_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): vad_frame.grid_rowconfigure(row, minsize=30)

        return vad_frame

    @new_tab
    def create_paths_tab(self):
        if self.paths_tab is None:
            paths_i18n = self.i18n.get('tabs', {}).get('paths', {})
            self.paths_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.paths_tab, text=paths_i18n.get('title', 'Paths'))
        else:
            for widget in self.paths_tab.winfo_children():
                widget.destroy()

        paths_frame = self.paths_tab
        paths_i18n = self.i18n.get('tabs', {}).get('paths', {})
        browse_text = self.i18n.get('buttons', {}).get('browse', 'Browse')

        watch_i18n = paths_i18n.get('folder_to_watch', {})
        HoverInfoLabelWidget(paths_frame, text=watch_i18n.get('label', '...'), tooltip=watch_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.folder_to_watch = ttk.Entry(paths_frame, width=50)
        self.folder_to_watch.insert(0, self.settings.paths.folder_to_watch)
        self.folder_to_watch.grid(row=self.current_row, column=1, sticky='W', pady=2)
        ttk.Button(paths_frame, text=browse_text, command=lambda: self.browse_folder(self.folder_to_watch),
                   bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
        self.current_row += 1

        audio_dest_i18n = paths_i18n.get('audio_destination', {})
        HoverInfoLabelWidget(paths_frame, text=audio_dest_i18n.get('label', '...'), tooltip=audio_dest_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.audio_destination = ttk.Entry(paths_frame, width=50)
        self.audio_destination.insert(0, self.settings.paths.audio_destination)
        self.audio_destination.grid(row=self.current_row, column=1, sticky='W', pady=2)
        ttk.Button(paths_frame, text=browse_text, command=lambda: self.browse_folder(self.audio_destination),
                   bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
        self.current_row += 1

        ss_dest_i18n = paths_i18n.get('screenshot_destination', {})
        HoverInfoLabelWidget(paths_frame, text=ss_dest_i18n.get('label', '...'),
                             tooltip=ss_dest_i18n.get('tooltip', '...'), foreground="dark orange",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.screenshot_destination = ttk.Entry(paths_frame, width=50)
        self.screenshot_destination.insert(0, self.settings.paths.screenshot_destination)
        self.screenshot_destination.grid(row=self.current_row, column=1, sticky='W', pady=2)
        ttk.Button(paths_frame, text=browse_text, command=lambda: self.browse_folder(self.screenshot_destination),
                   bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
        self.current_row += 1

        rm_vid_i18n = paths_i18n.get('remove_video', {})
        HoverInfoLabelWidget(paths_frame, text=rm_vid_i18n.get('label', '...'), tooltip=rm_vid_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.remove_video = tk.BooleanVar(value=self.settings.paths.remove_video)
        ttk.Checkbutton(paths_frame, variable=self.remove_video, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                column=1, sticky='W', pady=2)
        self.current_row += 1

        rm_audio_i18n = paths_i18n.get('remove_audio', {})
        HoverInfoLabelWidget(paths_frame, text=rm_audio_i18n.get('label', '...'), tooltip=rm_audio_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.remove_audio = tk.BooleanVar(value=self.settings.paths.remove_audio)
        ttk.Checkbutton(paths_frame, variable=self.remove_audio, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                column=1, sticky='W', pady=2)
        self.current_row += 1

        rm_ss_i18n = paths_i18n.get('remove_screenshot', {})
        HoverInfoLabelWidget(paths_frame, text=rm_ss_i18n.get('label', '...'), tooltip=rm_ss_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.remove_screenshot = tk.BooleanVar(value=self.settings.paths.remove_screenshot)
        ttk.Checkbutton(paths_frame, variable=self.remove_screenshot, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        self.add_reset_button(paths_frame, "paths", self.current_row, 0, self.create_paths_tab)

        for col in range(3): paths_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): paths_frame.grid_rowconfigure(row, minsize=30)

        return paths_frame

    def browse_file(self, entry_widget):
        file_selected = filedialog.askopenfilename()
        if file_selected:
            entry_widget.delete(0, tk.END)
            entry_widget.insert(0, file_selected)

    def browse_folder(self, entry_widget):
        folder_selected = filedialog.askdirectory()
        if folder_selected:
            entry_widget.delete(0, tk.END)
            entry_widget.insert(0, folder_selected)

    @new_tab
    def create_anki_tab(self):
        if self.anki_tab is None:
            anki_i18n = self.i18n.get('tabs', {}).get('anki', {})
            self.anki_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.anki_tab, text=anki_i18n.get('title', 'Anki'))
        else:
            for widget in self.anki_tab.winfo_children():
                widget.destroy()

        anki_frame = self.anki_tab
        anki_i18n = self.i18n.get('tabs', {}).get('anki', {})

        update_i18n = anki_i18n.get('update_anki', {})
        HoverInfoLabelWidget(anki_frame, text=update_i18n.get('label', '...'), tooltip=update_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.update_anki = tk.BooleanVar(value=self.settings.anki.update_anki)
        ttk.Checkbutton(anki_frame, variable=self.update_anki, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                              column=1, sticky='W', pady=2)
        self.current_row += 1

        url_i18n = anki_i18n.get('url', {})
        HoverInfoLabelWidget(anki_frame, text=url_i18n.get('label', '...'), tooltip=url_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.anki_url = ttk.Entry(anki_frame, width=50)
        self.anki_url.insert(0, self.settings.anki.url)
        self.anki_url.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        sentence_i18n = anki_i18n.get('sentence_field', {})
        HoverInfoLabelWidget(anki_frame, text=sentence_i18n.get('label', '...'), tooltip=sentence_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.sentence_field = ttk.Entry(anki_frame)
        self.sentence_field.insert(0, self.settings.anki.sentence_field)
        self.sentence_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        audio_i18n = anki_i18n.get('sentence_audio_field', {})
        HoverInfoLabelWidget(anki_frame, text=audio_i18n.get('label', '...'),
                             tooltip=audio_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.sentence_audio_field = ttk.Entry(anki_frame)
        self.sentence_audio_field.insert(0, self.settings.anki.sentence_audio_field)
        self.sentence_audio_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        pic_i18n = anki_i18n.get('picture_field', {})
        HoverInfoLabelWidget(anki_frame, text=pic_i18n.get('label', '...'), tooltip=pic_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.picture_field = ttk.Entry(anki_frame)
        self.picture_field.insert(0, self.settings.anki.picture_field)
        self.picture_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        word_i18n = anki_i18n.get('word_field', {})
        HoverInfoLabelWidget(anki_frame, text=word_i18n.get('label', '...'), tooltip=word_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.word_field = ttk.Entry(anki_frame)
        self.word_field.insert(0, self.settings.anki.word_field)
        self.word_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        prev_sent_i18n = anki_i18n.get('previous_sentence_field', {})
        HoverInfoLabelWidget(anki_frame, text=prev_sent_i18n.get('label', '...'),
                             tooltip=prev_sent_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.previous_sentence_field = ttk.Entry(anki_frame)
        self.previous_sentence_field.insert(0, self.settings.anki.previous_sentence_field)
        self.previous_sentence_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        prev_img_i18n = anki_i18n.get('previous_image_field', {})
        HoverInfoLabelWidget(anki_frame, text=prev_img_i18n.get('label', '...'),
                             tooltip=prev_img_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.previous_image_field = ttk.Entry(anki_frame)
        self.previous_image_field.insert(0, self.settings.anki.previous_image_field)
        self.previous_image_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        tags_i18n = anki_i18n.get('custom_tags', {})
        HoverInfoLabelWidget(anki_frame, text=tags_i18n.get('label', '...'), tooltip=tags_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.custom_tags = ttk.Entry(anki_frame, width=50)
        self.custom_tags.insert(0, ', '.join(self.settings.anki.custom_tags))
        self.custom_tags.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        tags_check_i18n = anki_i18n.get('tags_to_check', {})
        HoverInfoLabelWidget(anki_frame, text=tags_check_i18n.get('label', '...'),
                             tooltip=tags_check_i18n.get('tooltip', '...'),
                             foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.tags_to_check = ttk.Entry(anki_frame, width=50)
        self.tags_to_check.insert(0, ', '.join(self.settings.anki.tags_to_check))
        self.tags_to_check.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        game_tag_i18n = anki_i18n.get('add_game_tag', {})
        HoverInfoLabelWidget(anki_frame, text=game_tag_i18n.get('label', '...'),
                             tooltip=game_tag_i18n.get('tooltip', '...'), foreground="green",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.add_game_tag = tk.BooleanVar(value=self.settings.anki.add_game_tag)
        ttk.Checkbutton(anki_frame, variable=self.add_game_tag, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                               column=1, sticky='W', pady=2)
        self.current_row += 1

        parent_tag_i18n = anki_i18n.get('parent_tag', {})
        HoverInfoLabelWidget(anki_frame, text=parent_tag_i18n.get('label', '...'),
                             foreground="green", font=("Helvetica", 10, "bold"),
                             tooltip=parent_tag_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.parent_tag = ttk.Entry(anki_frame, width=50)
        self.parent_tag.insert(0, self.settings.anki.parent_tag)
        self.parent_tag.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        ow_audio_i18n = anki_i18n.get('overwrite_audio', {})
        HoverInfoLabelWidget(anki_frame, text=ow_audio_i18n.get('label', '...'), tooltip=ow_audio_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.overwrite_audio = tk.BooleanVar(value=self.settings.anki.overwrite_audio)
        ttk.Checkbutton(anki_frame, variable=self.overwrite_audio, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                  column=1, sticky='W', pady=2)
        self.current_row += 1

        ow_pic_i18n = anki_i18n.get('overwrite_picture', {})
        HoverInfoLabelWidget(anki_frame, text=ow_pic_i18n.get('label', '...'),
                             tooltip=ow_pic_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.overwrite_picture = tk.BooleanVar(value=self.settings.anki.overwrite_picture)
        ttk.Checkbutton(anki_frame, variable=self.overwrite_picture, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        multi_ow_i18n = anki_i18n.get('multi_overwrites_sentence', {})
        HoverInfoLabelWidget(anki_frame, text=multi_ow_i18n.get('label', '...'),
                             tooltip=multi_ow_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.multi_overwrites_sentence = tk.BooleanVar(value=self.settings.anki.multi_overwrites_sentence)
        ttk.Checkbutton(anki_frame, variable=self.multi_overwrites_sentence, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        self.add_reset_button(anki_frame, "anki", self.current_row, 0, self.create_anki_tab)

        for col in range(2): anki_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): anki_frame.grid_rowconfigure(row, minsize=30)

        return anki_frame

    def on_profiles_tab_selected(self, event):
        try:
            profiles_i18n = self.i18n.get('tabs', {}).get('profiles', {})
            if self.window.state() != "withdrawn" and self.notebook.tab(self.notebook.select(), "text") == profiles_i18n.get('title', 'Profiles'):
                self.refresh_obs_scenes()
        except Exception as e:
            logger.debug(e)

    @new_tab
    def create_features_tab(self):
        if self.features_tab is None:
            features_i18n = self.i18n.get('tabs', {}).get('features', {})
            self.features_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.features_tab, text=features_i18n.get('title', 'Features'))
        else:
            for widget in self.features_tab.winfo_children():
                widget.destroy()

        features_frame = self.features_tab
        features_i18n = self.i18n.get('tabs', {}).get('features', {})

        notify_i18n = features_i18n.get('notify_on_update', {})
        HoverInfoLabelWidget(features_frame, text=notify_i18n.get('label', '...'), tooltip=notify_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.notify_on_update = tk.BooleanVar(value=self.settings.features.notify_on_update)
        ttk.Checkbutton(features_frame, variable=self.notify_on_update, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        open_edit_i18n = features_i18n.get('open_anki_edit', {})
        HoverInfoLabelWidget(features_frame, text=open_edit_i18n.get('label', '...'),
                             tooltip=open_edit_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.open_anki_edit = tk.BooleanVar(value=self.settings.features.open_anki_edit)
        ttk.Checkbutton(features_frame, variable=self.open_anki_edit, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        open_browser_i18n = features_i18n.get('open_anki_browser', {})
        HoverInfoLabelWidget(features_frame, text=open_browser_i18n.get('label', '...'),
                             tooltip=open_browser_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.open_anki_browser = tk.BooleanVar(value=self.settings.features.open_anki_in_browser)
        ttk.Checkbutton(features_frame, variable=self.open_anki_browser, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        query_i18n = features_i18n.get('browser_query', {})
        HoverInfoLabelWidget(features_frame, text=query_i18n.get('label', '...'),
                             tooltip=query_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.browser_query = ttk.Entry(features_frame, width=50)
        self.browser_query.insert(0, self.settings.features.browser_query)
        self.browser_query.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        backfill_i18n = features_i18n.get('backfill_audio', {})
        HoverInfoLabelWidget(features_frame, text=backfill_i18n.get('label', '...'), tooltip=backfill_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.backfill_audio = tk.BooleanVar(value=self.settings.features.backfill_audio)
        ttk.Checkbutton(features_frame, variable=self.backfill_audio, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        full_auto_i18n = features_i18n.get('full_auto', {})
        HoverInfoLabelWidget(features_frame, text=full_auto_i18n.get('label', '...'), tooltip=full_auto_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.full_auto = tk.BooleanVar(value=self.settings.features.full_auto)
        ttk.Checkbutton(features_frame, variable=self.full_auto, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                column=1, sticky='W', pady=2)
        self.current_row += 1

        self.add_reset_button(features_frame, "features", self.current_row, 0, self.create_features_tab)

        for col in range(3): features_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): features_frame.grid_rowconfigure(row, minsize=30)

        return features_frame

    @new_tab
    def create_screenshot_tab(self):
        if self.screenshot_tab is None:
            ss_i18n = self.i18n.get('tabs', {}).get('screenshot', {})
            self.screenshot_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.screenshot_tab, text=ss_i18n.get('title', 'Screenshot'))
        else:
            for widget in self.screenshot_tab.winfo_children():
                widget.destroy()

        screenshot_frame = self.screenshot_tab
        ss_i18n = self.i18n.get('tabs', {}).get('screenshot', {})

        enabled_i18n = ss_i18n.get('enabled', {})
        HoverInfoLabelWidget(screenshot_frame, text=enabled_i18n.get('label', '...'), tooltip=enabled_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.screenshot_enabled = tk.BooleanVar(value=self.settings.screenshot.enabled)
        ttk.Checkbutton(screenshot_frame, variable=self.screenshot_enabled, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        width_i18n = ss_i18n.get('width', {})
        HoverInfoLabelWidget(screenshot_frame, text=width_i18n.get('label', '...'), tooltip=width_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.screenshot_width = ttk.Entry(screenshot_frame)
        self.screenshot_width.insert(0, str(self.settings.screenshot.width))
        self.screenshot_width.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        height_i18n = ss_i18n.get('height', {})
        HoverInfoLabelWidget(screenshot_frame, text=height_i18n.get('label', '...'), tooltip=height_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.screenshot_height = ttk.Entry(screenshot_frame)
        self.screenshot_height.insert(0, str(self.settings.screenshot.height))
        self.screenshot_height.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        quality_i18n = ss_i18n.get('quality', {})
        HoverInfoLabelWidget(screenshot_frame, text=quality_i18n.get('label', '...'), tooltip=quality_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.screenshot_quality = ttk.Entry(screenshot_frame)
        self.screenshot_quality.insert(0, str(self.settings.screenshot.quality))
        self.screenshot_quality.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        ext_i18n = ss_i18n.get('extension', {})
        HoverInfoLabelWidget(screenshot_frame, text=ext_i18n.get('label', '...'), tooltip=ext_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.screenshot_extension = ttk.Combobox(screenshot_frame, values=['webp', 'avif', 'png', 'jpeg'],
                                                 state="readonly")
        self.screenshot_extension.set(self.settings.screenshot.extension)
        self.screenshot_extension.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        ffmpeg_i18n = ss_i18n.get('ffmpeg_options', {})
        HoverInfoLabelWidget(screenshot_frame, text=ffmpeg_i18n.get('label', '...'),
                             tooltip=ffmpeg_i18n.get('tooltip', '...'), foreground="red",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.screenshot_custom_ffmpeg_settings = ttk.Entry(screenshot_frame, width=50)
        self.screenshot_custom_ffmpeg_settings.insert(0, self.settings.screenshot.custom_ffmpeg_settings)
        self.screenshot_custom_ffmpeg_settings.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        timing_i18n = ss_i18n.get('timing', {})
        HoverInfoLabelWidget(screenshot_frame, text=timing_i18n.get('label', '...'),
                             tooltip=timing_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.screenshot_timing = ttk.Combobox(screenshot_frame, values=['beginning', 'middle', 'end'], state="readonly")
        self.screenshot_timing.set(self.settings.screenshot.screenshot_timing_setting)
        self.screenshot_timing.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        offset_i18n = ss_i18n.get('offset', {})
        HoverInfoLabelWidget(screenshot_frame, text=offset_i18n.get('label', '...'),
                             tooltip=offset_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.seconds_after_line = ttk.Entry(screenshot_frame)
        self.seconds_after_line.insert(0, str(self.settings.screenshot.seconds_after_line))
        self.seconds_after_line.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        selector_i18n = ss_i18n.get('use_selector', {})
        HoverInfoLabelWidget(screenshot_frame, text=selector_i18n.get('label', '...'),
                             tooltip=selector_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.use_screenshot_selector = tk.BooleanVar(value=self.settings.screenshot.use_screenshot_selector)
        ttk.Checkbutton(screenshot_frame, variable=self.use_screenshot_selector, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        hotkey_i18n = ss_i18n.get('hotkey', {})
        HoverInfoLabelWidget(screenshot_frame, text=hotkey_i18n.get('label', '...'), tooltip=hotkey_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.take_screenshot_hotkey = ttk.Entry(screenshot_frame)
        self.take_screenshot_hotkey.insert(0, self.settings.hotkeys.take_screenshot)
        self.take_screenshot_hotkey.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        hotkey_update_i18n = ss_i18n.get('hotkey_updates_anki', {})
        HoverInfoLabelWidget(screenshot_frame, text=hotkey_update_i18n.get('label', '...'),
                             tooltip=hotkey_update_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.screenshot_hotkey_update_anki = tk.BooleanVar(value=self.settings.screenshot.screenshot_hotkey_updates_anki)
        ttk.Checkbutton(screenshot_frame, variable=self.screenshot_hotkey_update_anki, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        self.add_reset_button(screenshot_frame, "screenshot", self.current_row, 0, self.create_screenshot_tab)

        for col in range(3): screenshot_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): screenshot_frame.grid_rowconfigure(row, minsize=30)

        return screenshot_frame

    def update_audio_ffmpeg_settings(self, event):
        selected_option = self.ffmpeg_audio_preset_options.get()
        if selected_option in self.ffmpeg_audio_preset_options_map:
            self.audio_ffmpeg_reencode_options.delete(0, tk.END)
            self.audio_ffmpeg_reencode_options.insert(0, self.ffmpeg_audio_preset_options_map[selected_option])
        else:
            self.audio_ffmpeg_reencode_options.delete(0, tk.END)
            self.audio_ffmpeg_reencode_options.insert(0, "")

    @new_tab
    def create_audio_tab(self):
        if self.audio_tab is None:
            audio_i18n = self.i18n.get('tabs', {}).get('audio', {})
            self.audio_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.audio_tab, text=audio_i18n.get('title', 'Audio'))
        else:
            for widget in self.audio_tab.winfo_children():
                widget.destroy()

        audio_frame = self.audio_tab
        audio_i18n = self.i18n.get('tabs', {}).get('audio', {})

        enabled_i18n = audio_i18n.get('enabled', {})
        HoverInfoLabelWidget(audio_frame, text=enabled_i18n.get('label', '...'), tooltip=enabled_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.audio_enabled = tk.BooleanVar(value=self.settings.audio.enabled)
        ttk.Checkbutton(audio_frame, variable=self.audio_enabled, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                 column=1, sticky='W', pady=2)
        self.current_row += 1

        ext_i18n = audio_i18n.get('extension', {})
        HoverInfoLabelWidget(audio_frame, text=ext_i18n.get('label', '...'), tooltip=ext_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.audio_extension = ttk.Combobox(audio_frame, values=['opus', 'mp3', 'ogg', 'aac', 'm4a'], state="readonly")
        self.audio_extension.set(self.settings.audio.extension)
        self.audio_extension.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        begin_offset_i18n = audio_i18n.get('beginning_offset', {})
        HoverInfoLabelWidget(audio_frame, text=begin_offset_i18n.get('label', '...'),
                             tooltip=begin_offset_i18n.get('tooltip', '...'),
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.beginning_offset = ttk.Entry(audio_frame)
        self.beginning_offset.insert(0, str(self.settings.audio.beginning_offset))
        self.beginning_offset.grid(row=self.current_row, column=1, sticky='EW', pady=2)

        ttk.Button(audio_frame, text=audio_i18n.get('find_offset_button', 'Find Offset (WIP)'), command=self.call_audio_offset_selector,
                   bootstyle="info").grid(row=self.current_row, column=2, sticky='EW', pady=2, padx=5)
        self.current_row += 1

        end_offset_i18n = audio_i18n.get('end_offset', {})
        HoverInfoLabelWidget(audio_frame, text=end_offset_i18n.get('label', '...'),
                             tooltip=end_offset_i18n.get('tooltip', '...'),
                             foreground="red", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.pre_vad_audio_offset = ttk.Entry(audio_frame)
        self.pre_vad_audio_offset.insert(0, str(self.settings.audio.pre_vad_end_offset))
        self.pre_vad_audio_offset.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        ffmpeg_preset_i18n = audio_i18n.get('ffmpeg_preset', {})
        HoverInfoLabelWidget(audio_frame, text=ffmpeg_preset_i18n.get('label', '...'),
                             tooltip=ffmpeg_preset_i18n.get('tooltip', '...'), row=self.current_row, column=0)

        preset_options_i18n = ffmpeg_preset_i18n.get('options', {})
        self.ffmpeg_audio_preset_options_map = {
            preset_options_i18n.get('no_reencode', "No Re-encode"): "",
            preset_options_i18n.get('fade_in', "Simple Fade-in..."): "-c:a {encoder} -f {format} -af \"afade=t=in:d=0.10\"",
            preset_options_i18n.get('loudness_norm', "Simple loudness..."): "-c:a {encoder} -f {format} -af \"loudnorm=I=-23:TP=-2,afade=t=in:d=0.10\"",
            preset_options_i18n.get('downmix_norm', "Downmix to mono..."): "-c:a {encoder} -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.10\"",
            preset_options_i18n.get('downmix_norm_low_bitrate', "Downmix to mono, 30kbps..."): "-c:a {encoder} -b:a 30k -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.10\"",
            preset_options_i18n.get('custom', "Custom"): get_config().audio.custom_encode_settings,
        }

        self.ffmpeg_audio_preset_options = ttk.Combobox(audio_frame,
                                                        values=list(self.ffmpeg_audio_preset_options_map.keys()),
                                                        width=50, state="readonly")
        self.ffmpeg_audio_preset_options.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.ffmpeg_audio_preset_options.bind("<<ComboboxSelected>>", self.update_audio_ffmpeg_settings)
        self.current_row += 1

        ffmpeg_options_i18n = audio_i18n.get('ffmpeg_options', {})
        HoverInfoLabelWidget(audio_frame, text=ffmpeg_options_i18n.get('label', '...'),
                             tooltip=ffmpeg_options_i18n.get('tooltip', '...'), foreground="red",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.audio_ffmpeg_reencode_options = ttk.Entry(audio_frame, width=50)
        self.audio_ffmpeg_reencode_options.insert(0, self.settings.audio.ffmpeg_reencode_options)
        self.audio_ffmpeg_reencode_options.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        anki_media_i18n = audio_i18n.get('anki_media_collection', {})
        HoverInfoLabelWidget(audio_frame, text=anki_media_i18n.get('label', '...'),
                             tooltip=anki_media_i18n.get('tooltip', '...'),
                             foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.anki_media_collection = ttk.Entry(audio_frame)
        self.anki_media_collection.insert(0, self.settings.audio.anki_media_collection)
        self.anki_media_collection.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        ext_tool_i18n = audio_i18n.get('external_tool', {})
        HoverInfoLabelWidget(audio_frame, text=ext_tool_i18n.get('label', '...'),
                             tooltip=ext_tool_i18n.get('tooltip', '...'),
                             foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.external_tool = ttk.Entry(audio_frame)
        self.external_tool.insert(0, self.settings.audio.external_tool)
        self.external_tool.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.external_tool_enabled = tk.BooleanVar(value=self.settings.audio.external_tool_enabled)
        
        ext_tool_enabled_i18n = audio_i18n.get('external_tool_enabled', {})
        HoverInfoLabelWidget(audio_frame, text=ext_tool_enabled_i18n.get('label', '...'), tooltip=ext_tool_enabled_i18n.get('tooltip', '...'),
                             row=self.current_row, column=2, foreground="green", font=("Helvetica", 10, "bold"))
        ttk.Checkbutton(audio_frame, variable=self.external_tool_enabled, bootstyle="round-toggle").grid(
            row=self.current_row, column=3, sticky='W', padx=10, pady=5)
        self.current_row += 1

        ttk.Button(audio_frame, text=audio_i18n.get('install_ocenaudio_button', 'Install Ocenaudio'), command=self.download_and_install_ocen,
                   bootstyle="info").grid(row=self.current_row, column=0, pady=5)
        ttk.Button(audio_frame, text=audio_i18n.get('get_anki_media_button', 'Get Anki Media Collection'),
                   command=self.set_default_anki_media_collection, bootstyle="info").grid(row=self.current_row,
                                                                                          column=1, pady=5)
        self.current_row += 1

        self.add_reset_button(audio_frame, "audio", self.current_row, 0, self.create_audio_tab)

        for col in range(5): audio_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): audio_frame.grid_rowconfigure(row, minsize=30)

        return audio_frame

    def call_audio_offset_selector(self):
        try:
            path, beginning_offset, end_offset = gsm_state.previous_trim_args
            current_dir = os.path.dirname(os.path.abspath(__file__))
            script_path = os.path.join(current_dir, "audio_offset_selector.py")

            logger.info(' '.join([sys.executable, "-m", "GameSentenceMiner.util.audio_offset_selector",
                                  "--path", path, "--beginning_offset", str(beginning_offset), "--end_offset", str(end_offset)]))

            result = subprocess.run(
                [sys.executable, "-m", "GameSentenceMiner.util.audio_offset_selector",
                 "--path", path, "--beginning_offset", str(beginning_offset), "--end_offset", str(end_offset)],
                capture_output=True, text=True, check=False
            )
            if result.returncode != 0:
                logger.error(f"Script failed with return code: {result.returncode}")
                return None
            
            logger.info(result)
            logger.info(f"Audio offset selector script output: {result.stdout.strip()}")
            pyperclip.copy(result.stdout.strip())
            
            dialog_i18n = self.i18n.get('dialogs', {}).get('offset_copied', {})
            messagebox.showinfo(dialog_i18n.get('title', 'Clipboard'), dialog_i18n.get('message', 'Offset copied!'))
            return result.stdout.strip()

        except subprocess.CalledProcessError as e:
            logger.error(f"Error calling script: {e}\nStderr: {e.stderr.strip()}")
            return None
        except FileNotFoundError:
            logger.error(f"Error: Script not found at {script_path}.")
            return None
        except Exception as e:
            logger.error(f"An unexpected error occurred: {e}")
            return None

    @new_tab
    def create_obs_tab(self):
        if self.obs_tab is None:
            obs_i18n = self.i18n.get('tabs', {}).get('obs', {})
            self.obs_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.obs_tab, text=obs_i18n.get('title', 'OBS'))
        else:
            for widget in self.obs_tab.winfo_children():
                widget.destroy()

        obs_frame = self.obs_tab
        obs_i18n = self.i18n.get('tabs', {}).get('obs', {})

        enabled_i18n = obs_i18n.get('enabled', {})
        HoverInfoLabelWidget(obs_frame, text=enabled_i18n.get('label', '...'), tooltip=enabled_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.obs_enabled = tk.BooleanVar(value=self.settings.obs.enabled)
        ttk.Checkbutton(obs_frame, variable=self.obs_enabled, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                             column=1, sticky='W', pady=2)
        self.current_row += 1

        open_i18n = obs_i18n.get('open_obs', {})
        HoverInfoLabelWidget(obs_frame, text=open_i18n.get('label', '...'), tooltip=open_i18n.get('tooltip', '...'), row=self.current_row,
                             column=0)
        self.open_obs = tk.BooleanVar(value=self.settings.obs.open_obs)
        ttk.Checkbutton(obs_frame, variable=self.open_obs, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                          column=1, sticky='W', pady=2)
        self.current_row += 1

        close_i18n = obs_i18n.get('close_obs', {})
        HoverInfoLabelWidget(obs_frame, text=close_i18n.get('label', '...'), tooltip=close_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.close_obs = tk.BooleanVar(value=self.settings.obs.close_obs)
        ttk.Checkbutton(obs_frame, variable=self.close_obs, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                           column=1, sticky='W', pady=2)
        self.current_row += 1

        host_i18n = obs_i18n.get('host', {})
        HoverInfoLabelWidget(obs_frame, text=host_i18n.get('label', '...'), tooltip=host_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.obs_host = ttk.Entry(obs_frame)
        self.obs_host.insert(0, self.settings.obs.host)
        self.obs_host.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        port_i18n = obs_i18n.get('port', {})
        HoverInfoLabelWidget(obs_frame, text=port_i18n.get('label', '...'), tooltip=port_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.obs_port = ttk.Entry(obs_frame)
        self.obs_port.insert(0, str(self.settings.obs.port))
        self.obs_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        pass_i18n = obs_i18n.get('password', {})
        HoverInfoLabelWidget(obs_frame, text=pass_i18n.get('label', '...'), tooltip=pass_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.obs_password = ttk.Entry(obs_frame, show="*")
        self.obs_password.insert(0, self.settings.obs.password)
        self.obs_password.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        game_scene_i18n = obs_i18n.get('game_from_scene', {})
        HoverInfoLabelWidget(obs_frame, text=game_scene_i18n.get('label', '...'), tooltip=game_scene_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.get_game_from_scene_name = tk.BooleanVar(value=self.settings.obs.get_game_from_scene)
        ttk.Checkbutton(obs_frame, variable=self.get_game_from_scene_name, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        min_size_i18n = obs_i18n.get('min_replay_size', {})
        HoverInfoLabelWidget(obs_frame, text=min_size_i18n.get('label', '...'),
                             tooltip=min_size_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.minimum_replay_size = ttk.Entry(obs_frame)
        self.minimum_replay_size.insert(0, str(self.settings.obs.minimum_replay_size))
        self.minimum_replay_size.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        self.add_reset_button(obs_frame, "obs", self.current_row, 0, self.create_obs_tab)

        for col in range(3): obs_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): obs_frame.grid_rowconfigure(row, minsize=30)

        return obs_frame

    @new_tab
    def create_profiles_tab(self):
        if self.profiles_tab is None:
            profiles_i18n = self.i18n.get('tabs', {}).get('profiles', {})
            self.profiles_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.profiles_tab, text=profiles_i18n.get('title', 'Profiles'))
        else:
            for widget in self.profiles_tab.winfo_children():
                widget.destroy()

        profiles_frame = self.profiles_tab
        profiles_i18n = self.i18n.get('tabs', {}).get('profiles', {})

        select_i18n = profiles_i18n.get('select_profile', {})
        HoverInfoLabelWidget(profiles_frame, text=select_i18n.get('label', '...'), tooltip=select_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.profile_var = tk.StringVar(value=self.settings.name)
        self.profile_combobox = ttk.Combobox(profiles_frame, textvariable=self.profile_var,
                                             values=list(self.master_config.configs.keys()), state="readonly")
        self.profile_combobox.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.profile_combobox.bind("<<ComboboxSelected>>", self.on_profile_change)
        self.current_row += 1

        button_row = self.current_row
        ttk.Button(profiles_frame, text=profiles_i18n.get('add_button', 'Add Profile'), command=self.add_profile, bootstyle="primary").grid(
            row=button_row, column=0, pady=5)
        ttk.Button(profiles_frame, text=profiles_i18n.get('copy_button', 'Copy Profile'), command=self.copy_profile, bootstyle="secondary").grid(
            row=button_row, column=1, pady=5)
        self.delete_profile_button = ttk.Button(profiles_frame, text=profiles_i18n.get('delete_button', 'Delete Config'), command=self.delete_profile,
                                                bootstyle="danger")
        if self.master_config.current_profile != DEFAULT_CONFIG:
            self.delete_profile_button.grid(row=button_row, column=2, pady=5)
        else:
            self.delete_profile_button.grid_remove()
        self.current_row += 1

        scene_i18n = profiles_i18n.get('obs_scene', {})
        HoverInfoLabelWidget(profiles_frame, text=scene_i18n.get('label', '...'),
                             tooltip=scene_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.obs_scene_var = tk.StringVar(value="")
        self.obs_scene_listbox = tk.Listbox(profiles_frame, listvariable=self.obs_scene_var, selectmode=tk.MULTIPLE,
                                            height=10, width=50, selectbackground=ttk.Style().colors.primary)
        self.obs_scene_listbox.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.obs_scene_listbox.bind("<<ListboxSelect>>", self.on_obs_scene_select)
        ttk.Button(profiles_frame, text=profiles_i18n.get('refresh_scenes_button', 'Refresh Scenes'), command=self.refresh_obs_scenes, bootstyle="outline").grid(
            row=self.current_row, column=2, pady=5)
        self.current_row += 1

        switch_i18n = profiles_i18n.get('switch_to_default', {})
        HoverInfoLabelWidget(profiles_frame, text=switch_i18n.get('label', '...'),
                             tooltip=switch_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.switch_to_default_if_not_found = tk.BooleanVar(value=self.master_config.switch_to_default_if_not_found)
        ttk.Checkbutton(profiles_frame, variable=self.switch_to_default_if_not_found, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        for col in range(4): profiles_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): profiles_frame.grid_rowconfigure(row, minsize=30)

        return profiles_frame

    def on_obs_scene_select(self, event):
        self.settings.scenes = [self.obs_scene_listbox.get(i) for i in
                                self.obs_scene_listbox.curselection()]
        self.obs_scene_listbox_changed = True

    def refresh_obs_scenes(self):
        scenes = obs.get_obs_scenes()
        obs_scene_names = [scene['sceneName'] for scene in scenes]
        self.obs_scene_listbox.delete(0, tk.END)
        for scene_name in obs_scene_names:
            self.obs_scene_listbox.insert(tk.END, scene_name)
        for i, scene in enumerate(obs_scene_names):
            if scene.strip() in self.settings.scenes:
                self.obs_scene_listbox.select_set(i)
                self.obs_scene_listbox.activate(i)
        self.obs_scene_listbox.update_idletasks()

    @new_tab
    def create_advanced_tab(self):
        if self.advanced_tab is None:
            advanced_i18n = self.i18n.get('tabs', {}).get('advanced', {})
            self.advanced_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.advanced_tab, text=advanced_i18n.get('title', 'Advanced'))
        else:
            for widget in self.advanced_tab.winfo_children():
                widget.destroy()

        advanced_frame = self.advanced_tab
        advanced_i18n = self.i18n.get('tabs', {}).get('advanced', {})
        browse_text = self.i18n.get('buttons', {}).get('browse', 'Browse')

        ttk.Label(advanced_frame, text=advanced_i18n.get('player_note', '...'),
                  foreground="red", font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=3,
                                                                         sticky='W', pady=5)
        self.current_row += 1

        audio_player_i18n = advanced_i18n.get('audio_player_path', {})
        HoverInfoLabelWidget(advanced_frame, text=audio_player_i18n.get('label', '...'),
                             tooltip=audio_player_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.audio_player_path = ttk.Entry(advanced_frame, width=50)
        self.audio_player_path.insert(0, self.settings.advanced.audio_player_path)
        self.audio_player_path.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        ttk.Button(advanced_frame, text=browse_text, command=lambda: self.browse_file(self.audio_player_path),
                   bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
        self.current_row += 1

        video_player_i18n = advanced_i18n.get('video_player_path', {})
        HoverInfoLabelWidget(advanced_frame, text=video_player_i18n.get('label', '...'),
                             tooltip=video_player_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.video_player_path = ttk.Entry(advanced_frame, width=50)
        self.video_player_path.insert(0, self.settings.advanced.video_player_path)
        self.video_player_path.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        ttk.Button(advanced_frame, text=browse_text, command=lambda: self.browse_file(self.video_player_path),
                   bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
        self.current_row += 1

        play_hotkey_i18n = advanced_i18n.get('play_latest_hotkey', {})
        HoverInfoLabelWidget(advanced_frame, text=play_hotkey_i18n.get('label', '...'),
                             tooltip=play_hotkey_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.play_latest_audio_hotkey = ttk.Entry(advanced_frame)
        self.play_latest_audio_hotkey.insert(0, self.settings.hotkeys.play_latest_audio)
        self.play_latest_audio_hotkey.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        linebreak_i18n = advanced_i18n.get('multiline_linebreak', {})
        HoverInfoLabelWidget(advanced_frame, text=linebreak_i18n.get('label', '...'),
                             tooltip=linebreak_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.multi_line_line_break = ttk.Entry(advanced_frame)
        self.multi_line_line_break.insert(0, self.settings.advanced.multi_line_line_break)
        self.multi_line_line_break.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        storage_field_i18n = advanced_i18n.get('multiline_storage_field', {})
        HoverInfoLabelWidget(advanced_frame, text=storage_field_i18n.get('label', '...'),
                             tooltip=storage_field_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.multi_line_sentence_storage_field = ttk.Entry(advanced_frame)
        self.multi_line_sentence_storage_field.insert(0, self.settings.advanced.multi_line_sentence_storage_field)
        self.multi_line_sentence_storage_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        ocr_port_i18n = advanced_i18n.get('ocr_port', {})
        HoverInfoLabelWidget(advanced_frame, text=ocr_port_i18n.get('label', '...'),
                             tooltip=ocr_port_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.ocr_websocket_port = ttk.Entry(advanced_frame)
        self.ocr_websocket_port.insert(0, str(self.settings.advanced.ocr_websocket_port))
        self.ocr_websocket_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        comm_port_i18n = advanced_i18n.get('texthooker_comm_port', {})
        HoverInfoLabelWidget(advanced_frame, text=comm_port_i18n.get('label', '...'),
                             tooltip=comm_port_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.texthooker_communication_websocket_port = ttk.Entry(advanced_frame)
        self.texthooker_communication_websocket_port.insert(0, str(self.settings.advanced.texthooker_communication_websocket_port))
        self.texthooker_communication_websocket_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        export_port_i18n = advanced_i18n.get('plaintext_export_port', {})
        HoverInfoLabelWidget(advanced_frame, text=export_port_i18n.get('label', '...'),
                             tooltip=export_port_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.plaintext_websocket_export_port = ttk.Entry(advanced_frame)
        self.plaintext_websocket_export_port.insert(0, str(self.settings.advanced.plaintext_websocket_port))
        self.plaintext_websocket_export_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        reset_hotkey_i18n = advanced_i18n.get('reset_line_hotkey', {})
        HoverInfoLabelWidget(advanced_frame, text=reset_hotkey_i18n.get('label', '...'),
                             tooltip=reset_hotkey_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.reset_line_hotkey = ttk.Entry(advanced_frame)
        self.reset_line_hotkey.insert(0, self.settings.hotkeys.reset_line)
        self.reset_line_hotkey.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        polling_i18n = advanced_i18n.get('polling_rate', {})
        HoverInfoLabelWidget(advanced_frame, text=polling_i18n.get('label', '...'),
                             tooltip=polling_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.polling_rate = ttk.Entry(advanced_frame)
        self.polling_rate.insert(0, str(self.settings.anki.polling_rate))
        self.polling_rate.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1
        
        current_ver_i18n = advanced_i18n.get('current_version', {})
        HoverInfoLabelWidget(advanced_frame, text=current_ver_i18n.get('label', 'Current Version:'), bootstyle="secondary",
                             tooltip=current_ver_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.current_version = ttk.Label(advanced_frame, text=get_current_version(), bootstyle="secondary")
        self.current_version.grid(row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        latest_ver_i18n = advanced_i18n.get('latest_version', {})
        HoverInfoLabelWidget(advanced_frame, text=latest_ver_i18n.get('label', 'Latest Version:'), bootstyle="secondary",
                             tooltip=latest_ver_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.latest_version = ttk.Label(advanced_frame, text=get_latest_version(), bootstyle="secondary")
        self.latest_version.grid(row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        self.add_reset_button(advanced_frame, "advanced", self.current_row, 0, self.create_advanced_tab)

        for col in range(4): advanced_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): advanced_frame.grid_rowconfigure(row, minsize=30)

        return advanced_frame

    @new_tab
    def create_ai_tab(self):
        if self.ai_tab is None:
            ai_i18n = self.i18n.get('tabs', {}).get('ai', {})
            self.ai_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.ai_tab, text=ai_i18n.get('title', 'AI'))
        else:
            for widget in self.ai_tab.winfo_children():
                widget.destroy()

        ai_frame = self.ai_tab
        ai_i18n = self.i18n.get('tabs', {}).get('ai', {})

        enabled_i18n = ai_i18n.get('enabled', {})
        HoverInfoLabelWidget(ai_frame, text=enabled_i18n.get('label', '...'), tooltip=enabled_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.ai_enabled = tk.BooleanVar(value=self.settings.ai.enabled)
        ttk.Checkbutton(ai_frame, variable=self.ai_enabled, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                           column=1, sticky='W', pady=2)
        self.current_row += 1

        provider_i18n = ai_i18n.get('provider', {})
        HoverInfoLabelWidget(ai_frame, text=provider_i18n.get('label', '...'), tooltip=provider_i18n.get('tooltip', '...'), row=self.current_row,
                             column=0)
        self.ai_provider = ttk.Combobox(ai_frame, values=[AI_GEMINI, AI_GROQ, AI_LOCAL], state="readonly")
        self.ai_provider.set(self.settings.ai.provider)
        self.ai_provider.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        gemini_model_i18n = ai_i18n.get('gemini_model', {})
        HoverInfoLabelWidget(ai_frame, text=gemini_model_i18n.get('label', '...'), tooltip=gemini_model_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.gemini_model = ttk.Combobox(ai_frame, values=['gemma-3n-e4b-it', 'gemini-2.5-flash-lite', 'gemini-2.5-flash','gemini-2.0-flash', 'gemini-2.0-flash-lite'], state="readonly")
        try:
            self.gemini_model.set(self.settings.ai.gemini_model)
        except Exception:
            self.gemini_model.set('gemini-2.5-flash')
        self.gemini_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        gemini_key_i18n = ai_i18n.get('gemini_api_key', {})
        HoverInfoLabelWidget(ai_frame, text=gemini_key_i18n.get('label', '...'),
                             tooltip=gemini_key_i18n.get('tooltip', '...'),
                             foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.gemini_api_key = ttk.Entry(ai_frame, show="*")
        self.gemini_api_key.insert(0, self.settings.ai.gemini_api_key)
        self.gemini_api_key.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        groq_model_i18n = ai_i18n.get('groq_model', {})
        HoverInfoLabelWidget(ai_frame, text=groq_model_i18n.get('label', '...'), tooltip=groq_model_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.groq_model = ttk.Combobox(ai_frame, values=['meta-llama/llama-4-maverick-17b-128e-instruct',
                                                         'meta-llama/llama-4-scout-17b-16e-instruct',
                                                         'llama-3.1-8b-instant'], state="readonly")
        self.groq_model.set(self.settings.ai.groq_model)
        self.groq_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        groq_key_i18n = ai_i18n.get('groq_api_key', {})
        HoverInfoLabelWidget(ai_frame, text=groq_key_i18n.get('label', '...'), tooltip=groq_key_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.groq_api_key = ttk.Entry(ai_frame, show="*")
        self.groq_api_key.insert(0, self.settings.ai.groq_api_key)
        self.groq_api_key.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        local_model_i18n = ai_i18n.get('local_model', {})
        HoverInfoLabelWidget(ai_frame, text=local_model_i18n.get('label', '...'), tooltip=local_model_i18n.get('tooltip', '...'),
                             foreground="red", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.local_ai_model = ttk.Combobox(ai_frame, values=[OFF, 'facebook/nllb-200-distilled-600M', 'facebook/nllb-200-1.3B', 'facebook/nllb-200-3.3B'])
        self.local_ai_model.set(self.settings.ai.local_model)
        self.local_ai_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        anki_field_i18n = ai_i18n.get('anki_field', {})
        HoverInfoLabelWidget(ai_frame, text=anki_field_i18n.get('label', '...'), tooltip=anki_field_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.ai_anki_field = ttk.Entry(ai_frame)
        self.ai_anki_field.insert(0, self.settings.ai.anki_field)
        self.ai_anki_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        context_i18n = ai_i18n.get('context_length', {})
        HoverInfoLabelWidget(ai_frame, text=context_i18n.get('label', '...'), tooltip=context_i18n.get('tooltip', '...'),
                             foreground="red", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.ai_dialogue_context_length = ttk.Entry(ai_frame)
        self.ai_dialogue_context_length.insert(0, str(self.settings.ai.dialogue_context_length))
        self.ai_dialogue_context_length.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        canned_trans_i18n = ai_i18n.get('use_canned_translation', {})
        HoverInfoLabelWidget(ai_frame, text=canned_trans_i18n.get('label', '...'),
                             tooltip=canned_trans_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.use_canned_translation_prompt = tk.BooleanVar(value=self.settings.ai.use_canned_translation_prompt)
        ttk.Checkbutton(ai_frame, variable=self.use_canned_translation_prompt, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        canned_context_i18n = ai_i18n.get('use_canned_context', {})
        HoverInfoLabelWidget(ai_frame, text=canned_context_i18n.get('label', '...'),
                             tooltip=canned_context_i18n.get('tooltip', '...'), row=self.current_row, column=0)
        self.use_canned_context_prompt = tk.BooleanVar(value=self.settings.ai.use_canned_context_prompt)
        ttk.Checkbutton(ai_frame, variable=self.use_canned_context_prompt, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        custom_prompt_i18n = ai_i18n.get('custom_prompt', {})
        HoverInfoLabelWidget(ai_frame, text=custom_prompt_i18n.get('label', '...'), tooltip=custom_prompt_i18n.get('tooltip', '...'),
                             row=self.current_row, column=0)
        self.custom_prompt = scrolledtext.ScrolledText(ai_frame, width=50, height=5, font=("TkDefaultFont", 9),
                                                       relief="solid", borderwidth=1,
                                                       highlightbackground=ttk.Style().colors.border)
        self.custom_prompt.insert(tk.END, self.settings.ai.custom_prompt)
        self.custom_prompt.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        self.add_reset_button(ai_frame, "ai", self.current_row, 0, self.create_ai_tab)

        for col in range(3): ai_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): ai_frame.grid_rowconfigure(row, minsize=30)

        return ai_frame
    
    @new_tab
    def create_wip_tab(self):
        if self.wip_tab is None:
            wip_i18n = self.i18n.get('tabs', {}).get('wip', {})
            self.wip_tab = ttk.Frame(self.notebook, padding=15)
            self.notebook.add(self.wip_tab, text=wip_i18n.get('title', 'WIP'))
        else:
            for widget in self.wip_tab.winfo_children():
                widget.destroy()

        wip_frame = self.wip_tab
        wip_i18n = self.i18n.get('tabs', {}).get('wip', {})
        try:
            ttk.Label(wip_frame, text=wip_i18n.get('warning_experimental', '...'),
                    foreground="red", font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2,
                                                                        sticky='W', pady=5)
            self.current_row += 1
            
            ttk.Label(wip_frame, text=wip_i18n.get('warning_overlay_deps', '...'),
                    foreground="red", font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2,
                                                                        sticky='W', pady=5)
            self.current_row += 1

            overlay_port_i18n = wip_i18n.get('overlay_port', {})
            HoverInfoLabelWidget(wip_frame, text=overlay_port_i18n.get('label', '...'),
                                tooltip=overlay_port_i18n.get('tooltip', '...'),
                                row=self.current_row, column=0)
            self.overlay_websocket_port = ttk.Entry(wip_frame)
            self.overlay_websocket_port.insert(0, str(self.settings.wip.overlay_websocket_port))
            self.overlay_websocket_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
            self.current_row += 1

            overlay_send_i18n = wip_i18n.get('overlay_send', {})
            HoverInfoLabelWidget(wip_frame, text=overlay_send_i18n.get('label', '...'),
                                tooltip=overlay_send_i18n.get('tooltip', '...'),
                                row=self.current_row, column=0)
            self.overlay_websocket_send = tk.BooleanVar(value=self.settings.wip.overlay_websocket_send)
            ttk.Checkbutton(wip_frame, variable=self.overlay_websocket_send, bootstyle="round-toggle").grid(
                row=self.current_row, column=1, sticky='W', pady=2)
            self.current_row += 1

            monitor_i18n = wip_i18n.get('monitor_capture', {})
            HoverInfoLabelWidget(wip_frame, text=monitor_i18n.get('label', '...'),
                                tooltip=monitor_i18n.get('tooltip', '...'),
                                row=self.current_row, column=0)
            self.monitor_to_capture = ttk.Combobox(wip_frame, values=self.monitors, state="readonly")
            
            if self.monitors:
                self.monitor_to_capture.current(self.settings.wip.monitor_to_capture)
            else:
                self.monitor_to_capture.set(monitor_i18n.get('not_detected', "OwOCR Not Detected"))
            self.monitor_to_capture.grid(row=self.current_row, column=1, sticky='EW', pady=2)
            self.current_row += 1

        except Exception as e:
            logger.error(f"Error setting up wip tab to capture: {e}")
            ttk.Label(wip_frame, text=wip_i18n.get('error_setup', 'Error setting up WIP tab'), foreground="red").grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=5)

        self.add_reset_button(wip_frame, "wip", self.current_row, 0, self.create_wip_tab)

        for col in range(2): wip_frame.grid_columnconfigure(col, weight=0)
        for row in range(self.current_row): wip_frame.grid_rowconfigure(row, minsize=30)

        return wip_frame

    def on_profile_change(self, event):
        self.save_settings(profile_change=True)
        self.reload_settings(force_refresh=True)
        self.refresh_obs_scenes()
        if self.master_config.current_profile != DEFAULT_CONFIG:
            self.delete_profile_button.grid(row=1, column=2, pady=5)
        else:
            self.delete_profile_button.grid_remove()

    def add_profile(self):
        dialog_i18n = self.i18n.get('dialogs', {}).get('add_profile', {})
        new_profile_name = simpledialog.askstring(dialog_i18n.get('title', 'Input'), dialog_i18n.get('prompt', 'Enter new profile name:'))
        if new_profile_name:
            self.master_config.configs[new_profile_name] = self.master_config.get_default_config()
            self.profile_combobox['values'] = list(self.master_config.configs.keys())
            self.profile_combobox.set(new_profile_name)
            self.save_settings()
            self.reload_settings()

    def copy_profile(self):
        source_profile = self.profile_combobox.get()
        dialog_i18n = self.i18n.get('dialogs', {}).get('copy_profile', {})
        new_profile_name = simpledialog.askstring(dialog_i18n.get('title', 'Input'), dialog_i18n.get('prompt', 'Enter new profile name:'), parent=self.window)
        if new_profile_name and source_profile in self.master_config.configs:
            import copy
            self.master_config.configs[new_profile_name] = copy.deepcopy(self.master_config.configs[source_profile])
            self.master_config.configs[new_profile_name].name = new_profile_name
            self.profile_combobox['values'] = list(self.master_config.configs.keys())
            self.profile_combobox.set(new_profile_name)
            self.save_settings()
            self.reload_settings()

    def delete_profile(self):
        profile_to_delete = self.profile_combobox.get()
        dialog_i18n = self.i18n.get('dialogs', {}).get('delete_profile', {})
        error_title = dialog_i18n.get('error_title', 'Error')
        
        if profile_to_delete == "Default":
            messagebox.showerror(error_title, dialog_i18n.get('error_cannot_delete_default', 'Cannot delete the Default profile.'))
            return

        if profile_to_delete and profile_to_delete in self.master_config.configs:
            confirm = messagebox.askyesno(dialog_i18n.get('title', 'Confirm Delete'),
                                          dialog_i18n.get('message', "Are you sure... '{profile_name}'?").format(profile_name=profile_to_delete),
                                          parent=self.window, icon='warning')
            if confirm:
                del self.master_config.configs[profile_to_delete]
                self.profile_combobox['values'] = list(self.master_config.configs.keys())
                self.profile_combobox.set("Default")
                self.master_config.current_profile = "Default"
                save_full_config(self.master_config)
                self.reload_settings()

    def download_and_install_ocen(self):
        dialog_i18n = self.i18n.get('dialogs', {}).get('install_ocenaudio', {})
        confirm = messagebox.askyesno(dialog_i18n.get('title', 'Download OcenAudio?'),
                                      dialog_i18n.get('message', 'Would you like to download...?'),
                                      parent=self.window, icon='question')
        if confirm:
            self.external_tool.delete(0, tk.END)
            self.external_tool.insert(0, dialog_i18n.get('downloading_message', 'Downloading...'))
            exe_path = download_ocenaudio_if_needed()
            messagebox.showinfo(dialog_i18n.get('success_title', 'Download Complete'),
                                dialog_i18n.get('success_message', 'Downloaded to {path}').format(path=exe_path),
                                parent=self.window)
            self.external_tool.delete(0, tk.END)
            self.external_tool.insert(0, exe_path)
            self.save_settings()

    def set_default_anki_media_collection(self):
        dialog_i18n = self.i18n.get('dialogs', {}).get('set_anki_media', {})
        confirm = messagebox.askyesno(dialog_i18n.get('title', 'Set Default Path?'),
                                      dialog_i18n.get('message', 'Would you like to set...?'),
                                      parent=self.window, icon='question')
        if confirm:
            default_path = get_default_anki_media_collection_path()
            if default_path != self.settings.audio.anki_media_collection:
                self.anki_media_collection.delete(0, tk.END)
                self.anki_media_collection.insert(0, default_path)
                self.save_settings()


if __name__ == '__main__':
    # Ensure 'en_us.json' is in the same directory as this script to run this example
    root = ttk.Window(themename='darkly')
    window = ConfigApp(root)
    window.show()
    window.window.mainloop()