from __future__ import annotations

import io
import json

import pytest
from flask import Flask

from GameSentenceMiner.util.database.db import SQLiteDB
from GameSentenceMiner.web import hoshidicts_api

BROKER_TOKEN = "a" * 64


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GSM_BROKER_TOKEN", BROKER_TOKEN)
    app = Flask(__name__)
    hoshidicts_api.register_hoshidicts_api_routes(app)
    flask_client = app.test_client()
    flask_client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {BROKER_TOKEN}"
    return flask_client


@pytest.mark.parametrize("method", ["get", "post"])
def test_lookup_stats_require_broker_authentication(client, method):
    request_method = getattr(client, method)
    kwargs = {"json": {"term": "猫"}} if method == "post" else {}

    response = request_method(
        "/api/hoshidicts/lookup-stats",
        headers={"Authorization": ""},
        **kwargs,
    )

    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert response.get_json() == {
        "error": "Hoshidicts authentication failed.",
    }


def test_post_lookup_stats_normalizes_and_returns_current_count(client, monkeypatch):
    recorded = []

    def record_lookup(term, reading):
        recorded.append((term, reading))
        return {
            "term": term,
            "reading": reading,
            "lookup_count": 3,
            "first_looked_up_at": 100.0,
            "last_looked_up_at": 200.0,
        }

    monkeypatch.setattr(
        hoshidicts_api.TermLookupStatsTable,
        "record_lookup",
        record_lookup,
    )

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
    }


def test_post_lookup_stats_allows_an_omitted_reading(client, monkeypatch):
    recorded = []

    def fake_record(term, reading):
        recorded.append((term, reading))
        return {
            "term": term,
            "reading": reading,
            "lookup_count": 1,
            "first_looked_up_at": 1.0,
            "last_looked_up_at": 1.0,
        }

    monkeypatch.setattr(
        hoshidicts_api.TermLookupStatsTable,
        "record_lookup",
        fake_record,
    )

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


def test_post_lookup_stats_rejects_oversized_stream_without_content_length(client):
    body = json.dumps({"term": "猫", "padding": "x" * 5000}).encode()
    response = client.open(
        "/api/hoshidicts/lookup-stats",
        method="POST",
        input_stream=io.BytesIO(body),
        content_type="application/json",
        environ_overrides={
            "CONTENT_LENGTH": "",
            "wsgi.input_terminated": True,
        },
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


def test_get_lookup_stats_returns_paginated_camel_case_results(client, monkeypatch):
    calls = []

    def get_stats(limit, offset):
        calls.append((limit, offset))
        return {
            "total_lookups": 7,
            "unique_terms": 2,
            "items": [
                {
                    "term": "食べる",
                    "reading": "たべる",
                    "lookup_count": 5,
                    "first_looked_up_at": 100.0,
                    "last_looked_up_at": 200.0,
                }
            ],
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


@pytest.mark.parametrize(
    "query",
    [
        "limit=0",
        "limit=501",
        "limit=1.5",
        "limit=no",
        "limit=1_0",
        "limit=%2B10",
        "limit=%2001%20",
        "limit=01",
        "offset=-1",
        "offset=no",
        "offset=1_0",
    ],
)
def test_get_lookup_stats_rejects_invalid_pagination(client, query):
    response = client.get(f"/api/hoshidicts/lookup-stats?{query}")

    assert response.status_code == 400
    assert response.get_json()["success"] is False


def test_get_lookup_stats_uses_default_pagination(client, monkeypatch):
    calls = []
    monkeypatch.setattr(
        hoshidicts_api.TermLookupStatsTable,
        "get_stats",
        lambda limit, offset: calls.append((limit, offset)) or {"total_lookups": 0, "unique_terms": 0, "items": []},
    )

    response = client.get("/api/hoshidicts/lookup-stats")

    assert response.status_code == 200
    assert calls == [(100, 0)]
    assert response.get_json()["items"] == []


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
        assert second.status_code == 200
        assert second.get_json()["lookupCount"] == 2
        assert stats.status_code == 200
        assert stats.get_json()["totalLookups"] == 2
        assert stats.get_json()["items"][0]["lookupCount"] == 2
    finally:
        database.close()
        hoshidicts_api.TermLookupStatsTable._db = previous
