"""
Debug Routes

Routes for debugging/utility:
- Debug database info
- Re-pull game data
- Manual refresh operations
"""

from flask import Blueprint, jsonify

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.db import GameLinesTable

debug_bp = Blueprint('debug', __name__)


@debug_bp.route("/api/debug-db", methods=["GET"])
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
