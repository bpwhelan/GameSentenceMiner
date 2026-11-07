import asyncio
from types import SimpleNamespace

import pytest
from PIL import Image

from GameSentenceMiner import gametext
from GameSentenceMiner.util.overlay import get_overlay_coords as overlay
from GameSentenceMiner.util.text_log import TextSource


def test_recovery_does_not_inject_a_whole_scan_into_stats(monkeypatch):
    recovered = []
    monkeypatch.setattr(overlay, "get_overlay_config", lambda: SimpleNamespace(inject_scanned_lines=True))
    monkeypatch.setattr(overlay.gsm_state, "last_overlay_scan_line", None)
    monkeypatch.setattr(overlay.gsm_state, "current_game", "game")
    monkeypatch.setattr(gametext, "is_text_intake_paused", lambda: False)
    monkeypatch.setattr(gametext, "recover_skip_landing", lambda text, scene: recovered.append((text, scene)))

    async def forbidden(*args, **kwargs):
        pytest.fail("recovery must use verified suffix admission, not ordinary scan injection")

    monkeypatch.setattr(gametext, "add_line_to_text_log", forbidden)
    asyncio.run(overlay.OverlayProcessor._record_overlay_scan(None, "visible text", source=TextSource.SKIP_RECOVERY))
    assert recovered == [("visible text", "game")]
    assert overlay.gsm_state.last_overlay_scan_line.text == "visible text"


def test_recovery_stability_wait_is_bounded_for_animated_frames(monkeypatch):
    sleeps = []
    processor = SimpleNamespace(
        _skip_scan_suspended=False,
        _current_sequence=7,
        _get_screenshot_and_offset=lambda: (Image.new("RGB", (200, 100)),),
    )

    async def sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(overlay.asyncio, "sleep", sleep)
    assert asyncio.run(overlay.OverlayProcessor._wait_for_skip_landing(processor, 7))
    assert len(sleeps) <= 8


def test_new_generation_cancels_recovery_before_capture(monkeypatch):
    processor = SimpleNamespace(
        _skip_scan_suspended=False, _current_sequence=8, _get_screenshot_and_offset=lambda: pytest.fail("stale capture")
    )
    assert not asyncio.run(overlay.OverlayProcessor._wait_for_skip_landing(processor, 7))


def test_periodic_scans_are_blocked_while_skipping():
    processor = SimpleNamespace(_skip_scan_suspended=True)
    asyncio.run(overlay.OverlayProcessor.find_box_and_send_to_overlay(processor))


def test_periodic_scan_cannot_cancel_pending_recovery():
    processor = SimpleNamespace(_skip_scan_suspended=False, _skip_recovery_task=object())
    asyncio.run(overlay.OverlayProcessor.find_box_and_send_to_overlay(processor))


def test_late_recovery_cannot_restart_a_stopped_text_runtime(monkeypatch):
    monkeypatch.setattr(gametext, "_text_runtime", None)
    monkeypatch.setattr(gametext, "is_text_intake_paused", lambda: False)
    assert not gametext.recover_skip_landing("古い画面の文章", "game")
