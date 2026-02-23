import dataclasses
import importlib
import importlib.resources as resources
import inspect
import json
import os
import re
import shutil
import sys
import threading
import time
import toml
from dataclasses import dataclass, field
from dataclasses_json import dataclass_json
from enum import Enum
from functools import wraps
from importlib import metadata
from os.path import expanduser
from pathlib import Path
from sys import platform
from typing import Any, List, Dict, Optional, ClassVar

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
AI_OLLAMA = 'Ollama'
AI_LM_STUDIO = 'LM Studio'
AI_GSM_CLOUD = 'GSM Cloud'

GSM_CLOUD_DEFAULT_MODEL = "gpt-4.1-nano-2025-04-14"
GSM_CLOUD_PREVIEW_ENV = "GSM_CLOUD_PREVIEW"


def is_gsm_cloud_preview_enabled() -> bool:
    flag = os.environ.get(GSM_CLOUD_PREVIEW_ENV)
    if flag is None:
        return False
    normalized = str(flag).strip().lower()
    return normalized in {"1", "true", "yes", "on"}

GEMINI_MODEL_ALIASES = {
    "gemini-3-flash": "gemini-3-flash-preview",
    "gemini-3-pro": "gemini-3-pro-preview",
}

LEGACY_GEMINI_MODEL_ALIASES = {
    "gemini-2.5-flash-lite-preview-06-17": "gemini-2.5-flash-lite",
}


def normalize_gemini_model_name(model_name: str) -> str:
    normalized = str(model_name or "").strip()
    if not normalized:
        return ""
    lowered = normalized.lower()
    if lowered in GEMINI_MODEL_ALIASES:
        return GEMINI_MODEL_ALIASES[lowered]
    if lowered in LEGACY_GEMINI_MODEL_ALIASES:
        return LEGACY_GEMINI_MODEL_ALIASES[lowered]
    return normalized

INFO = 'INFO'
DEBUG = 'DEBUG'

DEFAULT_CONFIG = 'Default'

current_game = ''

supported_formats = {
    'opus': {'codec': 'libopus', 'format': 'opus'},
    'mp3': {'codec': 'libmp3lame', 'format': 'mp3'},
    'ogg': {'codec': 'libvorbis', 'format': 'ogg'},
    'aac': {'codec': 'aac', 'format': 'adts'},
    'm4a': {'codec': 'aac', 'format': 'ipod'},
}

SUPPORTED_AUDIO_EXTENSIONS = tuple(f'.{ext}' for ext in supported_formats.keys())

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

def is_wayland():
    return os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland' or bool(os.environ.get('WAYLAND_DISPLAY'))


def sanitize_and_resolve_path(input_path: str) -> str:
    """
    Fixes strings that were corrupted by Windows backslashes being interpreted 
    as escape sequences (e.g., 'C:\\Users\noober' becoming 'C:\\Users\nnoober').
    """
    if not input_path:
        return input_path
    
    s = str(input_path)
    s = s.replace('\a', '/a').replace('\b', '/b').replace('\f', '/f').replace('\n', '/n').replace('\r', '/r').replace('\t', '/t').replace('\v', '/v') 
    
    return Path(s).expanduser().resolve().as_posix()


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
    target_language: str = CommonLanguages.JAPANESE.value

    def get_native_language_name(self) -> str:
        try:
            return CommonLanguages.name_from_code(self.native_language)
        except ValueError:
            return "Unknown"
    
    def get_target_language_name(self) -> str:
        try:
            return CommonLanguages.name_from_code(self.target_language)
        except ValueError:
            return "Unknown"


@dataclass_json
@dataclass
class TextReplacementRule:
    enabled: bool = True
    mode: str = "plain"  # "plain" or "regex"
    find: str = ""
    replace: str = ""
    case_sensitive: bool = False
    whole_word: bool = False


@dataclass_json
@dataclass
class StringReplacement:
    enabled: bool = False
    rules: List[TextReplacementRule] = field(default_factory=list)


@dataclass_json
@dataclass
class TextProcessing:
    string_replacement: StringReplacement = field(default_factory=StringReplacement)

@dataclass_json
@dataclass
class Paths:
    folder_to_watch: str = sanitize_and_resolve_path("~/Videos/GSM")
    output_folder: str = sanitize_and_resolve_path("~/Videos/GSM/Output")
    copy_temp_files_to_output_folder: bool = False
    open_output_folder_on_card_creation: bool = False
    copy_trimmed_replay_to_output_folder: bool = False
    remove_video: bool = True
    remove_audio: bool = False
    remove_screenshot: bool = False

    def __post_init__(self):
        self.folder_to_watch = sanitize_and_resolve_path(self.folder_to_watch)
        self.output_folder = sanitize_and_resolve_path(self.output_folder)


@dataclass_json
@dataclass
class AnkiField:
    name: str = ''
    enabled: bool = True
    overwrite: bool = False
    append: bool = False
    core: bool = False

    def normalize(self):
        self.name = '' if self.name is None else str(self.name)
        self.enabled = bool(self.enabled)
        self.overwrite = bool(self.overwrite)
        self.append = bool(self.append)
        if self.core:
            self.enabled = True
        if self.overwrite and self.append:
            self.append = False


