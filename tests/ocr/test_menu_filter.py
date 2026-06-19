from types import SimpleNamespace

from PIL import Image

from GameSentenceMiner.owocr.owocr import ocr as ocr_module
from GameSentenceMiner.owocr.owocr import ocr_runtime as run_module


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


def test_exclusive_ocr_area_filter_keeps_only_lines_inside_exclusive_rectangles(monkeypatch):
    rectangles = [
        SimpleNamespace(is_secondary=False, is_excluded=False, is_exclusive=False, coordinates=(0, 0, 100, 100)),
        SimpleNamespace(is_secondary=False, is_excluded=False, is_exclusive=True, coordinates=(200, 0, 100, 100)),
    ]
    fake_config = SimpleNamespace(rectangles=rectangles)

    monkeypatch.setattr(
        run_module,
        "obs_screenshot_thread",
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_config)

    coords = [
        {
            "text": "outside",
            "bounding_rect": {"x1": 10, "y1": 10, "x2": 90, "y2": 10, "x3": 90, "y3": 90, "x4": 10, "y4": 90},
        },
        {
            "text": "inside",
            "bounding_rect": {"x1": 210, "y1": 10, "x2": 290, "y2": 10, "x3": 290, "y3": 90, "x4": 210, "y4": 90},
        },
    ]
    crop_coords_list = [(5, 5, 95, 95, "outside"), (205, 5, 295, 95, "inside")]

    text, filtered_coords, filtered_crop_coords_list, crop_coords, raw_response_dict, applied = (
        run_module.apply_exclusive_ocr_area_filter(
            "outside\ninside",
            coords,
            crop_coords_list,
            (5, 5, 295, 95),
            {"lines": coords},
            crop_offset=(0, 0),
        )
    )

    assert applied is True
    assert text == "inside"
    assert filtered_coords == [coords[1]]
    assert filtered_crop_coords_list == [crop_coords_list[1]]
    assert crop_coords == (205, 5, 295, 95)
    assert raw_response_dict is None


def test_exclusive_ocr_area_filter_leaves_text_when_no_exclusive_text_found(monkeypatch):
    rectangles = [
        SimpleNamespace(is_secondary=False, is_excluded=False, is_exclusive=True, coordinates=(200, 0, 100, 100)),
    ]
    fake_config = SimpleNamespace(rectangles=rectangles)

    monkeypatch.setattr(
        run_module,
        "obs_screenshot_thread",
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_config)

    crop_coords_list = [(5, 5, 95, 95, "outside")]

    text, coords, filtered_crop_coords_list, crop_coords, raw_response_dict, applied = (
        run_module.apply_exclusive_ocr_area_filter(
            "outside",
            [],
            crop_coords_list,
            (5, 5, 95, 95),
            {"lines": []},
            crop_offset=(0, 0),
        )
    )

    assert applied is False
    assert text == "outside"
    assert coords == []
    assert filtered_crop_coords_list == crop_coords_list
    assert crop_coords == (5, 5, 95, 95)
    assert raw_response_dict == {"lines": []}


def test_check_text_is_in_black_hole_matches_any_detected_text_box(monkeypatch):
    rectangles = [
        SimpleNamespace(
            is_secondary=False,
            is_excluded=False,
            is_exclusive=False,
            is_black_hole=True,
            coordinates=(0, 0, 100, 100),
        ),
        SimpleNamespace(
            is_secondary=False,
            is_excluded=False,
            is_exclusive=True,
            is_black_hole=False,
            coordinates=(200, 0, 100, 100),
        ),
    ]
    fake_config = SimpleNamespace(rectangles=rectangles)

    monkeypatch.setattr(
        run_module,
        "obs_screenshot_thread",
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_config)

    crop_coords_list = [(5, 5, 95, 95, "void"), (205, 5, 295, 95, "exclusive")]

    assert run_module.check_text_is_in_black_hole(
        (5, 5, 295, 95),
        crop_coords_list,
        crop_offset=(0, 0),
    )


def test_check_text_is_in_black_hole_ignores_disjoint_box(monkeypatch):
    rectangles = [
        SimpleNamespace(
            is_secondary=False,
            is_excluded=False,
            is_exclusive=False,
            is_black_hole=True,
            coordinates=(0, 0, 100, 100),
        ),
    ]
    fake_config = SimpleNamespace(rectangles=rectangles)

    monkeypatch.setattr(
        run_module,
        "obs_screenshot_thread",
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_config)

    crop_coords_list = [(105, 5, 145, 95, "outside")]

    assert not run_module.check_text_is_in_black_hole(
        (105, 5, 145, 95),
        crop_coords_list,
        crop_offset=(0, 0),
    )


def test_check_text_is_in_black_hole_matches_box_overlap(monkeypatch):
    rectangles = [
        SimpleNamespace(
            is_secondary=False,
            is_excluded=False,
            is_exclusive=False,
            is_black_hole=True,
            coordinates=(0, 0, 100, 100),
        ),
    ]
    fake_config = SimpleNamespace(rectangles=rectangles)

    monkeypatch.setattr(
        run_module,
        "obs_screenshot_thread",
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_config)

    crop_coords_list = [(5, 5, 205, 95, "line overlaps black hole")]

    assert run_module.check_text_is_in_black_hole(
        (5, 5, 205, 95),
        crop_coords_list,
        crop_offset=(0, 0),
    )


