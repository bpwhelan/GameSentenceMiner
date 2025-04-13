import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from os.path import expanduser
from sys import platform
from typing import List, Dict
import sys

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

AI_GEMINI = 'gemini'

INFO = 'INFO'
DEBUG = 'DEBUG'

DEFAULT_CONFIG = 'Default'

current_game = ''


@dataclass_json
@dataclass
class General:
    use_websocket: bool = True
    use_clipboard: bool = True
    websocket_uri: str = 'localhost:6677'
    open_config_on_startup: bool = False
    open_multimine_on_startup: bool = False
    texthook_replacement_regex: str = ""


@dataclass_json
@dataclass
class Paths:
    folder_to_watch: str = expanduser("~/Videos/GSM")
    audio_destination: str = expanduser("~/Videos/GSM/Audio/")
    screenshot_destination: str = expanduser("~/Videos/GSM/SS/")
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
    word_field: str = 'Expression'
    previous_sentence_field: str = ''
    previous_image_field: str = ''
    custom_tags: List[str] = None  # Initialize to None and set it in __post_init__
    tags_to_check: List[str] = None
    add_game_tag: bool = True
    polling_rate: int = 200
    overwrite_audio: bool = False
    overwrite_picture: bool = True
    multi_overwrites_sentence: bool = True
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
    enabled: bool = True
    width: str = 0
    height: str = 0
    quality: str = 85
    extension: str = "webp"
    custom_ffmpeg_settings: str = ''
    screenshot_hotkey_updates_anki: bool = False
    seconds_after_line: float = 1.0
    use_beginning_of_line_as_screenshot: bool = True
    use_new_screenshot_logic: bool = False


@dataclass_json
@dataclass
class Audio:
    enabled: bool = True
    extension: str = 'opus'
    beginning_offset: float = 0.0
    end_offset: float = 0.5
    ffmpeg_reencode_options: str = ''
    external_tool: str = ""
    anki_media_collection: str = ""
    external_tool_enabled: bool = True


@dataclass_json
@dataclass
class OBS:
    enabled: bool = True
    open_obs: bool = True
    close_obs: bool = True
    host: str = "localhost"
    port: int = 4455
    password: str = "your_password"
    get_game_from_scene: bool = True
    minimum_replay_size: int = 0


@dataclass_json
@dataclass
class Hotkeys:
    reset_line: str = 'f5'
    take_screenshot: str = 'f6'
    open_utility: str = 'ctrl+m'
    play_latest_audio: str = 'f7'


@dataclass_json
@dataclass
class VAD:
    whisper_model: str = WHISPER_BASE
    do_vad_postprocessing: bool = True
    vosk_url: str = VOSK_BASE
    selected_vad_model: str = SILERO
    backup_vad_model: str = OFF
    trim_beginning: bool = False
    beginning_offset: float = -0.25
    add_audio_on_no_results: bool = False

    def is_silero(self):
        return self.selected_vad_model == SILERO or self.backup_vad_model == SILERO

    def is_whisper(self):
        return self.selected_vad_model == WHISPER or self.backup_vad_model == WHISPER

    def is_vosk(self):
        return self.selected_vad_model == VOSK or self.backup_vad_model == VOSK


@dataclass_json
@dataclass
class Advanced:
    audio_player_path: str = ''
    video_player_path: str = ''
    show_screenshot_buttons: bool = False
    multi_line_line_break: str = '<br>'
    multi_line_sentence_storage_field: str = ''

@dataclass_json
@dataclass
class Ai:
    enabled: bool = False
    anki_field: str = ''
    provider: str = AI_GEMINI
    api_key: str = ''
    use_canned_translation_prompt: bool = True
    use_canned_context_prompt: bool = False
    custom_prompt: str = ''


