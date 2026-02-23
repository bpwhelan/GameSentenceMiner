import json
from types import SimpleNamespace

from GameSentenceMiner.util.shared.game_update_service import GameUpdateService


def test_build_update_fields_respects_manual_overrides():
    game_data = {
        "deck_id": 10,
        "title_original": "Orig",
        "title_romaji": "Roma",
        "title_english": "Eng",
        "media_type_string": "Visual Novel",
        "description": "Desc",
        "release_date": "2024-01-01",
        "links": [{"url": "x"}],
        "difficulty": 3,
        "character_count": 12,
        "genres": ["mystery"],
        "tags": ["tag"],
    }

    fields = GameUpdateService.build_update_fields(
        game_data,
        manual_overrides=["title_original", "difficulty"],
        source="jiten",
    )

    assert "title_original" not in fields
    assert "difficulty" not in fields
    assert fields["deck_id"] == 10
    assert fields["title_romaji"] == "Roma"
    assert fields["title_english"] == "Eng"
    assert fields["game_type"] == "Visual Novel"
    assert fields["character_count"] == 12


def test_build_update_fields_non_list_manual_overrides_is_treated_as_empty():
    fields = GameUpdateService.build_update_fields(
        {"title_original": "Orig", "media_type_string": "Anime"},
        manual_overrides="bad-type",
        source="anilist",
    )
    assert fields["title_original"] == "Orig"
    assert fields["game_type"] == "Anime"


def test_add_jiten_link_to_game_parses_string_links_and_replaces_existing():
    game = SimpleNamespace(links=json.dumps([{"url": "https://jiten.moe/deck/old"}]))
    GameUpdateService.add_jiten_link_to_game(game, deck_id=55)
    assert isinstance(game.links, list)
    assert len(game.links) == 1
    assert game.links[0]["deckId"] == 55
    assert "jiten.moe/decks/media/55/detail" in game.links[0]["url"]


def test_add_vndb_link_to_game_adds_prefix_and_updates_existing():
    game = SimpleNamespace(links=[{"url": "https://vndb.org/v1"}])
    GameUpdateService.add_vndb_link_to_game(game, "1234")
    assert len(game.links) == 1
    assert game.links[0]["url"] == "https://vndb.org/v1234"
    assert game.links[0]["vndbId"] == "v1234"


def test_add_anilist_link_to_game_handles_media_type():
    game = SimpleNamespace(links=[])
    GameUpdateService.add_anilist_link_to_game(game, anilist_id=999, media_type="MANGA")
    assert game.links[0]["url"] == "https://anilist.co/manga/999"
    assert game.links[0]["mediaType"] == "MANGA"


def test_merge_update_fields_from_multiple_sources_prioritizes_jiten():
    jiten = {
        "deck_id": 1,
        "title_original": "JitenOrig",
        "title_romaji": "JitenRoma",
        "description": "JitenDesc",
        "media_type_string": "Visual Novel",
        "difficulty": 2,
        "genres": ["g1"],
        "tags": ["t1"],
    }
    vndb = {
        "title_original": "VndbOrig",
        "title_romaji": "VndbRoma",
        "description": "VndbDesc",
        "release_date": "2020-01-01",
    }
    anilist = {
        "title_original": "AniOrig",
        "title_english": "AniEng",
        "release_date": "2019-01-01",
        "media_type": "ANIME",
    }

    merged = GameUpdateService.merge_update_fields_from_multiple_sources(
        jiten_data=jiten,
        vndb_data=vndb,
        anilist_data=anilist,
        manual_overrides=["title_romaji"],
    )

    assert merged["deck_id"] == 1
    assert merged["title_original"] == "JitenOrig"
    assert "title_romaji" not in merged
    assert merged["description"] == "JitenDesc"
    assert merged["release_date"] == "2020-01-01"
    assert merged["game_type"] == "Visual Novel"
    assert merged["difficulty"] == 2
