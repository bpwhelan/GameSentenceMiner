"""Deliver manual triggers and execute the remaining Python cron job leases."""

import asyncio
import queue
import sqlite3
import threading
import uuid
from concurrent.futures import Future

from websockets.exceptions import ConnectionClosed

from GameSentenceMiner.native import history
from GameSentenceMiner.native.runtime import backend_manages
from GameSentenceMiner.util.communication.bus_client import MAIN, get_bus
from GameSentenceMiner.util.config.configuration import logger

TRANSPORT_ERRORS = (OSError, RuntimeError, ConnectionClosed)


def managed(db):
    return db is not None and backend_manages("GSM_NATIVE_CRON") and history.managed(db)


class DesktopScheduler:
    def __init__(self, owner, db, priorities, execute):
        self.owner = owner
        self.db = db
        self.priorities = priorities
        self.execute = execute
        self.bus = get_bus()
        self.session = str(uuid.uuid4())
        self.stopped = threading.Event()
        self.loop = None
        self.changed = asyncio.Event()
        self.registered = asyncio.Event()
        self.idle = asyncio.Event()
        self.idle.set()
        self.ack = None
        self.revision = 0
        self.future = self.bus.submit(self._serve())

    def wake(self, *, refresh=False):
        def notify():
            if refresh:
                self.revision += 1
            self.changed.set()

        loop = self.loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(notify)

    def shutdown(self):
        self.stopped.set()
        self.wake()

    def request(self, action, timeout=10, **fields):
        return self.bus.request_async(
            MAIN, "mining.cron", {"session": self.session, "action": action, **fields}, timeout
        )

    def _register(self):
        # Register on the database writer so close/restore observes the
        # desktop's ownership before it can replace the profile.
        return self.bus.request(
            MAIN,
            "mining.cron",
            {
                "session": self.session,
                "action": "start",
                "priorities": self.priorities,
                "retry_seconds": self.owner.check_interval,
                "refresh_seconds": self.owner.cache_refresh_interval,
            },
        )

    async def _forward(self):
        sequence = sent_revision = 0
        pending = None
        while True:
            await self.changed.wait()
            self.changed.clear()
            if self.stopped.is_set():
                await self.idle.wait()
                if self.bus.connected:
                    try:
                        await self.request("stop", ack=self.ack)
                    except TRANSPORT_ERRORS as error:
                        logger.debug(f"Cron session stopped during disconnect: {error}")
                return
            if not self.registered.is_set():
                continue
            try:
                if sent_revision != self.revision:
                    revision = self.revision
                    await self.request("refresh")
                    sent_revision = revision
                while not self.stopped.is_set():
                    if pending is None:
                        try:
                            pending = self.owner._queue.get_nowait()
                        except queue.Empty:
                            break
                        sequence += 1
                    await self.request("force", sequence=sequence, name=pending.value)
                    self.owner._queue.task_done()
                    pending = None
            except TRANSPORT_ERRORS as error:
                logger.debug(f"Retrying cron command delivery: {error}")
                await asyncio.sleep(0.25)
                self.changed.set()

    async def _serve(self):
        self.loop = asyncio.get_running_loop()
        sender = asyncio.create_task(self._forward())
        backoff = 0.25
        try:
            while not self.stopped.is_set() and not self.db._closed:
                try:
                    if not self.registered.is_set():
                        if not self.bus.connected:
                            raise ConnectionError("Waiting for desktop")
                        await asyncio.wrap_future(self.db.run_external_write(self._register, wait=False))
                        self.registered.set()
                        self.changed.set()
                        if self.stopped.is_set():
                            break
                    lease = await self.request("next", timeout=None, ack=self.ack)
                    if self.stopped.is_set():
                        break
                    backoff = 0.25
                    if self.ack is not None and self.ack["lease"] == lease["lease"]:
                        continue
                    self.idle.clear()
                    try:
                        self.ack = await self._execute(lease)
                    finally:
                        self.idle.set()
                except (*TRANSPORT_ERRORS, sqlite3.Error) as error:
                    self.registered.clear()
                    if not self.stopped.is_set() and not self.db._closed:
                        logger.debug(f"Reconnecting desktop cron scheduler: {error}")
                        await asyncio.sleep(backoff)
                        backoff = min(5.0, backoff * 2)
        finally:
            self.stopped.set()
            self.changed.set()
            await sender
            self.loop = None

    async def _execute(self, lease):
        from GameSentenceMiner.util.concurrency.resource_qos import ExecutionClass, configure_current_thread

        job = lease["job"]
        result = Future()

        def run():
            if result.set_running_or_notify_cancel():
                try:
                    configure_current_thread(ExecutionClass.BACKGROUND)
                    result.set_result(self.execute(job))
                except BaseException:  # noqa: BLE001 - a legacy worker exit must also settle its lease
                    logger.exception(f"Scheduled task '{job['name']}' exited before completion")
                    result.set_result((False, None))

        try:
            # An uncancellable legacy network call must not hold the process
            # open at shutdown. Native jobs never create this thread.
            threading.Thread(target=run, name=f"gsm-cron-{job['name']}", daemon=True).start()
            work = asyncio.wrap_future(result)
            while not work.done():
                done, _ = await asyncio.wait([work], timeout=60)
                if not done:
                    logger.warning(f"Scheduled task '{job['name']}' is still running")
            finished, next_run = work.result()
        except RuntimeError as error:
            logger.exception(f"Scheduled task '{job['name']}' failed: {error}")
            finished, next_run = False, None
        return {"lease": lease["lease"], "finished": finished, "next_run": next_run}
