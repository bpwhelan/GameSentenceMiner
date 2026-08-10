from __future__ import annotations

import time
from types import SimpleNamespace

from GameSentenceMiner.util.communication import text_ingress_outbox
from GameSentenceMiner.util.communication.text_ingress_outbox import TextIngressOutbox


def _wait_until(predicate, timeout: float = 1.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


def test_disconnected_observation_does_not_block_newer_delivery(monkeypatch):
    connected = False
    delivered = []

    class FakeBus:
        @property
        def connected(self):
            return connected

        def request(self, _target, _topic, payload, timeout):
            assert timeout == 0.35
            delivered.append(payload["observationId"])
            return {"status": "accepted", "observation_id": payload["observationId"]}

    monkeypatch.setattr(text_ingress_outbox.bus_client, "get_bus", lambda: FakeBus())
    outbox = TextIngressOutbox(capacity=4)
    try:
        assert outbox.submit({"observationId": "first", "text": "one"})
        assert outbox.submit({"observationId": "second", "text": "two"})
        connected = True

        assert _wait_until(lambda: outbox.metrics_snapshot().completed == 2)
        assert set(delivered) == {"first", "second"}
    finally:
        outbox.stop()


def test_outbox_capacity_is_bounded_across_scheduled_retries(monkeypatch):
    monkeypatch.setattr(
        text_ingress_outbox.bus_client,
        "get_bus",
        lambda: SimpleNamespace(connected=False),
    )
    outbox = TextIngressOutbox(capacity=1)
    try:
        assert outbox.submit({"observationId": "first", "text": "one"})
        assert not outbox.submit({"observationId": "second", "text": "two"})
        metrics = outbox.metrics_snapshot()
        assert metrics.pending == 1
        assert metrics.backpressured == 1
    finally:
        outbox.stop()
