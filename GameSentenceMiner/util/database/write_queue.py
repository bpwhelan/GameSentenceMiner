"""Background database write queue.

Decouples the text-intake pipeline (clipboard / websocket / IPC text events)
from synchronous SQLite writes. All write operations submitted via
``db_write_queue.submit(...)`` are executed serially on a single dedicated
daemon thread, so a slow write (e.g. blocked behind a cron-task transaction)
can never stall the asyncio loop that processes incoming text lines.

SQLite is single-writer anyway, so serializing writes loses no real concurrency
while making contention behaviour predictable.
"""

from __future__ import annotations

import queue
import threading
from concurrent.futures import Future
from typing import Any, Callable, Optional, Tuple

from GameSentenceMiner.util.config.configuration import logger

_QUEUE_MAX_SIZE = 10000
_BACKPRESSURE_WARN_INTERVAL = 500  # log every Nth dropped/queued item when full
_SHUTDOWN_SENTINEL: Tuple[Any, ...] = ("__shutdown__",)


class DatabaseWriteQueue:
    def __init__(self, name: str = "gsm-db-writer", maxsize: int = _QUEUE_MAX_SIZE) -> None:
        self._name = name
        self._queue: "queue.Queue[Any]" = queue.Queue(maxsize=maxsize)
        self._thread: Optional[threading.Thread] = None
        self._started = threading.Event()
        self._stopping = threading.Event()
        self._dropped_count = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stopping.clear()
        self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
        self._thread.start()
        self._started.set()
        logger.debug(f"{self._name} started.")

    def stop(self, timeout: float = 5.0) -> None:
        if not self._thread:
            return
        self._stopping.set()
        try:
            self._queue.put_nowait(_SHUTDOWN_SENTINEL)
        except queue.Full:
            # Queue is jammed — drain a slot so the sentinel can land.
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(_SHUTDOWN_SENTINEL)
            except queue.Full:
                pass
        self._thread.join(timeout=timeout)
        if self._thread.is_alive():
            logger.warning(f"{self._name} did not stop within {timeout}s.")
        self._thread = None

    # -- submission --------------------------------------------------------

    def submit(self, func: Callable[..., Any], *args: Any, **kwargs: Any) -> bool:
        """Fire-and-forget enqueue. Returns False if the queue is full."""
        if self._stopping.is_set():
            return False
        try:
            self._queue.put_nowait((func, args, kwargs, None))
            return True
        except queue.Full:
            self._dropped_count += 1
            if self._dropped_count == 1 or self._dropped_count % _BACKPRESSURE_WARN_INTERVAL == 0:
                logger.warning(
                    f"{self._name} queue is full (size={self._queue.maxsize}); dropped "
                    f"{self._dropped_count} write(s) so far. The DB writer thread is not keeping up."
                )
            return False

    def submit_sync(self, func: Callable[..., Any], *args: Any, **kwargs: Any) -> "Future[Any]":
        """Enqueue a write and return a Future for the result."""
        future: "Future[Any]" = Future()
        if self._stopping.is_set():
            future.set_exception(RuntimeError(f"{self._name} is stopping"))
            return future
        try:
            self._queue.put((func, args, kwargs, future))
        except Exception as exc:
            future.set_exception(exc)
        return future

    # -- worker ------------------------------------------------------------

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is _SHUTDOWN_SENTINEL:
                # Drain any remaining queued writes before exit so we don't lose them.
                self._drain_remaining()
                return
            func, args, kwargs, future = item
            try:
                result = func(*args, **kwargs)
                if future is not None:
                    future.set_result(result)
            except Exception as exc:
                if future is not None:
                    future.set_exception(exc)
                else:
                    logger.exception(f"{self._name} write failed: {exc}")

    def _drain_remaining(self) -> None:
        while True:
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                return
            if item is _SHUTDOWN_SENTINEL:
                continue
            func, args, kwargs, future = item
            try:
                result = func(*args, **kwargs)
                if future is not None:
                    future.set_result(result)
            except Exception as exc:
                if future is not None:
                    future.set_exception(exc)
                else:
                    logger.exception(f"{self._name} write failed during drain: {exc}")


db_write_queue = DatabaseWriteQueue()
