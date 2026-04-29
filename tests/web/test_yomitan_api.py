from __future__ import annotations

import flask
import pytest
from types import SimpleNamespace
from unittest.mock import patch

from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.database.games_table import GamesTable


def _mock_config(port=9000):
    config = SimpleNamespace()
    config.general = SimpleNamespace(single_port=port)
    return config


def _make_game(*, game_id: str, title: str, character_data: str):
    return SimpleNamespace(
        id=game_id,
        title_original=title,
        title_romaji="",
        title_english="",
        vndb_character_data=character_data,
    )


@pytest.fixture(autouse=True)
def _in_memory_db():
    original_games_db = GamesTable._db
    original_lines_db = GameLinesTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = original_games_db
    GameLinesTable._db = original_lines_db


def _create_client():
    app = flask.Flask(__name__)
    app.config["TESTING"] = True

    from GameSentenceMiner.web.yomitan_api import register_yomitan_api_routes

    register_yomitan_api_routes(app)
    return app.test_client()


def test_yomitan_index_revision_is_stable_for_same_source_data():
    client = _create_client()
    games = [
        _make_game(
            game_id="game-1",
            title="Example Game",
            character_data='{"characters":{"main":[{"id":"c1","name_original":"テスト"}]}}',
        )
    ]

    with patch("GameSentenceMiner.web.yomitan_api.get_config", return_value=_mock_config(8123)):
        with patch("GameSentenceMiner.web.yomitan_api.get_recent_games", return_value=games):
            first = client.get("/api/yomitan-index?game_count=1&spoiler_level=0")
            second = client.get("/api/yomitan-index?game_count=1&spoiler_level=0")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json()["revision"] == second.get_json()["revision"]


def test_yomitan_index_revision_changes_when_character_data_changes():
    client = _create_client()
    base_games = [
        _make_game(
            game_id="game-1",
            title="Example Game",
            character_data='{"characters":{"main":[{"id":"c1","name_original":"テスト"}]}}',
        )
    ]
    updated_games = [
        _make_game(
            game_id="game-1",
            title="Example Game",
            character_data='{"characters":{"main":[{"id":"c1","name_original":"テスト"},{"id":"c2","name_original":"アリス"}]}}',
        )
    ]

    with patch("GameSentenceMiner.web.yomitan_api.get_config", return_value=_mock_config(8123)):
        with patch("GameSentenceMiner.web.yomitan_api.get_recent_games", return_value=base_games):
            first = client.get("/api/yomitan-index?game_count=1&spoiler_level=0")
        with patch("GameSentenceMiner.web.yomitan_api.get_recent_games", return_value=updated_games):
            second = client.get("/api/yomitan-index?game_count=1&spoiler_level=0")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json()["revision"] != second.get_json()["revision"]
