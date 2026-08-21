from __future__ import annotations

import json

import pytest
from flask import Flask

from GameSentenceMiner.util.database.db import SQLiteDB
from GameSentenceMiner.web import hoshidicts_api


def _stat(term, reading="", *, count=1, first=100.0, last=200.0):
    return {
        "term": term,
        "reading": reading,
        "lookup_count": count,
        "first_looked_up_at": first,
        "last_looked_up_at": last,
    }


def _patch_record(monkeypatch, *, recorded=None, **stat_overrides):
    def record_lookup(term, reading):
        if recorded is not None:
            recorded.append((term, reading))
        return _stat(term, reading, **stat_overrides)

    monkeypatch.setattr(hoshidicts_api.TermLookupStatsTable, "record_lookup", record_lookup)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(
        hoshidicts_api.TermLookupStatsTable,
        "get_seen_count",
        lambda _term: None,
        raising=False,
    )
    app = Flask(__name__)
    hoshidicts_api.register_hoshidicts_api_routes(app)
    return app.test_client()


def test_post_lookup_stats_normalizes_and_returns_current_count(client, monkeypatch):
    recorded = []
    _patch_record(monkeypatch, recorded=recorded, count=3)

    response = client.post(
        "/api/hoshidicts/lookup-stats",
        json={"term": "  は\u3099  ", "reading": "  は\u3099  "},
    )

    assert response.status_code == 200
    assert recorded == [("ば", "ば")]
    assert response.get_json() == {
        "success": True,
        "term": "ば",
        "reading": "ば",
        "lookupCount": 3,
        "firstLookedUpAt": 100.0,
        "lastLookedUpAt": 200.0,
        "seenCount": None,
    }


def test_post_lookup_stats_allows_an_omitted_reading(client, monkeypatch):
    recorded = []
    _patch_record(monkeypatch, recorded=recorded)

    response = client.post("/api/hoshidicts/lookup-stats", json={"term": "猫"})

    assert response.status_code == 200
    assert recorded == [("猫", "")]


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"term": ""},
        {"term": "   "},
        {"term": 123},
        {"term": "猫", "reading": 123},
        {"term": "猫" * 257},
        {"term": "猫", "reading": "ね" * 257},
    ],
)
def test_post_lookup_stats_rejects_invalid_payloads(client, payload):
    response = client.post("/api/hoshidicts/lookup-stats", json=payload)

    assert response.status_code == 400
    assert response.get_json()["success"] is False


def test_post_lookup_stats_rejects_oversized_body(client):
    response = client.post(
        "/api/hoshidicts/lookup-stats",
        data=json.dumps({"term": "猫", "padding": "x" * 5000}),
        content_type="application/json",
    )

    assert response.status_code == 413
    assert response.get_json()["success"] is False


def test_post_lookup_stats_returns_generic_unavailable_error(client, monkeypatch):
    def fail(_term, _reading):
        raise RuntimeError("secret database path")

    monkeypatch.setattr(hoshidicts_api.TermLookupStatsTable, "record_lookup", fail)

    response = client.post("/api/hoshidicts/lookup-stats", json={"term": "猫"})

    assert response.status_code == 503
    assert response.get_json() == {
        "success": False,
        "error": "Lookup statistics are unavailable.",
    }
    assert "secret" not in response.get_data(as_text=True)


def test_post_lookup_stats_returns_seen_count(client, monkeypatch):
    _patch_record(monkeypatch, count=2)
    monkeypatch.setattr(
        hoshidicts_api.TermLookupStatsTable,
        "get_seen_count",
        lambda term: 34 if term == "食べる" else 0,
    )

    response = client.post(
        "/api/hoshidicts/lookup-stats",
        json={"term": "食べる", "reading": "たべる"},
    )

    assert response.status_code == 200
    assert response.get_json()["seenCount"] == 34


def test_post_lookup_stats_keeps_recording_success_when_seen_count_is_unavailable(client, monkeypatch):
    _patch_record(monkeypatch)

    def fail_seen_count(_term):
        raise RuntimeError("tokenization cache unavailable")

    monkeypatch.setattr(
        hoshidicts_api.TermLookupStatsTable,
        "get_seen_count",
        fail_seen_count,
    )

    response = client.post(
        "/api/hoshidicts/lookup-stats",
        json={"term": "食べる", "reading": "たべる"},
    )

    assert response.status_code == 200
    assert response.get_json()["lookupCount"] == 1
    assert response.get_json()["seenCount"] is None


def test_get_lookup_stats_returns_paginated_camel_case_results(client, monkeypatch):
    calls = []

    def get_stats(limit, offset):
        calls.append((limit, offset))
        return {
            "total_lookups": 7,
            "unique_terms": 2,
            "items": [_stat("食べる", "たべる", count=5)],
        }

    monkeypatch.setattr(hoshidicts_api.TermLookupStatsTable, "get_stats", get_stats)

    response = client.get("/api/hoshidicts/lookup-stats?limit=10&offset=2")

    assert response.status_code == 200
    assert calls == [(10, 2)]
    assert response.get_json() == {
        "totalLookups": 7,
        "uniqueTerms": 2,
        "limit": 10,
        "offset": 2,
        "items": [
            {
                "term": "食べる",
                "reading": "たべる",
                "lookupCount": 5,
                "firstLookedUpAt": 100.0,
                "lastLookedUpAt": 200.0,
            }
        ],
    }

    calls.clear()
    default_response = client.get("/api/hoshidicts/lookup-stats")

    assert default_response.status_code == 200
    assert calls == [(100, 0)]


@pytest.mark.parametrize(
    "query",
    [
        "limit=0",
        "limit=501",
        "limit=1.5",
        "limit=no",
        "offset=-1",
        "offset=no",
    ],
)
def test_get_lookup_stats_rejects_invalid_pagination(client, query):
    response = client.get(f"/api/hoshidicts/lookup-stats?{query}")

    assert response.status_code == 400
    assert response.get_json()["success"] is False


def test_get_lookup_stats_returns_generic_unavailable_error(client, monkeypatch):
    def fail(_limit, _offset):
        raise RuntimeError("secret database path")

    monkeypatch.setattr(hoshidicts_api.TermLookupStatsTable, "get_stats", fail)

    response = client.get("/api/hoshidicts/lookup-stats")

    assert response.status_code == 503
    assert response.get_json() == {
        "success": False,
        "error": "Lookup statistics are unavailable.",
    }
    assert "secret" not in response.get_data(as_text=True)


def test_lookup_stats_api_persists_and_reads_aggregates(client):
    database = SQLiteDB(":memory:")
    previous = hoshidicts_api.TermLookupStatsTable._db
    hoshidicts_api.TermLookupStatsTable.set_db(database)
    try:
        first = client.post(
            "/api/hoshidicts/lookup-stats",
            json={"term": "食べる", "reading": "たべる"},
        )
        second = client.post(
            "/api/hoshidicts/lookup-stats",
            json={"term": "食べる", "reading": "たべる"},
        )
        stats = client.get("/api/hoshidicts/lookup-stats")

        assert first.status_code == 200
        assert first.get_json()["lookupCount"] == 1
        assert first.get_json()["seenCount"] is None
        assert second.status_code == 200
        assert second.get_json()["lookupCount"] == 2
        assert stats.status_code == 200
        assert stats.get_json()["totalLookups"] == 2
        assert stats.get_json()["items"][0]["lookupCount"] == 2
    finally:
        database.close()
        hoshidicts_api.TermLookupStatsTable._db = previous
