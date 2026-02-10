"""
Game Data Update Script for GameSentenceMiner

This module provides functions to automatically update game metadata from multiple sources:
- Jiten.moe (primary source for VNs, Anime, Manga)
- VNDB (secondary source for Visual Novels)
- AniList (secondary source for Anime/Manga)

Respects manual overrides set by users. Prioritizes Jiten data when available,
but also pulls cover images and supplementary data from VNDB/AniList.

Usage:
    from GameSentenceMiner.util.cron.jiten_update import update_all_jiten_games

    # Update all linked games (from all sources)
    result = update_all_jiten_games()
    print(f"Updated {result['updated_games']} out of {result['total_games']} games")
"""

import time
from typing import Optional, Dict, List

from GameSentenceMiner.util.clients.anilist_api_client import AniListApiClient
from GameSentenceMiner.util.clients.jiten_api_client import JitenApiClient
from GameSentenceMiner.util.clients.vndb_api_client import VNDBApiClient
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.games_table import GamesTable


def fetch_jiten_data_for_game(game: GamesTable) -> Optional[Dict]:
    """
    Fetch fresh data from jiten.moe API for a specific game.

    Args:
        game: GamesTable object with a deck_id

    Returns:
        Dictionary with normalized jiten.moe data (snake_case keys), or None if fetch fails

    Example return structure:
        {
            'deck_id': 123,
            'title_original': '君と彼女と彼女の恋。',
            'title_romaji': 'Kimi to Kanojo to Kanojo no Koi.',
            'title_english': 'You, Me, and Her',
            'description': 'A visual novel about...',
            'cover_name': 'https://...',
            'media_type': 7,  # 1=Anime, 7=Visual Novel, 2=Manga
            'character_count': 50000,
            'difficulty': 5,
            'difficulty_raw': 5.2,
            'links': [...],
            'aliases': [...],
            'release_date': '2013-06-28'
        }
    """
    if not game.deck_id:
        logger.debug(
            f"Game {game.id} ({game.title_original}) has no deck_id, skipping jiten fetch"
        )
        return None

    try:
        logger.debug(
            f"Fetching jiten.moe data for game: {game.title_original} (deck_id: {game.deck_id})"
        )

        # Use direct deck detail API endpoint
        data = JitenApiClient.get_deck_detail(game.deck_id)

        if not data:
            logger.debug(f"Failed to fetch deck detail for deck_id {game.deck_id}")
            return None

        # Extract main deck data from the detail response
        main_deck = data.get("data", {}).get("mainDeck")
        if not main_deck:
            logger.debug(f"No mainDeck found in response for deck_id {game.deck_id}")
            return None

        # Normalize the deck data
        jiten_data = JitenApiClient.normalize_deck_data(main_deck)
        logger.debug(
            f"Successfully fetched jiten.moe data for: {jiten_data['title_original']}"
        )
        return jiten_data

    except Exception as e:
        logger.debug(f"Unexpected error fetching jiten data for game {game.id}: {e}")
        return None


