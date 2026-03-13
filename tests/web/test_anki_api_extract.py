"""
Unit tests for the extracted standalone _fetch_* functions in anki_api_endpoints.py.

Verifies that the core logic was correctly extracted from nested route handlers
into module-level functions, and that the route handlers delegate to them.

Requirements: 3.1, 3.2
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import flask
import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _stub_heavy_modules(monkeypatch):
    """Prevent heavy imports (torch, Qt, etc.) from loading."""
    # Stub anki_tables so _is_cache_empty / _get_anki_data don't need real DB
    fake_anki_tables = types.ModuleType("GameSentenceMiner.util.database.anki_tables")
    fake_anki_tables.AnkiNotesTable = MagicMock()
    fake_anki_tables.AnkiCardsTable = MagicMock()
    fake_anki_tables.AnkiReviewsTable = MagicMock()
    monkeypatch.setitem(
        __import__("sys").modules,
        "GameSentenceMiner.util.database.anki_tables",
        fake_anki_tables,
    )


@pytest.fixture()
def anki_mod():
    """Import the module under test."""
    import GameSentenceMiner.web.anki_api_endpoints as mod

    return mod


# ---------------------------------------------------------------------------
# Tests: Functions exist at module level
# ---------------------------------------------------------------------------


class TestFunctionsExist:
    """Verify all 5 _fetch_* functions are module-level callables."""

    def test_fetch_earliest_date_exists(self, anki_mod):
        assert callable(getattr(anki_mod, "_fetch_earliest_date", None))

    def test_fetch_kanji_stats_exists(self, anki_mod):
        assert callable(getattr(anki_mod, "_fetch_kanji_stats", None))

    def test_fetch_game_stats_exists(self, anki_mod):
        assert callable(getattr(anki_mod, "_fetch_game_stats", None))

    def test_fetch_nsfw_sfw_retention_exists(self, anki_mod):
        assert callable(getattr(anki_mod, "_fetch_nsfw_sfw_retention", None))

    def test_fetch_anki_mining_heatmap_exists(self, anki_mod):
        assert callable(getattr(anki_mod, "_fetch_anki_mining_heatmap", None))


# ---------------------------------------------------------------------------
# Tests: Functions accept (start_timestamp, end_timestamp) signature
# ---------------------------------------------------------------------------


class TestFunctionSignatures:
    """Each _fetch_* function must accept start_timestamp and end_timestamp."""

    def test_earliest_date_signature(self, anki_mod):
        import inspect

        sig = inspect.signature(anki_mod._fetch_earliest_date)
        params = list(sig.parameters.keys())
        assert "start_timestamp" in params
        assert "end_timestamp" in params

    def test_kanji_stats_signature(self, anki_mod):
        import inspect

        sig = inspect.signature(anki_mod._fetch_kanji_stats)
        params = list(sig.parameters.keys())
        assert "start_timestamp" in params
        assert "end_timestamp" in params

    def test_game_stats_signature(self, anki_mod):
        import inspect

        sig = inspect.signature(anki_mod._fetch_game_stats)
        params = list(sig.parameters.keys())
        assert "start_timestamp" in params
        assert "end_timestamp" in params

    def test_nsfw_sfw_retention_signature(self, anki_mod):
        import inspect

        sig = inspect.signature(anki_mod._fetch_nsfw_sfw_retention)
        params = list(sig.parameters.keys())
        assert "start_timestamp" in params
        assert "end_timestamp" in params

    def test_mining_heatmap_signature(self, anki_mod):
        import inspect

        sig = inspect.signature(anki_mod._fetch_anki_mining_heatmap)
        params = list(sig.parameters.keys())
        assert "start_timestamp" in params
        assert "end_timestamp" in params


# ---------------------------------------------------------------------------
# Tests: Functions return dicts (or lists for game_stats)
# ---------------------------------------------------------------------------


class TestReturnTypes:
    """Verify return types when cache is empty (simplest path)."""

    def test_earliest_date_returns_dict_when_cache_empty(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: True)
        result = anki_mod._fetch_earliest_date(None, None)
        assert isinstance(result, dict)
        assert "earliest_date" in result

    def test_game_stats_returns_list_when_cache_empty(self, anki_mod, monkeypatch):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: True)
        result = anki_mod._fetch_game_stats(None, None)
        assert isinstance(result, list)
        assert result == []

    def test_nsfw_sfw_retention_returns_dict_when_cache_empty(
        self, anki_mod, monkeypatch
    ):
        monkeypatch.setattr(anki_mod, "_is_cache_empty", lambda: True)
        result = anki_mod._fetch_nsfw_sfw_retention(None, None)
        assert isinstance(result, dict)
        assert "nsfw_retention" in result
        assert "sfw_retention" in result

    def test_mining_heatmap_returns_dict(self, anki_mod, monkeypatch):
        monkeypatch.setattr(
            anki_mod,
            "GameLinesTable",
            MagicMock(all=MagicMock(return_value=[])),
        )
        monkeypatch.setattr(
            anki_mod,
            "calculate_mining_heatmap_data",
            lambda lines: {},
        )
        result = anki_mod._fetch_anki_mining_heatmap(None, None)
        assert isinstance(result, dict)


# ---------------------------------------------------------------------------
# Tests: Route handlers delegate to standalone functions
# ---------------------------------------------------------------------------


class TestRouteHandlersDelegation:
    """Verify route handlers call the extracted standalone functions."""

    @pytest.fixture()
    def app_and_client(self, anki_mod):
        test_app = flask.Flask(__name__)
        test_app.config["TESTING"] = True
        anki_mod.register_anki_api_endpoints(test_app)
        return test_app, test_app.test_client()

    def test_earliest_date_route_delegates(self, app_and_client, monkeypatch, anki_mod):
        app, client = app_and_client
        sentinel = {"earliest_date": 42}
        monkeypatch.setattr(anki_mod, "_fetch_earliest_date", lambda s, e: sentinel)
        with app.test_request_context():
            resp = client.get("/api/anki_earliest_date")
        assert resp.status_code == 200
        assert resp.get_json()["earliest_date"] == 42

    def test_game_stats_route_delegates(self, app_and_client, monkeypatch, anki_mod):
        app, client = app_and_client
        sentinel = [{"game_name": "TestGame", "card_count": 10}]
        monkeypatch.setattr(anki_mod, "_fetch_game_stats", lambda s, e: sentinel)
        with app.test_request_context():
            resp = client.get("/api/anki_game_stats")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data[0]["game_name"] == "TestGame"

    def test_nsfw_sfw_route_delegates(self, app_and_client, monkeypatch, anki_mod):
        app, client = app_and_client
        sentinel = {
            "nsfw_retention": 85.0,
            "sfw_retention": 90.0,
            "nsfw_reviews": 100,
            "sfw_reviews": 200,
            "nsfw_avg_time": 5.0,
            "sfw_avg_time": 4.0,
        }
        monkeypatch.setattr(
            anki_mod, "_fetch_nsfw_sfw_retention", lambda s, e: sentinel
        )
        with app.test_request_context():
            resp = client.get("/api/anki_nsfw_sfw_retention")
        assert resp.status_code == 200
        assert resp.get_json()["nsfw_retention"] == 85.0

    def test_mining_heatmap_route_delegates(
        self, app_and_client, monkeypatch, anki_mod
    ):
        app, client = app_and_client
        sentinel = {"2024": {"2024-01-15": 3}}
        monkeypatch.setattr(
            anki_mod, "_fetch_anki_mining_heatmap", lambda s, e: sentinel
        )
        with app.test_request_context():
            resp = client.get("/api/anki_mining_heatmap")
        assert resp.status_code == 200
        assert resp.get_json() == sentinel

    def test_kanji_stats_route_delegates(self, app_and_client, monkeypatch, anki_mod):
        app, client = app_and_client
        sentinel = {
            "missing_kanji": [],
            "anki_kanji_count": 5,
            "gsm_kanji_count": 10,
            "coverage_percent": 50.0,
        }
        monkeypatch.setattr(anki_mod, "_fetch_kanji_stats", lambda s, e: sentinel)
        with app.test_request_context():
            resp = client.get("/api/anki_kanji_stats")
        assert resp.status_code == 200
        assert resp.get_json()["coverage_percent"] == 50.0

    def test_sync_status_route_includes_auto_sync_metadata(
        self,
        app_and_client,
        monkeypatch,
    ):
        app, client = app_and_client

        class _FakeDb:
            def __init__(self, row):
                self._row = row

            def fetchone(self, _query):
                return self._row

        fake_anki_tables = types.ModuleType(
            "GameSentenceMiner.util.database.anki_tables"
        )
        fake_anki_tables.AnkiNotesTable = types.SimpleNamespace(
            _db=_FakeDb((12, 1700000000.0)),
            _table="anki_notes",
        )
        fake_anki_tables.AnkiCardsTable = types.SimpleNamespace(
            _db=_FakeDb((34,)),
            _table="anki_cards",
        )
        monkeypatch.setitem(
            sys.modules,
            "GameSentenceMiner.util.database.anki_tables",
            fake_anki_tables,
        )

        fake_cron_table = types.ModuleType("GameSentenceMiner.util.database.cron_table")

        class _FakeCronEntry:
            enabled = True
            schedule = "daily"
            next_run = 1700003600.0

        class _FakeCronTable:
            @staticmethod
            def get_by_name(name):
                assert name == "anki_card_sync"
                return _FakeCronEntry()

        fake_cron_table.CronTable = _FakeCronTable
        monkeypatch.setitem(
            sys.modules,
            "GameSentenceMiner.util.database.cron_table",
            fake_cron_table,
        )

        with app.test_request_context():
            resp = client.get("/api/anki_sync_status")

        assert resp.status_code == 200
        payload = resp.get_json()
        assert payload["cache_populated"] is True
        assert payload["note_count"] == 12
        assert payload["card_count"] == 34
        assert payload["auto_sync_enabled"] is True
        assert payload["auto_sync_schedule"] == "daily"
        assert payload["next_auto_sync"] is not None

    def test_sync_now_route_queues_anki_card_sync(self, app_and_client, monkeypatch):
        app, client = app_and_client
        called = {"count": 0}

        fake_cron = types.ModuleType("GameSentenceMiner.util.cron")

        class _FakeCronScheduler:
            def force_anki_card_sync(self):
                called["count"] += 1

        fake_cron.cron_scheduler = _FakeCronScheduler()
        monkeypatch.setitem(sys.modules, "GameSentenceMiner.util.cron", fake_cron)

        with app.test_request_context():
            resp = client.post("/api/anki_sync_now")

        assert resp.status_code == 202
        payload = resp.get_json()
        assert payload["status"] == "queued"
        assert called["count"] == 1

    def test_sync_now_route_returns_error_when_queue_fails(
        self,
        app_and_client,
        monkeypatch,
    ):
        app, client = app_and_client

        fake_cron = types.ModuleType("GameSentenceMiner.util.cron")

        class _BrokenCronScheduler:
            def force_anki_card_sync(self):
                raise RuntimeError("boom")

        fake_cron.cron_scheduler = _BrokenCronScheduler()
        monkeypatch.setitem(sys.modules, "GameSentenceMiner.util.cron", fake_cron)

        with app.test_request_context():
            resp = client.post("/api/anki_sync_now")

        assert resp.status_code == 500
        assert resp.get_json()["status"] == "error"
