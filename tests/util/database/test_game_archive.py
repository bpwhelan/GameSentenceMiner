from __future__ import annotations

# Exercise GSM's local-calendar semantics rather than UTC calendar dates.
# ruff: noqa: DTZ001, DTZ005, DTZ011
import datetime
import json

import pytest

from GameSentenceMiner.util.cron import daily_rollup
from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.database.game_daily_rollup_table import GameDailyRollupTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


@pytest.fixture
def archive_db(monkeypatch, tmp_path):
    db = SQLiteDB(":memory:")
    for table in (GameLinesTable, GamesTable, GameDailyRollupTable, StatsRollupTable):
        monkeypatch.setattr(table, "_db", table._db)
        table.set_db(db)
    monkeypatch.setattr("GameSentenceMiner.util.config.feature_flags.is_tokenization_enabled", lambda: False)
    monkeypatch.setattr(
        "GameSentenceMiner.util.database.archive_files.archive_directory", lambda: tmp_path / "archives"
    )
    yield db
    db.close()


def add_line(game, key, seconds, text="日本語日本語", **kwargs):
    GameLinesTable(
        id=key,
        game_id=game,
        game_name=game,
        timestamp=datetime.datetime(2026, 1, 10, 12).timestamp() + seconds,
        line_text=text,
        **kwargs,
    ).save()


def test_archive_preserves_shared_day_and_survives_rebuild(archive_db):
    from GameSentenceMiner.util.database.game_archive import archive_game

    GamesTable(id="a", title_original="A").save()
    GamesTable(id="b", title_original="B").save()
    add_line("a", "a1", 0, note_ids=[1, 2], screenshot_in_anki="image.png")
    add_line("b", "b1", 15, "学習")
    add_line("a", "a2", 30, translation="translation")
    before = daily_rollup.calculate_daily_stats("2026-01-10")

    result = archive_game("a")
    assert result["archived_lines"] == 2
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines WHERE game_id='a'")[0] == 0
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines WHERE game_id='b'")[0] == 1
    assert GamesTable.get("a") is not None
    assert daily_rollup.calculate_daily_stats("2026-01-10") == before
    assert archive_game("a")["archived_lines"] == 0
    assert daily_rollup.run_daily_rollup()["success"]
    saved = StatsRollupTable.get_by_date("2026-01-10")
    assert saved.total_lines == 3
    assert saved.anki_cards_created == 2
    assert json.loads(saved.kanji_frequency_data)["日"] == 4

    # Continued play contributes once, including after a second archive.
    add_line("a", "a3", 45)
    updated = daily_rollup.calculate_daily_stats("2026-01-10")
    archive_game("a")
    assert daily_rollup.calculate_daily_stats("2026-01-10") == updated


def test_archive_rolls_back_if_rollup_fails(archive_db, monkeypatch):
    from GameSentenceMiner.util.database.game_archive import archive_game

    GamesTable(id="a", title_original="A").save()
    add_line("a", "a1", 0)
    monkeypatch.setattr(daily_rollup, "replace_rollup_for_date", lambda *_: (_ for _ in ()).throw(RuntimeError("fail")))
    with pytest.raises(RuntimeError, match="fail"):
        archive_game("a")
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines")[0] == 1
    assert archive_db.fetchone("SELECT COUNT(*) FROM archived_game_days")[0] == 0


def test_archive_keeps_dates_when_no_raw_lines_remain(archive_db):
    from GameSentenceMiner.util.database.game_archive import archive_game

    GamesTable(id="a", title_original="A").save()
    add_line("a", "a1", 0)
    archive_game("a")
    assert daily_rollup.get_first_data_date() == "2026-01-10"
    assert daily_rollup.get_all_data_dates() == ["2026-01-10"]


