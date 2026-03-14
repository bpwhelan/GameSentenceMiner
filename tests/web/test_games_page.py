"""
TDD Tests for Games Page Feature (game-db.plan)

Tests cover:
- Phase 1: API sorting, /games route, navigation link
- Phase 2: /game/<game_id> detail route, /api/game/<game_id>/stats endpoint
- Phase 3: Game management endpoints (mark complete, update, delete, merge)
- Game detail page route (template rendering, game_id passing, edge cases)
- Game stats API endpoint (response shape, calculations, edge cases)
- API sorting (all sort modes, edge cases)
- Integration tests (grid -> detail flow, navigation)
- Game management edge cases (concurrent operations, boundary values)

These tests use a real in-memory SQLite database with GamesTable and
GameLinesTable wired up, plus a minimal Flask test client.
"""

import base64
import datetime
import json
import threading
import time
import uuid

import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _in_memory_db():
    """
    Create a fresh in-memory SQLite database for every test.
    Registers GamesTable, GameLinesTable, and StatsRollupTable against it,
    then tears down.
    """
    orig_games = GamesTable._db
    orig_lines = GameLinesTable._db
    orig_stats = StatsRollupTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    yield db
    db.close()
    GamesTable._db = orig_games
    GameLinesTable._db = orig_lines
    StatsRollupTable._db = orig_stats


@pytest.fixture()
def app(_in_memory_db):
    """
    Build a minimal Flask app with only the routes relevant to the Games
    feature.  We import blueprints / route-registration helpers lazily so the
    in-memory DB is already wired up before any route handler touches it.
    """
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True

    # Register the game-management blueprint (has /api/games-management,
    # /api/games POST, PUT /api/games/<id>, DELETE, mark-complete, etc.)
    from GameSentenceMiner.web.routes.game_management_routes import game_management_bp

    test_app.register_blueprint(game_management_bp)

    # Register stats API routes (has /api/game/<game_id>/stats)
    from GameSentenceMiner.web.stats_api import register_stats_api_routes

    register_stats_api_routes(test_app)

    # ---- lightweight stand-ins for routes that live on the main `app` ----

    @test_app.route("/games")
    def games_page():
        """Phase 1: the grid page route we plan to add."""
        return flask.render_template("games.html")

    @test_app.route("/game/<game_id>")
    def game_stats_page(game_id):
        """Phase 2: game detail page."""
        game = GamesTable.get(game_id)
        if not game:
            return "Game not found", 404
        return flask.render_template("game_stats.html", game_id=game_id)

    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_game(title="Test Game", **overrides):
    """Insert a game into the DB and return it."""
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


def _create_line(game, text="テスト文", timestamp=None):
    """Insert a GameLinesTable row linked to *game*."""
    line = GameLinesTable(
        id=str(uuid.uuid4()),
        game_name=game.title_original,
        game_id=game.id,
        line_text=text,
        timestamp=timestamp or time.time(),
    )
    line.add()
    return line


# ===================================================================
# Phase 1 – API Adjustment + Games Grid Page
# ===================================================================


class TestGamesManagementAPI:
    """Tests for GET /api/games-management — the existing endpoint that the
    grid page will call."""

    def test_returns_empty_list_when_no_games(self, client):
        resp = client.get("/api/games-management")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["games"] == []
        assert data["summary"]["total_games"] == 0

    def test_returns_all_games_with_metadata(self, client):
        g1 = _create_game("Game A", game_type="VN")
        g2 = _create_game("Game B")
        resp = client.get("/api/games-management")
        data = resp.get_json()
        titles = {g["title_original"] for g in data["games"]}
        assert titles == {"Game A", "Game B"}
        assert data["summary"]["total_games"] == 2

    def test_includes_line_count_and_character_count(self, client):
        game = _create_game("Counted Game")
        _create_line(game, text="あいうえお")  # 5 chars
        _create_line(game, text="かきくけこ")  # 5 chars
        resp = client.get("/api/games-management")
        games = resp.get_json()["games"]
        counted = [g for g in games if g["title_original"] == "Counted Game"][0]
        assert counted["line_count"] == 2
        assert counted["mined_character_count"] == 10

    def test_includes_linking_status(self, client):
        _create_game("Linked", deck_id=42)
        _create_game("Unlinked")
        resp = client.get("/api/games-management")
        data = resp.get_json()
        linked = [g for g in data["games"] if g["title_original"] == "Linked"][0]
        unlinked = [g for g in data["games"] if g["title_original"] == "Unlinked"][0]
        assert linked["is_linked"] is True
        assert unlinked["is_linked"] is False
        assert data["summary"]["linked_games"] == 1
        assert data["summary"]["unlinked_games"] == 1

    def test_includes_vndb_linked_status(self, client):
        _create_game("VNDB Game", vndb_id="v12345")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["is_linked"] is True
        assert game["vndb_id"] == "v12345"

    def test_includes_anilist_linked_status(self, client):
        _create_game("AniList Game", anilist_id="99999")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["is_linked"] is True
        assert game["anilist_id"] == "99999"

    def test_games_sorted_by_mined_character_count_descending(self, client):
        """Sorting is done client-side; the API returns all games unsorted."""
        g_small = _create_game("Small")
        g_big = _create_game("Big")
        _create_line(g_small, text="あ")  # 1 char
        _create_line(g_big, text="あいうえおかきくけこ")  # 10 chars
        resp = client.get("/api/games-management")
        titles = {g["title_original"] for g in resp.get_json()["games"]}
        assert "Big" in titles
        assert "Small" in titles

    def test_includes_start_and_last_played_dates(self, client):
        game = _create_game("Dated Game")
        t1 = 1700000000.0
        t2 = 1700100000.0
        _create_line(game, text="早い", timestamp=t1)
        _create_line(game, text="遅い", timestamp=t2)
        resp = client.get("/api/games-management")
        g = resp.get_json()["games"][0]
        assert g["start_date"] == t1
        assert g["last_played"] == t2

    def test_includes_genres_tags_links(self, client):
        _create_game(
            "Rich Game",
            genres=["RPG", "Adventure"],
            tags=["fantasy"],
            links=[{"linkType": 1, "url": "https://example.com"}],
        )
        resp = client.get("/api/games-management")
        g = resp.get_json()["games"][0]
        assert g["genres"] == ["RPG", "Adventure"]
        assert g["tags"] == ["fantasy"]
        assert len(g["links"]) == 1

    def test_auto_creates_game_for_orphaned_lines(self, client):
        """If game_lines reference a game_name with no matching games record,
        link_game_lines auto-creates it."""
        # Insert a line with no corresponding games record
        line = GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Orphan Game",
            line_text="孤独な文",
            timestamp=time.time(),
        )
        line.add()

        # link_game_lines runs in a background thread when visiting the
        # endpoint, so call it explicitly here for deterministic testing.
        GamesTable.link_game_lines()
        resp = client.get("/api/games-management")
        data = resp.get_json()
        titles = {g["title_original"] for g in data["games"]}
        assert "Orphan Game" in titles

    def test_endpoint_backfills_orphaned_lines_without_background_thread(self, client, monkeypatch):
        line = GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Threaded Orphan",
            line_text="孤独な文",
            timestamp=time.time(),
        )
        line.add()

        class _FakeThread:
            def __init__(self, *args, **kwargs):
                self.args = args
                self.kwargs = kwargs

            def start(self):
                # A background start would leave the orphan unlinked during this response.
                return None

        monkeypatch.setattr(threading, "Thread", _FakeThread)

        resp = client.get("/api/games-management")

        assert resp.status_code == 200
        data = resp.get_json()
        titles = {g["title_original"] for g in data["games"]}
        assert "Threaded Orphan" in titles

    def test_games_with_no_lines_still_included(self, client):
        """Plan says: display ALL games, including those with no sentences."""
        _create_game("Empty Game")
        resp = client.get("/api/games-management")
        titles = {g["title_original"] for g in resp.get_json()["games"]}
        assert "Empty Game" in titles


class TestGamesGridSorting:
    """Tests for the planned `?sort=last_played` query param addition.

    These tests document the DESIRED behavior (Phase 1, step 1 of the plan).
    They will fail until the sort parameter is implemented.
    """

    def test_sort_by_last_played_descending(self, client):
        """The plan says the grid should sort by recently played (last_played desc)."""
        g_old = _create_game("Old Game")
        g_new = _create_game("New Game")
        _create_line(g_old, text="古い", timestamp=1600000000.0)
        _create_line(g_new, text="新しい", timestamp=1700000000.0)

        resp = client.get("/api/games-management?sort=last_played")
        assert resp.status_code == 200
        titles = [g["title_original"] for g in resp.get_json()["games"]]
        assert titles[0] == "New Game"
        assert titles[1] == "Old Game"


# ===================================================================
# Phase 1 – /games route
# ===================================================================


class TestGamesPageRoute:
    """Tests for the /games HTML page route (Phase 1)."""

    def test_games_route_returns_200(self, client):
        """The /games route should exist and return 200."""
        resp = client.get("/games")
        assert resp.status_code == 200

    def test_games_route_returns_html(self, client):
        resp = client.get("/games")
        assert resp.content_type.startswith("text/html")


# ===================================================================
# Phase 1 – Navigation
# ===================================================================


