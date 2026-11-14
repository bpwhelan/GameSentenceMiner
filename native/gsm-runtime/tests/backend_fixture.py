"""Disposable backend for the real desktop/native transport integration check."""

import json
import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from GameSentenceMiner.util.communication.bus_client import BusClient

stopped = threading.Event()
client = BusClient()
client.subscribe("backend.command", lambda msg: stopped.set() if msg.get("data", {}).get("function") == "quit" else None)
client.handle("fixture.echo", lambda msg: msg["data"])
client.handle("fixture.crash", lambda msg: os._exit(7))


def ingest(message):
    payload = message["data"]
    Path(os.environ["GSM_FIXTURE_RECEIVED"]).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return {
        "status": "accepted",
        "observation_id": payload["observationId"],
        "raw_text": payload["text"],
        "processed_text": payload["text"].strip(),
    }


client.handle("text.ingress.v2", ingest)
client.start()
try:
    if not client.wait_connected(10):
        raise RuntimeError("Fixture did not complete its native handshake")
    reply = client.request("main", "fixture.roundtrip", {"text": "日本語🦀"})
    if reply != {"text": "日本語🦀"}:
        raise RuntimeError("Main-address request failed")
    client.publish("main", "backend.event", {"function": "initialized"}).result(timeout=2)
    print("native fixture initialized", flush=True)
    stopped.wait(90)
finally:
    client.stop()
