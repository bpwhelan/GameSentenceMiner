"""Compare the desktop and Flask game searches using real HTTP to isolated provider fixtures."""

import base64
import io
import json
import socket
import statistics
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from PIL import Image, ImageDraw


def start_fixture(stack):
    source = Image.new("RGBA", (600, 800), (30, 60, 90, 255))
    draw = ImageDraw.Draw(source)
    draw.rectangle((200, 200, 500, 700), fill=(0, 100, 200, 128))
    draw.rectangle((10, 10, 100, 100), fill=(90, 110, 130, 0))
    buffer = io.BytesIO()
    source.save(buffer, format="PNG")
    image = buffer.getvalue()
    cover_buffer = io.BytesIO()
    source.convert("RGB").save(cover_buffer, format="JPEG")
    cover = cover_buffer.getvalue()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def handle(self):
            try:
                super().handle()
            except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                # The disposable desktop exits with idle keep-alive sockets.
                pass

        def setup(self):
            super().setup()
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        def log_message(self, *args):
            pass

        def send_json(self, value, status=200):
            raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            uri = urlsplit(self.path)
            if uri.path in {"/cover.png", "/jiten.jpg"}:
                payload, mime = (image, "image/png") if uri.path == "/cover.png" else (cover, "image/jpeg")
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if uri.path.startswith("/media-deck/by-link-id/"):
                source, key = uri.path.split("/")[-2:]
                if (source, key) == ("2", "v17"):
                    return self.send_json([{}, {"deckId": 52}, 66])
                if (source, key) == ("4", "22"):
                    return self.send_json({"deckId": 53})
                return self.send_json({}, 404)
            if uri.path in {"/media-deck/52/detail", "/media-deck/53/detail"}:
                from benchmark_game_refresh import deck

                entry = deck(self.server.server_port)
                row = entry["data"]["mainDeck"]
                is_vn = uri.path.endswith("/52/detail")
                row.update(
                    deckId=52 if is_vn else 53,
                    mediaType=7 if is_vn else 9,
                    links=[{"url": "https://vndb.org/v17" if is_vn else "https://anilist.co/manga/22"}],
                )
                return self.send_json(entry)
            if uri.path == "/media-deck/42/detail":
                from benchmark_game_refresh import deck

                assert parse_qs(uri.query) == {"offset": ["0"]}
                return self.send_json(deck(self.server.server_port))
            args = parse_qs(uri.query)
            if (
                uri.path != "/media-deck/get-media-decks"
                or args.get("sortBy") != ["title"]
                or args.get("sortOrder") != ["0"]
                or args.get("offset") != ["0"]
                or "titleFilter" not in args
            ):
                return self.send_json({}, 400)
            self.send_json(
                {
                    "data": [
                        {
                            "deckId": i,
                            "originalTitle": f"三国 {i}",
                            "mediaType": 7 if i % 2 else 20,
                            "coverName": "https://example.invalid/cover.jpg",
                            "description": "猫" * 230,
                            "difficulty": 3,
                            "difficultyRaw": str(i % 7 + 0.1),
                            "genres": [7, 18, 44],
                            "tags": [{"name": "Novel"}],
                            "links": [{"url": "x"}],
                        }
                        for i in range(10)
                    ],
                    "totalItems": 50,
                }
            )

        def do_POST(self):
            value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            portrait = f"http://127.0.0.1:{self.server.server_port}/cover.png"
            if self.path == "/kana/vn" and value["filters"][:2] == ["id", "="]:
                from benchmark_game_refresh import vndb

                assert value["filters"][2] == "v17"
                return self.send_json(vndb(portrait))
            if self.path == "/graphql" and "id" in value["variables"] and "page" not in value["variables"]:
                from benchmark_game_refresh import anilist

                assert value["variables"] == {"id": 22, "type": "MANGA"}
                return self.send_json(anilist(portrait))
            if self.path == "/kana/character":
                assert (
                    value["fields"] and value["filters"] == ["vn", "=", ["id", "=", "v17"]] and value["results"] == 100
                )
                page = value["page"]
                assert page in (1, 2)
                rows = (
                    [
                        {
                            "id": "c1",
                            "name": "Aya",
                            "original": "綾",
                            "aliases": ["アヤ"],
                            "description": "[spoiler]秘密[/spoiler]",
                            "sex": ["f"],
                            "gender": ["f"],
                            "age": 18,
                            "vns": [{"id": "v17", "role": "main", "spoiler": 1}],
                            "traits": [
                                {"group_name": "Personality", "name": "Bold", "spoiler": 2},
                                {"group_name": "Personality", "name": "Bold", "spoiler": 0},
                            ],
                            "image": {"url": portrait},
                        },
                        {"id": "c2", "name": "Extra", "vns": [{"id": "v17", "role": "appears", "spoiler": 0}]},
                    ]
                    if page == 1
                    else [{"id": "c3", "name": "Other", "vns": [{"id": "v99", "role": "unknown"}], "height": 165}]
                )
                return self.send_json({"results": rows, "more": page == 1})
            if self.path == "/graphql" and "page" in value.get("variables", {}):
                variables = value["variables"]
                assert variables["type"] == "MANGA" and variables["id"] == 22 and variables["perPage"] == 25
                page = variables["page"]
                assert page in (1, 2)
                node = {
                    "id": 12 + page,
                    "name": {"full": "Aki", "native": "秋", "alternative": ["アキ"]},
                    "gender": "Female",
                    "image": {"medium": portrait} if page == 1 else {},
                    "description": "hello ~!秘密!~",
                    "age": "17",
                }
                return self.send_json(
                    {
                        "data": {
                            "Media": {
                                "characters": {
                                    "pageInfo": {"hasNextPage": page == 1},
                                    "edges": [{"role": "SUPPORTING" if page == 1 else "BACKGROUND", "node": node}],
                                }
                            }
                        }
                    }
                )
            if self.path == "/kana/vn":
                if value["filters"] == ["search", "=", "outage"]:
                    return self.send_json({}, 503)
                assert value["filters"][:2] == ["search", "="] and value["sort"] == "rating" and value["results"] == 10
                self.send_json(
                    {
                        "results": [
                            {
                                "id": f"v{i}",
                                "title": f"本 {i}",
                                "alttitle": None,
                                "image": {"url": "/x.jpg"},
                                "developers": [{"name": "制作"}, {}],
                                "rating": 75,
                                "description": "[b]内容[/b]" * 65,
                            }
                            for i in range(10)
                        ]
                    }
                )
            elif self.path == "/graphql":
                kind = value["variables"]["type"]
                assert kind in {"ANIME", "MANGA"} and "search" in value["variables"] and "idMal" in value["query"]
                self.send_json(
                    {
                        "data": {
                            "Page": {
                                "media": [
                                    {
                                        "id": i + 10,
                                        "title": {"native": "作品", "romaji": None, "english": "A story"},
                                        "format": kind,
                                        "coverImage": {"medium": "cover.png"},
                                        "description": "text <i>here</i>~!remove\nme!~ 日本語",
                                        "siteUrl": f"https://anilist.co/{kind.lower()}/{i + 10}",
                                    }
                                    for i in range(10)
                                ]
                            }
                        }
                    }
                )
            elif self.path == "/api/cloud/igdb/game":
                assert value == {"igdb_slug": "fixture-game"} and self.headers["X-GSM-Client"] == "gsm-desktop"
                self.send_json(
                    {
                        "igdb": {
                            "title": "作品",
                            "igdb_id": 42,
                            "igdb_slug": "fixture-game",
                            "genres": ["Adventure"],
                            "platforms": ["PC"],
                            "links": [
                                {"url": "https://www.igdb.com/games/fixture-game"},
                                {"url": "https://example.invalid/site"},
                            ],
                            "description_candidate": "新しい説明",
                            "release_date": "2025-12-01",
                            "cover_url": f"http://127.0.0.1:{self.server.server_port}/cover.png",
                        }
                    }
                )
            elif self.path == "/api/cloud/igdb/search":
                assert (
                    value["limit"] == 10
                    and self.headers["X-GSM-Client"] == "gsm-desktop"
                    and self.headers["X-GSM-Version"]
                )
                self.send_json(
                    {
                        "results": [
                            {
                                "title": f"Game {i}",
                                "igdb_slug": f"game-{i}",
                                "igdb_id": i,
                                "cover_url": "//images.igdb.com/t_cover_big/box.jpg",
                                "year": 2020,
                                "platforms": ["PC"],
                            }
                            for i in range(10)
                        ]
                    }
                )
            else:
                self.send_json({}, 404)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    stack.callback(server.server_close)
    stack.callback(thread.join, 5)
    stack.callback(server.shutdown)
    return server.server_port


