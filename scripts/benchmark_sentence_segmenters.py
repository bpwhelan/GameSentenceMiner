"""Independent, reproducible evaluation for GSM issue #551 (no runtime changes).

Run with a separate .venv containing the requirements in docs/benchmarks/sbd-551.
The prepare command downloads UD r2.16 test sets and freezes inputs before scoring.
The run command benchmarks the proposed clean=True adapter and diagnostic controls.
"""

from __future__ import annotations

import argparse
import ast
import gc
import hashlib
import importlib.metadata
import json
import logging
import os
import platform
import random
import re
import statistics
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "docs/benchmarks/sbd-551"
DEFAULT_CACHE = ROOT / ".tmp_test_env/sbd_issue_551"
BACKENDS = ("pysbd_clean", "yasbd_clean", "pysbd_raw", "yasbd_raw", "yasbd_core")
UD_SOURCES = {
    "ja": ("UD_Japanese-GSD", "ja_gsd-ud-test.conllu"),
    "zh": ("UD_Chinese-GSD", "zh_gsd-ud-test.conllu"),
    "en": ("UD_English-EWT", "en_ewt-ud-test.conllu"),
    "ko": ("UD_Korean-GSD", "ko_gsd-ud-test.conllu"),
    "fr": ("UD_French-GSD", "fr_gsd-ud-test.conllu"),
    "de": ("UD_German-GSD", "de_gsd-ud-test.conllu"),
    "es": ("UD_Spanish-GSD", "es_gsd-ud-test.conllu"),
    "ru": ("UD_Russian-Taiga", "ru_taiga-ud-test.conllu"),
    "pt": ("UD_Portuguese-Bosque", "pt_bosque-ud-test.conllu"),
    "uk": ("UD_Ukrainian-IU", "uk_iu-ud-test.conllu"),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def nonspace(text):
    return "".join(text.split())


def boundary_positions(sentences):
    lengths = [len(nonspace(sentence)) for sentence in sentences if nonspace(sentence)]
    position = 0
    positions = set()
    for length in lengths[:-1]:
        position += length
        positions.add(position)
    return positions


def score_case(text, expected, actual):
    """Count internal character boundaries; never guess alignment after text edits."""
    gold = [nonspace(sentence) for sentence in expected if nonspace(sentence)]
    predicted = [nonspace(sentence) for sentence in actual if nonspace(sentence)]
    if "".join(gold) != nonspace(text):
        raise ValueError("Gold annotations must preserve non-whitespace input characters")
    changed = "".join(predicted) != nonspace(text)
    gold_ends, predicted_ends = boundary_positions(gold), boundary_positions(predicted)
    return {
        "exact_stripped": [s.strip() for s in actual] == [s.strip() for s in expected],
        "exact_nonspace": predicted == gold,
        "content_changed": changed,
        "tp": None if changed else len(gold_ends & predicted_ends),
        "fp": None if changed else len(predicted_ends - gold_ends),
        "fn": None if changed else len(gold_ends - predicted_ends),
    }


def summarize_scores(scores):
    counts = {name: sum(s[name] or 0 for s in scores) for name in ("tp", "fp", "fn")}
    tp, fp, fn = (counts[name] for name in ("tp", "fp", "fn"))
    return {
        "cases": len(scores),
        "exact_stripped": sum(s["exact_stripped"] for s in scores),
        "exact_nonspace": sum(s["exact_nonspace"] for s in scores),
        "content_changed": sum(s["content_changed"] for s in scores),
        "boundary_scored_cases": sum(s["tp"] is not None for s in scores),
        "boundary_precision": tp / (tp + fp) if tp + fp else None,
        "boundary_recall": tp / (tp + fn) if tp + fn else None,
        "boundary_f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
        **counts,
    }


def read_literal_assignment(path, variable):
    """Read dataset constants without executing downloaded Python source."""

    class StripPytestParam(ast.NodeTransformer):
        def visit_Call(self, node):
            if (
                isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "pytest"
                and node.func.attr == "param"
            ):
                return ast.Tuple(elts=node.args, ctx=ast.Load())
            return node

    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == variable for target in node.targets
        ):
            return ast.literal_eval(StripPytestParam().visit(node.value))
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == variable:
            return ast.literal_eval(node.value)
    raise ValueError(f"Assignment {variable!r} missing in {path}")


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "GSM-independent-SBD-benchmark"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def prepare_ud(item, cache, groups):
    lang, (repo, filename) = item
    cached = cache / "sources" / filename
    metadata_path = cached.with_suffix(".metadata.json")
    if cached.exists() and metadata_path.exists():
        data = cached.read_bytes()
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata["sha256"] != digest(data):
            raise ValueError(f"Cached source checksum mismatch: {cached}")
    else:
        commit = json.loads(fetch(f"https://api.github.com/repos/UniversalDependencies/{repo}/commits/r2.16"))["sha"]
        url = f"https://raw.githubusercontent.com/UniversalDependencies/{repo}/{commit}/{filename}"
        data = fetch(url)
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(data)
        metadata = {"language": lang, "repo": repo, "revision": commit, "url": url, "sha256": digest(data)}
        write_json(metadata_path, metadata)
    sentences = []
    sentence_id = None
    for line in data.decode("utf-8-sig").splitlines():
        if line.startswith("# sent_id = "):
            sentence_id = line[len("# sent_id = ") :]
        elif line.startswith("# text = "):
            sentences.append((sentence_id, line[len("# text = ") :]))
    # Deterministic non-overlapping triples, sampled across the entire test file.
    # These are reconstructed contexts, not original document paragraphs.
    candidates = [sentences[i : i + 3] for i in range(0, len(sentences) - 2, 3)]
    selected = random.Random(551).sample(candidates, min(groups, len(candidates)))
    separator = "" if lang in {"ja", "zh"} else " "
    cases = [
        {
            "id": f"ud-{lang}-{index:03d}",
            "suite": "ud_r2.16",
            "lang": lang,
            "text": separator.join(text for _, text in group),
            "expected": [text for _, text in group],
            "sentence_ids": [sentence_id for sentence_id, _ in group],
        }
        for index, group in enumerate(selected)
    ]
    metadata.update(available_sentences=len(sentences), selected_triples=len(cases))
    return cases, metadata


