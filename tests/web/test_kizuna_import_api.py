import csv
import io
from datetime import datetime
from unittest.mock import Mock

import flask
import pytest

from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.database.game_daily_rollup_table import GameDailyRollupTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.database.third_party_stats_table import ThirdPartyStatsTable
from GameSentenceMiner.web.game_profiles import build_game_profiles
from GameSentenceMiner.web.stats_api import register_stats_api_routes
from GameSentenceMiner.web.third_party_stats_api import register_third_party_stats_routes

HEADER = ["vndb_id", "name", "date", "duration_seconds", "chars", "lines"]
SESSIONS = [
    ["v58562", "Le Mirage Mystique", "2025-10-20T16:04:42Z", 682, 2095, 102],
    ["v58562", "Le Mirage Mystique", "2025-10-20T12:09:33Z", 1206, 3540, 190],
    ["v17343", "Yunohana SpRING!", "2025-10-13T17:03:24Z", 9814, 40381, 1867],
    ["", '日本語, "Game"', "2025-10-12T17:58:13+00:00", 60.5, 100, 5],
]


@pytest.fixture()
def import_env(monkeypatch):
    tables = (GameLinesTable, GamesTable, StatsRollupTable, GameDailyRollupTable, ThirdPartyStatsTable)
    originals = {table: table._db for table in tables}
    db = SQLiteDB(":memory:")
    for table in tables:
        table.set_db(db)
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    register_third_party_stats_routes(app)
    register_stats_api_routes(app)
    from GameSentenceMiner.util.cron import cron_scheduler

    refresh = Mock()
    monkeypatch.setattr(cron_scheduler, "force_jiten_sync", refresh)
    yield app.test_client(), refresh
    db.close()
    for table, original in originals.items():
        table._db = original
    GamesTable.clear_name_id_cache()


def upload(client, rows=SESSIONS, *, filename="kizuna-export.csv", clear_previous=False, raw=None):
    if raw is None:
        content = io.StringIO(newline="")
        writer = csv.writer(content)
        writer.writerow(HEADER)
        writer.writerows(rows)
        raw = content.getvalue().encode("utf-8-sig")
    return client.post(
        "/api/import-kizuna",
        data={"file": (io.BytesIO(raw), filename), "clear_previous": str(clear_previous).lower()},
    )


def test_import_preserves_session_totals_and_links_games_before_queuing_metadata(import_env):
    client, refresh = import_env

    def check_committed_import():
        assert len(ThirdPartyStatsTable.all()) == 4
        assert len(GamesTable.all()) == 3

    refresh.side_effect = check_committed_import
    response = upload(client)
    assert response.status_code == 200
    data = response.get_json()
    assert data["imported_count"] == 4
    assert data["games_count"] == 3
    assert data["total_characters"] == 46116
    assert data["total_lines"] == 2164
    assert data["total_time_seconds"] == 11762.5
    assert data["metadata_refresh_status"] == "queued"
    refresh.assert_called_once_with()
    assert GameLinesTable.all() == []
    entries = ThirdPartyStatsTable.get_all_by_source("kizuna")
    assert all(entry.game_id and entry.source_id for entry in entries)
    assert sum(entry.lines_read for entry in entries) == 2164
    first = next(entry for entry in entries if entry.characters_read == 2095)
    expected_timestamp = datetime.fromisoformat("2025-10-20T16:04:42+00:00").timestamp()
    assert first.timestamp == expected_timestamp
    assert first.date == datetime.fromtimestamp(expected_timestamp).astimezone().date().isoformat()
    assert GamesTable.get(first.game_id).vndb_id == "v58562"
    assert GamesTable.get(first.game_id).type == "Visual Novel"
    assert GamesTable.get_by_title('日本語, "Game"').vndb_id == ""


def test_reimport_skips_duplicates_even_after_metadata_renames_game(import_env):
    client, refresh = import_env
    assert upload(client).status_code == 200
    game = GamesTable.get_by_title("Le Mirage Mystique")
    game.title_original = "Metadata title"
    game.save()
    response = upload(client)
    assert response.status_code == 200
    assert response.json["imported_count"] == 0
    assert response.json["skipped_count"] == 4
    assert response.json["metadata_refresh_status"] == "not_needed"
    assert len(ThirdPartyStatsTable.all()) == 4
    assert len(GamesTable.all()) == 3
    assert refresh.call_count == 1


