import ctypes
from dataclasses import dataclass
from math import floor, ceil

from dataclasses_json import dataclass_json
from typing import List, Optional, Union


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
                window = gw.getWindowsWithTitle(self.window)[0]
                self.window_geometry = WindowGeometry(
                    left=window.left,
                    top=window.top,
                    width=window.width,
                    height=window.height,
                )
                print(f"Window '{self.window}' found with geometry: {self.window_geometry}")
            except IndexError:
                raise ValueError(f"Window with title '{self.window}' not found.")
            for rectangle in self.rectangles:
                rectangle.coordinates = [
                    ceil(rectangle.coordinates[0] * self.window_geometry.width),
                    ceil(rectangle.coordinates[1] * self.window_geometry.height),
                    ceil(rectangle.coordinates[2] * self.window_geometry.width),
                    ceil(rectangle.coordinates[3] * self.window_geometry.height),
                ]

# try w10+, fall back to w8.1+
def set_dpi_awareness():
    per_monitor_awareness = 2
    ctypes.windll.shcore.SetProcessDpiAwareness(per_monitor_awareness)
