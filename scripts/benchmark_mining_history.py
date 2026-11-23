"""Compare the normal GSM history and Anki media paths on a temporary profile."""

import argparse
import base64
import gc
import hashlib
import json
import os
import platform
import statistics
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def media_bytes():
    return bytes(range(256)) * 32768 + b"x"


def sample_operation_memory(desktop_pid, operation, prefix):
    # Profile extra operations outside the timed run. Sampling from a separate
    # process also observes Python while its JSON encoder holds the GIL.
    probe = subprocess.Popen(
        [sys.executable, "-u", __file__, "--memory-probe", str(os.getpid()), str(desktop_pid)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        assert probe.stdout.readline().strip() == "ready"
        for _ in range(3):
            operation()
        output, _ = probe.communicate("x", timeout=15)
        assert probe.returncode == 0
        return {f"{prefix}_{key}": value for key, value in json.loads(output).items()}
    finally:
        if probe.poll() is None:
            probe.kill()
            probe.wait()


def memory_probe(worker_pid, desktop_pid):
    processes = [psutil.Process(worker_pid), psutil.Process(desktop_pid)]

    def used():
        return sum(p.memory_full_info().uss for p in processes) / 2**20

    stop = threading.Event()

    def wait_for_finish():
        sys.stdin.read(1)
        stop.set()

    threading.Thread(target=wait_for_finish, daemon=True).start()
    baseline = peak = used()
    print("ready", flush=True)
    while not stop.is_set():
        peak = max(peak, used())
        stop.wait(0.003)
    print(json.dumps({"baseline_mib": baseline, "peak_mib": peak}))


ITERATIONS = {
    "dialogue-intake-sources": 512,
    "dialogue-mixed": 36,
    "dialogue-journal-mixed": 48,
    "dialogue-journal-live": 12,
    "dialogue-journal-receipts": 24,
    "dialogue-journal-retention": 8,
    "dialogue-journal-feed": 64,
    "dialogue-journal-feed-bounded": 128,
    "dialogue-journal-feed-short": 192,
    "dialogue-long": 18,
    "dialogue-burst": 18,
    "dialogue-live": 8,
    "dialogue-mixed-broker": 4,
    "cards-single": 64,
    "cards-batch": 12,
    "cards-latest-small": 48,
    "cards-latest": 24,
    "group-small": 16,
    "group-chooser": 8,
    "group-auto": 8,
    "group-auto-late": 8,
    "group-merge": 20,
    "sync-small": 8,
    "sync-collection": 3,
    "sync-incremental": 16,
    "cron-scheduler": 24,
    "cron-rollup": 1,
    "cron-anki-sync": 1,
    "heatmap": 4,
    "daily": 50,
    "today": 15,
    "update": 200,
    "media": 8,
    "capture": 100,
    "import": 8,
    "link": 4,
    "kanji": 10,
    "frequency": 20,
    "dashboard": 6,
    "overview": 15,
    "milestones": 8,
    "poll": 50,
    "anki-monitor": 5,
    "anki-monitor-default": 5,
    "edit": 35,
    "maturity-small": 60,
    "maturity": 8,
    "reading-impact": 8,
    "anki-game-stats": 12,
    "anki-earliest": 12,
    "anki-note-kanji": 12,
    "anki-retention": 12,
    "rollup-small": 8,
    "rollup-mixed": 3,
    "rollup-indexed": 3,
    "rollup-repeat": 3,
    "rollup-year": 1,
    "search-like": 12,
    "search-regex": 6,
    "search-regex-fancy": 6,
    "search-tokenized": 20,
    "search-duplicates-window": 5,
    "search-duplicates-all": 5,
    "maint-games-list": 20,
    "maint-preview-delete": 8,
    "maint-preview-dedup": 6,
    "tok-words": 20,
    "tok-kanji": 12,
    "tok-not-in-anki": 10,
    "tok-not-in-anki-missing-kanji": 8,
    "game-stats": 12,
    "dashboard-stats": 8,
}


class AnkiFixture(BaseHTTPRequestHandler):
    def group(self, payload):
        from scripts.benchmark_anki_grouping import Collection

        with self.server.monitors_lock:
            collection = self.server.groups.get(self.path)
            if collection is None:
                collection = self.server.groups[self.path] = Collection(self.path.split("/")[2])
        body = collection.reply(payload)
        if body is None:
            self.close_connection = True
        else:
            self.reply(body)

    def monitor(self, payload):
        from scripts.benchmark_anki_monitor import Collection

        with self.server.monitors_lock:
            collection = self.server.monitors.get(self.path)
            if collection is None:
                collection = self.server.monitors[self.path] = Collection()
        self.reply(collection.reply(payload))

    def do_GET(self):
        if self.path.startswith("/group/"):
            self.group(None)
            return
        if self.path.startswith("/monitor/"):
            self.monitor(None)
            return
        if self.path.startswith("/sync/busy/"):
            self.reply(json.dumps(self.path in self.server.busy_syncs).encode())
            return
        self.reply(json.dumps(self.server.edits[self.path]).encode())

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.startswith("/cards/"):
            from scripts.benchmark_anki_cards import reply

            action = payload["action"]
            assert payload["version"] == 6 and (
                (action == "findNotes" and payload["params"] == {"query": "added:1"})
                or (action == "notesInfo" and set(payload["params"]) == {"notes"})
            )
            self.reply(reply(self.path.split("/")[-1], action, tuple(payload["params"].get("notes", ()))))
            return
        if self.path.startswith("/group/"):
            self.group(payload)
            return
        if self.path.startswith("/monitor/"):
            self.monitor(payload)
            return
        if self.path.startswith("/sync/busy/"):
            self.server.busy_syncs.add(self.path)
            self.reply(b'{"result":null,"error":"A collection operation is active."}')
            return
        if self.path.startswith("/sync/"):
            from scripts.benchmark_anki_sync import reply

            self.reply(reply(self.path, payload))
            return
        if self.path.startswith("/edit/"):
            state = self.server.edits.setdefault(self.path, {"step": 0, "busy": False, "completed": 0})
            actions = [
                ("guiSelectedNotes", {}, []),
                ("updateNoteFields", {"note": {"id": 17, "fields": {"Sentence": "日<br>本", "Empty": ""}}}, None),
                ("addTags", {"tags": "mined unvoiced", "notes": [17]}, None),
                ("removeTags", {"tags": "overlay", "notes": [17]}, None),
            ]
            action, params, result = actions[state["step"]]
            if payload != {"action": action, "version": 6, "params": params}:
                self.reply(json.dumps({"result": None, "error": f"Expected {action} at step {state['step']}"}).encode())
                return
            if action == "addTags" and not state["busy"]:
                state["busy"] = True
                self.reply(b'{"result":null,"error":"A collection operation is active."}')
                return
            state["step"] = (state["step"] + 1) % len(actions)
            if state["step"] == 0:
                state["completed"] += 1
            self.reply(json.dumps({"result": result, "error": None}).encode())
            return
        if payload == {"action": "findNotes", "version": 6, "params": {"query": "added:1"}}:
            self.reply(self.server.notes[self.path])
            return
        valid = (
            payload["version"] == 6
            and payload["action"] == "storeMediaFile"
            and payload["params"]["filename"] == "声.webm"
            and hashlib.sha256(base64.b64decode(payload["params"]["data"], validate=True)).digest()
            == self.server.media_digest
        )
        body = json.dumps(
            {"result": "声.webm", "error": None} if valid else {"result": None, "error": "Wrong upload"}
        ).encode()
        self.reply(body)

    def reply(self, body):
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def setup_worker(profile, *, real_logging=False):
    from scripts.benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module

    _configure_bootstrap_environment(profile / "bootstrap")
    os.environ["GSM_TEST_DATA_ROOT"] = str(profile)
    if not real_logging:
        _install_noop_logging_module()
    from GameSentenceMiner.util.database.db import (
        GameLinesTable,
        GamesTable,
        SQLiteDB,
        StatsRollupTable,
        ThirdPartyStatsTable,
    )

    db = SQLiteDB(str(profile / "gsm.db"))
    for table in (GameLinesTable, GamesTable, StatsRollupTable, ThirdPartyStatsTable):
        table.set_db(db)
    return db


def maturity_cycle(db, case):
    from flask import Flask

    from GameSentenceMiner.util.config.configuration import get_config, get_master_config
    from GameSentenceMiner.util.database.anki_tables import setup_anki_tables
    from GameSentenceMiner.web.anki_api_endpoints import register_anki_api_endpoints
    from GameSentenceMiner.web.tokenization_api import register_tokenization_api_routes

    setup_anki_tables(db)
    config = get_config()
    experimental = get_master_config().experimental
    experimental.enable_experimental_features = experimental.enable_tokenization = True
    config.anki.word_field = "Expression"
    config.anki.parent_tag = "Game"
    count = 64 if case == "maturity-small" else 8192
    first = datetime.now(UTC).astimezone().date() - timedelta(days=200)
    timestamps = [
        int(datetime.combine(first + timedelta(days=i), datetime.min.time()).replace(hour=12).timestamp())
        for i in range(185)
    ]

    def seed(conn):
        if case == "reading-impact":
            activity = {
                str(i): {"title": f"Title {i}", "chars": 1000 + i, "time": 300, "lines": 100} for i in range(12)
            }
            conn.execute(
                "INSERT INTO daily_stats_rollup(date,total_characters,total_reading_time_seconds,game_activity_data) VALUES (?,?,?,?)",
                (first.isoformat(), sum(g["chars"] for g in activity.values()), 3600, json.dumps(activity)),
            )
        for i in range(count):
            note = timestamps[i % 180] * 1000 + i
            fields = {"Expression": {"value": f"単語{i // 2}"}, "Other": {"value": "extra"}}
            conn.execute(
                "INSERT INTO anki_notes(note_id,fields_json,tags) VALUES (?,?,?)",
                (note, json.dumps(fields), json.dumps([f"Game::Title {i % 12}", *(["NSFW"] if i % 2 else [])])),
            )
            conn.execute(
                "INSERT INTO anki_cards(card_id,note_id,interval,synced_at) VALUES (?,?,21,?)",
                (i, note, timestamps[i % 180 + 4]),
            )
            conn.executemany(
                "INSERT INTO card_kanji_links(card_id,kanji_id) VALUES (?,?)", [(i, i % 1024), (i, (i + 1) % 1024)]
            )
            conn.executemany(
                "INSERT INTO anki_reviews(review_id,card_id,note_id,review_time,ease,interval,time_taken) VALUES (?,?,?,?,?,?,?)",
                [
                    (
                        f"{i}_{j}",
                        i,
                        note if i % 3 else 0,
                        timestamps[i % 180 + j] * 1000,
                        1 if j == 1 else 3,
                        10 if j == 0 or i % 7 == 0 else 21,
                        1500 + i % 500,
                    )
                    for j in range(5)
                ],
            )

    db.run_transaction(seed)
    app = Flask(__name__)
    register_tokenization_api_routes(app)
    register_anki_api_endpoints(app)
    client = app.test_client()
    url = "/api/tokenization/maturity-history"
    if case == "anki-game-stats":
        url = "/api/anki_game_stats"
    elif case == "anki-earliest":
        url = "/api/anki_earliest_date"
    elif case == "anki-note-kanji":
        url = "/api/anki_kanji_stats"
    elif case == "anki-retention":
        url = "/api/anki_nsfw_sfw_retention"
    elif case == "reading-impact":
        url = f"/api/anki-reading-impact?start_timestamp={timestamps[0] * 1000}&end_timestamp={timestamps[-1] * 1000}"

    def cycle():
        response = client.get(url)
        assert response.status_code == 200, response.data
        result = response.get_json()
        if case == "anki-game-stats":
            assert len(result) == 12 and sum(g["total_reviews"] for g in result) == count * 5
        elif case == "anki-earliest":
            assert result == {"earliest_date": timestamps[0]}
        elif case == "anki-note-kanji":
            assert result["anki_kanji_count"] == 2
        elif case == "anki-retention":
            assert result["nsfw_reviews"] == result["sfw_reviews"] == count * 5 // 2
            assert result["nsfw_retention"] == result["sfw_retention"] == 80
        elif case == "reading-impact":
            assert sum(result["mature_words"]) == count // 2 and sum(result["mature_kanji"]) == 1024
            assert len(result["per_game"]) == 12
        else:
            assert result["series"]["mature_words"]["total"] == count // 2
            assert result["series"]["unique_kanji"]["total"] == min(1024, count + 1)
        return result

    return cycle


def run_worker(args):
    profile = Path(os.environ["GSM_PROFILE_DIR"])
    db = setup_worker(profile, real_logging=args.case == "dialogue-intake-sources")
    from GameSentenceMiner.native import history
    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.util.database.db import GameLinesTable

    endpoint = json.loads((profile / "electron/agent-control.json").read_text())
    bus = bus_client.start_bus(client_id="backend", port=endpoint["port"], token=endpoint["token"])
    assert bus.wait_connected(5)
    os.environ["GSM_CLIENT_ID"] = "backend"
    os.environ["GSM_NATIVE_ANKI_MEDIA"] = os.environ["GSM_NATIVE_HISTORY"] = "1" if args.worker == "rust" else "0"
    os.environ["GSM_NATIVE_ANKI_POLL"] = os.environ["GSM_NATIVE_HISTORY"]
    os.environ["GSM_NATIVE_ANKI_EDIT"] = os.environ["GSM_NATIVE_HISTORY"]
    os.environ["GSM_NATIVE_ANKI_REPORTS"] = os.environ["GSM_NATIVE_HISTORY"]
    os.environ["GSM_NATIVE_DAILY_ROLLUP"] = os.environ["GSM_NATIVE_HISTORY"]
    os.environ["GSM_NATIVE_SEARCH"] = os.environ["GSM_NATIVE_HISTORY"]
    os.environ["GSM_NATIVE_MAINTENANCE"] = os.environ["GSM_NATIVE_HISTORY"]
    os.environ["GSM_NATIVE_TOKENIZATION"] = os.environ["GSM_NATIVE_HISTORY"]
    os.environ["GSM_NATIVE_DASHBOARD_STATS"] = os.environ["GSM_NATIVE_HISTORY"]
    assert history.managed(db) == (args.worker == "rust")
    case = args.case
    if case.startswith("dialogue-"):
        if case == "dialogue-intake-sources":
            from scripts.benchmark_desktop_intake import measure

            try:
                print(json.dumps(measure(args.worker, endpoint["pid"], ITERATIONS[case])))
            finally:
                bus.stop()
                db.close()
            return
        if case.startswith("dialogue-journal-"):
            from scripts.benchmark_dialogue_journal import measure
        else:
            from scripts.benchmark_dialogue_correlation import measure

        try:
            print(json.dumps(measure(case, args.worker, endpoint["pid"], ITERATIONS[case])))
        finally:
            bus.stop()
            db.close()
        return
    if case.startswith("group-"):
        from scripts.benchmark_anki_grouping import measure

        try:
            print(json.dumps(measure(bus, endpoint["pid"], args.worker, case, args.port, ITERATIONS[case])))
        finally:
            bus.stop()
            db.close()
        return
    if case in ("anki-monitor", "anki-monitor-default"):
        from scripts.benchmark_anki_monitor import measure

        try:
            rate_ms = 1000 if case == "anki-monitor-default" else 100
            print(json.dumps(measure(bus, endpoint["pid"], args.worker, args.port, rate_ms=rate_ms)))
        finally:
            bus.stop()
            db.close()
        return
    if case.startswith("sync-"):
        from scripts.benchmark_anki_sync import measure

        os.environ["GSM_NATIVE_ANKI_SYNC"] = os.environ["GSM_NATIVE_HISTORY"]
        try:
            print(json.dumps(measure(db, bus, endpoint["pid"], args, ITERATIONS[case])))
        finally:
            db.close()
            bus.stop()
        return
    if case in ("cron-scheduler", "cron-rollup", "cron-anki-sync"):
        from scripts.benchmark_cron_scheduler import measure, measure_scheduled

        # The previous desktop already used the Rust game linker. Hold it
        # constant and measure the change in scheduling ownership.
        os.environ["GSM_NATIVE_DAILY_ROLLUP"] = os.environ["GSM_NATIVE_ANKI_SYNC"] = os.environ[
            "GSM_NATIVE_HISTORY"
        ] = "1"
        os.environ["GSM_NATIVE_CRON"] = "1" if args.worker == "rust" else "0"
        try:
            if case != "cron-scheduler":
                print(json.dumps(measure_scheduled(db, bus, endpoint["pid"], args)))
            else:
                print(json.dumps(measure(db, bus, endpoint["pid"], ITERATIONS[case], args.worker)))
        finally:
            db.close()
            bus.stop()
        return
    if case in ("heatmap", "update"):
        rows = 12000 if case == "heatmap" else 1 + ITERATIONS["update"]
        db.executemany(
            "INSERT INTO game_lines(id,game_name,line_text,timestamp,note_ids) VALUES (?,?,?,?,?)",
            [
                (str(i), "Game", "日本語で読む。" * 7, 1700000000 + i * 360, "[1,2]" if i % 4 == 0 else "[]")
                for i in range(rows)
            ],
            commit=True,
        )
    if case.startswith("cards-"):
        from scripts.benchmark_anki_cards import setup

        cycle, verify_cards = setup(case, args.worker, args.port)
    elif case in ("heatmap", "daily", "today", "kanji", "frequency", "dashboard", "overview", "milestones"):
        from flask import Flask

        from GameSentenceMiner.web.stats_api import register_stats_api_routes

        app = Flask(__name__)
        register_stats_api_routes(app)
        client = app.test_client()
        url = "/api/mining_heatmap"
        if case == "kanji":
            url = "/api/game/game/kanji-grid"
            db.execute("INSERT INTO games(id,title_original) VALUES ('game','Game')", commit=True)
            db.executemany(
                "INSERT INTO game_lines(id,game_id,line_text) VALUES (?,'game',?)",
                [(str(i), "日本語で読む。𠀀" * 7) for i in range(12000)],
                commit=True,
            )
        elif case in ("frequency", "dashboard"):
            url = "/api/kanji-frequency?kanji=日" if case == "frequency" else "/api/stats/kanji-grid"
            start = datetime.now(UTC).astimezone().date() - timedelta(days=364)
            counts = {chr(0x4E00 + i): i for i in range(300)} | {"日": 11}
            db.executemany(
                "INSERT INTO daily_stats_rollup(date,kanji_frequency_data) VALUES (?,?)",
                [((start + timedelta(days=i)).isoformat(), json.dumps(counts | {"火": i})) for i in range(365)],
                commit=True,
            )
        elif case == "milestones":
            url = "/api/stats/game-milestones"
            cover = "A" * 8192
            db.executemany(
                "INSERT INTO games(id,title_original,release_date,difficulty,image) VALUES (?,?,?,?,?)",
                [(str(i), f"Game {i}", f"{2000 + i % 25}-01-03T13:04", i % 6, cover) for i in range(500)],
                commit=True,
            )
            db.executemany(
                "INSERT INTO game_lines(id,game_id,timestamp) VALUES (?,?,?)",
                [(str(i), str(i % 500), 1700000000 + i) for i in range(2000)],
                commit=True,
            )
        elif case == "overview":
            today = datetime.now(UTC).astimezone().date()
            midnight = datetime.combine(today, datetime.min.time()).timestamp()
            days = [(today - timedelta(days=i)).isoformat() for i in range(1, 366)]
            db.executemany(
                "INSERT INTO daily_stats_rollup(date,total_characters,total_reading_time_seconds) VALUES (?,?,?)",
                [(date, 600, 120) for date in days],
                commit=True,
            )
            db.executemany(
                "INSERT INTO third_party_stats(date,characters_read,time_read_seconds,source) VALUES (?,?,?,?)",
                [(date, 100, 30, "manual") for date in days[::2]],
                commit=True,
            )
            db.executemany(
                "INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES (?,?,?,?)",
                [(str(i), "Game", "本を読む。", midnight + i * 4) for i in range(1024)],
                commit=True,
            )
            url = "/api/stats/all-lines-data"
        elif case == "daily":
            first = datetime.now(UTC).astimezone().date() - timedelta(days=364)
            db.executemany(
                "INSERT INTO daily_stats_rollup(date,total_characters,total_reading_time_seconds) VALUES (?,?,?)",
                [((first + timedelta(days=i)).isoformat(), 1200, 360) for i in range(0, 365, 2)],
                commit=True,
            )
            url = "/api/daily-activity?all_time=true"
        elif case == "today":
            url = "/api/today-stats"
            day = (datetime.now(UTC).astimezone() - timedelta(hours=4)).date()
            start = datetime.combine(day, datetime.min.time()).replace(hour=4).timestamp()
            db.executemany(
                "INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES (?,?,?,?)",
                [(str(i), str((i // 256) % 2), "あいうえお。", start + i * 8) for i in range(1024)],
                commit=True,
            )

        def cycle():
            response = client.get(url)
            assert response.status_code == 200, response.data
            result = response.get_json()
            if case == "kanji":
                assert [entry["kanji"] for entry in result["kanji_data"]] == list("日本語読𠀀")
                assert result["max_frequency"] == 84000
            elif case == "frequency":
                assert result == {"kanji": "日", "count": 4015}
            elif case == "dashboard":
                assert result["unique_count"] == 302
                assert next(v["frequency"] for v in result["kanji_data"] if v["kanji"] == "日") == 4004
            elif case == "daily":
                assert result["charsData"] == [1200, 0] * 182 + [1200]
                assert result["timeData"] == [0.1, 0] * 182 + [0.1]
                assert result["speedData"] == [12000, 0] * 182 + [12000]
            elif case == "milestones":
                assert result["oldest_game"]["title_original"] == "Game 0"
                assert result["newest_game"]["title_original"] == "Game 499"
                assert result["oldest_game"]["image"] == result["newest_game"]["image"] == cover
            elif case == "overview":
                assert len(result) == 366, f"Expected 366 reading days, got {len(result)}"
                assert sum(day["characters"] for day in result) == 365 * 600 + 183 * 100 + 1024 * 4
                assert result[-1]["reading_time_seconds"] == 4092
            elif case == "today":
                assert result["todayTotalChars"] == 5120 and result["todaySessions"] == 4
            else:
                assert sum(sum(days.values()) for days in result.values()) == 3000
            return result
    elif case.startswith("search-"):
        from flask import Flask
        from urllib.parse import urlencode

        from GameSentenceMiner.util.database.tokenization_tables import (
            KanjiOccurrencesTable,
            KanjiTable,
            WordOccurrencesTable,
            WordsTable,
            create_tokenization_indexes,
        )
        from GameSentenceMiner.web.database_api import register_database_api_routes

        if case == "search-tokenized":
            try:
                db.execute("ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0", commit=True)
            except Exception:
                pass
            for cls in (WordsTable, KanjiTable, WordOccurrencesTable, KanjiOccurrencesTable):
                cls.set_db(db)
            create_tokenization_indexes(db)

        games = ["Game Alpha", "Game Beta", "Game Gamma", "Game Delta"]
        base_ts = 1700000000.0
        rows = []
        for i in range(20000):
            game_name = games[i % 4]
            if case.startswith("search-duplicates-"):
                # Create 200 same-game time-window duplicates and 190 same-game far-apart duplicates
                if i % 100 == 4:
                    text = f"重複テストの台詞番号{i - 4}です。"
                    ts = base_ts + (i - 4) * 5.0 + 30.0
                elif i % 100 == 50 and i >= 1000:
                    text = f"重複テストの台詞番号{i - 1000}です。"
                    ts = base_ts + i * 5.0
                else:
                    text = f"重複テストの台詞番号{i}です。"
                    ts = base_ts + i * 5.0
            else:
                if i % 40 == 0:
                    text = f"伝説の魔法が世界を変える第{i}章の物語です。"
                elif i % 37 == 0:
                    text = f"巨大なドラゴンと戦う冒険者{i}の記録。"
                else:
                    text = f"日常の会話シーン番号{i}：今日もいい天気ですね。"
                ts = base_ts + i * 10.0
            rows.append(
                (
                    f"line-{i:05d}",
                    game_name,
                    text,
                    ts,
                    "trans" if i % 5 == 0 else None,
                    "/a.mp3" if i % 3 == 0 else None,
                    "/s.png" if i % 2 == 0 else None,
                )
            )
        db.executemany(
            "INSERT INTO game_lines(id,game_name,line_text,timestamp,translation,audio_path,screenshot_path) "
            "VALUES (?,?,?,?,?,?,?)",
            rows,
            commit=True,
        )
        if case == "search-tokenized":
            db.execute(
                "INSERT INTO words(id,word,reading,pos,first_seen,last_seen) VALUES (1,'魔法','マホウ','名詞',?,?)",
                (base_ts, base_ts + 200000.0),
                commit=True,
            )
            db.executemany(
                "INSERT INTO word_occurrences(word_id,line_id) VALUES (1,?)",
                [(f"line-{i:05d}",) for i in range(0, 20000, 40)],
                commit=True,
            )

        app = Flask(__name__)
        register_database_api_routes(app)
        client = app.test_client()

        if case == "search-like":
            url = "/api/search-sentences?" + urlencode({"q": "魔法", "sort": "date_desc", "page": 1, "page_size": 20})

            def cycle():
                r = client.get(url)
                assert r.status_code == 200, r.data
                data = r.get_json()
                assert data["total"] == 500 and len(data["results"]) == 20
                return data
        elif case == "search-regex":
            url = "/api/search-sentences?" + urlencode(
                {"q": "魔法|ドラゴン|冒険", "use_regex": "true", "sort": "date_desc", "page": 2, "page_size": 20}
            )

            def cycle():
                r = client.get(url)
                assert r.status_code == 200, r.data
                data = r.get_json()
                assert data["total"] > 900 and len(data["results"]) == 20
                return data
        elif case == "search-regex-fancy":
            url = "/api/search-sentences?" + urlencode(
                {"q": "(?=.*魔法).*世界", "use_regex": "true", "sort": "length_desc", "page": 1, "page_size": 20}
            )

            def cycle():
                r = client.get(url)
                assert r.status_code == 200, r.data
                data = r.get_json()
                assert data["total"] == 500 and len(data["results"]) == 20
                return data
        elif case == "search-tokenized":
            url = "/api/search-sentences?" + urlencode(
                {"q": "魔法", "use_tokenized": "true", "sort": "date_desc", "page": 1, "page_size": 20}
            )

            def cycle():
                r = client.get(url)
                assert r.status_code == 200, r.data
                data = r.get_json()
                assert data["total"] == 500 and len(data["results"]) == 20
                return data
        else:
            ignore_window = case == "search-duplicates-all"
            payload = {
                "game": "",
                "time_window_minutes": 5,
                "case_sensitive": False,
                "ignore_time_window": ignore_window,
            }

            def cycle():
                r = client.post("/api/search-duplicates", json=payload)
                assert r.status_code == 200, r.data
                data = r.get_json()
                assert data["duplicates_found"] >= 190
                return data
    elif case.startswith("maint-") or case.startswith("tok-") or case in ("game-stats", "dashboard-stats"):
        from scripts.benchmark_history_slices import prepare_slice_cycle

        cycle = prepare_slice_cycle(db, case)
    elif case.startswith("rollup-"):
        from scripts.benchmark_daily_rollup import prepare_rollup
        from GameSentenceMiner.util.cron import run_crons

        cycle, verify_rollups = prepare_rollup(db, case)
        assert run_crons._can_isolate_task(run_crons._TASK_REGISTRY[run_crons.Crons.DAILY_STATS_ROLLUP.value]) == (
            args.worker == "python"
        )
    elif case in (
        "maturity-small",
        "maturity",
        "reading-impact",
        "anki-game-stats",
        "anki-earliest",
        "anki-note-kanji",
        "anki-retention",
    ):
        cycle = maturity_cycle(db, case)
    elif case == "link":
        from GameSentenceMiner.util.cron.populate_games import populate_games_table

        db.executemany(
            "INSERT INTO games(id,title_original,obs_scene_name,image) VALUES (?,?,?,?)",
            [(str(i), f"Game {i}", f"Game {i}", "A" * 8192) for i in range(100)],
            commit=True,
        )
        db.executemany(
            "INSERT INTO game_lines(id,game_name) VALUES (?,?)",
            [(str(i), f"Game {i % 104}") for i in range(6400)],
            commit=True,
        )

        def cycle():
            db.execute("UPDATE game_lines SET game_id=NULL", commit=True)
            db.execute("DELETE FROM games WHERE cast(substr(title_original,6) AS INTEGER)>=100", commit=True)
            result = populate_games_table()
            assert result["success"] and result["created"] == 4 and result["linked_lines"] == 6400, result
            return result

    elif case == "edit":
        from GameSentenceMiner import anki

        url = f"http://127.0.0.1:{args.port}/edit/{profile.name}"
        cfg = SimpleNamespace(url=url, tag_unvoiced_cards=True, remove_overlay_tag=True, sentence_field="Sentence")
        anki.get_config = lambda: SimpleNamespace(anki=cfg)
        assets = SimpleNamespace(audio_in_anki="", screenshot_in_anki="", prev_screenshot_in_anki="", video_in_anki="")

        def cycle():
            tags = ["mined"]
            note = {"id": 17, "fields": {"Sentence": "日\r\n本", "Empty": None}}
            assert anki._update_anki_note(SimpleNamespace(noteId=17), note, tags, assets) == []
            assert tags == ["mined", "unvoiced"]
            return note
    elif case == "poll":
        from GameSentenceMiner import anki

        config = SimpleNamespace(anki=SimpleNamespace(url=f"http://127.0.0.1:{args.port}/original"))
        anki.get_config = lambda: config
        processed = []
        anki.update_new_cards = lambda ids: processed.extend(ids)
        assert anki._seed_anki_polling_baseline()
        config.anki.url = f"http://127.0.0.1:{args.port}/with-new"
        assert anki.check_for_new_cards()
        assert processed == [1_700_000_016_384]
        anki._forget_anki_note(processed[0])
        assert anki.check_for_new_cards()
        assert processed == [1_700_000_016_384] * 2

        def cycle():
            anki._forget_anki_note(1_700_000_016_384)
            processed.clear()
            assert anki.check_for_new_cards()
            assert processed == [1_700_000_016_384]
            return list(processed)
    elif case == "update":
        pending_rows = iter(range(1 + ITERATIONS["update"]))

        def cycle():
            GameLinesTable.update(str(next(pending_rows)), screenshot_path="frame", note_id="second")
    elif case in ("capture", "import"):
        from GameSentenceMiner import gametext
        from GameSentenceMiner.util.database import db as db_module
        from GameSentenceMiner.util.text_log import GameLine

        gametext.gsm_db = db
        db_module._is_tokenization_enabled = lambda: False
        size = 256 if case == "import" else 1
        serial = 0
        when = datetime.now(UTC)

        def cycle():
            nonlocal serial
            lines = [
                GameLine(str(i), "日本語で読む。", when, None, None, scene=f"Game {i % 4}")
                for i in range(serial, serial + size)
            ]
            serial += size
            if case == "import":
                GameLinesTable.add_lines(lines)
            else:
                gametext._persist_game_line_async(lines[0])
                db.run_transaction(lambda _conn: None)

    else:
        from GameSentenceMiner import anki

        path = profile / "voice.webm"
        path.write_bytes(media_bytes())
        anki.get_config = lambda: SimpleNamespace(anki=SimpleNamespace(url=f"http://127.0.0.1:{args.port}"))

        def cycle():
            result = anki.store_media_file(path, filename="声.webm", retries=0)
            assert result == "声.webm", result
            return result

    try:
        processes = [psutil.Process(), psutil.Process(endpoint["pid"])]

        def cpu():
            return sum(p.cpu_times().user + p.cpu_times().system for p in processes)

        # Verify the warm-up actually crosses the boundary being timed. An
        # accidental local fallback can produce exactly the same HTTP output.
        topic = {"edit": "anki.edit", "media": "anki.storeMedia", "poll": "anki.poll"}.get(case, "mining.history")
        if case.startswith("cards-"):
            topic = "anki.cards"
        desktop_replied = False
        history_operations = set()
        send = bus.request

        def observe_request(dst, requested_topic, *args, **kwargs):
            nonlocal desktop_replied
            reply = send(dst, requested_topic, *args, **kwargs)
            if requested_topic == topic:
                assert reply is not None, f"Desktop declined {case}"
                desktop_replied = True
                if topic == "mining.history":
                    history_operations.add(args[0]["operation"])
            return reply

        first_request_start = time.perf_counter()
        with patch.object(bus, "request", observe_request):
            expected = cycle()
        first_request_ms = (time.perf_counter() - first_request_start) * 1000
        if case.startswith("rollup-"):
            original_days = db.fetchall("SELECT date,id,created_at FROM daily_stats_rollup ORDER BY date")
        assert desktop_replied == (args.worker == "rust"), f"Unexpected execution path for {case}"
        reports = {
            "maturity-small": {"maturityHistory"},
            "maturity": {"maturityHistory"},
            "reading-impact": {"maturityHistory", "ankiGameStats"},
            "anki-game-stats": {"ankiGameStats"},
            "anki-earliest": {"ankiEarliestNote"},
            "anki-note-kanji": {"ankiNoteKanji"},
            "anki-retention": {"ankiContentRetention"},
            "search-like": {"searchSentences"},
            "search-regex": {"searchSentences"},
            "search-regex-fancy": {"searchSentences"},
            "search-tokenized": {"searchSentences"},
            "search-duplicates-window": {"searchDuplicates"},
            "search-duplicates-all": {"searchDuplicates"},
            "maint-games-list": {"gamesList"},
            "maint-preview-delete": {"previewTextDeletion"},
            "maint-preview-dedup": {"previewDeduplication"},
            "tok-words": {"tokenizationWords"},
            "tok-kanji": {"tokenizationKanji"},
            "tok-not-in-anki": {"tokenizationWordsNotInAnki"},
            "tok-not-in-anki-missing-kanji": {"tokenizationWordsNotInAnki"},
            "game-stats": {"gameStats"},
            "dashboard-stats": {"dashboardStats"},
            **{key: {"beginRollup", "rebuildRollups"} for key in ITERATIONS if key.startswith("rollup-")},
        }
        if case in reports:
            assert history_operations == (reports[case] if args.worker == "rust" else set())
        gc.collect()
        start_cpu, start = cpu(), time.perf_counter()
        n = ITERATIONS[case]
        for _ in range(n):
            assert cycle() == expected
        elapsed, cpu_time = time.perf_counter() - start, cpu() - start_cpu
        if case == "edit":
            assert anki.requests.get(url, timeout=5).json() == {"step": 0, "busy": True, "completed": n + 1}
        if case == "update":
            line = GameLinesTable.get("0")
            assert line.note_ids == [1, 2, "second"] and line.screenshot_path == "frame"
            assert (
                db.fetchone(
                    "SELECT count(*) FROM game_lines WHERE screenshot_path='frame' AND "
                    "(SELECT count(*) FROM json_each(note_ids) WHERE value='second')=1"
                )[0]
                == n + 1
            )
        if case == "link":
            assert (
                db.fetchone(
                    "SELECT count(*) FROM game_lines JOIN games ON game_lines.game_id=games.id AND game_lines.game_name=games.title_original"
                )[0]
                == 6400
            )
        if case in ("capture", "import"):
            assert (
                db.fetchone(
                    "SELECT count(*) FROM game_lines JOIN games ON games.id=game_lines.game_id WHERE games.title_original=game_lines.game_name AND line_text='日本語で読む。'"
                )[0]
                == serial
            )
            assert db.fetchone("SELECT count(*) FROM games")[0] == 4
        uss = sum(p.memory_full_info().uss for p in processes) / 2**20
        extra_metrics = {}
        if case.startswith("cards-"):
            extra_metrics = sample_operation_memory(endpoint["pid"], cycle, "read")
            expected = verify_cards()
        if (
            case == "media"
            or case.startswith("rollup-")
            or case.startswith("search-")
            or case.startswith("maint-")
            or case.startswith("tok-")
            or case in ("game-stats", "dashboard-stats")
        ):
            prefix = "upload" if case == "media" else ("rollup" if case.startswith("rollup-") else "search")
            extra_metrics = sample_operation_memory(endpoint["pid"], cycle, prefix)
        if case.startswith("rollup-"):
            assert db.fetchall("SELECT date,id,created_at FROM daily_stats_rollup ORDER BY date") == original_days
            expected = verify_rollups()
        if case == "rollup-year" and args.worker == "rust":
            from GameSentenceMiner.util.cron.daily_rollup import get_all_data_dates, replace_rollup_for_date

            # Same warm database, same native per-day transaction. Measure the
            # cost of making the backend dispatch each individual day's work.
            start_cpu, start = cpu(), time.perf_counter()
            for date in get_all_data_dates():
                assert replace_rollup_for_date(date)["updated"]
            extra_metrics["per_day_dispatch_ms"] = (time.perf_counter() - start) * 1000
            extra_metrics["per_day_dispatch_cpu_ms"] = (cpu() - start_cpu) * 1000
            assert verify_rollups() == expected
        print(
            json.dumps(
                {
                    "result": expected,
                    "wall_ms": 1000 * elapsed / n,
                    "cpu_ms": 1000 * cpu_time / n,
                    "uss_mib": uss,
                    **({"first_request_ms": first_request_ms} if case in reports else {}),
                    **extra_metrics,
                }
            )
        )
    finally:
        bus.stop()
        db.close()


def sample(desktop, mode, case, port):
    with TemporaryDirectory() as temp:
        env = {
            **os.environ,
            "GSM_APP_ROOT": str(ROOT),
            "GSM_SMOKE_TEST": "1",
            "GSM_PROFILE_DIR": temp,
            "GSM_DATA_DIR": temp,
            "GSM_SHARED_DATA_DIR": temp,
        }
        env.pop("GSM_TEST_RESULT", None)
        child = subprocess.Popen(
            [str(desktop)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        try:
            endpoint = Path(temp) / "electron/agent-control.json"
            deadline = time.monotonic() + 20
            while not endpoint.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert json.loads(endpoint.read_text())["pid"] == child.pid
            output = subprocess.check_output(
                [sys.executable, __file__, "--worker", mode, "--case", case, "--port", str(port)],
                cwd=ROOT,
                env=env,
                encoding="utf-8",
                timeout=180,
            )
            return json.loads(output.splitlines()[-1])
        finally:
            child.terminate()
            child.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--desktop", type=Path)
    parser.add_argument("--output", type=Path, help="Write each measured sample and its median to JSON")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--case", nargs="+", choices=ITERATIONS)
    parser.add_argument("--worker", choices=["rust", "python"])
    parser.add_argument("--port", type=int)
    parser.add_argument("--memory-probe", type=int, nargs=2, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.memory_probe:
        memory_probe(*args.memory_probe)
        return
    if args.worker:
        if not args.case or len(args.case) != 1:
            parser.error("Each worker measures one case")
        args.case = args.case[0]
        run_worker(args)
        return
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
    if args.rounds < 1:
        parser.error("--rounds must be positive")
    report = {"platform": platform.platform(), "python": platform.python_version(), "cases": {}}
    if args.output:
        with desktop.open("rb") as executable:
            report["desktop_sha256"] = hashlib.file_digest(executable, "sha256").hexdigest()
        if any(case.startswith("dialogue-") for case in args.case or ITERATIONS):
            from GameSentenceMiner import _native

            with Path(_native.__file__).open("rb") as extension:
                report["native_extension_sha256"] = hashlib.file_digest(extension, "sha256").hexdigest()
    with ThreadingHTTPServer(("127.0.0.1", 0), AnkiFixture) as server:
        server.edits = {}
        server.busy_syncs = set()
        server.monitors = {}
        server.groups = {}
        server.monitors_lock = threading.Lock()
        server.media_digest = hashlib.sha256(media_bytes()).digest()
        notes = list(range(1_700_000_000_000, 1_700_000_016_384))
        server.notes = {
            path: json.dumps({"result": ids, "error": None}).encode()
            for path, ids in (("/original", notes), ("/with-new", [*notes, 1_700_000_016_384]))
        }
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for case in args.case or ITERATIONS:
                samples = {"python": [], "rust": []}
                for n in range(args.rounds):
                    for mode in ["python", "rust"] if n % 2 == 0 else ["rust", "python"]:
                        samples[mode].append(sample(desktop.resolve(), mode, case, server.server_port))
                    assert samples["python"][-1]["result"] == samples["rust"][-1]["result"]
                measured = {"iterations_per_run": ITERATIONS[case]}
                if case.startswith("rollup-") or case in ("cron-rollup", "cron-anki-sync"):
                    measured["result_sha256"] = samples["rust"][0]["result"]
                    assert all(run["result"] == measured["result_sha256"] for runs in samples.values() for run in runs)
                elif case in (
                    "cron-scheduler",
                    "anki-monitor",
                    "anki-monitor-default",
                    "anki-earliest",
                    "anki-note-kanji",
                    "anki-retention",
                ) or case.startswith(("sync-", "group-", "cards-", "dialogue-")):
                    measured["verified_result"] = samples["rust"][0]["result"]
                    assert all(
                        run["result"] == measured["verified_result"] for runs in samples.values() for run in runs
                    )
                for mode, runs in samples.items():
                    metrics = [{k: v for k, v in run.items() if k != "result"} for run in runs]
                    median = {k: round(statistics.median(r[k] for r in metrics), 3) for k in metrics[0]}
                    measured[mode] = {"samples": metrics, "median": median}
                    print(case, mode, median, flush=True)
                report["cases"][case] = measured
        finally:
            server.shutdown()
            thread.join()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
