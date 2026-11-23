"""Tadoku desktop and Flask parity measurements in disposable profiles."""

import http.server
import json
import statistics
import threading
import time

from benchmark_stats_exports import request


def configure_flask(app, port):
    import requests

    from GameSentenceMiner.util import tadoku_sync
    from GameSentenceMiner.web import tadoku_api

    base = f"http://127.0.0.1:{port}"
    tadoku_sync.TADOKU_API_BASE_URL = base + "/api/internal/immersion/"
    tadoku_sync.TADOKU_AUTH_BASE_URL = base + "/api/internal/identity/"
    tadoku_sync.TADOKU_ORIGIN = base

    class FixtureClient(tadoku_sync.TadokuClient):
        def __init__(self, *args, **kwargs):
            session = requests.Session()
            session.trust_env = False
            super().__init__(*args, session=session, **kwargs)
            # Production scopes the saved cookie to HTTPS on tadoku.app.
            # This fixture replaces that origin with plain loopback HTTP.
            if self.session_cookie:
                token = self.session_cookie
                self._clear_session_cookie()
                session.cookies.set("tadoku_session", token, domain="127.0.0.1", path="/")

    tadoku_sync.TadokuClient = tadoku_api.TadokuClient = FixtureClient
    from GameSentenceMiner.util.cron.tadoku_sync import run_scheduled_tadoku_sync

    # Waitress in this isolated harness serves requests without a cron worker.
    app.add_url_rule("/_benchmark/tadoku-daily", view_func=run_scheduled_tadoku_sync, methods=["POST"])


def start_fixture(stack):
    class Provider(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        disable_nagle_algorithm = True

        def log_message(self, *args):
            pass

        def handle(self):
            try:
                super().handle()
            except ConnectionResetError:
                # The desktop smoke closes its pooled connections at shutdown.
                pass

        def reply(self, status, body, cookie=None):
            payload = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            if cookie:
                self.send_header("Set-Cookie", "tadoku_session=" + cookie + "; Path=/; HttpOnly")
            self.end_headers()
            self.wfile.write(payload)

        def authorized(self):
            if self.server.expired or self.headers.get("Cookie") != "tadoku_session=fixture-session":
                self.server.expired = False
                self.reply(401, {})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path.endswith("/configuration-options"):
                self.reply(
                    200,
                    {
                        "units": [
                            {"log_activity_id": 1, "name": "Character", "unit_key": "general"},
                            {
                                "log_activity_id": 1,
                                "name": "Character",
                                "language_code": "jpn",
                                "unit_key": "jpn-character",
                            },
                        ]
                    },
                )
            elif self.path.endswith("/ongoing-registrations"):
                self.reply(
                    200,
                    {
                        "registrations": [
                            {
                                "id": f"event-{language}",
                                "languages": [{"code": language}],
                                "contest": {"allowed_activities": [{"id": "1"}]},
                            }
                            for language in ("jpn", "eng")
                        ]
                    },
                )
            else:
                self.reply(404, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path.endswith("/identity/login"):
                if body == {"email": "reader@example.invalid", "password": "fixture-only"}:
                    self.server.logins += 1
                    self.reply(200, {}, "fixture-session")
                else:
                    self.reply(401, {})
            elif self.authorized():
                if self.path != "/api/internal/immersion/logs":
                    self.reply(404, {})
                elif self.server.fail and self.server.logs:
                    self.reply(503, {"reason": "fixture rejection"})
                else:
                    log_id = f"fixture-{len(self.server.logs) + 1}"
                    self.server.logs[log_id] = body
                    self.reply(201, {"id": log_id})

        def do_DELETE(self):
            if self.authorized():
                log_id = self.path.rsplit("/", 1)[-1]
                removed = self.server.logs.pop(log_id, None)
                self.server.deleted.append(log_id)
                self.reply(200 if removed else 404, {})

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    server.logs = {}
    server.deleted = []
    server.fail = False
    server.expired = False
    server.logins = 0
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stack.callback(server.server_close)
    stack.callback(server.shutdown)
    return server


def cleanup(db):
    with db:
        db.execute("DELETE FROM game_lines WHERE id LIKE 'tadoku-bench-%'")
        db.execute("DELETE FROM games WHERE id LIKE 'tadoku-bench-%'")
        db.execute("DELETE FROM stats_export_state WHERE format_key LIKE 'tadoku_incremental:game:tadoku-bench-%'")


def measure(databases, connections, rounds, stack, provider):
    cursor = int(time.time()) - 1000
    for db in databases.values():
        stack.callback(cleanup, db)
        with db:
            originals = db.execute("SELECT created_at,id FROM game_lines").fetchall()

            def restore_baseline(db=db, originals=originals):
                with db:
                    db.executemany("UPDATE game_lines SET created_at=? WHERE id=?", originals)

            stack.callback(restore_baseline)
            db.execute("UPDATE game_lines SET created_at=0")
            db.execute(
                "UPDATE stats_export_state SET last_successful_export_at=? WHERE format_key='tadoku_incremental'",
                (cursor,),
            )
            for game in range(8):
                key = f"tadoku-bench-{game}"
                db.execute(
                    """INSERT INTO games(id,title_original,title_romaji,type) VALUES(?,?,?,?)""",
                    (key, f"ゲーム{game}", f"Game {game}", "Visual Novel" if game % 2 else "Manga"),
                )
                db.execute(
                    "INSERT INTO stats_export_state(format_key,last_successful_export_at) VALUES(?,?)",
                    ("tadoku_incremental:game:" + key, cursor + game),
                )
                db.executemany(
                    """INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,created_at)
                    VALUES(?,?,?,?,?,?)""",
                    [
                        (f"{key}-{i}", key, "OBS", f"【声】台詞{i % 100}。", cursor + i - 249, cursor + i - 249)
                        for i in range(500)
                    ],
                )
    results = {}
    for dedup in (False, True):
        path = "/api/tadoku/preview?title_source=romaji&deduplicate=" + str(dedup).lower()
        samples = {name: [] for name in connections}
        for i in range(rounds + 1):
            states = {}
            for name in connections if i % 2 == 0 else reversed(connections):
                connection, process = connections[name]
                start_cpu = process.cpu_times()
                start = time.perf_counter()
                response, raw = request(connection, "GET", path)
                elapsed = time.perf_counter() - start
                end = process.cpu_times()
                assert response.status == 200 and (name != "rust" or response.getheader("x-gsm-handler") == "rust"), (
                    name,
                    response.status,
                    raw[:300],
                )
                payload = json.loads(raw)
                assert payload.pop("upper_bound") >= cursor and payload["cursor"] == cursor
                entries = [r for r in payload["entries"] if r["game_key"].startswith("tadoku-bench-")]
                assert len(entries) == 8 and all(r["game_name"].startswith("Game ") for r in entries)
                assert (payload["duplicates_excluded"] > 1000) == dedup
                states[name] = payload
                if i:
                    samples[name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end.user + end.system - start_cpu.user - start_cpu.system) * 1000,
                            "server_resident_mib": process.memory_info().rss / 1024**2,
                        }
                    )
            assert states["rust"] == states["python"], states
        results["deduplicated" if dedup else "all"] = {
            name: {key: round(statistics.median(row[key] for row in rows), 4) for key in rows[0]}
            for name, rows in samples.items()
        }
    results.update(measure_sync(databases, connections, rounds, provider, cursor))
    check_daily(databases, connections, provider, cursor)
    return results


