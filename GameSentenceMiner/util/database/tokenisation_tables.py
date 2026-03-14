from __future__ import annotations

import sqlite3
from typing import List, Optional

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.anki_tables import (
    setup_anki_tables,
    _migrate_anki_card_sync_cron,
)
from GameSentenceMiner.util.database.db import SQLiteDB, SQLiteDBTable
from GameSentenceMiner.util.database.global_frequency_tables import (
    get_active_global_frequency_source,
    setup_global_frequency_sources,
    teardown_global_frequency_sources,
)

WORD_STATS_CACHE_TABLE = "word_stats_cache"


class WordsTable(SQLiteDBTable):
    _table = "words"
    _fields = [
        "word",
        "reading",
        "pos",
        "in_anki",
        "last_seen",
        "first_seen",
        "first_seen_line_id",
    ]
    _types = [
        int,
        str,
        str,
        str,
        int,
        float,
        float,
        str,
    ]  # id (int PK auto), word, reading, pos, in_anki, last_seen, first_seen, first_seen_line_id
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: Optional[int] = None,
        word: Optional[str] = None,
        reading: Optional[str] = None,
        pos: Optional[str] = None,
        in_anki: Optional[int] = None,
        last_seen: Optional[float] = None,
        first_seen: Optional[float] = None,
        first_seen_line_id: Optional[str] = None,
    ):
        self.id = id
        self.word = word if word is not None else ""
        self.reading = reading if reading is not None else ""
        self.pos = pos if pos is not None else ""
        self.in_anki = in_anki if in_anki is not None else 0
        self.last_seen = last_seen
        self.first_seen = first_seen
        self.first_seen_line_id = (
            first_seen_line_id if first_seen_line_id is not None else ""
        )

    @classmethod
    def get_or_create(cls, word: str, reading: str | None, pos: str | None) -> int:
        """Return the id of the word, creating it if it doesn't exist."""
        cur = cls._db.execute(
            f"INSERT OR IGNORE INTO {cls._table} (word, reading, pos, in_anki) VALUES (?, ?, ?, 0)",
            (word, reading or "", pos or ""),
            commit=True,
        )
        if cur.rowcount > 0:
            return cur.lastrowid
        row = cls._db.fetchone(f"SELECT id FROM {cls._table} WHERE word = ?", (word,))
        return row[0]

    @classmethod
    def get_by_word(cls, word: str) -> Optional["WordsTable"]:
        """Look up a word by its headword text."""
        row = cls._db.fetchone(f"SELECT * FROM {cls._table} WHERE word = ?", (word,))
        return cls.from_row(row) if row else None

    @classmethod
    def get_ids_by_words(cls, words: list[str]) -> dict[str, int]:
        """Return a dict mapping each requested word to its ID."""
        if not words:
            return {}

        found: dict[str, int] = {}
        unique_words = list(dict.fromkeys(words))
        for start in range(0, len(unique_words), 500):
            chunk = unique_words[start : start + 500]
            placeholders = ", ".join(["?"] * len(chunk))
            rows = cls._db.fetchall(
                f"SELECT id, word FROM {cls._table} WHERE word IN ({placeholders})",
                tuple(chunk),
            )
            for row in rows:
                found[row[1]] = row[0]
        return found

    @classmethod
    def get_words_not_in_anki(cls) -> list["WordsTable"]:
        """Get all words where in_anki is not set (0 or NULL)."""
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE in_anki = 0 OR in_anki IS NULL"
        )
        return [cls.from_row(row) for row in rows]

    @classmethod
    def mark_in_anki(cls, word_id: int) -> None:
        """Set in_anki = 1 for a given word."""
        cls._db.execute(
            f"UPDATE {cls._table} SET in_anki = 1 WHERE id = ?",
            (word_id,),
            commit=True,
        )

    @classmethod
    def update_last_seen(cls, word_id: int, timestamp: float) -> None:
        """Update last_seen to the greater of the existing value and the given timestamp."""
        cls._db.execute(
            f"UPDATE {cls._table} SET last_seen = MAX(COALESCE(CAST(last_seen AS REAL), 0), ?) WHERE id = ?",
            (timestamp, word_id),
            commit=True,
        )

    @classmethod
    def set_first_seen_if_missing(
        cls, word_id: int, timestamp: float, line_id: str
    ) -> None:
        """Persist first-seen metadata only when it has not been recorded yet."""
        cls._db.execute(
            f"""
            UPDATE {cls._table}
            SET first_seen = COALESCE(CAST(first_seen AS REAL), ?),
                first_seen_line_id = CASE
                    WHEN first_seen_line_id IS NULL OR TRIM(CAST(first_seen_line_id AS TEXT)) = ''
                    THEN ?
                    ELSE first_seen_line_id
                END
            WHERE id = ?
            """,
            (timestamp, line_id, word_id),
            commit=True,
        )

    @classmethod
    def clear_first_seen(cls, word_id: int) -> None:
        """Clear first-seen metadata when no stable occurrence remains."""
        cls._db.execute(
            f"UPDATE {cls._table} SET first_seen = NULL, first_seen_line_id = NULL WHERE id = ?",
            (word_id,),
            commit=True,
        )


