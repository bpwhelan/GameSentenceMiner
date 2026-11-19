"""Exercise desktop Anki monitoring through its production service and a loopback collection."""

import asyncio
import json
import os
import statistics
import threading
import time
import uuid
from contextlib import ExitStack
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import psutil
import requests

FIRST = 1_700_000_000_000
SIZE = 8192
FIELDS = {"Word": "空", "Sentence": "空を見た。", "Picture": "", "SentenceAudio": ""}


def note_info(note):
    return {
        "noteId": note,
        "modelName": "Monitor fixture",
        "tags": ["mined"],
        "cards": [note + 10_000],
        "fields": {name: {"order": i, "value": value} for i, (name, value) in enumerate(FIELDS.items())},
    }


async def handoff_cost(dispatch):
    """Measure delivery scheduling separately from Anki HTTP and card preparation."""
    assert await dispatch(threading.get_ident) != threading.get_ident()
    samples = 100
    start = time.perf_counter()
    for _ in range(samples):
        worker = await dispatch(threading.current_thread)
    cost_ms = (time.perf_counter() - start) * 1000 / samples
    await asyncio.sleep(0.05)
    return cost_ms, int(worker.is_alive())


class Collection:
    def __init__(self):
        self.ids = list(range(FIRST, FIRST + SIZE))
        self.finds = self.probes = self.lookups = 0
        self.online = True
        self.lock = threading.Lock()
        self.response = self.notes()

    def notes(self):
        return json.dumps({"error": None, "result": self.ids}, separators=(",", ":")).encode()

    def reply(self, payload):
        with self.lock:
            if payload is None:
                return json.dumps([self.finds, self.probes, self.lookups]).encode()
            if payload == {"add": True}:
                note = self.ids[-1] + 1
                self.ids.append(note)
                self.response = self.notes()
                return json.dumps(note).encode()
            if set(payload) == {"online"}:
                self.online = payload["online"]
                return b"null"
            if payload == {"version": 6, "action": "findNotes", "params": {"query": "added:1"}}:
                self.finds += 1
                return self.response if self.online else b'{"error":"unavailable","result":null}'
            if payload.get("action") == "notesInfo":
                ids = payload["params"]["notes"]
                assert payload["version"] == 6 and all(note in self.ids for note in ids)
                self.lookups += 1
                return json.dumps({"error": None, "result": [note_info(note) for note in ids]}).encode()
            assert payload == {"version": 6, "action": "version", "params": {}}, payload
            self.probes += 1
            return b'{"error":null,"result":6}' if self.online else b'{"error":"unavailable","result":null}'


