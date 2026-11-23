"""HTTP and SQLite comparisons for --imports in benchmark_desktop_controls.py."""

import csv
import hashlib
import io
import json
import statistics
import time
from datetime import UTC, datetime, timedelta, timezone


def mokuro_request(volumes):
    data = {}
    for i in range(volumes):
        turns = [[1600000000000 + j * 3600000, j, 50 * (j - 3 if j % 11 == 10 else j + 1)] for j in range(200)]
        data[str(i)] = {
            "series_title": f"漫画 {i:03}",
            "chars": 10_000,
            "timeReadInMinutes": 80.5,
            "addedOn": "2020-09-10",
            "recentPageTurns": turns[1::2] + turns[::2],
            "settings": {"cover": "x" * 16384},
        }
    content = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8-sig")
    return (
        b'--gsm-file\r\nContent-Disposition: form-data; name="file"; filename="volume-data.json"\r\nContent-Type: application/json\r\n\r\n'
        + content
        + b'\r\n--gsm-file\r\nContent-Disposition: form-data; name="clear_previous"\r\n\r\ntrue\r\n--gsm-file--\r\n'
    )


def measure(databases, connections, rounds):
    output = {}
    for volumes in [1, 48]:
        data = mokuro_request(volumes)
        samples = {name: [] for name in connections}
        for i in range(rounds + 1):
            responses = {}
            stored = {}
            for name in connections if i % 2 == 0 else reversed(connections):
                conn, proc = connections[name]
                cpu = proc.cpu_times()
                start = time.perf_counter()
                conn.request(
                    "POST",
                    "/api/import-mokuro",
                    data,
                    headers={"Content-Type": "multipart/form-data; boundary=gsm-file"},
                )
                response = conn.getresponse()
                body = response.read()
                elapsed = time.perf_counter() - start
                end = proc.cpu_times()
                assert response.status == 200 and (name != "rust" or response.getheader("x-gsm-handler") == "rust"), (
                    name,
                    response.status,
                    body[:512],
                )
                responses[name] = json.loads(body)
                assert responses[name]["total_characters"] == volumes * 10_000
                stored[name] = (
                    databases[name]
                    .execute(
                        "SELECT date,characters_read,time_read_seconds,source,label FROM third_party_stats WHERE source='mokuro' ORDER BY label,date"
                    )
                    .fetchall()
                )
                assert len(stored[name]) == responses[name]["imported_count"] and len(stored[name]) > volumes
                if i:
                    samples[name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000,
                            "server_resident_mib": proc.memory_info().rss / 1024**2,
                        }
                    )
            assert responses["rust"] == responses["python"] and stored["rust"] == stored["python"]
        output[f"{volumes} volumes, {len(data)} bytes"] = {
            name: {key: round(statistics.median(row[key] for row in values), 4) for key in values[0]}
            for name, values in samples.items()
        }
    return output


def measure_exstatic(databases, connections, fixtures, rounds):
    names = ["一番", "二番", "三番"]
    rows = [("ex-bench", f"line-{i}", names[i % 3], f'文 {i}, "台詞"\n続く', 1700000000.375 + i) for i in range(2500)]
    data = io.StringIO(newline="")
    writer = csv.writer(data)
    writer.writerow(("uuid", "given_identifier", "name", "line", "time"))
    writer.writerows([*rows, rows[1], ("ex-bench", "bad", names[0], "", 0)])
    body = (
        b'--csv\r\nContent-Disposition: form-data; name="file"; filename="lines.CSV"\r\n\r\n'
        + data.getvalue().encode("utf-8-sig")
        + b"\r\n--csv--\r\n"
    )
    games = {name: f"exstatic-game-{i}" for i, name in enumerate(names)}
    expected = sorted(
        (f"{uuid}|{identifier if i else line}", scene, line, stamp, games[scene], "ja")
        for i, (uuid, identifier, scene, line, stamp) in enumerate(rows)
    )
    legacy = next(r for r in expected if r[0].endswith(rows[0][3]))

    def cleanup(db):
        with db:
            db.execute("DELETE FROM game_lines WHERE id GLOB 'ex-bench|*'")
            db.executemany("DELETE FROM games WHERE id=?", [(key,) for key in games.values()])

    for db in databases.values():
        fixtures.callback(cleanup, db)
        with db:
            db.executemany(
                "INSERT INTO games(id,title_original,obs_scene_name) VALUES(?,?,?)",
                [(key, name, name) for name, key in games.items()],
            )
    samples = {phase: {name: [] for name in connections} for phase in ("initial", "retry")}
    for i in range(rounds + 1):
        for name in connections if i % 2 == 0 else reversed(connections):
            db = databases[name]
            with db:
                db.execute("DELETE FROM game_lines WHERE id GLOB 'ex-bench|*'")
                db.execute(
                    "INSERT INTO game_lines(id,game_name,line_text,timestamp,game_id,language) VALUES(?,?,?,?,?,?)",
                    legacy,
                )
            conn, proc = connections[name]
            for phase in samples:
                cpu = proc.cpu_times()
                start = time.perf_counter()
                conn.request(
                    "POST", "/api/import-exstatic", body, {"Content-Type": "multipart/form-data; boundary=csv"}
                )
                response = conn.getresponse()
                raw = response.read()
                elapsed = time.perf_counter() - start
                end = proc.cpu_times()
                assert response.status == 200 and (name != "rust" or response.getheader("x-gsm-handler") == "rust"), (
                    name,
                    response.status,
                    raw[:256],
                )
                parsed = json.loads(raw)
                count = 2499 if phase == "initial" else 0
                game_count = 3 if count else 0
                assert parsed["imported_count"] == count and parsed["games_count"] == game_count, (name, parsed)
                assert sorted(parsed["games"]) == (sorted(names) if count else [])
                assert parsed["warning_count"] == 1 and parsed["warnings"] == ["Row 2501: Missing line text"]
                assert (
                    parsed["rollup_status"] == "queued" and parsed["rollup_message"] == "Daily rollup has been queued."
                ), (name, parsed)
                assert (
                    parsed["message"]
                    == f"Successfully imported {count} lines from {game_count} games. Daily rollup has been queued."
                )
                saved = db.execute(
                    "SELECT id,game_name,line_text,timestamp,game_id,language FROM game_lines WHERE id GLOB 'ex-bench|*' ORDER BY id"
                ).fetchall()
                assert saved == expected, (name, phase, next(((a, b) for a, b in zip(saved, expected) if a != b), None))
                if i:
                    samples[phase][name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000,
                            "server_resident_mib": proc.memory_info().rss / 1024**2,
                        }
                    )
    return {
        phase: {
            name: {key: round(statistics.median(r[key] for r in values), 4) for key in values[0]}
            for name, values in modes.items()
        }
        for phase, modes in samples.items()
    }


