import asyncio
import json
from dataclasses import dataclass, field
from types import SimpleNamespace

import pytest

from GameSentenceMiner.web.gsm_websocket import (
    ID_OVERLAY,
    ID_REMOTE_PLAY,
    EndpointSpec,
    MultiplexWebsocketServerThread,
    WebsocketManager,
)
from GameSentenceMiner.web.remote_play import (
    RemoteInputGate,
    RemotePlayAccess,
    RemotePlaySessionManager,
    is_remote_play_origin_allowed,
    map_letterboxed_pointer,
)


@pytest.mark.parametrize(
    ("pointer", "display", "source", "expected"),
    [
        ((640, 360), (1280, 720), (1920, 1080), (0.5, 0.5, True)),
        ((500, 500), (1000, 1000), (1920, 1080), (0.5, 0.5, True)),
        ((500, 0), (1000, 1000), (1920, 1080), (0.5, 0.0, False)),
        ((500, 1000), (1000, 1000), (1920, 1080), (0.5, 1.0, False)),
        ((500, -20), (1000, 500), (1000, 1000), (0.5, 0.0, False)),
    ],
)
def test_map_letterboxed_pointer_clamps_to_source(pointer, display, source, expected):
    result = map_letterboxed_pointer(*pointer, *display, *source)

    assert result.x == pytest.approx(expected[0])
    assert result.y == pytest.approx(expected[1])
    assert result.inside_video is expected[2]


def test_remote_play_access_uses_an_expiring_token(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("GameSentenceMiner.web.remote_play.time.monotonic", lambda: clock[0])
    access = RemotePlayAccess(token_ttl_seconds=30)

    token = access.issue_token()

    assert access.validate(token) is True
    assert access.validate("wrong-token") is False
    clock[0] = 131.0
    assert access.validate(token) is False


@dataclass
class FakeInputBackend:
    events: list[tuple[str, dict]] = field(default_factory=list)
    release_count: int = 0
    available: bool = True

    def prepare(self) -> bool:
        return True

    def dispatch(self, event_type: str, payload: dict) -> bool:
        self.events.append((event_type, payload))
        return True

    def release_all(self) -> None:
        self.release_count += 1


def test_input_gate_defaults_disabled_and_escape_releases_capture():
    backend = FakeInputBackend()
    gate = RemoteInputGate(backend)

    assert gate.handle("pointer_move", {"x": 0.5, "y": 0.5}) is False
    assert backend.events == []

    gate.set_enabled(True)
    assert gate.handle("pointer_move", {"x": 0.5, "y": 0.5}) is True
    assert gate.handle("key_down", {"code": "Escape"}) is False
    assert gate.enabled is False
    assert backend.release_count == 1


@pytest.mark.parametrize("reason", ["blur", "disconnect", "pagehide"])
def test_input_gate_teardown_releases_held_input(reason):
    backend = FakeInputBackend()
    gate = RemoteInputGate(backend)
    gate.set_enabled(True)
    gate.handle("key_down", {"code": "KeyA"})

    gate.stop(reason)

    assert gate.enabled is False
    assert backend.release_count == 1


class FakeWebsocket:
    def __init__(self, messages=(), *, origin="http://localhost:7275", host="localhost:7275"):
        self.request = SimpleNamespace(headers={"Origin": origin, "Host": host})
        self._messages = iter(messages)
        self.sent = []
        self.closed = None

    async def recv(self):
        return next(self._messages)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._messages)
        except StopIteration as error:
            raise StopAsyncIteration from error

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def close(self, code, reason):
        self.closed = (code, reason)


def test_remote_play_origin_must_match_the_public_host():
    assert is_remote_play_origin_allowed("http://localhost:7275", "localhost:7275") is True
    assert is_remote_play_origin_allowed("https://gsm.example.test", "gsm.example.test") is True
    assert is_remote_play_origin_allowed("https://attacker.example", "gsm.example.test") is False
    assert is_remote_play_origin_allowed(None, "localhost:7275") is False


def test_signaling_rejects_an_invalid_token():
    manager = RemotePlaySessionManager()
    websocket = FakeWebsocket([json.dumps({"type": "authenticate", "token": "invalid"})])

    asyncio.run(manager.handle_connection(websocket))

    assert websocket.closed == (1008, "Authentication failed")
    assert manager.has_client() is False


def test_signaling_rejects_a_second_client():
    manager = RemotePlaySessionManager()
    token = manager.access.issue_token()
    existing_client = object()
    manager._active_websocket = existing_client
    websocket = FakeWebsocket([json.dumps({"type": "authenticate", "token": token})])

    asyncio.run(manager.handle_connection(websocket))

    assert websocket.closed == (1013, "Remote play already has an active client")
    assert manager._active_websocket is existing_client


def test_session_cleanup_stops_peer_media_and_input():
    class FakePeer:
        closed = False

        async def close(self):
            self.closed = True

    class FakeMedia:
        stopped = False

        async def stop(self):
            self.stopped = True

    websocket = object()
    backend = FakeInputBackend()
    gate = RemoteInputGate(backend)
    gate.set_enabled(True)
    peer = FakePeer()
    media = FakeMedia()
    manager = RemotePlaySessionManager()
    manager._active_websocket = websocket
    manager._input_gate = gate
    manager._peer = peer
    manager._media = media

    asyncio.run(manager._cleanup(websocket))

    assert peer.closed is True
    assert media.stopped is True
    assert backend.release_count == 1
    assert manager.has_client() is False


def test_multiplex_server_delegates_remote_play_connection():
    handled = []

    async def handle_connection(websocket):
        handled.append(websocket)

    server = MultiplexWebsocketServerThread(
        name="test",
        get_port_func=lambda: 0,
        msg_queue=None,
        is_paused_func=lambda: False,
        endpoint_specs={ID_REMOTE_PLAY: EndpointSpec(connection_handler=handle_connection)},
    )
    websocket = SimpleNamespace(request=SimpleNamespace(path="/ws/remote-play"))

    asyncio.run(server._handler(websocket))

    assert handled == [websocket]


def test_remote_client_is_an_overlay_consumer_and_receives_ocr_payload(monkeypatch):
    manager = WebsocketManager()
    forwarded = []
    future = object()
    monkeypatch.setattr("GameSentenceMiner.web.remote_play.remote_play_manager.has_client", lambda: True)
    monkeypatch.setattr(
        "GameSentenceMiner.web.remote_play.remote_play_manager.send_overlay_payload_nowait",
        lambda payload: forwarded.append(payload) or future,
    )
    payload = {"type": "word_coordinates", "data": [{"text": "猫"}]}

    assert manager.has_clients(ID_OVERLAY) is True
    assert manager.send_nowait(ID_OVERLAY, payload) == [future]
    assert forwarded == [payload]


def test_input_cannot_be_enabled_without_a_connected_peer():
    backend = FakeInputBackend()
    manager = RemotePlaySessionManager()
    manager._input_gate = RemoteInputGate(backend)
    websocket = FakeWebsocket()

    asyncio.run(manager._handle_message(websocket, json.dumps({"type": "input_enabled", "enabled": True})))

    assert manager._input_gate.enabled is False
    assert websocket.sent == [{"type": "input_state", "enabled": False, "accepted": False}]
