"""Text-free game archives, committed atomically with replacement rollups.

Daily frequency maps are the durable source for kanji and vocabulary. Compressed
numeric reading events retain only the timing/count inputs needed by adaptive
reading-time calculations, including sessions interleaving several games.
"""

# Calendar dates intentionally follow GSM's local-time stats and rollup convention.
# ruff: noqa: DTZ006

from __future__ import annotations

import json
import time
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from types import SimpleNamespace

from GameSentenceMiner.util.database.db import GameLinesTable, clean_text_for_stats
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.stats.stats_util import count_cards_from_line
from GameSentenceMiner.util.text_utils import is_kanji


def ensure_archive_schema(db):
    for sql in (
        """CREATE TABLE IF NOT EXISTS archived_game_days (
            game_id TEXT NOT NULL, date TEXT NOT NULL, game_name TEXT NOT NULL,
            events BLOB NOT NULL, kanji TEXT NOT NULL, raw_kanji TEXT NOT NULL,
            archived_at REAL NOT NULL, line_count INTEGER NOT NULL, character_count INTEGER NOT NULL,
            first_timestamp REAL NOT NULL, last_timestamp REAL NOT NULL,
            tokenized_lines INTEGER NOT NULL, token_kanji TEXT NOT NULL, PRIMARY KEY(game_id, date))""",
        "CREATE INDEX IF NOT EXISTS idx_archived_days_date ON archived_game_days(date)",
        """CREATE TABLE IF NOT EXISTS archived_word_stats (
            game_id TEXT NOT NULL, date TEXT NOT NULL, word_id INTEGER NOT NULL,
            word TEXT NOT NULL, reading TEXT NOT NULL, pos TEXT NOT NULL,
            frequency INTEGER NOT NULL, first_seen REAL NOT NULL, last_seen REAL NOT NULL,
            first_line_id TEXT NOT NULL,
            PRIMARY KEY(game_id, date, word_id))""",
        "CREATE INDEX IF NOT EXISTS idx_archived_words_word ON archived_word_stats(word_id)",
        """CREATE TRIGGER IF NOT EXISTS trg_delete_game_archive AFTER DELETE ON games BEGIN
            DELETE FROM archived_game_days WHERE game_id=OLD.id;
            DELETE FROM archived_word_stats WHERE game_id=OLD.id;
        END""",
    ):
        db.execute(sql, commit=True)


def has_archives(db=None):
    db = db or GameLinesTable._db
    return (
        hasattr(db, "table_exists")
        and db.table_exists("archived_game_days")
        and bool(db.fetchone("SELECT 1 FROM archived_game_days LIMIT 1"))
    )


def archive_dates():
    db = GameLinesTable._db
    if not has_archives(db):
        return []
    return [r[0] for r in db.fetchall("SELECT DISTINCT date FROM archived_game_days ORDER BY date")]


class CharacterCount:
    """A text-free length accepted by the shared reading-time calculations."""

    __slots__ = ("count",)

    def __init__(self, count):
        self.count = count

    def __len__(self):
        return self.count

    def __str__(self):
        return ""


def load_archive_days(start=None, end=None, game_id=None):
    db = GameLinesTable._db
    if not has_archives(db):
        return []
    conditions, params = ["1=1"], []
    for clause, value in (("date >= ?", start), ("date <= ?", end), ("game_id = ?", game_id)):
        if value is not None:
            conditions.append(clause)
            params.append(value)
    return db.fetchall(
        "SELECT game_id, date, game_name, events, kanji, raw_kanji, archived_at, token_kanji FROM archived_game_days WHERE "
        + " AND ".join(conditions)
        + " ORDER BY date, game_id",
        tuple(params),
    )


def archived_stats_lines(start=None, end=None, game_id=None):
    start_date = datetime.fromtimestamp(start).date().isoformat() if start is not None else None
    end_date = datetime.fromtimestamp(end).date().isoformat() if end is not None else None
    lines = []
    for gid, date, name, blob, kanji, _raw_kanji, _at, _token_kanji in load_archive_days(start_date, end_date, game_id):
        day_kanji = json.loads(kanji)
        for event in json.loads(zlib.decompress(blob)):
            timestamp, chars, cards, flags, raw_chars, tokenized, line_id = event
            if (start is not None and timestamp < start) or (end is not None and timestamp > end):
                continue
            lines.append(
                SimpleNamespace(
                    id=line_id,
                    game_id=gid,
                    game_name=name,
                    timestamp=timestamp,
                    line_text=CharacterCount(chars),
                    note_ids=(),
                    archived_card_count=cards,
                    screenshot_in_anki="1" if flags & 1 else "",
                    audio_in_anki="1" if flags & 2 else "",
                    translation="1" if flags & 4 else "",
                    raw_char_count=raw_chars,
                    tokenized=tokenized,
                    archived_kanji=day_kanji,
                )
            )
            day_kanji = {}
    return lines


