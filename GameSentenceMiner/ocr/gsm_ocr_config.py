import ctypes
from dataclasses import dataclass
from math import floor, ceil

from dataclasses_json import dataclass_json
from typing import List, Optional, Union

from GameSentenceMiner.util.configuration import logger


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
    coordinate_system: str = None
    window_geometry: Optional[WindowGeometry] = None
    window: Optional[str] = None
    language: str = "ja"

    def __post_init__(self):
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

def get_window(title):
    import pygetwindow as gw
    windows = gw.getWindowsWithTitle(title)
    if not windows:
        raise ValueError(f"No windows found with title '{title}'.")
    ret = None
    if windows:
        for window in windows:
            if "cmd.exe" in window.title.lower():
                logger.info(f"Skipping cmd.exe window with title: {window.title}")
                continue
            if len(windows) > 1:
                logger.info(
                    f"Warning: More than 1 window with title, Window Title: {window.title}, Geometry: {window.left}, {window.top}, {window.width}, {window.height}")
            if window.title == title:
                if window.isMinimized or not window.visible:
                    logger.info(f"Warning: Window '{title}' is minimized. Attempting to restore it.")
                    window.restore()
                return window
    return ret

# try w10+, fall back to w8.1+
def set_dpi_awareness():
    per_monitor_awareness = 2
    ctypes.windll.shcore.SetProcessDpiAwareness(per_monitor_awareness)
