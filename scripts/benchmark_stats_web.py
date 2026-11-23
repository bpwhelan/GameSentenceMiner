"""Compare production report handlers and core schema checks on disposable GSM databases."""

import argparse
import gzip
import json
import os
import platform
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
import zipfile
from contextlib import ExitStack, closing
from datetime import UTC, datetime, timedelta
from datetime import time as day_time
from pathlib import Path

import psutil
from benchmark_stats import REPO_ROOT, build_benchmark_client

GOAL_EDITS = ("goal-edit-timed", "goal-edit-settings", "goal-edit-partial")
CHARACTER_ZIP = "/api/yomitan-dict?spoiler_level=1"
ANKI_CHARTS = {
    "/api/anki-reading-impact": 10,
    "/api/anki_kanji_stats": 10,
    "/api/anki_stats_combined?sections=kanji_stats,game_stats": 10,
    "/api/anki_stats_combined?sections=reading_impact": 10,
    "/api/anki_stats_combined": 2,
}


def fixture(directory, rows, *, anki_charts=False):
    now = datetime.now(UTC).astimezone()
    config = {"stats": {"session_gap_seconds": 1800}}
    if anki_charts:
        config["experimental"] = {"enable_experimental_features": True, "enable_tokenization": True}
        config.update(
            {
                "current_profile": "Default",
                "configs": {"Default": {"anki": {"word_field": "Expression", "parent_tag": "Game"}}},
            }
        )
    (directory / "config.json").write_text(json.dumps(config), encoding="utf-8")
    with closing(sqlite3.connect(directory / "gsm.db")) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        sql = REPO_ROOT / "native/gsm-db/migrations"
        conn.executescript((sql / "001_core.sql").read_text())
        conn.execute(
            "INSERT INTO games(id,title_original,obs_scene_name,release_date) VALUES('g','Game','Game','2001-01-01')"
        )
        start = 1_600_000_000
        conn.executemany(
            "INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,language,note_ids) VALUES(?,'g','Game',?,?,'ja',?)",
            ((str(i), "日本語の文章" * 6, start + i * 60, "[123]" if i % 75 == 0 else "[]") for i in range(rows)),
        )
        conn.executemany(
            "INSERT INTO daily_stats_rollup(date,total_characters,total_reading_time_seconds,kanji_frequency_data) VALUES(?,?,'3600',?)",
            (((now.date() - timedelta(days=i)).isoformat(), 1024 + i, '{"日":8}') for i in range(365)),
        )
        conn.execute(
            """UPDATE daily_stats_rollup SET total_lines=35, total_sessions=1, unique_games_played=1,
               total_active_time_seconds=3600, longest_session_seconds=3600, shortest_session_seconds=3600,
               average_session_seconds=3600, average_reading_speed_chars_per_hour=total_characters,
               peak_reading_speed_chars_per_hour=total_characters, games_completed=0, games_started=0,
               anki_cards_created=0, lines_with_screenshots=0, lines_with_audio=0, lines_with_translations=0,
               unique_kanji_seen=1, unique_words_seen=0, max_chars_in_session=total_characters,
               max_time_in_session_seconds=3600, games_played_ids='["g"]'"""
        )
        utc_day = datetime.now(UTC).date()
        goal = json.dumps([{"id": "g", "name": "Daily reading", "metricType": "hours_static", "target": 1}])
        settings = '{"longestStreak":25,"customCheckboxes":{}}'
        conn.execute(
            "INSERT INTO goals(date,current_goals,goals_settings,last_updated) VALUES('current',?,?,?)",
            (goal, settings, 1600000000.5),
        )
        # A seven-day streak, followed by a gap and older completions.
        conn.executemany(
            "INSERT INTO goals(date,current_goals,goals_settings) VALUES(?,?,?)",
            (((utc_day - timedelta(days=i)).isoformat(), goal, settings) for i in range(366) if i != 7),
        )
        reading_day = now.date() - timedelta(days=now.hour < 4)
        noon = datetime.combine(reading_day, day_time(12)).timestamp()
        conn.executemany(
            "INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,language) VALUES(?,'g','Game',?,?,'ja')",
            ((f"today{i}", "日本語の文章", noon + i * 5) for i in range(20)),
        )
        conn.executescript((sql / "001_tracking.sql").read_text())
        conn.executescript((sql / "vocabulary_001_tables.sql").read_text())
        conn.executescript((sql / "vocabulary_001_indexes.sql").read_text())
        for i in range(400):
            nid = 1600000000000 + i
            conn.execute(
                "INSERT INTO anki_notes(note_id,model_name,fields_json,tags,mod) VALUES(?,'test','{}',?,100)",
                (nid, json.dumps(["Game::VN", "NSFW"] if i % 4 == 0 else ["Game::VN"])),
            )
            conn.execute("INSERT INTO anki_cards(card_id,note_id) VALUES(?,?)", (nid, nid))
            conn.execute(
                "INSERT INTO anki_reviews(review_id,note_id,card_id,review_time,ease,time_taken) VALUES(?,?,?,?,?,?)",
                (nid, nid, nid, nid, 1 if i % 5 == 0 else 3, 5000),
            )
        conn.execute("UPDATE anki_notes SET synced_at=1600000000.125")
        if anki_charts:
            conn.execute("""UPDATE daily_stats_rollup SET game_activity_data=json_object('g',
                json_object('title','VN','chars',CAST(total_characters AS INTEGER),'time',3600))""")
            conn.execute("""UPDATE anki_notes SET fields_json=json_object('Expression',
                json_object('value','日本語'||(rowid%200)))""")
            first_review = int((now - timedelta(days=301)).timestamp() * 1000)
            conn.execute("UPDATE anki_reviews SET interval=25,review_time=?+(rowid%300)*86400000", (first_review,))
            conn.execute("INSERT INTO kanji(id,character) VALUES(1,'日'),(2,'本')")
            conn.execute("INSERT INTO card_kanji_links(card_id,kanji_id) SELECT card_id,1+(rowid%2) FROM anki_cards")
        conn.execute(
            "INSERT INTO cron_table(name,schedule,enabled,next_run) VALUES('anki_card_sync','daily',1,1700000000)"
        )
        conn.commit()


