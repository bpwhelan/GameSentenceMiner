"""Deliver desktop polling results to mining on the existing backend connection."""

import asyncio
import itertools
import threading
from concurrent.futures import Future
from contextvars import copy_context

from websockets.exceptions import ConnectionClosed

from GameSentenceMiner.native import anki_poll
from GameSentenceMiner.native.runtime import backend_manages

_active = None
_revisions = itertools.count(1)
_transport_errors = (OSError, RuntimeError, ConnectionClosed)


async def _run_mining_work(function, *args):
    # Mining can wait on a GUI or on a third-party API. A default executor
    # worker is joined at interpreter exit even after its coroutine is cancelled.
    result = Future()
    context = copy_context()

    def run():
        if result.set_running_or_notify_cancel():
            try:
                value = context.run(function, *args)
            except BaseException as error:  # noqa: BLE001 - a worker exit must settle the wait without exiting the bus
                if not isinstance(error, Exception):
                    error = RuntimeError(f"Anki card handler exited: {error}")
                result.set_exception(error)
            else:
                result.set_result(value)

    threading.Thread(target=run, name="anki-card-handler", daemon=True).start()
    return await asyncio.wrap_future(result)


def wake(*, replay_changed=False):
    service = _active
    if service is not None:
        service.wake(replay_changed)


def stop():
    if (service := _active) is not None:
        service.stopped.set()
        service.wake(False)


def reachable(url, timeout):
    """Read monitored health, or probe once when polling is suspended."""
    if not backend_manages("GSM_NATIVE_ANKI_MONITOR"):
        return None
    from GameSentenceMiner.util.communication.bus_client import MAIN, get_bus

    bus = get_bus()
    service = _active
    if service is not None and service.watch_url == url and bus.connected:
        health = service.health
        if health is not None and health[0] == url:
            return health[1]
    try:
        return bus.request(
            MAIN, "anki.monitor", {"action": "probe", "url": url, "timeout": timeout}, timeout=timeout + 2
        )
    except _transport_errors:
        return False


def start(miner):
    global _active
    if not backend_manages("GSM_NATIVE_ANKI_MONITOR"):
        return False
    previous = _active
    if (
        previous is not None
        and not previous.stopped.is_set()
        and (previous.future is None or not previous.future.done())
    ):
        return True
    from GameSentenceMiner.util.communication.bus_client import get_bus

    service = DesktopMonitor(miner, get_bus())
    _active = service
    service.future = service.bus.submit(service.serve(previous.future if previous is not None else None))
    return True


class DesktopMonitor:
    def __init__(self, miner, bus):
        self.miner = miner
        self.bus = bus
        self.loop = None
        self.stopped = threading.Event()
        self.changed = asyncio.Event()
        self.revision = 0
        self.replay_revision = 0
        self.waiting = False
        self.watch_url = None
        self.health = None
        self.future = None

    def wake(self, replay_changed):
        def notify():
            self.revision = next(_revisions)
            if replay_changed:
                self.replay_revision += 1
            self.changed.set()

        loop = self.loop
        if loop is not None:
            try:
                loop.call_soon_threadsafe(notify)
            except RuntimeError:
                if not loop.is_closed():
                    raise

    def request(self, action, timeout=None, **fields):
        return self.bus.request_async(
            "main", "anki.monitor", {"action": action, "revision": self.revision, **fields}, timeout
        )

    async def forward_changes(self):
        while True:
            await self.changed.wait()
            self.changed.clear()
            if self.waiting and self.bus.connected:
                try:
                    await self.request("wake", timeout=2)
                except _transport_errors:
                    # A lost wake reply can be retried. Revisions are monotonic.
                    await asyncio.sleep(0.25)
                    self.changed.set()

    async def serve(self, previous=None):
        from GameSentenceMiner.util.config.configuration import logger

        # Finish in-flight card work before starting another monitor in a
        # reloaded backend. Late wakes from the old instance then sort first.
        if previous is not None:
            await asyncio.gather(asyncio.wrap_future(previous), return_exceptions=True)
        if self.stopped.is_set():
            return
        self.miner._anki_monitor_stop.clear()
        self.revision = next(_revisions)
        self.loop = asyncio.get_running_loop()
        sender = asyncio.create_task(self.forward_changes())
        try:
            while not self.stopped.is_set():
                try:
                    await self.step()
                except _transport_errors as error:
                    self.health = None
                    logger.debug(f"Anki monitor waiting for desktop: {error}")
                    await asyncio.sleep(0.5)
        finally:
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
            self.loop = None

    async def step(self):
        miner = self.miner
        config = miner.get_config()
        remaining = miner.get_anki_beacon_wait_timeout_seconds()
        miner.gsm_status.anki_beacon_connected = remaining > 0
        if remaining > 0:
            miner.gsm_status.anki_connected = True
        if config.anki.enabled and not miner.anki_beacon_note_queue.empty():
            await _run_mining_work(miner._process_next_anki_beacon_note)
            return
        if config.anki.enabled and remaining > 0 and miner.first_run:
            revision = self.revision
            await _run_mining_work(miner._ensure_anki_beacon_baseline)
            if self.stopped.is_set() or revision != self.revision:
                return
            remaining = miner.get_anki_beacon_wait_timeout_seconds()

        if not config.anki.enabled or remaining > 0:
            activity = "hold"
        else:
            activity = "poll" if miner._is_anki_polling_allowed() else "probe"
        revision = self.revision
        pending, edits = anki_poll.pending_changes()
        url = config.anki.url or ""
        self.waiting = True
        self.watch_url = url if activity in ("poll", "probe") else None
        try:
            reply = await self.request(
                "next",
                activity=activity,
                session=anki_poll.session(),
                url=url,
                connected=bool(miner.gsm_status.anki_connected)
                if self.health is not None and self.health[0] == url
                else None,
                rate=miner._get_anki_base_polling_rate_seconds(),
                resume_after=remaining if remaining > 0 else None,
                replay_revision=self.replay_revision,
                **edits,
            )
        finally:
            self.waiting = False
            self.watch_url = None
        if reply is None or self.stopped.is_set() or revision != self.revision:
            return
        ids = anki_poll.confirm_changes(pending, reply["notes"])
        if reply.get("acknowledged"):
            return
        self.health = (url, reply["connected"])
        miner.gsm_status.anki_connected = reply["connected"]
        if activity != "poll":
            return
        if reply["connected"]:
            miner.errors_shown = 0
            miner.final_warning_shown = False
            miner.anki_polling_gate_state.baseline_seed_failure_logs_shown = 0
            miner.first_run = False
            if ids:
                await _run_mining_work(miner._handle_polled_notes, ids)
        elif reply.get("warning"):
            if reply["seeding"]:
                miner.anki_polling_gate_state.baseline_seed_failure_logs_shown = reply["notice"] - 1
                miner._log_anki_polling_baseline_seed_failure(reply["warning"])
            else:
                miner._log_anki_poll_failure()