def update_character_data_from_vndb_anilist(game: GamesTable) -> Dict:
    """
    Fetch and update character data from VNDB/AniList for a game based on its vndb_id or anilist_id.
    
    Args:
        game: GamesTable object to update
        
    Returns:
        Dictionary with update summary:
        {
            'success': bool,
            'vndb_updated': bool,
            'anilist_updated': bool,
            'error': Optional[str]
        }
    """
    import json
    
    try:
        vndb_updated = False
        anilist_updated = False
        
        # Check if it's a Visual Novel and has VNDB ID
        if game.vndb_id:
            try:
                vndb_id = game.vndb_id
                logger.info(f"Fetching VNDB character data for VN ID: {vndb_id}")
                vndb_data = VNDBApiClient.process_vn_characters(vndb_id, max_spoiler=2, preserve_spoiler_metadata=True)
                
                if vndb_data:
                    game.vndb_character_data = json.dumps(vndb_data, ensure_ascii=False)
                    game.save()
                    logger.info(f"Updated VNDB data for {game.title_original}")
                    vndb_updated = True
                else:
                    logger.debug(f"No VNDB character data returned for VN ID: {vndb_id}")
                    game.save()
            except Exception as e:
                logger.error(f"Failed to fetch VNDB data for game {game.id}: {e}")
        
        # Check if it has AniList ID (Anime or Manga) and doesn't have VNDB
        if game.anilist_id and not game.vndb_id:
            try:
                media_id = game.anilist_id
                logger.info(f"Fetching AniList character data for ID: {media_id}")
                
                # Try to determine media type from game type, or default to ANIME
                media_type = "ANIME"
                if game.type == "Manga":
                    media_type = "MANGA"
                
                anilist_data = AniListApiClient.process_media_characters(
                    int(media_id), media_type, max_spoiler=2, preserve_spoiler_metadata=True
                )
                
                if anilist_data:
                    game.vndb_character_data = json.dumps(anilist_data, ensure_ascii=False)
                    game.save()
                    logger.info(f"Updated AniList data for {game.title_original}")
                    anilist_updated = True
                else:
                    logger.warning(f"No AniList character data returned for ID: {media_id}")
                    game.save()
            except Exception as e:
                logger.exception(f"Failed to fetch AniList data for game {game.id}: {e}")
        
        return {
            "success": True,
            "vndb_updated": vndb_updated,
            "anilist_updated": anilist_updated,
            "error": None
        }
        
    except Exception as e:
        logger.exception(f"Error updating character data for game {game.id}: {e}")
        return {
            "success": False,
            "vndb_updated": False,
            "anilist_updated": False,
            "error": str(e)
        }


def fetch_cover_image_from_vndb_anilist(game: GamesTable, manual_overrides: List[str]) -> Optional[str]:
    """
    Fetch cover image from VNDB or AniList for a game.
    
    Args:
        game: GamesTable object
        manual_overrides: List of manually overridden fields
        
    Returns:
        Base64-encoded image data, or None if not available or manually overridden
    """
    if "image" in manual_overrides:
        logger.debug(f"Image is manually overridden for game {game.id}")
        return None
    
    # Skip if game already has an image
    if game.image:
        logger.debug(f"Game {game.id} already has an image, skipping VNDB/AniList fetch")
        return None
    
    image_data = None
    
    # Try VNDB first
    if game.vndb_id:
        try:
            logger.debug(f"Fetching cover image from VNDB for {game.vndb_id}")
            image_data = VNDBApiClient.download_cover_image(game.vndb_id)
            if image_data:
                logger.info(f"Downloaded cover image from VNDB for {game.title_original}")
                return image_data
        except Exception as e:
            logger.error(f"Failed to fetch VNDB cover image for game {game.id}: {e}")
    
    # Try AniList if no VNDB image
    if game.anilist_id:
        try:
            media_type = "ANIME"
            if game.type == "Manga":
                media_type = "MANGA"
            
            logger.debug(f"Fetching cover image from AniList for {game.anilist_id}")
            image_data = AniListApiClient.download_cover_image(int(game.anilist_id), media_type)
            if image_data:
                logger.info(f"Downloaded cover image from AniList for {game.title_original}")
                return image_data
        except Exception as e:
            logger.error(f"Failed to fetch AniList cover image for game {game.id}: {e}")
    
    return None


