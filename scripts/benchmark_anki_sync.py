"""Exercise full and targeted Anki collection sync against an isolated AnkiConnect fixture."""

import hashlib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from unittest.mock import patch

import psutil
import requests

FIELD = "語.彙"
QUERY = FIELD + ':_* note:"Mining"'
FIRST = 1_700_000_000_000
VOCAB = ["日本", "𠀀本", "猫猫", "かな", " 日本 ", "", "㐀文", "未登録"]


@lru_cache(maxsize=180)
def _response(case, action, ids):
    if action == "notesInfo":
        data = [
            {
                "noteId": i,
                "modelName": "Mining",
                "fields": {
                    FIELD: {
                        "value": "改訂" if case == "edited" and i == FIRST + 6 else VOCAB[(i - FIRST) % 8],
                        "order": 2,
                    },
                    "Sentence": {"value": "例文。" * 200},
                    "Audio": {"value": "[sound:hello.ogg]"},
                },
                "tags": ["GSM::日本", "tag"],
                "mod": i % 100,
            }
            for i in ids
            if case != "missing" or i != ids[-1]
        ]
    elif action == "cardsInfo":
        data = [
            {
                "cardId": i,
                "note": i // 2,
                "deckName": "Deck",
                "queue": 2,
                "type": 2,
                "due": 1234,
                "interval": 22,
                "factor": 2500,
                "reps": 5,
                "lapses": 1,
                "question": "<div>日本語</div>" * 65,
                "answer": "unneeded" * 125,
            }
            for i in ids
        ]
    elif action == "getReviewsOfCards":
        data = {
            str(i): [
                {"id": FIRST + j * 1000, "ease": j % 4 + 1, "ivl": j + 1, "lastIvl": j, "time": 1700 + j}
                for j in range(6)
            ]
            for i in ids
        }
    else:
        raise ValueError(action)
    return json.dumps({"error": None, "result": data}, ensure_ascii=False, separators=(",", ":")).encode()


def reply(path, payload):
    assert payload["version"] == 6
    case = path.split("/")[-1]
    n = 12 if case in ("small", "missing") else 1200
    action, params = payload["action"], payload["params"]
    if action in ("findNotes", "findCards"):
        query = params["query"]
        if query == QUERY:
            ids = range(FIRST, FIRST + n)
        else:
            ids = [int(i) for i in re.findall(r"nid:(\d+)", query)]
            if action == "findNotes":
                assert query.startswith("(" + QUERY + ") (") and ids
                ids = [i for i in ids if FIRST <= i < FIRST + n]
            else:
                assert ids and "nid:" in query
        result = list(ids) if action == "findNotes" else [i * 2 + j for i in ids for j in (0, 1)]
        return json.dumps({"error": None, "result": result}).encode()
    ids = tuple(params["notes"] if action == "notesInfo" else params["cards"])
    return _response(case, action, ids)


def digest(db):
    h = hashlib.sha256()
    queries = [
        "SELECT note_id,model_name,fields_json,tags,mod FROM anki_notes ORDER BY note_id",
        "SELECT card_id,note_id,deck_name,queue,type,due,interval,factor,reps,lapses FROM anki_cards ORDER BY card_id",
        "SELECT review_id,card_id,note_id,review_time,ease,interval,last_interval,time_taken FROM anki_reviews ORDER BY review_id",
        "SELECT w.word,l.note_id FROM word_anki_links l JOIN words w ON w.id=l.word_id ORDER BY 1,2",
        "SELECT l.card_id,k.character FROM card_kanji_links l JOIN kanji k ON k.id=l.kanji_id ORDER BY 1,2",
        "SELECT word,in_anki FROM words ORDER BY word",
        "SELECT character FROM kanji ORDER BY character",
    ]
    for i, q in enumerate(queries):
        for row in db.fetchall(q):
            row = list(row)
            if i == 0:
                row[2:4] = [json.loads(v) for v in row[2:4]]
            h.update(json.dumps(row, ensure_ascii=False, sort_keys=True).encode())
            h.update(b"\n")
    return h.hexdigest()


def prepare_collection(db, url):
    from GameSentenceMiner.util.config.configuration import get_config, get_master_config
    from GameSentenceMiner.util.database.anki_tables import setup_anki_tables
    from GameSentenceMiner.util.database.tokenization_tables import KanjiTable, WordsTable

    config = get_config().anki
    config.word_field, config.note_type = FIELD, "Mining"
    config.url = url
    master = get_master_config().experimental
    master.enable_experimental_features = master.enable_tokenization = True
    setup_anki_tables(db)
    WordsTable.set_db(db)
    KanjiTable.set_db(db)
    db.execute("CREATE UNIQUE INDEX fixture_word ON words(word)", commit=True)
    db.execute("CREATE UNIQUE INDEX fixture_kanji ON kanji(character)", commit=True)
    db.executemany(
        "INSERT INTO words(word,in_anki) VALUES (?,1)",
        [(w,) for w in [*dict.fromkeys(x.strip() for x in VOCAB if x.strip() and x != "未登録"), "unused"]],
        commit=True,
    )

    def stale():
        def seed(conn):
            conn.execute("INSERT INTO anki_notes(note_id,fields_json) VALUES('-9','{}')")
            conn.execute("INSERT INTO anki_cards(card_id,note_id) VALUES('-8','-9')")
            conn.execute("INSERT INTO anki_reviews(review_id,card_id) VALUES('old','-8')")
            conn.execute("INSERT INTO card_kanji_links(card_id,kanji_id) VALUES('-8','99')")
            conn.execute("INSERT INTO word_anki_links(word_id,note_id) VALUES('1','-9')")

        db.run_transaction(seed)

    stale()
    return config, stale


