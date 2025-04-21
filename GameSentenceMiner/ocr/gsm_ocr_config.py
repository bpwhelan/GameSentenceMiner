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