"""
Setup script to register and run the populate_games cron job once.

This script:
1. Checks if populate_games cron already exists
2. If not, creates it with schedule='once'
3. Runs it immediately to populate the games table
4. The cron will auto-disable after running (schedule='once' behavior)

Usage:
    python -m GameSentenceMiner.util.cron.setup_populate_games_cron
"""

import time
from GameSentenceMiner.util.cron_table import CronTable
from GameSentenceMiner.util.cron.populate_games import populate_games_table
from GameSentenceMiner.util.configuration import logger


def setup_and_run_populate_games():
    """
    Setup and run the populate_games cron job once.
    
    Returns:
        Dictionary with setup and execution results
    """
    logger.info("=" * 80)
    logger.info("POPULATE GAMES CRON SETUP")
    logger.info("=" * 80)
    
    # Check if cron already exists
    existing_cron = CronTable.get_by_name('populate_games')
    
    if existing_cron:
        if existing_cron.enabled:
            logger.info(f"populate_games cron already exists and is enabled (id={existing_cron.id})")
            logger.info("Running it now...")
        else:
            logger.info(f"populate_games cron already exists but is disabled (id={existing_cron.id})")
            logger.info("This means it has already run once. Skipping...")
            return {
                'setup': 'skipped',
                'reason': 'Cron already ran (disabled)',
                'cron_id': existing_cron.id
            }
    else:
        # Create new cron entry with schedule='once'
        logger.info("Creating new populate_games cron entry...")
        try:
            new_cron = CronTable.create_cron_entry(
                name='populate_games',
                description='One-time auto-creation of game records from game_lines',
                next_run=time.time(),  # Run immediately
                schedule='once',  # Will auto-disable after running
                enabled=True
            )
            logger.info(f"Created populate_games cron (id={new_cron.id})")
            existing_cron = new_cron
        except Exception as e:
            logger.error(f"Failed to create cron entry: {e}")
            return {
                'setup': 'failed',
                'error': str(e)
            }
    
    # Run the populate_games function
    logger.info("Executing populate_games_table()...")
    try:
        result = populate_games_table()
        
        # Mark the cron as having run (will auto-disable since schedule='once')
        CronTable.just_ran(existing_cron.id)
        
        logger.info("=" * 80)
        logger.info("POPULATE GAMES COMPLETED")
        logger.info("=" * 80)
        logger.info(f"Success: {result['success']}")
        logger.info(f"Games created: {result['created']}")
        logger.info(f"Lines linked: {result['linked_lines']}")
        logger.info(f"Errors: {result['errors']}")
        if result['error_message']:
            logger.error(f"Error: {result['error_message']}")
        logger.info("=" * 80)
        
        return {
            'setup': 'success',
            'cron_id': existing_cron.id,
            'execution_result': result
        }
        
    except Exception as e:
        logger.error(f"Failed to execute populate_games: {e}", exc_info=True)
        return {
            'setup': 'execution_failed',
            'cron_id': existing_cron.id,
            'error': str(e)
        }


if __name__ == '__main__':
    result = setup_and_run_populate_games()
    
    print("\n" + "=" * 80)
    print("SETUP RESULT")
    print("=" * 80)
    print(f"Setup status: {result.get('setup')}")
    if 'cron_id' in result:
        print(f"Cron ID: {result['cron_id']}")
    if 'execution_result' in result:
        exec_result = result['execution_result']
        print(f"Games created: {exec_result.get('created', 0)}")
        print(f"Lines linked: {exec_result.get('linked_lines', 0)}")
        print(f"Errors: {exec_result.get('errors', 0)}")
    if 'error' in result:
        print(f"Error: {result['error']}")
    if 'reason' in result:
        print(f"Reason: {result['reason']}")
    print("=" * 80)