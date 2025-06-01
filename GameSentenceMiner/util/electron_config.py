import json
import os
from dataclasses import dataclass, field
from typing import List, Optional
from dataclasses_json import dataclass_json

from GameSentenceMiner.util.configuration import get_app_directory


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
    twoPassOCR: bool = False
    ocr1: str = "oneOCR"
    ocr2: str = "glens"
    window_name: str = ""
    requiresOpenWindow: Optional[bool] = None
    scanRate: Optional[float] = None

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
        self.config_path = config_path
        self.defaults = defaults if defaults is not None else StoreConfig()
        self._load_config()

    def _load_config(self):
        if os.path.exists(self.config_path):
            with open(self.config_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                self.data = StoreConfig.from_dict(data)
        else:
            self.data = self.defaults
            self._save_config()

    def _save_config(self):
        with open(self.config_path, 'w', encoding='utf-8') as f:
            json.dump(self.data.to_dict(), f, indent=4)

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
store = Store(config_path=os.path.join(get_app_directory(), "electron", "config.json"), defaults=StoreConfig())

# --- Convenience functions ---

def get_auto_update_gsm_app() -> bool:
    return store.get("autoUpdateGSMApp")

def set_auto_update_gsm_app(auto_update: bool):
    store.set("autoUpdateGSMApp", auto_update)

def get_auto_update_electron() -> bool:
    return store.get("autoUpdateElectron")

def set_auto_update_electron(auto_update: bool):
    store.set("autoUpdateElectron", auto_update)

def get_python_path() -> str:
    return store.get("pythonPath")

def set_python_path(path: str):
    store.set("pythonPath", path)

# OCR

def get_ocr_config() -> OCRConfig:
    ocr_data = store.get("OCR")
    return ocr_data if isinstance(ocr_data, OCRConfig) else OCRConfig.from_dict(ocr_data) if isinstance(ocr_data, dict) else OCRConfig()

def set_ocr_config(config: OCRConfig):
    store.set("OCR", config)

def get_two_pass_ocr() -> bool:
    return store.get("OCR.twoPassOCR")

def set_two_pass_ocr(two_pass: bool):
    store.set("OCR.twoPassOCR", two_pass)

def get_ocr1() -> str:
    return store.get("OCR.ocr1")

def set_ocr1(ocr: str):
    store.set("OCR.ocr1", ocr)

def get_ocr2() -> str:
    return store.get("OCR.ocr2")

def set_ocr2(ocr: str):
    store.set("OCR.ocr2", ocr)

def get_window_name() -> str:
    return store.get("OCR.window_name")

def set_window_name(name: str):
    store.set("OCR.window_name", name)

def get_requires_open_window() -> Optional[bool]:
    return store.get("OCR.requiresOpenWindow")

def set_requires_open_window(requires_open_window: Optional[bool]):
    store.set("OCR.requiresOpenWindow", requires_open_window)

def get_ocr_scan_rate() -> Optional[int]:
    return store.get("OCR.scanRate")

def set_ocr_scan_rate(scan_rate: Optional[int]):
    store.set("OCR.scanRate", scan_rate)

# Yuzu config getters and setters
def get_yuzu_config() -> YuzuConfig:
    yuzu_data = store.get('yuzu')
    return yuzu_data if isinstance(yuzu_data, YuzuConfig) else YuzuConfig.from_dict(yuzu_data) if isinstance(yuzu_data, dict) else YuzuConfig()

def set_yuzu_config(config: YuzuConfig):
    store.set('yuzu', config)


# Yuzu emulator path getters and setters
def get_yuzu_emu_path() -> str:
    return store.get('yuzu.emuPath')

def set_yuzu_emu_path(path: str):
    store.set('yuzu.emuPath', path)

# Yuzu ROMs path getters and setters
def get_yuzu_roms_path() -> str:
    return store.get('yuzu.romsPath')

def set_yuzu_roms_path(path: str):
    store.set('yuzu.romsPath', path)

def get_launch_yuzu_game_on_start() -> str:
    return store.get("yuzu.launchGameOnStart")

def set_launch_yuzu_game_on_start(path: str):
    store.set("yuzu.launchGameOnStart", path)

def get_last_yuzu_game_launched() -> str:
    return store.get("yuzu.lastGameLaunched")

def set_last_yuzu_game_launched(path: str):
    store.set("yuzu.lastGameLaunched", path)

# Agent scripts path getters and setters
def get_agent_scripts_path() -> str:
    return store.get('agentScriptsPath')

def set_agent_scripts_path(path: str):
    store.set('agentScriptsPath', path)

def set_agent_path(path: str):
    store.set('agentPath', path)

def get_agent_path() -> str:
    return store.get('agentPath')

def get_start_console_minimized() -> bool:
    return store.get("startConsoleMinimized")

def set_start_console_minimized(should_minimize: bool):
    store.set("startConsoleMinimized", should_minimize)

def get_vns() -> List[str]:
    return store.get('VN.vns')

def set_vns(vns: List[str]):
    store.set('VN.vns', vns)

def get_textractor_path() -> str:
    return store.get("VN.textractorPath")

def set_textractor_path(path: str):
    store.set("VN.textractorPath", path)

def get_launch_vn_on_start() -> str:
    return store.get("VN.launchVNOnStart")

def set_launch_vn_on_start(vn: str):
    store.set("VN.launchVNOnStart", vn)

def get_last_vn_launched() -> str:
    return store.get("VN.lastVNLaunched")

def set_last_vn_launched(vn: str):
    store.set("VN.lastVNLaunched", vn)

def get_steam_path() -> str:
    return store.get('steam.steamPath')

def set_steam_path(path: str):
    store.set('steam.steamPath', path)

def get_launch_steam_on_start() -> int:
    return store.get('steam.launchSteamOnStart')

def set_launch_steam_on_start(game_id: int):
    store.set('steam.launchSteamOnStart', game_id)

def get_last_steam_game_launched() -> int:
    return store.get('steam.lastGameLaunched')

def set_last_steam_game_launched(game_id: int):
    store.set('steam.lastGameLaunched', game_id)

# def get_steam_games() -> List[SteamGame]:
#     steam_games_data = store.get('steam.steamGames')
#     return [SteamGame.from_dict(game_data) for game_data in steam_games_data] if isinstance(steam_games_data, list) else []

# def set_steam_games(games: List[SteamGame]):
#     store.set('steam.steamGames', [game.to_dict() for game in games])

# if __name__ == "__main__":
#     # Example usage:
#     print(f"Initial Yuzu Emulator Path: {get_yuzu_emu_path()}")
#     set_yuzu_emu_path("D:\\NewEmulators\\yuzu\\yuzu.exe")
#     print(f"Updated Yuzu Emulator Path: {get_yuzu_emu_path()}")
#
#     ocr_config = get_ocr_config()
#     print(f"Initial Two-Pass OCR: {ocr_config.twoPassOCR}")
#     set_two_pass_ocr(True)
#     print(f"Updated Two-Pass OCR: {get_two_pass_ocr()}")
#
#     steam_games = get_steam_games()
#     print(f"Initial Steam Games: {[game.name for game in steam_games]}")
#     new_games = [SteamGame(123, "Game One"), SteamGame(456, "Game Two")]
#     set_steam_games(new_games)
#     print(f"Updated Steam Games: {[game.name for game in get_steam_games()]}")