def prepare(args):
    cases = json.loads((ARTIFACTS / "gsm_cases.json").read_text(encoding="utf-8"))
    metadata = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        for ud_cases, source in pool.map(lambda item: prepare_ud(item, args.cache, args.groups), UD_SOURCES.items()):
            cases.extend(ud_cases)
            metadata.append(source)
    for directory, suite in (("yasbd-lib", "yasbd_golden"), ("pysbd-source", "pysbd_golden")):
        source_root = args.cache / directory
        candidates = [source_root / "benchmarks/EN_GOLDEN_DATA.py", source_root / "tests/lang/test_english.py"]
        for candidate in candidates:
            if candidate.is_file() and candidate.suffix == ".py":
                try:
                    pairs = read_literal_assignment(candidate, "GOLDEN_EN_RULES_TEST_CASES")
                except ValueError:
                    continue
                for index, (text, expected) in enumerate(pairs):
                    # Some upstream gold data deliberately cleans input. Keep those
                    # as string equality tests; don't invent boundary alignment.
                    cases.append(
                        {"id": f"{suite}-{index:03d}", "suite": suite, "lang": "en", "text": text, "expected": expected}
                    )
                metadata.append(
                    {
                        "suite": suite,
                        "revision": subprocess.check_output(
                            ["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True
                        ).strip(),
                        "file": str(candidate.relative_to(source_root)),
                        "sha256": digest(candidate.read_bytes()),
                        "cases": len(pairs),
                    }
                )
                break
        else:
            raise ValueError(f"Missing golden data in {source_root}; clone the upstream repository first")
    fixture_bytes = (ARTIFACTS / "gsm_cases.json").read_bytes()
    write_json(args.cache / "corpus.json", cases)
    write_json(
        ARTIFACTS / "corpus_manifest.json",
        {
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "seed": 551,
            "groups_per_language": args.groups,
            "gsm_fixture_sha256": digest(fixture_bytes),
            "corpus_sha256": digest((args.cache / "corpus.json").read_bytes()),
            "sources": metadata,
        },
    )
    print(f"Frozen {len(cases)} cases before evaluation", flush=True)


class Passthrough:
    def segment(self, text):
        return [text]


class MaterializedCore:
    def __init__(self, detector):
        self.detector = detector

    def segment(self, text):
        return list(self.detector.segment(text))


def make_segmenter(backend, lang):
    if backend.startswith("pysbd"):
        from pysbd import Segmenter, languages

        return (
            Segmenter(language=lang, clean=backend.endswith("clean"))
            if lang in languages.LANGUAGE_CODES
            else Passthrough()
        )
    from yasbd import BoundaryDetector, get_supported_langs

    if lang not in get_supported_langs():
        return Passthrough()
    if backend == "yasbd_core":
        return BoundaryDetector(lang=lang)
    if backend == "yasbd_core_list":
        return MaterializedCore(BoundaryDetector(lang=lang))
    from yasbd.utils.pysbd_adapter import Segmenter

    return Segmenter(language=lang, clean=backend.endswith("clean"))


def percentile(values, fraction):
    ordered = sorted(values)
    index = (len(ordered) - 1) * fraction
    lo = int(index)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (index - lo)


def evaluate(cases, backends):
    records, grouped, segmenters = [], defaultdict(list), {}
    for case in cases:
        for backend in backends:
            key = (backend, case["lang"])
            if key not in segmenters:
                segmenters[key] = make_segmenter(*key)
            error = None
            try:
                actual = list(segmenters[key].segment(case["text"]))
            except Exception as exc:  # noqa: BLE001 - record third-party failures instead of dropping hard cases
                actual, error = [], repr(exc)
            if nonspace("".join(case["expected"])) == nonspace(case["text"]):
                scores = score_case(case["text"], case["expected"], actual)
            else:
                scores = {
                    "exact_stripped": [s.strip() for s in actual] == [s.strip() for s in case["expected"]],
                    "exact_nonspace": [nonspace(s) for s in actual] == [nonspace(s) for s in case["expected"]],
                    "content_changed": nonspace("".join(actual)) != nonspace(case["text"]),
                    "tp": None,
                    "fp": None,
                    "fn": None,
                }
            scores["error"] = error
            records.append({**case, "backend": backend, "actual": actual, **scores})
            grouped[(case["suite"], case["lang"], backend)].append(scores)
    summaries = [
        {
            "suite": suite,
            "lang": lang,
            "backend": backend,
            "errors": sum(s["error"] is not None for s in values),
            **summarize_scores(values),
        }
        for (suite, lang, backend), values in grouped.items()
    ]
    return summaries, records


def latency(cases, backends, rounds, passes):
    grouped = defaultdict(list)
    for case in cases:
        if case["suite"] in {"gsm", "ud_r2.16"}:
            grouped[(case["suite"], case["lang"])].append(case["text"])
    reports = []
    rng = random.Random(551)
    for (suite, lang), texts in grouped.items():
        # At most 32 independent texts per timing stratum; identical for every backend.
        texts = random.Random(551).sample(texts, min(32, len(texts)))
        engines = {backend: make_segmenter(backend, lang) for backend in backends}
        for engine in engines.values():
            for text in texts:
                list(engine.segment(text))
        durations, batch_means = defaultdict(list), defaultdict(list)
        for _ in range(rounds):
            order = list(backends)
            rng.shuffle(order)
            for backend in order:
                engine = engines[backend]
                gc.collect()
                gc.disable()
                try:
                    batch_start = time.perf_counter_ns()
                    for _ in range(passes):
                        for text in texts:
                            start = time.perf_counter_ns()
                            list(engine.segment(text))
                            durations[backend].append((time.perf_counter_ns() - start) / 1e6)
                    batch_means[backend].append((time.perf_counter_ns() - batch_start) / 1e6 / len(texts) / passes)
                finally:
                    gc.enable()
        for backend in backends:
            reports.append(
                {
                    "suite": suite,
                    "lang": lang,
                    "backend": backend,
                    "passthrough": isinstance(engines[backend], Passthrough),
                    "distinct_texts": len(texts),
                    "median_chars": statistics.median(map(len, texts)),
                    "calls": len(durations[backend]),
                    "median_ms": statistics.median(durations[backend]),
                    "p95_ms": percentile(durations[backend], 0.95),
                    "batch_mean_ms": batch_means[backend],
                    "median_batch_mean_ms": statistics.median(batch_means[backend]),
                }
            )
        print(f"Timed {suite}/{lang}: {len(texts)} texts, {rounds} rounds", flush=True)
    return reports


def cold_child(backend, lang):
    import psutil

    process = psutil.Process()
    rss_before = process.memory_info().rss
    start = time.perf_counter_ns()
    engine = make_segmenter(backend, lang)
    initialized = time.perf_counter_ns()
    text = "今日は晴れ。明日は雨。" if lang == "ja" else "Dr. Stone arrived. We can leave."
    list(engine.segment(text))
    first = time.perf_counter_ns()
    return {
        "import_and_init_ms": (initialized - start) / 1e6,
        "first_call_ms": (first - initialized) / 1e6,
        "total_ms": (first - start) / 1e6,
        "rss_delta_mib": (process.memory_info().rss - rss_before) / 2**20,
    }


def cold_runs(backends, rounds):
    output = []
    rng = random.Random(551)
    for lang in ("ja", "en"):
        measurements = defaultdict(list)
        for _ in range(rounds):
            order = list(backends)
            rng.shuffle(order)
            for backend in order:
                raw = subprocess.check_output(
                    [sys.executable, str(Path(__file__).resolve()), "cold-child", "--backend", backend, "--lang", lang],
                    text=True,
                )
                measurements[backend].append(json.loads(raw))
        for backend, values in measurements.items():
            output.append(
                {
                    "lang": lang,
                    "backend": backend,
                    "samples": values,
                    **{key: statistics.median(v[key] for v in values) for key in values[0]},
                }
            )
    return output


def probe(args):
    """Execute actual GSM filter methods with isolated regex/history state.

    Extracting methods avoids starting GSM services or reading user configuration.
    Language classification is fixed to the requested language for both backends.
    The native wrapper/extension is exercised as well when available.
    """
    sys.path.insert(0, str(ROOT))
    from GameSentenceMiner.native import ocr as native_ocr

    source = ROOT / "GameSentenceMiner/owocr/owocr/ocr_runtime.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "TextFiltering")
    initializer = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "__init__")
    regex_assignments = [
        node
        for node in initializer.body
        if isinstance(node, ast.Assign)
        and isinstance(node.targets[0], ast.Attribute)
        and node.targets[0].attr.endswith("_regex")
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Attribute)
        and isinstance(node.value.func.value, ast.Name)
        and node.value.func.value.id == "re"
        and node.value.func.attr == "compile"
    ]
    helpers = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name in {"_normalize_segment_source_text", "_join_selected_blocks_with_source_separators"}
    ]
    cls.body = [
        node
        for node in cls.body
        if isinstance(node, ast.FunctionDef)
        and node.name in {"_filter_text_python", "_filter_text_native", "_ensure_python_filter_backend"}
    ]
    namespace = {
        "re": re,
        "deque": deque,
        "logger": logging.getLogger("sbd-probe"),
        "engine_index": 0,
        "native_ocr": native_ocr,
    }
    exec(compile(ast.Module(body=helpers + [cls], type_ignores=[]), str(source), "exec"), namespace)  # noqa: S102 - local GSM methods, isolated globals
    scenarios = [
        ("ja-punctuation", "ja", ["「返しなさいよーーーっ！！」"], ["「返しなさいよーーーっ！！」"]),
        ("ja-fullwidth", "ja", ["ＨＰが１００回復した！次へ進もう。"], ["ＨＰが１００回復した！次へ進もう。"]),
        ("ja-wrap", "ja", ["今日はとても\nいい天気だ。外へ出よう。"], ["今日はとても\nいい天気だ。外へ出よう。"]),
        (
            "ja-menu-growth",
            "ja",
            ["武器を選ぶ\n防具を選ぶ", "武器を選ぶ\n防具を選ぶ\n戻る"],
            ["武器を選ぶ\n防具を選ぶ", "戻る"],
        ),
        ("ja-plain-growth", "ja", ["今日は晴れ。", "今日は晴れ。明日も晴れ。"], ["今日は晴れ。", "明日も晴れ。"]),
        ("ja-quote-growth", "ja", ["「行こう。」", "「行こう。」「うん。」"], ["「行こう。」", "「うん。」"]),
        (
            "en-lowercase-growth",
            "en",
            ["are you there?", "are you there? please answer."],
            ["are you there?", "please answer."],
        ),
        (
            "en-plain-growth",
            "en",
            ["The door is open.", "The door is open. We should leave."],
            ["The door is open.", "We should leave."],
        ),
        (
            "en-blank-line",
            "en",
            ["The door is open.BLANK_LINEWe should leave."],
            ["The door is open.\nWe should leave."],
        ),
        ("zh-punctuation", "zh", ["你准备好了吗？我们出发吧！"], ["你准备好了吗？我们出发吧！"]),
        (
            "ko-growth",
            "ko",
            ["문이 열렸습니다.", "문이 열렸습니다. 이제 출발합시다."],
            ["문이 열렸습니다.", "이제 출발합시다."],
        ),
    ]
    records = []
    for name, lang, frames, expected in scenarios:
        for backend in ("pysbd_clean", "yasbd_clean", "yasbd_raw", "yasbd_core_list"):
            for mode in ("python", "native") if native_ocr.is_available() else ("python",):
                namespace["get_ocr_language"] = lambda lang=lang: lang
                state = namespace["TextFiltering"]()
                state.initial_lang = lang
                state.segmenter = make_segmenter(backend, lang)
                state.last_few_results = {}
                state.accurate_filtering = False
                state.classify = lambda text, lang=lang: (lang, 1.0)
                state._refresh_segmenter_language = lambda: None
                exec(  # noqa: S102 - local GSM regex assignments only
                    compile(ast.Module(body=regex_assignments, type_ignores=[]), str(source), "exec"),
                    {"self": state, "re": re},
                )
                previous, outputs, blocks = [], [], []
                for frame in frames:
                    filtered, previous = getattr(state, f"_filter_text_{mode}")(
                        frame, previous, engine=None, is_second_ocr=True
                    )
                    outputs.append(filtered)
                    blocks.append(previous)
                records.append(
                    {
                        "scenario": name,
                        "lang": lang,
                        "backend": backend,
                        "mode": mode,
                        "frames": frames,
                        "expected": expected,
                        "outputs": outputs,
                        "blocks": blocks,
                        "passed": outputs == expected,
                    }
                )
    write_json(
        args.output / "gsm_integration.json",
        {
            "source_sha256": digest(source.read_bytes()),
            "native_available": native_ocr.is_available(),
            "native_import_error": str(native_ocr.import_error()),
            "classification": "fixed to requested language",
            "cases": records,
        },
    )
    print(f"GSM method probes: {len(records)}; native available: {native_ocr.is_available()}", flush=True)


