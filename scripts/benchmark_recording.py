"""Compare native and standalone subtitle writers and Anki Beacon receivers."""

import argparse
import datetime
import hashlib
import json
import os
import platform
import statistics
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace

from benchmark_stats import (
    REPO_ROOT,
    _configure_bootstrap_environment,
    _install_keyboard_stub,
    _install_noop_logging_module,
)
from benchmark_stats_web import measure, start_worker


def reference(directory, case):
    _configure_bootstrap_environment(directory / "bootstrap")
    _install_keyboard_stub()
    _install_noop_logging_module()
    fixture = json.loads((directory / "fixture.json").read_text(encoding="utf8"))
    if case == "beacon":
        from GameSentenceMiner import anki

        def run():
            anki.reset_anki_beacon_receiver_state()
            added = 0
            for raw in fixture["events"]:
                if anki.handle_incoming_anki_event(json.loads(raw)) == "note_added":
                    anki.anki_beacon_note_queue.get_nowait()
                    added += 1
            return added
    else:
        from GameSentenceMiner import longplay_handler as lp

        origin = datetime.datetime(2020, 1, 1, tzinfo=datetime.UTC)
        interval = datetime.timedelta(seconds=2.5)
        lines = []
        for i, text in enumerate(fixture["lines"]):
            lines.append(SimpleNamespace(time=origin + i * interval, text=text, prev=lines[-1] if lines else None))
        lp.get_all_lines = lambda: lines
        handler = lp.LongPlayHandler(lambda: True, lambda: "Fixture")
        video = directory / "python.mkv"
        srt = video.with_suffix(".srt")

        def run():
            srt.unlink(missing_ok=True)
            lp.gsm_state.recording_started_time = origin
            handler.on_record_state_changed(True, str(video) if case == "known" else None)
            for line in lines:
                handler.add_srt_line(line.time, line)
            # Supply the same deterministic stop time to the production finalizer.
            with handler._lock:
                handler._finalize_locked(end_time=origin + len(lines) * interval, output_path=str(video), reset=True)
            return 0

    print(f"ready {os.getpid()}", flush=True)
    for command in sys.stdin:
        _, count, _ = json.loads(command)
        start = time.perf_counter()
        for _ in range(count):
            added = run()
        ms = (time.perf_counter() - start) * 1000 / count
        print(
            json.dumps({"ms": ms, "added": added, "bytes": srt.stat().st_size if case != "beacon" else 0}), flush=True
        )


def cues(path):
    return path.read_text(encoding="utf8").strip().split("\n\n")


def run(root, rounds):
    worker = REPO_ROOT / "src-tauri/target/native-dev/release/examples/recording_benchmark"
    if os.name == "nt":
        worker = worker.with_suffix(".exe")
    report = {
        "rounds": rounds,
        "platform": platform.platform(),
        "worker_sha256": hashlib.sha256(worker.read_bytes()).hexdigest(),
        "workloads": {},
    }
    for case, size, calls in [("known", 64, 40), ("known", 2500, 3), ("late", 2500, 3), ("beacon", 256, 60)]:
        directory = root / f"{case}_{size}"
        directory.mkdir()
        lines = [f"台詞 {i} ―― 遠くから声が聞こえた。" for i in range(size)] if case != "beacon" else []
        events = []
        if case == "beacon":
            events.append(json.dumps({"event": "heartbeat", "session_id": "fixture", "heartbeat_interval_seconds": 15}))
            for note in range(1, size + 1):
                event = json.dumps({"event": "note_added", "session_id": "fixture", "note_id": note})
                events.extend((event, event))
        (directory / "fixture.json").write_text(
            json.dumps({"lines": lines, "events": events}, ensure_ascii=False), encoding="utf8"
        )
        samples = {"python": [], "rust": []}
        with ExitStack() as stack:
            processes = {
                "python": start_worker(
                    stack, [sys.executable, __file__, "--reference", str(directory), "--case", case]
                ),
                "rust": start_worker(stack, [str(worker), str(directory)]),
            }
            for process in processes.values():
                check = measure(process, case, 1, verify=True)
                assert check["added"] == (size if case == "beacon" else 0)
            if lines:
                py, rs = cues(directory / "python.srt"), cues(directory / "rust.srt")
                assert len(py) == len(rs) == size and py[:-1] == rs[:-1]
                assert py[-1].splitlines()[-1] == lines[-2] and rs[-1].splitlines()[-1] == lines[-1]
            for i in range(rounds):
                for lang in processes if i % 2 == 0 else reversed(processes):
                    samples[lang].append(measure(processes[lang], case, calls))
        summary = {
            lang: {
                key: round(statistics.median(row[key] for row in rows), 4) for key in ("ms", "cpu_ms", "resident_mib")
            }
            for lang, rows in samples.items()
        }
        report["workloads"][directory.name] = {**summary, "calls": calls, "samples": samples}
        print(directory.name, summary, flush=True)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--case")
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.reference:
        reference(args.reference, args.case)
    else:
        with tempfile.TemporaryDirectory() as temp:
            report = run(Path(temp), args.rounds)
        if args.output:
            args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
