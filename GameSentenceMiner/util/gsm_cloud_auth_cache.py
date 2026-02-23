import os
import threading
import time
from typing import Any, Dict, Optional

import requests

from GameSentenceMiner.util.config.configuration import get_config, gsm_state, is_gsm_cloud_preview_enabled, logger


class GsmCloudAuthCacheService:
    def __init__(self):
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def _load_runtime_config(self) -> Dict[str, Any]:
        preview_enabled = bool(is_gsm_cloud_preview_enabled())
        ai = get_config().ai
        interval_seconds = max(60 * 60, int(os.getenv("GSM_CLOUD_AUTH_WARM_INTERVAL_SECONDS", "43200")))
        timeout_seconds = max(3, min(30, int(os.getenv("GSM_CLOUD_AUTH_WARM_TIMEOUT_SECONDS", "8"))))
        return {
            "preview_enabled": preview_enabled,
            "api_url": str(ai.gsm_cloud_api_url or "").strip().rstrip("/"),
            "access_token": str(ai.gsm_cloud_access_token or "").strip(),
            "token_expires_at": max(0, int(ai.gsm_cloud_token_expires_at or 0)),
            "interval_seconds": interval_seconds,
            "timeout_seconds": timeout_seconds,
        }

    @staticmethod
    def _is_configured(cfg: Dict[str, Any]) -> bool:
        return bool(cfg["preview_enabled"] and cfg["api_url"] and cfg["access_token"])

    def warm_once(self, reason: str = "manual") -> bool:
        cfg = self._load_runtime_config()
        if not self._is_configured(cfg):
            return False

        token_expires_at = cfg["token_expires_at"]
        now = int(time.time())
        if token_expires_at and token_expires_at <= now:
            logger.debug("Skipping GSM Cloud auth cache warm-up: local access token is expired.")
            return False

        url = f"{cfg['api_url']}/api/cloud/auth/warm"
        headers = {
            "Authorization": f"Bearer {cfg['access_token']}",
            "Cache-Control": "no-store",
        }

        with self._lock:
            try:
                response = requests.get(url, headers=headers, timeout=cfg["timeout_seconds"])
            except Exception as exc:
                logger.debug("GSM Cloud auth cache warm-up failed ({}): {}", reason, exc)
                return False

        if response.status_code == 200:
            logger.debug("GSM Cloud auth cache warmed ({}).", reason)
            return True

        if response.status_code in (401, 403):
            logger.info(
                "GSM Cloud auth warm-up returned {} (token likely expired or invalid).",
                response.status_code,
            )
        else:
            logger.debug(
                "GSM Cloud auth warm-up returned HTTP {} ({}).",
                response.status_code,
                reason,
            )
        return False

    def _run_loop(self) -> None:
        first = True
        while not self._stop_event.is_set() and gsm_state.keep_running:
            reason = "startup" if first else "periodic"
            self.warm_once(reason=reason)
            first = False
            wait_seconds = self._load_runtime_config()["interval_seconds"]
            self._stop_event.wait(wait_seconds)

    def start_background_loop(self) -> bool:
        if self._thread and self._thread.is_alive():
            return True

        if not self._is_configured(self._load_runtime_config()):
            return False

        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="gsm-cloud-auth-warm",
            daemon=True,
        )
        self._thread.start()
        logger.debug("GSM Cloud auth cache warm-up loop started.")
        return True

    def stop_background_loop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        self._thread = None


gsm_cloud_auth_cache_service = GsmCloudAuthCacheService()
