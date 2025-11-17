"""
Cron Job Runner for GameSentenceMiner

This script checks for due cron jobs and executes them.
Should be called periodically (e.g., every hour) by an external scheduler.

Usage:
    python -m GameSentenceMiner.util.cron.run_crons
"""

import asyncio
from typing import Optional
from GameSentenceMiner.util.cron_table import CronTable
from GameSentenceMiner.util.configuration import logger


class CronScheduler:
    """
    Async-based cron scheduler that checks for due cron jobs every 15 minutes.
    
    Usage:
        # In your main async function:
        scheduler = CronScheduler()
        await scheduler.start()
        
        # To stop the scheduler:
        await scheduler.stop()
    """

    def __init__(self, check_interval: int = 900):
        """
        Initialize the CronScheduler.
        
        Args:
            check_interval: Seconds between cron checks (default: 900)
        """
        self.check_interval = check_interval
        self._task: Optional[asyncio.Task] = None
        self._running = False
    
    async def start(self):
        """Start the cron scheduler in the background."""
        if self._running:
            logger.warning("CronScheduler is already running")
            return
        
        self._running = True
        self._task = asyncio.create_task(self._run_scheduler())
        logger.info(f"CronScheduler started with check interval of {self.check_interval}s")
    
    async def stop(self):
        """Stop the cron scheduler gracefully."""
        if not self._running:
            logger.warning("CronScheduler is not running")
            return
        
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("CronScheduler stopped")
    
    async def _run_scheduler(self):
        """Internal method that runs the scheduler loop."""
        logger.info("CronScheduler loop started")
        
        # Run immediately on startup
        try:
            logger.info("Running initial cron check on startup...")
            await asyncio.to_thread(run_due_crons)
        except Exception as e:
            logger.warning(f"Failed to check cron jobs on startup: {e}")
        
        # Then continue with periodic checks
        while self._running:
            try:
                await asyncio.sleep(self.check_interval)
                if self._running:  # Check again after sleep
                    await asyncio.to_thread(run_due_crons)
            except asyncio.CancelledError:
                logger.info("CronScheduler task cancelled")
                break
            except Exception as e:
                logger.error(f"Error in CronScheduler loop: {e}", exc_info=True)
                # Continue running even if there's an error
    
    def is_running(self) -> bool:
        """Check if the scheduler is currently running."""
        return self._running


def run_due_crons():
    """
    Check for and execute all due cron jobs.
    
    Returns:
        Dictionary with execution summary
    """
    due_crons = CronTable.get_due_crons()
    
    if not due_crons:
        return {
            'total_checked': 0,
            'executed': 0,
            'failed': 0,
            'details': []
        }
    
    logger.info(f"📋 Found {len(due_crons)} cron job(s) due to run")
    
    executed_count = 0
    failed_count = 0
    details = []
    
    for cron in due_crons:
        logger.info(f"Executing cron job: {cron.name}")
        logger.info(f"Description: {cron.description}")
        
        detail = {
            'name': cron.name,
            'description': cron.description,
            'success': False,
            'error': None
        }
        
        try:
            # Execute populate_games BEFORE daily_stats_rollup to ensure games table is populated
            if cron.name == 'populate_games':
                from GameSentenceMiner.util.cron.populate_games import populate_games_table
                result = populate_games_table()
                
                # Mark as successfully run (even if there were some errors, as long as it completed)
                CronTable.just_ran(cron.id)
                executed_count += 1
                detail['success'] = True
                detail['result'] = result
                
                logger.info(f"Successfully executed {cron.name}")
                logger.info(f"Created: {result['created']} games, Linked: {result['linked_lines']} lines, Errors: {result['errors']}")
                
            # Execute the appropriate function based on cron name
            elif cron.name == 'jiten_sync':
                from GameSentenceMiner.util.cron.jiten_update import update_all_jiten_games
                result = update_all_jiten_games()
                
                # Mark as successfully run
                CronTable.just_ran(cron.id)
                executed_count += 1
                detail['success'] = True
                detail['result'] = result
                
                logger.info(f"Successfully executed {cron.name}")
                logger.info(f"Updated: {result['updated_games']}/{result['linked_games']} games")
                
            elif cron.name == 'daily_stats_rollup':
                from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup
                result = run_daily_rollup()
                
                # Mark as successfully run
                CronTable.just_ran(cron.id)
                executed_count += 1
                detail['success'] = True
                detail['result'] = result
                
                logger.info(f"Successfully executed {cron.name}")
                logger.info(f"Processed: {result['processed']} dates, Overwritten: {result['overwritten']}, Errors: {result['errors']}")
                
            else:
                logger.error(f"⚠️ Unknown cron job: {cron.name}")
                detail['error'] = f"Unknown cron job: {cron.name}"
                failed_count += 1
                
        except Exception as e:
            logger.error(f"Failed to execute {cron.name}: {e}", exc_info=True)
            detail['error'] = str(e)
            failed_count += 1
        
        details.append(detail)
    logger.info("Cron job check completed")
    logger.info(f"Total checked: {len(due_crons)}")
    logger.info(f"Successfully executed: {executed_count}")
    logger.info(f"Failed: {failed_count}")

    return {
        'total_checked': len(due_crons),
        'executed': executed_count,
        'failed': failed_count,
        'details': details
    }


# for me to manually check
if __name__ == '__main__':
    # Run the cron checker
    result = run_due_crons()
    
    # Print summary
    print("\n" + "=" * 80)
    print("CRON EXECUTION SUMMARY")
    print("=" * 80)
    print(f"Total cron jobs checked: {result['total_checked']}")
    print(f"Successfully executed: {result['executed']}")
    print(f"Failed: {result['failed']}")
    print("=" * 80)
    
    # Print details
    if result['details']:
        print("\nDETAILS:")
        print("-" * 80)
        for detail in result['details']:
            status = "✅" if detail['success'] else "❌"
            print(f"{status} {detail['name']}: {detail['description']}")
            if detail.get('error'):
                print(f"   Error: {detail['error']}")
            elif detail.get('result'):
                res = detail['result']
                if 'updated_games' in res:
                    print(f"   Updated {res['updated_games']}/{res['linked_games']} games")
                elif 'processed' in res:
                    print(f"   Processed {res['processed']} dates, Overwritten {res['overwritten']}, Errors {res['errors']}")
        print("-" * 80)