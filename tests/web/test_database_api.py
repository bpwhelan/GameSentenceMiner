"""
Tests for database API endpoints in GameSentenceMiner/web/database_api.py.

Covers:
- /api/search-sentences (text + regex, pagination, sorting, filtering)
- /api/games-list
- /api/delete-sentence-lines
- /api/delete-games
- /api/preview-text-deletion, /api/delete-text-lines
- /api/preview-deduplication, /api/deduplicate
- /api/merge_games, /api/migrate-lines
- /api/search-duplicates
- /api/delete-regex-in-game-lines
- Core functions: delete_text_lines(), deduplicate_lines_core()
"""

import json
import time
import uuid
from unittest.mock import patch

import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _in_memory_db():
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines


@pytest.fixture()
def app(_in_memory_db):
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True

    # Mock cron_scheduler to avoid side effects
    with patch("GameSentenceMiner.web.database_api.cron_scheduler"):
        from GameSentenceMiner.web.database_api import register_database_api_routes

        register_database_api_routes(test_app)

    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_game(title="Test Game", **overrides):
    fields = dict(
        title_original=title,
        title_romaji="",
        title_english="",
        game_type="",
        description="",
        completed=False,
    )
    fields.update(overrides)
    game = GamesTable(**fields)
    game.add()
    return game


def _create_line(
    game_name="Test Game",
    text="テスト文",
    timestamp=None,
    game_id="",
    screenshot_in_anki="",
    audio_in_anki="",
):
    line = GameLinesTable(
        id=str(uuid.uuid4()),
        game_name=game_name,
        game_id=game_id,
        line_text=text,
        timestamp=timestamp or time.time(),
        screenshot_in_anki=screenshot_in_anki,
        audio_in_anki=audio_in_anki,
    )
    line.add()
    return line


# ===================================================================
# /api/search-sentences
# ===================================================================


class TestSearchSentences:
    def test_empty_query_returns_400(self, client):
        resp = client.get("/api/search-sentences?q=")
        assert resp.status_code == 400

    def test_simple_text_search(self, client):
        _create_line(text="日本語のテスト文")
        _create_line(text="英語のテスト")
        resp = client.get("/api/search-sentences?q=日本語")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["total"] == 1
        assert "日本語" in data["results"][0]["sentence"]

    def test_search_returns_pagination(self, client):
        for i in range(25):
            _create_line(text=f"テスト文{i}")
        resp = client.get("/api/search-sentences?q=テスト&page=1&page_size=10")
        data = resp.get_json()
        assert data["total"] == 25
        assert data["page"] == 1
        assert data["page_size"] == 10
        assert len(data["results"]) == 10
        assert data["total_pages"] == 3

    def test_search_page_2(self, client):
        for i in range(25):
            _create_line(text=f"テスト文{i}")
        resp = client.get("/api/search-sentences?q=テスト&page=2&page_size=10")
        data = resp.get_json()
        assert len(data["results"]) == 10
        assert data["page"] == 2

    def test_regex_search(self, client):
        _create_line(text="テスト123")
        _create_line(text="テストabc")
        resp = client.get("/api/search-sentences?q=テスト\\d%2B&use_regex=true")
        data = resp.get_json()
        assert data["total"] == 1
        assert "123" in data["results"][0]["sentence"]

    def test_invalid_regex_returns_400(self, client):
        resp = client.get("/api/search-sentences?q=[invalid&use_regex=true")
        assert resp.status_code == 400

    def test_game_filter(self, client):
        _create_line(game_name="Game A", text="テスト文A")
        _create_line(game_name="Game B", text="テスト文B")
        resp = client.get("/api/search-sentences?q=テスト&game=Game+A")
        data = resp.get_json()
        assert data["total"] == 1
        assert data["results"][0]["game_name"] == "Game A"

    def test_invalid_date_returns_400(self, client):
        resp = client.get("/api/search-sentences?q=test&from_date=not-a-date")
        assert resp.status_code == 400

    def test_sort_by_date_asc(self, client):
        _create_line(text="テストA", timestamp=2000.0)
        _create_line(text="テストB", timestamp=1000.0)
        resp = client.get("/api/search-sentences?q=テスト&sort=date_asc")
        data = resp.get_json()
        assert data["results"][0]["timestamp"] <= data["results"][1]["timestamp"]

    def test_sort_by_date_desc(self, client):
        _create_line(text="テストA", timestamp=1000.0)
        _create_line(text="テストB", timestamp=2000.0)
        resp = client.get("/api/search-sentences?q=テスト&sort=date_desc")
        data = resp.get_json()
        assert data["results"][0]["timestamp"] >= data["results"][1]["timestamp"]

    def test_sort_by_length_desc(self, client):
        _create_line(text="短テスト")
        _create_line(text="とても長いテスト文章です")
        resp = client.get("/api/search-sentences?q=テスト&sort=length_desc")
        data = resp.get_json()
        assert len(data["results"][0]["sentence"]) >= len(data["results"][1]["sentence"])

    def test_no_results(self, client):
        _create_line(text="日本語")
        resp = client.get("/api/search-sentences?q=存在しない")
        data = resp.get_json()
        assert data["total"] == 0
        assert data["results"] == []

    def test_results_include_metadata(self, client):
        _create_line(text="メタテスト", game_name="MetaGame", timestamp=1700000000.0)
        resp = client.get("/api/search-sentences?q=メタ")
        r = resp.get_json()["results"][0]
        assert r["game_name"] == "MetaGame"
        assert "id" in r
        assert "timestamp" in r


