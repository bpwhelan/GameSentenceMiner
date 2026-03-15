from __future__ import annotations

from types import SimpleNamespace

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
            AssertionError(
                "expected unified window geometry helper instead of direct GetClientRect"
            )
        ),
    )

    monkeypatch.setattr(get_overlay_coords, "is_windows", lambda: True)
    monkeypatch.setattr(
        get_overlay_coords,
        "get_overlay_config",
        lambda: SimpleNamespace(monitor_to_capture=0),
    )
    monkeypatch.setattr(
        processor, "get_monitor_workarea", lambda monitor_index: dict(monitor)
    )
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