def archived_kanji_counts(game_id=None, *, raw=False):
    counts = Counter()
    for row in load_archive_days(game_id=game_id):
        counts.update(json.loads(row[5 if raw else 4]))
    return counts


def archived_word_frequencies(start_date, end_date):
    db = GameLinesTable._db
    if not has_archives(db):
        return {}
    return dict(
        db.fetchall(
            """SELECT word, SUM(frequency) FROM archived_word_stats
        WHERE date >= ? AND date <= ? AND pos NOT IN ('記号', 'その他') GROUP BY word""",
            (start_date, end_date),
        )
    )


def kanji_occurrence_source(db):
    query = """SELECT k.character, gl.game_id, CAST(gl.timestamp AS REAL) AS timestamp, 1 AS frequency
        FROM kanji_occurrences ko JOIN kanji k ON k.id=ko.kanji_id JOIN game_lines gl ON gl.id=ko.line_id"""
    if has_archives(db):
        query += """ UNION ALL SELECT j.key, d.game_id, d.first_timestamp, j.value
            FROM archived_game_days d, json_each(d.token_kanji) j"""
    return query


def archive_summary(game_id=None):
    summaries = archive_summaries()
    if game_id is not None:
        return summaries.get(
            game_id,
            {
                "archived_lines": 0,
                "archived_characters": 0,
                "first_timestamp": None,
                "last_timestamp": None,
                "archived_at": None,
                "tokenized_lines": 0,
            },
        )
    values = list(summaries.values())
    return {
        "archived_lines": sum(v["archived_lines"] for v in values),
        "archived_characters": sum(v["archived_characters"] for v in values),
        "first_timestamp": min((v["first_timestamp"] for v in values), default=None),
        "last_timestamp": max((v["last_timestamp"] for v in values), default=None),
        "archived_at": max((v["archived_at"] for v in values), default=None),
        "tokenized_lines": sum(v["tokenized_lines"] for v in values),
    }


def archive_summaries():
    db = GameLinesTable._db
    if not has_archives(db):
        return {}
    fields = (
        "archived_lines",
        "archived_characters",
        "first_timestamp",
        "last_timestamp",
        "archived_at",
        "tokenized_lines",
    )
    return {
        r[0]: dict(zip(fields, r[1:]))
        for r in db.fetchall("""SELECT game_id, SUM(line_count), SUM(character_count),
        MIN(first_timestamp), MAX(last_timestamp), MAX(archived_at), SUM(tokenized_lines)
        FROM archived_game_days GROUP BY game_id""")
    }


def word_occurrence_source(db):
    """One row per live occurrence or archived word/day, with an explicit weight."""
    query = """SELECT wo.word_id, gl.game_id, gl.game_name, CAST(gl.timestamp AS REAL) AS timestamp, gl.tokenized,
               1 AS frequency FROM word_occurrences wo JOIN game_lines gl ON gl.id=wo.line_id"""
    if has_archives(db):
        query += """ UNION ALL SELECT a.word_id, a.game_id, d.game_name, a.first_seen, 1, a.frequency
                     FROM archived_word_stats a JOIN archived_game_days d
                     ON d.game_id=a.game_id AND d.date=a.date"""
    return query


def restore_archived_words(db):
    """Re-enable vocabulary after tokenization was disabled without losing IDs."""
    if not db.table_exists("archived_word_stats"):
        return
    db.execute(
        """INSERT OR IGNORE INTO words(id, word, reading, pos, in_anki, first_seen, first_seen_line_id, last_seen)
        SELECT word_id, word, reading, pos, 0, first_seen, first_line_id, latest FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY word_id ORDER BY first_seen, first_line_id) AS ordinal,
                MAX(last_seen) OVER (PARTITION BY word_id) AS latest FROM archived_word_stats
        ) WHERE ordinal=1""",
        commit=True,
    )


