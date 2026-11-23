"""Compare Windows Snipping Tool discovery, installation, and reuse in isolated profiles."""

import argparse
import json
import os
import platform
import shutil
import statistics
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path

from benchmark_ffmpeg_bootstrap import digest
from benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module
from benchmark_stats_web import measure, start_worker


def reference(root):
    _configure_bootstrap_environment(root)
    _install_noop_logging_module()
    from GameSentenceMiner.util.downloader.oneocr_dl import Downloader, checkdir

    print(f"ready {os.getpid()}", flush=True)
    for line in sys.stdin:
        directory, count, _ = json.loads(line)
        os.environ["USERPROFILE"] = str(Path(directory).parent.parent)
        started = time.perf_counter()
        for _ in range(count):
            downloader = Downloader()
            assert Path(downloader.oneocr_dir) == Path(directory)
            installed = not checkdir(directory)
            if installed and not downloader._copy_files_if_needed():
                raise RuntimeError("The benchmark requires an installed Microsoft Snipping Tool with OneOCR")
        print(json.dumps({"installed": installed, "ms": (time.perf_counter() - started) * 1000 / count}), flush=True)


def benchmark(temp, rust_test, rounds):
    results = {}
    with ExitStack() as stack:
        workers = {
            "python": start_worker(stack, [sys.executable, __file__, "--worker", str(temp / "bootstrap")]),
            "rust": start_worker(
                stack,
                [
                    str(rust_test.resolve()),
                    "--exact",
                    "models::oneocr::tests::benchmark_worker",
                    "--ignored",
                    "--nocapture",
                ],
            ),
        }
        for operation, count in (("system_install", 1), ("reopen", 100)):
            samples = {name: [] for name in workers}
            for i in range(rounds):
                digests = []
                for name in workers if i % 2 == 0 else reversed(workers):
                    directory = temp / name / ".config" / "oneocr"
                    if operation == "system_install" and directory.exists():
                        shutil.rmtree(directory)
                    result = measure(workers[name], str(directory), count)
                    assert result.pop("installed") == (operation == "system_install")
                    if operation == "system_install":
                        digests.append(
                            [digest(directory / f) for f in ("oneocr.dll", "oneocr.onemodel", "onnxruntime.dll")]
                        )
                    samples[name].append(result)
                if digests:
                    assert digests[0] == digests[1]
            results[operation] = {
                name: {key: round(statistics.median(row[key] for row in rows), 3) for key in rows[0]}
                for name, rows in samples.items()
            }
    return {"platform": platform.platform(), "rounds": rounds, "medians": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--rust-test", type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.worker:
        reference(args.worker)
    else:
        if not args.rust_test or args.rounds < 1:
            parser.error("Supply the gsm-overlay test executable and a positive round count")
        with tempfile.TemporaryDirectory(prefix="gsm-oneocr-bench-") as folder:
            report = json.dumps(benchmark(Path(folder), args.rust_test, args.rounds), indent=2)
            print(report)
            if args.output:
                args.output.write_text(report + "\n", encoding="utf-8")