def sync_job(conn, options):
    reply, body = request(conn, "POST", "/api/tadoku/sync", options)
    assert reply.status == 202, (reply.status, body)
    record = json.loads(body)
    start = time.monotonic()
    while time.monotonic() - start < 10:
        reply, body = request(conn, "GET", "/api/tadoku/jobs/" + record["job_id"])
        assert reply.status == 200, (reply.status, body)
        record = json.loads(body)
        if record["status"] in ("completed", "failed"):
            return record
        time.sleep(0.001)
    raise AssertionError("Tadoku job timed out")


def check_daily(databases, connections, provider, cursor):
    import datetime as dt

    now = dt.datetime.now(dt.UTC).astimezone()
    due = (now.replace(hour=2, minute=17, second=0, microsecond=0) - dt.timedelta(days=1)).timestamp()
    receipts = {}
    for name, (conn, _) in connections.items():
        db = databases[name]
        provider.logs.clear()
        provider.deleted.clear()
        provider.fail = False
        with db:
            for j in (0, 2):
                # Game zero qualifies from historical reading. Game two also
                # qualifies by lifetime count but is outside the whitelist.
                db.execute(
                    "INSERT INTO game_lines(id,game_id,line_text,timestamp,created_at) VALUES(?,?,?,?,?)",
                    (f"tadoku-bench-history-{j}", f"tadoku-bench-{j}", "猫" * 6000, cursor - 10, cursor - 10),
                )
        settings = {
            "tadoku_daily_sync_game_ids": ["tadoku-bench-0", "tadoku-bench-1"],
            "tadoku_daily_sync_deduplicate": True,
            "tadoku_daily_sync_enabled": True,
            "tadoku_daily_sync_time": "02:17",
        }
        response, raw = request(conn, "POST", "/api/settings", settings)
        assert response.status == 200, (response.status, raw)
        if name == "python":
            response, body = request(conn, "POST", "/_benchmark/tadoku-daily")
            assert response.status == 200 and json.loads(body)["entries_sent"] == 1, body
        else:
            with db:
                db.execute("UPDATE cron_table SET next_run=?, last_run=NULL WHERE name='tadoku_sync'", (due,))
            response, raw = request(conn, "POST", "/api/settings", {"tadoku_daily_sync_time": "02:17"})
            assert response.status == 200, raw
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                last, following = db.execute(
                    "SELECT last_run,CAST(next_run AS REAL) FROM cron_table WHERE name='tadoku_sync'"
                ).fetchone()
                if last is not None and following > time.time():
                    next_time = dt.datetime.fromtimestamp(following, dt.UTC).astimezone()
                    assert (next_time.hour, next_time.minute) == (2, 17)
                    break
                time.sleep(0.01)
            else:
                raise AssertionError("Native Tadoku scheduler did not advance")
        assert len(provider.logs) == 1, provider.logs
        receipts[name] = provider.logs["fixture-1"]
        cursors = dict(
            db.execute(
                "SELECT format_key,CAST(last_successful_export_at AS REAL) FROM stats_export_state WHERE format_key LIKE 'tadoku_incremental%'"
            )
        )
        assert cursors["tadoku_incremental"] == cursor and cursors["tadoku_incremental:game:tadoku-bench-0"] > cursor
        assert (
            cursors["tadoku_incremental:game:tadoku-bench-1"] == cursor + 1
            and cursors["tadoku_incremental:game:tadoku-bench-2"] == cursor + 2
        )
        assert request(conn, "POST", "/api/settings", {"tadoku_daily_sync_enabled": False})[0].status == 200
    assert receipts["rust"] == receipts["python"]


