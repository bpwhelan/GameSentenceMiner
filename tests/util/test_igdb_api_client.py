import io

from PIL import Image

from GameSentenceMiner.util.clients.igdb_api_client import IGDBApiClient


def test_search_game_uses_direct_igdb_results(monkeypatch):
    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.gsm_cloud_igdb_client.GSMCloudIGDBClient.search_games",
        lambda *_args, **_kwargs: {
            "results": [
                {
                    "igdb_id": "114283",
                    "igdb_slug": "persona-5-royal",
                    "igdb_url": "https://www.igdb.com/games/persona-5-royal",
                    "title": "Persona 5 Royal",
                    "title_original": "Persona 5 Royal",
                    "title_romaji": "Persona 5 Royal",
                    "title_english": "Persona 5 Royal",
                    "year": "2019",
                    "result_type": "Expanded Game",
                    "platforms": ["Windows PC", "PlayStation 5"],
                    "cover_url": "https://images.igdb.com/igdb/image/upload/t_cover_big/cobaqh.jpg",
                }
            ],
            "total": 1,
        },
    )

    data = IGDBApiClient.search_game("Persona 5 Royal")

    assert data is not None
    result = data["results"][0]
    assert result["id"] == "114283"
    assert result["igdb_id"] == "114283"
    assert result["title"] == "Persona 5 Royal"
    assert result["year"] == "2019"
    assert result["result_type"] == "Expanded Game"
    assert result["platforms"] == ["Windows PC", "PlayStation 5"]
    assert result["source_url"] == "https://www.igdb.com/games/persona-5-royal"
    assert result["igdb_url"] == "https://www.igdb.com/games/persona-5-royal"
    assert result["cover_url"].endswith("/t_cover_big_2x/cobaqh.jpg")


def test_fetch_game_metadata_normalizes_direct_igdb_payload(monkeypatch):
    lookup_targets = []

    def _mock_fetch(*args, **_kwargs):
        lookup_targets.append(args[0])
        return {
            "igdb_id": "114283",
            "igdb_slug": "persona-5-royal",
            "igdb_url": "https://www.igdb.com/games/persona-5-royal",
            "title": "Persona 5 Royal",
            "description_candidate": "An enhanced version of Persona 5.",
            "release_date": "2019-10-31",
            "cover_url": "https://images.igdb.com/igdb/image/upload/t_cover_big/cobaqh.jpg",
            "genres": ["Adventure", "Role-playing (RPG)"],
            "platforms": ["Windows PC", "PlayStation 5"],
            "developers": ["Atlus", "P Studio"],
            "publishers": ["Sega"],
            "links": [
                {"url": "https://www.igdb.com/games/persona-5-royal", "linkType": 1},
                {"url": "https://atlus.com/p5r/home.html", "linkType": 1},
            ],
            "tags": ["Platform: Windows PC", "Theme: Fantasy"],
            "ratings": {
                "rating": 94.26,
                "rating_count": 1500,
                "total_rating": None,
                "total_rating_count": None,
                "aggregated_rating": None,
                "aggregated_rating_count": None,
            },
            "result_type": "Expanded Game",
            "media_type_string": "Game",
        }

    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.gsm_cloud_igdb_client.GSMCloudIGDBClient.fetch_igdb_game",
        _mock_fetch,
    )

    metadata = IGDBApiClient.fetch_game_metadata("https://www.igdb.com/games/persona-5-royal/")

    assert metadata is not None
    assert lookup_targets == ["https://www.igdb.com/games/persona-5-royal"]
    assert metadata["id"] == "114283"
    assert metadata["igdb_id"] == "114283"
    assert metadata["slug"] == "persona-5-royal"
    assert metadata["parent_game_slug"] == ""
    assert metadata["source_url"] == "https://www.igdb.com/games/persona-5-royal"
    assert metadata["igdb_url"] == "https://www.igdb.com/games/persona-5-royal"
    assert metadata["title_original"] == "Persona 5 Royal"
    assert metadata["description"] == "An enhanced version of Persona 5."
    assert metadata["release_date"] == "2019-10-31"
    assert metadata["cover_url"].endswith("/t_cover_big_2x/cobaqh.jpg")
    assert metadata["genres"] == ["Adventure", "Role-playing (RPG)"]
    assert metadata["platforms"] == ["Windows PC", "PlayStation 5"]
    assert metadata["developers"] == ["Atlus", "P Studio"]
    assert metadata["publishers"] == ["Sega"]
    assert metadata["rating"] == 94.26
    assert metadata["rating_count"] == 1500
    assert metadata["media_type_string"] == "Game"
    assert metadata["result_type"] == "Expanded Game"
    assert metadata["links"][0]["url"] == "https://www.igdb.com/games/persona-5-royal"
    assert metadata["links"][1]["url"] == "https://atlus.com/p5r/home.html"


def test_download_cover_image_keeps_existing_2x_urls(monkeypatch):
    image = Image.new("RGB", (12, 16), "red")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG")

    class Response:
        status_code = 200
        content = buffer.getvalue()

    monkeypatch.setattr(
        "GameSentenceMiner.util.clients.igdb_api_client.IGDBApiClient._request",
        lambda *_args, **_kwargs: Response(),
    )

    image_data = IGDBApiClient.download_cover_image(
        "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/coa93z.jpg"
    )

    assert image_data is not None
    assert image_data.startswith("data:image/png;base64,")


def test_extract_igdb_url_handles_legacy_and_canonical_urls():
    links = [
        {"url": "https://example.com"},
        "https://igdb.com/games/persona-5-royal/",
        {"url": "https://www.igdb.com/games/sekiro-shadows-die-twice"},
    ]

    assert IGDBApiClient.extract_igdb_url(links) == "https://www.igdb.com/games/persona-5-royal"


def test_extract_igdb_url_normalizes_canonical_url():
    links = [
        {"url": "https://example.com"},
        {"url": "https://www.igdb.com/games/sekiro-shadows-die-twice"},
    ]

    assert IGDBApiClient.extract_igdb_url(links) == "https://www.igdb.com/games/sekiro-shadows-die-twice"
