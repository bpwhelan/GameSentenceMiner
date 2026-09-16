"""Optional scheduled database compaction and completed-game archiving."""

# Use local calendar days, matching GSM's daily stats (including DST).
# ruff: noqa: DTZ006

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta

from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.game_archive import archive_game, archive_summary, ensure_archive_schema

maintenance_lock = threading.Lock()
DEFAULTS = {"vacuum_interval_days": 0, "archive_after_days": 0, "last_vacuum": None}


def ensure_maintenance_schema(db):
    ensure_archive_schema(db)
    db.execute(
        """CREATE TABLE IF NOT EXISTS database_maintenance (
        id INTEGER PRIMARY KEY CHECK(id=1), vacuum_interval_days INTEGER NOT NULL DEFAULT 0,
        archive_after_days INTEGER NOT NULL DEFAULT 0, last_vacuum REAL)""",
        commit=True,
    )
    db.execute("INSERT OR IGNORE INTO database_maintenance(id) VALUES (1)", commit=True)


def maintenance_settings():
    db = GameLinesTable._db
    if not db.table_exists("database_maintenance"):
        return dict(DEFAULTS)
    row = db.fetchone(
        "SELECT vacuum_interval_days, archive_after_days, last_vacuum FROM database_maintenance WHERE id=1"
    )
    return dict(zip(DEFAULTS, row)) if row else dict(DEFAULTS)


def save_maintenance_settings(data):
    if not isinstance(data, dict) or set(data) - {"vacuum_interval_days", "archive_after_days"}:
        raise ValueError("Expected vacuum_interval_days and archive_after_days")
    for name, value in data.items():
        if type(value) is not int or not 0 <= value <= 3650:
            raise ValueError(f"{name} must be a whole number between 0 and 3650 (0 disables it)")
    db = GameLinesTable._db
    ensure_maintenance_schema(db)

    def save(conn):
        settings = maintenance_settings()
        settings.update(data)
        conn.execute(
            "UPDATE database_maintenance SET vacuum_interval_days=?, archive_after_days=? WHERE id=1",
            (settings["vacuum_interval_days"], settings["archive_after_days"]),
        )

    db.run_transaction(save)
    return maintenance_settings()


def database_storage():
    db = GameLinesTable._db
    page_size = db.fetchone("PRAGMA page_size")[0]
    return {
        "database_bytes": db.fetchone("PRAGMA page_count")[0] * page_size,
        "reclaimable_bytes": db.fetchone("PRAGMA freelist_count")[0] * page_size,
        "raw_lines": db.fetchone("SELECT COUNT(*) FROM game_lines")[0],
        "archived_lines": archive_summary()["archived_lines"],
    }


def vacuum_database():
    db = GameLinesTable._db
    ensure_maintenance_schema(db)
    result = db.vacuum()
    db.execute("UPDATE database_maintenance SET last_vacuum=? WHERE id=1", (time.time(),), commit=True)
    return result


def run_database_maintenance(now=None):
    """Check once a day; only completed games older than the opt-in age qualify."""
    if not maintenance_lock.acquire(blocking=False):
        return {"success": True, "skipped": True, "reason": "Maintenance already running"}
    try:
        now = time.time() if now is None else now
        config = maintenance_settings()
        result = {"success": True, "archived_games": 0, "archived_lines": 0, "errors": []}
        db = GameLinesTable._db
        if config["archive_after_days"]:
            cutoff = (datetime.fromtimestamp(now) - timedelta(days=config["archive_after_days"])).timestamp()
            # Re-check status and activity inside the archive transaction to protect resumed games.
            ids = db.fetchall(
                """SELECT g.id FROM games g JOIN game_lines gl ON gl.game_id=g.id
                WHERE g.status='completed' OR ((g.status IS NULL OR g.status='') AND g.completed=1)
                GROUP BY g.id HAVING MAX(CAST(gl.timestamp AS REAL)) < ?""",
                (cutoff,),
            )
            for (game_id,) in ids:
                try:
                    archived = archive_game(game_id, completed_before=cutoff)
                    result["archived_games"] += int(archived["archived_lines"] > 0)
                    result["archived_lines"] += archived["archived_lines"]
                except Exception as exc:  # noqa: BLE001 - isolate failures to one scheduled game
                    from GameSentenceMiner.util.config.configuration import logger

                    logger.exception("Scheduled game archive failed")
                    result["errors"].append(f"{game_id}: {exc}")
        interval = config["vacuum_interval_days"]
        if interval and (config["last_vacuum"] is None or now - config["last_vacuum"] >= interval * 86400):
            result["vacuum"] = vacuum_database()
        result["success"] = not result["errors"]
        return result
    finally:
        maintenance_lock.release()


def setup_database_maintenance():
    from GameSentenceMiner.util.database.cron_table import CronTable

    db = GameLinesTable._db
    ensure_maintenance_schema(db)
    if not CronTable.get_by_name("database_maintenance"):
        CronTable.create_cron_entry(
            name="database_maintenance",
            description="Optional database cleanup and game archiving",
            next_run=time.time() + 300,
            schedule="daily",
            enabled=True,
        )