class KanjiTable(SQLiteDBTable):
    _table = "kanji"
    _fields = ["character"]
    _types = [int, str]  # id (int PK auto), character
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: Optional[int] = None,
        character: Optional[str] = None,
    ):
        self.id = id
        self.character = character if character is not None else ""

    @classmethod
    def get_or_create(cls, character: str) -> int:
        """Return the id of the kanji, creating it if it doesn't exist."""
        cur = cls._db.execute(
            f"INSERT OR IGNORE INTO {cls._table} (character) VALUES (?)",
            (character,),
            commit=True,
        )
        if cur.rowcount > 0:
            return cur.lastrowid
        row = cls._db.fetchone(
            f"SELECT id FROM {cls._table} WHERE character = ?", (character,)
        )
        return row[0]

    @classmethod
    def ensure_ids_for_characters(cls, characters: list[str]) -> dict[str, int]:
        """Return character->id for requested characters, creating missing rows."""
        if not characters:
            return {}

        unique_chars = list(dict.fromkeys(characters))
        with cls._db.transaction():
            for start in range(0, len(unique_chars), 500):
                chunk = unique_chars[start : start + 500]
                cls._db.executemany(
                    f"INSERT OR IGNORE INTO {cls._table} (character) VALUES (?)",
                    [(char,) for char in chunk],
                    commit=False,
                )

        ids: dict[str, int] = {}
        for start in range(0, len(unique_chars), 500):
            chunk = unique_chars[start : start + 500]
            placeholders = ", ".join(["?"] * len(chunk))
            rows = cls._db.fetchall(
                f"SELECT id, character FROM {cls._table} WHERE character IN ({placeholders})",
                tuple(chunk),
            )
            for row in rows:
                ids[row[1]] = row[0]
        return ids


class WordOccurrencesTable(SQLiteDBTable):
    _table = "word_occurrences"
    _fields = ["word_id", "line_id"]
    _types = [int, int, str]  # id, word_id, line_id
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: Optional[int] = None,
        word_id: Optional[int] = None,
        line_id: Optional[str] = None,
    ):
        self.id = id
        self.word_id = word_id
        self.line_id = line_id if line_id is not None else ""

    @classmethod
    def insert_occurrence(cls, word_id: int, line_id: str):
        """INSERT OR IGNORE a word-line mapping."""
        cls._db.execute(
            f"INSERT OR IGNORE INTO {cls._table} (word_id, line_id) VALUES (?, ?)",
            (word_id, line_id),
            commit=True,
        )

    @classmethod
    def get_lines_for_word(cls, word_id: int) -> list:
        """Get all line_ids containing a given word."""
        rows = cls._db.fetchall(
            f"SELECT line_id FROM {cls._table} WHERE word_id = ?", (word_id,)
        )
        return [row[0] for row in rows]

    @classmethod
    def get_words_for_line(cls, line_id: str) -> list:
        """Get all word_ids in a given line."""
        rows = cls._db.fetchall(
            f"SELECT word_id FROM {cls._table} WHERE line_id = ?", (line_id,)
        )
        return [row[0] for row in rows]