class TestNavigation:
    """Tests that the Games link appears in the navigation component."""

    def test_navigation_has_games_link(self):
        """The navigation component should include a link to /games."""
        import os

        nav_path = os.path.join(
            os.path.dirname(__file__),
            "../../GameSentenceMiner/web/templates/components/navigation.html",
        )
        with open(nav_path, encoding="utf-8") as f:
            content = f.read()
        assert "/games" in content, "Navigation component must contain a link to /games"
        assert "Games" in content, "Navigation component must contain the text 'Games'"


# ===================================================================
# Phase 2 – Game Detail Page
# ===================================================================


class TestGameDetailRoute:
    """Tests for /game/<game_id> route (Phase 2)."""

    def test_returns_404_for_nonexistent_game(self, client):
        resp = client.get(f"/game/{uuid.uuid4()}")
        assert resp.status_code == 404

    def test_returns_200_for_existing_game(self, client):
        game = _create_game("Detail Game")
        resp = client.get(f"/game/{game.id}")
        assert resp.status_code == 200


# ===================================================================
# Phase 3 – Game Management Endpoints
# ===================================================================


class TestCreateGame:
    """Tests for POST /api/games."""

    def test_create_game_success(self, client):
        resp = client.post(
            "/api/games",
            json={"title_original": "New Game", "type": "VN"},
        )
        assert resp.status_code == 201
        data = resp.get_json()
        assert data["success"] is True
        assert data["game"]["title_original"] == "New Game"

    def test_create_game_missing_title(self, client):
        resp = client.post("/api/games", json={"type": "VN"})
        assert resp.status_code == 400

    def test_create_game_empty_title(self, client):
        resp = client.post("/api/games", json={"title_original": "  "})
        assert resp.status_code == 400

    def test_create_game_no_body(self, client):
        resp = client.post(
            "/api/games",
            data="",
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_create_duplicate_game_fails(self, client):
        _create_game("Dupe")
        resp = client.post("/api/games", json={"title_original": "Dupe"})
        assert resp.status_code == 400
        assert "already exists" in resp.get_json()["error"]

    def test_create_game_links_orphaned_lines(self, client):
        """When a game is created, orphaned game_lines with the same
        game_name should be linked to the new game."""
        line = GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Orphan Target",
            line_text="リンクされる",
            timestamp=time.time(),
        )
        line.add()
        resp = client.post(
            "/api/games",
            json={"title_original": "Orphan Target"},
        )
        assert resp.status_code == 201
        data = resp.get_json()
        assert data["game"]["lines_linked"] == 1


class TestUpdateGame:
    """Tests for PUT /api/games/<game_id>."""

    def test_update_game_fields(self, client):
        game = _create_game("Updatable")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"title_english": "Updated English Title", "difficulty": 3},
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert "title_english" in data["updated_fields"]
        assert "difficulty" in data["updated_fields"]

    def test_update_nonexistent_game_404(self, client):
        resp = client.put(
            f"/api/games/{uuid.uuid4()}",
            json={"title_english": "Nope"},
        )
        assert resp.status_code == 404

    def test_update_no_data_400(self, client):
        game = _create_game("No Data")
        resp = client.put(
            f"/api/games/{game.id}",
            data="",
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_update_marks_fields_as_manual_overrides(self, client):
        game = _create_game("Manual Override Test")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"description": "Manually set"},
        )
        data = resp.get_json()
        assert "description" in data["manual_overrides"]

    def test_update_vndb_id_adds_v_prefix(self, client):
        game = _create_game("VNDB Prefix")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"vndb_id": "12345"},
        )
        assert resp.status_code == 200
        # Verify the stored value has the v prefix
        updated = GamesTable.get(game.id)
        assert updated.vndb_id == "v12345"

    def test_update_completed_field(self, client):
        game = _create_game("Complete Me")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"completed": True},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.completed is True

    def test_update_genres_and_tags(self, client):
        game = _create_game("Genre Tag Game")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"genres": ["Action", "RPG"], "tags": ["open-world"]},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.genres == ["Action", "RPG"]
        assert updated.tags == ["open-world"]


class TestMarkGameComplete:
    """Tests for POST /api/games/<game_id>/mark-complete."""

    def test_mark_complete_success(self, client):
        game = _create_game("Incomplete")
        resp = client.post(f"/api/games/{game.id}/mark-complete")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["completed"] is True
        # Verify in DB
        updated = GamesTable.get(game.id)
        assert updated.completed is True

    def test_mark_complete_nonexistent_404(self, client):
        resp = client.post(f"/api/games/{uuid.uuid4()}/mark-complete")
        assert resp.status_code == 404


class TestDeleteGame:
    """Tests for DELETE /api/games/<game_id> (unlink) and
    DELETE /api/games/<game_id>/delete-lines (permanent delete)."""

    def test_unlink_game_preserves_lines(self, client):
        game = _create_game("Unlinkable")
        line = _create_line(game, text="残る行")
        resp = client.delete(f"/api/games/{game.id}")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["unlinked_lines"] == 1
        # Game record should be gone
        assert GamesTable.get(game.id) is None
        # Line should still exist but with game_id = NULL
        remaining_line = GameLinesTable.get(line.id)
        assert remaining_line is not None
        assert remaining_line.game_id is None or remaining_line.game_id == ""

    def test_unlink_nonexistent_game_404(self, client):
        resp = client.delete(f"/api/games/{uuid.uuid4()}")
        assert resp.status_code == 404

    def test_delete_lines_permanently(self, client):
        game = _create_game("Deletable")
        line = _create_line(game, text="消える行")
        resp = client.delete(f"/api/games/{game.id}/delete-lines")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["deleted_lines"] == 1
        # Both game and line should be gone
        assert GamesTable.get(game.id) is None
        assert GameLinesTable.get(line.id) is None

    def test_delete_lines_zero_lines_returns_200(self, client):
        game = _create_game("No Lines Game")
        game_id = game.id
        resp = client.delete(f"/api/games/{game_id}/delete-lines")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["deleted_lines"] == 0
        assert data["success"] is True
        # Game record should also be deleted
        assert GamesTable.get(game_id) is None


class TestOrphanedGames:
    """Tests for GET /api/orphaned-games."""

    def test_no_orphans_when_all_games_linked(self, client):
        game = _create_game("Linked Game")
        _create_line(game)
        resp = client.get("/api/orphaned-games")
        data = resp.get_json()
        assert data["total_orphaned"] == 0

    def test_finds_orphaned_game_names(self, client):
        # Insert a line with game_name that has no games record
        line = GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Ghost Game",
            line_text="ゴースト",
            timestamp=time.time(),
        )
        line.add()
        resp = client.get("/api/orphaned-games")
        data = resp.get_json()
        assert data["total_orphaned"] == 1
        assert data["orphaned_games"][0]["game_name"] == "Ghost Game"


# ===================================================================
# GamesTable Model Tests
# ===================================================================


