from dataclasses import dataclass
from dataclasses_json import dataclass_json
from typing import List, Optional

@dataclass_json
@dataclass
class Monitor:
    left: int
    top: int
    width: int
    height: int
    index: int

@dataclass_json
@dataclass
class Rectangle:
    monitor: Monitor
    coordinates: List[int]
    is_excluded: bool

@dataclass_json
@dataclass
class OCRConfig:
    scene: str
    rectangles: List[Rectangle]
    window: Optional[str] = None

# Example of how you might use from_dict (assuming you have a dictionary called 'data')
data = {
    "scene": "CODEVEIN",
    "window": "CODE VEIN",
    "rectangles": [
        {
            "monitor": {"left": 0, "top": 0, "width": 2560, "height": 1440, "index": 0},
            "coordinates": [749, 1178, 1100, 147],
            "is_excluded": False,
        }
    ],
}

config = OCRConfig.from_dict(data)
print(config)