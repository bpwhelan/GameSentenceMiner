# Fixtures deliberately use GSM's local calendar and timestamps.
# ruff: noqa: DTZ001, DTZ011

from __future__ import annotations

import copy
import datetime as dt
import json
import os
import subprocess
import sys
import time
import uuid
import zlib
from types import SimpleNamespace
from unittest.mock import Mock

import flask
import pytest
import requests

from GameSentenceMiner.util.config.configuration import StatsConfig
from GameSentenceMiner.util.database.db import CronTable, GameLinesTable, SQLiteDB, StatsRollupTable
from GameSentenceMiner.util.database.game_daily_rollup_table import GameDailyRollupTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.kechimochi_sync_state import KechimochiSyncState
from GameSentenceMiner.util.database.third_party_stats_table import ThirdPartyStatsTable
from GameSentenceMiner.util.kechimochi_client import KechimochiClient, KechimochiSyncError, normalize_kechimochi_url
from GameSentenceMiner.util.kechimochi_sync import build_kechimochi_snapshot, run_kechimochi_sync, run_state_key


@pytest.fixture(autouse=True)
def database(monkeypatch):
    tables = (GameLinesTable, GamesTable, GameDailyRollupTable, ThirdPartyStatsTable, CronTable, StatsRollupTable)
    originals = {table: table._db for table in tables}
    db = SQLiteDB(":memory:")
    for table in tables:
        # Restore this baseline after any database patches made by the test itself.
        monkeypatch.setattr(table, "_db", table._db)
        table.set_db(db)
    db.execute(
        "CREATE TABLE IF NOT EXISTS game_lines_sync_changes "
        "(line_id TEXT PRIMARY KEY, change_type TEXT NOT NULL, changed_at REAL NOT NULL)",
        commit=True,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.util.kechimochi_sync.get_config",
        lambda: SimpleNamespace(general=SimpleNamespace(get_target_language_name=lambda: "Japanese")),
    )
    yield db
    db.close()
    for table, original in originals.items():
        table.set_db(original, ensure_schema=False)


def config(**kwargs):
    return StatsConfig(**kwargs)


def line(line_id, game_id, date, text, seconds=0):
    timestamp = dt.datetime.fromisoformat(date).replace(hour=12).timestamp() + seconds
    GameLinesTable(
        id=line_id, game_id=game_id, game_name="Scene", line_text=text, timestamp=timestamp, language="ja"
    ).save()


class Remote:
    def __init__(self):
        self.media = []
        self.logs = []
        self.writes = []
        self.lose_next_log_response = False

    def get_media(self):
        return copy.deepcopy(self.media)

    def get_logs(self):
        return copy.deepcopy(self.logs)

    def save_media(self, payload, media_id=None):
        self.writes.append(("media", media_id))
        if media_id is None:
            media_id = max((row["id"] for row in self.media), default=0) + 1
            self.media.append({**copy.deepcopy(payload), "id": media_id, "uid": f"uid-{media_id}"})
        else:
            self.media[:] = [
                {**copy.deepcopy(payload), "id": media_id} if row["id"] == media_id else row for row in self.media
            ]
        return media_id

    def save_log(self, payload, log_id=None):
        self.writes.append(("log", log_id))
        if log_id is None:
            log_id = max((row["id"] for row in self.logs), default=0) + 1
            self.logs.append({**copy.deepcopy(payload), "id": log_id})
        else:
            self.logs[:] = [
                {**copy.deepcopy(payload), "id": log_id} if row["id"] == log_id else row for row in self.logs
            ]
        if self.lose_next_log_response:
            self.lose_next_log_response = False
            raise KechimochiSyncError("Connection lost after commit")
        return log_id

    def delete_log(self, log_id):
        self.writes.append(("delete", log_id))
        self.logs[:] = [row for row in self.logs if row["id"] != log_id]


def test_snapshot_backfills_raw_gaps_rollup_only_history_and_external_stats():
    GamesTable(id="game", title_original="Game", game_type="Visual Novel").save()
    GameDailyRollupTable(date="2019-01-01", game_id="game", total_characters=100, total_reading_time_seconds=120).save()
    line("old", "game", "2020-01-01", "日本語")
    line("new", "game", dt.date.today().isoformat(), "日本語日本語")
    ThirdPartyStatsTable(
        date="2018-01-01", characters_read=20, time_read_seconds=60, source="mokuro", label="Book"
    ).save()

    snapshot = build_kechimochi_snapshot(config=config())

    assert {row["date"] for row in snapshot.logs.values()} == {
        "2018-01-01",
        "2019-01-01",
        "2020-01-01",
        dt.date.today().isoformat(),
    }
    assert sum(row["characters"] for row in snapshot.logs.values()) == 129
    assert sum(row["duration_minutes"] for row in snapshot.logs.values()) == 3


