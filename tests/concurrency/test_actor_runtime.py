from __future__ import annotations

import threading

import pytest

from GameSentenceMiner.util.concurrency.actor import (
    Actor,
    ActorStopped,
    MailboxFull,
    MailboxPolicy,
    RuntimeSupervisor,
)


class RecordingActor(Actor[int, int]):
    def __init__(self, *, capacity: int = 8, policy: MailboxPolicy = MailboxPolicy.ORDERED):
        super().__init__("test-recorder", capacity=capacity, policy=policy)
        self.values: list[int] = []

    def handle(self, message: int) -> int:
        self.values.append(message)
        return message * 2


def test_actor_ask_runs_on_owned_named_thread():
    actor = RecordingActor()
    actor.start()
    try:
        assert actor.ref.ask(21, timeout=0.5) == 42
        assert actor.thread_name == "test-recorder"
        assert actor.is_alive
        assert actor.metrics_snapshot().processed == 1
    finally:
        actor.stop(drain=True, timeout=1)

    assert not actor.is_alive
    with pytest.raises(ActorStopped):
        actor.ref.tell(1)


def test_latest_mailbox_coalesces_pending_values():
    entered = threading.Event()
    release = threading.Event()

    class BlockingActor(RecordingActor):
        def handle(self, message: int) -> int:
            if message == 1:
                entered.set()
                release.wait(1)
            return super().handle(message)

    actor = BlockingActor(capacity=1, policy=MailboxPolicy.LATEST)
    actor.start()
    try:
        actor.ref.tell(1)
        assert entered.wait(0.5)
        actor.ref.tell(2)
        actor.ref.tell(3)
        release.set()
        assert actor.wait_idle(1)
        assert actor.values == [1, 3]
        assert actor.metrics_snapshot().coalesced == 1
    finally:
        actor.stop(drain=True, timeout=1)


def test_ordered_mailbox_reports_backpressure_instead_of_dropping():
    actor = RecordingActor(capacity=1)
    actor.ref.tell(1)
    with pytest.raises(MailboxFull):
        actor.ref.tell(2, timeout=0)


def test_stop_drains_a_full_prestarted_mailbox_without_stranding_thread():
    actor = RecordingActor(capacity=1)
    actor.ref.tell(1)
    actor.start()

    assert actor.stop(drain=True, timeout=1)
    assert actor.values == [1]
    assert not actor.is_alive


def test_supervisor_stops_registered_actors_in_reverse_order():
    stopped: list[str] = []

    class OrderedStopActor(RecordingActor):
        def on_stop(self) -> None:
            stopped.append(self.name)

    supervisor = RuntimeSupervisor()
    first = supervisor.register(OrderedStopActor())
    first.name = "first"
    second = supervisor.register(OrderedStopActor())
    second.name = "second"
    supervisor.start()
    supervisor.stop()

    assert stopped == ["second", "first"]
    assert supervisor.health_snapshot()["state"] == "stopped"


def test_state_owner_failure_marks_runtime_unhealthy_and_closes_intake():
    class FailingActor(RecordingActor):
        def handle(self, message: int) -> int:
            raise ValueError(f"bad message: {message}")

    supervisor = RuntimeSupervisor()
    failing = supervisor.register(FailingActor())
    sibling = supervisor.register(RecordingActor())
    supervisor.start()
    try:
        with pytest.raises(ValueError, match="bad message"):
            failing.ref.ask(7, timeout=0.5)
        assert not failing.is_alive
        assert supervisor.health_snapshot()["healthy"] is False
        assert supervisor.health_snapshot()["failure"]["actor"] == "test-recorder"
        with pytest.raises(ActorStopped):
            sibling.ref.tell(1)
    finally:
        supervisor.stop()