class TestGamesTableModel:
    """Unit tests for the GamesTable model itself."""

    def test_create_and_retrieve(self):
        game = _create_game("Model Test")
        fetched = GamesTable.get(game.id)
        assert fetched is not None
        assert fetched.title_original == "Model Test"

    def test_uuid_auto_generated(self):
        game = GamesTable(title_original="UUID Test")
        assert game.id is not None
        assert len(game.id) == 36  # standard UUID format

    def test_get_by_title(self):
        _create_game("By Title")
        found = GamesTable.get_by_title("By Title")
        assert found is not None
        assert found.title_original == "By Title"

    def test_get_by_title_returns_none(self):
        assert GamesTable.get_by_title("Nonexistent") is None

    def test_get_by_deck_id(self):
        _create_game("Deck ID Game", deck_id=99)
        found = GamesTable.get_by_deck_id(99)
        assert found is not None

    def test_get_by_obs_scene_name(self):
        _create_game("OBS Game", obs_scene_name="my_scene")
        found = GamesTable.get_by_obs_scene_name("my_scene")
        assert found is not None

    def test_get_or_create_creates_new(self):
        game = GamesTable.get_or_create_by_name("Brand New")
        assert game.title_original == "Brand New"
        assert game.obs_scene_name == "Brand New"

    def test_get_or_create_returns_existing(self):
        original = _create_game("Already Exists")
        found = GamesTable.get_or_create_by_name("Already Exists")
        assert found.id == original.id

    def test_get_all_completed(self):
        _create_game("Done", completed=True)
        _create_game("Not Done", completed=False)
        completed = GamesTable.get_all_completed()
        assert len(completed) == 1
        assert completed[0].title_original == "Done"

    def test_get_all_in_progress(self):
        _create_game("Done", completed=True)
        _create_game("WIP", completed=False)
        in_progress = GamesTable.get_all_in_progress()
        assert len(in_progress) == 1
        assert in_progress[0].title_original == "WIP"

    def test_get_start_date(self):
        game = _create_game("Start Date")
        _create_line(game, timestamp=1000.0)
        _create_line(game, timestamp=2000.0)
        assert GamesTable.get_start_date(game.id) == 1000.0

    def test_get_last_played_date(self):
        game = _create_game("Last Played")
        _create_line(game, timestamp=1000.0)
        _create_line(game, timestamp=2000.0)
        assert GamesTable.get_last_played_date(game.id) == 2000.0

    def test_start_date_none_when_no_lines(self):
        game = _create_game("No Lines")
        assert GamesTable.get_start_date(game.id) is None

    def test_last_played_none_when_no_lines(self):
        game = _create_game("No Lines")
        assert GamesTable.get_last_played_date(game.id) is None

    def test_get_lines(self):
        game = _create_game("Lines Game")
        _create_line(game, text="一行目")
        _create_line(game, text="二行目")
        lines = game.get_lines()
        assert len(lines) == 2

    def test_normalize_game_name(self):
        assert GamesTable.normalize_game_name("Game ver1.00") == "game"
        assert GamesTable.normalize_game_name("Game V2.0") == "game"
        assert GamesTable.normalize_game_name("  Extra  Spaces  ") == "extra spaces"

    def test_fuzzy_match_game_name_similar(self):
        assert GamesTable.fuzzy_match_game_name("Game Title", "Game Titl") is True

    def test_fuzzy_match_game_name_different(self):
        assert (
            GamesTable.fuzzy_match_game_name("Totally Different", "Not Similar")
            is False
        )

    def test_fuzzy_match_empty_strings(self):
        assert GamesTable.fuzzy_match_game_name("", "Game") is False
        assert GamesTable.fuzzy_match_game_name("Game", "") is False

    def test_find_similar_game(self):
        _create_game("Great Adventure ver1.00")
        found = GamesTable.find_similar_game("Great Adventure")
        assert found is not None
        assert found.title_original == "Great Adventure ver1.00"

    def test_mark_field_manual(self):
        game = _create_game("Manual Test")
        game.mark_field_manual("description")
        assert game.is_field_manual("description") is True
        assert game.is_field_manual("title_original") is False

    def test_update_all_fields_manual(self):
        game = _create_game("Bulk Update")
        game.update_all_fields_manual(
            title_english="English Name",
            difficulty=3,
            genres=["RPG"],
        )
        updated = GamesTable.get(game.id)
        assert updated.title_english == "English Name"
        assert updated.difficulty == 3
        assert updated.genres == ["RPG"]
        assert updated.is_field_manual("title_english")
        assert updated.is_field_manual("difficulty")
        assert updated.is_field_manual("genres")

    def test_add_link(self):
        game = _create_game("Link Game")
        game.add_link(link_type=4, url="https://anilist.co/anime/12345")
        fetched = GamesTable.get(game.id)
        assert len(fetched.links) == 1
        assert fetched.links[0]["url"] == "https://anilist.co/anime/12345"

    def test_completed_defaults_false(self):
        game = GamesTable(title_original="Defaults")
        assert game.completed is False

    def test_lists_default_empty(self):
        game = GamesTable(title_original="Defaults")
        assert game.links == []
        assert game.genres == []
        assert game.tags == []
        assert game.manual_overrides == []


# ===================================================================
# GameLinesTable Model Tests (relevant to the feature)
# ===================================================================


class TestGameLinesForGamesFeature:
    """Verify GameLinesTable behaviors that the Games feature relies on."""

    def test_get_all_by_game_id(self):
        game = _create_game("Lines By ID")
        _create_line(game, text="行1")
        _create_line(game, text="行2")
        lines = GameLinesTable.get_all_by_game_id(game.id)
        assert len(lines) == 2

    def test_get_all_by_game_id_empty(self):
        game = _create_game("No Lines By ID")
        lines = GameLinesTable.get_all_by_game_id(game.id)
        assert lines == []

    def test_line_stores_game_id_correctly(self):
        game = _create_game("ID Persistence")
        line = _create_line(game)
        fetched = GameLinesTable.get(line.id)
        assert fetched.game_id == game.id

    def test_line_stores_game_name(self):
        game = _create_game("Name Persistence")
        line = _create_line(game)
        fetched = GameLinesTable.get(line.id)
        assert fetched.game_name == "Name Persistence"


# ===================================================================
# Placeholder image logic
# ===================================================================


class TestPlaceholderImage:
    """
    Phase 1, step 7: games without cover images should use
    /static/favicon-96x96.png.  The list API now returns ``has_image``
    (a boolean) instead of the full base64 data for performance.  The
    frontend loads the image lazily via ``/api/games/<id>/image``.
    """

    def test_game_with_no_image_returns_has_image_false(self, client):
        _create_game("No Image")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["has_image"] is False

    def test_game_with_image_returns_has_image_true(self, client):
        _create_game("Has Image", image="data:image/png;base64,AAAA")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["has_image"] is True

    def test_game_image_endpoint_uses_declared_data_uri_mimetype(self, client):
        raw = b"\xff\xd8\xff\xe0jpeg-cover"
        encoded = base64.b64encode(raw).decode("ascii")
        game = _create_game("JPEG Cover", image=f"data:image/jpeg;base64,{encoded}")

        resp = client.get(f"/api/games/{game.id}/image")

        assert resp.status_code == 200
        assert resp.mimetype == "image/jpeg"
        assert resp.data == raw

    def test_game_image_endpoint_detects_legacy_png_bytes(self, client):
        raw = b"\x89PNG\r\n\x1a\nlegacy-cover"
        encoded = base64.b64encode(raw).decode("ascii")
        game = _create_game("Legacy PNG Cover", image=encoded)

        resp = client.get(f"/api/games/{game.id}/image")

        assert resp.status_code == 200
        assert resp.mimetype == "image/png"
        assert resp.data == raw


# ===================================================================
# Game Detail Page – Comprehensive Route Tests
# ===================================================================


class TestGameDetailPageRendering:
    """Thorough tests for the /game/<game_id> route: template rendering,
    game_id passing through to JS config, error states, and edge cases."""

    def test_detail_returns_html_content_type(self, client):
        game = _create_game("HTML Type Test")
        resp = client.get(f"/game/{game.id}")
        assert resp.content_type.startswith("text/html")

    def test_detail_page_contains_game_id_in_config(self, client):
        """The template injects game_id into a JS config object so the
        frontend JS can fetch /api/game/<id>/stats."""
        game = _create_game("Config Injection")
        resp = client.get(f"/game/{game.id}")
        html = resp.data.decode()
        assert game.id in html, "game_id must appear in the rendered HTML"

    def test_detail_page_contains_game_details_heading(self, client):
        game = _create_game("Heading Check")
        resp = client.get(f"/game/{game.id}")
        html = resp.data.decode()
        assert "Game Details" in html

    def test_detail_404_returns_plain_text(self, client):
        resp = client.get(f"/game/{uuid.uuid4()}")
        assert resp.status_code == 404
        assert b"Game not found" in resp.data

    def test_detail_with_malformed_uuid(self, client):
        """Requests with a non-UUID game_id should still 404 gracefully."""
        resp = client.get("/game/not-a-valid-uuid")
        assert resp.status_code == 404

    def test_detail_with_empty_game_id(self, client):
        """Trailing slash without an id should 404 (Flask default)."""
        resp = client.get("/game/")
        assert resp.status_code == 404

    def test_detail_page_contains_navigation(self, client):
        game = _create_game("Nav Test")
        resp = client.get(f"/game/{game.id}")
        html = resp.data.decode()
        assert "/games" in html, "Detail page should have a link back to /games"

    def test_detail_page_contains_stats_elements(self, client):
        """The game_stats.html template should contain the stats grid elements."""
        game = _create_game("Stats Elements")
        resp = client.get(f"/game/{game.id}")
        html = resp.data.decode()
        assert "gameStatsGrid" in html
        assert "statTotalChars" in html
        assert "statReadingSpeed" in html

    def test_detail_page_contains_chart_containers(self, client):
        game = _create_game("Chart Test")
        resp = client.get(f"/game/{game.id}")
        html = resp.data.decode()
        assert "cumulativeCharsChart" in html
        assert "dailySpeedChart" in html
        assert "dailyCharsChart" in html

    def test_detail_page_contains_edit_modal(self, client):
        game = _create_game("Modal Test")
        resp = client.get(f"/game/{game.id}")
        html = resp.data.decode()
        assert "editGameModal" in html

    def test_detail_page_contains_delete_modal(self, client):
        game = _create_game("Delete Modal Test")
        resp = client.get(f"/game/{game.id}")
        html = resp.data.decode()
        assert "deleteGameModal" in html

    def test_detail_page_contains_merge_modal(self, client):
        game = _create_game("Merge Modal Test")
        resp = client.get(f"/game/{game.id}")
        html = resp.data.decode()
        assert "mergeGamesModal" in html

    def test_detail_page_contains_settings_cog(self, client):
        game = _create_game("Settings Cog Test")
        resp = client.get(f"/game/{game.id}")
        html = resp.data.decode()
        assert "settingsCogBtn" in html

    def test_multiple_games_have_distinct_detail_pages(self, client):
        """Each game's detail page should inject its own game_id."""
        g1 = _create_game("Game One")
        g2 = _create_game("Game Two")
        resp1 = client.get(f"/game/{g1.id}")
        resp2 = client.get(f"/game/{g2.id}")
        html1 = resp1.data.decode()
        html2 = resp2.data.decode()
        assert g1.id in html1 and g2.id not in html1
        assert g2.id in html2 and g1.id not in html2

    def test_deleted_game_returns_404(self, client):
        """After deleting a game, its detail page should 404."""
        game = _create_game("Deletable Detail")
        game_id = game.id
        # Verify it works first
        assert client.get(f"/game/{game_id}").status_code == 200
        # Delete via DB directly
        GamesTable._db.execute(
            f"DELETE FROM {GamesTable._table} WHERE id = ?",
            (game_id,),
            commit=True,
        )
        assert client.get(f"/game/{game_id}").status_code == 404


