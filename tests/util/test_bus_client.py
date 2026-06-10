"""Tests for the Python message-bus client (GameSentenceMiner.util.communication.bus_client).

A minimal real WebSocket "broker" runs in a background thread so the client is
exercised over an actual socket, including its handshake, reconnect loop,
request/response correlation, and inbound request handling.
"""

import asyncio
import json
import threading
import time

import pytest
import websockets

from GameSentenceMiner.util.communication import bus_client as bc

TOKEN = "tok"


class MiniBroker:
    """Just enough of the Electron broker to test the client end-to-end."""

    def __init__(self):
        self._loop = None
        self._ws = None
        self._server = None
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._stop_future = None
        self.frames = []
        self.port = 0
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> int:
        self._thread.start()
        assert self._ready.wait(5), "MiniBroker failed to start"
        return self.port

    def stop(self) -> None:
        if self._loop and self._stop_future and not self._stop_future.done():
            self._loop.call_soon_threadsafe(self._stop_future.set_result, None)
        self._thread.join(timeout=5)

    def _run(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        async def handler(ws):
            self._ws = ws
            async for raw in ws:
                msg = json.loads(raw)
                with self._lock:
                    self.frames.append(msg)
                if msg.get("kind") == "hello":
                    await ws.send(json.dumps(self._frame(msg["src"], "bus.welcome", "ack")))
                elif msg.get("kind") == "request" and msg.get("topic") == "echo":
                    reply = self._frame(msg["src"], "echo", "response", data=msg.get("data"))
                    reply["corr"] = msg["id"]
                    reply["ok"] = True
                    await ws.send(json.dumps(reply))

        self._loop = asyncio.get_running_loop()
        self._stop_future = self._loop.create_future()
        self._server = await websockets.serve(handler, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        self._ready.set()
        # Run until stop() resolves the future, then shut down cleanly.
        await self._stop_future
        self._server.close()
        await self._server.wait_closed()

    @staticmethod
    def _frame(dst, topic, kind, data=None):
        frame = {"v": 1, "id": f"b-{time.time()}", "src": "main", "dst": dst, "kind": kind, "topic": topic}
        if data is not None:
            frame["data"] = data
        return frame

    def send(self, frame) -> None:
        asyncio.run_coroutine_threadsafe(self._ws.send(json.dumps(frame)), self._loop)

    def wait_for(self, predicate, timeout=5):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                for frame in self.frames:
                    if predicate(frame):
                        return frame
            time.sleep(0.02)
        with self._lock:
            raise AssertionError(f"No matching frame. Saw: {self.frames}")


@pytest.fixture
def broker():
    b = MiniBroker()
    b.start()
    yield b
    b.stop()


@pytest.fixture
def client(broker):
    c = bc.BusClient(client_id="tester", port=broker.port, token=TOKEN)
    c.start()
    assert c.wait_connected(5), "client did not connect"
    yield c
    c.stop()


def test_is_bus_available(monkeypatch):
    monkeypatch.setenv("GSM_BROKER_PORT", "1234")
    monkeypatch.setenv("GSM_BROKER_TOKEN", "x")
    assert bc.is_bus_available() is True
    monkeypatch.delenv("GSM_BROKER_PORT")
    assert bc.is_bus_available() is False


def test_sends_hello_with_token(broker, client):
    hello = broker.wait_for(lambda f: f.get("kind") == "hello")
    assert hello["src"] == "tester"
    assert hello["data"]["token"] == TOKEN


def test_publish_event_reaches_broker(broker, client):
    client.publish("main", "ping", {"x": 1})
    frame = broker.wait_for(lambda f: f.get("topic") == "ping")
    assert frame["kind"] == "event"
    assert frame["data"] == {"x": 1}


def test_request_returns_response(broker, client):
    result = client.request("main", "echo", {"v": 7}, timeout=5)
    assert result == {"v": 7}


def test_handles_inbound_request(broker, client):
    client.handle("compute", lambda msg: msg["data"]["a"] + msg["data"]["b"])
    broker.send(
        {
            "v": 1,
            "id": "r1",
            "src": "main",
            "dst": "tester",
            "kind": "request",
            "topic": "compute",
            "data": {"a": 2, "b": 3},
        }
    )
    reply = broker.wait_for(lambda f: f.get("kind") == "response" and f.get("corr") == "r1")
    assert reply["ok"] is True
    assert reply["data"] == 5


def test_subscribe_receives_events(broker, client):
    received = []
    client.subscribe("notify", lambda msg: received.append(msg))
    broker.send(
        {"v": 1, "id": "e1", "src": "main", "dst": "tester", "kind": "event", "topic": "notify", "data": {"hi": 1}}
    )
    deadline = time.time() + 5
    while time.time() < deadline and not received:
        time.sleep(0.02)
    assert received, "subscriber was not invoked"
    assert received[0]["data"] == {"hi": 1}