def test_vacuum_reclaims_pages_and_preserves_data(tmp_path):
    db = SQLiteDB(str(tmp_path / "vacuum.db"))
    try:
        db.execute("CREATE TABLE payload (id INTEGER PRIMARY KEY, data BLOB)", commit=True)
        db.executemany("INSERT INTO payload(data) VALUES (?)", [(bytes(8192),)] * 100, commit=True)
        db.execute("DELETE FROM payload WHERE id > 1", commit=True)
        before = db.fetchone("PRAGMA page_count")[0]
        db.vacuum()
        assert db.fetchone("PRAGMA page_count")[0] < before
        assert db.fetchone("SELECT COUNT(*) FROM payload")[0] == 1
        db.verify_integrity()
        with pytest.raises(RuntimeError, match="transaction"):
            db.run_transaction(lambda conn: db.vacuum())
    finally:
        db.close()


def test_archive_preserves_today_game_stats_and_grid(archive_db):
    from flask import Flask

    from GameSentenceMiner.util.database.game_archive import archive_game
    from GameSentenceMiner.web.stats_api import register_stats_api_routes
    from GameSentenceMiner.web.stats_repository import fetch_today_lines

    GamesTable(id="a", title_original="A").save()
    add_line("a", "a1", 0, note_ids=[1, 2])
    add_line("a", "a2", 30)
    now = datetime.datetime.now().replace(hour=12, minute=0, second=0).timestamp()
    archive_db.execute("UPDATE game_lines SET timestamp=? WHERE id='a1'", (now,), commit=True)
    archive_db.execute("UPDATE game_lines SET timestamp=? WHERE id='a2'", (now + 30,), commit=True)
    app = Flask(__name__)
    register_stats_api_routes(app)
    client = app.test_client()
    before = client.get("/api/game/a/stats").get_json()
    grid = client.get("/api/game/a/kanji-grid").get_json()
    archive_game("a")
    after = client.get("/api/game/a/stats")
    assert after.status_code == 200
    before["game"]["archived_line_count"] = 2
    assert after.get_json() == before
    assert client.get("/api/game/a/kanji-grid").get_json() == grid
    assert len(fetch_today_lines(datetime.date.today())) == 2


