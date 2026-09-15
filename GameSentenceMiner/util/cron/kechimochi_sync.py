# Schedules follow GSM's local calendar, including local daylight-saving changes.
# ruff: noqa: DTZ005, DTZ006

from __future__ import annotations

import datetime as dt
import time

from GameSentenceMiner.util.config.configuration import get_stats_config, logger
from GameSentenceMiner.util.database.db import CronTable
from GameSentenceMiner.util.database.kechimochi_sync_state import KechimochiSyncState
from GameSentenceMiner.util.kechimochi_client import KechimochiConnectionError
from GameSentenceMiner.util.kechimochi_sync import run_kechimochi_sync, run_state_key

KECHIMOCHI_CRON_NAME = "kechimochi_sync"
KECHIMOCHI_SCHEDULES = {"quarter_hourly", "hourly", "daily"}


def next_kechimochi_run(now=None, *, config=None, retry=False):
    config = config or get_stats_config()
    now = now or dt.datetime.now()
    schedule = config.kechimochi_sync_schedule
    if schedule == "daily":
        hour, minute = map(int, config.kechimochi_sync_time.split(":"))
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= now:
            candidate += dt.timedelta(days=1)
    else:
        candidate = now + dt.timedelta(minutes=60 if schedule == "hourly" else 15)
    if retry:
        candidate = min(candidate, now + dt.timedelta(minutes=15))
    return candidate.timestamp()


def reschedule_kechimochi_run(now=None):
    config = get_stats_config()
    status = KechimochiSyncState().get(run_state_key(config.kechimochi_url), {})
    return next_kechimochi_run(now, config=config, retry=status.get("status") == "failed")


def configure_kechimochi_cron(*, config=None, run_immediately=True):
    config = config or get_stats_config()
    cron = CronTable.get_by_name(KECHIMOCHI_CRON_NAME)
    enabled = config.kechimochi_sync_enabled
    if cron is None:
        return CronTable.create_cron_entry(
            name=KECHIMOCHI_CRON_NAME,
            description="Reconcile all GSM history and library metadata with Kechimochi",
            next_run=time.time() if enabled and run_immediately else next_kechimochi_run(config=config),
            schedule=config.kechimochi_sync_schedule,
            enabled=enabled,
        )
    changed_schedule = cron.schedule != config.kechimochi_sync_schedule
    changed_time = (
        config.kechimochi_sync_schedule == "daily"
        and dt.datetime.fromtimestamp(cron.next_run).strftime("%H:%M") != config.kechimochi_sync_time
    )
    # Keep overdue runs overdue on startup, including an offline retry. Settings
    # saves explicitly request a new next_run after changing the time or schedule.
    if enabled and not cron.enabled:
        cron.next_run = time.time() if run_immediately else next_kechimochi_run(config=config)
    elif changed_schedule or (changed_time and not run_immediately):
        cron.next_run = next_kechimochi_run(config=config)
    cron.enabled = enabled
    cron.schedule = config.kechimochi_sync_schedule
    cron.save()
    return cron


def run_scheduled_kechimochi_sync():
    config = get_stats_config()
    if not config.kechimochi_sync_enabled:
        return {"success": True, "skipped": True, "reason": "Automatic Kechimochi sync is disabled"}
    try:
        return run_kechimochi_sync(config=config)
    except KechimochiConnectionError as exc:
        # The sync worker already recorded the failure and logged it at debug level.
        return {"success": False, "error": str(exc), "unavailable": True}
    except Exception as exc:  # noqa: BLE001 - cron failures must reschedule instead of killing the worker
        logger.exception("Scheduled Kechimochi sync failed: {}", exc)
        # CronTable schedules a bounded retry, including for daily schedules.
        return {"success": False, "error": str(exc)}
