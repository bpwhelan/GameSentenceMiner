"""
Unit tests for SQLiteDBTable.save() edge cases.

Tests:
- First-insert of AnkiNotesTable with a set note_id
- Update of existing row preserves data
- Auto-increment table still works with pk=None

Validates: Requirements 9.1, 9.2, 12.3
"""

from __future__ import annotations

import os
import tempfile

import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, SQLiteDBTable
from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable


# ---------------------------------------------------------------------------
# Auto-increment test model (reused from PBT file pattern)
# ---------------------------------------------------------------------------

class _AutoModel(SQLiteDBTable):
    _table = "test_auto_unit"
    _pk = "id"
    _auto_increment = True
    _fields = ["name", "value"]
    _types = [int, str, str]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def db():
    """Yield a temporary SQLite DB with AnkiNotesTable and _AutoModel registered."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    _db = SQLiteDB(path)
    AnkiNotesTable.set_db(_db)
    _AutoModel.set_db(_db)
    yield _db
    _db.close()
    try:
        os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Test: first-insert of AnkiNotesTable with a set note_id
# ---------------------------------------------------------------------------

def test_anki_notes_first_insert_with_set_note_id(db):
    """save() on AnkiNotesTable with a pre-set note_id should INSERT the row."""
    note = AnkiNotesTable(
        note_id=123456789,
        model_name="Basic",
        fields_json='{"Front": "hello", "Back": "world"}',
        tags="[\"vocab\"]",
        mod=1700000000,
        synced_at=1700000001.0,
    )
    note.save()

    # Verify via the ORM get() which handles type conversion
    fetched = AnkiNotesTable.get(123456789)
    assert fetched is not None, "First save() with set note_id should insert a row"
    assert fetched.note_id == 123456789
    assert fetched.model_name == "Basic"
    assert fetched.fields_json == '{"Front": "hello", "Back": "world"}'
    assert fetched.tags == '["vocab"]'


# ---------------------------------------------------------------------------
# Test: update of existing row preserves data
# ---------------------------------------------------------------------------

def test_anki_notes_update_preserves_and_changes_data(db):
    """Second save() with the same note_id should update the row, not duplicate it."""
    # Insert
    note = AnkiNotesTable(
        note_id=999,
        model_name="Basic",
        fields_json='{"Front": "a"}',
        tags="[]",
        mod=1,
        synced_at=100.0,
    )
    note.save()

    # Update with new values
    updated = AnkiNotesTable(
        note_id=999,
        model_name="Cloze",
        fields_json='{"Text": "b"}',
        tags='["updated"]',
        mod=2,
        synced_at=200.0,
    )
    updated.save()

    rows = db.fetchall("SELECT * FROM anki_notes WHERE note_id = ?", (999,))
    assert len(rows) == 1, "Upsert should not create a duplicate row"

    fetched = AnkiNotesTable.get(999)
    assert fetched.model_name == "Cloze"
    assert fetched.fields_json == '{"Text": "b"}'
    assert fetched.mod == 2


# ---------------------------------------------------------------------------
# Test: auto-increment table still works with pk=None
# ---------------------------------------------------------------------------

def test_auto_increment_insert_with_pk_none(db):
    """save() on an auto-increment model with pk=None should assign a new integer pk."""
    obj = _AutoModel()
    obj.id = None
    obj.name = "test"
    obj.value = "data"
    obj.save()

    assert obj.id is not None, "save() should assign pk after insert"
    assert isinstance(obj.id, int)

    row = db.fetchone(
        f"SELECT id, name, value FROM {_AutoModel._table} WHERE id = ?",
        (obj.id,),
    )
    assert row is not None
    assert row[1] == "test"
    assert row[2] == "data"