def test_word_views_and_cleanup_keep_archived_occurrences(archive_db, monkeypatch):
    from flask import Flask

    from GameSentenceMiner.util.cron.tokenize_lines import cleanup_orphaned_occurrences
    from GameSentenceMiner.util.database import tokenization_tables as tables
    from GameSentenceMiner.util.database.game_archive import archive_game
    from GameSentenceMiner.web.token_novelty import build_game_word_novelty, build_global_word_novelty
    from GameSentenceMiner.web.tokenization_api import register_tokenization_api_routes

    for table in (tables.WordsTable, tables.KanjiTable, tables.WordOccurrencesTable, tables.KanjiOccurrencesTable):
        monkeypatch.setattr(table, "_db", table._db)
        table.set_db(archive_db)
    archive_db.execute("ALTER TABLE game_lines ADD COLUMN tokenized INTEGER DEFAULT 0", commit=True)
    tables.create_tokenization_indexes(archive_db)
    tables.create_tokenization_trigger(archive_db)
    monkeypatch.setattr("GameSentenceMiner.util.config.feature_flags.is_tokenization_enabled", lambda: True)
    monkeypatch.setattr("GameSentenceMiner.web.tokenization_api.is_tokenization_enabled", lambda: True)
    monkeypatch.setattr("GameSentenceMiner.web.token_novelty.is_tokenization_enabled", lambda: True)
    GamesTable(id="a", title_original="A").save()
    add_line("a", "a1", 0)
    add_line("a", "a2", 30)
    archive_db.execute("UPDATE game_lines SET tokenized=1", commit=True)
    word_id = tables.WordsTable.get_or_create("日本語", "ニホンゴ", "名詞")
    first = archive_db.fetchone("SELECT timestamp FROM game_lines WHERE id='a1'")[0]
    tables.WordsTable.set_first_seen_if_missing(word_id, first, "a1")
    tables.WordOccurrencesTable.insert_occurrence(word_id, "a1")
    tables.WordOccurrencesTable.insert_occurrence(word_id, "a2")
    for character in "日本語":
        kanji_id = tables.KanjiTable.get_or_create(character)
        tables.KanjiOccurrencesTable.insert_occurrence(kanji_id, "a1")
        tables.KanjiOccurrencesTable.insert_occurrence(kanji_id, "a2")
    before_game = build_game_word_novelty("a", "2026-01-10", "2026-01-10")
    before_global = build_global_word_novelty("2026-01-10", "2026-01-10")
    app = Flask(__name__)
    register_tokenization_api_routes(app)
    client = app.test_client()
    urls = [
        "/api/tokenization/words",
        "/api/tokenization/words?game_id=a",
        "/api/tokenization/word/日本語",
        "/api/tokenization/word/日本語?game_id=a",
        "/api/tokenization/words/by-game",
        "/api/tokenization/words/not-in-anki?game_id=a",
        "/api/tokenization/words?days=3650",
        "/api/tokenization/kanji?days=3650",
    ]
    before = [client.get(url).get_json() for url in urls]
    assert before[-2]["total"] == 1
    assert before[-1]["total"] == 3
    archive_game("a")
    cleanup_orphaned_occurrences()
    assert tables.WordsTable.get(word_id) is not None
    assert build_game_word_novelty("a", "2026-01-10", "2026-01-10") == before_game
    assert build_global_word_novelty("2026-01-10", "2026-01-10") == before_global
    for url, payload in zip(urls, before):
        response = client.get(url)
        assert response.status_code == 200, (url, response.get_json())
        assert response.get_json() == payload, url
    assert json.loads(StatsRollupTable.get_by_date("2026-01-10").word_frequency_data) == {"日本語": 2}

    from GameSentenceMiner.util.database.archive_files import restore_archive_file

    assert restore_archive_file("a")["restored_lines"] == 2
    assert build_global_word_novelty("2026-01-10", "2026-01-10") == before_global
    for url, payload in zip(urls, before):
        assert client.get(url).get_json() == payload
    archive_game("a")

    # Simulate the word tables being recreated after tokenization was disabled.
    from GameSentenceMiner.util.database.game_archive import restore_archived_words

    archive_db.execute("DELETE FROM words", commit=True)
    restore_archived_words(archive_db)
    restored = tables.WordsTable.get(word_id)
    assert restored.first_seen == float(first)
    assert restored.first_seen_line_id == "a1"
    assert restored.last_seen == float(first) + 30
    assert build_global_word_novelty("2026-01-10", "2026-01-10") == before_global

    from GameSentenceMiner.util.database.game_archive import merge_archived_games

    GamesTable(id="b", title_original="B").save()
    add_line("b", "b1", -30)
    archive_db.execute("UPDATE game_lines SET tokenized=1", commit=True)
    tables.WordOccurrencesTable.insert_occurrence(word_id, "b1")
    archive_game("b")
    assert merge_archived_games("a", ["b"], "A") == 1
    assert archive_db.fetchall("SELECT game_id, frequency, first_line_id FROM archived_word_stats") == [("a", 3, "b1")]
    tables.recompute_word_first_seen_metadata(archive_db)
    assert tables.WordsTable.get(word_id).first_seen_line_id == "b1"


