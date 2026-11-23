"""Benchmark the local HTTP server used by the desktop status, pause and setup controls."""

import argparse
import base64
import hashlib
import http.client
import io
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
from pathlib import Path

import psutil
from benchmark_stats import REPO_ROOT, _configure_bootstrap_environment, _install_noop_logging_module


def serve(root, database_routes, library, areas, imports, media, media_refresh, exports, tadoku, kechimochi, goals):
    _configure_bootstrap_environment(root / "python-home")
    _install_noop_logging_module()
    os.environ["GSM_PROFILE_DIR"] = str(root / "python-home" / "profile")
    Path(os.environ["GSM_PROFILE_DIR"]).mkdir(exist_ok=True)
    os.chdir(root)
    from waitress import create_server

    from GameSentenceMiner.native import mining
    from GameSentenceMiner.web.onboarding_api import register_onboarding_routes
    from GameSentenceMiner.web.texthooking_page import app

    if not any(r.rule == "/api/onboarding/language" for r in app.url_map.iter_rules()):
        register_onboarding_routes(app)
    if database_routes:
        from GameSentenceMiner.web.database_api import register_database_api_routes

        if not any(r.rule == "/api/search-duplicates" for r in app.url_map.iter_rules()):
            register_database_api_routes(app)
    if library:
        from GameSentenceMiner.web import game_profiles
        from GameSentenceMiner.web.routes.game_management_routes import game_management_bp

        if game_management_bp.name not in app.blueprints:
            app.register_blueprint(game_management_bp)
        game_profiles._TESTING = False  # Use the normal 30-second cache in the disposable Flask profile.
    if exports:
        from GameSentenceMiner.web.stats_export_api import register_stats_export_api_routes

        if not any(rule.rule == "/api/stats-export/formats" for rule in app.url_map.iter_rules()):
            register_stats_export_api_routes(app)
    if goals:
        from GameSentenceMiner.util.database.anki_tables import setup_anki_tables
        from GameSentenceMiner.util.database.db import gsm_db
        from GameSentenceMiner.web.goals_api import register_goals_api_routes

        setup_anki_tables(gsm_db)
        if not any(rule.rule == "/api/goals/progress" for rule in app.url_map.iter_rules()):
            register_goals_api_routes(app)
    if kechimochi:
        from GameSentenceMiner.util.cron.kechimochi_sync import run_scheduled_kechimochi_sync
        from GameSentenceMiner.web.kechimochi_api import register_kechimochi_api_routes

        if not any(rule.rule == "/api/kechimochi/settings" for rule in app.url_map.iter_rules()):
            register_kechimochi_api_routes(app)
        app.add_url_rule("/_benchmark/kechimochi-scheduled", view_func=run_scheduled_kechimochi_sync, methods=["POST"])
    if tadoku:
        from benchmark_tadoku_desktop import configure_flask

        from GameSentenceMiner.web.tadoku_api import register_tadoku_api_routes

        configure_flask(app, int(os.environ["GSM_SMOKE_TADOKU_PORT"]))
        if not any(rule.rule == "/api/tadoku/preview" for rule in app.url_map.iter_rules()):
            register_tadoku_api_routes(app)
    if imports:
        from GameSentenceMiner.web.import_api import register_import_api_routes
        from GameSentenceMiner.web.third_party_stats_api import register_third_party_stats_routes

        if not any(r.rule == "/api/import-mokuro" for r in app.url_map.iter_rules()):
            register_third_party_stats_routes(app)
        if not any(r.rule == "/api/import-exstatic" for r in app.url_map.iter_rules()):
            register_import_api_routes(app)
    # Supply the disconnected mining snapshot in memory; exclude external Anki and IPC latency.
    mining.get_mining_status = lambda: {
        "anki_connected": False,
        "anki_beacon_connected": False,
        "words_being_processed": [],
    }
    server = create_server(app, host="127.0.0.1", port=0)
    info = {"port": int(server.effective_port), "pid": os.getpid()}
    if areas:
        from benchmark_ocr_area_selector import configure_flask

        info["ocr_dir"] = str(configure_flask(app, int(os.environ["GSM_SMOKE_AREA_OBS_PORT"])))
    if media:
        from benchmark_game_search import configure_flask

        configure_flask(app, int(os.environ["GSM_SMOKE_MEDIA_PORT"]))
        if media_refresh:
            from benchmark_game_refresh import enable_flask_job

            enable_flask_job()
    if database_routes:
        from GameSentenceMiner.util.database.db import gsm_db

        info["database"] = gsm_db.db_path
    (root / "python.json").write_text(json.dumps(info))
    server.run()