def update_game_from_vndb_or_anilist(game: GamesTable) -> Dict:
    """
    Update a game that has only vndb_id or anilist_id (no deck_id).
    Fetches metadata and cover image from the respective source.
    
    Args:
        game: GamesTable object to update
        
    Returns:
        Dictionary with update summary
    """
    try:
        update_fields = {}
        skipped_fields = []
        sources_used = []
        
        # Ensure manual_overrides is always a list
        manual_overrides = game.manual_overrides if game.manual_overrides is not None else []
        if not isinstance(manual_overrides, list):
            manual_overrides = []
        
        # === VNDB DATA ===
        if game.vndb_id:
            try:
                vndb_metadata = VNDBApiClient.fetch_vn_metadata(game.vndb_id)
                if vndb_metadata:
                    sources_used.append("vndb")
                    
                    # Update fields from VNDB if not manually overridden
                    if "title_original" not in manual_overrides and vndb_metadata.get("title_original"):
                        update_fields["title_original"] = vndb_metadata["title_original"]
                    elif "title_original" in manual_overrides:
                        skipped_fields.append("title_original")
                    
                    if "title_romaji" not in manual_overrides and vndb_metadata.get("title_romaji"):
                        update_fields["title_romaji"] = vndb_metadata["title_romaji"]
                    elif "title_romaji" in manual_overrides:
                        skipped_fields.append("title_romaji")
                    
                    if "description" not in manual_overrides and vndb_metadata.get("description"):
                        update_fields["description"] = vndb_metadata["description"]
                    elif "description" in manual_overrides:
                        skipped_fields.append("description")
                    
                    if "release_date" not in manual_overrides and vndb_metadata.get("release_date"):
                        update_fields["release_date"] = vndb_metadata["release_date"]
                    elif "release_date" in manual_overrides:
                        skipped_fields.append("release_date")
                    
                    if "type" not in manual_overrides:
                        update_fields["game_type"] = "Visual Novel"
                    
                    # Add tags and genres from VNDB
                    if "tags" not in manual_overrides and vndb_metadata.get("tags"):
                        update_fields["tags"] = vndb_metadata["tags"]
                    elif "tags" in manual_overrides:
                        skipped_fields.append("tags")
                    
                    if "genres" not in manual_overrides and vndb_metadata.get("genres"):
                        update_fields["genres"] = vndb_metadata["genres"]
                    elif "genres" in manual_overrides:
                        skipped_fields.append("genres")
                    
                    # Fetch cover image
                    if "image" not in manual_overrides:
                        image_data = VNDBApiClient.download_cover_image(game.vndb_id)
                        if image_data:
                            update_fields["image"] = image_data
                            logger.debug(f"Downloaded VNDB cover image for game {game.id}")
                    elif "image" in manual_overrides:
                        skipped_fields.append("image")
                        
            except Exception as e:
                logger.error(f"Failed to fetch VNDB data for game {game.id}: {e}")
        
        # === ANILIST DATA ===
        if game.anilist_id and not game.vndb_id:  # Only use AniList if no VNDB
            try:
                media_type = "ANIME"
                if game.type == "Manga":
                    media_type = "MANGA"
                
                anilist_metadata = AniListApiClient.fetch_media_metadata(int(game.anilist_id), media_type)
                if anilist_metadata:
                    sources_used.append("anilist")
                    
                    # Update fields from AniList if not manually overridden
                    if "title_original" not in manual_overrides and anilist_metadata.get("title_original"):
                        update_fields["title_original"] = anilist_metadata["title_original"]
                    elif "title_original" in manual_overrides:
                        skipped_fields.append("title_original")
                    
                    if "title_romaji" not in manual_overrides and anilist_metadata.get("title_romaji"):
                        update_fields["title_romaji"] = anilist_metadata["title_romaji"]
                    elif "title_romaji" in manual_overrides:
                        skipped_fields.append("title_romaji")
                    
                    if "title_english" not in manual_overrides and anilist_metadata.get("title_english"):
                        update_fields["title_english"] = anilist_metadata["title_english"]
                    elif "title_english" in manual_overrides:
                        skipped_fields.append("title_english")
                    
                    if "description" not in manual_overrides and anilist_metadata.get("description"):
                        update_fields["description"] = anilist_metadata["description"]
                    elif "description" in manual_overrides:
                        skipped_fields.append("description")
                    
                    if "release_date" not in manual_overrides and anilist_metadata.get("release_date"):
                        update_fields["release_date"] = anilist_metadata["release_date"]
                    elif "release_date" in manual_overrides:
                        skipped_fields.append("release_date")
                    
                    if "type" not in manual_overrides and anilist_metadata.get("media_type"):
                        update_fields["game_type"] = anilist_metadata["media_type"]
                    
                    # Add tags and genres from AniList
                    if "tags" not in manual_overrides and anilist_metadata.get("tags"):
                        update_fields["tags"] = anilist_metadata["tags"]
                    elif "tags" in manual_overrides:
                        skipped_fields.append("tags")
                    
                    if "genres" not in manual_overrides and anilist_metadata.get("genres"):
                        update_fields["genres"] = anilist_metadata["genres"]
                    elif "genres" in manual_overrides:
                        skipped_fields.append("genres")
                    
                    # Fetch cover image
                    if "image" not in manual_overrides:
                        image_data = AniListApiClient.download_cover_image(int(game.anilist_id), media_type)
                        if image_data:
                            update_fields["image"] = image_data
                            logger.debug(f"Downloaded AniList cover image for game {game.id}")
                    elif "image" in manual_overrides:
                        skipped_fields.append("image")
                        
            except Exception as e:
                logger.error(f"Failed to fetch AniList data for game {game.id}: {e}")
        
        # Apply updates
        if update_fields:
            game.update_all_fields_from_jiten(**update_fields)
            logger.debug(f"Updated game {game.id} from {sources_used}: {len(update_fields)} fields")
        
        return {
            "success": True,
            "sources_used": sources_used,
            "updated_fields": list(update_fields.keys()),
            "skipped_fields": skipped_fields,
            "error": None
        }
        
    except Exception as e:
        logger.exception(f"Error updating game {game.id} from VNDB/AniList: {e}")
        return {
            "success": False,
            "sources_used": [],
            "updated_fields": [],
            "skipped_fields": [],
            "error": str(e)
        }


