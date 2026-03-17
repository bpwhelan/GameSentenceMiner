from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from GameSentenceMiner.util.yomitan_dict import sudachi_user_dict


def _make_game(
    *,
    game_id: str = "game-1",
    title_original: str = "Test Game",
    obs_scene_name: str = "Test Scene",
    character_payload: dict | None = None,
):
    payload = (
        character_payload
        if character_payload is not None
        else {
            "characters": {
                "main": [
                    {
                        "id": "char-1",
                        "name": "Suzuki Taro",
                        "name_original": "鈴木 太郎",
                        "aliases": ["タロウ"],
                    }
                ]
            }
        }
    )
    return SimpleNamespace(
        id=game_id,
        title_original=title_original,
        title_romaji="",
        title_english="",
        obs_scene_name=obs_scene_name,
        vndb_character_data=json.dumps(payload, ensure_ascii=False),
    )


def test_build_rows_for_game_exports_full_name_and_kana_variants():
    game = _make_game()

    rows = sudachi_user_dict.build_rows_for_game(game)
    surfaces = {row[0] for row in rows}

    assert "鈴木 太郎" in surfaces
    assert "鈴木太郎" in surfaces
    assert any(surface in surfaces for surface in ("すずきたろ", "すずきたろう"))
    assert any(surface in surfaces for surface in ("スズキタロ", "スズキタロウ"))
    assert "タロウ" in surfaces
    assert "鈴木" not in surfaces
    assert "太郎" not in surfaces


def test_write_game_dictionary_source_writes_csv_and_metadata(tmp_path, monkeypatch):
    game = _make_game()
    monkeypatch.setattr(
        sudachi_user_dict,
        "get_app_directory",
        lambda: str(tmp_path),
    )

    written = sudachi_user_dict.write_game_dictionary_source(game)

    csv_path = (
        Path(tmp_path) / "dictionaries" / "sudachi" / "csv" / f"{game.id}.csv"
    )
    metadata_path = (
        Path(tmp_path) / "dictionaries" / "sudachi" / "metadata" / f"{game.id}.json"
    )

    assert written is True
    assert csv_path.is_file()
    assert metadata_path.is_file()
    assert "鈴木太郎" in csv_path.read_text(encoding="utf-8")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["game_id"] == game.id
    assert metadata["title"] == game.title_original
    assert metadata["row_count"] >= 4


def test_write_game_dictionary_source_skips_rewrite_when_hash_matches(
    tmp_path, monkeypatch
):
    game = _make_game()
    monkeypatch.setattr(
        sudachi_user_dict,
        "get_app_directory",
        lambda: str(tmp_path),
    )

    first_write = sudachi_user_dict.write_game_dictionary_source(game)
    csv_path = (
        Path(tmp_path) / "dictionaries" / "sudachi" / "csv" / f"{game.id}.csv"
    )
    original_text = csv_path.read_text(encoding="utf-8")
    csv_path.write_text("sentinel", encoding="utf-8")

    second_write = sudachi_user_dict.write_game_dictionary_source(game)

    assert first_write is True
    assert second_write is False
    assert csv_path.read_text(encoding="utf-8") == "sentinel"
    assert original_text != "sentinel"


def test_wait_for_scene_name_and_queue_waits_until_scene_is_available(monkeypatch):
    seen_calls = []
    scene_names = iter(["", "", "Kanon"])

    monkeypatch.setattr(
        sudachi_user_dict,
        "queue_ensure_scene_dictionary",
        lambda scene_name, *, reason, force: seen_calls.append(
            {
                "scene_name": scene_name,
                "reason": reason,
                "force": force,
            }
        ),
    )
    monkeypatch.setattr(sudachi_user_dict.time, "sleep", lambda _seconds: None)

    sudachi_user_dict._wait_for_scene_name_and_queue(
        lambda: next(scene_names),
        reason="startup",
        force=True,
        poll_interval_seconds=0.01,
        max_attempts=5,
    )

    assert seen_calls == [
        {
            "scene_name": "Kanon",
            "reason": "startup:ready",
            "force": True,
        }
    ]


def test_queue_ensure_scene_dictionary_noops_when_disabled(monkeypatch):
    monkeypatch.setattr(sudachi_user_dict, "SUDACHI_USER_DICT_ENABLED", False)
    monkeypatch.setattr(sudachi_user_dict, "_executor", None)

    executor_requested = False

    def _fail_get_executor():
        nonlocal executor_requested
        executor_requested = True
        raise AssertionError("executor should not be requested when disabled")

    monkeypatch.setattr(sudachi_user_dict, "_get_executor", _fail_get_executor)

    sudachi_user_dict.queue_ensure_scene_dictionary("Kanon", reason="test")

    assert executor_requested is False
    assert sudachi_user_dict._executor is None


def test_queue_wait_for_scene_dictionary_noops_when_disabled(monkeypatch):
    monkeypatch.setattr(sudachi_user_dict, "SUDACHI_USER_DICT_ENABLED", False)
    monkeypatch.setattr(sudachi_user_dict, "_startup_wait_active", False)

    def _fail_thread(*args, **kwargs):
        raise AssertionError("startup wait thread should not be started when disabled")

    monkeypatch.setattr(sudachi_user_dict.threading, "Thread", _fail_thread)

    sudachi_user_dict.queue_wait_for_scene_dictionary(lambda: "Kanon", reason="test")

    assert sudachi_user_dict._startup_wait_active is False
