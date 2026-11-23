"""Compare Python and Rust profile-file operations on disposable SQLite/WAL databases."""

import argparse
import gzip
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import platform
import shutil
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


def reference(root, extension):
    _configure_bootstrap_environment(root / "bootstrap")
    os.environ.pop("GSM_PROFILE_DIR", None)
    os.environ["GSM_DATA_DIR"] = str(root / "selected")
    os.environ["GSM_TEST_DATA_ROOT"] = str(root)
    _install_keyboard_stub()
    _install_noop_logging_module()
    if extension:
        name = "GameSentenceMiner._native"
        loader = importlib.machinery.ExtensionFileLoader(name, str(extension.resolve()))
        spec = importlib.util.spec_from_file_location(name, loader.path, loader=loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        sys.modules[name] = module
        from GameSentenceMiner.native.ocr import _extension

        assert (
            _extension is module
            and hasattr(module, "history_snapshot")
            and hasattr(module, "compressed_history_snapshot")
        )
    from GameSentenceMiner.util.cron.kechimochi_sync import configure_kechimochi_cron
    from GameSentenceMiner.util.database import db
    from GameSentenceMiner.util.database.data_dir_migration import recover_legacy_database
    from GameSentenceMiner.util.database.maintenance import setup_database_maintenance
    from GameSentenceMiner.util.tadoku_sync import initialize_tadoku_cursor

    source = root / "gsm.db"
    writer = db.SQLiteDB(str(source))
    jobs = db.SQLiteDB(str(root / "jobs.db"))
    for table in db._DATABASE_TABLE_CLASSES:
        table.set_db(jobs, ensure_schema=False)
    # Time only the job/cursor policy on both workers.
    db._initialize_vocabulary = lambda: None
    print(f"ready {os.getpid()}", flush=True)
    try:
        for line in sys.stdin:
            op, count, _ = json.loads(line)
            start = time.perf_counter()
            for _ in range(count):
                if op in {"seed-jobs", "existing-jobs"}:
                    initialize_tadoku_cursor()
                    db.check_and_run_migrations(core_schema_ready=True)
                    setup_database_maintenance()
                    configure_kechimochi_cron()
                    result = root / "jobs.db"
                elif op in {"relocate", "reopen"}:
                    recover_legacy_database(str(root / "selected"))
                    result = root / "selected/gsm.db"
                elif op == "manual":
                    result = root / "manual.db"
                    writer.backup(str(result))
                else:
                    result = db.backup_db(str(source), backup_dir=str(root / "daily"), retention_count=2)
            print(
                json.dumps(
                    {"ms": (time.perf_counter() - start) * 1000 / count, "result": str(result) if result else None}
                ),
                flush=True,
            )
    finally:
        jobs.close()
        writer.close()


def content_digest(conn):
    digest = hashlib.sha256()
    for row_id, text in conn.execute("SELECT id,text FROM lines ORDER BY id"):
        digest.update(row_id.to_bytes(8, "little"))
        digest.update(text.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def verify(path, expected, restored):
    if path.suffix == ".gz":
        with gzip.open(path, "rb") as source, restored.open("wb") as destination:
            shutil.copyfileobj(source, destination)
        path = restored
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute("PRAGMA quick_check").fetchone() == ("ok",)
        assert content_digest(conn) == expected


def benchmark(directory, rounds, rows, extension):
    exe = REPO_ROOT / "src-tauri/target/native-dev/release/examples/profile_files"
    if os.name == "nt":
        exe = exe.with_suffix(".exe")
    report = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "rows": rows,
        "rounds": rounds,
        "rust_worker_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
        "python_extension_sha256": hashlib.sha256(extension.read_bytes()).hexdigest() if extension else None,
        "workloads": {},
    }
    with ExitStack() as stack:
        workers = {}
        for name in ("python", "rust"):
            root = directory / name
            (root / "selected").mkdir(parents=True)
            (root / "daily").mkdir()
            source = stack.enter_context(closing(sqlite3.connect(root / "gsm.db")))
            source.execute("PRAGMA journal_mode=WAL")
            source.execute("PRAGMA wal_autocheckpoint=0")
            with closing(sqlite3.connect(root / "jobs.db")) as jobs:
                jobs.executescript((REPO_ROOT / "native/gsm-db/migrations/001_core.sql").read_text())
                jobs.executescript("PRAGMA journal_mode=WAL; PRAGMA user_version=4;")
            with source:
                source.execute("CREATE TABLE lines(id INTEGER PRIMARY KEY, text)")
                source.executemany(
                    "INSERT INTO lines VALUES(?,?)", ((i, f"{i:09}日本語の台詞" * 7) for i in range(rows))
                )
            expected = content_digest(source)
            report["fixture_digest"] = expected
            command = (
                [sys.executable, __file__, "--reference", str(root)] if name == "python" else [str(exe), str(root)]
            )
            if name == "python" and extension:
                command.extend(["--python-extension", str(extension.resolve())])
            workers[name] = start_worker(stack, command)
        for op, count in [
            ("relocate", 1),
            ("reopen", 100),
            ("manual", 1),
            ("daily", 1),
            ("already-backed-up", 25),
            ("seed-jobs", 1),
            ("existing-jobs", 50),
        ]:
            samples = {name: [] for name in workers}
            for i in range(rounds):
                job_states = []
                for name in ("python", "rust") if i % 2 == 0 else ("rust", "python"):
                    root = directory / name
                    pointer = root / "bootstrap/home/.config/GameSentenceMiner/data_dir.json"
                    if op == "relocate":
                        pointer.parent.mkdir(parents=True, exist_ok=True)
                        pointer.write_text(
                            json.dumps(
                                {"version": 2, "dataDir": str(root / "selected"), "legacyDatabaseDir": str(root)}
                            )
                        )
                        (root / "selected/gsm.db").write_bytes(b"prior copy")
                    if op == "daily":
                        daily_name = time.strftime("gsm_%Y-%m-%d.db.gz")
                        (root / "daily" / daily_name).unlink(missing_ok=True)
                    if op == "seed-jobs":
                        with closing(sqlite3.connect(root / "jobs.db")) as jobs:
                            jobs.executescript("DELETE FROM cron_table; DELETE FROM stats_export_state;")
                    sample = measure(workers[name], op, count)
                    result = sample.pop("result")
                    if op in {"seed-jobs", "existing-jobs"}:
                        with closing(sqlite3.connect(result)) as jobs:
                            job_rows = jobs.execute(
                                "SELECT name,description,schedule,enabled,CAST(next_run AS REAL) FROM cron_table ORDER BY name"
                            ).fetchall()
                            cursor = jobs.execute(
                                "SELECT last_successful_export_at FROM stats_export_state WHERE format_key='tadoku_incremental'"
                            ).fetchone()
                            assert len(job_rows) == 8 and cursor and float(cursor[0]) > 0
                            job_states.append(job_rows)
                    elif result:
                        verify(Path(result), expected, root / "restore.db")
                        if op == "manual":
                            Path(result).unlink()
                    else:
                        assert op == "already-backed-up"
                    if op == "relocate":
                        assert "legacyDatabaseDir" not in json.loads(pointer.read_text())
                        archives = list((root / "selected/backup/data-directory-migration").glob("*/gsm.db"))
                        assert len(archives) == i + 1 and all(p.read_bytes() == b"prior copy" for p in archives)
                    samples[name].append(sample)
                if job_states:
                    for a, b in zip(*job_states, strict=True):
                        assert a[:-1] == b[:-1] and abs(a[-1] - b[-1]) < 5, (a, b)
            report["workloads"][op] = {
                name: {k: round(statistics.median(row[k] for row in data), 4) for k in ("ms", "cpu_ms", "resident_mib")}
                for name, data in samples.items()
            }
            report["workloads"][op].update(iterations_per_round=count, samples=samples)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path)
    parser.add_argument(
        "--python-extension", type=Path, help="Use the built PyO3 snapshot functions in the Python baseline"
    )
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--rows", type=int, default=50_000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.reference:
        reference(args.reference, args.python_extension)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            report = benchmark(Path(tmp), args.rounds, args.rows, args.python_extension)
        print(json.dumps(report, indent=2))
        if args.output:
            args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
