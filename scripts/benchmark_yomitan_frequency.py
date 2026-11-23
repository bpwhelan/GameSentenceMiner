"""Measure personal frequency dictionary downloads and verify every exported bank."""

import argparse
import hashlib
import json
import os
import platform
import sqlite3
import statistics
import sys
import tempfile
import time
import zipfile
from contextlib import ExitStack, closing
from pathlib import Path

from benchmark_stats import (
    REPO_ROOT,
    _configure_bootstrap_environment,
    _install_keyboard_stub,
    _install_noop_logging_module,
)
from benchmark_stats_web import measure, start_worker

ROUTE = "/api/yomitan-freq-dict"


def seed(directory, count, archived):
    directory.mkdir()
    config = {
        "experimental": {"enable_tokenization": True, "enable_experimental_features": True},
        "configs": {"Default": {"general": {"single_port": 7275}}},
    }
    (directory / "config.json").write_text(json.dumps(config), encoding="utf8")
    sql = REPO_ROOT / "native/gsm-db/migrations"
    with closing(sqlite3.connect(directory / "gsm.db")) as db:
        db.executescript((sql / "001_core.sql").read_text())
        db.executescript((sql / "vocabulary_001_tables.sql").read_text())
        db.executescript((sql / "vocabulary_001_indexes.sql").read_text())
        db.execute("INSERT INTO game_lines(id,game_name,timestamp) VALUES('a','G',10),('b','G',20)")
        db.executemany(
            "INSERT INTO words(id,word,reading) VALUES(?,?,?)",
            ((i, f"言葉{i}", f"ことば{i}" if i % 3 else "") for i in range(1, count + 1)),
        )
        db.execute("INSERT INTO word_occurrences(word_id,line_id) SELECT id,'a' FROM words")
        db.execute("INSERT INTO word_occurrences(word_id,line_id) SELECT id,'b' FROM words WHERE id%4=0")
        if archived:
            db.executescript((sql / "003_archives.sql").read_text())
            db.execute("INSERT INTO archived_game_days VALUES('g','2020-01-01','G',X'','{}','{}',0,1,1,0,1,1,'{}')")
            db.execute("""INSERT INTO archived_word_stats SELECT 'g','2020-01-01',id,word,reading,'',3,0,1,'old'
                FROM words WHERE id%5=0""")
        db.commit()


def reference(directory):
    _configure_bootstrap_environment(directory / "bootstrap")
    _install_keyboard_stub()
    _install_noop_logging_module()
    from GameSentenceMiner.util.database.db import SQLiteDB
    from GameSentenceMiner.util.database.tokenization_tables import WordsTable
    from GameSentenceMiner.util.yomitan_dict.freq_dict_builder import FrequencyDictBuilder

    database = SQLiteDB(str(directory / "gsm.db"), read_only=True)
    WordsTable.set_db(database, ensure_schema=False)
    print(f"ready {os.getpid()}", flush=True)
    try:
        for line in sys.stdin:
            route, count, verify = json.loads(line)
            start = time.perf_counter()
            for _ in range(count):
                builder = FrequencyDictBuilder(f"http://127.0.0.1:7275{route}")
                builder.build_from_db()
                body = builder.export_bytes()
            ms = (time.perf_counter() - start) * 1000 / count
            if verify:
                (directory / "python.zip").write_bytes(body)
            print(json.dumps({"ms": ms, "bytes": len(body)}), flush=True)
    finally:
        database.close()


def signature(archive, count):
    with zipfile.ZipFile(archive) as zip_file:
        assert zip_file.testzip() is None
        expected = ["index.json", *(f"term_meta_bank_{i + 1}.json" for i in range((count + 9999) // 10000))]
        assert zip_file.namelist() == expected
        index = json.loads(zip_file.read(expected[0]))
        assert abs(int(index.pop("revision")) - time.time()) < 120
        rows = []
        for bank in expected[1:]:
            entries = json.loads(zip_file.read(bank))
            assert len(entries) == min(10000, count - len(rows))
            rows.extend(entries)
        assert len(rows) == count
        return index, hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def run(root, rounds):
    worker = REPO_ROOT / "src-tauri/target/native-dev/release/examples/report_benchmark"
    if os.name == "nt":
        worker = worker.with_suffix(".exe")
    report = {
        "rounds": rounds,
        "platform": platform.platform(),
        "worker_sha256": hashlib.sha256(worker.read_bytes()).hexdigest(),
        "workloads": {},
    }
    for name, size, archived, calls in [
        ("small", 100, False, 80),
        ("multiple_banks", 25000, False, 3),
        ("archived", 25000, True, 3),
    ]:
        directory = root / name
        seed(directory, size, archived)
        samples = {"rust": [], "python": []}
        with ExitStack() as stack:
            workers = {
                "rust": start_worker(stack, [str(worker), str(directory)]),
                "python": start_worker(stack, [sys.executable, __file__, "--reference", str(directory)]),
            }
            for process in workers.values():
                measure(process, ROUTE, 1, verify=True)
            expected = signature(directory / "python.zip", size)
            assert expected == signature(directory / "rust.zip", size)
            for i in range(rounds):
                for language in workers if i % 2 == 0 else reversed(workers):
                    samples[language].append(measure(workers[language], ROUTE, calls))
        result = {"word_count": size, "calls": calls, "term_sha256": expected[1], "samples": samples}
        for language, values in samples.items():
            result[language] = {
                k: round(statistics.median(v[k] for v in values), 4) for k in ("ms", "cpu_ms", "resident_mib", "bytes")
            }
        report["workloads"][name] = result
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
            result = run(Path(temp), args.rounds)
        if args.output:
            args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
        for name, value in result["workloads"].items():
            print(name, value["python"], value["rust"])
