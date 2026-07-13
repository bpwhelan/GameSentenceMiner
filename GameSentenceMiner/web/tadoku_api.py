from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from typing import Any

from flask import current_app, jsonify, request

from GameSentenceMiner.util.config.configuration import get_stats_config, save_stats_config
from GameSentenceMiner.util.tadoku_sync import (
    TadokuClient,
    TadokuSyncError,
    build_tadoku_preview,
    run_tadoku_sync,
)


@dataclass
class _TadokuJob:
    job_id: str
    status: str = "queued"
    result: dict[str, Any] | None = None
    error: str | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def payload(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.job_id,
                "status": self.status,
                "result": self.result,
                "error": self.error,
            }


class TadokuSyncJobManager:
    def __init__(self):
        self._jobs: dict[str, _TadokuJob] = {}
        self._lock = threading.Lock()

    def start(self, *, deduplicate: bool, run_inline: bool = False) -> dict[str, Any]:
        job = _TadokuJob(job_id=uuid.uuid4().hex)
        with self._lock:
            if any(candidate.status in {"queued", "running"} for candidate in self._jobs.values()):
                raise TadokuSyncError("A Tadoku sync is already queued or running")
            self._jobs[job.job_id] = job

        if run_inline:
            self._run(job, deduplicate)
        else:
            thread = threading.Thread(
                target=self._run,
                args=(job, deduplicate),
                name="gsm-tadoku-sync",
                daemon=True,
            )
            thread.start()
        return job.payload()

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
        return job.payload() if job else None

    @staticmethod
    def _run(job: _TadokuJob, deduplicate: bool) -> None:
        with job._lock:
            job.status = "running"
        try:
            result = run_tadoku_sync(deduplicate=deduplicate)
        except Exception as exc:
            with job._lock:
                job.status = "failed"
                job.error = str(exc)
            return
        with job._lock:
            job.status = "completed"
            job.result = result


tadoku_sync_job_manager = TadokuSyncJobManager()


def register_tadoku_api_routes(app):
    @app.route("/api/tadoku/auth/refresh", methods=["POST"])
    def api_tadoku_refresh_auth():
        config = get_stats_config()
        username = str(getattr(config, "tadoku_username", "") or "").strip()
        password = str(getattr(config, "tadoku_password", "") or "")
        if not username or not password:
            return jsonify({"error": "Save a Tadoku username and password first"}), 400

        try:
            client = TadokuClient(username, password)
            client.refresh_session()
        except TadokuSyncError as exc:
            return jsonify({"error": str(exc)}), 401

        config.tadoku_session_cookie = client.session_cookie
        save_stats_config(config)
        return jsonify({"authenticated": True}), 200

    @app.route("/api/tadoku/preview", methods=["GET"])
    def api_tadoku_preview():
        deduplicate = request.args.get("deduplicate", "false").lower() in {"1", "true", "yes", "on"}
        preview = build_tadoku_preview(deduplicate=deduplicate)
        config = get_stats_config()
        preview["configured"] = bool(getattr(config, "tadoku_username", "") and getattr(config, "tadoku_password", ""))
        return jsonify(preview), 200

    @app.route("/api/tadoku/sync", methods=["POST"])
    def api_tadoku_sync():
        data = request.get_json(silent=True) or {}
        try:
            payload = tadoku_sync_job_manager.start(
                deduplicate=bool(data.get("deduplicate", False)),
                run_inline=bool(current_app.testing),
            )
        except TadokuSyncError as exc:
            return jsonify({"error": str(exc)}), 409
        return jsonify(payload), 202

    @app.route("/api/tadoku/jobs/<job_id>", methods=["GET"])
    def api_tadoku_job(job_id: str):
        payload = tadoku_sync_job_manager.get(job_id)
        if payload is None:
            return jsonify({"error": "Tadoku sync job not found"}), 404
        return jsonify(payload), 200
