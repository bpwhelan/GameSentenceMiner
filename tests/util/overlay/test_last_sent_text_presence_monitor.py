from __future__ import annotations

import asyncio
from types import SimpleNamespace

import cv2
import numpy as np
from PIL import Image

from GameSentenceMiner.util.overlay import get_overlay_coords


def _frame(*, text: bool, background_seed: int = 0) -> Image.Image:
    rng = np.random.default_rng(background_seed)
    pixels = rng.integers(20, 80, size=(80, 240), dtype=np.uint8)
    if text:
        cv2.putText(pixels, "OCR", (55, 52), cv2.FONT_HERSHEY_SIMPLEX, 1.2, 245, 2, cv2.LINE_AA)
    return Image.fromarray(pixels, mode="L")


def _overlay_payload() -> dict:
    return {
        "type": "word_coordinates",
        "data": [
            {
                "text": "OCR",
                "bounding_rect": {
                    "x1": 0.2,
                    "y1": 0.25,
                    "x2": 0.6,
                    "y2": 0.25,
                    "x3": 0.6,
                    "y3": 0.75,
                    "x4": 0.2,
                    "y4": 0.75,
                },
                "words": [],
            }
        ],
        "is_final": True,
    }


def _enabled_config():
    return SimpleNamespace(
        last_sent_ocr_presence_check=True,
        last_sent_ocr_presence_remove_notation=True,
        last_sent_ocr_presence_invalidate_lookups=True,
    )


def test_overlay_percentages_map_back_into_capture_pixels():
    image = Image.new("L", (200, 100))

    pixel_payload = get_overlay_coords.OverlayProcessor._presence_pixel_payload(
        _overlay_payload()["data"],
        image,
        offset_x=100,
        offset_y=50,
        content_width=500,
        content_height=250,
        monitor_width=1000,
        monitor_height=500,
    )

    assert pixel_payload["line_coords"][0]["bounding_rect"] == {
        "x1": 40.0,
        "y1": 30.0,
        "x2": 200.0,
        "y2": 30.0,
        "x3": 200.0,
        "y3": 130.0,
        "x4": 40.0,
        "y4": 130.0,
    }


def test_coordinate_send_arms_background_monitor_invalidates_and_revalidates_without_another_event(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    coordinate_sends = []
    overlay_sends = []
    finished = asyncio.Event()
    captures = iter(
        [
            _frame(text=True, background_seed=1),
            _frame(text=False, background_seed=2),
            _frame(text=False, background_seed=3),
            _frame(text=True, background_seed=4),
            _frame(text=False, background_seed=5),
            _frame(text=False, background_seed=6),
        ]
    )
    pixel_payload = {
        "line_coords": [
            {
                "bounding_rect": {
                    "x1": 50,
                    "y1": 22,
                    "x2": 135,
                    "y2": 22,
                    "x3": 135,
                    "y3": 58,
                    "x4": 50,
                    "y4": 58,
                }
            }
        ]
    }

    async def fake_coordinate_send(payload):
        coordinate_sends.append(payload.copy())

    async def fake_overlay_send(channel, payload):
        overlay_sends.append((channel, payload))
        if (
            payload["type"] == "ocr_text_invalidated"
            and sum(item[1]["type"] == "ocr_text_invalidated" for item in overlay_sends) >= 2
        ):
            finished.set()

    def fake_capture(_overlay_data):
        return next(captures), ((240, 80), 0, 0, 240, 80, 240, 80, "test"), pixel_payload

    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", _enabled_config)
    monkeypatch.setattr(get_overlay_coords, "send_word_coordinates_to_overlay", fake_coordinate_send)
    monkeypatch.setattr(get_overlay_coords.websocket_manager, "has_clients", lambda _channel: True)
    monkeypatch.setattr(get_overlay_coords.websocket_manager, "send", fake_overlay_send)
    monkeypatch.setattr(get_overlay_coords, "LAST_SENT_PRESENCE_SCAN_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(processor, "_capture_last_sent_presence_frame", fake_capture)
    logs = []
    monkeypatch.setattr(get_overlay_coords.logger, "info", lambda *args, **_kwargs: logs.append(args))

    async def run():
        await processor._send_word_coordinates_with_presence(_overlay_payload())
        task = processor._last_sent_presence_task
        assert task is not None
        await asyncio.wait_for(finished.wait(), timeout=1)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())

    presence_id = coordinate_sends[0]["presence_id"]
    assert [payload["type"] for _, payload in overlay_sends] == [
        "ocr_text_invalidated",
        "ocr_text_revalidated",
        "ocr_text_invalidated",
    ]
    assert overlay_sends[0] == (
        get_overlay_coords.ID_OVERLAY,
        {
            "type": "ocr_text_invalidated",
            "presence_id": presence_id,
            "remove_notation": True,
            "invalidate_lookups": True,
        },
    )
    assert overlay_sends[1][0] == get_overlay_coords.ID_OVERLAY
    assert overlay_sends[1][1]["presence_id"] == presence_id
    assert overlay_sends[1][1]["payload"]["data"] == _overlay_payload()["data"]
    assert overlay_sends[2][1]["presence_id"] == presence_id
    assert sum("disappeared" in str(args[0]) for args in logs) == 2


def test_new_primary_overlay_event_cancels_and_replaces_monitor(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    started = []
    cancelled = []

    async def fake_coordinate_send(_payload):
        return None

    async def fake_monitor(presence_id, _overlay_data, _generation):
        started.append(presence_id)
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(presence_id)
            raise

    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", _enabled_config)
    monkeypatch.setattr(get_overlay_coords, "send_word_coordinates_to_overlay", fake_coordinate_send)
    monkeypatch.setattr(get_overlay_coords.websocket_manager, "has_clients", lambda _channel: True)
    monkeypatch.setattr(processor, "_monitor_last_sent_overlay_text", fake_monitor)

    async def run():
        first_payload = _overlay_payload()
        await processor._send_word_coordinates_with_presence(first_payload)
        first_task = processor._last_sent_presence_task
        await asyncio.sleep(0)

        second_payload = _overlay_payload()
        await processor._send_word_coordinates_with_presence(second_payload)
        second_task = processor._last_sent_presence_task
        await asyncio.sleep(0)

        assert first_payload["presence_id"] != second_payload["presence_id"]
        assert first_task is not None and first_task.cancelled()
        assert second_task is not None and not second_task.done()
        processor._cancel_last_sent_presence_monitor()
        await asyncio.gather(second_task, return_exceptions=True)

    asyncio.run(run())

    assert started == cancelled
    assert len(started) == 2


def test_disabled_setting_sends_normally_without_starting_monitor(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    coordinate_sends = []

    async def fake_coordinate_send(payload):
        coordinate_sends.append(payload.copy())

    monkeypatch.setattr(
        get_overlay_coords,
        "get_overlay_config",
        lambda: SimpleNamespace(last_sent_ocr_presence_check=False),
    )
    monkeypatch.setattr(get_overlay_coords, "send_word_coordinates_to_overlay", fake_coordinate_send)

    payload = _overlay_payload()
    asyncio.run(processor._send_word_coordinates_with_presence(payload))

    assert coordinate_sends == [_overlay_payload()]
    assert "presence_id" not in payload
    assert processor._last_sent_presence_task is None