def reference(directory):
    client = build_benchmark_client(
        directory / "gsm.db", directory / "bootstrap", include_anki=True, include_goals=True
    )
    from flask import render_template

    from GameSentenceMiner.util.database import db
    from GameSentenceMiner.util.database.cron_table import CronTable
    from GameSentenceMiner.web.database_api import register_database_api_routes
    from GameSentenceMiner.web.goals_projection_api import register_goals_projection_api_routes
    from GameSentenceMiner.web.third_party_stats_api import register_third_party_stats_routes
    from GameSentenceMiner.web.yomitan_api import register_yomitan_api_routes

    app = client.client.application
    register_database_api_routes(app)
    register_goals_projection_api_routes(app)
    register_third_party_stats_routes(app)
    register_yomitan_api_routes(app)

    @app.get("/search")
    def search():
        return render_template("search.html")

    os.environ["GSM_TEST_DATA_ROOT"] = str(directory)
    writer = db.SQLiteDB(str(directory / "gsm.db"))
    db.GoalsTable.set_db(writer)
    CronTable.set_db(writer)
    if "experimental" in json.loads((directory / "config.json").read_text()):
        from GameSentenceMiner.util.config.configuration import get_config, get_master_config

        profile = get_config()
        experimental = get_master_config().experimental
        experimental.enable_experimental_features = experimental.enable_tokenization = True
        profile.anki.word_field = "Expression"
        profile.anki.parent_tag = "Game"
    print(f"ready {os.getpid()}", flush=True)
    try:
        for line in sys.stdin:
            url, count, verify = json.loads(line)
            edit = (directory / (url + ".json")).read_bytes() if url in (*GOAL_EDITS, "import-stats-500") else None
            setup_seconds = 0.0
            started = time.perf_counter()
            for _ in range(count):
                if edit is not None:
                    response = client.client.post(
                        "/api/import-stats" if url == "import-stats-500" else "/api/goals/update",
                        data=edit,
                        content_type="application/json",
                        headers={"X-Timezone": "America/New_York"},
                    )
                    if response.status_code != 200:
                        raise RuntimeError(response.data)
                    body = response.data
                elif url == "schema":
                    for model in db._DATABASE_TABLE_CLASSES:
                        model.set_db(writer)
                    db._migrate_legacy_core_schema()
                    body = b"null"
                elif url == "vocabulary-schema":
                    from GameSentenceMiner.util.database import anki_tables as anki
                    from GameSentenceMiner.util.database import tokenization_tables as vocab

                    for model in [
                        vocab.WordsTable,
                        vocab.KanjiTable,
                        vocab.WordOccurrencesTable,
                        vocab.KanjiOccurrencesTable,
                    ]:
                        model.set_db(writer)
                    vocab.create_tokenization_indexes(writer)
                    anki.setup_anki_tables(writer)
                    vocab.create_tokenization_trigger(writer)
                    body = b"null"
                elif url == "complete-dailies":
                    reset = time.perf_counter()
                    writer.execute(
                        "DELETE FROM goals WHERE date=?", (datetime.now(UTC).date().isoformat(),), commit=True
                    )
                    setup_seconds += time.perf_counter() - reset
                    response = client.client.post("/api/goals/complete_todays_dailies")
                    if response.status_code != 200:
                        raise RuntimeError(response.data)
                    body = response.data
                elif url == "backup":
                    raw = directory / "snapshot.tmp.db"
                    packed = directory / "snapshot.tmp.gz"
                    db._create_sqlite_backup(str(directory / "gsm.db"), str(raw))
                    db._gzip_file(str(raw), str(packed))
                    db.durable_replace(packed, directory / "snapshot.db.gz")
                    raw.unlink()
                    body = b"null"
                elif url == "replace-500":
                    # The previous production import committed one ORM object at a time.
                    from GameSentenceMiner.util.database.third_party_stats_table import ThirdPartyStatsTable

                    cleared = ThirdPartyStatsTable.delete_by_source("bench")
                    for i in range(500):
                        ThirdPartyStatsTable(
                            date="2026-01-01",
                            characters_read=i + 1,
                            time_read_seconds=60.0,
                            source="bench",
                            label="fixture",
                        ).save()
                    body = json.dumps({"imported": 500, "cleared": cleared}).encode()
                else:
                    response = client.client.get(url)
                    if response.status_code != 200:
                        raise RuntimeError(f"{url} returned {response.status_code}: {response.data[:150]}")
                    body = response.data
            ms = (time.perf_counter() - started - setup_seconds) * 1000 / count
            if verify and url == CHARACTER_ZIP:
                (directory / "python.zip").write_bytes(body)
            value = json.loads(body) if verify and url not in ("/search", CHARACTER_ZIP) else None
            print(json.dumps({"ms": ms, "bytes": len(body), "result": value}), flush=True)
    finally:
        writer.close()
        client.close()