class KanjiOccurrencesTable(SQLiteDBTable):
    _table = "kanji_occurrences"
    _fields = ["kanji_id", "line_id"]
    _types = [int, int, str]  # id, kanji_id, line_id
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: Optional[int] = None,
        kanji_id: Optional[int] = None,
        line_id: Optional[str] = None,
    ):
        self.id = id
        self.kanji_id = kanji_id
        self.line_id = line_id if line_id is not None else ""

    @classmethod
    def insert_occurrence(cls, kanji_id: int, line_id: str):
        """INSERT OR IGNORE a kanji-line mapping."""
        cls._db.execute(
            f"INSERT OR IGNORE INTO {cls._table} (kanji_id, line_id) VALUES (?, ?)",
            (kanji_id, line_id),
            commit=True,
        )

    @classmethod
    def get_lines_for_kanji(cls, kanji_id: int) -> list:
        """Get all line_ids containing a given kanji."""
        rows = cls._db.fetchall(
            f"SELECT line_id FROM {cls._table} WHERE kanji_id = ?", (kanji_id,)
        )
        return [row[0] for row in rows]

    @classmethod
    def get_kanji_for_line(cls, line_id: str) -> list:
        """Get all kanji_ids in a given line."""
        rows = cls._db.fetchall(
            f"SELECT kanji_id FROM {cls._table} WHERE line_id = ?", (line_id,)
        )
        return [row[0] for row in rows]