@dataclass_json
@dataclass
class Anki:
    _FIELD_DEFAULTS: ClassVar[Dict[str, AnkiField]] = {
        "sentence": AnkiField(name="Sentence", enabled=True, overwrite=True, append=False, core=True),
        "sentence_audio": AnkiField(name="SentenceAudio", enabled=True, overwrite=False, append=False, core=True),
        "picture": AnkiField(name="Picture", enabled=True, overwrite=True, append=False, core=True),
        "word": AnkiField(name="Expression", enabled=True, overwrite=True, append=False, core=True),
        "previous_sentence": AnkiField(name="", enabled=True, overwrite=False, append=False, core=False),
        "previous_image": AnkiField(name="", enabled=True, overwrite=True, append=False, core=False),
        "video": AnkiField(name="", enabled=True, overwrite=True, append=False, core=False),
        "sentence_furigana": AnkiField(name="SentenceFurigana", enabled=True, overwrite=True, append=False, core=False),
        "game_name": AnkiField(name="", enabled=True, overwrite=True, append=False, core=False),
    }

    _LEGACY_FIELD_MAP: ClassVar[Dict[str, str]] = {
        "sentence_field": "sentence",
        "sentence_audio_field": "sentence_audio",
        "picture_field": "picture",
        "word_field": "word",
        "previous_sentence_field": "previous_sentence",
        "previous_image_field": "previous_image",
        "video_field": "video",
        "sentence_furigana_field": "sentence_furigana",
        "game_name_field": "game_name",
    }

    enabled: bool = True
    update_anki: bool = True
    show_update_confirmation_dialog_v2: bool = True
    auto_accept_timer: int = 10
    confirmation_always_on_top: bool = True
    confirmation_focus_on_show: bool = True
    url: str = 'http://127.0.0.1:8765'
    note_type: str = ''
    available_fields: List[str] = field(default_factory=list)
    sentence: AnkiField = field(default_factory=lambda: AnkiField(name="Sentence", enabled=True, overwrite=True, append=False, core=True))
    sentence_audio: AnkiField = field(default_factory=lambda: AnkiField(name="SentenceAudio", enabled=True, overwrite=False, append=False, core=True))
    picture: AnkiField = field(default_factory=lambda: AnkiField(name="Picture", enabled=True, overwrite=True, append=False, core=True))
    word: AnkiField = field(default_factory=lambda: AnkiField(name="Expression", enabled=True, overwrite=True, append=False, core=True))
    previous_sentence: AnkiField = field(default_factory=lambda: AnkiField(name="", enabled=True, overwrite=False, append=False))
    previous_image: AnkiField = field(default_factory=lambda: AnkiField(name="", enabled=True, overwrite=True, append=False))
    video: AnkiField = field(default_factory=lambda: AnkiField(name="", enabled=True, overwrite=True, append=False))
    sentence_furigana: AnkiField = field(default_factory=lambda: AnkiField(name="SentenceFurigana", enabled=True, overwrite=True, append=False))
    game_name: AnkiField = field(default_factory=lambda: AnkiField(name="", enabled=True, overwrite=True, append=False))
    # Initialize to None and set it in __post_init__
    custom_tags: List[str] = None
    tags_to_check: List[str] = None
    add_game_tag: bool = True
    polling_rate: int = 500
    polling_rate_v2: int = 1000
    # Legacy flags kept for compatibility with older configs.
    overwrite_audio: bool = False
    overwrite_picture: bool = True
    overwrite_sentence: bool = True
    parent_tag: str = "Game"
    autoplay_audio: bool = False
    replay_audio_on_tts_generation: bool = True
    tag_unvoiced_cards: bool = False

    def __post_init__(self):
        if self.custom_tags is None:
            self.custom_tags = ['GSM']
        if self.tags_to_check is None:
            self.tags_to_check = []

        for attr_name, default in self._FIELD_DEFAULTS.items():
            value = getattr(self, attr_name)
            coerced = self._coerce_field(value, default)
            setattr(self, attr_name, coerced)

        # Keep legacy overwrite settings synchronized.
        self.overwrite_audio = bool(self.sentence_audio.overwrite)
        self.overwrite_picture = bool(self.picture.overwrite)
        self.overwrite_sentence = bool(self.sentence.overwrite)

    def _coerce_field(self, value: Any, default: AnkiField) -> AnkiField:
        if isinstance(value, AnkiField):
            coerced = value
        elif isinstance(value, dict):
            coerced = AnkiField(
                name=value.get("name", default.name),
                enabled=value.get("enabled", default.enabled),
                overwrite=value.get("overwrite", default.overwrite),
                append=value.get("append", default.append),
                core=default.core,
            )
        elif isinstance(value, str):
            coerced = AnkiField(
                name=value,
                enabled=default.enabled,
                overwrite=default.overwrite,
                append=default.append,
                core=default.core,
            )
        else:
            coerced = AnkiField(
                name=default.name,
                enabled=default.enabled,
                overwrite=default.overwrite,
                append=default.append,
                core=default.core,
            )

        coerced.core = default.core
        coerced.normalize()
        return coerced

    def get_field_config(self, legacy_key: str) -> AnkiField:
        attr = self._LEGACY_FIELD_MAP[legacy_key]
        return getattr(self, attr)


def _make_field_name_property(attr_name: str):
    def getter(self: Anki) -> str:
        return getattr(self, attr_name).name

    def setter(self: Anki, value: str) -> None:
        field_cfg = getattr(self, attr_name)
        field_cfg.name = '' if value is None else str(value)
        field_cfg.normalize()

    return property(getter, setter)


def _make_field_flag_property(attr_name: str, flag_name: str):
    def getter(self: Anki):
        return bool(getattr(getattr(self, attr_name), flag_name))

    def setter(self: Anki, value):
        field_cfg = getattr(self, attr_name)
        setattr(field_cfg, flag_name, bool(value))
        field_cfg.normalize()
        if attr_name == "sentence_audio":
            self.overwrite_audio = bool(self.sentence_audio.overwrite)
        elif attr_name == "picture":
            self.overwrite_picture = bool(self.picture.overwrite)
        elif attr_name == "sentence":
            self.overwrite_sentence = bool(self.sentence.overwrite)

    return property(getter, setter)


for _legacy_key, _attr_name in Anki._LEGACY_FIELD_MAP.items():
    setattr(Anki, _legacy_key, _make_field_name_property(_attr_name))
    setattr(Anki, f"{_legacy_key}_enabled", _make_field_flag_property(_attr_name, "enabled"))
    setattr(Anki, f"{_legacy_key}_overwrite", _make_field_flag_property(_attr_name, "overwrite"))
    setattr(Anki, f"{_legacy_key}_append", _make_field_flag_property(_attr_name, "append"))


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
class Experimental:
    enable_experimental_features: bool = False

