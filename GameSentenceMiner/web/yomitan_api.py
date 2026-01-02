"""
Yomitan Dictionary API endpoint.

Generates a Yomitan-compatible dictionary from VNDB character data
for the most recently played games.
"""

from flask import jsonify, make_response
from typing import List

from GameSentenceMiner.util.yomitan_dict import YomitanDictBuilder
from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.configuration import get_config


def get_recent_games(limit: int = 3) -> List[GamesTable]:
    """
    Query game_lines for most recent activity per game.
    Returns games ordered by most recent line timestamp.
    
    Args:
        limit: Maximum number of games to return
        
    Returns:
        List of GamesTable objects with vndb_character_data
    """
    # Query to find games with most recent activity
    query = '''
        SELECT game_id, MAX(timestamp) as last_played
        FROM game_lines
        WHERE game_id IS NOT NULL AND game_id != ''
        GROUP BY game_id
        ORDER BY last_played DESC
        LIMIT ?
    '''
    rows = GameLinesTable._db.fetchall(query, (limit,))
    
    games = []
    for row in rows:
        game_id = row[0]
        game = GamesTable.get(game_id)
        if game and game.vndb_character_data:
            games.append(game)
    
    return games


def register_yomitan_api_routes(app):
    """Register Yomitan dictionary API routes with the Flask app."""
    
    @app.route("/api/yomitan-dict")
    def generate_yomitan_dict():
        """
        Generate Yomitan dictionary ZIP from recent games' character data.
        
        Returns a ZIP file containing a Yomitan-compatible dictionary with
        character names from the 3 most recently played games that have
        VNDB character data.
        
        The dictionary includes:
        - Character names (Japanese + romaji)
        - Character portraits (if available)
        - Role, traits, and descriptions
        - Aliases as separate entries
        
        ---
        tags:
          - Yomitan
        responses:
          200:
            description: ZIP file containing Yomitan dictionary
            content:
              application/zip:
                schema:
                  type: string
                  format: binary
          404:
            description: No games with VNDB character data found
        """
        # 1. Get 3 most recently played games
        recent_games = get_recent_games(limit=3)
        
        if not recent_games:
            return jsonify({"error": "No games with VNDB character data found"}), 404
        
        # 2. Build dictionary combining all games
        port = get_config().general.texthooker_port
        download_url = f"http://127.0.0.1:{port}/api/yomitan-dict"
        builder = YomitanDictBuilder(download_url=download_url)
        
        for game in recent_games:
            if game.vndb_character_data:
                builder.add_game_characters(game)
        
        if not builder.entries:
            return jsonify({"error": "No characters found in recent games"}), 404
        
        # 3. Return ZIP as file download with CORS headers
        zip_bytes = builder.export_bytes()
        response = make_response(zip_bytes)
        response.headers["Content-Type"] = "application/zip"
        response.headers["Content-Disposition"] = "attachment; filename=gsm_characters.zip"
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response