def update_single_game_from_jiten(game: GamesTable, jiten_data: Dict) -> Dict:
    """
    Update a single game's fields from jiten.moe data, respecting manual overrides.
    Always re-downloads cover images.

    Args:
        game: GamesTable object to update
        jiten_data: Dictionary with jiten.moe data (from fetch_jiten_data_for_game)

    Returns:
        Dictionary with update summary:
        {
            'success': bool,
            'updated_fields': List[str],
            'skipped_fields': List[str],
            'error': Optional[str]
        }
    """
    try:
        update_fields = {}
        skipped_fields = []

        # Ensure manual_overrides is always a list
        manual_overrides = (
            game.manual_overrides if game.manual_overrides is not None else []
        )
        if not isinstance(manual_overrides, list):
            logger.warning(
                f"⚠️ manual_overrides is not a list for game {game.id}: {type(manual_overrides)}"
            )
            manual_overrides = []

        logger.debug(
            f"Checking fields for game {game.id} (manual overrides: {manual_overrides})"
        )

        # Check each field against manual overrides
        if "deck_id" not in manual_overrides:
            update_fields["deck_id"] = jiten_data["deck_id"]
        else:
            skipped_fields.append("deck_id")

        if "title_original" not in manual_overrides and jiten_data.get(
            "title_original"
        ):
            update_fields["title_original"] = jiten_data["title_original"]
        elif "title_original" in manual_overrides:
            skipped_fields.append("title_original")

        if "title_romaji" not in manual_overrides and jiten_data.get("title_romaji"):
            update_fields["title_romaji"] = jiten_data["title_romaji"]
        elif "title_romaji" in manual_overrides:
            skipped_fields.append("title_romaji")

        if "title_english" not in manual_overrides and jiten_data.get("title_english"):
            update_fields["title_english"] = jiten_data["title_english"]
        elif "title_english" in manual_overrides:
            skipped_fields.append("title_english")

        if "type" not in manual_overrides and jiten_data.get("media_type"):
            # Map media type to string
            media_type_map = {1: "Anime", 7: "Visual Novel", 2: "Manga"}
            update_fields["game_type"] = media_type_map.get(
                jiten_data["media_type"], "Unknown"
            )
        elif "type" in manual_overrides:
            skipped_fields.append("type")

        if "description" not in manual_overrides and jiten_data.get("description"):
            update_fields["description"] = jiten_data["description"]
        elif "description" in manual_overrides:
            skipped_fields.append("description")

        if (
            "difficulty" not in manual_overrides
            and jiten_data.get("difficulty") is not None
        ):
            update_fields["difficulty"] = jiten_data["difficulty"]
        elif "difficulty" in manual_overrides:
            skipped_fields.append("difficulty")

        if (
            "character_count" not in manual_overrides
            and jiten_data.get("character_count") is not None
        ):
            update_fields["character_count"] = jiten_data["character_count"]
        elif "character_count" in manual_overrides:
            skipped_fields.append("character_count")

        if "links" not in manual_overrides and jiten_data.get("links"):
            update_fields["links"] = jiten_data["links"]
        elif "links" in manual_overrides:
            skipped_fields.append("links")

        if "release_date" not in manual_overrides and jiten_data.get("release_date"):
            update_fields["release_date"] = jiten_data["release_date"]
        elif "release_date" in manual_overrides:
            skipped_fields.append("release_date")

        if "genres" not in manual_overrides and jiten_data.get("genres"):
            update_fields["genres"] = jiten_data["genres"]
        elif "genres" in manual_overrides:
            skipped_fields.append("genres")

        if "tags" not in manual_overrides and jiten_data.get("tags"):
            update_fields["tags"] = jiten_data["tags"]
        elif "tags" in manual_overrides:
            skipped_fields.append("tags")

        # Always re-download image if not manually overridden
        if "image" not in manual_overrides and jiten_data.get("cover_name"):
            image_data = JitenApiClient.download_cover_image(jiten_data["cover_name"])
            if image_data:
                update_fields["image"] = image_data
                logger.debug(f"Downloaded and encoded image for game {game.id}")
            else:
                logger.debug(f"Failed to download image for game {game.id}")
        elif "image" in manual_overrides:
            skipped_fields.append("image")

        # Update the game using the jiten update method (doesn't mark as manual)
        if update_fields:
            game.update_all_fields_from_jiten(**update_fields)
            logger.debug(
                f"Updated game {game.id} ({game.title_original}): {len(update_fields)} fields"
            )
            
            return {
                "success": True,
                "updated_fields": list(update_fields.keys()),
                "skipped_fields": skipped_fields,
                "error": None,
            }
        else:
            logger.debug(
                f"No fields updated for game {game.id} - all fields are manually overridden"
            )
            return {
                "success": True,
                "updated_fields": [],
                "skipped_fields": skipped_fields,
                "error": None,
            }

    except Exception as e:
        logger.error(
            f"💥 Error updating game {game.id} from jiten data: {e}", exc_info=True
        )
        return {
            "success": False,
            "updated_fields": [],
            "skipped_fields": skipped_fields,
            "error": str(e),
        }


