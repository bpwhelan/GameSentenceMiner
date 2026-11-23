"""Compare the original Python indicator, the extension, and the desktop Rust loader.

Run python -m scripts.benchmark_recycled_lines from the checkout with its release extension.
The benchmark builds the standalone Rust measurement executable with Cargo.
"""

import argparse
import gc
import json
import os
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import types
from contextlib import closing
from pathlib import Path

import psutil

ROWS = 30_000
LIMIT = 10_000
COPIES = 8


def sentence(i):
    return (
        f"「まだ、そこにいるの？　もう少しだけ待っていて。」 第{i}行。"
        if i % 3
        else f"Are you still there? Just a little longer. Line {i}."
    )


def fixture(path):
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute("""CREATE TABLE game_lines (
            id TEXT PRIMARY KEY, game_name TEXT, line_text TEXT, timestamp REAL,
            translation TEXT, screenshot_path TEXT, audio_path TEXT, note_ids TEXT)""")
        conn.execute("CREATE INDEX time_idx ON game_lines(timestamp)")
        conn.executemany(
            "INSERT INTO game_lines VALUES (?, 'Scene', ?, ?, ?, ?, ?, '[]')",
            ((str(i), sentence(i), i, "Translation " * 8, f"images/{i}.png", f"audio/{i}.mp3") for i in range(ROWS)),
        )


def worker(mode, case, path, ref):
    from scripts.benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module

    _configure_bootstrap_environment(path.parent / "bootstrap")
    _install_noop_logging_module()
    os.environ["GSM_NATIVE_TEXT_MODE"] = "native"
    from GameSentenceMiner.util import text_log as log
    from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB

    if mode == "previous":
        old = subprocess.check_output(["git", "show", f"{ref}:GameSentenceMiner/util/text_log.py"])
        log = types.ModuleType("previous_text_log")
        sys.modules[log.__name__] = log
        exec(compile(old, "previous_text_log.py", "exec"), log.__dict__)  # noqa: S102 - benchmark the selected Git revision
    else:
        assert type(log.game_log._previous_lines).__module__ == "GameSentenceMiner._native"

    db = SQLiteDB(str(path), read_only=True)
    GameLinesTable.set_db(db)
    # Warm the config, row schema and SQLite's connection before either baseline.
    GameLinesTable.get_all_lines_for_scene("Scene", limit=1)
    probes = [sentence(ROWS - 1 - i) if i % 2 else sentence(ROWS + i) for i in range(512)]
    gc.collect()
    print(os.getpid(), flush=True)
    input()
    start = time.perf_counter()
    keep = []
    for _ in range(COPIES if case == "cache" else 1):
        index = log.GameText()
        limit = LIMIT if case == "scene" else None
        if case == "cache":
            lines = (sentence(i) for i in range(ROWS - LIMIT, ROWS))
        elif mode == "previous":
            rows = GameLinesTable.get_all_lines_for_scene("Scene", limit=limit)
            lines = (row.line_text for row in rows)
        else:
            lines = GameLinesTable.iter_recycled_line_texts("Scene", limit=limit)
        if mode == "previous":
            index.replace_previous_lines(log.normalize_text_for_comparison(line) for line in lines)
            if case != "cache":
                del rows
        else:
            index.replace_previous_lines(lines)
        keep.append(index)
    load_ms = (time.perf_counter() - start) * 1000
    log.game_log = keep[-1]
    count = len(log.game_log.previous_lines) if mode == "previous" else log.game_log.previous_line_count
    assert count == LIMIT
    assert [log.is_line_recycled(p) for p in probes] == [bool(i % 2) for i in range(len(probes))]
    timings = []
    for _ in range(5):
        start = time.perf_counter_ns()
        for _ in range(16):
            for probe in probes:
                log.is_line_recycled(probe)
        timings.append((time.perf_counter_ns() - start) / (16 * len(probes)) / 1000)
    print(json.dumps({"load_ms": load_ms, "lookup_us": statistics.median(timings)}), flush=True)
    input()
    db.close()


def sample(mode, case, path, ref, desktop_worker=None):
    cmd = [sys.executable, "-m", "scripts.benchmark_recycled_lines", "--worker", mode, case, str(path), "--ref", ref]
    if mode == "desktop":
        cmd = [str(desktop_worker), str(path), "Scene", "recent" if case == "scene" else "full"]
    with subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as proc:
        try:
            # Windows virtual environments may launch the interpreter through a redirector.
            if mode == "desktop":
                probes = [sentence(ROWS - 1 - i) if i % 2 else sentence(ROWS + i) for i in range(512)]
                proc.stdin.write(json.dumps(probes) + "\n")
                proc.stdin.flush()
            process = psutil.Process(int(proc.stdout.readline()))

            def memory():
                if sys.platform == "win32":
                    return process.memory_info().private
                return process.memory_full_info().uss

            base = peak = memory()
            stop = threading.Event()

            def monitor():
                nonlocal peak
                while not stop.wait(0.002):
                    peak = max(peak, memory())

            monitor_thread = threading.Thread(target=monitor)
            monitor_thread.start()
            try:
                proc.stdin.write("\n")
                proc.stdin.flush()
                result = json.loads(proc.stdout.readline())
                if mode == "desktop":
                    assert result.pop("count") == LIMIT
                    assert result.pop("hits") == [bool(i % 2) for i in range(len(probes))]
                retained = memory()
            finally:
                stop.set()
                monitor_thread.join()
            result["peak_delta_mib"] = (max(peak, retained) - base) / 2**20
            result["retained_delta_mib"] = (retained - base) / 2**20
            proc.communicate("\n", timeout=15)
            assert proc.returncode == 0
            return result
        finally:
            if proc.poll() is None:
                proc.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="4fea8c90")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--worker", nargs=3, metavar=("MODE", "CASE", "DATABASE"))
    args = parser.parse_args()
    if args.worker:
        mode, case, path = args.worker
        return worker(mode, case, Path(path), args.ref)
    manifest = "native/gsm-history/Cargo.toml"
    subprocess.run(
        ["cargo", "build", "--locked", "--release", "--manifest-path", manifest, "--example", "recycled_lines"],
        check=True,
    )
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest]
        )
    )
    desktop_worker = (
        Path(metadata["target_directory"])
        / "release/examples"
        / ("recycled_lines.exe" if sys.platform == "win32" else "recycled_lines")
    )
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / "history.db"
        fixture(path)
        for case in ("scene", "toggle", "cache"):
            samples = {"previous": [], "native": []}
            if case != "cache":
                samples["desktop"] = []
            for i in range(args.rounds):
                for mode in reversed(samples) if i % 2 else samples:
                    samples[mode].append(sample(mode, case, path, args.ref, desktop_worker))
            for mode, runs in samples.items():
                print(case, mode, {k: round(statistics.median(r[k] for r in runs), 3) for k in runs[0]}, flush=True)


if __name__ == "__main__":
    main()
