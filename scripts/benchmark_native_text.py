"""Benchmark the Rust text migrations, including Python boundary overhead.

Uses deterministic synthetic workloads and asserts exact output equality before
timing. Configuration is isolated under .tmp_test_env; no user database is read.
Run with the repo's .venv Python after rebuilding the native extension.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import platform
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _reference_function(module, name, revision):
    relative_path = Path(module.__file__).resolve().relative_to(ROOT).as_posix()
    source = subprocess.check_output(["git", "show", f"{revision}:{relative_path}"], cwd=ROOT)
    tree = ast.parse(source)
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    namespace = dict(vars(module))
    exec(compile(ast.Module(body=[function], type_ignores=[]), relative_path, "exec"), namespace)  # noqa: S102 - local git reference
    return namespace[name]


def measure(before, after, *, rounds, loops):
    expected, actual = before(), after()
    assert actual == expected, "Python and Rust outputs differ"
    samples = [[], []]
    for round_index in range(rounds):
        for index in (0, 1) if round_index % 2 else (1, 0):
            function = (before, after)[index]
            started = time.perf_counter_ns()
            for _ in range(loops):
                function()
            samples[index].append((time.perf_counter_ns() - started) / (loops * 1_000_000))
    medians = [statistics.median(values) for values in samples]
    return {
        "python_ms": medians[0],
        "native_ms": medians[1],
        "speedup": medians[0] / medians[1],
        "python_rounds_ms": samples[0],
        "native_rounds_ms": samples[1],
    }


def benchmark(args):
    from scripts.benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module

    _configure_bootstrap_environment(ROOT / ".tmp_test_env" / "native_text_benchmark")
    _install_noop_logging_module()
    os.environ["GSM_NATIVE_TEXT_MODE"] = "native"

    from GameSentenceMiner.native import ocr
    from GameSentenceMiner.native import text as native_text
    from GameSentenceMiner.ocr import compare
    from GameSentenceMiner.util import text_processing
    from GameSentenceMiner.web import stats

    for name in (
        "sequence_ratio",
        "matching_block_stats",
        "remove_repeated_chars",
        "remove_repeated_lines",
        "count_kanji",
    ):
        if not hasattr(ocr._extension, name):
            raise RuntimeError(f"Rebuild GameSentenceMiner._native: missing {name}")

    revision = subprocess.check_output(["git", "rev-parse", args.reference_ref], cwd=ROOT, text=True).strip()
    original_stats = _reference_function(stats, "calculate_kanji_frequency", revision)
    generator = random.Random(917)
    alphabet = "日本語文章学校時間私世界新読物語文字漢字一二三かきくけこさしすせそあいうえお"
    pairs = []
    for index in range(128):
        source = "".join(generator.choices(alphabet, k=48 + index % 5 * 24))
        changed = list(source)
        for offset in generator.sample(range(len(source)), k=1 + index % 6):
            changed[offset] = generator.choice(alphabet)
        pairs.append((source, "".join(changed)))
    char_texts = ["".join(char * 3 for char in source) for source, _ in pairs[:32]]
    line_texts = [source * 6 for source, _ in pairs[:32]]
    lines = [SimpleNamespace(line_text=pairs[index % len(pairs)][0]) for index in range(args.stats_lines)]

    workloads = {
        "ocr_sequence_ratio_128_pairs": (
            lambda: [native_text._sequence_ratio_python(a, b) for a, b in pairs],
            lambda: [native_text.sequence_ratio(a, b) for a, b in pairs],
        ),
        "ocr_matching_blocks_128_uncached_pairs": (
            lambda: [native_text._matching_block_stats_python(a, b, 2) for a, b in pairs],
            lambda: [compare._matching_block_stats_cached.__wrapped__(a, b, 2) for a, b in pairs],
        ),
        "hook_repeated_characters_32_lines": (
            lambda: [native_text._remove_repeated_chars_python(text) for text in char_texts],
            lambda: [text_processing.remove_repeated_chars(text) for text in char_texts],
        ),
        "hook_repeated_lines_32_lines": (
            lambda: [native_text._remove_repeated_lines_python(text) for text in line_texts],
            lambda: [text_processing.remove_repeated_lines(text) for text in line_texts],
        ),
        "stats_kanji_frequency": (
            lambda: original_stats(lines),
            lambda: stats.calculate_kanji_frequency(lines),
        ),
    }
    results = {}
    for name, (before, after) in workloads.items():
        results[name] = measure(before, after, rounds=args.rounds, loops=args.loops)
        row = results[name]
        print(f"{name}: {row['python_ms']:.3f} -> {row['native_ms']:.3f} ms ({row['speedup']:.2f}x)", flush=True)
    return {
        "workloads": "deterministic synthetic Japanese text; exact parity asserted before timing",
        "platform": platform.platform(),
        "python": platform.python_version(),
        "reference_revision": revision,
        "stats_lines": len(lines),
        "stats_characters": sum(len(line.line_text) for line in lines),
        "rounds": args.rounds,
        "loops": args.loops,
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-ref", default="HEAD")
    parser.add_argument("--stats-lines", type=int, default=10000)
    parser.add_argument("--rounds", type=int, default=7)
    parser.add_argument("--loops", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if min(args.stats_lines, args.rounds, args.loops) < 1:
        parser.error("--stats-lines, --rounds, and --loops must be positive")
    result = benchmark(args)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