def test_live_stats_replace_stale_rollup_without_double_counting():
    GamesTable(id="game", title_original="Game").save()
    GameDailyRollupTable(date="2020-01-01", game_id="game", total_characters=999).save()
    line("old", "game", "2020-01-01", "日本語")
    snapshot = build_kechimochi_snapshot(config=config())
    assert sum(row["characters"] for row in snapshot.logs.values()) == 3


def test_full_sync_is_idempotent_and_corrects_historical_edits():
    GamesTable(id="game", title_original="Original", game_type="Visual Novel").save()
    line("old", "game", "2020-01-01", "日本語")
    remote = Remote()
    first = run_kechimochi_sync(config=config(), client=remote)
    assert first["logs_created"] == 1
    original_id = remote.logs[0]["id"]
    remote.writes.clear()
    run_kechimochi_sync(config=config(), client=remote)
    assert remote.writes == []

    line("old", "game", "2020-01-01", "日本語日本語")
    game = GamesTable.get("game")
    game.title_original = "Renamed"
    game.save()
    result = run_kechimochi_sync(config=config(), client=remote)
    assert result["logs_updated"] == 1
    assert remote.logs[0]["id"] == original_id
    assert remote.logs[0]["characters"] == 6
    assert remote.media[0]["title"] == "Renamed"


def test_retry_after_ambiguous_post_recovers_remote_marker_without_duplicate():
    GamesTable(id="game", title_original="Game").save()
    line("old", "game", "2020-01-01", "日本語")
    remote = Remote()
    remote.lose_next_log_response = True
    with pytest.raises(KechimochiSyncError):
        run_kechimochi_sync(config=config(), client=remote)
    assert len(remote.logs) == 1
    result = run_kechimochi_sync(config=config(), client=remote)
    assert result["logs_created"] == 0
    assert len(remote.logs) == 1


def test_deletions_remove_only_gsm_logs_and_do_not_resurrect_stale_rollups(database):
    GamesTable(id="game", title_original="Game").save()
    GameDailyRollupTable(date="2020-01-01", game_id="game", total_characters=3).save()
    line("old", "game", "2020-01-01", "日本語")
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    remote.logs.append({**remote.logs[0], "id": 999, "notes": "My own log"})
    database.execute("DELETE FROM game_lines WHERE id='old'", commit=True)
    result = run_kechimochi_sync(config=config(), client=remote)
    assert result["logs_deleted"] == 1
    assert [row["id"] for row in remote.logs] == [999]
    assert len(remote.media) == 1


def test_separate_databases_and_same_title_games_keep_distinct_ownership():
    for game_id in ("one", "two"):
        GamesTable(id=game_id, title_original="Same title").save()
        line(game_id, game_id, "2020-01-01", "日本語")
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    assert len(remote.media) == 2
    assert len({(row["title"], row["variant"]) for row in remote.media}) == 2
    assert len(remote.logs) == 2


def test_state_lock_rejects_overlapping_syncs_and_releases_after_failure():
    state = KechimochiSyncState()
    with state.sync_lock(), pytest.raises(KechimochiSyncError, match="already"):
        run_kechimochi_sync(config=config(), client=Remote())
    assert run_kechimochi_sync(config=config(), client=Remote())["success"] is True


def test_archived_and_live_events_on_same_day_are_combined(database):
    from GameSentenceMiner.util.database.game_archive import ensure_archive_schema

    ensure_archive_schema(database)
    GamesTable(id="game", title_original="Game").save()
    timestamp = dt.datetime(2020, 1, 1, 12).timestamp()
    database.execute(
        "INSERT INTO archived_game_days VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "game",
            "2020-01-01",
            "Scene",
            zlib.compress(json.dumps([[timestamp, 30, 0, 0, 30, False, "archived"]]).encode()),
            "{}",
            "{}",
            1,
            1,
            30,
            timestamp,
            timestamp,
            0,
            "{}",
        ),
        commit=True,
    )
    line("live", "game", "2020-01-01", "日" * 60, seconds=60)
    GameDailyRollupTable(date="2020-01-01", game_id="game", total_characters=999).save()
    snapshot = build_kechimochi_snapshot(config=config())
    assert len(snapshot.logs) == 1
    assert next(iter(snapshot.logs.values()))["characters"] == 90
    assert snapshot.summary()["duration_minutes"] == 1


def test_unlinked_history_and_unplayed_library_are_included():
    GamesTable(id="planned", title_original="Planned", status="planned").save()
    line("unlinked", "", "2017-01-01", "日本語")
    snapshot = build_kechimochi_snapshot(config=config())
    assert {row["title"] for row in snapshot.media.values()} == {"Planned", "Scene"}
    assert snapshot.media["game:planned"]["tracking_status"] == "Not Started"
    assert snapshot.summary()["first_date"] == "2017-01-01"