def measure_kizuna(databases, connections, rounds):
    games = {f'本 {n}, "物語"': f"kizuna-game-{n}" for n in range(4)}
    rows = []
    ids = []
    for n in range(1000):
        title = list(games)[n % 4]
        instant = datetime(2020, 11, 1, 5, 30, tzinfo=UTC) + timedelta(hours=n, microseconds=(n * 17) % 1000000)
        stamp = instant.astimezone(timezone(timedelta(hours=9))).isoformat()
        seconds = [90.0, 1.25, 1e-5, 1e-6][n % 4]
        chars, lines = 3 * n, n % 22
        rows.append(("", title, stamp, seconds, chars, lines))
        key = json.dumps([title, instant.timestamp(), seconds, chars, lines], ensure_ascii=False).encode()
        ids.append(hashlib.sha256(key).hexdigest())
    data = io.StringIO(newline="")
    writer = csv.writer(data)
    writer.writerow(("vndb_id", "name", "date", "duration_seconds", "chars", "lines"))
    writer.writerows([*rows, rows[123]])
    file = (
        b'--csv\r\nContent-Disposition: form-data; name="file"; filename="sessions.csv"\r\n\r\n'
        + data.getvalue().encode("utf-8-sig")
    )
    for db in databases.values():
        with db:
            db.executemany(
                "INSERT INTO games(id,title_original,title_english) VALUES(?,?,?)",
                [(key, "Original " + name, name) for name, key in games.items()],
            )
    samples = {phase: {name: [] for name in connections} for phase in ("replace", "retry")}
    for i in range(rounds + 1):
        for phase in samples:
            response_by_server = {}
            stored = {}
            body = (
                file
                + b'\r\n--csv\r\nContent-Disposition: form-data; name="clear_previous"\r\n\r\n'
                + (b"TRUE" if phase == "replace" else b"false")
                + b"\r\n--csv--\r\n"
            )
            for name in connections if i % 2 == 0 else reversed(connections):
                conn, proc = connections[name]
                cpu = proc.cpu_times()
                start = time.perf_counter()
                conn.request("POST", "/api/import-kizuna", body, {"Content-Type": "multipart/form-data; boundary=csv"})
                response = conn.getresponse()
                raw = response.read()
                elapsed = time.perf_counter() - start
                end = proc.cpu_times()
                assert response.status == 200 and (name != "rust" or response.getheader("x-gsm-handler") == "rust"), (
                    name,
                    response.status,
                    raw[:300],
                )
                parsed = json.loads(raw)
                response_by_server[name] = parsed
                count = 1000 if phase == "replace" else 0
                assert parsed["imported_count"] == count and parsed["skipped_count"] == 1001 - count
                assert parsed["metadata_refresh_status"] == "not_needed"
                sql = """SELECT source_id,game_id,label,date,cast(timestamp as real),cast(time_read_seconds as real),
                    cast(characters_read as integer),cast(lines_read as integer) FROM third_party_stats WHERE source='kizuna' ORDER BY id"""
                stored[name] = databases[name].execute(sql).fetchall()
                assert [r[0] for r in stored[name]] == ids
                assert all(games[r[2]] == r[1] for r in stored[name])
                if i:
                    samples[phase][name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000,
                            "server_resident_mib": proc.memory_info().rss / 1024**2,
                        }
                    )
            assert response_by_server["rust"] == response_by_server["python"], response_by_server
            assert stored["rust"] == stored["python"], next(
                ((a, b) for a, b in zip(stored["rust"], stored["python"]) if a != b), None
            )
    return {
        phase: {
            name: {key: round(statistics.median(r[key] for r in values), 4) for key in values[0]}
            for name, values in modes.items()
        }
        for phase, modes in samples.items()
    }