def bulk_child(args):
    import psutil

    text = (args.cache / "bulk" / f"{args.workload}.txt").read_bytes().decode("utf-8")
    process = psutil.Process()
    engine = make_segmenter(args.backend, "ja" if args.workload.startswith("ja") else "en")
    list(engine.segment("短い文。" if args.workload.startswith("ja") else "A short sentence."))
    baseline = process.memory_info().rss
    start = time.perf_counter()
    result = list(engine.segment(text))
    first_ms = (time.perf_counter() - start) * 1000
    count = len(result)
    del result
    warm = []
    for _ in range(3):
        gc.collect()
        start = time.perf_counter()
        result = list(engine.segment(text))
        warm.append((time.perf_counter() - start) * 1000)
        del result
    memory = process.memory_info()
    return {
        "backend": args.backend,
        "workload": args.workload,
        "chars": len(text),
        "sha256": digest(text.encode("utf-8")),
        "sentences": count,
        "first_document_ms": first_ms,
        "warm_ms": warm,
        "median_ms": statistics.median(warm),
        "rss_growth_mib": (memory.rss - baseline) / 2**20,
        "peak_working_set_mib": getattr(memory, "peak_wset", memory.rss) / 2**20,
    }


def bulk(args):
    directory = args.cache / "bulk"
    directory.mkdir(parents=True, exist_ok=True)
    book_path = directory / "sherlock.txt"
    url = "https://www.gutenberg.org/ebooks/1661.txt.utf-8"
    if not book_path.exists():
        book_path.write_bytes(fetch(url))
    for size in (1000, 10000, 100000):
        (directory / f"ja_unpunctuated_{size}.txt").write_bytes(("あ" * size).encode("utf-8"))
    # A long OCR text with genuine line breaks; no speed extrapolation from one size.
    (directory / "ja_wrapped_100k.txt").write_bytes(("今日はとても\nいい天気だ。外へ出よう。\n" * 4500).encode("utf-8"))
    records = []
    pairs = [
        (path.stem, backend)
        for path in sorted(directory.glob("*.txt"))
        for backend in ("pysbd_clean", "yasbd_clean", "pysbd_raw", "yasbd_core")
    ]
    random.Random(551).shuffle(pairs)
    for workload, backend in pairs:
        try:
            raw = subprocess.check_output(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "bulk-child",
                    "--cache",
                    str(args.cache),
                    "--backend",
                    backend,
                    "--workload",
                    workload,
                ],
                text=True,
                encoding="utf-8",
                timeout=60,
            )
            record = json.loads(raw)
        except subprocess.TimeoutExpired:
            record = {"workload": workload, "backend": backend, "timeout_seconds": 60}
        records.append(record)
        write_json(args.output / "bulk.json", {"book_url": url, "cases": records})
        print(f"Bulk {workload}/{backend}: {record.get('median_ms', 'timeout')}", flush=True)


