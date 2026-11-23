"""Replay short, long and fast-forward dialogue traces in isolated processes.

Build cargo build --locked --release --example replay --manifest-path native/gsm-intake/Cargo.toml
then run python -m scripts.benchmark_intake_stream --binary PATH --output PATH.
"""

import argparse
import hashlib
import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import psutil

from scripts.benchmark_dialogue_correlation import observations


def python_worker(case, repeats):
    from GameSentenceMiner.native import ocr
    from GameSentenceMiner.text_pipeline.coordinator import TextCoordinatorState

    assert ocr._extension is not None
    rows = observations(case == "long", case == "burst")

    def cycle(verify=False):
        state = TextCoordinatorState(skip_detection=True)
        out = []
        for obs in rows:
            # Advance scheduled speech freezes on the trace clock for both owners.
            due = state.freeze_due(now=obs.received_at_utc, now_monotonic_ns=obs.received_monotonic_ns)
            res = state.ingest(obs, now=obs.received_at_utc)
            if verify:
                ack = res.ack
                events = [
                    [
                        e.kind.value,
                        e.record.stream_sequence,
                        e.record.revision,
                        e.record.text,
                        e.record.stats_status,
                        e.record.observation_ids,
                    ]
                    for e in (*due, *res.events)
                ]
                out.append(
                    [ack.status.value, ack.reason, ack.stream_sequence, ack.revision, ack.matched_source, events]
                )
        return out

    print(json.dumps([os.getpid(), cycle(True)], ensure_ascii=False), flush=True)
    input()
    start = time.perf_counter()
    for _ in range(repeats):
        cycle()
    print((time.perf_counter() - start) * 1e6 / (len(rows) * repeats), flush=True)
    input()


def sample(args, count):
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "GSM_NATIVE_TEXT_MODE": "native"}
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, encoding="utf-8", env=env)
    try:
        pid, reference = json.loads(proc.stdout.readline())
        process = psutil.Process(pid)

        def cpu():
            times = process.cpu_times()
            return times.user + times.system

        def memory():
            return process.memory_full_info().uss / (1024 * 1024)

        base = peak = memory()
        stop = threading.Event()

        def monitor():
            nonlocal peak
            while not stop.wait(0.01):
                peak = max(peak, memory())

        sampler = threading.Thread(target=monitor)
        sampler.start()
        try:
            before = cpu()
            proc.stdin.write("\n")
            proc.stdin.flush()
            wall = float(proc.stdout.readline())
            work = (cpu() - before) * 1e6 / count
            peak = max(peak, memory())
        finally:
            stop.set()
            sampler.join()
        proc.communicate("\n", timeout=10)
        assert proc.returncode == 0
        return reference, {"wall_us": wall, "cpu_us": work, "baseline_private_mib": base, "peak_private_mib": peak}
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


async def clipboard_notification():
    import asyncio

    import win32gui

    from GameSentenceMiner.util.platform.windows_clipboard import WM_CLIPBOARDUPDATE, WindowsClipboardListener

    loop = asyncio.get_running_loop()
    signal = asyncio.Event()
    pump = WindowsClipboardListener(lambda: loop.call_soon_threadsafe(signal.set))
    assert pump.start()
    try:
        samples = []
        for _ in range(1024):
            start = time.perf_counter_ns()
            win32gui.PostMessage(pump._hwnd, WM_CLIPBOARDUPDATE, 0, 0)
            await asyncio.wait_for(signal.wait(), 2)
            samples.append((time.perf_counter_ns() - start) / 1000)
            signal.clear()
        samples.sort()
        return {"p50_us": samples[512], "p95_us": samples[972]}
    finally:
        pump.stop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--clipboard-binary", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--worker", choices=["mixed", "long", "burst"])
    parser.add_argument("--repeats", type=int, default=48)
    parser.add_argument("--rounds", type=int, default=3)
    a = parser.parse_args()
    if a.worker:
        return python_worker(a.worker, a.repeats)
    report = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cycles_per_sample": a.repeats,
        "cases": {},
        "replacement_filters": [
            json.loads(subprocess.check_output([str(a.binary.resolve()), "--filters"])) for _ in range(a.rounds)
        ],
    }
    if a.clipboard_binary:
        import asyncio

        from scripts.benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module

        with tempfile.TemporaryDirectory() as isolated:
            _configure_bootstrap_environment(Path(isolated))
            _install_noop_logging_module()
            report["clipboard_notification"] = {"python": [], "rust": []}
            for i in range(a.rounds):
                for mode in ("python", "rust") if i % 2 == 0 else ("rust", "python"):
                    result = (
                        asyncio.run(clipboard_notification())
                        if mode == "python"
                        else json.loads(subprocess.check_output([str(a.clipboard_binary.resolve())]))
                    )
                    report["clipboard_notification"][mode].append(result)
    with tempfile.TemporaryDirectory() as temp:
        for case in ("mixed", "long", "burst"):
            rows = observations(case == "long", case == "burst")
            path = Path(temp) / "observations.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "ns": r.received_monotonic_ns,
                            "scene": r.metadata["scene"],
                            "payload": {
                                "text": r.raw_text,
                                "source": r.source_kind.value,
                                "source_instance": r.source_instance,
                                "observation_id": r.observation_id,
                                "revision_window_ms": r.revision_window_ms,
                                "remove_matching_prefix": r.remove_matching_prefix,
                                "metadata": dict(r.metadata),
                            },
                        }
                        for r in rows
                    ],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            result = {"observations": len(rows), "samples": {"python": [], "rust": []}}
            commands = {
                "rust": [str(a.binary.resolve()), str(path), str(a.repeats)],
                "python": [
                    sys.executable,
                    "-m",
                    "scripts.benchmark_intake_stream",
                    "--worker",
                    case,
                    "--repeats",
                    str(a.repeats),
                ],
            }
            reference = None
            for n in range(a.rounds):
                for mode in ("python", "rust") if n % 2 == 0 else ("rust", "python"):
                    actual, metrics = sample(commands[mode], len(rows) * a.repeats)
                    if reference is None:
                        reference = actual
                    for i, (expected, found) in enumerate(zip(reference, actual, strict=True)):
                        assert expected == found, (case, mode, i, expected, found)
                    result["samples"][mode].append(metrics)
            result["median"] = {
                mode: {k: round(statistics.median(s[k] for s in samples), 3) for k in samples[0]}
                for mode, samples in result["samples"].items()
            }
            result["verified_sha256"] = hashlib.sha256(json.dumps(reference, ensure_ascii=False).encode()).hexdigest()
            print(case, result["median"], flush=True)
            report["cases"][case] = result
    a.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