def test_external_corrections_and_opt_out_reconcile_owned_logs():
    entry = ThirdPartyStatsTable(
        date="2018-01-01", characters_read=20, time_read_seconds=60, source="manual", label="Book"
    )
    entry.save()
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    log_id = remote.logs[0]["id"]
    entry.date = "2018-01-02"
    entry.characters_read = 40
    entry.save()
    run_kechimochi_sync(config=config(), client=remote)
    assert len(remote.logs) == 1
    assert remote.logs[0]["id"] == log_id
    assert remote.logs[0]["date"] == "2018-01-02"
    assert remote.logs[0]["characters"] == 40
    result = run_kechimochi_sync(config=config(kechimochi_include_external_stats=False), client=remote)
    assert result["logs_deleted"] == 1


@pytest.mark.parametrize(
    "game_type,legacy_label",
    [("Visual Novel", "Visual Novel"), ("RPG", "RPG"), ("Game", "Game"), ("web novel", "Web Novel")],
)
def test_opt_in_adopts_unchanged_csv_import_and_preserves_user_notes(game_type, legacy_label):
    GamesTable(id="game", title_original="Game", game_type=game_type).save()
    line("old", "game", "2020-01-01", "日本語")
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    extra = json.loads(remote.media[0]["extra_data"])
    extra.pop("gsm_sync")
    extra["my_rating"] = 10
    remote.media[0]["extra_data"] = json.dumps(extra)
    remote.logs[0]["notes"] = ""
    remote.logs[0]["activity_type"] = legacy_label
    imported_id = remote.logs[0]["id"]
    result = run_kechimochi_sync(config=config(kechimochi_adopt_matching_logs=True), client=remote)
    assert result["logs_adopted"] == 1
    assert len(remote.logs) == 1
    assert remote.logs[0]["id"] == imported_id
    assert json.loads(remote.media[0]["extra_data"])["my_rating"] == 10
    remote.logs[0]["notes"] += "\nMy review"
    run_kechimochi_sync(config=config(), client=remote)
    assert "My review" in remote.logs[0]["notes"]


def test_ambiguous_imports_fail_without_deleting_existing_logs():
    GamesTable(id="game", title_original="Game").save()
    line("old", "game", "2020-01-01", "日本語")
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    remote.logs[0]["notes"] = ""
    remote.logs.append({**remote.logs[0], "id": 2})
    with pytest.raises(KechimochiSyncError, match="Multiple existing"):
        run_kechimochi_sync(config=config(kechimochi_adopt_matching_logs=True), client=remote)
    assert len(remote.logs) == 2


def test_another_gsm_database_does_not_claim_or_delete_foreign_entries():
    GamesTable(id="game", title_original="Game").save()
    line("old", "game", "2020-01-01", "日本語")
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    KechimochiSyncState().put("source_id", "a" * 32)
    run_kechimochi_sync(config=config(), client=remote)
    assert len(remote.logs) == len(remote.media) == 2
    assert remote.logs[0]["media_id"] != remote.logs[1]["media_id"]


def test_failure_retains_last_success_and_destination_has_independent_status():
    GamesTable(id="game", title_original="Game").save()
    line("old", "game", "2020-01-01", "日本語")
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    state = KechimochiSyncState()
    key = run_state_key(config().kechimochi_url)
    succeeded_at = state.get(key)["last_success_at"]
    line("new", "game", "2020-01-02", "日本語")
    remote.lose_next_log_response = True
    with pytest.raises(KechimochiSyncError):
        run_kechimochi_sync(config=config(), client=remote)
    assert state.get(key)["status"] == "failed"
    assert state.get(key)["last_success_at"] == succeeded_at
    assert state.get(run_state_key("http://127.0.0.1:9999")) is None


def test_missing_remote_records_are_recreated():
    GamesTable(id="game", title_original="Game").save()
    line("old", "game", "2020-01-01", "日本語")
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    remote.media.clear()
    remote.logs.clear()
    result = run_kechimochi_sync(config=config(), client=remote)
    assert result["media_created"] == result["logs_created"] == 1


@pytest.mark.parametrize(
    "url",
    [
        "",
        "file:///tmp",
        "http://a@localhost:3031",
        "http://localhost:bad",
        "http://localhost/?token=a",
        "http://localhost/#x",
        "http://localhost:0",
        "http://local host",
    ],
)
def test_url_validation_rejects_invalid_addresses(url):
    with pytest.raises(ValueError):
        normalize_kechimochi_url(url)


def test_url_normalization_accepts_api_suffix():
    assert normalize_kechimochi_url(" http://LOCALHOST:3031/api/ ") == "http://localhost:3031"


class Session:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []
        self.trust_env = True

    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        response = next(self.replies)
        if isinstance(response, Exception):
            raise response
        return response

    def close(self):
        pass


def response(payload, status=200):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(payload).encode()
    return result


def test_client_matches_http_contract_and_does_not_retry_ambiguous_posts():
    session = Session([response(7), response(None), requests.Timeout()])
    client = KechimochiClient(session=session)
    assert client.save_log({"characters": 10}) == 7
    client.delete_log(7)
    with pytest.raises(KechimochiSyncError):
        client.save_log({"characters": 11})
    assert len(session.calls) == 3
    assert session.trust_env is False
    assert session.calls[0][1]["json"]["id"] is None
    assert session.calls[1][1]["headers"]["X-Kechimochi-API"] == "1"
    assert all(call[1]["allow_redirects"] is False for call in session.calls)


