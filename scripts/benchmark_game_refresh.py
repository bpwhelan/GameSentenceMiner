"""Compare a Kizuna-triggered metadata refresh on isolated provider and database fixtures."""

import base64
import io
import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor

from PIL import Image


def enable_flask_job():
    from GameSentenceMiner.util.cron import cron_scheduler
    from GameSentenceMiner.util.cron.jiten_update import update_all_jiten_games

    worker = ThreadPoolExecutor(max_workers=1)
    cron_scheduler.force_jiten_sync = lambda: worker.submit(update_all_jiten_games)


def deck(port):
    return {
        "data": {
            "mainDeck": {
                "deckId": 42,
                "originalTitle": "本の題",
                "englishTitle": "Deck game",
                "romajiTitle": "Hon",
                "coverName": f"http://127.0.0.1:{port}/jiten.jpg",
                "difficulty": 3,
                "characterCount": 620,
                "mediaType": 7,
                "genres": [1],
                "tags": [{"name": "Novel"}],
                "links": [{"url": "https://example.invalid/jp", "linkType": 1}],
            }
        }
    }


def vndb(portrait):
    return {
        "results": [
            {
                "id": "v17",
                "title": "Visual novel",
                "alttitle": "物語",
                "released": "2020-03-04",
                "image": {"url": portrait},
                "description": "Remote VN description",
                "tags": [{"name": "Magic"}],
            }
        ]
    }


def anilist(portrait):
    return {
        "data": {
            "Media": {
                "id": 22,
                "title": {"native": "漫画", "romaji": "Manga", "english": "Book"},
                "description": "<b>Hello</b>~!hidden!~",
                "genres": ["Mystery"],
                "tags": [{"name": "School"}, {"name": "Secret", "isMediaSpoiler": True}],
                "coverImage": {"extraLarge": portrait},
                "startDate": {"year": 2010, "month": 2, "day": None},
            }
        }
    }


