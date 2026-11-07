from __future__ import annotations

from types import MappingProxyType, SimpleNamespace

import pytest

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


@pytest.fixture
def skip_overlay(monkeypatch):
    scans, controls = [], []

    class Processor:
        ready = True
        processing_loop = object()
        _current_sequence = 0

        async def set_skip_scan_state(self, active):
            controls.append(active)

        async def recover_after_skip(self, *, sequence):
            scans.append((None, None, "skip_recovery"))

        async def find_box_and_send_to_overlay(self, line, *, dict_from_ocr, sequence, source):
            scans.append((line, dict_from_ocr, source))

    processor = Processor()
    connection = SimpleNamespace(connected=True)
    scene = SimpleNamespace(current_game="game")
    monkeypatch.setattr("GameSentenceMiner.util.config.configuration.gsm_state", scene)
    monkeypatch.setattr("GameSentenceMiner.util.overlay.get_overlay_coords.get_overlay_processor", lambda: processor)
    monkeypatch.setattr(
        "GameSentenceMiner.web.gsm_websocket.websocket_manager",
        SimpleNamespace(has_clients=lambda _: connection.connected),
    )

    def submit(_loop, coroutine):
        try:
            coroutine.send(None)
        except StopIteration:
            pass
        return _ImmediateFuture()

    monkeypatch.setattr(overlay_dispatch, "submit_coroutine_to_loop", submit)
    return SimpleNamespace(actor=OverlayActor(), scans=scans, controls=controls, connection=connection, scene=scene)


def test_skip_suspends_burst_then_scans_current_screen_without_another_line(skip_overlay):
    actor = skip_overlay.actor
    actor.set_skipping(True, scene="game")
    record = SimpleNamespace(skip_overlay=False, metadata={"dict_from_ocr": {"stale": True}})
    for i in range(20):
        actor.handle(OverlayCommand(record, SimpleNamespace(id=i)))
    assert skip_overlay.scans == []
    actor.set_skipping(False, scene="game")
    actor.on_idle()
    actor.on_idle()
    assert skip_overlay.controls == [True, False]
    assert skip_overlay.scans == [(None, None, "skip_recovery")]


def test_recovery_is_retained_for_late_connection_but_cancelled_on_game_change(skip_overlay):
    actor = skip_overlay.actor
    actor.set_skipping(True, scene="game")
    actor.on_idle()
    skip_overlay.connection.connected = False
    actor.set_skipping(False, scene="game")
    actor.on_idle()
    assert skip_overlay.scans == []
    skip_overlay.scene.current_game = "other"
    skip_overlay.connection.connected = True
    actor.on_idle()
    assert skip_overlay.scans == []


def test_explicit_hotkey_scan_can_override_skip_pause(skip_overlay):
    skip_overlay.actor.set_skipping(True, scene="game")
    skip_overlay.actor.handle(OverlayCommand(source="hotkey"))
    assert skip_overlay.scans == [(None, None, "hotkey")]


def test_stopping_dispatcher_releases_processor_pause(skip_overlay):
    skip_overlay.actor.set_skipping(True, scene="game")
    skip_overlay.actor.on_idle()
    skip_overlay.actor.on_stop()
    assert skip_overlay.controls == [True, False]
