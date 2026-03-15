from __future__ import annotations

import json

import pytest

from GameSentenceMiner.util.database.db import SQLiteDB
from GameSentenceMiner.util.database.global_frequency_tables import (
    clear_global_frequency_source_cache,
    create_global_frequency_tables,
    get_active_global_frequency_source,
    setup_global_frequency_sources,
)
from GameSentenceMiner.util.database.tokenization_tables import (
    WORD_STATS_CACHE_TABLE,
    WordsTable,
    KanjiTable,
    WordOccurrencesTable,
    KanjiOccurrencesTable,
    create_tokenization_indexes,
    create_tokenization_trigger,
)


def _write_source_file(
    source_dir, payload: dict, filename: str = "source.json"
) -> None:
    (source_dir / filename).write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


@pytest.fixture
def db(tmp_path):
    test_db = SQLiteDB(str(tmp_path / "global-frequency.db"))
    yield test_db
    test_db.close()


@pytest.fixture
def source_dir(tmp_path, monkeypatch):
    directory = tmp_path / "word_frequency_sources"
    directory.mkdir()
    monkeypatch.setattr(
        "GameSentenceMiner.util.database.global_frequency_tables.get_global_frequency_source_dir",
        lambda: directory,
    )
    monkeypatch.delenv("GAME_SENTENCE_MINER_TESTING", raising=False)
    clear_global_frequency_source_cache()
    yield directory
    clear_global_frequency_source_cache()


def test_create_global_frequency_tables_is_idempotent(db):
    create_global_frequency_tables(db)
    create_global_frequency_tables(db)

    assert db.table_exists("global_frequency_sources")
    assert db.table_exists("word_global_frequencies")

    index_names = [
        row[1] for row in db.fetchall("PRAGMA index_list('word_global_frequencies')")
    ]
    assert "idx_word_global_frequencies_rank" in index_names


def test_setup_global_frequency_sources_seeds_rows_and_deduplicates_words(
    db, source_dir
):
    _write_source_file(
        source_dir,
        {
            "id": "jiten-global",
            "name": "Jiten Global",
            "version": "v1",
            "source_url": "https://jiten.moe/other",
            "default": True,
            "entries": [
                ["alpha", 20],
                ["beta", 5],
                ["alpha", 10],
            ],
        },
    )

    setup_global_frequency_sources(db)
    setup_global_frequency_sources(db)

    source_rows = db.fetchall(
        """
        SELECT id, name, version, is_default, max_rank, entry_count
        FROM global_frequency_sources
        """
    )
    assert source_rows == [("jiten-global", "Jiten Global", "v1", 1, 10, 2)]

    rank_rows = db.fetchall(
        """
        SELECT word, rank
        FROM word_global_frequencies
        WHERE source_id = 'jiten-global'
        ORDER BY rank ASC, word ASC
        """
    )
    assert rank_rows == [("beta", 5), ("alpha", 10)]

    active_source = get_active_global_frequency_source(db)
    assert active_source == {
        "id": "jiten-global",
        "name": "Jiten Global",
        "version": "v1",
        "source_url": "https://jiten.moe/other",
        "max_rank": 10,
    }


def test_setup_global_frequency_sources_refreshes_rows_when_version_changes(
    db, source_dir
):
    _write_source_file(
        source_dir,
        {
            "id": "jiten-global",
            "name": "Jiten Global",
            "version": "v1",
            "default": True,
            "entries": [
                ["alpha", 20],
                ["beta", 5],
            ],
        },
    )
    setup_global_frequency_sources(db)

    _write_source_file(
        source_dir,
        {
            "id": "jiten-global",
            "name": "Jiten Global",
            "version": "v2",
            "default": True,
            "entries": [
                ["alpha", 8],
                ["gamma", 12],
            ],
        },
    )
    clear_global_frequency_source_cache()

    setup_global_frequency_sources(db)

    source_row = db.fetchone(
        """
        SELECT version, max_rank, entry_count
        FROM global_frequency_sources
        WHERE id = 'jiten-global'
        """
    )
    assert source_row == ("v2", 12, 2)

    rank_rows = db.fetchall(
        """
        SELECT word, rank
        FROM word_global_frequencies
        WHERE source_id = 'jiten-global'
        ORDER BY rank ASC, word ASC
        """
    )
    assert rank_rows == [("alpha", 8), ("gamma", 12)]


def test_get_active_global_frequency_source_prefers_default_row(db):
    create_global_frequency_tables(db)
    db.executemany(
        """
        INSERT INTO global_frequency_sources
        (id, name, version, source_url, is_default, max_rank, entry_count, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        """,
        [
            ("secondary", "Secondary Source", "v1", "", 0, 99, 1),
            ("primary", "Primary Source", "v3", "https://example.com", 1, 25, 2),
        ],
        commit=True,
    )

    active_source = get_active_global_frequency_source(db)
    assert active_source == {
        "id": "primary",
        "name": "Primary Source",
        "version": "v3",
        "source_url": "https://example.com",
        "max_rank": 25,
    }


def test_setup_global_frequency_sources_refreshes_cached_active_ranks(db, source_dir):
    for cls in [WordsTable, KanjiTable, WordOccurrencesTable, KanjiOccurrencesTable]:
        cls.set_db(db)
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS game_lines (
            id TEXT PRIMARY KEY,
            timestamp REAL DEFAULT 0,
            game_id TEXT DEFAULT '',
            tokenized INTEGER DEFAULT 0
        )
        """,
        commit=True,
    )
    create_tokenization_indexes(db)
    create_tokenization_trigger(db)

    word_id = WordsTable.get_or_create("alpha", "alpha", "名詞")
    db.execute(
        "INSERT INTO game_lines (id, tokenized) VALUES ('line-1', 1)",
        commit=True,
    )
    WordOccurrencesTable.insert_occurrence(word_id, "line-1")
    assert (
        db.fetchone(
            f"SELECT active_global_rank FROM {WORD_STATS_CACHE_TABLE} WHERE word_id = ?",
            (word_id,),
        )[0]
        is None
    )

    _write_source_file(
        source_dir,
        {
            "id": "jiten-global",
            "name": "Jiten Global",
            "version": "v1",
            "default": True,
            "entries": [["alpha", 7]],
        },
    )
    clear_global_frequency_source_cache()

    setup_global_frequency_sources(db)

    assert db.fetchone(
        f"SELECT occurrence_count, active_global_rank FROM {WORD_STATS_CACHE_TABLE} WHERE word_id = ?",
        (word_id,),
    ) == (1, 7)