def configure_flask(app, port):
    import requests

    from GameSentenceMiner.util.clients.anilist_api_client import AniListApiClient
    from GameSentenceMiner.util.clients.gsm_cloud_igdb_client import GSMCloudIGDBClient
    from GameSentenceMiner.util.clients.jiten_api_client import JitenApiClient
    from GameSentenceMiner.util.clients.vndb_api_client import VNDBApiClient
    from GameSentenceMiner.web.routes.jiten_linking_routes import jiten_linking_bp
    from GameSentenceMiner.web.routes.cron_routes import cron_bp
    from GameSentenceMiner.web.routes.search_routes import search_bp

    base = f"http://127.0.0.1:{port}"
    JitenApiClient.BASE_URL = base + "/media-deck"
    AniListApiClient.API_URL = base + "/graphql"
    VNDBApiClient.API_URL = base + "/kana/character"
    GSMCloudIGDBClient._get_base_url = classmethod(lambda cls: base)
    send = requests.Session.send

    def local_vndb(session, request, **kwargs):
        if request.url == "https://api.vndb.org/kana/vn":
            request.url = base + "/kana/vn"
        return send(session, request, **kwargs)

    requests.Session.send = local_vndb
    if search_bp.name not in app.blueprints:
        app.register_blueprint(search_bp)
    if cron_bp.name not in app.blueprints:
        app.register_blueprint(cron_bp)
    if jiten_linking_bp.name not in app.blueprints:
        app.register_blueprint(jiten_linking_bp)


