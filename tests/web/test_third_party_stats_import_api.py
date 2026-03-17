import io
import json
from datetime import datetime, timezone

import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.database.third_party_stats_table import ThirdPartyStatsTable
from GameSentenceMiner.web.stats_api import register_stats_api_routes


@pytest.fixture(autouse=True)
def _in_memory_db():
    original_db = ThirdPartyStatsTable._db
    db = SQLiteDB(":memory:")
    ThirdPartyStatsTable.set_db(db)
    yield db
    db.close()
    ThirdPartyStatsTable._db = original_db


@pytest.fixture()
def app(_in_memory_db):
    test_app = flask.Flask(__name__)
    test_app.config["TESTING"] = True

    from GameSentenceMiner.web.third_party_stats_api import (
        register_third_party_stats_routes,
    )

    register_third_party_stats_routes(test_app)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


def _timestamp_ms(year, month, day, hour=0, minute=0, second=0):
    return int(datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc).timestamp() * 1000)


def _timestamp_seconds(year, month, day, hour=0, minute=0, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc).timestamp()


def _reduced_mokuro_export():
    """Small realistic fixture derived from the user's Mokuro export shape."""
    day_one = _timestamp_ms(2025, 12, 17, 17, 20, 0)
    day_two = _timestamp_ms(2025, 12, 19, 5, 31, 0)

    return {
        "abee6196-61b3-44d6-9076-4c2d59d046b9": {
            "progress": 183,
            "chars": 1200,
            "completed": True,
            "timeReadInMinutes": 60,
            "lastProgressUpdate": "2025-12-19T05:31:13.843Z",
            "settings": {"rightToLeft": True, "hasCover": True},
            "recentPageTurns": [
                [day_one, 76, 300],
                [day_one + 60000, 77, 400],
                [day_two, 181, 1000],
                [day_two + 1000, 182, 1200],
            ],
            "series_uuid": "054a8102-c0af-4ba1-93e8-e2d5b8103464",
            "series_title": "やがて君になる",
            "volume_title": "第01巻",
            "addedOn": "2025-12-15T00:00:00.000Z",
        },
        "0a4ca2f8-1eb2-4124-882c-7f2dae042277": {
            "progress": 11,
            "chars": 600,
            "timeReadInMinutes": 30,
            "lastProgressUpdate": "2025-12-29T02:50:36.660Z",
            "settings": {"rightToLeft": True, "hasCover": False},
            "recentPageTurns": [],
            "series_uuid": "74dc24c3-9c81-4662-87e0-8a94e64ae225",
            "series_title": "フリージア",
            "volume_title": "freesia_01",
        },
        "07c2e05e-f352-4eb6-978b-21681e5eb9fe": {
            "lastProgressUpdate": "2026-02-23T01:42:11.273Z",
            "series_uuid": "00da1870-0dc4-4897-a7e6-5a415dec1a12",
            "series_title": "正反対な君と僕",
            "volume_title": "正反対な君と僕 1 - 阿賀沢紅茶",
            "deletedOn": "2026-02-23T01:42:11.273Z",
        },
        "placeholder-abc": {
            "addedOn": "2026-02-23T01:42:50.841Z",
        },
        "empty-volume": {
            "chars": 0,
            "timeReadInMinutes": 0,
            "series_title": "Empty",
            "volume_title": "Vol 0",
        },
    }


def _upload_mokuro(client, payload, *, filename="volume-data.json", clear_previous=False, bom=False):
    content = json.dumps(payload, ensure_ascii=False)
    raw_bytes = content.encode("utf-8")
    if bom:
        raw_bytes = b"\xef\xbb\xbf" + raw_bytes

    return client.post(
        "/api/import-mokuro",
        data={
            "file": (io.BytesIO(raw_bytes), filename),
            "clear_previous": "true" if clear_previous else "false",
        },
        content_type="multipart/form-data",
    )


def _insert_entry(*, date, characters_read, time_read_seconds, source, label):
    entry = ThirdPartyStatsTable(
        date=date,
        characters_read=characters_read,
        time_read_seconds=time_read_seconds,
        source=source,
        label=label,
    )
    entry.save()
    return entry


@pytest.fixture()
def stats_client(_in_memory_db):
    original_games_db = GamesTable._db
    original_lines_db = GameLinesTable._db
    original_rollups_db = StatsRollupTable._db

    GamesTable.set_db(_in_memory_db)
    GameLinesTable.set_db(_in_memory_db)
    StatsRollupTable.set_db(_in_memory_db)

    app = flask.Flask(__name__)
    app.config["TESTING"] = True

    from GameSentenceMiner.web.third_party_stats_api import (
        register_third_party_stats_routes,
    )

    register_third_party_stats_routes(app)
    register_stats_api_routes(app)

    try:
        yield app.test_client()
    finally:
        GamesTable._db = original_games_db
        GameLinesTable._db = original_lines_db
        StatsRollupTable._db = original_rollups_db