def create_word_stats_cache_table(db: SQLiteDB) -> None:
    """Create the typed per-word cache table used by hot-path tokenisation APIs."""
    db.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {WORD_STATS_CACHE_TABLE} (
            word_id INTEGER PRIMARY KEY,
            occurrence_count INTEGER NOT NULL DEFAULT 0,
            active_global_rank INTEGER DEFAULT NULL
        )
        """,
        commit=True,
    )


def create_word_stats_cache_indexes(db: SQLiteDB) -> None:
    """Create lookup and sort indexes for the per-word cache table."""
    db.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_word_stats_cache_occurrence_count
        ON word_stats_cache(occurrence_count DESC, word_id)
        """,
        commit=True,
    )
    db.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_word_stats_cache_active_global_rank
        ON word_stats_cache(active_global_rank, word_id)
        """,
        commit=True,
    )


def refresh_word_stats_active_global_ranks(db: SQLiteDB) -> None:
    """Refresh cached ranks using the current active global-frequency source."""
    if not db.table_exists(WORD_STATS_CACHE_TABLE):
        return

    active_source = get_active_global_frequency_source(db)
    if active_source is None:
        db.execute(
            f"UPDATE {WORD_STATS_CACHE_TABLE} SET active_global_rank = NULL",
            commit=True,
        )
        return

    db.execute(
        f"""
        UPDATE {WORD_STATS_CACHE_TABLE}
        SET active_global_rank = (
            SELECT wgf.rank
            FROM words w
            LEFT JOIN word_global_frequencies wgf
                ON wgf.source_id = ? AND wgf.word = w.word
            WHERE w.id = {WORD_STATS_CACHE_TABLE}.word_id
        )
        """,
        (active_source["id"],),
        commit=True,
    )


def rebuild_word_stats_cache(db: SQLiteDB) -> None:
    """Rebuild the per-word cache from the raw occurrence tables."""
    create_word_stats_cache_table(db)

    with db.transaction():
        db.execute(f"DELETE FROM {WORD_STATS_CACHE_TABLE}", commit=True)
        db.execute(
            f"""
            INSERT INTO {WORD_STATS_CACHE_TABLE} (word_id, occurrence_count, active_global_rank)
            SELECT wo.word_id, COUNT(*), wgf.rank
            FROM word_occurrences wo
            JOIN words w ON w.id = wo.word_id
            LEFT JOIN global_frequency_sources gfs ON gfs.is_default = 1
            LEFT JOIN word_global_frequencies wgf
                ON wgf.source_id = gfs.id AND wgf.word = w.word
            GROUP BY wo.word_id, wgf.rank
            """,
            commit=True,
        )


def create_tokenisation_indexes(db: SQLiteDB):
    """Create all indexes for the tokenisation tables."""
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_words_word ON words(word)", commit=True
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_words_in_anki ON words(in_anki)", commit=True
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_words_pos ON words(pos)", commit=True)
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_words_first_seen ON words(first_seen)",
        commit=True,
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_words_first_seen_line_id ON words(first_seen_line_id)",
        commit=True,
    )
    # Migrate kanji index from non-unique to unique: drop old index, deduplicate, recreate.
    _migrate_kanji_unique_index(db)
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_kanji_character ON kanji(character)",
        commit=True,
    )
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_word_occ_unique ON word_occurrences(word_id, line_id)",
        commit=True,
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_word_occ_word_id ON word_occurrences(word_id)",
        commit=True,
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_word_occ_line_id ON word_occurrences(line_id)",
        commit=True,
    )
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_kanji_occ_unique ON kanji_occurrences(kanji_id, line_id)",
        commit=True,
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_kanji_occ_kanji_id ON kanji_occurrences(kanji_id)",
        commit=True,
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_kanji_occ_line_id ON kanji_occurrences(line_id)",
        commit=True,
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_game_lines_tokenised ON game_lines(tokenised)",
        commit=True,
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_game_lines_timestamp ON game_lines(timestamp)",
        commit=True,
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_game_lines_game_id ON game_lines(game_id)",
        commit=True,
    )

    create_word_stats_cache_table(db)
    create_word_stats_cache_indexes(db)
    setup_global_frequency_sources(db)


def _migrate_kanji_unique_index(db: SQLiteDB):
    """Migrate the kanji.character index from non-unique to unique.

    Older databases had a plain INDEX on kanji(character) which allowed
    duplicate rows.  This helper deduplicates existing rows (re-pointing
    kanji_occurrences to the surviving row) then drops the old index so
    the caller can recreate it as UNIQUE.
    """
    # Check if the existing index is already unique — nothing to do.
    index_info = db.fetchall(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_kanji_character'"
    )
    if not index_info:
        return  # Index doesn't exist yet; will be created fresh as UNIQUE.
    create_sql = index_info[0][0] or ""
    if "UNIQUE" in create_sql.upper():
        return  # Already unique.

    # Deduplicate: for each character keep the row with the smallest id.
    dupes = db.fetchall(
        "SELECT character, MIN(id) AS keep_id FROM kanji "
        "GROUP BY character HAVING COUNT(*) > 1"
    )
    if dupes:
        with db.transaction():
            for character, keep_id in dupes:
                dup_rows = db.fetchall(
                    "SELECT id FROM kanji WHERE character = ? AND id != ?",
                    (character, keep_id),
                )
                for (dup_id,) in dup_rows:
                    db.execute(
                        "UPDATE kanji_occurrences SET kanji_id = ? WHERE kanji_id = ?",
                        (keep_id, dup_id),
                        commit=True,
                    )
                    db.execute("DELETE FROM kanji WHERE id = ?", (dup_id,), commit=True)

    # Drop the old non-unique index so it can be recreated as UNIQUE.
    db.execute("DROP INDEX IF EXISTS idx_kanji_character", commit=True)


def create_tokenisation_trigger(db: SQLiteDB):
    """Create tokenisation triggers for cleanup and per-word cache maintenance."""
    db.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_game_lines_tokenisation_cleanup
        AFTER DELETE ON game_lines
        BEGIN
            DELETE FROM word_occurrences WHERE line_id = OLD.id;
            DELETE FROM kanji_occurrences WHERE line_id = OLD.id;
        END;
        """,
        commit=True,
    )
    db.execute(
        f"""
        CREATE TRIGGER IF NOT EXISTS trg_word_occurrences_stats_cache_insert
        AFTER INSERT ON word_occurrences
        BEGIN
            INSERT OR IGNORE INTO {WORD_STATS_CACHE_TABLE} (word_id, occurrence_count, active_global_rank)
            SELECT NEW.word_id, 0, wgf.rank
            FROM words w
            LEFT JOIN global_frequency_sources gfs ON gfs.is_default = 1
            LEFT JOIN word_global_frequencies wgf
                ON wgf.source_id = gfs.id AND wgf.word = w.word
            WHERE w.id = NEW.word_id
            LIMIT 1;

            UPDATE {WORD_STATS_CACHE_TABLE}
            SET occurrence_count = occurrence_count + 1
            WHERE word_id = NEW.word_id;
        END;
        """,
        commit=True,
    )
    db.execute(
        f"""
        CREATE TRIGGER IF NOT EXISTS trg_word_occurrences_stats_cache_delete
        AFTER DELETE ON word_occurrences
        BEGIN
            UPDATE {WORD_STATS_CACHE_TABLE}
            SET occurrence_count = CASE
                WHEN occurrence_count > 0 THEN occurrence_count - 1
                ELSE 0
            END
            WHERE word_id = OLD.word_id;

            DELETE FROM {WORD_STATS_CACHE_TABLE}
            WHERE word_id = OLD.word_id AND occurrence_count <= 0;
        END;
        """,
        commit=True,
    )
    db.execute(
        f"""
        CREATE TRIGGER IF NOT EXISTS trg_words_stats_cache_delete
        AFTER DELETE ON words
        BEGIN
            DELETE FROM {WORD_STATS_CACHE_TABLE}
            WHERE word_id = OLD.id;
        END;
        """,
        commit=True,
    )


