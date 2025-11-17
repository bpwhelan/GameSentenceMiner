import dataclasses
import json
import logging
import os
import shutil
import threading
import inspect
import re

from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from os.path import expanduser
from sys import platform
import time
from typing import Any, List, Dict
import sys
from enum import Enum

import toml
from dataclasses_json import dataclass_json

from importlib import metadata


OFF = 'OFF'
# VOSK = 'VOSK'
SILERO = 'SILERO'
WHISPER = 'WHISPER'
# GROQ = 'GROQ'

# VOSK_BASE = 'BASE'
# VOSK_SMALL = 'SMALL'

WHISPER_TINY = 'tiny'
WHISPER_BASE = 'base'
WHISPER_SMALL = 'small'
WHISPER_MEDIUM = 'medium'
WHISPER_LARGE = 'large'
WHISPER_TURBO = 'turbo'

AI_GEMINI = 'Gemini'
AI_GROQ = 'Groq'
AI_OPENAI = 'OpenAI'

INFO = 'INFO'
DEBUG = 'DEBUG'

DEFAULT_CONFIG = 'Default'

current_game = ''

supported_formats = {
    'opus': 'libopus',
    'mp3': 'libmp3lame',
    'ogg': 'libvorbis',
    'aac': 'aac',
    'm4a': 'aac',
}

KNOWN_ASPECT_RATIOS = [
    # --- Classic / Legacy ---
    {"name": "4:3 (SD / Retro Games)", "ratio": 4 / 3},
    {"name": "5:4 (Old PC Monitors)", "ratio": 5 / 4},
    {"name": "3:2 (Handheld / GBA / DS / DSLR)", "ratio": 3 / 2},

    # --- Modern Displays ---
    {"name": "16:10 (PC Widescreen)", "ratio": 16 / 10},
    {"name": "16:9 (Standard HD / 1080p / 4K)", "ratio": 16 / 9},
    {"name": "18:9 (Mobile / Some Modern Laptops)", "ratio": 18 / 9},
    {"name": "19.5:9 (Modern Smartphones)", "ratio": 19.5 / 9},
    {"name": "21:9 (UltraWide)", "ratio": 21 / 9},
    {"name": "24:10 (UltraWide+)", "ratio": 24 / 10},
    {"name": "32:9 (Super UltraWide)", "ratio": 32 / 9},

    # --- Vertical / Mobile ---
    {"name": "9:16 (Portrait Mode)", "ratio": 9 / 16},
    {"name": "3:4 (Portrait 4:3)", "ratio": 3 / 4},
    {"name": "1:1 (Square / UI Capture)", "ratio": 1 / 1},
]

KNOWN_ASPECT_RATIOS_DICT = {item["name"]: item["ratio"] for item in KNOWN_ASPECT_RATIOS}

def is_linux():
    return platform == 'linux'


def is_windows():
    return platform == 'win32'

def is_mac():
    return platform == 'darwin'


class Locale(Enum):
    English = 'en_us'
    日本語 = 'ja_jp'
    # 한국어 = 'ko_kr'
    中文 = 'zh_cn'
    Español = 'es_es'
    # Français = 'fr_fr'
    # Deutsch = 'de_de'
    # Italiano = 'it_it'
    # Русский = 'ru_ru'

    @classmethod
    def from_any(cls, value: str) -> 'Locale':
        """
        Lookup Locale by either enum name (e.g. 'English') or value (e.g. 'en_us').
        Case-insensitive.
        """
        value_lower = value.lower()
        for locale in cls:
            if locale.name.lower() == value_lower or locale.value.lower() == value_lower:
                return locale
        raise KeyError(f"Locale '{value}' not found.")

    def __getitem__(cls, item):
        try:
            return cls.from_any(item)
        except KeyError:
            raise


# Patch Enum's __getitem__ for this class
Locale.__getitem__ = classmethod(Locale.__getitem__)


class Language(Enum):
    JAPANESE = "ja"
    ENGLISH = "en"
    KOREAN = "ko"
    CHINESE = "zh"
    SPANISH = "es"
    FRENCH = "fr"
    GERMAN = "de"
    ITALIAN = "it"
    RUSSIAN = "ru"
    PORTUGUESE = "pt"
    HINDI = "hi"
    ARABIC = "ar"
    TURKISH = "tr"
    DUTCH = "nl"
    SWEDISH = "sv"
    FINNISH = "fi"
    DANISH = "da"
    NORWEGIAN = "no"


AVAILABLE_LANGUAGES = [lang.value for lang in Language]
AVAILABLE_LANGUAGES_DICT = {lang.value: lang for lang in Language}