class TestImportStatsBatchAPI:
    def test_imports_valid_entries_and_defaults_blank_label_to_source(self, client):
        response = client.post(
            "/api/import-stats",
            json={
                "entries": [
                    {
                        "date": "2025-03-08",
                        "characters_read": 5000,
                        "time_read_seconds": 3600,
                        "source": "ttsu",
                        "label": "Book One",
                    },
                    {
                        "date": "2025-03-09",
                        "characters_read": 2500,
                        "time_read_seconds": 0,
                        "source": "kindle",
                        "label": "   ",
                    },
                ]
            },
        )

        assert response.status_code == 200
        data = response.get_json()
        assert data["imported_count"] == 2
        assert data["total_characters"] == 7500
        assert data["total_time_seconds"] == 3600.0
        assert "warnings" not in data

        entries = ThirdPartyStatsTable.all()
        assert len(entries) == 2
        labels_by_source = {entry.source: entry.label for entry in entries}
        assert labels_by_source["ttsu"] == "Book One"
        assert labels_by_source["kindle"] == "kindle"

    def test_imports_valid_entries_reports_warnings_and_skips_zero_rows(self, client):
        response = client.post(
            "/api/import-stats",
            json={
                "entries": [
                    {
                        "date": "2025-03-08",
                        "characters_read": 1234,
                        "time_read_seconds": 600,
                        "source": "ttsu",
                        "label": "Good Entry",
                    },
                    {
                        "date": "bad-date",
                        "characters_read": 100,
                        "time_read_seconds": 60,
                        "source": "ttsu",
                    },
                    {
                        "date": "2025-03-09",
                        "characters_read": 0,
                        "time_read_seconds": 0,
                        "source": "ttsu",
                    },
                    {
                        "date": "2025-03-10",
                        "characters_read": 10,
                        "time_read_seconds": 5,
                        "source": "   ",
                    },
                ]
            },
        )

        assert response.status_code == 200
        data = response.get_json()
        assert data["imported_count"] == 1
        assert data["total_characters"] == 1234
        assert data["total_time_seconds"] == 600.0
        assert data["skipped_count"] == 2
        assert len(data["warnings"]) == 2

        entries = ThirdPartyStatsTable.all()
        assert len(entries) == 1
        assert entries[0].label == "Good Entry"

    def test_clear_source_removes_existing_entries_for_that_source_only(self, client):
        _insert_entry(
            date="2025-03-01",
            characters_read=100,
            time_read_seconds=10,
            source="ttsu",
            label="Old TTSU 1",
        )
        _insert_entry(
            date="2025-03-02",
            characters_read=200,
            time_read_seconds=20,
            source="ttsu",
            label="Old TTSU 2",
        )
        _insert_entry(
            date="2025-03-03",
            characters_read=300,
            time_read_seconds=30,
            source="kindle",
            label="Keep Kindle",
        )

        response = client.post(
            "/api/import-stats",
            json={
                "clear_source": "ttsu",
                "entries": [
                    {
                        "date": "2025-03-10",
                        "characters_read": 999,
                        "time_read_seconds": 111,
                        "source": "ttsu",
                        "label": "New TTSU",
                    }
                ],
            },
        )

        assert response.status_code == 200
        data = response.get_json()
        assert data["cleared_count"] == 2
        assert data["imported_count"] == 1

        ttsu_entries = ThirdPartyStatsTable.get_all_by_source("ttsu")
        kindle_entries = ThirdPartyStatsTable.get_all_by_source("kindle")
        assert len(ttsu_entries) == 1
        assert ttsu_entries[0].label == "New TTSU"
        assert len(kindle_entries) == 1
        assert kindle_entries[0].label == "Keep Kindle"

    def test_all_invalid_entries_return_400_and_do_not_clear_existing_data(self, client):
        _insert_entry(
            date="2025-03-01",
            characters_read=100,
            time_read_seconds=10,
            source="ttsu",
            label="Existing",
        )

        response = client.post(
            "/api/import-stats",
            json={
                "clear_source": "ttsu",
                "entries": [
                    {
                        "date": "bad-date",
                        "characters_read": 100,
                        "time_read_seconds": 10,
                        "source": "ttsu",
                    },
                    "not-an-object",
                ],
            },
        )

        assert response.status_code == 400
        data = response.get_json()
        assert data["error"] == "All entries failed validation"
        assert len(data["details"]) == 2

        entries = ThirdPartyStatsTable.get_all_by_source("ttsu")
        assert len(entries) == 1
        assert entries[0].label == "Existing"

    def test_rejects_batches_larger_than_limit(self, client):
        response = client.post(
            "/api/import-stats",
            json={
                "entries": [{}] * 50001,
            },
        )

        assert response.status_code == 400
        data = response.get_json()
        assert data["error"] == "Maximum 50000 entries per request"


