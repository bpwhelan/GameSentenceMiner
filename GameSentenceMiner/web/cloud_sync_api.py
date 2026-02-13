from typing import Any

from flask import jsonify, request

from GameSentenceMiner.util.cloud_sync import cloud_sync_service
from GameSentenceMiner.util.config.configuration import get_config, get_master_config, is_gsm_cloud_preview_enabled, logger


def _is_local_request() -> bool:
    remote = request.remote_addr or ""
    return remote in {"127.0.0.1", "::1", "localhost"}


def _local_only_guard():
    if _is_local_request():
        return None
    return (
        jsonify({"error": "Cloud sync control endpoints are localhost-only"}),
        403,
    )


def _parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    raise ValueError(f"Invalid boolean value: {value}")


def register_cloud_sync_api_routes(app):
    if not is_gsm_cloud_preview_enabled():
        return

    @app.route("/api/cloud-sync/status", methods=["GET"])
    def api_cloud_sync_status():
        guard = _local_only_guard()
        if guard:
            return guard
        return jsonify(cloud_sync_service.get_status()), 200

    @app.route("/api/cloud-sync/settings", methods=["POST"])
    def api_cloud_sync_settings():
        guard = _local_only_guard()
        if guard:
            return guard

        data = request.get_json(silent=True) or {}
        cfg = get_config().advanced
        master = get_master_config()

        try:
            if "enabled" in data:
                cfg.cloud_sync_enabled = _parse_bool(data.get("enabled"))
            if "auto_sync" in data:
                cfg.cloud_sync_auto_sync = _parse_bool(data.get("auto_sync"))
            if "api_url" in data:
                cfg.cloud_sync_api_url = str(data.get("api_url") or "").strip().rstrip("/")
            if "email" in data:
                cfg.cloud_sync_email = str(data.get("email") or "").strip()
            if "api_token" in data:
                cfg.cloud_sync_api_token = str(data.get("api_token") or "").strip()
            if "device_id" in data:
                cfg.cloud_sync_device_id = str(data.get("device_id") or "").strip()
            if "interval_seconds" in data:
                cfg.cloud_sync_interval_seconds = max(60, int(data.get("interval_seconds") or 900))
            if "push_batch_size" in data:
                cfg.cloud_sync_push_batch_size = max(
                    1, min(5000, int(data.get("push_batch_size") or 5000))
                )
            if "max_server_changes" in data:
                cfg.cloud_sync_max_server_changes = max(
                    1, min(5000, int(data.get("max_server_changes") or 5000))
                )
            if "timeout_seconds" in data:
                cfg.cloud_sync_timeout_seconds = max(
                    5, min(120, int(data.get("timeout_seconds") or 20))
                )
        except (ValueError, TypeError) as exc:
            return jsonify({"error": str(exc)}), 400

        master.save()
        cloud_sync_service.refresh_background_loop()
        logger.info("Cloud sync settings updated via local API")
        return jsonify(cloud_sync_service.get_status()), 200

    @app.route("/api/cloud-sync/queue-existing", methods=["POST"])
    def api_cloud_sync_queue_existing():
        guard = _local_only_guard()
        if guard:
            return guard

        queued_count = cloud_sync_service.queue_existing_lines()
        return jsonify(
            {
                "message": "Queued existing lines for sync",
                "queued_count": queued_count,
                "status": cloud_sync_service.get_status(),
            }
        ), 200

    @app.route("/api/cloud-sync/reset-cursor", methods=["POST"])
    def api_cloud_sync_reset_cursor():
        guard = _local_only_guard()
        if guard:
            return guard

        profile = get_config()
        advanced = profile.advanced
        identity = str(advanced.cloud_sync_email or "").strip()
        if not identity:
            identity = str(profile.ai.gsm_cloud_user_id or "").strip()
        if not identity:
            return jsonify({"error": "cloud sync identity is not configured"}), 400

        cloud_sync_service.reset_since_seq(identity=identity)
        return jsonify(
            {
                "message": "Cloud sync cursor reset to 0",
                "status": cloud_sync_service.get_status(),
            }
        ), 200

    @app.route("/api/cloud-sync/run", methods=["POST"])
    def api_cloud_sync_run():
        guard = _local_only_guard()
        if guard:
            return guard

        data = request.get_json(silent=True) or {}
        include_existing = bool(data.get("include_existing", False))
        max_rounds = int(data.get("max_rounds", 5) or 5)
        max_rounds = max(1, min(50, max_rounds))

        result = cloud_sync_service.sync_once(
            manual=True,
            include_existing=include_existing,
            max_rounds=max_rounds,
        )
        status_code = 200 if result.get("status") != "error" else 500
        return jsonify(result), status_code