@dataclass_json
@dataclass
class ProfileConfig:
    name: str = 'Default'
    general: General = field(default_factory=General)
    paths: Paths = field(default_factory=Paths)
    anki: Anki = field(default_factory=Anki)
    features: Features = field(default_factory=Features)
    screenshot: Screenshot = field(default_factory=Screenshot)
    audio: Audio = field(default_factory=Audio)
    obs: OBS = field(default_factory=OBS)
    hotkeys: Hotkeys = field(default_factory=Hotkeys)
    vad: VAD = field(default_factory=VAD)
    advanced: Advanced = field(default_factory=Advanced)
    ai: Ai = field(default_factory=Ai)


    # This is just for legacy support
    def load_from_toml(self, file_path: str):
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

        with open(get_config_path(), 'w') as f:
            f.write(self.to_json(indent=4))
            print(
                'config.json successfully generated from previous settings. config.toml will no longer be used.')

        return self

    def restart_required(self, previous):
        previous: ProfileConfig
        if any([previous.general.use_websocket != self.general.use_websocket,
                previous.general.use_clipboard != self.general.use_clipboard,
                previous.general.websocket_uri != self.general.websocket_uri,
                previous.paths.folder_to_watch != self.paths.folder_to_watch,
                previous.obs.open_obs != self.obs.open_obs,
                previous.obs.host != self.obs.host,
                previous.obs.port != self.obs.port
                ]):
            logger.info("Restart Required for Some Settings that were Changed")
            return True
        return False

    def config_changed(self, new: 'ProfileConfig') -> bool:
        return self != new


@dataclass_json
@dataclass
class Config:
    configs: Dict[str, ProfileConfig] = field(default_factory=dict)
    current_profile: str = DEFAULT_CONFIG

    @classmethod
    def new(cls):
        instance = cls(configs={DEFAULT_CONFIG: ProfileConfig()}, current_profile=DEFAULT_CONFIG)
        return instance

    def get_config(self) -> ProfileConfig:
        return self.configs[self.current_profile]

    def set_config_for_profile(self, profile: str, config: ProfileConfig):
        config.name = profile
        self.configs[profile] = config

    def has_config_for_current_game(self):
        return current_game in self.configs

    def get_all_profile_names(self):
        return list(self.configs.keys())

    def get_default_config(self):
        return self.configs[DEFAULT_CONFIG]

    def sync_shared_fields(self):
        config = self.get_config()
        for profile in self.configs.values():
            self.sync_shared_field(config.hotkeys, profile.hotkeys, "reset_line")
            self.sync_shared_field(config.hotkeys, profile.hotkeys, "take_screenshot")
            self.sync_shared_field(config.hotkeys, profile.hotkeys, "open_utility")
            self.sync_shared_field(config.hotkeys, profile.hotkeys, "play_latest_audio")
            self.sync_shared_field(config.anki, profile.anki, "url")
            self.sync_shared_field(config.anki, profile.anki, "sentence_field")
            self.sync_shared_field(config.anki, profile.anki, "sentence_audio_field")
            self.sync_shared_field(config.anki, profile.anki, "picture_field")
            self.sync_shared_field(config.anki, profile.anki, "word_field")
            self.sync_shared_field(config.anki, profile.anki, "previous_sentence_field")
            self.sync_shared_field(config.anki, profile.anki, "previous_image_field")
            self.sync_shared_field(config.anki, profile.anki, "tags_to_check")
            self.sync_shared_field(config.anki, profile.anki, "add_game_tag")
            self.sync_shared_field(config.anki, profile.anki, "polling_rate")
            self.sync_shared_field(config.anki, profile.anki, "overwrite_audio")
            self.sync_shared_field(config.anki, profile.anki, "overwrite_picture")
            self.sync_shared_field(config.anki, profile.anki, "multi_overwrites_sentence")
            self.sync_shared_field(config.anki, profile.anki, "anki_custom_fields")
            self.sync_shared_field(config.general, profile.general, "open_config_on_startup")
            self.sync_shared_field(config.general, profile.general, "open_multimine_on_startup")
            self.sync_shared_field(config.general, profile.general, "websocket_uri")
            self.sync_shared_field(config.audio, profile.audio, "external_tool")
            self.sync_shared_field(config.audio, profile.audio, "anki_media_collection")
            self.sync_shared_field(config, profile, "advanced")
            self.sync_shared_field(config, profile, "paths")
            self.sync_shared_field(config, profile, "obs")

        return self


    def sync_shared_field(self, config, config2, field_name):
        try:
            config_value = getattr(config, field_name, None)
            config2_value = getattr(config2, field_name, None)

            if config_value != config2_value:  # Check if values are different.
                if config_value is not None:
                    logging.info(f"Syncing shared field '{field_name}' to other profile.")
                    setattr(config2, field_name, config_value)
                elif config2_value is not None:
                    logging.info(f"Syncing shared field '{field_name}' to current profile.")
                    setattr(config, field_name, config2_value)
        except AttributeError as e:
            logging.error(f"AttributeError during sync of '{field_name}': {e}")
        except Exception as e:
            logging.error(f"An unexpected error occurred during sync of '{field_name}': {e}")