@pytest.mark.parametrize("payload", [{"logs": []}, [None], [{"id": 1}], "<html>"])
def test_malformed_remote_lists_stop_sync(payload):
    with pytest.raises(KechimochiSyncError):
        KechimochiClient(session=Session([response(payload)])).get_logs()


@pytest.fixture
def api_client(monkeypatch):
    from GameSentenceMiner.web import kechimochi_api

    holder = {"config": config()}
    monkeypatch.setattr(kechimochi_api, "get_stats_config", lambda: holder["config"])
    monkeypatch.setattr("GameSentenceMiner.util.cron.kechimochi_sync.get_stats_config", lambda: holder["config"])
    monkeypatch.setattr(kechimochi_api, "save_stats_config", lambda value: holder.update(config=value))
    monkeypatch.setattr(kechimochi_api, "kechimochi_sync_job_manager", kechimochi_api.KechimochiSyncJobManager())
    monkeypatch.setattr(kechimochi_api, "run_kechimochi_sync", lambda: {"success": True})
    app = flask.Flask(__name__)
    app.testing = True
    kechimochi_api.register_kechimochi_api_routes(app)
    return app.test_client(), holder


@pytest.mark.parametrize(
    "payload",
    [
        [],
        None,
        {"enabled": "false"},
        {"schedule": "once"},
        {"sync_time": "25:00"},
        {"url": "file:///etc"},
        {"unexpected": 1},
    ],
)
def test_api_validates_settings_atomically(api_client, payload):
    client, holder = api_client
    before = copy.deepcopy(holder["config"])
    result = client.post("/api/kechimochi/settings", json=payload)
    assert result.status_code == 400
    assert holder["config"] == before


def test_settings_enable_creates_schedule_and_starts_immediately(api_client, monkeypatch):
    from GameSentenceMiner.web import kechimochi_api

    calls = []
    monkeypatch.setattr(kechimochi_api, "run_kechimochi_sync", lambda: calls.append("synced"))
    client, holder = api_client
    result = client.post("/api/kechimochi/settings", json={"enabled": True, "schedule": "hourly"})
    assert result.status_code == 200
    assert holder["config"].kechimochi_sync_enabled is True
    assert CronTable.get_by_name("kechimochi_sync").schedule == "hourly"
    assert calls == ["synced"]
    assert client.get("/api/kechimochi/status").get_json()["next_run"] is not None
    result = client.post("/api/kechimochi/settings", json={"enabled": False})
    assert result.status_code == 200
    assert not CronTable.get_by_name("kechimochi_sync").enabled
    assert calls == ["synced"]


def test_startup_keeps_overdue_sync_and_daily_failure_retries_in_15_minutes(monkeypatch):
    from GameSentenceMiner.util.cron import kechimochi_sync as cron_module

    saved = config(kechimochi_sync_enabled=True, kechimochi_sync_schedule="daily", kechimochi_sync_time="04:30")
    monkeypatch.setattr(cron_module, "get_stats_config", lambda: saved)
    cron = cron_module.configure_kechimochi_cron(config=saved)
    cron.next_run = 100
    cron.save()
    assert cron_module.configure_kechimochi_cron(config=saved).next_run == 100
    now = dt.datetime(2026, 1, 1, 12)
    state = KechimochiSyncState()
    state.put(run_state_key(saved.kechimochi_url), {"status": "failed"})
    assert cron_module.reschedule_kechimochi_run(now) == (now + dt.timedelta(minutes=15)).timestamp()
    state.put(run_state_key(saved.kechimochi_url), {"status": "completed"})
    assert cron_module.reschedule_kechimochi_run(now) == dt.datetime(2026, 1, 2, 4, 30).timestamp()


def test_disabled_scheduled_sync_does_not_contact_kechimochi(monkeypatch):
    from GameSentenceMiner.util.cron import kechimochi_sync as cron_module

    monkeypatch.setattr(cron_module, "get_stats_config", lambda: config())
    monkeypatch.setattr(cron_module, "run_kechimochi_sync", lambda **kwargs: pytest.fail("Unexpected sync"))
    assert cron_module.run_scheduled_kechimochi_sync()["skipped"] is True


@pytest.fixture
def sync_logger(monkeypatch):
    logger = Mock()
    for module in (
        "GameSentenceMiner.util.kechimochi_sync",
        "GameSentenceMiner.util.cron.kechimochi_sync",
        "GameSentenceMiner.util.cron.run_crons",
        "GameSentenceMiner.web.kechimochi_api",
    ):
        monkeypatch.setattr(f"{module}.logger", logger)
    return logger


