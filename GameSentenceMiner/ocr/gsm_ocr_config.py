import json
import os
import shutil
from copy import deepcopy
from dataclasses import dataclass
from dataclasses_json import dataclass_json
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Union

from GameSentenceMiner import obs
from GameSentenceMiner.ocr.coordinate_math import scale_percentage_rectangle_to_even_pixels
from GameSentenceMiner.util.config.configuration import logger, get_app_directory
from GameSentenceMiner.util.config.electron_config import (
    get_ocr_use_window_for_config,
    get_ocr_default_scene_furigana_filter_sensitivity,
)
from GameSentenceMiner.util.platform.windows_dpi import enable_per_monitor_v2_dpi_awareness
from GameSentenceMiner.util.gsm_utils import sanitize_filename


@dataclass_json
@dataclass
class Monitor:
    index: int
    left: Optional[int] = None
    top: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None

# @dataclass_json
# @dataclass
# class Coordinates:
#     coordinates: List[Union[float, int]]
#     coordinate_system: str = None

@dataclass_json
@dataclass
class Rectangle:
    monitor: Monitor
    coordinates: List[Union[float, int]]
    is_excluded: bool
    is_secondary: bool = False

@dataclass_json
@dataclass
class WindowGeometry:
    left: int
    top: int
    width: int
    height: int
    
    
@dataclass_json
@dataclass
class OCRConfig:
    scene: str
    rectangles: List[Rectangle]
    pre_scale_rectangles: Optional[List[Rectangle]] = None
    coordinate_system: str = None
    window_geometry: Optional[WindowGeometry] = None
    window: Optional[str] = None
    language: str = "ja"

    def __post_init__(self):
        self.pre_scale_rectangles = deepcopy(self.rectangles)

    def scale_coords(self):
        if self.coordinate_system and self.coordinate_system == "percentage" and self.window:
            try:
                set_dpi_awareness()
                window = get_window(self.window)
                self.window_geometry = WindowGeometry(
                    left=window.left,
                    top=window.top,
                    width=window.width,
                    height=window.height,
                )
                logger.info(f"Window '{self.window}' found with geometry: {self.window_geometry}")
            except IndexError:
                raise ValueError(f"Window with title '{self.window}' not found.")
            for rectangle in self.rectangles:
                rectangle.coordinates = scale_percentage_rectangle_to_even_pixels(
                    rectangle.coordinates,
                    self.window_geometry.width,
                    self.window_geometry.height,
                )

    def scale_to_custom_size(self, width, height):
        self.rectangles = deepcopy(self.pre_scale_rectangles)
        if self.coordinate_system and self.coordinate_system == "percentage":
            for rectangle in self.rectangles:
                rectangle.coordinates = scale_percentage_rectangle_to_even_pixels(
                    rectangle.coordinates,
                    width,
                    height,
                )
                
def has_config_changed(current_config: OCRConfig) -> bool:
    new_config = get_scene_ocr_config(use_window_as_config=get_ocr_use_window_for_config(), window=current_config.window, refresh=True)
    if new_config.rectangles != current_config.rectangles:
        logger.info("OCR config has changed.")
        return True
    return False


def get_window(title):
    import pygetwindow as gw
    all_windows = gw.getWindowsWithTitle(title)
    if not all_windows:
        return None

    filtered_windows = []
    for window in all_windows:
        if "cmd.exe" in window.title.lower():
            logger.info(f"Skipping cmd.exe window with title: {window.title}")
            continue
        filtered_windows.append(window)

    if not filtered_windows:
        return None

    ret = None
    for window in filtered_windows:
        if len(filtered_windows) > 1:
            logger.info(
                f"Warning: More than 1 non-cmd.exe window with title, Window Title: {window.title}, Geometry: {window.left}, {window.top}, {window.width}, {window.height}")

        if window.title.strip() == title.strip():
            if window.isMinimized or not window.visible:
                logger.info(f"Warning: Window '{title}' is minimized or not visible. Attempting to restore it.")
                window.restore()
            return window
    return ret

# if windows, set dpi awareness to per-monitor v2
def set_dpi_awareness():
    enable_per_monitor_v2_dpi_awareness()
    
scene_ocr_config = None

def get_scene_ocr_config(use_window_as_config=False, window="", refresh=False) -> OCRConfig | None:
    global scene_ocr_config
    if scene_ocr_config and not refresh:
        return scene_ocr_config
    path = get_scene_ocr_config_path(use_window_as_config, window)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        from json import load
        data = load(f)
        ocr_config = OCRConfig.from_dict(data)
        scene_ocr_config = ocr_config
        return ocr_config

def get_scene_ocr_config_path(use_window_as_config=False, window=""):
    scene = _resolve_scene_name(use_window_as_config, window)
    return os.path.join(get_ocr_config_path(), f"{scene}.json")

