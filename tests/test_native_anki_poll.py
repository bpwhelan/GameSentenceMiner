import asyncio
import threading
from contextvars import ContextVar
from queue import Queue
from types import SimpleNamespace

import pytest

from GameSentenceMiner.native import anki_monitor, anki_poll
from GameSentenceMiner.util.communication import bus_client


def test_blocked_card_handler_cannot_keep_the_backend_process_alive():
    async def cancel_during_delivery():
        loop = asyncio.get_running_loop()
        entered = loop.create_future()
        release = threading.Event()
        queue = Queue()
        queue.put(1)

        def handle_note():
            loop.call_soon_threadsafe(entered.set_result, threading.current_thread())
            release.wait(timeout=3)

        miner = SimpleNamespace(
            get_config=lambda: SimpleNamespace(anki=SimpleNamespace(enabled=True)),
            get_anki_beacon_wait_timeout_seconds=lambda: 0,
            gsm_status=SimpleNamespace(),
            anki_beacon_note_queue=queue,
            _process_next_anki_beacon_note=handle_note,
        )
        delivery = asyncio.create_task(anki_monitor.DesktopMonitor(miner, None).step())
        try:
            worker = await asyncio.wait_for(entered, timeout=2)
            delivery.cancel()
            with pytest.raises(asyncio.CancelledError):
                await delivery
            assert worker.is_alive() and worker.daemon
            return worker
        finally:
            release.set()

    worker = asyncio.run(cancel_during_delivery())
    worker.join(timeout=1)
    assert not worker.is_alive()


def test_card_worker_receives_profile_context_and_its_exit_is_isolated():
    profile = ContextVar("profile")
    profile.set("mining")

    def exit_handler():
        raise SystemExit(profile.get())

    with pytest.raises(RuntimeError, match="Anki card handler exited: mining"):
        asyncio.run(anki_monitor._run_mining_work(exit_handler))


def test_status_uses_current_polling_endpoint_and_checks_explicitly_during_beacon(monkeypatch):
    calls = []
    bus = SimpleNamespace(connected=True, request=lambda *args, **kwargs: calls.append(args[2]) or True)
    service = SimpleNamespace(watch_url="http://anki", health=("http://anki", False))
    monkeypatch.setattr(anki_monitor, "_active", service)
    monkeypatch.setattr(anki_monitor, "backend_manages", lambda _: True)
    monkeypatch.setattr(bus_client, "get_bus", lambda: bus)
    assert anki_monitor.reachable("http://anki", 1) is False
    assert not calls
    assert anki_monitor.reachable("http://other", 1)
    service.watch_url = None
    assert anki_monitor.reachable("http://anki", 2)
    assert calls == [
        {"action": "probe", "url": "http://other", "timeout": 1},
        {"action": "probe", "url": "http://anki", "timeout": 2},
    ]


def test_binding_an_already_recording_obs_service_wakes_the_monitor(monkeypatch):
    from GameSentenceMiner import obs
    from GameSentenceMiner.obs import service

    active = SimpleNamespace(
        connection_pool=object(), event_client=object(), state=SimpleNamespace(replay_buffer_active=True)
    )
    monkeypatch.setattr(obs, "obs_service", active)
    monkeypatch.setattr(obs, "connection_pool", None)
    monkeypatch.setattr(obs, "event_client", None)
    published = []
    monkeypatch.setattr(
        anki_monitor,
        "wake",
        lambda: published.append((obs.connection_pool, obs.obs_service.state.replay_buffer_active)),
    )
    service._bind_obs_service_clients()
    assert published == [(active.connection_pool, True)]


def test_pending_edits_survive_disconnect_and_in_flight_beacon_notes(monkeypatch):
    monkeypatch.setattr(anki_poll, "_changes", {})
    anki_poll.acknowledge([8])
    anki_poll.acknowledge([5], known=False)

    def disconnected(*_args, **_kwargs):
        raise ConnectionError("closed")

    monkeypatch.setattr(bus_client, "get_bus", lambda: SimpleNamespace(request=disconnected))
    with pytest.raises(ConnectionError):
        anki_poll.query("difference", "http://localhost")

    def receive(_dst, topic, data, timeout):
        assert topic == "anki.poll" and timeout > 0
        assert data["remember"] == [8] and data["forget"] == [5]
        anki_poll.acknowledge([5])
        return [5, 7]

    monkeypatch.setattr(bus_client, "get_bus", lambda: SimpleNamespace(request=receive))
    assert anki_poll.query("difference", "http://localhost") == {7}
    assert anki_poll._changes == {5: True}
