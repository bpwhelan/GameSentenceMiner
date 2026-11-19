"""Compare managed vocabulary indexing with the previous Python worker on disposable profiles."""

import argparse
import hashlib
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.benchmark_mining_history import setup_worker

TEXTS = (
    "「今日も日本語の本を読んでいる。」",
    " <b>猫</b>と猫～犬が走った！[sound:日本.ogg]",
    "[[type:漢字]]空を見る。\n𠀀㐀",
    "ええと、これはゲームの物語です。",
    "読む、読んだ、読める。ABC123",
    "[sound:声]",
)


def worker(mode, case):
    profile = Path(os.environ["GSM_PROFILE_DIR"])
    with setup_worker(profile) as db:
        try:
            return measure_worker(profile, db, mode, case)
        finally:
            from GameSentenceMiner.util.database.db import gsm_db

            gsm_db.close()


def measure_worker(profile, db, mode, case):
    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.util.config.configuration import get_config, get_master_config
    from GameSentenceMiner.util.cron import tokenize_lines
    from GameSentenceMiner.util.database import tokenization_tables as tables
    from GameSentenceMiner.util.database.db import GameLinesTable
    from GameSentenceMiner.util.text_log import GameLine

    get_config()
    config = get_master_config().experimental
    config.enable_experimental_features = config.enable_tokenization = True
    config.tokenization_sudachi_dictionary = "small"
    db.execute("ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0", commit=True)
    for table in (tables.WordsTable, tables.KanjiTable, tables.WordOccurrencesTable, tables.KanjiOccurrencesTable):
        table.set_db(db)
    tables.create_tokenization_indexes(db)
    tables.create_tokenization_trigger(db)
    endpoint = json.loads((profile / "electron/agent-control.json").read_text())
    bus = bus_client.start_bus(client_id="backend", port=endpoint["port"], token=endpoint["token"])
    assert bus.wait_connected(5)
    os.environ.update(
        GSM_CLIENT_ID="backend",
        GSM_NATIVE_HISTORY="1",
        GSM_NATIVE_WORD_INDEX=str(int(mode == "rust" or case == "scheduled")),
    )
    desktop = psutil.Process(endpoint["pid"])
    helper = next(p for p in desktop.children(recursive=True) if p.name().startswith("gsm_overlay_server"))
    port = next(c.laddr.port for c in helper.net_connections("tcp") if c.status == psutil.CONN_LISTEN)
    os.environ["GSM_INPUT_SERVER_URL"] = f"ws://127.0.0.1:{port}"
    from GameSentenceMiner.sudachi import sudachi

    sudachi.endpoint = os.environ["GSM_INPUT_SERVER_URL"]
    backend = psutil.Process()
    processes = [desktop, helper, backend]

    def cpu(processes):
        return sum(p.cpu_times().user + p.cpu_times().system for p in processes)

    def snapshot():
        return [*processes, *[p for p in backend.children() if p.name().lower().startswith("python")]]

    def lines(start, size):
        return [
            GameLine(
                str(i),
                TEXTS[i % len(TEXTS)],
                datetime.fromtimestamp(1700000000 + i, UTC),
                None,
                None,
                scene="Index",
            )
            for i in range(start, start + size)
        ]

    def capture(batch):
        GameLinesTable.add_lines(batch)
        # Same externally observable completion test for both routes. The legacy
        # scheduler's wait_for_idle sleeps in 10ms increments.
        end = time.monotonic() + 30
        while db.fetchone("SELECT count(*) FROM game_lines WHERE tokenized=0")[0]:
            if time.monotonic() >= end:
                raise TimeoutError("Some captured lines were not indexed")
            time.sleep(0.001)

    def measure(fn):
        initial = cpu(snapshot())
        start = time.perf_counter()
        fn()
        wall = time.perf_counter() - start
        live = snapshot()
        return {
            "wall_ms": wall * 1000,
            "cpu_ms": (cpu(live) - initial) * 1000,
            "uss_mib": sum(p.memory_full_info().uss for p in live) / 2**20,
            "additional_python_workers": len(live) - len(processes),
        }

    try:
        if case == "scheduled":
            from scripts.benchmark_word_backfill import scheduled

            metrics = scheduled(profile, db, bus, config, lines, measure, mode)
        elif case == "capture":
            cold = measure(lambda: capture(lines(0, 1)))
            assert cold["additional_python_workers"] == (mode == "python")

            def singles():
                for i in range(32):
                    capture(lines(1 + i, 1))

            warm = measure(singles)
            for key in ("wall_ms", "cpu_ms"):
                warm[key] /= 32
            bulk = measure(lambda: capture(lines(33, 256)))
            large = measure(lambda: capture(lines(289, 4352)))
            metrics = {
                "first_line": cold,
                "one_line": warm,
                "import_256": bulk,
                "import_4352": large,
            }
        elif case == "backfill":
            batch = lines(0, 512)
            db.executemany(
                "INSERT INTO game_lines(id,line_text,timestamp) VALUES(?,?,?)",
                [(l.id, l.text, l.time.timestamp()) for l in batch],
                commit=True,
            )
            # Seed a dangling word and occurrence so cleanup rebuilds the rank cache.
            db.execute("INSERT INTO words(id,word) VALUES(1000,'孤児')", commit=True)
            db.execute("INSERT INTO word_occurrences(word_id,line_id) VALUES(1000,'removed')", commit=True)

            def backfill():
                result = tokenize_lines.run_tokenize_backfill()
                assert (result["processed"], result["errors"], result["orphans_cleaned"]) == (512, 0, 2), result

            metrics = {"backfill_512": measure(backfill)}
        else:

            def seed(conn):
                conn.executemany(
                    "INSERT INTO game_lines(id,timestamp,tokenized) VALUES(?,?,1)",
                    [(str(i), 1700000000 + i // 2) for i in range(4096)],
                )
                conn.executemany("INSERT INTO words(id,word) VALUES(?,?)", [(i + 1, f"項目{i}") for i in range(4096)])
                conn.executemany(
                    "INSERT INTO word_occurrences(word_id,line_id) VALUES(?,?)",
                    ((i + 1, str((i + j * 37) % 4096)) for i in range(4096) for j in range(8)),
                )
                conn.execute("CREATE TABLE archived_word_stats(word_id INTEGER, first_seen REAL,first_line_id TEXT)")
                conn.execute("CREATE INDEX archive_word ON archived_word_stats(word_id)")
                conn.executemany(
                    "INSERT INTO archived_word_stats VALUES(?,1,'archived')", [(i + 1,) for i in range(0, 4096, 4)]
                )

            db.run_transaction(seed)

            def repair():
                assert tables.recompute_word_first_seen_metadata(db, only_missing=True) == 4096

            metrics = {"repair_4096": measure(repair)}
            assert db.fetchone("SELECT count(*) FROM words WHERE first_seen_line_id='archived'")[0] == 1024
        digest = hashlib.sha256()
        for table, order in [
            ("words", "id"),
            ("kanji", "id"),
            ("word_occurrences", "id"),
            ("kanji_occurrences", "id"),
            ("word_stats_cache", "word_id"),
        ]:
            rows = db.fetchall(
                f"SELECT * FROM {table} ORDER BY {order}" + (",line_id" if table.endswith("_occurrences") else "")
            )
            assert rows or (case == "repair" and table in ("kanji", "kanji_occurrences")), table
            digest.update(json.dumps(rows, ensure_ascii=False).encode())
        assert db.fetchone("SELECT count(*) FROM game_lines WHERE tokenized=0")[0] == 0
        print(json.dumps({"metrics": metrics, "digest": digest.hexdigest()}), flush=True)
    finally:
        tokenize_lines.stop_realtime_tokenization()
        sudachi.close()
        db.close()
        bus.stop()


def sample(desktop, dictionary, mode, case):
    with TemporaryDirectory() as folder:
        profile = Path(folder)
        dest = profile / "sudachi/v20260116-small/system_small.dic"
        dest.parent.mkdir(parents=True)
        shutil.copyfile(dictionary, dest)
        env = {
            **os.environ,
            "GSM_APP_ROOT": str(ROOT),
            "GSM_SMOKE_TEST": "1",
            "GSM_PROFILE_DIR": folder,
            "GSM_DATA_DIR": folder,
            "GSM_SHARED_DATA_DIR": folder,
        }
        for name in ("GSM_TEST_RESULT", "GSM_INPUT_SERVER_URL"):
            env.pop(name, None)
        child = subprocess.Popen([desktop], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 30
            while not (profile / "electron/agent-control.json").is_file():
                if child.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("Fixture desktop did not start")
                time.sleep(0.05)
            output = subprocess.check_output(
                [sys.executable, __file__, "--worker", mode, "--case", case], env=env, cwd=ROOT, timeout=180
            )
            return json.loads(output.splitlines()[-1])
        finally:
            child.terminate()
            child.wait(timeout=15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", choices=["python", "rust"], help=argparse.SUPPRESS)
    parser.add_argument("--case", choices=["capture", "backfill", "repair", "scheduled"])
    parser.add_argument(
        "--previous-desktop", type=Path, help="Previous optimized desktop for the scheduled-job comparison"
    )
    parser.add_argument("--dictionary", type=Path, help="Installed v20260116 system_small.dic")
    parser.add_argument("--desktop", type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--batch-log", type=Path, help="Include output of the release Rust batch-size benchmark")
    args = parser.parse_args()
    if args.worker:
        worker(args.worker, args.case)
        return
    if not args.dictionary or not args.dictionary.is_file() or args.rounds < 1:
        parser.error("Supply an installed --dictionary and a positive number of rounds")
    desktop = args.desktop or Path(
        subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                "import {nativeExecutable} from './scripts/native-paths.mjs'; console.log(nativeExecutable())",
            ],
            cwd=ROOT,
            text=True,
        ).strip()
    )
    report = {"platform": platform.platform(), "python": platform.python_version(), "cases": {}}
    if args.batch_log:
        samples = [
            json.loads(line.split("MEASURE ", 1)[1])
            for line in args.batch_log.read_text(encoding="utf-8-sig").splitlines()
            if "MEASURE " in line
        ]
        assert len(samples) == 20, "Expected five runs at each of four batch sizes"
        report["sqlite_batches"] = samples
    for name, path in [("desktop", desktop), ("dictionary", args.dictionary)]:
        with path.open("rb") as f:
            report[name + "_sha256"] = hashlib.file_digest(f, "sha256").hexdigest()
    if args.case == "scheduled":
        if not args.previous_desktop or not args.previous_desktop.is_file():
            parser.error("--case scheduled requires --previous-desktop from before the backfill migration")
        with args.previous_desktop.open("rb") as f:
            report["previous_desktop_sha256"] = hashlib.file_digest(f, "sha256").hexdigest()
    for case in [args.case] if args.case else ["capture", "backfill", "repair"]:
        modes = {"python": [], "rust": []}
        for turn in range(args.rounds):
            for mode in list(modes)[:: (-1 if turn % 2 else 1)]:
                executable = args.previous_desktop if case == "scheduled" and mode == "python" else desktop
                modes[mode].append(sample(executable, args.dictionary, mode, case))
            assert modes["python"][-1]["digest"] == modes["rust"][-1]["digest"], modes
        for mode, runs in modes.items():
            for key in runs[0]["metrics"]:
                samples = [s["metrics"][key] for s in runs]
                median = {k: round(statistics.median(s[k] for s in samples), 3) for k in samples[0]}
                report["cases"].setdefault(key, {})[mode] = {
                    "median": median,
                    "samples": samples,
                    "digest": runs[0]["digest"],
                }
                print(key, mode, median, flush=True)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__mp_main__":
    # The isolated test environment normally points spawned workers at
    # database/gsm_test.db. Bind this worker to the same disposable gsm.db
    # as the desktop, retaining SQLiteDB's test-root protection.
    from GameSentenceMiner.util.database import db as database

    database.gsm_db = database.SQLiteDB(str(Path(os.environ["GSM_TEST_DATA_ROOT"]) / "gsm.db"))
elif __name__ == "__main__":
    main()
