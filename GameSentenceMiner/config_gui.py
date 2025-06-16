import asyncio
import subprocess
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
    def __init__(self, parent, text, tooltip, row, column, padx=5, pady=2, foreground="white", sticky='W', bootstyle=None, font=("Arial", 10, "normal")):
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


class ConfigApp:
    def __init__(self, root):
        self.window = root
        self.on_exit = None
        # self.window = ttk.Window(themename='darkly')
        self.window.title('GameSentenceMiner Configuration')
        self.window.protocol("WM_DELETE_WINDOW", self.hide)
        self.obs_scene_listbox_changed = False

        self.window.geometry("800x600")
        self.current_row = 0

        self.master_config: Config = configuration.load_config()

        self.settings = self.master_config.get_config()

        self.notebook = ttk.Notebook(self.window)
        self.notebook.pack(pady=10, expand=True, fill='both')

        self.general_frame = self.create_general_tab()
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
        # self.create_help_tab()

        self.notebook.bind("<<NotebookTabChanged>>", self.on_profiles_tab_selected)

        button_frame = ttk.Frame(self.window)
        button_frame.pack(side="bottom", pady=20, anchor="center")

        ttk.Button(button_frame, text="Save Settings", command=self.save_settings, bootstyle="success").grid(row=0,
                                                                                                             column=0,
                                                                                                             padx=10)
        # if len(self.master_config.configs) > 1:
        #     ttk.Button(button_frame, text="Save and Sync Changes",
        #                command=lambda: self.save_settings(profile_change=False, sync_changes=True),
        #                bootstyle="info").grid(row=0, column=1, padx=10)
        #     HoverInfoWidget(button_frame,
        #                     "Saves Settings and Syncs changed settings to all profiles (if you have them)", row=0,
        #                     column=2)

        self.window.withdraw()

    def show_scene_selection(self, matched_configs):
        selected_scene = None
        if matched_configs:
            selection_window = tk.Toplevel(self.window)
            selection_window.title("Select Profile")
            selection_window.transient(self.window)  # Make it modal relative to the main window
            selection_window.grab_set()  # Grab all events for this window

            ttk.Label(selection_window,
                      text="Multiple profiles match the current scene. Please select the profile:").pack(pady=10)
            profile_var = tk.StringVar(value=matched_configs[0])
            profile_dropdown = ttk.Combobox(selection_window, textvariable=profile_var, values=matched_configs,
                                            state="readonly")
            profile_dropdown.pack(pady=5)
            ttk.Button(selection_window, text="OK",
                       command=lambda: [selection_window.destroy(), setattr(self, 'selected_scene', profile_var.get())],
                       bootstyle="primary").pack(pady=10)

            self.window.wait_window(selection_window)  # Wait for selection_window to close
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
            return

    def hide(self):
        if self.window is not None:
            self.window.withdraw()

    def save_settings(self, profile_change=False, sync_changes=False):
        global settings_saved

        # Create a new Config instance
        config = ProfileConfig(
            scenes=[self.obs_scene_listbox.get(i) for i in
                    self.obs_scene_listbox.curselection()] if self.obs_scene_listbox_changed else self.settings.scenes,
            general=General(
                use_websocket=self.websocket_enabled.get(),
                use_clipboard=self.clipboard_enabled.get(),
                websocket_uri=self.websocket_uri.get(),
                open_config_on_startup=self.open_config_on_startup.get(),
                open_multimine_on_startup=self.open_multimine_on_startup.get(),
                texthook_replacement_regex=self.texthook_replacement_regex.get(),
                use_both_clipboard_and_websocket=self.use_both_clipboard_and_websocket.get(),
                texthooker_port=int(self.texthooker_port.get())
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
                # open_utility=self.open_utility_hotkey.get(),
                play_latest_audio=self.play_latest_audio_hotkey.get()
            ),
            vad=VAD(
                whisper_model=self.whisper_model.get(),
                do_vad_postprocessing=self.do_vad_postprocessing.get(),
                vosk_url='https://alphacephei.com/vosk/models/vosk-model-ja-0.22.zip' if self.vosk_url.get() == VOSK_BASE else "https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip",
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
                use_anki_note_creation_time=self.use_anki_note_creation_time.get(),
                ocr_websocket_port=int(self.ocr_websocket_port.get()),
                texthooker_communication_websocket_port=int(self.texthooker_communication_websocket_port.get()),
            ),
            ai=Ai(
                enabled=self.ai_enabled.get(),
                provider=self.ai_provider.get(),
                gemini_model=self.gemini_model.get(),
                groq_model=self.groq_model.get(),
                gemini_api_key=self.gemini_api_key.get(),
                api_key=self.gemini_api_key.get(),
                groq_api_key=self.groq_api_key.get(),
                anki_field=self.ai_anki_field.get(),
                use_canned_translation_prompt=self.use_canned_translation_prompt.get(),
                use_canned_context_prompt=self.use_canned_context_prompt.get(),
                custom_prompt=self.custom_prompt.get("1.0", tk.END)
            )
        )

        if self.ffmpeg_audio_preset_options.get() == "Custom":
            config.audio.custom_encode_settings = self.audio_ffmpeg_reencode_options.get()

        if config.features.backfill_audio and config.features.full_auto:
            messagebox.showerror("Configuration Error",
                                 "Cannot have Full Auto and Backfill mode on at the same time! Note: Backfill is a very niche workflow.")
            return

        if not config.general.use_websocket and not config.general.use_clipboard:
            messagebox.showerror("Configuration Error", "Cannot have both Clipboard and Websocket Disabled.")
            return

        current_profile = self.profile_combobox.get()
        prev_config = self.master_config.get_config()
        self.master_config.switch_to_default_if_not_found = self.switch_to_default_if_not_found.get()
        if profile_change:
            self.master_config.current_profile = current_profile
        else:
            self.master_config.current_profile = current_profile
            self.master_config.set_config_for_profile(current_profile, config)

        self.master_config = self.master_config.sync_shared_fields()

        if sync_changes:
            self.master_config.sync_changed_fields(prev_config)

        # Serialize the config instance to JSON
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

    def reload_settings(self):
        new_config = configuration.load_config()
        current_config = new_config.get_config()

        self.window.title("GameSentenceMiner Configuration - " + current_config.name)

        if current_config.name != self.settings.name or self.settings.config_changed(current_config):
            logger.info("Config changed, reloading settings.")
            self.master_config = new_config
            self.settings = current_config
            for frame in self.notebook.winfo_children():
                frame.destroy()

            self.general_frame = self.create_general_tab()
            self.create_paths_tab()
            self.create_anki_tab()
            self.create_vad_tab()
            self.create_features_tab()
            self.create_screenshot_tab()
            self.create_audio_tab()
            self.create_obs_tab()
            self.create_profiles_tab()
            self.create_advanced_tab()
            self.create_ai_tab()
            self.create_help_tab()  # Re-add help tab for modern styling consistent application

    def increment_row(self):
        """Increment the current row index and return the new value."""
        self.current_row += 1
        return self.current_row

    def add_label_and_increment_row(self, root, label, row=0, column=0):
        HoverInfoWidget(root, label, row=self.current_row, column=column)
        self.increment_row()

    def add_label_without_row_increment(self, root, label, row=0, column=0):
        HoverInfoWidget(root, label, row=self.current_row, column=column)

    @new_tab
    def create_general_tab(self):
        general_frame = ttk.Frame(self.notebook, padding=5)
        self.notebook.add(general_frame, text='General')

        HoverInfoLabelWidget(general_frame, text="Websocket Enabled:",
                             foreground="dark orange", font=("Helvetica", 10, "bold"),
                             tooltip="Enable or disable WebSocket communication. Enabling this will disable the clipboard monitor.",
                             row=self.current_row, column=0)
        self.websocket_enabled = tk.BooleanVar(value=self.settings.general.use_websocket)
        ttk.Checkbutton(general_frame, variable=self.websocket_enabled, bootstyle="round-toggle").grid(
            row=self.current_row, column=1,
            sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(general_frame, text="Clipboard Enabled:",
                             foreground="dark orange", font=("Helvetica", 10, "bold"),
                             tooltip="Enable or disable Clipboard monitoring.", row=self.current_row, column=0)
        self.clipboard_enabled = tk.BooleanVar(value=self.settings.general.use_clipboard)
        ttk.Checkbutton(general_frame, variable=self.clipboard_enabled, bootstyle="round-toggle").grid(
            row=self.current_row, column=1,
            sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(general_frame, text="Allow Both Simultaneously:",
                             foreground="red", font=("Helvetica", 10, "bold"),
                             tooltip="Enable to allow GSM to accept both clipboard and websocket input at the same time.",
                             row=self.current_row, column=0)
        self.use_both_clipboard_and_websocket = tk.BooleanVar(
            value=self.settings.general.use_both_clipboard_and_websocket)
        ttk.Checkbutton(general_frame, variable=self.use_both_clipboard_and_websocket, bootstyle="round-toggle").grid(
            row=self.current_row, column=1,
            sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(general_frame, text="Websocket URI(s):",
                             tooltip="WebSocket URI for connecting. Allows Comma Separated Values for Connecting Multiple.",
                             row=self.current_row, column=0)
        self.websocket_uri = ttk.Entry(general_frame, width=50)
        self.websocket_uri.insert(0, self.settings.general.websocket_uri)
        self.websocket_uri.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(general_frame, text="TextHook Replacement Regex:",
                             tooltip="Regex to run replacement on texthook input, set this to the same as what you may have in your texthook page.",
                             row=self.current_row, column=0)
        self.texthook_replacement_regex = ttk.Entry(general_frame)
        self.texthook_replacement_regex.insert(0, self.settings.general.texthook_replacement_regex)
        self.texthook_replacement_regex.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(general_frame, text="Open Config on Startup:",
                             tooltip="Whether to open config when the script starts.", row=self.current_row, column=0)
        self.open_config_on_startup = tk.BooleanVar(value=self.settings.general.open_config_on_startup)
        ttk.Checkbutton(general_frame, variable=self.open_config_on_startup, bootstyle="round-toggle").grid(
            row=self.current_row, column=1,
            sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(general_frame, text="Open GSM Texthooker on Startup:",
                             tooltip="Whether to open Texthooking page when the script starts.", row=self.current_row,
                             column=0)
        self.open_multimine_on_startup = tk.BooleanVar(value=self.settings.general.open_multimine_on_startup)
        ttk.Checkbutton(general_frame, variable=self.open_multimine_on_startup, bootstyle="round-toggle").grid(
            row=self.current_row, column=1,
            sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(general_frame, text="GSM Texthooker Port:",
                             tooltip="Port for the Texthooker to run on. Only change if you know what you are doing.",
                             row=self.current_row, column=0)
        self.texthooker_port = ttk.Entry(general_frame)
        self.texthooker_port.insert(0, str(self.settings.general.texthooker_port))
        self.texthooker_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(general_frame, text="Current Version:", bootstyle="secondary",
                             tooltip="The current version of the application.", row=self.current_row, column=0)
        self.current_version = ttk.Label(general_frame, text=get_current_version(), bootstyle="secondary")
        self.current_version.grid(row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(general_frame, text="Latest Version:", bootstyle="secondary",
                             tooltip="The latest available version of the application.", row=self.current_row, column=0)
        self.latest_version = ttk.Label(general_frame, text=get_latest_version(), bootstyle="secondary")
        self.latest_version.grid(row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        ttk.Label(general_frame, text="Indicates important/required settings.", foreground="dark orange",
                  font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
        self.current_row += 1
        ttk.Label(general_frame, text="Highlights Advanced Features that may break things.", foreground="red",
                  font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
        self.current_row += 1
        ttk.Label(general_frame, text="Indicates Recommended, but completely optional settings.", foreground="green",
                  font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
        self.current_row += 1
        ttk.Label(general_frame, text="Every Label in settings has a tooltip with more information if you hover over them.",
                font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=2, sticky='W', pady=2)
        self.current_row += 1

        general_frame.grid_columnconfigure(0, weight=0)  # No expansion for the label column
        general_frame.grid_columnconfigure(1, weight=0)  # Entry column gets more space
        for row in range(self.current_row):
            general_frame.grid_rowconfigure(row, minsize=30)

        return general_frame

    @new_tab
    def create_required_settings_tab(self):
        required_settings_frame = ttk.Frame(self.notebook)
        self.notebook.add(required_settings_frame, text='Required Settings')
        return required_settings_frame

    @new_tab
    def create_vad_tab(self):
        vad_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(vad_frame, text='VAD')

        HoverInfoLabelWidget(vad_frame, text="Voice Detection Postprocessing:",
                             tooltip="Enable post-processing of audio to trim just the voiceline.",
                             row=self.current_row, column=0)
        self.do_vad_postprocessing = tk.BooleanVar(
            value=self.settings.vad.do_vad_postprocessing)
        ttk.Checkbutton(vad_frame, variable=self.do_vad_postprocessing, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(vad_frame, text="Language:",
                             tooltip="Select the language for VAD. This is used for Whisper and Groq (if i implemented it)",
                             row=self.current_row, column=0)
        self.language = ttk.Combobox(vad_frame, values=AVAILABLE_LANGUAGES, state="readonly")
        self.language.set(self.settings.vad.language)
        self.language.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(vad_frame, text="Whisper Model:", tooltip="Select the Whisper model size for VAD.",
                             row=self.current_row, column=0)
        self.whisper_model = ttk.Combobox(vad_frame, values=[WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, WHISPER_MEDIUM,
                                                             WHSIPER_LARGE, WHISPER_TURBO], state="readonly")
        self.whisper_model.set(self.settings.vad.whisper_model)
        self.whisper_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(vad_frame, text="Select VAD Model:", tooltip="Select which VAD model to use.",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.selected_vad_model = ttk.Combobox(vad_frame, values=[VOSK, SILERO, WHISPER, GROQ], state="readonly")
        self.selected_vad_model.set(self.settings.vad.selected_vad_model)
        self.selected_vad_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(vad_frame, text="Backup VAD Model:",
                             tooltip="Select which model to use as a backup if no audio is found.",
                             row=self.current_row, column=0)
        self.backup_vad_model = ttk.Combobox(vad_frame, values=[OFF, VOSK, SILERO, WHISPER, GROQ], state="readonly")
        self.backup_vad_model.set(self.settings.vad.backup_vad_model)
        self.backup_vad_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(vad_frame, text="Add Audio on No Results:",
                             tooltip="Add audio even if no results are found by VAD.", row=self.current_row, column=0)
        self.add_audio_on_no_results = tk.BooleanVar(value=self.settings.vad.add_audio_on_no_results)
        ttk.Checkbutton(vad_frame, variable=self.add_audio_on_no_results, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(vad_frame, text="Audio End Offset:",
                             tooltip="Offset in seconds from end of the video to extract.", foreground="dark orange",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.end_offset = ttk.Entry(vad_frame)
        self.end_offset.insert(0, str(self.settings.audio.end_offset))
        self.end_offset.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(vad_frame, text="Trim Beginning:",
                             tooltip='Beginning offset after VAD Trim, Only active if "Trim Beginning" is ON. Negative values = more time at the beginning',
                             row=self.current_row, column=0)
        self.vad_trim_beginning = tk.BooleanVar(
            value=self.settings.vad.trim_beginning)
        ttk.Checkbutton(vad_frame, variable=self.vad_trim_beginning, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)

        HoverInfoLabelWidget(vad_frame, text="Beginning Offset:",
                             tooltip='Beginning offset after VAD Trim, Only active if "Trim Beginning" is ON. Negative values = more time at the beginning',
                             row=self.current_row, column=2)
        self.vad_beginning_offset = ttk.Entry(vad_frame)
        self.vad_beginning_offset.insert(0, str(self.settings.vad.beginning_offset))
        self.vad_beginning_offset.grid(row=self.current_row, column=3, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(vad_frame, text="Cut and Splice Segments:",
                             tooltip="Cut Detected Voice Segments and Paste them back together. More Padding = More Space between voicelines.",
                             row=self.current_row, column=0)
        self.cut_and_splice_segments = tk.BooleanVar(value=self.settings.vad.cut_and_splice_segments)
        ttk.Checkbutton(vad_frame, variable=self.cut_and_splice_segments, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        HoverInfoLabelWidget(vad_frame, text="Padding:",
                             tooltip="Cut Detected Voice Segments and Paste them back together. More Padding = More Space between voicelines.",
                             row=self.current_row, column=2)
        self.splice_padding = ttk.Entry(vad_frame)
        self.splice_padding.insert(0, str(self.settings.vad.splice_padding))
        self.splice_padding.grid(row=self.current_row, column=3, sticky='EW', pady=2)
        self.current_row += 1

        for col in range(5):
            vad_frame.grid_columnconfigure(col, weight=0)

        for row in range(self.current_row):
            vad_frame.grid_rowconfigure(row, minsize=30)

    @new_tab
    def create_paths_tab(self):
        paths_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(paths_frame, text='Paths')

        HoverInfoLabelWidget(paths_frame, text="Folder to Watch:", tooltip="Path where the OBS Replays will be saved.",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.folder_to_watch = ttk.Entry(paths_frame, width=50)
        self.folder_to_watch.insert(0, self.settings.paths.folder_to_watch)
        self.folder_to_watch.grid(row=self.current_row, column=1, sticky='W', pady=2)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.folder_to_watch),
                   bootstyle="outline").grid(
            row=self.current_row,
            column=2, padx=5, pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(paths_frame, text="Audio Destination:", tooltip="Path where the cut Audio will be saved.",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.audio_destination = ttk.Entry(paths_frame, width=50)
        self.audio_destination.insert(0, self.settings.paths.audio_destination)
        self.audio_destination.grid(row=self.current_row, column=1, sticky='W', pady=2)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.audio_destination),
                   bootstyle="outline").grid(
            row=self.current_row,
            column=2, padx=5, pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(paths_frame, text="Screenshot Destination:",
                             tooltip="Path where the Screenshot will be saved.", foreground="dark orange",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.screenshot_destination = ttk.Entry(paths_frame, width=50)
        self.screenshot_destination.insert(0, self.settings.paths.screenshot_destination)
        self.screenshot_destination.grid(row=self.current_row, column=1, sticky='W', pady=2)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.screenshot_destination),
                   bootstyle="outline").grid(
            row=self.current_row, column=2, padx=5, pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(paths_frame, text="Remove Video:", tooltip="Remove video from the output.",
                             row=self.current_row, column=0)
        self.remove_video = tk.BooleanVar(value=self.settings.paths.remove_video)
        ttk.Checkbutton(paths_frame, variable=self.remove_video, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                column=1, sticky='W',
                                                                                                pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(paths_frame, text="Remove Audio:", tooltip="Remove audio from the output.",
                             row=self.current_row, column=0)
        self.remove_audio = tk.BooleanVar(value=self.settings.paths.remove_audio)
        ttk.Checkbutton(paths_frame, variable=self.remove_audio, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                column=1, sticky='W',
                                                                                                pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(paths_frame, text="Remove Screenshot:", tooltip="Remove screenshots after processing.",
                             row=self.current_row, column=0)
        self.remove_screenshot = tk.BooleanVar(value=self.settings.paths.remove_screenshot)
        ttk.Checkbutton(paths_frame, variable=self.remove_screenshot, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        paths_frame.grid_columnconfigure(0, weight=0)
        paths_frame.grid_columnconfigure(1, weight=0)
        paths_frame.grid_columnconfigure(2, weight=0)

        for row in range(self.current_row):
            paths_frame.grid_rowconfigure(row, minsize=30)

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
        anki_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(anki_frame, text='Anki')

        HoverInfoLabelWidget(anki_frame, text="Update Anki:", tooltip="Automatically update Anki with new data.",
                             row=self.current_row, column=0)
        self.update_anki = tk.BooleanVar(value=self.settings.anki.update_anki)
        ttk.Checkbutton(anki_frame, variable=self.update_anki, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                              column=1, sticky='W',
                                                                                              pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Anki URL:", tooltip="The URL to connect to your Anki instance.",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.anki_url = ttk.Entry(anki_frame, width=50)
        self.anki_url.insert(0, self.settings.anki.url)
        self.anki_url.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Sentence Field:", tooltip="Field in Anki for the main sentence.",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.sentence_field = ttk.Entry(anki_frame)
        self.sentence_field.insert(0, self.settings.anki.sentence_field)
        self.sentence_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Sentence Audio Field:",
                             tooltip="Field in Anki for audio associated with the sentence. Leave Blank to Disable Audio Processing.",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.sentence_audio_field = ttk.Entry(anki_frame)
        self.sentence_audio_field.insert(0, self.settings.anki.sentence_audio_field)
        self.sentence_audio_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Picture Field:", tooltip="Field in Anki for associated pictures.",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.picture_field = ttk.Entry(anki_frame)
        self.picture_field.insert(0, self.settings.anki.picture_field)
        self.picture_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Word Field:", tooltip="Field in Anki for individual words.",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.word_field = ttk.Entry(anki_frame)
        self.word_field.insert(0, self.settings.anki.word_field)
        self.word_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Previous Sentence Field:",
                             tooltip="Field in Anki for the previous line of dialogue. If Empty, will not populate",
                             row=self.current_row, column=0)
        self.previous_sentence_field = ttk.Entry(anki_frame)
        self.previous_sentence_field.insert(0, self.settings.anki.previous_sentence_field)
        self.previous_sentence_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Previous VoiceLine SS Field:",
                             tooltip="Field in Anki for the screenshot of previous line. If Empty, will not populate",
                             row=self.current_row, column=0)
        self.previous_image_field = ttk.Entry(anki_frame)
        self.previous_image_field.insert(0, self.settings.anki.previous_image_field)
        self.previous_image_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Add Tags:", tooltip="Comma-separated custom tags for the Anki cards.",
                             row=self.current_row, column=0)
        self.custom_tags = ttk.Entry(anki_frame, width=50)
        self.custom_tags.insert(0, ', '.join(self.settings.anki.custom_tags))
        self.custom_tags.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Tags to work on:",
                             tooltip="Comma-separated Tags, script will only do 1-click on cards with these tags (Recommend keep empty, or use Yomitan Profile to add custom tag from texthooker page)",
                             foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.tags_to_check = ttk.Entry(anki_frame, width=50)
        self.tags_to_check.insert(0, ', '.join(self.settings.anki.tags_to_check))
        self.tags_to_check.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Add Game as Tag:",
                             tooltip="Include a tag for the game on the Anki card.", foreground="green",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.add_game_tag = tk.BooleanVar(value=self.settings.anki.add_game_tag)
        ttk.Checkbutton(anki_frame, variable=self.add_game_tag, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                               column=1, sticky='W',
                                                                                               pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Overwrite Audio:", tooltip="Overwrite existing audio in Anki cards.",
                             row=self.current_row, column=0)
        self.overwrite_audio = tk.BooleanVar(
            value=self.settings.anki.overwrite_audio)
        ttk.Checkbutton(anki_frame, variable=self.overwrite_audio, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                  column=1, sticky='W',
                                                                                                  pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Overwrite Picture:",
                             tooltip="Overwrite existing pictures in Anki cards.", row=self.current_row, column=0)
        self.overwrite_picture = tk.BooleanVar(
            value=self.settings.anki.overwrite_picture)
        ttk.Checkbutton(anki_frame, variable=self.overwrite_picture, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(anki_frame, text="Multi-line Mining Overwrite Sentence:",
                             tooltip="When using Multi-line Mining, overwrite the sentence with a concatenation of the lines selected.",
                             row=self.current_row, column=0)
        self.multi_overwrites_sentence = tk.BooleanVar(
            value=self.settings.anki.multi_overwrites_sentence)
        ttk.Checkbutton(anki_frame, variable=self.multi_overwrites_sentence, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        anki_frame.grid_columnconfigure(0, weight=0)
        anki_frame.grid_columnconfigure(1, weight=0)

        for row in range(self.current_row):
            anki_frame.grid_rowconfigure(row, minsize=30)

        return anki_frame

    def on_profiles_tab_selected(self, event):
        try:
            if self.window.state() != "withdrawn" and self.notebook.tab(self.notebook.select(), "text") == "Profiles":
                self.refresh_obs_scenes()
        except Exception as e:
            logger.debug(e)

    @new_tab
    def create_features_tab(self):
        features_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(features_frame, text='Features')

        HoverInfoLabelWidget(features_frame, text="Notify on Update:", tooltip="Notify the user when an update occurs.",
                             row=self.current_row, column=0)
        self.notify_on_update = tk.BooleanVar(value=self.settings.features.notify_on_update)
        ttk.Checkbutton(features_frame, variable=self.notify_on_update, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(features_frame, text="Open Anki Edit:",
                             tooltip="Automatically open Anki for editing after updating.", row=self.current_row,
                             column=0)
        self.open_anki_edit = tk.BooleanVar(value=self.settings.features.open_anki_edit)
        ttk.Checkbutton(features_frame, variable=self.open_anki_edit, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(features_frame, text="Open Anki Note in Browser:",
                             tooltip="Open Anki note in browser after updating.", row=self.current_row, column=0)
        self.open_anki_browser = tk.BooleanVar(value=self.settings.features.open_anki_in_browser)
        ttk.Checkbutton(features_frame, variable=self.open_anki_browser, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(features_frame, text="Browser Query:",
                             tooltip="Query to use when opening Anki notes in the browser. Ex: 'Added:1'",
                             row=self.current_row, column=0)
        self.browser_query = ttk.Entry(features_frame, width=50)
        self.browser_query.insert(0, self.settings.features.browser_query)
        self.browser_query.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(features_frame, text="Backfill Audio:", tooltip="Fill in audio data for existing entries.",
                             row=self.current_row, column=0)
        self.backfill_audio = tk.BooleanVar(value=self.settings.features.backfill_audio)
        ttk.Checkbutton(features_frame, variable=self.backfill_audio, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(features_frame, text="Full Auto Mode:", tooltip="Yomitan 1-click anki card creation.",
                             row=self.current_row, column=0)
        self.full_auto = tk.BooleanVar(
            value=self.settings.features.full_auto)
        ttk.Checkbutton(features_frame, variable=self.full_auto, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                column=1, sticky='W',
                                                                                                pady=2)
        self.current_row += 1

        for col in range(3):
            features_frame.grid_columnconfigure(col, weight=0)

        for row in range(self.current_row):
            features_frame.grid_rowconfigure(row, minsize=30)

    @new_tab
    def create_screenshot_tab(self):
        screenshot_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(screenshot_frame, text='Screenshot')

        HoverInfoLabelWidget(screenshot_frame, text="Enabled:", tooltip="Enable or disable screenshot processing.",
                             row=self.current_row, column=0)
        self.screenshot_enabled = tk.BooleanVar(value=self.settings.screenshot.enabled)
        ttk.Checkbutton(screenshot_frame, variable=self.screenshot_enabled, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="Width:", tooltip="Width of the screenshot in pixels.",
                             row=self.current_row, column=0)
        self.screenshot_width = ttk.Entry(screenshot_frame)
        self.screenshot_width.insert(0, str(self.settings.screenshot.width))
        self.screenshot_width.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="Height:", tooltip="Height of the screenshot in pixels.",
                             row=self.current_row, column=0)
        self.screenshot_height = ttk.Entry(screenshot_frame)
        self.screenshot_height.insert(0, str(self.settings.screenshot.height))
        self.screenshot_height.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="Quality:", tooltip="Quality of the screenshot (0-100).",
                             row=self.current_row, column=0)
        self.screenshot_quality = ttk.Entry(screenshot_frame)
        self.screenshot_quality.insert(0, str(self.settings.screenshot.quality))
        self.screenshot_quality.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="Extension:", tooltip="File extension for the screenshot format.",
                             row=self.current_row, column=0)
        self.screenshot_extension = ttk.Combobox(screenshot_frame, values=['webp', 'avif', 'png', 'jpeg'],
                                                 state="readonly")
        self.screenshot_extension.set(self.settings.screenshot.extension)
        self.screenshot_extension.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="FFmpeg Reencode Options:",
                             tooltip="Custom FFmpeg options for re-encoding screenshots.", foreground="red",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.screenshot_custom_ffmpeg_settings = ttk.Entry(screenshot_frame, width=50)
        self.screenshot_custom_ffmpeg_settings.insert(0, self.settings.screenshot.custom_ffmpeg_settings)
        self.screenshot_custom_ffmpeg_settings.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="Screenshot Timing:",
                             tooltip="Select when to take the screenshot relative to the line: beginning, middle, or end.",
                             row=self.current_row, column=0)
        self.screenshot_timing = ttk.Combobox(screenshot_frame, values=['beginning', 'middle', 'end'], state="readonly")
        self.screenshot_timing.set(self.settings.screenshot.screenshot_timing_setting)
        self.screenshot_timing.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="Screenshot Offset:",
                             tooltip="Time in seconds to offset the screenshot based on the Timing setting above (should almost always be positive, can be negative if you use \"middle\")",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.seconds_after_line = ttk.Entry(screenshot_frame)
        self.seconds_after_line.insert(0, str(self.settings.screenshot.seconds_after_line))
        self.seconds_after_line.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="Use Screenshot Selector for every card:",
                             tooltip="Enable to use the screenshot selector to choose the screenshot point on every card.",
                             row=self.current_row, column=0)
        self.use_screenshot_selector = tk.BooleanVar(value=self.settings.screenshot.use_screenshot_selector)
        ttk.Checkbutton(screenshot_frame, variable=self.use_screenshot_selector, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="Take Screenshot Hotkey:", tooltip="Hotkey to take a screenshot.",
                             row=self.current_row, column=0)
        self.take_screenshot_hotkey = ttk.Entry(screenshot_frame)
        self.take_screenshot_hotkey.insert(0, self.settings.hotkeys.take_screenshot)
        self.take_screenshot_hotkey.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(screenshot_frame, text="Screenshot Hotkey Updates Anki:",
                             tooltip="Enable to allow Screenshot hotkey/button to update the latest anki card.",
                             row=self.current_row, column=0)
        self.screenshot_hotkey_update_anki = tk.BooleanVar(
            value=self.settings.screenshot.screenshot_hotkey_updates_anki)
        ttk.Checkbutton(screenshot_frame, variable=self.screenshot_hotkey_update_anki, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        for col in range(3):
            screenshot_frame.grid_columnconfigure(col, weight=0)

        for row in range(self.current_row):
            screenshot_frame.grid_rowconfigure(row, minsize=30)

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
        audio_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(audio_frame, text='Audio')

        HoverInfoLabelWidget(audio_frame, text="Enabled:", tooltip="Enable or disable audio processing.",
                             row=self.current_row, column=0)
        self.audio_enabled = tk.BooleanVar(value=self.settings.audio.enabled)
        ttk.Checkbutton(audio_frame, variable=self.audio_enabled, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                                 column=1, sticky='W',
                                                                                                 pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(audio_frame, text="Audio Extension:", tooltip="File extension for audio files.",
                             row=self.current_row, column=0)
        self.audio_extension = ttk.Combobox(audio_frame, values=['opus', 'mp3', 'ogg', 'aac', 'm4a'], state="readonly")
        self.audio_extension.set(self.settings.audio.extension)
        self.audio_extension.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(audio_frame, text="Audio Extraction Beginning Offset:",
                             tooltip="Offset in seconds from beginning of the video to extract (Should Usually be negative or 0).",
                             foreground="dark orange", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.beginning_offset = ttk.Entry(audio_frame)
        self.beginning_offset.insert(0, str(self.settings.audio.beginning_offset))
        self.beginning_offset.grid(row=self.current_row, column=1, sticky='EW', pady=2)

        ttk.Button(audio_frame, text="Find Offset (WIP)", command=self.call_audio_offset_selector, bootstyle="info").grid(
            row=self.current_row, column=2, sticky='EW', pady=2, padx=5)

        self.current_row += 1


        HoverInfoLabelWidget(audio_frame, text="Audio Extraction End Offset:",
                             tooltip="Offset in seconds to trim from the end before VAD processing starts. Warning: May Result in lost audio if negative.",
                             foreground="red", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.pre_vad_audio_offset = ttk.Entry(audio_frame)
        self.pre_vad_audio_offset.insert(0, str(self.settings.audio.pre_vad_end_offset))
        self.pre_vad_audio_offset.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(audio_frame, text="FFmpeg Preset Options:",
                             tooltip="Select a preset FFmpeg option for re-encoding screenshots.", row=self.current_row,
                             column=0)

        # Define display names and their corresponding values
        self.ffmpeg_audio_preset_options_map = {
            "No Re-encode": "",
            "Simple Fade-in, Avoids Audio Clipping (Default)": "-c:a {encoder} -f {format} -af \"afade=t=in:d=0.10\"",
            "Simple loudness normalization (Simplest, Start Here)": "-c:a {encoder} -f {format} -af \"loudnorm=I=-23:TP=-2,afade=t=in:d=0.10\"",
            "Downmix to mono with normalization (Recommended(?))": "-c:a {encoder} -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.10\"",
            "Downmix to mono, 30kbps, normalized (Optimal(?))": "-c:a {encoder} -b:a 30k -ac 1 -f {format} -af \"loudnorm=I=-23:TP=-2:dual_mono=true,afade=t=in:d=0.10\"",
            "Custom": get_config().audio.custom_encode_settings,
        }

        # Create a Combobox with display names
        self.ffmpeg_audio_preset_options = ttk.Combobox(audio_frame,
                                                        values=list(self.ffmpeg_audio_preset_options_map.keys()),
                                                        width=50, state="readonly")
        # self.ffmpeg_preset_options.set("Downmix to mono with normalization")  # Set default display name
        self.ffmpeg_audio_preset_options.grid(row=self.current_row, column=1, sticky='EW', pady=2)

        # Bind selection to update settings
        self.ffmpeg_audio_preset_options.bind("<<ComboboxSelected>>", self.update_audio_ffmpeg_settings)
        self.current_row += 1

        HoverInfoLabelWidget(audio_frame, text="FFmpeg Reencode Options:",
                             tooltip="Custom FFmpeg options for re-encoding audio files.", foreground="red",
                             font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.audio_ffmpeg_reencode_options = ttk.Entry(audio_frame, width=50)
        self.audio_ffmpeg_reencode_options.insert(0, self.settings.audio.ffmpeg_reencode_options)
        self.audio_ffmpeg_reencode_options.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(audio_frame, text="Anki Media Collection:",
                             tooltip="Path of the Anki Media Collection, used for external Trimming tool. NO TRAILING SLASH",
                             foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.anki_media_collection = ttk.Entry(audio_frame)
        self.anki_media_collection.insert(0, self.settings.audio.anki_media_collection)
        self.anki_media_collection.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(audio_frame, text="External Audio Editing Tool:",
                             tooltip="Path to External tool that opens the audio up for manual trimming. I recommend OcenAudio for in-place Editing.",
                             foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.external_tool = ttk.Entry(audio_frame)
        self.external_tool.insert(0, self.settings.audio.external_tool)
        self.external_tool.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.external_tool_enabled = tk.BooleanVar(value=self.settings.audio.external_tool_enabled)
        HoverInfoLabelWidget(audio_frame, text="Enabled:", tooltip="Send Audio to External Tool for Editing.",
                             row=self.current_row, column=2, foreground="green", font=("Helvetica", 10, "bold"))
        ttk.Checkbutton(audio_frame, variable=self.external_tool_enabled, bootstyle="round-toggle").grid(
            row=self.current_row, column=3, sticky='W', padx=10, pady=5)
        self.current_row += 1

        ttk.Button(audio_frame, text="Install Ocenaudio", command=self.download_and_install_ocen,
                   bootstyle="info").grid(
            row=self.current_row, column=0, pady=5)
        ttk.Button(audio_frame, text="Get Anki Media Collection",
                   command=self.set_default_anki_media_collection, bootstyle="info").grid(row=self.current_row,
                                                                                          column=1, pady=5)
        self.current_row += 1

        for col in range(5):
            audio_frame.grid_columnconfigure(col, weight=0)

        for row in range(self.current_row):
            audio_frame.grid_rowconfigure(row, minsize=30)


    def call_audio_offset_selector(self):
        try:
            # if is_dev:
            #     path, beginning_offset, end_offset = r"C:\Users\Beangate\GSM\Electron App\test\tmphd01whan_untrimmed.opus", 500, 0
            # else:
            path, beginning_offset, end_offset = gsm_state.previous_trim_args
            # Get the directory of the current script
            current_dir = os.path.dirname(os.path.abspath(__file__))
            # Construct the path to the audio offset selector script
            script_path = os.path.join(current_dir,
                                       "audio_offset_selector.py")  # Replace with the actual script name if different

            logger.info(' '.join([sys.executable, "-m", "GameSentenceMiner.util.audio_offset_selector",
                                  "--path", path, "--beginning_offset", str(beginning_offset), "--end_offset",
                                  str(end_offset)]))

            # Run the script using subprocess.run()
            result = subprocess.run(
                [sys.executable, "-m", "GameSentenceMiner.util.audio_offset_selector",
                 "--path", path, "--beginning_offset", str(beginning_offset), "--end_offset", str(end_offset)],
                capture_output=True,
                text=True,  # Get output as text
                check=False  # Raise an exception for non-zero exit codes
            )
            if result.returncode != 0:
                logger.error(f"Script failed with return code: {result.returncode}")
                return None
            logger.info(result)
            logger.info(f"Audio offset selector script output: {result.stdout.strip()}")
            pyperclip.copy(result.stdout.strip())  # Copy the output to clipboard
            messagebox.showinfo("Clipboard", "Offset copied to clipboard!")
            return result.stdout.strip()  # Return the output

        except subprocess.CalledProcessError as e:
            logger.error(f"Error calling script: {e}")
            logger.error(f"Script output (stderr): {e.stderr.strip()}")
            return None
        except FileNotFoundError:
            logger.error(f"Error: Script not found at {script_path}. Make sure the script name is correct.")
            return None
        except Exception as e:
            logger.error(f"An unexpected error occurred: {e}")
            return None


    @new_tab
    def create_obs_tab(self):
        obs_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(obs_frame, text='OBS')

        HoverInfoLabelWidget(obs_frame, text="Enabled:", tooltip="Enable or disable OBS integration.",
                             row=self.current_row, column=0)
        self.obs_enabled = tk.BooleanVar(value=self.settings.obs.enabled)
        ttk.Checkbutton(obs_frame, variable=self.obs_enabled, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                             column=1, sticky='W',
                                                                                             pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(obs_frame, text="Open OBS:", tooltip="Open OBS when the GSM starts.", row=self.current_row,
                             column=0)
        self.open_obs = tk.BooleanVar(value=self.settings.obs.open_obs)
        ttk.Checkbutton(obs_frame, variable=self.open_obs, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                          column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(obs_frame, text="Close OBS:", tooltip="Close OBS when the GSM closes.",
                             row=self.current_row, column=0)
        self.close_obs = tk.BooleanVar(value=self.settings.obs.close_obs)
        ttk.Checkbutton(obs_frame, variable=self.close_obs, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                           column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(obs_frame, text="Host:", tooltip="Host address for the OBS WebSocket server.",
                             row=self.current_row, column=0)
        self.obs_host = ttk.Entry(obs_frame)
        self.obs_host.insert(0, self.settings.obs.host)
        self.obs_host.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(obs_frame, text="Port:", tooltip="Port number for the OBS WebSocket server.",
                             row=self.current_row, column=0)
        self.obs_port = ttk.Entry(obs_frame)
        self.obs_port.insert(0, str(self.settings.obs.port))
        self.obs_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(obs_frame, text="Password:", tooltip="Password for the OBS WebSocket server.",
                             row=self.current_row, column=0)
        self.obs_password = ttk.Entry(obs_frame, show="*")
        self.obs_password.insert(0, self.settings.obs.password)
        self.obs_password.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(obs_frame, text="Get Game From Scene Name:", tooltip="Changes Current Game to Scene Name",
                             row=self.current_row, column=0)
        self.get_game_from_scene_name = tk.BooleanVar(value=self.settings.obs.get_game_from_scene)
        ttk.Checkbutton(obs_frame, variable=self.get_game_from_scene_name, bootstyle="round-toggle").grid(
            row=self.current_row, column=1,
            sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(obs_frame, text="Minimum Replay Size (KB):",
                             tooltip="Minimum Replay Size for OBS Replays in KB. If Replay is Under this, Audio/Screenshot Will not be grabbed.",
                             row=self.current_row, column=0)
        self.minimum_replay_size = ttk.Entry(obs_frame)
        self.minimum_replay_size.insert(0, str(self.settings.obs.minimum_replay_size))
        self.minimum_replay_size.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        for col in range(3):
            obs_frame.grid_columnconfigure(col, weight=0)

        for row in range(self.current_row):
            obs_frame.grid_rowconfigure(row, minsize=30)

    @new_tab
    def create_profiles_tab(self):
        profiles_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(profiles_frame, text='Profiles')

        HoverInfoLabelWidget(profiles_frame, text="Select Profile:", tooltip="Select a profile to load its settings.",
                             row=self.current_row, column=0)
        self.profile_var = tk.StringVar(value=self.settings.name)
        self.profile_combobox = ttk.Combobox(profiles_frame, textvariable=self.profile_var,
                                             values=list(self.master_config.configs.keys()), state="readonly")
        self.profile_combobox.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.profile_combobox.bind("<<ComboboxSelected>>", self.on_profile_change)
        self.current_row += 1

        button_row = self.current_row
        ttk.Button(profiles_frame, text="Add Profile", command=self.add_profile, bootstyle="primary").grid(
            row=button_row, column=0, pady=5)
        ttk.Button(profiles_frame, text="Copy Profile", command=self.copy_profile, bootstyle="secondary").grid(
            row=button_row, column=1, pady=5)
        self.delete_profile_button = ttk.Button(profiles_frame, text="Delete Config", command=self.delete_profile,
                                                bootstyle="danger")
        if self.master_config.current_profile != DEFAULT_CONFIG:
            self.delete_profile_button.grid(row=button_row, column=2, pady=5)
        else:
            self.delete_profile_button.grid_remove()
        self.current_row += 1

        HoverInfoLabelWidget(profiles_frame, text="OBS Scene (Auto Switch Profile):",
                             tooltip="Select an OBS scene to associate with this profile. (Optional)",
                             row=self.current_row, column=0)
        self.obs_scene_var = tk.StringVar(value="")
        self.obs_scene_listbox = tk.Listbox(profiles_frame, listvariable=self.obs_scene_var, selectmode=tk.MULTIPLE,
                                            height=10, width=50, selectbackground=ttk.Style().colors.primary)
        self.obs_scene_listbox.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.obs_scene_listbox.bind("<<ListboxSelect>>", self.on_obs_scene_select)
        ttk.Button(profiles_frame, text="Refresh Scenes", command=self.refresh_obs_scenes, bootstyle="outline").grid(
            row=self.current_row, column=2, pady=5)
        self.current_row += 1

        HoverInfoLabelWidget(profiles_frame, text="Switch To Default If Not Found:",
                             tooltip="Enable to switch to the default profile if the selected OBS scene is not found.",
                             row=self.current_row, column=0)
        self.switch_to_default_if_not_found = tk.BooleanVar(value=self.master_config.switch_to_default_if_not_found)
        ttk.Checkbutton(profiles_frame, variable=self.switch_to_default_if_not_found, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        for col in range(4):
            profiles_frame.grid_columnconfigure(col, weight=0)

        for row in range(self.current_row):
            profiles_frame.grid_rowconfigure(row, minsize=30)

    def on_obs_scene_select(self, event):
        self.obs_scene_listbox_changed = True

    def refresh_obs_scenes(self):
        scenes = obs.get_obs_scenes()
        obs_scene_names = [scene['sceneName'] for scene in scenes]
        self.obs_scene_listbox.delete(0, tk.END)  # Clear existing items
        for scene_name in obs_scene_names:
            self.obs_scene_listbox.insert(tk.END, scene_name)  # Add each scene to the Listbox
        for i, scene in enumerate(obs_scene_names):  # Iterate through actual scene names
            if scene.strip() in self.settings.scenes:  # Check if scene is in current settings
                self.obs_scene_listbox.select_set(i)  # Select the item in the Listbox
                self.obs_scene_listbox.activate(i)
        self.obs_scene_listbox.update_idletasks()  # Ensure the GUI reflects the changes

    @new_tab
    def create_advanced_tab(self):
        advanced_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(advanced_frame, text='Advanced')

        ttk.Label(advanced_frame, text="Note: Only one of these will take effect, prioritizing audio.",
                  foreground="red", font=("Helvetica", 10, "bold")).grid(row=self.current_row, column=0, columnspan=3,
                                                                         sticky='W', pady=5)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Audio Player Path:",
                             tooltip="Path to the audio player executable. Will open the trimmed Audio",
                             row=self.current_row, column=0)
        self.audio_player_path = ttk.Entry(advanced_frame, width=50)
        self.audio_player_path.insert(0, self.settings.advanced.audio_player_path)
        self.audio_player_path.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        ttk.Button(advanced_frame, text="Browse", command=lambda: self.browse_file(self.audio_player_path),
                   bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Video Player Path:",
                             tooltip="Path to the video player executable. Will seek to the location of the line in the replay",
                             row=self.current_row, column=0)
        self.video_player_path = ttk.Entry(advanced_frame, width=50)
        self.video_player_path.insert(0, self.settings.advanced.video_player_path)
        self.video_player_path.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        ttk.Button(advanced_frame, text="Browse", command=lambda: self.browse_file(self.video_player_path),
                   bootstyle="outline").grid(row=self.current_row, column=2, padx=5, pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Play Latest Video/Audio Hotkey:",
                             tooltip="Hotkey to trim and play the latest audio.", row=self.current_row, column=0)
        self.play_latest_audio_hotkey = ttk.Entry(advanced_frame)
        self.play_latest_audio_hotkey.insert(0, self.settings.hotkeys.play_latest_audio)
        self.play_latest_audio_hotkey.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Multi-line Line-Break:",
                             tooltip="Line break for multi-line mining. This goes between each sentence",
                             row=self.current_row, column=0)
        self.multi_line_line_break = ttk.Entry(advanced_frame)
        self.multi_line_line_break.insert(0, self.settings.advanced.multi_line_line_break)
        self.multi_line_line_break.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Multi-Line Sentence Storage Field:",
                             tooltip="Field in Anki for storing the multi-line sentence temporarily.",
                             row=self.current_row, column=0)
        self.multi_line_sentence_storage_field = ttk.Entry(advanced_frame)
        self.multi_line_sentence_storage_field.insert(0, self.settings.advanced.multi_line_sentence_storage_field)
        self.multi_line_sentence_storage_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="OCR WebSocket Port:",
                             tooltip="Port for OCR WebSocket communication. GSM will also listen on this port",
                             row=self.current_row, column=0)
        self.ocr_websocket_port = ttk.Entry(advanced_frame)
        self.ocr_websocket_port.insert(0, str(self.settings.advanced.ocr_websocket_port))
        self.ocr_websocket_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Texthooker Communication WebSocket Port:",
                             tooltip="Port for GSM Texthooker WebSocket communication. Does nothing right now, hardcoded to 55001",
                             row=self.current_row, column=0)
        self.texthooker_communication_websocket_port = ttk.Entry(advanced_frame)
        self.texthooker_communication_websocket_port.insert(0,
                                                            str(self.settings.advanced.texthooker_communication_websocket_port))
        self.texthooker_communication_websocket_port.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Use Anki Creation Date for Audio Timing:",
                             tooltip="Use the Anki note creation date for audio timing instead of the OBS replay time.",
                             row=self.current_row, column=0)
        self.use_anki_note_creation_time = tk.BooleanVar(value=self.settings.advanced.use_anki_note_creation_time)
        ttk.Checkbutton(advanced_frame, variable=self.use_anki_note_creation_time, bootstyle="round-toggle").grid(
            row=self.current_row, column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Reset Line Hotkey:",
                             tooltip="Hotkey to reset the current line of dialogue.", row=self.current_row, column=0)
        self.reset_line_hotkey = ttk.Entry(advanced_frame)
        self.reset_line_hotkey.insert(0, self.settings.hotkeys.reset_line)
        self.reset_line_hotkey.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Polling Rate:",
                             tooltip="Rate at which Anki will check for updates (in milliseconds).",
                             row=self.current_row, column=0)
        self.polling_rate = ttk.Entry(advanced_frame)
        self.polling_rate.insert(0, str(self.settings.anki.polling_rate))
        self.polling_rate.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(advanced_frame, text="Vosk URL:", tooltip="URL for connecting to the Vosk server.",
                             row=self.current_row, column=0)
        self.vosk_url = ttk.Combobox(advanced_frame, values=[VOSK_BASE, VOSK_SMALL], state="readonly")
        self.vosk_url.set(VOSK_BASE if self.settings.vad.vosk_url == 'https://alphacephei.com/vosk/models/vosk-model-ja-0.22.zip' else VOSK_SMALL)
        self.vosk_url.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        for col in range(4):
            advanced_frame.grid_columnconfigure(col, weight=0)

        for row in range(self.current_row):
            advanced_frame.grid_rowconfigure(row, minsize=30)

    @new_tab
    def create_ai_tab(self):
        ai_frame = ttk.Frame(self.notebook, padding=15)
        self.notebook.add(ai_frame, text='AI')

        HoverInfoLabelWidget(ai_frame, text="Enabled:", tooltip="Enable or disable AI integration.",
                             row=self.current_row, column=0)
        self.ai_enabled = tk.BooleanVar(value=self.settings.ai.enabled)
        ttk.Checkbutton(ai_frame, variable=self.ai_enabled, bootstyle="round-toggle").grid(row=self.current_row,
                                                                                           column=1, sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(ai_frame, text="Provider:", tooltip="Select the AI provider.", row=self.current_row,
                             column=0)
        self.ai_provider = ttk.Combobox(ai_frame, values=['Gemini', 'Groq'], state="readonly")
        self.ai_provider.set(self.settings.ai.provider)
        self.ai_provider.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(ai_frame, text="Gemini AI Model:", tooltip="Select the AI model to use.",
                             row=self.current_row, column=0)
        self.gemini_model = ttk.Combobox(ai_frame, values=['gemini-2.0-flash', 'gemini-2.0-flash-lite',
                                                           'gemini-2.5-pro-preview-05-06',
                                                           'gemini-2.5-flash-preview-05-20'], state="readonly")
        self.gemini_model.set(self.settings.ai.gemini_model)
        self.gemini_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(ai_frame, text="Gemini API Key:",
                             tooltip="API key for the selected AI provider (Gemini only currently).",
                             foreground="green", font=("Helvetica", 10, "bold"), row=self.current_row, column=0)
        self.gemini_api_key = ttk.Entry(ai_frame, show="*")  # Mask the API key for security
        self.gemini_api_key.insert(0, self.settings.ai.gemini_api_key)
        self.gemini_api_key.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(ai_frame, text="Groq AI Model:", tooltip="Select the Groq AI model to use.",
                             row=self.current_row, column=0)
        self.groq_model = ttk.Combobox(ai_frame, values=['meta-llama/llama-4-maverick-17b-128e-instruct',
                                                         'meta-llama/llama-4-scout-17b-16e-instruct',
                                                         'llama-3.1-8b-instant'], state="readonly")
        self.groq_model.set(self.settings.ai.groq_model)
        self.groq_model.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(ai_frame, text="Groq API Key:", tooltip="API key for Groq AI provider.",
                             row=self.current_row, column=0)
        self.groq_api_key = ttk.Entry(ai_frame, show="*")  # Mask the API key for security
        self.groq_api_key.insert(0, self.settings.ai.groq_api_key)
        self.groq_api_key.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(ai_frame, text="Anki Field:", tooltip="Field in Anki for AI-generated content.",
                             row=self.current_row, column=0)
        self.ai_anki_field = ttk.Entry(ai_frame)
        self.ai_anki_field.insert(0, self.settings.ai.anki_field)
        self.ai_anki_field.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(ai_frame, text="Use Canned Translation Prompt:",
                             tooltip="Use a pre-defined translation prompt for AI.", row=self.current_row, column=0)
        self.use_canned_translation_prompt = tk.BooleanVar(value=self.settings.ai.use_canned_translation_prompt)
        ttk.Checkbutton(ai_frame, variable=self.use_canned_translation_prompt, bootstyle="round-toggle").grid(
            row=self.current_row, column=1,
            sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(ai_frame, text="Use Canned Context Prompt:",
                             tooltip="Use a pre-defined context prompt for AI.", row=self.current_row, column=0)
        self.use_canned_context_prompt = tk.BooleanVar(value=self.settings.ai.use_canned_context_prompt)
        ttk.Checkbutton(ai_frame, variable=self.use_canned_context_prompt, bootstyle="round-toggle").grid(
            row=self.current_row, column=1,
            sticky='W', pady=2)
        self.current_row += 1

        HoverInfoLabelWidget(ai_frame, text="Custom Prompt:", tooltip="Custom prompt for AI processing.",
                             row=self.current_row, column=0)
        self.custom_prompt = scrolledtext.ScrolledText(ai_frame, width=50, height=5, font=("TkDefaultFont", 9),
                                                       relief="solid", borderwidth=1,
                                                       highlightbackground=ttk.Style().colors.border)  # Adjust height as needed
        self.custom_prompt.insert(tk.END, self.settings.ai.custom_prompt)
        self.custom_prompt.grid(row=self.current_row, column=1, sticky='EW', pady=2)
        self.current_row += 1

        for col in range(3):
            ai_frame.grid_columnconfigure(col, weight=0)

        for row in range(self.current_row):
            ai_frame.grid_rowconfigure(row, minsize=30)

        return ai_frame

    # @new_tab
    # def create_help_tab(self):
    #     help_frame = ttk.Frame(self.notebook, padding=15)
    #     self.notebook.add(help_frame, text='Help')
    #
    #
    #
    #     help_frame.grid_columnconfigure(0, weight=1)

    def on_profile_change(self, event):
        self.save_settings(profile_change=True)
        self.reload_settings()
        self.refresh_obs_scenes()
        if self.master_config.current_profile != DEFAULT_CONFIG:
            self.delete_profile_button.grid(row=1, column=2, pady=5)
        else:
            self.delete_profile_button.grid_remove()

    def add_profile(self):
        new_profile_name = simpledialog.askstring("Input", "Enter new profile name:")
        if new_profile_name:
            self.master_config.configs[new_profile_name] = self.master_config.get_default_config()
            self.profile_combobox['values'] = list(self.master_config.configs.keys())
            self.profile_combobox.set(new_profile_name)
            self.save_settings()
            self.reload_settings()

    def copy_profile(self):
        source_profile = self.profile_combobox.get()
        new_profile_name = simpledialog.askstring("Input", "Enter new profile name:", parent=self.window)
        if new_profile_name and source_profile in self.master_config.configs:
            # Deep copy the configuration to avoid shared references
            import copy
            self.master_config.configs[new_profile_name] = copy.deepcopy(self.master_config.configs[source_profile])
            self.master_config.configs[new_profile_name].name = new_profile_name  # Update the name in the copied config
            self.profile_combobox['values'] = list(self.master_config.configs.keys())
            self.profile_combobox.set(new_profile_name)
            self.save_settings()
            self.reload_settings()

    def delete_profile(self):
        profile_to_delete = self.profile_combobox.get()
        if profile_to_delete == "Default":
            messagebox.showerror("Error", "Cannot delete the Default profile.")
            return

        if profile_to_delete and profile_to_delete in self.master_config.configs:
            confirm = messagebox.askyesno("Confirm Delete",
                                          f"Are you sure you want to delete the profile '{profile_to_delete}'?",
                                          parent=self.window, icon='warning')
            if confirm:
                del self.master_config.configs[profile_to_delete]
                self.profile_combobox['values'] = list(self.master_config.configs.keys())
                self.profile_combobox.set("Default")
                self.master_config.current_profile = "Default"
                save_full_config(self.master_config)
                self.reload_settings()

    def show_error_box(self, title, message):
        messagebox.showerror(title, message)

    def download_and_install_ocen(self):
        confirm = messagebox.askyesno("Download OcenAudio?",
                                      "Would you like to download and install OcenAudio? It is a free audio editing software that works extremely well with GSM.",
                                      parent=self.window, icon='question')
        if confirm:
            self.external_tool.delete(0, tk.END)
            self.external_tool.insert(0, "Downloading OcenAudio...")
            exe_path = download_ocenaudio_if_needed()
            messagebox.showinfo("OcenAudio Downloaded",
                                f"OcenAudio has been downloaded and installed. You can find it at {exe_path}.",
                                parent=self.window)
            self.external_tool.delete(0, tk.END)
            self.external_tool.insert(0, exe_path)
            self.save_settings()

    def set_default_anki_media_collection(self):
        confirm = messagebox.askyesno("Set Default Anki Media Collection?",
                                      "Would you like to set the default Anki media collection path? This will help the script find the media collection for external trimming.\n\nDefault: %APPDATA%/Anki2/User 1/collection.media",
                                      parent=self.window, icon='question')
        if confirm:
            default_path = get_default_anki_media_collection_path()
            if default_path != self.settings.audio.anki_media_collection:  # Check against anki_media_collection
                self.anki_media_collection.delete(0, tk.END)
                self.anki_media_collection.insert(0, default_path)
                self.save_settings()


if __name__ == '__main__':
    root = ttk.Window(themename='darkly')
    window = ConfigApp(root)
    window.show()
    window.window.mainloop()