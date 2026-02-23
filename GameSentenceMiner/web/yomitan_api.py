"""
Yomitan Dictionary API endpoint.

Generates a Yomitan-compatible dictionary from VNDB character data
for the most recently played games.
"""

import json
from flask import jsonify, make_response, request
from typing import List

from GameSentenceMiner.util.config.configuration import get_config, logger
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.yomitan_dict import YomitanDictBuilder


def _has_character_data(game: GamesTable) -> bool:
    """
    Validate that a game actually has character entries, not just an empty JSON structure.
    
    Args:
        game: GamesTable instance to validate
        
    Returns:
        True if game has at least one character entry, False otherwise
    """
    if not game.vndb_character_data:
        return False
    
    try:
        # Parse JSON if it's a string
        char_data = game.vndb_character_data
        if isinstance(char_data, str):
            char_data = json.loads(char_data)
        
        if not isinstance(char_data, dict):
            return False
        
        # Check if any category has characters
        # VNDB data structure: {"characters": {"main": [...], "primary": [...]}}
        characters_obj = char_data.get("characters", {})
        if not isinstance(characters_obj, dict):
            return False
        
        categories = ["main", "primary", "side", "appears"]
        for category in categories:
            characters = characters_obj.get(category, [])
            if isinstance(characters, list) and len(characters) > 0:
                return True
        
        return False
    except (json.JSONDecodeError, TypeError, AttributeError):
        return False


def get_recent_games(desired_count: int = 3, max_search: int = 50) -> List[GamesTable]:
    """
    Query the most recently played games with valid character data.
    
    This function searches through games ordered by their most recent play time
    (based on game_lines timestamps) and validates that they actually contain
    character entries (not just empty JSON structures). It returns games that
    have valid, populated character data.
    
    Args:
        desired_count: Number of valid games to return (default 3)
        max_search: Maximum number of games to check (default 50)
        
    Returns:
        List of GamesTable objects with validated vndb_character_data,
        ordered by most recently played first
    """
    # Query games with character data, ordered by most recent play time
    # Join with game_lines to get the MAX(timestamp) for each game
    query = '''
        SELECT g.id
        FROM games g
        LEFT JOIN (
            SELECT game_id, MAX(timestamp) as last_played
            FROM game_lines
            WHERE game_id IS NOT NULL AND game_id != ''
            GROUP BY game_id
        ) gl ON g.id = gl.game_id
        WHERE g.vndb_character_data IS NOT NULL
          AND g.vndb_character_data != ''
          AND g.vndb_character_data != '{}'
        ORDER BY gl.last_played DESC NULLS LAST
        LIMIT ?
    '''
    rows = GamesTable._db.fetchall(query, (max_search,))
    
    logger.info(f"Yomitan: Found {len(rows)} games with vndb_character_data field set (non-empty)")
    
    valid_games = []
    checked_games = []  # For logging/debugging
    
    for row in rows:
        game_id = row[0]
        game = GamesTable.get(game_id)
        
        if not game:
            continue
        
        game_title = game.title_original or game.title_romaji or game.title_english or game_id
        
        # Validate that the game actually has character entries
        has_data = _has_character_data(game)
        
        if has_data:
            valid_games.append(game)
            checked_games.append((game_title, True, "Has character data"))
            logger.info(f"Yomitan: ✓ '{game_title}' - VALID character data")
            
            # Stop once we have enough valid games
            if len(valid_games) >= desired_count:
                break
        else:
            checked_games.append((game_title, False, "Empty or invalid character data"))
            # Log first few characters of the data to debug
            data_preview = str(game.vndb_character_data)[:100] if game.vndb_character_data else "None"
            logger.info(f"Yomitan: ✗ '{game_title}' - INVALID/EMPTY character data. Preview: {data_preview}")
    
    # Log summary
    if valid_games:
        logger.info(f"Yomitan: SUCCESS - Found {len(valid_games)} game(s) with valid character data out of {len(checked_games)} checked")
    else:
        logger.warning(f"Yomitan: FAILED - No games with valid character data found (checked {len(checked_games)} games)")
    
    return valid_games