def details(path, process):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            return json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            if process.poll() is not None:
                raise RuntimeError(f"{process.args[0]} exited with code {process.returncode}")
            time.sleep(0.1)
    raise RuntimeError("Server did not announce readiness")


def stop(process):
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=15)


def batch(connection, process, case, count, native):
    path, payload, status, field, expected = case
    method = "GET" if payload is None else "POST"
    if path.startswith("PUT "):
        method, path = path.split(" ", 1)
    body = json.dumps(payload).encode() if isinstance(payload, dict) else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}

    def cpu():
        t = process.cpu_times()
        return t.user + t.system

    start_cpu = cpu()
    start = time.perf_counter()
    for i in range(count):
        if callable(payload):
            request_payload, expected = payload(i)
            body = json.dumps(request_payload).encode()
        connection.request(method, path, body=body, headers=headers)
        reply = connection.getresponse()
        data = reply.read()
        if native:
            assert reply.getheader("x-gsm-handler") == "rust", path
        if isinstance(expected, bytes):
            assert reply.status == status and data == expected, path
        else:
            parsed = json.loads(data)
            assert reply.status == status and parsed[field] == expected, (path, reply.status, parsed)
    elapsed = time.perf_counter() - start
    return {
        "ms": elapsed * 1000 / count,
        "server_cpu_ms": (cpu() - start_cpu) * 1000 / count,
        "server_resident_mib": process.memory_info().rss / 1024**2,
    }


def fixture_databases(root, stack, python_db):
    (rust_db,) = root.glob("gsm-native-smoke-*/pythonless/gsm.db")
    python_db = Path(python_db).resolve()
    assert any(parent.samefile(root) for parent in python_db.parent.resolve().parents)
    # The isolated Flask module initializes its tables lazily. Give both
    # servers the same migrated baseline, including the four smoke rows.
    with closing(sqlite3.connect(rust_db)) as source, closing(sqlite3.connect(python_db)) as target:
        source.backup(target)
    databases = {}
    for name, path in [("rust", rust_db), ("python", python_db)]:
        assert path.is_file() and any(parent.samefile(root) for parent in path.resolve().parents), path
        databases[name] = stack.enter_context(closing(sqlite3.connect(path)))
    return databases


def seed_maintenance(databases, stack):
    rows = [(f"bench-{i}", "Benchmark game", f"台詞{i // 2}", 1700000000 + i) for i in range(4000)]
    for conn in databases.values():
        with conn:
            conn.executemany("INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES(?,?,?,?)", rows)

        def clear(conn=conn):
            with conn:
                conn.executemany("DELETE FROM game_lines WHERE id=?", ((r[0],) for r in rows))

        stack.callback(clear)


def measure_deletions(databases, connections, rounds):
    rows = [(f"edit-{i}", "Deletion fixture", f"台詞{i // 2:03d}", 1700000000 + i) for i in range(800)]
    ids = [row[0] for row in rows]
    remaining = set(ids)
    exact = {row[0] for row in rows if "台詞1" in row[2]}
    cases = [
        ("/api/delete-text-lines", {"exact_text": "台詞1"}, remaining - exact),
        ("/api/deduplicate", {"games": ["Deletion fixture"]}, set(ids[::2])),
        ("/api/deduplicate-entire-game", {"games": ["Deletion fixture"], "preserve_newest": True}, set(ids[1::2])),
        ("/api/delete-sentence-lines", {"line_ids": ids[::3]}, remaining - set(ids[::3])),
    ]
    results = {}
    for path, payload, survivors in cases:
        samples = {name: [] for name in connections}
        for i in range(rounds + 1):
            for name in connections if i % 2 == 0 else reversed(connections):
                db = databases[name]
                try:
                    with db:
                        db.executemany("INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES(?,?,?,?)", rows)
                    sample = batch(
                        *connections[name],
                        (path, payload, 200, "deleted_count", len(rows) - len(survivors)),
                        1,
                        name == "rust",
                    )
                    assert {
                        row[0] for row in db.execute("SELECT id FROM game_lines WHERE game_name='Deletion fixture'")
                    } == survivors
                    if i:
                        samples[name].append(sample)
                finally:
                    with db:
                        db.execute("DELETE FROM game_lines WHERE game_name='Deletion fixture'")
        results[path] = {
            name: {k: round(statistics.median(v[k] for v in rows), 4) for k in rows[0]}
            for name, rows in samples.items()
        }
    return results


