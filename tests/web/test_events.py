"""
Unit tests for GameSentenceMiner/web/events.py — EventManager.

These are pure unit tests with no Flask or database dependency.
"""

import datetime
from types import SimpleNamespace

import pytest

from GameSentenceMiner.web.events import EventItem, EventManager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_gameline(line_id="line-1", text="テスト", time=None):
    """Create a minimal GameLine-compatible object."""
    return SimpleNamespace(
        id=line_id,
        text=text,
        time=time or datetime.datetime(2024, 6, 15, 12, 0, 0),
    )


# ---------------------------------------------------------------------------
# EventItem
# ---------------------------------------------------------------------------


class TestEventItem:
    def test_to_dict(self):
        line = _make_gameline()
        event = EventItem(
            line=line,
            id="e1",
            text="hello",
            time=datetime.datetime(2024, 1, 1, 10, 0, 0),
        )
        d = event.to_dict()
        assert d["id"] == "e1"
        assert d["text"] == "hello"
        assert d["checked"] is False
        assert d["history"] is False

    def test_to_serializable_iso_format(self):
        line = _make_gameline()
        dt = datetime.datetime(2024, 6, 15, 12, 30, 0)
        event = EventItem(line=line, id="e2", text="world", time=dt)
        s = event.to_serializable()
        assert s["time"] == dt.isoformat()


# ---------------------------------------------------------------------------
# EventManager — basic operations
# ---------------------------------------------------------------------------


class TestEventManagerBasic:
    def test_starts_empty(self):
        em = EventManager()
        assert em.get_events() == []
        assert em.get_ordered_ids() == []

    def test_add_gameline(self):
        em = EventManager()
        line = _make_gameline("id-1", "テスト文")
        event = em.add_gameline(line)
        assert event.id == "id-1"
        assert event.text == "テスト文"
        assert len(em.get_events()) == 1

    def test_get_by_id(self):
        em = EventManager()
        line = _make_gameline("id-A")
        em.add_gameline(line)
        assert em.get("id-A") is not None
        assert em.get("nonexistent") is None

    def test_get_ordered_ids(self):
        em = EventManager()
        em.add_gameline(_make_gameline("a"))
        em.add_gameline(_make_gameline("b"))
        em.add_gameline(_make_gameline("c"))
        assert em.get_ordered_ids() == ["a", "b", "c"]

    def test_iteration(self):
        em = EventManager()
        em.add_gameline(_make_gameline("x"))
        em.add_gameline(_make_gameline("y"))
        ids = [e.id for e in em]
        assert ids == ["x", "y"]

    def test_add_event_directly(self):
        em = EventManager()
        line = _make_gameline("direct")
        event = EventItem(line=line, id="direct", text="直接", time=datetime.datetime.now())
        em.add_event(event)
        assert em.get("direct") is not None


# ---------------------------------------------------------------------------
# EventManager — remove and clear
# ---------------------------------------------------------------------------


class TestEventManagerRemoveAndClear:
    def test_remove_lines_by_ids(self):
        em = EventManager()
        em.add_gameline(_make_gameline("keep"))
        em.add_gameline(_make_gameline("remove"))
        em.remove_lines_by_ids(["remove"])
        assert len(em.get_events()) == 1
        assert em.get("keep") is not None
        assert em.get("remove") is None

    def test_remove_with_timed_out_flag(self):
        em = EventManager()
        em.add_gameline(_make_gameline("timeout-1"))
        em.remove_lines_by_ids(["timeout-1"], timed_out=True)
        assert "timeout-1" in em.timed_out_ids

    def test_remove_nonexistent_id_is_safe(self):
        em = EventManager()
        em.add_gameline(_make_gameline("existing"))
        em.remove_lines_by_ids(["nonexistent"])  # should not raise
        assert len(em.get_events()) == 1

    def test_clear_history_removes_history_events(self):
        em = EventManager()
        line1 = _make_gameline("current")
        line2 = _make_gameline("old")
        e1 = em.add_gameline(line1)
        e2 = em.add_gameline(line2)
        e2.history = True
        em.clear_history()
        assert len(em.get_events()) == 1
        assert em.get("current") is not None
        assert em.get("old") is None


# ---------------------------------------------------------------------------
# EventManager — reset and replace
# ---------------------------------------------------------------------------


class TestEventManagerResetReplace:
    def test_reset_checked_lines(self):
        em = EventManager()
        e = em.add_gameline(_make_gameline("check-me"))
        e.checked = True
        em.reset_checked_lines()
        assert e.checked is False

    def test_replace_events(self):
        em = EventManager()
        em.add_gameline(_make_gameline("old"))
        line = _make_gameline("new")
        new_event = EventItem(line=line, id="new", text="新", time=datetime.datetime.now())
        em.replace_events([new_event])
        assert len(em.get_events()) == 1
        assert em.get("new") is not None
        assert em.get("old") is None