def recompute_word_first_seen_metadata(
    db: SQLiteDB,
    word_ids: list[int] | None = None,
    *,
    only_missing: bool = False,
) -> int:
    """Populate or repair word first-seen metadata from surviving occurrences."""
    if not db.table_exists("words") or not db.table_exists("word_occurrences"):
        return 0

    conditions: list[str] = []
    params: list[object] = []
    if word_ids is not None:
        target_ids = [word_id for word_id in dict.fromkeys(word_ids) if word_id > 0]
        if not target_ids:
            return 0
        placeholders = ", ".join(["?"] * len(target_ids))
        conditions.append(f"id IN ({placeholders})")
        params.extend(target_ids)

    if only_missing:
        conditions.append(
            "(first_seen IS NULL OR first_seen_line_id IS NULL OR TRIM(CAST(first_seen_line_id AS TEXT)) = '')"
        )

    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    target_rows = db.fetchall(f"SELECT id FROM words {where_sql}", tuple(params))
    target_word_ids = [int(row[0]) for row in target_rows]
    if not target_word_ids:
        return 0

    placeholders = ", ".join(["?"] * len(target_word_ids))
    occurrence_rows = db.fetchall(
        f"""
        SELECT wo.word_id, gl.timestamp, gl.id
        FROM word_occurrences wo
        JOIN game_lines gl ON gl.id = wo.line_id
        WHERE wo.word_id IN ({placeholders})
        ORDER BY wo.word_id ASC, CAST(gl.timestamp AS REAL) ASC, gl.id ASC
        """,
        tuple(target_word_ids),
    )

    earliest_by_word: dict[int, tuple[float, str]] = {}
    for raw_word_id, raw_timestamp, raw_line_id in occurrence_rows:
        word_id = int(raw_word_id)
        if word_id in earliest_by_word:
            continue
        earliest_by_word[word_id] = (
            float(raw_timestamp) if raw_timestamp is not None else 0.0,
            str(raw_line_id or ""),
        )

    updated = 0
    with db.transaction():
        for word_id in target_word_ids:
            first_occurrence = earliest_by_word.get(word_id)
            if first_occurrence is None:
                db.execute(
                    "UPDATE words SET first_seen = NULL, first_seen_line_id = NULL WHERE id = ?",
                    (word_id,),
                    commit=True,
                )
                updated += 1
                continue

            timestamp, line_id = first_occurrence
            db.execute(
                """
                UPDATE words
                SET first_seen = ?, first_seen_line_id = ?
                WHERE id = ?
                """,
                (timestamp, line_id, word_id),
                commit=True,
            )
            updated += 1

    return updated