@pytest.mark.parametrize("failure", [requests.ConnectionError, requests.Timeout])
def test_scheduled_connection_failure_is_quiet_and_retries(monkeypatch, sync_logger, failure):
    from GameSentenceMiner.util import kechimochi_sync as sync_module
    from GameSentenceMiner.util.cron import kechimochi_sync as cron_module
    from GameSentenceMiner.util.cron import run_crons

    saved = config(kechimochi_sync_enabled=True, kechimochi_sync_schedule="daily", kechimochi_sync_time="04:30")
    monkeypatch.setattr(cron_module, "get_stats_config", lambda: saved)
    remote = KechimochiClient(session=Session([failure("Offline")]))
    monkeypatch.setattr(sync_module, "KechimochiClient", lambda url: remote)
    snapshot = Mock(side_effect=AssertionError("Offline sync must not scan local history"))
    monkeypatch.setattr(sync_module, "build_kechimochi_snapshot", snapshot)
    state = KechimochiSyncState()
    key = run_state_key(saved.kechimochi_url)
    state.put(key, {"status": "completed", "last_success_at": 123})
    cron = cron_module.configure_kechimochi_cron(config=saved)

    result = run_crons.run_due_crons(due_crons=[cron])

    detail = result["details"][0]
    assert detail["success"] is False
    assert "Could not reach Kechimochi" in detail["result"]["error"]
    assert state.get(key)["status"] == "failed"
    assert state.get(key)["error"] == detail["result"]["error"]
    assert state.get(key)["last_success_at"] == 123
    assert time.time() < cron.next_run <= time.time() + 900
    snapshot.assert_not_called()
    sync_logger.error.assert_not_called()
    sync_logger.exception.assert_not_called()
    sync_logger.warning.assert_not_called()
    assert not any("synced 0 activities" in call.args[0] for call in sync_logger.background.call_args_list)


@pytest.mark.parametrize(
    "reply",
    [
        response(None, 403),
        response({"invalid": "version"}),
        requests.RequestException("Bad request"),
        RuntimeError("Bug"),
    ],
    ids=["http-error", "invalid-response", "other-request-error", "unexpected-error"],
)
def test_scheduled_other_failures_remain_logged(monkeypatch, sync_logger, reply):
    from GameSentenceMiner.util import kechimochi_sync as sync_module
    from GameSentenceMiner.util.cron import kechimochi_sync as cron_module
    from GameSentenceMiner.util.cron import run_crons

    saved = config(kechimochi_sync_enabled=True)
    monkeypatch.setattr(cron_module, "get_stats_config", lambda: saved)
    remote = KechimochiClient(session=Session([reply]))
    monkeypatch.setattr(sync_module, "KechimochiClient", lambda url: remote)
    cron = cron_module.configure_kechimochi_cron(config=saved)

    result = run_crons.run_due_crons(due_crons=[cron])

    assert result["details"][0]["success"] is False
    assert KechimochiSyncState().get(run_state_key(saved.kechimochi_url))["status"] == "failed"
    sync_logger.error.assert_called_once()
    sync_logger.exception.assert_called_once()
    sync_logger.warning.assert_called_once()


@pytest.mark.parametrize("failure", [requests.ConnectionError, requests.Timeout])
def test_manual_connection_failure_is_quiet_and_queues_early_retry(api_client, monkeypatch, sync_logger, failure):
    from GameSentenceMiner.util import kechimochi_sync as sync_module
    from GameSentenceMiner.web import kechimochi_api

    client, holder = api_client
    remote = KechimochiClient(session=Session([failure("Offline")]))
    monkeypatch.setattr(sync_module, "KechimochiClient", lambda url: remote)
    monkeypatch.setattr(sync_module, "get_stats_config", lambda: holder["config"])
    monkeypatch.setattr(kechimochi_api, "run_kechimochi_sync", run_kechimochi_sync)
    result = client.post("/api/kechimochi/settings", json={"enabled": True, "schedule": "daily"})
    assert result.status_code == 200
    next_run = CronTable.get_by_name("kechimochi_sync").next_run
    assert time.time() < next_run <= time.time() + 900
    status = client.get("/api/kechimochi/status").get_json()
    assert status["status"] == "failed"
    assert "Could not reach Kechimochi" in status["error"]
    assert kechimochi_api.kechimochi_sync_job_manager.active() is None
    sync_logger.error.assert_not_called()
    sync_logger.exception.assert_not_called()
    sync_logger.warning.assert_not_called()


def test_cover_sync_is_idempotent_and_restricted_scope_does_not_block_stats():
    from GameSentenceMiner.util.kechimochi_client import KechimochiHTTPError

    GamesTable(id="game", title_original="Game", image="aW1hZ2U=").save()
    line("old", "game", "2020-01-01", "日本語")
    remote = Remote()

    def forbidden(*args):
        raise KechimochiHTTPError("Full scope required", 403)

    remote.upload_cover = forbidden
    result = run_kechimochi_sync(config=config(), client=remote)
    assert result["logs_created"] == 1
    assert result["warnings"]
    remote.upload_cover = lambda *args: {"path": "covers/game.jpg"}
    result = run_kechimochi_sync(config=config(), client=remote)
    assert result["covers_uploaded"] == 1
    remote.writes.clear()
    assert run_kechimochi_sync(config=config(), client=remote)["covers_uploaded"] == 0
    assert remote.writes == []


