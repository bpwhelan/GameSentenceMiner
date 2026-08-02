from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import pytest
from PIL import Image

import GameSentenceMiner.ocr.gsm_ocr as gsm_ocr
from GameSentenceMiner.ocr import owocr_area_selector_qt as area_selector_qt
from GameSentenceMiner.ocr.gsm_ocr_config import Monitor, OCRConfig, Rectangle
from GameSentenceMiner.owocr.owocr.ocr import post_process
from GameSentenceMiner.owocr.owocr import ocr_runtime as run_module


def test_resolve_requested_engines_prioritizes_cli_values():
    engines = run_module._resolve_requested_engines(
        "meikiocr",
        "glens",
        requested_engine="alivetext",
        requested_ocr1="alivetext",
        requested_ocr2="alivetext",
    )

    assert engines[0] == "alivetext"
    assert engines.count("alivetext") == 1
    assert "meikiocr" in engines
    assert "glens" in engines


def test_resolve_requested_engines_falls_back_to_config_values():
    engines = run_module._resolve_requested_engines(
        "meikiocr",
        "glens",
        requested_engine=None,
        requested_ocr1=None,
        requested_ocr2=None,
    )

    assert engines == ["meikiocr", "glens"]


def test_resolve_requested_engines_can_exclude_config_values():
    engines = run_module._resolve_requested_engines(
        "meiki_text_detector",
        "glens",
        requested_engine="glens",
        requested_ocr1="glens",
        requested_ocr2="glens",
        include_configured_engines=False,
    )

    assert engines == ["glens"]


def test_run_oneocr_disables_manual_combo_in_auto_mode(monkeypatch):
    captured = {}

    monkeypatch.setattr(gsm_ocr.ocr_runtime, "init_config", lambda _parse_args: None)
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "run", lambda **kwargs: captured.update(kwargs))

    monkeypatch.setattr(gsm_ocr, "obs_ocr", True)
    monkeypatch.setattr(gsm_ocr, "window", None)
    monkeypatch.setattr(gsm_ocr, "ss_clipboard", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr1", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr2", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "manual", False)
    monkeypatch.setattr(gsm_ocr, "global_pause_hotkey", "ctrl+shift+p")
    monkeypatch.setattr(gsm_ocr, "furigana_filter_sensitivity", 0)
    monkeypatch.setattr(gsm_ocr, "ocr_result_callback", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "get_ocr_scan_rate", lambda: 0.5)

    gsm_ocr.run_oneocr(None, [])

    assert captured["screen_capture_combo"] == ""
    assert captured["screen_capture_on_demand"] is False
    assert captured["include_configured_engines"] is True


def test_run_oneocr_leaves_manual_combo_to_shared_hotkey_manager(monkeypatch):
    captured = {}

    monkeypatch.setattr(gsm_ocr.ocr_runtime, "init_config", lambda _parse_args: None)
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "run", lambda **kwargs: captured.update(kwargs))

    monkeypatch.setattr(gsm_ocr, "obs_ocr", True)
    monkeypatch.setattr(gsm_ocr, "window", None)
    monkeypatch.setattr(gsm_ocr, "ss_clipboard", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr1", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr2", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "manual", True)
    monkeypatch.setattr(gsm_ocr, "global_pause_hotkey", "ctrl+shift+p")
    monkeypatch.setattr(gsm_ocr, "furigana_filter_sensitivity", 0)
    monkeypatch.setattr(gsm_ocr, "ocr_result_callback", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "get_ocr_scan_rate", lambda: 0.5)
    gsm_ocr.run_oneocr(None, [])

    assert captured["screen_capture_combo"] == ""
    assert captured["screen_capture_on_demand"] is True
    assert captured["include_configured_engines"] is False


