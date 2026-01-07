"""
Jiten.moe Database API Routes

This module contains all API routes related to jiten.moe integration and game management.
Handles game linking, searching, updating, and management operations.
"""

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import request, jsonify

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.configuration import logger
from GameSentenceMiner.util.jiten_api_client import JitenApiClient
from GameSentenceMiner.util.cron import cron_scheduler


def add_jiten_link_to_game(game, deck_id):
    """
    Helper function to add or update Jiten.moe link in game's links list.
    Ensures there's only one Jiten link and it's up to date.
    """
    jiten_url = f"https://jiten.moe/decks/media/{deck_id}/detail"

    # Ensure game.links is a list (handle cases where it might be a string or None)
    if not isinstance(game.links, list):
        if isinstance(game.links, str):
            try:
                game.links = json.loads(game.links)
            except (json.JSONDecodeError, TypeError):
                game.links = []
        else:
            game.links = []

    # Check if a Jiten link already exists
    jiten_link_index = None
    for i, link in enumerate(game.links):
        # Handle both string and object formats for backward compatibility
        link_url = link if isinstance(link, str) else (link.get("url") if isinstance(link, dict) else "")
        if "jiten.moe/deck" in link_url:
            jiten_link_index = i
            break

    # Create Jiten link object with proper structure
    jiten_link = {
        "url": jiten_url,
        "linkType": 99,  # Jiten.moe link type
        "deckId": deck_id
    }

    if jiten_link_index is not None:
        # Update existing Jiten link
        game.links[jiten_link_index] = jiten_link
        logger.debug(f"Updated existing Jiten link to: {jiten_url}")
    else:
        # Add new Jiten link
        game.links.append(jiten_link)
        logger.debug(f"Added new Jiten link: {jiten_url}")