def test_metadata_uses_kechimochi_source_fields_and_readable_values():
    GamesTable(
        id="game",
        title_original="日本語",
        title_romaji="Nihongo",
        title_english="Japanese",
        game_type="Visual Novel",
        description="GSM description",
        deck_id=42,
        vndb_id="v17",
        character_count=123456,
        release_date="2020-01-01",
        genres=["Drama", "Mystery"],
        tags=["School"],
        links=[
            {"url": "https://vndb.org/v17"},
            {"url": "https://jiten.moe/decks/42"},
            {"url": "https://anilist.co/manga/100"},
            {"url": "https://example.org/work"},
        ],
    ).save()
    media = build_kechimochi_snapshot(config=config()).media["game:game"]
    extra = json.loads(media["extra_data"])
    assert media["description"] == "GSM description"
    assert extra["Source (VNDB)"] == "https://vndb.org/v17"
    assert extra["Source (Jiten.moe)"] == "https://jiten.moe/decks/42"
    assert extra["Source (Anilist)"] == "https://anilist.co/manga/100"
    assert extra["Source (example.org)"] == "https://example.org/work"
    assert extra["Character count"] == "123,456"
    assert extra["Release Date"] == "2020-01-01"
    assert extra["Genres"] == "Drama, Mystery"
    assert extra["Tags"] == "School"
    assert extra["Romaji title"] == "Nihongo"
    assert extra["English title"] == "Japanese"
    assert all(isinstance(value, str) for value in extra.values())
    assert len([key for key in extra if key.startswith("Source (VNDB)")]) == 1


@pytest.mark.parametrize("game_type,kind", [("Anime", "anime"), ("Manga", "manga"), ("Novel", "manga")])
def test_metadata_can_generate_anilist_links_from_saved_ids(game_type, kind):
    GamesTable(id="game", title_original="Game", game_type=game_type, anilist_id="123").save()
    extra = json.loads(build_kechimochi_snapshot(config=config()).media["game:game"]["extra_data"])
    assert extra["Source (Anilist)"] == f"https://anilist.co/{kind}/123"


def test_metadata_survives_kechimochi_refresh_and_sync_ownership_survives_stringification():
    GamesTable(id="game", title_original="Game", description="GSM description", genres=["Drama"]).save()
    line("line", "game", "2020-01-01", "日本語")
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    media_id = remote.media[0]["id"]
    extra = json.loads(remote.media[0]["extra_data"])
    # Kechimochi's editor/importer normalizes every extra_data value to a string.
    extra = {key: value if isinstance(value, str) else json.dumps(value) for key, value in extra.items()}
    extra.update({"Genres": "Drama, Adventure", "Developer": "Example studio"})
    remote.media[0].update(description="Description from Kechimochi's importer", extra_data=json.dumps(extra))
    run_kechimochi_sync(config=config(), client=remote)
    assert len(remote.media) == len(remote.logs) == 1
    assert remote.media[0]["id"] == media_id
    assert remote.media[0]["description"] == "Description from Kechimochi's importer"
    assert json.loads(remote.media[0]["extra_data"])["Genres"] == "Drama, Adventure"
    assert json.loads(remote.media[0]["extra_data"])["Developer"] == "Example studio"
    remote.writes.clear()
    run_kechimochi_sync(config=config(), client=remote)
    assert remote.writes == []

    game = GamesTable.get("game")
    game.description = "Corrected GSM description"
    game.genres = ["Mystery"]
    game.save()
    run_kechimochi_sync(config=config(), client=remote)
    assert remote.media[0]["description"] == "Corrected GSM description"
    assert json.loads(remote.media[0]["extra_data"])["Genres"] == "Mystery"


def test_missing_gsm_description_does_not_erase_kechimochi_metadata():
    GamesTable(id="game", title_original="Game").save()
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    remote.media[0]["description"] = "Fetched using a source link"
    run_kechimochi_sync(config=config(), client=remote)
    assert remote.media[0]["description"] == "Fetched using a source link"


def test_metadata_migrates_legacy_sync_fields_and_object_marker_without_duplicates():
    GamesTable(id="game", title_original="Game", genres=["Drama"], deck_id=42).save()
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    extra = json.loads(remote.media[0]["extra_data"])
    marker = extra["gsm_sync"]
    marker = json.loads(marker) if isinstance(marker, str) else marker
    remote.media[0]["extra_data"] = json.dumps(
        {
            "gsm_sync": {"source": marker["source"], "key": marker["key"]},
            "genres": ["Drama"],
            "deck_id": 42,
            "links": ["https://jiten.moe/decks/42"],
            "Developer": "My studio",
        }
    )
    run_kechimochi_sync(config=config(), client=remote)
    assert len(remote.media) == 1
    extra = json.loads(remote.media[0]["extra_data"])
    assert extra["Genres"] == "Drama"
    assert extra["Jiten deck ID"] == "42"
    assert extra["Source (Jiten.moe)"] == "https://jiten.moe/decks/42"
    assert extra["Developer"] == "My studio"
    assert not {"genres", "deck_id", "links"}.intersection(extra)


