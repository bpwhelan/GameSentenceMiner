"""Compare the former Python speech relay with the debug desktop's direct helper pipe.

Run with the project venv, --helper pointing to scripts/fixtures/speech_helper.rs
compiled with rustc, and --desktop-test pointing to the cargo test executable.
"""

import argparse
import json
import logging
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path


def python_worker(helper, case):
    from GameSentenceMiner.windows_speech_recognition import (
        ForegroundWindow,
        WindowsSpeechRecognitionService,
        _ProcessPair,
    )

    latencies, texts = [], []

    def on_text(event, *_):
        latencies.append(time.time_ns() // 1000 - event.offset)
        texts.append(event.text)

    service = WindowsSpeechRecognitionService(on_text=on_text, language="ja", backend="sapi")
    print("SPEECH_READY", os.getpid(), flush=True)
    input()
    start = time.perf_counter()
    options = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "bufsize": 0}
    audio = subprocess.Popen([helper, "--root-pid", "1"], stdin=subprocess.DEVNULL, **options)
    speech = subprocess.Popen([helper, "--language", "ja-JP"], stdin=subprocess.PIPE, **options)
    pair = _ProcessPair(audio, speech, 1, logging.getLogger(__name__))
    try:
        deadline = start + 30
        while len(texts) < 64:
            service._drain_events(pair, ForegroundWindow(1, 1))
            if time.perf_counter() > deadline:
                raise TimeoutError("Missing recognition events")
            if len(texts) < 64:
                time.sleep(service.poll_interval)
        assert audio.wait(timeout=3) == speech.wait(timeout=3) == 0
    finally:
        pair.stop()
    assert texts == [f"結果{i * 32 + 31 if case == 'burst' else i}" for i in range(64)]
    print(
        "SPEECH_DONE",
        json.dumps({"wall_ms": (time.perf_counter() - start) * 1000, "latencies_us": latencies}),
        flush=True,
    )
    input()


def run(command, env):
    import psutil

    with subprocess.Popen(
        command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8"
    ) as worker:
        try:
            for line in worker.stdout:
                if "SPEECH_READY " in line:
                    # A Windows venv may launch the interpreter in a child process.
                    p = psutil.Process(int(line.split("SPEECH_READY ", 1)[1]))
                    cpu = sum(p.cpu_times()[:2])
                    worker.stdin.write("\n")
                    worker.stdin.flush()
                if "SPEECH_DONE " in line:
                    result = json.loads(line.split("SPEECH_DONE ", 1)[1])
                    result["cpu_ms"] = 1000 * (sum(p.cpu_times()[:2]) - cpu)
                    result["peak_ws_mib"] = p.memory_info().peak_wset / 2**20
                    result["median_delivery_ms"] = statistics.median(result.pop("latencies_us")) / 1000
                    worker.stdin.write("\n")
                    worker.stdin.flush()
                    break
            else:
                raise RuntimeError("Worker exited without reporting its result")
            if worker.wait(timeout=10):
                raise RuntimeError("Speech fixture validation failed")
            return result
        finally:
            if worker.poll() is None:
                worker.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--desktop-test", type=Path)
    parser.add_argument("--worker", choices=["live", "burst"])
    parser.add_argument("--rounds", type=int, default=5)
    args = parser.parse_args()
    helper = str(args.helper.resolve())
    if args.worker:
        return python_worker(helper, args.worker)
    if os.name != "nt" or not args.desktop_test:
        parser.error("The comparison requires Windows and a debug desktop test executable")
    for case in ("live", "burst"):
        env = {
            **os.environ,
            "GSM_SPEECH_FIXTURE": case,
            "GSM_WINDOWS_AUDIO_HELPER": helper,
            "GSM_WINDOWS_SAPI_HELPER": helper,
        }
        commands = {
            "Python": [sys.executable, "-m", "scripts.benchmark_speech_pipe", "--helper", helper, "--worker", case],
            "Rust": [
                str(args.desktop_test),
                "mining_workspace::speech::tests::speech_pipe_benchmark",
                "--ignored",
                "--exact",
                "--nocapture",
            ],
        }
        rows = {key: [] for key in commands}
        for i in range(args.rounds):
            for key in list(commands) if i % 2 == 0 else reversed(commands):
                rows[key].append(run(commands[key], env))
        for key, results in rows.items():
            median = {name: round(statistics.median(row[name] for row in results), 3) for name in results[0]}
            print(case, key, median, flush=True)


if __name__ == "__main__":
    main()
