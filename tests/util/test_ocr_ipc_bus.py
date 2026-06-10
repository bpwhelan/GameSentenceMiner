"""End-to-end test of the OCR <-> Electron adapter (ocr_ipc) over the message bus.

Reuses the MiniBroker from test_bus_client to stand in for the Electron broker,
then drives ocr_ipc through its public API (the same calls gsm_ocr.py makes) and
asserts events reach the broker and commands reach the registered handler.
"""

import time

import pytest

from GameSentenceMiner.util.communication import bus_client as bc
from GameSentenceMiner.util.communication import ocr_ipc
from tests.util.test_bus_client import MiniBroker, TOKEN


@pytest.fixture
def ocr_over_bus(monkeypatch):
    broker = MiniBroker()
    broker.start()
    monkeypatch.setenv("GSM_BROKER_PORT", str(broker.port))
    monkeypatch.setenv("GSM_BROKER_TOKEN", TOKEN)
    monkeypatch.setenv("GSM_CLIENT_ID", "ocr")
    # Reset the process-wide singleton so it picks up this broker's env.
    bc._client = None

    yield broker

    client = bc._client
    if client:
        client.stop()
    bc._client = None
    broker.stop()


def test_announce_event_reaches_broker(ocr_over_bus):
    ocr_ipc.start_ipc_listener()
    assert bc.get_bus().wait_connected(5), "OCR bus client did not connect"

    ocr_ipc.announce_ocr_result("こんにちは", {"source": "test"})

    frame = ocr_over_bus.wait_for(lambda f: f.get("topic") == ocr_ipc.OCR_EVENT_TOPIC)
    assert frame["src"] == "ocr"
    assert frame["dst"] == "*"  # broadcast: both main (UI) and backend consume it
    assert frame["data"]["event"] == "ocr_result"
    assert frame["data"]["data"]["text"] == "こんにちは"
    assert frame["data"]["data"]["source"] == "test"


def test_command_invokes_registered_handler(ocr_over_bus):
    received = []
    ocr_ipc.register_command_handler(lambda cmd: received.append(cmd))
    ocr_ipc.start_ipc_listener()
    assert bc.get_bus().wait_connected(5), "OCR bus client did not connect"

    ocr_over_bus.send(
        {
            "v": 1,
            "id": "c1",
            "src": "main",
            "dst": "ocr",
            "kind": "command",
            "topic": ocr_ipc.OCR_COMMAND_TOPIC,
            "data": {"command": "pause", "data": {"state": True}},
        }
    )

    deadline = time.time() + 5
    while time.time() < deadline and not received:
        time.sleep(0.02)
    assert received, "command handler was not invoked"
    assert received[0]["command"] == "pause"
    assert received[0]["data"] == {"state": True}