def test_ocr_processor_lazily_initializes_missing_engine(monkeypatch):
    loaded_engine = SimpleNamespace(name="meiki_text_detector")
    load_calls = []
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "engine_instances", [], raising=False)

    def load_engine(name, *, switch):
        load_calls.append((name, switch))
        gsm_ocr.ocr_runtime.engine_instances.append(loaded_engine)

    monkeypatch.setattr(gsm_ocr.ocr_runtime, "engine_change_handler_name", load_engine)

    processor = object.__new__(gsm_ocr.OCRProcessor)

    assert processor._get_engine_instance_by_name("meiki_text_detector") is loaded_engine
    assert load_calls == [("meiki_text_detector", False)]


def test_secondary_prepass_lazily_initializes_configured_ocr1(monkeypatch):
    class FakeDetector:
        name = "meiki_text_detector"

        def __call__(self, _img, _furigana_filter_sensitivity):
            return True, "", [], [], (1, 2, 8, 9), None

    detector = FakeDetector()
    load_calls = []
    monkeypatch.setattr(gsm_ocr, "is_beangate", True)
    monkeypatch.setattr(gsm_ocr, "get_ocr_ocr1", lambda: "meiki_text_detector")
    monkeypatch.setattr(gsm_ocr, "get_ocr_ocr2", lambda: "glens")
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "engine_instances", [], raising=False)
    monkeypatch.setattr(gsm_ocr, "get_ocr2_image", lambda *_args, **_kwargs: "cropped")

    def load_engine(name, *, switch):
        load_calls.append((name, switch))
        gsm_ocr.ocr_runtime.engine_instances.append(detector)

    monkeypatch.setattr(gsm_ocr.ocr_runtime, "engine_change_handler_name", load_engine)

    processor = object.__new__(gsm_ocr.OCRProcessor)
    result, offset = processor._prepare_beangate_secondary_ocr2_image(Image.new("RGB", (10, 10)))

    assert result == "cropped"
    assert offset == (1, 2)
    assert load_calls == [("meiki_text_detector", False)]


def test_primary_area_hotkey_runs_ocr2_on_green_rectangles_only(monkeypatch):
    monitor = Monitor(index=0, width=1920, height=1080)
    green = Rectangle(monitor, [10, 20, 300, 120], is_excluded=False)
    purple = Rectangle(monitor, [20, 200, 400, 300], is_excluded=False, is_secondary=True)
    black_hole = Rectangle(monitor, [0, 0, 100, 100], is_excluded=False, is_black_hole=True)
    exclusion = Rectangle(monitor, [30, 30, 40, 40], is_excluded=True)
    config = OCRConfig(scene="test", rectangles=[green, purple, black_hole, exclusion])
    captured = {}
    image = Image.new("RGB", (1920, 1080), "white")

    monkeypatch.setattr(gsm_ocr, "get_ocr_config", lambda: config)
    monkeypatch.setattr(gsm_ocr.obs, "get_screenshot_PIL", lambda **_kwargs: image)

    def apply_config(img, current_config, **kwargs):
        captured["rectangles"] = kwargs.get("rectangles")
        captured["return_full_size"] = kwargs.get("return_full_size")
        return img, (10, 20)

    monkeypatch.setattr(gsm_ocr.ocr_runtime, "apply_ocr_config_to_image", apply_config)
    monkeypatch.setattr(
        gsm_ocr,
        "get_second_ocr_processor",
        lambda: SimpleNamespace(do_second_ocr=lambda *args, **kwargs: captured.update(args=args, kwargs=kwargs)),
    )

    assert gsm_ocr.run_primary_rectangles_ocr_once() is True
    assert captured["rectangles"] == [green]
    assert captured["return_full_size"] is False
    assert captured["kwargs"]["source"] == gsm_ocr.TextSource.OCR_MANUAL
    assert captured["kwargs"]["ignore_previous_result"] is True
    assert captured["kwargs"]["ignore_furigana_filter"] is True


