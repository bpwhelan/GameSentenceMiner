"""
Setup script to register the jiten_upgrader cron job.

This script:
1. Checks if jiten_upgrader cron already exists
2. If not, creates it with a weekly schedule (Sunday 3:00 AM)
3. Optionally runs it immediately if requested

The Jiten Upgrader checks games with VNDB/AniList IDs to see if Jiten.moe 
now has entries for them, and auto-links if found.

Usage:
    python -m GameSentenceMiner.util.cron.jiten_upgrader_cron
    
    # To run immediately after setup:
    python -m GameSentenceMiner.util.cron.jiten_upgrader_cron --run-now
"""

import sys
from GameSentenceMiner.util.database.cron_table import CronTable
from datetime import datetime, timedelta

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.cron.jiten_upgrader import upgrade_games_to_jiten


def calculate_next_sunday_3am() -> float:
    """
    Calculate the timestamp for next Sunday at 3:00 AM local time.
    
    Returns:
        Unix timestamp for the next scheduled run
    """
    now = datetime.now()
    
    # Calculate days until Sunday (Sunday is weekday 6)
    days_until_sunday = (6 - now.weekday()) % 7
    
    # If today is Sunday and it's after 3 AM, schedule for next week
    if days_until_sunday == 0 and now.hour >= 3:
        days_until_sunday = 7
    
    # Create datetime for next Sunday at 3:00 AM
    next_sunday = now.replace(hour=3, minute=0, second=0, microsecond=0) + timedelta(days=days_until_sunday)
    
    return next_sunday.timestamp()


def setup_jiten_upgrader_cron(run_now: bool = False):
    """
    Setup the jiten_upgrader cron job with weekly schedule.
    
    Args:
        run_now: If True, run the upgrader immediately after setup
    
    Returns:
        Dictionary with setup results
    """
    logger.info("=" * 80)
    logger.info("JITEN UPGRADER CRON SETUP")
    logger.info("=" * 80)
    
    # Check if cron already exists
    existing_cron = CronTable.get_by_name('jiten_upgrader')
    
    if existing_cron:
        logger.info(f"jiten_upgrader cron already exists (id={existing_cron.id})")
        logger.info(f"  Enabled: {existing_cron.enabled}")
        logger.info(f"  Schedule: {existing_cron.schedule}")
        
        if existing_cron.next_run:
            next_run_dt = datetime.fromtimestamp(existing_cron.next_run)
            logger.info(f"  Next run: {next_run_dt.strftime('%Y-%m-%d %H:%M:%S')}")
        
        cron_id = existing_cron.id
        setup_status = 'already_exists'
    else:
        # Create new cron entry with weekly schedule
        logger.info("Creating new jiten_upgrader cron entry...")
        
        next_run = calculate_next_sunday_3am()
        next_run_dt = datetime.fromtimestamp(next_run)
        
        try:
            new_cron = CronTable.create_cron_entry(
                name='jiten_upgrader',
                description='Weekly check for games with VNDB/AniList IDs to auto-link to Jiten.moe',
                next_run=next_run,
                schedule='weekly',  # Weekly schedule
                enabled=True
            )
            cron_id = new_cron.id
            setup_status = 'created'
            
            logger.info(f"Created jiten_upgrader cron (id={new_cron.id})")
            logger.info(f"  Schedule: weekly (every Sunday at 3:00 AM)")
            logger.info(f"  First run: {next_run_dt.strftime('%Y-%m-%d %H:%M:%S')}")
            
        except Exception as e:
            logger.error(f"Failed to create cron entry: {e}")
            return {
                'setup': 'failed',
                'error': str(e)
            }
    
    # Optionally run immediately
    if run_now:
        logger.info("")
        logger.info("Running jiten_upgrader now...")
        logger.info("")
        
        try:
            result = upgrade_games_to_jiten()
            
            # Mark as run after successful execution
            if setup_status != 'already_exists' or existing_cron.enabled:
                CronTable.just_ran(cron_id)
            
            logger.info("=" * 80)
            logger.info("JITEN UPGRADER COMPLETED")
            logger.info("=" * 80)
            logger.info(f"Total checked: {result.get('total_checked', 0)}")
            logger.info(f"Upgraded to Jiten: {result.get('upgraded_to_jiten', 0)}")
            logger.info(f"Already on Jiten: {result.get('already_on_jiten', 0)}")
            logger.info(f"Not found on Jiten: {result.get('not_found_on_jiten', 0)}")
            logger.info(f"Failed: {result.get('failed', 0)}")
            logger.info("=" * 80)
            
            return {
                'setup': setup_status,
                'cron_id': cron_id,
                'ran_immediately': True,
                'execution_result': result
            }
            
        except Exception as e:
            logger.exception(f"Failed to execute jiten_upgrader: {e}")
            return {
                'setup': setup_status,
                'cron_id': cron_id,
                'ran_immediately': False,
                'error': str(e)
            }
    
    return {
        'setup': setup_status,
        'cron_id': cron_id,
        'ran_immediately': False
    }


if __name__ == '__main__':
    # Check for --run-now flag
    run_now = '--run-now' in sys.argv
    
    result = setup_jiten_upgrader_cron(run_now=run_now)
    
    print("\n" + "=" * 80)
    print("SETUP RESULT")
    print("=" * 80)
    print(f"Setup status: {result.get('setup')}")
    
    if 'cron_id' in result:
        print(f"Cron ID: {result['cron_id']}")
    
    if result.get('ran_immediately'):
        exec_result = result.get('execution_result', {})
        print(f"\nExecution Results:")
        print(f"  Total checked: {exec_result.get('total_checked', 0)}")
        print(f"  Upgraded to Jiten: {exec_result.get('upgraded_to_jiten', 0)}")
        print(f"  Already on Jiten: {exec_result.get('already_on_jiten', 0)}")
        print(f"  Not found on Jiten: {exec_result.get('not_found_on_jiten', 0)}")
        print(f"  Failed: {exec_result.get('failed', 0)}")
    
    if 'error' in result:
        print(f"Error: {result['error']}")
    
    print("=" * 80)
