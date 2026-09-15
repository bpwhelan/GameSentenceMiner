from __future__ import annotations

import dataclasses
import re
import threading
import uuid

from flask import current_app, jsonify, request

from GameSentenceMiner.util.config.configuration import get_stats_config, logger, save_stats_config
from GameSentenceMiner.util.cron.kechimochi_sync import (
    KECHIMOCHI_CRON_NAME,
    KECHIMOCHI_SCHEDULES,
    configure_kechimochi_cron,
)
from GameSentenceMiner.util.database.db import CronTable
from GameSentenceMiner.util.database.kechimochi_sync_state import KechimochiSyncState
from GameSentenceMiner.util.kechimochi_client import KechimochiClient, KechimochiSyncError, normalize_kechimochi_url
from GameSentenceMiner.util.kechimochi_sync import build_kechimochi_snapshot, run_kechimochi_sync, run_state_key

SETTING_FIELDS = {
    "url": "kechimochi_url",
    "enabled": "kechimochi_sync_enabled",
    "schedule": "kechimochi_sync_schedule",
    "sync_time": "kechimochi_sync_time",
    "include_external_stats": "kechimochi_include_external_stats",
    "sync_covers": "kechimochi_sync_covers",
    "adopt_matching_logs": "kechimochi_adopt_matching_logs",
}


def settings_payload(config):
    return {name: getattr(config, field) for name, field in SETTING_FIELDS.items()}


def validated_settings(data, config):
    if not isinstance(data, dict) or set(data) - SETTING_FIELDS.keys():
        raise ValueError("Expected Kechimochi sync settings")
    updates = {}
    for name, value in data.items():
        if name == "url":
            value = normalize_kechimochi_url(value)
        elif name == "schedule":
            if not isinstance(value, str) or value not in KECHIMOCHI_SCHEDULES:
                raise ValueError("Choose a 15-minute, hourly, or daily sync schedule")
        elif name == "sync_time":
            if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
                raise ValueError("Sync time must be a local time in HH:MM format")
        elif type(value) is not bool:
            raise ValueError(f"{name} must be true or false")
        updates[SETTING_FIELDS[name]] = value
    return dataclasses.replace(config, **updates)


class KechimochiSyncJobManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._job = None

    def active(self):
        with self._lock:
            if self._job and self._job["status"] in {"queued", "running"}:
                return dict(self._job)
        return None

    def start(self, *, run_inline=False):
        with self._lock:
            if self._job and self._job["status"] in {"queued", "running"}:
                raise KechimochiSyncError("A Kechimochi sync is already queued or running")
            with KechimochiSyncState().sync_lock():
                pass
            self._job = {"job_id": uuid.uuid4().hex, "status": "queued"}
            payload = dict(self._job)
        if run_inline:
            self._run()
        else:
            try:
                threading.Thread(target=self._run, name="gsm-kechimochi-sync", daemon=True).start()
            except Exception:
                with self._lock:
                    self._job["status"] = "failed"
                raise
        return payload

    def _run(self):
        with self._lock:
            self._job["status"] = "running"
        try:
            run_kechimochi_sync()
        except Exception as exc:  # noqa: BLE001 - report all worker failures in the job status
            logger.exception("Manual Kechimochi sync failed: {}", exc)
            with self._lock:
                self._job.update(status="failed", error=str(exc))
        else:
            with self._lock:
                self._job["status"] = "completed"
        finally:
            # Manual runs (including the first backfill on enable) also need a
            # bounded offline retry, even when the normal schedule is daily.
            from GameSentenceMiner.util.cron.kechimochi_sync import reschedule_kechimochi_run
            from GameSentenceMiner.util.cron.run_crons import cron_scheduler

            cron = CronTable.get_by_name(KECHIMOCHI_CRON_NAME)
            if cron and cron.enabled:
                cron.next_run = reschedule_kechimochi_run()
                cron.save()
                cron_scheduler.update_scheduled_cron(cron)


kechimochi_sync_job_manager = KechimochiSyncJobManager()


def sync_status():
    config = get_stats_config()
    state = KechimochiSyncState()
    status = state.get(run_state_key(config.kechimochi_url), {"status": "idle"})
    active = kechimochi_sync_job_manager.active()
    if active and status["status"] != "running":
        status = {**status, "status": active["status"], "phase": "Starting sync", "error": None, "result": None}
    elif status["status"] == "running" and not active:
        try:
            with state.sync_lock():
                status = {
                    **status,
                    "status": "interrupted",
                    "error": "The previous sync was interrupted. The next run will resume safely.",
                }
        except KechimochiSyncError:
            pass
    cron = CronTable.get_by_name(KECHIMOCHI_CRON_NAME)
    return {
        **status,
        "settings": settings_payload(config),
        "next_run": cron.next_run if cron and cron.enabled else None,
    }


def register_kechimochi_api_routes(app):
    @app.get("/api/kechimochi/settings")
    def api_kechimochi_settings():
        return jsonify(settings_payload(get_stats_config()))

    @app.post("/api/kechimochi/settings")
    def api_kechimochi_save_settings():
        try:
            config = validated_settings(request.get_json(silent=True), get_stats_config())
            with KechimochiSyncState().sync_lock():
                if kechimochi_sync_job_manager.active():
                    raise KechimochiSyncError("Wait for the current Kechimochi sync to finish before changing settings")
                save_stats_config(config)
                cron = configure_kechimochi_cron(config=config, run_immediately=False)
                from GameSentenceMiner.util.cron.run_crons import cron_scheduler

                cron_scheduler.update_scheduled_cron(cron)
            if config.kechimochi_sync_enabled:
                kechimochi_sync_job_manager.start(run_inline=bool(current_app.testing))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except KechimochiSyncError as exc:
            return jsonify({"error": str(exc)}), 409
        return jsonify(settings_payload(config))

    @app.post("/api/kechimochi/test")
    def api_kechimochi_test():
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or set(data) - {"url"}:
            return jsonify({"error": "Expected a Kechimochi URL"}), 400
        client = None
        try:
            client = KechimochiClient(data.get("url", get_stats_config().kechimochi_url))
            return jsonify({"connected": True, "version": client.version(), "media_count": len(client.get_media())})
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except KechimochiSyncError as exc:
            return jsonify({"error": str(exc)}), 502
        finally:
            if client:
                client.close()

    @app.get("/api/kechimochi/preview")
    def api_kechimochi_preview():
        try:
            snapshot = build_kechimochi_snapshot()
        except (KechimochiSyncError, ValueError) as exc:
            return jsonify({"error": str(exc)}), 400
        entries = [
            {**row, "title": snapshot.media[row["media_key"]]["title"]}
            for row in sorted(snapshot.logs.values(), key=lambda row: (row["date"], row["media_key"]))[:100]
        ]
        return jsonify({**snapshot.summary(), "entries": entries})

    @app.get("/api/kechimochi/status")
    def api_kechimochi_status():
        return jsonify(sync_status())

    @app.post("/api/kechimochi/sync")
    def api_kechimochi_sync():
        try:
            return jsonify(kechimochi_sync_job_manager.start(run_inline=bool(current_app.testing))), 202
        except KechimochiSyncError as exc:
            return jsonify({"error": str(exc)}), 409
