"""
Unit tests for stats-refactor lazy-load endpoint error fallbacks.

Validates: Requirements 7.4, 8.4
"""

from __future__ import annotations

import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


# ---------------------------------------------------------------------------
# Fixtures (same pattern as test_stats_refactor_pbt.py)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _in_memory_db():
    """Swap all table backends to a shared in-memory SQLite DB."""
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_stats


@pytest.fixture()
def app(_in_memory_db):
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True
    from GameSentenceMiner.web.stats_api import register_stats_api_routes

    register_stats_api_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


# ---------------------------------------------------------------------------
# Unit tests: endpoint error fallbacks
# ---------------------------------------------------------------------------


class TestKanjiGridErrorFallback:
    """Validates: Requirement 7.4 — kanji-grid returns empty fallback on error."""

    def test_returns_empty_fallback_when_build_combined_stats_raises(self, client, monkeypatch):
        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_api._build_combined_stats",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        resp = client.get("/api/stats/kanji-grid")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data == {"kanji_data": [], "unique_count": 0, "max_frequency": 0}

    def test_returns_empty_fallback_when_build_kanji_grid_data_raises(self, client, monkeypatch):
        # Let _build_combined_stats succeed but make _build_kanji_grid_data raise
        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_api._build_kanji_grid_data",
            lambda *a, **kw: (_ for _ in ()).throw(ValueError("bad kanji")),
        )
        # Also patch heavy deps so _build_combined_stats doesn't fail for unrelated reasons
        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_service.get_third_party_stats_by_date",
            lambda start, end: {},
        )
        resp = client.get("/api/stats/kanji-grid")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data == {"kanji_data": [], "unique_count": 0, "max_frequency": 0}


class TestGameMilestonesErrorFallback:
    """Validates: Requirement 8.4 — game-milestones returns null on error."""

    def test_returns_null_when_calculate_game_milestones_raises(self, client, monkeypatch):
        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_api.calculate_game_milestones",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("milestone error")),
        )
        resp = client.get("/api/stats/game-milestones")
        assert resp.status_code == 200
        assert resp.get_json() is None


class TestAllLinesDataErrorFallback:
    """Validates: Requirement 7.4 (error fallback) — all-lines-data returns [] on error."""

    def test_returns_empty_array_when_build_combined_stats_raises(self, client, monkeypatch):
        monkeypatch.setattr(
            "GameSentenceMiner.web.stats_api._build_combined_stats",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("db down")),
        )
        resp = client.get("/api/stats/all-lines-data")
        assert resp.status_code == 200
        assert resp.get_json() == []