def archive_game(game_id: str, *, completed_before=None) -> dict:
    """Preserve all stats before removing a game's raw sentences in one transaction."""
    from GameSentenceMiner.util.config.configuration import get_stats_config
    from GameSentenceMiner.util.config.feature_flags import is_tokenization_enabled
    from GameSentenceMiner.util.cron.daily_rollup import replace_rollup_for_date

    db = GameLinesTable._db
    ensure_archive_schema(db)

    def archive(conn):
        game = GamesTable.get(game_id)
        if game is None:
            raise ValueError("Game not found")
        rows = db.fetchall("SELECT * FROM game_lines WHERE game_id = ? ORDER BY timestamp, id", (game_id,))
        lines = [GameLinesTable.from_row(row) for row in rows]
        columns = {r[1] for r in db.fetchall("PRAGMA table_info(game_lines)")}
        tokenized_ids = (
            {r[0] for r in db.fetchall("SELECT id FROM game_lines WHERE game_id=? AND tokenized=1", (game_id,))}
            if "tokenized" in columns
            else set()
        )
        for line in lines:
            line.tokenized = line.id in tokenized_ids
        if not lines:
            return {"game_id": game_id, "archived_lines": 0}
        if completed_before is not None and (
            game.effective_status != "completed" or max(float(line.timestamp) for line in lines) >= completed_before
        ):
            return {"game_id": game_id, "archived_lines": 0}
        if is_tokenization_enabled():
            from GameSentenceMiner.util.cron.tokenize_lines import tokenize_line

            for line in lines:
                if not line.tokenized and not tokenize_line(line.id, line.line_text, float(line.timestamp)):
                    raise ValueError(
                        "Tokenization failed. No sentences were archived; retry after fixing tokenization."
                    )
                line.tokenized = True

        from GameSentenceMiner.util.database.archive_files import write_archive_file

        archive_file = write_archive_file(conn, game)
        by_date = defaultdict(list)
        for line in lines:
            by_date[datetime.fromtimestamp(float(line.timestamp)).date().isoformat()].append(line)

        for date, day_lines in by_date.items():
            old = load_archive_days(date, date, game_id)
            events = json.loads(zlib.decompress(old[0][3])) if old else []
            kanji = Counter(json.loads(old[0][4])) if old else Counter()
            raw_kanji = Counter(json.loads(old[0][5])) if old else Counter()
            token_kanji = Counter(json.loads(old[0][7])) if old else Counter()
            for line in day_lines:
                text = line.line_text or ""
                config = get_stats_config()
                cleaned = clean_text_for_stats(
                    text,
                    regex_out_repetitions=config.regex_out_repetitions,
                    extra_punctuation_regex=config.extra_punctuation_regex,
                )
                kanji.update(c for c in cleaned if is_kanji(c))
                raw_kanji.update(c for c in text if is_kanji(c))
                if line.tokenized:
                    token_kanji.update({c for c in text if is_kanji(c)})
                flags = (
                    bool(line.screenshot_in_anki and line.screenshot_in_anki.strip())
                    | bool(line.audio_in_anki and line.audio_in_anki.strip()) << 1
                    | bool(line.translation and line.translation.strip()) << 2
                )
                events.append(
                    [
                        float(line.timestamp),
                        len(cleaned),
                        count_cards_from_line(line),
                        flags,
                        len(text),
                        int(bool(line.tokenized)),
                        line.id,
                    ]
                )
            events.sort(key=lambda event: event[0])
            db.execute(
                "INSERT OR REPLACE INTO archived_game_days VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    game_id,
                    date,
                    game.obs_scene_name or day_lines[0].game_name or game.title_original,
                    zlib.compress(json.dumps(events, separators=(",", ":")).encode()),
                    json.dumps(kanji, ensure_ascii=False),
                    json.dumps(raw_kanji, ensure_ascii=False),
                    time.time(),
                    len(events),
                    sum(e[1] for e in events),
                    events[0][0],
                    events[-1][0],
                    sum(e[5] for e in events),
                    json.dumps(token_kanji, ensure_ascii=False),
                ),
                commit=True,
            )
            if db.table_exists("word_occurrences"):
                start = datetime.fromisoformat(date)
                word_rows = db.fetchall(
                    """
                    WITH occurrences AS (
                        SELECT wo.word_id, gl.id AS line_id, CAST(gl.timestamp AS REAL) AS timestamp,
                            ROW_NUMBER() OVER (PARTITION BY wo.word_id ORDER BY CAST(gl.timestamp AS REAL), gl.id) AS ordinal
                        FROM word_occurrences wo JOIN game_lines gl ON gl.id=wo.line_id
                        WHERE gl.game_id=? AND gl.timestamp >= ? AND gl.timestamp < ?
                    )
                    SELECT w.id, w.word, w.reading, w.pos, COUNT(*), MIN(o.timestamp), MAX(o.timestamp),
                        MAX(CASE WHEN o.ordinal=1 THEN o.line_id END)
                    FROM occurrences o JOIN words w ON w.id=o.word_id GROUP BY w.id
                    """,
                    (game_id, start.timestamp(), (start + timedelta(days=1)).timestamp()),
                )
                for wid, word, reading, pos, count, first, last, first_id in word_rows:
                    db.execute(
                        """INSERT INTO archived_word_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(game_id, date, word_id) DO UPDATE SET
                        frequency=frequency+excluded.frequency,
                        first_line_id=CASE WHEN excluded.first_seen < first_seen THEN excluded.first_line_id ELSE first_line_id END,
                        first_seen=MIN(first_seen, excluded.first_seen), last_seen=MAX(last_seen, excluded.last_seen)""",
                        (
                            game_id,
                            date,
                            wid,
                            word,
                            reading or "",
                            pos or "",
                            count,
                            first,
                            last,
                            first_id,
                        ),
                        commit=True,
                    )

        db.execute("DELETE FROM game_lines WHERE game_id = ?", (game_id,), commit=True)
        # Trigger cleanup is present in normal databases; also support databases without it.
        for table in ("word_occurrences", "kanji_occurrences"):
            if db.table_exists(table):
                db.execute(f"DELETE FROM {table} WHERE line_id NOT IN (SELECT id FROM game_lines)", commit=True)
        for date in sorted(by_date):
            replace_rollup_for_date(date)
        return {"game_id": game_id, "archived_lines": len(lines), "archive_file": archive_file}

    result = db.run_transaction(archive)
    from GameSentenceMiner.web.game_profiles import invalidate_game_profiles_cache

    invalidate_game_profiles_cache()
    return result


