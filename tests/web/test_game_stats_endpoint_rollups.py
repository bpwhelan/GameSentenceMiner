from __future__ import annotations

import datetime
import json
from types import SimpleNamespace

import flask
import pytest


@pytest.fixture()
def app():
    test_app = flask.Flask(__name__)
    test_app.config["TESTING"] = True

    from GameSentenceMiner.web.stats_api import register_stats_api_routes

    register_stats_api_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


def test_game_stats_uses_raw_card_query_when_rollup_cards_missing(client, monkeypatch):
    today = datetime.date.today()
    first_day = today - datetime.timedelta(days=2)
    second_day = today - datetime.timedelta(days=1)
    game_id = "game-123"

    game = SimpleNamespace(
        id=game_id,
        title_original="Test Game",
        title_romaji="",
        title_english="",
        type="VN",
        description="",
        image="",
        genres=[],
        tags=[],
        links=[],
        completed=False,
        character_count=10000,
    )

    rollups = [
        SimpleNamespace(
            date=first_day.isoformat(),
            game_activity_data=json.dumps(
                {
                    game_id: {
                        "title": "Test Game",
                        "chars": 120,
                        "time": 3600,
                        "lines": 3,
                    }
                }
            ),
        ),
        SimpleNamespace(
            date=second_day.isoformat(),
            game_activity_data=json.dumps(
                {
                    game_id: {
                        "title": "Test Game",
                        "chars": 80,
                        "time": 1800,
                        "lines": 2,
                    }
                }
            ),
        ),
    ]

    first_ts = datetime.datetime.combine(first_day, datetime.time(hour=12)).timestamp()
    second_ts = datetime.datetime.combine(second_day, datetime.time(hour=18)).timestamp()

    class FakeDB:
        def fetchall(self, query, params):
            compact = " ".join(query.split())
            if compact.startswith("SELECT MIN(timestamp), MAX(timestamp)"):
                return [(first_ts, second_ts)]
            if compact.startswith(
                "SELECT timestamp, note_ids, screenshot_in_anki, audio_in_anki"
            ):
                return [
                    (first_ts, "[101, 102]", "", ""),
                    (second_ts, "", "has-screenshot", ""),
                ]
            raise AssertionError(f"Unexpected query: {compact}")

    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.GamesTable.get",
        lambda requested_game_id: game if requested_game_id == game_id else None,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.GameLinesTable._db",
        FakeDB(),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.StatsRollupTable.get_first_date",
        lambda: first_day.isoformat(),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.StatsRollupTable.get_date_range",
        lambda start, end: rollups,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api._query_stats_lines",
        lambda *args, **kwargs: pytest.fail(
            "rollup-backed path should not query full line records for historical data"
        ),
    )

    response = client.get(f"/api/game/{game_id}/stats")

    assert response.status_code == 200
    payload = response.get_json()

    assert payload["stats"]["total_characters"] == 200
    assert payload["stats"]["total_sentences"] == 5
    assert payload["stats"]["total_cards_mined"] == 3
    assert payload["dailySpeed"]["labels"] == [
        first_day.isoformat(),
        second_day.isoformat(),
    ]
    assert payload["dailySpeed"]["cardsData"] == [2, 1]
    assert payload["dailySpeed"]["charsData"] == [120, 80]
    assert payload["stats"]["first_date"] == first_day.isoformat()
    assert payload["stats"]["last_date"] == second_day.isoformat()
