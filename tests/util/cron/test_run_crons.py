from __future__ import annotations

from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.cron.run_crons import (
    MANUAL_CRON_EXECUTION_TIMEOUT_SECONDS,
    CronScheduler,
    MockCron,
)


def test_run_cron_blocking_uses_bounded_timeout_when_scheduler_is_running(monkeypatch):
    scheduler = CronScheduler()
    scheduler._running = True
    scheduler.loop = SimpleNamespace(is_running=lambda: True)

    cancel_calls = []
    observed_timeouts = []

    class _FakeFuture:
        def result(self, timeout=None):
            observed_timeouts.append(timeout)
            raise TimeoutError("hung")

        def cancel(self):
            cancel_calls.append(True)
            return True

    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.run_crons.asyncio.run_coroutine_threadsafe",
        lambda coro, loop: (coro.close() or _FakeFuture()),
    )

    with pytest.raises(TimeoutError, match="Timed out waiting for manual cron execution"):
        scheduler.run_cron_blocking(MockCron(id=1, name="daily_stats_rollup", description="test"))

    assert observed_timeouts == [MANUAL_CRON_EXECUTION_TIMEOUT_SECONDS]
    assert cancel_calls == [True]


def test_run_cron_blocking_returns_result_before_timeout_when_scheduler_is_running(monkeypatch):
    scheduler = CronScheduler()
    scheduler._running = True
    scheduler.loop = SimpleNamespace(is_running=lambda: True)

    observed_timeouts = []
    expected = {"details": [{"success": True, "result": {"ok": 1}}]}

    class _FakeFuture:
        def result(self, timeout=None):
            observed_timeouts.append(timeout)
            return expected

        def cancel(self):
            raise AssertionError("cancel() should not be called for successful runs")

    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.run_crons.asyncio.run_coroutine_threadsafe",
        lambda coro, loop: (coro.close() or _FakeFuture()),
    )

    result = scheduler.run_cron_blocking(MockCron(id=1, name="daily_stats_rollup", description="test"))

    assert result == expected
    assert observed_timeouts == [MANUAL_CRON_EXECUTION_TIMEOUT_SECONDS]
