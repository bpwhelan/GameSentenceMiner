from __future__ import annotations

import asyncio
import gc
import json
from datetime import datetime
from types import SimpleNamespace

from PIL import Image

import GameSentenceMiner.ocr.gsm_ocr as gsm_ocr
from GameSentenceMiner.ocr import owocr_area_selector_qt as area_selector_qt
from GameSentenceMiner.ocr.gsm_ocr_config import Monitor, OCRConfig, Rectangle
from GameSentenceMiner.owocr.owocr.ocr import post_process
from GameSentenceMiner.owocr.owocr import run as run_module


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


def test_run_oneocr_disables_manual_combo_in_auto_mode(monkeypatch):
    captured = {}

    monkeypatch.setattr(gsm_ocr.run, "init_config", lambda _parse_args: None)
    monkeypatch.setattr(gsm_ocr.run, "run", lambda **kwargs: captured.update(kwargs))

    monkeypatch.setattr(gsm_ocr, "obs_ocr", True)
    monkeypatch.setattr(gsm_ocr, "window", None)
    monkeypatch.setattr(gsm_ocr, "ss_clipboard", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr1", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr2", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "manual", False)
    monkeypatch.setattr(gsm_ocr, "manual_ocr_hotkey_combo", "<alt>+b")
    monkeypatch.setattr(gsm_ocr, "global_pause_hotkey", "ctrl+shift+p")
    monkeypatch.setattr(gsm_ocr, "furigana_filter_sensitivity", 0)
    monkeypatch.setattr(gsm_ocr, "ocr_result_callback", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "get_ocr_scan_rate", lambda: 0.5)

    gsm_ocr.run_oneocr(None, [])

    assert captured["screen_capture_combo"] == ""


def test_run_oneocr_uses_manual_combo_in_manual_mode(monkeypatch):
    captured = {}

    monkeypatch.setattr(gsm_ocr.run, "init_config", lambda _parse_args: None)
    monkeypatch.setattr(gsm_ocr.run, "run", lambda **kwargs: captured.update(kwargs))

    monkeypatch.setattr(gsm_ocr, "obs_ocr", True)
    monkeypatch.setattr(gsm_ocr, "window", None)
    monkeypatch.setattr(gsm_ocr, "ss_clipboard", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr1", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr2", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "manual", True)
    monkeypatch.setattr(gsm_ocr, "manual_ocr_hotkey_combo", "<alt>+b")
    monkeypatch.setattr(gsm_ocr, "global_pause_hotkey", "ctrl+shift+p")
    monkeypatch.setattr(gsm_ocr, "furigana_filter_sensitivity", 0)
    monkeypatch.setattr(gsm_ocr, "ocr_result_callback", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "get_ocr_scan_rate", lambda: 0.5)

    gsm_ocr.run_oneocr(None, [])

    assert captured["screen_capture_combo"] == "<alt>+b"


def test_post_process_normalizes_contextual_japanese_dashes_to_choonpu():
    text = post_process("-刻も早く、ス-パ-でA-1を買う")

    assert text == "一刻も早く、スーパーでＡ－１を買う"


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


def test_no_text_similarity_backoff_only_starts_after_no_text_cap():
    threshold_sleep = run_module._get_sleep_add_for_target_rate(
        0.5,
        run_module._get_no_text_scan_rate_cap(0.5),
    )

    assert (
        run_module._should_check_no_text_similarity(
            base_scan_rate=0.5,
            sleep_time_to_add=threshold_sleep - 0.01,
            sleep_reason="no_text",
        )
        is False
    )

    assert (
        run_module._should_check_no_text_similarity(
            base_scan_rate=0.5,
            sleep_time_to_add=threshold_sleep,
            sleep_reason="no_text",
        )
        is True
    )

    assert (
        run_module._should_check_no_text_similarity(
            base_scan_rate=0.5,
            sleep_time_to_add=3.0,
            sleep_reason="identical",
        )
        is False
    )