def test_merge_and_unlink_preserve_archived_history(archive_db):
    from flask import Flask

    from GameSentenceMiner.util.database.game_archive import archive_game, archive_summary
    from GameSentenceMiner.web.database_api import register_database_api_routes
    from GameSentenceMiner.web.routes.game_management_routes import game_management_bp

    for game_id in ("a", "b"):
        GamesTable(id=game_id, title_original=game_id, obs_scene_name=game_id, vndb_id="v1").save()
        add_line(game_id, game_id + "1", 0, note_ids=[1])
        archive_game(game_id)
    add_line("a", "a2", 30)
    before = daily_rollup.calculate_daily_stats("2026-01-10")
    app = Flask(__name__)
    register_database_api_routes(app)
    app.register_blueprint(game_management_bp)
    client = app.test_client()
    response = client.post("/api/merge_games", json={"target_game": "b", "games_to_merge": ["a"]})
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["lines_moved"] == 2
    assert response.get_json()["total_lines_in_primary"] == 3
    assert archive_summary("a")["archived_lines"] == 0
    assert archive_summary("b")["archived_lines"] == 2
    after = daily_rollup.calculate_daily_stats("2026-01-10")
    for metric in ("total_characters", "total_lines", "anki_cards_created", "kanji_frequency_data"):
        assert after[metric] == before[metric]
    assert client.delete("/api/games/b").status_code == 200
    assert GamesTable.get("b").vndb_id == ""
    assert archive_summary("b")["archived_lines"] == 2
    assert client.delete("/api/games/b/delete-lines").status_code == 200
    assert archive_summary("b")["archived_lines"] == 0


def test_failed_tokenization_and_resumed_game_keep_original_lines(archive_db, monkeypatch):
    from GameSentenceMiner.util.database.game_archive import archive_game

    GamesTable(id="a", title_original="a", status="completed").save()
    add_line("a", "a1", 0)
    timestamp = float(archive_db.fetchone("SELECT timestamp FROM game_lines")[0])
    assert archive_game("a", completed_before=timestamp - 1)["archived_lines"] == 0
    monkeypatch.setattr("GameSentenceMiner.util.config.feature_flags.is_tokenization_enabled", lambda: True)
    monkeypatch.setattr("GameSentenceMiner.util.cron.tokenize_lines.tokenize_line", lambda *_: False)
    with pytest.raises(ValueError, match="Tokenization failed"):
        archive_game("a")
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines")[0] == 1
    assert archive_db.fetchone("SELECT COUNT(*) FROM archived_game_days")[0] == 0


def test_scheduled_maintenance_is_opt_in_and_completed_only(archive_db):
    from GameSentenceMiner.util.database.maintenance import run_database_maintenance, save_maintenance_settings

    for game_id, status in (("a", "completed"), ("b", "in_progress"), ("c", "completed")):
        GamesTable(id=game_id, title_original=game_id, status=status).save()
        add_line(game_id, game_id + "1", 0)
    now = datetime.datetime(2026, 2, 10, 12).timestamp()
    archive_db.execute("UPDATE game_lines SET timestamp=? WHERE game_id='c'", (now - 3600,), commit=True)
    assert run_database_maintenance(now)["archived_games"] == 0
    save_maintenance_settings({"archive_after_days": 14})
    result = run_database_maintenance(now)
    assert result["success"]
    assert result["archived_games"] == 1
    assert [r[0] for r in archive_db.fetchall("SELECT DISTINCT game_id FROM game_lines ORDER BY game_id")] == ["b", "c"]


@pytest.mark.parametrize(
    "settings",
    [
        None,
        [],
        {"archive_after_days": -1},
        {"archive_after_days": True},
        {"archive_after_days": 1.5},
        {"vacuum_interval_days": 3651},
        {"unknown": 1},
    ],
)
def test_maintenance_rejects_invalid_settings(archive_db, settings):
    from GameSentenceMiner.util.database.maintenance import save_maintenance_settings

    with pytest.raises(ValueError):
        save_maintenance_settings(settings)


def test_global_stats_and_today_sessions_survive_archive(archive_db):
    from flask import Flask

    from GameSentenceMiner.util.database.game_archive import archive_game
    from GameSentenceMiner.web.stats_api import register_stats_api_routes

    GamesTable(id="a", title_original="A").save()
    add_line("a", "old", 0, note_ids=[1])
    add_line("a", "today", 1, note_ids=[2, 3])
    now = datetime.datetime.now().replace(hour=12, minute=0, second=0).timestamp()
    archive_db.execute("UPDATE game_lines SET timestamp=? WHERE id='today'", (now,), commit=True)
    daily_rollup.run_daily_rollup()
    app = Flask(__name__)
    register_stats_api_routes(app)
    client = app.test_client()
    urls = [
        "/api/stats",
        "/api/stats/kanji-grid",
        "/api/mining_heatmap",
        "/api/stats/all-lines-data",
        "/api/today-stats",
    ]
    before = [client.get(url).get_json() for url in urls]
    assert before[1]["unique_count"] == 3
    archive_game("a")
    for url, payload in zip(urls, before):
        response = client.get(url)
        assert response.status_code == 200
        if url == "/api/today-stats":
            for session in payload["sessions"]:
                session["lines"] = []
        assert response.get_json() == payload, url


