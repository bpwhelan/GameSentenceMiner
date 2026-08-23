from __future__ import annotations

from datetime import datetime, timedelta

from GameSentenceMiner.util.config.configuration import get_stats_config, logger
from GameSentenceMiner.util.database.cron_table import CronTable
from GameSentenceMiner.util.tadoku_sync import (
    TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS,
    TadokuSyncError,
    run_tadoku_sync,
)


TADOKU_CRON_NAME = "tadoku_sync"


def _next_daily_run(now: datetime | None = None, sync_time: str | None = None) -> float:
    now = now or datetime.now()
    sync_time = sync_time or getattr(get_stats_config(), "tadoku_daily_sync_time", "00:01")
    try:
        hour, minute = (int(part) for part in sync_time.split(":"))
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    except (AttributeError, TypeError, ValueError):
        candidate = now.replace(hour=0, minute=1, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate.timestamp()


def configure_tadoku_cron(enabled: bool | None = None) -> CronTable:
    config = get_stats_config()
    if enabled is None:
        enabled = bool(getattr(config, "tadoku_daily_sync_enabled", False))
    sync_time = getattr(config, "tadoku_daily_sync_time", "00:01")

    cron = CronTable.get_by_name(TADOKU_CRON_NAME)
    if cron is None:
        cron = CronTable.create_cron_entry(
            name=TADOKU_CRON_NAME,
            description="Export incremental per-game character counts to Tadoku",
            next_run=_next_daily_run(sync_time=sync_time),
            schedule="daily",
            enabled=bool(enabled),
        )
        return cron

    was_enabled = bool(cron.enabled)
    changed = False
    if cron.schedule != "daily":
        cron.schedule = "daily"
        changed = True
    if datetime.fromtimestamp(cron.next_run).strftime("%H:%M") != sync_time:
        cron.next_run = _next_daily_run(sync_time=sync_time)
        changed = True
    if was_enabled != bool(enabled):
        cron.enabled = bool(enabled)
        changed = True
        if enabled:
            cron.next_run = _next_daily_run(sync_time=sync_time)
    if changed:
        cron.save()
        logger.info("Tadoku daily sync %s", "enabled" if enabled else "disabled")
    return cron


def run_scheduled_tadoku_sync() -> dict:
    config = get_stats_config()
    configured_game_ids = set(getattr(config, "tadoku_daily_sync_game_ids", []) or [])
    try:
        return run_tadoku_sync(
            config=config,
            deduplicate=bool(getattr(config, "tadoku_daily_sync_deduplicate", True)),
            minimum_characters_per_game=TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS,
            game_whitelist=configured_game_ids or None,
        )
    except TadokuSyncError as exc:
        # Reschedule for tomorrow after a remote/auth failure instead of retrying
        # and contacting Tadoku every scheduler minute.
        logger.error("Tadoku daily sync failed: %s", exc)
        return {"success": False, "error": str(exc)}