class CommonLanguages(str, Enum):
    """
    An Enum of the world's most common languages, based on total speaker count.

    The enum member is the common English name (e.g., ENGLISH) and its
    value is the ISO 639-1 two-letter code (e.g., 'en').

    Inheriting from `str` allows for direct comparison and use in functions
    that expect a string, e.g., `CommonLanguages.FRENCH == 'fr'`.

    This list is curated from Wikipedia's "List of languages by total number of speakers"
    and contains over 200 entries to provide broad but practical coverage.
    """
    ENGLISH = 'en'
    AFRIKAANS = 'af'
    AKAN = 'ak'
    ALBANIAN = 'sq'
    ALGERIAN_SPOKEN_ARABIC = 'arq'
    AMHARIC = 'am'
    ARMENIAN = 'hy'
    ASSAMESE = 'as'
    BAMBARA = 'bm'
    BASQUE = 'eu'
    BELARUSIAN = 'be'
    BENGALI = 'bn'
    BHOJPURI = 'bho'
    BOSNIAN = 'bs'
    BODO = 'brx'
    BULGARIAN = 'bg'
    BURMESE = 'my'
    CAPE_VERDEAN_CREOLE = 'kea'
    CATALAN = 'ca'
    CEBUANO = 'ceb'
    CHHATTISGARHI = 'hns'
    CHITTAGONIAN = 'ctg'
    CROATIAN = 'hr'
    CZECH = 'cs'
    DANISH = 'da'
    DECCAN = 'dcc'
    DOGRI = 'doi'
    DZONGKHA = 'dz'
    DUTCH = 'nl'
    EGYPTIAN_SPOKEN_ARABIC = 'arz'
    ESTONIAN = 'et'
    EWE = 'ee'
    FAROESE = 'fo'
    FIJIAN = 'fj'
    FINNISH = 'fi'
    FRENCH = 'fr'
    GALICIAN = 'gl'
    GAN_CHINESE = 'gan'
    GEORGIAN = 'ka'
    GERMAN = 'de'
    GREEK = 'el'
    GREENLANDIC = 'kl'
    GUJARATI = 'gu'
    HAITIAN_CREOLE = 'ht'
    HAUSA = 'ha'
    HAKKA_CHINESE = 'hak'
    HARYANVI = 'bgc'
    HEBREW = 'he'
    HINDI = 'hi'
    HUNGARIAN = 'hu'
    ICELANDIC = 'is'
    IGBO = 'ig'
    INDONESIAN = 'id'
    IRANIAN_PERSIAN = 'fa'
    IRISH = 'ga'
    ITALIAN = 'it'
    JAVANESE = 'jv'
    JAMAICAN_PATOIS = 'jam'
    JAPANESE = 'ja'
    KANNADA = 'kn'
    KASHMIRI = 'ks'
    KAZAKH = 'kk'
    KHMER = 'km'
    KONGO = 'kg'
    KONKANI = 'kok'
    KOREAN = 'ko'
    KURDISH = 'kmr'
    LAO = 'lo'
    LATVIAN = 'lv'
    LINGALA = 'ln'
    LITHUANIAN = 'lt'
    LUBA_KASAI = 'lua'
    LUXEMBOURGISH = 'lb'
    MACEDONIAN = 'mk'
    MADURESE = 'mad'
    MAGAHI = 'mag'
    MAITHILI = 'mai'
    MALAGASY = 'mg'
    MALAYALAM = 'ml'
    MALTESE = 'mt'
    MANDARIN_CHINESE = 'zh'
    MANIPURI = 'mni'
    MARATHI = 'mr'
    MAORI = 'mi'
    MAURITIAN_CREOLE = 'mfe'
    MIN_NAN_CHINESE = 'nan'
    MINANGKABAU = 'min'
    MONGOLIAN = 'mn'
    MONTENEGRIN = 'cnr'
    MOROCCAN_SPOKEN_ARABIC = 'ary'
    NDEBELE = 'nr'
    NEPALI = 'ne'
    NIGERIAN_PIDGIN = 'pcm'
    NORTHERN_KURDISH = 'kmr'
    NORTHERN_PASHTO = 'pbu'
    NORTHERN_UZBEK = 'uz'
    NORWEGIAN = 'no'
    ODIA = 'or'
    PAPIAMENTO = 'pap'
    POLISH = 'pl'
    PORTUGUESE = 'pt'
    ROMANIAN = 'ro'
    RWANDA = 'rw'
    RUSSIAN = 'ru'
    SAMOAN = 'sm'
    SANTALI = 'sat'
    SARAIKI = 'skr'
    SCOTTISH_GAELIC = 'gd'
    SEYCHELLOIS_CREOLE = 'crs'
    SERBIAN = 'sr'
    SHONA = 'sn'
    SINDHI = 'sd'
    SINHALA = 'si'
    SLOVAK = 'sk'
    SLOVENIAN = 'sl'
    SOMALI = 'so'
    SOTHO = 'st'
    SOUTH_AZERBAIJANI = 'azb'
    SOUTHERN_PASHTO = 'ps'
    SPANISH = 'es'
    STANDARD_ARABIC = 'ar'
    SUDANESE_SPOKEN_ARABIC = 'apd'
    SUNDANESE = 'su'
    SWAHILI = 'sw'
    SWATI = 'ss'
    SWEDISH = 'sv'
    SYLHETI = 'syl'
    TAGALOG = 'tl'
    TAMIL = 'ta'
    TELUGU = 'te'
    THAI = 'th'
    TIGRINYA = 'ti'
    TIBETAN = 'bo'
    TONGAN = 'to'
    TSONGA = 'ts'
    TSWANA = 'tn'
    TWI = 'twi'
    UKRAINIAN = 'uk'
    URDU = 'ur'
    UYGHUR = 'ug'
    VENDA = 've'
    VIETNAMESE = 'vi'
    WELSH = 'cy'
    WESTERN_PUNJABI = 'pnb'
    WOLOF = 'wo'
    WU_CHINESE = 'wuu'
    XHOSA = 'xh'
    YORUBA = 'yo'
    YUE_CHINESE = 'yue'
    ZULU = 'zu'

    # Helper methods

    @classmethod
    def get_all_codes(cls) -> list[str]:
        """Returns a list of all language codes (e.g., ['en', 'zh', 'hi'])."""
        return [lang.value for lang in cls]

    @classmethod
    def get_all_names(cls) -> list[str]:
        """Returns a list of all language names (e.g., ['ENGLISH', 'MANDARIN_CHINESE'])."""
        return [lang.name for lang in cls]

    @classmethod
    def get_all_names_pretty(cls) -> list[str]:
        """Returns a list of all language names formatted for display (e.g., ['English', 'Mandarin Chinese'])."""
        return [lang.name.replace('_', ' ').title() for lang in cls]

    @classmethod
    def get_choices(cls) -> list[tuple[str, str]]:
        """
        Returns a list of (value, label) tuples for use in web framework
        choice fields (e.g., Django, Flask).

        Example: [('en', 'English'), ('zh', 'Mandarin Chinese')]
        """
        return [(lang.value, lang.name.replace('_', ' ').title()) for lang in cls]

    # Method to lookup language by it's name
    @classmethod
    def from_name(cls, name: str) -> 'CommonLanguages':
        """
        Looks up a language by its name (e.g., 'ENGLISH') and returns the corresponding enum member.
        Raises ValueError if not found.
        """
        try:
            return cls[name.upper()]
        except KeyError:
            raise ValueError(f"Language '{name}' not found in CommonLanguages")

    # Method to lookup language by its code
    @classmethod
    def from_code(cls, code: str) -> 'CommonLanguages':
        """
        Looks up a language by its code (e.g., 'en') and returns the corresponding enum member.
        Raises ValueError if not found.
        """
        for lang in cls:
            if lang.value == code:
                return lang
        raise ValueError(
            f"Language code '{code}' not found in CommonLanguages")

    @classmethod
    def name_from_code(cls, code: str) -> str:
        """
        Returns the name of the language given its code (e.g., 'en' -> 'ENGLISH').
        Raises ValueError if not found.
        """
        return cls.from_code(code).name