def run(args):
    corpus_path = args.cache / "corpus.json"
    cases = json.loads(corpus_path.read_text(encoding="utf-8"))
    manifest = json.loads((ARTIFACTS / "corpus_manifest.json").read_text(encoding="utf-8"))
    if digest(corpus_path.read_bytes()) != manifest["corpus_sha256"]:
        raise ValueError("Corpus differs from frozen manifest")
    backends = args.backends.split(",")
    summaries, records = evaluate(cases, backends)
    args.output.mkdir(parents=True, exist_ok=True)
    write_json(args.output / "accuracy.json", summaries)
    # Raw inputs/outputs remain in the local ignored cache (UD source licenses vary).
    write_json(args.cache / "predictions.json", records)
    print(f"Evaluated {len(records)} case/backend pairs", flush=True)
    times = latency(cases, backends, args.rounds, args.passes)
    write_json(args.output / "latency.json", times)
    cold = cold_runs(backends, 5)
    from pysbd import languages
    from yasbd import get_supported_langs

    write_json(
        args.output / "environment.json",
        {
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "python": sys.version,
            "platform": platform.platform(),
            "processor": platform.processor(),
            "logical_cpu_count": os.cpu_count(),
            "gsm_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "script_sha256": digest(Path(__file__).read_bytes()),
            "corpus_sha256": manifest["corpus_sha256"],
            "packages": {d.metadata["Name"]: d.version for d in importlib.metadata.distributions()},
            "pysbd_languages": sorted(languages.LANGUAGE_CODES),
            "yasbd_languages": sorted(get_supported_langs()),
            "rounds": args.rounds,
            "passes_per_round": args.passes,
            "cold": cold,
        },
    )
    print(f"Results: {args.output}", flush=True)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "run", "cold-child", "probe", "bulk", "bulk-child"))
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--output", type=Path, default=ARTIFACTS / "results")
    parser.add_argument("--groups", type=int, default=150)
    parser.add_argument("--backends", default=",".join(BACKENDS))
    parser.add_argument("--rounds", type=int, default=7)
    parser.add_argument("--passes", type=int, default=3)
    parser.add_argument("--backend", default="pysbd_clean")
    parser.add_argument("--lang", default="ja")
    parser.add_argument("--workload", default="sherlock")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args)
    elif args.command == "run":
        run(args)
    elif args.command == "probe":
        probe(args)
    elif args.command == "bulk":
        bulk(args)
    elif args.command == "bulk-child":
        print(json.dumps(bulk_child(args)))
    else:
        print(json.dumps(cold_child(args.backend, args.lang)))


if __name__ == "__main__":
    main()