def measure(connections, rounds, count):
    def normalize(data):
        if "by_source" not in data:
            return data
        order = data["sources_searched"]
        groups = data["by_source"]
        assert set(order) == set(groups)
        assert data["results"] == [row for name in order for row in groups[name]["results"]]
        for group in groups.values():
            group["results"].sort(key=lambda row: (row["media_type"], row["id"]))
        return {"query": data["query"], "by_source": groups}

    results = {}
    for path in [
        "/api/jiten-search?title=Game",
        "/api/search/unified?q=Game",
        "/api/search/unified?q=outage&sources=vndb,jiten,missing",
    ]:
        samples = {name: [] for name in connections}
        for i in range(rounds + 1):
            bodies = {}
            for name in connections if i % 2 == 0 else reversed(connections):
                conn, proc = connections[name]
                cpu = proc.cpu_times()
                repeats = count if i else 1
                elapsed = 0
                for _ in range(repeats):
                    start = time.perf_counter()
                    conn.request("GET", path)
                    response = conn.getresponse()
                    buf = response.read()
                    elapsed += time.perf_counter() - start
                    assert response.status == 200 and (
                        name != "rust" or response.getheader("x-gsm-handler") == "rust"
                    ), (name, response.status, buf[:256])
                    value = json.loads(buf)
                    if "title=" in path:
                        assert len(value["results"]) == 10
                    elif "outage" in path:
                        assert value["by_source"]["vndb"]["error"] and len(value["results"]) == 10
                    else:
                        assert len(value["results"]) == 50, (
                            name,
                            value["by_source"].keys(),
                            [(k, v["error"]) for k, v in value["by_source"].items()],
                        )
                    normalized = normalize(value)
                    if name in bodies:
                        assert normalized == bodies[name]
                    bodies[name] = normalized
                end = proc.cpu_times()
                if i:
                    samples[name].append(
                        {
                            "ms": elapsed * 1000 / repeats,
                            "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000 / repeats,
                            "server_resident_mib": proc.memory_info().rss / 1024**2,
                        }
                    )
            assert bodies["python"] == bodies["rust"], [
                (key, bodies["python"].get(key), bodies["rust"].get(key))
                for key in bodies["python"]
                if bodies["python"].get(key) != bodies["rust"].get(key)
            ][:1]
        results[path] = {
            name: {k: round(statistics.median(v[k] for v in rows), 4) for k in rows[0]}
            for name, rows in samples.items()
        }
    return results


