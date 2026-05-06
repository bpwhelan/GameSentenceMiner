from __future__ import annotations

import math
from typing import Sequence


def ceil_to_multiple(value: float | int, multiple: int = 2) -> int:
    if multiple <= 0:
        raise ValueError("multiple must be greater than zero")
    return int(math.ceil(float(value) / float(multiple)) * multiple)


def floor_to_multiple(value: float | int, multiple: int = 2) -> int:
    if multiple <= 0:
        raise ValueError("multiple must be greater than zero")
    return int(math.floor(float(value) / float(multiple)) * multiple)


def ceil_to_even(value: float | int) -> int:
    return ceil_to_multiple(value, 2)


def scale_percentage_rectangle_to_even_pixels(
    coordinates: Sequence[float | int],
    width: int,
    height: int,
) -> list[int]:
    if len(coordinates) < 4:
        raise ValueError("coordinates must contain at least 4 values")

    return [
        ceil_to_even(float(coordinates[0]) * int(width)),
        ceil_to_even(float(coordinates[1]) * int(height)),
        ceil_to_even(float(coordinates[2]) * int(width)),
        ceil_to_even(float(coordinates[3]) * int(height)),
    ]


def logical_box_to_even_physical_box(
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    *,
    scale: float,
    max_width: int,
    max_height: int,
    multiple: int = 2,
) -> tuple[int, int, int, int]:
    if multiple <= 0:
        raise ValueError("multiple must be greater than zero")

    left = min(int(x1), int(x2))
    top = min(int(y1), int(y2))
    right = max(int(x1), int(x2))
    bottom = max(int(y1), int(y2))

    physical_left = ceil_to_multiple(left * float(scale), multiple)
    physical_top = ceil_to_multiple(top * float(scale), multiple)
    physical_right = ceil_to_multiple(right * float(scale), multiple)
    physical_bottom = ceil_to_multiple(bottom * float(scale), multiple)

    max_w = max(0, int(max_width))
    max_h = max(0, int(max_height))
    aligned_max_w = floor_to_multiple(max_w, multiple) if max_w >= multiple else max_w
    aligned_max_h = floor_to_multiple(max_h, multiple) if max_h >= multiple else max_h

    physical_left = min(max(0, physical_left), aligned_max_w)
    physical_top = min(max(0, physical_top), aligned_max_h)
    physical_right = min(max(0, physical_right), aligned_max_w)
    physical_bottom = min(max(0, physical_bottom), aligned_max_h)

    min_span_x = multiple if aligned_max_w >= multiple else 1
    min_span_y = multiple if aligned_max_h >= multiple else 1

    if physical_right <= physical_left:
        physical_right = min(aligned_max_w, physical_left + min_span_x)
    if physical_right <= physical_left:
        physical_left = max(0, physical_right - min_span_x)

    if physical_bottom <= physical_top:
        physical_bottom = min(aligned_max_h, physical_top + min_span_y)
    if physical_bottom <= physical_top:
        physical_top = max(0, physical_bottom - min_span_y)

    return (
        int(physical_left),
        int(physical_top),
        int(physical_right),
        int(physical_bottom),
    )