def measure_scene_edits(databases, connections, rounds):
    source, target = "Scene benchmark source", "Scene benchmark target"
    source_id, target_id = "scene-bench-source", "scene-bench-target"
    rows = [
        (f"scene-fixture-{i:03d}", source_id, source, "Earlier scene" if i % 2 else None, f"文章{i}", 1700000000 + i)
        for i in range(500)
    ]
    anchor = ("scene-fixture-target", target_id, target, None, "猫", 1700001000)
    ids = [row[0] for row in rows]
    cases = [
        ("/api/migrate-lines", {"line_ids": ids, "target_game": target}, "migrated_count"),
        ("/api/merge_games", {"games_to_merge": [source], "target_game": target}, "lines_moved"),
        ("/api/delete-games", {"game_names": [source]}, "total_sentences_deleted"),
    ]
    columns = "id,game_id,game_name,original_game_name,line_text,timestamp"
    results = {}
    for path, payload, count_field in cases:
        deleting = path == "/api/delete-games"
        expected = (
            [] if deleting else [(k, target_id, target, orig or source, txt, ts) for k, _, _, orig, txt, ts in rows]
        )
        samples = {name: [] for name in connections}
        for i in range(rounds + 1):
            for name in connections if i % 2 == 0 else reversed(connections):
                db = databases[name]
                try:
                    with db:
                        db.executemany(
                            "INSERT INTO games(id,title_original) VALUES(?,?)",
                            [(source_id, source), (target_id, target)],
                        )
                        db.executemany(f"INSERT INTO game_lines({columns}) VALUES(?,?,?,?,?,?)", rows + [anchor])
                    sample = batch(*connections[name], (path, payload, 200, count_field, len(rows)), 1, name == "rust")
                    assert db.execute(
                        f"SELECT {columns} FROM game_lines WHERE id LIKE 'scene-fixture-%' ORDER BY id"
                    ).fetchall() == expected + [anchor]
                    assert db.execute("SELECT count(*) FROM games WHERE id=?", (source_id,)).fetchone()[0] == int(
                        not deleting
                    )
                    if i:
                        samples[name].append(sample)
                finally:
                    with db:
                        db.execute("DELETE FROM game_lines WHERE id LIKE 'scene-fixture-%'")
                        db.execute("DELETE FROM games WHERE id IN (?,?)", (source_id, target_id))
        results[path] = {
            name: {k: round(statistics.median(sample[k] for sample in values), 4) for k in values[0]}
            for name, values in samples.items()
        }
    return results


def library_cases(databases, connections, stack):
    cover = b"GIF89a" + bytes(range(256)) * 256
    stored = base64.b64encode(cover).decode("ascii")
    games = [(f"bench-game-{i:02}", f"図書館 {i:02}", stored) for i in range(64)]
    now = int(time.time())
    lines = [(f"bench-library-{i}", games[i % 64][0], games[i % 64][1], f"台詞{i}", now - i % 60) for i in range(3200)]
    for db in databases.values():
        with db:
            db.executemany("INSERT INTO games(id,title_original,image) VALUES(?,?,?)", games)
            db.executemany("INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES(?,?,?,?,?)", lines)

        def clear(db=db):
            with db:
                db.executemany("DELETE FROM game_lines WHERE id=?", ((r[0],) for r in lines))
                db.executemany("DELETE FROM games WHERE id=?", ((r[0],) for r in games))

        stack.callback(clear)

    path = "/api/games-management?sort=title"
    reports = {}
    for name, (conn, _) in connections.items():
        conn.request("GET", path)
        resp = conn.getresponse()
        assert resp.status == 200 and (name != "rust" or resp.getheader("x-gsm-handler") == "rust"), name
        reports[name] = json.loads(resp.read())
    fixture = lambda report: [g for g in report["games"] if g["id"].startswith("bench-game-")]
    expected = fixture(reports["python"])
    actual = fixture(reports["rust"])
    assert len(expected) == len(actual) == len(games)
    for legacy, native in zip(expected, actual):
        assert legacy == native, {
            key: (legacy.get(key), native.get(key))
            for key in legacy.keys() | native.keys()
            if legacy.get(key) != native.get(key)
        }
    assert all(g["line_count"] == 50 for g in actual)
    assert reports["python"]["summary"] == reports["rust"]["summary"]
    return [
        (path, None, 200, "summary", reports["python"]["summary"]),
        ("/api/orphaned-games", None, 200, "total_orphaned", 0),
        ("/api/games/bench-game-00/image", None, 200, None, cover),
        (
            "PUT /api/games/bench-game-00",
            lambda i: ({"title_english": f"Updated {i % 2}"}, ["title_english"]),
            200,
            "updated_fields",
            None,
        ),
        ("/api/games/bench-game-00/mark-complete", {}, 200, "completed", True),
    ]


