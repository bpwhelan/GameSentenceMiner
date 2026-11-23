"""Measure web module startup in fresh standalone and managed GSM processes."""

import argparse
import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import psutil
from benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module


def worker(directory, mode):
    _configure_bootstrap_environment(directory)
    _install_noop_logging_module()
    os.environ["GSM_PROFILE_DIR"] = str(directory)
    os.environ.pop("GSM_PYTHONLESS", None)
    os.environ["GSM_NATIVE_GAME_SESSION"] = "1" if mode == "desktop" else "0"
    os.chdir(directory)
    process = psutil.Process()
    initial = process.memory_info().rss
    start = time.perf_counter()
    cpu = time.process_time()
    from GameSentenceMiner.web.texthooking_page import app

    result = {
        "wall_ms": (time.perf_counter() - start) * 1000,
        "cpu_ms": (time.process_time() - cpu) * 1000,
        "working_set_growth_mib": (process.memory_info().rss - initial) / 1024**2,
    }
    routes = {r.rule for r in app.url_map.iter_rules() if r.endpoint.startswith("flasgger.")}
    assert any(r.rule == "/clear_history" and "POST" in r.methods for r in app.url_map.iter_rules()) == (
        mode == "standalone"
    )
    if mode == "desktop":
        assert not routes and "flasgger" not in sys.modules
    else:
        assert {"/api/docs", "/apispec.json", "/oauth2-redirect.html", "/apidocs/index.html"} <= routes
    print(json.dumps(result))


def measure(rounds):
    samples = {"desktop": [], "standalone": []}
    with tempfile.TemporaryDirectory(prefix="gsm-api-docs-") as root:
        for index in range(rounds + 1):
            for mode in samples if index % 2 == 0 else reversed(samples):
                directory = Path(root, f"{mode}-{index}")
                output = subprocess.check_output(
                    [sys.executable, __file__, "--worker", str(directory), mode], text=True
                )
                sample = json.loads(output.splitlines()[-1])
                if index:
                    samples[mode].append(sample)
    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "method": "Fresh checkout interpreter and disposable profile per sample. Time covers importing the production Flask web module with standalone Swagger and legacy history route registration enabled or omitted by the desktop. One warmup per mode, then alternating order. All runs verify route registration and desktop imports.",
        "rounds": rounds,
        "medians": {
            mode: {key: round(statistics.median(row[key] for row in rows), 3) for key in rows[0]}
            for mode, rows in samples.items()
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", nargs=2, metavar=("DIRECTORY", "MODE"))
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.worker:
        worker(Path(args.worker[0]), args.worker[1])
    elif args.rounds > 0:
        result = json.dumps(measure(args.rounds), indent=2)
        print(result)
        if args.output:
            args.output.write_text(result + "\n", encoding="utf-8")
    else:
        parser.error("Round count must be positive")
