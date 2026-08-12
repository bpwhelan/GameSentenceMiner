from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from GameSentenceMiner.util.database.db import SQLiteDB
from GameSentenceMiner.util.database.term_lookup_stats_table import (
    TermLookupStatsTable,
)


@pytest.fixture(autouse=True)
def restore_lookup_stats_database():
    previous = TermLookupStatsTable._db
    try:
        yield
    finally:
        TermLookupStatsTable._db = previous


def _stat(term, reading, *, count=1, first, last=None):
    return {
        "term": term,
        "reading": reading,
        "lookup_count": count,
        "first_looked_up_at": first,
        "last_looked_up_at": first if last is None else last,
    }


def _create_tokenization_tables(database, *, cache=True):
    database.execute("CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT NOT NULL)", commit=True)
    database.execute(
        "CREATE TABLE word_occurrences (word_id INTEGER NOT NULL, line_id TEXT NOT NULL)",
        commit=True,
    )
    if cache:
        database.execute(
            """
            CREATE TABLE word_stats_cache (
                word_id INTEGER PRIMARY KEY,
                occurrence_count INTEGER NOT NULL
            )
            """,
            commit=True,
        )


@pytest.fixture
def lookup_db():
    database = SQLiteDB(":memory:")
    TermLookupStatsTable.set_db(database)
    try:
        yield database
    finally:
        database.close()


def test_lookup_stats_schema_is_typed_idempotent_and_drops_legacy_sort_index(lookup_db):
    lookup_db.execute("DROP INDEX IF EXISTS idx_term_lookup_stats_count", commit=True)
    lookup_db.execute(
        """
        CREATE INDEX idx_term_lookup_stats_count
        ON term_lookup_stats (lookup_count)
        """,
        commit=True,
    )
    TermLookupStatsTable.set_db(lookup_db)

    columns = {row[1]: (row[2], row[5]) for row in lookup_db.fetchall("PRAGMA table_info(term_lookup_stats)")}
    assert columns == {
        "term": ("TEXT", 1),
        "reading": ("TEXT", 2),
        "lookup_count": ("INTEGER", 0),
        "first_looked_up_at": ("REAL", 0),
        "last_looked_up_at": ("REAL", 0),
    }
    indexes = {row[1] for row in lookup_db.fetchall("PRAGMA index_list(term_lookup_stats)")}
    assert "idx_term_lookup_stats_count" not in indexes


def test_repeated_lookup_increments_and_preserves_first_timestamp(lookup_db):
    first = TermLookupStatsTable.record_lookup("食べる", "たべる", 100.0)
    second = TermLookupStatsTable.record_lookup("食べる", "たべる", 150.0)

    assert first == _stat("食べる", "たべる", first=100.0)
    assert second == _stat("食べる", "たべる", count=2, first=100.0, last=150.0)


def test_out_of_order_writes_keep_timestamp_bounds_valid(lookup_db):
    TermLookupStatsTable.record_lookup("戻る", "もどる", 200.0)

    result = TermLookupStatsTable.record_lookup("戻る", "もどる", 100.0)

    assert result["lookup_count"] == 2
    assert result["first_looked_up_at"] == 100.0
    assert result["last_looked_up_at"] == 200.0


def test_lookup_stats_separate_readings_and_order_by_count_then_recency(lookup_db):
    TermLookupStatsTable.record_lookup("生", "せい", 100.0)
    TermLookupStatsTable.record_lookup("生", "せい", 110.0)
    TermLookupStatsTable.record_lookup("生", "なま", 120.0)
    TermLookupStatsTable.record_lookup("食べる", "たべる", 130.0)
    TermLookupStatsTable.record_lookup("食べる", "たべる", 140.0)

    stats = TermLookupStatsTable.get_stats(limit=2, offset=0)

    assert stats["total_lookups"] == 5
    assert stats["unique_terms"] == 3
    assert [item["term"] for item in stats["items"]] == ["食べる", "生"]
    assert [item["reading"] for item in stats["items"]] == ["たべる", "せい"]
    assert TermLookupStatsTable.get_stats(limit=2, offset=2)["items"] == [_stat("生", "なま", first=120.0)]
    empty_page = TermLookupStatsTable.get_stats(limit=2, offset=99)
    assert empty_page == {
        "total_lookups": 5,
        "unique_terms": 3,
        "items": [],
    }


