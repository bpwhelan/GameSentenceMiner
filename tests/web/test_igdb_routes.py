import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


@pytest.fixture(autouse=True)
def _in_memory_db():
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
    test_app = flask.Flask(__name__)
    test_app.config["TESTING"] = True

    from GameSentenceMiner.web.routes.game_management_routes import game_management_bp
    from GameSentenceMiner.web.routes.jiten_linking_routes import jiten_linking_bp
    from GameSentenceMiner.web.routes.search_routes import search_bp

    test_app.register_blueprint(game_management_bp)
    test_app.register_blueprint(jiten_linking_bp)
    test_app.register_blueprint(search_bp)
    return test_app


@pytest.fixture()
def client(app):
    return app.test_client()


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


def test_games_management_counts_igdb_only_games_as_linked(client):
    _create_game(
        "IGDB Only",
        links=[{"url": "https://igdb.com/games/persona-5-royal/"}],
    )

    response = client.get("/api/games-management")
    data = response.get_json()

    assert response.status_code == 200
    assert data["games"][0]["is_linked"] is True
    assert data["summary"]["linked_games"] == 1


def test_link_igdb_imports_metadata_and_cover(client, monkeypatch):
    game = _create_game("Old Title")

    metadata = {
        "igdb_id": "114283",
        "slug": "persona-5-royal",
        "title_original": "Persona 5 Royal",
        "title_romaji": "Persona 5 Royal",
        "title_english": "Persona 5 Royal",
        "description": "Enhanced edition with extra IGDB detail",
        "release_date": "2019-10-31",
        "genres": ["Adventure", "RPG", "Role-playing (RPG)"],
        "platforms": ["Windows PC", "PlayStation 5"],
        "tags": ["Platform: Windows PC", "Platform: PlayStation 5", "Theme: Fantasy"],
        "links": [
            {"url": "https://www.igdb.com/games/persona-5-royal"},
            {"url": "https://atlus.com/p5r/home.html"},
        ],
        "media_type_string": "Game",
        "cover_url": "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/cobaqh.jpg",
    }

    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient.fetch_game_metadata",
        lambda *_args, **_kwargs: metadata,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient.download_cover_image",
        lambda *_args, **_kwargs: "data:image/png;base64,abc123",
    )
    response = client.post(
        f"/api/games/{game.id}/link-igdb",
        json={
            "igdb_url": "https://igdb.com/games/persona-5-royal/",
            "result_type": "Expanded Game",
        },
    )

    assert response.status_code == 200

    updated = GamesTable.get(game.id)
    assert updated.title_original == "Persona 5 Royal"
    assert updated.description == "Enhanced edition with extra IGDB detail"
    assert updated.type == "Game"
    assert updated.release_date == "2019-10-31"
    assert updated.genres == ["Adventure", "RPG", "Role-playing (RPG)"]
    assert updated.tags == ["Platform: Windows PC", "Platform: PlayStation 5", "Theme: Fantasy"]
    assert updated.image == "data:image/png;base64,abc123"
    assert updated.links[0]["url"] == "https://www.igdb.com/games/persona-5-royal"
    assert updated.links[1]["url"] == "https://atlus.com/p5r/home.html"


def test_link_igdb_overrides_empty_manual_fields_for_unlinked_game(client, monkeypatch):
    game = _create_game(
        "",
        title_romaji="",
        title_english="",
        game_type="",
        description="",
        image="",
        links=[],
        manual_overrides=[
            "title_original",
            "title_romaji",
            "title_english",
            "type",
            "description",
            "image",
            "links",
            "release_date",
            "character_summary",
            "vndb_id",
            "anilist_id",
        ],
    )

    metadata = {
        "igdb_id": "114283",
        "slug": "persona-5-royal",
        "title_original": "Persona 5 Royal",
        "title_romaji": "Persona 5 Royal",
        "title_english": "Persona 5 Royal",
        "description": "Enhanced edition",
        "release_date": "2019-10-31",
        "genres": ["Adventure", "RPG"],
        "platforms": ["Windows PC"],
        "links": [{"url": "https://www.igdb.com/games/persona-5-royal"}],
        "media_type_string": "Game",
        "cover_url": "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/cobaqh.jpg",
        "tags": ["Platform: Windows PC"],
    }

    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient.fetch_game_metadata",
        lambda *_args, **_kwargs: metadata,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient.download_cover_image",
        lambda *_args, **_kwargs: "data:image/png;base64,abc123",
    )

    response = client.post(
        f"/api/games/{game.id}/link-igdb",
        json={"igdb_url": "https://www.igdb.com/games/persona-5-royal"},
    )

    assert response.status_code == 200

    updated = GamesTable.get(game.id)
    assert updated.title_original == "Persona 5 Royal"
    assert updated.title_romaji == "Persona 5 Royal"
    assert updated.title_english == "Persona 5 Royal"
    assert updated.type == "Game"
    assert updated.description == "Enhanced edition"
    assert updated.release_date == "2019-10-31"
    assert updated.image == "data:image/png;base64,abc123"
    assert updated.links[0]["url"] == "https://www.igdb.com/games/persona-5-royal"


