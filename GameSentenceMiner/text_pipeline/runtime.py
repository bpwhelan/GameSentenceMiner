from __future__ import annotations

from datetime import timedelta
from typing import Callable

from GameSentenceMiner.util.concurrency.actor import (
    Actor,
    ActorStopped,
    MailboxFull,
    MailboxPolicy,
    RuntimeSupervisor,
)
from GameSentenceMiner.util.concurrency.scheduler import (
    SchedulerActor,
    acquire_runtime_scheduler,
    release_runtime_scheduler,
)
from GameSentenceMiner.util.concurrency.resource_qos import ExecutionClass, enable_responsive_gil

from .coordinator import FreezeCommand, IngestCommand, SnapshotCommand, TextCoordinatorActor, TextCoordinatorState
from .models import (
    IngressAck,
    IngressResult,
    IngressStatus,
    TextDomainEvent,
    TextObservation,
    TextStreamSnapshot,
)


class TextProjectionActor(Actor[TextDomainEvent, None]):
    def __init__(self, projector: Callable[[TextDomainEvent], None], *, capacity: int = 2048) -> None:
        super().__init__(
            "gsm-text-projection",
            capacity=capacity,
            policy=MailboxPolicy.ORDERED,
            execution_class=ExecutionClass.LATENCY,
        )
        self._projector = projector

    def handle(self, message: TextDomainEvent) -> None:
        self._projector(message)


class AuthoritativeTextRuntime:
    """Owns the authoritative text actor and its ordered compatibility projection."""

    def __init__(
        self,
        projector: Callable[[TextDomainEvent], None],
        *,
        retention_provider: Callable[[], timedelta | None] | None = None,
    ) -> None:
        self.supervisor = RuntimeSupervisor()
        self.scheduler: SchedulerActor | None = None
        self.projection = self.supervisor.register(TextProjectionActor(projector))
        state = TextCoordinatorState()
        self.coordinator = self.supervisor.register(
            TextCoordinatorActor(
                state=state,
                subscriber=self._enqueue_projection,
                retention_provider=retention_provider,
                schedule_freeze=self._schedule_freeze,
            )
        )
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        enable_responsive_gil()
        self.scheduler = acquire_runtime_scheduler()
        self.supervisor.start()
        self._started = True

    def ingest(self, observation: TextObservation, *, timeout: float = 0.25) -> IngressResult:
        self.start()
        try:
            result = self.coordinator.ref.ask(IngestCommand(observation), timeout=timeout)
            if not isinstance(result, IngressResult):
                raise TypeError(f"Unexpected text ingress result: {type(result)!r}")
            return result
        except MailboxFull:
            return IngressResult(
                IngressAck(IngressStatus.BACKPRESSURED, observation.observation_id, reason="text mailbox full")
            )
        except (ActorStopped, TimeoutError):
            return IngressResult(
                IngressAck(IngressStatus.REJECTED, observation.observation_id, reason="text runtime unavailable")
            )

    def freeze(self, line_id: str, *, timeout: float = 0.25) -> tuple[TextDomainEvent, ...]:
        self.start()
        result = self.coordinator.ref.ask(FreezeCommand(line_id), timeout=timeout)
        if not isinstance(result, tuple):
            raise TypeError(f"Unexpected freeze result: {type(result)!r}")
        return result

    def snapshot(self, *, timeout: float = 0.25) -> TextStreamSnapshot:
        self.start()
        result = self.coordinator.ref.ask(SnapshotCommand(), timeout=timeout)
        if not isinstance(result, TextStreamSnapshot):
            raise TypeError(f"Unexpected snapshot result: {type(result)!r}")
        return result

    def wait_projected(self, timeout: float = 1.0) -> bool:
        return self.projection.wait_idle(timeout)

    def stop(self) -> bool:
        if not self._started:
            return True
        try:
            snapshot = self.snapshot(timeout=1.0)
            if snapshot.records and snapshot.records[-1].state.value == "provisional":
                self.freeze(snapshot.records[-1].line_id, timeout=1.0)
                self.wait_projected(timeout=1.0)
        except Exception:
            pass
        scheduler = self.scheduler
        self.scheduler = None
        scheduler_stopped = True if scheduler is None else release_runtime_scheduler(scheduler)
        success = self.supervisor.stop() and scheduler_stopped
        self._started = False
        return success

    def health_snapshot(self) -> dict[str, object]:
        health = self.supervisor.health_snapshot()
        scheduler_health = (
            self.scheduler.health_snapshot() if self.scheduler is not None else {"state": "created", "healthy": True}
        )
        health["scheduler"] = scheduler_health
        health["healthy"] = bool(health["healthy"] and health["scheduler"]["healthy"])
        return health

    def _enqueue_projection(self, event: TextDomainEvent) -> None:
        self.projection.ref.tell(event)

    def _schedule_freeze(self, line_id: str, delay_seconds: float) -> None:
        def freeze_line() -> None:
            try:
                self.coordinator.ref.tell(FreezeCommand(line_id), timeout=0.25)
            except ActorStopped:
                pass

        scheduler = self.scheduler
        if scheduler is None:
            raise ActorStopped("Text scheduler is unavailable")
        scheduler.schedule_after("text.open.freeze", delay_seconds, freeze_line)