def measure_links(databases, connections, rounds):
    samples = {stage: {name: [] for name in connections} for stage in ("initial", "overwrite")}
    for i in range(rounds + 1):
        for stage in samples:
            results = {}
            for name in connections if i % 2 == 0 else reversed(connections):
                db = databases[name]
                if stage == "initial":
                    with db:
                        db.execute("DELETE FROM games WHERE id='igdb-bench'")
                        db.execute("""INSERT INTO games(id,title_original,description,obs_scene_name,manual_overrides,links)
                            VALUES('igdb-bench','手動','手動の説明','OBS Scene','["title_original","description","image"]','[]')""")
                overwrite = stage == "overwrite"
                conn, proc = connections[name]
                payload = json.dumps(
                    {"igdb_url": "https://www.igdb.com/games/fixture-game/", "overwrite_metadata": overwrite}
                )
                cpu = proc.cpu_times()
                start = time.perf_counter()
                conn.request("POST", "/api/games/igdb-bench/link-igdb", payload, {"Content-Type": "application/json"})
                response = conn.getresponse()
                raw = response.read()
                elapsed = time.perf_counter() - start
                end = proc.cpu_times()
                assert response.status == 200 and (name != "rust" or response.getheader("x-gsm-handler") == "rust"), (
                    name,
                    raw[:256],
                )
                saved = db.execute(
                    "SELECT title_original,title_romaji,title_english,type,description,obs_scene_name,release_date,genres,tags,links,manual_overrides,image FROM games WHERE id='igdb-bench'"
                ).fetchone()
                fields = list(saved[:7]) + [json.loads(value) for value in saved[7:-1]]
                assert fields[:7] == [
                    "作品" if overwrite else "手動",
                    "作品",
                    "作品",
                    "Game",
                    "新しい説明" if overwrite else "手動の説明",
                    "OBS Scene",
                    "2025-12-01",
                ], fields
                assert fields[7:9] == [["Adventure"], ["Platform: PC"]]
                assert saved[-1].startswith("data:image/png;base64,")
                with Image.open(io.BytesIO(base64.b64decode(saved[-1].split(",")[1]))) as thumbnail:
                    assert thumbnail.size == (300, 400)
                    pixels = [thumbnail.convert("RGB").getpixel(xy) for xy in [(20, 20), (150, 150), (280, 350)]]
                    assert pixels[0] == (255, 255, 255) and pixels[-1] == (30, 60, 90)
                    assert all(abs(x - y) <= 1 for x, y in zip(pixels[1], (127, 177, 227))), pixels
                results[name] = (json.loads(raw), fields, pixels)
                if i:
                    samples[stage][name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000,
                            "server_resident_mib": proc.memory_info().rss / 1024**2,
                        }
                    )
            assert results["rust"] == results["python"], results
    return {
        stage: {
            name: {k: round(statistics.median(v[k] for v in rows), 4) for k in rows[0]} for name, rows in modes.items()
        }
        for stage, modes in samples.items()
    }