def test_maintenance_api_confirmation_and_jobs(archive_db, monkeypatch):
    from types import SimpleNamespace

    from flask import Flask

    from GameSentenceMiner.web.database_maintenance_api import register_database_maintenance_routes

    GamesTable(id="a", title_original="A").save()
    add_line("a", "a1", 0)
    app = Flask(__name__)
    register_database_maintenance_routes(app)
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_maintenance_api.get_background_work_pool",
        lambda: SimpleNamespace(submit=lambda fn: fn()),
    )
    client = app.test_client()
    assert client.get("/api/database/maintenance").get_json()["settings"]["archive_after_days"] == 0
    assert client.post("/api/games/a/archive", json={}).status_code == 400
    assert client.get("/api/games/a/archive").get_json()["raw_lines"] == 1
    job = client.post("/api/games/a/archive", json={"confirm": True})
    assert job.status_code == 202
    status = client.get("/api/database/maintenance/jobs/" + job.get_json()["id"]).get_json()
    assert status["status"] == "completed"
    assert status["result"]["archived_lines"] == 1
    assert client.get("/api/games/a/archive").get_json()["raw_lines"] == 0
    assert client.put("/api/database/maintenance", json={"archive_after_days": "7"}).status_code == 400
    monkeypatch.setattr(archive_db, "read_only", True)
    assert client.post("/api/database/vacuum", json={}).status_code == 403
    assert client.post("/api/games/a/archive", json={"confirm": True}).status_code == 403


@pytest.fixture
def batch_archive_client(archive_db, monkeypatch):
    from types import SimpleNamespace

    from flask import Flask

    from GameSentenceMiner.web.database_maintenance_api import register_database_maintenance_routes

    app = Flask(__name__)
    register_database_maintenance_routes(app)
    monkeypatch.setattr(
        "GameSentenceMiner.web.database_maintenance_api.get_background_work_pool",
        lambda: SimpleNamespace(submit=lambda fn: fn()),
    )
    for game_id in ("a", "b", "empty", "unselected"):
        GamesTable(id=game_id, title_original=game_id).save()
        if game_id != "empty":
            add_line(game_id, game_id + "1", 0)
    return app.test_client()


def test_batch_archive_confirms_once_and_preserves_unselected_games(archive_db, batch_archive_client):
    client = batch_archive_client
    selection = {"game_ids": ["a", "b", "empty", "a"]}
    preview = client.post("/api/games/archive/preview", json=selection)
    assert preview.status_code == 200
    assert preview.get_json()["raw_lines"] == 2
    assert preview.get_json()["game_count"] == 3
    assert client.post("/api/games/archive", json=selection).status_code == 400
    job = client.post("/api/games/archive", json={**selection, "confirm": True})
    assert job.status_code == 202
    status = client.get("/api/database/maintenance/jobs/" + job.get_json()["id"]).get_json()
    assert status["status"] == "completed"
    assert status["completed_games"] == status["total_games"] == 3
    result = status["result"]
    assert result["archived_games"] == result["archived_lines"] == 2
    assert result["skipped_games"] == 1
    assert result["failed_games"] == []
    assert result["successful_game_ids"] == ["a", "b", "empty"]
    assert archive_db.fetchall("SELECT game_id FROM game_lines") == [("unselected",)]
    assert daily_rollup.calculate_daily_stats("2026-01-10")["total_lines"] == 3