PACKAGE_NAME = "GameSentenceMiner"


def get_current_version():
    try:
        version = metadata.version(PACKAGE_NAME)
        return version
    except metadata.PackageNotFoundError:
        return ""


def get_latest_version():
    try:
        import requests
        response = requests.get(f"https://pypi.org/pypi/{PACKAGE_NAME}/json")
        latest_version = response.json()["info"]["version"]
        return latest_version
    except Exception as e:
        logger.error(f"Error fetching latest version: {e}")
        return None


def check_for_updates(force=False):
    try:
        installed_version = get_current_version()
        latest_version = get_latest_version()

        if installed_version != latest_version or force:
            logger.info(
                f"Update available: {installed_version} -> {latest_version}")
            return True, latest_version
        else:
            logger.info("You are already using the latest version.")
            return False, latest_version
    except Exception as e:
        logger.error(f"Error checking for updates: {e}")


@dataclass_json
@dataclass
class General:
    use_websocket: bool = True
    use_clipboard: bool = True
    use_both_clipboard_and_websocket: bool = False
    merge_matching_sequential_text: bool = False
    websocket_uri: str = 'localhost:6677,localhost:9001,localhost:2333'
    open_config_on_startup: bool = False
    open_multimine_on_startup: bool = True
    texthook_replacement_regex: str = ""
    texthooker_port: int = 55000
    native_language: str = CommonLanguages.ENGLISH.value

    def get_native_language_name(self) -> str:
        try:
            return CommonLanguages.name_from_code(self.native_language)
        except ValueError:
            return "Unknown"

@dataclass_json
@dataclass
class Paths:
    folder_to_watch: str = expanduser("~/Videos/GSM")
    output_folder: str = expanduser("~/Videos/GSM/Output")
    copy_temp_files_to_output_folder: bool = False
    open_output_folder_on_card_creation: bool = False
    copy_trimmed_replay_to_output_folder: bool = False
    remove_video: bool = True
    remove_audio: bool = False
    remove_screenshot: bool = False

    def __post_init__(self):
        if self.folder_to_watch:
            self.folder_to_watch = os.path.normpath(self.folder_to_watch).replace("\\", "/")
            self.folder_to_watch = re.sub(r'/+', '/', self.folder_to_watch)
        if self.output_folder:
            self.output_folder = os.path.normpath(self.output_folder).replace("\\", "/")
            self.output_folder = re.sub(r'/+', '/', self.output_folder)


@dataclass_json
@dataclass
class Anki:
    update_anki: bool = True
    show_update_confirmation_dialog_v2: bool = True
    url: str = 'http://127.0.0.1:8765'
    sentence_field: str = "Sentence"
    sentence_audio_field: str = "SentenceAudio"
    picture_field: str = "Picture"
    word_field: str = 'Expression'
    previous_sentence_field: str = ''
    previous_image_field: str = ''
    video_field: str = ''
    # Initialize to None and set it in __post_init__
    custom_tags: List[str] = None
    tags_to_check: List[str] = None
    add_game_tag: bool = True
    game_name_field: str = ''
    polling_rate: int = 200
    overwrite_audio: bool = False
    overwrite_picture: bool = True
    multi_overwrites_sentence: bool = True
    parent_tag: str = "Game"

    def __post_init__(self):
        if self.custom_tags is None:
            self.custom_tags = ['GSM']
        if self.tags_to_check is None:
            self.tags_to_check = []


@dataclass_json
@dataclass
class Features:
    full_auto: bool = True
    notify_on_update: bool = True
    open_anki_edit: bool = False
    open_anki_in_browser: bool = True
    browser_query: str = ''
    generate_longplay: bool = False


@dataclass_json
@dataclass
class Screenshot:
    enabled: bool = True
    width: str = 0
    height: str = 0
    quality: str = 85
    extension: str = "webp"
    custom_ffmpeg_settings: str = ''
    custom_ffmpeg_option_selected: str = ''
    screenshot_hotkey_updates_anki: bool = False
    animated: bool = False
    seconds_after_line: float = 1.0
    use_beginning_of_line_as_screenshot: bool = True
    use_new_screenshot_logic: bool = False
    screenshot_timing_setting: str = 'beginning'  # 'middle', 'end'
    use_screenshot_selector: bool = False
    trim_black_bars_wip: bool = True

    def __post_init__(self):
        if not self.screenshot_timing_setting and self.use_beginning_of_line_as_screenshot:
            self.screenshot_timing_setting = 'beginning'
        if not self.screenshot_timing_setting and self.use_new_screenshot_logic:
            self.screenshot_timing_setting = 'middle'
        if not self.screenshot_timing_setting and not self.use_beginning_of_line_as_screenshot and not self.use_new_screenshot_logic:
            self.screenshot_timing_setting = 'end'
        if self.width and self.height == 0:
            self.height = -1
        if self.width == 0 and self.height:
            self.width = -1


