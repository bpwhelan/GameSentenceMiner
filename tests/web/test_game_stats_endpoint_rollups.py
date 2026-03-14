from __future__ import annotations

import datetime
import json
from types import SimpleNamespace

import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.game_daily_rollup_table import (
    GameDailyRollupTable,
)
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.database.tokenisation_tables import (
    KanjiOccurrencesTable,
    KanjiTable,
    WordOccurrencesTable,
    WordsTable,
    setup_tokenisation,
)


@pytest.fixture(autouse=True)
def _in_memory_db():
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    orig_game_daily = GameDailyRollupTable._db
    orig_words = WordsTable._db
    orig_word_occurrences = WordOccurrencesTable._db
    orig_kanji = KanjiTable._db
    orig_kanji_occurrences = KanjiOccurrencesTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    GameDailyRollupTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_stats
    GameDailyRollupTable._db = orig_game_daily
    WordsTable._db = orig_words
    WordOccurrencesTable._db = orig_word_occurrences
    KanjiTable._db = orig_kanji
    KanjiOccurrencesTable._db = orig_kanji_occurrences


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


def test_game_stats_prefers_game_daily_rollups_when_available(client, monkeypatch):
    today = datetime.date.today()
    first_day = today - datetime.timedelta(days=3)
    second_day = today - datetime.timedelta(days=1)
    game_id = "game-rollup"

    game = GamesTable(
        id=game_id,
        title_original="Rollup Game",
        title_romaji="",
        title_english="",
        obs_scene_name="Rollup Scene",
        game_type="VN",
        description="",
        image="",
        genres=[],
        tags=[],
        links=[],
        completed=False,
        character_count=10000,
    )
    game.save()

    GameLinesTable(
        id="line-1",
        game_name="Rollup Scene",
        line_text="abc",
        timestamp=datetime.datetime.combine(
            first_day, datetime.time(hour=12)
        ).timestamp(),
        game_id=game_id,
        note_ids=[],
    ).save()
    GameLinesTable(
        id="line-2",
        game_name="Rollup Scene",
        line_text="def",
        timestamp=datetime.datetime.combine(
            second_day, datetime.time(hour=12)
        ).timestamp(),
        game_id=game_id,
        note_ids=[],
    ).save()

    GameDailyRollupTable(
        date=first_day.isoformat(),
        game_id=game_id,
        total_characters=120,
        total_lines=3,
        total_cards_mined=2,
        total_reading_time_seconds=3600.0,
    ).save()
    GameDailyRollupTable(
        date=second_day.isoformat(),
        game_id=game_id,
        total_characters=80,
        total_lines=2,
        total_cards_mined=1,
        total_reading_time_seconds=1800.0,
    ).save()

    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.StatsRollupTable.get_date_range",
        lambda *_args, **_kwargs: pytest.fail(
            "game stats should use game_daily_rollup when available"
        ),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api._query_stats_lines",
        lambda *_args, **_kwargs: pytest.fail(
            "game stats should not fall back to full line records when game_daily_rollup exists"
        ),
    )

    response = client.get(f"/api/game/{game_id}/stats")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["game"]["obs_scene_name"] == "Rollup Scene"
    assert payload["stats"]["total_characters"] == 200
    assert payload["stats"]["total_sentences"] == 5
    assert payload["stats"]["total_cards_mined"] == 3
    assert payload["dailySpeed"]["labels"] == [
        first_day.isoformat(),
        second_day.isoformat(),
    ]
    assert payload["dailySpeed"]["charsData"] == [120, 80]
    assert payload["dailySpeed"]["cardsData"] == [2, 1]


def test_game_stats_counts_media_only_cards_without_rollups(client):
    game_id = "game-media-only"
    today = datetime.date.today()

    game = GamesTable(
        id=game_id,
        title_original="Media Only Game",
        title_romaji="",
        title_english="",
        game_type="VN",
        description="",
        image="",
        genres=[],
        tags=[],
        links=[],
        completed=False,
        character_count=0,
    )
    game.save()

    GameLinesTable(
        id="line-media-only",
        game_name="Media Scene",
        line_text="abc",
        timestamp=datetime.datetime.combine(today, datetime.time(hour=12)).timestamp(),
        game_id=game_id,
        note_ids=[],
        screenshot_in_anki="stored-screenshot",
    ).save()

    response = client.get(f"/api/game/{game_id}/stats")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["stats"]["total_cards_mined"] == 1
    assert payload["dailySpeed"]["labels"] == [today.isoformat()]
    assert payload["dailySpeed"]["cardsData"] == [1]


