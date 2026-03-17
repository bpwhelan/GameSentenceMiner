"""
One-time Game Population Cron Job for GameSentenceMiner

This module provides a one-time cron job that auto-creates game records from game_lines.
This ensures the games table is populated before the daily rollup runs, so that
game_activity_data and games_played_ids can be properly populated in the rollup.

This job should run once and then mark itself as complete.

Usage:
    from GameSentenceMiner.util.cron.populate_games import populate_games_table

    # Run the one-time population
    result = populate_games_table()
    print(f"Created {result['created']} games, linked {result['linked']} lines")
"""

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.games_table import GamesTable


def populate_games_table():
    """
    Auto-create game records for any game_lines that don't have corresponding games,
    and link all orphaned game_lines to their game records.

    Delegates to :meth:`GamesTable.link_game_lines` which handles both creating
    missing game records and setting ``game_id`` on unlinked lines.

    Returns:
        Dictionary with execution summary:
        {
            'success': bool,
            'created': int,  # Number of new games created
            'linked_lines': int,  # Number of game_lines linked to games
            'errors': int,
            'error_message': str or None
        }
    """
    logger.info("Starting one-time game population from game_lines")

    try:
        result = GamesTable.link_game_lines()

        logger.info(f"Game population completed: created {result['created']} games, linked {result['linked']} lines")

        return {
            "success": True,
            "created": result["created"],
            "linked_lines": result["linked"],
            "errors": 0,
            "error_message": None,
        }

    except Exception as e:
        error_msg = str(e)
        logger.exception(f"Fatal error in populate_games_table: {error_msg}")

        return {
            "success": False,
            "created": 0,
            "linked_lines": 0,
            "errors": 1,
            "error_message": error_msg,
        }


# Example usage for testing
if __name__ == "__main__":
    # Run the one-time population
    result = populate_games_table()

    # Print summary
    print("\n" + "=" * 80)
    print("GAME POPULATION SUMMARY")
    print("=" * 80)
    print(f"Success: {'Yes' if result['success'] else 'No'}")
    print(f"Games created: {result['created']}")
    print(f"Lines linked: {result['linked_lines']}")
    print(f"Errors: {result['errors']}")
    if result["error_message"]:
        print(f"Error: {result['error_message']}")
    print("=" * 80)
