"""
Property-based tests for SQLiteDBTable.save() upsert semantics.

Property 8: save() Upsert for Non-Auto-Increment Tables
Property 9: save() Preserves Auto-Increment Behaviour

Validates: Requirements 9.1, 9.2
"""

from __future__ import annotations

import os
import tempfile

from hypothesis import given, settings
from hypothesis import strategies as st

from GameSentenceMiner.util.database.db import SQLiteDB, SQLiteDBTable


# ---------------------------------------------------------------------------
# Test model definitions — lightweight subclasses for property testing
# ---------------------------------------------------------------------------

class NonAutoIncrementModel(SQLiteDBTable):
    """Test model mimicking Anki tables: _auto_increment = False, text PK."""
    _table = "test_non_auto"
    _pk = "item_id"
    _auto_increment = False
    _fields = ["name", "value"]
    _types = [str, str, str]  # pk type, then field types


class AutoIncrementModel(SQLiteDBTable):
    """Test model with default auto-increment integer PK."""
    _table = "test_auto"
    _pk = "id"
    _auto_increment = True
    _fields = ["name", "value"]
    _types = [int, str, str]  # pk type, then field types


# ---------------------------------------------------------------------------
# DB helper — creates a fresh DB per test invocation
# ---------------------------------------------------------------------------

def _make_db():
    """Create a temporary SQLite DB and register both test models."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = SQLiteDB(path)
    NonAutoIncrementModel.set_db(db)
    AutoIncrementModel.set_db(db)
    return db, path


def _cleanup_db(db: SQLiteDB, path: str):
    db.close()
    try:
        os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------

_text_st = st.text(
    alphabet=st.characters(categories=("L", "N", "P", "S")),
    min_size=1,
    max_size=30,
)

_pk_st = st.text(
    alphabet=st.characters(categories=("L", "N")),
    min_size=1,
    max_size=20,
)


# ---------------------------------------------------------------------------
# Property 8: save() Upsert for Non-Auto-Increment Tables
# ---------------------------------------------------------------------------

@settings(max_examples=100)
@given(pk=_pk_st, name1=_text_st, val1=_text_st, name2=_text_st, val2=_text_st)
def test_save_upsert_non_auto_increment(pk, name1, val1, name2, val2):
    """
    **Validates: Requirements 9.1, 9.2**

    Property 8: save() Upsert for Non-Auto-Increment Tables

    For any SQLiteDBTable subclass with _auto_increment = False and a set
    primary key value, calling save() SHALL result in exactly one row in the
    database with that primary key and the correct field values, regardless
    of whether the row previously existed.
    """
    db, path = _make_db()
    try:
        # First save — should INSERT
        obj1 = NonAutoIncrementModel()
        obj1.item_id = pk
        obj1.name = name1
        obj1.value = val1
        obj1.save()

        row = db.fetchone(
            f"SELECT item_id, name, value FROM {NonAutoIncrementModel._table} WHERE item_id = ?",
            (pk,),
        )
        assert row is not None, "First save() should insert a row"
        assert row[0] == pk
        assert row[1] == name1
        assert row[2] == val1

        # Second save — should UPDATE (upsert) the same row
        obj2 = NonAutoIncrementModel()
        obj2.item_id = pk
        obj2.name = name2
        obj2.value = val2
        obj2.save()

        rows = db.fetchall(
            f"SELECT item_id, name, value FROM {NonAutoIncrementModel._table} WHERE item_id = ?",
            (pk,),
        )
        assert len(rows) == 1, "Upsert should not create duplicate rows"
        assert rows[0][0] == pk
        assert rows[0][1] == name2
        assert rows[0][2] == val2
    finally:
        _cleanup_db(db, path)


# ---------------------------------------------------------------------------
# Property 9: save() Preserves Auto-Increment Behaviour
# ---------------------------------------------------------------------------

@settings(max_examples=100)
@given(name1=_text_st, val1=_text_st, name2=_text_st, val2=_text_st)
def test_save_auto_increment_insert_then_update(name1, val1, name2, val2):
    """
    **Validates: Requirements 9.1, 9.2**

    Property 9: save() Preserves Auto-Increment Behaviour

    For any SQLiteDBTable subclass with _auto_increment = True, calling save()
    with pk = None SHALL insert a new row and set the pk attribute to the new
    lastrowid. Calling save() with a set pk SHALL update the existing row.
    """
    db, path = _make_db()
    try:
        # INSERT: pk is None → DB assigns auto-increment id
        obj = AutoIncrementModel()
        obj.id = None
        obj.name = name1
        obj.value = val1
        obj.save()

        assert obj.id is not None, "save() should set pk after insert"
        assert isinstance(obj.id, int), "Auto-increment pk should be an integer"
        assigned_id = obj.id

        row = db.fetchone(
            f"SELECT id, name, value FROM {AutoIncrementModel._table} WHERE id = ?",
            (assigned_id,),
        )
        assert row is not None, "Row should exist after insert"
        assert row[1] == name1
        assert row[2] == val1

        # UPDATE: pk is set → should update existing row
        obj.name = name2
        obj.value = val2
        obj.save()

        row = db.fetchone(
            f"SELECT id, name, value FROM {AutoIncrementModel._table} WHERE id = ?",
            (assigned_id,),
        )
        assert row is not None, "Row should still exist after update"
        assert row[0] == assigned_id, "pk should not change on update"
        assert row[1] == name2
        assert row[2] == val2

        # Verify only one row exists
        count = db.fetchone(
            f"SELECT COUNT(*) FROM {AutoIncrementModel._table}",
        )
        assert count[0] == 1, "Update should not create a new row"
    finally:
        _cleanup_db(db, path)
