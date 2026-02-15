import json
import mss
import os
from copy import deepcopy
from dataclasses import dataclass
from dataclasses_json import dataclass_json
from math import floor, ceil
from pathlib import Path
from typing import List, Optional, Union

from GameSentenceMiner import obs
from GameSentenceMiner.util.config.configuration import logger, get_app_directory
from GameSentenceMiner.util.config.electron_config import get_ocr_use_window_for_config
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
            import pygetwindow as gw
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
                rectangle.coordinates = [
                    ceil(rectangle.coordinates[0] * self.window_geometry.width),
                    ceil(rectangle.coordinates[1] * self.window_geometry.height),
                    ceil(rectangle.coordinates[2] * self.window_geometry.width),
                    ceil(rectangle.coordinates[3] * self.window_geometry.height),
                ]

    def scale_to_custom_size(self, width, height):
        self.rectangles = deepcopy(self.pre_scale_rectangles)
        if self.coordinate_system and self.coordinate_system == "percentage":
            for rectangle in self.rectangles:
                rectangle.coordinates = [
                    floor(rectangle.coordinates[0] * width),
                    floor(rectangle.coordinates[1] * height),
                    floor(rectangle.coordinates[2] * width),
                    floor(rectangle.coordinates[3] * height),
                ]
                
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
    import sys
    if sys.platform != "win32":
        return
    import ctypes
    per_monitor_awareness = 2
    ctypes.windll.shcore.SetProcessDpiAwareness(per_monitor_awareness)
    
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
    ocr_config_dir = get_ocr_config_path()
    try:
        if use_window_as_config:
            scene = sanitize_filename(window)
        else:
            scene = sanitize_filename(obs.get_current_scene() or "Default")
    except Exception as e:
        print(f"Error getting OBS scene: {e}. Using default config name.")
        scene = "Default"
    return os.path.join(ocr_config_dir, f"{scene}.json")

def get_ocr_config_path():
    ocr_config_dir = os.path.join(get_app_directory(), "ocr_config")
    os.makedirs(ocr_config_dir, exist_ok=True)
    return ocr_config_dir


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
        with open(config_path, 'w', encoding="utf-8") as f:
            json.dump(ocr_config.to_dict(), f, indent=4)
        return ocr_config
    try:
        with open(config_path, 'r', encoding="utf-8") as f:
            config_data = json.load(f)
        if "rectangles" in config_data and isinstance(config_data["rectangles"], list) and all(
                isinstance(item, list) and len(item) == 4 for item in config_data["rectangles"]):
            # Old config format, convert to new
            new_rectangles = []
            with mss.mss() as sct:
                monitors = sct.monitors
                default_monitor = monitors[1] if len(monitors) > 1 else monitors[0]
                for rect in config_data["rectangles"]:
                    new_rectangles.append({
                        "monitor": {
                            "left": default_monitor["left"],
                            "top": default_monitor["top"],
                            "width": default_monitor["width"],
                            "height": default_monitor["height"],
                            "index": 0  # Assuming single monitor for old config
                        },
                        "coordinates": rect,
                        "is_excluded": False
                    })
                if 'excluded_rectangles' in config_data:
                    for rect in config_data['excluded_rectangles']:
                        new_rectangles.append({
                            "monitor": {
                                "left": default_monitor["left"],
                                "top": default_monitor["top"],
                                "width": default_monitor["width"],
                                "height": default_monitor["height"],
                                "index": 0  # Assuming single monitor for old config
                            },
                            "coordinates": rect,
                            "is_excluded": True
                        })
            new_config_data = {"scene": config_data.get("scene", scene), "window": config_data.get("window", None),
                               "rectangles": new_rectangles, "coordinate_system": "absolute"}
            with open(config_path, 'w', encoding="utf-8") as f:
                json.dump(new_config_data, f, indent=4)
            return OCRConfig.from_dict(new_config_data)
        elif "rectangles" in config_data and isinstance(config_data["rectangles"], list) and all(
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