def register_jiten_database_api_routes(app):
    """Register all Jiten-related database API routes with the Flask app."""

    @app.route("/api/games-management", methods=["GET"])
    def api_games_management():
        """
        Get all games with their jiten.moe linking status
        ---
        tags:
          - Jiten
        responses:
          200:
            description: List of games with metadata and linking status
            schema:
              type: object
              properties:
                games:
                  type: array
                  items:
                    type: object
                    properties:
                      id:
                        type: string
                      title_original:
                        type: string
                      title_romaji:
                        type: string
                      title_english:
                        type: string
                      type:
                        type: string
                      deck_id:
                        type: string
                      is_linked:
                        type: boolean
                      line_count:
                        type: integer
                      mined_character_count:
                        type: integer
                summary:
                  type: object
                  properties:
                    total_games:
                      type: integer
                    linked_games:
                      type: integer
                    unlinked_games:
                      type: integer
          500:
            description: Failed to fetch games data
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable

            # First, auto-create games for any orphaned game_lines
            # Get all distinct game names from game_lines
            game_names_from_lines = GameLinesTable._db.fetchall(
                f"SELECT DISTINCT game_name FROM {GameLinesTable._table} "
                f"WHERE game_name IS NOT NULL AND game_name != ''"
            )

            # Get existing game titles
            existing_games_rows = GamesTable._db.fetchall(
                f"SELECT title_original FROM {GamesTable._table}"
            )
            existing_titles = {row[0] for row in existing_games_rows}

            # Auto-create games for orphaned game_lines using get_or_create_by_name
            # This will reuse existing game_id mappings instead of creating duplicates
            for row in game_names_from_lines:
                game_name = row[0]
                if game_name not in existing_titles:
                    # Use get_or_create_by_name which checks for existing mappings
                    game = GamesTable.get_or_create_by_name(game_name)

                    # Link any orphaned game_lines to this game
                    GameLinesTable._db.execute(
                        f"UPDATE {GameLinesTable._table} SET game_id = ? WHERE game_name = ? AND (game_id IS NULL OR game_id = '')",
                        (game.id, game_name),
                        commit=True,
                    )

                    logger.debug(
                        f"Auto-linked game_lines for: {game_name} -> game_id={game.id}"
                    )
                    existing_titles.add(game_name)

            # Get all games from the games table
            all_games = GamesTable.all()

            games_data = []
            for game in all_games:
                # Get line count and character count for this game
                lines = game.get_lines()
                line_count = len(lines)

                # Calculate actual mined character count from lines (don't store it)
                actual_char_count = sum(
                    len(line.line_text) if line.line_text else 0 for line in lines
                )

                # Determine linking status - linked if ANY of Jiten, VNDB, or AniList IDs are present
                is_linked = bool(game.deck_id) or bool(game.vndb_id) or bool(game.anilist_id)
                has_manual_overrides = len(game.manual_overrides) > 0

                # Get start and end dates
                start_date = GamesTable.get_start_date(game.id)
                last_played = GamesTable.get_last_played_date(game.id)

                games_data.append(
                    {
                        "id": game.id,
                        "title_original": game.title_original,
                        "title_romaji": game.title_romaji,
                        "title_english": game.title_english,
                        "type": game.type,
                        "description": game.description,
                        "image": game.image,
                        "deck_id": game.deck_id,
                        "vndb_id": game.vndb_id,
                        "anilist_id": game.anilist_id,
                        "difficulty": game.difficulty,
                        "completed": game.completed,
                        "is_linked": is_linked,
                        "has_manual_overrides": has_manual_overrides,
                        "manual_overrides": game.manual_overrides,
                        "line_count": line_count,
                        "mined_character_count": actual_char_count,  # Mined count (calculated from lines)
                        "jiten_character_count": game.character_count,  # Jiten total (from jiten.moe)
                        "start_date": start_date,
                        "last_played": last_played,
                        "links": game.links,
                        "release_date": game.release_date,  # Add release date to API response
                        "genres": game.genres if hasattr(game, "genres") else [],  # Add genres
                        "tags": game.tags if hasattr(game, "tags") else [],  # Add tags
                        "obs_scene_name": game.obs_scene_name
                        if hasattr(game, "obs_scene_name")
                        else "",  # Add OBS scene name
                        "character_summary": game.character_summary
                        if hasattr(game, "character_summary")
                        else "",  # AI-generated character summary
                    }
                )

            # Sort by mined character count (most active games first)
            games_data.sort(key=lambda x: x["mined_character_count"], reverse=True)

            # Calculate summary statistics
            total_games = len(games_data)
            linked_games = sum(1 for game in games_data if game["is_linked"])
            unlinked_games = total_games - linked_games

            return jsonify(
                {
                    "games": games_data,
                    "summary": {
                        "total_games": total_games,
                        "linked_games": linked_games,
                        "unlinked_games": unlinked_games,
                    },
                }
            ), 200

        except Exception as e:
            logger.error(f"Error fetching games management data: {e}", exc_info=True)
            return jsonify({"error": "Failed to fetch games data"}), 500

    @app.route("/api/jiten-search", methods=["GET"])
    def api_jiten_search():
        """
        Search Jiten.moe dictionary entries
        ---
        tags:
          - Jiten
        parameters:
          - name: query
            in: query
            type: string
            required: true
            description: Search term
          - name: page
            in: query
            type: integer
            default: 1
            description: Page number
          - name: page_size
            in: query
            type: integer
            default: 20
            description: Results per page (max 100)
        responses:
          200:
            description: Search results
            schema:
              type: object
              properties:
                results:
                  type: array
                  items:
                    type: object
                    properties:
                      word:
                        type: string
                      reading:
                        type: string
                      meanings:
                        type: array
                        items: string
                total:
                  type: integer
                page:
                  type: integer
                page_size:
                  type: integer
          400:
            description: Invalid search parameters
          500:
            description: Search failed
        """
        try:
            title_filter = request.args.get("title", "").strip()
            if not title_filter:
                return jsonify({"error": "Title parameter is required"}), 400

            # Use API client
            data = JitenApiClient.search_media_decks(title_filter)

            if not data:
                return jsonify({"error": "Failed to search jiten.moe database"}), 500

            # Process and format the results
            results = []
            for item in data.get("data", []):
                # Use the normalize function for consistency
                normalized_item = JitenApiClient.normalize_deck_data(item)
                results.append(normalized_item)

            return jsonify(
                {"results": results, "total_items": data.get("totalItems", 0)}
            ), 200

        except Exception as e:
            logger.debug(f"Error in jiten search: {e}")
            return jsonify({"error": "Search failed"}), 500

    @app.route("/api/games/<game_id>/link-jiten", methods=["POST"])
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
            from GameSentenceMiner.util.games_table import GamesTable
            import requests

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
                add_jiten_link_to_game(game, deck_id)
                # Save the game again to persist the Jiten link
                game.save()

            # Check if it's a Visual Novel and fetch VNDB character data
            if jiten_data.get("media_type_string") == "Visual Novel":
                try:
                    from GameSentenceMiner.util.vndb_api_client import VNDBApiClient
                    
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
                    from GameSentenceMiner.util.anilist_api_client import AniListApiClient
                    
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
                    logger.error(f"Failed to fetch AniList character data: {anilist_error}", exc_info=True)

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

    @app.route("/api/games/<game_id>", methods=["PUT"])
    def api_update_game(game_id):
        """
        Update game information manually (marks fields as manually overridden).
        Supports all game fields including image, deck_id, character_count, and links.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable

            data = request.get_json()
            if not data:
                return jsonify({"error": "No data provided"}), 400

            # Get the game
            game = GamesTable.get(game_id)
            if not game:
                return jsonify({"error": "Game not found"}), 404

            # Update fields using manual update method (marks as manual override)
            update_fields = {}

            # All allowed fields for manual editing
            allowed_fields = [
                "title_original",
                "title_romaji",
                "title_english",
                "type",
                "description",
                "difficulty",
                "completed",
                "deck_id",
                "vndb_id",
                "anilist_id",
                "character_count",
                "image",
                "links",
                "release_date",
                "genres",
                "tags",
                "character_summary",
            ]

            for field in allowed_fields:
                if field in data:
                    value = data[field]
                    # Map 'type' to 'game_type' for the method parameter
                    field_key = "game_type" if field == "type" else field

                    # Handle empty strings for optional fields
                    if (
                        field
                        in [
                            "title_romaji",
                            "title_english",
                            "type",
                            "description",
                            "image",
                            "release_date",
                            "character_summary",
                            "vndb_id",
                            "anilist_id",
                        ]
                        and value == ""
                    ):
                        update_fields[field_key] = ""
                    # Handle None values for numeric fields
                    elif (
                        field in ["difficulty", "deck_id", "character_count"]
                        and value == ""
                    ):
                        update_fields[field_key] = None
                    # Handle boolean
                    elif field == "completed":
                        update_fields[field_key] = bool(value)
                    # Handle VNDB ID - ensure it has 'v' prefix
                    elif field == "vndb_id" and value:
                        # Strip any existing 'v' prefix and add it back to normalize format
                        vndb_value = str(value).strip()
                        if vndb_value and not vndb_value.startswith('v'):
                            vndb_value = f"v{vndb_value}"
                        update_fields[field_key] = vndb_value
                    # Handle lists
                    elif field == "links":
                        if isinstance(value, list):
                            update_fields[field_key] = value
                        elif value == "":
                            update_fields[field_key] = []
                    else:
                        update_fields[field_key] = value

            if update_fields:
                game.update_all_fields_manual(**update_fields)

                logger.debug(
                    f"Manually updated game {game_id} fields: {list(update_fields.keys())}"
                )

                return jsonify(
                    {
                        "success": True,
                        "message": "Game updated successfully",
                        "updated_fields": list(update_fields.keys()),
                        "manual_overrides": game.manual_overrides,
                    }
                ), 200
            else:
                return jsonify({"error": "No valid fields to update"}), 400

        except Exception as e:
            logger.error(f"Error updating game: {e}", exc_info=True)
            return jsonify({"error": f"Failed to update game: {str(e)}"}), 500

    @app.route("/api/games/<game_id>/mark-complete", methods=["POST"])
    def api_mark_game_complete(game_id):
        """
        Mark a game as completed.
        Sets the completed field to True for the specified game.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable

            # Get the game
            game = GamesTable.get(game_id)
            if not game:
                return jsonify({"error": "Game not found"}), 404

            # Mark as completed
            game.completed = True
            game.save()

            logger.debug(f"Marked game {game_id} ({game.title_original}) as completed")

            return jsonify(
                {
                    "success": True,
                    "message": f'Game "{game.title_original}" marked as completed',
                    "game_id": game_id,
                    "completed": True,
                }
            ), 200

        except Exception as e:
            logger.error(f"Error marking game as complete: {e}", exc_info=True)
            return jsonify({"error": f"Failed to mark game as complete: {str(e)}"}), 500

    @app.route("/api/games/<game_id>/repull-jiten", methods=["POST"])
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
            from GameSentenceMiner.util.games_table import GamesTable
            from GameSentenceMiner.util.vndb_api_client import VNDBApiClient
            from GameSentenceMiner.util.anilist_api_client import AniListApiClient

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
                    logger.error(f"Failed to fetch AniList character data: {e}", exc_info=True)

            # === SAVE UPDATES ===
            if update_fields:
                game.update_all_fields_from_jiten(**update_fields)

                # Automatically add Jiten link if links are not manually overridden and we have a deck_id
                if "links" not in manual_overrides and has_jiten:
                    add_jiten_link_to_game(game, game.deck_id)
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
                    add_jiten_link_to_game(game, game.deck_id)
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

    @app.route("/api/games/<game_id>", methods=["DELETE"])
    def api_delete_individual_game(game_id):
        """
        Delete (unlink) an individual game from the games table.
        This removes the game record but preserves all game_lines data by setting game_id to NULL.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable

            # Get the game to verify it exists
            game = GamesTable.get(game_id)
            if not game:
                return jsonify({"error": "Game not found"}), 404

            game_name = game.title_original

            # Get count of lines that will be unlinked
            lines_count = GameLinesTable._db.fetchone(
                f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE game_id=?",
                (game_id,),
            )
            unlinked_lines = lines_count[0] if lines_count else 0

            # Unlink game_lines by setting game_id to NULL
            GameLinesTable._db.execute(
                f"UPDATE {GameLinesTable._table} SET game_id = NULL WHERE game_id = ?",
                (game_id,),
                commit=True,
            )

            # Delete the game record from games table
            GameLinesTable._db.execute(
                f"DELETE FROM {GamesTable._table} WHERE id = ?", (game_id,), commit=True
            )

            logger.debug(
                f"Unlinked game '{game_name}' (id={game_id}): removed game record, unlinked {unlinked_lines} lines"
            )

            # Trigger stats rollup after unlinking game
            try:
                logger.info("Triggering stats rollup after game unlink")
                cron_scheduler.force_daily_rollup()
            except Exception as rollup_error:
                logger.error(f"Stats rollup failed after game unlink: {rollup_error}")
                # Don't fail the unlink operation if rollup fails

            return jsonify(
                {
                    "success": True,
                    "message": f'Game "{game_name}" has been unlinked successfully',
                    "game_name": game_name,
                    "unlinked_lines": unlinked_lines,
                }
            ), 200

        except Exception as e:
            logger.error(f"Error unlinking game {game_id}: {e}", exc_info=True)
            return jsonify({"error": f"Failed to unlink game: {str(e)}"}), 500

    @app.route("/api/games/<game_id>/delete-lines", methods=["DELETE"])
    def api_delete_game_lines(game_id):
        """
        Permanently delete all lines associated with a game.
        This is a destructive operation that cannot be undone.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable

            # Get the game to verify it exists
            game = GamesTable.get(game_id)
            if not game:
                return jsonify({"error": "Game not found"}), 404

            game_name = game.title_original

            # Get count of lines that will be deleted
            lines_count = GameLinesTable._db.fetchone(
                f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE game_id=?",
                (game_id,),
            )
            lines_to_delete = lines_count[0] if lines_count else 0

            if lines_to_delete == 0:
                return jsonify(
                    {"error": "No lines found for this game"}
                ), 404

            # PERMANENTLY DELETE all lines for this game
            GameLinesTable._db.execute(
                f"DELETE FROM {GameLinesTable._table} WHERE game_id = ?",
                (game_id,),
                commit=True,
            )

            # Also delete the game record from games table
            GameLinesTable._db.execute(
                f"DELETE FROM {GamesTable._table} WHERE id = ?", (game_id,), commit=True
            )

            logger.info(
                f"PERMANENTLY DELETED game '{game_name}' (id={game_id}): deleted {lines_to_delete} lines and game record"
            )

            # Trigger stats rollup after deleting game lines
            try:
                logger.info("Triggering stats rollup after game lines deletion")
                cron_scheduler.force_daily_rollup()
            except Exception as rollup_error:
                logger.error(f"Stats rollup failed after game lines deletion: {rollup_error}")
                # Don't fail the deletion operation if rollup fails

            return jsonify(
                {
                    "success": True,
                    "message": f'Game lines for "{game_name}" have been PERMANENTLY DELETED',
                    "game_name": game_name,
                    "deleted_lines": lines_to_delete,
                }
            ), 200

        except Exception as e:
            logger.error(f"Error deleting game lines for {game_id}: {e}", exc_info=True)
            return jsonify({"error": f"Failed to delete game lines: {str(e)}"}), 500

    @app.route("/api/orphaned-games", methods=["GET"])
    def api_orphaned_games():
        """
        Get game names from game_lines that don't have corresponding games records.
        Returns potential games that users can choose to create.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable

            # Get all distinct game names from game_lines
            game_names_from_lines = GameLinesTable._db.fetchall(
                f"SELECT DISTINCT game_name, COUNT(*) as line_count, SUM(LENGTH(line_text)) as char_count "
                f"FROM {GameLinesTable._table} "
                f"WHERE game_name IS NOT NULL AND game_name != '' "
                f"GROUP BY game_name"
            )

            # Get all existing game titles from games table
            existing_games = GamesTable._db.fetchall(
                f"SELECT title_original FROM {GamesTable._table}"
            )
            existing_titles = {row[0] for row in existing_games}

            # Find orphaned games (in game_lines but not in games table)
            orphaned_games = []
            for row in game_names_from_lines:
                game_name, line_count, char_count = row
                if game_name not in existing_titles:
                    # Get date range for this game
                    date_range = GameLinesTable._db.fetchone(
                        f"SELECT MIN(timestamp), MAX(timestamp) FROM {GameLinesTable._table} WHERE game_name=?",
                        (game_name,),
                    )
                    min_timestamp, max_timestamp = (
                        date_range if date_range else (None, None)
                    )

                    orphaned_games.append(
                        {
                            "game_name": game_name,
                            "line_count": line_count,
                            "character_count": char_count or 0,
                            "first_seen": min_timestamp,
                            "last_seen": max_timestamp,
                        }
                    )

            # Sort by character count (most active first)
            orphaned_games.sort(key=lambda x: x["character_count"], reverse=True)

            return jsonify(
                {
                    "orphaned_games": orphaned_games,
                    "total_orphaned": len(orphaned_games),
                    "total_managed": len(existing_titles),
                }
            ), 200

        except Exception as e:
            logger.error(f"Error fetching orphaned games: {e}")
            return jsonify({"error": "Failed to fetch orphaned games"}), 500

    @app.route("/api/games", methods=["POST"])
    def api_create_game():
        """
        Create a new game record (custom or from jiten.moe data).
        Links orphaned game_lines to the newly created game.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable

            data = request.get_json()
            if not data:
                return jsonify({"error": "No data provided"}), 400

            # Required field
            title_original = data.get("title_original", "").strip()
            if not title_original:
                return jsonify({"error": "title_original is required"}), 400

            # Check if game already exists
            existing_game = GamesTable.get_by_title(title_original)
            if existing_game:
                return jsonify(
                    {"error": f'Game with title "{title_original}" already exists'}
                ), 400

            # Create new game with provided data
            game_data = {
                "title_original": title_original,
                "title_romaji": data.get("title_romaji", ""),
                "title_english": data.get("title_english", ""),
                "game_type": data.get("type", ""),
                "description": data.get("description", ""),
                "image": data.get("image", ""),
                "difficulty": data.get("difficulty"),
                "links": data.get("links", []),
                "completed": data.get("completed", False),
            }

            # Create the game
            new_game = GamesTable(**game_data)
            new_game.add()  # Use add() instead of save() for new records with UUID primary keys

            # Link orphaned game_lines to this new game
            lines_updated = 0
            try:
                GameLinesTable._db.execute(
                    f"UPDATE {GameLinesTable._table} SET game_id = ? WHERE game_name = ? AND (game_id IS NULL OR game_id = '')",
                    (new_game.id, title_original),
                    commit=True,
                )

                # Count how many lines were updated
                updated_count = GameLinesTable._db.fetchone(
                    f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE game_id = ?",
                    (new_game.id,),
                )
                lines_updated = updated_count[0] if updated_count else 0

                # Don't update character_count - it should only store jiten.moe's total
                # Mined character count is calculated on-the-fly from game_lines

            except Exception as link_error:
                logger.warning(
                    f"Failed to link orphaned lines to new game {new_game.id}: {link_error}"
                )

            logger.debug(
                f"Created new game: {title_original} (id={new_game.id}, linked {lines_updated} lines)"
            )

            return (
                jsonify(
                    {
                        "success": True,
                        "message": f'Game "{title_original}" created successfully',
                        "game": {
                            "id": new_game.id,
                            "title_original": new_game.title_original,
                            "title_romaji": new_game.title_romaji,
                            "title_english": new_game.title_english,
                            "type": new_game.type,
                            "jiten_character_count": new_game.character_count,  # Jiten total (if linked)
                            "lines_linked": lines_updated,
                        },
                    }
                ),
                201,
            )

        except Exception as e:
            logger.error(f"Error creating game: {e}")
            return jsonify({"error": f"Failed to create game: {str(e)}"}), 500

    @app.route("/api/debug-db", methods=["GET"])
    def api_debug_db():
        """Debug endpoint to check database structure and content."""
        try:
            # Check table structure
            columns_info = GameLinesTable._db.fetchall("PRAGMA table_info(game_lines)")
            table_structure = [
                {"name": col[1], "type": col[2], "notnull": col[3], "default": col[4]}
                for col in columns_info
            ]

            # Check if we have any data
            count_result = GameLinesTable._db.fetchone(
                "SELECT COUNT(*) FROM game_lines"
            )
            total_count = count_result[0] if count_result else 0

            # Try to get a sample record
            sample_record = None
            if total_count > 0:
                sample_row = GameLinesTable._db.fetchone(
                    "SELECT * FROM game_lines LIMIT 1"
                )
                if sample_row:
                    sample_record = {
                        "row_length": len(sample_row),
                        "sample_data": sample_row[:5]
                        if len(sample_row) > 5
                        else sample_row,  # First 5 columns only
                    }

            # Test the model
            model_info = {
                "fields_count": len(GameLinesTable._fields),
                "types_count": len(GameLinesTable._types),
                "fields": GameLinesTable._fields,
                "types": [str(t) for t in GameLinesTable._types],
            }

            return jsonify(
                {
                    "table_structure": table_structure,
                    "total_records": total_count,
                    "sample_record": sample_record,
                    "model_info": model_info,
                }
            ), 200

        except Exception as e:
            logger.error(f"Error in debug endpoint: {e}")
            return jsonify({"error": f"Debug failed: {str(e)}"}), 500

    @app.route("/api/search/unified", methods=["GET"])
    def api_unified_search():
        """
        Search across Jiten, VNDB, and AniList simultaneously.
        
        Query Parameters:
        - q: Search query (required)
        - sources: Comma-separated list of sources (default: jiten,vndb,anilist)
        
        Returns:
        {
            "jiten": {"results": [...], "total": 10, "error": null},
            "vndb": {"results": [...], "total": 5, "error": null},
            "anilist": {"results": [...], "total": 8, "error": null}
        }
        """
        from GameSentenceMiner.util.vndb_api_client import VNDBApiClient
        from GameSentenceMiner.util.anilist_api_client import AniListApiClient
        
        # Constants
        SEARCH_TIMEOUT = 15  # seconds per source
        
        query = request.args.get("q", "").strip()
        if not query:
            return jsonify({"error": "Query parameter 'q' is required"}), 400
        
        # Parse requested sources
        sources_param = request.args.get("sources", "jiten,vndb,anilist")
        requested_sources = [s.strip().lower() for s in sources_param.split(",")]
        
        # Initialize results structure
        results = {}
        
        def search_jiten():
            """Search Jiten.moe and normalize results"""
            try:
                logger.info(f"[Unified Search] Searching Jiten.moe for: '{query}'")
                data = JitenApiClient.search_media_decks(query)
                if not data:
                    logger.warning(f"[Unified Search] Jiten.moe returned no data for: '{query}'")
                    return {"results": [], "total": 0, "error": "Failed to fetch from Jiten.moe"}
                
                result_count = len(data.get("data", []))
                total_items = data.get("totalItems", 0)
                logger.info(f"[Unified Search] Jiten.moe returned {result_count} results for '{query}' (total: {total_items})")
                
                normalized_results = []
                for item in data.get("data", []):
                    deck_data = JitenApiClient.normalize_deck_data(item)
                    
                    # Determine cover URL
                    cover_url = None
                    if deck_data.get("cover_name"):
                        cover_url = deck_data["cover_name"]
                    
                    normalized_results.append({
                        "id": str(deck_data.get("deck_id", "")),
                        "title": deck_data.get("title_original", ""),
                        "title_en": deck_data.get("title_english", ""),
                        "title_jp": deck_data.get("title_original", ""),
                        "cover_url": cover_url,
                        "source": "jiten",
                        "source_url": f"https://jiten.moe/decks/media/{deck_data.get('deck_id')}/detail",
                        "description": (deck_data.get("description", "") or "")[:200],
                        "media_type": deck_data.get("media_type_string", ""),
                        "character_count": deck_data.get("character_count", 0),
                        "difficulty": deck_data.get("difficulty", 0),
                        # Original data for linking
                        "_raw": deck_data
                    })
                
                return {
                    "results": normalized_results,
                    "total": data.get("totalItems", len(normalized_results)),
                    "error": None
                }
            except Exception as e:
                logger.error(f"Jiten search error: {e}")
                return {"results": [], "total": 0, "error": str(e)}
        
        def search_vndb():
            """Search VNDB and normalize results"""
            try:
                logger.info(f"[Unified Search] Searching VNDB for: '{query}'")
                data = VNDBApiClient.search_vn(query, limit=10)
                if not data:
                    logger.warning(f"[Unified Search] VNDB returned no data for: '{query}'")
                    return {"results": [], "total": 0, "error": "Failed to fetch from VNDB"}
                
                result_count = len(data.get("results", []))
                logger.info(f"[Unified Search] VNDB returned {result_count} results for '{query}'")
                
                normalized_results = []
                for item in data.get("results", []):
                    # Extract cover URL from image object
                    cover_url = None
                    image_data = item.get("image")
                    if isinstance(image_data, dict):
                        cover_url = image_data.get("url")
                    
                    # Extract developer names
                    developers = item.get("developers", [])
                    developer_names = []
                    if developers:
                        developer_names = [d.get("name", "") for d in developers if d.get("name")]
                    
                    # Clean description
                    description = item.get("description", "") or ""
                    # Remove VNDB BBCode tags for display
                    import re
                    description = re.sub(r'\[/?[^\]]+\]', '', description)[:200]
                    
                    normalized_results.append({
                        "id": item.get("id", ""),
                        "title": item.get("title", ""),
                        "title_en": item.get("title", ""),  # VNDB title is usually romanized
                        "title_jp": item.get("alttitle", ""),
                        "cover_url": cover_url,
                        "source": "vndb",
                        "source_url": f"https://vndb.org/{item.get('id', '')}",
                        "description": description,
                        "media_type": "Visual Novel",
                        "rating": item.get("rating"),
                        "released": item.get("released"),
                        "developers": developer_names,
                        # Original data for potential linking
                        "_raw": item
                    })
                
                return {
                    "results": normalized_results,
                    "total": len(normalized_results),
                    "error": None
                }
            except Exception as e:
                logger.error(f"VNDB search error: {e}")
                return {"results": [], "total": 0, "error": str(e)}
        
        def search_anilist_anime():
            """Search AniList for anime and normalize results"""
            try:
                data = AniListApiClient.search_media(query, media_type="ANIME")
                if not data:
                    return {"results": [], "total": 0, "error": "Failed to fetch from AniList"}
                
                media_list = data.get("data", {}).get("Page", {}).get("media", [])
                
                normalized_results = []
                for item in media_list:
                    title_info = item.get("title", {})
                    cover_info = item.get("coverImage", {})
                    
                    # Clean description - strip HTML and AniList spoiler tags
                    description = item.get("description", "") or ""
                    import re
                    description = re.sub(r'<[^>]+>', '', description)  # Remove HTML
                    description = re.sub(r'~!.+?!~', '', description, flags=re.DOTALL)  # Remove spoilers
                    description = description[:200]
                    
                    normalized_results.append({
                        "id": str(item.get("id", "")),
                        "title": title_info.get("romaji", "") or title_info.get("english", ""),
                        "title_en": title_info.get("english", ""),
                        "title_jp": title_info.get("native", ""),
                        "cover_url": cover_info.get("large") or cover_info.get("medium"),
                        "source": "anilist",
                        "source_url": item.get("siteUrl", f"https://anilist.co/anime/{item.get('id')}"),
                        "description": description,
                        "media_type": "Anime",
                        "format": item.get("format"),
                        "status": item.get("status"),
                        "score": item.get("averageScore"),
                        "mal_id": item.get("idMal"),
                        # Original data for potential linking
                        "_raw": item
                    })
                
                return {
                    "results": normalized_results,
                    "total": len(normalized_results),
                    "error": None
                }
            except Exception as e:
                logger.error(f"AniList anime search error: {e}")
                return {"results": [], "total": 0, "error": str(e)}
        
        def search_anilist_manga():
            """Search AniList for manga and normalize results"""
            try:
                data = AniListApiClient.search_media(query, media_type="MANGA")
                if not data:
                    return {"results": [], "total": 0, "error": "Failed to fetch from AniList"}
                
                media_list = data.get("data", {}).get("Page", {}).get("media", [])
                
                normalized_results = []
                for item in media_list:
                    title_info = item.get("title", {})
                    cover_info = item.get("coverImage", {})
                    
                    # Clean description
                    description = item.get("description", "") or ""
                    import re
                    description = re.sub(r'<[^>]+>', '', description)
                    description = re.sub(r'~!.+?!~', '', description, flags=re.DOTALL)
                    description = description[:200]
                    
                    normalized_results.append({
                        "id": str(item.get("id", "")),
                        "title": title_info.get("romaji", "") or title_info.get("english", ""),
                        "title_en": title_info.get("english", ""),
                        "title_jp": title_info.get("native", ""),
                        "cover_url": cover_info.get("large") or cover_info.get("medium"),
                        "source": "anilist",
                        "source_url": item.get("siteUrl", f"https://anilist.co/manga/{item.get('id')}"),
                        "description": description,
                        "media_type": "Manga",
                        "format": item.get("format"),
                        "status": item.get("status"),
                        "score": item.get("averageScore"),
                        "mal_id": item.get("idMal"),
                        "_raw": item
                    })
                
                return {
                    "results": normalized_results,
                    "total": len(normalized_results),
                    "error": None
                }
            except Exception as e:
                logger.error(f"AniList manga search error: {e}")
                return {"results": [], "total": 0, "error": str(e)}
        
        # Map source names to search functions
        search_functions = {}
        if "jiten" in requested_sources:
            search_functions["jiten"] = search_jiten
        if "vndb" in requested_sources:
            search_functions["vndb"] = search_vndb
        if "anilist" in requested_sources:
            # AniList searches both anime and manga
            search_functions["anilist_anime"] = search_anilist_anime
            search_functions["anilist_manga"] = search_anilist_manga
        
        # Execute searches in parallel with timeout
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {
                executor.submit(func): name
                for name, func in search_functions.items()
            }
            
            for future in as_completed(futures, timeout=SEARCH_TIMEOUT + 5):
                source_name = futures[future]
                try:
                    result = future.result(timeout=SEARCH_TIMEOUT)
                    
                    # Combine anime and manga results for AniList
                    if source_name == "anilist_anime":
                        if "anilist" not in results:
                            results["anilist"] = {"results": [], "total": 0, "error": None}
                        results["anilist"]["results"].extend(result["results"])
                        results["anilist"]["total"] += result["total"]
                        if result["error"]:
                            results["anilist"]["error"] = result["error"]
                    elif source_name == "anilist_manga":
                        if "anilist" not in results:
                            results["anilist"] = {"results": [], "total": 0, "error": None}
                        results["anilist"]["results"].extend(result["results"])
                        results["anilist"]["total"] += result["total"]
                        if result["error"] and not results["anilist"]["error"]:
                            results["anilist"]["error"] = result["error"]
                    else:
                        results[source_name] = result
                        
                except TimeoutError:
                    logger.warning(f"Search timeout for source: {source_name}")
                    if source_name.startswith("anilist"):
                        if "anilist" not in results:
                            results["anilist"] = {"results": [], "total": 0, "error": "Timeout"}
                    else:
                        results[source_name] = {"results": [], "total": 0, "error": "Timeout"}
                except Exception as e:
                    logger.error(f"Search error for {source_name}: {e}")
                    if source_name.startswith("anilist"):
                        if "anilist" not in results:
                            results["anilist"] = {"results": [], "total": 0, "error": str(e)}
                    else:
                        results[source_name] = {"results": [], "total": 0, "error": str(e)}
        
        # Ensure all requested sources have entries in results
        for source in requested_sources:
            if source not in results:
                results[source] = {"results": [], "total": 0, "error": "No results"}
        
        # Combine all results into flat array for frontend compatibility
        all_results = []
        for source_name, source_data in results.items():
            all_results.extend(source_data.get("results", []))
        
        # Structure response to match frontend expectations
        response = {
            "results": all_results,
            "by_source": results,
            "query": query,
            "sources_searched": list(results.keys())
        }
        
        return jsonify(response), 200

    @app.route('/api/cron/jiten-upgrader/run', methods=['POST'])
    def api_run_jiten_upgrader():
        """
        Manually trigger the Jiten Upgrader cron job.
        
        This endpoint checks all games with vndb_id or anilist_id (but no deck_id)
        to see if Jiten.moe now has entries for them, and auto-links if found.
        
        ---
        tags:
          - Cron
        responses:
          200:
            description: Jiten upgrader completed successfully
            schema:
              type: object
              properties:
                status:
                  type: string
                  enum: [success, error]
                result:
                  type: object
                  properties:
                    total_checked:
                      type: integer
                    upgraded_to_jiten:
                      type: integer
                    already_on_jiten:
                      type: integer
                    not_found_on_jiten:
                      type: integer
                    failed:
                      type: integer
                    elapsed_time:
                      type: number
          500:
            description: Jiten upgrader failed
        """
        try:
            from GameSentenceMiner.util.cron.jiten_upgrader import upgrade_games_to_jiten
            
            logger.info("Manual trigger: Running Jiten Upgrader")
            result = upgrade_games_to_jiten()
            
            return jsonify({
                'status': 'success',
                'result': {
                    'total_checked': result.get('total_checked', 0),
                    'upgraded_to_jiten': result.get('upgraded_to_jiten', 0),
                    'already_on_jiten': result.get('already_on_jiten', 0),
                    'not_found_on_jiten': result.get('not_found_on_jiten', 0),
                    'failed': result.get('failed', 0),
                    'elapsed_time': result.get('elapsed_time', 0),
                    'details': result.get('details', [])
                }
            }), 200
            
        except Exception as e:
            logger.error(f"Error running Jiten Upgrader: {e}", exc_info=True)
            return jsonify({
                'status': 'error',
                'error': str(e)
            }), 500