def start_worker(stack, command):
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
    )

    def stop():
        process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait()
        process.stdout.close()

    stack.callback(stop)
    for line in process.stdout:
        if line.startswith("ready "):
            return process, psutil.Process(int(line.split()[1]))
    raise RuntimeError(f"Worker failed to start ({process.wait()})")


def measure(worker, url, count, *, verify=False):
    process, stats = worker

    def cpu():
        times = stats.cpu_times()
        return times.user + times.system

    before = cpu()
    process.stdin.write(json.dumps([url, count, verify]) + "\n")
    process.stdin.flush()
    for line in process.stdout:
        if line.startswith('{"'):
            result = json.loads(line)
            result["cpu_ms"] = (cpu() - before) * 1000 / count
            mem = stats.memory_info()
            # Peak working set for this worker's lifetime on Windows; current RSS elsewhere.
            result["resident_mib"] = getattr(mem, "peak_wset", mem.rss) / (1024**2)
            return result
    raise RuntimeError(f"Benchmark worker exited ({process.wait()}) for {url}")


def index_cost(directories, rounds):
    samples = {name: [] for name in directories}
    evidence = {}
    with ExitStack() as stack:
        conns = {}
        for name, root in directories.items():
            conn = stack.enter_context(closing(sqlite3.connect(root / "gsm.db")))
            conn.execute("PRAGMA synchronous=FULL")
            conns[name] = conn
            evidence[name] = {
                "journal_mode": conn.execute("PRAGMA journal_mode").fetchone()[0],
                "database_bytes": conn.execute(
                    "SELECT page_count*page_size FROM pragma_page_count,pragma_page_size"
                ).fetchone()[0],
                "compressed_snapshot_bytes": (root / "snapshot.db.gz").stat().st_size,
            }
        for i in range(rounds):
            for name in ("rust", "python") if i % 2 else ("python", "rust"):
                rows = [(f"new-{i}-{j}", 2_000_000_000 + i * 64 + j) for j in range(64)]
                conn = conns[name]
                wall, cpu = time.perf_counter(), time.process_time()
                with conn:
                    conn.executemany(
                        "INSERT INTO game_lines(id,timestamp,line_text,language,game_name,game_id) VALUES(?,?,'日本語','ja','Game','g')",
                        rows,
                    )
                samples[name].append(((time.perf_counter() - wall) * 1000, (time.process_time() - cpu) * 1000))
        for name, sample in samples.items():
            evidence[name]["capture_batch_64_ms"] = round(statistics.median(wall for wall, _ in sample), 4)
            evidence[name]["capture_batch_64_cpu_ms"] = round(statistics.median(cpu for _, cpu in sample), 4)
        evidence["dashboard_query_plans"] = {
            column: [
                row[-1]
                for row in conns["rust"].execute(
                    f"EXPLAIN QUERY PLAN SELECT line_text FROM game_lines WHERE {column} BETWEEN ? AND ? ORDER BY {column}",
                    (1, 2),
                )
            ]
            for column in ("CAST(timestamp AS REAL)", "timestamp")
        }
    return evidence


