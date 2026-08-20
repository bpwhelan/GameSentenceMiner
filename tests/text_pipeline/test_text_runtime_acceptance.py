from __future__ import annotations

import statistics
import time
from datetime import datetime, timezone

from GameSentenceMiner.text_pipeline.models import SourceKind, TextEventKind, TextObservation
from GameSentenceMiner.text_pipeline.runtime import AuthoritativeTextRuntime


def _observation(index: int) -> TextObservation:
    now = datetime.now(timezone.utc)
    return TextObservation(
        observation_id=f"latency-{index}",
        source_kind=SourceKind.MANUAL,
        source_instance="acceptance",
        raw_text=f"line {index}",
        captured_at_utc=now,
        emitted_at_utc=now,
        received_at_utc=now,
        received_monotonic_ns=time.monotonic_ns(),
        revision_window_ms=100,
    )


def test_normal_load_ingress_to_provisional_projection_meets_latency_budget():
    submitted: dict[str, int] = {}
    latencies_ms: list[float] = []

    def project(event) -> None:
        if event.kind is TextEventKind.APPENDED:
            observation_id = event.record.observation_ids[0]
            latencies_ms.append((time.perf_counter_ns() - submitted[observation_id]) / 1_000_000)

    runtime = AuthoritativeTextRuntime(project)
    try:
        for index in range(1_000):
            item = _observation(index)
            submitted[item.observation_id] = time.perf_counter_ns()
            runtime.ingest(item, timeout=1.0)
        assert runtime.wait_projected(timeout=5.0)
    finally:
        runtime.stop()

    quantiles = statistics.quantiles(latencies_ms, n=100)
    assert quantiles[94] < 50
    assert quantiles[98] < 100