# ===================================================================
# /api/games-list
# ===================================================================


class TestGamesList:
    def test_empty_database(self, client):
        resp = client.get("/api/games-list")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["games"] == []

    def test_lists_games_with_metadata(self, client):
        _create_line(game_name="My Game", text="あいう", timestamp=1700000000.0)
        _create_line(game_name="My Game", text="えおか", timestamp=1700100000.0)
        resp = client.get("/api/games-list")
        data = resp.get_json()
        assert len(data["games"]) == 1
        game = data["games"][0]
        assert game["name"] == "My Game"
        assert game["sentence_count"] == 2
        assert game["total_characters"] == 6

    def test_multiple_games_sorted_by_chars(self, client):
        _create_line(game_name="Small", text="あ", timestamp=1700000000.0)
        _create_line(game_name="Big", text="あいうえおかきくけこ", timestamp=1700000000.0)
        resp = client.get("/api/games-list")
        games = resp.get_json()["games"]
        assert games[0]["name"] == "Big"


# ===================================================================
# /api/delete-sentence-lines
# ===================================================================


class TestDeleteSentenceLines:
    def test_no_ids_returns_400(self, client):
        resp = client.post("/api/delete-sentence-lines", json={"line_ids": []})
        assert resp.status_code == 400

    def test_invalid_type_returns_400(self, client):
        resp = client.post("/api/delete-sentence-lines", json={"line_ids": "not-a-list"})
        assert resp.status_code == 400

    def test_delete_existing_lines(self, client):
        line1 = _create_line(text="削除する1")
        line2 = _create_line(text="削除する2")
        resp = client.post("/api/delete-sentence-lines", json={"line_ids": [line1.id, line2.id]})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["deleted_count"] == 2

    def test_partial_deletion(self, client):
        line = _create_line(text="存在する")
        resp = client.post(
            "/api/delete-sentence-lines",
            json={"line_ids": [line.id, "nonexistent-id"]},
        )
        assert resp.status_code == 200
        # At least the existing line should be counted
        data = resp.get_json()
        assert data["deleted_count"] >= 1


# ===================================================================
# /api/delete-games
# ===================================================================


