import asyncio
from types import SimpleNamespace

from GameSentenceMiner.util.overlay import get_overlay_coords


def _precomputed_payload(mode: str = "absolute_screen") -> dict:
    return {
        "schema": "gsm_overlay_coords_v1",
        "coordinate_space": {
            "mode": mode,
            "source_width": 2560,
            "source_height": 1440,
        },
        "lines": [{"text": "test"}],
    }


def _processor_with_magpie() -> get_overlay_coords.OverlayProcessor:
    processor = get_overlay_coords.OverlayProcessor()
    processor.window_monitor = SimpleNamespace(
        target_hwnd=123,
        magpie_info={
            "sourceWindowLeftEdgePosition": 640,
            "sourceWindowTopEdgePosition": 360,
            "sourceWindowRightEdgePosition": 1920,
            "sourceWindowBottomEdgePosition": 1080,
            "magpieWindowLeftEdgePosition": 0,
            "magpieWindowTopEdgePosition": 0,
            "magpieWindowRightEdgePosition": 2560,
            "magpieWindowBottomEdgePosition": 1440,
        },
    )
    processor._is_use_ocr_result_enabled = lambda: True
    return processor


def test_magpie_disables_absolute_screen_precomputed_overlay_payload():
    processor = _processor_with_magpie()

    assert processor._should_use_precomputed_overlay_payload(_precomputed_payload()) is False
    assert processor._should_use_precomputed_overlay_payload(_precomputed_payload("source_content")) is True


def test_engine_hook_payload_can_explicitly_bypass_overlay_ocr():
    payload = _precomputed_payload("source_content")
    payload.update(
        {
            "bypass_ocr": True,
            "producer": {
                "kind": "engine-hook",
                "version": 1,
                "integrationId": "mages-steins-gate-steam",
            },
        }
    )

    assert get_overlay_coords.OverlayProcessor._is_forced_ocr_bypass_payload(payload) is True


def test_untrusted_precomputed_payload_cannot_force_ocr_bypass():
    payload = _precomputed_payload("source_content")
    payload.update({"bypass_ocr": True, "producer": {"kind": "mages-agent", "version": 1}})

    assert get_overlay_coords.OverlayProcessor._is_forced_ocr_bypass_payload(payload) is False


def test_magpie_area_select_falls_back_to_overlay_ocr(monkeypatch):
    processor = _processor_with_magpie()
    ensure_engine_calls = []
    received_payloads = []

    async def fake_send_overlay_clear(_line_id):
        return None

    async def fake_find_box_for_sentence(*_args, **kwargs):
        received_payloads.append(kwargs.get("dict_from_ocr"))
        return []

    monkeypatch.setattr(get_overlay_coords, "send_overlay_clear", fake_send_overlay_clear)
    monkeypatch.setattr(processor, "_ensure_correct_engine_loaded", lambda: ensure_engine_calls.append(True))
    monkeypatch.setattr(processor, "_get_effective_engine", lambda: "unsupported-test-engine")
    monkeypatch.setattr(processor, "_is_supplement_mode_enabled", lambda: False)
    monkeypatch.setattr(processor, "find_box_for_sentence", fake_find_box_for_sentence)

    async def run():
        processor.processing_loop = asyncio.get_running_loop()
        await processor.find_box_and_send_to_overlay(
            line=SimpleNamespace(id="line-1", text="test", source="screen_cropper"),
            dict_from_ocr=_precomputed_payload(),
        )

    asyncio.run(run())

    assert ensure_engine_calls == [True]
    assert received_payloads == [None]


def test_precomputed_payload_fully_covered_by_exclusion_sends_empty_final_payload(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    processor.ocr_language = "ja"
    bounding_rect = {
        "x1": 10,
        "y1": 10,
        "x2": 20,
        "y2": 10,
        "x3": 20,
        "y3": 20,
        "x4": 10,
        "y4": 20,
    }
    payload = {
        "schema": "gsm_overlay_coords_v1",
        "coordinate_space": {"mode": "source_content", "source_width": 100, "source_height": 100},
        "lines": [
            {
                "text": "日",
                "bounding_rect": bounding_rect,
                "words": [{"text": "日", "bounding_rect": bounding_rect}],
            }
        ],
    }
    sent_payloads = []

    monkeypatch.setattr(
        processor,
        "get_configured_monitor_workarea",
        lambda: {"left": 0, "top": 0, "width": 100, "height": 100},
    )
    monkeypatch.setattr(processor, "_resolve_overlay_geometry", lambda *_args: (0, 0, 100, 100, 100, 100))
    monkeypatch.setattr(processor, "_get_overlay_minimum_character_size", lambda: 0)
    monkeypatch.setattr(
        processor,
        "_get_precomputed_exclusion_regions",
        lambda **_kwargs: [
            {
                "x1": 0.1,
                "y1": 0.1,
                "x2": 0.2,
                "y2": 0.1,
                "x3": 0.2,
                "y3": 0.2,
                "x4": 0.1,
                "y4": 0.2,
            }
        ],
    )

    async def fake_send(payload_to_send):
        sent_payloads.append(payload_to_send)

    monkeypatch.setattr(get_overlay_coords, "send_word_coordinates_to_overlay", fake_send)

    used_precomputed = asyncio.run(processor._try_send_precomputed_overlay_payload(payload, None))

    assert used_precomputed is True
    assert sent_payloads == [
        {
            "type": "word_coordinates",
            "data": [],
            "is_sentence_recycled": False,
            "is_final": True,
        }
    ]
