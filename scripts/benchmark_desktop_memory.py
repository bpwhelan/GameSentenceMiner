"""Measure the native desktop's full process tree with an isolated 1,000-line profile.

Run with .venv/Scripts/python.exe scripts/benchmark_desktop_memory.py --output <json>.
USS avoids double-counting shared Chromium pages. Private committed bytes are
reported separately so paging alone cannot masquerade as released allocations.
The fixture excludes Python, OBS, real games, OCR models and imported dictionaries.
Use --pid to sample an existing full application without changing its state.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parents[1]


def snapshot(pid: int) -> dict:
    parent = psutil.Process(pid)
    rows = []
    for process in [parent, *parent.children(recursive=True)]:
        try:
            memory = process.memory_full_info()
            kind = next((arg for arg in process.cmdline() if arg.startswith("--type=")), "")
            rows.append(
                {
                    "pid": process.pid,
                    "parent_pid": process.ppid(),
                    "name": process.name(),
                    "kind": kind,
                    "rss_mib": memory.rss / 2**20,
                    "uss_mib": getattr(memory, "uss", 0) / 2**20,
                    "private_mib": getattr(memory, "private", 0) / 2**20,
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return {
        "processes": rows,
        "totals": {key: sum(row[key] for row in rows) for key in ("rss_mib", "uss_mib", "private_mib")},
    }


def sample(pid: int) -> dict:
    samples = []
    for _ in range(5):
        samples.append(snapshot(pid))
        time.sleep(0.25)
    return {
        "median": {key: round(statistics.median(s["totals"][key] for s in samples), 2) for key in samples[0]["totals"]},
        "samples": samples,
    }


def benchmark(executable: Path, settle: float) -> dict:
    profile = Path(tempfile.mkdtemp(prefix="gsm-memory-"))
    result = profile / "result.json"
    env = {
        **os.environ,
        "GSM_APP_ROOT": str(ROOT),
        "GSM_PROFILE_DIR": str(profile),
        "GSM_SMOKE_TEST": "1",
        "GSM_SMOKE_SUITE": "memory",
        "GSM_TEST_RESULT": str(result),
        "GSM_MEMORY_CHECKPOINT_DIR": str(profile),
    }
    # Do not inherit unrelated fixture selections from other native tests.
    for key in ("GSM_SMOKE_DICTIONARY", "GSM_LEGACY_FIXTURE", "GSM_FIXTURE_RESULT"):
        env.pop(key, None)
    checkpoints = {}
    with (profile / "desktop.log").open("w", encoding="utf-8") as log:
        child = subprocess.Popen(
            [str(executable)],
            cwd=ROOT,
            env=env,
            stdout=log,
            stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            for name in ("home-visible", "home-hidden", "overlay-warm", "overlay-disabled", "reopened"):
                ready = profile / f"{name}.ready.json"
                deadline = time.monotonic() + 120
                while not ready.exists():
                    if child.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError(f"Memory fixture stopped at {name}; see {profile / 'desktop.log'}")
                    time.sleep(0.1)
                time.sleep(settle)
                checkpoints[name] = {"fixture": json.loads(ready.read_text(encoding="utf-8")), **sample(child.pid)}
                print(f"{name}: {checkpoints[name]['median']}", flush=True)
                (profile / f"{name}.continue").touch()
            code = child.wait(timeout=30)
            outcome = json.loads(result.read_text(encoding="utf-8"))
            if code or outcome["code"]:
                raise RuntimeError(f"Memory fixture failed: {outcome}")
        finally:
            if child.poll() is None:
                # Only the isolated process launched above; its Windows job owns its children.
                child.terminate()
                child.wait(timeout=15)
    return {
        "profile": str(profile),
        "executable": str(executable),
        "settle_seconds": settle,
        "checkpoints": checkpoints,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--executable", type=Path)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--settle", type=float, default=12)
    args = parser.parse_args()
    if args.pid:
        report = sample(args.pid)
    else:
        executable = args.executable
        if executable is None:
            host = {"Windows": "win32", "Darwin": "darwin", "Linux": "linux"}[platform.system()]
            arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
            pointer = ROOT / "src-tauri/target/desktop-runs" / f"{host}-{arch}.json"
            executable = Path(json.loads(pointer.read_text(encoding="utf-8"))["executable"])
        report = benchmark(executable.resolve(), max(0, args.settle))
    report["platform"] = platform.platform()
    report["measured_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