def test_check_text_is_in_black_hole_skips_out_of_bounds_box(monkeypatch):
    # A near-edge / out-of-frame box (e.g. a reconstructed ScreenAI line) must not
    # abort the whole-frame check; a later in-frame line in the black hole still hits.
    rectangles = [
        SimpleNamespace(
            is_secondary=False,
            is_excluded=False,
            is_exclusive=False,
            is_black_hole=True,
            coordinates=(0, 0, 100, 100),
        ),
    ]
    fake_config = SimpleNamespace(rectangles=rectangles)

    monkeypatch.setattr(
        run_module,
        "obs_screenshot_thread",
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_config)

    crop_coords_list = [
        (5, 5, 405, 95, "out of bounds"),  # box_right > width
        (5, 5, 95, 95, "void"),  # inside the black hole
    ]

    assert run_module.check_text_is_in_black_hole(
        (5, 5, 405, 95),
        crop_coords_list,
        crop_offset=(0, 0),
    )


def test_process_and_write_results_skips_black_hole_before_exclusive_filter(monkeypatch):
    rectangles = [
        SimpleNamespace(
            is_secondary=False,
            is_excluded=False,
            is_exclusive=False,
            is_black_hole=True,
            coordinates=(0, 0, 100, 100),
        ),
        SimpleNamespace(
            is_secondary=False,
            is_excluded=False,
            is_exclusive=True,
            is_black_hole=False,
            coordinates=(200, 0, 100, 100),
        ),
    ]
    fake_area_config = SimpleNamespace(rectangles=rectangles)

    class FakeOCR:
        name = "fakeocr"
        readable_name = "Fake OCR"

        def __call__(self, img, furigana_filter_sensitivity=0):
            return (
                True,
                "void\nexclusive",
                [],
                [(5, 5, 95, 95, "void"), (205, 5, 295, 95, "exclusive")],
                (5, 5, 295, 95),
                None,
            )

    callback_calls = []
    log_messages = []

    monkeypatch.setattr(
        run_module,
        "config",
        SimpleNamespace(get_general=lambda key: {"engine_color": "cyan", "notifications": False}.get(key)),
    )
    monkeypatch.setattr(
        run_module,
        "logger",
        SimpleNamespace(
            opt=lambda **kwargs: SimpleNamespace(info=lambda message, *args, **kwargs: log_messages.append(message))
        ),
    )
    monkeypatch.setattr(run_module, "engine_instances", [FakeOCR()], raising=False)
    monkeypatch.setattr(run_module, "engine_index", 0, raising=False)
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
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_area_config)

    orig_text, text = run_module.process_and_write_results(
        Image.new("RGB", (400, 300), color=0),
        "callback",
        None,
        None,
        None,
    )

    assert (orig_text, text) == ("", "")
    assert callback_calls == []
    assert run_module.BLACK_HOLE_SKIP_LOG_MESSAGE in log_messages


def test_process_and_write_results_skips_detector_black_hole_before_exclusive_filter(monkeypatch):
    rectangles = [
        SimpleNamespace(
            is_secondary=False,
            is_excluded=False,
            is_exclusive=False,
            is_black_hole=True,
            coordinates=(0, 0, 100, 100),
        ),
        SimpleNamespace(
            is_secondary=False,
            is_excluded=False,
            is_exclusive=True,
            is_black_hole=False,
            coordinates=(200, 0, 100, 100),
        ),
    ]
    fake_area_config = SimpleNamespace(rectangles=rectangles)

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
                img_width=400,
                img_height=300,
                crop_padding=5,
            )

    callback_calls = []
    log_messages = []

    monkeypatch.setattr(
        run_module,
        "config",
        SimpleNamespace(get_general=lambda key: {"engine_color": "cyan", "notifications": False}.get(key)),
    )
    monkeypatch.setattr(
        run_module,
        "logger",
        SimpleNamespace(
            opt=lambda **kwargs: SimpleNamespace(info=lambda message, *args, **kwargs: log_messages.append(message))
        ),
    )
    monkeypatch.setattr(run_module, "engine_instances", [FakeDetector()], raising=False)
    monkeypatch.setattr(run_module, "engine_index", 0, raising=False)
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
        SimpleNamespace(width=400, height=300),
        raising=False,
    )
    monkeypatch.setattr(run_module, "get_scaled_scene_ocr_config", lambda *_: fake_area_config)

    orig_text, text = run_module.process_and_write_results(
        Image.new("RGB", (400, 300), color=0),
        "callback",
        None,
        None,
        None,
    )

    assert (orig_text, text) == ("", "")
    assert callback_calls == []
    assert run_module.BLACK_HOLE_SKIP_LOG_MESSAGE in log_messages


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
