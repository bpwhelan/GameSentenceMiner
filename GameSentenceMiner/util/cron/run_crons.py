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
from dataclasses import dataclass, field
from typing import Callable, Optional

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.cron_table import CronTable


MAX_QUEUE_WAIT_SECONDS = 0.5
# A single task running longer than this is almost certainly stuck. We can't kill the
# thread, but we log a warning (and keep re-warning) so it shows up in users' logs. The
# recurring culprit is a user plugin with a blocking/looping main().
SLOW_TASK_WARN_SECONDS = 60.0


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


# --------------------------------------------------------------------------- #
# Task registry                                                               #
# --------------------------------------------------------------------------- #
# Each cron task is declared once here instead of a giant if/elif chain. The
# runner does the (lazy) import + call and returns the task's result dict; the
# optional callbacks derive success/log lines from that result.


# Lower priority runs first when several tasks are due in the same batch. Plugins go
# first (users expect their own code to win), then the daily stats rollup; everything
# else runs at the default priority afterwards in registry order.
PRIORITY_HIGH = 0
PRIORITY_ROLLUP = 10
PRIORITY_DEFAULT = 100
PRIORITY_LOW = 1000


@dataclass(frozen=True)
class _TaskDef:
    runner: Callable[[], dict]
    success: Callable[[dict], bool] = field(default=lambda result: True)
    summary: Callable[[dict], str] = field(default=lambda result: "")
    warn: Callable[[dict], Optional[str]] = field(default=lambda result: None)
    priority: int = PRIORITY_DEFAULT


def _run_populate_games() -> dict:
    from GameSentenceMiner.util.cron.populate_games import populate_games_table

    return populate_games_table()


def _run_jiten_sync() -> dict:
    from GameSentenceMiner.util.cron.jiten_update import update_all_jiten_games

    return update_all_jiten_games()


def _run_daily_rollup() -> dict:
    from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup

    return run_daily_rollup()


def _run_user_plugins() -> dict:
    from GameSentenceMiner.util.cron.user_plugins import execute_user_plugins

    return execute_user_plugins()


def _run_jiten_upgrader() -> dict:
    from GameSentenceMiner.util.cron.jiten_upgrader import upgrade_games_to_jiten

    return upgrade_games_to_jiten()


def _run_daily_goals_completion() -> dict:
    from GameSentenceMiner.util.cron.daily_goals_completion import run_daily_goals_completion

    return run_daily_goals_completion()


def _run_tokenize_backfill() -> dict:
    from GameSentenceMiner.util.cron.tokenize_lines import run_tokenize_backfill

    return run_tokenize_backfill()


def _run_anki_word_sync_deprecated() -> dict:
    logger.warning("anki_word_sync is deprecated — use anki_card_sync instead. Skipping.")
    return {"skipped": True, "reason": "deprecated — use anki_card_sync"}


def _run_anki_card_sync() -> dict:
    from GameSentenceMiner.util.cron.anki_card_sync import run_full_sync

    return run_full_sync()


def _skip_or(result: dict, done: str) -> str:
    if result.get("skipped"):
        return f"skipped: {result.get('reason', 'unknown')}"
    return done