def drop_tokenisation_trigger(db: SQLiteDB):
    """Drop tokenisation cleanup and cache-maintenance triggers."""
    db.execute(
        "DROP TRIGGER IF EXISTS trg_game_lines_tokenisation_cleanup", commit=True
    )
    db.execute(
        "DROP TRIGGER IF EXISTS trg_word_occurrences_stats_cache_insert",
        commit=True,
    )
    db.execute(
        "DROP TRIGGER IF EXISTS trg_word_occurrences_stats_cache_delete",
        commit=True,
    )
    db.execute("DROP TRIGGER IF EXISTS trg_words_stats_cache_delete", commit=True)


def setup_tokenisation(db: SQLiteDB):
    """
    Full setup when tokenisation is enabled:
    1. Create tables (set_db handles CREATE TABLE IF NOT EXISTS)
    2. Add tokenised column to game_lines
    3. Create indexes
    4. Create trigger
    5. Register cron
    6. Reset tokenised column to 0 ONLY on fresh setup (first enable or re-enable after teardown)
    """
    # Check BEFORE creating tables whether they already exist.
    # If they do, this is a repeat startup and we must NOT wipe the tokenised flags.
    tables_already_exist = db.table_exists("words")
    word_stats_cache_already_exists = db.table_exists(WORD_STATS_CACHE_TABLE)

    # 1. Create tables by calling set_db
    for cls in [WordsTable, KanjiTable, WordOccurrencesTable, KanjiOccurrencesTable]:
        cls.set_db(db)

    # 2. Add tokenised column (idempotent)
    try:
        db.execute(
            "ALTER TABLE game_lines ADD COLUMN tokenised INTEGER DEFAULT 0",
            commit=True,
        )
    except sqlite3.OperationalError as e:
        if "duplicate column name" not in str(e):
            raise

    # 2b. Add in_anki column to words table (idempotent)
    try:
        db.execute(
            "ALTER TABLE words ADD COLUMN in_anki INTEGER DEFAULT 0",
            commit=True,
        )
    except sqlite3.OperationalError as e:
        if "duplicate column name" not in str(e):
            raise

    # 3. Create indexes
    create_tokenisation_indexes(db)

    # 3b. Create Anki cache tables
    setup_anki_tables(db)

    # 4. Create trigger
    create_tokenisation_trigger(db)

    # 4b. Backfill the per-word cache on first migration to the cache-table schema.
    if not word_stats_cache_already_exists:
        rebuild_word_stats_cache(db)

    recompute_word_first_seen_metadata(db, only_missing=True)

    # 5. Register crons
    _migrate_tokenise_backfill_cron_job()
    _migrate_anki_card_sync_cron()

    # 6. Reset tokenised = 0 ONLY on fresh setup (first enable or re-enable after
    #    teardown which drops the tables). On normal repeat startup the tables already
    #    exist and previously-tokenised lines must keep their flag.
    if not tables_already_exist:
        db.execute("UPDATE game_lines SET tokenised = 0", commit=True)
        logger.info(
            "Fresh tokenisation setup: reset all lines to untokenised for initial backfill"
        )

    logger.info(
        "Tokenisation setup complete: tables, indexes, trigger, and cron created"
    )


