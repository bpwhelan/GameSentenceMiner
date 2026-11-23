import asyncio
import base64
import json

import pytest

from GameSentenceMiner.native import intake
from GameSentenceMiner.util.communication import bus_client


def test_large_reply_reassembles_unicode_across_byte_boundaries(monkeypatch):
    value = {"records": [{"text": "字幕😀"}]}
    raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
    offsets = []

    class Bus:
        def request(self, dst, topic, data, timeout):
            assert dst == "main" and topic == "text.intake"
            if data["action"] == "snapshot":
                return {"transfer": "immutable", "size": len(raw)}
            assert data["action"] == "chunk" and data["transfer"] == "immutable"
            offset = data["offset"]
            offsets.append(offset)
            return base64.b64encode(raw[offset : offset + 2]).decode()

    monkeypatch.setattr(bus_client, "get_bus", Bus)
    assert intake.request("snapshot") == value
    assert offsets == list(range(0, len(raw), 2))


@pytest.mark.parametrize("outputs", [False, True])
def test_disconnected_projection_resumes_from_last_completed_event(monkeypatch, outputs):
    from GameSentenceMiner import gametext as gt

    state = intake.DesktopTextRuntime(None, lambda: None)
    polls = []
    sessions = []
    applied = []
    disconnect = True

    def request(action, **params):
        nonlocal disconnect
        if action == "start":
            sessions.append(params["session"])
            assert params["desktop_outputs"] is True
            return {"desktop_outputs": True} if outputs else True
        assert action == "next"
        polls.append(params["after"])
        if params["after"] == 2 and disconnect:
            disconnect = False
            raise ConnectionError("reconnect")
        return {
            "events": [1, 2] if not params["after"] else [3],
            "accepted_lines": 1,
            "sources": {"clipboard": False, "websockets": {}},
        }

    def project(event):
        applied.append(event)
        if event == 3:
            state._stopping.set()

    monkeypatch.setattr(gt.logger, "warning", lambda *_: None)
    monkeypatch.setattr(intake, "_configuration", dict)
    monkeypatch.setattr(intake, "request", request)
    monkeypatch.setattr(state, "_project", project)
    state._run()
    assert applied == [1, 2, 3]
    status = state.health_snapshot()
    assert status["receipt_log_owner"] == ("desktop" if outputs else "python")
    assert status["accepted_lines"] == 1 and status["projected"] == 3
    assert polls == [0, 2, 2]
    assert len(sessions) == 2 and sessions[0] == sessions[1]


def test_async_speech_hypotheses_reach_the_desktop_in_producer_order():
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor

    received = []
    worker = intake.DesktopTextRuntime(None, lambda: None)
    started = threading.Event()

    def partial():
        started.set()
        time.sleep(0.04)
        received.append("partial")

    async def send():
        # Ensure at least two threads are available so a scheduler race would be visible.
        asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=2))
        first = asyncio.create_task(worker.from_async_producer(partial))
        while not started.is_set():
            await asyncio.sleep(0.001)
        await worker.from_async_producer(lambda: received.append("final"))
        await first

    asyncio.run(send())
    assert received == ["partial", "final"]


def test_on_demand_compatibility_lines_resolve_live_neighbors_and_mined_time(monkeypatch):
    def row(line_id, previous, following):
        return {
            "id": line_id,
            "text": line_id,
            "time_epoch": 1700000000,
            "first_seen_time_epoch": 1699999999,
            "finalized_at": "2026-11-20T12:00:00Z",
            "mined_time_epoch": 1700000001 if previous else None,
            "scene": "Game",
            "index": 0,
            "source": "manual",
            "source_padding": 0,
            "revision": 2,
            "state": "frozen",
            "session_id": "session",
            "stream_sequence": 2,
            "source_instance": "producer",
            "prev_id": previous,
            "next_id": following,
            "translation": "test",
            "excluded_from_stats": False,
        }

    monkeypatch.setattr(
        intake, "request", lambda *args, **kwargs: {"ids": ["b"], "lines": [row("a", None, "b"), row("b", "a", None)]}
    )
    (selected,) = intake.reader_lines("selected")
    assert selected.prev.id == "a"
    assert selected.prev.next is selected
    assert selected.mined_time.timestamp() == 1700000001
    assert selected.first_seen_time.timestamp() == 1699999999
    assert selected.finalized_time.tzinfo is None