def measure_jiten_links(databases, connections, rounds, port, dictionary_fixture=None):
    from urllib.request import urlopen

    base = f"http://127.0.0.1:{port}"
    with urlopen(base + "/cover.png", timeout=3) as response:
        portrait = "data:image/png;base64," + base64.b64encode(response.read()).decode()
    with urlopen(base + "/jiten.jpg", timeout=3) as response:
        cover = "data:image/jpeg;base64," + base64.b64encode(response.read()).decode()
    samples = {key: {name: [] for name in connections} for key in ("Visual Novel", "Manga")}
    for i in range(rounds + 1):
        for kind, modes in samples.items():
            states = {}
            vn = kind == "Visual Novel"
            for name in connections if i % 2 == 0 else reversed(connections):
                db = databases[name]
                dictionary = None
                if dictionary_fixture is not None:
                    profile = (
                        dictionary_fixture / "python-home/profile"
                        if name == "python"
                        else Path(db.execute("PRAGMA database_list").fetchone()[2]).parent
                    )
                    assert profile.resolve().is_relative_to(dictionary_fixture.resolve())
                    directory = profile / "dictionaries/sudachi"
                    meta = directory / "metadata/jiten-bench.json"
                    csv = directory / "csv/jiten-bench.csv"
                    csv.unlink(missing_ok=True)
                    meta.unlink(missing_ok=True)
                with db:
                    db.execute("DELETE FROM games WHERE id='jiten-bench'")
                    db.execute("DELETE FROM game_lines WHERE game_name='Jiten Scene'")
                    db.execute("""INSERT INTO games(id,title_original,manual_overrides,links)
                        VALUES('jiten-bench','Original title','["title_english"]','[]')""")
                    db.executemany(
                        """INSERT INTO game_lines(id,game_name,game_id,timestamp,line_text)
                        VALUES(?, 'Jiten Scene',?,1700000000,'語')""",
                        [(f"jiten-line-{n}", "jiten-bench" if n == 0 else "previous-game") for n in range(100)],
                    )
                url = "https://vndb.org/v17/" if vn else "https://anilist.co/manga/22/Title"
                data = {
                    "deck_id": 123,
                    "jiten_data": {
                        "title_original": "作品",
                        "title_english": "The title",
                        "difficulty": 0,
                        "character_count": 1000,
                        "media_type_string": kind,
                        "cover_name": base + "/jiten.jpg",
                        "genres": ["Adventure"],
                        "tags": ["Mystery"],
                        "links": [url],
                    },
                }
                conn, proc = connections[name]
                cpu = proc.cpu_times()
                start = time.perf_counter()
                conn.request(
                    "POST", "/api/games/jiten-bench/link-jiten", json.dumps(data), {"Content-Type": "application/json"}
                )
                response = conn.getresponse()
                raw = response.read()
                elapsed = time.perf_counter() - start
                end = proc.cpu_times()
                assert response.status == 200 and (name != "rust" or response.getheader("x-gsm-handler") == "rust"), (
                    name,
                    raw[:512],
                )
                if dictionary_fixture is not None:
                    while not meta.is_file():
                        if time.perf_counter() - start > 5:
                            raise AssertionError(f"{name} did not publish {meta}")
                        time.sleep(0.001)
                    ready_ms = (time.perf_counter() - start) * 1000
                    end = proc.cpu_times()
                    dictionary = (csv.read_bytes(), json.loads(meta.read_bytes()))
                    assert dictionary[1]["row_count"] > 0 and dictionary[1]["title"] == "作品"
                reply = json.loads(raw)
                assert reply["lines_updated"] == 100
                row = db.execute("""SELECT title_original,title_english,obs_scene_name,deck_id,character_count,difficulty,type,
                    image,links,genres,tags,vndb_id,anilist_id,vndb_character_data FROM games WHERE id='jiten-bench'""").fetchone()
                assert list(row[:8]) == ["作品", "The title", "Jiten Scene", "123", "1000", "0", kind, cover]
                links, genres, tags = map(json.loads, row[8:11])
                assert links == [
                    {"url": url, "linkType": 1},
                    {"url": "https://jiten.moe/decks/media/123/detail", "linkType": 99, "deckId": 123},
                ]
                assert genres == ["Adventure"] and tags == ["Mystery"]
                assert (row[11] or "", row[12] or "") == (("v17", "") if vn else ("", "22"))
                characters = json.loads(row[-1])
                assert characters["character_count"] == 2 and len(characters["characters"]["side"]) == 1
                first = characters["characters"]["main" if vn else "primary"][0]
                assert first["image_base64"] == portrait
                if vn:
                    assert first["personality"] == [{"name": "Bold", "spoiler": 2}]
                else:
                    assert first["description_has_spoilers"]
                mappings = db.execute(
                    "SELECT id,game_id FROM game_lines WHERE game_name='Jiten Scene' ORDER BY id"
                ).fetchall()
                assert len(mappings) == 100 and all(game == "jiten-bench" for _, game in mappings)
                states[name] = (reply, characters, mappings, dictionary)
                # Restore the four installation-smoke rows before its reopen check.
                with db:
                    db.execute("DELETE FROM game_lines WHERE game_id='jiten-bench'")
                    db.execute("DELETE FROM games WHERE id='jiten-bench'")
                if i:
                    modes[name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000,
                            "server_resident_mib": proc.memory_info().rss / 1024**2,
                        }
                    )
                    if dictionary_fixture is not None:
                        modes[name][-1]["dictionary_ready_ms"] = ready_ms
            assert states["python"] == states["rust"], (
                kind,
                states["python"][0],
                states["rust"][0],
                states["python"][-1],
                states["rust"][-1],
            )
    return {
        stage: {
            name: {key: round(statistics.median(v[key] for v in rows), 4) for key in rows[0]}
            for name, rows in modes.items()
        }
        for stage, modes in samples.items()
    }
