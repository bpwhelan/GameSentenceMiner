from __future__ import annotations

import csv
import datetime
import io
import json
import time

import flask
import pytest

from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.database.game_daily_rollup_table import (
    GameDailyRollupTable,
)
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.database.stats_export_state_table import (
    StatsExportStateTable,
)
from GameSentenceMiner.util.database.third_party_stats_table import (
    ThirdPartyStatsTable,
)
from GameSentenceMiner.web.stats_export_api import register_stats_export_api_routes


@pytest.fixture(autouse=True)
def _in_memory_db():
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    orig_export_state = StatsExportStateTable._db
    orig_game_daily = GameDailyRollupTable._db
    orig_third_party = ThirdPartyStatsTable._db

    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    StatsExportStateTable.set_db(db)
    GameDailyRollupTable.set_db(db)
    ThirdPartyStatsTable.set_db(db)

    yield db

    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_stats
    StatsExportStateTable._db = orig_export_state
    GameDailyRollupTable._db = orig_game_daily
    ThirdPartyStatsTable._db = orig_third_party


@pytest.fixture()
def app(_in_memory_db):
    test_app = flask.Flask(__name__)
    test_app.config["TESTING"] = True
    register_stats_export_api_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


def _parse_csv_response(response) -> list[dict[str, str]]:
    decoded = response.get_data(as_text=True).lstrip("\ufeff")
    return list(csv.DictReader(io.StringIO(decoded)))


def _wait_for_job_completion(client, job_id: str, timeout_seconds: float = 5.0) -> dict:
    deadline = time.time() + timeout_seconds
    last_payload = None

    while time.time() < deadline:
        resp = client.get(f"/api/stats-export/jobs/{job_id}")
        assert resp.status_code == 200
        payload = resp.get_json()
        last_payload = payload
        if payload["status"] in {"completed", "failed"}:
            return payload
        time.sleep(0.05)

    raise AssertionError(f"Export job {job_id} did not complete in time. Last payload: {last_payload}")


def test_stats_export_formats_endpoint_lists_kechimochi(client):
    response = client.get("/api/stats-export/formats")

    assert response.status_code == 200
    payload = response.get_json()

    assert payload["formats"]
    format_ids = {fmt["id"] for fmt in payload["formats"]}
    assert "kechimochi" in format_ids
    assert "kechimochi_library" in format_ids

    library_format = next(fmt for fmt in payload["formats"] if fmt["id"] == "kechimochi_library")
    assert "Media Library" in library_format["label"]
    assert library_format["supports_date_range"] is False
    assert library_format["supports_external_stats"] is False


def test_stats_export_job_builds_kechimochi_csv_from_native_and_external_stats(client):
    today = datetime.date.today()
    yesterday = today - datetime.timedelta(days=1)

    game = GamesTable(
        id="game-vn",
        title_original="Tsukihime",
        game_type="Visual Novel",
    )
    game.save()

    GameDailyRollupTable(
        date=yesterday.isoformat(),
        game_id=game.id,
        total_characters=1200,
        total_lines=12,
        total_reading_time_seconds=1800,
    ).save()

    noon_ts = datetime.datetime.combine(today, datetime.time(hour=12)).timestamp()
    GameLinesTable(
        id="line-1",
        game_name="Tsukihime Scene",
        game_id=game.id,
        line_text="あいうえお",
        timestamp=noon_ts,
        language="ja",
    ).save()
    GameLinesTable(
        id="line-2",
        game_name="Tsukihime Scene",
        game_id=game.id,
        line_text="かきくけこ",
        timestamp=noon_ts + 60,
        language="ja",
    ).save()

    ThirdPartyStatsTable(
        date=yesterday.isoformat(),
        characters_read=900,
        time_read_seconds=1500,
        source="mokuro",
        label="Frieren Vol. 1",
    ).save()

    start_response = client.post(
        "/api/stats-export/jobs",
        json={
            "format": "kechimochi",
            "scope": "all_time",
            "include_external_stats": True,
        },
    )

    assert start_response.status_code == 202
    start_payload = start_response.get_json()
    assert start_payload["status"] in {"queued", "running", "completed"}
    assert start_payload["job_id"]

    final_payload = _wait_for_job_completion(client, start_payload["job_id"])
    assert final_payload["status"] == "completed"
    assert final_payload["progress"] == 100
    assert final_payload["download_url"].endswith("/download")

    download_response = client.get(final_payload["download_url"])

    assert download_response.status_code == 200
    assert download_response.mimetype == "text/csv"

    rows = _parse_csv_response(download_response)
    assert len(rows) == 3

    native_historical = next(
        row for row in rows if row["Log Name"] == "Tsukihime" and row["Date"] == yesterday.isoformat()
    )
    assert native_historical["Media Type"] == "Playing"
    assert native_historical["Activity Type"] == "Visual Novel"
    assert native_historical["Duration"] == "30"
    assert native_historical["Characters"] == "1200"

    native_today = next(row for row in rows if row["Log Name"] == "Tsukihime" and row["Date"] == today.isoformat())
    assert native_today["Media Type"] == "Playing"
    assert native_today["Activity Type"] == "Visual Novel"
    assert native_today["Characters"] == "10"

    external_row = next(row for row in rows if row["Log Name"] == "Frieren Vol. 1")
    assert external_row["Media Type"] == "Reading"
    assert external_row["Activity Type"] == "Book"
    assert external_row["Duration"] == "25"
    assert external_row["Characters"] == "900"


