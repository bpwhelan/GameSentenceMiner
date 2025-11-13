"""
Jiten.moe Database API Routes

This module contains all API routes related to jiten.moe integration and game management.
Handles game linking, searching, updating, and management operations.
"""

import json
from flask import request, jsonify

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.configuration import logger
from GameSentenceMiner.util.jiten_api_client import JitenApiClient
from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup


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
        Get all games with their jiten.moe linking status and statistics.
        Automatically creates game records for orphaned game_lines.
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

                # Determine linking status
                is_linked = bool(game.deck_id)
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
                        "obs_scene_name": game.obs_scene_name
                        if hasattr(game, "obs_scene_name")
                        else "",  # Add OBS scene name
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
        Search jiten.moe media decks by title.
        """
        try:
            title_filter = request.args.get("title", "").strip()
            if not title_filter:
                return jsonify({"error": "Title parameter is required"}), 400

            # Use centralized API client
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
        Link a game to jiten.moe data, respecting manual overrides.
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
                run_daily_rollup()
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
                "character_count",
                "image",
                "links",
                "release_date",
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
        Repull jiten.moe data for a game, respecting manual overrides.
        Only updates fields that are not in the manually edited fields list.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable
            import requests

            # Get the game
            game = GamesTable.get(game_id)
            if not game:
                logger.error(f"Game not found: {game_id}")
                return jsonify({"error": "Game not found"}), 404

            # Check if game is linked to jiten.moe
            if not game.deck_id:
                logger.error(f"Game {game_id} is not linked to jiten.moe")
                return jsonify(
                    {"error": "Game is not linked to jiten.moe. Please link it first."}
                ), 400

            # Fetch fresh data from jiten.moe API using direct deck detail endpoint
            try:
                # Use direct deck detail API endpoint
                data = JitenApiClient.get_deck_detail(game.deck_id)

                if not data:
                    return jsonify(
                        {"error": "Failed to fetch data from jiten.moe"}
                    ), 500

                # Extract main deck data from the detail response
                main_deck = data.get("data", {}).get("mainDeck")
                if not main_deck:
                    return jsonify(
                        {
                            "error": f"Game with deck_id {game.deck_id} not found on jiten.moe"
                        }
                    ), 404

                # Normalize the deck data
                jiten_data = JitenApiClient.normalize_deck_data(main_deck)

            except Exception as e:
                logger.error(f"Jiten API request failed: {e}")
                return jsonify({"error": "Failed to fetch data from jiten.moe"}), 500

            # Update game with fresh jiten.moe data, respecting manual overrides
            update_fields = {}
            skipped_fields = []

            # Ensure manual_overrides is always a list
            manual_overrides = (
                game.manual_overrides if game.manual_overrides is not None else []
            )
            if not isinstance(manual_overrides, list):
                logger.warning(
                    f"manual_overrides is not a list: {type(manual_overrides)} - {manual_overrides}"
                )
                manual_overrides = []

            # Only update fields that are not manually overridden
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

            if "title_romaji" not in manual_overrides and jiten_data.get(
                "title_romaji"
            ):
                update_fields["title_romaji"] = jiten_data["title_romaji"]
            elif "title_romaji" in manual_overrides:
                skipped_fields.append("title_romaji")

            if "title_english" not in manual_overrides and jiten_data.get(
                "title_english"
            ):
                update_fields["title_english"] = jiten_data["title_english"]
            elif "title_english" in manual_overrides:
                skipped_fields.append("title_english")

            if "type" not in manual_overrides and jiten_data.get("media_type_string"):
                # Use the pre-converted media type string from jiten_api_client
                update_fields["game_type"] = jiten_data["media_type_string"]
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

            if "release_date" not in manual_overrides and jiten_data.get(
                "release_date"
            ):
                update_fields["release_date"] = jiten_data["release_date"]
            elif "release_date" in manual_overrides:
                skipped_fields.append("release_date")

            # Download and encode image if not manually overridden
            if "image" not in manual_overrides and jiten_data.get("cover_name"):
                image_data = JitenApiClient.download_cover_image(
                    jiten_data["cover_name"]
                )
                if image_data:
                    update_fields["image"] = image_data
            elif "image" in manual_overrides:
                skipped_fields.append("image")

            # Update the game using the jiten update method (doesn't mark as manual)
            if update_fields:
                game.update_all_fields_from_jiten(**update_fields)

                # Automatically add Jiten link if links are not manually overridden
                if "links" not in manual_overrides:
                    add_jiten_link_to_game(game, game.deck_id)
                    # Save the game again to persist the Jiten link
                    game.save()

                return jsonify(
                    {
                        "success": True,
                        "message": f'Successfully repulled data from jiten.moe for "{game.title_original}"',
                        "updated_fields": list(update_fields.keys()),
                        "skipped_fields": skipped_fields,  # Always return as list
                        "deck_id": game.deck_id,
                        "jiten_raw_response": jiten_data,  # Include full jiten.moe data
                    }
                ), 200
            else:
                # Even if no other fields are updated, we should still add the Jiten link if links are not manually overridden
                if "links" not in manual_overrides:
                    add_jiten_link_to_game(game, game.deck_id)
                    # Save the game to persist the Jiten link
                    game.save()

                return jsonify(
                    {
                        "success": True,
                        "message": f'No fields updated - all fields are manually overridden for "{game.title_original}"',
                        "updated_fields": [],
                        "skipped_fields": skipped_fields,  # Always return as list
                        "deck_id": game.deck_id,
                        "jiten_raw_response": jiten_data,  # Include full jiten.moe data
                    }
                ), 200

        except Exception as e:
            logger.error(
                f"Error repulling jiten data for game {game_id}: {e}", exc_info=True
            )
            return jsonify({"error": f"Failed to repull jiten data: {str(e)}"}), 500

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
                run_daily_rollup()
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
                run_daily_rollup()
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