@pytest.mark.parametrize("enriched", [False, True])
def test_cleared_gsm_metadata_removes_only_unchanged_values(enriched):
    GamesTable(id="game", title_original="Game", description="Original", genres=["Drama"]).save()
    remote = Remote()
    run_kechimochi_sync(config=config(), client=remote)
    if enriched:
        remote.media[0]["description"] = "Enriched"
        extra = json.loads(remote.media[0]["extra_data"])
        extra["Genres"] = "Adventure"
        remote.media[0]["extra_data"] = json.dumps(extra)
    game = GamesTable.get("game")
    game.description, game.genres = "", []
    game.save()
    run_kechimochi_sync(config=config(), client=remote)
    extra = json.loads(remote.media[0]["extra_data"])
    assert remote.media[0]["description"] == ("Enriched" if enriched else "")
    assert extra.get("Genres") == ("Adventure" if enriched else None)


def test_existing_kechimochi_cover_is_preserved_until_gsm_cover_changes():
    GamesTable(id="game", title_original="Game", image="aW1hZ2U=").save()
    remote = Remote()
    uploads = []

    def upload(*args):
        uploads.append(args)
        return {"path": "covers/gsm.jpg"}

    remote.upload_cover = upload
    run_kechimochi_sync(config=config(), client=remote)
    remote.media[0]["cover_image"] = "covers/imported-in-kechimochi.jpg"
    run_kechimochi_sync(config=config(), client=remote)
    assert remote.media[0]["cover_image"] == "covers/imported-in-kechimochi.jpg"
    assert len(uploads) == 1
    game = GamesTable.get("game")
    game.image = "bmV3LWltYWdl"
    game.save()
    run_kechimochi_sync(config=config(), client=remote)
    assert len(uploads) == 2
    assert remote.media[0]["cover_image"] == "covers/gsm.jpg"


def test_metadata_omits_invalid_urls_and_does_not_guess_unknown_anilist_kind():
    GamesTable(
        id="game",
        title_original="Game",
        anilist_id="123",
        vndb_id="invalid",
        deck_id=-1,
        links=[{"url": "javascript:alert(1)"}, {"url": "https://user:password@example.org"}, {"url": "http://["}],
    ).save()
    extra = json.loads(build_kechimochi_snapshot(config=config()).media["game:game"]["extra_data"])
    assert not any(key.startswith("Source (") for key in extra)


def test_os_lock_excludes_a_separate_worker_process(tmp_path, monkeypatch):
    file_db = SQLiteDB(str(tmp_path / "sync.db"))
    monkeypatch.setattr(GameLinesTable, "_db", file_db)
    state = KechimochiSyncState()
    script = """
import sys
from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB, gsm_db
from GameSentenceMiner.util.database.kechimochi_sync_state import KechimochiSyncState
from GameSentenceMiner.util.kechimochi_client import KechimochiSyncError
db = SQLiteDB(sys.argv[1])
GameLinesTable._db = db
try:
    try:
        with KechimochiSyncState().sync_lock():
            print('ACQUIRED')
    except KechimochiSyncError:
        print('BUSY')
finally:
    db.close()
    gsm_db.close()
"""
    try:
        with state.sync_lock():
            busy = subprocess.run(
                [sys.executable, "-c", script, file_db.db_path], capture_output=True, text=True, timeout=20, check=True
            )
            assert "BUSY" in busy.stdout
        available = subprocess.run(
            [sys.executable, "-c", script, file_db.db_path], capture_output=True, text=True, timeout=20, check=True
        )
        assert "ACQUIRED" in available.stdout
    finally:
        file_db.close()


def test_status_recovers_after_an_interrupted_process(api_client):
    client, holder = api_client
    state = KechimochiSyncState()
    state.put(run_state_key(holder["config"].kechimochi_url), {"status": "running", "last_success_at": 123})
    status = client.get("/api/kechimochi/status").get_json()
    assert status["status"] == "interrupted"
    assert status["last_success_at"] == 123
    with state.sync_lock():
        assert client.get("/api/kechimochi/status").get_json()["status"] == "running"


def test_legacy_json_and_unattributed_daily_history_are_backfilled_once():
    StatsRollupTable(
        date="2015-01-01",
        total_characters=12,
        total_reading_time_seconds=120,
        game_activity_data=json.dumps({"legacy-game": {"title": "Old game", "chars": 12, "time": 120}}),
    ).save()
    StatsRollupTable(date="2014-01-01", total_characters=5, total_reading_time_seconds=60).save()
    snapshot = build_kechimochi_snapshot(config=config())
    assert {row["title"] for row in snapshot.media.values()} == {"Old game", "GSM historical activity"}
    assert snapshot.summary()["characters"] == 17
    assert snapshot.summary()["duration_minutes"] == 3
    assert snapshot.summary()["first_date"] == "2014-01-01"