def test_stats_export_job_rejects_unknown_format(client):
    response = client.post(
        "/api/stats-export/jobs",
        json={
            "format": "missing-format",
            "scope": "all_time",
        },
    )

    assert response.status_code == 400
    assert "Unsupported export format" in response.get_json()["error"]


def test_since_last_export_returns_only_new_data_after_previous_success(client):
    today = datetime.date.today()
    yesterday = today - datetime.timedelta(days=1)

    game = GamesTable(
        id="game-vn",
        title_original="Tsukihime",
        game_type="Visual Novel",
    )
    game.save()

    historical_rollup = GameDailyRollupTable(
        date=yesterday.isoformat(),
        game_id=game.id,
        total_characters=1200,
        total_lines=12,
        total_reading_time_seconds=1800,
    )
    historical_rollup.save()

    old_line_ts = datetime.datetime.combine(today, datetime.time(hour=10)).timestamp()
    old_line = GameLinesTable(
        id="line-old",
        game_name="Tsukihime Scene",
        game_id=game.id,
        line_text="あいうえお",
        timestamp=old_line_ts,
        language="ja",
    )
    old_line.save()

    old_external = ThirdPartyStatsTable(
        date=yesterday.isoformat(),
        characters_read=900,
        time_read_seconds=1500,
        source="mokuro",
        label="Frieren Vol. 1",
    )
    old_external.save()

    first_export_response = client.post(
        "/api/stats-export/jobs",
        json={
            "format": "kechimochi",
            "scope": "all_time",
            "include_external_stats": True,
        },
    )
    assert first_export_response.status_code == 202
    first_job = _wait_for_job_completion(client, first_export_response.get_json()["job_id"])
    assert first_job["status"] == "completed"

    state = StatsExportStateTable.get("kechimochi")
    assert state is not None
    cutoff = float(state.last_successful_export_at)

    historical_rollup.total_characters = 1500
    historical_rollup.total_lines = 15
    historical_rollup.total_reading_time_seconds = 2400
    historical_rollup.updated_at = cutoff + 10
    historical_rollup.save()

    new_line_ts = datetime.datetime.combine(today, datetime.time(hour=13)).timestamp()
    new_line = GameLinesTable(
        id="line-new",
        game_name="Tsukihime Scene",
        game_id=game.id,
        line_text="さしすせそ",
        timestamp=new_line_ts,
        language="ja",
        last_modified=cutoff + 20,
    )
    new_line.save()

    new_external = ThirdPartyStatsTable(
        date=today.isoformat(),
        characters_read=600,
        time_read_seconds=1200,
        source="mokuro",
        label="Sousou no Frieren Vol. 2",
        created_at=cutoff + 30,
    )
    new_external.save()

    incremental_response = client.post(
        "/api/stats-export/jobs",
        json={
            "format": "kechimochi",
            "scope": "since_last_export",
            "include_external_stats": True,
        },
    )

    assert incremental_response.status_code == 202
    incremental_job = _wait_for_job_completion(client, incremental_response.get_json()["job_id"])
    assert incremental_job["status"] == "completed"

    download_response = client.get(incremental_job["download_url"])
    rows = _parse_csv_response(download_response)

    assert len(rows) == 2
    assert {row["Log Name"] for row in rows} == {"Tsukihime", "Sousou no Frieren Vol. 2"}
    native_row = next(row for row in rows if row["Log Name"] == "Tsukihime")
    assert native_row["Date"] == today.isoformat()
    assert native_row["Characters"] == "5"
    external_row = next(row for row in rows if row["Log Name"] == "Sousou no Frieren Vol. 2")
    assert external_row["Date"] == today.isoformat()
    assert external_row["Characters"] == "600"


