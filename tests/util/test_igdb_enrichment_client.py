from GameSentenceMiner.util.clients.igdb_enrichment_client import IGDBEnrichmentClient


def test_extract_igdb_slug_prefers_game_url():
    links = [
        {"url": "https://igdb.com/games/persona-5-royal/", "linkType": 1},
        {"url": "https://www.igdb.com/games/persona-5-royal", "linkType": 1},
    ]

    assert IGDBEnrichmentClient.extract_igdb_slug(links) == "persona-5-royal"


def test_normalize_igdb_game_collects_mergeable_and_future_metadata():
    client = IGDBEnrichmentClient(client_id="id", client_secret="secret")
    game = {
        "name": "Persona 5 Royal",
        "slug": "persona-5-royal",
        "url": "https://www.igdb.com/games/persona-5-royal",
        "summary": "Longer IGDB summary.",
        "first_release_date": 1572480000,
        "genres": [{"name": "Role-playing (RPG)"}, {"name": "Adventure"}],
        "themes": [{"name": "Fantasy"}],
        "keywords": [{"name": "jrpg"}, {"name": "party-based combat"}],
        "game_modes": [{"name": "Single player"}],
        "player_perspectives": [{"name": "Third person"}],
        "platforms": [{"name": "PlayStation 4"}],
        "collections": [{"name": "Persona"}],
        "franchises": [{"name": "Megami Tensei"}],
        "involved_companies": [
            {"company": {"name": "Atlus"}, "developer": True, "publisher": False},
            {"company": {"name": "Sega"}, "developer": False, "publisher": True},
        ],
        "websites": [
            {"url": "https://persona.atlus.com/p5r/", "category": 1},
            {"url": "https://store.steampowered.com/app/1687950/Persona_5_Royal/", "category": 13},
        ],
        "screenshots": [{"image_id": "abc123"}],
        "artworks": [{"image_id": "def456"}],
        "videos": [{"video_id": "ghi789"}],
        "aggregated_rating": 94.0,
        "aggregated_rating_count": 10,
        "rating": 93.5,
        "rating_count": 100,
        "total_rating": 93.8,
        "total_rating_count": 110,
    }

    normalized = client.normalize_igdb_game(game)

    assert normalized["release_date"] == "2019-10-31"
    assert normalized["genres"] == ["Role-playing (RPG)", "Adventure"]
    assert "Theme: Fantasy" in normalized["tags"]
    assert "Keyword: jrpg" in normalized["tags"]
    assert "Mode: Single player" in normalized["tags"]
    assert "Perspective: Third person" in normalized["tags"]
    assert "Collection: Persona" in normalized["tags"]
    assert "Franchise: Megami Tensei" in normalized["tags"]
    assert "Platform: PlayStation 4" in normalized["tags"]
    assert normalized["developers"] == ["Atlus"]
    assert normalized["publishers"] == ["Sega"]
    assert normalized["website_categories"] == ["Official", "Steam"]
    assert normalized["assets"]["screenshots"] == [
        "https://images.igdb.com/igdb/image/upload/t_screenshot_big/abc123.jpg"
    ]
    assert normalized["assets"]["artworks"] == ["https://images.igdb.com/igdb/image/upload/t_1080p/def456.jpg"]
    assert normalized["assets"]["videos"] == ["https://www.youtube.com/watch?v=ghi789"]


def test_build_merge_candidate_merges_schema_compatible_fields():
    source_metadata = {
        "description": "Short imported description.",
        "release_date": "2020-03-31",
        "genres": ["Adventure"],
        "tags": ["Platform: PlayStation 4"],
        "links": [{"url": "https://www.igdb.com/games/persona-5-royal", "linkType": 1}],
    }
    igdb_metadata = {
        "description_candidate": "Longer IGDB summary that should win.",
        "release_date": "2019-10-31",
        "genres": ["Role-playing (RPG)", "Adventure"],
        "tags": ["Theme: Fantasy", "Platform: PlayStation 4"],
        "links": [
            {"url": "https://www.igdb.com/games/persona-5-royal", "linkType": 1},
            {"url": "https://persona.atlus.com/p5r/", "linkType": 1},
        ],
    }

    merged = IGDBEnrichmentClient.build_merge_candidate(source_metadata, igdb_metadata)

    assert merged["description"] == "Longer IGDB summary that should win."
    assert merged["release_date"] == "2019-10-31"
    assert merged["genres"] == ["Adventure", "Role-playing (RPG)"]
    assert merged["tags"] == ["Platform: PlayStation 4", "Theme: Fantasy"]
    assert merged["links"] == [
        {"url": "https://www.igdb.com/games/persona-5-royal", "linkType": 1},
        {"url": "https://persona.atlus.com/p5r/", "linkType": 1},
    ]


def test_apply_merge_candidate_updates_source_metadata():
    source_metadata = {
        "description": "Short imported description.",
        "release_date": "2020-03-31",
        "genres": ["Adventure"],
        "tags": ["Platform: PlayStation 4"],
        "links": [{"url": "https://www.igdb.com/games/persona-5-royal", "linkType": 1}],
        "media_type_string": "Game",
    }
    igdb_metadata = {
        "description_candidate": "Longer IGDB summary that should win.",
        "release_date": "2019-10-31",
        "genres": ["Role-playing (RPG)", "Adventure"],
        "tags": ["Theme: Fantasy", "Platform: PlayStation 4"],
        "links": [{"url": "https://persona.atlus.com/p5r/", "linkType": 1}],
    }

    merged = IGDBEnrichmentClient.apply_merge_candidate(source_metadata, igdb_metadata)

    assert merged["description"] == "Longer IGDB summary that should win."
    assert merged["release_date"] == "2019-10-31"
    assert merged["genres"] == ["Adventure", "Role-playing (RPG)"]
    assert merged["tags"] == ["Platform: PlayStation 4", "Theme: Fantasy"]
    assert merged["links"] == [
        {"url": "https://www.igdb.com/games/persona-5-royal", "linkType": 1},
        {"url": "https://persona.atlus.com/p5r/", "linkType": 1},
    ]
    assert merged["media_type_string"] == "Game"
