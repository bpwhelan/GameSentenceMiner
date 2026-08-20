from __future__ import annotations

import heapq
import itertools
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Callable

from .actor import ActorStopped, MailboxFull
from .resource_qos import ExecutionClass, configure_current_thread


@dataclass(order=True)
class _ScheduledCall:
    deadline_ns: int
    ordinal: int
    key: str = field(compare=False)
    generation: int = field(compare=False)
    callback: Callable[[], None] = field(compare=False)


@dataclass(frozen=True)
class SchedulerMetrics:
    scheduled: int = 0
    executed: int = 0
    cancelled: int = 0
    coalesced: int = 0
    failed: int = 0
    pending: int = 0


class SchedulerActor:
    """One condition-variable/min-heap owner for keyed runtime deadlines."""

    def __init__(
        self,
        name: str = "gsm-deadline-scheduler",
        *,
        capacity: int = 4096,
        monotonic_ns: Callable[[], int] = time.monotonic_ns,
    ) -> None:
        self.name = name
        self.capacity = capacity
        self._monotonic_ns = monotonic_ns
        self._condition = threading.Condition(threading.RLock())
        self._heap: list[_ScheduledCall] = []
        self._active: dict[str, int] = {}
        self._generations: dict[str, int] = {}
        self._ordinal = itertools.count()
        self._thread: threading.Thread | None = None
        self._accepting = True
        self._stopped = False
        self._failure: str | None = None
        self._scheduled = 0
        self._executed = 0
        self._cancelled = 0
        self._coalesced = 0
        self._failed = 0

    def start(self) -> None:
        with self._condition:
            if self._thread and self._thread.is_alive():
                return
            if self._stopped:
                raise ActorStopped(f"Scheduler '{self.name}' cannot be restarted")
            self._thread = threading.Thread(target=self._run, name=self.name, daemon=False)
            self._thread.start()

    def schedule_after(self, key: str, delay_seconds: float, callback: Callable[[], None]) -> None:
        deadline = self._monotonic_ns() + max(0, int(delay_seconds * 1_000_000_000))
        self.schedule_at(key, deadline, callback)

    def schedule_at(self, key: str, deadline_ns: int, callback: Callable[[], None]) -> None:
        with self._condition:
            if not self._accepting or self._stopped:
                raise ActorStopped(f"Scheduler '{self.name}' is stopped")
            replacing = key in self._active
            if not replacing and len(self._active) >= self.capacity:
                raise MailboxFull(f"Scheduler '{self.name}' is backpressured")
            generation = self._generations.get(key, 0) + 1
            self._generations[key] = generation
            self._active[key] = generation
            heapq.heappush(
                self._heap,
                _ScheduledCall(int(deadline_ns), next(self._ordinal), key, generation, callback),
            )
            self._scheduled += 1
            if replacing:
                self._coalesced += 1
            if len(self._heap) > self.capacity * 2:
                self._compact_locked()
            self._condition.notify()

    def cancel(self, key: str) -> bool:
        with self._condition:
            if key not in self._active:
                return False
            del self._active[key]
            self._cancelled += 1
            self._condition.notify()
            return True

    def run_due(self, *, now_ns: int | None = None) -> int:
        """Execute ready callbacks; public to support deterministic fake-clock tests."""
        callbacks: list[Callable[[], None]] = []
        with self._condition:
            now = self._monotonic_ns() if now_ns is None else int(now_ns)
            self._discard_stale_locked()
            while self._heap and self._heap[0].deadline_ns <= now:
                call = heapq.heappop(self._heap)
                if self._active.get(call.key) != call.generation:
                    continue
                del self._active[call.key]
                callbacks.append(call.callback)
                self._discard_stale_locked()
        for callback in callbacks:
            try:
                callback()
            except BaseException as error:
                with self._condition:
                    self._failed += 1
                    self._failure = repr(error)
                    self._accepting = False
            else:
                with self._condition:
                    self._executed += 1
        return len(callbacks)

    def _run(self) -> None:
        configure_current_thread(ExecutionClass.LATENCY)
        while True:
            self.run_due()
            with self._condition:
                if self._stopped:
                    return
                self._discard_stale_locked()
                if not self._heap:
                    self._condition.wait()
                    continue
                remaining_ns = self._heap[0].deadline_ns - self._monotonic_ns()
                if remaining_ns > 0:
                    self._condition.wait(remaining_ns / 1_000_000_000)

    def stop(self, *, timeout: float = 5.0) -> bool:
        with self._condition:
            self._accepting = False
            self._stopped = True
            self._active.clear()
            self._heap.clear()
            self._condition.notify_all()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout)
        return not bool(thread and thread.is_alive())

    def health_snapshot(self) -> dict[str, object]:
        metrics = self.metrics_snapshot()
        if self._failure:
            state = "failed"
        elif self._stopped:
            state = "stopped"
        elif self._thread and self._thread.is_alive():
            state = "running"
        else:
            state = "created"
        return {
            "state": state,
            "healthy": self._failure is None and state in {"created", "running"},
            "failure": self._failure,
            "thread_alive": bool(self._thread and self._thread.is_alive()),
            **asdict(metrics),
        }

    def metrics_snapshot(self) -> SchedulerMetrics:
        with self._condition:
            return SchedulerMetrics(
                scheduled=self._scheduled,
                executed=self._executed,
                cancelled=self._cancelled,
                coalesced=self._coalesced,
                failed=self._failed,
                pending=len(self._active),
            )

    def _discard_stale_locked(self) -> None:
        while self._heap:
            call = self._heap[0]
            if self._active.get(call.key) == call.generation:
                break
            heapq.heappop(self._heap)

    def _compact_locked(self) -> None:
        self._heap = [call for call in self._heap if self._active.get(call.key) == call.generation]
        heapq.heapify(self._heap)


_runtime_scheduler: SchedulerActor | None = None
_runtime_scheduler_leases = 0
_runtime_scheduler_lock = threading.Lock()


def acquire_runtime_scheduler() -> SchedulerActor:
    global _runtime_scheduler, _runtime_scheduler_leases
    with _runtime_scheduler_lock:
        if _runtime_scheduler is None or _runtime_scheduler.health_snapshot()["state"] == "stopped":
            _runtime_scheduler = SchedulerActor()
        _runtime_scheduler_leases += 1
        scheduler = _runtime_scheduler
        scheduler.start()
        return scheduler


def release_runtime_scheduler(scheduler: SchedulerActor, *, timeout: float = 5.0) -> bool:
    global _runtime_scheduler, _runtime_scheduler_leases
    should_stop = False
    with _runtime_scheduler_lock:
        if scheduler is not _runtime_scheduler:
            return True
        _runtime_scheduler_leases = max(0, _runtime_scheduler_leases - 1)
        if _runtime_scheduler_leases == 0:
            _runtime_scheduler = None
            should_stop = True
    return scheduler.stop(timeout=timeout) if should_stop else True


def shutdown_runtime_scheduler(*, timeout: float = 5.0) -> bool:
    """Final process-shutdown fallback after all scheduler owners stop intake."""
    global _runtime_scheduler, _runtime_scheduler_leases
    with _runtime_scheduler_lock:
        scheduler = _runtime_scheduler
        _runtime_scheduler = None
        _runtime_scheduler_leases = 0
    return True if scheduler is None else scheduler.stop(timeout=timeout)
