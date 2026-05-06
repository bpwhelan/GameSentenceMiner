from __future__ import annotations

from types import SimpleNamespace

import flask
import pytest

from GameSentenceMiner.web.database_api import register_database_api_routes


@pytest.fixture()
def app():
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True
    register_database_api_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


def _stats_config(**overrides):
    values = {
        "session_gap_seconds": 3600,
        "streak_requirement_hours": 1.0,
        "reading_hours_target": 1500,
        "character_count_target": 25_000_000,
        "games_target": 100,
        "reading_hours_target_date": "",
        "character_count_target_date": "",
        "games_target_date": "",
        "cards_mined_daily_target": 10,
        "regex_out_punctuation": False,
        "regex_out_repetitions": True,
        "extra_punctuation_regex": "",
        "easy_days_settings": {
            "monday": 100,
            "tuesday": 100,
            "wednesday": 100,
            "thursday": 100,
            "friday": 100,
            "saturday": 100,
            "sunday": 100,
        },
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_get_settings_omits_afk_timer(client, monkeypatch):
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.get_stats_config",
        lambda: _stats_config(session_gap_seconds=1800),
    )

    response = client.get("/api/settings")

    assert response.status_code == 200
    data = response.get_json()
    assert "afk_timer_seconds" not in data
    assert data["session_gap_seconds"] == 1800


def test_get_settings_includes_extra_punctuation_regex(client, monkeypatch):
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.get_stats_config",
        lambda: _stats_config(extra_punctuation_regex=r"\.?【.*?】"),
    )

    response = client.get("/api/settings")

    assert response.status_code == 200
    data = response.get_json()
    assert data["extra_punctuation_regex"] == r"\.?【.*?】"


def test_post_settings_rejects_legacy_afk_timer_only(client, monkeypatch):
    config = _stats_config()
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.get_stats_config",
        lambda: config,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.save_stats_config",
        lambda _config: None,
    )

    response = client.post("/api/settings", json={"afk_timer_seconds": 120})

    assert response.status_code == 400
    assert response.get_json() == {"error": "No valid settings provided"}


def test_post_settings_updates_session_gap_without_afk_timer(client, monkeypatch):
    config = _stats_config()
    saved = []
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.get_stats_config",
        lambda: config,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.save_stats_config",
        lambda updated: saved.append(updated),
    )

    response = client.post("/api/settings", json={"session_gap_seconds": 1800})

    assert response.status_code == 200
    data = response.get_json()
    assert "afk_timer_seconds" not in data
    assert data["session_gap_seconds"] == 1800
    assert config.session_gap_seconds == 1800
    assert saved == [config]


def test_post_settings_updates_extra_punctuation_regex(client, monkeypatch):
    config = _stats_config()
    saved = []
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.get_stats_config",
        lambda: config,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.save_stats_config",
        lambda updated: saved.append(updated),
    )

    response = client.post("/api/settings", json={"extra_punctuation_regex": r"\.?【.*?】"})

    assert response.status_code == 200
    data = response.get_json()
    assert data["extra_punctuation_regex"] == r"\.?【.*?】"
    assert config.extra_punctuation_regex == r"\.?【.*?】"
    assert saved == [config]


def test_post_settings_rejects_invalid_extra_punctuation_regex(client, monkeypatch):
    config = _stats_config()
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.get_stats_config",
        lambda: config,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_api.save_stats_config",
        lambda _config: None,
    )

    response = client.post("/api/settings", json={"extra_punctuation_regex": "["})

    assert response.status_code == 400
    assert response.get_json()["error"] == "extra_punctuation_regex must be a valid regex"
