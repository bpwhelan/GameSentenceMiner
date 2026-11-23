"""Compare production OCR settings handlers using the same pinned, local graphs."""

import argparse
import json
import os
import shutil
import statistics
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path

from benchmark_stats_web import REPO_ROOT, measure, start_worker


def reference(engine):
    sys.path.insert(0, str(REPO_ROOT))
    if engine == "vocr":
        from GameSentenceMiner.ocr.vita_model_manager import handle_model_request
    else:
        from GameSentenceMiner.ocr.meiki_model_manager import handle_model_request

    print("ready", os.getpid(), flush=True)
    for line in sys.stdin:
        workload, count, _ = json.loads(line)
        payload = {"data": {"model": "small"} if workload == "select" else {}}
        start = time.perf_counter()
        for _ in range(count):
            result = handle_model_request(payload)
        print(json.dumps({"ms": (time.perf_counter() - start) * 1000 / count, "result": result}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--desktop-test", type=Path)
    parser.add_argument("--small-model", type=Path)
    parser.add_argument("--reference", action="store_true")
    parser.add_argument("--engine", choices=["meiki", "vocr"], default="meiki")
    args = parser.parse_args()
    if args.reference:
        return reference(args.engine)
    if not args.desktop_test or (args.engine == "meiki" and not args.small_model):
        parser.error("--desktop-test is required, and Meiki also requires --small-model")
    with tempfile.TemporaryDirectory(prefix="gsm-model-settings-") as temp, ExitStack() as stack:
        workers = {}
        for name in ["Python", "Rust"]:
            base = Path(temp, name)
            if args.engine == "meiki":
                directory = base / "ocr_models"
                directory.mkdir(parents=True)
                shutil.copyfile(args.small_model, directory / "meiki.text.detect.v0.1.320x192.onnx")
            else:
                directory = base / "ocr" / "vita-vn-ocr"
                directory.mkdir(parents=True)
                (directory / "installation.json").write_text('{"model":"large"}', encoding="utf-8")
                (directory / "native-runtime.json").write_text('{"backend":"c"}', encoding="utf-8")
            os.environ.update(
                GSM_DATA_DIR=str(base),
                GSM_TEST_DATA_ROOT=str(base),
                GSM_SHARED_DATA_DIR=str(base),
                GSM_VITA_OCR_DIR=str(directory),
                GSM_BENCH_MODEL_ENGINE=args.engine,
                GSM_VOCR_BACKEND="c",
                GAME_SENTENCE_MINER_TESTING="1",
                HF_HUB_OFFLINE="1",
            )
            command = (
                [sys.executable, __file__, "--reference", "--engine", args.engine]
                if name == "Python"
                else [
                    str(args.desktop_test),
                    "ocr_coordinator::meiki::tests::benchmark",
                    "--exact",
                    "--ignored",
                    "--nocapture",
                ]
            )
            workers[name] = start_worker(stack, command)
        for case, count in [("status", 30 if args.engine == "vocr" else 2000), ("select", 3)]:
            samples = {key: [] for key in workers}
            for i in range(6):
                for name in workers if i % 2 == 0 else reversed(workers):
                    row = measure(workers[name], case, count)
                    expected = "small" if case == "select" else "large"
                    status = {"available": True, "busy": False, "model": expected}
                    if args.engine == "vocr":
                        from GameSentenceMiner.ocr.vita_ocr import RELEASE, UPSTREAM_REVISION

                        status.update(
                            backend="onnx",
                            installed=["normal", "small", "large"],
                            supported=True,
                            release=RELEASE,
                            revision=UPSTREAM_REVISION,
                        )
                    if row["result"] != status:
                        raise RuntimeError(f"{name} {case}: {row['result']}")
                    if i:
                        samples[name].append(row)
            for name, series in samples.items():
                print(
                    case,
                    name,
                    {
                        k: round(statistics.median(row[k] for row in series), 4)
                        for k in ("ms", "cpu_ms", "resident_mib")
                    },
                    flush=True,
                )


if __name__ == "__main__":
    main()