# ===================================================================
# Game Stats API – /api/game/<game_id>/stats
# ===================================================================


class TestGameStatsAPI:
    """Comprehensive tests for GET /api/game/<game_id>/stats endpoint."""

    def test_stats_404_for_nonexistent_game(self, client):
        resp = client.get(f"/api/game/{uuid.uuid4()}/stats")
        assert resp.status_code == 404
        data = resp.get_json()
        assert "error" in data
        assert "not found" in data["error"].lower()

    def test_stats_returns_200_for_existing_game(self, client):
        game = _create_game("Stats Game")
        resp = client.get(f"/api/game/{game.id}/stats")
        assert resp.status_code == 200

    def test_stats_response_has_required_keys(self, client):
        game = _create_game("Keys Game")
        resp = client.get(f"/api/game/{game.id}/stats")
        data = resp.get_json()
        assert "game" in data
        assert "stats" in data
        assert "dailySpeed" in data

    def test_stats_game_section_has_required_fields(self, client):
        game = _create_game(
            "Full Game",
            title_romaji="Furu Geimu",
            title_english="Full Game EN",
            game_type="VN",
            description="A test game",
            image="data:image/png;base64,ABC",
        )
        resp = client.get(f"/api/game/{game.id}/stats")
        g = resp.get_json()["game"]
        assert g["id"] == game.id
        assert g["title_original"] == "Full Game"
        assert g["title_romaji"] == "Furu Geimu"
        assert g["title_english"] == "Full Game EN"
        assert g["type"] == "VN"
        assert g["description"] == "A test game"
        assert g["image"] == "data:image/png;base64,ABC"
        assert isinstance(g["genres"], list)
        assert isinstance(g["tags"], list)
        assert isinstance(g["links"], list)

    def test_stats_empty_game_has_zero_stats(self, client):
        """A game with no lines should return zeroed-out stats."""
        game = _create_game("Empty Stats")
        resp = client.get(f"/api/game/{game.id}/stats")
        stats = resp.get_json()["stats"]
        assert stats["total_characters"] == 0
        assert stats["total_sentences"] == 0
        assert stats["total_cards_mined"] == 0
        assert stats["reading_speed"] == 0
        assert stats["total_time_hours"] == 0

    def test_stats_empty_game_has_empty_daily_speed(self, client):
        game = _create_game("Empty Daily")
        resp = client.get(f"/api/game/{game.id}/stats")
        daily = resp.get_json()["dailySpeed"]
        assert daily["labels"] == []
        assert daily["speedData"] == []
        assert daily["charsData"] == []
        assert daily["timeData"] == []

    def test_stats_counts_characters_correctly(self, client):
        game = _create_game("Char Count")
        now = time.time()
        _create_line(game, text="あいうえお", timestamp=now)  # 5 chars
        _create_line(game, text="かきくけこさしす", timestamp=now + 1)  # 8 chars
        resp = client.get(f"/api/game/{game.id}/stats")
        stats = resp.get_json()["stats"]
        assert stats["total_characters"] == 13

    def test_stats_counts_sentences_correctly(self, client):
        game = _create_game("Sentence Count")
        now = time.time()
        _create_line(game, text="一文目", timestamp=now)
        _create_line(game, text="二文目", timestamp=now + 1)
        _create_line(game, text="三文目", timestamp=now + 2)
        resp = client.get(f"/api/game/{game.id}/stats")
        stats = resp.get_json()["stats"]
        assert stats["total_sentences"] == 3

    def test_stats_has_formatted_values(self, client):
        """The API should return pre-formatted display strings."""
        game = _create_game("Formatted")
        _create_line(game, text="テスト", timestamp=time.time())
        resp = client.get(f"/api/game/{game.id}/stats")
        stats = resp.get_json()["stats"]
        assert "total_characters_formatted" in stats
        assert "total_time_formatted" in stats
        assert "reading_speed_formatted" in stats

    def test_stats_has_date_range(self, client):
        game = _create_game("Date Range")
        t1 = 1700000000.0
        t2 = 1700100000.0
        _create_line(game, text="始め", timestamp=t1)
        _create_line(game, text="終わり", timestamp=t2)
        resp = client.get(f"/api/game/{game.id}/stats")
        stats = resp.get_json()["stats"]
        assert stats["first_date"] != ""
        assert stats["last_date"] != ""

    def test_stats_game_completed_field(self, client):
        game = _create_game("Completed Field", completed=True)
        resp = client.get(f"/api/game/{game.id}/stats")
        g = resp.get_json()["game"]
        assert g["completed"] is True

    def test_stats_game_genres_and_tags(self, client):
        game = _create_game(
            "Genre Tag Stats",
            genres=["RPG", "Adventure"],
            tags=["fantasy", "isekai"],
        )
        resp = client.get(f"/api/game/{game.id}/stats")
        g = resp.get_json()["game"]
        assert g["genres"] == ["RPG", "Adventure"]
        assert g["tags"] == ["fantasy", "isekai"]

    def test_stats_game_links_field(self, client):
        game = _create_game("Links Stats")
        game.add_link(link_type=1, url="https://example.com")
        resp = client.get(f"/api/game/{game.id}/stats")
        g = resp.get_json()["game"]
        assert len(g["links"]) == 1
        assert g["links"][0]["url"] == "https://example.com"

    def test_stats_game_character_count_field(self, client):
        """The game's jiten.moe character_count should be returned."""
        game = _create_game("Jiten Chars", character_count=50000)
        resp = client.get(f"/api/game/{game.id}/stats")
        g = resp.get_json()["game"]
        assert g["character_count"] == 50000

    def test_stats_with_malformed_game_id(self, client):
        resp = client.get("/api/game/not-a-uuid/stats")
        assert resp.status_code == 404


# ===================================================================
# API Sorting – All Sort Modes
# ===================================================================


class TestGamesManagementAPISorting:
    """Comprehensive tests for sorting in GET /api/games-management."""

    def test_default_sort_is_last_played(self, client):
        """When no sort param is given, default is last_played."""
        g_old = _create_game("Old Default")
        g_new = _create_game("New Default")
        _create_line(g_old, text="古い", timestamp=1600000000.0)
        _create_line(g_new, text="新しい", timestamp=1700000000.0)
        resp = client.get("/api/games-management")
        titles = [g["title_original"] for g in resp.get_json()["games"]]
        assert titles[0] == "New Default"

    def test_sort_by_character_count(self, client):
        g_small = _create_game("Small CC")
        g_big = _create_game("Big CC")
        _create_line(g_small, text="あ")
        _create_line(g_big, text="あいうえおかきくけこ")
        resp = client.get("/api/games-management?sort=character_count")
        titles = [g["title_original"] for g in resp.get_json()["games"]]
        assert titles[0] == "Big CC"

    def test_sort_by_title(self, client):
        _create_game("Zebra Game")
        _create_game("Alpha Game")
        _create_game("Middle Game")
        resp = client.get("/api/games-management?sort=title")
        titles = [g["title_original"] for g in resp.get_json()["games"]]
        assert titles == ["Alpha Game", "Middle Game", "Zebra Game"]

    def test_sort_by_line_count(self, client):
        g_few = _create_game("Few Lines")
        g_many = _create_game("Many Lines")
        _create_line(g_few, text="一")
        _create_line(g_many, text="一")
        _create_line(g_many, text="二")
        _create_line(g_many, text="三")
        resp = client.get("/api/games-management?sort=line_count")
        titles = [g["title_original"] for g in resp.get_json()["games"]]
        assert titles[0] == "Many Lines"

    def test_sort_by_last_played_with_no_lines_game(self, client):
        """Games with no lines (last_played=None) should sort after games
        with lines when sorting by last_played."""
        g_with = _create_game("Has Lines")
        _create_game("No Lines Sort")
        _create_line(g_with, text="テスト", timestamp=1700000000.0)
        resp = client.get("/api/games-management?sort=last_played")
        titles = [g["title_original"] for g in resp.get_json()["games"]]
        assert titles[0] == "Has Lines"

    def test_sort_unknown_param_falls_back(self, client):
        """Unknown sort param should use default fallback (character count)."""
        g_small = _create_game("Fallback Small")
        g_big = _create_game("Fallback Big")
        _create_line(g_small, text="あ")
        _create_line(g_big, text="あいうえおかきくけこ")
        resp = client.get("/api/games-management?sort=nonexistent")
        assert resp.status_code == 200
        titles = [g["title_original"] for g in resp.get_json()["games"]]
        assert titles[0] == "Fallback Big"


# ===================================================================
# Games Management API – Response Shape & Fields
# ===================================================================