@dataclass_json
@dataclass
class ProcessPausing:
    enabled: bool = False
    auto_resume_seconds: int = 30
    require_game_exe_match: bool = True
    overlay_manual_hotkey_requests_pause: bool = False
    overlay_texthooker_hotkey_requests_pause: bool = False
    allowlist: List[str] = field(default_factory=list)
    denylist: List[str] = field(default_factory=lambda: [
        "explorer.exe",
        "dwm.exe",
        "csrss.exe",
        "services.exe",
        "svchost.exe",
        "smss.exe",
        "wininit.exe",
        "winlogon.exe",
        "lsass.exe",
        "audiodg.exe",
        "steam.exe",
        "steamwebhelper.exe",
        "steamservice.exe",
        "obs64.exe",
        "obs.exe",
        "discord.exe",
        "gamesentenceminer.exe",
        "gsm_overlay.exe",
        "gsm_overlay",
    ])

@dataclass_json
@dataclass
class AnimatedScreenshotSettings:
    fps: int = 15 # max 30
    extension: str = 'avif' # 'webp'
    quality: int = 8 # 0-10
    scaled_quality: int = 10 # 0-90 for webp, 10-45 for avif
    
    def __post_init__(self):
        # Disable webp due to it being garbage
        self.extension = 'avif'
        self.scaled_quality = self._scale_quality(self.quality, self.extension)
    
    def _scale_quality(self, q: int, codec: str) -> int:
        q = max(0, min(10, q))

        if codec == "webp":
            # 0 → 60, 10 → 80
            return int(60 + q * 2)

        if codec == "avif":
            # AV1 CRF: 0 = best, 63 = worst
            # We expose 10-45 (recommended usable range)
            # 0 → 45, 10 → 10
            return int(45 - q * 3.5)

        return q

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
    animated_settings: AnimatedScreenshotSettings = field(default_factory=AnimatedScreenshotSettings)
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
    extension: str = 'mp3'
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
            "{format}", self.extension if self.extension in supported_formats else "mp3").replace("{encoder}", supported_formats.get(self.extension, {"codec": "libmp3lame"})["codec"])
        if not self.anki_media_collection:
            self.anki_media_collection = get_default_anki_media_collection_path()
        self.anki_media_collection = sanitize_and_resolve_path(self.anki_media_collection)
        self.external_tool = sanitize_and_resolve_path(self.external_tool)


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
    recording_fps: int = 15
    disable_desktop_audio_on_connect: bool = False
    obs_path: str = ''

    def __post_init__(self):
        # Force get_game_from_scene to be True
        self.get_game_from_scene = True
        self.recording_fps = max(1, min(120, int(self.recording_fps or 15)))
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
    open_utility: str = 'ctrl+m'
    play_latest_audio: str = 'f7'
    manual_overlay_scan: str = ''
    process_pause: str = ''


@dataclass_json
@dataclass
class VAD:
    whisper_model: str = WHISPER_BASE
    do_vad_postprocessing: bool = True
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
    use_cpu_for_inference_v2: bool = True
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
    localhost_bind_address: str = '127.0.0.1' # Default 127.0.0.1 for security, set to 0.0.0.0 to allow external connections
    dont_collect_stats: bool = False
    audio_backend: str = 'sounddevice' # 'sounddevice' or 'qt6'
    slowest_polling_rate: int = 5000  # in ms
    longest_sleep_time: float = 5.0
    cloud_sync_enabled: bool = False
    cloud_sync_auto_sync: bool = False
    cloud_sync_api_url: str = ""
    cloud_sync_email: str = ""
    cloud_sync_api_token: str = ""
    cloud_sync_device_id: str = ""
    cloud_sync_interval_seconds: int = 900
    cloud_sync_push_batch_size: int = 5000
    cloud_sync_max_server_changes: int = 5000
    cloud_sync_timeout_seconds: int = 20

    def __post_init__(self):
        if self.plaintext_websocket_port == -1:
            self.plaintext_websocket_port = self.texthooker_communication_websocket_port + 1
        self.cloud_sync_api_url = str(self.cloud_sync_api_url or "").strip().rstrip("/")
        self.cloud_sync_email = str(self.cloud_sync_email or "").strip()
        self.cloud_sync_api_token = str(self.cloud_sync_api_token or "").strip()
        self.cloud_sync_device_id = str(self.cloud_sync_device_id or "").strip()
        self.cloud_sync_interval_seconds = max(60, int(self.cloud_sync_interval_seconds or 900))
        self.cloud_sync_push_batch_size = max(1, min(5000, int(self.cloud_sync_push_batch_size or 5000)))
        self.cloud_sync_max_server_changes = max(1, min(5000, int(self.cloud_sync_max_server_changes or 5000)))
        self.cloud_sync_timeout_seconds = max(5, min(120, int(self.cloud_sync_timeout_seconds or 20)))
        if not is_gsm_cloud_preview_enabled():
            self.cloud_sync_enabled = False
            self.cloud_sync_auto_sync = False


