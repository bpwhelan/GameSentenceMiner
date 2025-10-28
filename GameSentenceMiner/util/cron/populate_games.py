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
    print(f"Created {result['created']} games, linked {result['linked_lines']} lines")
"""

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.configuration import logger


def populate_games_table():
    """
    Auto-create game records for any game_lines that don't have corresponding games.
    This is a one-time operation that ensures the games table is populated.
    
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
    
    created_count = 0
    linked_lines_count = 0
    errors = 0
    
    try:
        # Get all distinct game names from game_lines
        game_names_from_lines = GameLinesTable._db.fetchall(
            f"SELECT DISTINCT game_name FROM {GameLinesTable._table} "
            f"WHERE game_name IS NOT NULL AND game_name != ''"
        )
        
        if not game_names_from_lines:
            logger.info("No game names found in game_lines table")
            return {
                'success': True,
                'created': 0,
                'linked_lines': 0,
                'errors': 0,
                'error_message': None
            }
        
        logger.info(f"Found {len(game_names_from_lines)} distinct game names in game_lines")
        
        # Get existing game titles to avoid duplicates
        existing_games_rows = GamesTable._db.fetchall(
            f"SELECT title_original FROM {GamesTable._table}"
        )
        existing_titles = {row[0] for row in existing_games_rows}
        
        logger.info(f"Found {len(existing_titles)} existing games in games table")
        
        # Auto-create games for game_lines that don't have corresponding games
        for row in game_names_from_lines:
            game_name = row[0]
            
            # Skip if game already exists
            if game_name in existing_titles:
                logger.debug(f"Game '{game_name}' already exists, skipping")
                continue
            
            try:
                # Use get_or_create_by_name which checks for existing mappings
                # and reuses them instead of creating duplicates
                game = GamesTable.get_or_create_by_name(game_name)
                
                # Link any orphaned game_lines to this game
                GameLinesTable._db.execute(
                    f"UPDATE {GameLinesTable._table} SET game_id = ? "
                    f"WHERE game_name = ? AND (game_id IS NULL OR game_id = '')",
                    (game.id, game_name),
                    commit=True,
                )
                
                # Count how many lines were linked
                linked_count = GameLinesTable._db.fetchone(
                    f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE game_id = ?",
                    (game.id,),
                )
                lines_linked = linked_count[0] if linked_count else 0
                
                logger.info(
                    f"Created game '{game_name}' (id={game.id}) and linked {lines_linked} lines"
                )
                
                created_count += 1
                linked_lines_count += lines_linked
                existing_titles.add(game_name)
                
            except Exception as e:
                logger.error(f"Error creating game for '{game_name}': {e}", exc_info=True)
                errors += 1
                continue
        
        logger.info(
            f"Game population completed: created {created_count} games, "
            f"linked {linked_lines_count} lines, {errors} errors"
        )
        
        return {
            'success': True,
            'created': created_count,
            'linked_lines': linked_lines_count,
            'errors': errors,
            'error_message': None
        }
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Fatal error in populate_games_table: {error_msg}", exc_info=True)
        
        return {
            'success': False,
            'created': created_count,
            'linked_lines': linked_lines_count,
            'errors': errors + 1,
            'error_message': error_msg
        }


# Example usage for testing
if __name__ == '__main__':
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
    if result['error_message']:
        print(f"Error: {result['error_message']}")
    print("=" * 80)