def test_manual_command_runs_primary_ocr2_directly_during_auto_mode(monkeypatch):
    calls = []
    monkeypatch.setattr(gsm_ocr, "manual", False)
    monkeypatch.setattr(gsm_ocr, "get_ocr_manual_scan_delay_ms", lambda: 0)
    monkeypatch.setattr(gsm_ocr, "get_ocr_manual_scan_delay_gamepad_only", lambda: False)
    monkeypatch.setattr(gsm_ocr, "run_primary_rectangles_ocr_once", lambda: calls.append("primary") or True)
    monkeypatch.delattr(gsm_ocr.ocr_runtime, "paused", raising=False)

    response = gsm_ocr._handle_command(
        {"command": gsm_ocr.ocr_ipc.OCRCommand.MANUAL_OCR.value},
        announce_ipc=False,
    )

    assert response["success"] is True
    assert calls == ["primary"]


def test_manual_ocr_trigger_delays_keyboard_activation(monkeypatch):
    calls = []
    timers = []

    class FakeTimer:
        def __init__(self, interval, callback):
            self.interval = interval
            self.callback = callback
            self.daemon = False
            timers.append(self)

        def start(self):
            calls.append("scheduled")

    monkeypatch.setattr(gsm_ocr, "manual", False)
    monkeypatch.setattr(gsm_ocr.threading, "Timer", FakeTimer)
    monkeypatch.setattr(gsm_ocr, "get_ocr_manual_scan_delay_ms", lambda: 350)
    monkeypatch.setattr(gsm_ocr, "get_ocr_manual_scan_delay_gamepad_only", lambda: False)
    monkeypatch.setattr(
        gsm_ocr,
        "run_primary_rectangles_ocr_once",
        lambda: calls.append("captured") or True,
    )

    assert gsm_ocr.trigger_manual_ocr(gamepad_activation=False) is True
    assert calls == ["scheduled"]
    assert len(timers) == 1
    assert timers[0].interval == 0.35
    assert timers[0].daemon is True

    timers[0].callback()
    assert calls == ["scheduled", "captured"]


def test_manual_ocr_delay_can_be_limited_to_gamepad_activation(monkeypatch):
    calls = []
    timers = []

    class FakeTimer:
        def __init__(self, interval, callback):
            self.interval = interval
            self.callback = callback
            self.daemon = False
            timers.append(self)

        def start(self):
            calls.append("scheduled")

    monkeypatch.setattr(gsm_ocr, "manual", False)
    monkeypatch.setattr(gsm_ocr.threading, "Timer", FakeTimer)
    monkeypatch.setattr(gsm_ocr, "get_ocr_manual_scan_delay_ms", lambda: 250)
    monkeypatch.setattr(gsm_ocr, "get_ocr_manual_scan_delay_gamepad_only", lambda: True)
    monkeypatch.setattr(
        gsm_ocr,
        "run_primary_rectangles_ocr_once",
        lambda: calls.append("captured") or True,
    )

    assert gsm_ocr.trigger_manual_ocr(gamepad_activation=False) is True
    assert calls == ["captured"]
    assert timers == []

    calls.clear()
    assert gsm_ocr.trigger_manual_ocr(gamepad_activation=True) is True
    assert calls == ["scheduled"]
    assert len(timers) == 1
    assert timers[0].interval == 0.25


def test_manual_mode_delayed_trigger_sets_screenshot_event(monkeypatch):
    events = []
    screenshot_event = SimpleNamespace(set=lambda: events.append("set"))

    monkeypatch.setattr(gsm_ocr, "manual", True)
    monkeypatch.setattr(
        gsm_ocr.ocr_runtime,
        "screenshot_event",
        screenshot_event,
        raising=False,
    )
    monkeypatch.setattr(gsm_ocr, "get_ocr_manual_scan_delay_ms", lambda: 0)
    monkeypatch.setattr(gsm_ocr, "get_ocr_manual_scan_delay_gamepad_only", lambda: False)

    assert gsm_ocr.trigger_manual_ocr(gamepad_activation=False) is True
    assert events == ["set"]