def measure(bus, desktop_pid, mode, port, *, rate_ms=100):
    from GameSentenceMiner import anki
    from GameSentenceMiner.native import anki_monitor
    from GameSentenceMiner.obs.outputs import set_replay_buffer_active
    from GameSentenceMiner.util.models import model

    url = f"http://127.0.0.1:{port}/monitor/{uuid.uuid4().hex}"
    config = SimpleNamespace(
        anki=SimpleNamespace(
            url=url,
            enabled=True,
            polling_rate_v2=rate_ms,
            word_field="Word",
            sentence_field="Sentence",
            sentence_audio_field="SentenceAudio",
            picture_field="Picture",
            sentence_furigana_field="",
        ),
        obs=SimpleNamespace(disable_recording=False),
    )
    state = SimpleNamespace(replay_buffer_active=False)
    incoming = []
    ready = threading.Condition()
    python_steps = transport = 0
    metrics = {}

    def accept(card, **_):
        assert card.modelName == "Monitor fixture" and card.tags == ["mined"] and card.cards == [card.noteId + 10_000]
        assert {name: card.get_field(name) for name in card.fields} == FIELDS
        with ready:
            incoming.append((card.noteId, time.perf_counter()))
            ready.notify_all()

    def wait_note(note):
        with ready:
            assert ready.wait_for(lambda: any(i == note for i, _ in incoming), timeout=4), (note, incoming)
            return next(t for i, t in incoming if i == note)

    def counts():
        return requests.get(url, timeout=2).json()

    def wait_calls(index, minimum):
        until = time.monotonic() + 5
        while counts()[index] < minimum:
            assert time.monotonic() < until, (counts(), minimum)
            time.sleep(0.025)

    legacy_step = anki._monitor_anki_iteration
    native_step = anki_monitor.DesktopMonitor.step
    request = bus.request_async

    def old_iteration(*args, **kwargs):
        nonlocal python_steps
        python_steps += 1
        return legacy_step(*args, **kwargs)

    async def new_iteration(service):
        nonlocal python_steps
        python_steps += 1
        return await native_step(service)

    async def observe(destination, topic, *args, **kwargs):
        nonlocal transport
        if topic in ("anki.monitor", "anki.poll"):
            transport += 1
        return await request(destination, topic, *args, **kwargs)

    processes = [psutil.Process(), psutil.Process(desktop_pid)]

    def cpu():
        return sum(sum(p.cpu_times()[:2]) for p in processes)

    def idle(label, index):
        before = counts()
        start_steps, start_transport = python_steps, transport
        started_cpu, started = cpu(), time.perf_counter()
        time.sleep(6)
        seconds = time.perf_counter() - started
        elapsed_cpu = cpu() - started_cpu
        after = counts()
        queries = after[index] - before[index]
        assert queries >= 3_000 / rate_ms and after[1 - index] == before[1 - index], (label, before, after)
        metrics.update(
            {
                label + "_queries_per_second": queries / seconds,
                label + "_cpu_ms_per_second": elapsed_cpu * 1000 / seconds,
                label + "_python_iterations": python_steps - start_steps,
                label + "_broker_requests": transport - start_transport,
                label + "_uss_mib": sum(p.memory_full_info().uss for p in processes) / 2**20,
            }
        )
        if mode == "rust":
            assert python_steps == start_steps and transport == start_transport

    os.environ["GSM_NATIVE_ANKI_POLL"] = "1"  # Both versions use the existing native ID tracker.
    os.environ["GSM_NATIVE_ANKI_MONITOR"] = "1" if mode == "rust" else "0"
    with ExitStack() as mock:
        for target, field, value in (
            (anki, "get_config", lambda: config),
            (model, "get_config", lambda: config),
            (anki, "obs", SimpleNamespace(obs_service=SimpleNamespace(state=state))),
            (anki, "update_single_card", accept),
            (anki, "_monitor_anki_iteration", old_iteration),
            (anki_monitor.DesktopMonitor, "step", new_iteration),
            (bus, "request_async", observe),
        ):
            mock.enter_context(patch.object(target, field, value))
        using_desktop = anki_monitor.start(anki)
        assert using_desktop == (mode == "rust")
        thread = None
        if not using_desktop:
            thread = threading.Thread(target=anki.start_monitoring_anki, name="anki-monitor", daemon=True)
            thread.start()
        try:
            wait_calls(1, 3)
            idle("inactive", 1)
            metrics["dedicated_python_threads"] = sum(t.name == "anki-monitor" for t in threading.enumerate())
            # Ignore notes created while the replay buffer was off.
            hidden = requests.post(url, json={"add": True}, timeout=2).json()
            set_replay_buffer_active(state, True)
            wait_calls(0, 3)
            assert not incoming
            idle("active", 0)
            # The status page reads this same reachability check. Count actual
            # version requests so a fast stale/default result cannot pass.
            probes = counts()[1]
            start = time.perf_counter()
            for _ in range(24):
                assert anki.refresh_anki_connect_connection_status()
            metrics["status_read_ms"] = (time.perf_counter() - start) * 1000 / 24
            metrics["status_http_queries"] = counts()[1] - probes
            assert metrics["status_http_queries"] == (0 if using_desktop else 24)
            latencies = []
            for fraction in (0.15, 0.55, 0.85, 0.25, 0.65):
                time.sleep(fraction * rate_ms / 1000)
                start = time.perf_counter()
                note = requests.post(url, json={"add": True}, timeout=2).json()
                latencies.append((wait_note(note) - start) * 1000)
            metrics["note_delivery_ms"] = statistics.mean(latencies)
            # A short remaining heartbeat exercises push precedence and timed
            # fallback without changing the production grace period.
            # Heartbeat receipts use the same local naive clock as the production receiver.
            received_at = datetime.now() - timedelta(seconds=28.5)  # noqa: DTZ005
            anki.record_anki_beacon_heartbeat({"session_id": "fixture"}, received_at=received_at)
            time.sleep(0.2)
            # During Beacon mode the poller has suspended HTTP. An explicit
            # status check still probes AnkiConnect once on the configured URL.
            probes = counts()[1]
            assert anki.refresh_anki_connect_connection_status()
            assert counts()[1] == probes + 1
            frozen = counts()
            pushed = requests.post(url, json={"add": True}, timeout=2).json()
            anki.handle_incoming_anki_event({"event": "note_added", "session_id": "fixture", "note_id": pushed})
            wait_note(pushed)
            assert counts()[2] == frozen[2] + 1
            full_note = requests.post(url, json={"add": True}, timeout=2).json()
            event = {
                "event": "note_added",
                "session_id": "fixture",
                "note_id": full_note,
                "fields": FIELDS,
                "note_type_name": "Monitor fixture",
                "tags": ["mined"],
                "card_ids": [full_note + 10_000],
            }
            anki.handle_incoming_anki_event(event)
            wait_note(full_note)
            assert anki.handle_incoming_anki_event(event) == "duplicate_note_added"
            time.sleep(0.2)
            assert counts() == [frozen[0], frozen[1], frozen[2] + 1]
            wait_calls(0, frozen[0] + 2)
            expected = list(range(hidden + 1, full_note + 1))
            assert [i for i, _ in incoming] == expected, incoming
            assert anki.gsm_status.anki_connected and not anki.gsm_status.anki_beacon_connected
            for online in (False, True):
                requests.post(url, json={"online": online}, timeout=2).raise_for_status()
                deadline = time.monotonic() + 4
                while anki.gsm_status.anki_connected != online:
                    assert time.monotonic() < deadline, online
                    time.sleep(0.02)
            # Drop only this disposable backend's socket. A note published
            # before reauthentication must still be delivered exactly once.
            bus.submit(bus._ws.close()).result(timeout=3)
            after_reconnect = requests.post(url, json={"add": True}, timeout=2).json()
            wait_note(after_reconnect)
            expected.append(after_reconnect)
            wait_calls(0, counts()[0] + 2)
            assert [i for i, _ in incoming] == expected
            probes = counts()[1]
            set_replay_buffer_active(state, False)
            wait_calls(1, probes + 2)
            requests.post(url, json={"add": True}, timeout=2).raise_for_status()
            finds = counts()[0]
            set_replay_buffer_active(state, True)
            wait_calls(0, finds + 3)
            assert [i for i, _ in incoming] == expected
            metrics["post_delivery_uss_mib"] = sum(p.memory_full_info().uss for p in processes) / 2**20
            metrics["post_delivery_python_threads"] = processes[0].num_threads()
            config.anki.enabled = False
            anki_monitor.wake()
            time.sleep(0.25)
            frozen = counts()
            time.sleep(0.25)
            assert frozen == counts()
            if using_desktop:
                for label, dispatch in (("pooled", asyncio.to_thread), ("per_batch", anki_monitor._run_mining_work)):
                    cost, retained = asyncio.run(handoff_cost(dispatch))
                    metrics[label + "_handoff_ms"] = cost
                    metrics[label + "_retained_worker"] = retained
            return {"result": {"delivered": expected, "suppressed_on_activation": hidden}, **metrics}
        finally:
            anki.stop_monitoring_anki()
            if thread is not None:
                thread.join(5)
                assert not thread.is_alive()
            else:
                anki_monitor._active.future.result(timeout=5)