class TestDeleteGames:
    def test_no_games_returns_400(self, client):
        resp = client.post("/api/delete-games", json={"game_names": []})
        assert resp.status_code == 400

    def test_nonexistent_game_returns_400(self, client):
        resp = client.post("/api/delete-games", json={"game_names": ["DoesNotExist"]})
        assert resp.status_code == 400

    def test_delete_existing_game(self, client):
        _create_line(game_name="DeleteMe", text="テスト")
        resp = client.post("/api/delete-games", json={"game_names": ["DeleteMe"]})
        assert resp.status_code == 200
        data = resp.get_json()
        assert "DeleteMe" in data["successful_games"]
        assert data["total_sentences_deleted"] >= 1

    def test_delete_multiple_games(self, client):
        _create_line(game_name="Game1", text="A")
        _create_line(game_name="Game2", text="B")
        resp = client.post("/api/delete-games", json={"game_names": ["Game1", "Game2"]})
        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["successful_games"]) == 2


# ===================================================================
# /api/preview-text-deletion & /api/delete-text-lines
# ===================================================================


class TestTextDeletion:
    def test_preview_exact_text(self, client):
        _create_line(text="ログ出力テスト")
        _create_line(text="別のテスト")
        resp = client.post(
            "/api/preview-text-deletion",
            json={
                "exact_text": "ログ出力",
                "case_sensitive": False,
                "use_regex": False,
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["count"] == 1

    def test_preview_regex(self, client):
        _create_line(text="テスト123")
        _create_line(text="テスト456")
        _create_line(text="テストabc")
        resp = client.post(
            "/api/preview-text-deletion",
            json={
                "regex_pattern": r"テスト\d+",
                "use_regex": True,
            },
        )
        data = resp.get_json()
        assert data["count"] == 2

    def test_preview_no_pattern_returns_400(self, client):
        resp = client.post("/api/preview-text-deletion", json={})
        assert resp.status_code == 400

    def test_delete_exact_text(self, client):
        _create_line(text="削除ターゲット")
        _create_line(text="残すテスト")
        resp = client.post(
            "/api/delete-text-lines",
            json={
                "exact_text": "削除ターゲット",
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["deleted_count"] == 1

    def test_delete_regex_text(self, client):
        _create_line(text="ログ001")
        _create_line(text="ログ002")
        _create_line(text="残す文")
        resp = client.post(
            "/api/delete-text-lines",
            json={
                "regex_pattern": r"ログ\d+",
                "use_regex": True,
            },
        )
        data = resp.get_json()
        assert data["deleted_count"] == 2

    def test_delete_no_pattern_returns_400(self, client):
        resp = client.post("/api/delete-text-lines", json={})
        assert resp.status_code == 400


# ===================================================================
# /api/preview-deduplication & /api/deduplicate
# ===================================================================


class TestDeduplication:
    def test_preview_finds_duplicates_in_time_window(self, client):
        base_ts = 1700000000.0
        _create_line(game_name="Game", text="重複テスト", timestamp=base_ts)
        _create_line(game_name="Game", text="重複テスト", timestamp=base_ts + 60)  # within 5 min
        _create_line(game_name="Game", text="ユニーク", timestamp=base_ts + 120)
        resp = client.post(
            "/api/preview-deduplication",
            json={
                "games": ["Game"],
                "time_window_minutes": 5,
            },
        )
        data = resp.get_json()
        assert data["duplicates_count"] == 1

    def test_preview_ignoring_time_window(self, client):
        _create_line(game_name="Game", text="重複", timestamp=1000.0)
        _create_line(game_name="Game", text="重複", timestamp=9000.0)  # far apart
        resp = client.post(
            "/api/preview-deduplication",
            json={
                "games": ["Game"],
                "ignore_time_window": True,
            },
        )
        data = resp.get_json()
        assert data["duplicates_count"] == 1

    def test_preview_no_games_returns_400(self, client):
        resp = client.post("/api/preview-deduplication", json={"games": []})
        assert resp.status_code == 400

    def test_deduplicate_removes_duplicates(self, client):
        base_ts = 1700000000.0
        _create_line(game_name="Game", text="重複テスト", timestamp=base_ts)
        _create_line(game_name="Game", text="重複テスト", timestamp=base_ts + 30)
        resp = client.post(
            "/api/deduplicate",
            json={
                "games": ["Game"],
                "time_window_minutes": 5,
            },
        )
        data = resp.get_json()
        assert data["deleted_count"] == 1

    def test_deduplicate_all_games(self, client):
        base_ts = 1700000000.0
        _create_line(game_name="A", text="同じ", timestamp=base_ts)
        _create_line(game_name="A", text="同じ", timestamp=base_ts + 10)
        _create_line(game_name="B", text="同じ", timestamp=base_ts)
        _create_line(game_name="B", text="同じ", timestamp=base_ts + 10)
        resp = client.post(
            "/api/deduplicate",
            json={
                "games": ["all"],
                "time_window_minutes": 5,
            },
        )
        data = resp.get_json()
        assert data["deleted_count"] == 2


# ===================================================================
# /api/search-duplicates
# ===================================================================


class TestSearchDuplicates:
    def test_finds_duplicates(self, client):
        base_ts = 1700000000.0
        _create_line(game_name="G", text="ダブり", timestamp=base_ts)
        _create_line(game_name="G", text="ダブり", timestamp=base_ts + 30)
        _create_line(game_name="G", text="ユニーク", timestamp=base_ts + 60)
        resp = client.post(
            "/api/search-duplicates",
            json={
                "game": "G",
                "time_window_minutes": 5,
            },
        )
        data = resp.get_json()
        assert data["duplicates_found"] == 1
        assert data["search_mode"] == "duplicates"

    def test_no_body_returns_error(self, client):
        resp = client.post("/api/search-duplicates", data="", content_type="application/json")
        assert resp.status_code in (400, 500)


# ===================================================================
# /api/merge_games
# ===================================================================


class TestMergeGames:
    def test_merge_success(self, client):
        game_a = _create_game("Target")
        _create_line(game_name="Target", text="A", game_id=game_a.id)
        _create_line(game_name="Source", text="B")
        resp = client.post(
            "/api/merge_games",
            json={
                "target_game": "Target",
                "games_to_merge": ["Source"],
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["lines_moved"] >= 1

    def test_merge_no_target_returns_400(self, client):
        resp = client.post(
            "/api/merge_games",
            json={
                "target_game": "",
                "games_to_merge": ["Source"],
            },
        )
        assert resp.status_code == 400

    def test_merge_no_sources_returns_400(self, client):
        resp = client.post(
            "/api/merge_games",
            json={
                "target_game": "Target",
                "games_to_merge": [],
            },
        )
        assert resp.status_code == 400

    def test_merge_invalid_source_returns_400(self, client):
        _create_line(game_name="Target", text="A")
        resp = client.post(
            "/api/merge_games",
            json={
                "target_game": "Target",
                "games_to_merge": ["NonexistentGame"],
            },
        )
        assert resp.status_code == 400


# ===================================================================
# /api/migrate-lines
# ===================================================================


class TestMigrateLines:
    def test_migrate_lines_success(self, client):
        target_game = _create_game("TargetGame")
        _create_line(game_name="TargetGame", text="ターゲット", game_id=target_game.id)
        source_line = _create_line(game_name="SourceGame", text="ソース")
        resp = client.post(
            "/api/migrate-lines",
            json={
                "line_ids": [source_line.id],
                "target_game": "TargetGame",
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["migrated_count"] == 1

    def test_migrate_no_ids_returns_400(self, client):
        resp = client.post(
            "/api/migrate-lines",
            json={
                "line_ids": [],
                "target_game": "Target",
            },
        )
        assert resp.status_code == 400

    def test_migrate_no_target_returns_400(self, client):
        resp = client.post(
            "/api/migrate-lines",
            json={
                "line_ids": ["some-id"],
                "target_game": "",
            },
        )
        assert resp.status_code == 400


# ===================================================================
# /api/delete-regex-in-game-lines
# ===================================================================


class TestDeleteRegexInGameLines:
    def test_removes_pattern_from_text(self, client):
        _create_line(text="テスト【注釈】文")
        _create_line(text="テスト文")
        resp = client.post(
            "/api/delete-regex-in-game-lines",
            json={
                "regex_pattern": r"【.*?】",
            },
        )
        data = resp.get_json()
        assert resp.status_code == 200
        assert data["updated_count"] == 1

    def test_invalid_regex_returns_400(self, client):
        resp = client.post(
            "/api/delete-regex-in-game-lines",
            json={
                "regex_pattern": "[invalid",
            },
        )
        assert resp.status_code == 400

    def test_no_pattern_returns_400(self, client):
        resp = client.post("/api/delete-regex-in-game-lines", json={})
        assert resp.status_code == 400


# ===================================================================
# Core functions: delete_text_lines(), deduplicate_lines_core()
# ===================================================================


class TestDeleteTextLinesCore:
    def test_exact_text_deletion(self):
        from GameSentenceMiner.web.database_api import delete_text_lines

        _create_line(text="削除対象テスト")
        _create_line(text="残すテスト")
        result = delete_text_lines(exact_text="削除対象")
        assert result["deleted_count"] == 1

    def test_regex_deletion(self):
        from GameSentenceMiner.web.database_api import delete_text_lines

        _create_line(text="ログ001")
        _create_line(text="ログ002")
        _create_line(text="テスト")
        result = delete_text_lines(regex_pattern=r"ログ\d+", use_regex=True)
        assert result["deleted_count"] == 2

    def test_no_pattern_raises(self):
        from GameSentenceMiner.web.database_api import delete_text_lines

        with pytest.raises(ValueError):
            delete_text_lines()

    def test_case_insensitive_match(self):
        from GameSentenceMiner.web.database_api import delete_text_lines

        _create_line(text="Hello World")
        result = delete_text_lines(exact_text="hello world", case_sensitive=False)
        assert result["deleted_count"] == 1

    def test_case_sensitive_no_match(self):
        from GameSentenceMiner.web.database_api import delete_text_lines

        _create_line(text="Hello World")
        result = delete_text_lines(exact_text="hello world", case_sensitive=True)
        assert result["deleted_count"] == 0


class TestDeduplicateLinesCore:
    def test_deduplicate_within_time_window(self):
        from GameSentenceMiner.web.database_api import deduplicate_lines_core

        base_ts = 1700000000.0
        _create_line(game_name="G", text="重複", timestamp=base_ts)
        _create_line(game_name="G", text="重複", timestamp=base_ts + 30)
        result = deduplicate_lines_core(games=["G"], time_window_minutes=5)
        assert result["deleted_count"] == 1

    def test_deduplicate_outside_time_window_not_removed(self):
        from GameSentenceMiner.web.database_api import deduplicate_lines_core

        _create_line(game_name="G", text="重複", timestamp=1000.0)
        _create_line(game_name="G", text="重複", timestamp=9000.0)  # >5 min apart
        result = deduplicate_lines_core(games=["G"], time_window_minutes=5)
        assert result["deleted_count"] == 0

    def test_deduplicate_ignore_time_window(self):
        from GameSentenceMiner.web.database_api import deduplicate_lines_core

        _create_line(game_name="G", text="重複", timestamp=1000.0)
        _create_line(game_name="G", text="重複", timestamp=9000.0)
        result = deduplicate_lines_core(games=["G"], ignore_time_window=True)
        assert result["deleted_count"] == 1

    def test_no_games_raises(self):
        from GameSentenceMiner.web.database_api import deduplicate_lines_core

        with pytest.raises(ValueError):
            deduplicate_lines_core(games=[])

    def test_preserve_newest(self):
        from GameSentenceMiner.web.database_api import deduplicate_lines_core

        base_ts = 1700000000.0
        old_line = _create_line(game_name="G", text="重複", timestamp=base_ts)
        new_line = _create_line(game_name="G", text="重複", timestamp=base_ts + 30)
        result = deduplicate_lines_core(games=["G"], time_window_minutes=5, preserve_newest=True)
        assert result["deleted_count"] == 1
        # The old line should have been deleted; the new one should remain
        assert GameLinesTable.get(new_line.id) is not None
        assert GameLinesTable.get(old_line.id) is None
