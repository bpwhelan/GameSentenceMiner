from __future__ import annotations

import threading
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass
from typing import Any, Callable

from .actor import ActorStopped, MailboxFull
from .resource_qos import ExecutionClass, configure_current_thread


@dataclass(frozen=True)
class WorkPoolMetrics:
    accepted: int = 0
    completed: int = 0
    failed: int = 0
    rejected: int = 0
    outstanding: int = 0


class BoundedWorkPool:
    """Bounded blocking/CPU job pool with explicit overload signaling."""

    def __init__(self, name: str, *, max_workers: int, capacity: int) -> None:
        if max_workers <= 0 or capacity < max_workers:
            raise ValueError("Work pool capacity must be at least max_workers")
        self.name = name
        self.capacity = capacity
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix=name,
            initializer=configure_current_thread,
            initargs=(ExecutionClass.BACKGROUND,),
        )
        self._slots = threading.BoundedSemaphore(capacity)
        self._lock = threading.RLock()
        self._accepting = True
        self._accepted = 0
        self._completed = 0
        self._failed = 0
        self._rejected = 0
        self._outstanding = 0

    def submit(
        self,
        fn: Callable[..., Any],
        *args: Any,
        timeout: float = 0.25,
        **kwargs: Any,
    ) -> Future[Any]:
        with self._lock:
            if not self._accepting:
                raise ActorStopped(f"Work pool '{self.name}' is stopped")
        if not self._slots.acquire(timeout=max(0.0, timeout)):
            with self._lock:
                self._rejected += 1
            raise MailboxFull(f"Work pool '{self.name}' is backpressured")
        with self._lock:
            self._accepted += 1
            self._outstanding += 1
        try:
            future = self._executor.submit(fn, *args, **kwargs)
        except BaseException:
            self._slots.release()
            with self._lock:
                self._outstanding -= 1
                self._failed += 1
            raise
        future.add_done_callback(self._done)
        return future

    def _done(self, future: Future[Any]) -> None:
        self._slots.release()
        with self._lock:
            self._outstanding -= 1
            if future.cancelled() or future.exception() is not None:
                self._failed += 1
            else:
                self._completed += 1

    def shutdown(self, *, wait: bool = True, cancel_futures: bool = False) -> None:
        with self._lock:
            self._accepting = False
        self._executor.shutdown(wait=wait, cancel_futures=cancel_futures)

    def health_snapshot(self) -> dict[str, object]:
        return {"name": self.name, "capacity": self.capacity, **asdict(self.metrics_snapshot())}

    def metrics_snapshot(self) -> WorkPoolMetrics:
        with self._lock:
            return WorkPoolMetrics(
                accepted=self._accepted,
                completed=self._completed,
                failed=self._failed,
                rejected=self._rejected,
                outstanding=self._outstanding,
            )


class BoundedDeque:
    """Small thread-safe, list-compatible bounded queue for legacy consumers."""

    def __init__(self, capacity: int, *, name: str) -> None:
        self.capacity = capacity
        self.name = name
        self._items: deque[Any] = deque()
        self._condition = threading.Condition(threading.RLock())

    def append(self, item: Any, *, timeout: float = 0.25) -> None:
        deadline = time.monotonic() + max(0.0, timeout)
        with self._condition:
            while len(self._items) >= self.capacity:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise MailboxFull(f"Queue '{self.name}' is backpressured")
                self._condition.wait(remaining)
            self._items.append(item)
            self._condition.notify_all()

    def pop(self, index: int = -1) -> Any:
        with self._condition:
            if index == 0:
                item = self._items.popleft()
            elif index == -1 or index == len(self._items) - 1:
                item = self._items.pop()
            else:
                items = list(self._items)
                item = items.pop(index)
                self._items = deque(items)
            self._condition.notify_all()
            return item

    def remove(self, item: Any) -> None:
        with self._condition:
            self._items.remove(item)
            self._condition.notify_all()

    def clear(self) -> None:
        with self._condition:
            self._items.clear()
            self._condition.notify_all()

    def __len__(self) -> int:
        with self._condition:
            return len(self._items)

    def __getitem__(self, index: int) -> Any:
        with self._condition:
            return self._items[index]


_general_pool: BoundedWorkPool | None = None
_general_pool_lock = threading.Lock()


def get_background_work_pool() -> BoundedWorkPool:
    global _general_pool
    with _general_pool_lock:
        if _general_pool is None:
            _general_pool = BoundedWorkPool("gsm-background", max_workers=4, capacity=128)
        return _general_pool


def submit_background_work(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Future[Any]:
    return get_background_work_pool().submit(fn, *args, **kwargs)


def shutdown_background_work(*, wait: bool = True) -> None:
    global _general_pool
    with _general_pool_lock:
        pool = _general_pool
        _general_pool = None
    if pool is not None:
        pool.shutdown(wait=wait, cancel_futures=not wait)
