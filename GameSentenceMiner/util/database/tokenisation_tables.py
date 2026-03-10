from __future__ import annotations

import sqlite3
from typing import List, Optional

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.db import SQLiteDB, SQLiteDBTable


class WordsTable(SQLiteDBTable):
    _table = "words"
    _fields = ["word", "reading", "pos", "in_anki"]
    _types = [int, str, str, str, int]  # id (int PK auto), word, reading, pos, in_anki
    _pk = "id"
    _auto_increment = True

    def __init__(
        self,
        id: Optional[int] = None,
        word: Optional[str] = None,
        reading: Optional[str] = None,
        pos: Optional[str] = None,
        in_anki: Optional[int] = None,
    ):
        self.id = id
        self.word = word if word is not None else ""
        self.reading = reading if reading is not None else ""
        self.pos = pos if pos is not None else ""
        self.in_anki = in_anki if in_anki is not None else 0

    @classmethod
    def get_or_create(cls, word: str, reading: str | None, pos: str | None) -> int:
        """Return the id of the word, creating it if it doesn't exist."""
        cls._db.execute(
            f"INSERT OR IGNORE INTO {cls._table} (word, reading, pos, in_anki) VALUES (?, ?, ?, 0)",
            (word, reading or "", pos or ""),
            commit=True,
        )
        row = cls._db.fetchone(f"SELECT id FROM {cls._table} WHERE word = ?", (word,))
        return row[0]

    @classmethod
    def get_by_word(cls, word: str) -> Optional["WordsTable"]:
        """Look up a word by its headword text."""
        row = cls._db.fetchone(f"SELECT * FROM {cls._table} WHERE word = ?", (word,))
        return cls.from_row(row) if row else None

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
        cls._db.execute(
            f"INSERT OR IGNORE INTO {cls._table} (character) VALUES (?)",
            (character,),
            commit=True,
        )
        row = cls._db.fetchone(
            f"SELECT id FROM {cls._table} WHERE character = ?", (character,)
        )
        return row[0]


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


def create_tokenisation_indexes(db: SQLiteDB):
    """Create all indexes for the tokenisation tables."""
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_words_word ON words(word)", commit=True
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_kanji_character ON kanji(character)",
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


def create_tokenisation_trigger(db: SQLiteDB):
    """Create the AFTER DELETE trigger on game_lines to clean up occurrences."""
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


def drop_tokenisation_trigger(db: SQLiteDB):
    """Drop the tokenisation cleanup trigger."""
    db.execute(
        "DROP TRIGGER IF EXISTS trg_game_lines_tokenisation_cleanup", commit=True
    )


def setup_tokenisation(db: SQLiteDB):
    """
    Full setup when tokenisation is enabled:
    1. Create tables (set_db handles CREATE TABLE IF NOT EXISTS)
    2. Add tokenised column to game_lines
    3. Create indexes
    4. Create trigger
    5. Register cron
    6. Reset tokenised column to 0 for re-enable correctness
    """
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

    # 4. Create trigger
    create_tokenisation_trigger(db)

    # 5. Register crons
    _migrate_tokenise_backfill_cron_job()
    _migrate_anki_word_sync_cron_job()

    # 6. Reset tokenised = 0 for all lines (handles re-enable after disable)
    db.execute("UPDATE game_lines SET tokenised = 0", commit=True)

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

    # 3. Disable crons
    _disable_tokenise_backfill_cron()
    _disable_anki_word_sync_cron()

    # 4. Drop trigger
    drop_tokenisation_trigger(db)

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
