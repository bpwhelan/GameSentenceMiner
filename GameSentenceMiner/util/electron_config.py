import json
import os
from dataclasses import dataclass, field
from typing import List, Optional
from dataclasses_json import dataclass_json

from GameSentenceMiner.util.configuration import get_app_directory, logger


# @dataclass_json
# @dataclass
# class SteamGame:
#     id: str = ''
#     name: str = ''
#     processName: str = ''
#     script: str = ''

@dataclass_json
@dataclass
class YuzuConfig:
    emuPath: str = "C:\\Emulation\\Emulators\\yuzu-windows-msvc\\yuzu.exe"
    romsPath: str = "C:\\Emulation\\Yuzu\\Games"
    launchGameOnStart: str = ""
    lastGameLaunched: str = ""

@dataclass_json
@dataclass
class VNConfig:
    vns: List[str] = field(default_factory=list)
    textractorPath: str = ""
    launchVNOnStart: str = ""
    lastVNLaunched: str = ""

# @dataclass_json
# @dataclass
# class SteamConfig:
#     steamPath: str = ""
#     steamGames: List[SteamGame] = field(default_factory=list)
#     launchSteamOnStart: int = 0
#     lastGameLaunched: int = 0

@dataclass_json
@dataclass
class OCRConfig:
    twoPassOCR: bool = True
    optimize_second_scan: bool = True
    ocr1: str = "oneOCR"
    ocr2: str = "glens"
    window_name: str = ""
    language: str = "ja"
    ocr_screenshots: bool = False
    furigana_filter_sensitivity: int = 0
    manualOcrHotkey: str = "Ctrl+Shift+G"
    areaSelectOcrHotkey: str = "Ctrl+Shift+O"
    sendToClipboard: bool = True
    scanRate: float = 0.5
    requiresOpenWindow: bool = False
    useWindowForConfig: bool = False
    lastWindowSelected: str = ""
    keep_newline: bool = False
    useObsAsOCRSource: bool = True

    def has_changed(self, other: 'OCRConfig') -> bool:
        return self.to_dict() != other.to_dict()

@dataclass_json
@dataclass
class StoreConfig:
    yuzu: YuzuConfig = field(default_factory=YuzuConfig)
    agentScriptsPath: str = "E:\\Japanese Stuff\\agent-v0.1.4-win32-x64\\data\\scripts"
    textractorPath: str = "E:\\Japanese Stuff\\Textractor\\Textractor.exe"
    startConsoleMinimized: bool = False
    autoUpdateElectron: bool = True
    autoUpdateGSMApp: bool = False
    pythonPath: str = ""
    VN: VNConfig = field(default_factory=VNConfig)
    # steam: SteamConfig = field(default_factory=SteamConfig)
    agentPath: str = ""
    OCR: OCRConfig = field(default_factory=OCRConfig)