def measure_sync(databases, connections, rounds, provider, cursor):
    for conn, _ in connections.values():
        assert request(conn, "POST", "/api/tadoku/auth/refresh")[0].status == 400
        assert request(conn, "GET", "/api/tadoku/jobs/missing")[0].status == 404
        assert request(conn, "POST", "/api/tadoku/sync", {"log_descriptions": {"game": " "}})[0].status == 400
        ok, raw = request(
            conn,
            "POST",
            "/api/settings",
            {"tadoku_username": "reader@example.invalid", "tadoku_password": "fixture-only"},
        )
        assert ok.status == 200, raw
        reply, body = request(conn, "POST", "/api/tadoku/auth/refresh")
        assert reply.status == 200 and json.loads(body) == {"authenticated": True}, (reply.status, body)
    results = {}
    for case in ("upload", "rollback"):
        samples = {name: [] for name in connections}
        for i in range(rounds + 1):
            states = {}
            for name in connections if i % 2 == 0 else reversed(connections):
                db = databases[name]
                with db:
                    db.execute(
                        "UPDATE stats_export_state SET last_successful_export_at=? WHERE format_key='tadoku_incremental'",
                        (cursor,),
                    )
                    for j in range(8):
                        db.execute(
                            "UPDATE stats_export_state SET last_successful_export_at=? WHERE format_key=?",
                            (cursor + j, f"tadoku_incremental:game:tadoku-bench-{j}"),
                        )
                provider.logs.clear()
                provider.deleted.clear()
                provider.fail = case == "rollback"
                # Make the first upload prove recovery from an expired cookie.
                provider.expired = case == "upload" and i == 0
                logins_before = provider.logins
                conn, process = connections[name]
                start_cpu = process.cpu_times()
                start = time.perf_counter()
                record = sync_job(conn, {"deduplicate": True, "log_descriptions": {"tadoku-bench-0": "手入力"}})
                elapsed = time.perf_counter() - start
                end = process.cpu_times()
                assert provider.logins - logins_before == int(case == "upload" and i == 0)
                bounds = [
                    float(row[0])
                    for row in db.execute(
                        "SELECT last_successful_export_at FROM stats_export_state WHERE format_key LIKE 'tadoku_incremental%' ORDER BY format_key"
                    )
                ]
                if provider.fail:
                    assert record["status"] == "failed" and "503" in record["error"] and not provider.logs, record
                    assert provider.deleted == ["fixture-1"] and bounds == [cursor, *[cursor + j for j in range(8)]]
                else:
                    assert record["status"] == "completed", record
                    result = record["result"]
                    assert result["entries_sent"] == 8 and result["characters_sent"] > 0
                    assert all(abs(v - result["cursor"]) < 0.00001 for v in bounds)
                    assert provider.logs["fixture-1"]["description"] == "手入力"
                    assert all(
                        r["registration_ids"] == ["event-jpn"] and r["unit_key"] == "jpn-character"
                        for r in provider.logs.values()
                    )
                    del result["cursor"]
                states[name] = (record["result"], dict(provider.logs), list(provider.deleted))
                if i:
                    samples[name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end.user + end.system - start_cpu.user - start_cpu.system) * 1000,
                            "server_resident_mib": process.memory_info().rss / 1024**2,
                        }
                    )
            assert states["rust"] == states["python"], states
        results[case] = {
            name: {key: round(statistics.median(row[key] for row in rows), 4) for key in rows[0]}
            for name, rows in samples.items()
        }
    return results
