"""
Tests for the tokenized search path in /api/search-sentences.

Covers:
- Tokenized search returns correct lines for a known word (Req 3.1)
- Game filter narrows results correctly (Req 3.2)
- Date range filter works (Req 3.2)
- Non-existent word returns empty results (Req 3.3)
- Fallback when tokenization tables don't exist (Req 3.4)
"""

from __future__ import annotations

import time
import uuid
from unittest.mock import patch

import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.tokenization_tables import (
    WordsTable,
    WordOccurrencesTable,
    KanjiTable,
    KanjiOccurrencesTable,
    create_tokenization_indexes,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _in_memory_db():
    """Set up an in-memory DB shared by GameLinesTable and tokenization tables."""
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)

    # Add tokenized column to game_lines BEFORE creating indexes (index references it)
    try:
        db.execute(
            "ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0",
            commit=True,
        )
    except Exception:
        pass

    # Set up tokenization tables on the same in-memory DB
    for cls in [WordsTable, KanjiTable, WordOccurrencesTable, KanjiOccurrencesTable]:
        cls.set_db(db)

    create_tokenization_indexes(db)

    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines


@pytest.fixture()
def app(_in_memory_db):
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True

    with patch("GameSentenceMiner.web.database_api.cron_scheduler"):
        from GameSentenceMiner.web.database_api import register_database_api_routes

        register_database_api_routes(test_app)

    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_line(
    game_name: str = "Test Game",
    text: str = "テスト文",
    timestamp: float | None = None,
    game_id: str = "",
) -> GameLinesTable:
    line = GameLinesTable(
        id=str(uuid.uuid4()),
        game_name=game_name,
        game_id=game_id,
        line_text=text,
        timestamp=timestamp or time.time(),
    )
    line.add()
    return line


def _insert_word(word: str, reading: str = "", pos: str = "名詞") -> int:
    return WordsTable.get_or_create(word, reading, pos)


def _link_word_to_line(word_id: int, line_id: str):
    WordOccurrencesTable.insert_occurrence(word_id, line_id)


# ===================================================================
# Tokenized search tests
# ===================================================================


class TestTokenizedSearchBasic:
    """Test tokenized search returns correct lines for a known word. (Req 3.1)"""

    def test_tokenized_search_returns_matching_lines(self, client):
        line1 = _create_line(text="本を読む", timestamp=1000.0)
        line2 = _create_line(text="本を買う", timestamp=2000.0)
        _create_line(text="映画を見る", timestamp=3000.0)  # not linked to 本

        word_id = _insert_word("本", "ホン")
        _link_word_to_line(word_id, line1.id)
        _link_word_to_line(word_id, line2.id)

        resp = client.get("/api/search-sentences?q=本&use_tokenized=true")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["total"] == 2
        assert len(data["results"]) == 2
        returned_ids = {r["id"] for r in data["results"]}
        assert returned_ids == {line1.id, line2.id}

    def test_tokenized_search_does_not_return_unlinked_lines(self, client):
        """Lines containing the word as substring but not linked via occurrences are excluded."""
        line1 = _create_line(text="本を読む", timestamp=1000.0)
        # line2 contains 本 as substring but is NOT linked via word_occurrences
        _create_line(text="本当に面白い", timestamp=2000.0)

        word_id = _insert_word("本", "ホン")
        _link_word_to_line(word_id, line1.id)

        resp = client.get("/api/search-sentences?q=本&use_tokenized=true")
        data = resp.get_json()
        assert data["total"] == 1
        assert data["results"][0]["id"] == line1.id

    def test_tokenized_search_response_format(self, client):
        """Verify the response includes all expected metadata fields."""
        line = _create_line(text="食べる", timestamp=1500.0, game_name="RPG Game")
        word_id = _insert_word("食べる", "タベル", "動詞")
        _link_word_to_line(word_id, line.id)

        resp = client.get("/api/search-sentences?q=食べる&use_tokenized=true")
        data = resp.get_json()
        assert data["total"] == 1
        result = data["results"][0]
        assert result["id"] == line.id
        assert result["sentence"] == "食べる"
        assert result["game_name"] == "RPG Game"
        assert result["timestamp"] == 1500.0
        assert "translation" in result
        assert "has_audio" in result
        assert "has_screenshot" in result
        # Pagination fields
        assert data["page"] == 1
        assert data["page_size"] == 20
        assert data["total_pages"] == 1


