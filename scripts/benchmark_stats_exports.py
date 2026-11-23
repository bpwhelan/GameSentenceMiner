"""Compare complete export downloads from two isolated desktop profiles."""

import base64
import csv
import datetime as dt
import io
import json
import statistics
import time


def request(conn, method, path, body=None, headers=None):
    hdr = {"Content-Type": "application/json"} if body is not None else {}
    conn.request(method, path, body=json.dumps(body) if body is not None else None, headers={**hdr, **(headers or {})})
    response = conn.getresponse()
    return response, response.read()


def job(conn, options, native):
    response, payload = request(conn, "POST", "/api/stats-export/jobs", options)
    assert response.status == 202 and (not native or response.getheader("x-gsm-handler") == "rust"), (
        response.status,
        payload[:500],
    )
    path = "/api/stats-export/jobs/" + json.loads(payload)["job_id"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response, raw = request(conn, "GET", path)
        state = json.loads(raw)
        assert response.status == 200 and state["status"] in ("queued", "running", "completed", "failed"), state
        if state["status"] in ("completed", "failed"):
            return state
        time.sleep(0.001)
    raise AssertionError("Export did not finish")


def remove_fixture(db):
    with db:
        db.execute("DELETE FROM game_lines WHERE id LIKE 'export-%'")
        db.execute("DELETE FROM game_daily_rollup WHERE game_id LIKE 'export-%'")
        db.execute("DELETE FROM games WHERE id LIKE 'export-%'")
        db.execute("DELETE FROM third_party_stats WHERE label GLOB '外部[0-9]*' AND source='mokuro'")


def measure(databases, connections, rounds, stack):
    today = dt.datetime.now(dt.UTC).astimezone().date()
    past = (today - dt.timedelta(days=3)).isoformat()
    midnight = dt.datetime.combine(today, dt.time.min).timestamp()
    cover = "data:image/png;base64," + base64.b64encode(bytes(range(256)) * 64).decode()
    for db in databases.values():
        stack.callback(remove_fixture, db)
        with db:
            for i in range(48):
                key = f"export-{i}"
                db.execute(
                    """INSERT INTO games(id,title_english,obs_scene_name,type,description,image,deck_id,genres,links,completed)
                    VALUES(?,?,?,'Visual Novel',?,?,?,'["冒険"]',?,?)""",
                    (
                        key,
                        f'夜 "Story", {i}',
                        f"Scene {i}",
                        f"説明\n二行目{i}",
                        cover,
                        i,
                        json.dumps(["HTTP://local", {"url": "http://local"}]),
                        i % 2,
                    ),
                )
                db.execute(
                    """INSERT INTO game_daily_rollup(date,game_id,total_characters,total_reading_time_seconds)
                    VALUES(?,?,?,?)""",
                    (past, key, 400 + i, 150 + i),
                )
                db.executemany(
                    """INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,last_modified)
                    VALUES(?,?,?,'こんにちは。',?,?)""",
                    [(f"export-{i}-{j}", key, f"Scene {i}", midnight + 60 + j * 31, midnight) for j in range(25)],
                )
                db.execute(
                    """INSERT INTO third_party_stats(date,label,source,characters_read,time_read_seconds,created_at)
                    VALUES(?,?,'mokuro',999,90,?)""",
                    (past, f"外部{i}", midnight),
                )
    catalogs = []
    for name, (conn, _) in connections.items():
        response, data = request(conn, "GET", "/api/stats-export/formats")
        assert response.status == 200
        catalogs.append(json.loads(data))
        assert request(conn, "GET", "/api/stats-export/jobs/missing")[0].status == 404
        assert request(conn, "GET", "/api/stats-export/jobs/missing/download")[0].status == 409
        assert request(conn, "POST", "/api/stats-export/jobs", {"format": "invalid"})[0].status == 400
        failed = job(conn, {"format": "kechimochi", "scope": "custom", "start_date": past}, name == "rust")
        assert failed["status"] == "failed" and "both start_date and end_date" in failed["error"]
    assert catalogs[0] == catalogs[1]
    cases = {
        "library": {"format": "kechimochi_library"},
        "activity": {"format": "kechimochi", "scope": "custom", "start_date": past, "end_date": today.isoformat()},
        "incremental": {"format": "kechimochi", "scope": "since_last_export"},
    }
    medians = {}
    for case, options in cases.items():
        samples = {name: [] for name in connections}
        for i in range(rounds + 1):
            copies = {}
            for name in connections if i % 2 == 0 else reversed(connections):
                db = databases[name]
                if case == "incremental":
                    with db:
                        db.execute("UPDATE game_lines SET last_modified=? WHERE id='export-0-0'", (time.time() + 10,))
                conn, process = connections[name]
                start_cpu = process.cpu_times()
                start = time.perf_counter()
                state = job(conn, options, name == "rust")
                assert state["status"] == "completed" and state["progress"] == 100, state
                response, data = request(conn, "GET", state["download_url"])
                elapsed = time.perf_counter() - start
                end_cpu = process.cpu_times()
                assert response.status == 200 and response.getheader("Content-Type").startswith("text/csv")
                assert state["filename"] in response.getheader("Content-Disposition") and data.startswith(
                    b"\xef\xbb\xbf"
                )
                assert name != "rust" or response.getheader("x-gsm-handler") == "rust"
                values = list(csv.DictReader(io.StringIO(data.decode("utf-8-sig"))))
                assert len(values) == state["row_count"]
                if case == "library":
                    entries = [r for r in values if r["Title"].startswith("夜")]
                    assert len(entries) == 48 and all(r["Cover Image (Base64)"] == cover.split(",")[1] for r in entries)
                elif case == "activity":
                    assert len([r for r in values if r["Log Name"].startswith("夜")]) == 96
                    assert len([r for r in values if r["Log Name"].startswith("外部")]) == 48
                else:
                    assert len(values) == 1 and values[0]["Characters"] == "5", values
                if not i:
                    resp, partial = request(conn, "GET", state["download_url"], headers={"Range": "bytes=0-15"})
                    assert resp.status == 206 and partial == data[:16]
                    assert request(conn, "HEAD", state["download_url"])[0].getheader("Content-Length") == str(len(data))
                copies[name] = data
                assert db.execute(
                    "SELECT last_successful_export_at FROM stats_export_state WHERE format_key=?", (options["format"],)
                ).fetchone()
                if i:
                    samples[name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end_cpu.user + end_cpu.system - start_cpu.user - start_cpu.system) * 1000,
                            "server_resident_mib": process.memory_info().rss / 1024**2,
                        }
                    )
            if copies["rust"] != copies["python"]:
                rust = copies["rust"].decode("utf-8-sig").splitlines()
                python = copies["python"].decode("utf-8-sig").splitlines()
                first = next(((n, a[:240], b[:240]) for n, (a, b) in enumerate(zip(rust, python)) if a != b), None)
                raise AssertionError((case, len(rust), len(python), first))
        medians[case] = {
            name: {key: round(statistics.median(row[key] for row in rows), 4) for key in rows[0]}
            for name, rows in samples.items()
        }
    return medians
