from __future__ import annotations

import datetime
import importlib.util
import json
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.database.third_party_stats_table import ThirdPartyStatsTable
from GameSentenceMiner.util.database.anki_tables import setup_anki_tables


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "benchmark_stats.py"


def _load_benchmark_module():
    module_name = f"benchmark_stats_test_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(module_name, SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def benchmark_db_path(tmp_path):
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    orig_third_party = ThirdPartyStatsTable._db

    db_path = tmp_path / "benchmark.db"
    db = SQLiteDB(str(db_path))
    setup_anki_tables(db)
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    ThirdPartyStatsTable.set_db(db)

    game_one = GamesTable(
        id="game-1",
        title_original="Game One",
        obs_scene_name="Game One",
        genres=["VN"],
        tags=["Story Rich"],
    )
    game_one.save()

    game_two = GamesTable(
        id="game-2",
        title_original="Game Two",
        obs_scene_name="Game Two",
        genres=["Action"],
        tags=["Fast"],
    )
    game_two.save()

    def ts(day: str, hour: int, minute: int) -> float:
        return datetime.datetime.fromisoformat(f"{day}T{hour:02d}:{minute:02d}:00").timestamp()

    GameLinesTable(
        id="line-1",
        game_name="Game One",
        line_text="日本語の一行目です",
        timestamp=ts("2026-03-08", 12, 0),
        game_id="game-1",
        note_ids=["1001"],
    ).save()
    GameLinesTable(
        id="line-2",
        game_name="Game One",
        line_text="日本語の二行目です",
        timestamp=ts("2026-03-09", 12, 10),
        game_id="game-1",
        note_ids=[],
    ).save()
    GameLinesTable(
        id="line-3",
        game_name="Game One",
        line_text="日本語の三行目です",
        timestamp=ts("2026-03-09", 12, 25),
        game_id="game-1",
        note_ids=[],
    ).save()
    GameLinesTable(
        id="line-4",
        game_name="Game Two",
        line_text="別ゲームの一行です",
        timestamp=ts("2026-03-08", 15, 0),
        game_id="game-2",
        note_ids=[],
    ).save()

    StatsRollupTable(
        date="2026-03-08",
        total_lines=2,
        total_characters=30,
        total_sessions=1,
        unique_games_played=2,
        total_reading_time_seconds=1800.0,
        total_active_time_seconds=1800.0,
        average_session_seconds=1800.0,
        average_reading_speed_chars_per_hour=60.0,
        peak_reading_speed_chars_per_hour=120.0,
        anki_cards_created=1,
        kanji_frequency_data=json.dumps({"日": 2, "本": 2}),
        hourly_activity_data=json.dumps({"12": 18, "15": 12}),
        hourly_reading_speed_data=json.dumps({"12": 70, "15": 50}),
        game_activity_data=json.dumps(
            {
                "game-1": {"title": "Game One", "lines": 1, "chars": 18, "time": 900},
                "game-2": {"title": "Game Two", "lines": 1, "chars": 12, "time": 900},
            }
        ),
        games_played_ids=json.dumps(["game-1", "game-2"]),
        genre_activity_data=json.dumps({"VN": {"chars": 18, "time": 900, "cards": 1}}),
        type_activity_data=json.dumps({"Visual Novel": {"chars": 30, "time": 1800, "cards": 1}}),
        word_frequency_data=json.dumps({"日本語": 3}),
    ).save()

    yield db_path

    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_stats
    ThirdPartyStatsTable._db = orig_third_party


def test_create_snapshot_db_copies_database(benchmark_db_path, tmp_path):
    module = _load_benchmark_module()

    snapshot_path = module.create_snapshot_db(benchmark_db_path, tmp_path / "snapshot")

    assert snapshot_path.exists()
    assert module.get_table_row_counts(snapshot_path) == {
        "game_lines": 4,
        "daily_stats_rollup": 1,
        "games": 2,
        "third_party_stats": 0,
        "anki_notes": 0,
        "anki_cards": 0,
        "anki_reviews": 0,
    }


def test_selection_helpers_choose_hottest_game_and_latest_activity(benchmark_db_path):
    module = _load_benchmark_module()

    assert module.select_hottest_game_id(benchmark_db_path) == "game-1"
    assert module.select_latest_activity_date(benchmark_db_path) == "2026-03-09"


def test_benchmark_cli_smoke_run(benchmark_db_path, tmp_path):
    json_out = tmp_path / "benchmark_results.json"

    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--db-path",
            str(benchmark_db_path),
            "--iterations",
            "1",
            "--warmup",
            "0",
            "--json-out",
            str(json_out),
        ],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(json_out.read_text(encoding="utf-8"))

    assert "Stats Benchmark" in completed.stdout
    assert payload["selection"]["game_id"] == "game-1"
    assert payload["selection"]["today_date"] == "2026-03-09"
    assert set(payload["results"]) == {"stats", "today", "game"}

    for result in payload["results"].values():
        assert result["status_code"] == 200
        assert result["response_bytes"] > 0
        assert len(result["samples_ms"]) == 1


def test_anki_benchmark_cli_smoke_run(benchmark_db_path, tmp_path):
    json_out = tmp_path / "anki_benchmark_results.json"

    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--db-path",
            str(benchmark_db_path),
            "--iterations",
            "1",
            "--warmup",
            "0",
            "--endpoints",
            "anki_page,anki_combined",
            "--json-out",
            str(json_out),
        ],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(json_out.read_text(encoding="utf-8"))

    assert "Stats Benchmark" in completed.stdout
    assert set(payload["results"]) == {"anki_page", "anki_combined"}

    for result in payload["results"].values():
        assert result["status_code"] == 200
        assert result["response_bytes"] > 0
        assert len(result["samples_ms"]) == 1