def test_link_igdb_can_overwrite_manual_fields_when_requested(client, monkeypatch):
    game = _create_game(
        "Manual Title",
        title_romaji="Manual Title",
        title_english="Manual Title",
        game_type="Other",
        description="Manual description",
        image="data:image/png;base64,old",
        release_date="2001-01-01",
        manual_overrides=[
            "title_original",
            "title_romaji",
            "title_english",
            "type",
            "description",
            "image",
            "links",
            "release_date",
        ],
    )

    metadata = {
        "igdb_id": "114283",
        "slug": "persona-5-royal",
        "title_original": "Persona 5 Royal",
        "title_romaji": "Persona 5 Royal",
        "title_english": "Persona 5 Royal",
        "description": "Enhanced edition",
        "release_date": "2019-10-31",
        "genres": ["Adventure", "RPG"],
        "platforms": ["Windows PC"],
        "links": [{"url": "https://www.igdb.com/games/persona-5-royal"}],
        "media_type_string": "Game",
        "cover_url": "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/cobaqh.jpg",
        "tags": ["Platform: Windows PC"],
    }

    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient.fetch_game_metadata",
        lambda *_args, **_kwargs: metadata,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient.download_cover_image",
        lambda *_args, **_kwargs: "data:image/png;base64,new",
    )
    response = client.post(
        f"/api/games/{game.id}/link-igdb",
        json={
            "igdb_url": "https://www.igdb.com/games/persona-5-royal",
            "overwrite_metadata": True,
        },
    )

    assert response.status_code == 200

    updated = GamesTable.get(game.id)
    assert updated.title_original == "Persona 5 Royal"
    assert updated.title_romaji == "Persona 5 Royal"
    assert updated.title_english == "Persona 5 Royal"
    assert updated.type == "Game"
    assert updated.description == "Enhanced edition"
    assert updated.release_date == "2019-10-31"
    assert updated.image == "data:image/png;base64,new"
    assert updated.links[0]["url"] == "https://www.igdb.com/games/persona-5-royal"


def test_repull_jiten_uses_igdb_when_present(client, monkeypatch):
    game = _create_game(
        "Old Title",
        links=[{"url": "https://www.igdb.com/games/persona-5-royal"}],
    )

    metadata = {
        "igdb_id": "114283",
        "slug": "persona-5-royal",
        "title_original": "Persona 5 Royal",
        "title_romaji": "Persona 5 Royal",
        "title_english": "Persona 5 Royal",
        "description": "Enhanced edition with IGDB extras",
        "release_date": "2019-10-31",
        "genres": ["Adventure", "RPG", "Role-playing (RPG)"],
        "platforms": ["Windows PC", "PlayStation 5"],
        "tags": ["Platform: Windows PC", "Platform: PlayStation 5", "Theme: Fantasy"],
        "links": [
            {"url": "https://www.igdb.com/games/persona-5-royal"},
            {"url": "https://atlus.com/p5r/home.html"},
        ],
        "media_type_string": "Game",
        "cover_url": None,
    }

    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient.fetch_game_metadata",
        lambda *_args, **_kwargs: metadata,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient.download_cover_image",
        lambda *_args, **_kwargs: None,
    )
    response = client.post(f"/api/games/{game.id}/repull-jiten")

    assert response.status_code == 200
    payload = response.get_json()
    assert "igdb" in payload["sources_used"]

    updated = GamesTable.get(game.id)
    assert updated.description == "Enhanced edition with IGDB extras"
    assert updated.genres == ["Adventure", "RPG", "Role-playing (RPG)"]
    assert updated.tags == ["Platform: Windows PC", "Platform: PlayStation 5", "Theme: Fantasy"]


def test_unified_search_includes_igdb_results(client, monkeypatch):
    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient.search_game",
        lambda *_args, **_kwargs: {
            "results": [
                {
                    "igdb_id": "114283",
                    "title": "Persona 5 Royal",
                    "year": "2019",
                    "cover_url": "https://images.igdb.com/igdb/image/upload/t_cover_big/cobaqh.jpg",
                    "igdb_url": "https://www.igdb.com/games/persona-5-royal",
                    "platforms": ["Windows PC"],
                    "result_type": "Expanded Game",
                }
            ]
        },
    )

    response = client.get("/api/search/unified?q=persona&sources=igdb")

    assert response.status_code == 200
    data = response.get_json()
    assert data["results"][0]["source"] == "igdb"
    assert data["results"][0]["source_url"] == "https://www.igdb.com/games/persona-5-royal"