def test_game_stats_reports_word_novelty_for_words_first_seen_in_that_game(
    client, monkeypatch, _in_memory_db
):
    monkeypatch.setattr(
        "GameSentenceMiner.web.token_novelty.is_tokenisation_enabled",
        lambda: True,
    )
    setup_tokenisation(_in_memory_db)

    today = datetime.date.today()
    previous_day = today - datetime.timedelta(days=3)
    first_day = today - datetime.timedelta(days=2)
    second_day = today - datetime.timedelta(days=1)
    game_id = "game-novelty"
    other_game_id = "game-other"

    GamesTable(
        id=game_id,
        title_original="Novelty Game",
        title_romaji="",
        title_english="",
        game_type="VN",
        description="",
        image="",
        genres=[],
        tags=[],
        links=[],
        completed=False,
        character_count=0,
    ).save()
    GamesTable(
        id=other_game_id,
        title_original="Earlier Game",
        title_romaji="",
        title_english="",
        game_type="VN",
        description="",
        image="",
        genres=[],
        tags=[],
        links=[],
        completed=False,
        character_count=0,
    ).save()

    timestamps = {
        "other": datetime.datetime.combine(
            previous_day, datetime.time(hour=12)
        ).timestamp(),
        "first": datetime.datetime.combine(
            first_day, datetime.time(hour=12)
        ).timestamp(),
        "second": datetime.datetime.combine(
            second_day, datetime.time(hour=12)
        ).timestamp(),
    }

    GameLinesTable(
        id="novelty-other-line",
        game_name="Earlier Game",
        game_id=other_game_id,
        line_text="qq",
        timestamp=timestamps["other"],
        note_ids=[],
    ).save()
    GameLinesTable(
        id="novelty-line-1",
        game_name="Novelty Game",
        game_id=game_id,
        line_text="aaaa",
        timestamp=timestamps["first"],
        note_ids=[],
    ).save()
    GameLinesTable(
        id="novelty-line-2",
        game_name="Novelty Game",
        game_id=game_id,
        line_text="bbbb",
        timestamp=timestamps["second"],
        note_ids=[],
    ).save()
    for line_id in ["novelty-other-line", "novelty-line-1", "novelty-line-2"]:
        _in_memory_db.execute(
            "UPDATE game_lines SET tokenised = 1 WHERE id = ?",
            (line_id,),
            commit=True,
        )

    alpha_id = WordsTable.get_or_create("alpha", "", "noun")
    carry_id = WordsTable.get_or_create("carry", "", "noun")
    beta_id = WordsTable.get_or_create("beta", "", "noun")
    WordsTable.set_first_seen_if_missing(
        carry_id, timestamps["other"], "novelty-other-line"
    )
    WordsTable.set_first_seen_if_missing(
        alpha_id, timestamps["first"], "novelty-line-1"
    )
    WordsTable.set_first_seen_if_missing(
        beta_id, timestamps["second"], "novelty-line-2"
    )

    WordOccurrencesTable.insert_occurrence(carry_id, "novelty-other-line")
    WordOccurrencesTable.insert_occurrence(alpha_id, "novelty-line-1")
    WordOccurrencesTable.insert_occurrence(alpha_id, "novelty-line-2")
    WordOccurrencesTable.insert_occurrence(beta_id, "novelty-line-2")
    WordOccurrencesTable.insert_occurrence(carry_id, "novelty-line-2")

    response = client.get(f"/api/game/{game_id}/stats")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["tokenisationStatus"]["enabled"] is True
    assert payload["vocabulary"] == {
        "uniqueWordsInGame": 3,
        "globallyNewWordsFromGame": 2,
        "noveltyRate": 66.7,
        "newWordsPer10kChars": 2500.0,
        "defaultBucketSize": 10000,
        "bucketSizeOptions": [10000, 25000, 50000, 100000],
        "totalTokenisedChars": 8,
        "newWordCharacterPositions": [4, 8],
        "series": {
            "labels": [first_day.isoformat(), second_day.isoformat()],
            "dailyNew": [1, 1],
            "cumulative": [1, 2],
        },
    }


def test_game_stats_returns_empty_bucket_data_for_zero_tokenised_characters(
    client, monkeypatch, _in_memory_db
):
    monkeypatch.setattr(
        "GameSentenceMiner.web.token_novelty.is_tokenisation_enabled",
        lambda: True,
    )
    setup_tokenisation(_in_memory_db)

    game_id = "game-empty-tokenised"
    GamesTable(
        id=game_id,
        title_original="Empty Tokenised Game",
        title_romaji="",
        title_english="",
        game_type="VN",
        description="",
        image="",
        genres=[],
        tags=[],
        links=[],
        completed=False,
        character_count=0,
    ).save()

    response = client.get(f"/api/game/{game_id}/stats")

    assert response.status_code == 200
    assert response.get_json()["vocabulary"] == {
        "uniqueWordsInGame": 0,
        "globallyNewWordsFromGame": 0,
        "noveltyRate": 0.0,
        "newWordsPer10kChars": 0.0,
        "series": {"labels": [], "dailyNew": [], "cumulative": []},
        "defaultBucketSize": 10000,
        "bucketSizeOptions": [10000, 25000, 50000, 100000],
        "totalTokenisedChars": 0,
        "newWordCharacterPositions": [],
    }