_TASK_REGISTRY: dict[str, _TaskDef] = {
    Crons.POPULATE_GAMES.value: _TaskDef(
        runner=_run_populate_games,
        summary=lambda r: f"created {r.get('created', 0)} games, linked {r.get('linked_lines', 0)} lines",
    ),
    Crons.JITEN_SYNC.value: _TaskDef(
        runner=_run_jiten_sync,
        priority=PRIORITY_LOW,
    ),
    Crons.DAILY_STATS_ROLLUP.value: _TaskDef(runner=_run_daily_rollup, priority=PRIORITY_ROLLUP),
    Crons.USER_PLUGINS.value: _TaskDef(
        runner=_run_user_plugins,
        success=lambda r: r.get("executed", False),
        warn=lambda r: f"User plugins completed with warning: {r['error']}" if r.get("error") else None,
        priority=PRIORITY_HIGH,
    ),
    Crons.JITEN_UPGRADER.value: _TaskDef(
        runner=_run_jiten_upgrader,
        summary=lambda r: f"upgraded {r.get('upgraded_to_jiten', 0)} games, not found {r.get('not_found_on_jiten', 0)}",
        priority=PRIORITY_LOW,
    ),
    Crons.DAILY_GOALS_COMPLETION.value: _TaskDef(
        runner=_run_daily_goals_completion,
        success=lambda r: r.get("success", False),
        summary=lambda r: (
            f"✅ daily goals auto-completed, streak {r.get('streak', 0)}"
            if r.get("action") == "completed"
            else f"action={r.get('action', 'unknown')}"
        ),
        priority=PRIORITY_DEFAULT,
    ),
    Crons.TOKENIZE_BACKFILL.value: _TaskDef(
        runner=_run_tokenize_backfill,
        success=lambda r: not r.get("skipped", False),
        summary=lambda r: _skip_or(r, f"{r.get('processed', 0)} lines processed"),
        priority=PRIORITY_LOW,
    ),
    Crons.ANKI_WORD_SYNC.value: _TaskDef(runner=_run_anki_word_sync_deprecated),
    Crons.ANKI_CARD_SYNC.value: _TaskDef(
        runner=_run_anki_card_sync,
        success=lambda r: not r.get("skipped", False),
        summary=lambda r: _skip_or(
            r,
            f"notes={r.get('notes', 0)}, cards={r.get('cards', 0)}, reviews={r.get('reviews', 0)}",
        ),
    ),
}


class _SlowTaskWatchdog:
    """Logs a warning every ``interval`` seconds while a cron task is still running.

    A stuck task can't be interrupted (it owns the scheduler thread), but this makes it
    impossible to miss in the logs and names the offending task + elapsed time.
    """

    def __init__(self, name: str, interval: float = SLOW_TASK_WARN_SECONDS):
        self._name = name
        self._interval = interval
        self._timer: Optional[threading.Timer] = None
        self._started = 0.0

    def __enter__(self) -> "_SlowTaskWatchdog":
        self._started = time.monotonic()
        self._arm()
        return self

    def __exit__(self, *exc) -> None:
        if self._timer:
            self._timer.cancel()
            self._timer = None

    def _arm(self) -> None:
        self._timer = threading.Timer(self._interval, self._fire)
        self._timer.daemon = True
        self._timer.name = f"gsm-cron-watchdog-{self._name}"
        self._timer.start()

    def _fire(self) -> None:
        elapsed = time.monotonic() - self._started
        logger.warning(f"⏳ Scheduled task '{self._name}' still running after {elapsed:.0f}s — it may be stuck")
        self._arm()


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

        # Currently-running task, for diagnostics (skips / stop-while-busy).
        self._active_task: Optional[str] = None
        self._active_since: Optional[float] = None

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

        logger.background(f"CronScheduler started with check interval of {self.check_interval}s")

    def shutdown(self):
        """Signal the scheduler to wind down without blocking.

        The scheduler thread is a daemon that will exit after its current task, so on
        teardown (e.g. the async runner cancelling its tasks at process shutdown) there's
        no need to block-join and warn — just set the stop event and return.
        """
        with self._state_lock:
            self._running = False
        self._stop_event.set()

    def stop(self, timeout: float = 2.0):
        """Stop the cron scheduler gracefully (blocks up to ``timeout`` for the thread)."""
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
            active = self._active_task_info()
            suffix = f" (active task: {active})" if active else ""
            logger.warning(f"CronScheduler stop requested, but the scheduler thread is still running{suffix}")
        else:
            logger.background("CronScheduler stopped")

    def _set_active_task(self, name: Optional[str]):
        with self._state_lock:
            self._active_task = name
            self._active_since = time.monotonic() if name else None

    def _active_task_info(self) -> Optional[str]:
        """Human-readable description of the in-flight task, or None when idle."""
        with self._state_lock:
            if not self._active_task:
                return None
            elapsed = time.monotonic() - (self._active_since or time.monotonic())
            return f"{self._active_task}, running {elapsed:.0f}s"

    def _run_scheduler(self):
        """
        The main loop.
        It waits for 'check_interval' seconds OR for a forced task in the queue.
        """
        logger.background("CronScheduler thread started")

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

                    logger.background(f"Received forced trigger for: {forced_task.value}")
                    self._execute_safe(forced_task)
                    next_check_time = time.monotonic() + self.check_interval
                except queue.Empty:
                    if not self._stop_event.is_set() and time.monotonic() >= next_check_time:
                        logger.background("Running periodic scheduled task check...")
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
            logger.background("CronScheduler thread exited")

    def _execute_safe(self, force_task: Optional[Crons]):
        """Helper to acquire lock and run logic"""
        acquired = self._lock.acquire(blocking=False)
        if not acquired:
            active = self._active_task_info()
            logger.background(f"Previous cron batch still running ({active or 'unknown'}), skipping this check")
            return

        try:
            run_due_crons(force_task, progress=self._set_active_task)
        except Exception as e:
            logger.exception(f"Cron batch execution failed: {e}")
        finally:
            self._set_active_task(None)
            self._lock.release()

    def is_running(self) -> bool:
        with self._state_lock:
            return self._running