def get_ocr_config_path():
    ocr_config_dir = os.path.join(get_app_directory(), "ocr_config")
    os.makedirs(ocr_config_dir, exist_ok=True)
    return ocr_config_dir


# ---------------------------------------------------------------------------
# Per-scene settings  ({scene}_config.json)
# Lives alongside {scene}.json but only stores lightweight settings, not areas.
# ---------------------------------------------------------------------------

def get_scene_settings_defaults() -> dict:
    return {
        "furigana_filter_sensitivity": get_ocr_default_scene_furigana_filter_sensitivity(),
    }


def _resolve_scene_name(use_window_as_config=False, window=""):
    """Resolve the sanitized scene name used for config file paths."""
    try:
        if use_window_as_config:
            return sanitize_filename(window)
        return sanitize_filename(obs.get_current_scene() or "Default")
    except Exception as e:
        logger.debug(f"Error resolving scene name: {e}. Using 'Default'.")
        return "Default"


def get_scene_settings_path(use_window_as_config=False, window=""):
    """Return the path to {scene}_config.json."""
    scene = _resolve_scene_name(use_window_as_config, window)
    return os.path.join(get_ocr_config_path(), f"{scene}_config.json")


def read_scene_settings(use_window_as_config=False, window="") -> dict:
    """Read per-scene settings. Returns defaults merged with any saved values."""
    settings_path = get_scene_settings_path(use_window_as_config, window)
    result = get_scene_settings_defaults()
    if not os.path.exists(settings_path):
        return result
    try:
        with open(settings_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        result.update(data)
    except Exception as e:
        logger.warning(f"Failed to read scene settings from {settings_path}: {e}")
    return result


def write_scene_settings(settings: dict, use_window_as_config=False, window="") -> None:
    """Merge *settings* into the per-scene config and write it."""
    current = read_scene_settings(use_window_as_config, window)
    current.update(settings)
    settings_path = get_scene_settings_path(use_window_as_config, window)
    try:
        with open(settings_path, 'w', encoding='utf-8') as f:
            json.dump(current, f, indent=2)
        logger.debug(f"Wrote scene settings to {settings_path}")
    except Exception as e:
        logger.warning(f"Failed to write scene settings to {settings_path}: {e}")


def get_scene_furigana_filter_sensitivity(use_window_as_config=False, window="") -> int:
    """Convenience: read furigana_filter_sensitivity for the current scene."""
    settings = read_scene_settings(use_window_as_config, window)
    try:
        return int(settings.get("furigana_filter_sensitivity", 0))
    except (TypeError, ValueError):
        return 0


def write_ocr_config(config_path, config_data: dict) -> None:
    """
    The single authoritative write function for OCR scene configs.
    Creates a dated backup in ocr_config/backup/<scene>/ before overwriting.
    """
    config_path = Path(config_path)
    if config_path.exists():
        try:
            scene_name = config_path.stem
            backup_dir = config_path.parent / "backup" / scene_name
            backup_dir.mkdir(parents=True, exist_ok=True)
            date_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            backup_path = backup_dir / f"{scene_name}_{date_str}.json"
            shutil.copy2(config_path, backup_path)
            logger.debug(f"Backed up OCR config to {backup_path}")
        except Exception as e:
            logger.warning(f"Failed to create OCR config backup: {e}")
    with open(config_path, 'w', encoding='utf-8') as f:
        json.dump(config_data, f, indent=2)
    logger.info(f"Wrote OCR config to {config_path}")


def get_ocr_config(window=None, use_window_for_config=False) -> OCRConfig:
    """Loads and updates screen capture areas from the corresponding JSON file."""
    ocr_config_dir = get_ocr_config_path()
    obs.update_current_game()
    if use_window_for_config and window:
        scene = sanitize_filename(window)
    else:
        scene = sanitize_filename(obs.get_current_scene())
    config_path = Path(ocr_config_dir) / f"{scene}.json"
    if not config_path.exists():
        ocr_config = OCRConfig(scene=scene, window=window, rectangles=[], coordinate_system="percentage")
        write_ocr_config(config_path, ocr_config.to_dict())
        return ocr_config
    try:
        with open(config_path, 'r', encoding="utf-8") as f:
            config_data = json.load(f)
        if "rectangles" in config_data and isinstance(config_data["rectangles"], list) and all(
                isinstance(item, dict) and "coordinates" in item for item in config_data["rectangles"]):
            return OCRConfig.from_dict(config_data)
        else:
            raise Exception(f"Invalid config format in {config_path}.")
    except json.JSONDecodeError:
        print("Error decoding JSON. Please check your config file.")
        return None
    except Exception as e:
        print(f"Error loading config: {e}")
        return None
