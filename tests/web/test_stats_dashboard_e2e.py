from __future__ import annotations

import datetime
import json
import re
from dataclasses import dataclass
from pathlib import Path

import flask
import pytest

from GameSentenceMiner.util.config.configuration import (
    get_config,
    get_master_config,
    get_stats_config,
)
from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.database.third_party_stats_table import (
    ThirdPartyStatsTable,
)
from GameSentenceMiner.web.stats_api import register_stats_api_routes


FROZEN_TODAY = datetime.date(2026, 3, 12)


def _normalise_windows_path(path: Path) -> str:
    path_str = str(path)
    return path_str[4:] if path_str.startswith("\\\\?\\") else path_str


class _FrozenDate(datetime.date):
    @classmethod
    def today(cls) -> _FrozenDate:
        return cls(2026, 3, 12)


@dataclass
class _DashboardTestEnv:
    client: flask.testing.FlaskClient
    start_timestamp: float
    end_timestamp: float
    today_start_timestamp: float
    today_end_timestamp: float


def _timestamp(iso_datetime: str) -> float:
    return datetime.datetime.fromisoformat(iso_datetime).timestamp()


def _freeze_stats_today(monkeypatch: pytest.MonkeyPatch) -> None:
    import GameSentenceMiner.web.rollup_stats as rollup_stats
    import GameSentenceMiner.web.stats as stats_module
    import GameSentenceMiner.web.stats_api as stats_api
    import GameSentenceMiner.web.stats_service as stats_service

    monkeypatch.setattr(stats_api.datetime, "date", _FrozenDate)
    monkeypatch.setattr(stats_service.datetime, "date", _FrozenDate)
    monkeypatch.setattr(rollup_stats.datetime, "date", _FrozenDate)
    monkeypatch.setattr(stats_module.datetime, "date", _FrozenDate)


def _seed_games() -> None:
    GamesTable(
        id="game-alpha",
        title_original="Alpha Quest",
        obs_scene_name="ALPHA_SCENE",
        game_type="Visual Novel",
        difficulty=2,
        release_date="2010-01-01",
        character_count=1000,
        completed=True,
        genres=["Mystery"],
        tags=["Detective"],
    ).save()
    GamesTable(
        id="game-beta",
        title_original="Beta Fight",
        obs_scene_name="BETA_SCENE",
        game_type="Action",
        difficulty=5,
        release_date="2020-06-15",
        character_count=2000,
        completed=False,
        genres=["Action"],
        tags=["Boss Rush"],
    ).save()


def _seed_raw_lines() -> None:
    GameLinesTable(
        id="hist-alpha",
        game_name="ALPHA_SCENE",
        game_id="game-alpha",
        line_text="a",
        timestamp=_timestamp("2026-03-10T12:00:00"),
    ).save()
    GameLinesTable(
        id="hist-beta",
        game_name="BETA_SCENE",
        game_id="game-beta",
        line_text="b",
        timestamp=_timestamp("2026-03-10T12:05:00"),
    ).save()
    GameLinesTable(
        id="live-beta",
        game_name="BETA_SCENE",
        game_id="game-beta",
        line_text="xy",
        timestamp=_timestamp("2026-03-12T09:00:00"),
        audio_in_anki="1",
    ).save()
    GameLinesTable(
        id="live-alpha-1",
        game_name="ALPHA_SCENE",
        game_id="game-alpha",
        line_text="abcde",
        timestamp=_timestamp("2026-03-12T10:00:00"),
        note_ids=["n1", "n2"],
    ).save()
    GameLinesTable(
        id="live-alpha-2",
        game_name="ALPHA_SCENE",
        game_id="game-alpha",
        line_text="fghij",
        timestamp=_timestamp("2026-03-12T10:00:30"),
        screenshot_in_anki="1",
    ).save()