def goal_edit_benchmark(executable, rounds, output):
    goals = [
        {
            "id": f"goal-{i}",
            "name": f"読む {i}",
            "metricType": "characters",
            "target": 200 + i,
            "startDate": "2025-11-02T01:30:00-04:00",
            "endDate": "2025-11-02T01:15:00-05:00",
        }
        for i in range(100)
    ]
    edits = [
        {"current_goals": goals},
        {"goals_settings": {"easyDays": {"monday": 25, "sunday": 100}, "customCheckboxes": {"one": False}}},
        {"partial_settings": {"easyDays": {"monday": 50}, "customCheckboxes": {"two": True}}},
    ]
    iterations = 40
    report = {"platform": platform.platform(), "rounds": rounds, "iterations": iterations, "workloads": {}}
    with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
        workers = {}
        for name in ("rust", "python"):
            root = Path(temp) / name
            root.mkdir()
            fixture(root, 0)
            for key, edit in zip(GOAL_EDITS, edits, strict=True):
                (root / (key + ".json")).write_bytes(json.dumps(edit, ensure_ascii=False).encode())
            cmd = (
                [str(executable), str(root)] if name == "rust" else [sys.executable, __file__, "--reference", str(root)]
            )
            workers[name] = start_worker(stack, cmd)
        for key in GOAL_EDITS:
            samples = {name: [] for name in workers}
            persisted = {}
            for name, worker in workers.items():
                answer = measure(worker, key, 1, verify=True)["result"]
                assert answer["success"] and answer["last_updated"] > 0
                with closing(sqlite3.connect(Path(temp) / name / "gsm.db")) as db:
                    row = db.execute(
                        "SELECT current_goals,goals_settings,goals_version FROM goals WHERE date='current'"
                    ).fetchone()
                    persisted[name] = [json.loads(value) if value else None for value in row]
            assert persisted["rust"] == persisted["python"] and persisted["rust"][0] == goals
            if key == "goal-edit-partial":
                assert persisted["rust"][1]["easyDays"] == {"monday": 50, "sunday": 100}
                assert persisted["rust"][1]["customCheckboxes"] == {"one": False, "two": True}
            for i in range(rounds):
                for name in ("rust", "python") if i % 2 else ("python", "rust"):
                    sample = measure(workers[name], key, iterations)
                    samples[name].append({k: round(sample[k], 4) for k in ("ms", "cpu_ms", "resident_mib")})
            summary = {
                name: {k: statistics.median(s[k] for s in series) for k in series[0]}
                for name, series in samples.items()
            }
            print(key, summary, flush=True)
            report["workloads"][key] = {"summary": summary, "samples": samples}
    if output:
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--exe", type=Path)
    parser.add_argument("--goal-edits", action="store_true")
    parser.add_argument("--only", action="append", help="Benchmark one report URL (repeatable)")
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--rows", type=int, default=50_000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.reference:
        return reference(args.reference)
    suffix = ".exe" if os.name == "nt" else ""
    executable = args.exe or REPO_ROOT / f"src-tauri/target/native-dev/release/examples/report_benchmark{suffix}"
    if args.goal_edits:
        return goal_edit_benchmark(executable, args.rounds, args.output)
    urls = {
        "/api/yomitan-index": 20,
        "/api/stats": 10,
        "/api/goals-projection": 5,
        "/api/goals/current": 100,
        "/api/goals/reading-pace": 40,
        "/api/goals/latest_goals": 100,
        "/api/goals/current_streak": 50,
        "complete-dailies": 10,
        "/api/stats/all-lines-data": 10,
        "/api/game/g/stats": 5,
        "/api/games/g/archive": 20,
        "/api/stats/kanji-grid": 5,
        "/api/daily-activity": 100,
        "/api/kanji-frequency?kanji=%E6%97%A5": 30,
        "/api/mining_heatmap": 2,
        "/api/stats/game-milestones": 50,
        "/api/today-stats": 50,
        "/api/anki_game_stats": 20,
        "/api/anki_sync_status": 2000,
        **ANKI_CHARTS,
        "/api/anki_earliest_date": 50,
        "/api/anki_nsfw_sfw_retention": 20,
        "/api/kanji-sorting-configs": 100,
        "/search": 100,
        "schema": 25,
        "vocabulary-schema": 25,
        "replace-500": 2,
        "/api/third-party-stats?source=bench": 10,
        "/api/third-party-stats/summary": 50,
        "backup": 1,
    }
    report = {
        "platform": platform.platform(),
        "python_version": platform.python_version(),
        "rust_version": subprocess.check_output(["rustc", "--version"], text=True).strip(),
        "logical_cpus": psutil.cpu_count(),
        "historical_lines": args.rows,
        "live_lines": 20,
        "rollup_days": 365,
        "goal_history_days": 365,
        "anki_notes": 400,
        "rounds": args.rounds,
        "initialization": {},
        "workloads": {},
    }
    with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
        directory = Path(temp)
        # Independent copies let each startup benchmark use its own schema and indexes.
        workers = {}
        for name in ("python", "rust"):
            root = directory / name
            root.mkdir()
            fixture(root, args.rows, anki_charts=any(url in ANKI_CHARTS for url in (args.only or urls)))
            if any(url in ("/api/yomitan-index", CHARACTER_ZIP) for url in (args.only or urls)):
                with closing(sqlite3.connect(root / "gsm.db")) as db:
                    characters = [
                        {
                            "id": str(i),
                            "name": "Tsumugi Wenders",
                            "name_original": f"紬 ヴェンダース{i}",
                            "description": "人物紹介 [url=https://example.com]Link[/url] [spoiler]secret[/spoiler]",
                            "personality": [{"name": "Calm", "spoiler": 0}, {"name": "Hidden", "spoiler": 2}],
                            "role": "main",
                            "birthday": [9, 1],
                            "sex": "f",
                            "height": 165,
                            "aliases": [f"別名{i}"],
                        }
                        for i in range(8)
                    ]
                    characters[0]["image_base64"] = (
                        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
                    )
                    db.execute(
                        "UPDATE games SET vndb_character_data=?", (json.dumps({"characters": {"main": characters}}),)
                    )
                    db.commit()
            if "import-stats-500" in (args.only or []):
                entries = [
                    {
                        "date": "2026-11-20",
                        "characters_read": i + 1,
                        "time_read_seconds": 2.5,
                        "source": "日記",
                        "label": "読書",
                    }
                    for i in range(500)
                ]
                (root / "import-stats-500.json").write_bytes(
                    json.dumps({"clear_source": "日記", "entries": entries}, ensure_ascii=False).encode()
                )
            cmd = (
                [sys.executable, __file__, "--reference", str(root)]
                if name == "python"
                else [str(executable), str(root)]
            )
            workers[name] = start_worker(stack, cmd)
        for name, worker in workers.items():
            report["initialization"][name] = {}
            for operation in ("schema", "vocabulary-schema"):
                sample = measure(worker, operation, 1)
                report["initialization"][name][operation] = {
                    k: round(sample[k], 4) for k in ("ms", "cpu_ms", "resident_mib")
                }
        repetitions = {**urls, "import-stats-500": 20, CHARACTER_ZIP: 1}
        selected = {url: repetitions[url] for url in args.only} if args.only else urls
        for url, count in selected.items():
            samples = {name: [] for name in workers}
            checks = [measure(worker, url, 1, verify=True) for worker in workers.values()]
            if url == CHARACTER_ZIP:
                print("Archive bytes", {k: v["bytes"] for k, v in zip(workers, checks, strict=True)}, flush=True)
                with (
                    zipfile.ZipFile(directory / "python/python.zip") as old,
                    zipfile.ZipFile(directory / "rust/rust.zip") as new,
                ):
                    assert set(old.namelist()) == set(new.namelist())
                    assert "term_bank_2.json" in new.namelist()
                    for name in old.namelist():
                        if name.endswith(".json"):
                            assert json.loads(old.read(name)) == json.loads(new.read(name)), name
                        else:
                            assert old.read(name) == new.read(name), name
            if url == "/api/third-party-stats?source=bench":
                for check in checks:
                    for entry in check["result"]["entries"]:
                        # Each worker imports its own rows on a different clock tick.
                        assert entry.pop("created_at") > 0
            if checks[0]["result"] != checks[1]["result"]:
                raise AssertionError(f"Payload mismatch for {url}: {str(checks)[:1500]}")
            if url == "/api/anki-reading-impact":
                result = checks[0]["result"]
                assert sum(result["mature_words"]) == 200 and sum(result["mature_kanji"]) == 2
                assert result["per_game"][0]["card_count"] == 400
            for i in range(args.rounds):
                for name in ("rust", "python") if i % 2 else ("python", "rust"):
                    samples[name].append(measure(workers[name], url, count))
            result = {
                name: {k: round(statistics.median(r[k] for r in data), 4) for k in ("ms", "cpu_ms", "resident_mib")}
                for name, data in samples.items()
            }
            report["workloads"][url] = {"iterations_per_round": count, **result}
            if args.only:
                report["workloads"][url]["samples"] = {
                    name: [{k: round(s[k], 4) for k in ("ms", "cpu_ms", "resident_mib")} for s in series]
                    for name, series in samples.items()
                }
            print(url, result, flush=True)
        if args.only:
            if args.output:
                args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            return
        for name in workers:
            root = directory / name
            with gzip.open(root / "snapshot.db.gz", "rb") as backup, (root / "restore.db").open("wb") as restore:
                shutil.copyfileobj(backup, restore)
            with closing(sqlite3.connect(root / "restore.db")) as conn:
                assert conn.execute("PRAGMA quick_check").fetchone() == ("ok",)
                assert conn.execute("SELECT count(*) FROM game_lines").fetchone() == (args.rows + 20,)
                assert conn.execute(
                    "SELECT count(*),sum(characters_read) FROM third_party_stats WHERE source='bench'"
                ).fetchone() == (500, 125250)
        report["storage_and_writes"] = index_cost({name: directory / name for name in workers}, args.rounds)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
