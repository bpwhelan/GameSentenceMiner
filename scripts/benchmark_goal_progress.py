"""Compare goal metrics from native HTTP and Flask on matching temporary databases."""

import datetime as dt
import json
import statistics
import time
from zoneinfo import ZoneInfo

from benchmark_stats_exports import request

ZONE = ZoneInfo("America/New_York")


def seed(db, stack, today):
    first = today - dt.timedelta(days=6)
    midnight = dt.datetime.combine(today, dt.time.min, ZONE).timestamp()
    with db:
        db.executemany(
            "INSERT INTO games(id,title_original,obs_scene_name,type) VALUES(?,?,?,?)",
            [("goal-a", "空", "Air", "Visual Novel"), ("goal-b", "本", "Book", "Manga")],
        )
        for i in range(7):
            date = first + dt.timedelta(days=i)
            if date < today:
                db.execute(
                    """INSERT INTO daily_stats_rollup(date,total_characters,total_reading_time_seconds,anki_cards_created,games_played_ids,type_activity_data,
                    total_lines,total_sessions,unique_games_played,total_active_time_seconds,longest_session_seconds,shortest_session_seconds,
                    average_session_seconds,average_reading_speed_chars_per_hour,peak_reading_speed_chars_per_hour,games_completed,games_started,
                    lines_with_screenshots,lines_with_audio,lines_with_translations,unique_kanji_seen,max_chars_in_session,max_time_in_session_seconds,unique_words_seen)
                    VALUES(?,?,?,3,?,?,80,1,2,1800,1800,1800,1800,2000,2000,0,0,0,0,0,0,1000,1800,0)""",
                    (
                        str(date),
                        1000 + i,
                        1810 + i,
                        '["goal-a","goal-b"]',
                        json.dumps({"Manga": {"chars": 225, "time": 360, "cards": 1}}),
                    ),
                )
            db.execute(
                "INSERT INTO third_party_stats(date,source,label,characters_read,time_read_seconds) VALUES(?,'mokuro','goal fixture',25,120)",
                (str(date),),
            )
            start = dt.datetime.combine(date, dt.time.min, ZONE).timestamp() + 120
            db.executemany(
                """INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,note_ids) VALUES(?,?,?,?,?,?)""",
                [
                    (
                        f"goal-{i}-{n}",
                        "goal-a" if n % 2 else "goal-b",
                        "空" if n % 2 else "本",
                        "語学。",
                        start + n * 20,
                        "[1,2]" if n % 5 == 0 else "[]",
                    )
                    for n in range(80)
                ],
            )
        for i in range(4):
            db.execute(
                "INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES(?,?,?,?,?)",
                (
                    f"goal-fall-{i}",
                    "goal-a",
                    "空",
                    "夕暮れ",
                    dt.datetime.fromisoformat("2020-11-01T05:30:00+00:00").timestamp() + i * 1800,
                ),
            )
        # Both profiles use the same existing vocabulary-cache schema.
        db.execute(
            "CREATE TABLE IF NOT EXISTS anki_cards(card_id TEXT PRIMARY KEY,note_id TEXT,deck_name TEXT,queue TEXT,type TEXT,due TEXT,interval TEXT,factor TEXT,reps TEXT,lapses TEXT,synced_at TEXT)"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS anki_reviews(review_id TEXT PRIMARY KEY,card_id TEXT,note_id TEXT,review_time TEXT,ease TEXT,interval TEXT,last_interval TEXT,time_taken TEXT,synced_at TEXT)"
        )
        for i, t, interval in [(1, 2, 23), (2, 2, 30), (3, 0, 0)]:
            db.execute(
                "INSERT INTO anki_cards(card_id,note_id,deck_name,type,interval) VALUES(?,?,?,?,?)",
                (str(78800 + i), str(79900 + i), "Goal deck", t, interval),
            )
            db.execute(
                "INSERT INTO anki_reviews(review_id,card_id,note_id,review_time) VALUES(?,?,?,?)",
                (f"goal-review-{i}", str(78800 + i), str(79900 + i), int((midnight + 300) * 1000)),
            )

    def cleanup():
        with db:
            db.execute("DELETE FROM game_lines WHERE id LIKE 'goal-%'")
            db.execute("DELETE FROM games WHERE id IN ('goal-a','goal-b')")
            db.execute('DELETE FROM daily_stats_rollup WHERE games_played_ids=\'["goal-a","goal-b"]\'')
            db.execute("DELETE FROM third_party_stats WHERE label='goal fixture'")
            db.execute("DELETE FROM anki_cards WHERE deck_name='Goal deck'")
            db.execute("DELETE FROM anki_reviews WHERE review_id LIKE 'goal-review-%'")

    stack.callback(cleanup)