def test_no_text_similarity_backoff_requires_cached_last_image():
    threshold_sleep = run_module._get_sleep_add_for_target_rate(
        0.5,
        run_module._get_no_text_scan_rate_cap(0.5),
    )

    assert (
        run_module._can_check_no_text_similarity(
            base_scan_rate=0.5,
            sleep_time_to_add=threshold_sleep,
            sleep_reason="no_text",
            last_image=None,
            last_image_np=None,
        )
        is False
    )

    assert (
        run_module._can_check_no_text_similarity(
            base_scan_rate=0.5,
            sleep_time_to_add=threshold_sleep,
            sleep_reason="no_text",
            last_image=object(),
            last_image_np=object(),
        )
        is True
    )


def test_update_image_comparison_cache_copies_image_and_builds_numpy_cache():
    img = Image.new("RGB", (3, 2), color=(10, 20, 30))

    cached_image, cached_image_np = run_module._update_image_comparison_cache(None, img)

    assert cached_image is not img
    assert cached_image.size == img.size
    assert cached_image_np.shape == (2, 3, 3)
    assert tuple(cached_image_np[0, 0]) == (10, 20, 30)


def test_no_text_similarity_backoff_extends_beyond_normal_cap():
    sleep_time_to_add, sleep_reason = run_module._update_no_text_similarity_sleep_state(
        base_scan_rate=0.5,
        sleep_time_to_add=0.5,
        sleep_reason="no_text",
        is_similar=True,
    )

    assert sleep_reason == "no_text_similar"
    assert sleep_time_to_add > 0.5
    assert run_module._get_adjusted_scan_rate(0.5, sleep_time_to_add, sleep_reason) > 1.0


def test_no_text_similarity_backoff_clamps_back_to_normal_cap_when_frame_changes():
    expected_sleep = run_module._get_sleep_add_for_target_rate(
        0.5,
        run_module._get_no_text_scan_rate_cap(0.5),
    )
    sleep_time_to_add, sleep_reason = run_module._update_no_text_similarity_sleep_state(
        base_scan_rate=0.5,
        sleep_time_to_add=2.75,
        sleep_reason="no_text_similar",
        is_similar=False,
    )

    assert sleep_reason == "no_text"
    assert sleep_time_to_add == expected_sleep
    assert run_module._get_adjusted_scan_rate(0.5, sleep_time_to_add, sleep_reason) == 2.0


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
        gsm_ocr.run,
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


def test_obs_screenshot_thread_capture_original_size_falls_back_when_source_dimensions_missing():
    thread = run_module.OBSScreenshotThread(SimpleNamespace(rectangles=[]), screen_capture_on_combo=False)
    del thread.source_width
    del thread.source_height

    assert thread.get_capture_original_size(2560, 1440) == {"width": 2560, "height": 1440}


def test_websocket_server_buffers_until_first_client_connects():
    server = gsm_ocr.WebsocketServerThread(read=True)
    message = json.dumps({"sentence": "hello"})

    class FakeClient:
        def __init__(self):
            self.messages = []

        async def send(self, payload):
            self.messages.append(json.loads(payload))

    asyncio.run(server._queue_or_send_message(message))
    assert list(server._pending_messages) == [message]

    client = FakeClient()
    asyncio.run(server._register_client(client))

    assert client.messages == [{"sentence": "hello"}]
    assert list(server._pending_messages) == []

    server.clients.clear()
    asyncio.run(server._queue_or_send_message(json.dumps({"sentence": "later"})))
    assert list(server._pending_messages) == []


def test_send_result_closed_websocket_loop_does_not_leak_coroutine_warning(monkeypatch, recwarn):
    server = gsm_ocr.WebsocketServerThread(read=True)
    loop = asyncio.new_event_loop()
    server._loop = loop
    server._event.set()
    loop.close()

    monkeypatch.setattr(gsm_ocr, "websocket_server_thread", server)
    monkeypatch.setattr(gsm_ocr, "get_ocr_send_to_clipboard", lambda _source: False)
    monkeypatch.setattr(gsm_ocr, "is_windows", lambda: False)

    asyncio.run(gsm_ocr.send_result("hello", datetime.now()))
    gc.collect()

    leaked_coroutine_warnings = [
        warning
        for warning in recwarn
        if warning.category is RuntimeWarning and "_queue_or_send_message" in str(warning.message)
    ]
    assert leaked_coroutine_warnings == []


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
                "globalPauseHotkey": ("ctrl+shift+p", "ctrl+alt+p"),
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
    monkeypatch.delattr(gsm_ocr.run, "paused", raising=False)

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