@pytest.mark.parametrize("ids", [None, [], "a", [None], [{}], [1], [""], ["a", "missing"], ["a"] * 1001])
def test_batch_archive_rejects_invalid_selection_before_any_work(archive_db, batch_archive_client, ids):
    for url in ("/api/games/archive/preview", "/api/games/archive"):
        response = batch_archive_client.post(url, json={"game_ids": ids, "confirm": True})
        assert response.status_code == 400
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines")[0] == 3


def test_batch_archive_reports_failures_and_continues(archive_db, batch_archive_client, monkeypatch):
    from GameSentenceMiner.web import database_maintenance_api as api

    archive = api.archive_game

    def archive_with_failure(game_id):
        if game_id == "a":
            raise ValueError("Tokenization unavailable")
        return archive(game_id)

    monkeypatch.setattr(api, "archive_game", archive_with_failure)
    client = batch_archive_client
    job = client.post("/api/games/archive", json={"game_ids": ["a", "b"], "confirm": True}).get_json()
    status = client.get("/api/database/maintenance/jobs/" + job["id"]).get_json()
    assert status["result"]["archived_lines"] == 1
    assert status["result"]["successful_game_ids"] == ["b"]
    assert status["result"]["failed_games"] == [{"game_id": "a", "game_name": "a", "error": "Tokenization unavailable"}]
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines WHERE game_id='a'")[0] == 1
    monkeypatch.setattr(archive_db, "read_only", True)
    assert client.post("/api/games/archive", json={"game_ids": ["a"], "confirm": True}).status_code == 403


def test_batch_archive_runs_in_background_with_progress_and_exclusive_lock(
    archive_db, batch_archive_client, monkeypatch
):
    from types import SimpleNamespace

    from GameSentenceMiner.web import database_maintenance_api as api

    queued, progress = [], []
    monkeypatch.setattr(api, "get_background_work_pool", lambda: SimpleNamespace(submit=queued.append))
    client = batch_archive_client
    response = client.post("/api/games/archive", json={"game_ids": ["a", "b"], "confirm": True})
    assert response.status_code == 202
    job_url = "/api/database/maintenance/jobs/" + response.get_json()["id"]
    archive = api.archive_game

    def observe_progress(game_id):
        snapshot = client.get(job_url).get_json()
        progress.append((snapshot["completed_games"], snapshot["current_game"]))
        return archive(game_id)

    monkeypatch.setattr(api, "archive_game", observe_progress)
    try:
        assert client.get(job_url).get_json()["status"] == "running"
        assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines")[0] == 3
        assert client.post("/api/database/vacuum").status_code == 409
        assert client.post("/api/games/a/archive", json={"confirm": True}).status_code == 409
    finally:
        queued.pop()()
    assert progress == [(0, "a"), (1, "b")]
    assert client.get(job_url).get_json()["status"] == "completed"
    assert not api.maintenance_lock.locked()


def test_archive_file_round_trip_keeps_raw_fields_and_one_file_per_game(archive_db):
    from zipfile import ZipFile

    from GameSentenceMiner.util.database.archive_files import (
        archive_file_path,
        list_archive_files,
        restore_archive_file,
    )
    from GameSentenceMiner.util.database.game_archive import archive_game, archive_summary

    GamesTable(id="a", title_original="日本語 / test: game").save()
    add_line("a", "a1", 0, translation="Original translation", note_ids=[1, 2], audio_path="sound.wav")
    columns = [row[1] for row in archive_db.fetchall("PRAGMA table_info(game_lines)")]
    original = dict(zip(columns, archive_db.fetchone("SELECT * FROM game_lines WHERE id='a1'")))
    archive_game("a")
    path = archive_file_path("a")
    with ZipFile(path) as exported:
        records = [json.loads(line) for line in exported.read("game_lines.jsonl").splitlines()]
        assert records[0]["line"] == original
        assert exported.testzip() is None
    add_line("a", "a2", 30)
    before = daily_rollup.calculate_daily_stats("2026-01-10")
    archive_game("a")
    assert len(list_archive_files()) == 1
    assert list_archive_files()[0]["line_count"] == 2
    assert archive_file_path("a") == path
    assert restore_archive_file("a")["restored_lines"] == 2
    assert daily_rollup.calculate_daily_stats("2026-01-10") == before
    assert archive_summary("a")["archived_lines"] == 0
    assert archive_db.fetchone("SELECT translation, audio_path FROM game_lines WHERE id='a1'") == (
        "Original translation",
        "sound.wav",
    )
    assert path.exists()
    assert restore_archive_file("a")["restored_lines"] == 0


