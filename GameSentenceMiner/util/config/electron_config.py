import copy
import json
import os
import time
from threading import RLock
from typing import Any, Dict, Optional, Tuple

from GameSentenceMiner.util.config.configuration import (
    get_app_directory,
    is_windows,
    logger,
)


ELECTRON_CONFIG_PATH = os.path.join(get_app_directory(), "electron", "config.json")


# Mirrors electron-src/main/store.ts defaults.
# Keep OCR legacy keys that Python code still reads for backwards compatibility.
DEFAULT_STORE_CONFIG: Dict[str, Any] = {
    "frontPageState": {
        "agentEnabled": False,
        "ocrEnabled": False,
    },
    "yuzu": {
        "emuPath": "C:\\Emulation\\Emulators\\yuzu-windows-msvc\\yuzu.exe",
        "romsPath": "C:\\Emulation\\Yuzu\\Games",
        "launchGameOnStart": "",
        "lastGameLaunched": "",
        "games": [],
    },
    "agentScriptsPath": "E:\\Japanese Stuff\\agent-v0.1.4-win32-x64\\data\\scripts",
    "textractorPath": "E:\\Japanese Stuff\\Textractor\\Textractor.exe",
    "startConsoleMinimized": False,
    "autoUpdateElectron": False,
    "autoUpdateGSMApp": False,
    "VN": {
        "vns": [],
        "textractorPath": "",
        "launchVNOnStart": "",
        "lastVNLaunched": "",
    },
    "pythonPath": "",
    "electronAppVersion": "",
    "steam": {
        "steamPath": "",
        "steamGames": [],
        "launchSteamOnStart": 0,
        "lastGameLaunched": 0,
    },
    "agentPath": "",
    "OCR": {
        "twoPassOCR": True,
        "optimize_second_scan": True,
        "ocr1": "oneocr",
        "ocr2": "glens",
        "scanRate": 0.5,
        "language": "ja",
        "ocr_screenshots": False,
        "furigana_filter_sensitivity": 0,
        "manualOcrHotkey": "Ctrl+Shift+G",
        "areaSelectOcrHotkey": "Ctrl+Shift+O",
        "globalPauseHotkey": "Ctrl+Shift+P",
        "sendToClipboard": False,
        "keep_newline": False,
        "advancedMode": False,
        "scanRate_basic": 0.5,
        "ocr1_advanced": "oneocr",
        "ocr2_advanced": "glens",
        "scanRate_advanced": 0.5,
        # Legacy/compat keys still consumed by Python OCR runtime.
        "window_name": "",
        "requiresOpenWindow": False,
        "useWindowForConfig": False,
        "lastWindowSelected": "",
        "useObsAsOCRSource": True,
        "ocr1_basic": "oneocr",
        "ocr2_basic": "glens",
    },
    "customPythonPackage": "GameSentenceMiner",
    "windowTransparencyToolHotkey": "Ctrl+Alt+Y",
    "windowTransparencyTarget": "",
    "runWindowTransparencyToolOnStartup": False,
    "runOverlayOnStartup": False,
    "obsOcrScenes": [],
    "pullPreReleases": False,
    "runManualOCROnStartup": False,
    "visibleTabs": ["launcher", "stats", "python", "console"],
    "statsEndpoint": "overview",
    "hasCompletedSetup": False,
}


def _clone(value: Any) -> Any:
    return copy.deepcopy(value)


def _deep_merge_defaults(defaults: Any, loaded: Any) -> Any:
    if isinstance(defaults, dict):
        loaded_dict = loaded if isinstance(loaded, dict) else {}
        merged = _clone(loaded_dict)
        for key, default_value in defaults.items():
            merged[key] = _deep_merge_defaults(default_value, loaded_dict.get(key))
        return merged

    if isinstance(defaults, list):
        return _clone(loaded) if isinstance(loaded, list) else _clone(defaults)

    if loaded is None:
        return _clone(defaults)
    return loaded