def _seed_rollups() -> None:
    StatsRollupTable(
        date="2026-03-10",
        total_lines=3,
        total_characters=30,
        total_sessions=1,
        unique_games_played=2,
        total_reading_time_seconds=1800,
        total_active_time_seconds=1800,
        average_reading_speed_chars_per_hour=60,
        peak_reading_speed_chars_per_hour=90,
        anki_cards_created=1,
        longest_session_seconds=1800,
        shortest_session_seconds=1800,
        average_session_seconds=1800,
        max_chars_in_session=30,
        max_time_in_session_seconds=1800,
        game_activity_data=json.dumps(
            {
                "game-alpha": {
                    "title": "Alpha Quest",
                    "lines": 2,
                    "chars": 18,
                    "time": 900,
                },
                "game-beta": {
                    "title": "Beta Fight",
                    "lines": 1,
                    "chars": 12,
                    "time": 900,
                },
            }
        ),
        games_played_ids=json.dumps(["game-alpha", "game-beta"]),
        hourly_activity_data=json.dumps({"9": 12, "10": 18}),
        hourly_reading_speed_data=json.dumps({"9": 48, "10": 72}),
        kanji_frequency_data=json.dumps({"日": 2, "本": 1}),
        genre_activity_data=json.dumps(
            {
                "Mystery": {"chars": 18, "time": 900, "cards": 1},
                "Action": {"chars": 12, "time": 900, "cards": 0},
            }
        ),
        type_activity_data=json.dumps(
            {
                "Visual Novel": {"chars": 18, "time": 900, "cards": 1},
                "Action": {"chars": 12, "time": 900, "cards": 0},
            }
        ),
    ).save()
    StatsRollupTable(
        date="2026-03-11",
        total_lines=4,
        total_characters=40,
        total_sessions=2,
        unique_games_played=2,
        total_reading_time_seconds=3600,
        total_active_time_seconds=3600,
        average_reading_speed_chars_per_hour=40,
        peak_reading_speed_chars_per_hour=80,
        anki_cards_created=2,
        longest_session_seconds=1800,
        shortest_session_seconds=1200,
        average_session_seconds=1500,
        max_chars_in_session=25,
        max_time_in_session_seconds=1800,
        game_activity_data=json.dumps(
            {
                "game-alpha": {
                    "title": "Alpha Quest",
                    "lines": 1,
                    "chars": 10,
                    "time": 1200,
                },
                "game-beta": {
                    "title": "Beta Fight",
                    "lines": 3,
                    "chars": 30,
                    "time": 2400,
                },
            }
        ),
        games_played_ids=json.dumps(["game-alpha", "game-beta"]),
        hourly_activity_data=json.dumps({"9": 10, "11": 30}),
        hourly_reading_speed_data=json.dumps({"9": 60, "11": 45}),
        kanji_frequency_data=json.dumps({"日": 1, "語": 3}),
        genre_activity_data=json.dumps(
            {
                "Mystery": {"chars": 10, "time": 1200, "cards": 0},
                "Action": {"chars": 30, "time": 2400, "cards": 2},
            }
        ),
        type_activity_data=json.dumps(
            {
                "Visual Novel": {"chars": 10, "time": 1200, "cards": 0},
                "Action": {"chars": 30, "time": 2400, "cards": 2},
            }
        ),
    ).save()


def _seed_third_party_stats() -> None:
    ThirdPartyStatsTable(
        date="2026-03-11",
        characters_read=50,
        time_read_seconds=600,
        source="mokuro",
        label="Imported Volume 1",
    ).save()


def _seed_dashboard_data() -> None:
    _seed_games()
    _seed_raw_lines()
    _seed_rollups()
    _seed_third_party_stats()


def _create_app() -> flask.Flask:
    repo_root = Path(__file__).resolve().parents[2]
    app = flask.Flask(
        __name__,
        template_folder=_normalise_windows_path(
            repo_root / "GameSentenceMiner" / "web" / "templates"
        ),
        static_folder=_normalise_windows_path(
            repo_root / "GameSentenceMiner" / "web" / "static"
        ),
    )
    app.config["TESTING"] = True
    register_stats_api_routes(app)

    @app.route("/stats")
    def stats_page():
        return flask.render_template(
            "stats.html",
            config=get_config(),
            master_config=get_master_config(),
            stats_config=get_stats_config(),
            first_rollup_date=StatsRollupTable.get_first_date(),
        )

    return app


def _build_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    seed_data: bool,
) -> _DashboardTestEnv:
    _freeze_stats_today(monkeypatch)

    db = SQLiteDB(str(tmp_path / "stats_dashboard_e2e.db"))
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    ThirdPartyStatsTable.set_db(db)

    if seed_data:
        _seed_dashboard_data()

    app = _create_app()
    client = app.test_client()
    return _DashboardTestEnv(
        client=client,
        start_timestamp=_timestamp("2026-03-10T00:00:00"),
        end_timestamp=_timestamp("2026-03-12T23:59:59"),
        today_start_timestamp=_timestamp("2026-03-12T00:00:00"),
        today_end_timestamp=_timestamp("2026-03-12T23:59:59"),
    )


@pytest.fixture()
def seeded_dashboard_env(tmp_path, monkeypatch):
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    orig_third_party = ThirdPartyStatsTable._db
    env = _build_env(tmp_path, monkeypatch, seed_data=True)
    try:
        yield env
    finally:
        GamesTable._db.close()
        GamesTable._db = orig_games
        GameLinesTable._db = orig_lines
        StatsRollupTable._db = orig_stats
        ThirdPartyStatsTable._db = orig_third_party


