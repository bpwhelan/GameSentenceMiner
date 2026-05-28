"""
Cron Job Runner for GameSentenceMiner

This script checks for due cron jobs and executes them.
Should be called periodically (e.g., every hour) by an external scheduler.

Usage:
    python -m GameSentenceMiner.util.cron.run_crons
"""

import enum
import queue
import threading
import time
from dataclasses import dataclass
from typing import Optional

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.cron_table import CronTable


MAX_QUEUE_WAIT_SECONDS = 0.5


class Crons(enum.Enum):
    POPULATE_GAMES = "populate_games"
    JITEN_SYNC = "jiten_sync"
    DAILY_STATS_ROLLUP = "daily_stats_rollup"
    USER_PLUGINS = "user_plugins"
    JITEN_UPGRADER = "jiten_upgrader"
    DAILY_GOALS_COMPLETION = "daily_goals_completion"
    TOKENIZE_BACKFILL = "tokenize_backfill"
    ANKI_WORD_SYNC = "anki_word_sync"
    ANKI_CARD_SYNC = "anki_card_sync"


@dataclass
class MockCron:
    """Helper to mimic the ORM object for forced runs"""

    id: int
    name: str
    description: str


class CronScheduler:
    """
    Thread-based cron scheduler that checks for due cron jobs every 15 minutes.
    It uses a Queue to allow immediate execution of forced tasks.
    """

    def __init__(self, check_interval: int = 900):
        self.check_interval = check_interval
        self._thread: Optional[threading.Thread] = None
        self._running = False

        self._lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._stop_event = threading.Event()

        self._queue: queue.Queue[Crons] = queue.Queue()

    def add_external_task(self, task: Crons):
        """
        Add an external cron task to be executed IMMEDIATELY.
        Thread-safe: Can be called from UI threads.
        """
        if not self.is_running():
            logger.warning("CronScheduler is not running, task queued but won't run until start()")
        self._queue.put(task)

    def force_daily_rollup(self):
        self.add_external_task(Crons.DAILY_STATS_ROLLUP)

    def force_jiten_sync(self):
        self.add_external_task(Crons.JITEN_SYNC)

    def force_populate_games(self):
        self.add_external_task(Crons.POPULATE_GAMES)

    def force_jiten_upgrader(self):
        self.add_external_task(Crons.JITEN_UPGRADER)

    def force_daily_goals_completion(self):
        self.add_external_task(Crons.DAILY_GOALS_COMPLETION)

    def force_tokenize_backfill(self):
        self.add_external_task(Crons.TOKENIZE_BACKFILL)

    def force_anki_word_sync(self):
        self.add_external_task(Crons.ANKI_WORD_SYNC)

    def force_anki_card_sync(self):
        self.add_external_task(Crons.ANKI_CARD_SYNC)

    def start(self):
        """Start the cron scheduler in the background."""
        with self._state_lock:
            if self._thread and self._thread.is_alive():
                logger.warning("CronScheduler is already running")
                return

            self._running = True
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run_scheduler,
                name="gsm-cron-scheduler",
                daemon=True,
            )
            self._thread.start()

        logger.debug(f"CronScheduler started with check interval of {self.check_interval}s")

    def stop(self, timeout: float = 2.0):
        """Stop the cron scheduler gracefully."""
        with self._state_lock:
            thread = self._thread
            if not self._running and not (thread and thread.is_alive()):
                return

            self._running = False
            self._stop_event.set()

        if thread and thread.is_alive() and threading.current_thread() is not thread:
            thread.join(timeout=timeout)

        with self._state_lock:
            if self._thread is thread and thread and not thread.is_alive():
                self._thread = None

        if thread and thread.is_alive():
            logger.warning("CronScheduler stop requested, but the scheduler thread is still running")
        else:
            logger.info("CronScheduler stopped")

    def _run_scheduler(self):
        """
        The main loop.
        It waits for 'check_interval' seconds OR for a forced task in the queue.
        """
        logger.debug("CronScheduler thread started")

        try:
            try:
                if not self._stop_event.is_set():
                    logger.background("Running initial scheduled task check on startup...")
                    self._execute_safe(None)
            except Exception as e:
                logger.warning(f"Failed to check scheduled tasks on startup: {e}")

            next_check_time = time.monotonic() + self.check_interval

            while not self._stop_event.is_set():
                got_queue_item = False
                forced_task: Optional[Crons] = None
                seconds_until_check = max(0.0, next_check_time - time.monotonic())
                queue_wait_seconds = min(MAX_QUEUE_WAIT_SECONDS, seconds_until_check)

                try:
                    forced_task = self._queue.get(timeout=queue_wait_seconds)
                    got_queue_item = True

                    logger.info(f"Received forced trigger for: {forced_task}")
                    self._execute_safe(forced_task)
                    next_check_time = time.monotonic() + self.check_interval
                except queue.Empty:
                    if not self._stop_event.is_set() and time.monotonic() >= next_check_time:
                        self._execute_safe(None)
                        next_check_time = time.monotonic() + self.check_interval
                except Exception as e:
                    logger.exception(f"Error in CronScheduler loop: {e}")
                    self._stop_event.wait(60)  # Backoff on error, but wake promptly on stop.
                    next_check_time = time.monotonic() + self.check_interval
                finally:
                    if got_queue_item:
                        self._queue.task_done()
        finally:
            with self._state_lock:
                self._running = False
            logger.debug("CronScheduler thread exited")

    def _execute_safe(self, force_task: Optional[Crons]):
        """Helper to acquire lock and run logic"""
        acquired = self._lock.acquire(blocking=False)
        if not acquired:
            logger.background("Cron task is already running, skipping/queuing...")
            return

        try:
            run_due_crons(force_task)
        finally:
            self._lock.release()

    def is_running(self) -> bool:
        with self._state_lock:
            return self._running