@pytest.mark.parametrize("manual_mode", [False, True])
def test_manual_hotkeys_identify_keyboard_and_gamepad_activations(monkeypatch, manual_mode):
    activations = []

    class FakeHotkeyManager:
        def __init__(self):
            self.keyboard = []
            self.gamepad = []

        def clear(self):
            return None

        def register(self, binding_getter, callback):
            self.keyboard.append((binding_getter, callback))

        def register_gamepad(self, binding_getter, callback):
            self.gamepad.append((binding_getter, callback))

    manager = FakeHotkeyManager()
    monkeypatch.setattr(gsm_ocr, "_get_hotkey_manager", lambda: manager)
    monkeypatch.setattr(gsm_ocr, "manual", manual_mode)
    monkeypatch.setattr(gsm_ocr, "area_select_ocr_hotkey", "")
    monkeypatch.setattr(gsm_ocr, "manual_ocr_hotkey", "Ctrl+Shift+M")
    monkeypatch.setattr(gsm_ocr, "menu_ocr_hotkey", "")
    monkeypatch.setattr(gsm_ocr, "whole_window_ocr_hotkey", "")
    monkeypatch.setattr(
        gsm_ocr,
        "trigger_manual_ocr",
        lambda **kwargs: activations.append(kwargs) or True,
    )

    gsm_ocr.add_ss_hotkey()

    assert len(manager.keyboard) == 1
    manager.keyboard[0][1]()
    manual_gamepad_callback = next(
        callback for binding_getter, callback in manager.gamepad if binding_getter is gsm_ocr.get_ocr_manual_ocr_gamepad
    )
    manual_gamepad_callback()

    assert activations == [
        {"gamepad_activation": False},
        {"gamepad_activation": True},
    ]


def test_menu_command_always_runs_secondary_rectangles(monkeypatch):
    calls = []
    monkeypatch.setattr(gsm_ocr, "run_secondary_rectangles_ocr_once", lambda: calls.append("menu") or True)
    monkeypatch.delattr(gsm_ocr.ocr_runtime, "paused", raising=False)

    response = gsm_ocr._handle_command(
        {"command": gsm_ocr.ocr_ipc.OCRCommand.MENU_OCR.value},
        announce_ipc=False,
    )

    assert response["success"] is True
    assert calls == ["menu"]


def test_post_process_normalizes_contextual_japanese_dashes_to_choonpu():
    text = post_process("-刻も早く、ス-パ-でA-1を買う")

    assert text == "一刻も早く、スーパーでＡ－１を買う"


def test_post_process_collapses_repeated_japanese_middle_dots():
    text = post_process("私は・・・・・・まだうまく受け止められてないから。")

    assert text == "私は・・・まだうまく受け止められてないから。"


def test_post_process_collapses_google_lens_dot_variants():
    text = post_process("私は••••••まだ······うまく受け止められてないから。")

    assert text == "私は・・・まだ・・・うまく受け止められてないから。"


def test_build_overlay_coordinate_payload_normalizes_lookup_text_dashes():
    response_dict = {
        "line_coords": [
            {
                "text": "-刻も早く",
                "bounding_rect": {"x1": 0, "y1": 0, "x2": 40, "y2": 0, "x3": 40, "y3": 10, "x4": 0, "y4": 10},
                "words": [
                    {
                        "text": "-刻も早く",
                        "bounding_rect": {"x1": 0, "y1": 0, "x2": 40, "y2": 0, "x3": 40, "y3": 10, "x4": 0, "y4": 10},
                    },
                    {
                        "text": "A-1",
                        "bounding_rect": {"x1": 45, "y1": 0, "x2": 65, "y2": 0, "x3": 65, "y3": 10, "x4": 45, "y4": 10},
                    },
                ],
            }
        ],
        "pipeline": {
            "capture": {
                "scaled_size": {"width": 100, "height": 20},
                "original_size": {"width": 100, "height": 20},
            },
            "processing": {
                "processed_size": {"width": 100, "height": 20},
                "crop_offset": {"x": 0, "y": 0},
                "coordinate_mode": "source_content",
            },
            "ocr": {},
        },
    }

    payload = gsm_ocr.build_overlay_coordinate_payload(response_dict)

    assert payload is not None
    assert payload["lines"][0]["text"] == "一刻も早く"
    assert payload["lines"][0]["words"][0]["text"] == "一刻も早く"
    assert payload["lines"][0]["words"][1]["text"] == "A-1"