class TestTokenizedSearchGameFilter:
    """Test game filter narrows results correctly. (Req 3.2)"""

    def test_game_filter_narrows_results(self, client):
        line1 = _create_line(text="本を読む", game_name="Game A", timestamp=1000.0)
        line2 = _create_line(text="本を買う", game_name="Game B", timestamp=2000.0)

        word_id = _insert_word("本", "ホン")
        _link_word_to_line(word_id, line1.id)
        _link_word_to_line(word_id, line2.id)

        resp = client.get("/api/search-sentences?q=本&use_tokenized=true&game=Game A")
        data = resp.get_json()
        assert data["total"] == 1
        assert data["results"][0]["game_name"] == "Game A"

    def test_game_filter_no_match(self, client):
        line = _create_line(text="本を読む", game_name="Game A", timestamp=1000.0)
        word_id = _insert_word("本", "ホン")
        _link_word_to_line(word_id, line.id)

        resp = client.get("/api/search-sentences?q=本&use_tokenized=true&game=Nonexistent")
        data = resp.get_json()
        assert data["total"] == 0
        assert data["results"] == []


class TestTokenizedSearchDateRange:
    """Test date range filter works. (Req 3.2)"""

    def test_date_filters_do_not_attach_utc_timezone(self, client, monkeypatch):
        class _FakeParsedDate:
            def replace(self, **kwargs):
                if kwargs.get("tzinfo") is not None:
                    raise AssertionError("date filters should keep local-time semantics")
                return self

            def timestamp(self):
                return 0.0

        class _FakeDateTime:
            @classmethod
            def strptime(cls, _value, _fmt):
                return _FakeParsedDate()

        monkeypatch.setattr(
            "GameSentenceMiner.web.database_api.datetime.datetime",
            _FakeDateTime,
        )

        resp = client.get(
            "/api/search-sentences?q=存在しない単語&use_tokenized=true&from_date=2024-06-01&to_date=2024-06-30"
        )

        assert resp.status_code == 200

    def test_date_range_filters_results(self, client):
        import datetime as _dt

        # Use local-time noon timestamps so they land clearly within or outside the filter range
        # regardless of the machine's UTC offset.
        def _local_noon(date_str: str) -> float:
            return _dt.datetime.strptime(date_str, "%Y-%m-%d").replace(hour=12).timestamp()

        line_early = _create_line(text="早い文", timestamp=_local_noon("2024-06-01"))
        line_mid = _create_line(text="中間の文", timestamp=_local_noon("2024-06-15"))
        line_late = _create_line(text="遅い文", timestamp=_local_noon("2024-07-01"))

        word_id = _insert_word("文")
        _link_word_to_line(word_id, line_early.id)
        _link_word_to_line(word_id, line_mid.id)
        _link_word_to_line(word_id, line_late.id)

        # Filter to June only
        resp = client.get("/api/search-sentences?q=文&use_tokenized=true&from_date=2024-06-01&to_date=2024-06-30")
        data = resp.get_json()
        assert data["total"] == 2
        returned_ids = {r["id"] for r in data["results"]}
        assert line_early.id in returned_ids
        assert line_mid.id in returned_ids
        assert line_late.id not in returned_ids

    def test_from_date_only(self, client):
        line_old = _create_line(text="古い文", timestamp=1717200000.0)
        line_new = _create_line(text="新しい文", timestamp=1719792000.0)

        word_id = _insert_word("文")
        _link_word_to_line(word_id, line_old.id)
        _link_word_to_line(word_id, line_new.id)

        resp = client.get("/api/search-sentences?q=文&use_tokenized=true&from_date=2024-06-30")
        data = resp.get_json()
        assert data["total"] == 1
        assert data["results"][0]["id"] == line_new.id


class TestTokenizedSearchNonExistentWord:
    """Test non-existent word returns empty results. (Req 3.3)"""

    def test_word_not_in_words_table(self, client):
        _create_line(text="テスト文", timestamp=1000.0)

        resp = client.get("/api/search-sentences?q=存在しない単語&use_tokenized=true")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["results"] == []
        assert data["total"] == 0
        assert data["page"] == 1
        assert data["total_pages"] == 0


class TestTokenizedSearchFallback:
    """Test fallback when tokenization tables don't exist. (Req 3.4)"""

    def test_fallback_to_like_search(self, client, _in_memory_db):
        """When tokenization tables are dropped, the API falls back to LIKE search."""
        _create_line(text="本を読む", timestamp=1000.0)

        # Drop the tokenization tables to simulate them not existing
        _in_memory_db.execute("DROP TABLE IF EXISTS word_occurrences", commit=True)
        _in_memory_db.execute("DROP TABLE IF EXISTS words", commit=True)

        # Reset column order cache so from_row doesn't get confused
        WordsTable._column_order_cache = None
        WordOccurrencesTable._column_order_cache = None

        resp = client.get("/api/search-sentences?q=本&use_tokenized=true")
        assert resp.status_code == 200
        data = resp.get_json()
        # Should fall back to LIKE search and find the line containing 本
        assert data["total"] >= 1
        assert any("本" in r["sentence"] for r in data["results"])