def get_default_anki_path():
    if platform == 'win32':  # Windows
        base_dir = os.getenv('APPDATA')
    else:  # macOS and Linux
        base_dir = '~/.local/share/'
    config_dir = os.path.join(base_dir, 'Anki2')
    return config_dir

def get_default_anki_media_collection_path():
    return os.path.join(get_default_anki_path(), 'User 1', 'collection.media')

def get_app_directory():
    if platform == 'win32':  # Windows
        appdata_dir = os.getenv('APPDATA')
    else:  # macOS and Linux
        appdata_dir = os.path.expanduser('~/.config')
    config_dir = os.path.join(appdata_dir, 'GameSentenceMiner')
    os.makedirs(config_dir, exist_ok=True)  # Create the directory if it doesn't exist
    return config_dir


def get_log_path():
    return os.path.join(get_app_directory(), 'gamesentenceminer.log')

temp_directory = ''

def get_temporary_directory():
    global temp_directory
    if not temp_directory:
        temp_directory = os.path.join(get_app_directory(), 'temp')
        os.makedirs(temp_directory, exist_ok=True)
        for filename in os.listdir(temp_directory):
            file_path = os.path.join(temp_directory, filename)
            try:
                if os.path.isfile(file_path) or os.path.islink(file_path):
                    os.unlink(file_path)
                elif os.path.isdir(file_path):
                    shutil.rmtree(file_path)
            except Exception as e:
                logger.error(f"Failed to delete {file_path}. Reason: {e}")
    return temp_directory

def get_config_path():
    return os.path.join(get_app_directory(), 'config.json')


def load_config():
    config_path = get_config_path()

    if os.path.exists('config.json') and not os.path.exists(config_path):
        shutil.copy('config.json', config_path)

    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as file:
                config_file = json.load(file)
                if "current_profile" in config_file:
                    return Config.from_dict(config_file)
                else:
                    print(f"Loading Profile-less Config, Converting to new Config!")
                    with open(config_path, 'r') as file:
                        config_file = json.load(file)

                    config = ProfileConfig.from_dict(config_file)
                    new_config = Config(configs = {DEFAULT_CONFIG : config}, current_profile=DEFAULT_CONFIG)

                    with open(config_path, 'w') as file:
                        json.dump(new_config.to_dict(), file, indent=4)
                    return new_config
        except json.JSONDecodeError as e:
            logger.error(f"Error parsing config.json: {e}")
            return None
    elif os.path.exists('config.toml'):
        config = ProfileConfig().load_from_toml('config.toml')
        new_config = Config({DEFAULT_CONFIG: config}, current_profile=DEFAULT_CONFIG)
        return new_config
    else:
        config = Config.new()
        with open(config_path, 'w') as file:
            json.dump(config.to_dict(), file, indent=4)
        return config


config_instance: Config = None


def get_config():
    global config_instance
    if config_instance is None:
        config_instance = load_config()
        config = config_instance.get_config()

        if config.features.backfill_audio and config.features.full_auto:
            logger.warning("Backfill audio is enabled, but full auto is also enabled. Disabling backfill...")
            config.features.backfill_audio = False

    # print(config_instance.get_config())
    return config_instance.get_config()


def reload_config():
    global config_instance
    config_instance = load_config()
    config = config_instance.get_config()

    if config.features.backfill_audio and config.features.full_auto:
        logger.warning("Backfill is enabled, but full auto is also enabled. Disabling backfill...")
        config.features.backfill_audio = False

def get_master_config():
    return config_instance

def save_full_config(config):
    with open(get_config_path(), 'w') as file:
        json.dump(config.to_dict(), file, indent=4)

def save_current_config(config):
    global config_instance
    config_instance.set_config_for_profile(config_instance.current_profile, config)
    save_full_config(config_instance)

def switch_profile_and_save(profile_name):
    global config_instance
    config_instance.current_profile = profile_name
    save_full_config(config_instance)
    return config_instance.get_config()


sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

logger = logging.getLogger("GameSentenceMiner")
logger.setLevel(logging.DEBUG)  # Set the base level to DEBUG so that all messages are captured

# Create console handler with level INFO
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.INFO)

# Create rotating file handler with level DEBUG
file_handler = RotatingFileHandler(get_log_path(), maxBytes=1024 * 1024, backupCount=5, encoding='utf-8')
file_handler.setLevel(logging.DEBUG)

# Create a formatter
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# Add formatter to handlers
console_handler.setFormatter(formatter)
file_handler.setFormatter(formatter)

# Add handlers to the logger
logger.addHandler(console_handler)
logger.addHandler(file_handler)