def test_google_lens_is_overlay_supported_engine():
    assert gsm_ocr._is_overlay_supported_engine("glens")
    assert gsm_ocr._is_overlay_supported_engine("Google Lens")


def test_second_ocr_prefers_google_lens_overlay_payload(monkeypatch):
    sent = []
    saved = []
    ctrl = SimpleNamespace(
        last_sent_result="",
        last_ocr2_result=[],
        config=gsm_ocr.TwoPassConfig(),
    )
    first_pass_payload = {
        "schema": "gsm_ocr_geometry_v1",
        "line_coords": [
            {
                "text": "oneocr",
                "bounding_rect": {"x1": 0, "y1": 0, "x2": 40, "y2": 0, "x3": 40, "y3": 10, "x4": 0, "y4": 10},
                "words": [
                    {
                        "text": "oneocr",
                        "bounding_rect": {"x1": 0, "y1": 0, "x2": 40, "y2": 0, "x3": 40, "y3": 10, "x4": 0, "y4": 10},
                    }
                ],
            }
        ],
        "pipeline": {
            "engine": "oneocr",
            "capture": {"scaled_size": {"width": 100, "height": 20}, "original_size": {"width": 100, "height": 20}},
            "processing": {
                "processed_size": {"width": 100, "height": 20},
                "crop_offset": {"x": 0, "y": 0},
                "coordinate_mode": "source_content",
            },
            "ocr": {},
        },
    }
    lens_payload = {
        "schema": "gsm_ocr_geometry_v1",
        "line_coords": [
            {
                "text": "lens",
                "bounding_rect": {"x1": 5, "y1": 0, "x2": 45, "y2": 0, "x3": 45, "y3": 10, "x4": 5, "y4": 10},
                "words": [
                    {
                        "text": "lens",
                        "bounding_rect": {"x1": 5, "y1": 0, "x2": 45, "y2": 0, "x3": 45, "y3": 10, "x4": 5, "y4": 10},
                    }
                ],
            }
        ],
        "pipeline": {
            "engine": "glens",
            "capture": {"scaled_size": {"width": 100, "height": 20}, "original_size": {"width": 100, "height": 20}},
            "processing": {
                "processed_size": {"width": 100, "height": 20},
                "crop_offset": {"x": 0, "y": 0},
                "coordinate_mode": "source_content",
            },
            "ocr": {},
        },
    }

    monkeypatch.setattr(gsm_ocr, "TextFiltering", lambda lang: object())
    monkeypatch.setattr(gsm_ocr, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(gsm_ocr, "get_controller", lambda: ctrl)
    monkeypatch.setattr(gsm_ocr, "get_ocr_ocr2", lambda: "glens")
    monkeypatch.setattr(gsm_ocr, "capture_ocr_metrics_sample", lambda *args, **kwargs: None)
    monkeypatch.setattr(gsm_ocr, "save_result_image", lambda *args, **kwargs: saved.append(args))

    async def _send_result(text, time, *, response_dict=None, source=None):
        sent.append({"text": text, "response_dict": response_dict, "source": source})

    monkeypatch.setattr(gsm_ocr, "send_result", _send_result)
    monkeypatch.setattr(
        gsm_ocr.ocr_runtime,
        "process_and_write_results",
        lambda *args, **kwargs: (["lens"], "lens", lens_payload),
    )

    processor = gsm_ocr.OCRProcessor()
    processor.do_second_ocr(
        "",
        datetime(2026, 2, 22, 12, 0, 0),
        Image.new("RGB", (2, 2), color=255),
        filtering=None,
        response_dict=first_pass_payload,
    )

    assert saved
    assert sent[0]["response_dict"]["pipeline"]["engine"] == "glens"
    assert sent[0]["response_dict"]["line_coords"] == lens_payload["line_coords"]


def test_second_ocr_rebases_cropped_google_lens_overlay_payload():
    first_pass_payload = {
        "schema": "gsm_ocr_geometry_v1",
        "line_coords": [],
        "pipeline": {
            "engine": "oneocr",
            "capture": {
                "scaled_size": {"width": 1000, "height": 500},
                "original_size": {"width": 1000, "height": 500},
            },
            "processing": {
                "processed_size": {"width": 1000, "height": 500},
                "crop_offset": {"x": 10, "y": 20},
                "coordinate_mode": "source_content",
            },
            "ocr": {"crop_coords": [100, 50, 300, 150]},
        },
    }
    lens_payload = {
        "schema": "gsm_ocr_geometry_v1",
        "line_coords": [
            {
                "text": "lens",
                "bounding_rect": {"x1": 5, "y1": 6, "x2": 45, "y2": 6, "x3": 45, "y3": 26, "x4": 5, "y4": 26},
                "words": [
                    {
                        "text": "lens",
                        "bounding_rect": {
                            "x1": 5,
                            "y1": 6,
                            "x2": 45,
                            "y2": 6,
                            "x3": 45,
                            "y3": 26,
                            "x4": 5,
                            "y4": 26,
                        },
                    }
                ],
            }
        ],
        "pipeline": {
            "engine": "glens",
            "capture": {
                "scaled_size": {"width": 200, "height": 100},
                "original_size": {"width": 200, "height": 100},
            },
            "processing": {
                "processed_size": {"width": 200, "height": 100},
                "crop_offset": {"x": 0, "y": 0},
                "coordinate_mode": "source_content",
            },
            "ocr": {},
        },
    }

    selected_payload = gsm_ocr._select_second_pass_payload(first_pass_payload, lens_payload)
    overlay_payload = gsm_ocr.build_overlay_coordinate_payload(selected_payload)

    assert selected_payload is not lens_payload
    assert overlay_payload["coordinate_space"]["source_width"] == 1000
    assert overlay_payload["coordinate_space"]["source_height"] == 500
    assert overlay_payload["coordinate_space"]["crop_offset"] == {"x": 110, "y": 70}
    assert overlay_payload["lines"][0]["bounding_rect"]["x1"] == 115
    assert overlay_payload["lines"][0]["bounding_rect"]["y1"] == 76


def test_apply_ocr_config_to_image_supports_grayscale_masking():
    img = Image.new("L", (12, 12), color=255)
    config = SimpleNamespace(
        rectangles=[
            SimpleNamespace(coordinates=[0, 0, 3, 3], is_excluded=True, is_secondary=False),
            SimpleNamespace(coordinates=[0, 0, 12, 12], is_excluded=False, is_secondary=False),
        ]
    )

    processed, offset = run_module.apply_ocr_config_to_image(
        img,
        config,
        return_full_size=False,
    )

    assert processed.mode == "L"
    assert offset == (0, 0)
    assert processed.getpixel((0, 0)) == 0
    assert processed.getpixel((8, 8)) == 255


def test_apply_ocr_config_to_image_scales_percentage_rectangles_to_frame_size():
    img = Image.new("L", (2560, 1440), color=255)
    config = OCRConfig(
        scene="Cyberpunk 2077",
        rectangles=[
            Rectangle(
                monitor=Monitor(index=0),
                coordinates=[0.25, 0.25, 0.5, 0.25],
                is_excluded=False,
            )
        ],
        coordinate_system="percentage",
    )

    processed, offset = run_module.apply_ocr_config_to_image(
        img,
        config,
        return_full_size=False,
    )

    assert processed.size == (1280, 360)
    assert offset == (640, 360)


def test_apply_ocr_config_to_image_includes_black_hole_rectangles_in_primary_crop():
    img = Image.new("L", (100, 20), color=255)
    config = SimpleNamespace(
        rectangles=[
            SimpleNamespace(
                coordinates=[0, 0, 10, 10],
                is_excluded=False,
                is_secondary=False,
                is_black_hole=False,
            ),
            SimpleNamespace(
                coordinates=[40, 0, 10, 10],
                is_excluded=False,
                is_secondary=False,
                is_black_hole=True,
            ),
        ]
    )

    processed, offset = run_module.apply_ocr_config_to_image(
        img,
        config,
        return_full_size=False,
    )

    assert processed.size == (50, 10)
    assert offset == (0, 0)


def test_ocr_processor_second_pass_suppresses_subset_chunk_duplicate(monkeypatch):
    sent = []
    saved = []
    full_text = "ヤゴ：「荘厳」？あー・・・できる限りのことはしたつもりだ。大佐に相応しい式かと"
    ctrl = SimpleNamespace(
        last_sent_result=full_text,
        last_ocr2_result=[
            "ヤゴ：「荘厳」？",
            "あー・・・できる限りのことはしたつもりだ。",
            "大佐に相応しい式かと",
        ],
    )

    monkeypatch.setattr(gsm_ocr, "TextFiltering", lambda lang: object())
    monkeypatch.setattr(gsm_ocr, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(gsm_ocr, "get_controller", lambda: ctrl)
    monkeypatch.setattr(gsm_ocr, "get_ocr_ocr2", lambda: "glens")
    monkeypatch.setattr(gsm_ocr, "capture_ocr_metrics_sample", lambda *args, **kwargs: None)
    monkeypatch.setattr(gsm_ocr, "save_result_image", lambda *args, **kwargs: saved.append(args))

    async def _send_result(text, time, *, response_dict=None, source=None):
        sent.append(
            {
                "text": text,
                "time": time,
                "response_dict": response_dict,
                "source": source,
            }
        )

    monkeypatch.setattr(gsm_ocr, "send_result", _send_result)
    monkeypatch.setattr(
        gsm_ocr.ocr_runtime,
        "process_and_write_results",
        lambda *args, **kwargs: (["・「荘厳」？"], "・「荘厳」？", {"engine": "glens"}),
    )

    processor = gsm_ocr.OCRProcessor()
    processor.do_second_ocr(
        "",
        datetime(2026, 2, 22, 12, 0, 0),
        Image.new("RGB", (2, 2), color=255),
        filtering=None,
    )

    assert sent == []
    assert saved == []
    assert ctrl.last_sent_result == full_text


def test_describe_obs_source_selection_handles_no_valid_source():
    message = area_selector_qt.describe_obs_source_selection(
        [
            {"sourceName": "Game Source", "inputKind": "game_capture"},
            {"sourceName": "Window Source", "inputKind": "window_capture"},
        ],
        None,
    )

    assert message == (
        "Multiple active video sources found, but no valid source has output yet. Retrying screenshot capture."
    )


def test_obs_area_selector_uses_single_fast_initial_screenshot(monkeypatch):
    calls = []

    def fake_get_screenshot_pil(**kwargs):
        calls.append(kwargs)
        return Image.new("RGB", (640, 360), color=(255, 255, 255))

    monkeypatch.setattr(area_selector_qt.obs, "get_screenshot_PIL", fake_get_screenshot_pil)
    monkeypatch.setattr(
        area_selector_qt.obs,
        "get_active_video_sources",
        lambda: (_ for _ in ()).throw(AssertionError("source enumeration should not run before first capture")),
    )
    monkeypatch.setattr(
        area_selector_qt.obs,
        "get_best_source_for_screenshot",
        lambda: (_ for _ in ()).throw(AssertionError("source validation should not run before first capture")),
    )

    selector = SimpleNamespace(
        overlay_config_mode=False,
        screenshot_img=None,
        target_window_geometry={},
        bounding_box_original=None,
        monitors=[],
        _fit_capture_to_screen=lambda original_w, original_h: setattr(
            selector,
            "fit_args",
            (original_w, original_h),
        ),
    )

    area_selector_qt.OWOCRAreaSelectorWidget._init_obs_screenshot(selector)

    assert calls == [{"compression": 90, "img_format": "jpg", "retry": 1, "capture_fps": 2}]
    assert selector.fit_args == (640, 360)
    assert selector.target_window_geometry == {"left": 0, "top": 0, "width": 640, "height": 360}


def test_obs_screenshot_thread_capture_original_size_falls_back_when_source_dimensions_missing():
    thread = run_module.OBSScreenshotThread(SimpleNamespace(rectangles=[]), screen_capture_on_combo=False)
    del thread.source_width
    del thread.source_height

    assert thread.get_capture_original_size(2560, 1440) == {"width": 2560, "height": 1440}


def test_apply_ipc_config_reload_refreshes_hotkeys_and_clipboard_toggle(monkeypatch):
    events = []

    class FakeHotkeyManager:
        def refresh(self):
            events.append("hotkeys-refreshed")

    monkeypatch.setattr(gsm_ocr, "reload_electron_config", lambda: None)
    monkeypatch.setattr(
        gsm_ocr, "refresh_runtime_hotkey_settings_from_config", lambda: events.append("runtime-hotkeys")
    )
    monkeypatch.setattr(gsm_ocr, "_get_hotkey_manager", lambda: FakeHotkeyManager())
    monkeypatch.setattr(gsm_ocr, "get_ocr_ocr_screenshots", lambda: True)
    monkeypatch.setattr(gsm_ocr, "get_scene_furigana_filter_sensitivity", lambda **kwargs: 0)
    monkeypatch.setattr(gsm_ocr, "reset_callback_vars", lambda: events.append("reset"))
    monkeypatch.setattr(gsm_ocr, "has_config_changed", lambda _config: False)

    gsm_ocr.ss_clipboard = False
    gsm_ocr.apply_ipc_config_reload(
        {
            "reload_electron": True,
            "reload_area": False,
            "changes": {
                "gamepadHotkeysEnabled": (True, False),
                "ocr_screenshots": (False, True),
            },
        }
    )

    assert gsm_ocr.ss_clipboard is True
    assert "runtime-hotkeys" in events
    assert "hotkeys-refreshed" in events


def test_handle_command_reload_config_announces_reloaded_status(monkeypatch):
    announced = []

    monkeypatch.setattr(gsm_ocr, "apply_ipc_config_reload", lambda data=None: announced.append(("reload", data)))
    monkeypatch.setattr(gsm_ocr, "_build_status_payload", lambda: {"paused": False, "scan_rate": 0.5})
    monkeypatch.setattr(gsm_ocr.ocr_ipc, "announce_config_reloaded", lambda: announced.append(("config", None)))
    monkeypatch.setattr(gsm_ocr.ocr_ipc, "announce_status", lambda payload: announced.append(("status", payload)))
    monkeypatch.delattr(gsm_ocr.ocr_runtime, "paused", raising=False)

    response = gsm_ocr._handle_command(
        {"command": "reload_config", "data": {"reload_electron": True}},
        announce_ipc=True,
    )

    assert response["success"] is True
    assert announced == [
        ("reload", {"reload_electron": True}),
        ("config", None),
        ("status", {"paused": False, "scan_rate": 0.5}),
    ]