def measure(db, bus, desktop_pid, args, iterations):
    from GameSentenceMiner.util.cron.anki_card_sync import run_full_sync, run_incremental_sync
    from scripts.benchmark_mining_history import sample_operation_memory

    size = "small" if args.case == "sync-small" else "collection"
    config, stale = prepare_collection(db, f"http://127.0.0.1:{args.port}/sync/{size}")
    expected_n = 12 if args.case == "sync-small" else 1200
    processes = [psutil.Process(), psutil.Process(desktop_pid)]

    def cpu():
        return sum(sum(p.cpu_times()[:2]) for p in processes)

    def timed(f, n):
        before_cpu, start = cpu(), time.perf_counter()
        for _ in range(n):
            result = f()
            assert not result["skipped"], result
        return result, (time.perf_counter() - start) * 1000 / n, (cpu() - before_cpu) * 1000 / n

    # Warm the report module separately so importing Flask does not dominate
    # the first measured synchronization for either implementation.
    from GameSentenceMiner.web.anki_api_endpoints import invalidate_anki_data_cache

    invalidate_anki_data_cache()
    calls = []
    original = bus.request

    def observe(dst, topic, data=None, timeout=15):
        calls.append(topic)
        return original(dst, topic, data, timeout)

    with patch.object(bus, "request", observe):
        first, first_ms, first_cpu = timed(run_full_sync, 1)
    assert calls.count("anki.sync") == int(args.worker == "rust")
    assert (
        first["notes_upserted"] == expected_n
        and first["cards_upserted"] == 2 * expected_n
        and first["reviews_upserted"] == 12 * expected_n
    )
    assert set(first["deletion"].values()) == {1}, first
    before = digest(db)
    if args.case == "sync-incremental":

        def operation():
            return run_incremental_sync([FIRST + 6, FIRST + 100000])
    else:
        operation = run_full_sync
    result, ms, cpu_ms = timed(operation, iterations)
    if args.case == "sync-incremental":
        assert result["notes_upserted"] == 1 and result["cards_upserted"] == 2
    assert digest(db) == before
    uss = sum(p.memory_full_info().uss for p in processes) / 2**20
    memory = sample_operation_memory(desktop_pid, operation, "sync")
    config.url = f"http://127.0.0.1:{args.port}/sync/edited"
    edited = run_incremental_sync([FIRST + 6])
    assert not edited["skipped"] and edited["word_links"] == 0 and edited["kanji_links"] == 4, edited
    edited_digest = digest(db)
    assert edited_digest != before
    # Full sync must keep stale records and their links if Anki omits a
    # requested note, including after a successful previous run.
    stale()
    config.url = f"http://127.0.0.1:{args.port}/sync/missing"
    failed = run_full_sync()
    assert failed["skipped"] and db.fetchone("SELECT count(*) FROM anki_reviews WHERE review_id='old'")[0] == 1
    if args.worker == "rust" and args.case == "sync-small":
        from GameSentenceMiner.native.history import stop_anki_sync

        # Verify shutdown wakes a real busy retry over the same broker
        # connection that currently has the long-running sync request pending.
        config.url = f"http://127.0.0.1:{args.port}/sync/busy/{desktop_pid}"
        with ThreadPoolExecutor(1) as executor:
            busy = executor.submit(run_full_sync)
            try:
                deadline = time.monotonic() + 5
                while not requests.get(config.url, timeout=1).json():
                    assert time.monotonic() < deadline, "Sync never reached Anki"
                    time.sleep(0.01)
                db.execute("UPDATE anki_notes SET mod=42 WHERE note_id='-9'", commit=True)
            finally:
                stop_anki_sync()
            assert "stopped with the backend session" in busy.result(timeout=3)["reason"]
        stopped = run_full_sync()
        assert stopped["skipped"] and "stopped with the backend session" in stopped["reason"], stopped
    return {
        "result": {"digest": before, "edited_digest": edited_digest, "first": first, "warm": result, "edited": edited},
        "first_ms": first_ms,
        "first_cpu_ms": first_cpu,
        "wall_ms": ms,
        "cpu_ms": cpu_ms,
        "settled_uss_mib": uss,
        **memory,
    }
