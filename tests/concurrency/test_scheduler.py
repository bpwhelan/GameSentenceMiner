from __future__ import annotations

from GameSentenceMiner.util.concurrency.scheduler import SchedulerActor


class FakeClock:
    def __init__(self) -> None:
        self.now_ns = 0

    def monotonic_ns(self) -> int:
        return self.now_ns

    def advance(self, seconds: float) -> None:
        self.now_ns += int(seconds * 1_000_000_000)


def test_scheduler_is_deterministic_and_latest_deadline_wins():
    clock = FakeClock()
    scheduler = SchedulerActor(capacity=2, monotonic_ns=clock.monotonic_ns)
    calls = []

    scheduler.schedule_after("line", 1.0, lambda: calls.append("old"))
    scheduler.schedule_after("line", 2.0, lambda: calls.append("new"))
    clock.advance(1.0)
    assert scheduler.run_due() == 0
    clock.advance(1.0)
    assert scheduler.run_due() == 1

    assert calls == ["new"]
    assert scheduler.metrics_snapshot().coalesced == 1
    scheduler.stop()
