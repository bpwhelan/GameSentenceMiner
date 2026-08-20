from __future__ import annotations

import threading

import pytest

from GameSentenceMiner.util.concurrency.actor import MailboxFull
from GameSentenceMiner.util.concurrency.work_pool import BoundedWorkPool


def test_bounded_work_pool_rejects_overload_explicitly():
    entered = threading.Event()
    release = threading.Event()
    pool = BoundedWorkPool("test-work", max_workers=1, capacity=1)

    def blocking_job() -> None:
        entered.set()
        release.wait(1)

    try:
        future = pool.submit(blocking_job)
        assert entered.wait(0.5)
        with pytest.raises(MailboxFull):
            pool.submit(lambda: None, timeout=0)
        release.set()
        future.result(timeout=1)
    finally:
        release.set()
        pool.shutdown()

    metrics = pool.metrics_snapshot()
    assert metrics.accepted == 1
    assert metrics.rejected == 1
    assert metrics.completed == 1
