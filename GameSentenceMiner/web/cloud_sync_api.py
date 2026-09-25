import copy
from typing import Any
from urllib.parse import urlsplit

from flask import jsonify, request

from GameSentenceMiner.util.cloud_sync import cloud_sync_service
from GameSentenceMiner.util.config.configuration import (
    get_config,
    get_master_config,
    logger,
)


def _is_local_request() -> bool:
    remote = request.remote_addr or ""
    return remote in {"127.0.0.1", "::1", "localhost"}


def _local_only_guard():
    origin = request.headers.get("Origin")
    host_is_local = urlsplit(request.host_url).hostname in {"localhost", "127.0.0.1", "::1"}
    same_origin = not origin or origin.rstrip("/") == request.host_url.rstrip("/")
    if _is_local_request() and host_is_local and same_origin and request.headers.get("Sec-Fetch-Site") != "cross-site":
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
    @app.route("/api/cloud-sync/relay", methods=["DELETE"])
    def api_cloud_sync_delete_relay():
        guard = _local_only_guard()
        if guard:
            return guard
        result = cloud_sync_service.purge_relay()
        return jsonify(result), 200 if result.get("status") == "success" else 409

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

        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"error": "Expected a JSON object"}), 400
        original = get_config().advanced
        cfg = copy.deepcopy(original)
        master = get_master_config()

        try:
            from GameSentenceMiner.util.cloud_sync.crypto import SyncCipher
            from GameSentenceMiner.util.cloud_sync.relay_client import validate_relay_url
            from GameSentenceMiner.util.cloud_sync.settings import GROUPS

            if "protocol" in data:
                if data["protocol"] not in {"relay-v2", "legacy"}:
                    raise ValueError("Unknown sync protocol")
                cfg.cloud_sync_protocol = data["protocol"]
            if "sync_key" in data:
                key = str(data["sync_key"] or "").strip()
                if key:
                    SyncCipher(key)
                cfg.cloud_sync_key = key
            if "settings_groups" in data:
                groups = data["settings_groups"]
                if not isinstance(groups, list) or any(
                    not isinstance(group, str) or group not in GROUPS for group in groups
                ):
                    raise ValueError("Unknown portable settings group")
                cfg.cloud_sync_settings_groups = list(dict.fromkeys(groups))
            if "enabled" in data:
                cfg.cloud_sync_enabled = _parse_bool(data.get("enabled"))
            if "auto_sync" in data:
                cfg.cloud_sync_auto_sync = _parse_bool(data.get("auto_sync"))
            if "api_url" in data:
                cfg.cloud_sync_api_url = str(data.get("api_url") or "").strip().rstrip("/")
                if cfg.cloud_sync_api_url:
                    validate_relay_url(cfg.cloud_sync_api_url)
            if "email" in data:
                cfg.cloud_sync_email = str(data.get("email") or "").strip()
            if "api_token" in data:
                cfg.cloud_sync_api_token = str(data.get("api_token") or "").strip()
            if "device_id" in data:
                cfg.cloud_sync_device_id = str(data.get("device_id") or "").strip()
            if "interval_seconds" in data:
                cfg.cloud_sync_interval_seconds = max(60, int(data.get("interval_seconds") or 900))
            if "push_batch_size" in data:
                cfg.cloud_sync_push_batch_size = max(1, min(5000, int(data.get("push_batch_size") or 5000)))
            if "max_server_changes" in data:
                cfg.cloud_sync_max_server_changes = max(1, min(5000, int(data.get("max_server_changes") or 5000)))
            if "timeout_seconds" in data:
                cfg.cloud_sync_timeout_seconds = max(5, min(120, int(data.get("timeout_seconds") or 20)))
        except (ValueError, TypeError) as exc:
            return jsonify({"error": str(exc)}), 400

        if not cloud_sync_service._sync_lock.acquire(blocking=False):
            return jsonify({"error": "Wait for the current sync to finish before changing its settings"}), 409
        previous = [(profile, profile.advanced) for profile in master.configs.values()]
        try:
            for profile, advanced in previous:
                updated = copy.deepcopy(advanced)
                for name, value in vars(cfg).items():
                    if name.startswith("cloud_sync_"):
                        setattr(updated, name, copy.deepcopy(value))
                profile.advanced = updated
            master.save()
        except Exception:
            for profile, advanced in previous:
                profile.advanced = advanced
            raise
        finally:
            cloud_sync_service._sync_lock.release()
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
        if advanced.cloud_sync_protocol == "relay-v2":
            return jsonify(
                {"error": "Use a device transfer to recover encrypted sync; its cursor cannot be reset independently"}
            ), 409
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

        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"error": "Expected a JSON object"}), 400
        try:
            include_existing = _parse_bool(data.get("include_existing", False))
            max_rounds = max(1, min(50, int(data.get("max_rounds", 5))))
            publish_snapshot = _parse_bool(data.get("publish_snapshot", False))
            reseed = _parse_bool(data.get("reseed", False))
        except (TypeError, ValueError) as exc:
            return jsonify({"error": str(exc)}), 400

        result = cloud_sync_service.sync_once(
            manual=True,
            include_existing=include_existing,
            max_rounds=max_rounds,
            publish_snapshot=publish_snapshot,
            reseed=reseed,
        )
        status_code = 200 if result.get("status") != "error" else 500
        return jsonify(result), status_code
