"""End-to-end test of the backend <-> Electron adapter (electron_ipc) over the bus.

Covers backend.command dispatch, backend.event emission, and the bridge that
turns a broadcast ocr.event(result) into the backend's ocr_result command.
"""

import time

import pytest

from GameSentenceMiner.util.communication import bus_client as bc
from GameSentenceMiner.util.communication import electron_ipc as e
from tests.util.test_bus_client import MiniBroker, TOKEN


@pytest.fixture
def backend_over_bus(monkeypatch):
    broker = MiniBroker()
    broker.start()
    monkeypatch.setenv("GSM_BROKER_PORT", str(broker.port))
    monkeypatch.setenv("GSM_BROKER_TOKEN", TOKEN)
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")
    bc._client = None
    yield broker
    client = bc._client
    if client:
        client.stop()
    bc._client = None
    broker.stop()


def _wait(predicate, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline and not predicate():
        time.sleep(0.02)
    return predicate()


def test_send_message_emits_backend_event(backend_over_bus):
    e.register_command_handler(lambda c: None)
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)

    e.send_message("initialized", {"ready": True})

    frame = backend_over_bus.wait_for(lambda f: f.get("topic") == e.BACKEND_EVENT_TOPIC)
    assert frame["dst"] == "main"
    assert frame["data"]["function"] == "initialized"
    assert frame["data"]["data"] == {"ready": True}


def test_backend_command_dispatched(backend_over_bus):
    received = []
    e.register_command_handler(lambda c: received.append(c))
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)

    backend_over_bus.send(
        {
            "v": 1,
            "id": "c1",
            "src": "main",
            "dst": "backend",
            "kind": "command",
            "topic": e.BACKEND_COMMAND_TOPIC,
            "data": {"function": "reload_settings"},
        }
    )

    assert _wait(lambda: len(received) > 0), "command handler not invoked"
    assert received[0]["function"] == "reload_settings"


def test_ocr_broadcast_bridges_to_backend_handler(backend_over_bus):
    received = []
    e.register_command_handler(lambda c: received.append(c))
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)

    # Simulate the OCR process broadcasting a result onto the bus.
    backend_over_bus.send(
        {
            "v": 1,
            "id": "o1",
            "src": "ocr",
            "dst": "backend",
            "kind": "event",
            "topic": e.OCR_EVENT_TOPIC,
            "data": {"event": "ocr_result", "data": {"text": "セリフ", "source": "OCR"}},
        }
    )

    assert _wait(lambda: len(received) > 0), "ocr_result was not bridged"
    assert received[0]["function"] == "ocr_result"
    assert received[0]["data"]["text"] == "セリフ"
