import os
import tkinter as tk
from tkinter import filedialog
import ttkbootstrap as ttk
import json

import toml

TOML_CONFIG_FILE = 'config.toml'
CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config.json')

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
        label = tk.Label(self.tooltip, text=text, background="yellow", relief="solid", borderwidth=1, font=("tahoma", "8", "normal"))
        label.pack(ipadx=1)

    def hide_info_box(self):
        if self.tooltip:
            self.tooltip.destroy()
            self.tooltip = None


class ConfigApp:
    def __init__(self, root):
        self.root = root
        self.root.title('GameSentenceMiner Configuration')

        # Customize the style for dark mode
        style = ttk.Style()
        style.theme_use('darkly')
        style.configure('TNotebook.Tab', padding=[10, 10], font=('Helvetica', 10))

        self.settings = self.load_settings()

        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(pady=10, expand=True)

        self.create_general_tab()
        self.create_paths_tab()
        self.create_anki_tab()
        self.create_features_tab()
        self.create_screenshot_tab()
        self.create_audio_tab()
        self.create_obs_tab()
        self.create_websocket_tab()
        self.create_hotkeys_tab()

        ttk.Button(self.root, text="Save Settings", command=self.save_settings).pack(pady=10)

    def load_settings(self):
        if os.path.exists('config.json'):
            # If the JSON config exists, load it
            try:
                with open('config.json', 'r') as file:
                    config_file = json.load(file)
                    return config_file
            except json.JSONDecodeError as e:
                print(f"Error parsing {CONFIG_FILE}: {e}")
                return None
        else:
            # If the JSON config doesn't exist, load from TOML and write to JSON
            try:
                with open(TOML_CONFIG_FILE, 'r') as file:
                    toml_config = toml.load(file)

                    # Write the TOML data to JSON file
                    with open(CONFIG_FILE, 'w') as json_file:
                        json.dump(toml_config, json_file, indent=4)

                    print(f"Configuration file created from {TOML_CONFIG_FILE}.")
                    return toml_config
            except FileNotFoundError:
                print(f"Configuration file {TOML_CONFIG_FILE} not found!")
                return None
            except toml.TomlDecodeError as e:
                print(f"Error parsing {TOML_CONFIG_FILE}: {e}")
                return None

    def save_settings(self):
        # Update settings from GUI elements before saving
        self.settings['general'] = {
            'console_log_level': self.console_log_level.get(),
            'file_log_level': self.file_log_level.get(),
            'whisper_model': self.whisper_model.get(),
        }
        self.settings['paths'] = {
            'folder_to_watch': self.folder_to_watch.get(),
            'audio_destination': self.audio_destination.get(),
            'screenshot_destination': self.screenshot_destination.get(),
        }
        self.settings['anki'] = {
            'url': self.anki_url.get(),
            'sentence_field': self.sentence_field.get(),
            'sentence_audio_field': self.sentence_audio_field.get(),
            'picture_field': self.picture_field.get(),
            'word_field': self.word_field.get(),
            'custom_tags': self.custom_tags.get().split(', '),
            'add_game_tag': self.add_game_tag.get(),
            'polling_rate': int(self.polling_rate.get()),
        }
        self.settings['features'] = {
            'full_auto': self.full_auto.get(),
            'do_vad_postprocessing': self.do_vad_postprocessing.get(),
            'remove_video': self.remove_video.get(),
            'remove_audio': self.remove_audio.get(),
            'remove_screenshot': self.remove_screenshot.get(),
            'update_anki': self.update_anki.get(),
            'notify_on_update': self.notify_on_update.get(),
            'open_anki_edit': self.open_anki_edit.get(),
            'backfill_audio': self.backfill_audio.get(),
        }
        self.settings['screenshot'] = {
            'width': int(self.screenshot_width.get()),
            'height': int(self.screenshot_height.get()),
            'quality': int(self.screenshot_quality.get()),
            'extension': self.screenshot_extension.get(),
            'custom_ffmpeg_settings': self.screenshot_custom_ffmpeg_settings.get(),
        }
        self.settings['audio'] = {
            'extension': self.audio_extension.get(),
            'beginning_offset': float(self.beginning_offset.get()),
            'end_offset': float(self.end_offset.get()),
            'ffmpeg_reencode_options': self.ffmpeg_reencode_options.get(),
        }
        self.settings['obs'] = {
            'enabled': self.obs_enabled.get(),
            'host': self.obs_host.get(),
            'port': int(self.obs_port.get()),
            'password': self.obs_password.get(),
        }
        self.settings['anki_custom_fields'] = {
            key_entry.get(): value_entry.get() for key_entry, value_entry in self.custom_field_entries if
            key_entry.get()
        }
        self.settings['anki_overwrites'] = {
            'overwrite_audio': self.overwrite_audio.get(),
            'overwrite_picture': self.overwrite_picture.get(),
        }
        self.settings['websocket'] = {
            'enabled': self.websocket_enabled.get(),
            'uri': self.websocket_uri.get(),
        }
        self.settings['hotkeys'] = {
            'reset_hotkey': self.reset_offset_hotkey.get(),
            'reset_line': self.reset_line_hotkey.get(),
            'take_screenshot': self.take_screenshot_hotkey.get(),
        }

        with open('config.json', 'w') as file:
            json.dump(self.settings, file, indent=4)
        print("Settings saved successfully!")

    def create_general_tab(self):
        general_frame = ttk.Frame(self.notebook)
        self.notebook.add(general_frame, text='General')

        ttk.Label(general_frame, text="Console Log Level:").grid(row=0, column=0, sticky='W')
        self.console_log_level = ttk.Combobox(general_frame, values=['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'])
        self.console_log_level.set(self.settings.get('general', {}).get('console_log_level', 'INFO'))
        self.console_log_level.grid(row=0, column=1)
        HoverInfoWidget(general_frame, "Log Level for the Console, Default: INFO", row=0, column=2)

        ttk.Label(general_frame, text="File Log Level:").grid(row=1, column=0, sticky='W')
        self.file_log_level = ttk.Combobox(general_frame, values=['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'])
        self.file_log_level.set(self.settings.get('general', {}).get('file_log_level', 'DEBUG'))
        self.file_log_level.grid(row=1, column=1)
        HoverInfoWidget(general_frame, "Log Level for the Log File, Default: DEBUG.", row=1, column=2)

        ttk.Label(general_frame, text="Whisper Model:").grid(row=2, column=0, sticky='W')
        self.whisper_model = ttk.Combobox(general_frame, values=['tiny', 'base', 'small', 'medium', 'large'])
        self.whisper_model.set(self.settings.get('general', {}).get('whisper_model', 'base'))
        self.whisper_model.grid(row=2, column=1)
        HoverInfoWidget(general_frame, "Select the Whisper model size for vad. Recommend keeping this as tiny or base", row=2, column=2)

    def create_paths_tab(self):
        paths_frame = ttk.Frame(self.notebook)
        self.notebook.add(paths_frame, text='Paths')

        ttk.Label(paths_frame, text="Folder to Watch:").grid(row=0, column=0, sticky='W')
        self.folder_to_watch = ttk.Entry(paths_frame, width=50)
        self.folder_to_watch.insert(0, self.settings.get('paths', {}).get('folder_to_watch', '~/Videos/OBS'))
        self.folder_to_watch.grid(row=0, column=1)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.folder_to_watch)).grid(row=0,
                                                                                                              column=2)
        HoverInfoWidget(paths_frame, "Path where the OBS Replays will be saved.", row=0, column=3)

        ttk.Label(paths_frame, text="Audio Destination:").grid(row=1, column=0, sticky='W')
        self.audio_destination = ttk.Entry(paths_frame, width=50)
        self.audio_destination.insert(0, self.settings.get('paths', {}).get('audio_destination', '~/Videos/OBS/Audio/'))
        self.audio_destination.grid(row=1, column=1)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.audio_destination)).grid(row=1,
                                                                                                                column=2)
        HoverInfoWidget(paths_frame, "Path where the cut Audio will be saved.", row=1, column=3)

        ttk.Label(paths_frame, text="Screenshot Destination:").grid(row=2, column=0, sticky='W')
        self.screenshot_destination = ttk.Entry(paths_frame, width=50)
        self.screenshot_destination.insert(0, self.settings.get('paths', {}).get('screenshot_destination',
                                                                                 '~/Videos/OBS/SS/'))
        self.screenshot_destination.grid(row=2, column=1)
        ttk.Button(paths_frame, text="Browse", command=lambda: self.browse_folder(self.screenshot_destination)).grid(
            row=2, column=2)
        HoverInfoWidget(paths_frame, "Path where the Screenshot will be saved.", row=2, column=3)

    def browse_folder(self, entry_widget):
        folder_selected = filedialog.askdirectory()
        if folder_selected:
            entry_widget.delete(0, tk.END)
            entry_widget.insert(0, folder_selected)

    def create_anki_tab(self):
        anki_frame = ttk.Frame(self.notebook)
        self.notebook.add(anki_frame, text='Anki')

        ttk.Label(anki_frame, text="Anki URL:").grid(row=0, column=0, sticky='W')
        self.anki_url = ttk.Entry(anki_frame, width=50)
        self.anki_url.insert(0, self.settings.get('anki', {}).get('url', 'http://127.0.0.1:8765'))
        self.anki_url.grid(row=0, column=1)
        HoverInfoWidget(anki_frame, "The URL to connect to your Anki instance.", row=0, column=2)

        ttk.Label(anki_frame, text="Sentence Field:").grid(row=1, column=0, sticky='W')
        self.sentence_field = ttk.Entry(anki_frame)
        self.sentence_field.insert(0, self.settings.get('anki', {}).get('sentence_field', 'Sentence'))
        self.sentence_field.grid(row=1, column=1)
        HoverInfoWidget(anki_frame, "Field in Anki for the main sentence.", row=1, column=2)

        ttk.Label(anki_frame, text="Sentence Audio Field:").grid(row=2, column=0, sticky='W')
        self.sentence_audio_field = ttk.Entry(anki_frame)
        self.sentence_audio_field.insert(0, self.settings.get('anki', {}).get('sentence_audio_field', 'SentenceAudio'))
        self.sentence_audio_field.grid(row=2, column=1)
        HoverInfoWidget(anki_frame, "Field in Anki for audio associated with the sentence.", row=2, column=2)

        ttk.Label(anki_frame, text="Picture Field:").grid(row=3, column=0, sticky='W')
        self.picture_field = ttk.Entry(anki_frame)
        self.picture_field.insert(0, self.settings.get('anki', {}).get('picture_field', 'Picture'))
        self.picture_field.grid(row=3, column=1)
        HoverInfoWidget(anki_frame, "Field in Anki for associated pictures.", row=3, column=2)

        ttk.Label(anki_frame, text="Word Field:").grid(row=4, column=0, sticky='W')
        self.word_field = ttk.Entry(anki_frame)
        self.word_field.insert(0, self.settings.get('anki', {}).get('word_field', 'Word'))
        self.word_field.grid(row=4, column=1)
        HoverInfoWidget(anki_frame, "Field in Anki for individual words.", row=4, column=2)

        ttk.Label(anki_frame, text="Custom Tags:").grid(row=5, column=0, sticky='W')
        self.custom_tags = ttk.Entry(anki_frame)
        self.custom_tags.insert(0, ', '.join(self.settings.get('anki', {}).get('custom_tags', [])))
        self.custom_tags.grid(row=5, column=1)
        HoverInfoWidget(anki_frame, "Comma-separated custom tags for the Anki cards.", row=5, column=2)

        ttk.Label(anki_frame, text="Add Game Tag:").grid(row=6, column=0, sticky='W')
        self.add_game_tag = tk.BooleanVar(value=self.settings.get('anki', {}).get('add_game_tag', True))
        ttk.Checkbutton(anki_frame, variable=self.add_game_tag).grid(row=6, column=1, sticky='W')
        HoverInfoWidget(anki_frame, "Include a tag for the game on the Anki card.", row=6, column=2)

        ttk.Label(anki_frame, text="Polling Rate:").grid(row=7, column=0, sticky='W')
        self.polling_rate = ttk.Entry(anki_frame)
        self.polling_rate.insert(0, self.settings.get('anki', {}).get('polling_rate', 200))
        self.polling_rate.grid(row=7, column=1)
        HoverInfoWidget(anki_frame, "Rate at which Anki will check for updates (in milliseconds).", row=7, column=2)

        ttk.Label(anki_frame, text="Overwrite Audio:").grid(row=8, column=0, sticky='W')
        self.overwrite_audio = tk.BooleanVar(
            value=self.settings.get('anki_overwrites', {}).get('overwrite_audio', False))
        ttk.Checkbutton(anki_frame, variable=self.overwrite_audio).grid(row=8, column=1, sticky='W')
        HoverInfoWidget(anki_frame, "Overwrite existing audio in Anki cards.", row=8, column=2)

        ttk.Label(anki_frame, text="Overwrite Picture:").grid(row=9, column=0, sticky='W')
        self.overwrite_picture = tk.BooleanVar(
            value=self.settings.get('anki_overwrites', {}).get('overwrite_picture', True))
        ttk.Checkbutton(anki_frame, variable=self.overwrite_picture).grid(row=9, column=1, sticky='W')
        HoverInfoWidget(anki_frame, "Overwrite existing pictures in Anki cards.", row=9, column=2)

        self.anki_custom_fields = self.settings.get('anki_custom_fields', {})
        self.custom_field_entries = []

        ttk.Button(anki_frame, text="Add Field",
                   command=lambda: self.add_custom_field(anki_frame, 10)).grid(row=10, column=0, pady=5)
        HoverInfoWidget(anki_frame, "Add a new custom field for Anki cards.", row=10, column=2)
        self.display_custom_fields(anki_frame, 10)

    def add_custom_field(self, frame, start_row):
        row = len(self.custom_field_entries) + 1 + start_row

        key_entry = ttk.Entry(frame)
        key_entry.grid(row=row, column=0, padx=5, pady=2, sticky='W')
        value_entry = ttk.Entry(frame)
        value_entry.grid(row=row, column=1, padx=5, pady=2, sticky='W')

        self.custom_field_entries.append((key_entry, value_entry))

    def display_custom_fields(self, frame, start_row):
        for row, (key, value) in enumerate(self.anki_custom_fields.items(), start=1):
            key_entry = ttk.Entry(frame)
            key_entry.insert(0, key)
            key_entry.grid(row=row + start_row, column=0, padx=5, pady=2, sticky='W')
            value_entry = ttk.Entry(frame)
            value_entry.insert(0, value)
            value_entry.grid(row=row + start_row, column=1, padx=5, pady=2, sticky='W')

            self.custom_field_entries.append((key_entry, value_entry))

    def create_features_tab(self):
        features_frame = ttk.Frame(self.notebook)
        self.notebook.add(features_frame, text='Features')

        ttk.Label(features_frame, text="Voice Detection Postprocessing:").grid(row=0, column=0, sticky='W')
        self.do_vad_postprocessing = tk.BooleanVar(
            value=self.settings.get('features', {}).get('do_vad_postprocessing', True))
        ttk.Checkbutton(features_frame, variable=self.do_vad_postprocessing).grid(row=0, column=1, sticky='W')
        HoverInfoWidget(features_frame, "Enable post-processing of Audio to trim just the voiceline.", row=0, column=2)

        ttk.Label(features_frame, text="Remove Video:").grid(row=1, column=0, sticky='W')
        self.remove_video = tk.BooleanVar(value=self.settings.get('features', {}).get('remove_video', True))
        ttk.Checkbutton(features_frame, variable=self.remove_video).grid(row=1, column=1, sticky='W')
        HoverInfoWidget(features_frame, "Remove video from the output.", row=1, column=2)

        ttk.Label(features_frame, text="Remove Audio:").grid(row=2, column=0, sticky='W')
        self.remove_audio = tk.BooleanVar(value=self.settings.get('features', {}).get('remove_audio', False))
        ttk.Checkbutton(features_frame, variable=self.remove_audio).grid(row=2, column=1, sticky='W')
        HoverInfoWidget(features_frame, "Remove audio from the output.", row=2, column=2)

        ttk.Label(features_frame, text="Remove Screenshot:").grid(row=3, column=0, sticky='W')
        self.remove_screenshot = tk.BooleanVar(value=self.settings.get('features', {}).get('remove_screenshot', False))
        ttk.Checkbutton(features_frame, variable=self.remove_screenshot).grid(row=3, column=1, sticky='W')
        HoverInfoWidget(features_frame, "Remove screenshots after processing.", row=3, column=2)

        ttk.Label(features_frame, text="Update Anki:").grid(row=4, column=0, sticky='W')
        self.update_anki = tk.BooleanVar(value=self.settings.get('features', {}).get('update_anki', True))
        ttk.Checkbutton(features_frame, variable=self.update_anki).grid(row=4, column=1, sticky='W')
        HoverInfoWidget(features_frame, "Automatically update Anki with new data.", row=4, column=2)

        ttk.Label(features_frame, text="Notify on Update:").grid(row=5, column=0, sticky='W')
        self.notify_on_update = tk.BooleanVar(value=self.settings.get('features', {}).get('notify_on_update', True))
        ttk.Checkbutton(features_frame, variable=self.notify_on_update).grid(row=5, column=1, sticky='W')
        HoverInfoWidget(features_frame, "Notify the user when an update occurs.", row=5, column=2)

        ttk.Label(features_frame, text="Open Anki Edit:").grid(row=6, column=0, sticky='W')
        self.open_anki_edit = tk.BooleanVar(value=self.settings.get('features', {}).get('open_anki_edit', False))
        ttk.Checkbutton(features_frame, variable=self.open_anki_edit).grid(row=6, column=1, sticky='W')
        HoverInfoWidget(features_frame, "Automatically open Anki for editing after updating.", row=6, column=2)

        ttk.Label(features_frame, text="Backfill Audio:").grid(row=7, column=0, sticky='W')
        self.backfill_audio = tk.BooleanVar(value=self.settings.get('features', {}).get('backfill_audio', False))
        ttk.Checkbutton(features_frame, variable=self.backfill_audio).grid(row=7, column=1, sticky='W')
        HoverInfoWidget(features_frame, "Fill in audio data for existing entries.", row=7, column=2)

        ttk.Label(features_frame, text="Full Auto Mode:").grid(row=8, column=0, sticky='W')
        self.full_auto = tk.BooleanVar(
            value=self.settings.get('features', {}).get('full_auto', True))
        ttk.Checkbutton(features_frame, variable=self.full_auto).grid(row=8, column=1, sticky='W')
        HoverInfoWidget(features_frame, "Yomitan 1-click anki card creation.", row=8, column=2)

    def create_screenshot_tab(self):
        screenshot_frame = ttk.Frame(self.notebook)
        self.notebook.add(screenshot_frame, text='Screenshot')

        ttk.Label(screenshot_frame, text="Width:").grid(row=0, column=0, sticky='W')
        self.screenshot_width = ttk.Entry(screenshot_frame)
        self.screenshot_width.insert(0, self.settings.get('screenshot', {}).get('width', 1280))
        self.screenshot_width.grid(row=0, column=1)
        HoverInfoWidget(screenshot_frame, "Width of the screenshot in pixels.", row=0, column=2)

        ttk.Label(screenshot_frame, text="Height:").grid(row=1, column=0, sticky='W')
        self.screenshot_height = ttk.Entry(screenshot_frame)
        self.screenshot_height.insert(0, self.settings.get('screenshot', {}).get('height', 0))
        self.screenshot_height.grid(row=1, column=1)
        HoverInfoWidget(screenshot_frame, "Height of the screenshot in pixels.", row=1, column=2)

        ttk.Label(screenshot_frame, text="Quality:").grid(row=2, column=0, sticky='W')
        self.screenshot_quality = ttk.Entry(screenshot_frame)
        self.screenshot_quality.insert(0, self.settings.get('screenshot', {}).get('quality', 85))
        self.screenshot_quality.grid(row=2, column=1)
        HoverInfoWidget(screenshot_frame, "Quality of the screenshot (0-100).", row=2, column=2)

        ttk.Label(screenshot_frame, text="Extension:").grid(row=3, column=0, sticky='W')
        self.screenshot_extension = ttk.Combobox(screenshot_frame, values=['webp', 'avif', 'png', 'jpeg'])
        self.screenshot_extension.insert(0, self.settings.get('screenshot', {}).get('extension', 'webp'))
        self.screenshot_extension.grid(row=3, column=1)
        HoverInfoWidget(screenshot_frame, "File extension for the screenshot format.", row=3, column=2)

        ttk.Label(screenshot_frame, text="FFmpeg Reencode Options:").grid(row=4, column=0, sticky='W')
        self.screenshot_custom_ffmpeg_settings = ttk.Entry(screenshot_frame, width=50)
        self.screenshot_custom_ffmpeg_settings.insert(0, self.settings.get('screenshot', {}).get('custom_ffmpeg_settings', ''))
        self.screenshot_custom_ffmpeg_settings.grid(row=4, column=1)
        HoverInfoWidget(screenshot_frame, "Custom FFmpeg options for re-encoding screenshots.", row=4, column=2)

    def create_audio_tab(self):
        audio_frame = ttk.Frame(self.notebook)
        self.notebook.add(audio_frame, text='Audio')

        ttk.Label(audio_frame, text="Audio Extension:").grid(row=0, column=0, sticky='W')
        self.audio_extension = ttk.Combobox(audio_frame, values=['opus', 'mp3','ogg', 'aac', 'm4a'])
        self.audio_extension.insert(0, self.settings.get('audio', {}).get('extension', 'opus'))
        self.audio_extension.grid(row=0, column=1)
        HoverInfoWidget(audio_frame, "File extension for audio files.", row=0, column=2)

        ttk.Label(audio_frame, text="Beginning Offset:").grid(row=1, column=0, sticky='W')
        self.beginning_offset = ttk.Entry(audio_frame)
        self.beginning_offset.insert(0, self.settings.get('audio', {}).get('beginning_offset', 0.0))
        self.beginning_offset.grid(row=1, column=1)
        HoverInfoWidget(audio_frame, "Offset in seconds to start audio processing.", row=1, column=2)

        ttk.Label(audio_frame, text="End Offset:").grid(row=2, column=0, sticky='W')
        self.end_offset = ttk.Entry(audio_frame)
        self.end_offset.insert(0, self.settings.get('audio', {}).get('end_offset', 0.5))
        self.end_offset.grid(row=2, column=1)
        HoverInfoWidget(audio_frame, "Offset in seconds to end audio processing.", row=2, column=2)

        ttk.Label(audio_frame, text="FFmpeg Reencode Options:").grid(row=3, column=0, sticky='W')
        self.ffmpeg_reencode_options = ttk.Entry(audio_frame, width=50)
        self.ffmpeg_reencode_options.insert(0, self.settings.get('audio', {}).get('ffmpeg_reencode_options', ''))
        self.ffmpeg_reencode_options.grid(row=3, column=1)
        HoverInfoWidget(audio_frame, "Custom FFmpeg options for re-encoding audio files.", row=3, column=2)

    def create_obs_tab(self):
        obs_frame = ttk.Frame(self.notebook)
        self.notebook.add(obs_frame, text='OBS')

        ttk.Label(obs_frame, text="Enabled:").grid(row=0, column=0, sticky='W')
        self.obs_enabled = tk.BooleanVar(value=self.settings.get('obs', {}).get('enabled', True))
        ttk.Checkbutton(obs_frame, variable=self.obs_enabled).grid(row=0, column=1, sticky='W')
        HoverInfoWidget(obs_frame, "Enable or disable OBS integration.", row=0, column=2)

        ttk.Label(obs_frame, text="Host:").grid(row=1, column=0, sticky='W')
        self.obs_host = ttk.Entry(obs_frame)
        self.obs_host.insert(0, self.settings.get('obs', {}).get('host', '127.0.0.1'))
        self.obs_host.grid(row=1, column=1)
        HoverInfoWidget(obs_frame, "Host address for the OBS WebSocket server.", row=1, column=2)

        ttk.Label(obs_frame, text="Port:").grid(row=2, column=0, sticky='W')
        self.obs_port = ttk.Entry(obs_frame)
        self.obs_port.insert(0, self.settings.get('obs', {}).get('port', 4455))
        self.obs_port.grid(row=2, column=1)
        HoverInfoWidget(obs_frame, "Port number for the OBS WebSocket server.", row=2, column=2)

        ttk.Label(obs_frame, text="Password:").grid(row=3, column=0, sticky='W')
        self.obs_password = ttk.Entry(obs_frame, show='*')
        self.obs_password.insert(0, self.settings.get('obs', {}).get('password', 'your_password'))
        self.obs_password.grid(row=3, column=1)
        HoverInfoWidget(obs_frame, "Password for the OBS WebSocket server.", row=3, column=2)

    def create_websocket_tab(self):
        websocket_frame = ttk.Frame(self.notebook)
        self.notebook.add(websocket_frame, text='WebSocket')

        ttk.Label(websocket_frame, text="Enabled:").grid(row=0, column=0, sticky='W')
        self.websocket_enabled = tk.BooleanVar(value=self.settings.get('websocket', {}).get('enabled', True))
        ttk.Checkbutton(websocket_frame, variable=self.websocket_enabled).grid(row=0, column=1, sticky='W')
        HoverInfoWidget(websocket_frame, "Enable or disable WebSocket communication.", row=0, column=2)

        ttk.Label(websocket_frame, text="URI:").grid(row=1, column=0, sticky='W')
        self.websocket_uri = ttk.Entry(websocket_frame)
        self.websocket_uri.insert(0, self.settings.get('websocket', {}).get('uri', 'localhost:6677'))
        self.websocket_uri.grid(row=1, column=1)
        HoverInfoWidget(websocket_frame, "WebSocket URI for connecting.", row=1, column=2)

    def create_hotkeys_tab(self):
        hotkeys_frame = ttk.Frame(self.notebook)
        self.notebook.add(hotkeys_frame, text='Hotkeys')

        ttk.Label(hotkeys_frame, text="Reset Offset Hotkey:").grid(row=0, column=0, sticky='W')
        self.reset_offset_hotkey = ttk.Entry(hotkeys_frame)
        self.reset_offset_hotkey.insert(0, self.settings.get('hotkeys', {}).get('reset_hotkey', 'f4'))
        self.reset_offset_hotkey.grid(row=0, column=1)
        HoverInfoWidget(hotkeys_frame, "Hotkey to reset the audio offset.", row=0, column=2)

        ttk.Label(hotkeys_frame, text="Reset Line Hotkey:").grid(row=1, column=0, sticky='W')
        self.reset_line_hotkey = ttk.Entry(hotkeys_frame)
        self.reset_line_hotkey.insert(0, self.settings.get('hotkeys', {}).get('reset_line', 'f5'))
        self.reset_line_hotkey.grid(row=1, column=1)
        HoverInfoWidget(hotkeys_frame, "Hotkey to reset the current line of dialogue.", row=1, column=2)

        ttk.Label(hotkeys_frame, text="Take Screenshot Hotkey:").grid(row=2, column=0, sticky='W')
        self.take_screenshot_hotkey = ttk.Entry(hotkeys_frame)
        self.take_screenshot_hotkey.insert(0, self.settings.get('hotkeys', {}).get('take_screenshot', 'f6'))
        self.take_screenshot_hotkey.grid(row=2, column=1)
        HoverInfoWidget(hotkeys_frame, "Hotkey to take a screenshot.", row=2, column=2)


if __name__ == '__main__':
    root = ttk.Window()
    app = ConfigApp(root)
    root.mainloop()
