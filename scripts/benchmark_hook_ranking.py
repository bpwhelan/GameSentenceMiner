"""Compare warm Python and Rust Hook Finder batches in isolated processes.

Build the Rust worker with cargo build --release --locked --example rank_hooks
--manifest-path native/gsm-text-preview/Cargo.toml, then run this script with
the repository's virtual environment. Pass --native to override the worker path.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import os
import statistics
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory

import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def python_worker():
    from scripts.benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module

    _configure_bootstrap_environment(ROOT / ".tmp_test_env" / "hook_ranking")
    _install_noop_logging_module()
    from GameSentenceMiner.util.config.configuration import TextProcessing
    from GameSentenceMiner.util.texthook_matching import rank_hooks

    request = json.loads(input())
    config = TextProcessing.from_dict(request["settings"], infer_missing=False)
    snapshot = request["snapshot"]

    def run():
        return rank_hooks(
            snapshot["hooks"],
            request["blocks"],
            config,
            request["language"],
            selected_hook_id=snapshot.get("selectedHookId"),
            processor_overrides=snapshot.get("processorOverrides"),
        )

    print(os.getpid(), flush=True)
    for line in sys.stdin:
        count = int(line)
        if count:
            for _ in range(count):
                run()
            print("done", flush=True)
        else:
            print(json.dumps(run(), ensure_ascii=True), flush=True)


def workloads():
    dialogues = ["今日の放課後は図書館で待ち合わせよう", "ここから先は一人で大丈夫だよ", "明日の朝になればまた会えるよ"]
    exact = [{"id": str(i), "samples": [dialogues[i % 3]]} for i in range(16)]
    mixed = [
        {
            "id": str(i),
            "samples": [
                f"<name{i}>{line}</name{i}>" if i % 2 else f"背景画像{i}.{j}.png" for j, line in enumerate(dialogues)
            ],
        }
        for i in range(24)
    ]
    scripted = [{"id": str(i), "samples": [f"{{ruby{i}}}{line}{{/ruby{i}}}" for line in dialogues]} for i in range(12)]
    configured = [{"id": str(i), "samples": [f"[{i}] {line}" for line in dialogues]} for i in range(12)]
    return {
        "exact": {"hooks": exact},
        "mixed": {"hooks": mixed},
        "script_tags": {"hooks": scripted},
        "custom_regex": {"hooks": configured},
        "busy_screen": {
            "hooks": [{"id": str(i), "samples": [f"第{i}話「{line}」" for line in dialogues]} for i in range(64)]
        },
    }, dialogues


class Worker:
    def __init__(self, stack, cmd, request):
        self.child = stack.enter_context(
            subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            )
        )
        stack.callback(self.child.stdin.close)
        # A Windows virtual environment can start Python through a launcher.
        self.process = psutil.Process(int(self.ask(json.dumps(request, ensure_ascii=True))))

    def ask(self, line):
        self.child.stdin.write(str(line) + "\n")
        self.child.stdin.flush()
        answer = self.child.stdout.readline()
        if not answer:
            raise RuntimeError(f"Hook ranking worker exited ({self.child.poll()})")
        return answer.strip()

    def measure(self, count):
        previous = self.process.cpu_times()
        start = time.perf_counter()
        if self.ask(count) != "done":
            raise RuntimeError("Hook ranking worker failed")
        elapsed = time.perf_counter() - start
        cpu = self.process.cpu_times()
        return elapsed * 1000 / count, (cpu.user + cpu.system - previous.user - previous.system) * 1000 / count


def resident_backend(use_python):
    """Keep shared mining dependencies loaded in both arms of the memory comparison."""
    from scripts.benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module

    request = json.loads(input())
    _configure_bootstrap_environment(Path(request["profile"]))
    _install_noop_logging_module()
    from GameSentenceMiner.util.communication.bus_client import BusClient
    from GameSentenceMiner.util.config.configuration import TextProcessing

    importlib.import_module("rapidfuzz.fuzz")
    importlib.import_module("GameSentenceMiner.util.text_processing")
    config = TextProcessing.from_dict(request["settings"], infer_missing=False)
    client = BusClient(client_id="backend", **request["broker"])
    if use_python:
        from GameSentenceMiner.util.texthook_matching import rank_hooks

        async def rank(message):
            data = message["data"]
            return await asyncio.to_thread(rank_hooks, data["hooks"], data["blocks"], config, request["language"])

        client.handle("texthook.rank", rank, concurrent=True)
    client.start()
    try:
        if not client.wait_connected(5):
            raise RuntimeError("Benchmark backend did not connect to the isolated broker")
        print(os.getpid(), flush=True)
        sys.stdin.readline()
    finally:
        client.stop()


def resident_memory(broker_exe, native_exe, request, engine):
    # Keep the same three processes alive. The benchmark splits the desktop
    # broker and native ranker into separate processes so both routes can be driven.
    with ExitStack() as stack:
        broker = stack.enter_context(
            subprocess.Popen(
                [broker_exe],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
        )
        stack.callback(broker.stdin.close)
        info = json.loads(broker.stdout.readline())["ready"]
        backend = Worker(
            stack,
            [sys.executable, __file__, "--resident-backend", engine],
            {key: request[key] for key in ("profile", "settings", "language")} | {"broker": info},
        )
        native = Worker(stack, [native_exe], request)
        payload = json.dumps(
            {
                "id": 1,
                "action": "bus.request",
                "params": {
                    "dst": "backend",
                    "topic": "texthook.rank",
                    "data": request["snapshot"] | {"blocks": request["blocks"]},
                },
            }
        )
        for _ in range(50):
            if engine == "rust":
                result = json.loads(native.ask(0))
            else:
                broker.stdin.write(payload + "\n")
                broker.stdin.flush()
                for line in broker.stdout:
                    message = json.loads(line)
                    if message.get("id") == 1:
                        result = message["result"]
                        break
                else:
                    raise RuntimeError("Benchmark broker exited")
        memory = [p.memory_full_info() for p in [psutil.Process(broker.pid), backend.process, native.process]]
        return result, {
            k: sum(getattr(m, k) for m in memory) / 2**20 for k in ("uss", "private") if hasattr(memory[0], k)
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--resident-backend", choices=("python", "rust"), help=argparse.SUPPRESS)
    parser.add_argument(
        "--resident-broker", help="Measure both resident runtimes with the gsm-runtime service example."
    )
    default = (
        ROOT / "src-tauri/target/native-dev/release/examples" / ("rank_hooks.exe" if os.name == "nt" else "rank_hooks")
    )
    parser.add_argument("--native", default=str(default))
    args = parser.parse_args()
    if args.worker:
        python_worker()
        return
    if args.resident_backend:
        resident_backend(args.resident_backend == "python")
        return
    snapshots, blocks = workloads()
    for name, snapshot in snapshots.items():
        request = {"snapshot": snapshot, "blocks": blocks, "language": "ja", "settings": {}}
        if name == "busy_screen":
            request["blocks"] = [f"第{i}話『{blocks[i % len(blocks)]}』" for i in range(48)]
        if name == "custom_regex":
            request["settings"] = {
                "string_replacement": {
                    "enabled": True,
                    "rules": [{"mode": "regex", "find": r"^\[\d+\] ", "replace": "", "case_sensitive": True}],
                }
            }
        with ExitStack() as stack:
            profile = Path(stack.enter_context(TemporaryDirectory()))
            request["profile"] = str(profile)
            # Exercise the normal native settings read, including unrelated profile data.
            config = {"general": {"target_language": request["language"]}, "text_processing": request["settings"]}
            (profile / "config.json").write_text(
                json.dumps(
                    {
                        "current_profile": "Active",
                        "configs": {"Active": config, "Other": {"unused": "x" * 220_000}},
                    }
                ),
                encoding="utf-8",
            )
            if args.resident_broker:
                samples = {"python": [], "rust": []}
                expected = None
                for order in [("python", "rust"), ("rust", "python"), ("python", "rust")]:
                    for engine in order:
                        result, memory = resident_memory(args.resident_broker, args.native, request, engine)
                        if expected is not None and expected != result:
                            raise AssertionError(f"Different resident results for {name}")
                        expected = result
                        samples[engine].append(memory)
                print(
                    json.dumps(
                        {
                            "workload": name,
                            "resident_mib": {
                                engine: {key: round(statistics.median(s[key] for s in runs), 2) for key in runs[0]}
                                for engine, runs in samples.items()
                            },
                        }
                    ),
                    flush=True,
                )
                continue
            workers = [
                Worker(stack, cmd, request)
                for cmd in (
                    [sys.executable, __file__, "--worker"],
                    [args.native],
                )
            ]
            initial = [worker.process.memory_info().rss for worker in workers]
            if json.loads(workers[0].ask(0)) != json.loads(workers[1].ask(0)):
                raise AssertionError(f"Different results for {name}")
            timings = [[], []]
            # Calibrate each window to exceed the OS CPU timer's resolution.
            counts = [max(1, round(450 / max(worker.measure(4)[0], 0.01))) for worker in workers]
            for order in [(0, 1), (1, 0), (0, 1), (1, 0), (0, 1)]:
                for i in order:
                    timings[i].append(workers[i].measure(counts[i]))
            for i, worker in enumerate(workers):
                wall, cpu = map(statistics.median, zip(*timings[i]))
                mem = worker.process.memory_info()
                print(
                    json.dumps(
                        {
                            "workload": name,
                            "engine": ["python", "rust"][i],
                            "batches_per_round": counts[i],
                            "wall_ms": round(wall, 4),
                            "cpu_ms": round(cpu, 4),
                            "ready_rss_mib": round(initial[i] / 2**20, 2),
                            "final_rss_mib": round(mem.rss / 2**20, 2),
                            "peak_rss_mib": round(mem.peak_wset / 2**20, 2) if hasattr(mem, "peak_wset") else None,
                        }
                    ),
                    flush=True,
                )


if __name__ == "__main__":
    main()
