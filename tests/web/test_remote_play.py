from dataclasses import dataclass, field

import pytest

from GameSentenceMiner.web.remote_play import (
    RemoteInputGate,
    RemotePlayAccess,
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