def archive_cases(databases):
    entries = []
    for i in range(16):
        game = f"archive-game-{i:02}"
        file_id = hashlib.sha256(game.encode()).hexdigest()
        filename = f"game-読書-{i}--{file_id}.gsm-archive.zip"
        metadata = {
            "format": "gsm-game-archive",
            "version": 1,
            "game_id": game,
            "game_name": f"読書 {i}",
            "game": {"id": game, "image": "A" * 65536},
            "line_count": 0,
        }
        with io.BytesIO() as buffer:
            with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", json.dumps(metadata).encode())
                archive.writestr("game_lines.jsonl", b"")
            contents = buffer.getvalue()
        mtime = 1700000000 + i
        for db in databases.values():
            directory = Path(db.execute("PRAGMA database_list").fetchone()[2]).parent / "archives/games"
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / filename
            path.write_bytes(contents)
            os.utime(path, (mtime, mtime))
        entries.append(
            {
                "file_id": file_id,
                "filename": filename,
                "size_bytes": len(contents),
                "updated_at": mtime,
                "game_id": game,
                "game_name": metadata["game_name"],
                "line_count": 0,
                "can_restore": True,
            }
        )
    return [
        ("/api/database/archive-files", None, 200, "archives", entries[::-1]),
        (f"/api/database/archive-files/{file_id}/download", None, 200, None, contents),
        (
            "PUT /api/database/maintenance",
            {"vacuum_interval_days": 30},
            200,
            "settings",
            {"vacuum_interval_days": 30, "archive_after_days": 0, "last_vacuum": None},
        ),
    ]


def measure_archive_jobs(databases, connections, rounds):
    game = "archive-benchmark"
    file_id = hashlib.sha256(game.encode()).hexdigest()
    source = [(f"bench-{i:05}", game, "試験", f"これは本です。{i}", 1600000000 + i) for i in range(500)]
    paths = {name: Path(db.execute("PRAGMA database_list").fetchone()[2]) for name, db in databases.items()}
    for db in databases.values():
        with db:
            db.execute("INSERT INTO games(id,title_original) VALUES(?,'試験')", (game,))
            db.executemany("INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES(?,?,?,?,?)", source)
    operations = ("archive", "restore", "delete", "vacuum")
    samples = {op: {name: [] for name in connections} for op in operations}

    def invoke(name, path, data):
        conn, proc = connections[name]
        start_cpu = proc.cpu_times()
        start = time.perf_counter()
        conn.request("POST", path, body=json.dumps(data), headers={"Content-Type": "application/json"})
        reply = conn.getresponse()
        job = json.loads(reply.read())
        assert reply.status == 202 and (name != "rust" or reply.getheader("x-gsm-handler") == "rust"), (path, job)
        status_url = f"/api/database/maintenance/jobs/{job['id']}"
        while time.perf_counter() - start < 30:
            conn.request("GET", status_url)
            reply = conn.getresponse()
            job = json.loads(reply.read())
            assert reply.status == 200 and (name != "rust" or reply.getheader("x-gsm-handler") == "rust"), job
            if job["status"] == "completed":
                end_cpu = proc.cpu_times()
                return job["result"], {
                    "ms": (time.perf_counter() - start) * 1000,
                    "server_cpu_ms": (end_cpu.user + end_cpu.system - start_cpu.user - start_cpu.system) * 1000,
                    "server_resident_mib": proc.memory_info().rss / 1024**2,
                }
            assert job["status"] == "running", job
            time.sleep(0.002)
        raise TimeoutError(status_url)

    for name, path in paths.items():
        # Reproduce the independent process lock taken by GSM's legacy scheduler.
        with path.with_suffix(".maintenance.lock").open("a+b") as handle:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            conn = connections[name][0]
            conn.request("POST", "/api/database/vacuum")
            reply = conn.getresponse()
            assert reply.status == 409 and "already running" in json.loads(reply.read())["error"]
    for i in range(rounds + 1):
        archives = {}
        records = {}
        for op in operations:
            for name in connections if i % 2 == 0 else reversed(connections):
                db = databases[name]
                if op == "vacuum":
                    with db:
                        db.execute("CREATE TABLE IF NOT EXISTS archive_bench_free(value BLOB)")
                        db.execute("INSERT INTO archive_bench_free VALUES(zeroblob(1048576))")
                        db.execute("DELETE FROM archive_bench_free")
                endpoint = {
                    "archive": f"/api/games/{game}/archive",
                    "restore": f"/api/database/archive-files/{file_id}/restore",
                    "delete": f"/api/database/archive-files/{file_id}/delete",
                    "vacuum": "/api/database/vacuum",
                }[op]
                result, sample = invoke(name, endpoint, {"confirm": True})
                if i:
                    samples[op][name].append(sample)
                if op == "archive":
                    assert result["archived_lines"] == len(source)
                    archive = paths[name].parent / "archives/games" / result["archive_file"]["filename"]
                    with zipfile.ZipFile(archive) as saved:
                        assert saved.testzip() is None
                        records[name] = [json.loads(v) for v in saved.read("game_lines.jsonl").splitlines()]
                        assert len(records[name]) == len(source) and json.loads(saved.read("manifest.json"))[
                            "line_count"
                        ] == len(source)
                    archives[name] = archive
                    assert db.execute(
                        "SELECT sum(line_count) FROM archived_game_days WHERE game_id=?", (game,)
                    ).fetchone()[0] == len(source)
                elif op == "restore":
                    assert result == {"restored_lines": len(source), "skipped_lines": 0}
                    assert (
                        db.execute(
                            "SELECT id,game_id,game_name,line_text,timestamp FROM game_lines WHERE game_id=? ORDER BY id",
                            (game,),
                        ).fetchall()
                        == source
                    )
                elif op == "delete":
                    assert not archives[name].exists()
                else:
                    assert result["reclaimed_bytes"] >= 512 * 1024
            if op == "archive":
                assert records["python"] == records["rust"]
                extra = archives["rust"].with_suffix(".exchange")
                shutil.copyfile(archives["rust"], extra)
                shutil.copyfile(archives["python"], archives["rust"])
                shutil.copyfile(extra, archives["python"])
                extra.unlink()
    for db in databases.values():
        with db:
            db.execute("DELETE FROM game_lines WHERE game_id=?", (game,))
            db.execute("DELETE FROM games WHERE id=?", (game,))
    return {
        op: {
            name: {k: round(statistics.median(row[k] for row in values), 4) for k in values[0]}
            for name, values in modes.items()
        }
        for op, modes in samples.items()
    }


