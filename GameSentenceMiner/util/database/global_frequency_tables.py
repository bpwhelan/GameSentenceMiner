from __future__ import annotations

import json
import os
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.db import SQLiteDB

_SOURCE_DIR = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "templates"
    / "components"
    / "word_frequency_sources"
)


def get_global_frequency_source_dir() -> Path:
    return _SOURCE_DIR


def clear_global_frequency_source_cache() -> None:
    load_global_frequency_sources.cache_clear()


def _normalize_source_entries(
    raw_entries: list[Any], source_id: str
) -> list[tuple[str, int]]:
    best_rank_by_word: dict[str, int] = {}

    for entry in raw_entries:
        if not isinstance(entry, (list, tuple)) or len(entry) != 2:
            continue

        raw_word, raw_rank = entry
        word = str(raw_word or "").strip()
        if not word:
            continue

        try:
            rank = int(raw_rank)
        except (TypeError, ValueError):
            continue

        if rank <= 0:
            continue

        existing = best_rank_by_word.get(word)
        if existing is None or rank < existing:
            best_rank_by_word[word] = rank

    entries = sorted(best_rank_by_word.items(), key=lambda item: (item[1], item[0]))
    logger.info(
        f"Loaded {len(entries)} global-frequency entries for source {source_id}"
    )
    return entries


def _read_source_file(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning(f"Failed to load word-frequency source {path.name}: {exc}")
        return None

    source_id = str(data.get("id") or path.stem).strip()
    name = str(data.get("name") or source_id).strip()
    version = str(data.get("version") or "1").strip()
    source_url = str(data.get("source") or data.get("source_url") or "").strip()
    is_default = bool(data.get("default"))

    try:
        max_rank = int(data.get("max_rank") or 0)
    except (TypeError, ValueError):
        max_rank = 0

    raw_entries = data.get("entries") or []
    if not isinstance(raw_entries, list):
        logger.warning(f"Word-frequency source {path.name} has invalid entries payload")
        return None

    entries = _normalize_source_entries(raw_entries, source_id)
    if not entries:
        logger.warning(
            f"Word-frequency source {path.name} did not contain any usable entries"
        )
        return None

    if max_rank <= 0:
        max_rank = max(rank for _, rank in entries)

    return {
        "id": source_id,
        "name": name,
        "version": version,
        "source_url": source_url,
        "is_default": is_default,
        "max_rank": max_rank,
        "entry_count": len(entries),
        "entries": entries,
    }


@lru_cache(maxsize=1)
def load_global_frequency_sources() -> list[dict[str, Any]]:
    source_dir = get_global_frequency_source_dir()
    if not source_dir.exists():
        logger.info(f"Word-frequency source directory does not exist yet: {source_dir}")
        return []

    sources: list[dict[str, Any]] = []
    for path in sorted(source_dir.glob("*.json")):
        source = _read_source_file(path)
        if source:
            sources.append(source)

    default_count = sum(1 for source in sources if source["is_default"])
    if sources and default_count == 0:
        sources[0]["is_default"] = True

    return sources


def create_global_frequency_tables(db: SQLiteDB) -> None:
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS global_frequency_sources (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            source_url TEXT DEFAULT '',
            is_default INTEGER NOT NULL DEFAULT 0,
            max_rank INTEGER NOT NULL DEFAULT 0,
            entry_count INTEGER NOT NULL DEFAULT 0,
            synced_at REAL NOT NULL DEFAULT 0
        )
        """,
        commit=True,
    )
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS word_global_frequencies (
            source_id TEXT NOT NULL,
            word TEXT NOT NULL,
            rank INTEGER NOT NULL,
            PRIMARY KEY (source_id, word)
        )
        """,
        commit=True,
    )
    db.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_word_global_frequencies_rank
        ON word_global_frequencies(source_id, rank)
        """,
        commit=True,
    )


def setup_global_frequency_sources(db: SQLiteDB) -> None:
    create_global_frequency_tables(db)

    if os.getenv("GAME_SENTENCE_MINER_TESTING") == "1":
        return

    sources = load_global_frequency_sources()
    if not sources:
        return

    default_source_id = next(
        (source["id"] for source in sources if source["is_default"]),
        sources[0]["id"],
    )

    for source in sources:
        source_id = source["id"]
        row = db.fetchone(
            """
            SELECT version, entry_count
            FROM global_frequency_sources
            WHERE id = ?
            """,
            (source_id,),
        )

        needs_refresh = (
            row is None
            or str(row[0]) != source["version"]
            or int(row[1]) != source["entry_count"]
        )

        with db.transaction():
            if needs_refresh:
                rows_to_insert = [
                    (source_id, word, rank) for word, rank in source["entries"]
                ]
                db.execute(
                    "DELETE FROM word_global_frequencies WHERE source_id = ?",
                    (source_id,),
                    commit=True,
                )
                db.executemany(
                    """
                    INSERT OR REPLACE INTO word_global_frequencies (source_id, word, rank)
                    VALUES (?, ?, ?)
                    """,
                    rows_to_insert,
                    commit=True,
                )

            db.execute(
                """
                INSERT OR REPLACE INTO global_frequency_sources
                (id, name, version, source_url, is_default, max_rank, entry_count, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_id,
                    source["name"],
                    source["version"],
                    source["source_url"],
                    1 if source_id == default_source_id else 0,
                    int(source["max_rank"]),
                    int(source["entry_count"]),
                    time.time(),
                ),
                commit=True,
            )

    try:
        from GameSentenceMiner.util.database.tokenisation_tables import (
            refresh_word_stats_active_global_ranks,
        )

        refresh_word_stats_active_global_ranks(db)
    except Exception as exc:
        logger.warning(f"Failed to refresh cached word ranks after source sync: {exc}")


def teardown_global_frequency_sources(db: SQLiteDB) -> None:
    db.execute("DROP TABLE IF EXISTS word_global_frequencies", commit=True)
    db.execute("DROP TABLE IF EXISTS global_frequency_sources", commit=True)


def get_active_global_frequency_source(db: SQLiteDB) -> dict[str, Any] | None:
    if not db.table_exists("global_frequency_sources"):
        return None

    row = db.fetchone(
        """
        SELECT id, name, version, source_url, max_rank
        FROM global_frequency_sources
        ORDER BY is_default DESC, name ASC, id ASC
        LIMIT 1
        """
    )
    if not row:
        return None

    return {
        "id": str(row[0]),
        "name": str(row[1]),
        "version": str(row[2]),
        "source_url": str(row[3] or ""),
        "max_rank": int(row[4] or 0),
    }
