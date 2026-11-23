"""Compare the offscreen Anki chooser through the real Qt worker and native desktop entry points."""

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import psutil
from benchmark_qt_dialog import ROOT, write_fixture


def run(executable, app_root, mode):
    with tempfile.TemporaryDirectory(prefix="gsm-grouping-") as temp:
        directory = Path(temp)
        result = directory / "result.json"
        env = {
            **os.environ,
            "GSM_APP_ROOT": str(app_root),
            "GSM_PROFILE_DIR": temp,
            "GSM_SHARED_DATA_DIR": temp,
            "GSM_DATA_DIR": temp,
            "GSM_SMOKE_TEST": "1",
            "GSM_TEST_RESULT": str(result),
        }
        if mode == "Qt":
            write_fixture(directory)
            env.update(
                GSM_SMOKE_SUITE="qt-dialog",
                GSM_SMOKE_ANKI_GROUPING="1",
                GSM_QT_FIXTURE_MODE="standalone",
                GSM_TEST_QT_PYTHON=sys.executable,
                QT_QPA_PLATFORM="offscreen",
            )
        else:
            env.update(GSM_SMOKE_SUITE="anki-grouping", PATH=os.environ.get("SystemRoot", "C:/Windows") + "/System32")
        cpu = {}
        peak_private = 0
        with (
            tempfile.TemporaryFile() as logs,
            subprocess.Popen([executable], cwd=ROOT, env=env, stdout=logs, stderr=logs) as proc,
        ):
            host = psutil.Process(proc.pid)
            deadline = time.monotonic() + 65
            try:
                while proc.poll() is None and time.monotonic() < deadline:
                    private = 0
                    for child in [host, *host.children(recursive=True)]:
                        try:
                            with child.oneshot():
                                times = child.cpu_times()
                                cpu[child.pid] = times.user + times.system
                                memory = child.memory_info()
                                private += getattr(memory, "private", memory.rss)
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass
                    peak_private = max(peak_private, private)
                    time.sleep(0.025)
            finally:
                if proc.poll() is None:
                    proc.kill()
            if proc.wait() or not result.is_file():
                logs.seek(0)
                raise RuntimeError(
                    result.read_text() if result.exists() else logs.read().decode(errors="replace")[-2500:]
                )
        report = json.loads(result.read_text(encoding="utf-8"))
        if report.get("code") != 0:
            raise RuntimeError(report)
        return [report["detail"]["elapsed_ms"], 1000 * sum(cpu.values()), peak_private / 2**20]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--desktop", required=True, type=Path)
    parser.add_argument("--app-root", required=True, type=Path, help="Isolated desktop assets with dist/renderer")
    parser.add_argument("--rounds", type=int, default=5)
    args = parser.parse_args()
    results = {"Qt": [], "Rust": []}
    for i in range(args.rounds):
        for mode in results if i % 2 == 0 else reversed(results):
            results[mode].append(run(args.desktop.resolve(), args.app_root.resolve(), mode))
    for mode, rows in results.items():
        print(
            mode, dict(zip(("dialog_ms", "tree_cpu_ms", "peak_tree_private_mib"), map(statistics.median, zip(*rows))))
        )


if __name__ == "__main__":
    main()