class Store:
    def __init__(
        self,
        config_path: str = ELECTRON_CONFIG_PATH,
        defaults: Optional[Dict[str, Any]] = None,
    ):
        self.config_path = config_path
        self.defaults: Dict[str, Any] = _clone(defaults) if defaults is not None else _clone(DEFAULT_STORE_CONFIG)
        self.data: Dict[str, Any] = _clone(self.defaults)
        self._lock = RLock()
        self._load_config()

    def _ensure_parent_dir(self) -> None:
        parent = os.path.dirname(self.config_path)
        if parent:
            os.makedirs(parent, exist_ok=True)

    def _read_raw_data(self, retries: int = 6, retry_delay: float = 0.05) -> Optional[Dict[str, Any]]:
        if not os.path.exists(self.config_path):
            return None

        last_error: Optional[Exception] = None
        for attempt in range(retries):
            try:
                with open(self.config_path, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
                if isinstance(data, dict):
                    return data
                logger.warning("Electron config root is not an object, using defaults merge fallback.")
                return {}
            except (json.JSONDecodeError, OSError) as exc:
                last_error = exc
                if attempt < retries - 1:
                    time.sleep(retry_delay)

        logger.debug(f"Failed reading electron config after retries: {last_error}")
        return None

    def _load_config(self) -> None:
        with self._lock:
            self._ensure_parent_dir()
            raw_data = self._read_raw_data()

            if raw_data is None:
                if not os.path.exists(self.config_path):
                    self.data = _clone(self.defaults)
                    self._save_config_unlocked()
                return

            merged = _deep_merge_defaults(self.defaults, raw_data)
            self.data = merged

            # Persist merged defaults for missing keys so both sides stay in sync.
            if merged != raw_data:
                self._save_config_unlocked()

    def _save_config_unlocked(self) -> None:
        self._ensure_parent_dir()
        tmp_path = f"{self.config_path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(self.data, handle, indent=4)
        os.replace(tmp_path, self.config_path)

    def _save_config(self) -> None:
        with self._lock:
            self._save_config_unlocked()

    def reload_config(self) -> None:
        self._load_config()

    def read_from_disk(self) -> Dict[str, Any]:
        with self._lock:
            raw_data = self._read_raw_data()
            if raw_data is None:
                return _clone(self.data)
            return _deep_merge_defaults(self.defaults, raw_data)

    def get(self, key: str, default: Any = None) -> Any:
        keys = key.split(".") if key else []
        with self._lock:
            value: Any = self.data
            for current_key in keys:
                if isinstance(value, dict) and current_key in value:
                    value = value[current_key]
                else:
                    return default
            return _clone(value)

    def set(self, key: str, value: Any) -> bool:
        keys = key.split(".") if key else []
        if not keys:
            return False

        with self._lock:
            current = self.data
            for current_key in keys[:-1]:
                next_value = current.get(current_key)
                if not isinstance(next_value, dict):
                    next_value = {}
                    current[current_key] = next_value
                current = next_value
            current[keys[-1]] = value
            self._save_config_unlocked()
            return True

    def delete(self, key: str) -> bool:
        keys = key.split(".") if key else []
        if not keys:
            return False

        with self._lock:
            current = self.data
            for current_key in keys[:-1]:
                next_value = current.get(current_key)
                if not isinstance(next_value, dict):
                    return False
                current = next_value

            if keys[-1] not in current:
                return False

            del current[keys[-1]]
            self._save_config_unlocked()
            return True

    def print_store(self) -> None:
        with self._lock:
            print(json.dumps(self.data, indent=4))


electron_store = Store(config_path=ELECTRON_CONFIG_PATH, defaults=DEFAULT_STORE_CONFIG)


def get_electron_store() -> Store:
    return electron_store


def _get_ocr_config() -> Dict[str, Any]:
    config = electron_store.get("OCR", {})
    return config if isinstance(config, dict) else {}


def _get_ocr_value(key: str, default: Any = None) -> Any:
    return _get_ocr_config().get(key, default)


def _is_advanced_mode() -> bool:
    return bool(_get_ocr_value("advancedMode", False))


def _resolve_ocr_engine(engine: Any) -> str:
    if not isinstance(engine, str):
        return ""

    engine_normalized = engine.strip().lower()
    if not engine_normalized:
        return ""

    if not is_windows() and engine_normalized == "oneocr":
        return "meikiocr"

    return engine_normalized


def _get_basic_ocr1_engine(ocr_config: Dict[str, Any]) -> str:
    ocr1 = ocr_config.get("ocr1")
    if isinstance(ocr1, str) and ocr1.strip():
        return ocr1

    legacy_ocr1 = ocr_config.get("ocr1_basic")
    if isinstance(legacy_ocr1, str) and legacy_ocr1.strip():
        return legacy_ocr1

    return "oneocr" if is_windows() else "meiki_text_detector"


def _get_basic_ocr2_engine(ocr_config: Dict[str, Any]) -> str:
    ocr2 = ocr_config.get("ocr2")
    if isinstance(ocr2, str) and ocr2.strip():
        return ocr2

    legacy_ocr2 = ocr_config.get("ocr2_basic")
    if isinstance(legacy_ocr2, str) and legacy_ocr2.strip():
        return legacy_ocr2

    return "glens"


def get_ocr_two_pass_ocr() -> bool:
    if not _is_advanced_mode():
        return True
    return bool(_get_ocr_value("twoPassOCR", True))


def get_ocr_optimize_second_scan() -> bool:
    if not _is_advanced_mode():
        return True
    return bool(_get_ocr_value("optimize_second_scan", True))


def get_ocr_ocr1() -> str:
    ocr_config = _get_ocr_config()
    if not _is_advanced_mode():
        return _resolve_ocr_engine(_get_basic_ocr1_engine(ocr_config))
    return _resolve_ocr_engine(ocr_config.get("ocr1", "oneocr"))


def get_ocr_ocr2() -> str:
    ocr_config = _get_ocr_config()
    if not _is_advanced_mode():
        return _resolve_ocr_engine(_get_basic_ocr2_engine(ocr_config))
    return _resolve_ocr_engine(ocr_config.get("ocr2", "glens"))


def get_ocr_window_name() -> str:
    return str(_get_ocr_value("window_name", "") or "")


def get_ocr_language() -> str:
    return str(_get_ocr_value("language", "ja") or "ja")


def get_ocr_ocr_screenshots() -> bool:
    if not _is_advanced_mode():
        return False
    return bool(_get_ocr_value("ocr_screenshots", False))


def get_ocr_furigana_filter_sensitivity() -> int:
    try:
        return int(_get_ocr_value("furigana_filter_sensitivity", 0))
    except (TypeError, ValueError):
        return 0


def get_ocr_manual_ocr_hotkey() -> str:
    return str(_get_ocr_value("manualOcrHotkey", "Ctrl+Shift+G") or "Ctrl+Shift+G")


def get_ocr_area_select_ocr_hotkey() -> str:
    return str(_get_ocr_value("areaSelectOcrHotkey", "Ctrl+Shift+O") or "Ctrl+Shift+O")


def get_ocr_global_pause_hotkey() -> str:
    return str(_get_ocr_value("globalPauseHotkey", "Ctrl+Shift+P") or "Ctrl+Shift+P")


def get_ocr_send_to_clipboard() -> bool:
    return bool(_get_ocr_value("sendToClipboard", False))


def get_ocr_scan_rate() -> float:
    ocr_config = _get_ocr_config()
    scan_rate = ocr_config.get("scanRate")

    if scan_rate is None and not _is_advanced_mode():
        scan_rate = ocr_config.get("scanRate_basic", 0.5)

    try:
        return float(scan_rate)
    except (TypeError, ValueError):
        return 0.5


def get_ocr_requires_open_window() -> bool:
    return bool(_get_ocr_value("requiresOpenWindow", False))


def get_ocr_use_window_for_config() -> bool:
    return bool(_get_ocr_value("useWindowForConfig", False))


def get_ocr_last_window_selected() -> str:
    return str(_get_ocr_value("lastWindowSelected", "") or "")


def get_ocr_keep_newline() -> bool:
    if not _is_advanced_mode():
        return True
    return bool(_get_ocr_value("keep_newline", False))


def get_ocr_use_obs_as_source() -> bool:
    return bool(_get_ocr_value("useObsAsOCRSource", True))


def get_furigana_filter_sensitivity() -> int:
    return get_ocr_furigana_filter_sensitivity()


def has_ocr_config_changed() -> Tuple[bool, Dict[str, Tuple[Any, Any]]]:
    current_data = electron_store.read_from_disk()
    current_ocr = current_data.get("OCR", {}) if isinstance(current_data, dict) else {}
    old_ocr = _get_ocr_config()

    if not isinstance(current_ocr, dict):
        current_ocr = {}

    if current_ocr == old_ocr:
        return False, {}

    changes: Dict[str, Tuple[Any, Any]] = {}
    for key in sorted(set(current_ocr.keys()) | set(old_ocr.keys())):
        old_value = old_ocr.get(key)
        new_value = current_ocr.get(key)
        if old_value != new_value:
            changes[key] = (old_value, new_value)

    return True, changes


def reload_electron_config() -> Store:
    electron_store.reload_config()
    return electron_store
