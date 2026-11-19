"""Fixtures and cycles for benchmarking maintenance, tokenization, and dashboard stats slices."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from urllib.parse import urlencode


def prepare_slice_cycle(db, case: str):
    """Seed an isolated profile for *case* and return a repeatable benchmark cycle."""
    if case.startswith("maint-"):
        return _prepare_maintenance(db, case)
    if case.startswith("tok-"):
        return _prepare_tokenization(db, case)
    if case in ("game-stats", "dashboard-stats"):
        return _prepare_stats(db, case)
    raise ValueError(f"Unknown slice benchmark case: {case}")


def _prepare_maintenance(db, case: str):
    from flask import Flask

    from GameSentenceMiner.web.database_api import register_database_api_routes

    games = [f"Game {i:02d}" for i in range(20)]
    base_ts = 1700000000.0
    rows = []
    for i in range(20000):
        g = games[i % 20]
        if case == "maint-preview-dedup" and i >= 20 and i % 100 == 20 + ((i // 100) % 20):
            text = f"重複メンテナンス台詞{i - 20}です。"
            ts = base_ts + (i - 20) * 5.0 + 30.0
        elif case == "maint-preview-delete" and i % 25 == 0:
            text = f"System: AutoSave slot {i % 12}"
            ts = base_ts + i * 5.0
        else:
            text = f"重複メンテナンス台詞{i}です。"
            ts = base_ts + i * 5.0
        rows.append((f"m-{i:05d}", g, text, ts))
    db.executemany(
        "INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES (?,?,?,?)",
        rows,
        commit=True,
    )

    app = Flask(__name__)
    register_database_api_routes(app)
    client = app.test_client()

    if case == "maint-games-list":

        def cycle():
            r = client.get("/api/games-list")
            assert r.status_code == 200, r.data
            data = r.get_json()
            assert len(data["games"]) == 20
            return data

        return cycle

    if case == "maint-preview-delete":
        payload = {
            "regex_pattern": r"^system:\s+autosave",
            "case_sensitive": False,
            "use_regex": True,
        }

        def cycle():
            r = client.post("/api/preview-text-deletion", json=payload)
            assert r.status_code == 200, r.data
            data = r.get_json()
            assert data["count"] == 12 and len(data["samples"]) == 10
            return data

        return cycle

    if case == "maint-preview-dedup":
        payload = {
            "games": ["all"],
            "time_window_minutes": 5,
            "case_sensitive": False,
            "ignore_time_window": False,
        }

        def cycle():
            r = client.post("/api/preview-deduplication", json=payload)
            assert r.status_code == 200, r.data
            data = r.get_json()
            assert data["duplicates_count"] == 200 and data["games_affected"] == 20
            return data

        return cycle

    raise ValueError(f"Unknown maintenance case: {case}")


def _prepare_tokenization(db, case: str):
    from flask import Flask

    from GameSentenceMiner.util.config.configuration import get_config
    from GameSentenceMiner.util.database.anki_tables import AnkiCardsTable, AnkiNotesTable, WordAnkiLinksTable
    from GameSentenceMiner.util.database.global_frequency_tables import setup_global_frequency_sources
    from GameSentenceMiner.util.database.tokenization_tables import (
        KanjiOccurrencesTable,
        KanjiTable,
        WordOccurrencesTable,
        WordsTable,
        create_tokenization_indexes,
    )
    from GameSentenceMiner.web.tokenization_api import register_tokenization_api_routes

    try:
        db.execute("ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0", commit=True)
    except Exception:
        pass
    for cls in (
        WordsTable,
        KanjiTable,
        WordOccurrencesTable,
        KanjiOccurrencesTable,
        AnkiNotesTable,
        AnkiCardsTable,
        WordAnkiLinksTable,
    ):
        cls.set_db(db)
    create_tokenization_indexes(db)
    setup_global_frequency_sources(db)
    db.execute(
        "CREATE TABLE IF NOT EXISTS word_stats_cache ("
        "word_id INTEGER PRIMARY KEY, occurrence_count INTEGER NOT NULL DEFAULT 0, active_global_rank INTEGER)",
        commit=True,
    )

    cfg = get_config()
    cfg.anki.parent_tag = "Game"
    cfg.anki.word_field = "Expression"

    pos_cycle = ["名詞", "動詞", "形容詞", "副詞", "助詞"]
    base_ts = 1700000000.0

    def seed(conn):
        conn.execute(
            "INSERT INTO global_frequency_sources(id,name,version,source_url,max_rank,is_default) "
            "VALUES ('jpdb','JPDB','v2','',50000,1)"
        )
        word_rows = []
        cache_rows = []
        freq_rows = []
        for i in range(1, 4001):
            c1 = chr(0x4E00 + (i % 600))
            c2 = chr(0x4E00 + ((i * 7) % 600))
            word = f"{c1}{c2}{i}" if i % 9 != 0 else f"ascii{i}"
            pos = pos_cycle[i % len(pos_cycle)]
            in_anki = 1 if i % 4 == 0 else 0
            word_rows.append((i, word, f"ヨミ{i}", pos, in_anki, base_ts + i, f"l-{i}"))
            rank = i * 3 if i % 5 != 0 else None
            cache_rows.append((i, 1 + (i * 13) % 500, rank))
            if rank is not None:
                freq_rows.append(("jpdb", word, rank))
        conn.executemany(
            "INSERT INTO words(id,word,reading,pos,in_anki,first_seen,first_seen_line_id) VALUES (?,?,?,?,?,?,?)",
            word_rows,
        )
        conn.executemany(
            "INSERT INTO word_stats_cache(word_id,occurrence_count,active_global_rank) VALUES (?,?,?)",
            cache_rows,
        )
        conn.executemany(
            "INSERT INTO word_global_frequencies(source_id,word,rank) VALUES (?,?,?)",
            freq_rows,
        )
        # Seed Anki cards & notes for enrichment / missing-kanji filter
        notes = []
        cards = []
        links = []
        for i in range(4, 4001, 4):
            nid = 100000 + i
            c1 = chr(0x4E00 + (i % 300))
            notes.append((str(nid), json.dumps({"Expression": {"value": f"{c1}語"}}), json.dumps(["Game::Title1"])))
            cards.append((i, nid, "MiningDeck", 21 + (i % 30), 1000 + i))
            links.append((i, nid))
        conn.executemany("INSERT INTO anki_notes(note_id,fields_json,tags) VALUES (?,?,?)", notes)
        conn.executemany("INSERT INTO anki_cards(card_id,note_id,deck_name,interval,due) VALUES (?,?,?,?,?)", cards)
        conn.executemany("INSERT INTO word_anki_links(word_id,note_id) VALUES (?,?)", links)

        if case == "tok-kanji":
            conn.executemany(
                "INSERT INTO kanji(id,character) VALUES (?,?)",
                [(i, chr(0x4E00 + i)) for i in range(1, 501)],
            )
            conn.executemany(
                "INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,tokenized) VALUES (?,?,?,?,?,1)",
                [(f"kl-{i}", f"g{i % 4}", f"Game {i % 4}", "漢字", base_ts + i * 10) for i in range(4000)],
            )
            conn.executemany(
                "INSERT INTO kanji_occurrences(kanji_id,line_id) VALUES (?,?)",
                [((i * 3 + j) % 500 + 1, f"kl-{i}") for i in range(4000) for j in range(3)],
            )

    db.run_transaction(seed)

    app = Flask(__name__)
    register_tokenization_api_routes(app)
    client = app.test_client()

    if case == "tok-words":
        url = "/api/tokenization/words?" + urlencode({"pos": "content", "limit": 100, "offset": 0})

        def cycle():
            with patch("GameSentenceMiner.web.tokenization_api.is_tokenization_enabled", return_value=True):
                r = client.get(url)
            assert r.status_code == 200, r.data
            data = r.get_json()
            assert len(data["words"]) == 100 and data["total"] > 2000
            return data

        return cycle

    if case == "tok-kanji":
        url = "/api/tokenization/kanji?" + urlencode({"limit": 100, "offset": 0})

        def cycle():
            with patch("GameSentenceMiner.web.tokenization_api.is_tokenization_enabled", return_value=True):
                r = client.get(url)
            assert r.status_code == 200, r.data
            data = r.get_json()
            assert len(data["kanji"]) == 100 and data["total"] == 500
            return data

        return cycle

    if case == "tok-not-in-anki":
        url = "/api/tokenization/words/not-in-anki?" + urlencode(
            {
                "vocab_only": "true",
                "script_filter": "cjk",
                "sort": "global_rank",
                "order": "asc",
                "limit": 100,
                "offset": 0,
            }
        )

        def cycle():
            with patch("GameSentenceMiner.web.tokenization_api.is_tokenization_enabled", return_value=True):
                r = client.get(url)
            assert r.status_code == 200, r.data
            data = r.get_json()
            assert len(data["words"]) == 100 and data["total"] > 1000
            return data

        return cycle

    if case == "tok-not-in-anki-missing-kanji":
        url = "/api/tokenization/words/not-in-anki?" + urlencode(
            {
                "has_missing_anki_kanji": "true",
                "vocab_only": "true",
                "limit": 100,
                "offset": 0,
            }
        )

        def cycle():
            with patch("GameSentenceMiner.web.tokenization_api.is_tokenization_enabled", return_value=True):
                r = client.get(url)
            assert r.status_code == 200, r.data
            data = r.get_json()
            assert len(data["words"]) == 100 and data["total"] > 500
            return data

        return cycle

    raise ValueError(f"Unknown tokenization case: {case}")


def _prepare_stats(db, case: str):
    from flask import Flask

    from GameSentenceMiner.util.database.game_daily_rollup_table import GameDailyRollupTable
    from GameSentenceMiner.util.database.tokenization_tables import (
        KanjiOccurrencesTable,
        KanjiTable,
        WordOccurrencesTable,
        WordsTable,
        create_tokenization_indexes,
    )
    from GameSentenceMiner.web.stats_api import register_stats_api_routes

    try:
        db.execute("ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0", commit=True)
    except Exception:
        pass
    GameDailyRollupTable.set_db(db)
    for cls in (WordsTable, KanjiTable, WordOccurrencesTable, KanjiOccurrencesTable):
        cls.set_db(db)
    create_tokenization_indexes(db)

    today = datetime.now(UTC).astimezone().date()
    today_midnight = datetime.combine(today, datetime.min.time()).timestamp()

    def seed(conn):
        for g in range(12):
            conn.execute(
                "INSERT INTO games(id,title_original,obs_scene_name,type,genres,tags,completed,character_count,difficulty) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    f"g{g}",
                    f"Title {g}",
                    f"Scene {g}",
                    "Visual Novel" if g % 2 == 0 else "RPG",
                    json.dumps(["Fantasy", f"Genre{g % 4}"]),
                    json.dumps(["Magic", f"Tag{g % 5}"]),
                    1 if g % 3 == 0 else 0,
                    500000,
                    g % 5,
                ),
            )
        days = 180 if case == "game-stats" else 365
        for d_off in range(1, days + 1):
            d_str = (today - timedelta(days=d_off)).isoformat()
            g_act = {}
            day_chars = 0
            day_lines = 0
            day_cards = 0
            day_time = 0.0
            for g in range(1 if case == "game-stats" else 4):
                gid = f"g{(d_off + g) % 12}" if case != "game-stats" else "g0"
                c = 4000 + (d_off * 17 + g * 31) % 2000
                l = 200 + (d_off % 50)
                cards = 5 + (d_off % 8)
                t = 1200.0 + (d_off % 300)
                g_act[gid] = {"title": f"Title {gid[1:]}", "chars": c, "lines": l, "cards": cards, "time": t}
                conn.execute(
                    "INSERT INTO game_daily_rollup(date,game_id,total_characters,total_lines,total_cards_mined,total_reading_time_seconds) "
                    "VALUES (?,?,?,?,?,?)",
                    (d_str, gid, c, l, cards, t),
                )
                day_chars += c
                day_lines += l
                day_cards += cards
                day_time += t
            conn.execute(
                "INSERT INTO daily_stats_rollup(date,total_lines,total_characters,total_sessions,"
                "total_reading_time_seconds,total_active_time_seconds,longest_session_seconds,"
                "shortest_session_seconds,average_session_seconds,average_reading_speed_chars_per_hour,"
                "anki_cards_created,hourly_activity_data,hourly_reading_speed_data,game_activity_data,"
                "genre_activity_data,type_activity_data,max_chars_in_session) "
                "VALUES (?,?,?,2,?,?,900.0,300.0,?,?,?, ?,?,?,?,?,?)",
                (
                    d_str,
                    day_lines,
                    day_chars,
                    day_time,
                    day_time,
                    day_time / 2.0,
                    day_chars / (day_time / 3600.0),
                    day_cards,
                    json.dumps({str((d_off % 12) + 8): day_chars}),
                    json.dumps({str((d_off % 12) + 8): int(day_chars / (day_time / 3600.0))}),
                    json.dumps(g_act),
                    json.dumps({"Fantasy": {"chars": day_chars, "time": day_time, "cards": day_cards}}),
                    json.dumps({"Visual Novel": {"chars": day_chars, "time": day_time, "cards": day_cards}}),
                    day_chars // 2,
                ),
            )

        # Seed historical first line + 500 today live lines + 1,500 tokenized words for novelty
        first_ts = datetime.combine(today - timedelta(days=days), datetime.min.time()).timestamp() + 3600
        conn.execute(
            "INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,note_ids,tokenized) VALUES (?,?,?,?,?,?,1)",
            ("first-line", "g0", "Scene 0", "物語の始まりです。", first_ts, "[]"),
        )
        today_rows = [
            (
                f"today-{i:04d}",
                "g0",
                "Scene 0",
                f"今日の読書テスト文章番号{i}です。魔法と冒険の世界。",
                today_midnight + 3600 + i * 6.0,
                "[1]" if i % 25 == 0 else "[]",
            )
            for i in range(500)
        ]
        conn.executemany(
            "INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,note_ids,tokenized) VALUES (?,?,?,?,?,?,1)",
            today_rows,
        )
        word_rows = [
            (
                i,
                f"語彙{i}",
                f"ゴイ{i}",
                "名詞",
                today_midnight + 3600 + (i % 500) * 6.0,
                f"today-{i % 500:04d}",
            )
            for i in range(1, 1501)
        ]
        conn.executemany(
            "INSERT INTO words(id,word,reading,pos,first_seen,first_seen_line_id) VALUES (?,?,?,?,?,?)",
            word_rows,
        )
        conn.executemany(
            "INSERT INTO word_occurrences(word_id,line_id) VALUES (?,?)",
            [(i, f"today-{i % 500:04d}") for i in range(1, 1501)],
        )

    db.run_transaction(seed)

    app = Flask(__name__)
    register_stats_api_routes(app)
    client = app.test_client()

    if case == "game-stats":

        def cycle():
            with patch("GameSentenceMiner.web.token_novelty.is_tokenization_enabled", return_value=True):
                with patch("GameSentenceMiner.util.config.feature_flags.is_tokenization_enabled", return_value=True):
                    r = client.get("/api/game/g0/stats")
            assert r.status_code == 200, r.data
            data = r.get_json()
            assert data["game"]["id"] == "g0" and data["vocabulary"]["uniqueWordsInGame"] == 1500
            return data

        return cycle

    def cycle():
        with patch("GameSentenceMiner.web.token_novelty.is_tokenization_enabled", return_value=True):
            with patch("GameSentenceMiner.util.config.feature_flags.is_tokenization_enabled", return_value=True):
                r = client.get("/api/stats")
        assert r.status_code == 200, r.data
        data = r.get_json()
        assert len(data["labels"]) >= 365 and data["vocabularyStats"]["uniqueWordsSeen"] == 1500
        return data

    return cycle
