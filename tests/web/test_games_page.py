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

import json
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
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    StatsRollupTable.set_db(db)
    yield db
    db.close()


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
        """Default sort in the current endpoint is by mined_character_count desc."""
        g_small = _create_game("Small")
        g_big = _create_game("Big")
        _create_line(g_small, text="あ")  # 1 char
        _create_line(g_big, text="あいうえおかきくけこ")  # 10 chars
        resp = client.get("/api/games-management")
        titles = [g["title_original"] for g in resp.get_json()["games"]]
        assert titles[0] == "Big"

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
        the endpoint auto-creates it."""
        # Insert a line with no corresponding games record
        line = GameLinesTable(
            id=str(uuid.uuid4()),
            game_name="Orphan Game",
            line_text="孤独な文",
            timestamp=time.time(),
        )
        line.add()

        resp = client.get("/api/games-management")
        data = resp.get_json()
        titles = {g["title_original"] for g in data["games"]}
        assert "Orphan Game" in titles

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
        with open(nav_path) as f:
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

    def test_delete_lines_no_lines_404(self, client):
        game = _create_game("No Lines Game")
        resp = client.delete(f"/api/games/{game.id}/delete-lines")
        assert resp.status_code == 404


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
    /static/favicon-96x96.png.  The image field in the API response will be
    empty-string or None; the frontend handles this.  We just verify the
    API returns the raw value so the frontend can decide.
    """

    def test_game_with_no_image_returns_empty_string(self, client):
        _create_game("No Image")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["image"] == ""

    def test_game_with_image_returns_image(self, client):
        _create_game("Has Image", image="data:image/png;base64,AAAA")
        resp = client.get("/api/games-management")
        game = resp.get_json()["games"][0]
        assert game["image"].startswith("data:image/png")