@pytest.fixture()
def empty_dashboard_env(tmp_path, monkeypatch):
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    orig_third_party = ThirdPartyStatsTable._db
    env = _build_env(tmp_path, monkeypatch, seed_data=False)
    try:
        yield env
    finally:
        GamesTable._db.close()
        GamesTable._db = orig_games
        GameLinesTable._db = orig_lines
        StatsRollupTable._db = orig_stats
        ThirdPartyStatsTable._db = orig_third_party


def test_stats_page_renders_dashboard_wiring(seeded_dashboard_env: _DashboardTestEnv):
    response = seeded_dashboard_env.client.get("/stats")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    for element_id in (
        "totalCharsForPeriod",
        "dailyTimeChart",
        "gameMilestonesGrid",
        "kanjiGridContainer",
        "miningHeatmapContainer",
        "toggleMovingAverageBtn",
    ):
        assert f'id="{element_id}"' in html

    for removed_id in ("toggleTimeDataBtn", "toggleCharsDataBtn", "toggleSpeedDataBtn"):
        assert f'id="{removed_id}"' not in html

    for heading in (
        "Top 5 Reading Time by Game",
        "Top 5 Characters Read by Game",
        "Top 5 Reading Speed by Game",
    ):
        assert heading in html

    assert "/static/js/stats.js" in html
    assert "window.statsConfig" in html
    assert 'id="exstaticFile"' not in html
    assert 'id="importExstaticBtn"' not in html
    assert re.search(r'"firstDate"\s*:\s*"2026-03-10"', html)


def test_api_stats_full_flow_returns_expected_dashboard_contract(
    seeded_dashboard_env: _DashboardTestEnv,
):
    response = seeded_dashboard_env.client.get(
        f"/api/stats?start={seeded_dashboard_env.start_timestamp}"
        f"&end={seeded_dashboard_env.end_timestamp}"
    )

    assert response.status_code == 200

    data = response.get_json()
    assert data["labels"] == ["2026-03-10", "2026-03-11", "2026-03-12"]

    all_games = data["allGamesStats"]
    assert all_games["total_characters"] == 132
    assert all_games["total_sentences"] == 10
    assert all_games["total_time_hours"] == pytest.approx(1.675)
    assert all_games["reading_speed"] == 78
    assert all_games["sessions"] == 4
    assert all_games["completed_games"] == 1
    assert all_games["first_date"] == "2026-03-10"
    assert all_games["last_date"] == "2026-03-12"

    assert data["timePeriodAverages"] == {
        "avgHoursPerDay": 0.56,
        "avgCharsPerDay": 44,
        "avgSpeedPerDay": 525,
        "totalHours": 1.68,
        "totalChars": 132,
    }
    assert data["heatmapData"] == {
        "2026": {
            "2026-03-10": 30,
            "2026-03-11": 90,
            "2026-03-12": 12,
        }
    }
    assert data["cardsMinedLast30Days"] == {
        "labels": ["2026-03-10", "2026-03-11"],
        "totals": [1, 2],
    }
    assert data["miningHeatmapData"] == {
        "2026": {
            "2026-03-10": 1,
            "2026-03-11": 2,
            "2026-03-12": 3,
        }
    }

    current_game = data["currentGameStats"]
    assert current_game["game_id"] == "game-alpha"
    assert current_game["title_original"] == "Alpha Quest"
    assert current_game["total_characters"] == 38
    assert current_game["total_sentences"] == 5
    assert current_game["reading_speed"] == 64
    assert current_game["first_date"] == "2026-03-10"
    assert current_game["last_date"] == "2026-03-12"
    assert current_game["progress_percentage"] == 3.8
    assert current_game["daily_activity"] == {
        "2026-03-10": 18,
        "2026-03-11": 10,
        "2026-03-12": 10,
    }

    assert dict(
        zip(data["totalCharsPerGame"]["labels"], data["totalCharsPerGame"]["totals"])
    ) == {"Alpha Quest": 28, "Beta Fight": 42}
    assert dict(
        zip(data["readingTimePerGame"]["labels"], data["readingTimePerGame"]["totals"])
    ) == {"Alpha Quest": 0.58, "Beta Fight": 0.92}
    assert dict(
        zip(
            data["readingSpeedPerGame"]["labels"],
            data["readingSpeedPerGame"]["totals"],
        )
    ) == {"Alpha Quest": 48.0, "Beta Fight": 46.0}

    assert "kanjiGridData" not in data
    assert "gameMilestones" not in data


