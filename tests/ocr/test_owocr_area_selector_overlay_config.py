import json
from types import SimpleNamespace

import GameSentenceMiner.ocr.owocr_area_selector_qt as selector_module


def test_normalize_initial_draw_mode_accepts_recommendation_modes():
    assert selector_module.normalize_initial_draw_mode("secondary") == "secondary"
    assert selector_module.normalize_initial_draw_mode("black_hole") == "black_hole"
    assert selector_module.normalize_initial_draw_mode("unexpected") == "normal"
    assert selector_module.normalize_initial_draw_mode("black_hole", primary_only=True) == "normal"


def test_normal_draw_mode_keeps_modifier_hotkeys_enabled():
    selector = SimpleNamespace(
        drawing_excluded=True,
        drawing_secondary=True,
        drawing_exclusive=True,
        drawing_black_hole=True,
        menu_drawing_mode=True,
        _primary_only_mode=lambda: False,
    )

    selector_module.OWOCRAreaSelectorWidget.set_draw_mode(selector, "normal")

    assert selector.drawing_excluded is False
    assert selector.drawing_secondary is False
    assert selector.drawing_exclusive is False
    assert selector.drawing_black_hole is False
    assert selector.menu_drawing_mode is False


def test_recommended_draw_mode_stays_selected_across_drags():
    selector = SimpleNamespace(
        drawing_excluded=False,
        drawing_secondary=False,
        drawing_exclusive=False,
        drawing_black_hole=False,
        menu_drawing_mode=False,
        _primary_only_mode=lambda: False,
    )

    selector_module.OWOCRAreaSelectorWidget.set_draw_mode(selector, "secondary")

    assert selector.drawing_secondary is True
    assert selector.menu_drawing_mode is True


def test_load_existing_overlay_rectangles_translates_legacy_monitor_rects_to_window_coords(tmp_path, monkeypatch):
    overlay_config_path = tmp_path / "Scene_overlay.json"
    overlay_config_path.write_text(
        json.dumps(
            {
                "monitor_index": 0,
                "coordinate_system": "percentage",
                "rects": [
                    {
                        "x": 150 / 1920,
                        "y": 250 / 1080,
                        "w": 400 / 1920,
                        "h": 120 / 1080,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(selector_module, "get_ocr_config_path", lambda: str(tmp_path))

    selector = SimpleNamespace(
        scene="Scene",
        rectangles=[],
        undo_stack=[],
        select_monitor_area=False,
        target_monitor_index=0,
        monitor_geometry=None,
        screenshot_img=SimpleNamespace(width=1280, height=720),
        scale_factor_w=1.0,
        scale_factor_h=1.0,
        bounding_box_original={"left": 100, "top": 200, "width": 1280, "height": 720},
        target_window_geometry={"left": 100, "top": 200, "width": 1280, "height": 720},
        _resolve_monitor_geometry_for_index=lambda _index: {
            "index": 0,
            "left": 0,
            "top": 0,
            "width": 1920,
            "height": 1080,
        },
    )

    selector_module.OWOCRAreaSelectorWidget._load_existing_overlay_rectangles(selector)

    assert selector.rectangles == [
        {
            "x": 50,
            "y": 50,
            "w": 400,
            "h": 120,
            "monitor_index": 0,
            "is_excluded": False,
            "is_exclusive": False,
            "is_secondary": False,
            "is_black_hole": False,
        }
    ]
