from PyQt6.QtCore import QRect, QSize

from GameSentenceMiner.ocr.owocr_area_selector_qt import (
    _fit_selector_window_to_available_geometry,
    _size_reaches_available_geometry,
)


def test_selector_window_fit_reserves_toolbar_inside_work_area():
    available = QRect(0, 0, 2560, 1392)

    width, height = _fit_selector_window_to_available_geometry(
        image_width=2560,
        image_height=1364,
        toolbar_height=40,
        available_geometry=available,
    )

    assert width <= int(available.width() * 0.98)
    assert height <= int(available.height() * 0.98)
    assert height == 40 + round((width / 2560) * 1364)


def test_selector_window_fit_does_not_enlarge_smaller_capture():
    assert _fit_selector_window_to_available_geometry(
        image_width=1280,
        image_height=720,
        toolbar_height=40,
        available_geometry=QRect(0, 0, 1920, 1040),
    ) == (1280, 760)


def test_maximize_sized_resize_reaches_available_geometry_with_frame_tolerance():
    available = QRect(0, 0, 2560, 1392)

    assert _size_reaches_available_geometry(QSize(2540, 1350), available)
    assert not _size_reaches_available_geometry(QSize(2200, 1200), available)