def register_yomitan_api_routes(app):
    """Register Yomitan dictionary API routes with the Flask app."""
    
    @app.route("/api/yomitan-dict")
    def generate_yomitan_dict():
        """
        Generate Yomitan dictionary ZIP from recent games' character data.
        
        Returns a ZIP file containing a Yomitan-compatible dictionary with
        character names from the most recently played games that have
        VNDB character data.
        
        Query Parameters:
        - game_count: Number of games to include (1-999, default: 3)
        - spoiler_level: Maximum spoiler level to include (0=None, 1=Minor, 2=Major, default: 0)
        
        The dictionary includes:
        - Character names (Japanese + romaji)
        - Character portraits (if available)
        - Role, traits, and descriptions
        - Aliases as separate entries
        
        ---
        tags:
          - Yomitan
        parameters:
          - name: game_count
            in: query
            type: integer
            default: 3
            minimum: 1
            maximum: 999
            description: Number of recent games to include in dictionary
          - name: spoiler_level
            in: query
            type: integer
            default: 0
            minimum: 0
            maximum: 2
            description: Maximum spoiler level to include (0=None, 1=Minor, 2=Major)
        responses:
          200:
            description: ZIP file containing Yomitan dictionary
            content:
              application/zip:
                schema:
                  type: string
                  format: binary
          400:
            description: Invalid game_count or spoiler_level parameter
          404:
            description: No games with VNDB character data found
        """
        # Get game_count from query parameter (default: 3)
        game_count = request.args.get('game_count', 3, type=int)
        
        # Validate game_count range (1-999)
        if game_count < 1 or game_count > 999:
            return jsonify({
                "error": "Invalid game_count parameter",
                "message": f"game_count must be between 1 and 999, got: {game_count}",
                "action": "Please use a value between 1 and 999"
            }), 400
        
        # Get spoiler_level from query parameter (default: 0)
        spoiler_level = request.args.get('spoiler_level', 0, type=int)
        
        # Validate spoiler_level range (0-2)
        if spoiler_level < 0 or spoiler_level > 2:
            return jsonify({
                "error": "Invalid spoiler_level parameter",
                "message": f"spoiler_level must be between 0 and 2, got: {spoiler_level}",
                "action": "Please use a value between 0 (None), 1 (Minor), or 2 (Major)"
            }), 400
        
        # 1. Get most recently played games with valid character data
        recent_games = get_recent_games(desired_count=game_count, max_search=50)
        
        if not recent_games:
            return jsonify({
                "error": "No games with valid VNDB character data found",
                "message": "None of your recently played games have populated character data from VNDB.",
                "action": "Visit the Database page → Link Games to VNDB, or play a different game that has character data available"
            }), 404
        
        # 2. Build dictionary combining all games
        port = get_config().general.texthooker_port
        download_url = f"http://127.0.0.1:{port}/api/yomitan-dict?game_count={game_count}&spoiler_level={spoiler_level}"
        builder = YomitanDictBuilder(download_url=download_url, game_count=game_count, spoiler_level=spoiler_level)
        
        total_characters = 0
        for game in recent_games:
            char_count = builder.add_game_characters(game)
            total_characters += char_count
            logger.debug(f"Yomitan: Added {char_count} characters from {game.title_original or game.title_romaji or 'Unknown'}")
        
        if not builder.entries:
            game_titles = [g.title_original or g.title_romaji or g.title_english or "Unknown" for g in recent_games]
            return jsonify({
                "error": "No character entries generated",
                "message": f"Character data validation passed but no entries were created from: {', '.join(game_titles)}",
                "action": "This may indicate a data format issue. Please report this on GitHub."
            }), 404
        
        logger.info(f"Yomitan: Generated dictionary with {len(builder.entries)} total entries from {total_characters} characters across {len(recent_games)} games")
        
        # 3. Return ZIP as file download with CORS headers
        zip_bytes = builder.export_bytes()
        response = make_response(zip_bytes)
        response.headers["Content-Type"] = "application/zip"
        response.headers["Content-Disposition"] = "attachment; filename=gsm_characters.zip"
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response
    
    @app.route("/api/yomitan-index")
    def get_yomitan_index():
        """
        Return dictionary metadata for Yomitan update checking.
        
        This endpoint returns a lightweight JSON response containing just the
        index.json metadata that Yomitan uses to check if an update is available.
        Yomitan compares the revision from this endpoint against the installed
        dictionary's revision to determine if an update is needed.
        
        Query Parameters:
        - game_count: Number of games to include (1-999, default: 3)
        - spoiler_level: Maximum spoiler level to include (0=None, 1=Minor, 2=Major, default: 0)
        
        ---
        tags:
          - Yomitan
        parameters:
          - name: game_count
            in: query
            type: integer
            default: 3
            minimum: 1
            maximum: 999
            description: Number of recent games to include in dictionary
          - name: spoiler_level
            in: query
            type: integer
            default: 0
            minimum: 0
            maximum: 2
            description: Maximum spoiler level to include (0=None, 1=Minor, 2=Major)
        responses:
          200:
            description: JSON containing dictionary index metadata
            content:
              application/json:
                schema:
                  type: object
                  properties:
                    title:
                      type: string
                    revision:
                      type: string
                    format:
                      type: integer
                    author:
                      type: string
                    description:
                      type: string
                    downloadUrl:
                      type: string
                    indexUrl:
                      type: string
        """
        # Get game_count from query parameter (default: 3)
        game_count = request.args.get('game_count', 3, type=int)
        
        # Validate game_count range (1-999)
        if game_count < 1 or game_count > 999:
            game_count = 3  # Default to 3 for invalid values
        
        # Get spoiler_level from query parameter (default: 0)
        spoiler_level = request.args.get('spoiler_level', 0, type=int)
        
        # Validate spoiler_level range (0-2)
        if spoiler_level < 0 or spoiler_level > 2:
            spoiler_level = 0  # Default to 0 for invalid values
        
        # Build the index metadata (same as what goes in the ZIP)
        port = get_config().general.texthooker_port
        download_url = f"http://127.0.0.1:{port}/api/yomitan-dict?game_count={game_count}&spoiler_level={spoiler_level}"
        index_url = f"http://127.0.0.1:{port}/api/yomitan-index?game_count={game_count}&spoiler_level={spoiler_level}"
        
        # Create a builder just to get consistent metadata generation
        builder = YomitanDictBuilder(download_url=download_url, game_count=game_count, spoiler_level=spoiler_level)
        
        # Get game titles for description (without processing all character data)
        recent_games = get_recent_games(desired_count=game_count, max_search=50)
        for game in recent_games:
            game_title = game.title_original or game.title_romaji or game.title_english or ""
            if game_title:
                builder.game_titles.append(game_title)
        
        # Build the index using the builder's method
        index = builder._create_index()
        
        # Ensure indexUrl is set (in case _create_index doesn't set it)
        if "indexUrl" not in index:
            index["indexUrl"] = index_url
        
        response = jsonify(index)
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response
