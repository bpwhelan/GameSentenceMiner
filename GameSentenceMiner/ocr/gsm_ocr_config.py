import os
from copy import deepcopy
from dataclasses import dataclass
from math import floor, ceil
from pathlib import Path

from GameSentenceMiner import obs
from dataclasses_json import dataclass_json
from typing import List, Optional, Union

from GameSentenceMiner.util.configuration import logger, get_app_directory
from GameSentenceMiner.util.electron_config import get_ocr_use_window_for_config
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