from types import SimpleNamespace

from PIL import Image

from GameSentenceMiner.owocr.owocr import ocr as ocr_module
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
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_config)

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


def test_check_text_is_all_menu_accepts_four_value_crop_coords(monkeypatch):
    menu_rectangles = [SimpleNamespace(is_secondary=True, coordinates=(0, 0, 100, 100))]
    fake_config = SimpleNamespace(rectangles=menu_rectangles)

    monkeypatch.setattr(
        run_module,
        "obs_screenshot_thread",
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_config)

    crop_coords_list = [
        (5, 5, 95, 95),
    ]

    assert run_module.check_text_is_all_menu(
        (5, 5, 95, 95),
        crop_coords_list,
        crop_offset=(0, 0),
    )


def test_build_text_detection_result_includes_per_box_crop_coords():
    success, text, coords, crop_coords_list, crop_coords, response_dict = ocr_module._build_text_detection_result(
        "meiki_text_detector",
        [
            {"box": [10, 10, 90, 90], "score": 0.9},
            {"box": [210, 10, 290, 90], "score": 0.8},
        ],
        img_width=300,
        img_height=100,
        crop_padding=5,
    )

    assert success is True
    assert text == ""
    assert coords == []
    assert crop_coords_list == [(5, 5, 95, 95), (205, 5, 295, 95)]
    assert crop_coords == (5, 5, 295, 95)
    assert response_dict["crop_coords_list"] == [[5, 5, 95, 95], [205, 5, 295, 95]]


def test_process_and_write_results_skips_detector_payload_when_all_boxes_are_menu(monkeypatch):
    menu_rectangles = [
        SimpleNamespace(is_secondary=True, coordinates=(0, 0, 100, 100)),
        SimpleNamespace(is_secondary=True, coordinates=(200, 0, 100, 100)),
    ]
    fake_area_config = SimpleNamespace(rectangles=menu_rectangles)

    class FakeDetector:
        name = "meiki_text_detector"
        readable_name = "Meiki Text Detector"

        def __call__(self, img, furigana_filter_sensitivity=0):
            return ocr_module._build_text_detection_result(
                self.name,
                [
                    {"box": [10, 10, 90, 90], "score": 0.9},
                    {"box": [210, 10, 290, 90], "score": 0.8},
                ],
                img_width=300,
                img_height=100,
                crop_padding=5,
            )

    callback_calls = []

    monkeypatch.setattr(
        run_module,
        "config",
        SimpleNamespace(get_general=lambda key: {"engine_color": "cyan", "notifications": False}.get(key)),
    )
    monkeypatch.setattr(
        run_module,
        "logger",
        SimpleNamespace(opt=lambda **kwargs: SimpleNamespace(info=lambda *args, **kwargs: None)),
    )
    monkeypatch.setattr(run_module, "engine_instances", [FakeDetector()], raising=False)
    monkeypatch.setattr(run_module, "auto_pause_handler", None, raising=False)
    monkeypatch.setattr(
        run_module,
        "txt_callback",
        lambda *args, **kwargs: callback_calls.append({"args": args, "kwargs": kwargs}),
        raising=False,
    )
    monkeypatch.setattr(
        run_module,
        "obs_screenshot_thread",
        SimpleNamespace(width=300, height=100),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_area_config)

    orig_text, text = run_module.process_and_write_results(
        Image.new("RGB", (300, 100), color=0),
        "callback",
        None,
        None,
        None,
        engine="meiki_text_detector",
    )

    assert (orig_text, text) == ("", "")
    assert callback_calls == []
