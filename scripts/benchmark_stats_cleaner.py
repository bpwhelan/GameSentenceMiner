"""Check native report text against the production Python cleaner and time the same work."""

import argparse
import json
import os
import platform
import statistics
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path

from benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module
from benchmark_stats_web import measure, start_worker


def python_worker(root):
    _configure_bootstrap_environment(root)
    _install_noop_logging_module()
    from GameSentenceMiner.util.database.db import clean_text_for_stats

    print(f"ready {os.getpid()}", flush=True)
    for line in sys.stdin:
        (pattern, repeat, lines), count, verify = json.loads(line)
        start = time.perf_counter()
        for _ in range(count):
            for text in lines:
                len(clean_text_for_stats(text, repeat, pattern))
        ms = (time.perf_counter() - start) * 1000 / count
        outputs = [clean_text_for_stats(v, repeat, pattern) for v in lines] if verify else []
        print(json.dumps({"ms": ms, "outputs": outputs}), flush=True)


def run(args):
    corpus = [
        "",
        "\x1d文字字。犬犬犬犬！\x1f",
        "【名前】今日は犬と犬犬猫猫猫猫猫を見た。",
        "a\nb。犬",
        "字文文字文",
        "【名前】" + "日本語を読む。" * 50,
    ]
    medians = {}
    with tempfile.TemporaryDirectory() as root, ExitStack() as stack:
        workers = {
            "python": start_worker(stack, [sys.executable, __file__, "--worker", root]),
            "rust": start_worker(
                stack,
                [args.rust_test, "--ignored", "--exact", "sessions::cleaner_tests::benchmark_worker", "--nocapture"],
            ),
        }
        for pattern, repeat in [
            ("", False),
            ("【.*?】", False),
            ("(?<=。)犬", True),
            ("字(?=文)", False),
            (r"(猫|犬)\1", True),
        ]:
            request = [pattern, repeat, corpus]
            golden = [measure(worker, request, 1, verify=True)["outputs"] for worker in workers.values()]
            assert golden[0] == golden[1], (request, golden)
            samples = {name: [] for name in workers}
            for i in range(args.rounds):
                for name in workers if i % 2 == 0 else reversed(workers):
                    row = measure(workers[name], request, 500)
                    row.pop("outputs")
                    samples[name].append(row)
            medians[pattern or "(default)"] = {
                name: {k: round(statistics.median(r[k] for r in rows), 5) for k in rows[0]}
                for name, rows in samples.items()
            }
    return {
        "platform": platform.platform(),
        "rounds": args.rounds,
        "method": "Warm workers. Milliseconds per six-line corpus, 500 iterations per round. Includes Unicode character counting. Replacement output checked against Python. Lifetime peak working set on Windows; imports and regex compilation excluded.",
        "medians": medians,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--rust-test", type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.worker:
        python_worker(args.worker)
    elif args.rust_test and args.rounds > 0:
        result = json.dumps(run(args), indent=2, ensure_ascii=False)
        print(result)
        if args.output:
            args.output.write_text(result + "\n", encoding="utf-8")
    else:
        parser.error("A release gsm-history unit test executable and positive round count are required")
