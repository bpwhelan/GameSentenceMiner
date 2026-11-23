"""Overlay WebSocket workloads for benchmark_reader_ai.py --overlay."""

import json
import time

from benchmark_reader_projection import eventually
from websockets.sync.client import connect


def verify_attached(port, model):
    with connect(f"ws://127.0.0.1:{port}/ws/overlay") as first, connect(f"ws://127.0.0.1:{port}/ws/overlay") as second:
        # A backend-owned profile request lets us wait for the upstream handshake.
        def joined(socket):
            socket.send('{"type":"get-gsm-profile-state"}')
            while True:
                frame = socket.recv(timeout=10)
                if frame in ("True", "False"):
                    return frame == "True"

        eventually(lambda: joined(first))
        eventually(lambda: joined(second))
        before = len(model.prompts)
        first.send(
            json.dumps(
                {"type": "translate-request", "request_id": "joined", "blocks": [{"id": "a", "text": "受け取る"}]}
            )
        )
        for socket in (first, second):
            while True:
                raw = socket.recv(timeout=10)
                if raw not in ("True", "False") and json.loads(raw).get("type") == "translation-result":
                    assert json.loads(raw)["data"]["request_id"] == "joined"
                    break
        assert len(model.prompts) == before + 1


def measure_overlay(socket, model, mode, rounds, count, cpu, memory):
    def send(body):
        socket.send(json.dumps({"type": "translate-request", **body}, ensure_ascii=False))

    def result():
        while True:
            raw = socket.recv(timeout=10)
            if raw == "False":
                raise AssertionError("The overlay endpoint rejected the translation")
            if raw == "True":
                continue
            msg = json.loads(raw)
            if msg.get("type") in ("translation-result", "translation-error"):
                return msg

    def call(body):
        send(body)
        response = result()
        assert response["type"] == "translation-result", response
        return response["data"]

    blocks = [{"id": "left", "text": "こんにちは"}, {"id": "right", "text": "読める。"}]
    cases = {
        "blocks": {"blocks": blocks, "request_id": "blocks"},
        "analysis": {"blocks": blocks, "request_id": "analysis", "mode": "custom", "question": "How is this used?"},
        "flat_cached": {"text": "猫の物語", "request_id": "flat"},
    }
    expected, prompts = {}, {}
    for name, body in cases.items():
        before = len(model.prompts)
        expected[name] = call(body)
        assert len(model.prompts) == before + 1, (name, mode)
        prompts[name] = model.prompts[-1]
    translated = expected["blocks"]["blocks"]
    assert [b["id"] for b in translated] == ["left", "right"]
    assert all(len(b["translation"]) == 64 for b in translated)
    assert expected["analysis"]["mode"] == "custom"
    assert "前々" not in prompts["blocks"] and "現在の行" in prompts["blocks"]
    samples = {key: [] for key in cases}
    for i in range(rounds):
        for name in cases if i % 2 == 0 else reversed(cases):
            calls = len(model.prompts)
            cpu_start, start = cpu(), time.perf_counter()
            for _ in range(count):
                assert call(cases[name]) == expected[name]
            elapsed = time.perf_counter() - start
            samples[name].append(
                {"ms": elapsed * 1000 / count, "cpu_ms": (cpu() - cpu_start) * 1000 / count, "private_mib": memory()}
            )
            assert len(model.prompts) == calls + (0 if name == "flat_cached" else count)
    if mode == "rust":
        send({"blocks": [blocks[0], blocks[0]], "request_id": "dupe"})
        error = result()
        assert error["request_id"] == "dupe" and "unique" in error["error"]
        send({"blocks": blocks, "mode": "custom", "question": " ", "request_id": "bad-question"})
        assert result()["request_id"] == "bad-question"
        started = len(model.prompts)
        send({"blocks": [{"id": "id", "text": "SLOW_FIXTURE"}], "request_id": "first"})
        eventually(lambda: len(model.prompts) > started)
        send({"text": "busy", "request_id": "busy"})
        for key in ("superseded", "latest"):
            send({"blocks": [{"id": "id", "text": key}], "request_id": key})
        received = [result() for _ in range(3)]
        assert sorted(v.get("data", v)["request_id"] for v in received) == ["busy", "first", "latest"], received
        assert len(model.prompts) == started + 2
    return expected, prompts, samples