def merge_archived_games(target_id, source_ids, target_name):
    """Move both raw and archived history, preserving word/day frequencies."""
    from GameSentenceMiner.util.cron.daily_rollup import replace_rollup_for_date

    db = GameLinesTable._db
    ensure_archive_schema(db)

    def merge(conn):
        moved, dates = 0, set()
        for source_id in source_ids:
            if source_id == target_id:
                raise ValueError("A game cannot be merged into itself")
            source_days = load_archive_days(game_id=source_id)
            for _gid, date, _name, blob, kanji, raw_kanji, at, token_kanji in source_days:
                dates.add(date)
                events = json.loads(zlib.decompress(blob))
                moved += len(events)
                frequencies = [Counter(json.loads(value)) for value in (kanji, raw_kanji, token_kanji)]
                existing = load_archive_days(date, date, target_id)
                if existing:
                    events.extend(json.loads(zlib.decompress(existing[0][3])))
                    for counts, index in zip(frequencies, (4, 5, 7)):
                        counts.update(json.loads(existing[0][index]))
                    at = max(at, existing[0][6])
                events.sort(key=lambda e: (e[0], e[6]))
                conn.execute(
                    "INSERT OR REPLACE INTO archived_game_days VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        target_id,
                        date,
                        target_name,
                        zlib.compress(json.dumps(events, separators=(",", ":")).encode()),
                        json.dumps(frequencies[0], ensure_ascii=False),
                        json.dumps(frequencies[1], ensure_ascii=False),
                        at,
                        len(events),
                        sum(e[1] for e in events),
                        events[0][0],
                        events[-1][0],
                        sum(e[5] for e in events),
                        json.dumps(frequencies[2], ensure_ascii=False),
                    ),
                )
            conn.execute(
                """INSERT INTO archived_word_stats
                SELECT ?, date, word_id, word, reading, pos, frequency, first_seen, last_seen, first_line_id
                FROM archived_word_stats WHERE game_id=?
                ON CONFLICT(game_id, date, word_id) DO UPDATE SET
                frequency=frequency+excluded.frequency,
                first_line_id=CASE WHEN excluded.first_seen < first_seen THEN excluded.first_line_id ELSE first_line_id END,
                first_seen=MIN(first_seen, excluded.first_seen), last_seen=MAX(last_seen, excluded.last_seen)""",
                (target_id, source_id),
            )
            dates.update(
                r[0]
                for r in conn.execute(
                    "SELECT DISTINCT DATE(timestamp, 'unixepoch', 'localtime') FROM game_lines WHERE game_id=?",
                    (source_id,),
                )
            )
            moved += conn.execute(
                "UPDATE game_lines SET game_id=?, game_name=?, original_game_name=COALESCE(original_game_name, game_name) WHERE game_id=?",
                (target_id, target_name, source_id),
            ).rowcount
            conn.execute("DELETE FROM archived_game_days WHERE game_id=?", (source_id,))
            conn.execute("DELETE FROM archived_word_stats WHERE game_id=?", (source_id,))
        for date in sorted(dates):
            replace_rollup_for_date(date)
        return moved

    result = db.run_transaction(merge)
    from GameSentenceMiner.web.game_profiles import invalidate_game_profiles_cache

    invalidate_game_profiles_cache()
    return result


