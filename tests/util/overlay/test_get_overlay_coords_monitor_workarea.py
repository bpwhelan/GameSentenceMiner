from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

from GameSentenceMiner.ocr.gsm_ocr_config import OCRConfig, Monitor, Rectangle, WindowGeometry
from GameSentenceMiner.util.overlay import get_overlay_coords


class _FakeMSSContext:
    def __init__(self, monitors):
        self.monitors = monitors

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class _FakeMSSModule:
    def __init__(self, monitors):
        self._monitors = monitors

    def mss(self):
        return _FakeMSSContext(self._monitors)


def test_get_monitor_workarea_clamps_high_index_to_last_monitor(monkeypatch):
    fake_monitors = [
        {"left": 0, "top": 0, "width": 3200, "height": 1080},
        {"left": 0, "top": 0, "width": 1920, "height": 1080},
        {"left": 1920, "top": 0, "width": 1280, "height": 720},
    ]
    monkeypatch.setattr(get_overlay_coords, "mss", _FakeMSSModule(fake_monitors))

    processor = get_overlay_coords.OverlayProcessor()
    workarea = processor.get_monitor_workarea(999)

    assert workarea == {
        "left": 1920,
        "top": 0,
        "width": 1280,
        "height": 719,
    }


def test_get_monitor_workarea_clamps_negative_index_to_first_monitor(monkeypatch):
    fake_monitors = [
        {"left": 0, "top": 0, "width": 3840, "height": 2160},
        {"left": 0, "top": 0, "width": 1920, "height": 1080},
        {"left": 1920, "top": 0, "width": 1920, "height": 1080},
    ]
    monkeypatch.setattr(get_overlay_coords, "mss", _FakeMSSModule(fake_monitors))

    processor = get_overlay_coords.OverlayProcessor()
    workarea = processor.get_monitor_workarea(-5)

    assert workarea == {
        "left": 0,
        "top": 0,
        "width": 1920,
        "height": 1079,
    }


def test_get_monitor_workarea_falls_back_when_mss_missing(monkeypatch):
    monkeypatch.setattr(get_overlay_coords, "mss", None)
    monkeypatch.setattr(get_overlay_coords, "is_windows", lambda: False)

    processor = get_overlay_coords.OverlayProcessor()
    processor.ss_width = 1111
    processor.ss_height = 777

    workarea = processor.get_monitor_workarea(0)
    assert workarea == {
        "left": 0,
        "top": 0,
        "width": 1111,
        "height": 776,
    }


def test_oneocr_percentages_ignore_magpie_scaling():
    """Coordinate conversion should NOT map to Magpie destination.

    Text/interactive areas must appear at the original source window
    position, not the Magpie-scaled position.
    """
    processor = get_overlay_coords.OverlayProcessor()
    processor.last_monitor_left = 0
    processor.last_monitor_top = 0
    processor.calculated_width_scale_factor = 1.0
    processor.calculated_height_scale_factor = 1.0

    # Simulate Magpie being active
    class FakeMonitor:
        magpie_info = {
            "magpieWindowTopEdgePosition": 0,
            "magpieWindowBottomEdgePosition": 1440,
            "magpieWindowLeftEdgePosition": 0,
            "magpieWindowRightEdgePosition": 2560,
            "sourceWindowLeftEdgePosition": 620,
            "sourceWindowTopEdgePosition": 342,
            "sourceWindowRightEdgePosition": 1900,
            "sourceWindowBottomEdgePosition": 1062,
        }
        target_hwnd = None

    processor.window_monitor = FakeMonitor()

    # OCR result: a box at pixel (100, 100) in a 1280x720 source window
    # Window offset is (620, 342) - the source window position
    ocr_results = [
        {
            "text": "テスト",
            "bounding_rect": {"x1": 100.0, "y1": 100.0, "x3": 200.0, "y3": 150.0},
            "words": [],
        }
    ]

    result = processor._convert_oneocr_results_to_percentages(
        ocr_results,
        2560,
        1440,
        offset_x=620,
        offset_y=342,
    )

    # Expected: (100 + 620) / 2560 = 0.28125 for x1
    # If Magpie mapping were applied, x1 would be ~0.0 (mapped to dest origin)
    assert len(result) == 1
    box = result[0]["bounding_rect"]
    assert abs(box["x1"] - (100 + 620) / 2560) < 0.001
    assert abs(box["y1"] - (100 + 342) / 1440) < 0.001


