"""
Cron Routes

Routes for cron/background job operations:
- Trigger Jiten upgrader
- Trigger game population
- Cron status endpoints
"""

from flask import Blueprint, jsonify

from GameSentenceMiner.util.config.configuration import logger

cron_bp = Blueprint("cron", __name__)


@cron_bp.route("/api/cron/jiten-upgrader/run", methods=["POST"])
def api_run_jiten_upgrader():
    """
    Manually trigger the Jiten Upgrader cron job.

    This endpoint checks all games with vndb_id or anilist_id (but no deck_id)
    to see if Jiten.moe now has entries for them, and auto-links if found.
    """
    try:
        from GameSentenceMiner.util.cron.jiten_upgrader import upgrade_games_to_jiten

        logger.info("Manual trigger: Running Jiten Upgrader")
        result = upgrade_games_to_jiten()

        return jsonify(
            {
                "status": "success",
                "result": {
                    "total_checked": result.get("total_checked", 0),
                    "upgraded_to_jiten": result.get("upgraded_to_jiten", 0),
                    "already_on_jiten": result.get("already_on_jiten", 0),
                    "not_found_on_jiten": result.get("not_found_on_jiten", 0),
                    "failed": result.get("failed", 0),
                    "elapsed_time": result.get("elapsed_time", 0),
                    "details": result.get("details", []),
                },
            }
        ), 200

    except Exception as e:
        logger.exception(f"Error running Jiten Upgrader: {e}")
        return jsonify({"status": "error", "error": str(e)}), 500
