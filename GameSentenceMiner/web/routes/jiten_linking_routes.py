"""
Jiten Linking Routes

Routes for linking games to external databases:
- Link to Jiten.moe
- Link to VNDB
- Link to AniList
- Repull game data from linked sources
- Uses GameUpdateService from GameSentenceMiner/util/shared/game_update_service.py
"""

import json
from flask import Blueprint, request, jsonify

from GameSentenceMiner.util.clients.jiten_api_client import JitenApiClient
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.cron import cron_scheduler
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.shared import GameUpdateService

jiten_linking_bp = Blueprint('jiten_linking', __name__)


@jiten_linking_bp.route("/api/games/<game_id>/link-jiten", methods=["POST"])
def api_link_game_to_jiten(game_id):
    """
    Link a game to jiten.moe data
    ---
    tags:
      - Jiten
    parameters:
      - name: game_id
        in: path
        type: string
        required: true
        description: Game ID
      - name: body
        in: body
        required: true
        schema:
          type: object
          properties:
            deck_id:
              type: string
              description: Jiten.moe deck ID
            jiten_data:
              type: object
              description: Full jiten.moe data object
    responses:
      200:
        description: Game linked successfully
      400:
        description: Invalid request
      404:
        description: Game not found
      500:
        description: Failed to link game
    """
    try:
        from GameSentenceMiner.util.database.games_table import GamesTable

        data = request.get_json()
        if not data:
            return jsonify({"error": "No data provided"}), 400

        deck_id = data.get("deck_id")
        if not deck_id:
            return jsonify({"error": "deck_id is required"}), 400

        # Get the game
        game = GamesTable.get(game_id)
        if not game:
            return jsonify({"error": "Game not found"}), 404

        # Get jiten.moe data to ensure it's valid
        jiten_data = data.get("jiten_data", {})

        # Update game with jiten.moe data, respecting manual overrides
        update_fields = {}

        # Only update fields that are not manually overridden
        if "deck_id" not in game.manual_overrides:
            update_fields["deck_id"] = deck_id

        if "title_original" not in game.manual_overrides and jiten_data.get(
            "title_original"
        ):
            update_fields["title_original"] = jiten_data["title_original"]

        if "title_romaji" not in game.manual_overrides and jiten_data.get(
            "title_romaji"
        ):
            update_fields["title_romaji"] = jiten_data["title_romaji"]

        if "title_english" not in game.manual_overrides and jiten_data.get(
            "title_english"
        ):
            update_fields["title_english"] = jiten_data["title_english"]

        if "type" not in game.manual_overrides and jiten_data.get("media_type_string"):
            # Use the pre-converted media type string from jiten_api_client
            update_fields["game_type"] = jiten_data["media_type_string"]

        if "description" not in game.manual_overrides and jiten_data.get(
            "description"
        ):
            update_fields["description"] = jiten_data["description"]

        if (
            "difficulty" not in game.manual_overrides
            and jiten_data.get("difficulty") is not None
        ):
            update_fields["difficulty"] = jiten_data["difficulty"]

        # Frontend sends snake_case (character_count) from the search endpoint
        if (
            "character_count" not in game.manual_overrides
            and jiten_data.get("character_count") is not None
        ):
            update_fields["character_count"] = jiten_data["character_count"]

        if "links" not in game.manual_overrides and jiten_data.get("links"):
            update_fields["links"] = jiten_data["links"]

        if "release_date" not in game.manual_overrides and jiten_data.get(
            "release_date"
        ):
            update_fields["release_date"] = jiten_data["release_date"]

        if "genres" not in game.manual_overrides and jiten_data.get("genres"):
            update_fields["genres"] = jiten_data["genres"]

        if "tags" not in game.manual_overrides and jiten_data.get("tags"):
            update_fields["tags"] = jiten_data["tags"]

        # Download and encode image if not manually overridden
        if "image" not in game.manual_overrides and jiten_data.get("cover_name"):
            image_data = JitenApiClient.download_cover_image(
                jiten_data["cover_name"]
            )
            if image_data:
                update_fields["image"] = image_data

        # CRITICAL FIX: Use obs_scene_name if available, otherwise query game_lines for actual game_name
        # The obs_scene_name field stores the immutable OBS scene name (e.g., "君と彼女と彼女の恋。　ver1.00")
        # After update_all_fields_from_jiten(), title_original will be the jiten title (e.g., "君と彼女と彼女の恋。")

        # First, try to get obs_scene_name from the game record
        obs_scene_name = (
            game.obs_scene_name
            if hasattr(game, "obs_scene_name") and game.obs_scene_name
            else None
        )

        # If obs_scene_name is not set, query game_lines to find the actual game_name
        if not obs_scene_name:
            result = GameLinesTable._db.fetchone(
                f"SELECT DISTINCT game_name FROM {GameLinesTable._table} WHERE game_id = ? LIMIT 1",
                (game_id,),
            )
            if result and result[0]:
                obs_scene_name = result[0]
                # Store it in obs_scene_name for future use
                game.obs_scene_name = obs_scene_name
            else:
                # Fallback to title_original (this is the old buggy behavior)
                obs_scene_name = game.title_original
                logger.warning(
                    f"Could not find game_name in game_lines for game_id={game_id}, falling back to title_original"
                )

        # Update the game using the jiten update method (doesn't mark as manual)
        game.update_all_fields_from_jiten(**update_fields)

        # Automatically add Jiten link if links are not manually overridden
        if "links" not in game.manual_overrides:
            GameUpdateService.add_jiten_link_to_game(game, deck_id)
            # Save the game again to persist the Jiten link
            game.save()

        # Check if it's a Visual Novel and fetch VNDB character data
        if jiten_data.get("media_type_string") == "Visual Novel":
            try:
                from GameSentenceMiner.util.clients.vndb_api_client import VNDBApiClient
                
                links = jiten_data.get("links", [])
                vndb_id = JitenApiClient.extract_vndb_id(links)
                
                if vndb_id:
                    # Store the VNDB ID in the game record
                    game.vndb_id = vndb_id
                    logger.info(f"Fetching VNDB character data for VN ID: {vndb_id}")
                    vndb_data = VNDBApiClient.process_vn_characters(vndb_id, max_spoiler=2, preserve_spoiler_metadata=True)
                    
                    if vndb_data:
                        # Store as JSON string in the database
                        game.vndb_character_data = json.dumps(vndb_data, ensure_ascii=False)
                        game.save()
                        logger.info(f"Stored {vndb_data.get('character_count', 0)} characters for {game.title_original}")
                    else:
                        logger.debug(f"No VNDB character data returned for VN ID: {vndb_id}")
                        # Still save the vndb_id even if character data fetch fails
                        game.save()
                else:
                    logger.debug(f"No VNDB ID found in links for Visual Novel: {game.title_original}")
            except Exception as vndb_error:
                # VNDB fetch should NOT block the linking process
                logger.error(f"Failed to fetch VNDB character data: {vndb_error}")

        # Check if it's Anime or Manga and fetch AniList character data
        if jiten_data.get("media_type_string") in ["Anime", "Manga"]:
            try:
                from GameSentenceMiner.util.clients.anilist_api_client import AniListApiClient
                
                links = jiten_data.get("links", [])
                logger.info(f"Checking AniList for {jiten_data.get('media_type_string')}, links: {links}")
                anilist_info = JitenApiClient.extract_anilist_id(links)
                
                if anilist_info:
                    media_id, media_type = anilist_info
                    # Store the AniList ID in the game record
                    game.anilist_id = str(media_id)
                    logger.info(f"Fetching AniList character data for {media_type} ID: {media_id}")
                    anilist_data = AniListApiClient.process_media_characters(
                        media_id, media_type, max_spoiler=2, preserve_spoiler_metadata=True
                    )
                    
                    if anilist_data:
                        # Store as JSON string in the database (reuse vndb_character_data field)
                        game.vndb_character_data = json.dumps(anilist_data, ensure_ascii=False)
                        game.save()
                        logger.info(f"Stored {anilist_data.get('character_count', 0)} AniList characters for {game.title_original}")
                    else:
                        logger.warning(f"No AniList character data returned for {media_type} ID: {media_id}")
                        # Still save the anilist_id even if character data fetch fails
                        game.save()
                else:
                    logger.warning(f"No AniList ID found in links: {links}")
            except Exception as anilist_error:
                # AniList fetch should NOT block the linking process
                logger.exception(f"Failed to fetch AniList character data: {anilist_error}")

        # Update ALL game_lines with the OBS scene name to point to this game_id
        # This creates the explicit mapping: OBS scene name -> game_id
        # When a user links a game to jiten.moe, they're saying "this OBS scene name maps to this jiten game"
        lines_updated = 0
        try:
            # Use the obs_scene_name (OBS scene name) to find and update game_lines
            # This will OVERWRITE any existing game_id values
            GameLinesTable._db.execute(
                f"UPDATE {GameLinesTable._table} SET game_id = ? WHERE game_name = ?",
                (game_id, obs_scene_name),
                commit=True,
            )

            # Count how many lines were updated
            updated_count = GameLinesTable._db.fetchone(
                f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE game_id = ?",
                (game_id,),
            )
            lines_updated = updated_count[0] if updated_count else 0

        except Exception as link_error:
            logger.warning(
                f"Failed to update game_lines for game {game_id}: {link_error}"
            )

        logger.info(f"Linked game {game_id} to jiten.moe deck {deck_id}")

        # Trigger stats rollup after linking game
        try:
            logger.info("Triggering stats rollup after game link")
            cron_scheduler.force_daily_rollup()
        except Exception as rollup_error:
            logger.error(f"Stats rollup failed after game link: {rollup_error}")
            # Don't fail the link operation if rollup fails

        return jsonify(
            {
                "success": True,
                "message": f"Game linked to jiten.moe deck {deck_id}",
                "updated_fields": list(update_fields.keys()),
                "manual_overrides": game.manual_overrides,
                "lines_updated": lines_updated,
            }
        ), 200

    except Exception as e:
        logger.error(f"Error linking game to jiten: {e}")
        return jsonify({"error": f"Failed to link game: {str(e)}"}), 500