def measure(databases, connections, rounds, stack):
    today = dt.datetime.now(ZONE).date()
    for db in databases.values():
        seed(db, stack, today)
    base = {
        "goal_id": "reading",
        "metric_type": "characters",
        "target_value": 7500,
        "start_date": str(today - dt.timedelta(days=6)),
        "end_date": str(today + dt.timedelta(days=5)),
        "goals_settings": {"easyDays": {"saturday": 45, "friday": 75}, "ankiConnect": {"deckName": "Goal deck"}},
    }
    specs = [
        ("calendar", "progress", {}),
        ("projection", "projection", {}),
        ("games_projection", "projection", {"metric_type": "games"}),
        ("mature_projection", "projection", {"metric_type": "mature_cards"}),
        ("daily", "today-progress", {}),
        ("media", "today-progress", {"metric_type": "hours", "media_type": "Manga"}),
        ("games", "progress", {"metric_type": "games", "media_type": "Manga"}),
        ("mined", "progress", {"metric_type": "cards", "media_type": "Manga"}),
        ("mature", "progress", {"metric_type": "mature_cards"}),
        ("backlog", "today-progress", {"metric_type": "anki_backlog"}),
        ("static", "today-progress", {"metric_type": "characters_static", "start_date": None, "end_date": None}),
        ("relinked", "today-progress", {"metric_type": "finish_game", "game_id": "gone", "game_name": "Air"}),
        ("expired", "progress", {"end_date": str(today - dt.timedelta(days=2))}),
        ("future", "today-progress", {"start_date": str(today + dt.timedelta(days=1))}),
        (
            "timed",
            "progress",
            {
                "start_date": "2020-11-01T01:30:00-04:00",
                "end_date": "2020-11-01T01:30:00-05:00",
                "media_type": "Visual Novel",
            },
        ),
        (
            "complete_days",
            "progress",
            {"start_date": base["start_date"] + "T00:03", "end_date": str(today - dt.timedelta(days=2)) + "T00:30"},
        ),
        ("invalid", "progress", {"metric_type": "invalid"}),
        ("ambiguous", "progress", {"start_date": "2020-11-01T01:30", "end_date": "2020-11-01T03:00"}),
    ]
    results = {}
    for label, route, options in specs:
        samples = {name: [] for name in connections}
        for i in range(rounds + 1):
            states = {}
            for name in connections if i % 2 == 0 else reversed(connections):
                conn, process = connections[name]
                cpu = process.cpu_times()
                start = time.perf_counter()
                reply, raw = request(conn, "POST", "/api/goals/" + route, {**base, **options}, {"X-Timezone": ZONE.key})
                elapsed = time.perf_counter() - start
                end = process.cpu_times()
                if name == "rust":
                    assert reply.getheader("x-gsm-handler") == "rust", (label, reply.status, raw[:200])
                states[name] = (reply.status, json.loads(raw))
                if i:
                    samples[name].append(
                        {
                            "ms": elapsed * 1000,
                            "server_cpu_ms": (end.user + end.system - cpu.user - cpu.system) * 1000,
                            "server_resident_mib": process.memory_info().rss / 1024**2,
                        }
                    )
            assert states["rust"] == states["python"], (label, states)
            status, payload = states["rust"]
            assert status == (400 if label in {"invalid", "ambiguous"} else 200), (label, payload)
            if label == "timed":
                assert payload["progress"] == 6, payload
            if label == "relinked":
                assert payload["total_progress"] > 0, payload
        results[label] = {
            name: {k: round(statistics.median(row[k] for row in rows), 4) for k in rows[0]}
            for name, rows in samples.items()
        }
    return results
