from __future__ import annotations

import datetime
import json
from types import SimpleNamespace

import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


@pytest.fixture(autouse=True)
def _in_memory_db():
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


def test_all_lines_data_skips_full_combined_stats_builder(client, monkeypatch):
    today = datetime.date.today()
    yesterday = today - datetime.timedelta(days=1)

    rollup = StatsRollupTable(
        date=yesterday.isoformat(),
        total_lines=5,
        total_characters=123,
        total_reading_time_seconds=45.0,
        anki_cards_created=0,
        game_activity_data=json.dumps({}),
        kanji_frequency_data=json.dumps({}),
        hourly_activity_data=json.dumps({}),
        hourly_reading_speed_data=json.dumps({}),
        genre_activity_data=json.dumps({}),
        type_activity_data=json.dumps({}),
    )
    rollup.save()

    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api._build_combined_stats",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("all-lines-data should not build the full combined stats payload")
        ),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_service.get_third_party_stats_by_date",
        lambda *_args, **_kwargs: {},
    )

    resp = client.get("/api/stats/all-lines-data")
    assert resp.status_code == 200

    data = resp.get_json()
    assert isinstance(data, list)
    assert data[0]["date"] == yesterday.isoformat()
    assert data[0]["characters"] == 123
    assert data[0]["reading_time_seconds"] == 45.0


def test_all_lines_data_aggregates_live_dates_with_adaptive_reading_time(
    client,
    monkeypatch,
):
    today = datetime.date.today().isoformat()
    live_lines = [
        SimpleNamespace(
            timestamp=datetime.datetime.combine(datetime.date.today(), datetime.time(10, 0)).timestamp(),
            line_text="abc",
        ),
        SimpleNamespace(
            timestamp=datetime.datetime.combine(datetime.date.today(), datetime.time(10, 2)).timestamp(),
            line_text="de",
        ),
        SimpleNamespace(
            timestamp=datetime.datetime.combine(datetime.date.today(), datetime.time(10, 5)).timestamp(),
            line_text="f",
        ),
    ]

    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api._load_stats_range_context",
        lambda *_args, **_kwargs: ([], live_lines, today, today, {}),
    )

    resp = client.get("/api/stats/all-lines-data")
    assert resp.status_code == 200

    data = resp.get_json()
    assert data == [
        {
            "timestamp": datetime.datetime.combine(datetime.date.today(), datetime.time.min).timestamp(),
            "date": today,
            "characters": 6,
            "reading_time_seconds": 30.0,
        }
    ]