def _execute_cron(cron, task_def: "_TaskDef", progress: Optional[Callable[[Optional[str]], None]]) -> dict:
    """Run a single due cron task with timing + watchdog logging.

    Returns its detail dict, augmented with internal ``_executed``/``_failed`` flags.
    """
    detail = {"name": cron.name, "description": cron.description, "success": False, "error": None}

    if progress:
        progress(cron.name)

    started = time.monotonic()
    logger.background(f"▶ Executing scheduled task: {cron.name}")

    try:
        with _SlowTaskWatchdog(cron.name):
            result = task_def.runner()

        duration = time.monotonic() - started
        if cron.id != -1:
            CronTable.just_ran(cron.id)

        detail["success"] = task_def.success(result)
        detail["result"] = result
        detail["_executed"] = True

        warning = task_def.warn(result)
        if warning:
            logger.warning(warning)

        summary = task_def.summary(result)
        logger.background(f"✔ Finished {cron.name} in {duration:.1f}s" + (f" — {summary}" if summary else ""))
    except Exception as e:
        duration = time.monotonic() - started
        logger.exception(f"✖ Failed to execute {cron.name} after {duration:.1f}s: {e}")
        detail["error"] = str(e)
        detail["_failed"] = True
    finally:
        if progress:
            progress(None)

    return detail


def run_due_crons(
    force_task: Optional["Crons"] = None,
    progress: Optional[Callable[[Optional[str]], None]] = None,
) -> dict:
    """
    Check for and execute all due cron jobs.

    ``progress`` (optional) is called with the task name when each task starts and
    with ``None`` when it ends, so a caller can surface what's currently running.
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

    # Run higher-priority tasks first; stable sort keeps DB order within a priority.
    # Unknown tasks fall to the default priority and still run (and get logged below).
    def _priority(cron) -> int:
        task_def = _TASK_REGISTRY.get(cron.name)
        return task_def.priority if task_def else PRIORITY_DEFAULT

    due_crons = sorted(due_crons, key=_priority)

    logger.background(f"📋 Found {len(due_crons)} scheduled task(s) due to run")

    batch_started = time.monotonic()
    executed_count = 0
    failed_count = 0
    details = []

    for cron in due_crons:
        task_def = _TASK_REGISTRY.get(cron.name)
        if task_def is None:
            logger.error(f"⚠️ Unknown scheduled task: {cron.name}")
            details.append(
                {
                    "name": cron.name,
                    "description": cron.description,
                    "success": False,
                    "error": "Unknown scheduled task",
                }
            )
            failed_count += 1
            continue

        detail = _execute_cron(cron, task_def, progress)
        executed_count += detail.pop("_executed", False)
        failed_count += detail.pop("_failed", False)
        details.append(detail)

    logger.background(
        f"Scheduled task check completed in {time.monotonic() - batch_started:.1f}s "
        f"({executed_count} executed, {failed_count} failed)"
    )

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