def test_resolve_overlay_geometry_uses_unified_client_geometry(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    processor.window_monitor = SimpleNamespace(target_hwnd=123)

    monitor = {"left": 100, "top": 200, "width": 1920, "height": 1079}
    fake_user32 = SimpleNamespace(
        IsWindowVisible=lambda hwnd: True,
        IsIconic=lambda hwnd: False,
        GetClientRect=lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("expected unified window geometry helper instead of direct GetClientRect")
        ),
    )

    monkeypatch.setattr(get_overlay_coords, "is_windows", lambda: True)
    monkeypatch.setattr(
        get_overlay_coords,
        "get_overlay_config",
        lambda: SimpleNamespace(monitor_to_capture=0),
    )
    monkeypatch.setattr(processor, "get_monitor_workarea", lambda monitor_index: dict(monitor))
    monkeypatch.setattr(
        get_overlay_coords,
        "get_window_client_physical_geometry",
        lambda hwnd: (430, 560, 1280, 720),
        raising=False,
    )
    monkeypatch.setattr(get_overlay_coords, "user32", fake_user32)

    assert processor._resolve_overlay_geometry(800, 600) == (
        330,
        360,
        1280,
        720,
        1920,
        1079,
    )


def test_build_overlay_area_config_filters_primary_secondary_and_exclusions(
    monkeypatch,
):
    processor = get_overlay_coords.OverlayProcessor()
    source_config = OCRConfig(
        scene="scene",
        coordinate_system="percentage",
        rectangles=[
            Rectangle(
                monitor=Monitor(index=1),
                coordinates=[0, 0, 100, 20],
                is_excluded=False,
                is_secondary=False,
            ),
            Rectangle(
                monitor=Monitor(index=1),
                coordinates=[0, 30, 100, 20],
                is_excluded=False,
                is_secondary=True,
            ),
            Rectangle(
                monitor=Monitor(index=1),
                coordinates=[0, 60, 100, 20],
                is_excluded=True,
                is_secondary=False,
            ),
        ],
    )

    monkeypatch.setattr(
        get_overlay_coords,
        "get_overlay_config",
        lambda: SimpleNamespace(
            ocr_area_config_include_primary_areas=False,
            ocr_area_config_include_secondary_areas=True,
            ocr_area_config_use_exclusion_zones=False,
        ),
    )

    filtered = processor._build_overlay_area_config(deepcopy(source_config))

    assert [rect.is_secondary for rect in filtered.rectangles] == [True]
    assert [rect.is_excluded for rect in filtered.rectangles] == [False]


