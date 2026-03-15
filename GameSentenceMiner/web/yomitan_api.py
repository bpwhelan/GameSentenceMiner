"""Yomitan Dictionary API endpoint."""

from flask import jsonify, make_response, request

from GameSentenceMiner.util.config.configuration import get_config, logger
from GameSentenceMiner.util.yomitan_dict import YomitanDictBuilder
from GameSentenceMiner.util.yomitan_dict.character_names import (
    get_recent_games_with_character_data,
)


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
        recent_games = get_recent_games_with_character_data(
            desired_count=game_count,
            max_search=50,
        )
        
        if not recent_games:
            return jsonify({
                "error": "No games with valid VNDB character data found",
                "message": "None of your recently played games have populated character data from VNDB.",
                "action": "Visit the Database page → Link Games to VNDB, or play a different game that has character data available"
            }), 404
        
        # 2. Build dictionary combining all games
        port = get_config().general.single_port
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
        port = get_config().general.single_port
        download_url = f"http://127.0.0.1:{port}/api/yomitan-dict?game_count={game_count}&spoiler_level={spoiler_level}"
        index_url = f"http://127.0.0.1:{port}/api/yomitan-index?game_count={game_count}&spoiler_level={spoiler_level}"
        
        # Create a builder just to get consistent metadata generation
        builder = YomitanDictBuilder(download_url=download_url, game_count=game_count, spoiler_level=spoiler_level)
        
        # Get game titles for description (without processing all character data)
        recent_games = get_recent_games_with_character_data(
            desired_count=game_count,
            max_search=50,
        )
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
