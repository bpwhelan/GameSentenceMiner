from __future__ import annotations

import asyncio
import os
import threading
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Any, Coroutine

from .resource_qos import ExecutionClass, configure_current_thread


def submit_coroutine_to_loop(
    loop: asyncio.AbstractEventLoop,
    coro: Coroutine[Any, Any, Any],
) -> Future[Any]:
    """Cross-thread transport submission kept inside the asyncio boundary."""
    return asyncio.run_coroutine_threadsafe(coro, loop)


@dataclass(frozen=True)
class TransportHealth:
    state: str
    thread_alive: bool
    pending_tasks: int
    failure: str | None = None


class AsyncTransportRuntime:
    """Managed event-loop thread for adapters whose libraries require asyncio."""

    def __init__(self, name: str = "gsm-async-transport", *, capacity: int = 256) -> None:
        self._name = name
        self._capacity = capacity
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._futures: set[Future[Any]] = set()
        self._lock = threading.RLock()
        self._state = "created"
        self._failure: str | None = None

    @property
    def loop(self) -> asyncio.AbstractEventLoop | None:
        return self._loop

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            if self._state == "stopped":
                raise RuntimeError(f"Transport runtime '{self._name}' cannot be restarted")
            self._state = "starting"
            self._thread = threading.Thread(target=self._run, name=self._name, daemon=False)
            self._thread.start()
        if not self._ready.wait(timeout=5):
            raise RuntimeError(f"Transport runtime '{self._name}' failed to start")

    def _run(self) -> None:
        configure_current_thread(ExecutionClass.LATENCY)
        # aiohttp and websockets share this loop. The selector implementation
        # avoids noisy Proactor connection-reset callbacks on Windows.
        loop = asyncio.SelectorEventLoop() if os.name == "nt" else asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._state = "running"
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()
            self._state = "stopped"

    def submit(self, coro: Coroutine[Any, Any, Any]) -> Future[Any]:
        loop = self._loop
        if loop is None or self._state != "running":
            coro.close()
            raise RuntimeError(f"Transport runtime '{self._name}' is not running")
        with self._lock:
            if len(self._futures) >= self._capacity:
                coro.close()
                raise RuntimeError(f"Transport runtime '{self._name}' is backpressured")
            future = submit_coroutine_to_loop(loop, coro)
            self._futures.add(future)
            future.add_done_callback(self._task_done)
            return future

    def _task_done(self, future: Future[Any]) -> None:
        with self._lock:
            self._futures.discard(future)
            if future.cancelled():
                return
            try:
                error = future.exception()
            except Exception as exc:  # pragma: no cover - defensive Future implementation
                error = exc
            if error is not None and self._state not in {"stopping", "stopped"}:
                self._failure = repr(error)
                self._state = "failed"

    def stop(self, timeout: float = 5.0) -> None:
        loop = self._loop
        thread = self._thread
        if loop is None or self._state == "stopped":
            return
        self._state = "stopping"
        loop.call_soon_threadsafe(loop.stop)
        if thread and thread is not threading.current_thread():
            thread.join(timeout=timeout)
        if thread and thread.is_alive():
            raise RuntimeError(f"Transport runtime '{self._name}' did not stop within {timeout} seconds")

    def health_snapshot(self) -> TransportHealth:
        with self._lock:
            return TransportHealth(
                state=self._state,
                thread_alive=bool(self._thread and self._thread.is_alive()),
                pending_tasks=len(self._futures),
                failure=self._failure,
            )