def test_archive_file_write_failure_keeps_raw_lines_and_previous_file(archive_db, monkeypatch):
    from GameSentenceMiner.util.database import archive_files
    from GameSentenceMiner.util.database.game_archive import archive_game, archive_summary

    GamesTable(id="a", title_original="A").save()
    add_line("a", "a1", 0)
    archive_game("a")
    path = archive_files.archive_file_path("a")
    original_file = path.read_bytes()
    add_line("a", "a2", 30)
    monkeypatch.setattr(archive_files, "durable_replace", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError, match="disk full"):
        archive_game("a")
    assert path.read_bytes() == original_file
    assert archive_db.fetchone("SELECT id FROM game_lines")[0] == "a2"
    assert archive_summary("a")["archived_lines"] == 1
    assert len(list(path.parent.iterdir())) == 1


def test_deleting_archive_file_preserves_stats_and_partial_restore_is_safe(archive_db):
    from GameSentenceMiner.util.database.archive_files import delete_archive_file, restore_archive_file
    from GameSentenceMiner.util.database.game_archive import archive_game

    GamesTable(id="a", title_original="A").save()
    add_line("a", "a1", 0)
    archive_game("a")
    before = daily_rollup.calculate_daily_stats("2026-01-10")
    delete_archive_file("a")
    assert daily_rollup.calculate_daily_stats("2026-01-10") == before
    add_line("a", "a2", 30)
    archive_game("a")
    with pytest.raises(ValueError, match="part of an archived day"):
        restore_archive_file("a")
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines")[0] == 0
    assert daily_rollup.calculate_daily_stats("2026-01-10")["total_lines"] == 2


def test_archive_file_corruption_does_not_change_stats(archive_db):
    from GameSentenceMiner.util.database.archive_files import archive_file_path, restore_archive_file
    from GameSentenceMiner.util.database.game_archive import archive_game

    GamesTable(id="a", title_original="A").save()
    add_line("a", "a1", 0)
    archive_game("a")
    archive_file_path("a").write_bytes(b"corrupt ZIP")
    with pytest.raises(ValueError, match="archive file"):
        restore_archive_file("a")
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines")[0] == 0
    assert daily_rollup.calculate_daily_stats("2026-01-10")["total_lines"] == 1


def test_archive_file_api_download_restore_and_delete(archive_db, batch_archive_client):
    from io import BytesIO
    from zipfile import ZipFile

    from GameSentenceMiner.util.database.game_archive import archive_game, archive_summary

    client = batch_archive_client
    archive_game("a")
    listing = client.get("/api/database/archive-files").get_json()
    assert listing["directory"]
    assert len(listing["archives"]) == 1
    item = listing["archives"][0]
    assert item["game_name"] == "a"
    assert item["can_restore"] is True
    url = "/api/database/archive-files/" + item["file_id"]
    with client.get(url + "/download") as download:
        assert download.status_code == 200
        assert "attachment" in download.headers["Content-Disposition"]
        with ZipFile(BytesIO(download.data)) as zipped:
            assert json.loads(zipped.read("game_lines.jsonl"))["line"]["id"] == "a1"
    assert client.post(url + "/restore", json={}).status_code == 400
    job = client.post(url + "/restore", json={"confirm": True})
    assert job.status_code == 202
    status = client.get("/api/database/maintenance/jobs/" + job.get_json()["id"]).get_json()
    assert status["status"] == "completed"
    assert status["result"]["restored_lines"] == 1
    assert archive_summary("a")["archived_lines"] == 0
    assert len(client.get("/api/database/archive-files").get_json()["archives"]) == 1
    archive_game("a")
    before = daily_rollup.calculate_daily_stats("2026-01-10")
    assert client.post(url + "/delete", json={}).status_code == 400
    job = client.post(url + "/delete", json={"confirm": True})
    status = client.get("/api/database/maintenance/jobs/" + job.get_json()["id"]).get_json()
    assert status["status"] == "completed"
    assert client.get("/api/database/archive-files").get_json()["archives"] == []
    assert daily_rollup.calculate_daily_stats("2026-01-10") == before
    assert client.get(url + "/download").status_code == 404