def run_due_crons(force_task: Optional["Crons"] = None) -> dict:
    """
    Check for and execute all due cron jobs.
    """

    if force_task:
        logger.info(f"⚡ Forcing execution of scheduled task: {force_task.value}")
        # Create a Mock object that mimics the ORM object so dot-notation works
        fake_cron = MockCron(
            id=-1,  # -1 ID for manual runs
            name=force_task.value,
            description=f"Forced execution of {force_task.value}",
        )
        due_crons = [fake_cron]
    else:
        due_crons = CronTable.get_due_crons()

    if not due_crons:
        return {"total_checked": 0, "executed": 0, "failed": 0, "details": []}

    logger.background(f"📋 Found {len(due_crons)} scheduled task(s) due to run")

    executed_count = 0
    failed_count = 0
    details = []

    for cron in due_crons:
        logger.background(f"Executing scheduled task: {cron.name}")

        detail = {
            "name": cron.name,
            "description": cron.description,
            "success": False,
            "error": None,
        }

        try:
            # Execute populate_games
            if cron.name == Crons.POPULATE_GAMES.value:
                from GameSentenceMiner.util.cron.populate_games import (
                    populate_games_table,
                )

                result = populate_games_table()

                if cron.id != -1:
                    CronTable.just_ran(cron.id)
                executed_count += 1
                detail["success"] = True
                detail["result"] = result

                logger.background(f"Successfully executed {cron.name}")
                logger.background(
                    f"Created: {result.get('created', 0)} games, Linked: {result.get('linked_lines', 0)} lines"
                )

            # Execute Jiten Sync
            elif cron.name == Crons.JITEN_SYNC.value:
                from GameSentenceMiner.util.cron.jiten_update import (
                    update_all_jiten_games,
                )

                result = update_all_jiten_games()

                if cron.id != -1:
                    CronTable.just_ran(cron.id)
                executed_count += 1
                detail["success"] = True
                detail["result"] = result

                logger.background(f"Successfully executed {cron.name}")

            # Execute Daily Rollup
            elif cron.name == Crons.DAILY_STATS_ROLLUP.value:
                from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup

                result = run_daily_rollup()

                if cron.id != -1:
                    CronTable.just_ran(cron.id)
                executed_count += 1
                detail["success"] = True
                detail["result"] = result

                logger.background(f"Successfully executed {cron.name}")

            elif cron.name == Crons.USER_PLUGINS.value:
                from GameSentenceMiner.util.cron.user_plugins import (
                    execute_user_plugins,
                )

                result = execute_user_plugins()

                # Mark as successfully run (even if plugins had errors, the system ran)
                CronTable.just_ran(cron.id)
                executed_count += 1
                detail["success"] = result.get("executed", False)
                detail["result"] = result

                if result.get("error"):
                    logger.warning(f"User plugins completed with warning: {result['error']}")
                else:
                    logger.background(f"Successfully executed {cron.name}")

            # Execute Jiten Upgrader (weekly check for new Jiten entries)
            elif cron.name == Crons.JITEN_UPGRADER.value:
                from GameSentenceMiner.util.cron.jiten_upgrader import (
                    upgrade_games_to_jiten,
                )

                result = upgrade_games_to_jiten()

                if cron.id != -1:
                    CronTable.just_ran(cron.id)
                executed_count += 1
                detail["success"] = True
                detail["result"] = result

                logger.background(f"Successfully executed {cron.name}")
                logger.background(
                    f"Upgraded: {result.get('upgraded_to_jiten', 0)} games, Not found: {result.get('not_found_on_jiten', 0)}"
                )

            # Execute Daily Goals Completion (hourly check for auto-completing daily goals)
            elif cron.name == Crons.DAILY_GOALS_COMPLETION.value:
                from GameSentenceMiner.util.cron.daily_goals_completion import (
                    run_daily_goals_completion,
                )

                result = run_daily_goals_completion()

                if cron.id != -1:
                    CronTable.just_ran(cron.id)
                executed_count += 1
                detail["success"] = result.get("success", False)
                detail["result"] = result

                if result.get("action") == "completed":
                    logger.background(f"✅ Daily goals auto-completed! Streak: {result.get('streak', 0)}")
                else:
                    logger.background(f"Executed {cron.name}: {result.get('action', 'unknown')}")

            # Execute Tokenize Backfill (weekly tokenization of game lines)
            elif cron.name == Crons.TOKENIZE_BACKFILL.value:
                from GameSentenceMiner.util.cron.tokenize_lines import (
                    run_tokenize_backfill,
                )

                result = run_tokenize_backfill()

                if cron.id != -1:
                    CronTable.just_ran(cron.id)
                executed_count += 1
                detail["success"] = not result.get("skipped", False)
                detail["result"] = result

                if result.get("skipped"):
                    logger.background(f"Skipped {cron.name}: {result.get('reason', 'unknown')}")
                else:
                    logger.background(
                        f"Successfully executed {cron.name}: {result.get('processed', 0)} lines processed"
                    )

            # Deprecated: anki_word_sync replaced by anki_card_sync
            elif cron.name == Crons.ANKI_WORD_SYNC.value:
                logger.warning("anki_word_sync is deprecated — use anki_card_sync instead. Skipping.")
                result = {"skipped": True, "reason": "deprecated — use anki_card_sync"}

                if cron.id != -1:
                    CronTable.just_ran(cron.id)
                executed_count += 1
                detail["success"] = True
                detail["result"] = result

            # Execute Anki Card Sync (daily full sync of Anki notes, cards, reviews)
            elif cron.name == Crons.ANKI_CARD_SYNC.value:
                from GameSentenceMiner.util.cron.anki_card_sync import (
                    run_full_sync,
                )

                result = run_full_sync()

                if cron.id != -1:
                    CronTable.just_ran(cron.id)
                executed_count += 1
                detail["success"] = not result.get("skipped", False)
                detail["result"] = result

                if result.get("skipped"):
                    logger.background(f"Skipped {cron.name}: {result.get('reason', 'unknown')}")
                else:
                    logger.background(
                        f"Successfully executed {cron.name}: "
                        f"notes={result.get('notes', 0)}, cards={result.get('cards', 0)}, "
                        f"reviews={result.get('reviews', 0)}"
                    )

            else:
                logger.error(f"⚠️ Unknown scheduled task: {cron.name}")
                detail["error"] = f"Unknown scheduled task: {cron.name}"
                failed_count += 1

        except Exception as e:
            logger.exception(f"Failed to execute {cron.name}: {e}")
            detail["error"] = str(e)
            failed_count += 1

        details.append(detail)

    logger.background("Scheduled task check completed")

    return {
        "total_checked": len(due_crons),
        "executed": executed_count,
        "failed": failed_count,
        "details": details,
    }


# Global instance
cron_scheduler = CronScheduler()


# for me to manually check
if __name__ == "__main__":
    try:
        # Start the scheduler
        cron_scheduler.start()

        # Simulate a manual trigger
        print("Waiting 2 seconds then forcing task...")
        time.sleep(2)
        cron_scheduler.force_populate_games()

        # Keep alive briefly to let it run
        time.sleep(5)
    except KeyboardInterrupt:
        pass
    finally:
        cron_scheduler.stop()