def test_matches_existing_vndb_game_and_preserves_metadata(import_env):
    client, _ = import_env
    existing = GamesTable(title_original="既存タイトル", vndb_id="v58562", description="Keep this", completed=True)
    existing.save()
    assert upload(client, SESSIONS[:1]).status_code == 200
    entry = ThirdPartyStatsTable.all()[0]
    assert entry.game_id == existing.id
    assert len(GamesTable.all()) == 1
    game = GamesTable.get(existing.id)
    assert game.description == "Keep this"
    assert game.title_original == "既存タイトル"
    assert game.completed is True


def test_same_title_with_different_vndb_id_is_not_merged(import_env):
    client, _ = import_env
    existing = GamesTable(title_original="Le Mirage Mystique", vndb_id="v1")
    existing.save()
    assert upload(client, SESSIONS[:1]).status_code == 200
    assert ThirdPartyStatsTable.all()[0].game_id != existing.id
    assert GamesTable.get(existing.id).vndb_id == "v1"


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"name,date,chars\nGame,2025-10-20,100\n",
        b"vndb_id,name,date,duration_seconds,chars,lines\n",
        b"\xff\xfeinvalid",
        b'vndb_id,name,date,duration_seconds,chars,lines\nv1,"unclosed',
    ],
)
def test_invalid_file_does_not_clear_existing_data(import_env, raw):
    client, refresh = import_env
    entry = ThirdPartyStatsTable(source="kizuna", date="2025-01-01", characters_read=123)
    entry.save()
    response = upload(client, raw=raw, clear_previous=True)
    assert response.status_code == 400
    assert response.json["error"]
    assert ThirdPartyStatsTable.get(entry.id).characters_read == 123
    assert GamesTable.all() == []
    refresh.assert_not_called()


@pytest.mark.parametrize(
    ("column", "value"),
    [(0, "invalid"), (1, ""), (2, "bad date"), (3, "nan"), (3, "inf"), (3, "-1"), (4, "-1"), (4, "1.5"), (5, "bad")],
)
def test_validates_every_row_before_importing_any(import_env, column, value):
    client, refresh = import_env
    invalid = SESSIONS[0].copy()
    invalid[column] = value
    response = upload(client, [SESSIONS[1], invalid])
    assert response.status_code == 400
    assert "Row 3" in response.json["error"]
    assert ThirdPartyStatsTable.all() == []
    assert GamesTable.all() == []
    refresh.assert_not_called()


def test_clear_previous_only_replaces_kizuna_entries(import_env):
    client, _ = import_env
    assert upload(client).status_code == 200
    other = ThirdPartyStatsTable(source="manual", date="2025-01-01", characters_read=123)
    other.save()
    response = upload(client, SESSIONS[:1], clear_previous=True)
    assert response.status_code == 200
    assert response.json["cleared_count"] == 4
    assert len(ThirdPartyStatsTable.get_all_by_source("kizuna")) == 1
    assert ThirdPartyStatsTable.get(other.id).characters_read == 123


def test_database_error_rolls_back_clearing_games_and_sessions(import_env, monkeypatch):
    client, refresh = import_env
    original = ThirdPartyStatsTable(source="kizuna", date="2025-01-01", characters_read=123)
    original.save()
    save = ThirdPartyStatsTable.save

    def fail_second(entry):
        if entry.characters_read == 3540:
            raise RuntimeError("simulated write failure")
        return save(entry)

    monkeypatch.setattr(ThirdPartyStatsTable, "save", fail_second)
    response = upload(client, clear_previous=True)
    assert response.status_code == 500
    assert len(ThirdPartyStatsTable.all()) == 1
    assert ThirdPartyStatsTable.get(original.id).characters_read == 123
    assert GamesTable.all() == []
    refresh.assert_not_called()


def test_metadata_queue_failure_does_not_undo_import(import_env):
    client, refresh = import_env
    refresh.side_effect = RuntimeError("queue unavailable")
    response = upload(client)
    assert response.status_code == 200
    assert response.json["metadata_refresh_status"] == "failed"
    assert len(ThirdPartyStatsTable.all()) == 4


