"""Exercise desktop sync and its Flask reference against independent local Kechimochi stores."""

import base64
import copy
import http.server
import json
import os
import socket
import statistics
import threading
import time
from email import policy
from email.parser import BytesParser
from pathlib import Path

from benchmark_stats_exports import request

SOURCE_ID = "f9cecf2e20ad4c8f87c4365cd7178924"
COVER = b"fixture image" * 1280
PATH = "/api/kechimochi/"


class Store:
    def __init__(self):
        self.media = {}
        self.logs = {}
        self.covers = {}
        self.lose_reply = False
        self.restrict = False
        self.unavailable = False
        self.writes = 0


class Provider(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass

    def log_message(self, *args):
        pass

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route(self):
        owner, api, kind, *ident = self.path.strip("/").split("/")
        assert owner in self.server.stores and api == "api"
        assert self.headers.get("X-Kechimochi-API") == "1"
        store = self.server.stores[owner]
        if store.unavailable:
            return self.reply(503, {"error": "fixture offline"})
        if kind == "version":
            return self.reply(200, "2.4")
        if kind == "covers":
            data = self.rfile.read(int(self.headers["Content-Length"]))
            if store.restrict:
                return self.reply(403, {"error": "scope"})
            message = BytesParser(policy=policy.default).parsebytes(
                ("Content-Type: " + self.headers["Content-Type"] + "\r\n\r\n").encode() + data
            )
            (part,) = message.iter_parts()
            assert part.get_filename() == "gsm-cover.jpg" and part.get_payload(decode=True) == COVER
            store.covers[int(ident[0])] = COVER
            return self.reply(200, {"path": "/covers/" + ident[0]})
        collection = getattr(store, kind)
        if self.command == "GET":
            return self.reply(200, list(collection.values()))
        store.writes += 1
        if self.command == "DELETE":
            del collection[int(ident[0])]
            return self.reply(200, True)
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.command == "POST":
            assert payload["id"] is None
            row_id = max(collection, default=0) + 1
        else:
            row_id = int(ident[0])
            assert row_id == payload["id"] and row_id in collection
        collection[row_id] = {**payload, "id": row_id}
        if kind == "logs" and self.command == "POST" and store.lose_reply:
            store.lose_reply = False
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        self.reply(200, row_id)

    do_GET = do_POST = do_PUT = do_DELETE = route


def start_fixture(stack):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    server.stores = {name: Store() for name in ("rust", "python")}
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stack.callback(server.server_close)
    stack.callback(server.shutdown)
    return server


def api(conn, method, path, body=None, status=200):
    reply, raw = request(conn, method, PATH + path, body)
    assert reply.status == status, (method, path, reply.status, raw[:600])
    return json.loads(raw)


def wait(conn, before=None):
    start = time.monotonic()
    while time.monotonic() - start < 15:
        state = api(conn, "GET", "status")
        if state.get("run_id") != before and state["status"] in {"completed", "failed"}:
            return state
        time.sleep(0.001)
    raise AssertionError(f"Sync did not finish: {state}")


def sync(conn):
    before = api(conn, "GET", "status").get("run_id")
    queued = api(conn, "POST", "sync", status=202)
    assert queued["status"] == "queued"
    return wait(conn, before)


def seed(db, stack):
    with db:
        db.execute("CREATE TABLE IF NOT EXISTS kechimochi_sync_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        db.execute("INSERT OR REPLACE INTO kechimochi_sync_state VALUES('source_id',?)", (json.dumps(SOURCE_ID),))
        for i in range(8):
            game = f"km-{i}"
            db.execute(
                """INSERT INTO games(id,title_english,type,obs_scene_name,description,genres,image,vndb_id,character_count)
                    VALUES(?,?,?,?,?,'["冒険"]',?,'v5','10234')""",
                (
                    game,
                    f"海{i}",
                    "Visual Novel",
                    f"scene{i}",
                    f"設定{i}",
                    base64.b64encode(COVER).decode() if i < 2 else "",
                ),
            )
            db.executemany(
                "INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,language) VALUES(?,?,?,?,?,'ja')",
                [(f"{game}-{j}", game, f"scene{i}", f"台詞{j}。", 1600000000 + j * 20) for j in range(250)],
            )
        db.execute(
            "INSERT INTO game_daily_rollup(date,game_id,total_characters,total_reading_time_seconds) VALUES('2017-01-01','km-0',20,150)"
        )
        db.execute(
            "INSERT INTO third_party_stats(date,source,label,characters_read,time_read_seconds) VALUES('2016-01-01','mokuro','外部',17,60)"
        )

    def cleanup():
        with db:
            db.execute("DELETE FROM game_lines WHERE id LIKE 'km-%'")
            db.execute("DELETE FROM games WHERE id LIKE 'km-%'")
            db.execute("DELETE FROM game_daily_rollup WHERE game_id LIKE 'km-%'")
            db.execute("DELETE FROM third_party_stats WHERE label='外部' AND source='mokuro'")

    stack.callback(cleanup)


def measured(process, run, *args):
    cpu = process.cpu_times()
    start = time.perf_counter()
    result = run(*args)
    elapsed = time.perf_counter() - start
    end = process.cpu_times()
    return result, {
        "ms": elapsed * 1000,
        "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000,
        "server_resident_mib": process.memory_info().rss / 1024**2,
    }


def measure(databases, connections, rounds, stack, provider):
    for name, (conn, _) in connections.items():
        seed(databases[name], stack)
        url = f"http://127.0.0.1:{provider.server_port}/{name}"
        before = api(conn, "GET", "settings")
        assert "true or false" in api(conn, "POST", "settings", {"enabled": 1}, 400)["error"]
        assert api(conn, "GET", "settings") == before
        assert api(conn, "POST", "settings", {"url": url + "/api/"})["url"] == url
        assert api(conn, "POST", "test", {}) == {"connected": True, "version": "2.4", "media_count": 0}
    results = {}
    for case in ("preview", "full", "repeat"):
        samples = {name: [] for name in connections}
        for i in range(rounds + 1):
            states = {}
            for name in connections if i % 2 == 0 else reversed(connections):
                conn, process = connections[name]
                store = provider.stores[name]
                if case == "preview":
                    payload, timing = measured(process, api, conn, "GET", "preview")
                    assert payload["characters"] > 6000
                    states[name] = payload
                else:
                    if case == "full":
                        provider.stores[name] = store = Store()
                        with databases[name] as db:
                            db.execute("DELETE FROM kechimochi_sync_state WHERE key LIKE 'metadata:%'")
                    state, timing = measured(process, sync, conn)
                    assert state["status"] == "completed", state
                    result = state["result"]
                    if case == "full":
                        assert (
                            result["media_created"] >= 9
                            and result["logs_created"] >= 10
                            and result["covers_uploaded"] == 2
                        ), result
                    else:
                        assert not any(
                            result[k]
                            for k in (
                                "media_created",
                                "media_updated",
                                "logs_created",
                                "logs_updated",
                                "logs_deleted",
                                "covers_uploaded",
                            )
                        ), result
                    states[name] = (result, store.media, store.logs, store.covers)
                if i:
                    samples[name].append(timing)
            assert states["rust"] == states["python"], difference(states)
        results[case] = {
            name: {k: round(statistics.median(v[k] for v in rows), 4) for k in rows[0]}
            for name, rows in samples.items()
        }
    verify_recovery(databases, connections, provider)
    return results


def difference(states):
    for key in states["rust"] if isinstance(states["rust"], dict) else range(len(states["rust"])):
        a, b = states["rust"][key], states["python"][key]
        if a != b:
            if isinstance(a, dict):
                for field in a.keys() | b.keys():
                    if a.get(field) != b.get(field):
                        return key, field, a.get(field), b.get(field)
            return key, a, b


def verify_recovery(databases, connections, provider):
    states = {}
    for name, (conn, _) in connections.items():
        db = databases[name]
        store = provider.stores[name]
        media = next(v for v in store.media.values() if v["title"] == "海0")
        media["description"] = "Kept remote description"
        extra = json.loads(media["extra_data"])
        extra["Genres"] = "Local edit"
        media["extra_data"] = json.dumps(extra, ensure_ascii=False, sort_keys=True)
        store.logs[900] = {
            "id": 900,
            "media_id": media["id"],
            "characters": 1,
            "duration_minutes": 0,
            "date": "2010-01-01",
            "notes": "Manual log",
            "activity_type": "Reading",
        }
        store.lose_reply = True
        with db:
            db.execute(
                "INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES('km-retry','km-0','Sea','追記',1630000000)"
            )
            db.execute("DELETE FROM third_party_stats WHERE label='外部'")
        state = sync(conn)
        assert state["status"] == "failed" and store.logs[901]["characters"] == 2, state
        assert any(r["date"] == "2016-01-01" for r in store.logs.values())
        state = sync(conn)
        assert state["result"]["logs_created"] == 0 and state["result"]["logs_deleted"] == 1, state
        assert (
            store.logs[900]["notes"] == "Manual log"
            and store.media[media["id"]]["description"] == "Kept remote description"
        )
        assert json.loads(store.media[media["id"]]["extra_data"])["Genres"] == "Local edit"
        with db:
            db.execute("UPDATE games SET image=? WHERE id='km-2'", (base64.b64encode(COVER).decode(),))
        store.restrict = True
        result = sync(conn)["result"]
        assert result["covers_uploaded"] == 0 and len(result["warnings"]) == 1, result
        check_ownership(conn, db, store)
        states[name] = copy.deepcopy((store.media, store.logs))
        verify_schedule(name, conn, db, store)
    assert states["rust"] == states["python"], difference(states)


def check_ownership(conn, db, store):
    # This handle lives in a different process from both production workers.
    path = Path(db.execute("PRAGMA database_list").fetchone()[2]).with_suffix(".kechimochi.lock")
    with path.open("r+b") as handle:
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert "already" in api(conn, "POST", "sync", status=409)["error"].lower()
    api(conn, "POST", "settings", {"adopt_matching_logs": True, "sync_covers": False})
    # Two CSV imports match the same local log. No deletions or blind adoption.
    first = store.logs[901]
    first["notes"] = ""
    first["activity_type"] = "Visual Novel"
    store.logs[902] = {**first, "id": 902}
    state = sync(conn)
    assert state["status"] == "failed" and "Multiple existing" in state["error"], state
    del store.logs[902]
    state = sync(conn)
    assert state["result"]["logs_adopted"] == 1 and "GSM sync:" in store.logs[901]["notes"], state
    # A duplicate ownership marker must stop the run before any remote change.
    store.logs[902] = {**store.logs[901], "id": 902}
    before = store.writes
    state = sync(conn)
    assert "duplicate GSM ownership markers" in state["error"] and store.writes == before, state
    del store.logs[902]


def verify_schedule(name, conn, db, store):
    before = api(conn, "GET", "status")["run_id"]
    store.unavailable = True
    api(conn, "POST", "settings", {"enabled": True, "schedule": "daily", "sync_time": "02:17"})
    state = wait(conn, before)
    assert state["status"] == "failed", state
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        next_run = api(conn, "GET", "status")["next_run"]
        if next_run and 880 < next_run - time.time() < 905:
            break
        time.sleep(0.005)
    else:
        raise AssertionError(("Manual retry deadline", next_run))
    store.unavailable = False
    if name == "python":
        response, raw = request(conn, "POST", "/_benchmark/kechimochi-scheduled")
        assert response.status == 200 and json.loads(raw)["success"], raw
    else:
        with db:
            db.execute("UPDATE cron_table SET next_run=1,last_run=NULL WHERE name='kechimochi_sync'")
        # A stats update wakes the normal desktop scheduler to reread its due jobs.
        response, _ = request(conn, "POST", "/api/settings", {"tadoku_daily_sync_enabled": False})
        assert response.status == 200
        state = wait(conn, state["run_id"])
        assert state["status"] == "completed", state
        end = time.monotonic() + 10
        while time.monotonic() < end:
            row = db.execute(
                "SELECT last_run,CAST(next_run AS REAL) FROM cron_table WHERE name='kechimochi_sync'"
            ).fetchone()
            if row[0] and time.strftime("%H:%M", time.localtime(row[1])) == "02:17":
                break
            time.sleep(0.005)
        else:
            raise AssertionError(("Scheduled deadline", row))
    api(conn, "POST", "settings", {"enabled": False})