class Store:
    def __init__(self, config_path=os.path.join(get_app_directory(), "electron", "config.json"), defaults: Optional[StoreConfig] = None):
        self.data: StoreConfig = StoreConfig()
        self.config_path = config_path
        self.defaults = defaults if defaults is not None else StoreConfig()
        self._load_config()

    def _load_config(self):
        if os.path.exists(self.config_path):
            while True:
                try:
                    with open(self.config_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        self.data = StoreConfig.from_dict(data)
                    break
                except (json.JSONDecodeError, IOError) as e:
                    logger.debug(f"File being written to: {e}. Retrying...")
        else:
            self.data = self.defaults
            self._save_config()

    def _save_config(self):
        with open(self.config_path, 'w', encoding='utf-8') as f:
            json.dump(self.data.to_dict(), f, indent=4)

    def reload_config(self):
        self._load_config()

    def get(self, key, default=None):
        keys = key.split('.')
        value = self.data
        for k in keys:
            if hasattr(value, '__dataclass_fields__') and k in value.__dataclass_fields__:
                value = getattr(value, k)
            else:
                return default
        return value

    def set(self, key, value):
        keys = key.split('.')
        current = self.data
        for i, k in enumerate(keys):
            if i == len(keys) - 1:
                setattr(current, k, value)
            else:
                if not hasattr(current, '__dataclass_fields__') or k not in current.__dataclass_fields__:
                    return  # Key doesn't exist in the dataclass structure
                if not hasattr(getattr(current, k), '__dataclass_fields__'):
                    setattr(current, k, object()) # Create a new object if it's not a dataclass instance yet
                current = getattr(current, k)
        self._save_config()

    def delete(self, key):
        keys = key.split('.')
        if not keys:
            return False
        current = self.data
        for i, k in enumerate(keys[:-1]):
            if not hasattr(current, '__dataclass_fields__') or k not in current.__dataclass_fields__:
                return False
            current = getattr(current, k)
        if hasattr(current, keys[-1]):
            delattr(current, keys[-1])
            self._save_config()
            return True
        return False

    def print_store(self):
        """Prints the entire contents of the store in a readable JSON format."""
        print(json.dumps(self.data.to_dict(), indent=4))

# Initialize the store
electron_store = Store(config_path=os.path.join(get_app_directory(), "electron", "config.json"), defaults=StoreConfig())


# def has_section_changed(section_class: type) -> bool:
#     global electron_store
#     # Get the attribute name from the class (e.g. OCRConfig -> OCR)
#     section_name = None
#     for attr, value in StoreConfig.__dataclass_fields__.items():
#         if value.type == section_class:
#             section_name = attr
#             break
#     if not section_name:
#         return False
#     if not os.path.exists(electron_store.config_path):
#         return False
#     with open(electron_store.config_path, 'r', encoding='utf-8') as f:
#         data = json.load(f)
#         current = StoreConfig.from_dict(data)
#         current_section = getattr(current, section_name)
#         old_section = getattr(electron_store, section_name)
#         if hasattr(current_section, 'to_dict') and hasattr(old_section, 'to_dict'):
#             return current_section.to_dict() != old_section.to_dict()
#         electron_store = Store(config_path=electron_store.config_path)
#         return True

# Helper Methods
def get_electron_store() -> Store:
    global electron_store
    return electron_store

def get_ocr_two_pass_ocr():
    return electron_store.data.OCR.twoPassOCR

def get_ocr_optimize_second_scan():
    return electron_store.data.OCR.optimize_second_scan

def get_ocr_ocr1():
    return electron_store.data.OCR.ocr1

def get_ocr_ocr2():
    return electron_store.data.OCR.ocr2

def get_ocr_window_name():
    return electron_store.data.OCR.window_name or ""

def get_ocr_language():
    return electron_store.data.OCR.language or "ja"

def get_ocr_ocr_screenshots():
    return electron_store.data.OCR.ocr_screenshots

def get_ocr_furigana_filter_sensitivity():
    return electron_store.data.OCR.furigana_filter_sensitivity

def get_ocr_manual_ocr_hotkey():
    return electron_store.data.OCR.manualOcrHotkey

def get_ocr_area_select_ocr_hotkey():
    return electron_store.data.OCR.areaSelectOcrHotkey

def get_ocr_send_to_clipboard():
    return electron_store.data.OCR.sendToClipboard

def get_ocr_scan_rate():
    return electron_store.data.OCR.scanRate

def get_ocr_requires_open_window():
    return electron_store.data.OCR.requiresOpenWindow

def get_ocr_use_window_for_config():
    return electron_store.data.OCR.useWindowForConfig

def get_ocr_last_window_selected():
    return electron_store.data.OCR.lastWindowSelected

def get_ocr_keep_newline():
    return electron_store.data.OCR.keep_newline

def get_ocr_use_obs_as_source():
    return electron_store.data.OCR.useObsAsOCRSource

def get_furigana_filter_sensitivity() -> int:
    return electron_store.data.OCR.furigana_filter_sensitivity
    
def has_ocr_config_changed() -> bool:
    global electron_store
    if not os.path.exists(electron_store.config_path):
        return False, {}
    with open(electron_store.config_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
        current = StoreConfig.from_dict(data)
        current_section = current.OCR
        old_section = electron_store.data.OCR
    if not (hasattr(current_section, 'to_dict') and hasattr(old_section, 'to_dict')):
        return False, {}
    current_dict = current_section.to_dict()
    old_dict = old_section.to_dict()
    if current_dict != old_dict:
        changes = {k: (old_dict[k], current_dict[k]) for k in current_dict if old_dict.get(k) != current_dict.get(k)}
        # logger.info(f"OCR Config changes detected: {changes}")
        return True, changes
    return False, {}

def reload_electron_config():
    global electron_store
    electron_store.reload_config()
    return electron_store