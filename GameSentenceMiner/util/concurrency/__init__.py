"""Deterministic, supervised concurrency primitives used by GSM domain services."""

from .actor import (
    Actor,
    ActorRef,
    ActorStopped,
    MailboxFull,
    MailboxPolicy,
    RuntimeSupervisor,
)
from .scheduler import (
    SchedulerActor,
    SchedulerMetrics,
    acquire_runtime_scheduler,
    release_runtime_scheduler,
    shutdown_runtime_scheduler,
)
from .work_pool import BoundedDeque, BoundedWorkPool, submit_background_work
from .resource_qos import ExecutionClass, configure_background_process, configure_current_thread

__all__ = [
    "Actor",
    "ActorRef",
    "ActorStopped",
    "MailboxFull",
    "MailboxPolicy",
    "RuntimeSupervisor",
    "SchedulerActor",
    "SchedulerMetrics",
    "acquire_runtime_scheduler",
    "release_runtime_scheduler",
    "shutdown_runtime_scheduler",
    "BoundedWorkPool",
    "BoundedDeque",
    "submit_background_work",
    "ExecutionClass",
    "configure_background_process",
    "configure_current_thread",
]
