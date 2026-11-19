"""Measure full ingress decisions, including skip classification and record revisions."""

import gc
import hashlib
import json
import os
import sys
import time
from collections import Counter
from contextlib import nullcontext
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import psutil


def observations(long=False, burst=False):
    from GameSentenceMiner.text_pipeline.models import SourceKind as S
    from GameSentenceMiner.text_pipeline.models import TextObservation

    start = datetime(2026, 11, 19, tzinfo=UTC)
    samples = []
    if burst:
        # Sliding hook buffers with substantial overlap and varying fresh text.
        pages = "".join(chr(0x5000 + i) * 16 + "会話が続く。" for i in range(290))
        for i in range(216):
            stamp = start + timedelta(milliseconds=i * 45)
            samples.append(
                TextObservation(
                    str(i),
                    S.TEXTHOOK,
                    "hook",
                    pages[i * 22 : i * 22 + 500],
                    stamp,
                    stamp,
                    stamp,
                    1_000_000 + i * 45_000_000,
                    metadata={"scene": str(i // 72), "skip_control_active": i % 8 == 0},
                )
            )
        return samples
    for group in range(24):
        # Different lines from one source followed by an OCR approximation,
        # subsequent prefix, speech fragments, and a non-speech interruption.
        scene = str(group // 8)
        text = chr(0x5000 + group) + "もう少しここで待っていよう。"
        if long:
            text *= 160
        rows = [
            (S.TEXTHOOK, text),
            (S.OCR, text.replace("少", "秒")),
            (S.TEXTHOOK, text + " 続き。"),
            (S.TEXTHOOK, text + " 続き。"),
            (S.SPEECH_RECOGNITION, "そして"),
            (S.MANUAL, f"確認 {group}"),
            (S.SPEECH_RECOGNITION, "そして次へ"),
            (S.SPEECH_RECOGNITION, "そして"),
            (S.SPEECH_RECOGNITION, "そして次へ！"),
        ]
        for j, (source, raw) in enumerate(rows):
            i = len(samples)
            stamp = start + timedelta(milliseconds=40 * i)
            samples.append(
                TextObservation(
                    str(i),
                    source,
                    source.value,
                    raw,
                    stamp,
                    stamp,
                    stamp,
                    1_000_000 + 40_000_000 * i,
                    remove_matching_prefix=True,
                    merge_fragments=source is S.SPEECH_RECOGNITION,
                    revision_window_ms=500,
                    metadata={"scene": scene, "speech_final": j == 8},
                )
            )
    return samples


def measure(case, mode, desktop_pid, iterations):
    from GameSentenceMiner.native import ocr, text_correlation
    from GameSentenceMiner.text_pipeline.coordinator import TextCoordinatorState
    from scripts.benchmark_mining_history import sample_operation_memory

    os.environ["GSM_NATIVE_TEXT_MODE"] = "python" if mode == "python" else "native"
    os.environ["GSM_NATIVE_TEXT_CORRELATION"] = "1"
    if case.endswith("-broker"):
        ocr._extension = None
    items = observations("long" in case, "burst" in case)
    processes = [psutil.Process(), psutil.Process(desktop_pid)]

    def cpu():
        return sum(p.cpu_times().user + p.cpu_times().system for p in processes)

    def cycle(verify=False):
        state = TextCoordinatorState(session_id="bench", skip_detection=True)
        rows = []
        for obs in items:
            result = state.ingest(obs, now=obs.received_at_utc)
            if verify:
                ack = result.ack
                rows.append(
                    [
                        ack.status.value,
                        ack.reason,
                        ack.stream_sequence,
                        ack.revision,
                        ack.matched_source,
                        [
                            (
                                e.kind.value,
                                e.record.stream_sequence,
                                e.record.revision,
                                e.record.text,
                                e.record.stats_status,
                                e.record.observation_ids,
                            )
                            for e in result.events
                        ],
                    ]
                )
        if verify:
            return {
                "decisions_and_events": hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest(),
                "decisions": dict(Counter(r[0] for r in rows)),
                "metrics": vars(state.metrics),
            }

    def live_cycle(verify=False):
        from GameSentenceMiner.text_pipeline.models import SourceKind
        from GameSentenceMiner.text_pipeline.runtime import AuthoritativeTextRuntime

        published = []
        runtime = AuthoritativeTextRuntime(published.append)
        runtime.start()
        try:
            for obs in live_items:
                assert runtime.ingest(obs, timeout=1).ack.status.value == "accepted"
                assert runtime.wait_projected(timeout=1)
            assert len(published) == len(live_items)
            if verify:
                assert all(e.record.source_kind is SourceKind.MANUAL for e in published)
                rows = [(e.kind.value, e.record.text, e.record.stream_sequence) for e in published]
                return {"published": len(rows), "events_sha256": hashlib.sha256(json.dumps(rows).encode()).hexdigest()}
        finally:
            assert runtime.stop()

    if case == "dialogue-live":
        from GameSentenceMiner.text_pipeline.models import SourceKind

        live_items = [
            replace(obs, source_kind=SourceKind.MANUAL, raw_text=f"台詞 {i}。", remove_matching_prefix=False)
            for i, obs in enumerate(items)
        ]
        cycle = live_cycle

    from GameSentenceMiner.text_pipeline.skip_detection import SkipDetector

    probe = TextCoordinatorState(skip_detection=True)
    selected = probe._classify
    assert isinstance(probe._skip_detector, SkipDetector) == (mode == "python" or case.endswith("-broker"))
    check_path = nullcontext()
    if mode == "rust":
        assert selected is (text_correlation._desktop if case.endswith("-broker") else ocr._extension.classify_dialogue)

        def fail(*_):
            raise AssertionError("native classifier unexpectedly fell back")

        check_path = patch.object(TextCoordinatorState, "_classify_reference", fail)
    else:
        assert selected is None
    with check_path:
        expected = cycle(True)
        gc.collect()
        start_cpu, start = cpu(), time.perf_counter()
        for _ in range(iterations):
            cycle()
        wall, work = time.perf_counter() - start, cpu() - start_cpu
        count = iterations * len(items)
        return {
            "result": expected,
            "observations": len(items),
            "us_per_observation": wall * 1e6 / count,
            "cpu_us_per_observation": work * 1e6 / count,
            **sample_operation_memory(desktop_pid, cycle, "intake"),
        }


if __name__ == "__main__":
    # Run once per fresh interpreter from the repository root using -m.
    process = psutil.Process()
    baseline = process.memory_full_info().uss
    start = time.perf_counter()
    from GameSentenceMiner.text_pipeline.coordinator import TextCoordinatorState

    state = TextCoordinatorState(skip_detection=True)
    elapsed = time.perf_counter() - start
    assert state._classify is not None
    print(
        json.dumps(
            {
                "startup_ms": elapsed * 1000,
                "additional_private_mib": (process.memory_full_info().uss - baseline) / 2**20,
                "modules_loaded": {
                    name: name in sys.modules for name in ("rapidfuzz.fuzz", "unicodedata", "statistics")
                },
            }
        )
    )