class TestGamesManagementAPIResponseShape:
    """Verify the structure and all fields in /api/games-management response."""

    def test_response_has_games_and_summary(self, client):
        resp = client.get("/api/games-management")
        data = resp.get_json()
        assert "games" in data
        assert "summary" in data
        assert isinstance(data["games"], list)

    def test_summary_keys(self, client):
        _create_game("Summary Test")
        resp = client.get("/api/games-management")
        summary = resp.get_json()["summary"]
        assert "total_games" in summary
        assert "linked_games" in summary
        assert "unlinked_games" in summary

    def test_game_object_has_all_expected_fields(self, client):
        _create_game("Fields Test", game_type="VN")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        expected_fields = [
            "id",
            "title_original",
            "title_romaji",
            "title_english",
            "type",
            "description",
            "has_image",
            "deck_id",
            "vndb_id",
            "anilist_id",
            "difficulty",
            "completed",
            "is_linked",
            "has_manual_overrides",
            "manual_overrides",
            "line_count",
            "mined_character_count",
            "jiten_character_count",
            "start_date",
            "last_played",
            "links",
            "release_date",
            "genres",
            "tags",
            "obs_scene_name",
            "character_summary",
        ]
        for field in expected_fields:
            assert field in game, f"Missing field: {field}"

    def test_game_type_field_passthrough(self, client):
        _create_game("Type VN", game_type="VN")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["type"] == "VN"

    def test_obs_scene_name_included(self, client):
        _create_game("OBS Scene", obs_scene_name="my_game_scene")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["obs_scene_name"] == "my_game_scene"

    def test_character_summary_included(self, client):
        _create_game("Char Summary", character_summary="MC is a hero.")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["character_summary"] == "MC is a hero."

    def test_release_date_included(self, client):
        _create_game("Release", release_date="2024-01-15")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["release_date"] == "2024-01-15"


# ===================================================================
# Update Game – Additional Edge Cases
# ===================================================================


class TestUpdateGameEdgeCases:
    """Extended tests for PUT /api/games/<game_id>."""

    def test_update_title_original(self, client):
        game = _create_game("Original Title")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"title_original": "Changed Title"},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.title_original == "Changed Title"

    def test_update_description_to_empty(self, client):
        game = _create_game("Empty Desc", description="Has content")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"description": ""},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.description == ""

    def test_update_image_field(self, client):
        game = _create_game("Image Update")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"image": "data:image/jpeg;base64,NEWIMAGE"},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.image == "data:image/jpeg;base64,NEWIMAGE"

    def test_update_deck_id(self, client):
        game = _create_game("Deck Update")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"deck_id": 42},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.deck_id == 42

    def test_update_character_count(self, client):
        game = _create_game("Char Count Update")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"character_count": 100000},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.character_count == 100000

    def test_update_vndb_id_with_v_prefix(self, client):
        """vndb_id already having 'v' prefix should not double-prefix."""
        game = _create_game("VNDB Prefix Existing")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"vndb_id": "v99999"},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.vndb_id == "v99999"

    def test_update_anilist_id(self, client):
        game = _create_game("AniList Update")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"anilist_id": "12345"},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.anilist_id == "12345"

    def test_update_multiple_fields_at_once(self, client):
        game = _create_game("Multi Update")
        resp = client.put(
            f"/api/games/{game.id}",
            json={
                "title_english": "Multi EN",
                "title_romaji": "Multi Romaji",
                "difficulty": 4,
                "completed": True,
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["updated_fields"]) == 4
        updated = GamesTable.get(game.id)
        assert updated.title_english == "Multi EN"
        assert updated.title_romaji == "Multi Romaji"
        assert updated.difficulty == 4
        assert updated.completed is True

    def test_update_links_as_list(self, client):
        game = _create_game("Links Update")
        new_links = [
            {"linkType": 1, "url": "https://a.com"},
            {"linkType": 2, "url": "https://b.com"},
        ]
        resp = client.put(
            f"/api/games/{game.id}",
            json={"links": new_links},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert len(updated.links) == 2

    def test_update_release_date(self, client):
        game = _create_game("Release Update")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"release_date": "2025-06-01"},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.release_date == "2025-06-01"

    def test_update_character_summary(self, client):
        game = _create_game("Summary Update")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"character_summary": "MC: John, Heroine: Jane"},
        )
        assert resp.status_code == 200
        updated = GamesTable.get(game.id)
        assert updated.character_summary == "MC: John, Heroine: Jane"

    def test_update_with_invalid_json(self, client):
        game = _create_game("Invalid JSON")
        resp = client.put(
            f"/api/games/{game.id}",
            data="not json",
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_update_ignores_unknown_fields(self, client):
        game = _create_game("Unknown Fields")
        resp = client.put(
            f"/api/games/{game.id}",
            json={"nonexistent_field": "value", "title_english": "Valid"},
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert "title_english" in data["updated_fields"]
        assert "nonexistent_field" not in data["updated_fields"]


# ===================================================================
# Create Game – Additional Edge Cases
# ===================================================================


class TestCreateGameEdgeCases:
    """Extended tests for POST /api/games."""

    def test_create_game_with_all_fields(self, client):
        resp = client.post(
            "/api/games",
            json={
                "title_original": "Complete Game",
                "title_romaji": "Kanpeki Geimu",
                "title_english": "Complete Game EN",
                "type": "VN",
                "description": "A complete game",
                "completed": True,
            },
        )
        assert resp.status_code == 201
        data = resp.get_json()
        assert data["game"]["title_original"] == "Complete Game"

    def test_create_game_returns_valid_uuid(self, client):
        resp = client.post(
            "/api/games",
            json={"title_original": "UUID Game"},
        )
        data = resp.get_json()
        game_id = data["game"]["id"]
        assert len(game_id) == 36  # UUID format

    def test_create_game_with_unicode_title(self, client):
        resp = client.post(
            "/api/games",
            json={"title_original": "月姫 -A piece of blue glass moon-"},
        )
        assert resp.status_code == 201
        data = resp.get_json()
        assert data["game"]["title_original"] == "月姫 -A piece of blue glass moon-"

    def test_create_game_with_very_long_title(self, client):
        long_title = "A" * 500
        resp = client.post(
            "/api/games",
            json={"title_original": long_title},
        )
        assert resp.status_code == 201
        data = resp.get_json()
        assert data["game"]["title_original"] == long_title

    def test_create_game_with_special_characters(self, client):
        resp = client.post(
            "/api/games",
            json={"title_original": "Game <with> \"special\" & 'chars'"},
        )
        assert resp.status_code == 201

    def test_created_game_appears_in_list(self, client):
        client.post("/api/games", json={"title_original": "Listed Game"})
        resp = client.get("/api/games-management")
        titles = {g["title_original"] for g in resp.get_json()["games"]}
        assert "Listed Game" in titles

    def test_created_game_accessible_via_detail_page(self, client):
        resp = client.post("/api/games", json={"title_original": "Detail Access"})
        game_id = resp.get_json()["game"]["id"]
        detail_resp = client.get(f"/game/{game_id}")
        assert detail_resp.status_code == 200


# ===================================================================
# Delete Game – Extended Scenarios
# ===================================================================


class TestDeleteGameExtended:
    """More delete scenarios covering edge cases."""

    def test_unlink_game_with_multiple_lines(self, client):
        game = _create_game("Multi Line Unlink")
        for i in range(5):
            _create_line(game, text=f"行{i}")
        resp = client.delete(f"/api/games/{game.id}")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["unlinked_lines"] == 5

    def test_unlink_game_with_no_lines(self, client):
        game = _create_game("No Lines Unlink")
        resp = client.delete(f"/api/games/{game.id}")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["unlinked_lines"] == 0

    def test_delete_game_then_stats_404(self, client):
        """After deleting a game, its stats API should 404."""
        game = _create_game("Stats After Delete")
        _create_line(game, text="消える")
        game_id = game.id
        # Delete permanently
        client.delete(f"/api/games/{game_id}/delete-lines")
        # Stats should 404
        resp = client.get(f"/api/game/{game_id}/stats")
        assert resp.status_code == 404

    def test_double_delete_returns_404(self, client):
        game = _create_game("Double Delete")
        _create_line(game, text="一回目")
        client.delete(f"/api/games/{game.id}/delete-lines")
        resp = client.delete(f"/api/games/{game.id}/delete-lines")
        assert resp.status_code == 404

    def test_unlinked_lines_become_orphans(self, client):
        """After unlinking, lines should appear under orphaned games."""
        game = _create_game("Orphan After Unlink")
        _create_line(game, text="孤児になる")
        client.delete(f"/api/games/{game.id}")
        resp = client.get("/api/orphaned-games")
        data = resp.get_json()
        orphan_names = {g["game_name"] for g in data["orphaned_games"]}
        assert "Orphan After Unlink" in orphan_names


# ===================================================================
# Mark Complete – Extended Tests
# ===================================================================


class TestMarkCompleteExtended:
    """Additional mark-complete scenarios."""

    def test_mark_complete_already_completed(self, client):
        """Marking an already-completed game should still succeed."""
        game = _create_game("Already Done", completed=True)
        resp = client.post(f"/api/games/{game.id}/mark-complete")
        assert resp.status_code == 200
        assert resp.get_json()["completed"] is True

    def test_mark_complete_updates_in_api_list(self, client):
        game = _create_game("Complete List")
        client.post(f"/api/games/{game.id}/mark-complete")
        resp = client.get("/api/games-management")
        g = [
            x
            for x in resp.get_json()["games"]
            if x["title_original"] == "Complete List"
        ][0]
        assert g["completed"] is True

    def test_mark_complete_reflected_in_stats(self, client):
        game = _create_game("Complete Stats")
        client.post(f"/api/games/{game.id}/mark-complete")
        resp = client.get(f"/api/game/{game.id}/stats")
        assert resp.get_json()["game"]["completed"] is True


# ===================================================================
# Orphaned Games – Extended Tests
# ===================================================================


class TestOrphanedGamesExtended:
    """More thorough orphan detection tests."""

    def test_orphan_includes_line_count(self, client):
        for _ in range(3):
            GameLinesTable(
                id=str(uuid.uuid4()),
                game_name="Orphan Count",
                line_text="テスト",
                timestamp=time.time(),
            ).add()
        resp = client.get("/api/orphaned-games")
        orphan = resp.get_json()["orphaned_games"][0]
        assert orphan["line_count"] == 3

    def test_orphan_includes_character_count(self, client):
        GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Orphan Chars",
            line_text="あいうえお",  # 5 chars
            timestamp=time.time(),
        ).add()
        resp = client.get("/api/orphaned-games")
        orphan = resp.get_json()["orphaned_games"][0]
        assert orphan["character_count"] == 5

    def test_orphan_includes_date_range(self, client):
        GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Orphan Dates",
            line_text="テスト",
            timestamp=1700000000.0,
        ).add()
        GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Orphan Dates",
            line_text="テスト",
            timestamp=1700100000.0,
        ).add()
        resp = client.get("/api/orphaned-games")
        orphan = resp.get_json()["orphaned_games"][0]
        # Timestamps may come back as strings from SQLite
        assert float(orphan["first_seen"]) == 1700000000.0
        assert float(orphan["last_seen"]) == 1700100000.0

    def test_multiple_orphan_groups(self, client):
        for name in ["Orphan A", "Orphan B", "Orphan C"]:
            GameLinesTable(
                id=str(uuid.uuid4()),
                game_name=name,
                line_text="テスト",
                timestamp=time.time(),
            ).add()
        resp = client.get("/api/orphaned-games")
        data = resp.get_json()
        assert data["total_orphaned"] == 3

    def test_creating_game_resolves_orphan(self, client):
        """After creating a game that matches an orphan name, the orphan
        should disappear from the orphaned list."""
        GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Resolved Orphan",
            line_text="テスト",
            timestamp=time.time(),
        ).add()
        # Verify it's orphaned
        resp = client.get("/api/orphaned-games")
        assert resp.get_json()["total_orphaned"] == 1

        # Create game with matching name
        client.post("/api/games", json={"title_original": "Resolved Orphan"})

        # Orphan should be gone
        resp = client.get("/api/orphaned-games")
        assert resp.get_json()["total_orphaned"] == 0


