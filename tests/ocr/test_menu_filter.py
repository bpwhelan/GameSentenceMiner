from types import SimpleNamespace

from GameSentenceMiner.owocr.owocr import run as run_module


def test_check_text_is_all_menu_uses_crop_coords_list_over_union_box(monkeypatch):
    # Two separate secondary/menu rectangles.
    menu_rectangles = [
        SimpleNamespace(is_secondary=True, coordinates=(0, 0, 100, 100)),
        SimpleNamespace(is_secondary=True, coordinates=(200, 0, 100, 100)),
    ]
    fake_config = SimpleNamespace(rectangles=menu_rectangles)

    # Fake screenshot source dimensions consumed by the menu-check helper.
    monkeypatch.setattr(
        run_module,
        "obs_screenshot_thread",
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(
        run_module, "get_scaled_scene_ocr_config", lambda *_: fake_config
    )

    # Individual boxes are each fully inside one secondary rectangle.
    # Values include the +5/-5 padding expectation in check_text_is_all_menu.
    crop_coords_list = [
        (5, 5, 95, 95, "A"),
        (205, 5, 295, 95, "B"),
    ]

    # Union box spans across non-menu space and should NOT be used when list is available.
    crop_coords_union = (5, 5, 295, 95)

    assert run_module.check_text_is_all_menu(
        crop_coords_union,
        crop_coords_list,
        crop_offset=(0, 0),
    )
