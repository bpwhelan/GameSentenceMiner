import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from os.path import expanduser
from typing import List, Dict

import toml
from dataclasses_json import dataclass_json

OFF = 'OFF'
VOSK = 'VOSK'
SILERO = 'SILERO'
WHISPER = 'WHISPER'

VOSK_BASE = 'BASE'
VOSK_SMALL = 'SMALL'

WHISPER_TINY = 'tiny'
WHISPER_BASE = 'base'
WHISPER_SMALL = 'small'
WHISPER_MEDIUM = 'medium'
WHSIPER_LARGE = 'large'

INFO = 'INFO'
DEBUG = 'DEBUG'


@dataclass_json
@dataclass
class General:
    use_websocket: bool = True
    websocket_uri: str = 'localhost:6677'
    open_config_on_startup: bool = False


@dataclass_json
@dataclass
class Paths:
    folder_to_watch: str = expanduser("~/Videos/OBS")
    audio_destination: str = expanduser("~/Videos/OBS/Audio/")
    screenshot_destination: str = expanduser("~/Videos/OBS/SS/")
    remove_video: bool = True
    remove_audio: bool = False
    remove_screenshot: bool = False


@dataclass_json
@dataclass
class Anki:
    update_anki: bool = True
    url: str = 'http://127.0.0.1:8765'
    sentence_field: str = "Sentence"
    sentence_audio_field: str = "SentenceAudio"
    picture_field: str = "Picture"
    word_field: str = 'Word'
    previous_sentence_field: str = ''
    custom_tags: List[str] = None  # Initialize to None and set it in __post_init__
    tags_to_check: List[str] = None
    add_game_tag: bool = True
    polling_rate: int = 200
    overwrite_audio: bool = False
    overwrite_picture: bool = True
    anki_custom_fields: Dict[str, str] = None  # Initialize to None and set it in __post_init__

    def __post_init__(self):
        if self.custom_tags is None:
            self.custom_tags = []
        if self.anki_custom_fields is None:
            self.anki_custom_fields = {}
        if self.tags_to_check is None:
            self.tags_to_check = []


@dataclass_json
@dataclass
class Features:
    full_auto: bool = True
    notify_on_update: bool = True
    open_anki_edit: bool = False
    backfill_audio: bool = False


@dataclass_json
@dataclass
class Screenshot:
    width: str = 0
    height: str = 0
    quality: str = 85
    extension: str = "webp"
    custom_ffmpeg_settings: str = ''


@dataclass_json
@dataclass
class Audio:
    extension: str = 'opus'
    beginning_offset: float = 0.0
    end_offset: float = 0.5
    ffmpeg_reencode_options: str = ''


@dataclass_json
@dataclass
class OBS:
    enabled: bool = True
    host: str = "localhost"
    port: int = 4455
    password: str = "your_password"
    start_buffer: bool = True
    get_game_from_scene: bool = True


@dataclass_json
@dataclass
class Hotkeys:
    reset_line: str = 'f5'
    take_screenshot: str = 'f6'


@dataclass_json
@dataclass
class VAD:
    whisper_model: str = WHISPER_BASE
    do_vad_postprocessing: bool = True
    vosk_url: str = VOSK_BASE
    selected_vad_model: str = SILERO
    backup_vad_model: str = OFF
    trim_beginning: bool = False