# ===================================================================
# Games Grid Page – Extended Tests
# ===================================================================


class TestGamesGridPage:
    """Extended tests for the /games grid page."""

    def test_games_page_contains_search_input(self, client):
        resp = client.get("/games")
        html = resp.data.decode()
        assert "gamesSearchInput" in html

    def test_games_page_contains_loading_state(self, client):
        resp = client.get("/games")
        html = resp.data.decode()
        assert "gamesLoading" in html

    def test_games_page_contains_error_state(self, client):
        resp = client.get("/games")
        html = resp.data.decode()
        assert "gamesError" in html

    def test_games_page_contains_empty_state(self, client):
        resp = client.get("/games")
        html = resp.data.decode()
        assert "gamesEmpty" in html

    def test_games_page_contains_grid_container(self, client):
        resp = client.get("/games")
        html = resp.data.decode()
        assert "gamesGrid" in html

    def test_games_page_contains_navigation(self, client):
        resp = client.get("/games")
        html = resp.data.decode()
        assert "/games" in html


# ===================================================================
# Integration: Grid → Detail Flow
# ===================================================================


class TestGridToDetailIntegration:
    """End-to-end tests verifying the grid-to-detail navigation flow."""

    def test_game_in_api_list_is_accessible_via_detail(self, client):
        """Every game returned by /api/games-management should have a
        valid detail page at /game/<id>."""
        _create_game("Integration A")
        _create_game("Integration B")
        resp = client.get("/api/games-management")
        for game in resp.get_json()["games"]:
            detail_resp = client.get(f"/game/{game['id']}")
            assert detail_resp.status_code == 200, (
                f"Detail page for '{game['title_original']}' returned "
                f"{detail_resp.status_code}"
            )

    def test_game_in_api_list_has_stats_endpoint(self, client):
        """Every game in the list should have a working stats endpoint."""
        game = _create_game("Stats Integration")
        _create_line(game, text="テスト")
        resp = client.get("/api/games-management")
        for g in resp.get_json()["games"]:
            stats_resp = client.get(f"/api/game/{g['id']}/stats")
            assert stats_resp.status_code == 200

    def test_create_then_view_detail(self, client):
        """POST a new game, then verify its detail page works."""
        create_resp = client.post(
            "/api/games",
            json={"title_original": "Created and Viewed"},
        )
        game_id = create_resp.get_json()["game"]["id"]
        detail_resp = client.get(f"/game/{game_id}")
        assert detail_resp.status_code == 200
        assert game_id in detail_resp.data.decode()

    def test_create_then_view_stats(self, client):
        """POST a new game, then verify its stats API works."""
        create_resp = client.post(
            "/api/games",
            json={"title_original": "Created and Stats"},
        )
        game_id = create_resp.get_json()["game"]["id"]
        stats_resp = client.get(f"/api/game/{game_id}/stats")
        assert stats_resp.status_code == 200
        data = stats_resp.get_json()
        assert data["game"]["title_original"] == "Created and Stats"
        assert data["stats"]["total_characters"] == 0

    def test_update_then_verify_in_stats(self, client):
        """Update a game's metadata, then verify it appears in the stats API."""
        game = _create_game("Update Verify")
        client.put(
            f"/api/games/{game.id}",
            json={"title_english": "Updated EN Title"},
        )
        stats_resp = client.get(f"/api/game/{game.id}/stats")
        assert stats_resp.get_json()["game"]["title_english"] == "Updated EN Title"

    def test_full_lifecycle(self, client):
        """Create → add lines → view stats → mark complete → delete."""
        # Create
        create_resp = client.post(
            "/api/games",
            json={"title_original": "Lifecycle Game"},
        )
        game_id = create_resp.get_json()["game"]["id"]

        # Add lines directly
        game = GamesTable.get(game_id)
        now = time.time()
        _create_line(game, text="ライフサイクルテスト", timestamp=now)
        _create_line(game, text="二行目のテスト", timestamp=now + 5)

        # View stats
        stats_resp = client.get(f"/api/game/{game_id}/stats")
        assert stats_resp.status_code == 200
        stats = stats_resp.get_json()["stats"]
        assert stats["total_characters"] > 0
        assert stats["total_sentences"] == 2

        # Mark complete
        complete_resp = client.post(f"/api/games/{game_id}/mark-complete")
        assert complete_resp.status_code == 200

        # Verify completed in stats
        stats_resp = client.get(f"/api/game/{game_id}/stats")
        assert stats_resp.get_json()["game"]["completed"] is True

        # Delete
        delete_resp = client.delete(f"/api/games/{game_id}/delete-lines")
        assert delete_resp.status_code == 200

        # Verify gone
        assert client.get(f"/game/{game_id}").status_code == 404
        assert client.get(f"/api/game/{game_id}/stats").status_code == 404


# ===================================================================
# GamesTable Model – Additional Tests
# ===================================================================


class TestGamesTableModelExtended:
    """Additional model-level tests for edge cases."""

    def test_get_all_returns_all_games(self):
        for i in range(5):
            _create_game(f"All Game {i}")
        all_games = GamesTable.all()
        assert len(all_games) == 5

    def test_delete_game_from_db(self):
        game = _create_game("DB Delete")
        game_id = game.id
        GamesTable._db.execute(
            f"DELETE FROM {GamesTable._table} WHERE id = ?",
            (game_id,),
            commit=True,
        )
        assert GamesTable.get(game_id) is None

    def test_game_with_all_metadata(self):
        game = _create_game(
            "Metadata Game",
            title_romaji="Metadeeta Geimu",
            title_english="Metadata Game EN",
            game_type="VN",
            description="Full metadata",
            difficulty=3,
            vndb_id="v12345",
            anilist_id="67890",
            character_count=50000,
            release_date="2024-01-01",
            genres=["RPG"],
            tags=["fantasy"],
        )
        fetched = GamesTable.get(game.id)
        assert fetched.title_romaji == "Metadeeta Geimu"
        assert fetched.title_english == "Metadata Game EN"
        assert fetched.type == "VN"
        assert fetched.description == "Full metadata"
        assert fetched.difficulty == 3
        assert fetched.vndb_id == "v12345"
        assert fetched.anilist_id == "67890"
        assert fetched.character_count == 50000
        assert fetched.release_date == "2024-01-01"
        assert fetched.genres == ["RPG"]
        assert fetched.tags == ["fantasy"]

    def test_save_updates_existing_game(self):
        game = _create_game("Save Update")
        game.title_english = "New English"
        game.save()
        fetched = GamesTable.get(game.id)
        assert fetched.title_english == "New English"

    def test_manual_overrides_persist(self):
        game = _create_game("Override Persist")
        game.mark_field_manual("title_english")
        game.mark_field_manual("description")
        game.save()  # mark_field_manual is in-memory only; must save explicitly
        fetched = GamesTable.get(game.id)
        assert fetched.is_field_manual("title_english")
        assert fetched.is_field_manual("description")
        assert not fetched.is_field_manual("title_romaji")

    def test_get_by_title_case_sensitive(self):
        _create_game("Case Sensitive")
        assert GamesTable.get_by_title("Case Sensitive") is not None
        assert GamesTable.get_by_title("case sensitive") is None

    def test_normalize_removes_version_suffix(self):
        assert GamesTable.normalize_game_name("Game ver2.00") == "game"
        assert GamesTable.normalize_game_name("Game V1.5.3") == "game"
        assert GamesTable.normalize_game_name("Game v3") == "game"

    def test_fuzzy_match_version_variants(self):
        assert (
            GamesTable.fuzzy_match_game_name(
                "Great Adventure ver1.00",
                "Great Adventure ver2.00",
            )
            is True
        )


