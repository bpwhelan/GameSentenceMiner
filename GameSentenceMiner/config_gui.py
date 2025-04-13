import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, scrolledtext

import ttkbootstrap as ttk

from GameSentenceMiner import obs, configuration
from GameSentenceMiner.communication.send import send_restart_signal
from GameSentenceMiner.configuration import *
from GameSentenceMiner.downloader.download_tools import download_ocenaudio_if_needed
from GameSentenceMiner.package import get_current_version, get_latest_version

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
        label = tk.Label(self.tooltip, text=text, background="yellow", relief="solid", borderwidth=1,
                         font=("tahoma", "8", "normal"))
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

        self.current_row = 0

        self.master_config: Config = configuration.load_config()

        self.settings = self.master_config.get_config()

        self.notebook = ttk.Notebook(self.window)
        self.notebook.pack(pady=10, expand=True)

        self.general_frame = self.create_general_tab()
        self.create_paths_tab()
        self.create_anki_tab()
        self.create_vad_tab()
        self.create_features_tab()
        self.create_screenshot_tab()
        self.create_audio_tab()
        self.create_obs_tab()
        self.create_hotkeys_tab()
        self.create_profiles_tab()
        self.create_advanced_tab()
        self.create_ai_tab()

        ttk.Button(self.window, text="Save Settings", command=self.save_settings).pack(pady=20)

        self.window.withdraw()

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

    def save_settings(self, profile_change=False):
        global settings_saved

        # Create a new Config instance
        config = ProfileConfig(
            general=General(
                use_websocket=self.websocket_enabled.get(),
                use_clipboard=self.clipboard_enabled.get(),
                websocket_uri=self.websocket_uri.get(),
                open_config_on_startup=self.open_config_on_startup.get(),
                open_multimine_on_startup=self.open_multimine_on_startup.get(),
                texthook_replacement_regex=self.texthook_replacement_regex.get()
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
                anki_custom_fields={
                    key_entry.get(): value_entry.get() for key_entry, value_entry, delete_button in
                    self.custom_field_entries if key_entry.get()
                }
            ),
            features=Features(
                full_auto=self.full_auto.get(),
                notify_on_update=self.notify_on_update.get(),
                open_anki_edit=self.open_anki_edit.get(),
                backfill_audio=self.backfill_audio.get()
            ),
            screenshot=Screenshot(
                enabled=self.screenshot_enabled.get(),
                width=self.screenshot_width.get(),
                height=self.screenshot_height.get(),
                quality=self.screenshot_quality.get(),
                extension=self.screenshot_extension.get(),
                custom_ffmpeg_settings=self.screenshot_custom_ffmpeg_settings.get(),
                screenshot_hotkey_updates_anki=self.screenshot_hotkey_update_anki.get(),
                seconds_after_line = self.seconds_after_line.get(),
                use_beginning_of_line_as_screenshot=self.use_beginning_of_line_as_screenshot.get(),
                use_new_screenshot_logic=self.use_new_screenshot_logic.get()
            ),
            audio=Audio(
                enabled=self.audio_enabled.get(),
                extension=self.audio_extension.get(),
                beginning_offset=float(self.beginning_offset.get()),
                end_offset=float(self.end_offset.get()),
                ffmpeg_reencode_options=self.ffmpeg_reencode_options.get(),
                external_tool = self.external_tool.get(),
                anki_media_collection=self.anki_media_collection.get(),
                external_tool_enabled=self.external_tool_enabled.get(),
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
                open_utility=self.open_utility_hotkey.get(),
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
            ),
            advanced=Advanced(
                audio_player_path=self.audio_player_path.get(),
                video_player_path=self.video_player_path.get(),
                show_screenshot_buttons=self.show_screenshot_button.get(),
                multi_line_line_break=self.multi_line_line_break.get(),
                multi_line_sentence_storage_field=self.multi_line_sentence_storage_field.get(),
            ),
            ai=Ai(
                enabled=self.ai_enabled.get(),
                # provider=self.provider.get(),
                anki_field=self.ai_anki_field.get(),
                api_key=self.ai_api_key.get(),
                use_canned_translation_prompt=self.use_canned_translation_prompt.get(),
                use_canned_context_prompt=self.use_canned_context_prompt.get(),
                custom_prompt=self.custom_prompt.get("1.0", tk.END)
            )
        )

        if config.features.backfill_audio and config.features.full_auto:
            messagebox.showerror("Configuration Error", "Cannot have Full Auto and Backfill mode on at the same time! Note: Backfill is a very niche workflow.")
            return

        if not config.general.use_websocket and not config.general.use_clipboard:
            messagebox.showerror("Configuration Error", "Cannot have both Clipboard and Websocket Disabled.")
            return

        current_profile = self.profile_combobox.get()
        prev_config = self.master_config.get_config()
        if profile_change:
            self.master_config.current_profile = current_profile
        else:
            self.master_config.current_profile = current_profile
            self.master_config.set_config_for_profile(current_profile, config)

        self.master_config = self.master_config.sync_shared_fields()

        # Serialize the config instance to JSON
        with open(get_config_path(), 'w') as file:
            file.write(self.master_config.to_json(indent=4))

        logger.info("Settings saved successfully!")

        if self.master_config.get_config().restart_required(prev_config):
            logger.info("Restart Required for some settings to take affect!")
            send_restart_signal()

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
            self.create_hotkeys_tab()
            self.create_profiles_tab()
            self.create_advanced_tab()
            self.create_ai_tab()


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
        general_frame = ttk.Frame(self.notebook)
        self.notebook.add(general_frame, text='General')

        ttk.Label(general_frame, text="Websocket Enabled:").grid(row=self.current_row, column=0, sticky='W')
        self.websocket_enabled = tk.BooleanVar(value=self.settings.general.use_websocket)
        ttk.Checkbutton(general_frame, variable=self.websocket_enabled).grid(row=self.current_row, column=1,
                                                                             sticky='W')
        self.add_label_and_increment_row(general_frame, "Enable or disable WebSocket communication. Enabling this will disable the clipboard monitor. RESTART REQUIRED.",
                                         row=self.current_row, column=2)

        ttk.Label(general_frame, text="Clipboard Enabled:").grid(row=self.current_row, column=0, sticky='W')
        self.clipboard_enabled = tk.BooleanVar(value=self.settings.general.use_clipboard)
        ttk.Checkbutton(general_frame, variable=self.clipboard_enabled).grid(row=self.current_row, column=1,
                                                                             sticky='W')
        self.add_label_and_increment_row(general_frame, "Enable to allow GSM to see clipboard for text and line timing.",
                                         row=self.current_row, column=2)

        ttk.Label(general_frame, text="Websocket URI:").grid(row=self.current_row, column=0, sticky='W')
        self.websocket_uri = ttk.Entry(general_frame)
        self.websocket_uri.insert(0, self.settings.general.websocket_uri)
        self.websocket_uri.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(general_frame, "WebSocket URI for connecting.", row=self.current_row,
                                         column=2)

        ttk.Label(general_frame, text="TextHook Replacement Regex:").grid(row=self.current_row, column=0, sticky='W')
        self.texthook_replacement_regex = ttk.Entry(general_frame)
        self.texthook_replacement_regex.insert(0, self.settings.general.texthook_replacement_regex)
        self.texthook_replacement_regex.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(general_frame, "Regex to run replacement on texthook input, set this to the same as what you may have in your texthook page.", row=self.current_row,
                                         column=2)

        ttk.Label(general_frame, text="Open Config on Startup:").grid(row=self.current_row, column=0, sticky='W')
        self.open_config_on_startup = tk.BooleanVar(value=self.settings.general.open_config_on_startup)
        ttk.Checkbutton(general_frame, variable=self.open_config_on_startup).grid(row=self.current_row, column=1,
                                                                                  sticky='W')
        self.add_label_and_increment_row(general_frame, "Whether to open config when the script starts.",
                                         row=self.current_row, column=2)

        ttk.Label(general_frame, text="Open Multimine on Startup:").grid(row=self.current_row, column=0, sticky='W')
        self.open_multimine_on_startup = tk.BooleanVar(value=self.settings.general.open_multimine_on_startup)
        ttk.Checkbutton(general_frame, variable=self.open_multimine_on_startup).grid(row=self.current_row, column=1,
                                                                                  sticky='W')
        self.add_label_and_increment_row(general_frame, "Whether to open multimining window when the script starts.",
                                         row=self.current_row, column=2)

        ttk.Label(general_frame, text="Current Version:").grid(row=self.current_row, column=0, sticky='W')
        self.current_version = ttk.Label(general_frame, text=get_current_version())
        self.current_version.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(general_frame, "The current version of the application.", row=self.current_row,
                                         column=2)

        ttk.Label(general_frame, text="Latest Version:").grid(row=self.current_row, column=0, sticky='W')
        self.latest_version = ttk.Label(general_frame, text=get_latest_version())
        self.latest_version.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(general_frame, "The latest available version of the application.",
                                         row=self.current_row, column=2)

        # ttk.Label(general_frame, text="Per Scene Config:").grid(row=self.current_row, column=0, sticky='W')
        # self.per_scene_config = tk.BooleanVar(value=self.master_config.per_scene_config)
        # ttk.Checkbutton(general_frame, variable=self.per_scene_config).grid(row=self.current_row, column=1,
        #                                                                      sticky='W')
        # self.add_label_and_increment_row(general_frame, "Enable Per-Scene Config, REQUIRES RESTART. Disable to edit the DEFAULT Config.",
        #                                  row=self.current_row, column=2)

        return general_frame

    @new_tab
    def create_vad_tab(self):
        vad_frame = ttk.Frame(self.notebook)
        self.notebook.add(vad_frame, text='VAD')

        ttk.Label(vad_frame, text="Voice Detection Postprocessing:").grid(row=self.current_row, column=0, sticky='W')
        self.do_vad_postprocessing = tk.BooleanVar(
            value=self.settings.vad.do_vad_postprocessing)
        ttk.Checkbutton(vad_frame, variable=self.do_vad_postprocessing).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(vad_frame, "Enable post-processing of audio to trim just the voiceline.",
                                         row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Whisper Model:").grid(row=self.current_row, column=0, sticky='W')
        self.whisper_model = ttk.Combobox(vad_frame, values=[WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, WHISPER_MEDIUM,
                                                             WHSIPER_LARGE])
        self.whisper_model.set(self.settings.vad.whisper_model)
        self.whisper_model.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(vad_frame, "Select the Whisper model size for VAD.", row=self.current_row,
                                         column=2)

        ttk.Label(vad_frame, text="Vosk URL:").grid(row=self.current_row, column=0, sticky='W')
        self.vosk_url = ttk.Combobox(vad_frame, values=[VOSK_BASE, VOSK_SMALL])
        self.vosk_url.insert(0,
                             VOSK_BASE if self.settings.vad.vosk_url == 'https://alphacephei.com/vosk/models/vosk-model-ja-0.22.zip' else VOSK_SMALL)
        self.vosk_url.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(vad_frame, "URL for connecting to the Vosk server.", row=self.current_row,
                                         column=2)

        ttk.Label(vad_frame, text="Select VAD Model:").grid(row=self.current_row, column=0, sticky='W')
        self.selected_vad_model = ttk.Combobox(vad_frame, values=[VOSK, SILERO, WHISPER])
        self.selected_vad_model.set(self.settings.vad.selected_vad_model)
        self.selected_vad_model.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(vad_frame, "Select which VAD model to use.", row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Backup VAD Model:").grid(row=self.current_row, column=0, sticky='W')
        self.backup_vad_model = ttk.Combobox(vad_frame, values=[OFF, VOSK, SILERO, WHISPER])
        self.backup_vad_model.set(self.settings.vad.backup_vad_model)
        self.backup_vad_model.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(vad_frame, "Select which model to use as a backup if no audio is found.",
                                         row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Trim Beginning:").grid(row=self.current_row, column=0, sticky='W')
        self.vad_trim_beginning = tk.BooleanVar(
            value=self.settings.vad.trim_beginning)
        ttk.Checkbutton(vad_frame, variable=self.vad_trim_beginning).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(vad_frame, "Trim the beginning of the audio based on Voice Detection Results",
                                         row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Beginning Offset After Beginning Trim:").grid(row=self.current_row, column=0, sticky='W')
        self.vad_beginning_offset = ttk.Entry(vad_frame)
        self.vad_beginning_offset.insert(0, str(self.settings.vad.beginning_offset))
        self.vad_beginning_offset.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(vad_frame, 'Beginning offset after VAD Trim, Only active if "Trim Beginning" is ON. Negative values = more time at the beginning', row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Add Audio on No Results:").grid(row=self.current_row, column=0, sticky='W')
        self.add_audio_on_no_results = tk.BooleanVar(value=self.settings.vad.add_audio_on_no_results)
        ttk.Checkbutton(vad_frame, variable=self.add_audio_on_no_results).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(vad_frame, "Add audio even if no results are found by VAD.", row=self.current_row, column=2)


    @new_tab
    def create_paths_tab(self):
        paths_frame = ttk.Frame(self.notebook)
        self.notebook.add(paths_frame, text='Paths')

        ttk.Label(paths_frame, text="Folder to Watch:").grid(row=self.current_row, column=0, sticky='W')
        self.folder_to_watch = ttk.Entry(paths_frame, width=50)
        self.folder_to_watch.insert(0, self.settings.paths.folder_to_watch)
        self.folder_to_watch.grid(row=self.current_row, column=1)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.folder_to_watch)).grid(
            row=self.current_row,
            column=2)
        self.add_label_and_increment_row(paths_frame, "Path where the OBS Replays will be saved.", row=self.current_row,
                                         column=3)

        ttk.Label(paths_frame, text="Audio Destination:").grid(row=self.current_row, column=0, sticky='W')
        self.audio_destination = ttk.Entry(paths_frame, width=50)
        self.audio_destination.insert(0, self.settings.paths.audio_destination)
        self.audio_destination.grid(row=self.current_row, column=1)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.audio_destination)).grid(
            row=self.current_row,
            column=2)
        self.add_label_and_increment_row(paths_frame, "Path where the cut Audio will be saved.", row=self.current_row,
                                         column=3)

        ttk.Label(paths_frame, text="Screenshot Destination:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_destination = ttk.Entry(paths_frame, width=50)
        self.screenshot_destination.insert(0, self.settings.paths.screenshot_destination)
        self.screenshot_destination.grid(row=self.current_row, column=1)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.screenshot_destination)).grid(
            row=self.current_row, column=2)
        self.add_label_and_increment_row(paths_frame, "Path where the Screenshot will be saved.", row=self.current_row,
                                         column=3)

        ttk.Label(paths_frame, text="Remove Video:").grid(row=self.current_row, column=0, sticky='W')
        self.remove_video = tk.BooleanVar(value=self.settings.paths.remove_video)
        ttk.Checkbutton(paths_frame, variable=self.remove_video).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(paths_frame, "Remove video from the output.", row=self.current_row, column=2)

        ttk.Label(paths_frame, text="Remove Audio:").grid(row=self.current_row, column=0, sticky='W')
        self.remove_audio = tk.BooleanVar(value=self.settings.paths.remove_audio)
        ttk.Checkbutton(paths_frame, variable=self.remove_audio).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(paths_frame, "Remove audio from the output.", row=self.current_row, column=2)

        ttk.Label(paths_frame, text="Remove Screenshot:").grid(row=self.current_row, column=0, sticky='W')
        self.remove_screenshot = tk.BooleanVar(value=self.settings.paths.remove_screenshot)
        ttk.Checkbutton(paths_frame, variable=self.remove_screenshot).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(paths_frame, "Remove screenshots after processing.", row=self.current_row,
                                         column=2)

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
        anki_frame = ttk.Frame(self.notebook)
        self.notebook.add(anki_frame, text='Anki')

        ttk.Label(anki_frame, text="Update Anki:").grid(row=self.current_row, column=0, sticky='W')
        self.update_anki = tk.BooleanVar(value=self.settings.anki.update_anki)
        ttk.Checkbutton(anki_frame, variable=self.update_anki).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(anki_frame, "Automatically update Anki with new data.", row=self.current_row,
                                         column=2)

        ttk.Label(anki_frame, text="Anki URL:").grid(row=self.current_row, column=0, sticky='W')
        self.anki_url = ttk.Entry(anki_frame, width=50)
        self.anki_url.insert(0, self.settings.anki.url)
        self.anki_url.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "The URL to connect to your Anki instance.", row=self.current_row,
                                         column=2)

        ttk.Label(anki_frame, text="Sentence Field:").grid(row=self.current_row, column=0, sticky='W')
        self.sentence_field = ttk.Entry(anki_frame)
        self.sentence_field.insert(0, self.settings.anki.sentence_field)
        self.sentence_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Field in Anki for the main sentence.", row=self.current_row,
                                         column=2)

        ttk.Label(anki_frame, text="Sentence Audio Field:").grid(row=self.current_row, column=0, sticky='W')
        self.sentence_audio_field = ttk.Entry(anki_frame)
        self.sentence_audio_field.insert(0, self.settings.anki.sentence_audio_field)
        self.sentence_audio_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame,
                                         "Field in Anki for audio associated with the sentence. Leave Blank to Disable Audio Processing.",
                                         row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Picture Field:").grid(row=self.current_row, column=0, sticky='W')
        self.picture_field = ttk.Entry(anki_frame)
        self.picture_field.insert(0, self.settings.anki.picture_field)
        self.picture_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Field in Anki for associated pictures.", row=self.current_row,
                                         column=2)

        ttk.Label(anki_frame, text="Word Field:").grid(row=self.current_row, column=0, sticky='W')
        self.word_field = ttk.Entry(anki_frame)
        self.word_field.insert(0, self.settings.anki.word_field)
        self.word_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Field in Anki for individual words.", row=self.current_row,
                                         column=2)

        ttk.Label(anki_frame, text="Previous Sentence Field:").grid(row=self.current_row, column=0, sticky='W')
        self.previous_sentence_field = ttk.Entry(anki_frame)
        self.previous_sentence_field.insert(0, self.settings.anki.previous_sentence_field)
        self.previous_sentence_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame,
                                         "Field in Anki for the previous line of dialogue. If Empty, will not populate",
                                         row=self.current_row,
                                         column=2)

        ttk.Label(anki_frame, text="Previous VoiceLine SS Field:").grid(row=self.current_row, column=0, sticky='W')
        self.previous_image_field = ttk.Entry(anki_frame)
        self.previous_image_field.insert(0, self.settings.anki.previous_image_field)
        self.previous_image_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame,
                                         "Field in Anki for the screenshot of previous line. If Empty, will not populate",
                                         row=self.current_row,
                                         column=2)

        ttk.Label(anki_frame, text="Custom Tags:").grid(row=self.current_row, column=0, sticky='W')
        self.custom_tags = ttk.Entry(anki_frame)
        self.custom_tags.insert(0, ', '.join(self.settings.anki.custom_tags))
        self.custom_tags.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Comma-separated custom tags for the Anki cards.",
                                         row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Tags to work on:").grid(row=self.current_row, column=0, sticky='W')
        self.tags_to_check = ttk.Entry(anki_frame)
        self.tags_to_check.insert(0, ', '.join(self.settings.anki.tags_to_check))
        self.tags_to_check.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame,
                                         "Comma-separated Tags, script will only do 1-click on cards with these tags (Recommend keep empty, or use Yomitan Profile to add custom tag from texthooker page)",
                                         row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Add Game Tag:").grid(row=self.current_row, column=0, sticky='W')
        self.add_game_tag = tk.BooleanVar(value=self.settings.anki.add_game_tag)
        ttk.Checkbutton(anki_frame, variable=self.add_game_tag).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(anki_frame, "Include a tag for the game on the Anki card.",
                                         row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Polling Rate:").grid(row=self.current_row, column=0, sticky='W')
        self.polling_rate = ttk.Entry(anki_frame)
        self.polling_rate.insert(0, str(self.settings.anki.polling_rate))
        self.polling_rate.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Rate at which Anki will check for updates (in milliseconds).",
                                         row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Overwrite Audio:").grid(row=self.current_row, column=0, sticky='W')
        self.overwrite_audio = tk.BooleanVar(
            value=self.settings.anki.overwrite_audio)
        ttk.Checkbutton(anki_frame, variable=self.overwrite_audio).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(anki_frame, "Overwrite existing audio in Anki cards.", row=self.current_row,
                                         column=2)

        ttk.Label(anki_frame, text="Overwrite Picture:").grid(row=self.current_row, column=0, sticky='W')
        self.overwrite_picture = tk.BooleanVar(
            value=self.settings.anki.overwrite_picture)
        ttk.Checkbutton(anki_frame, variable=self.overwrite_picture).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(anki_frame, "Overwrite existing pictures in Anki cards.", row=self.current_row,
                                         column=2)

        ttk.Label(anki_frame, text="Multi-line Mining Overwrite Sentence:").grid(row=self.current_row, column=0, sticky='W')
        self.multi_overwrites_sentence = tk.BooleanVar(
            value=self.settings.anki.multi_overwrites_sentence)
        ttk.Checkbutton(anki_frame, variable=self.multi_overwrites_sentence).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(anki_frame, "When using Multi-line Mining, overrwrite the sentence with a concatenation of the lines selected.", row=self.current_row,
                                         column=2)

        self.anki_custom_fields = self.settings.anki.anki_custom_fields
        self.custom_field_entries = []

        row_at_the_time = self.current_row + 1

        ttk.Button(anki_frame, text="Add Field",
                   command=lambda: self.add_custom_field(anki_frame, row_at_the_time)).grid(row=self.current_row,
                                                                                            column=0, pady=5)
        self.add_label_and_increment_row(anki_frame, "Add a new custom field for Anki cards.", row=self.current_row,
                                         column=2)
        self.display_custom_fields(anki_frame, self.current_row)

        return anki_frame

    def add_custom_field(self, frame, start_row):
        row = len(self.custom_field_entries) + 1 + start_row

        key_entry = ttk.Entry(frame)
        key_entry.grid(row=row, column=0, padx=5, pady=2, sticky='W')
        value_entry = ttk.Entry(frame)
        value_entry.grid(row=row, column=1, padx=5, pady=2, sticky='W')

        # Create a delete button for this custom field
        delete_button = ttk.Button(frame, text="X",
                                   command=lambda: self.delete_custom_field(row, key_entry, value_entry, delete_button))
        delete_button.grid(row=row, column=2, padx=5, pady=2)

        self.custom_field_entries.append((key_entry, value_entry, delete_button))

    def display_custom_fields(self, frame, start_row):
        for row, (key, value) in enumerate(self.anki_custom_fields.items()):
            key_entry = ttk.Entry(frame)
            key_entry.insert(0, key)
            key_entry.grid(row=row + start_row, column=0, padx=5, pady=2, sticky='W')

            value_entry = ttk.Entry(frame)
            value_entry.insert(0, value)
            value_entry.grid(row=row + start_row, column=1, padx=5, pady=2, sticky='W')

            # Create a delete button for each existing custom field
            delete_button = ttk.Button(frame, text="X",
                                       command=lambda: self.delete_custom_field(row + start_row, key_entry, value_entry,
                                                                                delete_button))
            delete_button.grid(row=row + start_row, column=2, padx=5, pady=2)

            self.custom_field_entries.append((key_entry, value_entry, delete_button))

    def delete_custom_field(self, row, key_entry, value_entry, delete_button):
        # Remove the entry from the GUI
        key_entry.destroy()
        value_entry.destroy()
        delete_button.destroy()

        # Remove the entry from the custom field entries list
        self.custom_field_entries.remove((key_entry, value_entry, delete_button))

        # Update the GUI rows below to fill the gap if necessary
        # for (ke, ve, db) in self.custom_field_entries:
        #     if self.custom_field_entries.index((ke, ve, db)) > self.custom_field_entries.index(
        #             (key_entry, value_entry, delete_button)):
        #         ke.grid_configure(row=ke.grid_info()['row'] - 1)
        #         ve.grid_configure(row=ve.grid_info()['row'] - 1)
        #         db.grid_configure(row=db.grid_info()['row'] - 1)

    @new_tab
    def create_features_tab(self):
        features_frame = ttk.Frame(self.notebook)
        self.notebook.add(features_frame, text='Features')

        ttk.Label(features_frame, text="Notify on Update:").grid(row=self.current_row, column=0, sticky='W')
        self.notify_on_update = tk.BooleanVar(value=self.settings.features.notify_on_update)
        ttk.Checkbutton(features_frame, variable=self.notify_on_update).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(features_frame, "Notify the user when an update occurs.", row=self.current_row,
                                         column=2)

        ttk.Label(features_frame, text="Open Anki Edit:").grid(row=self.current_row, column=0, sticky='W')
        self.open_anki_edit = tk.BooleanVar(value=self.settings.features.open_anki_edit)
        ttk.Checkbutton(features_frame, variable=self.open_anki_edit).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(features_frame, "Automatically open Anki for editing after updating.",
                                         row=self.current_row, column=2)

        ttk.Label(features_frame, text="Backfill Audio:").grid(row=self.current_row, column=0, sticky='W')
        self.backfill_audio = tk.BooleanVar(value=self.settings.features.backfill_audio)
        ttk.Checkbutton(features_frame, variable=self.backfill_audio).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(features_frame, "Fill in audio data for existing entries.",
                                         row=self.current_row, column=2)

        ttk.Label(features_frame, text="Full Auto Mode:").grid(row=self.current_row, column=0, sticky='W')
        self.full_auto = tk.BooleanVar(
            value=self.settings.features.full_auto)
        ttk.Checkbutton(features_frame, variable=self.full_auto).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(features_frame, "Yomitan 1-click anki card creation.", row=self.current_row,
                                         column=2)

    @new_tab
    def create_screenshot_tab(self):
        screenshot_frame = ttk.Frame(self.notebook)
        self.notebook.add(screenshot_frame, text='Screenshot')

        ttk.Label(screenshot_frame, text="Enabled:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_enabled = tk.BooleanVar(value=self.settings.screenshot.enabled)
        ttk.Checkbutton(screenshot_frame, variable=self.screenshot_enabled).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(screenshot_frame, "Enable or disable screenshot processing.", row=self.current_row, column=2)

        ttk.Label(screenshot_frame, text="Width:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_width = ttk.Entry(screenshot_frame)
        self.screenshot_width.insert(0, str(self.settings.screenshot.width))
        self.screenshot_width.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "Width of the screenshot in pixels.", row=self.current_row,
                                         column=2)

        ttk.Label(screenshot_frame, text="Height:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_height = ttk.Entry(screenshot_frame)
        self.screenshot_height.insert(0, str(self.settings.screenshot.height))
        self.screenshot_height.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "Height of the screenshot in pixels.", row=self.current_row,
                                         column=2)

        ttk.Label(screenshot_frame, text="Quality:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_quality = ttk.Entry(screenshot_frame)
        self.screenshot_quality.insert(0, str(self.settings.screenshot.quality))
        self.screenshot_quality.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "Quality of the screenshot (0-100).", row=self.current_row,
                                         column=2)

        ttk.Label(screenshot_frame, text="Extension:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_extension = ttk.Combobox(screenshot_frame, values=['webp', 'avif', 'png', 'jpeg'])
        self.screenshot_extension.insert(0, self.settings.screenshot.extension)
        self.screenshot_extension.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "File extension for the screenshot format.",
                                         row=self.current_row, column=2)

        ttk.Label(screenshot_frame, text="FFmpeg Reencode Options:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_custom_ffmpeg_settings = ttk.Entry(screenshot_frame, width=50)
        self.screenshot_custom_ffmpeg_settings.insert(0, self.settings.screenshot.custom_ffmpeg_settings)
        self.screenshot_custom_ffmpeg_settings.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "Custom FFmpeg options for re-encoding screenshots.",
                                         row=self.current_row, column=2)

        ttk.Label(screenshot_frame, text="Screenshot Hotkey Updates Anki:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_hotkey_update_anki = tk.BooleanVar(value=self.settings.screenshot.screenshot_hotkey_updates_anki)
        ttk.Checkbutton(screenshot_frame, variable=self.screenshot_hotkey_update_anki).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(screenshot_frame, "Enable to allow Screenshot hotkey/button to update the latest anki card.", row=self.current_row,
                                         column=2)

        ttk.Label(screenshot_frame, text="Seconds After Line to SS:").grid(row=self.current_row, column=0, sticky='W')
        self.seconds_after_line = ttk.Entry(screenshot_frame)
        self.seconds_after_line.insert(0, str(self.settings.screenshot.seconds_after_line))
        self.seconds_after_line.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "This is only used for mining from lines from history (not current line)", row=self.current_row,
                                         column=2)

        ttk.Label(screenshot_frame, text="Use Beginning of Line as Screenshot:").grid(row=self.current_row, column=0, sticky='W')
        self.use_beginning_of_line_as_screenshot = tk.BooleanVar(value=self.settings.screenshot.use_beginning_of_line_as_screenshot)
        ttk.Checkbutton(screenshot_frame, variable=self.use_beginning_of_line_as_screenshot).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(screenshot_frame, "Enable to use the beginning of the line as the screenshot point. Adjust the above setting to fine-tine timing.", row=self.current_row, column=2)

        ttk.Label(screenshot_frame, text="Use alternative screenshot logic:").grid(row=self.current_row, column=0, sticky='W')
        self.use_new_screenshot_logic = tk.BooleanVar(value=self.settings.screenshot.use_new_screenshot_logic)
        ttk.Checkbutton(screenshot_frame, variable=self.use_new_screenshot_logic).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(screenshot_frame, "Enable to use the new screenshot logic. This will try to take the screenshot in the middle of the voiceline, or middle of the line if no audio/vad.", row=self.current_row, column=2)

    @new_tab
    def create_audio_tab(self):
        audio_frame = ttk.Frame(self.notebook)
        self.notebook.add(audio_frame, text='Audio')

        ttk.Label(audio_frame, text="Enabled:").grid(row=self.current_row, column=0, sticky='W')
        self.audio_enabled = tk.BooleanVar(value=self.settings.audio.enabled)
        ttk.Checkbutton(audio_frame, variable=self.audio_enabled).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(audio_frame, "Enable or disable audio processing.", row=self.current_row, column=2)

        ttk.Label(audio_frame, text="Audio Extension:").grid(row=self.current_row, column=0, sticky='W')
        self.audio_extension = ttk.Combobox(audio_frame, values=['opus', 'mp3', 'ogg', 'aac', 'm4a'])
        self.audio_extension.insert(0, self.settings.audio.extension)
        self.audio_extension.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(audio_frame, "File extension for audio files.", row=self.current_row, column=2)

        ttk.Label(audio_frame, text="Beginning Offset:").grid(row=self.current_row, column=0, sticky='W')
        self.beginning_offset = ttk.Entry(audio_frame)
        self.beginning_offset.insert(0, str(self.settings.audio.beginning_offset))
        self.beginning_offset.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(audio_frame, "Offset in seconds to start audio processing.",
                                         row=self.current_row, column=2)

        ttk.Label(audio_frame, text="End Offset:").grid(row=self.current_row, column=0, sticky='W')
        self.end_offset = ttk.Entry(audio_frame)
        self.end_offset.insert(0, str(self.settings.audio.end_offset))
        self.end_offset.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(audio_frame, "Offset in seconds to end audio processing.",
                                         row=self.current_row, column=2)

        ttk.Label(audio_frame, text="FFmpeg Reencode Options:").grid(row=self.current_row, column=0, sticky='W')
        self.ffmpeg_reencode_options = ttk.Entry(audio_frame, width=50)
        self.ffmpeg_reencode_options.insert(0, self.settings.audio.ffmpeg_reencode_options)
        self.ffmpeg_reencode_options.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(audio_frame, "Custom FFmpeg options for re-encoding audio files.",
                                         row=self.current_row, column=2)

        ttk.Label(audio_frame, text="Anki Media Collection:").grid(row=self.current_row, column=0, sticky='W')
        self.anki_media_collection = ttk.Entry(audio_frame)
        self.anki_media_collection.insert(0, self.settings.audio.anki_media_collection)
        self.anki_media_collection.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(audio_frame,
                                         "Path of the Anki Media Collection, used for external Trimming tool. NO TRAILING SLASH",
                                         row=self.current_row,
                                         column=2)

        ttk.Label(audio_frame, text="External Audio Editing Tool:").grid(row=self.current_row, column=0, sticky='W')
        self.external_tool = ttk.Entry(audio_frame)
        self.external_tool.insert(0, self.settings.audio.external_tool)
        self.external_tool.grid(row=self.current_row, column=1)
        ttk.Label(audio_frame, text="Enabled:").grid(row=self.current_row, column=2, sticky='W')
        self.external_tool_enabled = tk.BooleanVar(value=self.settings.audio.external_tool_enabled)
        ttk.Checkbutton(audio_frame, variable=self.external_tool_enabled).grid(row=self.current_row, column=3, sticky='W')
        self.add_label_and_increment_row(audio_frame,
                                         "Path to External tool that opens the audio up for manual trimming. I recommend OcenAudio for in-place Editing.",
                                         row=self.current_row,
                                         column=4)

        ttk.Button(audio_frame, text="Install Ocenaudio", command=self.download_and_install_ocen).grid(
            row=self.current_row, column=0, pady=5)
        ttk.Button(audio_frame, text="Get Anki Media Collection",
                   command=self.set_default_anki_media_collection).grid(row=self.current_row, column=1, pady=5)
        self.add_label_and_increment_row(audio_frame,
                                         "These Two buttons both help set up the External Audio Editing Tool. The first one downloads and installs OcenAudio, a free audio editing software. The second one sets the default Anki media collection path.",
                                         row=self.current_row,
                                         column=3)

    @new_tab
    def create_obs_tab(self):
        obs_frame = ttk.Frame(self.notebook)
        self.notebook.add(obs_frame, text='OBS')

        ttk.Label(obs_frame, text="Enabled:").grid(row=self.current_row, column=0, sticky='W')
        self.obs_enabled = tk.BooleanVar(value=self.settings.obs.enabled)
        ttk.Checkbutton(obs_frame, variable=self.obs_enabled).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(obs_frame, "Enable or disable OBS integration.", row=self.current_row,
                                         column=2)

        ttk.Label(obs_frame, text="Open OBS:").grid(row=self.current_row, column=0, sticky='W')
        self.open_obs = tk.BooleanVar(value=self.settings.obs.open_obs)
        ttk.Checkbutton(obs_frame, variable=self.open_obs).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(obs_frame, "Open OBS when the GSM starts.", row=self.current_row,
                                         column=2)

        ttk.Label(obs_frame, text="Close OBS:").grid(row=self.current_row, column=0, sticky='W')
        self.close_obs = tk.BooleanVar(value=self.settings.obs.close_obs)
        ttk.Checkbutton(obs_frame, variable=self.close_obs).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(obs_frame, "Close OBS when the GSM closes.", row=self.current_row,
                                         column=2)

        ttk.Label(obs_frame, text="Host:").grid(row=self.current_row, column=0, sticky='W')
        self.obs_host = ttk.Entry(obs_frame)
        self.obs_host.insert(0, self.settings.obs.host)
        self.obs_host.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(obs_frame, "Host address for the OBS WebSocket server.", row=self.current_row,
                                         column=2)

        ttk.Label(obs_frame, text="Port:").grid(row=self.current_row, column=0, sticky='W')
        self.obs_port = ttk.Entry(obs_frame)
        self.obs_port.insert(0, str(self.settings.obs.port))
        self.obs_port.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(obs_frame, "Port number for the OBS WebSocket server.", row=self.current_row,
                                         column=2)

        ttk.Label(obs_frame, text="Password:").grid(row=self.current_row, column=0, sticky='W')
        self.obs_password = ttk.Entry(obs_frame)
        self.obs_password.insert(0, self.settings.obs.password)
        self.obs_password.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(obs_frame, "Password for the OBS WebSocket server.", row=self.current_row,
                                         column=2)

        ttk.Label(obs_frame, text="Get Game From Scene Name:").grid(row=self.current_row, column=0, sticky='W')
        self.get_game_from_scene_name = tk.BooleanVar(value=self.settings.obs.get_game_from_scene)
        ttk.Checkbutton(obs_frame, variable=self.get_game_from_scene_name).grid(row=self.current_row, column=1,
                                                                                sticky='W')
        self.add_label_and_increment_row(obs_frame, "Changes Current Game to Scene Name", row=self.current_row,
                                         column=2)

        ttk.Label(obs_frame, text="Minimum Replay Size (KB):").grid(row=self.current_row, column=0, sticky='W')
        self.minimum_replay_size = ttk.Entry(obs_frame)
        self.minimum_replay_size.insert(0, str(self.settings.obs.minimum_replay_size))
        self.minimum_replay_size.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(obs_frame, "Minimum Replay Size for OBS Replays in KB. If Replay is Under this, "
                                                    "Audio/Screenshot Will not be grabbed.", row=self.current_row,
                                         column=2)

    @new_tab
    def create_hotkeys_tab(self):
        hotkeys_frame = ttk.Frame(self.notebook)
        self.notebook.add(hotkeys_frame, text='Hotkeys')

        ttk.Label(hotkeys_frame, text="Reset Line Hotkey:").grid(row=self.current_row, column=0, sticky='W')
        self.reset_line_hotkey = ttk.Entry(hotkeys_frame)
        self.reset_line_hotkey.insert(0, self.settings.hotkeys.reset_line)
        self.reset_line_hotkey.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(hotkeys_frame, "Hotkey to reset the current line of dialogue.",
                                         row=self.current_row, column=2)

        ttk.Label(hotkeys_frame, text="Take Screenshot Hotkey:").grid(row=self.current_row, column=0, sticky='W')
        self.take_screenshot_hotkey = ttk.Entry(hotkeys_frame)
        self.take_screenshot_hotkey.insert(0, self.settings.hotkeys.take_screenshot)
        self.take_screenshot_hotkey.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(hotkeys_frame, "Hotkey to take a screenshot.", row=self.current_row, column=2)

        ttk.Label(hotkeys_frame, text="Open Utility Hotkey:").grid(row=self.current_row, column=0, sticky='W')
        self.open_utility_hotkey = ttk.Entry(hotkeys_frame)
        self.open_utility_hotkey.insert(0, self.settings.hotkeys.open_utility)
        self.open_utility_hotkey.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(hotkeys_frame, "Hotkey to open the text utility.", row=self.current_row, column=2)


    @new_tab
    def create_profiles_tab(self):
        profiles_frame = ttk.Frame(self.notebook)
        self.notebook.add(profiles_frame, text='Profiles')

        ttk.Label(profiles_frame, text="Select Profile:").grid(row=self.current_row, column=0, sticky='W')
        self.profile_var = tk.StringVar(value=self.settings.name)
        self.profile_combobox = ttk.Combobox(profiles_frame, textvariable=self.profile_var, values=list(self.master_config.configs.keys()))
        self.profile_combobox.grid(row=self.current_row, column=1)
        self.profile_combobox.bind("<<ComboboxSelected>>", self.on_profile_change)
        self.add_label_and_increment_row(profiles_frame, "Select a profile to load its settings.", row=self.current_row, column=2)

        ttk.Button(profiles_frame, text="Add Profile", command=self.add_profile).grid(row=self.current_row, column=0, pady=5)
        ttk.Button(profiles_frame, text="Copy Profile", command=self.copy_profile).grid(row=self.current_row, column=1, pady=5)
        if self.master_config.current_profile != DEFAULT_CONFIG:
            ttk.Button(profiles_frame, text="Delete Config", command=self.delete_profile).grid(row=self.current_row, column=2, pady=5)

    @new_tab
    def create_advanced_tab(self):
        advanced_frame = ttk.Frame(self.notebook)
        self.notebook.add(advanced_frame, text='Advanced')

        ttk.Label(advanced_frame, text="Note: Only one of these will take effect, prioritizing audio.", foreground="red").grid(row=self.current_row, column=0, columnspan=3, sticky='W')
        self.current_row += 1

        ttk.Label(advanced_frame, text="Audio Player Path:").grid(row=self.current_row, column=0, sticky='W')
        self.audio_player_path = ttk.Entry(advanced_frame, width=50)
        self.audio_player_path.insert(0, self.settings.advanced.audio_player_path)
        self.audio_player_path.grid(row=self.current_row, column=1)
        ttk.Button(advanced_frame, text="Browse", command=lambda: self.browse_file(self.audio_player_path)).grid(row=self.current_row, column=2)
        self.add_label_and_increment_row(advanced_frame, "Path to the audio player executable. Will open the trimmed Audio", row=self.current_row, column=3)

        ttk.Label(advanced_frame, text="Video Player Path:").grid(row=self.current_row, column=0, sticky='W')
        self.video_player_path = ttk.Entry(advanced_frame, width=50)
        self.video_player_path.insert(0, self.settings.advanced.video_player_path)
        self.video_player_path.grid(row=self.current_row, column=1)
        ttk.Button(advanced_frame, text="Browse", command=lambda: self.browse_file(self.video_player_path)).grid(row=self.current_row, column=2)
        self.add_label_and_increment_row(advanced_frame, "Path to the video player executable. Will seek to the location of the line in the replay", row=self.current_row, column=3)


        ttk.Label(advanced_frame, text="Play Latest Video/Audio Hotkey:").grid(row=self.current_row, column=0, sticky='W')
        self.play_latest_audio_hotkey = ttk.Entry(advanced_frame)
        self.play_latest_audio_hotkey.insert(0, self.settings.hotkeys.play_latest_audio)
        self.play_latest_audio_hotkey.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(advanced_frame, "Hotkey to trim and play the latest audio.", row=self.current_row, column=2)

        ttk.Label(advanced_frame, text="Show Screenshot Button:").grid(row=self.current_row, column=0, sticky='W')
        self.show_screenshot_button = tk.BooleanVar(value=self.settings.advanced.show_screenshot_buttons)
        ttk.Checkbutton(advanced_frame, variable=self.show_screenshot_button).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(advanced_frame, "Show the screenshot button in the utility gui.", row=self.current_row, column=2)

        ttk.Label(advanced_frame, text="Multi-line Line-Break:").grid(row=self.current_row, column=0, sticky='W')
        self.multi_line_line_break = ttk.Entry(advanced_frame)
        self.multi_line_line_break.insert(0, self.settings.advanced.multi_line_line_break)
        self.multi_line_line_break.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(advanced_frame, "Line break for multi-line mining. This goes between each sentence", row=self.current_row, column=2)

        ttk.Label(advanced_frame, text="Multi-Line Sentence Storage Field:").grid(row=self.current_row, column=0, sticky='W')
        self.multi_line_sentence_storage_field = ttk.Entry(advanced_frame)
        self.multi_line_sentence_storage_field.insert(0, self.settings.advanced.multi_line_sentence_storage_field)
        self.multi_line_sentence_storage_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(advanced_frame, "Field in Anki for storing the multi-line sentence temporarily.", row=self.current_row, column=2)


    @new_tab
    def create_ai_tab(self):
        ai_frame = ttk.Frame(self.notebook)
        self.notebook.add(ai_frame, text='AI')

        ttk.Label(ai_frame, text="Enabled:").grid(row=self.current_row, column=0, sticky='W')
        self.ai_enabled = tk.BooleanVar(value=self.settings.ai.enabled)
        ttk.Checkbutton(ai_frame, variable=self.ai_enabled).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(ai_frame, "Enable or disable AI integration.", row=self.current_row, column=2)

        ttk.Label(ai_frame, text="Anki Field:").grid(row=self.current_row, column=0, sticky='W')
        self.ai_anki_field = ttk.Entry(ai_frame)
        self.ai_anki_field.insert(0, self.settings.ai.anki_field)
        self.ai_anki_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(ai_frame, "Field in Anki for AI-generated content.", row=self.current_row,
                                         column=2)

        # ttk.Label(ai_frame, text="Provider:").grid(row=self.current_row, column=0, sticky='W')
        # self.provider = ttk.Combobox(ai_frame,
        #                              values=[AI_GEMINI])
        # self.provider.set(self.settings.ai.provider)
        # self.provider.grid(row=self.current_row, column=1)
        # self.add_label_and_increment_row(ai_frame, "Select the AI provider. Currently only Gemini is supported.", row=self.current_row, column=2)

        ttk.Label(ai_frame, text="API Key:").grid(row=self.current_row, column=0, sticky='W')
        self.ai_api_key = ttk.Entry(ai_frame, show="*")  # Mask the API key for security
        self.ai_api_key.insert(0, self.settings.ai.api_key)
        self.ai_api_key.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(ai_frame, "API key for the selected AI provider (Gemini only currently).", row=self.current_row,
                                         column=2)

        ttk.Label(ai_frame, text="Use Canned Translation Prompt:").grid(row=self.current_row, column=0, sticky='W')
        self.use_canned_translation_prompt = tk.BooleanVar(value=self.settings.ai.use_canned_translation_prompt)
        ttk.Checkbutton(ai_frame, variable=self.use_canned_translation_prompt).grid(row=self.current_row, column=1,
                                                                                    sticky='W')
        self.add_label_and_increment_row(ai_frame, "Use a pre-defined translation prompt for AI.", row=self.current_row,
                                         column=2)

        ttk.Label(ai_frame, text="Use Canned Context Prompt:").grid(row=self.current_row, column=0, sticky='W')
        self.use_canned_context_prompt = tk.BooleanVar(value=self.settings.ai.use_canned_context_prompt)
        ttk.Checkbutton(ai_frame, variable=self.use_canned_context_prompt).grid(row=self.current_row, column=1,
                                                                                sticky='W')
        self.add_label_and_increment_row(ai_frame, "Use a pre-defined context prompt for AI.", row=self.current_row,
                                         column=2)

        ttk.Label(ai_frame, text="Custom Prompt:").grid(row=self.current_row, column=0, sticky='W')

        self.custom_prompt = scrolledtext.ScrolledText(ai_frame, width=50, height=5)  # Adjust height as needed
        self.custom_prompt.insert(tk.END, self.settings.ai.custom_prompt)
        self.custom_prompt.grid(row=self.current_row, column=1)

        self.add_label_and_increment_row(ai_frame, "Custom prompt for AI processing.", row=self.current_row, column=2)

        return ai_frame


    def on_profile_change(self, event):
        print("profile Changed!")
        self.save_settings(profile_change=True)
        self.reload_settings()

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
        new_profile_name = simpledialog.askstring("Input", "Enter new profile name:")
        if new_profile_name and source_profile in self.master_config.configs:
            self.master_config.configs[new_profile_name] = self.master_config.configs[source_profile]
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
            confirm = messagebox.askyesno("Confirm Delete", f"Are you sure you want to delete the profile '{profile_to_delete}'?")
            if confirm:
                del self.master_config.configs[profile_to_delete]
                self.profile_combobox['values'] = list(self.master_config.configs.keys())
                self.profile_combobox.set("Default")
                self.save_settings()
                self.reload_settings()


    def show_error_box(self, title, message):
        messagebox.showerror(title, message)

    def download_and_install_ocen(self):
        confirm = messagebox.askyesno("Download OcenAudio?", "Would you like to download and install OcenAudio? It is a free audio editing software that works extremely well with GSM.")
        if confirm:
            exe_path = download_ocenaudio_if_needed()
            messagebox.showinfo("OcenAudio Downloaded", f"OcenAudio has been downloaded and installed. You can find it at {exe_path}.")
            self.external_tool.delete(0, tk.END)
            self.external_tool.insert(0, exe_path)
            self.save_settings()

    def set_default_anki_media_collection(self):
        confirm = messagebox.askyesno("Set Default Anki Media Collection?", "Would you like to set the default Anki media collection path? This will help the script find the media collection for external trimming.\n\nDefault: %APPDATA%/Anki2/User 1/collection.media")
        if confirm:
            default_path = get_default_anki_media_collection_path()
            if default_path != self.settings.audio.external_tool:
                self.anki_media_collection.delete(0, tk.END)
                self.anki_media_collection.insert(0, default_path)
                self.save_settings()


if __name__ == '__main__':
    root = ttk.Window(themename='darkly')
    window = ConfigApp(root)
    window.show()
    window.window.mainloop()
