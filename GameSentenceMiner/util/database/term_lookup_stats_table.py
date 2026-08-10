from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from GameSentenceMiner.util.database.db import SQLiteDB


class TermLookupStatsTable:
    """All-time lookup counts for canonical dictionary terms."""

    _table = "term_lookup_stats"
    _db: SQLiteDB | None = None

    @classmethod
    def set_db(cls, db: SQLiteDB) -> None:
        cls._db = db
        if db.read_only:
            return
        db.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {cls._table} (
                term TEXT NOT NULL,
                reading TEXT NOT NULL DEFAULT '',
                lookup_count INTEGER NOT NULL DEFAULT 0 CHECK (lookup_count >= 0),
                first_looked_up_at REAL NOT NULL,
                last_looked_up_at REAL NOT NULL,
                PRIMARY KEY (term, reading)
            )
            """,
            commit=True,
        )
        # The stats query is infrequent, while maintaining this index slows every lookup write.
        db.execute("DROP INDEX IF EXISTS idx_term_lookup_stats_count", commit=True)

    @classmethod
    def _get_db(cls) -> SQLiteDB:
        if cls._db is None:
            raise RuntimeError("Term lookup statistics database is not initialized.")
        return cls._db

    @classmethod
    def record_lookup(
        cls,
        term: str,
        reading: str,
        looked_up_at: float | None = None,
    ) -> dict[str, Any]:
        db = cls._get_db()
        if db.read_only:
            raise RuntimeError("Cannot record lookup statistics in read-only mode.")
        timestamp = time.time() if looked_up_at is None else float(looked_up_at)

        def write(conn):
            conn.execute(
                f"""
                INSERT INTO {cls._table} (
                    term,
                    reading,
                    lookup_count,
                    first_looked_up_at,
                    last_looked_up_at
                ) VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(term, reading) DO UPDATE SET
                    lookup_count = {cls._table}.lookup_count + 1,
                    first_looked_up_at = MIN(
                        {cls._table}.first_looked_up_at,
                        excluded.first_looked_up_at
                    ),
                    last_looked_up_at = MAX(
                        {cls._table}.last_looked_up_at,
                        excluded.last_looked_up_at
                    )
                """,
                (term, reading, timestamp, timestamp),
            )
            row = conn.execute(
                f"""
                SELECT
                    term,
                    reading,
                    lookup_count,
                    first_looked_up_at,
                    last_looked_up_at
                FROM {cls._table}
                WHERE term = ? AND reading = ?
                """,
                (term, reading),
            ).fetchone()
            return cls._row_to_dict(row)

        return db.run_transaction(write)

    @classmethod
    def get_seen_count(cls, term: str) -> int | None:
        """Return the all-games tokenized occurrence count for an exact term."""
        db = cls._get_db()
        if not db.table_exists("words"):
            return None

        if db.table_exists("word_stats_cache"):
            row = db.fetchone(
                """
                SELECT COALESCE(word_stats_cache.occurrence_count, 0)
                FROM words
                LEFT JOIN word_stats_cache
                    ON word_stats_cache.word_id = words.id
                WHERE words.word = ?
                LIMIT 1
                """,
                (term,),
            )
            return int(row[0] or 0) if row is not None else 0

        if not db.table_exists("word_occurrences"):
            return None

        row = db.fetchone(
            """
            SELECT COUNT(word_occurrences.line_id)
            FROM words
            LEFT JOIN word_occurrences
                ON word_occurrences.word_id = words.id
            WHERE words.word = ?
            """,
            (term,),
        )
        return int(row[0] or 0) if row is not None else 0

    @classmethod
    def get_stats(cls, limit: int, offset: int) -> dict[str, Any]:
        db = cls._get_db()
        if not db.table_exists(cls._table):
            return {"total_lookups": 0, "unique_terms": 0, "items": []}

        rows = db.fetchall(
            f"""
            WITH totals AS (
                SELECT
                    COALESCE(SUM(lookup_count), 0) AS total_lookups,
                    COUNT(*) AS unique_terms
                FROM {cls._table}
            ),
            page AS (
                SELECT
                    term,
                    reading,
                    lookup_count,
                    first_looked_up_at,
                    last_looked_up_at
                FROM {cls._table}
                ORDER BY
                    lookup_count DESC,
                    last_looked_up_at DESC,
                    term ASC,
                    reading ASC
                LIMIT ? OFFSET ?
            )
            SELECT
                totals.total_lookups,
                totals.unique_terms,
                page.term,
                page.reading,
                page.lookup_count,
                page.first_looked_up_at,
                page.last_looked_up_at
            FROM totals
            LEFT JOIN page ON 1 = 1
            ORDER BY
                page.lookup_count DESC,
                page.last_looked_up_at DESC,
                page.term ASC,
                page.reading ASC
            """,
            (limit, offset),
        )
        first_row = rows[0]
        return {
            "total_lookups": int(first_row[0] or 0),
            "unique_terms": int(first_row[1] or 0),
            "items": [cls._row_to_dict(row[2:]) for row in rows if row[2] is not None],
        }

    @staticmethod
    def _row_to_dict(row) -> dict[str, Any]:
        if row is None:
            raise RuntimeError("Lookup statistics write did not return a row.")
        return {
            "term": str(row[0]),
            "reading": str(row[1]),
            "lookup_count": int(row[2]),
            "first_looked_up_at": float(row[3]),
            "last_looked_up_at": float(row[4]),
        }
