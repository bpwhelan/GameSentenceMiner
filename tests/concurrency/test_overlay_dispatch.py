from __future__ import annotations

from types import MappingProxyType, SimpleNamespace

from GameSentenceMiner.util.communication import overlay_dispatch
from GameSentenceMiner.util.communication.overlay_dispatch import OverlayActor, OverlayCommand


class _ImmediateFuture:
    def done(self):
        return True

    def result(self):
        return None

    def add_done_callback(self, callback):
        callback(self)


def test_overlay_actor_advances_processor_generation_and_submits_scan(monkeypatch):
    calls = []

    class FakeProcessor:
        ready = True
        processing_loop = object()
        _current_sequence = 0

        async def find_box_and_send_to_overlay(self, line, *, dict_from_ocr, sequence, source):
            calls.append((line, dict_from_ocr, sequence, source))

    processor = FakeProcessor()

    def submit(loop, coroutine):
        assert loop is processor.processing_loop
        try:
            coroutine.send(None)
        except StopIteration:
            pass
        return _ImmediateFuture()

    monkeypatch.setattr(
        "GameSentenceMiner.util.overlay.get_overlay_coords.get_overlay_processor",
        lambda: processor,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.gsm_websocket.websocket_manager",
        SimpleNamespace(has_clients=lambda _server_id: True),
    )
    monkeypatch.setattr(overlay_dispatch, "submit_coroutine_to_loop", submit)

    record = SimpleNamespace(
        skip_overlay=False,
        metadata=MappingProxyType({"dict_from_ocr": {"lines": []}}),
    )
    line = SimpleNamespace(id="line-1", text="text")
    actor = OverlayActor()

    actor.handle(OverlayCommand(record, line))

    assert processor._current_sequence == 1
    assert calls == [(line, {"lines": []}, 1, None)]


def test_overlay_actor_retries_latest_line_when_processor_becomes_ready(monkeypatch):
    calls = []

    class FakeProcessor:
        ready = False
        processing_loop = object()
        _current_sequence = 0

        async def find_box_and_send_to_overlay(self, line, *, dict_from_ocr, sequence, source):
            calls.append((line.id, sequence))

    processor = FakeProcessor()

    def submit(_loop, coroutine):
        try:
            coroutine.send(None)
        except StopIteration:
            pass
        return _ImmediateFuture()

    monkeypatch.setattr(
        "GameSentenceMiner.util.overlay.get_overlay_coords.get_overlay_processor",
        lambda: processor,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.gsm_websocket.websocket_manager",
        SimpleNamespace(has_clients=lambda _server_id: True),
    )
    monkeypatch.setattr(overlay_dispatch, "submit_coroutine_to_loop", submit)

    record = SimpleNamespace(skip_overlay=False, metadata=MappingProxyType({}))
    actor = OverlayActor()
    actor.handle(OverlayCommand(record, SimpleNamespace(id="line-1")))
    assert calls == []

    processor.ready = True
    actor.on_idle()

    assert calls == [("line-1", 1)]


def test_overlay_actor_retains_latest_command_until_client_connects(monkeypatch):
    calls = []
    connected = False

    class FakeProcessor:
        ready = True
        processing_loop = object()
        _current_sequence = 0

        async def find_box_and_send_to_overlay(self, line, *, dict_from_ocr, sequence, source):
            calls.append((line, sequence, source))

    processor = FakeProcessor()

    def submit(_loop, coroutine):
        try:
            coroutine.send(None)
        except StopIteration:
            pass
        return _ImmediateFuture()

    monkeypatch.setattr(
        "GameSentenceMiner.util.overlay.get_overlay_coords.get_overlay_processor",
        lambda: processor,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.gsm_websocket.websocket_manager",
        SimpleNamespace(has_clients=lambda _server_id: connected),
    )
    monkeypatch.setattr(overlay_dispatch, "submit_coroutine_to_loop", submit)

    actor = OverlayActor()
    actor.handle(OverlayCommand(source="hotkey"))
    assert calls == []

    connected = True
    actor.on_idle()

    assert calls == [(None, 1, "hotkey")]