def update_all_jiten_games() -> Dict:
    """
    Update all games from their linked data sources (Jiten, VNDB, AniList).

    This is the main entry point for the game data update cron job.
    - Processes games linked to Jiten.moe (deck_id)
    - Processes games linked to VNDB (vndb_id)
    - Processes games linked to AniList (anilist_id)
    - Continues on errors (individual game failures don't stop the process)
    - Downloads cover images from all available sources
    - Adds delay between games to avoid rate limiting

    Returns:
        Dictionary with summary statistics:
        {
            'total_games': int,           # Total games in database
            'jiten_linked': int,          # Games with deck_id
            'vndb_linked': int,           # Games with vndb_id
            'anilist_linked': int,        # Games with anilist_id
            'updated_games': int,         # Successfully updated
            'failed_games': int,          # Failed to update
            'total_fields_updated': int,  # Total fields updated across all games
            'details': List[Dict]         # Per-game details
        }
    """
    logger.info("Starting game data update for all linked games")

    start_time = time.time()

    # Get all games
    all_games = GamesTable.all()
    total_games = len(all_games)

    # Categorize games by source
    jiten_games = [game for game in all_games if game.deck_id]
    vndb_only_games = [game for game in all_games if game.vndb_id and not game.deck_id]
    anilist_only_games = [game for game in all_games if game.anilist_id and not game.deck_id and not game.vndb_id]
    
    jiten_count = len(jiten_games)
    vndb_only_count = len(vndb_only_games)
    anilist_only_count = len(anilist_only_games)
    
    # Games with any source
    linked_games_set = set()
    for game in all_games:
        if game.deck_id or game.vndb_id or game.anilist_id:
            linked_games_set.add(game.id)
    linked_count = len(linked_games_set)
    unlinked_count = total_games - linked_count

    logger.info(
        f"Found {total_games} total games: {jiten_count} Jiten, {vndb_only_count} VNDB-only, "
        f"{anilist_only_count} AniList-only, {unlinked_count} unlinked"
    )

    # Process each game
    updated_count = 0
    failed_count = 0
    total_fields_updated = 0
    details = []

    # === PHASE 1: Process Jiten-linked games ===
    logger.info(f"Phase 1: Processing {jiten_count} Jiten-linked games...")
    for i, game in enumerate(jiten_games, 1):
        logger.debug(
            f"Processing Jiten game {i}/{jiten_count}: {game.title_original} (deck_id: {game.deck_id})"
        )

        game_detail = {
            "game_id": game.id,
            "title": game.title_original,
            "source": "jiten",
            "deck_id": game.deck_id,
            "vndb_id": game.vndb_id,
            "anilist_id": game.anilist_id,
            "success": False,
            "updated_fields": [],
            "skipped_fields": [],
            "error": None,
        }

        try:
            # Fetch jiten data
            jiten_data = fetch_jiten_data_for_game(game)

            if jiten_data is None:
                logger.debug(f"Failed to fetch jiten data for game {game.id}, skipping")
                failed_count += 1
                game_detail["error"] = "Failed to fetch jiten data"
                details.append(game_detail)
                continue

            # Update the game from Jiten
            result = update_single_game_from_jiten(game, jiten_data)

            if result["success"]:
                updated_count += 1
                total_fields_updated += len(result["updated_fields"])
                game_detail["success"] = True
                game_detail["updated_fields"] = result["updated_fields"]
                game_detail["skipped_fields"] = result["skipped_fields"]
                
                # If no image from Jiten, try VNDB/AniList
                manual_overrides = game.manual_overrides if game.manual_overrides else []
                if "image" not in result["updated_fields"] and "image" not in manual_overrides:
                    supplemental_image = fetch_cover_image_from_vndb_anilist(game, manual_overrides)
                    if supplemental_image:
                        game.image = supplemental_image
                        game.save()
                        game_detail["updated_fields"].append("image (vndb/anilist)")
                        total_fields_updated += 1
            else:
                failed_count += 1
                game_detail["error"] = result["error"]

            details.append(game_detail)

        except Exception as e:
            logger.error(
                f"💥 Unexpected error processing game {game.id}: {e}", exc_info=True
            )
            failed_count += 1
            game_detail["error"] = str(e)
            details.append(game_detail)

        # Add delay between games
        if i < jiten_count:
            time.sleep(1)

    # === PHASE 2: Process VNDB-only games ===
    logger.info(f"Phase 2: Processing {vndb_only_count} VNDB-only games...")
    for i, game in enumerate(vndb_only_games, 1):
        logger.debug(
            f"Processing VNDB game {i}/{vndb_only_count}: {game.title_original} (vndb_id: {game.vndb_id})"
        )

        game_detail = {
            "game_id": game.id,
            "title": game.title_original,
            "source": "vndb",
            "vndb_id": game.vndb_id,
            "success": False,
            "updated_fields": [],
            "skipped_fields": [],
            "error": None,
        }

        try:
            result = update_game_from_vndb_or_anilist(game)
            
            if result["success"]:
                updated_count += 1
                total_fields_updated += len(result["updated_fields"])
                game_detail["success"] = True
                game_detail["updated_fields"] = result["updated_fields"]
                game_detail["skipped_fields"] = result["skipped_fields"]
            else:
                failed_count += 1
                game_detail["error"] = result["error"]

            details.append(game_detail)

        except Exception as e:
            logger.error(
                f"💥 Unexpected error processing VNDB game {game.id}: {e}", exc_info=True
            )
            failed_count += 1
            game_detail["error"] = str(e)
            details.append(game_detail)

        # Add delay between games
        if i < vndb_only_count:
            time.sleep(1)

    # === PHASE 3: Process AniList-only games ===
    logger.info(f"Phase 3: Processing {anilist_only_count} AniList-only games...")
    for i, game in enumerate(anilist_only_games, 1):
        logger.debug(
            f"Processing AniList game {i}/{anilist_only_count}: {game.title_original} (anilist_id: {game.anilist_id})"
        )

        game_detail = {
            "game_id": game.id,
            "title": game.title_original,
            "source": "anilist",
            "anilist_id": game.anilist_id,
            "success": False,
            "updated_fields": [],
            "skipped_fields": [],
            "error": None,
        }

        try:
            result = update_game_from_vndb_or_anilist(game)
            
            if result["success"]:
                updated_count += 1
                total_fields_updated += len(result["updated_fields"])
                game_detail["success"] = True
                game_detail["updated_fields"] = result["updated_fields"]
                game_detail["skipped_fields"] = result["skipped_fields"]
            else:
                failed_count += 1
                game_detail["error"] = result["error"]

            details.append(game_detail)

        except Exception as e:
            logger.error(
                f"💥 Unexpected error processing AniList game {game.id}: {e}", exc_info=True
            )
            failed_count += 1
            game_detail["error"] = str(e)
            details.append(game_detail)

        # Add delay between games
        if i < anilist_only_count:
            time.sleep(1)

    # === PHASE 4: Process character data for all games with VNDB/AniList IDs ===
    logger.info("Phase 4: Processing VNDB/AniList character data for all games...")
    for i, game in enumerate(all_games, 1):
        if game.vndb_id or game.anilist_id:
            logger.debug(
                f"Processing character data {i}/{total_games}: {game.title_original} "
                f"(vndb_id: {game.vndb_id}, anilist_id: {game.anilist_id})"
            )
            try:
                update_character_data_from_vndb_anilist(game)
            except Exception as e:
                logger.error(
                    f"💥 Error updating character data for game {game.id}: {e}", exc_info=True
                )
        
        # Add delay between API calls
        if i < total_games:
            time.sleep(0.5)

    elapsed_time = time.time() - start_time

    # Log summary
    logger.info("Game data update completed")
    logger.info(f"Summary:")
    logger.info(f"   - Total games: {total_games}")
    logger.info(f"   - Jiten-linked: {jiten_count}")
    logger.info(f"   - VNDB-only: {vndb_only_count}")
    logger.info(f"   - AniList-only: {anilist_only_count}")
    logger.info(f"   - Unlinked: {unlinked_count}")
    logger.info(f"   - Successfully updated: {updated_count}")
    logger.info(f"   - Failed: {failed_count}")
    logger.info(f"   - Total fields updated: {total_fields_updated}")
    logger.info(f"   - Time elapsed: {elapsed_time:.2f} seconds")

    return {
        "total_games": total_games,
        "jiten_linked": jiten_count,
        "vndb_linked": vndb_only_count,
        "anilist_linked": anilist_only_count,
        "unlinked_games": unlinked_count,
        "updated_games": updated_count,
        "failed_games": failed_count,
        "total_fields_updated": total_fields_updated,
        "elapsed_time": elapsed_time,
        "details": details,
    }


