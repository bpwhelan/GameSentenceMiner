"""
Cron Job Runner for GameSentenceMiner

This script checks for due cron jobs and executes them.
Should be called periodically (e.g., every hour) by an external scheduler.

Usage:
    python -m GameSentenceMiner.util.cron.run_crons
"""

import asyncio
import enum
import time
from dataclasses import dataclass
from typing import Optional, List, Any

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.cron_table import CronTable


class Crons(enum.Enum):
    POPULATE_GAMES = 'populate_games'
    JITEN_SYNC = 'jiten_sync'
    DAILY_STATS_ROLLUP = 'daily_stats_rollup'
    USER_PLUGINS = "user_plugins"
    JITEN_UPGRADER = 'jiten_upgrader'

@dataclass
class MockCron:
    """Helper to mimic the ORM object for forced runs"""
    id: int
    name: str
    description: str

class CronScheduler:
    """
    Async-based cron scheduler that checks for due cron jobs every 15 minutes.
    It uses an Event Queue to allow immediate execution of forced tasks.
    """

    def __init__(self, check_interval: int = 900):
        self.check_interval = check_interval
        self._task: Optional[asyncio.Task] = None
        self._running = False
        
        self._lock = asyncio.Lock()
        
        self._queue = None
        self.loop = None

    def _ensure_init(self):
        """Lazy initialization of loop-dependent objects"""
        if self._queue is None:
            self._queue = asyncio.Queue()
        if self.loop is None:
            try:
                self.loop = asyncio.get_running_loop()
            except RuntimeError:
                self.loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self.loop)

    def add_external_task(self, task: Crons):
        """
        Add an external cron task to be executed IMMEDIATELY.
        Thread-safe: Can be called from UI threads.
        """
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(self._queue.put_nowait, task)
        else:
            logger.warning("CronScheduler loop is not running, task queued but won't run until start()")
            self._queue.put_nowait(task)
        
    def force_daily_rollup(self):
        self.add_external_task(Crons.DAILY_STATS_ROLLUP)
        
    def force_jiten_sync(self):
        self.add_external_task(Crons.JITEN_SYNC)
    
    def force_populate_games(self):
        self.add_external_task(Crons.POPULATE_GAMES)
    
    def force_jiten_upgrader(self):
        self.add_external_task(Crons.JITEN_UPGRADER)
    
    async def start(self):
        """Start the cron scheduler in the background."""
        if self._running:
            logger.warning("CronScheduler is already running")
            return
        
        self._ensure_init()
        self._running = True
        self._task = asyncio.create_task(self._run_scheduler())
        logger.debug(f"CronScheduler started with check interval of {self.check_interval}s")
    
    async def stop(self):
        """Stop the cron scheduler gracefully."""
        if not self._running:
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
        """
        The main loop. 
        It waits for 'check_interval' seconds OR for a forced task in the queue.
        """
        logger.debug("CronScheduler loop started")
        
        try:
            logger.background("Running initial scheduled task check on startup...")
            await self._execute_safe(None)
        except Exception as e:
            logger.warning(f"Failed to check scheduled tasks on startup: {e}")
        
        while self._running:
            try:
                forced_task = await asyncio.wait_for(self._queue.get(), timeout=self.check_interval)
                
                logger.info(f"Received forced trigger for: {forced_task}")
                await self._execute_safe(forced_task)
                
            except asyncio.TimeoutError:
                if self._running:
                    await self._execute_safe(None)
                    
            except asyncio.CancelledError:
                logger.info("CronScheduler task cancelled")
                break
            except Exception as e:
                logger.exception(f"Error in CronScheduler loop: {e}")
                await asyncio.sleep(60) # Backoff on error

    async def _execute_safe(self, force_task: Optional[Crons]):
        """Helper to acquire lock and run logic"""
        if self._lock.locked():
            logger.background("Cron task is already running, skipping/queuing...")
            return

        async with self._lock:
            await run_due_crons(force_task)

    def is_running(self) -> bool:
        return self._running
    