@dataclass_json
@dataclass
class Config:
    general: General = field(default_factory=General)
    paths: Paths = field(default_factory=Paths)
    anki: Anki = field(default_factory=Anki)
    features: Features = field(default_factory=Features)
    screenshot: Screenshot = field(default_factory=Screenshot)
    audio: Audio = field(default_factory=Audio)
    obs: OBS = field(default_factory=OBS)
    hotkeys: Hotkeys = field(default_factory=Hotkeys)
    vad: VAD = field(default_factory=VAD)

    def load_from_toml(self, file_path: str):
        # Load the TOML configuration
        with open(file_path, 'r') as f:
            config_data = toml.load(f)

        self.paths.folder_to_watch = expanduser(config_data['paths'].get('folder_to_watch', self.paths.folder_to_watch))
        self.paths.audio_destination = expanduser(
            config_data['paths'].get('audio_destination', self.paths.audio_destination))
        self.paths.screenshot_destination = expanduser(config_data['paths'].get('screenshot_destination',
                                                                                self.paths.screenshot_destination))

        self.anki.url = config_data['anki'].get('url', self.anki.url)
        self.anki.sentence_field = config_data['anki'].get('sentence_field', self.anki.sentence_field)
        self.anki.sentence_audio_field = config_data['anki'].get('sentence_audio_field', self.anki.sentence_audio_field)
        self.anki.word_field = config_data['anki'].get('word_field', self.anki.word_field)
        self.anki.picture_field = config_data['anki'].get('picture_field', self.anki.picture_field)
        self.anki.custom_tags = config_data['anki'].get('custom_tags', self.anki.custom_tags)
        self.anki.add_game_tag = config_data['anki'].get('add_game_tag', self.anki.add_game_tag)
        self.anki.polling_rate = config_data['anki'].get('polling_rate', self.anki.polling_rate)
        self.anki.overwrite_audio = config_data['anki_overwrites'].get('overwrite_audio', self.anki.overwrite_audio)
        self.anki.overwrite_picture = config_data['anki_overwrites'].get('overwrite_picture',
                                                                         self.anki.overwrite_picture)

        self.features.full_auto = config_data['features'].get('do_vosk_postprocessing', self.features.full_auto)
        self.features.notify_on_update = config_data['features'].get('notify_on_update', self.features.notify_on_update)
        self.features.open_anki_edit = config_data['features'].get('open_anki_edit', self.features.open_anki_edit)
        self.features.backfill_audio = config_data['features'].get('backfill_audio', self.features.backfill_audio)

        self.screenshot.width = config_data['screenshot'].get('width', self.screenshot.width)
        self.screenshot.height = config_data['screenshot'].get('height', self.screenshot.height)
        self.screenshot.quality = config_data['screenshot'].get('quality', self.screenshot.quality)
        self.screenshot.extension = config_data['screenshot'].get('extension', self.screenshot.extension)
        self.screenshot.custom_ffmpeg_settings = config_data['screenshot'].get('custom_ffmpeg_settings',
                                                                               self.screenshot.custom_ffmpeg_settings)

        self.audio.extension = config_data['audio'].get('extension', self.audio.extension)
        self.audio.beginning_offset = config_data['audio'].get('beginning_offset', self.audio.beginning_offset)
        self.audio.end_offset = config_data['audio'].get('end_offset', self.audio.end_offset)
        self.audio.ffmpeg_reencode_options = config_data['audio'].get('ffmpeg_reencode_options',
                                                                      self.audio.ffmpeg_reencode_options)

        # Load VAD configuration from TOML
        self.vad.whisper_model = config_data['vosk'].get('whisper_model', self.vad.whisper_model)
        self.vad.vosk_url = config_data['vosk'].get('url', self.vad.vosk_url)
        self.vad.do_vad_postprocessing = config_data['features'].get('do_vosk_postprocessing',
                                                                     self.vad.do_vad_postprocessing)
        self.vad.trim_beginning = config_data['audio'].get('vosk_trim_beginning', self.vad.trim_beginning)

        self.obs.enabled = config_data['obs'].get('enabled', self.obs.enabled)
        self.obs.host = config_data['obs'].get('host', self.obs.host)
        self.obs.port = config_data['obs'].get('port', self.obs.port)
        self.obs.password = config_data['obs'].get('password', self.obs.password)

        self.general.use_websocket = config_data['websocket'].get('enabled', self.general.use_websocket)
        self.general.websocket_uri = config_data['websocket'].get('uri', self.general.websocket_uri)

        self.hotkeys.reset_line = config_data['hotkeys'].get('reset_line', self.hotkeys.reset_line)
        self.hotkeys.take_screenshot = config_data['hotkeys'].get('take_screenshot', self.hotkeys.take_screenshot)

        self.anki.anki_custom_fields = config_data.get('anki_custom_fields', {})

        with open('get_config().json', 'w') as f:
            f.write(self.to_json(indent=4))
            print(
                'get_config().json successfully generated from previous settings. get_config().toml will no longer be used.')

        return self


logger = logging.getLogger("GameSentenceMiner")
logger.setLevel(logging.DEBUG)  # Set the base level to DEBUG so that all messages are captured

# Create console handler with level INFO
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)

# Create rotating file handler with level DEBUG
file_handler = RotatingFileHandler("gamesentenceminer.log", maxBytes=10_000_000, backupCount=2, encoding='utf-8')
file_handler.setLevel(logging.DEBUG)

# Create a formatter
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# Add formatter to handlers
console_handler.setFormatter(formatter)
file_handler.setFormatter(formatter)

# Add handlers to the logger
logger.addHandler(console_handler)
logger.addHandler(file_handler)

CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'get_config().json')
temp_directory = ''
current_game = ''


def load_config():
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


config_instance: Config = None


def get_config():
    global config_instance
    if config_instance is None:
        config_instance = load_config()

        if config_instance.features.backfill_audio and config_instance.features.full_auto:
            print("Cannot have backfill_audio and obs_full_auto_mode turned on at the same time!")
            exit(1)

    return config_instance


def reload_config():
    global config_instance
    config_instance = load_config()

    if config_instance.features.backfill_audio and config_instance.features.full_auto:
        print("Cannot have backfill_audio and obs_full_auto_mode turned on at the same time!")
        exit(1)


class ConfigWatcher:
    def __init__(self, file_path, poll_interval=.25):
        self.file_path = file_path
        self.poll_interval = poll_interval
        self.last_modified_time = None
        self.keep_running = True

    def watch(self):
        """Polls the file for changes in a loop, running in its own thread."""
        self.last_modified_time = os.path.getmtime(self.file_path)

        while self.keep_running:
            time.sleep(self.poll_interval)
            current_modified_time = os.path.getmtime(self.file_path)

            if current_modified_time != self.last_modified_time:
                self.last_modified_time = current_modified_time
                self.on_modified()

    def on_modified(self):
        logger.info(f"Reloading Config!")
        reload_config()


def watch_for_config_changes():
    config_file = "config.json"  # Replace with your actual config file path
    watcher = ConfigWatcher(config_file, poll_interval=.25)

    # Run the file watcher in a separate thread
    watcher_thread = threading.Thread(target=watcher.watch, daemon=True)
    watcher_thread.start()