def test_build_overlay_area_config_defaults_to_existing_behavior(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    source_config = OCRConfig(
        scene="scene",
        coordinate_system="percentage",
        rectangles=[
            Rectangle(
                monitor=Monitor(index=1),
                coordinates=[0, 0, 100, 20],
                is_excluded=False,
                is_secondary=False,
            ),
            Rectangle(
                monitor=Monitor(index=1),
                coordinates=[0, 30, 100, 20],
                is_excluded=False,
                is_secondary=True,
            ),
            Rectangle(
                monitor=Monitor(index=1),
                coordinates=[0, 60, 100, 20],
                is_excluded=True,
                is_secondary=False,
            ),
        ],
    )

    monkeypatch.setattr(
        get_overlay_coords,
        "get_overlay_config",
        lambda: SimpleNamespace(),
    )

    filtered = processor._build_overlay_area_config(deepcopy(source_config))

    assert len(filtered.rectangles) == 3
    assert len(filtered.pre_scale_rectangles) == 3


def test_get_effective_overlay_area_config_prefers_dedicated_overlay_area(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    dedicated_config = OCRConfig(
        scene="scene",
        coordinate_system="percentage",
        rectangles=[
            Rectangle(
                monitor=Monitor(index=0),
                coordinates=[0.1, 0.2, 0.3, 0.4],
                is_excluded=False,
            )
        ],
    )

    monkeypatch.setattr(
        get_overlay_coords,
        "get_overlay_config",
        lambda: SimpleNamespace(use_overlay_area_config=True, use_ocr_area_config=True),
    )
    monkeypatch.setattr(processor, "_get_scaled_overlay_area_config", lambda width, height: dedicated_config)
    monkeypatch.setattr(
        processor,
        "_get_scaled_overlay_ocr_config",
        lambda width, height: (_ for _ in ()).throw(AssertionError("OCR area config should not be used")),
    )

    effective = processor._get_effective_overlay_area_config(1920, 1080)

    assert effective is dedicated_config


def test_get_effective_overlay_area_config_falls_back_to_ocr_area_config(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    ocr_config = OCRConfig(
        scene="scene",
        coordinate_system="percentage",
        rectangles=[
            Rectangle(
                monitor=Monitor(index=0),
                coordinates=[0.05, 0.1, 0.2, 0.25],
                is_excluded=False,
            )
        ],
    )

    monkeypatch.setattr(
        get_overlay_coords,
        "get_overlay_config",
        lambda: SimpleNamespace(use_overlay_area_config=True, use_ocr_area_config=True),
    )
    monkeypatch.setattr(processor, "_get_scaled_overlay_area_config", lambda width, height: None)
    monkeypatch.setattr(processor, "_get_scaled_overlay_ocr_config", lambda width, height: ocr_config)
    monkeypatch.setattr(processor, "_build_overlay_area_config", lambda config: config)

    effective = processor._get_effective_overlay_area_config(1920, 1080)

    assert effective is ocr_config


def test_get_scaled_overlay_area_config_uses_saved_window_geometry_without_hwnd(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    processor._last_overlay_capture_used_window_handle = False
    overlay_area_config = OCRConfig(
        scene="scene",
        coordinate_system="percentage",
        rectangles=[
            Rectangle(
                monitor=Monitor(index=0),
                coordinates=[0.1, 0.2, 0.3, 0.4],
                is_excluded=False,
            )
        ],
        window_geometry=WindowGeometry(left=300, top=200, width=1280, height=720),
    )

    monkeypatch.setattr(get_overlay_coords, "get_overlay_area_config", lambda: overlay_area_config)
    monkeypatch.setattr(
        get_overlay_coords,
        "get_overlay_config",
        lambda: SimpleNamespace(monitor_to_capture=0),
    )
    monkeypatch.setattr(
        processor,
        "get_monitor_workarea",
        lambda monitor_index: {"left": 100, "top": 50, "width": 1920, "height": 1079},
    )

    scaled = processor._get_scaled_overlay_area_config(1920, 1080)

    assert scaled is not None
    assert scaled.rectangles[0].coordinates == [328, 294, 384, 288]


def test_get_scaled_monitor_overlay_area_config_maps_into_window_capture(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    processor._last_overlay_capture_used_window_handle = True
    processor._last_overlay_capture_offset_x = 220
    processor._last_overlay_capture_offset_y = 140
    overlay_area_config = OCRConfig(
        scene="scene",
        coordinate_system="percentage",
        rectangles=[
            Rectangle(
                monitor=Monitor(index=0),
                coordinates=[0.2, 0.25, 0.1, 0.15],
                is_excluded=False,
            )
        ],
    )
    setattr(overlay_area_config, "overlay_coordinate_space", "monitor")

    monkeypatch.setattr(get_overlay_coords, "get_overlay_area_config", lambda: overlay_area_config)
    monkeypatch.setattr(
        get_overlay_coords,
        "get_overlay_config",
        lambda: SimpleNamespace(monitor_to_capture=0),
    )
    monkeypatch.setattr(
        processor,
        "get_monitor_workarea",
        lambda monitor_index: {"left": 0, "top": 0, "width": 1920, "height": 1079},
    )

    scaled = processor._get_scaled_overlay_area_config(1280, 720)

    assert scaled is not None
    assert scaled.rectangles[0].coordinates == [164, 129, 192, 161]