def word_novelty_with_archives(start_date, end_date, game_id=None):
    """Calculate novelty from durable word metadata and text-free reading events."""
    from GameSentenceMiner.web.token_novelty import (
        DEFAULT_GAME_BUCKET_SIZE,
        GAME_BUCKET_SIZE_OPTIONS,
        _build_date_labels,
        _build_series,
    )

    db = GameLinesTable._db
    start = datetime.fromisoformat(start_date).timestamp() if start_date else 0
    end = (datetime.fromisoformat(end_date) + timedelta(days=1)).timestamp() if end_date else time.time()
    records = archived_stats_lines()
    records.extend(
        SimpleNamespace(id=r[0], game_id=r[1], timestamp=float(r[2]), raw_char_count=r[3], tokenized=True)
        for r in db.fetchall(
            "SELECT id, game_id, timestamp, LENGTH(COALESCE(line_text,'')) FROM game_lines WHERE tokenized=1"
        )
    )
    records = sorted((r for r in records if r.tokenized), key=lambda r: (r.timestamp, r.id))
    by_id = {r.id: r for r in records}
    chars = sum(
        r.raw_char_count for r in records if start <= r.timestamp < end and (game_id is None or r.game_id == game_id)
    )
    params = [start, end]
    game_filter = ""
    if game_id is not None:
        game_filter = " AND game_id=?"
        params.append(game_id)
    unique = db.fetchone(
        f"SELECT COUNT(DISTINCT word_id) FROM ({word_occurrence_source(db)}) WHERE tokenized=1 AND timestamp>=? AND timestamp<?{game_filter}",
        tuple(params),
    )[0]
    counts, games, new_ids = Counter(), Counter(), []
    for timestamp, line_id in db.fetchall(
        "SELECT first_seen, first_seen_line_id FROM words WHERE first_seen IS NOT NULL"
    ):
        origin = by_id.get(line_id)
        if not origin or not start <= float(timestamp) < end or (game_id is not None and origin.game_id != game_id):
            continue
        counts[datetime.fromtimestamp(float(timestamp)).date().isoformat()] += 1
        games[origin.game_id] += 1
        new_ids.append(line_id)
    series = _build_series(_build_date_labels(start_date, end_date), counts)
    new_count = sum(counts.values())
    per_10k = round(new_count / chars * 10000, 1) if chars else 0.0
    if game_id is None:
        titles = {g.id: g.title_original for g in GamesTable.all_without_images()}
        ranked = sorted(games.items(), key=lambda item: (-item[1], titles.get(item[0], item[0])))
        return (
            {"uniqueWordsSeen": unique, "newWordsFirstSeen": new_count, "newWordsPer10kChars": per_10k},
            series,
            {"labels": [titles.get(gid, gid) for gid, _ in ranked], "totals": [n for _, n in ranked]},
        )
    positions, total = {}, 0
    for record in records:
        if record.game_id == game_id:
            total += record.raw_char_count
            positions[record.id] = total
    return {
        "uniqueWordsInGame": unique,
        "globallyNewWordsFromGame": new_count,
        "noveltyRate": round(new_count / unique * 100, 1) if unique else 0.0,
        "newWordsPer10kChars": per_10k,
        "series": series,
        "defaultBucketSize": DEFAULT_GAME_BUCKET_SIZE,
        "bucketSizeOptions": list(GAME_BUCKET_SIZE_OPTIONS),
        "totalTokenizedChars": total,
        "newWordCharacterPositions": sorted(positions[key] for key in new_ids),
    }
