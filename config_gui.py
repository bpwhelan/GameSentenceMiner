import os
import tkinter as tk
from tkinter import filedialog
import ttkbootstrap as ttk
import json

import configuration
from configuration import *

import toml

TOML_CONFIG_FILE = 'config.toml'
CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config.json')
settings_saved = False


def new_tab(func):
    """Decorator to initialize the current row and perform pre-initialization tasks."""

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
        global settings_saved
        settings_saved = False
        self.root = root
        self.root.title('GameSentenceMiner Configuration')
        self.current_row = 0  # Initialize the row variable

        self.settings: Config = self.load_settings()

        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(pady=10, expand=True)

        self.create_general_tab()
        self.create_paths_tab()
        self.create_anki_tab()
        self.create_vad_tab()  # New VAD tab
        self.create_features_tab()
        self.create_screenshot_tab()
        self.create_audio_tab()
        self.create_obs_tab()
        self.create_hotkeys_tab()

        ttk.Button(self.root, text="Save Settings", command=self.save_settings).pack(pady=10)

    def load_settings(self):
        if os.path.exists('config.json'):
            try:
                with open('config.json', 'r') as file:
                    config_file = json.load(file)
                    return Config.from_dict(config_file)
            except json.JSONDecodeError as e:
                print(f"Error parsing config.json: {e}")
                return None
        elif os.path.exists('config.toml'):
            return Config().load_from_toml('config.toml')
        else:
            return Config()

    def save_settings(self):
        global settings_saved

        # Create a new Config instance
        config = Config(
            general=General(
                use_websocket=self.websocket_enabled.get(),
                websocket_uri=self.websocket_uri.get(),
                open_config_on_startup=self.open_config_on_startup.get()
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
                custom_tags=self.custom_tags.get().split(', '),
                add_game_tag=self.add_game_tag.get(),
                polling_rate=int(self.polling_rate.get()),
                overwrite_audio=self.overwrite_audio.get(),
                overwrite_picture=self.overwrite_picture.get(),
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
                width=int(self.screenshot_width.get()),
                height=int(self.screenshot_height.get()),
                quality=int(self.screenshot_quality.get()),
                extension=self.screenshot_extension.get(),
                custom_ffmpeg_settings=self.screenshot_custom_ffmpeg_settings.get()
            ),
            audio=Audio(
                extension=self.audio_extension.get(),
                beginning_offset=float(self.beginning_offset.get()),
                end_offset=float(self.end_offset.get()),
                ffmpeg_reencode_options=self.ffmpeg_reencode_options.get()
            ),
            obs=OBS(
                enabled=self.obs_enabled.get(),
                host=self.obs_host.get(),
                port=int(self.obs_port.get()),
                password=self.obs_password.get(),
                start_buffer=self.obs_start_buffer.get(),
                get_game_from_scene=self.get_game_from_scene_name.get()
            ),
            hotkeys=Hotkeys(
                reset_line=self.reset_line_hotkey.get(),
                take_screenshot=self.take_screenshot_hotkey.get()
            ),
            vad=VAD(
                whisper_model=self.whisper_model.get(),
                do_vad_postprocessing=self.do_vad_postprocessing.get(),
                vosk_url='https://alphacephei.com/vosk/models/vosk-model-ja-0.22.zip' if self.vosk_url.get() == VOSK_BASE else "https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip",
                selected_vad_model=self.selected_vad_model.get(),
                backup_vad_model=self.backup_vad_model.get(),
                trim_beginning=self.vad_trim_beginning.get()
            )
        )

        # Serialize the config instance to JSON
        with open('config.json', 'w') as file:
            file.write(config.to_json(indent=4))

        print("Settings saved successfully!")
        settings_saved = True
        configuration.reload_config()

    def increment_row(self):
        """Increment the current row index and return the new value."""
        self.current_row += 1
        return self.current_row

    def add_label_and_increment_row(self, root, label, row=0, column=0):
        HoverInfoWidget(root, label, row=self.current_row, column=column)
        self.increment_row()

    @new_tab
    def create_general_tab(self):
        general_frame = ttk.Frame(self.notebook)
        self.notebook.add(general_frame, text='General')

        ttk.Label(general_frame, text="Websocket Enabled:").grid(row=self.current_row, column=0, sticky='W')
        self.websocket_enabled = tk.BooleanVar(value=self.settings.general.use_websocket)
        ttk.Checkbutton(general_frame, variable=self.websocket_enabled).grid(row=self.current_row, column=1,
                                                                               sticky='W')
        self.add_label_and_increment_row(general_frame, "Enable or disable WebSocket communication.",
                                         row=self.current_row, column=2)

        ttk.Label(general_frame, text="Websocket URI:").grid(row=self.current_row, column=0, sticky='W')
        self.websocket_uri = ttk.Entry(general_frame)
        self.websocket_uri.insert(0, self.settings.general.websocket_uri)
        self.websocket_uri.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(general_frame, "WebSocket URI for connecting.", row=self.current_row,
                                         column=2)

        ttk.Label(general_frame, text="Open Config on Startup:").grid(row=self.current_row, column=0, sticky='W')
        self.open_config_on_startup = tk.BooleanVar(value=self.settings.general.open_config_on_startup)
        ttk.Checkbutton(general_frame, variable=self.open_config_on_startup).grid(row=self.current_row, column=1,
                                                                             sticky='W')
        self.add_label_and_increment_row(general_frame, "Whether to open config when the script starts.",
                                         row=self.current_row, column=2)

    @new_tab
    def create_vad_tab(self):
        vad_frame = ttk.Frame(self.notebook)
        self.notebook.add(vad_frame, text='VAD')

        ttk.Label(vad_frame, text="Voice Detection Postprocessing:").grid(row=self.current_row, column=0, sticky='W')
        self.do_vad_postprocessing = tk.BooleanVar(
            value=self.settings.vad.do_vad_postprocessing)
        ttk.Checkbutton(vad_frame, variable=self.do_vad_postprocessing).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(vad_frame, "Enable post-processing of audio to trim just the voiceline.", row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Whisper Model:").grid(row=self.current_row, column=0, sticky='W')
        self.whisper_model = ttk.Combobox(vad_frame, values=[WHISPER_TINY, WHISPER_BASE, WHISPER_SMALL, WHISPER_MEDIUM, WHSIPER_LARGE])
        self.whisper_model.set(self.settings.vad.whisper_model)
        self.whisper_model.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(vad_frame, "Select the Whisper model size for VAD.", row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Vosk URL:").grid(row=self.current_row, column=0, sticky='W')
        self.vosk_url = ttk.Combobox(vad_frame, values=[VOSK_BASE, VOSK_SMALL])
        self.vosk_url.insert(0, VOSK_BASE if self.settings.vad.vosk_url == 'https://alphacephei.com/vosk/models/vosk-model-ja-0.22.zip' else VOSK_SMALL)
        self.vosk_url.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(vad_frame, "URL for connecting to the Vosk server.", row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Select VAD Model:").grid(row=self.current_row, column=0, sticky='W')
        self.selected_vad_model = ttk.Combobox(vad_frame, values=[VOSK, SILERO, WHISPER])
        self.selected_vad_model.set(self.settings.vad.selected_vad_model)
        self.selected_vad_model.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(vad_frame, "Select which VAD model to use.", row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Backup VAD Model:").grid(row=self.current_row, column=0, sticky='W')
        self.backup_vad_model = ttk.Combobox(vad_frame, values=[OFF, VOSK, SILERO, WHISPER])
        self.backup_vad_model.set(self.settings.vad.backup_vad_model)
        self.backup_vad_model.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(vad_frame, "Select which model to use as a backup if no audio is found.", row=self.current_row, column=2)

        ttk.Label(vad_frame, text="Trim Beginning:").grid(row=self.current_row, column=0, sticky='W')
        self.vad_trim_beginning = tk.BooleanVar(
            value=self.settings.vad.trim_beginning)
        ttk.Checkbutton(vad_frame, variable=self.vad_trim_beginning).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(vad_frame, "Trim the beginning of the audio based on Voice Detection Results",
                                         row=self.current_row, column=2)

    @new_tab
    def create_paths_tab(self):
        paths_frame = ttk.Frame(self.notebook)
        self.notebook.add(paths_frame, text='Paths')

        ttk.Label(paths_frame, text="Folder to Watch:").grid(row=self.current_row, column=0, sticky='W')
        self.folder_to_watch = ttk.Entry(paths_frame, width=50)
        self.folder_to_watch.insert(0, self.settings.paths.folder_to_watch)
        self.folder_to_watch.grid(row=self.current_row, column=1)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.folder_to_watch)).grid(row=self.current_row,
                                                                                                              column=2)
        self.add_label_and_increment_row(paths_frame, "Path where the OBS Replays will be saved.", row=self.current_row, column=3)

        ttk.Label(paths_frame, text="Audio Destination:").grid(row=self.current_row, column=0, sticky='W')
        self.audio_destination = ttk.Entry(paths_frame, width=50)
        self.audio_destination.insert(0, self.settings.paths.audio_destination)
        self.audio_destination.grid(row=self.current_row, column=1)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.audio_destination)).grid(row=self.current_row,
                                                                                                                column=2)
        self.add_label_and_increment_row(paths_frame, "Path where the cut Audio will be saved.", row=self.current_row, column=3)

        ttk.Label(paths_frame, text="Screenshot Destination:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_destination = ttk.Entry(paths_frame, width=50)
        self.screenshot_destination.insert(0, self.settings.paths.screenshot_destination)
        self.screenshot_destination.grid(row=self.current_row, column=1)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.screenshot_destination)).grid(
            row=self.current_row, column=2)
        self.add_label_and_increment_row(paths_frame, "Path where the Screenshot will be saved.", row=self.current_row, column=3)

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
        self.add_label_and_increment_row(paths_frame, "Remove screenshots after processing.", row=self.current_row, column=2)

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
        self.add_label_and_increment_row(anki_frame, "Automatically update Anki with new data.", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Anki URL:").grid(row=self.current_row, column=0, sticky='W')
        self.anki_url = ttk.Entry(anki_frame, width=50)
        self.anki_url.insert(0, self.settings.anki.url)
        self.anki_url.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "The URL to connect to your Anki instance.", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Sentence Field:").grid(row=self.current_row, column=0, sticky='W')
        self.sentence_field = ttk.Entry(anki_frame)
        self.sentence_field.insert(0, self.settings.anki.sentence_field)
        self.sentence_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Field in Anki for the main sentence.", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Sentence Audio Field:").grid(row=self.current_row, column=0, sticky='W')
        self.sentence_audio_field = ttk.Entry(anki_frame)
        self.sentence_audio_field.insert(0, self.settings.anki.sentence_audio_field)
        self.sentence_audio_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Field in Anki for audio associated with the sentence.", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Picture Field:").grid(row=self.current_row, column=0, sticky='W')
        self.picture_field = ttk.Entry(anki_frame)
        self.picture_field.insert(0, self.settings.anki.picture_field)
        self.picture_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Field in Anki for associated pictures.", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Word Field:").grid(row=self.current_row, column=0, sticky='W')
        self.word_field = ttk.Entry(anki_frame)
        self.word_field.insert(0, self.settings.anki.word_field)
        self.word_field.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Field in Anki for individual words.", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Custom Tags:").grid(row=self.current_row, column=0, sticky='W')
        self.custom_tags = ttk.Entry(anki_frame)
        self.custom_tags.insert(0, ', '.join(self.settings.anki.custom_tags))
        self.custom_tags.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Comma-separated custom tags for the Anki cards.", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Add Game Tag:").grid(row=self.current_row, column=0, sticky='W')
        self.add_game_tag = tk.BooleanVar(value=self.settings.anki.add_game_tag)
        ttk.Checkbutton(anki_frame, variable=self.add_game_tag).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(anki_frame, "Include a tag for the game on the Anki card.", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Polling Rate:").grid(row=self.current_row, column=0, sticky='W')
        self.polling_rate = ttk.Entry(anki_frame)
        self.polling_rate.insert(0, str(self.settings.anki.polling_rate))
        self.polling_rate.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(anki_frame, "Rate at which Anki will check for updates (in milliseconds).", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Overwrite Audio:").grid(row=self.current_row, column=0, sticky='W')
        self.overwrite_audio = tk.BooleanVar(
            value=self.settings.anki.overwrite_audio)
        ttk.Checkbutton(anki_frame, variable=self.overwrite_audio).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(anki_frame, "Overwrite existing audio in Anki cards.", row=self.current_row, column=2)

        ttk.Label(anki_frame, text="Overwrite Picture:").grid(row=self.current_row, column=0, sticky='W')
        self.overwrite_picture = tk.BooleanVar(
            value=self.settings.anki.overwrite_picture)
        ttk.Checkbutton(anki_frame, variable=self.overwrite_picture).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(anki_frame, "Overwrite existing pictures in Anki cards.", row=self.current_row, column=2)

        self.anki_custom_fields = self.settings.anki.anki_custom_fields
        self.custom_field_entries = []

        row_at_the_time = self.current_row + 1

        ttk.Button(anki_frame, text="Add Field",
                   command=lambda: self.add_custom_field(anki_frame, row_at_the_time)).grid(row=self.current_row, column=0, pady=5)
        self.add_label_and_increment_row(anki_frame, "Add a new custom field for Anki cards.", row=self.current_row, column=2)
        self.display_custom_fields(anki_frame, self.current_row)

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
        self.add_label_and_increment_row(features_frame, "Notify the user when an update occurs.", row=self.current_row, column=2)

        ttk.Label(features_frame, text="Open Anki Edit:").grid(row=self.current_row, column=0, sticky='W')
        self.open_anki_edit = tk.BooleanVar(value=self.settings.features.open_anki_edit)
        ttk.Checkbutton(features_frame, variable=self.open_anki_edit).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(features_frame, "Automatically open Anki for editing after updating.", row=self.current_row, column=2)

        ttk.Label(features_frame, text="Backfill Audio:").grid(row=self.current_row, column=0, sticky='W')
        self.backfill_audio = tk.BooleanVar(value=self.settings.features.backfill_audio)
        ttk.Checkbutton(features_frame, variable=self.backfill_audio).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(features_frame, "Fill in audio data for existing entries.", row=self.current_row, column=2)

        ttk.Label(features_frame, text="Full Auto Mode:").grid(row=self.current_row, column=0, sticky='W')
        self.full_auto = tk.BooleanVar(
            value=self.settings.features.full_auto)
        ttk.Checkbutton(features_frame, variable=self.full_auto).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(features_frame, "Yomitan 1-click anki card creation.", row=self.current_row, column=2)

    @new_tab
    def create_screenshot_tab(self):
        screenshot_frame = ttk.Frame(self.notebook)
        self.notebook.add(screenshot_frame, text='Screenshot')

        ttk.Label(screenshot_frame, text="Width:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_width = ttk.Entry(screenshot_frame)
        self.screenshot_width.insert(0, str(self.settings.screenshot.width))
        self.screenshot_width.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "Width of the screenshot in pixels.", row=self.current_row, column=2)

        ttk.Label(screenshot_frame, text="Height:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_height = ttk.Entry(screenshot_frame)
        self.screenshot_height.insert(0, str(self.settings.screenshot.height))
        self.screenshot_height.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "Height of the screenshot in pixels.", row=self.current_row, column=2)

        ttk.Label(screenshot_frame, text="Quality:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_quality = ttk.Entry(screenshot_frame)
        self.screenshot_quality.insert(0, str(self.settings.screenshot.quality))
        self.screenshot_quality.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "Quality of the screenshot (0-100).", row=self.current_row, column=2)

        ttk.Label(screenshot_frame, text="Extension:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_extension = ttk.Combobox(screenshot_frame, values=['webp', 'avif', 'png', 'jpeg'])
        self.screenshot_extension.insert(0, self.settings.screenshot.extension)
        self.screenshot_extension.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "File extension for the screenshot format.", row=self.current_row, column=2)

        ttk.Label(screenshot_frame, text="FFmpeg Reencode Options:").grid(row=self.current_row, column=0, sticky='W')
        self.screenshot_custom_ffmpeg_settings = ttk.Entry(screenshot_frame, width=50)
        self.screenshot_custom_ffmpeg_settings.insert(0, self.settings.screenshot.custom_ffmpeg_settings)
        self.screenshot_custom_ffmpeg_settings.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(screenshot_frame, "Custom FFmpeg options for re-encoding screenshots.", row=self.current_row, column=2)

    @new_tab
    def create_audio_tab(self):
        audio_frame = ttk.Frame(self.notebook)
        self.notebook.add(audio_frame, text='Audio')

        ttk.Label(audio_frame, text="Audio Extension:").grid(row=self.current_row, column=0, sticky='W')
        self.audio_extension = ttk.Combobox(audio_frame, values=['opus', 'mp3','ogg', 'aac', 'm4a'])
        self.audio_extension.insert(0, self.settings.audio.extension)
        self.audio_extension.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(audio_frame, "File extension for audio files.", row=self.current_row, column=2)

        ttk.Label(audio_frame, text="Beginning Offset:").grid(row=self.current_row, column=0, sticky='W')
        self.beginning_offset = ttk.Entry(audio_frame)
        self.beginning_offset.insert(0, str(self.settings.audio.beginning_offset))
        self.beginning_offset.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(audio_frame, "Offset in seconds to start audio processing.", row=self.current_row, column=2)

        ttk.Label(audio_frame, text="End Offset:").grid(row=self.current_row, column=0, sticky='W')
        self.end_offset = ttk.Entry(audio_frame)
        self.end_offset.insert(0, str(self.settings.audio.end_offset))
        self.end_offset.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(audio_frame, "Offset in seconds to end audio processing.", row=self.current_row, column=2)

        ttk.Label(audio_frame, text="FFmpeg Reencode Options:").grid(row=self.current_row, column=0, sticky='W')
        self.ffmpeg_reencode_options = ttk.Entry(audio_frame, width=50)
        self.ffmpeg_reencode_options.insert(0, self.settings.audio.ffmpeg_reencode_options)
        self.ffmpeg_reencode_options.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(audio_frame, "Custom FFmpeg options for re-encoding audio files.", row=self.current_row, column=2)

    @new_tab
    def create_obs_tab(self):
        obs_frame = ttk.Frame(self.notebook)
        self.notebook.add(obs_frame, text='OBS')

        ttk.Label(obs_frame, text="Enabled:").grid(row=self.current_row, column=0, sticky='W')
        self.obs_enabled = tk.BooleanVar(value=self.settings.obs.enabled)
        ttk.Checkbutton(obs_frame, variable=self.obs_enabled).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(obs_frame, "Enable or disable OBS integration.", row=self.current_row, column=2)

        ttk.Label(obs_frame, text="Host:").grid(row=self.current_row, column=0, sticky='W')
        self.obs_host = ttk.Entry(obs_frame)
        self.obs_host.insert(0, self.settings.obs.host)
        self.obs_host.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(obs_frame, "Host address for the OBS WebSocket server.", row=self.current_row, column=2)

        ttk.Label(obs_frame, text="Port:").grid(row=self.current_row, column=0, sticky='W')
        self.obs_port = ttk.Entry(obs_frame)
        self.obs_port.insert(0, str(self.settings.obs.port))
        self.obs_port.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(obs_frame, "Port number for the OBS WebSocket server.", row=self.current_row, column=2)

        ttk.Label(obs_frame, text="Password:").grid(row=self.current_row, column=0, sticky='W')
        self.obs_password = ttk.Entry(obs_frame)
        self.obs_password.insert(0, self.settings.obs.password)
        self.obs_password.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(obs_frame, "Password for the OBS WebSocket server.", row=self.current_row, column=2)

        ttk.Label(obs_frame, text="Start/Stop Buffer:").grid(row=self.current_row, column=0, sticky='W')
        self.obs_start_buffer = tk.BooleanVar(value=self.settings.obs.start_buffer)
        ttk.Checkbutton(obs_frame, variable=self.obs_start_buffer).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(obs_frame, "Start and Stop the Buffer when Script runs.", row=self.current_row,
                                         column=2)

        ttk.Label(obs_frame, text="Get Game From Scene Name:").grid(row=self.current_row, column=0, sticky='W')
        self.get_game_from_scene_name = tk.BooleanVar(value=self.settings.obs.get_game_from_scene)
        ttk.Checkbutton(obs_frame, variable=self.get_game_from_scene_name).grid(row=self.current_row, column=1, sticky='W')
        self.add_label_and_increment_row(obs_frame, "Changes Current Game to Scene Name", row=self.current_row,
                                         column=2)


    @new_tab
    def create_hotkeys_tab(self):
        hotkeys_frame = ttk.Frame(self.notebook)
        self.notebook.add(hotkeys_frame, text='Hotkeys')

        ttk.Label(hotkeys_frame, text="Reset Line Hotkey:").grid(row=self.current_row, column=0, sticky='W')
        self.reset_line_hotkey = ttk.Entry(hotkeys_frame)
        self.reset_line_hotkey.insert(0, self.settings.hotkeys.reset_line)
        self.reset_line_hotkey.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(hotkeys_frame, "Hotkey to reset the current line of dialogue.", row=self.current_row, column=2)

        ttk.Label(hotkeys_frame, text="Take Screenshot Hotkey:").grid(row=self.current_row, column=0, sticky='W')
        self.take_screenshot_hotkey = ttk.Entry(hotkeys_frame)
        self.take_screenshot_hotkey.insert(0, self.settings.hotkeys.take_screenshot)
        self.take_screenshot_hotkey.grid(row=self.current_row, column=1)
        self.add_label_and_increment_row(hotkeys_frame, "Hotkey to take a screenshot.", row=self.current_row, column=2)


def show_gui():
    root = ttk.Window(themename='darkly')
    ConfigApp(root)
    root.mainloop()
    return settings_saved


if __name__ == '__main__':
    show_gui()
    if settings_saved:
        exit(0)
    else:
        exit(1)