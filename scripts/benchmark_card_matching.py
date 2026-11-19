"""Compare complete Anki history lookups in fresh Python backend processes."""

import argparse
import ast
import gc
import json
import os
import statistics
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
CASES = {
    "single": (1, 12000),
    "live": (64, 1400),
    "overlay": (256, 500),
    "saved": (2048, 75),
    "overlapping_clips": (2048, 40),
    "expired": (10000, 900),
}


def workload(name, text_log):
    count, _ = CASES[name]
    now = datetime.now(UTC).astimezone().replace(tzinfo=None)
    old = now - timedelta(days=3)
    target = "あの図書館で明日の放課後に待っている。"
    other = ["夕飯までには戻るつもりだ。", "新しい地図を手に入れた！", "ここからは一人でも大丈夫だよ。"]
    lines = []
    for i in range(count):
        stamp = old if name in ("saved", "overlapping_clips") or (name == "expired" and i % 997) else now
        line = other[i % len(other)] + str(i)
        lines.append(text_log.GameLine(str(i), line, stamp, None, None))
    match = count - 1 if name != "expired" else 997
    lines[match].text = target
    if name == "overlapping_clips":
        for i, line in enumerate(lines):
            line.id = str(i % 128)
            line.text = target if i % 3 else other[0]
    sentence = target.replace("図書館", "<b>図書館</b>")
    if name == "overlay":
        sentence = other[0] + sentence + other[2]
        lines[-2].text = other[2]
    fields = {"Sentence": sentence, "Expression": "図書館"}
    card = SimpleNamespace(get_field=fields.get)

    def run():
        return text_log.find_matching_line(
            card,
            lines,
            prefer_recent=name == "overlay",
            respect_replay_window=name not in ("saved", "overlapping_clips"),
            minimum_score=80 if name in ("saved", "overlapping_clips") else 0,
        )

    return run, lines[match]


def worker(mode, name, reference, preload_rapidfuzz):
    from scripts.benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module

    with TemporaryDirectory() as profile:
        _configure_bootstrap_environment(Path(profile))
        _install_noop_logging_module()
        os.environ["GSM_NATIVE_TEXT_MODE"] = mode
        from GameSentenceMiner.native import ocr
        from GameSentenceMiner.util import text_log

        if not hasattr(ocr._extension, "rank_card_lines"):
            raise RuntimeError("Rebuild the GSM native extension before benchmarking")
        text_log.get_config = lambda: SimpleNamespace(
            anki=SimpleNamespace(sentence_field="Sentence", word_field="Expression")
        )
        text_log.gsm_state.replay_buffer_length = 300
        if preload_rapidfuzz or mode == "python":
            import rapidfuzz
        if reference:
            namespace = vars(text_log).copy()
            if mode == "python":
                namespace["rapidfuzz"] = rapidfuzz
            # The parent reads the original matcher and scorer helpers from local Git.
            exec(compile(reference, "<baseline text_log.py>", "exec"), namespace)  # noqa: S102
            if mode == "python":
                text_log.find_matching_line = namespace["find_matching_line"]
        run, expected = workload(name, text_log)
        process = psutil.Process()
        gc.collect()
        before = process.memory_full_info()
        assert run() is expected
        gc.collect()
        iterations = CASES[name][1]
        wall, cpu = time.perf_counter_ns(), time.process_time_ns()
        for _ in range(iterations):
            assert run() is expected
        cpu = (time.process_time_ns() - cpu) / iterations / 1e6
        wall = (time.perf_counter_ns() - wall) / iterations / 1e6
        memory = process.memory_full_info()
        print(
            json.dumps(
                {
                    "wall_ms": wall,
                    "cpu_ms": cpu,
                    "uss_mib": memory.uss / 2**20,
                    "uss_growth_kib": (memory.uss - before.uss) / 1024,
                    **({"peak_rss_mib": memory.peak_wset / 2**20} if hasattr(memory, "peak_wset") else {}),
                }
            )
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", choices=("python", "native"), help=argparse.SUPPRESS)
    parser.add_argument("--case", choices=CASES)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--reference-ref", help="Compare against the original find_matching_line at this Git revision.")
    parser.add_argument("--preload-rapidfuzz", action="store_true", help="Keep Python RapidFuzz resident in both runs.")
    args = parser.parse_args()
    if args.worker:
        worker(args.worker, args.case, sys.stdin.read() if args.reference_ref else None, args.preload_rapidfuzz)
        return
    reference = None
    if args.reference_ref:
        src = subprocess.check_output(
            ["git", "show", f"{args.reference_ref}:GameSentenceMiner/util/text_log.py"], cwd=ROOT, encoding="utf-8"
        )
        names = {"lines_match", "_match_score", "_highlight_context_score", "find_matching_line"}
        functions = [n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name in names]
        if len(functions) != len(names):
            raise ValueError("The selected revision does not contain the original Anki matching functions")
        reference = "\n\n".join(ast.get_source_segment(src, n) for n in functions)
    for name in [args.case] if args.case else CASES:
        results = {"python": [], "native": []}
        for round_number in range(args.rounds):
            order = ("native", "python") if round_number % 2 else ("python", "native")
            for mode in order:
                args_worker = [sys.executable, __file__, "--worker", mode, "--case", name]
                if reference:
                    args_worker.extend(["--reference-ref", args.reference_ref])
                if args.preload_rapidfuzz:
                    args_worker.append("--preload-rapidfuzz")
                raw = subprocess.check_output(
                    args_worker, input=reference, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"}
                )
                results[mode].append(json.loads(raw.strip().splitlines()[-1]))
        print(
            json.dumps(
                {
                    "case": name,
                    **{
                        mode: {key: round(statistics.median(row[key] for row in rows), 4) for key in rows[0]}
                        for mode, rows in results.items()
                    },
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
