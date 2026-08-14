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