def test_concurrent_lookup_increments_are_atomic(lookup_db):
    def record(_index: int) -> None:
        TermLookupStatsTable.record_lookup("読む", "よむ", 200.0)

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(record, range(40)))

    stats = TermLookupStatsTable.get_stats(limit=10, offset=0)
    assert stats["total_lookups"] == 40
    assert stats["items"][0]["lookup_count"] == 40


def test_lookup_stats_survive_tokenization_table_removal(lookup_db):
    for table in ["words", "word_occurrences", "word_stats_cache"]:
        lookup_db.execute(f"CREATE TABLE {table} (id INTEGER)", commit=True)
    TermLookupStatsTable.record_lookup("聞く", "きく", 300.0)

    for table in ["word_occurrences", "words", "word_stats_cache"]:
        lookup_db.execute(f"DROP TABLE {table}", commit=True)

    assert lookup_db.table_exists("term_lookup_stats")
    assert TermLookupStatsTable.get_stats(limit=10, offset=0)["total_lookups"] == 1


def test_read_only_legacy_database_without_lookup_table_reads_empty(tmp_path):
    path = tmp_path / "legacy.db"
    writable = SQLiteDB(str(path))
    writable.execute("CREATE TABLE legacy (id INTEGER)", commit=True)
    writable.close()

    read_only = SQLiteDB(str(path), read_only=True)
    try:
        TermLookupStatsTable.set_db(read_only)
        assert TermLookupStatsTable.get_stats(limit=10, offset=0) == {
            "total_lookups": 0,
            "unique_terms": 0,
            "items": [],
        }
        with pytest.raises(RuntimeError, match="read-only"):
            TermLookupStatsTable.record_lookup("読む", "よむ", 400.0)
    finally:
        read_only.close()


def test_lookup_stats_persist_when_database_reopens(tmp_path):
    path = tmp_path / "persistent.db"
    first_database = SQLiteDB(str(path))
    TermLookupStatsTable.set_db(first_database)
    TermLookupStatsTable.record_lookup("学ぶ", "まなぶ", 500.0)
    first_database.close()

    second_database = SQLiteDB(str(path))
    try:
        TermLookupStatsTable.set_db(second_database)
        assert TermLookupStatsTable.get_stats(limit=10, offset=0)["items"] == [_stat("学ぶ", "まなぶ", first=500.0)]
    finally:
        second_database.close()


def test_seen_count_is_unavailable_without_tokenization_tables(lookup_db):
    assert TermLookupStatsTable.get_seen_count("食べる") is None

    lookup_db.execute(
        "CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT NOT NULL)",
        commit=True,
    )

    assert TermLookupStatsTable.get_seen_count("食べる") is None


def test_seen_count_uses_word_stats_cache_and_returns_zero_for_unseen_terms(lookup_db):
    _create_tokenization_tables(lookup_db)
    lookup_db.execute(
        "INSERT INTO words (id, word) VALUES (?, ?)",
        (1, "食べる"),
        commit=True,
    )
    lookup_db.execute(
        "INSERT INTO word_stats_cache (word_id, occurrence_count) VALUES (?, ?)",
        (1, 34),
        commit=True,
    )
    lookup_db.execute(
        "INSERT INTO word_occurrences (word_id, line_id) VALUES (?, ?)",
        (1, "cache-must-win"),
        commit=True,
    )

    assert TermLookupStatsTable.get_seen_count("食べる") == 34
    assert TermLookupStatsTable.get_seen_count("未出") == 0


def test_seen_count_falls_back_to_raw_occurrences_when_cache_is_missing(lookup_db):
    _create_tokenization_tables(lookup_db, cache=False)
    lookup_db.execute(
        "INSERT INTO words (id, word) VALUES (?, ?)",
        (1, "読む"),
        commit=True,
    )
    lookup_db.executemany(
        "INSERT INTO word_occurrences (word_id, line_id) VALUES (?, ?)",
        [(1, "line-1"), (1, "line-2")],
        commit=True,
    )

    assert TermLookupStatsTable.get_seen_count("読む") == 2
    assert TermLookupStatsTable.get_seen_count("未出") == 0