@dataclass_json
@dataclass
class Ai:
    enabled: bool = False # DEPRECATED, use is_configured() instead
    add_to_anki: bool = False
    anki_field: str = ''
    provider: str = AI_GEMINI
    gemini_model: str = 'gemma-3-27b-it'
    gemini_backup_model: str = ''
    groq_model: str = 'meta-llama/llama-4-scout-17b-16e-instruct'
    groq_backup_model: str = ''
    gemini_api_key: str = ''
    api_key: str = ''  # Legacy support, will be moved to gemini_api_key if provider is gemini
    groq_api_key: str = ''
    open_ai_url: str = ''
    open_ai_model: str = ''
    open_ai_backup_model: str = ''
    open_ai_api_key: str = ''
    ollama_url: str = 'http://localhost:11434'
    ollama_model: str = 'llama3'
    ollama_backup_model: str = ''
    lm_studio_url: str = 'http://localhost:1234/v1'
    lm_studio_model: str = ''
    lm_studio_backup_model: str = ''
    lm_studio_api_key: str = 'lm-studio'
    gsm_cloud_api_url: str = "https://api.gamesentenceminer.com"
    gsm_cloud_auth_url: str = "https://auth.gamesentenceminer.com"
    gsm_cloud_client_id: str = "gsm-desktop"
    gsm_cloud_access_token: str = ""
    gsm_cloud_refresh_token: str = ""
    gsm_cloud_user_id: str = ""
    gsm_cloud_token_expires_at: int = 0
    gsm_cloud_models: List[str] = field(default_factory=lambda: [GSM_CLOUD_DEFAULT_MODEL])
    use_canned_translation_prompt: bool = True
    use_canned_context_prompt: bool = False
    custom_prompt: str = ''
    custom_texthooker_prompt: str = ''
    custom_full_prompt: str = ''
    dialogue_context_length: int = 10
    temperature: float = 0.3
    max_output_tokens: int = 4096
    top_p: float = 0.9

    def __post_init__(self):
        provider_alias_map = {
            "gemini": AI_GEMINI,
            "groq": AI_GROQ,
            "openai": AI_OPENAI,
            "ollama": AI_OLLAMA,
            "lm_studio": AI_LM_STUDIO,
            "lm studio": AI_LM_STUDIO,
            "gsm_cloud": AI_GSM_CLOUD,
            "gsm cloud": AI_GSM_CLOUD,
        }
        provider_key = str(self.provider or "").strip().lower()
        if provider_key in provider_alias_map:
            self.provider = provider_alias_map[provider_key]
        if self.provider == AI_GSM_CLOUD and not is_gsm_cloud_preview_enabled():
            self.provider = AI_GEMINI

        if not self.gemini_api_key:
            self.gemini_api_key = self.api_key
        if self.gemini_model in ['RECOMMENDED', 'OTHER']:
            self.gemini_model = 'gemini-2.5-flash-lite'
        if self.gemini_backup_model in ['RECOMMENDED', 'OTHER', OFF]:
            self.gemini_backup_model = ''
        if self.groq_model in ['RECOMMENDED', 'OTHER']:
            self.groq_model = 'meta-llama/llama-4-scout-17b-16e-instruct'
        if self.groq_backup_model in ['RECOMMENDED', 'OTHER', OFF]:
            self.groq_backup_model = ''
        if self.open_ai_backup_model == OFF:
            self.open_ai_backup_model = ''
        if self.ollama_backup_model == OFF:
            self.ollama_backup_model = ''
        if self.lm_studio_backup_model == OFF:
            self.lm_studio_backup_model = ''

        if self.enabled:
            self.add_to_anki = True

        self.groq_model = str(self.groq_model or "").strip()
        self.groq_backup_model = str(self.groq_backup_model or "").strip()
        self.open_ai_model = str(self.open_ai_model or "").strip()
        self.open_ai_backup_model = str(self.open_ai_backup_model or "").strip()
        self.ollama_model = str(self.ollama_model or "").strip()
        self.ollama_backup_model = str(self.ollama_backup_model or "").strip()
        self.lm_studio_model = str(self.lm_studio_model or "").strip()
        self.lm_studio_backup_model = str(self.lm_studio_backup_model or "").strip()
        self.gsm_cloud_api_url = str(self.gsm_cloud_api_url or "").strip().rstrip("/")
        self.gsm_cloud_auth_url = str(self.gsm_cloud_auth_url or "").strip().rstrip("/")
        self.gsm_cloud_client_id = str(self.gsm_cloud_client_id or "").strip() or "gsm-desktop"
        self.gsm_cloud_access_token = str(self.gsm_cloud_access_token or "").strip()
        self.gsm_cloud_refresh_token = str(self.gsm_cloud_refresh_token or "").strip()
        self.gsm_cloud_user_id = str(self.gsm_cloud_user_id or "").strip()
        try:
            self.gsm_cloud_token_expires_at = max(0, int(self.gsm_cloud_token_expires_at or 0))
        except (TypeError, ValueError):
            self.gsm_cloud_token_expires_at = 0

        self.gemini_model = normalize_gemini_model_name(self.gemini_model)
        self.gemini_backup_model = normalize_gemini_model_name(self.gemini_backup_model)
        if self.gemini_backup_model == self.gemini_model:
            self.gemini_backup_model = ''
        if self.groq_backup_model == self.groq_model:
            self.groq_backup_model = ''
        if self.open_ai_backup_model == self.open_ai_model:
            self.open_ai_backup_model = ''
        if self.ollama_backup_model == self.ollama_model:
            self.ollama_backup_model = ''
        if self.lm_studio_backup_model == self.lm_studio_model:
            self.lm_studio_backup_model = ''

        valid_cloud_models = []
        for model in (self.gsm_cloud_models or []):
            normalized_model = str(model or "").strip()
            if normalized_model and normalized_model not in valid_cloud_models:
                valid_cloud_models.append(normalized_model)
        if not valid_cloud_models:
            valid_cloud_models = [GSM_CLOUD_DEFAULT_MODEL]
        self.gsm_cloud_models = valid_cloud_models

    def is_configured(self) -> bool:
        if self.provider == AI_GEMINI and self.gemini_api_key and self.gemini_model:
            return True
        if self.provider == AI_GROQ and self.groq_api_key and self.groq_model:
            return True
        if self.provider == AI_OPENAI and self.open_ai_api_key and self.open_ai_model and self.open_ai_url:
            return True
        if self.provider == AI_OLLAMA and self.ollama_model and self.ollama_url:
            return True
        if self.provider == AI_LM_STUDIO and self.lm_studio_model and self.lm_studio_url:
            return True
        if self.provider == AI_GSM_CLOUD and self.gsm_cloud_access_token and self.get_gsm_cloud_primary_model():
            return True
        return False

    def get_gsm_cloud_primary_model(self) -> str:
        return self.gsm_cloud_models[0] if self.gsm_cloud_models else GSM_CLOUD_DEFAULT_MODEL

    def get_gsm_cloud_openai_base_url(self) -> str:
        base = str(self.gsm_cloud_api_url or "").strip().rstrip("/")
        if not base:
            base = "https://api.gamesentenceminer.com"
        return f"{base}/api/cloud/openai/v1"

    def is_gsm_cloud_authenticated(self) -> bool:
        return bool(self.gsm_cloud_access_token)