@dataclass_json
@dataclass
class Audio:
    enabled: bool = True
    extension: str = 'opus'
    beginning_offset: float = -0.5
    end_offset: float = 0.5
    pre_vad_end_offset: float = 0.0
    ffmpeg_reencode_options: str = '-c:a {encoder} -f {format} -af \"afade=t=in:d=0.005\"' if is_windows() else ''
    ffmpeg_reencode_options_to_use: str = ''
    external_tool: str = ""
    anki_media_collection: str = ""
    external_tool_enabled: bool = True
    custom_encode_settings: str = ''

    def __post_init__(self):
        self.ffmpeg_reencode_options_to_use = self.ffmpeg_reencode_options.replace(
            "{format}", self.extension).replace("{encoder}", supported_formats.get(self.extension, ''))
        if not self.anki_media_collection:
            self.anki_media_collection = get_default_anki_media_collection_path()
        if self.anki_media_collection:
            self.anki_media_collection = os.path.normpath(
                self.anki_media_collection)
        if self.external_tool:
            self.external_tool = os.path.normpath(self.external_tool)


@dataclass_json
@dataclass
class OBS:
    open_obs: bool = True
    close_obs: bool = True
    automatically_manage_replay_buffer: bool = True
    host: str = "127.0.0.1"
    port: int = 7274
    password: str = "your_password"
    get_game_from_scene: bool = True
    minimum_replay_size: int = 0
    obs_path: str = ''

    def __post_init__(self):
        # Force get_game_from_scene to be True
        self.get_game_from_scene = True
        if not self.obs_path:
            if is_windows():
                self.obs_path = os.path.join(get_app_directory(), "obs-studio/bin/64bit/obs64.exe")
            elif is_linux():
                self.obs_path = "/usr/bin/obs"
            elif is_mac():
                self.obs_path = "/opt/homebrew/bin/obs"


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
    language: str = 'ja'
    # vosk_url: str = VOSK_BASE
    selected_vad_model: str = WHISPER
    backup_vad_model: str = OFF
    trim_beginning: bool = False
    beginning_offset: float = -0.25
    add_audio_on_no_results: bool = False
    use_tts_as_fallback: bool = False
    tts_url: str = 'http://127.0.0.1:5050/?term=$s'
    cut_and_splice_segments: bool = False
    splice_padding: float = 0.1
    use_cpu_for_inference: bool = False
    use_vad_filter_for_whisper: bool = True

    def __post_init__(self):
        if self.selected_vad_model == self.backup_vad_model:
            self.backup_vad_model = OFF

    def is_silero(self):
        return self.selected_vad_model == SILERO or self.backup_vad_model == SILERO

    def is_whisper(self):
        return self.selected_vad_model == WHISPER or self.backup_vad_model == WHISPER

    # def is_vosk(self):
    #     return self.selected_vad_model == VOSK or self.backup_vad_model == VOSK

    # def is_groq(self):
    #     return self.selected_vad_model == GROQ or self.backup_vad_model == GROQ


@dataclass_json
@dataclass
class Advanced:
    plaintext_websocket_port: int = -1
    audio_player_path: str = ''
    video_player_path: str = ''
    show_screenshot_buttons: bool = False
    multi_line_line_break: str = '<br>'
    multi_line_sentence_storage_field: str = ''
    ocr_websocket_port: int = 9002
    texthooker_communication_websocket_port: int = 55001
    afk_timer_seconds: int = 120 # LEGACY, not used anymore
    session_gap_seconds: int = 3600 # LEGACY, not used anymore
    streak_requirement_hours: float = 0.01 # LEGACY, not used anymore
    localhost_bind_address: str = '127.0.0.1' # Default 127.0.0.1 for security, set to 0.0.0.0 to allow external connections

    def __post_init__(self):
        if self.plaintext_websocket_port == -1:
            self.plaintext_websocket_port = self.texthooker_communication_websocket_port + 1


@dataclass_json
@dataclass
class Ai:
    enabled: bool = False
    add_to_anki: bool = False
    anki_field: str = ''
    provider: str = AI_GEMINI
    gemini_model: str = 'gemini-2.5-flash-lite'
    groq_model: str = 'meta-llama/llama-4-scout-17b-16e-instruct'
    gemini_api_key: str = ''
    api_key: str = ''  # Legacy support, will be moved to gemini_api_key if provider is gemini
    groq_api_key: str = ''
    open_ai_url: str = ''
    open_ai_model: str = ''
    open_ai_api_key: str = ''
    use_canned_translation_prompt: bool = True
    use_canned_context_prompt: bool = False
    custom_prompt: str = ''
    custom_texthooker_prompt: str = ''
    dialogue_context_length: int = 10

    def __post_init__(self):
        if not self.gemini_api_key:
            self.gemini_api_key = self.api_key
            if self.provider == 'gemini':
                self.provider = AI_GEMINI
            if self.provider == 'groq':
                self.provider = AI_GROQ
        if self.gemini_model in ['RECOMMENDED', 'OTHER']:
            self.gemini_model = 'gemini-2.5-flash-lite'
        if self.groq_model in ['RECOMMENDED', 'OTHER']:
            self.groq_model = 'meta-llama/llama-4-scout-17b-16e-instruct'
            
        if self.enabled:
            self.add_to_anki = True

        # Change Legacy Model Name
        if self.gemini_model == 'gemini-2.5-flash-lite-preview-06-17':
            self.gemini_model = 'gemini-2.5-flash-lite'
            
    def is_configured(self) -> bool:
        if self.provider == AI_GEMINI and self.gemini_api_key and self.gemini_model:
            return True
        if self.provider == AI_GROQ and self.groq_api_key and self.groq_model:
            return True
        if self.provider == AI_OPENAI and self.open_ai_api_key and self.open_ai_model and self.open_ai_url:
            return True
        return False


class OverlayEngine(str, Enum):
    LENS = 'lens'
    ONEOCR = 'oneocr'