def test_imported_activity_appears_in_global_game_stats_and_profiles(import_env):
    client, _ = import_env
    assert upload(client).status_code == 200
    game = GamesTable.get_by_title("Le Mirage Mystique")
    response = client.get(f"/api/game/{game.id}/stats")
    assert response.status_code == 200
    stats = response.json["stats"]
    assert stats["total_characters"] == 5635
    assert stats["total_sentences"] == 292
    assert stats["total_time_hours"] == round(1888 / 3600, 2)
    assert response.json["dailySpeed"]["charsData"] == [5635]
    profile = build_game_profiles()[game.id]
    assert profile.character_count == 5635
    assert profile.line_count == 292

    global_response = client.get("/api/stats?include_tokenization=false")
    assert global_response.status_code == 200
    data = global_response.json
    assert data["allGamesStats"]["total_characters"] == 46116
    assert data["allGamesStats"]["total_sentences"] == 2164
    assert data["allGamesStats"]["sessions"] == 4
    per_game = dict(zip(data["totalCharsPerGame"]["labels"], data["totalCharsPerGame"]["totals"]))
    assert per_game[game.title_original] == 5635


def test_import_totals_survive_rollup_rebuild_and_mix_with_native_activity(import_env):
    client, _ = import_env
    assert upload(client, SESSIONS[:1]).status_code == 200
    game = GamesTable.get_by_title("Le Mirage Mystique")
    date = ThirdPartyStatsTable.all()[0].date
    timestamp = ThirdPartyStatsTable.all()[0].timestamp
    for i in range(2):
        GameLinesTable(
            id=f"native-{i}",
            game_name=game.title_original,
            game_id=game.id,
            line_text="文" * 100,
            timestamp=timestamp + i * 30,
        ).save()
    StatsRollupTable(date=date, total_characters=200, total_lines=2, total_reading_time_seconds=30).save()
    GameDailyRollupTable(
        date=date, game_id=game.id, total_characters=200, total_lines=2, total_reading_time_seconds=30
    ).save()
    response = client.get(f"/api/game/{game.id}/stats")
    assert response.json["stats"]["total_characters"] == 2295
    assert response.json["stats"]["total_sentences"] == 104
    assert response.json["dailySpeed"]["speedData"] == [int(2295 * 3600 / 712)]

    from GameSentenceMiner.util.cron.daily_rollup import replace_rollup_for_date

    replace_rollup_for_date(date)
    response = client.get(f"/api/game/{game.id}/stats")
    assert response.json["stats"]["total_characters"] == 2295
    assert response.json["stats"]["total_sentences"] == 104


def test_requires_csv_upload(import_env):
    client, refresh = import_env
    assert client.post("/api/import-kizuna").status_code == 400
    assert upload(client, filename="kizuna.json").status_code == 400
    refresh.assert_not_called()


def test_existing_external_stats_schema_migrates_without_changing_data(import_env):
    client, _ = import_env
    db = ThirdPartyStatsTable._db
    db.execute("DROP TABLE third_party_stats", commit=True)
    db.execute(
        "CREATE TABLE third_party_stats (id INTEGER PRIMARY KEY, date TEXT, characters_read TEXT, "
        "time_read_seconds TEXT, source TEXT, label TEXT, created_at TEXT)",
        commit=True,
    )
    db.execute(
        "INSERT INTO third_party_stats VALUES (1, '2025-01-01', '123', '60', 'manual', 'Existing', '1')",
        commit=True,
    )
    ThirdPartyStatsTable.set_db(db)
    legacy = ThirdPartyStatsTable.get(1)
    assert legacy.characters_read == 123
    assert legacy.lines_read == 0
    assert legacy.game_id == ""
    assert legacy.source_id == ""
    assert ThirdPartyStatsTable.aggregate_by_date("2025-01-01", "2025-01-01") == {
        "2025-01-01": {"characters": 123, "time_seconds": 60.0}
    }
    assert upload(client).status_code == 200
    assert ThirdPartyStatsTable.get(1).characters_read == 123