class OverlayEngine(str, Enum):
    LENS = 'lens'
    ONEOCR = 'oneocr'
    MEIKIOCR = 'meikiocr'

@dataclass_json
@dataclass
class Overlay:
    websocket_port: int = 55499
    engine: str = OverlayEngine.LENS.value
    engine_v2: str = OverlayEngine.ONEOCR.value  # New v2 config - defaults everyone to ONEOCR
    monitor_to_capture: int = 0
    periodic: bool = False
    periodic_interval: float = 1.0
    periodic_ratio: float = 0.9
    send_hotkey_text_to_texthooker: bool = False
    minimum_character_size: int = 0
    use_ocr_area_config: bool = False
    ocr_full_screen_instead_of_obs: bool = False

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
    text_processing: TextProcessing = field(default_factory=TextProcessing)
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
    hotkeys: Hotkeys = field(default_factory=Hotkeys)
    
    def __post_init__(self):
        pass

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

        self.paths.folder_to_watch = sanitize_and_resolve_path(config_data['paths'].get(
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
        self.anki.polling_rate_v2 = config_data['anki'].get(
            'polling_rate', self.anki.polling_rate_v2)
        anki_overwrites = config_data.get('anki_overwrites', {})
        legacy_overwrite_audio = anki_overwrites.get('overwrite_audio', self.anki.overwrite_audio)
        legacy_overwrite_picture = anki_overwrites.get('overwrite_picture', self.anki.overwrite_picture)
        legacy_overwrite_sentence = anki_overwrites.get('overwrite_sentence', self.anki.overwrite_sentence)
        self.anki.overwrite_audio = legacy_overwrite_audio
        self.anki.overwrite_picture = legacy_overwrite_picture
        self.anki.overwrite_sentence = legacy_overwrite_sentence
        self.anki.sentence_audio_field_overwrite = legacy_overwrite_audio
        self.anki.picture_field_overwrite = legacy_overwrite_picture
        self.anki.sentence_field_overwrite = legacy_overwrite_sentence

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

        self.hotkeys.process_pause = config_data['hotkeys'].get(
            'process_pause', self.hotkeys.process_pause)

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
    afk_timer_seconds: int = 60  # Used when minimum_chars_per_hour is 0 (fallback mode)
    minimum_chars_per_hour: int = 5000  # Minimum reading speed (CPH). Set to 0 to use afk_timer_seconds instead (not recommended)
    session_gap_seconds: int = 3600
    streak_requirement_hours: float = 0.01 # 1 second required per day to keep your streak by default
    reading_hours_target: int = 1500  # Target reading hours based on TMW N1 achievement data
    character_count_target: int = 25000000  # Target character count (25M) inspired by Discord server milestones
    games_target: int = 100  # Target VNs/games completed based on Refold community standards
    reading_hours_target_date: str = ""  # Target date for reading hours goal (ISO format: YYYY-MM-DD)
    character_count_target_date: str = ""  # Target date for character count goal (ISO format: YYYY-MM-DD)
    games_target_date: str = ""  # Target date for games/VNs goal (ISO format: YYYY-MM-DD)
    cards_mined_daily_target: int = 10  # Daily target for cards mined (default: 10 cards per day)
    regex_out_punctuation: bool = True
    regex_out_repetitions: bool = False
    easy_days_settings: Dict[str, int] = field(default_factory=lambda: {
        'monday': 100,
        'tuesday': 100,
        'wednesday': 100,
        'thursday': 100,
        'friday': 100,
        'saturday': 100,
        'sunday': 100
    })
    
@dataclass_json
@dataclass
class Discord:
    enabled: bool = True
    update_interval: int = 15
    inactivity_timer: int = 300
    icon: str = "GSM" # "Cute", "Jacked", "Cursed"
    show_reading_stats: str = "Total Characters"  # 'None', 'Characters per Hour', 'Total Characters', 'Cards Mined', 'Active Reading Time'
    blacklisted_scenes: List[str] = field(default_factory=list)

@dataclass_json
@dataclass
class Config:
    configs: Dict[str, ProfileConfig] = field(default_factory=dict)
    current_profile: str = DEFAULT_CONFIG
    switch_to_default_if_not_found: bool = True
    locale: str = Locale.English.value
    stats: StatsConfig = field(default_factory=StatsConfig)
    overlay: Overlay = field(default_factory=Overlay)
    experimental: Experimental = field(default_factory=Experimental)
    process_pausing: ProcessPausing = field(default_factory=ProcessPausing)
    discord: Discord = field(default_factory=Discord)
    version: str = ""

    @classmethod
    def new(cls):
        instance = cls(
            configs={DEFAULT_CONFIG: ProfileConfig()}, current_profile=DEFAULT_CONFIG)
        return instance

    @staticmethod
    def _migrate_anki_profile_data(profile_data: Dict[str, Any]) -> None:
        if not isinstance(profile_data, dict):
            return

        anki_data = profile_data.get("anki")
        if not isinstance(anki_data, dict):
            return

        field_specs = {
            "sentence": {"legacy": "sentence_field", "default_name": "Sentence", "core": True, "legacy_overwrite": "overwrite_sentence", "default_overwrite": True},
            "sentence_audio": {"legacy": "sentence_audio_field", "default_name": "SentenceAudio", "core": True, "legacy_overwrite": "overwrite_audio", "default_overwrite": False},
            "picture": {"legacy": "picture_field", "default_name": "Picture", "core": True, "legacy_overwrite": "overwrite_picture", "default_overwrite": True},
            "word": {"legacy": "word_field", "default_name": "Expression", "core": True, "legacy_overwrite": None, "default_overwrite": True},
            "previous_sentence": {"legacy": "previous_sentence_field", "default_name": "", "core": False, "legacy_overwrite": None, "default_overwrite": False},
            "previous_image": {"legacy": "previous_image_field", "default_name": "", "core": False, "legacy_overwrite": None, "default_overwrite": True},
            "video": {"legacy": "video_field", "default_name": "", "core": False, "legacy_overwrite": None, "default_overwrite": True},
            "sentence_furigana": {"legacy": "sentence_furigana_field", "default_name": "SentenceFurigana", "core": False, "legacy_overwrite": None, "default_overwrite": True},
            "game_name": {"legacy": "game_name_field", "default_name": "", "core": False, "legacy_overwrite": None, "default_overwrite": True},
        }

        for new_key, spec in field_specs.items():
            legacy_key = spec["legacy"]
            raw_value = anki_data.get(new_key)
            legacy_name = anki_data.get(legacy_key)

            if isinstance(raw_value, dict):
                field_dict = dict(raw_value)
            elif isinstance(raw_value, str):
                field_dict = {"name": raw_value}
            else:
                field_dict = {}
                if isinstance(legacy_name, str):
                    field_dict["name"] = legacy_name

            if "name" not in field_dict:
                field_dict["name"] = spec["default_name"]

            legacy_enabled_key = f"{legacy_key}_enabled"
            legacy_overwrite_key = f"{legacy_key}_overwrite"
            legacy_append_key = f"{legacy_key}_append"

            if "enabled" not in field_dict:
                legacy_enabled_value = anki_data.get(legacy_enabled_key)
                field_dict["enabled"] = True if legacy_enabled_value is None else bool(legacy_enabled_value)

            if "overwrite" not in field_dict:
                legacy_overwrite_value = anki_data.get(legacy_overwrite_key)
                if legacy_overwrite_value is None and spec["legacy_overwrite"]:
                    legacy_overwrite_value = anki_data.get(spec["legacy_overwrite"])
                field_dict["overwrite"] = spec["default_overwrite"] if legacy_overwrite_value is None else bool(legacy_overwrite_value)

            if "append" not in field_dict:
                legacy_append_value = anki_data.get(legacy_append_key)
                field_dict["append"] = False if legacy_append_value is None else bool(legacy_append_value)

            field_dict["core"] = bool(spec["core"])
            if field_dict["core"]:
                field_dict["enabled"] = True
            if field_dict["overwrite"] and field_dict["append"]:
                field_dict["append"] = False

            anki_data[new_key] = field_dict

            anki_data.pop(legacy_key, None)
            anki_data.pop(legacy_enabled_key, None)
            anki_data.pop(legacy_overwrite_key, None)
            anki_data.pop(legacy_append_key, None)

        profile_data.pop("anki_overwrites", None)

    @classmethod
    def _migrate_raw_data(cls, data: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(data, dict):
            return data
        configs = data.get("configs")
        if not isinstance(configs, dict):
            return data
        for profile_data in configs.values():
            cls._migrate_anki_profile_data(profile_data)
        return data

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
                data = cls._migrate_raw_data(data)
                return cls.from_dict(data)
        else:
            return cls.new()
        
    def __post_init__(self):  
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
                
        for name, config in list(self.configs.items()):
            if name != config.name:
                config.name = name
                logger.info(f"Config name '{name}' updated to match its key in the configs dictionary.")

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
                config.hotkeys, profile.hotkeys, "open_utility")
            self.sync_shared_field(
                config.hotkeys, profile.hotkeys, "play_latest_audio")
            self.sync_shared_field(
                config.hotkeys, profile.hotkeys, "process_pause")
            self.sync_shared_field(config.anki, profile.anki, "url")
            self.sync_shared_field(config.anki, profile.anki, "sentence_field")
            self.sync_shared_field(config.anki, profile.anki, "sentence_field_enabled")
            self.sync_shared_field(config.anki, profile.anki, "sentence_field_overwrite")
            self.sync_shared_field(config.anki, profile.anki, "sentence_field_append")
            self.sync_shared_field(
                config.anki, profile.anki, "sentence_audio_field")
            self.sync_shared_field(config.anki, profile.anki, "sentence_audio_field_enabled")
            self.sync_shared_field(config.anki, profile.anki, "sentence_audio_field_overwrite")
            self.sync_shared_field(config.anki, profile.anki, "sentence_audio_field_append")
            self.sync_shared_field(config.anki, profile.anki, "picture_field")
            self.sync_shared_field(config.anki, profile.anki, "picture_field_enabled")
            self.sync_shared_field(config.anki, profile.anki, "picture_field_overwrite")
            self.sync_shared_field(config.anki, profile.anki, "picture_field_append")
            self.sync_shared_field(config.anki, profile.anki, "word_field")
            self.sync_shared_field(config.anki, profile.anki, "word_field_enabled")
            self.sync_shared_field(config.anki, profile.anki, "word_field_overwrite")
            self.sync_shared_field(config.anki, profile.anki, "word_field_append")
            self.sync_shared_field(
                config.anki, profile.anki, "previous_sentence_field")
            self.sync_shared_field(config.anki, profile.anki, "previous_sentence_field_enabled")
            self.sync_shared_field(config.anki, profile.anki, "previous_sentence_field_overwrite")
            self.sync_shared_field(config.anki, profile.anki, "previous_sentence_field_append")
            self.sync_shared_field(
                config.anki, profile.anki, "previous_image_field")
            self.sync_shared_field(config.anki, profile.anki, "previous_image_field_enabled")
            self.sync_shared_field(config.anki, profile.anki, "previous_image_field_overwrite")
            self.sync_shared_field(config.anki, profile.anki, "previous_image_field_append")
            self.sync_shared_field(config.anki, profile.anki, "video_field")
            self.sync_shared_field(config.anki, profile.anki, "video_field_enabled")
            self.sync_shared_field(config.anki, profile.anki, "video_field_overwrite")
            self.sync_shared_field(config.anki, profile.anki, "video_field_append")
            self.sync_shared_field(config.anki, profile.anki, "sentence_furigana_field")
            self.sync_shared_field(config.anki, profile.anki, "sentence_furigana_field_enabled")
            self.sync_shared_field(config.anki, profile.anki, "sentence_furigana_field_overwrite")
            self.sync_shared_field(config.anki, profile.anki, "sentence_furigana_field_append")
            self.sync_shared_field(config.anki, profile.anki, "game_name_field")
            self.sync_shared_field(config.anki, profile.anki, "game_name_field_enabled")
            self.sync_shared_field(config.anki, profile.anki, "game_name_field_overwrite")
            self.sync_shared_field(config.anki, profile.anki, "game_name_field_append")
            self.sync_shared_field(config.anki, profile.anki, "tags_to_check")
            self.sync_shared_field(config.anki, profile.anki, "add_game_tag")
            self.sync_shared_field(config.anki, profile.anki, "polling_rate")
            self.sync_shared_field(
                config.anki, profile.anki, "autoplay_audio")
            self.sync_shared_field(
                config.anki, profile.anki, "show_update_confirmation_dialog_v2")
            self.sync_shared_field(
                config.anki, profile.anki, "auto_accept_timer")
            self.sync_shared_field(
                config.anki, profile.anki, "confirmation_always_on_top")
            self.sync_shared_field(
                config.anki, profile.anki, "confirmation_focus_on_show")
            self.sync_shared_field(
                config.anki, profile.anki, "replay_audio_on_tts_generation")
            self.sync_shared_field(
                config.general, profile.general, "open_config_on_startup")
            self.sync_shared_field(
                config.general, profile.general, "open_multimine_on_startup")
            self.sync_shared_field(
                config.general, profile.general, "websocket_uri")
            self.sync_shared_field(
                config.general, profile.general, "texthooker_port")
            self.sync_shared_field(
                config.general, profile.general, "target_language")
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
            self.sync_shared_field(config.advanced, profile.advanced, "audio_player_path")
            self.sync_shared_field(config.advanced, profile.advanced, "video_player_path")
            self.sync_shared_field(config.advanced, profile.advanced, "multi_line_line_break")
            self.sync_shared_field(config.advanced, profile.advanced, "multi_line_sentence_storage_field")
            self.sync_shared_field(config.advanced, profile.advanced, "ocr_websocket_port")
            self.sync_shared_field(config.advanced, profile.advanced, "texthooker_communication_websocket_port")
            self.sync_shared_field(config.advanced, profile.advanced, "plaintext_websocket_port")
            self.sync_shared_field(config.advanced, profile.advanced, "localhost_bind_address")
            self.sync_shared_field(config.advanced, profile.advanced, "longest_sleep_time")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_enabled")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_auto_sync")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_api_url")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_email")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_api_token")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_device_id")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_interval_seconds")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_push_batch_size")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_max_server_changes")
            self.sync_shared_field(config.advanced, profile.advanced, "cloud_sync_timeout_seconds")
            self.sync_shared_field(config, profile, "paths")
            self.sync_shared_field(config, profile, "obs")
            self.sync_shared_field(config, profile, "wip")
            self.sync_shared_field(config.ai, profile.ai, "anki_field")
            self.sync_shared_field(config.ai, profile.ai, "provider")
            self.sync_shared_field(config.ai, profile.ai, "api_key")
            self.sync_shared_field(config.ai, profile.ai, "gemini_api_key")
            self.sync_shared_field(config.ai, profile.ai, "gemini_backup_model")
            self.sync_shared_field(config.ai, profile.ai, "groq_api_key")
            self.sync_shared_field(config.ai, profile.ai, "groq_backup_model")
            self.sync_shared_field(config.ai, profile.ai, "open_ai_backup_model")
            self.sync_shared_field(config.ai, profile.ai, "ollama_url")
            self.sync_shared_field(config.ai, profile.ai, "ollama_model")
            self.sync_shared_field(config.ai, profile.ai, "ollama_backup_model")
            self.sync_shared_field(config.ai, profile.ai, "lm_studio_backup_model")
            self.sync_shared_field(config.ai, profile.ai, "gsm_cloud_api_url")
            self.sync_shared_field(config.ai, profile.ai, "gsm_cloud_auth_url")
            self.sync_shared_field(config.ai, profile.ai, "gsm_cloud_client_id")
            self.sync_shared_field(config.ai, profile.ai, "gsm_cloud_access_token")
            self.sync_shared_field(config.ai, profile.ai, "gsm_cloud_refresh_token")
            self.sync_shared_field(config.ai, profile.ai, "gsm_cloud_user_id")
            self.sync_shared_field(config.ai, profile.ai, "gsm_cloud_token_expires_at")
            self.sync_shared_field(config.ai, profile.ai, "gsm_cloud_models")
            self.sync_shared_field(config.text_processing, profile.text_processing, "string_replacement")

        return self

    def sync_shared_field(self, config, config2, field_name):
        try:
            config_value = getattr(config, field_name, None)
            config2_value = getattr(config2, field_name, None)

            if config_value != config2_value:  # Check if values are different.
                if config_value is not None:
                    logger.info(
                        f"Syncing shared field '{field_name}' to other profile.")
                    setattr(config2, field_name, config_value)
                elif config2_value is not None:
                    logger.info(
                        f"Syncing shared field '{field_name}' to current profile.")
                    setattr(config, field_name, config2_value)
        except AttributeError as e:
            logger.error(f"AttributeError during sync of '{field_name}': {e}")
        except Exception as e:
            logger.error(
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

def get_gpu_support_path():
    return os.path.join(get_app_directory(), 'gpu_support')

def add_gpu_dlls_to_path():
    try:
        if is_windows():
            # toolkit_path = r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin"
            # if os.path.exists(toolkit_path):
            #     os.environ["PATH"] = toolkit_path + os.pathsep + os.environ["PATH"]
            #     logger.info(f"Added CUDA Toolkit DLLs to PATH from {toolkit_path}")
            # extra_dll_path = r"C:\Program Files\NVIDIA\CUDNN\v9.17\bin\12.9"
            # if os.path.exists(extra_dll_path):
            #     os.environ["PATH"] = extra_dll_path + os.pathsep + os.environ["PATH"]
            #     logger.info(f"Added extra cuDNN DLLs to PATH from {extra_dll_path}")
            packages_added = False
            for pkg in ["nvidia.cublas", "nvidia.cudnn"]:
                spec = importlib.util.find_spec(pkg)
                if spec and spec.submodule_search_locations:
                    # Go up one level to get the nvidia parent directory
                    nvidia_root = os.path.dirname(spec.submodule_search_locations[0])
                    # Add all nvidia package bin directories to PATH
                    for item in os.listdir(nvidia_root):
                        item_path = os.path.join(nvidia_root, item)
                        if os.path.isdir(item_path):
                            bin_path = os.path.join(item_path, "bin")
                            if os.path.exists(bin_path):
                                os.environ["PATH"] = bin_path + os.pathsep + os.environ["PATH"]
                                packages_added = True
                    break  # Only need to find one package to get the nvidia root
            if packages_added:
                logger.info(f"Added NVIDIA GPU Support DLLs to PATH from {nvidia_root}")
    except Exception as e:
        pass
    # gpu_path = get_gpu_support_path()
    # if os.path.exists(gpu_path):
    #     os.environ['PATH'] = gpu_path + os.pathsep + os.environ.get('PATH', '')
    #     logger.info(f"Added GPU Support DLLs to PATH from {gpu_path}")
    # else:
    #     logger.warning(f"GPU Support path does not exist: {gpu_path}")
    
def is_cuda_available():
    try:
        if is_windows():
            cuda_found = False
            cudnn_found = False
            for pkg in ["nvidia.cublas", "nvidia.cudnn"]:
                spec = importlib.util.find_spec(pkg)
                if spec and spec.submodule_search_locations:
                    if pkg == "nvidia.cublas":
                        cuda_found = True
                    elif pkg == "nvidia.cudnn":
                        cudnn_found = True
            
            if cuda_found and cudnn_found:
                return True
        elif is_linux():
            try:
                import torch
                if torch.cuda.is_available():
                    logger.info("CUDA support found via PyTorch")
                    return True
            except ImportError:
                pass
    except Exception as e:
        pass
    return False

def get_app_directory():
    if platform == 'win32':  # Windows
        appdata_dir = os.getenv('APPDATA')
    else:  # macOS and Linux
        appdata_dir = sanitize_and_resolve_path('~/.config')
    config_dir = os.path.join(appdata_dir, 'GameSentenceMiner')
    # Create the directory if it doesn't exist
    os.makedirs(config_dir, exist_ok=True)
    return config_dir


# Logging is now handled by GameSentenceMiner.util.logging_config
# Import at the end of this file to avoid circular dependencies

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

def _remove_legacy_hotkeys(config_data: dict):
    if not isinstance(config_data, dict):
        return config_data

    hotkeys = config_data.get('hotkeys')
    if isinstance(hotkeys, dict):
        hotkeys.pop('reset_line', None)
        hotkeys.pop('take_screenshot', None)

    configs = config_data.get('configs')
    if isinstance(configs, dict):
        for profile_data in configs.values():
            if isinstance(profile_data, dict):
                profile_hotkeys = profile_data.get('hotkeys')
                if isinstance(profile_hotkeys, dict):
                    profile_hotkeys.pop('reset_line', None)
                    profile_hotkeys.pop('take_screenshot', None)

    return config_data


def load_config():
    config_path = get_config_path()

    if os.path.exists('config.json') and not os.path.exists(config_path):
        shutil.copy('config.json', config_path)

    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as file:
                config_file = json.load(file)
                config_file = _remove_legacy_hotkeys(config_file)
                if "current_profile" in config_file:
                    return Config.from_dict(config_file)
                else:
                    logger.warning(f"Loading Profile-less Config, Converting to new Config!")
                    with open(config_path, 'r') as file:
                        config_file = json.load(file)
                    config_file = _remove_legacy_hotkeys(config_file)

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
    return get_config().overlay
    # global config_instance
    # if config_instance is None:
    #     config_instance = load_config()
    # return config_instance.overlay


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

# Import the new logging system
from GameSentenceMiner.util.logging_config import logger, initialize_logging, cleanup_old_logs

# Initialize logging with appropriate settings
initialize_logging()

DB_PATH = os.path.join(get_app_directory(), 'gsm.db')

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
        self.current_recording = None
        self.srt_index = 1
        self.current_audio_stream = None
        self.replay_buffer_length = 300
        self.vad_result = None
        self.videos_with_pending_operations = set()  # Track videos that shouldn't be deleted yet
        self.disable_anki_confirmation_session = False
        self.replay_buffer_stopped_timestamp = None


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
    _processing_words_lock = threading.Lock()

    ready: bool = False
    status: bool = "Initializing"
    cards_created: int = 0
    websockets_connected: List[str] = field(default_factory=list)
    obs_connected: bool = False
    anki_connected: bool = False
    last_line_received: str = None
    words_being_processed: List[str] = field(default_factory=list)
    clipboard_enabled: bool = True

    @staticmethod
    def _normalize_processing_word(word: Optional[str]) -> str:
        if word is None:
            return ""
        return str(word).strip()

    def add_word_being_processed(self, word: str):
        normalized = self._normalize_processing_word(word)
        if not normalized:
            return
        with self._processing_words_lock:
            if normalized not in self.words_being_processed:
                self.words_being_processed.append(normalized)

    def remove_word_being_processed(self, word: str):
        normalized = self._normalize_processing_word(word)
        if not normalized:
            return
        with self._processing_words_lock:
            self.words_being_processed[:] = [
                existing
                for existing in self.words_being_processed
                if self._normalize_processing_word(existing) != normalized
            ]

    def clear_words_being_processed(self):
        with self._processing_words_lock:
            self.words_being_processed.clear()


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
is_dev = is_running_from_source() or '--dev' in sys.argv

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
    return str(resources.files(PACKAGE_NAME).joinpath("assets", "pickaxe.png"))

ffmpeg_base_command_list = [get_ffmpeg_path(), "-hide_banner", "-loglevel", "error", '-nostdin']

ffmpeg_base_command_list_info = [get_ffmpeg_path(), "-hide_banner", "-loglevel", "info", '-nostdin']

add_gpu_dlls_to_path()

# Clean up old logs on module load
try:
    cleanup_old_logs()
except Exception as e:
    logger.warning(f"Error during log cleanup: {e}")
