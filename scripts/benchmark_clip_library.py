"""Measure the saved-clip catalogue and the folder resolution used by open and trash."""

import argparse
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

from benchmark_stats import (
    REPO_ROOT,
    _configure_bootstrap_environment,
    _install_keyboard_stub,
    _install_noop_logging_module,
)
from benchmark_stats_web import measure, start_worker


def reference(directory):
    _configure_bootstrap_environment(directory / "bootstrap")
    _install_keyboard_stub()
    _install_noop_logging_module()
    from GameSentenceMiner.util import clips
    from GameSentenceMiner.web import clips_api

    root = str(directory / "Clips")
    clips.get_clips_root = lambda: root
    ids = json.loads((directory / "ids.json").read_bytes())
    print(f"ready {os.getpid()}", flush=True)
    for line in sys.stdin:
        case, calls, verify = json.loads(line)
        start = time.perf_counter()
        for _ in range(calls):
            if case == "catalog":
                result = {"clips": [clips_api._summary(c, root) for c in reversed(list(clips.iter_clips(root)))]}
            else:
                result = sum(clips_api._resolve(id_) is not None for id_ in ids)
            data = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf8")
        ms = (time.perf_counter() - start) * 1000 / calls
        if verify:
            (directory / "python-output.json").write_bytes(data)
        print(json.dumps({"ms": ms, "bytes": len(data)}), flush=True)


def fixture(directory, count):
    directory.mkdir()
    ids = []
    for i in range(count):
        id_ = f"2026-11-{i % 20 + 1:02}/{i:04}_保存"
        ids.append(id_)
        folder = directory / "Clips" / id_
        folder.mkdir(parents=True)
        lines = [
            {
                "id": f"{i}-{j}",
                "text": f"台詞 {i} その{j}",
                "time": f"2026-11-01T12:00:0{j}",
                "role": ["previous", "previous", "selected", "next", "next"][j],
            }
            for j in range(5)
        ]
        (folder / "manifest.json").write_text(
            json.dumps(
                {"clip": {"file": "clip.mkv", "end_time": "2026-11-01T12:00:06"}, "lines": lines}, ensure_ascii=False
            ),
            encoding="utf8",
        )
        if i % 9:
            (folder / "clip.mkv").write_bytes(b"fixture")
    (directory / "ids.json").write_text(json.dumps(ids + ["missing", "../example"]), encoding="utf8")


def run(root, rounds):
    exe = REPO_ROOT / "src-tauri/target/native-dev/release/examples/clip_library_benchmark"
    if os.name == "nt":
        exe = exe.with_suffix(".exe")
    report = {
        "platform": platform.platform(),
        "rounds": rounds,
        "worker_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
        "workloads": {},
    }
    for size in (32, 512):
        directory = root / str(size)
        fixture(directory, size)
        for case in ("catalog", "resolve"):
            calls = 15 if size == 32 else 3
            samples = {"rust": [], "python": []}
            with ExitStack() as stack:
                workers = {
                    "rust": start_worker(stack, [str(exe), str(directory)]),
                    "python": start_worker(stack, [sys.executable, __file__, "--reference", str(directory)]),
                }
                for worker in workers.values():
                    measure(worker, case, 1, verify=True)
                result = json.loads((directory / "rust-output.json").read_bytes())
                assert result == json.loads((directory / "python-output.json").read_bytes())
                assert (len(result["clips"]) if case == "catalog" else result) == size
                for i in range(rounds):
                    for lang in workers if i % 2 == 0 else reversed(workers):
                        samples[lang].append(measure(workers[lang], case, calls))
            summary = {
                lang: {k: round(statistics.median(row[k] for row in rows), 4) for k in ("ms", "cpu_ms", "resident_mib")}
                for lang, rows in samples.items()
            }
            report["workloads"][f"{case}_{size}"] = {**summary, "samples": samples, "calls": calls}
            print(case, size, summary, flush=True)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.reference:
        reference(args.reference)
    else:
        with tempfile.TemporaryDirectory() as temp:
            results = run(Path(temp), args.rounds)
        if args.output:
            args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf8")