def test_game_stats_counts_media_only_cards_in_today_rollup_delta(client):
    today = datetime.date.today()
    yesterday = today - datetime.timedelta(days=1)
    game_id = "game-media-delta"

    game = GamesTable(
        id=game_id,
        title_original="Media Delta Game",
        title_romaji="",
        title_english="",
        game_type="VN",
        description="",
        image="",
        genres=[],
        tags=[],
        links=[],
        completed=False,
        character_count=0,
    )
    game.save()

    GameLinesTable(
        id="line-yesterday",
        game_name="Media Scene",
        line_text="abc",
        timestamp=datetime.datetime.combine(
            yesterday,
            datetime.time(hour=12),
        ).timestamp(),
        game_id=game_id,
        note_ids=[],
    ).save()
    GameLinesTable(
        id="line-today-media",
        game_name="Media Scene",
        line_text="def",
        timestamp=datetime.datetime.combine(today, datetime.time(hour=12)).timestamp(),
        game_id=game_id,
        note_ids=[],
        screenshot_in_anki="stored-screenshot",
    ).save()

    GameDailyRollupTable(
        date=yesterday.isoformat(),
        game_id=game_id,
        total_characters=3,
        total_lines=1,
        total_cards_mined=0,
        total_reading_time_seconds=60.0,
    ).save()

    response = client.get(f"/api/game/{game_id}/stats")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["stats"]["total_cards_mined"] == 1
    assert payload["dailySpeed"]["labels"] == [
        yesterday.isoformat(),
        today.isoformat(),
    ]
    assert payload["dailySpeed"]["cardsData"] == [0, 1]


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
    second_ts = datetime.datetime.combine(
        second_day, datetime.time(hour=18)
    ).timestamp()

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


def test_game_stats_rollup_query_starts_at_first_game_activity_date(
    client, monkeypatch
):
    today = datetime.date.today()
    global_first_day = today - datetime.timedelta(days=30)
    first_day = today - datetime.timedelta(days=3)
    second_day = today - datetime.timedelta(days=1)
    game_id = "game-456"

    game = SimpleNamespace(
        id=game_id,
        title_original="Scoped Game",
        title_romaji="",
        title_english="",
        type="VN",
        description="",
        image="",
        genres=[],
        tags=[],
        links=[],
        completed=False,
        character_count=5000,
    )

    first_ts = datetime.datetime.combine(first_day, datetime.time(hour=10)).timestamp()
    second_ts = datetime.datetime.combine(
        second_day, datetime.time(hour=20)
    ).timestamp()
    requested_ranges: list[tuple[str, str]] = []

    rollups = [
        SimpleNamespace(
            date=first_day.isoformat(),
            game_activity_data=json.dumps(
                {
                    game_id: {
                        "title": "Scoped Game",
                        "chars": 90,
                        "time": 1800,
                        "lines": 2,
                        "cards": 1,
                    }
                }
            ),
        ),
        SimpleNamespace(
            date=second_day.isoformat(),
            game_activity_data=json.dumps(
                {
                    game_id: {
                        "title": "Scoped Game",
                        "chars": 110,
                        "time": 3600,
                        "lines": 3,
                        "cards": 2,
                    }
                }
            ),
        ),
    ]

    class FakeDB:
        def fetchall(self, query, params):
            compact = " ".join(query.split())
            if compact.startswith("SELECT MIN(timestamp), MAX(timestamp)"):
                return [(first_ts, second_ts)]
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
        lambda: global_first_day.isoformat(),
    )

    def fake_get_date_range(start, end):
        requested_ranges.append((start, end))
        return rollups

    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api.StatsRollupTable.get_date_range",
        fake_get_date_range,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.stats_api._query_stats_lines",
        lambda *args, **kwargs: pytest.fail(
            "rollup-backed path should not query full line records for historical data"
        ),
    )

    response = client.get(f"/api/game/{game_id}/stats")

    assert response.status_code == 200
    assert requested_ranges == [(first_day.isoformat(), second_day.isoformat())]

    payload = response.get_json()
    assert payload["dailySpeed"]["labels"] == [
        first_day.isoformat(),
        second_day.isoformat(),
    ]
    assert payload["stats"]["total_characters"] == 200
    assert payload["stats"]["total_cards_mined"] == 3
