"""Compare dialogue journals with the same native classifier and skip detector on both paths."""

import gc
import hashlib
import json
import os
import time
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import psutil


def measure(case, mode, desktop_pid, iterations):
    from GameSentenceMiner.native import ocr
    from GameSentenceMiner.text_pipeline import coordinator
    from GameSentenceMiner.text_pipeline.journal import ReferenceJournal
    from GameSentenceMiner.text_pipeline.models import TextRecordState
    from scripts import benchmark_dialogue_correlation as intake
    from scripts.benchmark_mining_history import sample_operation_memory

    os.environ["GSM_NATIVE_TEXT_MODE"] = "native"
    make_journal = ReferenceJournal if mode == "python" else ocr._extension.DialogueJournal
    override = patch.object(coordinator, "make_journal", ReferenceJournal) if mode == "python" else nullcontext()
    with override:
        probe = coordinator.TextCoordinatorState(skip_detection=True)
        assert type(probe._journal) is make_journal
        assert probe._classify is ocr._extension.classify_dialogue
        if case.endswith(("-mixed", "-live")):
            # The intake harness checks the complete decision/event digest and waits
            # for projection on the live actor. Both sides keep the native classifier.
            return intake.measure(case.replace("-journal", ""), "rust", desktop_pid, iterations)
        if case.startswith("dialogue-journal-feed"):
            return measure_feed(case, mode, desktop_pid, iterations)

    processes = (psutil.Process(), psutil.Process(desktop_pid))

    def cpu():
        return sum(p.cpu_times().user + p.cpu_times().system for p in processes)

    def private_mib():
        return sum(p.memory_full_info().uss for p in processes) / 2**20

    def key(i):
        return f"00000000-0000-4000-8000-{i:012x}"

    if case.endswith("receipts"):
        count = 32_768

        def receipts(journal, ids):
            accepted = 0
            for i, receipt in enumerate(ids):
                accepted += journal.observe(receipt, 20_000)
                if i % 4 == 0:
                    accepted += journal.observe(receipt, 20_000)
            return accepted

        # Measure an initially empty cache with streamed IDs. Holding all input
        # strings in the fixture would hide Python's cost of retaining 20,000 IDs.
        gc.collect()
        base = private_mib()
        full = make_journal()
        assert receipts(full, (key(i) for i in range(count))) == count
        retained = private_mib() - base
        assert not full.observe(key(count - 20_000), 20_000)
        assert full.observe(key(0), 20_000)
        del full
        ids = tuple(map(key, range(count)))
        units = count + (count + 3) // 4

        def cycle():
            return receipts(make_journal(), ids)

        expected = {"accepted": count, "retried": units - count}
        assert cycle() == count
    else:
        live, steps = 16_384, 32_768
        stamp = datetime(2026, 1, 2, tzinfo=UTC)
        rows = [
            SimpleNamespace(
                line_id=key(i),
                first_seen_at_utc=stamp + timedelta(microseconds=i),
                stream_sequence=i + 1,
                stats_status="accepted",
                state=TextRecordState.FROZEN,
            )
            for i in range(live + steps)
        ]

        def prepare():
            journal = make_journal()
            for row in rows[:live]:
                journal.publish(row.line_id, row, True, (True, "accepted", None), None)
            return journal

        def roll(journal, verify=False):
            digest = hashlib.sha256() if verify else None
            for i, new in enumerate(rows[live:]):
                removed = journal.expire(rows[i + 1].first_seen_at_utc)
                journal.publish(new.line_id, new, True, (True, "accepted", None), None)
                found = journal.get(rows[i + 1].line_id)
                if verify:
                    assert removed[0] is rows[i] and len(removed) == 1 and found is rows[i + 1]
                    digest.update(removed[0].line_id.encode())
            if verify:
                seq, retained = journal.snapshot()
                assert seq == len(rows) and retained == tuple(rows[steps:])
                return {"expired_digest": digest.hexdigest(), "last_sequence": seq, "retained": len(retained)}

        gc.collect()
        base = private_mib()
        full = prepare()
        retained = private_mib() - base
        expected = roll(full, True)
        del full
        units = steps

        def cycle():
            roll(prepare())

    seconds = work = snapshot_wall = snapshot_cpu = fresh_wall = fresh_cpu = 0.0
    for _ in range(iterations):
        # Exclude initial population from the rolling expiration measurement.
        journal = prepare() if case.endswith("retention") else None
        start_cpu, start = cpu(), time.perf_counter()
        if journal is None:
            cycle()
        else:
            roll(journal)
        seconds += time.perf_counter() - start
        work += cpu() - start_cpu
        if journal is not None:
            # Re-publish the newest immutable projection to invalidate the snapshot
            # without changing the depth. A fresh read includes that revision.
            last = rows[-1]
            start_cpu, start = cpu(), time.perf_counter()
            for _ in range(256):
                journal.publish(last.line_id, last, False, (True, "accepted", None), None)
                journal.snapshot()
            fresh_wall += time.perf_counter() - start
            fresh_cpu += cpu() - start_cpu
            start_cpu, start = cpu(), time.perf_counter()
            for _ in range(2048):
                journal.snapshot()
            snapshot_wall += time.perf_counter() - start
            snapshot_cpu += cpu() - start_cpu
        del journal
    return {
        "result": expected,
        "operations": units,
        "us_per_operation": seconds * 1e6 / (units * iterations),
        "cpu_us_per_operation": work * 1e6 / (units * iterations),
        "retained_private_delta_mib": retained,
        **(
            {
                "repeat_snapshot_us": snapshot_wall * 1e6 / (iterations * 2048),
                "repeat_snapshot_cpu_us": snapshot_cpu * 1e6 / (iterations * 2048),
                "fresh_snapshot_us": fresh_wall * 1e6 / (iterations * 256),
                "fresh_snapshot_cpu_us": fresh_cpu * 1e6 / (iterations * 256),
            }
            if case.endswith("retention")
            else {}
        ),
        **sample_operation_memory(desktop_pid, cycle, "journal"),
    }