@dataclass_json
@dataclass
class Overlay:
    websocket_port: int = 55499
    engine: str = OverlayEngine.LENS.value
    monitor_to_capture: int = 0
    periodic: bool = False
    periodic_interval: float = 1.0
    periodic_ratio: float = 0.9
    scan_delay: float = 0.25
    minimum_character_size: int = 0
    number_of_local_scans_per_event: int = 1

    def __post_init__(self):
        if self.monitor_to_capture == -1:
            self.monitor_to_capture = 0  # Default to the first monitor if not set
            
        try:
            import mss as mss
            monitors = [f"Monitor {i}: width: {monitor['width']}, height: {monitor['height']}" for i, monitor in enumerate(mss.mss().monitors[1:], start=1)]
            if len(monitors) == 0:
                monitors = [1]
            self.monitors = monitors
        except ImportError:
            self.monitors = []
        if self.monitor_to_capture >= len(self.monitors):
            self.monitor_to_capture = 0  # Reset to first monitor if out of range

@dataclass_json
@dataclass
class WIP:
    pass


@dataclass_json
@dataclass
class ProfileConfig:
    name: str = 'Default'
    scenes: List[str] = field(default_factory=list)
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
    overlay: Overlay = field(default_factory=Overlay)
    wip: WIP = field(default_factory=WIP)

    def get_field_value(self, section: str, field_name: str):
        section_obj = getattr(self, section, None)
        if section_obj and hasattr(section_obj, field_name):
            return getattr(section_obj, field_name)
        else:
            raise ValueError(
                f"Field '{field_name}' not found in section '{section}' of ProfileConfig.")

    # This is just for legacy support
    def load_from_toml(self, file_path: str):
        with open(file_path, 'r') as f:
            config_data = toml.load(f)

        self.paths.folder_to_watch = expanduser(config_data['paths'].get(
            'folder_to_watch', self.paths.folder_to_watch))

        self.anki.url = config_data['anki'].get('url', self.anki.url)
        self.anki.sentence_field = config_data['anki'].get(
            'sentence_field', self.anki.sentence_field)
        self.anki.sentence_audio_field = config_data['anki'].get(
            'sentence_audio_field', self.anki.sentence_audio_field)
        self.anki.word_field = config_data['anki'].get(
            'word_field', self.anki.word_field)
        self.anki.picture_field = config_data['anki'].get(
            'picture_field', self.anki.picture_field)
        self.anki.custom_tags = config_data['anki'].get(
            'custom_tags', self.anki.custom_tags)
        self.anki.add_game_tag = config_data['anki'].get(
            'add_game_tag', self.anki.add_game_tag)
        self.anki.polling_rate = config_data['anki'].get(
            'polling_rate', self.anki.polling_rate)
        self.anki.overwrite_audio = config_data['anki_overwrites'].get(
            'overwrite_audio', self.anki.overwrite_audio)
        self.anki.overwrite_picture = config_data['anki_overwrites'].get('overwrite_picture',
                                                                         self.anki.overwrite_picture)

        self.features.full_auto = config_data['features'].get(
            'do_vosk_postprocessing', self.features.full_auto)
        self.features.notify_on_update = config_data['features'].get(
            'notify_on_update', self.features.notify_on_update)
        self.features.open_anki_edit = config_data['features'].get(
            'open_anki_edit', self.features.open_anki_edit)
        
        self.screenshot.width = config_data['screenshot'].get(
            'width', self.screenshot.width)
        self.screenshot.height = config_data['screenshot'].get(
            'height', self.screenshot.height)
        self.screenshot.quality = config_data['screenshot'].get(
            'quality', self.screenshot.quality)
        self.screenshot.extension = config_data['screenshot'].get(
            'extension', self.screenshot.extension)
        self.screenshot.custom_ffmpeg_settings = config_data['screenshot'].get('custom_ffmpeg_settings',
                                                                               self.screenshot.custom_ffmpeg_settings)

        self.audio.extension = config_data['audio'].get(
            'extension', self.audio.extension)
        self.audio.beginning_offset = config_data['audio'].get(
            'beginning_offset', self.audio.beginning_offset)
        self.audio.end_offset = config_data['audio'].get(
            'end_offset', self.audio.end_offset)
        self.audio.ffmpeg_reencode_options = config_data['audio'].get('ffmpeg_reencode_options',
                                                                      self.audio.ffmpeg_reencode_options)

        self.vad.whisper_model = config_data['vosk'].get(
            'whisper_model', self.vad.whisper_model)
        self.vad.vosk_url = config_data['vosk'].get('url', self.vad.vosk_url)
        self.vad.do_vad_postprocessing = config_data['features'].get('do_vosk_postprocessing',
                                                                     self.vad.do_vad_postprocessing)
        self.vad.trim_beginning = config_data['audio'].get(
            'vosk_trim_beginning', self.vad.trim_beginning)

        self.obs.host = config_data['obs'].get('host', self.obs.host)
        self.obs.port = config_data['obs'].get('port', self.obs.port)
        self.obs.password = config_data['obs'].get(
            'password', self.obs.password)

        self.general.use_websocket = config_data['websocket'].get(
            'enabled', self.general.use_websocket)
        self.general.websocket_uri = config_data['websocket'].get(
            'uri', self.general.websocket_uri)

        self.hotkeys.reset_line = config_data['hotkeys'].get(
            'reset_line', self.hotkeys.reset_line)
        self.hotkeys.take_screenshot = config_data['hotkeys'].get(
            'take_screenshot', self.hotkeys.take_screenshot)

        with open(get_config_path(), 'w') as f:
            f.write(self.to_json(indent=4))
            logger.warning(
                'config.json successfully generated from previous settings. config.toml will no longer be used.')

        return self

    def restart_required(self, previous):
        previous: ProfileConfig
        if any([previous.paths.folder_to_watch != self.paths.folder_to_watch,
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
class StatsConfig:
    afk_timer_seconds: int = 120
    session_gap_seconds: int = 3600
    streak_requirement_hours: float = 0.01 # 1 second required per day to keep your streak by default
    reading_hours_target: int = 1500  # Target reading hours based on TMW N1 achievement data
    character_count_target: int = 25000000  # Target character count (25M) inspired by Discord server milestones
    games_target: int = 100  # Target VNs/games completed based on Refold community standards
    reading_hours_target_date: str = ""  # Target date for reading hours goal (ISO format: YYYY-MM-DD)
    character_count_target_date: str = ""  # Target date for character count goal (ISO format: YYYY-MM-DD)
    games_target_date: str = ""  # Target date for games/VNs goal (ISO format: YYYY-MM-DD)
    cards_mined_daily_target: int = 10  # Daily target for cards mined (default: 10 cards per day)

@dataclass_json
@dataclass
class Config:
    configs: Dict[str, ProfileConfig] = field(default_factory=dict)
    current_profile: str = DEFAULT_CONFIG
    switch_to_default_if_not_found: bool = True
    locale: str = Locale.English.value
    stats: StatsConfig = field(default_factory=StatsConfig)
    overlay: Overlay = field(default_factory=Overlay)
    version: str = ""

    @classmethod
    def new(cls):
        instance = cls(
            configs={DEFAULT_CONFIG: ProfileConfig()}, current_profile=DEFAULT_CONFIG)
        return instance

    def get_locale(self) -> Locale:
        try:
            return Locale.from_any(self.locale)
        except KeyError:
            logger.warning(
                f"Locale '{self.locale}' not found. Defaulting to English.")
            return Locale.English

    @classmethod
    def load(cls):
        config_path = get_config_path()
        if os.path.exists(config_path):
            with open(config_path, 'r') as file:
                data = json.load(file)
                return cls.from_dict(data)
        else:
            return cls.new()
        
    def __post_init__(self):
        # Move Stats to global config if found in profiles for legacy support
        default_stats = StatsConfig()
        for profile in self.configs.values():
            if profile.advanced:
                if profile.advanced.afk_timer_seconds != default_stats.afk_timer_seconds:
                    self.stats.afk_timer_seconds = profile.advanced.afk_timer_seconds
                if profile.advanced.session_gap_seconds != default_stats.session_gap_seconds:
                    self.stats.session_gap_seconds = profile.advanced.session_gap_seconds
                if profile.advanced.streak_requirement_hours != default_stats.streak_requirement_hours:
                    self.stats.streak_requirement_hours = profile.advanced.streak_requirement_hours
        
        self.overlay = self.get_config().overlay
        
        # Add a way to migrate certain things based on version if needed, also help with better defaults
        if self.version:
            current_version = get_current_version()
            if self.version != current_version:
                from packaging import version
                logger.info(f"New Config Found: {self.version} != {current_version}")
                # Handle version mismatch
                if version.parse(self.version) < version.parse("2.18.0"):
                    # Example, doesn't need to be done
                    for profile in self.configs.values():
                        profile.obs.get_game_from_scene = True
                        # Whisper basically uses Silero's VAD internally, so no need for backup
                        if profile.vad.selected_vad_model == WHISPER and profile.vad.backup_vad_model == SILERO:
                            profile.vad.backup_vad_model = OFF

                self.version = current_version
                self.save()

    def save(self):
        with open(get_config_path(), 'w') as file:
            json.dump(self.to_dict(), file, indent=4)
        return self

    def get_config(self) -> ProfileConfig:
        if self.current_profile not in self.configs:
            logger.warning(
                f"Profile '{self.current_profile}' not found. Switching to default profile.")
            self.current_profile = DEFAULT_CONFIG
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

    def sync_changed_fields(self, previous_config: ProfileConfig):
        current_config = self.get_config()

        for section in current_config.to_dict():
            if dataclasses.is_dataclass(getattr(current_config, section, None)):
                for field_name in getattr(current_config, section, None).to_dict():
                    config_section = getattr(current_config, section, None)
                    previous_config_section = getattr(
                        previous_config, section, None)
                    current_value = getattr(config_section, field_name, None)
                    previous_value = getattr(
                        previous_config_section, field_name, None)
                    if str(current_value).strip() != str(previous_value).strip():
                        logger.info(
                            f"Syncing changed field '{field_name}' from '{previous_value}' to '{current_value}'")
                        for profile in self.configs.values():
                            if profile != current_config:
                                profile_section = getattr(
                                    profile, section, None)
                                if profile_section:
                                    setattr(profile_section,
                                            field_name, current_value)
                                    logger.info(
                                        f"Updated '{field_name}' in profile '{profile.name}'")

        return self

    def sync_shared_fields(self):
        config = self.get_config()
        for profile in self.configs.values():
            self.sync_shared_field(
                config.hotkeys, profile.hotkeys, "reset_line")
            self.sync_shared_field(
                config.hotkeys, profile.hotkeys, "take_screenshot")
            self.sync_shared_field(
                config.hotkeys, profile.hotkeys, "open_utility")
            self.sync_shared_field(
                config.hotkeys, profile.hotkeys, "play_latest_audio")
            self.sync_shared_field(config.anki, profile.anki, "url")
            self.sync_shared_field(config.anki, profile.anki, "sentence_field")
            self.sync_shared_field(
                config.anki, profile.anki, "sentence_audio_field")
            self.sync_shared_field(config.anki, profile.anki, "picture_field")
            self.sync_shared_field(config.anki, profile.anki, "word_field")
            self.sync_shared_field(
                config.anki, profile.anki, "previous_sentence_field")
            self.sync_shared_field(
                config.anki, profile.anki, "previous_image_field")
            self.sync_shared_field(config.anki, profile.anki, "tags_to_check")
            self.sync_shared_field(config.anki, profile.anki, "add_game_tag")
            self.sync_shared_field(config.anki, profile.anki, "polling_rate")
            self.sync_shared_field(
                config.anki, profile.anki, "overwrite_audio")
            self.sync_shared_field(
                config.anki, profile.anki, "overwrite_picture")
            self.sync_shared_field(
                config.anki, profile.anki, "multi_overwrites_sentence")
            self.sync_shared_field(
                config.general, profile.general, "open_config_on_startup")
            self.sync_shared_field(
                config.general, profile.general, "open_multimine_on_startup")
            self.sync_shared_field(
                config.general, profile.general, "websocket_uri")
            self.sync_shared_field(
                config.general, profile.general, "texthooker_port")
            self.sync_shared_field(
                config.audio, profile.audio, "external_tool")
            self.sync_shared_field(
                config.audio, profile.audio, "anki_media_collection")
            self.sync_shared_field(
                config.audio, profile.audio, "external_tool_enabled")
            self.sync_shared_field(
                config.audio, profile.audio, "custom_encode_settings")
            self.sync_shared_field(
                config.screenshot, profile.screenshot, "custom_ffmpeg_settings")
            self.sync_shared_field(config, profile, "advanced")
            self.sync_shared_field(config, profile, "paths")
            self.sync_shared_field(config, profile, "obs")
            self.sync_shared_field(config, profile, "wip")
            self.sync_shared_field(config.ai, profile.ai, "anki_field")
            self.sync_shared_field(config.ai, profile.ai, "provider")
            self.sync_shared_field(config.ai, profile.ai, "api_key")
            self.sync_shared_field(config.ai, profile.ai, "gemini_api_key")
            self.sync_shared_field(config.ai, profile.ai, "groq_api_key")

        return self

    def sync_shared_field(self, config, config2, field_name):
        try:
            config_value = getattr(config, field_name, None)
            config2_value = getattr(config2, field_name, None)

            if config_value != config2_value:  # Check if values are different.
                if config_value is not None:
                    logging.info(
                        f"Syncing shared field '{field_name}' to other profile.")
                    setattr(config2, field_name, config_value)
                elif config2_value is not None:
                    logging.info(
                        f"Syncing shared field '{field_name}' to current profile.")
                    setattr(config, field_name, config2_value)
        except AttributeError as e:
            logging.error(f"AttributeError during sync of '{field_name}': {e}")
        except Exception as e:
            logging.error(
                f"An unexpected error occurred during sync of '{field_name}': {e}")


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
    # Create the directory if it doesn't exist
    os.makedirs(config_dir, exist_ok=True)
    return config_dir


def get_logger_name():
    """Determine the appropriate logger name based on the calling context."""
    frame = inspect.currentframe()
    try:
        # Go up the call stack to find the main module
        while frame:
            filename = frame.f_code.co_filename
            if filename.endswith(('gsm.py', 'gamesentenceminer.py', '__main__.py')):
                return "GameSentenceMiner"
            elif 'ocr' in filename.lower():
                return "misc_ocr_utils"
            elif 'overlay' in filename.lower():
                return "GSM_Overlay"
            frame = frame.f_back
        
        # Fallback: check the main module name
        main_module = inspect.getmodule(inspect.stack()[-1][0])
        if main_module and hasattr(main_module, '__file__'):
            main_file = os.path.basename(main_module.__file__)
            if main_file in ('gsm.py', 'gamesentenceminer.py'):
                return "GameSentenceMiner"
            elif 'ocr' in main_file.lower():
                return "misc_ocr_utils"
            elif 'overlay' in main_file.lower():
                return "GSM_Overlay"

        return "GameSentenceMiner"  # Default fallback
    finally:
        del frame
        
logger_name = get_logger_name()

def get_log_path():
    path = os.path.join(get_app_directory(), "logs", f'{logger_name.lower()}.log')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path

def get_error_log_path():
    path = os.path.join(get_app_directory(), "logs", 'error.log')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path

temp_directory = ''


def get_temporary_directory(delete=False):
    global temp_directory
    if not temp_directory:
        temp_directory = os.path.join(get_app_directory(), 'temp')
        os.makedirs(temp_directory, exist_ok=True)
        if delete:
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
                    logger.warning(f"Loading Profile-less Config, Converting to new Config!")
                    with open(config_path, 'r') as file:
                        config_file = json.load(file)

                    config = ProfileConfig.from_dict(config_file)
                    new_config = Config(
                        configs={DEFAULT_CONFIG: config}, current_profile=DEFAULT_CONFIG)

                    config.save()
                    return new_config
        except json.JSONDecodeError as e:
            logger.error(
                f"Error parsing config.json, saving backup and returning new config: {e}")
            shutil.copy(config_path, config_path + '.bak')
            config = Config.new()
            config.save()
            return config
    elif os.path.exists('config.toml'):
        config = ProfileConfig().load_from_toml('config.toml')
        new_config = Config({DEFAULT_CONFIG: config},
                            current_profile=DEFAULT_CONFIG)
        return new_config
    else:
        config = Config.new()
        config.save()
        return config


config_instance: Config = None


def get_config():
    global config_instance
    if config_instance is None:
        config_instance = load_config()

    return config_instance.get_config()


def get_overlay_config():
    global config_instance
    if config_instance is None:
        config_instance = load_config()
    return config_instance.overlay


def reload_config():
    global config_instance
    config_instance = load_config()

        
def get_stats_config():
    global config_instance
    if config_instance is None:
        config_instance = load_config()
    return config_instance.stats


def get_master_config():
    return config_instance


def save_full_config(config):
    with open(get_config_path(), 'w') as file:
        json.dump(config.to_dict(), file, indent=4)


def save_current_config(config):
    global config_instance
    config_instance.set_config_for_profile(
        config_instance.current_profile, config)
    save_full_config(config_instance)
    

def save_stats_config(stats_config):
    global config_instance
    config_instance.stats = stats_config
    save_full_config(config_instance)


def switch_profile_and_save(profile_name):
    global config_instance
    config_instance.current_profile = profile_name
    save_full_config(config_instance)
    return config_instance.get_config()

if is_windows():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

logger = logging.getLogger(logger_name)
# Set the base level to DEBUG so that all messages are captured
logger.setLevel(logging.DEBUG)
formatter = logging.Formatter(
    '%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# Create console handler with level INFO
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.INFO)

console_handler.setFormatter(formatter)

logger.addHandler(console_handler)

file_path = get_log_path()
# Use RotatingFileHandler for automatic log rotation
rotating_handler = RotatingFileHandler(
    file_path, 
    maxBytes=10 * 1024 * 1024,  # 10MB
    backupCount=5 if logger_name == "GameSentenceMiner" else 0,  # Keep more logs for OCR and Overlay
    encoding='utf-8'
)
rotating_handler.setLevel(logging.DEBUG)
rotating_handler.setFormatter(formatter)
logger.addHandler(rotating_handler)

error_log_path = get_error_log_path()
error_handler = RotatingFileHandler(
    error_log_path,
    maxBytes=5 * 1024 * 1024,  # 5MB
    backupCount=1,
    encoding='utf-8'
)
error_handler.setLevel(logging.ERROR)
error_handler.setFormatter(formatter)
error_handler.addFilter(lambda record: record.levelno >= logging.ERROR)
logger.addHandler(error_handler)

DB_PATH = os.path.join(get_app_directory(), 'gsm.db')

# Clean up files in log directory older than 7 days
def cleanup_old_logs(days=7):
    log_dir = os.path.dirname(get_log_path())
    now = time.time()
    cutoff = now - (days * 86400)  # 86400 seconds in a day

    if os.path.exists(log_dir):
        for filename in os.listdir(log_dir):
            file_path = os.path.join(log_dir, filename)
            if os.path.isfile(file_path):
                file_modified = os.path.getmtime(file_path)
                if file_modified < cutoff:
                    try:
                        os.remove(file_path)
                        logger.info(f"Deleted old log file: {file_path}")
                    except Exception as e:
                        logger.error(f"Error deleting file {file_path}: {e}")

try:
    cleanup_old_logs()
except Exception as e:
    logger.warning(f"Error during log cleanup: {e}")


class GsmAppState:
    def __init__(self):
        self.config_app = None
        self.dialog_manager = None
        self.line_for_audio = None
        self.line_for_screenshot = None
        self.anki_note_for_screenshot = None
        self.previous_line_for_audio = None
        self.previous_line_for_screenshot = None
        self.previous_trim_args = None
        self.previous_audio = None
        self.previous_screenshot = None
        self.previous_replay = None
        self.current_replay = None
        self.lock = threading.Lock()
        self.last_mined_line = None
        self.keep_running = True
        self.current_game = ''
        self.videos_to_remove = set()
        self.recording_started_time = None
        self.current_srt = None
        self.srt_index = 1
        self.current_audio_stream = None
        self.replay_buffer_length = 0
        self.vad_result = None


@dataclass_json
@dataclass
class AnkiUpdateResult:
    success: bool = False
    audio_in_anki: str = ''
    screenshot_in_anki: str = ''
    prev_screenshot_in_anki: str = ''
    sentence_in_anki: str = ''
    multi_line: bool = False
    video_in_anki: str = ''
    word_path: str = ''
    word: str = ''
    extra_tags: List[str] = field(default_factory=list)

    @staticmethod
    def failure():
        return AnkiUpdateResult(success=False, audio_in_anki='', screenshot_in_anki='', prev_screenshot_in_anki='', sentence_in_anki='', multi_line=False, video_in_anki='', word_path='', word='', extra_tags=[])


@dataclass_json
@dataclass
class GsmStatus:
    ready: bool = False
    status: bool = "Initializing"
    cards_created: int = 0
    websockets_connected: List[str] = field(default_factory=list)
    obs_connected: bool = False
    anki_connected: bool = False
    last_line_received: str = None
    words_being_processed: List[str] = field(default_factory=list)
    clipboard_enabled: bool = True

    def add_word_being_processed(self, word: str):
        if word not in self.words_being_processed:
            self.words_being_processed.append(word)

    def remove_word_being_processed(self, word: str):
        if word in self.words_being_processed:
            self.words_being_processed.remove(word)


def is_running_from_source():
    # Check for .git directory at the project root
    current_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = current_dir
    while project_root != os.path.dirname(project_root):  # Avoid infinite loop
        if os.path.isdir(os.path.join(project_root, '.git')):
            return True
        project_root = os.path.dirname(project_root)
    return False


gsm_status = GsmStatus()
anki_results = {}
gsm_state = GsmAppState()
is_dev = is_running_from_source()

is_beangate = os.path.exists("C:/Users/Beangate")


def get_ffmpeg_path():
    path = os.path.join(get_app_directory(), "ffmpeg", "ffmpeg.exe") if is_windows() else "ffmpeg"
    if shutil.which(path) is not None:
        return path
    elif is_mac():
        if shutil.which("/opt/homebrew/bin/ffmpeg") is not None:
            return "/opt/homebrew/bin/ffmpeg"
    return path

def get_ffprobe_path():
    path = os.path.join(get_app_directory(), "ffmpeg", "ffprobe.exe") if is_windows() else "ffprobe"
    if shutil.which(path) is not None:
        return path
    elif is_mac():
        if shutil.which("/opt/homebrew/bin/ffprobe") is not None:
            return "/opt/homebrew/bin/ffprobe"
    return path

def get_pickaxe_png_path():
    package_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(package_root, "assets", "pickaxe.png")
    return path

ffmpeg_base_command_list = [get_ffmpeg_path(), "-hide_banner", "-loglevel", "error", '-nostdin']

ffmpeg_base_command_list_info = [get_ffmpeg_path(), "-hide_banner", "-loglevel", "info", '-nostdin']


# logger.debug(f"Running in development mode: {is_dev}")
# logger.debug(f"Running on Beangate's PC: {is_beangate}")