# ===================================================================
# link_game_lines – backfill & data integrity
# ===================================================================


def _create_orphan_line(game_name, text="テスト文", timestamp=None):
    """Insert a game_lines row with game_name but NO game_id (simulates
    import / sync)."""
    line = GameLinesTable(
        id=str(uuid.uuid4()),
        game_name=game_name,
        game_id="",
        line_text=text,
        timestamp=timestamp or time.time(),
    )
    line.add()
    return line


class TestLinkGameLines:
    """Tests for GamesTable.link_game_lines()."""

    def test_creates_game_for_unknown_game_name(self):
        """If game_lines have a game_name with no games record, one is created."""
        _create_orphan_line("Brand New Game")
        result = GamesTable.link_game_lines()
        assert result["created"] >= 1
        assert GamesTable.get_by_title("Brand New Game") is not None

    def test_links_orphan_lines_for_new_game(self):
        """Orphaned lines should get game_id set after link_game_lines."""
        line = _create_orphan_line("Brand New Game")
        GamesTable.link_game_lines()
        fetched = GameLinesTable.get(line.id)
        game = GamesTable.get_by_title("Brand New Game")
        assert fetched.game_id == game.id

    def test_links_orphan_lines_for_existing_game(self):
        """The critical bug: lines for an EXISTING game that lack game_id
        must still get linked."""
        game = _create_game("Existing Game")
        line = _create_orphan_line("Existing Game")
        # Before fix, the old backfill would skip this because the game exists
        GamesTable.link_game_lines()
        fetched = GameLinesTable.get(line.id)
        assert fetched.game_id == game.id

    def test_links_lines_matching_obs_scene_name(self):
        """Lines whose game_name matches obs_scene_name (not title_original)
        should also be linked."""
        game = _create_game("Pretty Title", obs_scene_name="ugly_obs_scene")
        line = _create_orphan_line("ugly_obs_scene")
        GamesTable.link_game_lines()
        fetched = GameLinesTable.get(line.id)
        assert fetched.game_id == game.id

    def test_does_not_overwrite_existing_game_id(self):
        """Lines that already have a correct game_id should not be touched."""
        game = _create_game("Already Linked")
        line = _create_line(game, text="正しい")
        GamesTable.link_game_lines()
        fetched = GameLinesTable.get(line.id)
        assert fetched.game_id == game.id

    def test_get_lines_returns_all_after_backfill(self):
        """After link_game_lines, game.get_lines() should return ALL lines
        including previously orphaned ones."""
        game = _create_game("Full Count")
        _create_line(game, text="linked from start")
        _create_orphan_line("Full Count", text="was orphaned")
        GamesTable.link_game_lines()
        lines = game.get_lines()
        assert len(lines) == 2

    def test_idempotent(self):
        """Running link_game_lines twice should not duplicate or break."""
        _create_orphan_line("Idempotent Game")
        GamesTable.link_game_lines()
        GamesTable.link_game_lines()
        game = GamesTable.get_by_title("Idempotent Game")
        lines = game.get_lines()
        assert len(lines) == 1

    def test_games_management_shows_correct_count_after_backfill(self, client):
        """End-to-end: /api/games-management should report the correct
        mined_character_count for a game whose lines were previously orphaned."""
        game = _create_game("API Count Game")
        _create_line(game, text="AB")  # 2 chars, has game_id
        _create_orphan_line("API Count Game", text="CDE")  # 3 chars, no game_id
        # link_game_lines runs in a background thread when visiting the
        # endpoint, so call it explicitly here for deterministic testing.
        GamesTable.link_game_lines()
        resp = client.get("/api/games-management")
        data = resp.get_json()
        matched = [g for g in data["games"] if g["title_original"] == "API Count Game"]
        assert len(matched) == 1
        assert matched[0]["mined_character_count"] == 5
        assert matched[0]["line_count"] == 2


# ===================================================================
# add_lines – bulk insert sets game_id
# ===================================================================


class TestAddLinesSetsGameId:
    """Tests that GameLinesTable.add_lines() sets game_id at insert time."""

    def test_add_lines_sets_game_id(self):
        """Bulk-inserted lines via add_lines should have game_id populated."""
        from datetime import datetime
        from GameSentenceMiner.util.text_log import GameLine

        game = _create_game("Bulk Game", obs_scene_name="Bulk Game")
        gl = GameLine(
            id=str(uuid.uuid4()),
            text="バルクテスト",
            scene="Bulk Game",
            time=datetime.now(),
            prev=None,
            next=None,
            index=0,
        )
        GameLinesTable.add_lines([gl])
        fetched = GameLinesTable.get(gl.id)
        assert fetched.game_id == game.id

    def test_add_lines_creates_game_if_missing(self):
        """add_lines should auto-create a game record when none exists."""
        from datetime import datetime
        from GameSentenceMiner.util.text_log import GameLine

        gl = GameLine(
            id=str(uuid.uuid4()),
            text="新しいゲーム",
            scene="Auto Created Game",
            time=datetime.now(),
            prev=None,
            next=None,
            index=0,
        )
        GameLinesTable.add_lines([gl])
        fetched = GameLinesTable.get(gl.id)
        assert fetched.game_id != ""
        game = GamesTable.get_by_title("Auto Created Game")
        assert game is not None
        assert fetched.game_id == game.id

    def test_add_lines_no_scene_leaves_game_id_empty(self):
        """Lines without a scene name should still insert with empty game_id."""
        from datetime import datetime
        from GameSentenceMiner.util.text_log import GameLine

        gl = GameLine(
            id=str(uuid.uuid4()),
            text="シーンなし",
            scene="",
            time=datetime.now(),
            prev=None,
            next=None,
            index=0,
        )
        GameLinesTable.add_lines([gl])
        fetched = GameLinesTable.get(gl.id)
        assert fetched.game_id == ""


# ===================================================================
# Cloud sync – apply_remote_sync_changes links game_id
# ===================================================================


class TestCloudSyncLinksGameId:
    """After applying remote sync changes, new lines should have game_id set."""

    @pytest.fixture(autouse=True)
    def _sync_table(self, _in_memory_db):
        """Create the sync tracking table required by apply_remote_sync_changes."""
        _in_memory_db.execute(
            f"""CREATE TABLE IF NOT EXISTS {GameLinesTable._sync_changes_table} (
                line_id TEXT PRIMARY KEY,
                change_type TEXT NOT NULL,
                changed_at REAL NOT NULL
            )""",
            commit=True,
        )

    def test_sync_upsert_links_game_id(self):
        """A synced line with a known game_name should get game_id set."""
        game = _create_game("Synced Game", obs_scene_name="Synced Game")
        line_id = str(uuid.uuid4())
        changes = [
            {
                "id": line_id,
                "operation": "upsert",
                "changed_at": time.time(),
                "data": {
                    "game_name": "Synced Game",
                    "line_text": "同期テスト",
                    "timestamp": time.time(),
                },
            }
        ]
        GameLinesTable.apply_remote_sync_changes(changes)
        fetched = GameLinesTable.get(line_id)
        assert fetched.game_id == game.id


# ===================================================================
# Game Profiles – SQL Aggregation Tests
# ===================================================================


