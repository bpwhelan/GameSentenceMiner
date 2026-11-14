import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from GameSentenceMiner.util.overlay import get_overlay_coords as overlay


def test_periodic_scans_pause_for_eight_seconds_and_new_text_extends_pause(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(overlay.time, "monotonic", lambda: now[0])
    processor = overlay.OverlayProcessor()
    assert processor.periodic_scan_delay() == 0
    processor.note_text_event()
    now[0] += 5
    assert processor.periodic_scan_delay() == pytest.approx(3)
    processor.note_text_event()
    now[0] += 7.9
    assert processor.periodic_scan_delay() == pytest.approx(0.1)
    now[0] += 0.1
    assert processor.periodic_scan_delay() == 0


def test_periodic_request_does_not_cancel_text_scan_during_quiet_period(monkeypatch):
    processor = overlay.OverlayProcessor()
    processor.note_text_event()
    activity = []
    monkeypatch.setattr(processor, "_mark_ocr_engine_active", lambda: activity.append(True))
    asyncio.run(processor.find_box_and_send_to_overlay(check_against_last=True, local_ocr_retry=0))
    assert activity == []


def test_text_event_resets_pause_before_scan_and_manual_scans_still_run(monkeypatch):
    processor = overlay.OverlayProcessor()
    processor._current_sequence = 1
    monkeypatch.setattr(
        processor, "_mark_ocr_engine_active", lambda: (_ for _ in ()).throw(RuntimeError("scan reached"))
    )

    async def run():
        with pytest.raises(RuntimeError, match="scan reached"):
            await processor.find_box_and_send_to_overlay(SimpleNamespace(id="line"), sequence=1)
        assert processor.periodic_scan_delay() > 7
        with pytest.raises(RuntimeError, match="scan reached"):
            await processor.find_box_and_send_to_overlay(source=overlay.TextSource.MANUAL)

    asyncio.run(run())


def test_periodic_loop_sleeps_and_rechecks_extended_deadline(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(overlay.time, "monotonic", lambda: now[0])
    processor = overlay.OverlayProcessor()
    processor.note_text_event()
    scan = AsyncMock()
    monkeypatch.setattr(processor, "find_box_and_send_to_overlay", scan)
    monkeypatch.setattr(overlay, "overlay_processor", processor)
    monkeypatch.setattr(overlay.websocket_manager, "has_clients", lambda _: True)
    monkeypatch.setattr(
        overlay,
        "get_config",
        lambda: SimpleNamespace(
            overlay=SimpleNamespace(
                periodic=True,
                periodic_interval=0.5,
                scan_on_mouse_move=False,
            )
        ),
    )
    sleeps = []

    async def sleep(delay):
        sleeps.append(delay)
        if len(sleeps) == 1:
            now[0] += 5
            processor.note_text_event()
            now[0] += 3
        elif len(sleeps) == 2:
            now[0] += delay
        else:
            raise asyncio.CancelledError

    monkeypatch.setattr(overlay.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(overlay._overlay_loop())
    assert sleeps == [8, 5, 0.5]
    scan.assert_awaited_once_with(check_against_last=True, local_ocr_retry=0)