def measure_feed(case, mode, desktop_pid, iterations):
    from dataclasses import replace

    from GameSentenceMiner import gametext
    from GameSentenceMiner.text_pipeline import coordinator
    from GameSentenceMiner.text_pipeline.models import SourceKind, TextObservation, TextStreamSnapshot
    from GameSentenceMiner.text_pipeline.runtime import AuthoritativeTextRuntime
    from GameSentenceMiner.web.gsm_websocket import build_textfeed_v2_snapshot_payload
    from scripts.benchmark_mining_history import sample_operation_memory

    count = 64 if case.endswith("-short") else 4096
    requested = 100
    runtime = AuthoritativeTextRuntime(lambda event: None)
    state = runtime.coordinator.state
    state.session_id = "feed-benchmark"
    stamp = datetime(2026, 4, 8, tzinfo=UTC)
    template = TextObservation("0", SourceKind.MANUAL, "fixture", "第0行", stamp, stamp, stamp, 1)
    ids = iter(f"line-{i}" for i in range(count))
    with patch.object(coordinator, "uuid", SimpleNamespace(uuid4=lambda: next(ids))):
        for i in range(count):
            obs = replace(template, observation_id=str(i), raw_text=f"第{i}行。")
            state.ingest(obs, now=stamp)
    expected = TextStreamSnapshot(
        state.session_id, count, tuple(state.get(f"line-{i}") for i in range(max(0, count - requested), count))
    ).to_wire()

    def previous():
        payload = gametext.get_text_stream_snapshot().to_wire()
        payload["lines"] = payload["lines"][-requested:]
        return payload

    def current():
        return build_textfeed_v2_snapshot_payload({"max_lines": requested})

    processes = (psutil.Process(), psutil.Process(desktop_pid))

    def cpu():
        return sum(p.cpu_times().user + p.cpu_times().system for p in processes)

    with patch.object(gametext, "get_authoritative_text_runtime", return_value=runtime):
        runtime.start()
        try:
            request = previous if mode == "python" and not case.endswith("-bounded") else current
            assert expected == request()
            assert len(expected["lines"]) == min(requested, count) and expected["snapshot_sequence"] == count

            def cycle():
                return json.dumps(request())

            digest = hashlib.sha256(cycle().encode()).hexdigest()
            gc.collect()
            start_cpu, start = cpu(), time.perf_counter()
            for _ in range(iterations):
                cycle()
            wall, work = time.perf_counter() - start, cpu() - start_cpu
            return {
                "result": {"payload_sha256": digest, "retained": count, "returned": len(expected["lines"])},
                "ms_per_request": wall * 1000 / iterations,
                "cpu_ms_per_request": work * 1000 / iterations,
                **sample_operation_memory(desktop_pid, cycle, "feed"),
            }
        finally:
            assert runtime.stop()
