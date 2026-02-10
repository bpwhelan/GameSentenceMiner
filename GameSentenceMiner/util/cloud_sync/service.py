import hashlib
import socket
import threading
import time
import uuid
from typing import Any, Dict, Optional

import requests

from GameSentenceMiner.util.config.configuration import (
    get_config,
    get_master_config,
    gsm_state,
    logger,
)
from GameSentenceMiner.util.database.db import GameLinesTable


class CloudSyncService:
    _state_table = "sync_client_state"
    _state_prefix = "gameline_since_seq"

    def __init__(self):
        self._sync_lock = threading.Lock()
        self._status_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._last_result: Dict[str, Any] = {
            "status": "never_ran",
            "last_started_at": None,
            "last_finished_at": None,
            "last_success_at": None,
            "last_error": None,
        }

    def _ensure_state_table(self) -> None:
        GameLinesTable._db.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self._state_table} (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """,
            commit=True,
        )

    def _state_get(self, key: str) -> Optional[str]:
        self._ensure_state_table()
        row = GameLinesTable._db.fetchone(
            f"SELECT value FROM {self._state_table} WHERE key=?",
            (key,),
        )
        return str(row[0]) if row and row[0] is not None else None

    def _state_set(self, key: str, value: str) -> None:
        self._ensure_state_table()
        GameLinesTable._db.execute(
            f"""
            INSERT OR REPLACE INTO {self._state_table} (key, value, updated_at)
            VALUES (?, ?, ?)
            """,
            (key, value, time.time()),
            commit=True,
        )

    def _build_since_key(self, email: str) -> str:
        profile = get_master_config().current_profile
        normalized_email = (email or "").strip().lower()
        return f"{self._state_prefix}:{profile}:{normalized_email}"

    def _get_since_seq(self, email: str) -> int:
        key = self._build_since_key(email)
        raw_value = self._state_get(key)
        if not raw_value:
            return 0
        try:
            return max(0, int(raw_value))
        except (ValueError, TypeError):
            return 0

    def _set_since_seq(self, email: str, seq: int) -> None:
        key = self._build_since_key(email)
        self._state_set(key, str(max(0, int(seq))))

    def reset_since_seq(self, email: str) -> None:
        self._set_since_seq(email=email, seq=0)

    def _get_pending_count(self) -> int:
        row = GameLinesTable._db.fetchone(
            f"SELECT COUNT(*) FROM {GameLinesTable._sync_changes_table}"
        )
        return int(row[0]) if row else 0

    def _derive_device_id(self, configured_device_id: str) -> str:
        configured_device_id = (configured_device_id or "").strip()
        if configured_device_id:
            return configured_device_id

        raw_identity = f"{uuid.getnode()}|{socket.gethostname()}"
        digest = hashlib.sha256(raw_identity.encode("utf-8")).hexdigest()
        return f"gsm-{digest[:20]}"

    def _load_runtime_config(self) -> Dict[str, Any]:
        advanced = get_config().advanced
        return {
            "enabled": bool(advanced.cloud_sync_enabled),
            "auto_sync": bool(advanced.cloud_sync_auto_sync),
            "api_url": str(advanced.cloud_sync_api_url or "").strip().rstrip("/"),
            "email": str(advanced.cloud_sync_email or "").strip(),
            "api_token": str(advanced.cloud_sync_api_token or "").strip(),
            "device_id": self._derive_device_id(str(advanced.cloud_sync_device_id or "")),
            "interval_seconds": max(60, int(advanced.cloud_sync_interval_seconds or 900)),
            "push_batch_size": max(1, min(2000, int(advanced.cloud_sync_push_batch_size or 500))),
            "max_server_changes": max(1, min(2000, int(advanced.cloud_sync_max_server_changes or 500))),
            "timeout_seconds": max(5, min(120, int(advanced.cloud_sync_timeout_seconds or 20))),
        }

    def _is_configured(self, cfg: Dict[str, Any]) -> bool:
        return bool(cfg["api_url"] and cfg["email"])

    def _set_last_result(self, result: Dict[str, Any]) -> None:
        with self._status_lock:
            self._last_result = result

    def _get_last_result(self) -> Dict[str, Any]:
        with self._status_lock:
            return dict(self._last_result)

    def start_background_loop(self) -> bool:
        cfg = self._load_runtime_config()
        if not (cfg["enabled"] and cfg["auto_sync"]):
            logger.debug("Cloud sync auto loop not started (disabled or manual-only mode).")
            return False

        if self._thread and self._thread.is_alive():
            return True

        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="gsm-cloud-sync",
            daemon=True,
        )
        self._thread.start()
        logger.info(
            "Cloud sync auto loop started with interval={}s",
            cfg["interval_seconds"],
        )
        return True

    def stop_background_loop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        self._thread = None

    def refresh_background_loop(self) -> None:
        cfg = self._load_runtime_config()
        if cfg["enabled"] and cfg["auto_sync"]:
            self.start_background_loop()
            return
        self.stop_background_loop()

    def _run_loop(self) -> None:
        while not self._stop_event.is_set() and gsm_state.keep_running:
            cfg = self._load_runtime_config()
            if cfg["enabled"] and cfg["auto_sync"]:
                try:
                    self.sync_once(manual=False)
                except Exception as exc:
                    logger.error("Cloud sync background loop failed: {}", exc)
            wait_seconds = cfg["interval_seconds"]
            self._stop_event.wait(wait_seconds)

    def queue_existing_lines(self) -> int:
        return GameLinesTable.queue_all_lines_for_sync()

    def get_status(self) -> Dict[str, Any]:
        cfg = self._load_runtime_config()
        configured = self._is_configured(cfg)
        since_seq = self._get_since_seq(cfg["email"]) if configured else 0
        pending = self._get_pending_count()

        return {
            "enabled": cfg["enabled"],
            "auto_sync": cfg["auto_sync"],
            "configured": configured,
            "api_url": cfg["api_url"],
            "email": cfg["email"],
            "device_id": cfg["device_id"],
            "interval_seconds": cfg["interval_seconds"],
            "push_batch_size": cfg["push_batch_size"],
            "max_server_changes": cfg["max_server_changes"],
            "timeout_seconds": cfg["timeout_seconds"],
            "since_seq": since_seq,
            "pending_changes": pending,
            "auto_loop_running": bool(self._thread and self._thread.is_alive()),
            "last_result": self._get_last_result(),
        }

    def sync_once(
        self,
        manual: bool = False,
        include_existing: bool = False,
        max_rounds: int = 5,
    ) -> Dict[str, Any]:
        started_at = time.time()
        if not self._sync_lock.acquire(blocking=False):
            result = {
                "status": "skipped",
                "reason": "sync already running",
                "manual": manual,
                "started_at": started_at,
                "finished_at": time.time(),
            }
            self._set_last_result(result)
            return result

        try:
            cfg = self._load_runtime_config()

            if not cfg["enabled"]:
                result = {
                    "status": "skipped",
                    "reason": "cloud sync disabled",
                    "manual": manual,
                    "started_at": started_at,
                    "finished_at": time.time(),
                }
                self._set_last_result(result)
                return result

            if not self._is_configured(cfg):
                result = {
                    "status": "skipped",
                    "reason": "cloud sync is missing api_url or email",
                    "manual": manual,
                    "started_at": started_at,
                    "finished_at": time.time(),
                }
                self._set_last_result(result)
                return result

            if not manual and not cfg["auto_sync"]:
                result = {
                    "status": "skipped",
                    "reason": "auto sync disabled",
                    "manual": manual,
                    "started_at": started_at,
                    "finished_at": time.time(),
                }
                self._set_last_result(result)
                return result

            queued_existing = 0
            if include_existing:
                queued_existing = self.queue_existing_lines()

            self._set_last_result(
                {
                    "status": "running",
                    "manual": manual,
                    "started_at": started_at,
                    "last_started_at": started_at,
                    "last_finished_at": None,
                    "last_success_at": None,
                    "last_error": None,
                }
            )

            since_seq = self._get_since_seq(cfg["email"])
            total_sent = 0
            total_acked = 0
            total_received = 0
            total_applied_upserts = 0
            total_applied_deletes = 0
            total_applied_client_changes = 0
            total_ignored_client_changes = 0
            rounds = 0
            has_more = False

            headers = {"Content-Type": "application/json"}
            if cfg["api_token"]:
                headers["Authorization"] = f"Bearer {cfg['api_token']}"

            while rounds < max(1, int(max_rounds)):
                outgoing_changes = GameLinesTable.get_pending_sync_changes(
                    limit=cfg["push_batch_size"]
                )
                payload = {
                    "email": cfg["email"],
                    "mac_address": cfg["device_id"],
                    "since_seq": since_seq,
                    "max_server_changes": cfg["max_server_changes"],
                    "changes": outgoing_changes,
                }

                response = requests.post(
                    f"{cfg['api_url']}/api/sync-db",
                    json=payload,
                    headers=headers,
                    timeout=cfg["timeout_seconds"],
                )
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"Sync API returned HTTP {response.status_code}: {response.text[:400]}"
                    )

                body = response.json()
                rounds += 1

                sent_ids = [
                    str(change.get("id", "")).strip()
                    for change in outgoing_changes
                    if str(change.get("id", "")).strip()
                ]
                if sent_ids:
                    total_acked += GameLinesTable.acknowledge_sync_changes(sent_ids)
                total_sent += len(sent_ids)

                server_changes = body.get("server_changes", [])
                apply_stats = GameLinesTable.apply_remote_sync_changes(
                    server_changes, clear_local_tracking=True
                )
                total_received += len(server_changes)
                total_applied_upserts += int(apply_stats.get("upserts", 0))
                total_applied_deletes += int(apply_stats.get("deletes", 0))

                total_applied_client_changes += int(
                    body.get("applied_client_changes", 0) or 0
                )
                total_ignored_client_changes += int(
                    body.get("ignored_client_changes", 0) or 0
                )

                next_since_seq = int(body.get("next_since_seq", since_seq) or since_seq)
                since_seq = max(since_seq, next_since_seq)
                self._set_since_seq(cfg["email"], since_seq)

                has_more = bool(body.get("has_more", False))
                pending_after_round = self._get_pending_count()
                if not has_more and pending_after_round == 0:
                    break
                if not has_more and not outgoing_changes and not server_changes:
                    break

            finished_at = time.time()
            result = {
                "status": "success",
                "manual": manual,
                "started_at": started_at,
                "finished_at": finished_at,
                "last_started_at": started_at,
                "last_finished_at": finished_at,
                "last_success_at": finished_at,
                "last_error": None,
                "queued_existing": queued_existing,
                "rounds": rounds,
                "has_more_after_last_round": has_more,
                "since_seq": since_seq,
                "sent_changes": total_sent,
                "acked_changes": total_acked,
                "received_changes": total_received,
                "applied_remote_upserts": total_applied_upserts,
                "applied_remote_deletes": total_applied_deletes,
                "applied_client_changes": total_applied_client_changes,
                "ignored_client_changes": total_ignored_client_changes,
                "pending_changes_after": self._get_pending_count(),
            }
            self._set_last_result(result)
            return result

        except Exception as exc:
            finished_at = time.time()
            result = {
                "status": "error",
                "manual": manual,
                "started_at": started_at,
                "finished_at": finished_at,
                "last_started_at": started_at,
                "last_finished_at": finished_at,
                "last_success_at": self._get_last_result().get("last_success_at"),
                "last_error": str(exc),
                "pending_changes_after": self._get_pending_count(),
            }
            self._set_last_result(result)
            logger.error("Cloud sync failed: {}", exc)
            return result
        finally:
            self._sync_lock.release()


cloud_sync_service = CloudSyncService()
