"""Compare desktop vocabulary setup and frequency import against the shipping Python paths."""

import argparse
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import platform
import sqlite3
import statistics
import sys
import tempfile
import time
from contextlib import ExitStack, closing
from pathlib import Path

from benchmark_stats import (
    REPO_ROOT,
    _configure_bootstrap_environment,
    _install_keyboard_stub,
    _install_noop_logging_module,
)
from benchmark_stats_web import measure, start_worker

SOURCES = REPO_ROOT / "GameSentenceMiner/web/templates/components/word_frequency_sources"
SQL = REPO_ROOT / "native/gsm-db/migrations"


def reference(directory, extension):
    _configure_bootstrap_environment(directory / "bootstrap")
    _install_keyboard_stub()
    _install_noop_logging_module()
    name = "GameSentenceMiner._native"
    loader = importlib.machinery.ExtensionFileLoader(name, str(extension.resolve()))
    spec = importlib.util.spec_from_file_location(name, loader.path, loader=loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    sys.modules[name] = module
    from GameSentenceMiner.util.database import (
        anki_tables,
        db,
        tokenization_tables,
    )
    from GameSentenceMiner.util.database import (
        global_frequency_tables as frequency,
    )
    from GameSentenceMiner.util.database.cron_table import CronTable

    assert callable(module.configure_vocabulary_schema)
    os.environ.pop("GAME_SENTENCE_MINER_TESTING", None)
    print(f"ready {os.getpid()}", flush=True)
    for line in sys.stdin:
        case, count, _ = json.loads(line)
        path = case["db"]
        database = db.SQLiteDB(path)
        CronTable.set_db(database, ensure_schema=False)
        try:
            database.fetchone("SELECT 1")
            database.run_external_write(lambda: None)
            start = time.perf_counter()
            for _ in range(count):
                op = case["op"]
                if op in {"enable", "enabled", "disable"}:
                    enabled = op != "disable"
                    database.run_external_write(
                        lambda path=path, enabled=enabled: module.configure_vocabulary_schema(path, enabled)
                    )
                    if enabled:
                        tokenization_tables._migrate_tokenize_backfill_cron_job()
                        anki_tables._migrate_anki_card_sync_cron()
                    else:
                        tokenization_tables._disable_tokenize_backfill_cron()
                        tokenization_tables._disable_anki_word_sync_cron()
                        anki_tables._disable_anki_card_sync_cron()
                else:
                    if op != "warm":
                        frequency.clear_global_frequency_source_cache()
                    frequency.setup_global_frequency_sources(database)
            print(json.dumps({"ms": (time.perf_counter() - start) * 1000 / count}), flush=True)
        finally:
            database.close()


def seed(path):
    with closing(sqlite3.connect(path)) as db:
        db.executescript((SQL / "001_core.sql").read_text())
        db.executescript("PRAGMA journal_mode=WAL; PRAGMA user_version=4;")
        db.commit()


def signature(path, op, cached_ranks):
    with closing(sqlite3.connect(path)) as db:
        assert db.execute("PRAGMA quick_check").fetchone() == ("ok",)
        if op in {"enable", "enabled", "disable"}:
            jobs = db.execute(
                "SELECT name,description,schedule,CAST(enabled AS INTEGER) FROM cron_table ORDER BY name"
            ).fetchall()
            assert len(jobs) == 2 and all(bool(row[-1]) == (op != "disable") for row in jobs)
            assert bool(db.execute("SELECT count(*) FROM sqlite_schema WHERE name='words'").fetchone()[0]) == (
                op != "disable"
            )
            return jobs
        header = db.execute(
            "SELECT id,name,version,source_url,is_default,max_rank,entry_count FROM global_frequency_sources"
        ).fetchall()
        digest = hashlib.sha256()
        count = 0
        for word, rank in db.execute("SELECT word,rank FROM word_global_frequencies ORDER BY word"):
            digest.update(word.encode() + b"\0" + rank.to_bytes(8, "little"))
            count += 1
        assert count == header[0][-1] and count > 0
        cached = db.execute("SELECT word_id,active_global_rank FROM word_stats_cache ORDER BY word_id").fetchall()
        assert [row[1] for row in cached] == cached_ranks
        return {"metadata": header, "pairs_sha256": digest.hexdigest(), "cached": cached}


def benchmark(root, extension, rounds):
    worker = REPO_ROOT / "src-tauri/target/native-dev/release/examples/vocabulary_setup"
    if os.name == "nt":
        worker = worker.with_suffix(".exe")
    bundled = (SOURCES / "jiten_global.json").read_bytes()
    words = json.loads(bundled)["entries"][:2]
    report = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "rounds": rounds,
        "source_sha256": hashlib.sha256(bundled).hexdigest(),
        "python_extension_sha256": hashlib.sha256(extension.read_bytes()).hexdigest(),
        "rust_worker_sha256": hashlib.sha256(worker.read_bytes()).hexdigest(),
        "workloads": {},
    }
    for i in range(rounds):
        with ExitStack() as stack:
            workers = {
                key: start_worker(stack, cmd)
                for key, cmd in [
                    ("python", [sys.executable, __file__, "--reference", str(root), "--extension", str(extension)]),
                    ("rust", [str(worker), str(SOURCES)]),
                ]
            }
            paths = {name: root / f"{name}-{i}.db" for name in workers}
            for path in paths.values():
                seed(path)
            for op, count in [
                ("enable", 1),
                ("enabled", 40),
                ("fresh", 1),
                ("reopen", 1),
                ("warm", 25),
                ("upgrade", 1),
                ("disable", 1),
            ]:
                results = []
                for name in workers if i % 2 == 0 else reversed(workers):
                    path = paths[name]
                    if op == "fresh":
                        with closing(sqlite3.connect(path)) as db:
                            db.executemany(
                                "INSERT INTO words(id,word) VALUES(?,?)",
                                enumerate([words[0][0], words[1][0], "__gsm_unranked_fixture__"], 1),
                            )
                            db.executemany(
                                "INSERT INTO word_stats_cache(word_id,occurrence_count) VALUES(?,1)", [(1,), (2,), (3,)]
                            )
                            db.commit()
                    if op == "upgrade":
                        with closing(sqlite3.connect(path)) as db:
                            db.execute("UPDATE global_frequency_sources SET version='previous-version'")
                            db.execute("UPDATE word_global_frequencies SET word='__retired__'||word WHERE rank % 97=0")
                            db.execute("UPDATE word_global_frequencies SET rank=rank+100 WHERE rank % 20=0")
                            db.commit()
                    sample = measure(workers[name], {"op": op, "db": str(path)}, count)
                    results.append(signature(path, op, [words[0][1], words[1][1], None]))
                    r = report["workloads"].setdefault(op, {"calls": count, "samples": {"rust": [], "python": []}})
                    r["samples"][name].append(sample)
                assert results[0] == results[1], op
                if op == "fresh":
                    report["validated_frequency_data"] = results[0]
        for path in paths.values():
            path.unlink()
    for r in report["workloads"].values():
        for name, samples in r["samples"].items():
            r[name] = {
                key: round(statistics.median(sample[key] for sample in samples), 4)
                for key in ("ms", "cpu_ms", "resident_mib")
            }
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.reference:
        reference(args.reference, args.extension)
    else:
        with tempfile.TemporaryDirectory() as folder:
            result = benchmark(Path(folder), args.extension, args.rounds)
        if args.output:
            args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
        for op, stats in result["workloads"].items():
            print(op, stats["python"], stats["rust"])