def test_since_last_export_falls_back_to_all_time_when_no_previous_export(client):
    today = datetime.date.today()
    game = GamesTable(
        id="game-fallback",
        title_original="Fallback Game",
        game_type="Visual Novel",
    )
    game.save()

    line = GameLinesTable(
        id="line-fallback",
        game_name="Fallback Scene",
        game_id=game.id,
        line_text="あいうえお",
        timestamp=datetime.datetime.combine(today, datetime.time(hour=12)).timestamp(),
        language="ja",
    )
    line.save()

    response = client.post(
        "/api/stats-export/jobs",
        json={
            "format": "kechimochi",
            "scope": "since_last_export",
            "include_external_stats": False,
        },
    )

    assert response.status_code == 202
    payload = _wait_for_job_completion(client, response.get_json()["job_id"])
    assert payload["status"] == "completed"
    assert "all-time" in payload["message"].lower()

    download_response = client.get(payload["download_url"])
    rows = _parse_csv_response(download_response)
    assert len(rows) == 1
    assert rows[0]["Log Name"] == "Fallback Game"


def test_stats_export_job_builds_kechimochi_media_library_csv_from_games(client):
    completed_game = GamesTable(
        id="game-library-complete",
        title_original="Tsukihime",
        title_english="Tsukihime - A piece of blue glass moon",
        game_type="Visual Novel",
        description="Classic VN remake.",
        image="data:image/png;base64,ZmFrZV9jb3Zlcg==",
        completed=True,
        deck_id=42,
        obs_scene_name="Tsukihime Scene",
        vndb_id="v7",
        genres=["Mystery"],
        tags=["Remake"],
        links=[
            {
                "url": "https://vndb.org/v7",
                "linkType": 1,
                "deckId": 42,
            },
            {
                "url": "https://jiten.moe/decks/media/42/detail",
                "linkType": 99,
                "deckId": 42,
            },
        ],
    )
    completed_game.save()

    not_started_game = GamesTable(
        id="game-library-planned",
        title_original="Sousou no Frieren",
        game_type="Anime",
        description="",
        image="",
        completed=False,
        anilist_id="52991",
    )
    not_started_game.save()

    response = client.post(
        "/api/stats-export/jobs",
        json={
            "format": "kechimochi_library",
            "scope": "all_time",
            "include_external_stats": True,
        },
    )

    assert response.status_code == 202
    payload = _wait_for_job_completion(client, response.get_json()["job_id"])
    assert payload["status"] == "completed"

    download_response = client.get(payload["download_url"])
    assert download_response.status_code == 200

    rows = _parse_csv_response(download_response)
    assert len(rows) == 2

    completed_row = next(row for row in rows if row["Title"] == "Tsukihime")
    assert completed_row["Media Type"] == "Playing"
    assert completed_row["Status"] == "Complete"
    assert completed_row["Description"] == "Classic VN remake."
    assert completed_row["Content Type"] == "Visual Novel"
    assert completed_row["Cover Image (Base64)"] == "ZmFrZV9jb3Zlcg=="
    assert '"vNDB_ID": "v7"' in completed_row["Extra Data"]
    assert '"deck_id": 42' in completed_row["Extra Data"]
    completed_extra_data = json.loads(completed_row["Extra Data"])
    assert completed_extra_data["links"] == [
        "https://vndb.org/v7",
        "https://jiten.moe/decks/media/42/detail",
    ]

    planned_row = next(row for row in rows if row["Title"] == "Sousou no Frieren")
    assert planned_row["Media Type"] == "Watching"
    assert planned_row["Status"] == "Not Started"
    assert planned_row["Content Type"] == "Anime"
    assert planned_row["Cover Image (Base64)"] == ""
    assert '"aniList_ID": "52991"' in planned_row["Extra Data"]