async def run_due_crons(force_task: Optional['Crons'] = None) -> dict:
    """
    Check for and execute all due cron jobs.
    """
    
    if force_task:
        logger.info(f"⚡ Forcing execution of scheduled task: {force_task.value}")
        # Create a Mock object that mimics the ORM object so dot-notation works
        fake_cron = MockCron(
            id=-1, # -1 ID for manual runs
            name=force_task.value,
            description=f"Forced execution of {force_task.value}"
        )
        due_crons = [fake_cron]
    else:
        due_crons = CronTable.get_due_crons()
        
    if not due_crons:
        return {
            'total_checked': 0,
            'executed': 0,
            'failed': 0,
            'details': []
        }
    
    logger.background(f"📋 Found {len(due_crons)} scheduled task(s) due to run")
    
    executed_count = 0
    failed_count = 0
    details = []
    
    for cron in due_crons:
        logger.background(f"Executing scheduled task: {cron.name}")
        
        detail = {
            'name': cron.name,
            'description': cron.description,
            'success': False,
            'error': None
        }
        
        try:
            # Execute populate_games
            if cron.name == Crons.POPULATE_GAMES.value:
                from GameSentenceMiner.util.cron.populate_games import populate_games_table
                result = populate_games_table()
                
                if cron.id != -1: CronTable.just_ran(cron.id)
                executed_count += 1
                detail['success'] = True
                detail['result'] = result
                
                logger.background(f"Successfully executed {cron.name}")
                logger.background(f"Created: {result.get('created',0)} games, Linked: {result.get('linked_lines',0)} lines")
                
            # Execute Jiten Sync
            elif cron.name == Crons.JITEN_SYNC.value:
                from GameSentenceMiner.util.cron.jiten_update import update_all_jiten_games
                result = update_all_jiten_games()
                
                if cron.id != -1: CronTable.just_ran(cron.id)
                executed_count += 1
                detail['success'] = True
                detail['result'] = result
                
                logger.background(f"Successfully executed {cron.name}")
                
            # Execute Daily Rollup
            elif cron.name == Crons.DAILY_STATS_ROLLUP.value:
                from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup
                result = run_daily_rollup()
                
                if cron.id != -1: CronTable.just_ran(cron.id)
                executed_count += 1
                detail['success'] = True
                detail['result'] = result
                
                logger.background(f"Successfully executed {cron.name}")
                
            elif cron.name == Crons.USER_PLUGINS.value:
                from GameSentenceMiner.util.cron.user_plugins import execute_user_plugins
                result = execute_user_plugins()
                
                # Mark as successfully run (even if plugins had errors, the system ran)
                CronTable.just_ran(cron.id)
                executed_count += 1
                detail['success'] = result.get('executed', False)
                detail['result'] = result
                
                if result.get('error'):
                    logger.warning(f"User plugins completed with warning: {result['error']}")
                else:
                    logger.background(f"Successfully executed {cron.name}")
            
            # Execute Jiten Upgrader (weekly check for new Jiten entries)
            elif cron.name == Crons.JITEN_UPGRADER.value:
                from GameSentenceMiner.util.cron.jiten_upgrader import upgrade_games_to_jiten
                result = upgrade_games_to_jiten()
                
                if cron.id != -1: CronTable.just_ran(cron.id)
                executed_count += 1
                detail['success'] = True
                detail['result'] = result
                
                logger.background(f"Successfully executed {cron.name}")
                logger.background(f"Upgraded: {result.get('upgraded_to_jiten', 0)} games, Not found: {result.get('not_found_on_jiten', 0)}")
                
            else:
                logger.error(f"⚠️ Unknown scheduled task: {cron.name}")
                detail['error'] = f"Unknown scheduled task: {cron.name}"
                failed_count += 1
                
        except Exception as e:
            logger.exception(f"Failed to execute {cron.name}: {e}")
            detail['error'] = str(e)
            failed_count += 1
        
        details.append(detail)
        
    logger.background("Scheduled task check completed")

    return {
        'total_checked': len(due_crons),
        'executed': executed_count,
        'failed': failed_count,
        'details': details
    }


# Global instance
cron_scheduler = CronScheduler()


# for me to manually check
if __name__ == '__main__':
    async def main():
        # Start the scheduler
        await cron_scheduler.start()
        
        # Simulate a manual trigger
        print("Waiting 2 seconds then forcing task...")
        await asyncio.sleep(2)
        cron_scheduler.force_populate_games()
        
        # Keep alive briefly to let it run
        await asyncio.sleep(5)
        await cron_scheduler.stop()

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass