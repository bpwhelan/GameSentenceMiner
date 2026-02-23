"""
Game Management Routes

Routes for game CRUD operations:
- List games with linking status
- Get/update game details
- Create/delete games
- Mark games as completed
- Manage orphaned games
"""

from flask import Blueprint, request, jsonify

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.cron import cron_scheduler
from GameSentenceMiner.util.database.db import GameLinesTable

game_management_bp = Blueprint('game_management', __name__)


@game_management_bp.route("/api/games-management", methods=["GET"])
def api_games_management():
    """
    Get all games with their jiten.moe linking status
    ---
    tags:
      - Jiten
    responses:
      200:
        description: List of games with metadata and linking status
      500:
        description: Failed to fetch games data
    """
    try:
        from GameSentenceMiner.util.database.games_table import GamesTable

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
        logger.exception(f"Error fetching games management data: {e}")
        return jsonify({"error": "Failed to fetch games data"}), 500


@game_management_bp.route("/api/games/<game_id>", methods=["PUT"])
def api_update_game(game_id):
    """
    Update game information manually (marks fields as manually overridden).
    Supports all game fields including image, deck_id, character_count, and links.
    """
    try:
        from GameSentenceMiner.util.database.games_table import GamesTable

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
        logger.exception(f"Error updating game: {e}")
        return jsonify({"error": f"Failed to update game: {str(e)}"}), 500


@game_management_bp.route("/api/games/<game_id>/mark-complete", methods=["POST"])
def api_mark_game_complete(game_id):
    """
    Mark a game as completed.
    Sets the completed field to True for the specified game.
    """
    try:
        from GameSentenceMiner.util.database.games_table import GamesTable

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
        logger.exception(f"Error marking game as complete: {e}")
        return jsonify({"error": f"Failed to mark game as complete: {str(e)}"}), 500


@game_management_bp.route("/api/games/<game_id>", methods=["DELETE"])
def api_delete_individual_game(game_id):
    """
    Delete (unlink) an individual game from the games table.
    This removes the game record but preserves all game_lines data by setting game_id to NULL.
    """
    try:
        from GameSentenceMiner.util.database.games_table import GamesTable

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
        logger.exception(f"Error unlinking game {game_id}: {e}")
        return jsonify({"error": f"Failed to unlink game: {str(e)}"}), 500


@game_management_bp.route("/api/games/<game_id>/delete-lines", methods=["DELETE"])
def api_delete_game_lines(game_id):
    """
    Permanently delete all lines associated with a game.
    This is a destructive operation that cannot be undone.
    """
    try:
        from GameSentenceMiner.util.database.games_table import GamesTable

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
        logger.exception(f"Error deleting game lines for {game_id}: {e}")
        return jsonify({"error": f"Failed to delete game lines: {str(e)}"}), 500


@game_management_bp.route("/api/orphaned-games", methods=["GET"])
def api_orphaned_games():
    """
    Get game names from game_lines that don't have corresponding games records.
    Returns potential games that users can choose to create.
    """
    try:
        from GameSentenceMiner.util.database.games_table import GamesTable

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


@game_management_bp.route("/api/games", methods=["POST"])
def api_create_game():
    """
    Create a new game record (custom or from jiten.moe data).
    Links orphaned game_lines to the newly created game.
    """
    try:
        from GameSentenceMiner.util.database.games_table import GamesTable

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