@jiten_linking_bp.route("/api/games/<game_id>/repull-jiten", methods=["POST"])
def api_repull_game_from_jiten(game_id):
    """
    Repull data for a game from all associated sources (Jiten, VNDB, AniList).
    Respects manual overrides. Prioritizes Jiten data but also pulls from other sources.
    
    This endpoint supports games linked to:
    - Jiten.moe (deck_id)
    - VNDB (vndb_id)
    - AniList (anilist_id)
    
    Cover images are downloaded from all available sources, with priority:
    1. Jiten.moe (if deck_id exists)
    2. VNDB (if vndb_id exists and no Jiten image)
    3. AniList (if anilist_id exists and no Jiten/VNDB image)
    """
    try:
        from GameSentenceMiner.util.database.games_table import GamesTable
        from GameSentenceMiner.util.clients.vndb_api_client import VNDBApiClient
        from GameSentenceMiner.util.clients.anilist_api_client import AniListApiClient

        # Get the game
        game = GamesTable.get(game_id)
        if not game:
            logger.error(f"Game not found: {game_id}")
            return jsonify({"error": "Game not found"}), 404

        # Check if game is linked to any source
        has_jiten = bool(game.deck_id)
        has_vndb = bool(game.vndb_id)
        has_anilist = bool(game.anilist_id)
        
        if not has_jiten and not has_vndb and not has_anilist:
            logger.error(f"Game {game_id} is not linked to any data source")
            return jsonify(
                {"error": "Game is not linked to any data source (Jiten, VNDB, or AniList). Please link it first."}
            ), 400

        # Track which sources were used
        sources_used = []
        update_fields = {}
        skipped_fields = []
        jiten_data = None
        vndb_metadata = None
        anilist_metadata = None

        # Ensure manual_overrides is always a list
        manual_overrides = (
            game.manual_overrides if game.manual_overrides is not None else []
        )
        if not isinstance(manual_overrides, list):
            logger.warning(
                f"manual_overrides is not a list: {type(manual_overrides)} - {manual_overrides}"
            )
            manual_overrides = []

        # === JITEN.MOE DATA (Primary source if available) ===
        if has_jiten:
            try:
                logger.info(f"Fetching Jiten.moe data for deck_id: {game.deck_id}")
                data = JitenApiClient.get_deck_detail(game.deck_id)

                if data:
                    main_deck = data.get("data", {}).get("mainDeck")
                    if main_deck:
                        jiten_data = JitenApiClient.normalize_deck_data(main_deck)
                        sources_used.append("jiten")
                        logger.info(f"Successfully fetched Jiten.moe data for {game.title_original}")
                    else:
                        logger.warning(f"No mainDeck in Jiten response for deck_id {game.deck_id}")
                else:
                    logger.warning(f"Failed to fetch Jiten data for deck_id {game.deck_id}")
            except Exception as e:
                logger.error(f"Jiten API request failed: {e}")

        # === VNDB DATA (Secondary source for Visual Novels) ===
        if has_vndb:
            try:
                logger.info(f"Fetching VNDB data for vndb_id: {game.vndb_id}")
                vndb_metadata = VNDBApiClient.fetch_vn_metadata(game.vndb_id)
                if vndb_metadata:
                    sources_used.append("vndb")
                    logger.info(f"Successfully fetched VNDB metadata for {game.vndb_id}")
            except Exception as e:
                logger.error(f"VNDB API request failed: {e}")

        # === ANILIST DATA (Secondary source for Anime/Manga) ===
        if has_anilist:
            try:
                # Determine media type from game type
                media_type = "ANIME"
                if game.type and game.type.lower() == "manga":
                    media_type = "MANGA"
                
                logger.info(f"Fetching AniList data for anilist_id: {game.anilist_id}")
                anilist_metadata = AniListApiClient.fetch_media_metadata(
                    int(game.anilist_id), media_type
                )
                if anilist_metadata:
                    sources_used.append("anilist")
                    logger.info(f"Successfully fetched AniList metadata for {game.anilist_id}")
            except Exception as e:
                logger.error(f"AniList API request failed: {e}")

        # === APPLY UPDATES (Prioritize Jiten > VNDB > AniList) ===
        
        # Deck ID
        if "deck_id" not in manual_overrides and jiten_data and jiten_data.get("deck_id"):
            update_fields["deck_id"] = jiten_data["deck_id"]
        elif "deck_id" in manual_overrides:
            skipped_fields.append("deck_id")

        # Title Original (Japanese)
        if "title_original" not in manual_overrides:
            if jiten_data and jiten_data.get("title_original"):
                update_fields["title_original"] = jiten_data["title_original"]
            elif vndb_metadata and vndb_metadata.get("title_original"):
                update_fields["title_original"] = vndb_metadata["title_original"]
            elif anilist_metadata and anilist_metadata.get("title_original"):
                update_fields["title_original"] = anilist_metadata["title_original"]
        elif "title_original" in manual_overrides:
            skipped_fields.append("title_original")

        # Title Romaji
        if "title_romaji" not in manual_overrides:
            if jiten_data and jiten_data.get("title_romaji"):
                update_fields["title_romaji"] = jiten_data["title_romaji"]
            elif vndb_metadata and vndb_metadata.get("title_romaji"):
                update_fields["title_romaji"] = vndb_metadata["title_romaji"]
            elif anilist_metadata and anilist_metadata.get("title_romaji"):
                update_fields["title_romaji"] = anilist_metadata["title_romaji"]
        elif "title_romaji" in manual_overrides:
            skipped_fields.append("title_romaji")

        # Title English
        if "title_english" not in manual_overrides:
            if jiten_data and jiten_data.get("title_english"):
                update_fields["title_english"] = jiten_data["title_english"]
            elif anilist_metadata and anilist_metadata.get("title_english"):
                update_fields["title_english"] = anilist_metadata["title_english"]
        elif "title_english" in manual_overrides:
            skipped_fields.append("title_english")

        # Type
        if "type" not in manual_overrides:
            if jiten_data and jiten_data.get("media_type_string"):
                update_fields["game_type"] = jiten_data["media_type_string"]
            elif vndb_metadata:
                update_fields["game_type"] = "Visual Novel"
            elif anilist_metadata and anilist_metadata.get("media_type"):
                update_fields["game_type"] = anilist_metadata["media_type"]
        elif "type" in manual_overrides:
            skipped_fields.append("type")

        # Description
        if "description" not in manual_overrides:
            if jiten_data and jiten_data.get("description"):
                update_fields["description"] = jiten_data["description"]
            elif vndb_metadata and vndb_metadata.get("description"):
                update_fields["description"] = vndb_metadata["description"]
            elif anilist_metadata and anilist_metadata.get("description"):
                update_fields["description"] = anilist_metadata["description"]
        elif "description" in manual_overrides:
            skipped_fields.append("description")

        # Difficulty (Jiten-only)
        if "difficulty" not in manual_overrides and jiten_data and jiten_data.get("difficulty") is not None:
            update_fields["difficulty"] = jiten_data["difficulty"]
        elif "difficulty" in manual_overrides:
            skipped_fields.append("difficulty")

        # Character Count (Jiten-only)
        if "character_count" not in manual_overrides and jiten_data and jiten_data.get("character_count") is not None:
            update_fields["character_count"] = jiten_data["character_count"]
        elif "character_count" in manual_overrides:
            skipped_fields.append("character_count")

        # Links
        if "links" not in manual_overrides and jiten_data and jiten_data.get("links"):
            update_fields["links"] = jiten_data["links"]
        elif "links" in manual_overrides:
            skipped_fields.append("links")

        # Release Date
        if "release_date" not in manual_overrides:
            if jiten_data and jiten_data.get("release_date"):
                update_fields["release_date"] = jiten_data["release_date"]
            elif vndb_metadata and vndb_metadata.get("release_date"):
                update_fields["release_date"] = vndb_metadata["release_date"]
            elif anilist_metadata and anilist_metadata.get("release_date"):
                update_fields["release_date"] = anilist_metadata["release_date"]
        elif "release_date" in manual_overrides:
            skipped_fields.append("release_date")

        # Genres (Jiten-only)
        if "genres" not in manual_overrides and jiten_data and jiten_data.get("genres"):
            update_fields["genres"] = jiten_data["genres"]
        elif "genres" in manual_overrides:
            skipped_fields.append("genres")

        # Tags (Jiten-only)
        if "tags" not in manual_overrides and jiten_data and jiten_data.get("tags"):
            update_fields["tags"] = jiten_data["tags"]
        elif "tags" in manual_overrides:
            skipped_fields.append("tags")

        # === COVER IMAGE (Priority: Jiten > VNDB > AniList) ===
        if "image" not in manual_overrides:
            image_data = None
            image_source = None
            
            # Try Jiten first
            if jiten_data and jiten_data.get("cover_name"):
                image_data = JitenApiClient.download_cover_image(jiten_data["cover_name"])
                if image_data:
                    image_source = "jiten"
                    logger.info(f"Downloaded cover image from Jiten.moe")
            
            # Try VNDB if no Jiten image
            if not image_data and has_vndb:
                image_data = VNDBApiClient.download_cover_image(game.vndb_id)
                if image_data:
                    image_source = "vndb"
                    logger.info(f"Downloaded cover image from VNDB")
            
            # Try AniList if no Jiten/VNDB image
            if not image_data and has_anilist:
                media_type = "ANIME"
                if game.type and game.type.lower() == "manga":
                    media_type = "MANGA"
                image_data = AniListApiClient.download_cover_image(int(game.anilist_id), media_type)
                if image_data:
                    image_source = "anilist"
                    logger.info(f"Downloaded cover image from AniList")
            
            if image_data:
                update_fields["image"] = image_data
                if image_source and image_source not in sources_used:
                    sources_used.append(f"{image_source} (image)")
        elif "image" in manual_overrides:
            skipped_fields.append("image")

        # === UPDATE CHARACTER DATA ===
        # VNDB character data for Visual Novels
        if has_vndb:
            try:
                logger.info(f"Fetching VNDB character data for VN ID: {game.vndb_id}")
                vndb_char_data = VNDBApiClient.process_vn_characters(
                    game.vndb_id, max_spoiler=2, preserve_spoiler_metadata=True
                )
                if vndb_char_data:
                    game.vndb_character_data = json.dumps(vndb_char_data, ensure_ascii=False)
                    logger.info(f"Updated VNDB character data for {game.title_original}")
            except Exception as e:
                logger.error(f"Failed to fetch VNDB character data: {e}")

        # AniList character data for Anime/Manga
        if has_anilist and not has_vndb:  # Only if not already using VNDB
            try:
                media_type = "ANIME"
                if game.type and game.type.lower() == "manga":
                    media_type = "MANGA"
                
                logger.info(f"Fetching AniList character data for {media_type} ID: {game.anilist_id}")
                anilist_char_data = AniListApiClient.process_media_characters(
                    int(game.anilist_id), media_type, max_spoiler=2, preserve_spoiler_metadata=True
                )
                if anilist_char_data:
                    game.vndb_character_data = json.dumps(anilist_char_data, ensure_ascii=False)
                    logger.info(f"Updated AniList character data for {game.title_original}")
            except Exception as e:
                logger.exception(f"Failed to fetch AniList character data: {e}")

        # === SAVE UPDATES ===
        if update_fields:
            game.update_all_fields_from_jiten(**update_fields)

            # Automatically add Jiten link if links are not manually overridden and we have a deck_id
            if "links" not in manual_overrides and has_jiten:
                GameUpdateService.add_jiten_link_to_game(game, game.deck_id)
                game.save()

            return jsonify(
                {
                    "success": True,
                    "message": f'Successfully repulled data for "{game.title_original}"',
                    "sources_used": sources_used,
                    "updated_fields": list(update_fields.keys()),
                    "skipped_fields": skipped_fields,
                    "deck_id": game.deck_id,
                    "vndb_id": game.vndb_id,
                    "anilist_id": game.anilist_id,
                }
            ), 200
        else:
            # Even if no other fields are updated, save character data and Jiten link
            if "links" not in manual_overrides and has_jiten:
                GameUpdateService.add_jiten_link_to_game(game, game.deck_id)
            game.save()

            return jsonify(
                {
                    "success": True,
                    "message": f'No fields updated - all fields are manually overridden for "{game.title_original}"',
                    "sources_used": sources_used,
                    "updated_fields": [],
                    "skipped_fields": skipped_fields,
                    "deck_id": game.deck_id,
                    "vndb_id": game.vndb_id,
                    "anilist_id": game.anilist_id,
                }
            ), 200

    except Exception as e:
        logger.error(
            f"Error repulling data for game {game_id}: {e}", exc_info=True
        )
        return jsonify({"error": f"Failed to repull data: {str(e)}"}), 500