def run(root, args):
    with ExitStack() as stack:
        logs = stack.enter_context((root / "servers.log").open("w", encoding="utf-8"))
        command = [sys.executable, __file__, "--worker", str(root)]
        env = os.environ.copy()
        if args.jiten_links:
            env["GSM_ENABLE_SUDACHI_USER_DICT"] = "1" if args.sudachi_names else "0"
        if args.areas:
            from benchmark_ocr_area_selector import start_fixture

            env["GSM_SMOKE_AREA_OBS_PORT"] = str(start_fixture(root, stack))
            command.append("--areas")
        elif args.media or args.media_links or args.jiten_links or args.media_refresh or args.repull or args.upgrade:
            from benchmark_game_search import start_fixture

            env["GSM_SMOKE_MEDIA_PORT"] = str(start_fixture(stack))
            if args.media_refresh:
                command.append("--media-refresh")
            else:
                command.append(
                    "--media-links"
                    if args.media_links or args.jiten_links or args.repull or args.upgrade
                    else "--media"
                )
        elif args.exports:
            command.append("--exports")
            env.update(TEMP=str(root), TMP=str(root), TMPDIR=str(root))
        elif args.goals:
            command.append("--goals")
        elif args.kechimochi:
            from benchmark_kechimochi_desktop import start_fixture

            provider = start_fixture(stack)
            command.append("--kechimochi")
        elif args.tadoku:
            from benchmark_tadoku_desktop import start_fixture

            provider = start_fixture(stack)
            env["GSM_SMOKE_TADOKU_PORT"] = str(provider.server_port)
            command.append("--tadoku")
        elif args.imports or args.exstatic or args.kizuna:
            command.append("--imports")
        elif args.library:
            command.append("--library")
        elif args.maintenance or args.settings or args.deletions or args.archives or args.archive_jobs or args.scenes:
            command.append("--maintenance")
        python = subprocess.Popen(command, stdout=logs, stderr=logs, env=env)
        stack.callback(stop, python)
        native = subprocess.Popen(
            ["node", str(REPO_ROOT / "scripts/test-native-desktop.mjs"), "pythonless"],
            env={
                **env,
                "GSM_SMOKE_BENCHMARK_READY": str(root / "rust.json"),
                "GSM_NATIVE_TEST_EXECUTABLE": str(args.desktop.resolve()),
                "GSM_SMOKE_PARENT": str(root),
            },
            stdout=logs,
            stderr=logs,
            cwd=REPO_ROOT,
        )
        fixtures = ExitStack()
        try:
            servers = {"python": details(root / "python.json", python), "rust": details(root / "rust.json", native)}
            connections = {}
            for name, info in servers.items():
                connection = http.client.HTTPConnection("127.0.0.1", info["port"], timeout=6)
                stack.callback(connection.close)
                connections[name] = (connection, psutil.Process(info["pid"]))
            results = {}
            cases = [
                ("/get_status", None, 200, "words_being_processed", []),
                ("/set_text_intake_paused", {"paused": False}, 200, "paused", False),
                ("/api/onboarding/language", {"language": 42}, 400, "error", "Unsupported learning language."),
            ]
            if (
                args.maintenance
                or args.deletions
                or args.library
                or args.archives
                or args.archive_jobs
                or args.scenes
                or args.imports
                or args.exstatic
                or args.kizuna
                or args.media_links
                or args.jiten_links
                or args.media_refresh
                or args.repull
                or args.upgrade
                or args.exports
                or args.tadoku
                or args.kechimochi
                or args.goals
            ):
                databases = fixture_databases(root, fixtures, servers["python"]["database"])
            if args.goals:
                from benchmark_goal_progress import measure

                results = measure(databases, connections, args.rounds, fixtures)
                cases = []
            elif args.kechimochi:
                from benchmark_kechimochi_desktop import measure

                results = measure(databases, connections, args.rounds, fixtures, provider)
                cases = []
            elif args.tadoku:
                from benchmark_tadoku_desktop import measure

                results = measure(databases, connections, args.rounds, fixtures, provider)
                cases = []
            elif args.exports:
                from benchmark_stats_exports import measure

                results = measure(databases, connections, args.rounds, fixtures)
                cases = []
            elif args.upgrade:
                from benchmark_game_refresh import measure_upgrades

                results = measure_upgrades(databases, connections, args.rounds)
                cases = []
            elif args.repull:
                from benchmark_game_refresh import measure_repull

                results = measure_repull(databases, connections, args.rounds)
                cases = []
            elif args.media_refresh:
                from benchmark_game_refresh import measure

                results = measure(databases, connections, args.rounds)
                cases = []
            elif args.jiten_links:
                from benchmark_game_search import measure_jiten_links

                results = measure_jiten_links(
                    databases,
                    connections,
                    args.rounds,
                    int(env["GSM_SMOKE_MEDIA_PORT"]),
                    root if args.sudachi_names else None,
                )
                cases = []
            elif args.media_links:
                from benchmark_game_search import measure_links

                results = measure_links(databases, connections, args.rounds)
                cases = []
            elif args.media:
                from benchmark_game_search import measure

                results = measure(connections, args.rounds, args.requests)
                cases = []
            elif args.kizuna:
                from benchmark_reading_file_imports import measure_kizuna

                results = measure_kizuna(databases, connections, args.rounds)
                cases = []
            elif args.exstatic:
                from benchmark_reading_file_imports import measure_exstatic

                results = measure_exstatic(databases, connections, fixtures, args.rounds)
                cases = []
            elif args.imports:
                from benchmark_reading_file_imports import measure

                results = measure(databases, connections, args.rounds)
                cases = []
            elif args.areas:
                from benchmark_ocr_area_selector import measure

                results = measure(root, servers, connections, args.rounds, args.requests, batch)
                cases = []
            elif args.maintenance:
                seed_maintenance(databases, fixtures)
                cases = [
                    ("/api/preview-text-deletion", {"exact_text": "台詞1"}, 200, "count", 1111),
                    ("/api/preview-deduplication", {"games": ["Benchmark game"]}, 200, "duplicates_count", 2000),
                    ("/api/search-duplicates", {"game": "Benchmark game"}, 200, "duplicates_found", 2000),
                ]
            elif args.scenes:
                results = measure_scene_edits(databases, connections, args.rounds)
                cases = []
            elif args.deletions:
                results = measure_deletions(databases, connections, args.rounds)
                cases = []
            elif args.library:
                cases = library_cases(databases, connections, fixtures)
            elif args.archives:
                cases = archive_cases(databases)
            elif args.archive_jobs:
                results = measure_archive_jobs(databases, connections, args.rounds)
                cases = []
            elif args.settings:
                cases = [
                    ("/api/settings", None, 200, "tadoku_configured", False),
                    ("/api/settings", lambda i: ({"games_target": 98 + i % 2}, 98 + i % 2), 200, "games_target", 98),
                    ("/api/settings", {"games_target": 0}, 400, "error", "Games target must be between 1 and 1,000"),
                ]
            for case in cases:
                samples = {name: [] for name in servers}
                for name, pair in connections.items():
                    batch(*pair, case, 10, name == "rust")
                for i in range(args.rounds):
                    for name in servers if i % 2 == 0 else reversed(servers):
                        samples[name].append(batch(*connections[name], case, args.requests, name == "rust"))
                label = f"{'GET' if case[1] is None else 'POST'} {case[0]} {case[2]}" if args.settings else case[0]
                results[label] = {
                    name: {k: round(statistics.median(v[k] for v in rows), 4) for k in rows[0]}
                    for name, rows in samples.items()
                }
        except Exception:
            logs.flush()
            print((root / "servers.log").read_text(encoding="utf-8", errors="replace")[-3000:], file=sys.stderr)
            raise
        finally:
            fixtures.close()
            (root / "rust.done").touch()
            if native.wait(timeout=150) != 0 and sys.exc_info()[0] is None:
                logs.flush()
                raise RuntimeError((root / "servers.log").read_text(encoding="utf-8", errors="replace")[-3000:])
    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "rounds": args.rounds,
        "requests_per_round": 1
        if args.deletions
        or args.archive_jobs
        or args.scenes
        or args.imports
        or args.exstatic
        or args.kizuna
        or args.media_links
        or args.jiten_links
        or args.media_refresh
        or args.repull
        or args.upgrade
        or args.exports
        or args.tadoku
        or args.kechimochi
        or args.goals
        else args.requests,
        "method": f"Sequential persistent loopback HTTP requests alternating between {args.desktop.parent.name} Rust Tauri and production Flask routes in Waitress. RSS covers the entire server process and excludes children. "
        + (
            "Both databases include the same 4,000 fixture rows. Search includes response serialization and transfer."
            if args.maintenance
            else "Both archive directories contain the same 16 portable ZIPs with 64 KiB embedded covers. Checks compare every catalog field and exact download bytes. Retention writes include SQLite persistence."
            if args.archives
            else "500 sentences per archive, with full production rollups. Samples include job acceptance, execution and polling at 2 ms intervals. Every round compares the complete sentence records and exchanges ZIPs between runtimes before restoring. Vacuum reclaims a disposable 1 MiB allocation. The fixture also verifies mutual exclusion with a separate process."
            if args.archive_jobs
            else "Mokuro multipart upload with a UTF-8 BOM and clear_previous after the file. Compare a 1-volume archive and a 48-volume archive, including 200 page turns and 16 KiB of unrelated metadata per volume. Each round checks the complete response and every persisted daily entry. One warmup per server and file size."
            if args.imports
            else "2,500 ExStatic lines from three existing games, one previously imported using a legacy ID. Measure first upload and retry, including rollup queue submission. Each sample verifies the response, warning, IDs, text, times, languages and game links. Database seeding and verification run outside the timings."
            if args.exstatic
            else "1,000 Kizuna sessions across four existing game aliases with fractional durations, offset timestamps, UTF-8 titles, and an in-file duplicate. Each round replaces a prior import, retries it, compares the complete HTTP response and SQLite rows, and independently calculates all source IDs with Python json.dumps and SHA-256. The timed games have no remote metadata links."
            if args.kizuna
            else "Four loopback provider fixtures return Jiten, VNDB, GSM Cloud IGDB, and AniList search results. Each unified request issues five HTTP requests including both AniList media types. Compare every normalized field and raw record, treating provider completion order as variable. One warmup per operation and server. Remote network latency is excluded."
            if args.media
            else "Link an existing game through the GSM Cloud IGDB HTTP contract on loopback. Include a 600 by 800 transparent cover, thumbnail generation and SQLite commit. Compare every response field, game fields, link ordering, preserved scene, image dimensions and three decoded pixels. Alternate initial linking and explicit metadata overwrite."
            if args.media_links
            else "Time from a Kizuna upload until committed game metadata and portraits are visible. The native desktop uses its scheduler. The Flask fixture dispatches its production Jiten update function on one background thread. Includes provider pacing and polls for SQLite commits every 5 ms. All provider responses come from loopback."
            if args.media_refresh
            else "Repull one game from four local metadata providers. Compare priority rules, manual field overrides, a full JPEG cover and VNDB portraits, and the response when all metadata fields are locked."
            if args.repull
            else "Create, poll and download a Kechimochi CSV through production HTTP. Library includes 48 covers of 16 KiB each, activity includes daily rollups, live lines and imports, and incremental includes a modified historical sentence. Poll every millisecond. Compare entire CSV files and verify partial downloads, validation and cursor persistence."
            if args.exports
            else "Compare previews spanning 2,000 lines from eight games, full syncs with covers, and repeat syncs against independent loopback Kechimochi instances. Check remote media and logs, recovery after a lost POST reply, retained edits, deletions and scheduled retries. Sync timing includes polling for completion."
            if args.kechimochi
            else "Compare complete goal progress responses for current, expired, future, game-scoped, typed, static and exact-time goals, including imported reading, Anki cache counts, and local daylight-saving boundaries."
            if args.goals
            else "Preview 4,000 lines across eight games with global and per-game cursors. Compare the full payload except the wall clock. Exercise sign-in, daily eligibility, receipts for eight logs, and rollback after a rejected second log using a loopback Tadoku service. Sync timing includes polling every millisecond."
            if args.tadoku
            else "Run the public Jiten upgrader against VNDB and AniList lookup fixtures. Include the one-second provider pacing, two successful links and an unmatched game. Compare every result field except elapsed time, cover bytes, stored game fields and character documents."
            if args.upgrade
            else "Link a Jiten deck to an existing scene with 100 sentences, a JPEG cover, and paginated VNDB or AniList characters from loopback providers. Check saved metadata, source portrait bytes, all sentence mappings, and response fields after each commit."
            + (
                " Includes time until the optional per-game Sudachi CSV and metadata file are ready, observed by polling every millisecond."
                if args.sudachi_names
                else ""
            )
            if args.jiten_links
            else "Persistent loopback HTTP to independent Rust desktop and Flask processes. The profile contains 32 legacy OCR area files with pixel coordinates. Reads check the complete browser response. Saves check the original geometry and metadata. The screenshot request traverses an OBS v5 WebSocket fixture returning a 1280x720 JPEG, and checks the decoded image and cache headers."
            if args.areas
            else "Each server handles 500 source sentences and an existing target game. Alternate between release servers after one warmup. Verify surviving IDs, current and original scenes, linked game IDs, text, timestamps and source game metadata outside timings."
            if args.scenes
            else "Both databases contain the same 64 additional games with 64 KiB covers and 3,200 sentences. The first sorted library read compares every field of all 64 games. Flask uses its production profile cache, and repeated calls verify the response or exact cover bytes."
            if args.library
            else "Each request starts with 800 seeded lines in a disposable database. After each response all surviving IDs are checked. Seeding, verification and cleanup are outside timings. Each server receives one warmup per operation."
            if args.deletions
            else "Saves alternate the game target on each request and include profile persistence."
            if args.settings
            else "The disconnected mining status is supplied to Flask in memory. Pause is already false."
        ),
        "medians": results,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--desktop", type=Path)
    parser.add_argument("--worker", type=Path)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--maintenance", action="store_true")
    group.add_argument("--settings", action="store_true")
    group.add_argument("--deletions", action="store_true")
    group.add_argument("--library", action="store_true")
    group.add_argument("--archives", action="store_true")
    group.add_argument("--archive-jobs", action="store_true")
    group.add_argument("--scenes", action="store_true")
    group.add_argument("--areas", action="store_true")
    group.add_argument("--imports", action="store_true")
    group.add_argument("--exstatic", action="store_true")
    group.add_argument("--kizuna", action="store_true")
    group.add_argument("--media", action="store_true")
    group.add_argument("--media-links", action="store_true")
    group.add_argument("--jiten-links", action="store_true")
    group.add_argument("--media-refresh", action="store_true")
    group.add_argument("--repull", action="store_true")
    group.add_argument("--upgrade", action="store_true")
    group.add_argument("--exports", action="store_true")
    group.add_argument("--tadoku", action="store_true")
    group.add_argument("--kechimochi", action="store_true")
    group.add_argument("--goals", action="store_true")
    parser.add_argument(
        "--sudachi-names", action="store_true", help="Verify the optional per-game dictionary from a Jiten link"
    )
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--requests", type=int, default=200)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.sudachi_names and not args.jiten_links:
        parser.error("--sudachi-names requires --jiten-links")
    if args.worker:
        serve(
            args.worker,
            args.maintenance
            or args.settings
            or args.library
            or args.imports
            or args.media_links
            or args.jiten_links
            or args.media_refresh
            or args.exports
            or args.tadoku
            or args.kechimochi
            or args.goals,
            args.library,
            args.areas,
            args.imports or args.media_refresh,
            args.media or args.media_links or args.jiten_links or args.media_refresh,
            args.media_refresh,
            args.exports,
            args.tadoku,
            args.kechimochi,
            args.goals,
        )
    elif args.desktop and args.rounds > 0 and args.requests > 0:
        with tempfile.TemporaryDirectory(prefix="gsm-http-bench-") as temp:
            output = json.dumps(run(Path(temp), args), indent=2)
        print(output)
        if args.output:
            args.output.write_text(output + "\n", encoding="utf-8")
    else:
        parser.error("A release desktop executable and positive sample counts are required")
