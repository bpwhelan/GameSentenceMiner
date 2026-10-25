import pytest

from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.database.reading_breaks_table import ReadingBreaksTable


def test_reading_old_database_does_not_create_pause_table(monkeypatch, tmp_path):
    path = str(tmp_path / "old-stats.db")
    database = SQLiteDB(path)
    database.execute("CREATE TABLE old_data (id INTEGER)", commit=True)
    database.close()
    database = SQLiteDB(path, read_only=True)
    monkeypatch.setattr(GameLinesTable, "_db", database)
    try:
        assert ReadingBreaksTable.between(0.0, 1000.0) == []
        assert not database.table_exists(ReadingBreaksTable._table)
    finally:
        database.close()


def test_pause_boundaries_follow_the_selected_database_and_numeric_timestamp_order(monkeypatch):
    first = SQLiteDB(":memory:")
    second = SQLiteDB(":memory:")
    try:
        monkeypatch.setattr(GameLinesTable, "_db", first)
        for timestamp in [100.0, 20.0, 9.0, 50.0]:
            ReadingBreaksTable.record(timestamp)
        assert ReadingBreaksTable.between(20.0, 100.0) == [20.0, 50.0]

        monkeypatch.setattr(GameLinesTable, "_db", second)
        assert ReadingBreaksTable.between(0.0, 1000.0) == []
        ReadingBreaksTable.record(30.0)
        assert ReadingBreaksTable.between(0.0, 1000.0) == [30.0]

        monkeypatch.setattr(GameLinesTable, "_db", first)
        assert ReadingBreaksTable.between(0.0, 1000.0) == [9.0, 20.0, 50.0, 100.0]
    finally:
        first.close()
        second.close()


@pytest.mark.parametrize("timestamp", [float("nan"), float("inf"), -float("inf")])
def test_invalid_pause_timestamps_are_not_saved(monkeypatch, timestamp):
    database = SQLiteDB(":memory:")
    monkeypatch.setattr(GameLinesTable, "_db", database)
    try:
        ReadingBreaksTable.record(timestamp)
        assert ReadingBreaksTable.between(0.0, 1000.0) == []
    finally:
        database.close()
