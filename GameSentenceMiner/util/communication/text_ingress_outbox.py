from __future__ import annotations

import threading
from dataclasses import dataclass, replace
from typing import Any, Callable

from GameSentenceMiner.util.concurrency.actor import Actor, ActorStopped, MailboxFull, MailboxPolicy
from GameSentenceMiner.util.concurrency.scheduler import (
    SchedulerActor,
    acquire_runtime_scheduler,
    release_runtime_scheduler,
)

from . import bus_client

TEXT_INGRESS_TOPIC = "text.ingress.v2"
RETRY_DELAYS = (0.05, 0.1, 0.2, 0.4)


@dataclass(frozen=True)
class OutboxItem:
    payload: dict[str, Any]
    attempt: int = 0
    on_complete: Callable[[str, dict[str, Any]], None] | None = None

    @property
    def observation_id(self) -> str:
        return str(self.payload.get("observationId") or self.payload.get("observation_id") or "")


class TextIngressOutboxActor(Actor[OutboxItem, dict[str, Any] | None]):
    """Retry owner that never sleeps while newer OCR observations are queued."""

    def __init__(
        self,
        *,
        target: str = "backend",
        capacity: int = 256,
        scheduler: SchedulerActor | None = None,
    ) -> None:
        super().__init__("gsm-text-ingress-outbox", capacity=capacity, policy=MailboxPolicy.ORDERED)
        self.target = target
        self._scheduler = scheduler
        self._owns_scheduler_lease = scheduler is None

    def on_start(self) -> None:
        if self._scheduler is None:
            self._scheduler = acquire_runtime_scheduler()

    def handle(self, message: OutboxItem) -> dict[str, Any] | None:
        bus = bus_client.get_bus()
        if bus.connected:
            try:
                ack = bus.request(self.target, TEXT_INGRESS_TOPIC, message.payload, timeout=0.35)
                if isinstance(ack, dict) and ack.get("status") != "backpressured":
                    return self._complete(message, ack)
            except Exception:
                pass

        delay = RETRY_DELAYS[min(message.attempt, len(RETRY_DELAYS) - 1)]
        retry = replace(message, attempt=message.attempt + 1)
        scheduler = self._scheduler
        if scheduler is None:
            raise RuntimeError("Text ingress retry scheduler is unavailable")

        def enqueue_retry() -> None:
            try:
                self.ref.tell(retry, timeout=0)
            except (ActorStopped, MailboxFull):
                self._complete(
                    retry,
                    {
                        "status": "backpressured",
                        "observation_id": retry.observation_id,
                        "reason": "producer retry mailbox unavailable",
                    },
                )

        scheduler.schedule_after(
            f"text-ingress-outbox:{id(self)}:{message.observation_id}",
            delay,
            enqueue_retry,
        )
        return None

    def on_stop(self) -> None:
        scheduler = self._scheduler
        self._scheduler = None
        if scheduler is not None and self._owns_scheduler_lease:
            release_runtime_scheduler(scheduler)

    @staticmethod
    def _complete(message: OutboxItem, result: dict[str, Any]) -> dict[str, Any]:
        if message.on_complete is not None:
            message.on_complete(message.observation_id, result)
        return result


@dataclass(frozen=True)
class TextIngressOutboxMetrics:
    pending: int
    accepted: int
    completed: int
    stale_excluded: int
    backpressured: int


class TextIngressOutbox:
    def __init__(self, *, target: str = "backend", capacity: int = 256) -> None:
        self._capacity = capacity
        self._slots = threading.BoundedSemaphore(capacity)
        self._pending_ids: set[str] = set()
        self._lock = threading.RLock()
        self._accepted = 0
        self._completed = 0
        self._stale_excluded = 0
        self._backpressured = 0
        self.actor = TextIngressOutboxActor(target=target, capacity=capacity)
        self.actor.start()

    def submit(self, payload: dict[str, Any]) -> bool:
        copied = dict(payload)
        observation_id = str(copied.get("observationId") or copied.get("observation_id") or "")
        if not observation_id:
            return False
        with self._lock:
            if observation_id in self._pending_ids:
                return True
        if not self._slots.acquire(blocking=False):
            with self._lock:
                self._backpressured += 1
            return False
        with self._lock:
            self._pending_ids.add(observation_id)
            self._accepted += 1
        item = OutboxItem(copied, on_complete=self._on_complete)
        try:
            self.actor.ref.tell(item, timeout=0)
            return True
        except (ActorStopped, MailboxFull):
            self._release(observation_id, {"status": "backpressured"})
            return False

    def _on_complete(self, observation_id: str, result: dict[str, Any]) -> None:
        self._release(observation_id, result)

    def _release(self, observation_id: str, result: dict[str, Any]) -> None:
        with self._lock:
            if observation_id not in self._pending_ids:
                return
            self._pending_ids.remove(observation_id)
            self._completed += 1
            status = result.get("status")
            if status == "stale_excluded":
                self._stale_excluded += 1
            elif status == "backpressured":
                self._backpressured += 1
        self._slots.release()

    def metrics_snapshot(self) -> TextIngressOutboxMetrics:
        with self._lock:
            return TextIngressOutboxMetrics(
                pending=len(self._pending_ids),
                accepted=self._accepted,
                completed=self._completed,
                stale_excluded=self._stale_excluded,
                backpressured=self._backpressured,
            )

    def stop(self) -> bool:
        return self.actor.stop(drain=True, timeout=3)