def test_stale_legacy_totals_do_not_duplicate_live_or_per_game_history():
    GamesTable(id="game", title_original="Game").save()
    StatsRollupTable(date="2020-01-01", total_characters=999).save()
    line("live", "game", "2020-01-01", "日本語")
    GameDailyRollupTable(date="2019-01-01", game_id="game", total_characters=12).save()
    StatsRollupTable(
        date="2019-01-01", total_characters=100, game_activity_data=json.dumps({"game": {"chars": 100, "time": 120}})
    ).save()
    assert build_kechimochi_snapshot(config=config()).summary()["characters"] == 15


def test_snapshot_error_never_prunes_existing_remote_activity():
    remote = Remote()
    GamesTable(id="game", title_original="Game").save()
    line("live", "game", "2020-01-01", "日本語")
    run_kechimochi_sync(config=config(), client=remote)
    remote.writes.clear()
    StatsRollupTable(date="2018-01-01", game_activity_data="invalid JSON").save()
    with pytest.raises(ValueError):
        run_kechimochi_sync(config=config(), client=remote)
    assert remote.writes == []
    assert len(remote.logs) == 1


@pytest.mark.skipif(not os.environ.get("GSM_KECHIMOCHI_LIVE_URL"), reason="Opt-in local Kechimochi roundtrip")
def test_live_kechimochi_roundtrip(database):
    """Create isolated fixture media, exercise the real API, and remove only those fixtures."""
    saved = config(kechimochi_url=os.environ["GSM_KECHIMOCHI_LIVE_URL"])
    state = KechimochiSyncState()
    prefix = "GSM sync verification " + uuid.uuid4().hex
    GamesTable(
        id="live-fixture",
        title_original=prefix,
        game_type="Visual Novel",
        description="GSM fixture description",
        vndb_id="v17",
        character_count=12345,
    ).save()
    line("fixture-line", "live-fixture", "2001-01-01", "日本語")
    client = KechimochiClient(saved.kechimochi_url)
    original_save = client.save_log
    fail_once = True

    def lose_response(payload, log_id=None):
        nonlocal fail_once
        result = original_save(payload, log_id)
        if fail_once:
            fail_once = False
            raise KechimochiSyncError("Simulated lost response after Kechimochi committed")
        return result

    try:
        assert client.version().startswith("http-")
        client.save_log = lose_response
        with pytest.raises(KechimochiSyncError, match="Simulated"):
            run_kechimochi_sync(config=saved, client=client)
        result = run_kechimochi_sync(config=saved, client=client)
        assert result["logs_created"] == 0
        owned_media = [row for row in client.get_media() if row["title"] == prefix]
        assert len(owned_media) == 1
        media_id = owned_media[0]["id"]
        fixture_media = owned_media[0]
        fixture_extra = json.loads(fixture_media["extra_data"])
        assert fixture_extra["Source (VNDB)"] == "https://vndb.org/v17"
        assert fixture_extra["Character count"] == "12,345"
        # Simulate Kechimochi's native metadata import/save workflow.
        fixture_extra["Developer"] = "Fixture studio"
        fixture_extra = {
            key: value if isinstance(value, str) else json.dumps(value) for key, value in fixture_extra.items()
        }
        client.save_media(
            {**fixture_media, "description": "Imported fixture description", "extra_data": json.dumps(fixture_extra)},
            media_id,
        )
        owned_logs = [row for row in client.get_logs() if row["media_id"] == media_id]
        assert len(owned_logs) == 1
        assert owned_logs[0]["characters"] == 3
        line("fixture-line", "live-fixture", "2001-01-01", "日本語日本語")
        result = run_kechimochi_sync(config=saved, client=client)
        assert result["logs_updated"] == 1
        updated = [row for row in client.get_logs() if row["media_id"] == media_id]
        assert updated[0]["characters"] == 6
        assert updated[0]["id"] == owned_logs[0]["id"]
        result = run_kechimochi_sync(config=saved, client=client)
        assert result["logs_created"] == result["logs_updated"] == result["media_updated"] == 0
        fixture_media = next(row for row in client.get_media() if row["id"] == media_id)
        assert fixture_media["description"] == "Imported fixture description"
        assert json.loads(fixture_media["extra_data"])["Developer"] == "Fixture studio"
        database.execute("DELETE FROM game_lines WHERE id='fixture-line'", commit=True)
        assert run_kechimochi_sync(config=saved, client=client)["logs_deleted"] == 1
    finally:
        for media in client.get_media():
            if media["title"] != prefix:
                continue
            marker = json.loads(media["extra_data"]).get("gsm_sync", {})
            marker = json.loads(marker) if isinstance(marker, str) else marker
            if marker.get("source") == state.source_id:
                client._request("DELETE", f"media/{media['id']}")
        client.close()
