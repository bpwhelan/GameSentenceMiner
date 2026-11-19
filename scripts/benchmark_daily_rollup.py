"""Daily statistics fixtures for the paired desktop benchmarks in benchmark_mining_history.py."""

import hashlib
import json
import zlib
from datetime import datetime, timedelta


def prepare_rollup(db, case):
    from GameSentenceMiner.util.config.configuration import get_config, get_master_config, get_stats_config
    from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup
    from GameSentenceMiner.util.database.game_archive import ensure_archive_schema
    from GameSentenceMiner.util.database.game_daily_rollup_table import GameDailyRollupTable
    from GameSentenceMiner.util.database.reading_breaks_table import ReadingBreaksTable
    from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
    from GameSentenceMiner.util.database.tokenization_tables import (
        KanjiOccurrencesTable,
        KanjiTable,
        WordOccurrencesTable,
        WordsTable,
        create_tokenization_indexes,
    )

    get_config()
    settings = get_stats_config()
    settings.session_gap_seconds = 300
    settings.regex_out_repetitions = case == "rollup-repeat"
    settings.extra_punctuation_regex = "[A-Za-z0-9本]+|猫犬" if case == "rollup-repeat" else ""
    experimental = get_master_config().experimental
    experimental.enable_experimental_features = True
    experimental.enable_tokenization = case in ("rollup-mixed", "rollup-indexed")
    days, count = (1, 16) if case == "rollup-small" else (10, 512)
    if case == "rollup-year":
        days, count = 365, 16
    GameDailyRollupTable.set_db(db)
    ReadingBreaksTable.set_db(db)
    for table in (WordsTable, KanjiTable, WordOccurrencesTable, KanjiOccurrencesTable):
        table.set_db(db)
    db.execute("ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0", commit=True)
    db.execute("CREATE INDEX IF NOT EXISTS rollup_fixture_time ON game_lines(timestamp)", commit=True)
    create_tokenization_indexes(db)
    ensure_archive_schema(db)
    base = datetime(2024, 1, 12).astimezone()
    texts = (
        "「日本語」を読む。",
        "猫猫猫猫犬！",
        "あ い\nう。",
        "…",
        "𠀀㐀本を読む。",
        " ",
        "猫です。",
        "日語" * 9 + "\n" + "声！" * 6,
    )

    def seed(conn):
        conn.executemany(
            "INSERT INTO games(id,title_original,type,genres,image) VALUES(?,?,?,?,?)",
            [
                (str(i), f"Title {i}" if i % 2 else "", " VN " if i % 3 else "", '["Action","読書"]', "A" * 4096)
                for i in range(6)
            ],
        )
        conn.execute("INSERT INTO words(id,word,pos) VALUES(1,'猫','名詞'),(2,'句','記号')")
        conn.execute("INSERT INTO kanji(id,character) VALUES(1,'猫'),(2,'本')")
        for d in range(days):
            day = base + timedelta(days=d)
            date = day.date().isoformat()
            midnight = day.timestamp()
            # Include a day containing archived lines alone.
            n = 0 if d == 2 else count

            def live(i, midnight=midnight, d=d):
                time = midnight + 3595 + (i // 64) * 3600 + (i % 64) * 8 + (i % 7) / 31
                return (
                    f"{d}-{i}",
                    time,
                    str(i % 8) if i % 9 else "",
                    f"Scene {i % 8}" if i % 8 != 7 else "",
                    texts[i % len(texts)],
                    "[1,2]" if i % 5 == 0 else "malformed",
                    " frame " if i % 11 == 0 else "",
                    "clip" if i % 7 == 0 else "",
                    " translated " if i % 3 == 0 else " ",
                    int(case != "rollup-mixed" or d % 2 == 0 or i != 1),
                )

            conn.executemany(
                "INSERT INTO game_lines(id,timestamp,game_id,game_name,line_text,note_ids,screenshot_in_anki,audio_in_anki,translation,tokenized) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (live(i) for i in range(n)),
            )
            for table, field in (("word_occurrences", "word_id"), ("kanji_occurrences", "kanji_id")):
                conn.executemany(
                    f"INSERT INTO {table}({field},line_id) VALUES(?,?)", ((1 + i % 2, f"{d}-{i}") for i in range(n))
                )
            conn.execute("INSERT INTO stats_reading_breaks(timestamp) VALUES(?)", (midnight + 3640,))
            events = [
                [
                    midnight + 3595 + j * 22,
                    7 + j % 3,
                    j % 3,
                    j % 8,
                    12,
                    int(case != "rollup-mixed" or d % 3 != 0 or j != 0),
                    f"a{j}",
                ]
                for j in range(8)
            ]
            conn.execute(
                "INSERT INTO archived_game_days VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "old",
                    date,
                    "Archive",
                    zlib.compress(json.dumps(events).encode()),
                    '{"鳥":8,"猫":4}',
                    '{"鳥":8,"猫":4}',
                    0,
                    8,
                    63,
                    events[0][0],
                    events[-1][0],
                    sum(e[5] for e in events),
                    '{"鳥":7,"猫":3}',
                ),
            )
            conn.execute(
                "INSERT INTO archived_word_stats(game_id,date,word_id,word,reading,pos,frequency,first_seen,last_seen,first_line_id) VALUES('old',?,1,'猫','ネコ','名詞',6,1,1,'old-line')",
                (date,),
            )

    db.run_transaction(seed)
    completed = 0

    def cycle():
        nonlocal completed
        result = run_daily_rollup()
        assert result["success"] and result["errors"] == 0, result
        assert result["total_dates"] == days
        assert (result["processed"], result["overwritten"]) == ((days, 0) if completed == 0 else (0, days)), result
        completed += 1
        return days

    def verify():
        data = []
        for table, order in ((StatsRollupTable, "date"), (GameDailyRollupTable, "date,game_id")):
            records = db.fetchall(f"SELECT * FROM {table._table} ORDER BY {order}")
            assert records
            for raw in records:
                row = table.from_row(raw)
                values = {}
                for key in table._fields:
                    if key in ("created_at", "updated_at"):
                        continue
                    value = getattr(row, key)
                    if key.endswith("_data") or key == "games_played_ids":
                        value = json.loads(value)
                        if key == "games_played_ids":
                            value = sorted(value)
                        if key == "kanji_frequency_data":
                            values["kanji_order"] = list(value)
                    values[key] = value
                data.append(values)
        # JSON differences include SQL counts, numeric session values, and the
        # ranked kanji display order. Runtime timestamps and set order vary.
        return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    return cycle, verify