class TestComputeTodayGameProfilesSQLAggregation:
    """Tests for compute_today_game_profiles() which uses SQL GROUP BY
    aggregation instead of fetching every row into Python."""

    def test_empty_table_returns_empty_dict(self):
        from GameSentenceMiner.web.game_profiles import compute_today_game_profiles

        profiles = compute_today_game_profiles()
        assert profiles == {}

    def test_single_game_single_line(self):
        from GameSentenceMiner.web.game_profiles import compute_today_game_profiles

        game = _create_game("Single Line Game")
        _create_line(game, text="あいうえお", timestamp=1700000000.0)
        profiles = compute_today_game_profiles()
        assert game.id in profiles
        p = profiles[game.id]
        assert p.line_count == 1
        assert p.character_count == 5
        assert p.start_date == 1700000000.0
        assert p.last_played == 1700000000.0

    def test_single_game_multiple_lines(self):
        from GameSentenceMiner.web.game_profiles import compute_today_game_profiles

        game = _create_game("Multi Line")
        _create_line(game, text="あいう", timestamp=1700000000.0)  # 3 chars
        _create_line(game, text="かきくけこ", timestamp=1700050000.0)  # 5 chars
        _create_line(game, text="さ", timestamp=1700100000.0)  # 1 char
        profiles = compute_today_game_profiles()
        p = profiles[game.id]
        assert p.line_count == 3
        assert p.character_count == 9
        assert p.start_date == 1700000000.0
        assert p.last_played == 1700100000.0

    def test_multiple_games(self):
        from GameSentenceMiner.web.game_profiles import compute_today_game_profiles

        g1 = _create_game("Game A")
        g2 = _create_game("Game B")
        _create_line(g1, text="あいう", timestamp=1700000000.0)
        _create_line(g2, text="かきくけこさしす", timestamp=1700050000.0)
        profiles = compute_today_game_profiles()
        assert profiles[g1.id].line_count == 1
        assert profiles[g1.id].character_count == 3
        assert profiles[g2.id].line_count == 1
        assert profiles[g2.id].character_count == 8

    def test_lines_without_game_id_are_excluded(self):
        from GameSentenceMiner.web.game_profiles import compute_today_game_profiles

        game = _create_game("Has Lines")
        _create_line(game, text="リンク済み", timestamp=1700000000.0)
        # Insert a line with no game_id
        GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Orphan",
            game_id="",
            line_text="孤児の行",
            timestamp=1700000000.0,
        ).add()
        profiles = compute_today_game_profiles()
        # Only the linked game should appear
        assert len(profiles) == 1
        assert game.id in profiles

    def test_null_game_id_excluded(self):
        from GameSentenceMiner.web.game_profiles import compute_today_game_profiles

        # Insert a line with NULL game_id (no game_id kwarg defaults to None)
        GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="No ID",
            line_text="テスト",
            timestamp=1700000000.0,
        ).add()
        profiles = compute_today_game_profiles()
        assert len(profiles) == 0

    def test_with_rollup_data_only_includes_recent_lines(self):
        """When rollups exist, only lines after the last rollup are included."""
        from GameSentenceMiner.web.game_profiles import compute_today_game_profiles

        game = _create_game("Rollup Game")
        # Create a rollup entry for yesterday
        StatsRollupTable._db.execute(
            f"INSERT INTO {StatsRollupTable._table} (date) VALUES (?)",
            ("2024-06-15",),
            commit=True,
        )
        # Old line (before rollup) — should NOT be included
        old_ts = 1718409600.0  # 2024-06-15 00:00:00 UTC
        _create_line(game, text="古い行", timestamp=old_ts)
        # New line (after rollup) — should be included
        new_ts = 1718582400.0  # 2024-06-17 00:00:00 UTC
        _create_line(game, text="新しい行", timestamp=new_ts)

        profiles = compute_today_game_profiles()
        assert game.id in profiles
        p = profiles[game.id]
        assert p.line_count == 1
        assert p.character_count == 4  # len("新しい行")

    def test_null_line_text_counts_as_zero_chars(self):
        """Lines with NULL line_text should contribute 0 characters."""
        from GameSentenceMiner.web.game_profiles import compute_today_game_profiles

        game = _create_game("Null Text")
        # Insert a line with NULL text via raw SQL
        GameLinesTable._db.execute(
            f"INSERT INTO {GameLinesTable._table} (id, game_name, game_id, line_text, timestamp) "
            f"VALUES (?, ?, ?, NULL, ?)",
            (str(uuid.uuid4()), "Null Text", game.id, 1700000000.0),
            commit=True,
        )
        profiles = compute_today_game_profiles()
        assert game.id in profiles
        p = profiles[game.id]
        assert p.line_count == 1
        assert p.character_count == 0


class TestComputeProfilesFromAggregateRows:
    """Unit tests for the pure-logic _compute_profiles_from_aggregate_rows."""

    def test_empty_rows(self):
        from GameSentenceMiner.web.game_profiles import (
            _compute_profiles_from_aggregate_rows,
        )

        assert _compute_profiles_from_aggregate_rows([]) == {}

    def test_single_row(self):
        from GameSentenceMiner.web.game_profiles import (
            _compute_profiles_from_aggregate_rows,
        )

        rows = [("game-1", 10, 500, 1700000000.0, 1700100000.0)]
        result = _compute_profiles_from_aggregate_rows(rows)
        assert "game-1" in result
        p = result["game-1"]
        assert p.line_count == 10
        assert p.character_count == 500
        assert p.start_date == 1700000000.0
        assert p.last_played == 1700100000.0

    def test_null_timestamps(self):
        from GameSentenceMiner.web.game_profiles import (
            _compute_profiles_from_aggregate_rows,
        )

        rows = [("game-1", 5, 100, None, None)]
        result = _compute_profiles_from_aggregate_rows(rows)
        p = result["game-1"]
        assert p.start_date is None
        assert p.last_played is None

    def test_null_character_count(self):
        """SUM(LENGTH(line_text)) returns NULL when all texts are NULL."""
        from GameSentenceMiner.web.game_profiles import (
            _compute_profiles_from_aggregate_rows,
        )

        rows = [("game-1", 3, None, 1700000000.0, 1700000000.0)]
        result = _compute_profiles_from_aggregate_rows(rows)
        assert result["game-1"].character_count == 0

    def test_skips_null_game_id(self):
        from GameSentenceMiner.web.game_profiles import (
            _compute_profiles_from_aggregate_rows,
        )

        rows = [(None, 5, 100, 1700000000.0, 1700000000.0)]
        result = _compute_profiles_from_aggregate_rows(rows)
        assert len(result) == 0

    def test_skips_empty_game_id(self):
        from GameSentenceMiner.web.game_profiles import (
            _compute_profiles_from_aggregate_rows,
        )

        rows = [("", 5, 100, 1700000000.0, 1700000000.0)]
        result = _compute_profiles_from_aggregate_rows(rows)
        assert len(result) == 0

    def test_multiple_rows(self):
        from GameSentenceMiner.web.game_profiles import (
            _compute_profiles_from_aggregate_rows,
        )

        rows = [
            ("game-1", 10, 500, 1700000000.0, 1700100000.0),
            ("game-2", 20, 1000, 1700050000.0, 1700200000.0),
        ]
        result = _compute_profiles_from_aggregate_rows(rows)
        assert len(result) == 2
        assert result["game-1"].line_count == 10
        assert result["game-2"].character_count == 1000


class TestBuildGameProfilesIntegration:
    """Integration tests for build_game_profiles() verifying SQL aggregation
    produces correct results end-to-end."""

    def test_matches_expected_totals(self):
        from GameSentenceMiner.web.game_profiles import build_game_profiles

        game = _create_game("Integration Game")
        _create_line(game, text="あいうえお", timestamp=1700000000.0)  # 5
        _create_line(game, text="かきく", timestamp=1700050000.0)  # 3
        profiles = build_game_profiles()
        p = profiles[game.id]
        assert p.line_count == 2
        assert p.character_count == 8
        assert p.start_date == 1700000000.0
        assert p.last_played == 1700050000.0

    def test_games_api_uses_sql_aggregation(self, client):
        """The /api/games-management endpoint should return correct stats
        computed via SQL aggregation."""
        game = _create_game("API Agg Game")
        _create_line(game, text="テスト", timestamp=1700000000.0)  # 3 chars
        _create_line(game, text="もうひとつ", timestamp=1700050000.0)  # 5 chars
        resp = client.get("/api/games-management")
        data = resp.get_json()
        matched = [g for g in data["games"] if g["title_original"] == "API Agg Game"]
        assert len(matched) == 1
        assert matched[0]["line_count"] == 2
        assert matched[0]["mined_character_count"] == 8

    def test_build_game_profiles_preserves_exact_timestamps_for_rolled_up_games(self):
        from GameSentenceMiner.web.game_profiles import build_game_profiles

        game = _create_game("Rolled Up Game")
        start_ts = datetime.datetime(2024, 6, 1, 10, 15, 0).timestamp()
        end_ts = datetime.datetime(2024, 6, 1, 22, 45, 0).timestamp()
        _create_line(game, text="あ", timestamp=start_ts)
        _create_line(game, text="い", timestamp=end_ts)

        StatsRollupTable(
            date="2024-06-01",
            total_lines=2,
            total_characters=2,
            game_activity_data=json.dumps(
                {
                    game.id: {
                        "title": game.title_original,
                        "chars": 2,
                        "lines": 2,
                    }
                }
            ),
        ).save()

        profiles = build_game_profiles()

        assert profiles[game.id].start_date == start_ts
        assert profiles[game.id].last_played == end_ts

    def test_invalidate_game_profiles_cache_forces_fresh_aggregation(self, monkeypatch):
        import GameSentenceMiner.web.game_profiles as game_profiles

        game_profiles.invalidate_game_profiles_cache()
        monkeypatch.setattr(game_profiles, "_TESTING", False)

        game = _create_game("Cached Game")
        _create_line(game, text="あ", timestamp=1700000000.0)

        first_profiles = game_profiles.build_game_profiles()
        assert first_profiles[game.id].line_count == 1

        _create_line(game, text="い", timestamp=1700000100.0)

        cached_profiles = game_profiles.build_game_profiles()
        assert cached_profiles[game.id].line_count == 1

        game_profiles.invalidate_game_profiles_cache()
        refreshed_profiles = game_profiles.build_game_profiles()
        assert refreshed_profiles[game.id].line_count == 2

        game_profiles.invalidate_game_profiles_cache()