def test_api_daily_activity_default_route_uses_last_28_days(
    seeded_dashboard_env: _DashboardTestEnv,
):
    response = seeded_dashboard_env.client.get("/api/daily-activity")

    assert response.status_code == 200

    data = response.get_json()
    assert len(data["labels"]) == 28
    assert data["labels"][-1] == FROZEN_TODAY.isoformat()

    by_date = {
        date: (time, chars, speed)
        for date, time, chars, speed in zip(
            data["labels"], data["timeData"], data["charsData"], data["speedData"]
        )
    }
    assert by_date["2026-03-10"] == (0.5, 30, 60)
    assert by_date["2026-03-11"] == (1.0, 40, 40)
    assert by_date["2026-03-12"] == (0, 0, 0)


def test_api_daily_activity_explicit_range_uses_selected_dates(
    seeded_dashboard_env: _DashboardTestEnv,
):
    response = seeded_dashboard_env.client.get(
        f"/api/daily-activity?start={seeded_dashboard_env.start_timestamp}"
        f"&end={seeded_dashboard_env.end_timestamp}"
    )

    assert response.status_code == 200

    data = response.get_json()
    assert data["labels"] == ["2026-03-10", "2026-03-11", "2026-03-12"]
    assert data["timeData"] == [0.5, 1.0, 0]
    assert data["charsData"] == [30, 40, 0]
    assert data["speedData"] == [60, 40, 0]


def test_api_stats_kanji_grid_returns_expected_counts(
    seeded_dashboard_env: _DashboardTestEnv,
):
    response = seeded_dashboard_env.client.get(
        f"/api/stats/kanji-grid?start={seeded_dashboard_env.start_timestamp}"
        f"&end={seeded_dashboard_env.end_timestamp}"
    )

    assert response.status_code == 200

    data = response.get_json()
    frequency_by_kanji = {
        item["kanji"]: item["frequency"] for item in data["kanji_data"]
    }
    assert frequency_by_kanji == {"日": 3, "本": 1, "語": 3}
    assert data["unique_count"] == 3
    assert data["max_frequency"] == 3


def test_api_stats_game_milestones_returns_seeded_games(
    seeded_dashboard_env: _DashboardTestEnv,
):
    response = seeded_dashboard_env.client.get("/api/stats/game-milestones")

    assert response.status_code == 200

    data = response.get_json()
    assert data["oldest_game"]["title_original"] == "Alpha Quest"
    assert data["oldest_game"]["release_date"] == "2010-01-01"
    assert data["newest_game"]["title_original"] == "Beta Fight"
    assert data["newest_game"]["release_date"] == "2020-06-15"


def test_api_mining_heatmap_returns_today_only_mined_line_counts(
    seeded_dashboard_env: _DashboardTestEnv,
):
    response = seeded_dashboard_env.client.get(
        f"/api/mining_heatmap?start={seeded_dashboard_env.today_start_timestamp}"
        f"&end={seeded_dashboard_env.today_end_timestamp}"
    )

    assert response.status_code == 200
    assert response.get_json() == {"2026": {"2026-03-12": 3}}


def test_empty_dashboard_flow_returns_documented_fallbacks(
    empty_dashboard_env: _DashboardTestEnv,
):
    page_response = empty_dashboard_env.client.get("/stats")
    assert page_response.status_code == 200

    html = page_response.get_data(as_text=True)
    assert "window.statsConfig" in html
    assert re.search(r'"firstDate"\s*:\s*(null|"")', html)

    stats_response = empty_dashboard_env.client.get("/api/stats")
    assert stats_response.status_code == 200
    assert stats_response.get_json() == {"labels": [], "datasets": []}

    daily_response = empty_dashboard_env.client.get("/api/daily-activity")
    assert daily_response.status_code == 200
    daily_data = daily_response.get_json()
    assert len(daily_data["labels"]) == 28
    assert daily_data["labels"][-1] == FROZEN_TODAY.isoformat()
    assert all(value == 0 for value in daily_data["timeData"])
    assert all(value == 0 for value in daily_data["charsData"])
    assert all(value == 0 for value in daily_data["speedData"])

    kanji_response = empty_dashboard_env.client.get("/api/stats/kanji-grid")
    assert kanji_response.status_code == 200
    assert kanji_response.get_json() == {
        "kanji_data": [],
        "unique_count": 0,
        "max_frequency": 0,
    }

    milestones_response = empty_dashboard_env.client.get("/api/stats/game-milestones")
    assert milestones_response.status_code == 200
    assert milestones_response.get_json() is None

    mining_response = empty_dashboard_env.client.get("/api/mining_heatmap")
    assert mining_response.status_code == 200
    assert mining_response.get_json() == {}