# Example usage for testing
if __name__ == "__main__":
    # Run the update
    result = update_all_jiten_games()

    # Print summary
    print("\n" + "=" * 80)
    print("JITEN UPDATE SUMMARY")
    print("=" * 80)
    print(f"Total games: {result['total_games']}")
    print(f"Linked games: {result['linked_games']}")
    print(f"Successfully updated: {result['updated_games']}")
    print(f"Failed: {result['failed_games']}")
    print(f"Skipped (no deck_id): {result['skipped_games']}")
    print(f"Total fields updated: {result['total_fields_updated']}")
    print(f"Time elapsed: {result['elapsed_time']:.2f} seconds")
    print("=" * 80)

    # Print per-game details
    if result["details"]:
        print("\nPER-GAME DETAILS:")
        print("-" * 80)
        for detail in result["details"]:
            status = "✅" if detail["success"] else "❌"
            print(f"{status} {detail['title']} (deck_id: {detail['deck_id']})")
            if detail["updated_fields"]:
                print(f"   Updated: {', '.join(detail['updated_fields'])}")
            if detail["skipped_fields"]:
                print(f"   Skipped: {', '.join(detail['skipped_fields'])}")
            if detail["error"]:
                print(f"   Error: {detail['error']}")
        print("-" * 80)
