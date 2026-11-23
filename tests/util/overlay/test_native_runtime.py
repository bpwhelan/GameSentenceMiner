import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from GameSentenceMiner.util.overlay import get_overlay_coords as overlay
from GameSentenceMiner.util.overlay import native_runtime


def test_completed_native_scan_only_records_unbacked_scans_without_bouncing_back(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY", "1")
    recorded = AsyncMock()
    recycled = []
    processor = SimpleNamespace(
        _is_sentence_recycled=lambda text: (_ for _ in ()).throw(AssertionError("should not check recycled on return")),
        _send_sentence_recycled_status=lambda **payload: recycled.append(payload),
        _record_overlay_scan=recorded,
    )
    payload = {
        "is_final": True,
        "data": [{"text": "猫"}],
        "line_id": None,
        "source": "hotkey",
        "scan_summary": "Overlay OCR complete: meikiocr sent 1 text boxes",
    }
    asyncio.run(native_runtime.accept_result(processor, payload))
    assert processor.last_oneocr_result == "猫"
    assert processor.last_lens_result == ""
    assert recycled == []
    recorded.assert_awaited_once_with("猫", source="hotkey")
    recorded.reset_mock()
    # Text-driven scans (line_id present) are owned end-to-end by Rust; Python ignores them.
    payload["line_id"] = "existing-hook-line"
    payload["data"] = [{"text": "犬"}]
    asyncio.run(native_runtime.accept_result(processor, payload))
    recorded.assert_not_awaited()
    assert recycled == []
    assert processor.last_oneocr_result == "猫"
    # Non-final scans are ignored.
    payload["line_id"] = None
    payload["is_final"] = False
    payload["data"] = [{"text": "partial"}]
    asyncio.run(native_runtime.accept_result(processor, payload))
    assert processor.last_oneocr_result == "猫"
    recorded.assert_not_awaited()


def test_tauri_scan_forwards_context_without_initializing_python_ocr(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY", "1")
    processor = overlay.OverlayProcessor()
    send = AsyncMock()
    monkeypatch.setattr(native_runtime, "send", send)
    monkeypatch.setattr(processor, "_is_sentence_recycled", lambda text: text == "日本語")
    monkeypatch.setattr(processor, "_ensure_correct_engine_loaded", lambda: (_ for _ in ()).throw(AssertionError()))
    asyncio.run(processor.find_box_and_send_to_overlay(SimpleNamespace(id="line", text="日本語")))
    send.assert_awaited_once_with(
        processor,
        "scan",
        line_id="line",
        text="日本語",
        is_sentence_recycled=True,
        precomputed=None,
        retries=5,
        manual=False,
        source=None,
        source_instance=None,
    )


def test_tauri_periodic_loop_only_synchronizes_context(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY", "1")
    processor = overlay.OverlayProcessor()
    monkeypatch.setattr(overlay, "overlay_processor", processor)
    monkeypatch.setattr(overlay.websocket_manager, "has_clients", lambda _: True)
    send = AsyncMock()
    monkeypatch.setattr(native_runtime, "send", send)

    async def stop(_):
        raise asyncio.CancelledError

    monkeypatch.setattr(overlay.asyncio, "sleep", stop)
    try:
        asyncio.run(overlay._overlay_loop())
    except asyncio.CancelledError:
        pass
    send.assert_awaited_once_with(processor)


def test_tauri_scan_forwards_hook_identity_and_respects_manual_line_sources(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY", "1")
    processor = overlay.OverlayProcessor()
    send = AsyncMock()
    monkeypatch.setattr(native_runtime, "send", send)
    line = SimpleNamespace(id="hooked", text="日本語", source="texthook", source_instance="hook-1")
    asyncio.run(processor.find_box_and_send_to_overlay(line))
    assert send.call_args.kwargs["source"] == "texthook"
    assert send.call_args.kwargs["source_instance"] == "hook-1"
    assert send.call_args.kwargs["manual"] is False
    line.source = overlay.TextSource.HOTKEY
    asyncio.run(processor.find_box_and_send_to_overlay(line))
    assert send.call_args.kwargs["manual"] is True


def test_pause_recovery_and_background_do_not_capture_in_python(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY", "1")
    processor = overlay.OverlayProcessor()
    send = AsyncMock()
    monkeypatch.setattr(native_runtime, "send", send)
    asyncio.run(processor.set_skip_scan_state(True))
    asyncio.run(processor.recover_after_skip(sequence=1))
    asyncio.run(processor.capture_and_send_manual_background())
    assert [call.args[1] for call in send.await_args_list] == ["pause", "scan", "background"]


def test_python_standalone_keeps_legacy_runtime(monkeypatch):
    monkeypatch.delenv("GSM_NATIVE_OVERLAY", raising=False)
    assert not native_runtime.enabled()


def test_window_movement_reprojects_native_results_without_requesting_ocr(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY", "1")
    processor = overlay.OverlayProcessor()
    send = AsyncMock()
    monkeypatch.setattr(native_runtime, "send", send)

    asyncio.run(processor.reprocess_and_send_last_results())

    send.assert_awaited_once_with(processor, "reproject")


def test_desktop_owned_scan_sends_no_python_recycled_verdict(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY", "1")
    monkeypatch.setenv("GSM_NATIVE_RECYCLED_LINES", "1")
    processor = overlay.OverlayProcessor()
    send = AsyncMock()
    monkeypatch.setattr(native_runtime, "send", send)
    monkeypatch.setattr(processor, "_is_sentence_recycled", Mock(side_effect=AssertionError("Python checked the line")))
    asyncio.run(processor.find_box_and_send_to_overlay(SimpleNamespace(id="line", text="some dialogue")))
    assert "is_sentence_recycled" not in send.await_args.kwargs