class TestImportMokuroAPI:
    def test_imports_reduced_realistic_mokuro_export_and_persists_daily_rows(self, client):
        response = _upload_mokuro(client, _reduced_mokuro_export())

        assert response.status_code == 200
        data = response.get_json()
        assert data["imported_count"] == 4
        assert data["cleared_count"] == 0
        assert data["volumes_processed"] == 5
        assert data["volumes_with_data"] == 2
        assert data["total_characters"] == 1800
        assert data["total_time_minutes"] == 90.0
        assert data["date_range"] == {"min": "2025-12-15", "max": "2025-12-29"}
        assert set(data["volumes"]) == {
            "やがて君になる - 第01巻",
            "フリージア - freesia_01",
        }

        entries = ThirdPartyStatsTable.get_all_by_source("mokuro")
        assert [(entry.date, entry.characters_read, entry.time_read_seconds, entry.label) for entry in entries] == [
            ("2025-12-15", 300, 900.0, "やがて君になる - 第01巻"),
            ("2025-12-17", 100, 300.0, "やがて君になる - 第01巻"),
            ("2025-12-19", 800, 2400.0, "やがて君になる - 第01巻"),
            ("2025-12-29", 600, 1800.0, "フリージア - freesia_01"),
        ]

    def test_import_mokuro_can_decode_utf8_bom_files(self, client):
        response = _upload_mokuro(client, _reduced_mokuro_export(), bom=True)

        assert response.status_code == 200
        data = response.get_json()
        assert data["imported_count"] == 4

    def test_clear_previous_removes_only_existing_mokuro_entries(self, client):
        _insert_entry(
            date="2025-01-01",
            characters_read=111,
            time_read_seconds=22,
            source="mokuro",
            label="Old Mokuro A",
        )
        _insert_entry(
            date="2025-01-02",
            characters_read=222,
            time_read_seconds=33,
            source="mokuro",
            label="Old Mokuro B",
        )
        _insert_entry(
            date="2025-01-03",
            characters_read=333,
            time_read_seconds=44,
            source="manual",
            label="Keep Manual",
        )

        response = _upload_mokuro(client, _reduced_mokuro_export(), clear_previous=True)

        assert response.status_code == 200
        data = response.get_json()
        assert data["cleared_count"] == 2
        assert data["imported_count"] == 4

        mokuro_entries = ThirdPartyStatsTable.get_all_by_source("mokuro")
        manual_entries = ThirdPartyStatsTable.get_all_by_source("manual")
        assert len(mokuro_entries) == 4
        assert len(manual_entries) == 1
        assert manual_entries[0].label == "Keep Manual"

    def test_returns_success_with_zero_imports_when_file_has_no_valid_reading_data(self, client):
        response = _upload_mokuro(
            client,
            {
                "deleted-volume": {
                    "series_title": "Deleted",
                    "volume_title": "Vol 1",
                    "deletedOn": "2026-02-23T01:42:11.273Z",
                },
                "placeholder": {"addedOn": "2026-02-23T01:42:50.841Z"},
                "empty-volume": {
                    "series_title": "Empty",
                    "volume_title": "Vol 0",
                    "chars": 0,
                    "timeReadInMinutes": 0,
                },
            },
        )

        assert response.status_code == 200
        data = response.get_json()
        assert data["imported_count"] == 0
        assert data["cleared_count"] == 0
        assert data["volumes_processed"] == 3
        assert data["message"] == "No valid reading data found in the file"
        assert ThirdPartyStatsTable.get_all_by_source("mokuro") == []

    def test_rejects_missing_file_wrong_extension_invalid_json_and_non_object_json(self, client):
        no_file = client.post("/api/import-mokuro", data={}, content_type="multipart/form-data")
        assert no_file.status_code == 400
        assert no_file.get_json()["error"] == "No file provided"

        wrong_extension = _upload_mokuro(
            client,
            _reduced_mokuro_export(),
            filename="volume-data.txt",
        )
        assert wrong_extension.status_code == 400
        assert wrong_extension.get_json()["error"] == "File must be a JSON file"

        invalid_json = client.post(
            "/api/import-mokuro",
            data={
                "file": (io.BytesIO(b"{not valid json"), "volume-data.json"),
            },
            content_type="multipart/form-data",
        )
        assert invalid_json.status_code == 400
        assert "Invalid JSON file" in invalid_json.get_json()["error"]

        non_object = client.post(
            "/api/import-mokuro",
            data={
                "file": (io.BytesIO(b"[]"), "volume-data.json"),
            },
            content_type="multipart/form-data",
        )
        assert non_object.status_code == 400
        assert non_object.get_json()["error"] == "Expected a JSON object with volume UUIDs as keys"