def test_archive_file_api_handles_corruption_read_only_and_invalid_paths(archive_db, batch_archive_client, monkeypatch):
    from GameSentenceMiner.util.database.archive_files import archive_file_path
    from GameSentenceMiner.util.database.game_archive import archive_game
    from GameSentenceMiner.util.database.maintenance import maintenance_lock

    client = batch_archive_client
    archive_game("a")
    archive_file_path("a").write_bytes(b"broken")
    item = client.get("/api/database/archive-files").get_json()["archives"][0]
    assert item["can_restore"] is False
    url = "/api/database/archive-files/" + item["file_id"]
    for action in ("restore", "delete"):
        assert client.post("/api/database/archive-files/not-an-id/" + action, json={"confirm": True}).status_code == 400
    assert client.get("/api/database/archive-files/not-an-id/download").status_code == 400
    monkeypatch.setattr(archive_db, "read_only", True)
    for action in ("restore", "delete"):
        assert client.post(url + "/" + action, json={"confirm": True}).status_code == 403
    monkeypatch.setattr(archive_db, "read_only", False)
    with maintenance_lock:
        assert client.post(url + "/delete", json={"confirm": True}).status_code == 409
        assert client.post(url + "/restore", json={"confirm": True}).status_code == 409
    job = client.post(url + "/restore", json={"confirm": True}).get_json()
    assert client.get("/api/database/maintenance/jobs/" + job["id"]).get_json()["status"] == "failed"
    job = client.post(url + "/delete", json={"confirm": True}).get_json()
    assert client.get("/api/database/maintenance/jobs/" + job["id"]).get_json()["status"] == "completed"


def test_published_archive_file_survives_database_failure_and_retry_deduplicates(archive_db, monkeypatch):
    from GameSentenceMiner.util.database.archive_files import list_archive_files, restore_archive_file
    from GameSentenceMiner.util.database.game_archive import archive_game

    GamesTable(id="a", title_original="A").save()
    add_line("a", "a1", 0)
    replace = daily_rollup.replace_rollup_for_date
    monkeypatch.setattr(daily_rollup, "replace_rollup_for_date", lambda *_: (_ for _ in ()).throw(RuntimeError("fail")))
    with pytest.raises(RuntimeError, match="fail"):
        archive_game("a")
    assert list_archive_files()[0]["line_count"] == 1
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines")[0] == 1
    monkeypatch.setattr(daily_rollup, "replace_rollup_for_date", replace)
    archive_game("a")
    assert list_archive_files()[0]["line_count"] == 1
    before = daily_rollup.calculate_daily_stats("2026-01-10")
    monkeypatch.setattr(daily_rollup, "replace_rollup_for_date", lambda *_: (_ for _ in ()).throw(RuntimeError("fail")))
    with pytest.raises(RuntimeError, match="fail"):
        restore_archive_file("a")
    assert archive_db.fetchone("SELECT COUNT(*) FROM game_lines")[0] == 0
    assert daily_rollup.calculate_daily_stats("2026-01-10") == before
    monkeypatch.setattr(daily_rollup, "replace_rollup_for_date", replace)
    assert restore_archive_file("a")["restored_lines"] == 1
