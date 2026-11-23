"""Compare the desktop FFmpeg installers using the pinned Windows release ZIPs."""

import argparse
import hashlib
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

from benchmark_stats import REPO_ROOT, _configure_bootstrap_environment, _install_noop_logging_module
from benchmark_stats_web import measure, start_worker


def python_worker(root):
    _configure_bootstrap_environment(root)
    _install_noop_logging_module()
    from GameSentenceMiner.util.downloader import download_tools

    def unexpected_download(*args, **kwargs):
        raise RuntimeError("The existing pinned FFmpeg fixture failed the Python version check")

    download_tools.download_file = unexpected_download
    print(f"ready {os.getpid()}", flush=True)
    for line in sys.stdin:
        (shared, archive, arch), count, _ = json.loads(line)
        os.environ["GSM_SHARED_DATA_DIR"] = shared
        target = Path(shared) / "ffmpeg"
        start = time.perf_counter()
        for _ in range(count):
            if target.is_dir():
                assert download_tools.download_ffmpeg_if_needed() == "skipped"
                installed = False
            else:
                download_tools.install_ffmpeg_archive(archive, str(target), {"compressed_format": "zip"})
                installed = True
        print(json.dumps({"installed": installed, "ms": (time.perf_counter() - start) * 1000 / count}), flush=True)


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def benchmark(root, args):
    with ExitStack() as stack:
        workers = {
            "python": start_worker(stack, [sys.executable, __file__, "--worker", str(root / "bootstrap")]),
            "rust": start_worker(
                stack,
                [
                    str(args.rust_test.resolve()),
                    "--exact",
                    "ffmpeg::tests::benchmark_worker",
                    "--ignored",
                    "--nocapture",
                ],
            ),
        }
        results = {}
        for arch, archive in (("x64", args.x64), ("arm64", args.arm64)):
            if not archive:
                continue
            archive = archive.resolve()
            manifest = REPO_ROOT / f"native/gsm-packages/assets/ffmpeg/{arch}.sha256"
            expected = {name: sha for sha, _, name in (line.split() for line in manifest.read_text().splitlines())}
            native_arch = "arm64" if platform.machine().lower() in ("aarch64", "arm64") else "x64"
            workloads = [("install", 1)]
            if arch == native_arch:
                workloads.extend([("adopt", 1), ("reopen", 20)])
            for operation, count in workloads:
                samples = {name: [] for name in workers}
                for i in range(args.rounds):
                    for name in workers if i % 2 == 0 else reversed(workers):
                        shared = root / arch / name
                        shared.mkdir(parents=True, exist_ok=True)
                        if operation == "install":
                            if (shared / "ffmpeg").is_dir():
                                shutil.rmtree(shared / "ffmpeg")
                        if operation != "reopen":
                            (shared / "ffmpeg-bundle.json").unlink(missing_ok=True)
                        result = measure(workers[name], [str(shared), str(archive), arch], count)
                        assert result.pop("installed") == (operation == "install")
                        if operation == "install":
                            assert {p.name: digest(p) for p in (shared / "ffmpeg").iterdir()} == expected
                        samples[name].append(result)
                results[f"{arch}_{operation}"] = {
                    name: {k: round(statistics.median(s[k] for s in rows), 3) for k in rows[0]}
                    for name, rows in samples.items()
                }
        return {"platform": platform.platform(), "rounds": args.rounds, "medians": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rust-test", type=Path)
    parser.add_argument("--x64", type=Path)
    parser.add_argument("--arm64", type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--worker", type=Path)
    args = parser.parse_args()
    if args.worker:
        python_worker(args.worker)
    else:
        if not args.rust_test or not (args.x64 or args.arm64) or args.rounds < 1:
            parser.error("Supply a gsm-packages test executable, release ZIP and positive round count")
        with tempfile.TemporaryDirectory(prefix="gsm-ffmpeg-bench-") as temp:
            report = json.dumps(benchmark(Path(temp), args), indent=2)
            print(report)
            if args.output:
                args.output.write_text(report + "\n", encoding="utf-8")