class TestThirdPartyStatsImporterEndToEnd:
    def test_batch_import_flows_through_summary_list_and_stats_endpoint(self, stats_client):
        import_response = stats_client.post(
            "/api/import-stats",
            json={
                "entries": [
                    {
                        "date": "2025-03-08",
                        "characters_read": 5000,
                        "time_read_seconds": 3600,
                        "source": "ttsu",
                        "label": "Book One",
                    },
                    {
                        "date": "2025-03-09",
                        "characters_read": 2500,
                        "time_read_seconds": 1800,
                        "source": "kindle",
                        "label": "Book Two",
                    },
                ]
            },
        )
        assert import_response.status_code == 200

        summary_response = stats_client.get("/api/third-party-stats/summary")
        assert summary_response.status_code == 200
        summary = summary_response.get_json()
        assert summary["total_entries"] == 2
        assert summary["total_characters"] == 7500
        assert summary["total_time_seconds"] == 5400.0
        assert summary["by_source"]["ttsu"] == {
            "count": 1,
            "characters": 5000,
            "time_seconds": 3600.0,
        }
        assert summary["by_source"]["kindle"] == {
            "count": 1,
            "characters": 2500,
            "time_seconds": 1800.0,
        }

        entries_response = stats_client.get("/api/third-party-stats")
        assert entries_response.status_code == 200
        entries_payload = entries_response.get_json()
        assert entries_payload["count"] == 2
        assert {
            (entry["date"], entry["source"], entry["label"], entry["characters_read"])
            for entry in entries_payload["entries"]
        } == {
            ("2025-03-08", "ttsu", "Book One", 5000),
            ("2025-03-09", "kindle", "Book Two", 2500),
        }

        stats_response = stats_client.get(
            "/api/stats",
            query_string={
                "start": _timestamp_seconds(2025, 3, 8, 0, 0, 0),
                "end": _timestamp_seconds(2025, 3, 9, 23, 59, 59),
            },
        )
        assert stats_response.status_code == 200
        stats_payload = stats_response.get_json()
        assert stats_payload["allGamesStats"]["total_characters"] == 7500
        assert stats_payload["allGamesStats"]["total_sentences"] == 0
        assert stats_payload["allGamesStats"]["total_time_hours"] == pytest.approx(1.5)
        assert stats_payload["heatmapData"] == {
            "2025": {
                "2025-03-08": 5000,
                "2025-03-09": 2500,
            }
        }

    def test_mokuro_import_flows_through_summary_list_and_stats_endpoint(self, stats_client):
        import_response = _upload_mokuro(stats_client, _reduced_mokuro_export())
        assert import_response.status_code == 200

        summary_response = stats_client.get("/api/third-party-stats/summary")
        assert summary_response.status_code == 200
        summary = summary_response.get_json()
        assert summary["total_entries"] == 4
        assert summary["total_characters"] == 1800
        assert summary["total_time_seconds"] == 5400.0
        assert summary["by_source"]["mokuro"] == {
            "count": 4,
            "characters": 1800,
            "time_seconds": 5400.0,
        }

        entries_response = stats_client.get("/api/third-party-stats?source=mokuro")
        assert entries_response.status_code == 200
        entries_payload = entries_response.get_json()
        assert entries_payload["count"] == 4
        assert [
            (
                entry["date"],
                entry["characters_read"],
                entry["time_read_seconds"],
                entry["label"],
            )
            for entry in entries_payload["entries"]
        ] == [
            ("2025-12-15", 300, 900.0, "やがて君になる - 第01巻"),
            ("2025-12-17", 100, 300.0, "やがて君になる - 第01巻"),
            ("2025-12-19", 800, 2400.0, "やがて君になる - 第01巻"),
            ("2025-12-29", 600, 1800.0, "フリージア - freesia_01"),
        ]

        stats_response = stats_client.get(
            "/api/stats",
            query_string={
                "start": _timestamp_seconds(2025, 12, 15, 0, 0, 0),
                "end": _timestamp_seconds(2025, 12, 29, 23, 59, 59),
            },
        )
        assert stats_response.status_code == 200
        stats_payload = stats_response.get_json()
        assert stats_payload["allGamesStats"]["total_characters"] == 1800
        assert stats_payload["allGamesStats"]["total_sentences"] == 0
        assert stats_payload["allGamesStats"]["total_time_hours"] == pytest.approx(1.5)
        assert stats_payload["heatmapData"] == {
            "2025": {
                "2025-12-15": 300,
                "2025-12-17": 100,
                "2025-12-19": 800,
                "2025-12-29": 600,
            }
        }
