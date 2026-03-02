from GameSentenceMiner.ocr.coordinate_math import (
    ceil_to_even,
    logical_box_to_even_physical_box,
    scale_percentage_rectangle_to_even_pixels,
)


def test_scale_percentage_rectangle_to_even_pixels_rounds_up():
    coords = scale_percentage_rectangle_to_even_pixels([0.101, 0.255, 0.504, 0.333], 101, 99)
    assert coords == [12, 26, 52, 34]
    assert all(value % 2 == 0 for value in coords)


def test_logical_box_to_even_physical_box_keeps_even_and_in_bounds():
    box = logical_box_to_even_physical_box(
        1,
        3,
        9,
        11,
        scale=1.25,
        max_width=19,
        max_height=23,
    )

    assert box == (2, 4, 12, 14)
    assert all(value % 2 == 0 for value in box)


def test_logical_box_to_even_physical_box_handles_edge_clamping():
    box = logical_box_to_even_physical_box(
        15,
        17,
        19,
        23,
        scale=1.0,
        max_width=19,
        max_height=23,
    )

    assert box == (16, 18, 18, 22)
    assert all(value % 2 == 0 for value in box)


def test_logical_box_to_even_physical_box_repairs_collapsed_span():
    box = logical_box_to_even_physical_box(
        1,
        1,
        1,
        1,
        scale=1.0,
        max_width=20,
        max_height=20,
    )

    assert box == (2, 2, 4, 4)
    assert box[2] > box[0]
    assert box[3] > box[1]
    assert all(value % 2 == 0 for value in box)


def test_ceil_to_even_always_rounds_up():
    assert ceil_to_even(0) == 0
    assert ceil_to_even(1) == 2
    assert ceil_to_even(2) == 2
    assert ceil_to_even(2.01) == 4