def teardown_tokenisation(db: SQLiteDB):
    """
    Full teardown when tokenisation is disabled:
    1. Drop occurrence tables first (FK order)
    2. Drop dimension tables
    3. Disable cron
    4. Drop trigger
    NOTE: tokenised column on game_lines is NOT removed (SQLite compat)
    """
    # 1-2. Drop tables (order matters for FK safety, but SQLite doesn't enforce FKs by default)
    WordOccurrencesTable.set_db(db)  # Ensure _db is set before drop
    KanjiOccurrencesTable.set_db(db)
    WordsTable.set_db(db)
    KanjiTable.set_db(db)

    WordOccurrencesTable.drop()
    KanjiOccurrencesTable.drop()
    WordsTable.drop()
    KanjiTable.drop()
    db.execute(f"DROP TABLE IF EXISTS {WORD_STATS_CACHE_TABLE}", commit=True)

    # 3. Disable crons
    _disable_tokenise_backfill_cron()
    _disable_anki_word_sync_cron()

    # 4. Drop trigger
    drop_tokenisation_trigger(db)

    teardown_global_frequency_sources(db)

    logger.info(
        "Tokenisation teardown complete: tables, trigger dropped; cron disabled"
    )


def _migrate_tokenise_backfill_cron_job():
    """Register the tokenise_backfill cron job."""
    from datetime import datetime, timedelta
    from GameSentenceMiner.util.database.cron_table import CronTable

    existing_cron = CronTable.get_by_name("tokenise_backfill")
    if not existing_cron:
        now = datetime.now()
        one_minute_ago = now - timedelta(minutes=1)
        CronTable.create_cron_entry(
            name="tokenise_backfill",
            description="Tokenise game lines and clean up orphaned occurrences",
            next_run=one_minute_ago.timestamp(),
            schedule="weekly",
        )
        logger.info("Created tokenise_backfill cron job")
    else:
        # Re-enabling after disable: ensure cron is active
        if not existing_cron.enabled:
            existing_cron.enabled = True
            existing_cron.next_run = (datetime.now() - timedelta(minutes=1)).timestamp()
            existing_cron.save()
            logger.info("Re-enabled tokenise_backfill cron job")


def _disable_tokenise_backfill_cron():
    """Disable the tokenise_backfill cron job."""
    from GameSentenceMiner.util.database.cron_table import CronTable

    existing_cron = CronTable.get_by_name("tokenise_backfill")
    if existing_cron:
        existing_cron.enabled = False
        existing_cron.save()
        logger.info("Disabled tokenise_backfill cron job")


def _migrate_anki_word_sync_cron_job():
    """Register the anki_word_sync daily cron job."""
    from datetime import datetime, timedelta
    from GameSentenceMiner.util.database.cron_table import CronTable

    existing_cron = CronTable.get_by_name("anki_word_sync")
    if not existing_cron:
        now = datetime.now()
        one_minute_ago = now - timedelta(minutes=1)
        CronTable.create_cron_entry(
            name="anki_word_sync",
            description="Sync tokenised words with Anki Expression field",
            next_run=one_minute_ago.timestamp(),
            schedule="daily",
        )
        logger.info("Created anki_word_sync cron job")
    else:
        if not existing_cron.enabled:
            existing_cron.enabled = True
            existing_cron.next_run = (datetime.now() - timedelta(minutes=1)).timestamp()
            existing_cron.save()
            logger.info("Re-enabled anki_word_sync cron job")


def _disable_anki_word_sync_cron():
    """Disable the anki_word_sync cron job."""
    from GameSentenceMiner.util.database.cron_table import CronTable

    existing_cron = CronTable.get_by_name("anki_word_sync")
    if existing_cron:
        existing_cron.enabled = False
        existing_cron.save()
        logger.info("Disabled anki_word_sync cron job")