def seed(db):
    with db:
        db.execute("DELETE FROM games WHERE id IN ('refresh-jiten','refresh-vndb','refresh-anilist','refresh-done')")
        db.executemany(
            """INSERT INTO games(id,title_original,deck_id,vndb_id,anilist_id,type,completed,description,manual_overrides)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            [
                ("refresh-jiten", "Deck", 42, None, None, None, 0, "", "[]"),
                (
                    "refresh-vndb",
                    "Fixture novel",
                    None,
                    "v17",
                    None,
                    "Visual Novel",
                    0,
                    "Keep description",
                    '["description"]',
                ),
                ("refresh-anilist", "Manga", None, None, "22", "Manga", 0, "", "[]"),
                ("refresh-done", "Done", 88, None, None, None, 1, "", "[]"),
            ],
        )


def saved(db):
    rows = db.execute("""SELECT id,title_original,coalesce(title_romaji,''),coalesce(title_english,''),type,coalesce(description,''),
        coalesce(release_date,''),coalesce(genres,'[]'),coalesce(tags,'[]'),coalesce(links,'[]'),image,coalesce(vndb_character_data,'{}'),
        coalesce(difficulty,''),coalesce(character_count,0)
        FROM games WHERE id IN ('refresh-jiten','refresh-vndb','refresh-anilist') ORDER BY id""").fetchall()
    assert len(rows) == 3
    data = []
    for row in rows:
        game, title = row[:2]
        chars = json.loads(row[11] or "{}")
        if game == "refresh-jiten":
            assert title == "本の題" and row[10].startswith("data:image/jpeg;base64,") and str(row[13]) == "620"
            image = row[10]
        else:
            assert chars["character_count"] == 2 and row[10].startswith("data:image/png;base64,")
            with Image.open(io.BytesIO(base64.b64decode(row[10].split(",")[1]))) as picture:
                assert picture.size == (300, 400)
                image = [picture.getpixel(xy) for xy in [(20, 20), (150, 150), (290, 380)]]
            if game == "refresh-vndb":
                assert title == "物語" and row[5] == "Keep description" and json.loads(row[8]) == ["Magic"]
            else:
                assert title == "漫画" and row[5:7] == ("Hello", "2010-02-01") and json.loads(row[8]) == ["School"]
        data.append([*row[:7], *[json.loads(v or "[]") for v in row[7:10]], image, chars, row[12], int(row[13] or 0)])
    assert db.execute("SELECT title_original FROM games WHERE id='refresh-done'").fetchone() == ("Done",)
    return data


def measure(databases, connections, rounds):
    body = (
        b'--f\r\nContent-Disposition: form-data; name="file"; filename="session.csv"\r\n\r\n'
        b"vndb_id,name,date,duration_seconds,chars,lines\r\nv17,Fixture novel,2026-01-01T00:00:00Z,50,100,1\r\n"
        b'--f\r\nContent-Disposition: form-data; name="clear_previous"\r\n\r\ntrue\r\n--f--\r\n'
    )
    samples = {name: [] for name in databases}
    for i in range(rounds + 1):
        states = {}
        for name in connections if i % 2 == 0 else reversed(connections):
            db = databases[name]
            seed(db)
            conn, process = connections[name]
            cpu = process.cpu_times()
            start = time.perf_counter()
            conn.request("POST", "/api/import-kizuna", body, {"Content-Type": "multipart/form-data; boundary=f"})
            response = conn.getresponse()
            raw = response.read()
            assert response.status == 200 and (name != "rust" or response.getheader("x-gsm-handler") == "rust"), (
                name,
                raw[:512],
            )
            reply = json.loads(raw)
            assert reply["metadata_refresh_status"] == "queued", reply
            enqueue = time.perf_counter() - start
            while not db.execute("""SELECT count(*)=3 FROM games WHERE (id='refresh-jiten' AND title_original='本の題') OR
                (id IN ('refresh-vndb','refresh-anilist') AND vndb_character_data IS NOT NULL AND vndb_character_data!='')""").fetchone()[
                0
            ]:
                if time.perf_counter() - start > 15:
                    raise AssertionError(
                        (
                            name,
                            db.execute(
                                "SELECT id,title_original,length(vndb_character_data),length(image) FROM games"
                            ).fetchall(),
                        )
                    )
                time.sleep(0.005)
            elapsed = time.perf_counter() - start
            end = process.cpu_times()
            states[name] = saved(db)
            if i:
                samples[name].append(
                    {
                        "enqueue_ms": 1000 * enqueue,
                        "ready_ms": 1000 * elapsed,
                        "server_cpu_ms": 1000 * (end.system + end.user - cpu.system - cpu.user),
                        "server_resident_mib": process.memory_info().rss / 1024**2,
                    }
                )
        assert states["rust"] == states["python"], [
            (a[:10], b[:10], a[-2:], b[-2:]) for a, b in zip(states["rust"], states["python"]) if a != b
        ]
    for db in databases.values():
        with db:
            db.execute(
                "DELETE FROM games WHERE id IN ('refresh-jiten','refresh-vndb','refresh-anilist','refresh-done')"
            )
    return {
        name: {key: round(statistics.median(row[key] for row in rows), 4) for key in rows[0]}
        for name, rows in samples.items()
    }


def measure_repull(databases, connections, rounds):
    locked = [
        "deck_id",
        "title_original",
        "title_romaji",
        "title_english",
        "type",
        "description",
        "difficulty",
        "character_count",
        "links",
        "release_date",
        "genres",
        "tags",
        "image",
    ]
    samples = {mode: {name: [] for name in databases} for mode in ("four_sources", "all_overridden")}
    for i in range(rounds + 1):
        for mode, results in samples.items():
            states = {}
            for name in connections if i % 2 == 0 else reversed(connections):
                db = databases[name]
                with db:
                    db.execute("DELETE FROM games WHERE id='repull-fixture'")
                    db.execute(
                        """INSERT INTO games(id,deck_id,vndb_id,anilist_id,title_original,type,description,image,manual_overrides,links)
                        VALUES('repull-fixture',42,'v17','22','手動','Manga','Keep description','my-cover',?,?)""",
                        (
                            json.dumps(locked if mode == "all_overridden" else ["description"]),
                            json.dumps(
                                [
                                    {"url": "https://www.igdb.com/games/fixture-game", "linkType": 1},
                                    {"url": "https://example.invalid/manual"},
                                ]
                            ),
                        ),
                    )
                conn, process = connections[name]
                cpu = process.cpu_times()
                start = time.perf_counter()
                conn.request("POST", "/api/games/repull-fixture/repull-jiten")
                response = conn.getresponse()
                raw = response.read()
                elapsed = time.perf_counter() - start
                end = process.cpu_times()
                assert response.status == 200 and (name != "rust" or response.getheader("x-gsm-handler") == "rust"), (
                    name,
                    raw[:512],
                )
                reply = json.loads(raw)
                assert reply["sources_used"] == ["jiten", "vndb", "anilist", "igdb"] and reply["success"], reply
                row = db.execute("""SELECT title_original,coalesce(title_romaji,''),coalesce(title_english,''),type,description,
                    image,links,genres,tags,vndb_character_data FROM games WHERE id='repull-fixture'""").fetchone()
                assert row[4] == "Keep description"
                if mode == "all_overridden":
                    assert not reply["updated_fields"] and reply["skipped_fields"] == locked and row[5] == "my-cover"
                else:
                    assert row[:4] == ("本の題", "Hon", "Deck game", "Visual Novel")
                    assert reply["skipped_fields"] == ["description"] and row[5].startswith("data:image/jpeg;base64,")
                    assert json.loads(row[7]) == ["Action"] and json.loads(row[8]) == ["Novel"]
                people = json.loads(row[9])
                assert people["vn_id"] == "v17" and people["character_count"] == 2
                states[name] = (reply, *row[:6], *[json.loads(value or "[]") for value in row[6:9]], people)
                if i:
                    results[name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000,
                            "server_resident_mib": process.memory_info().rss / 1024**2,
                        }
                    )
            for idx, (rust, python) in enumerate(zip(states["rust"], states["python"])):
                assert rust == python, (mode, idx, str(rust)[:512], str(python)[:512])
    return {
        mode: {
            name: {key: round(statistics.median(row[key] for row in rows), 4) for key in rows[0]}
            for name, rows in results.items()
        }
        for mode, results in samples.items()
    }


def measure_upgrades(databases, connections, rounds):
    modes = {name: [] for name in databases}
    for i in range(rounds + 1):
        states = {}
        for name in connections if i % 2 == 0 else reversed(connections):
            db = databases[name]
            with db:
                db.execute("DELETE FROM games WHERE id IN ('upgrade-a','upgrade-b','upgrade-c','upgrade-already')")
                db.executemany(
                    """INSERT INTO games(id,title_original,deck_id,vndb_id,anilist_id,type,completed,manual_overrides,links,obs_scene_name)
                    VALUES(?,?,?,?,?,'',1,'["title_original","links"]','["https://manual.invalid/"]','My Scene')""",
                    [
                        ("upgrade-b", "B", None, "v404", "22"),
                        ("upgrade-a", "A", None, "v17", None),
                        ("upgrade-c", "C", None, "v404", "77"),
                        ("upgrade-already", "Linked", 80, None, None),
                    ],
                )
            conn, process = connections[name]
            cpu = process.cpu_times()
            start = time.perf_counter()
            conn.request("POST", "/api/cron/jiten-upgrader/run")
            response = conn.getresponse()
            raw = response.read()
            elapsed = time.perf_counter() - start
            end = process.cpu_times()
            assert response.status == 200 and (name != "rust" or response.getheader("x-gsm-handler") == "rust"), (
                name,
                raw[:512],
            )
            value = json.loads(raw)
            assert value["status"] == "success"
            result = value["result"]
            assert result.pop("elapsed_time") > 0
            assert (
                result["total_checked"],
                result["upgraded_to_jiten"],
                result["already_on_jiten"],
                result["failed"],
                result["not_found_on_jiten"],
            ) == (3, 2, 1, 0, 1), result
            assert [r["game_id"] for r in result["details"]] == ["upgrade-b", "upgrade-a", "upgrade-c"]
            games = []
            for row in db.execute("""SELECT id,deck_id,type,title_original,obs_scene_name,image,links,genres,tags,
                    vndb_character_data,vndb_id,anilist_id FROM games WHERE id IN ('upgrade-a','upgrade-b') ORDER BY id"""):
                assert row[3] in ("A", "B") and row[4] == "My Scene" and row[5].startswith("data:image/jpeg;base64,")
                links, genres, tags, people = map(json.loads, row[6:10])
                assert links == [
                    "https://manual.invalid/",
                    {"url": f"https://jiten.moe/decks/media/{row[1]}/detail", "deckId": int(row[1]), "linkType": 99},
                ]
                assert people["character_count"] == 2
                games.append([*row[:6], links, genres, tags, people, row[10] or "", row[11] or ""])
            states[name] = (result, games)
            if i:
                modes[name].append(
                    {
                        "ms": elapsed * 1000,
                        "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000,
                        "server_resident_mib": process.memory_info().rss / 1024**2,
                    }
                )
        assert states["rust"] == states["python"], (states["rust"][0], states["python"][0])
    return {
        name: {key: round(statistics.median(row[key] for row in rows), 4) for key in rows[0]}
        for name, rows in modes.items()
    }
