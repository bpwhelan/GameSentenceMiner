"""Background thread that monitors OBS connection health and drives periodic ticks.

Changes vs. the original:
* Maximum consecutive recovery failures (10) before backing off to 30 s interval.
* No thread-spawning recovery — recovery is inline only.
* Tick timing guard: if a tick takes >5 s, skip next cycle.
"""

from __future__ import annotations

import threading
import time

from GameSentenceMiner.obs._state import get_connection_pool, get_obs_service, is_connecting
from GameSentenceMiner.obs.client_wrapper import _recover_obs_service_clients_sync
from GameSentenceMiner.obs.types import OBSTickOptions
from GameSentenceMiner.util.config.configuration import gsm_state, gsm_status, logger

_MAX_CONSECUTIVE_RECOVERY_FAILURES = 10
_BACKED_OFF_CHECK_INTERVAL = 30.0
_TICK_SKIP_THRESHOLD_SECONDS = 5.0


class OBSConnectionManager(threading.Thread):
    def __init__(self, check_output: bool = False) -> None:
        super().__init__()
        self.daemon = True
        self.running = True
        self.check_connection_interval = 1.0
        self.recovery_cooldown_seconds = 2.0
        self.check_output = check_output
        self.last_tick_time = 0.0

        self._check_lock = threading.Lock()
        self._last_recovery_attempt = 0.0
        self._consecutive_recovery_failures = 0
        self._backed_off = False

    # ------------------------------------------------------------------
    # Recovery
    # ------------------------------------------------------------------

    def _recover_obs_connection(self) -> bool:
        now = time.monotonic()
        if is_connecting():
            return False
        if (now - self._last_recovery_attempt) < self.recovery_cooldown_seconds:
            return False

        self._last_recovery_attempt = now

        # Look up via the package so monkeypatches (e.g. in tests) are respected
        import GameSentenceMiner.obs as _obs_pkg

        pool = getattr(_obs_pkg, "connection_pool", None) or get_connection_pool()
        if pool:
            try:
                pool.reset_healthcheck_client()
            except Exception:
                pass

        obs_service = getattr(_obs_pkg, "obs_service", None) or get_obs_service()
        if obs_service:
            if _recover_obs_service_clients_sync():
                logger.info("Recovered OBS WebSocket connection.")
                self._consecutive_recovery_failures = 0
                if self._backed_off:
                    self._backed_off = False
                    logger.info("OBS connection recovered — resuming normal check interval.")
                return True

        # Failed
        self._consecutive_recovery_failures += 1
        if self._consecutive_recovery_failures >= _MAX_CONSECUTIVE_RECOVERY_FAILURES and not self._backed_off:
            self._backed_off = True
            logger.warning(
                f"OBS recovery failed {self._consecutive_recovery_failures} times consecutively — "
                f"reducing check frequency to every {_BACKED_OFF_CHECK_INTERVAL:.0f}s."
            )
        return False

    # ------------------------------------------------------------------
    # Health check
    # ------------------------------------------------------------------

    def _check_obs_connection(self) -> bool:
        if is_connecting():
            return False

        import GameSentenceMiner.obs as _obs_pkg

        pool = getattr(_obs_pkg, "connection_pool", None) or get_connection_pool()
        try:
            client = pool.get_healthcheck_client() if pool else None
            if client:
                client.get_version()
                gsm_status.obs_connected = True
                # Successful check resets back-off
                if self._backed_off:
                    self._consecutive_recovery_failures = 0
                    self._backed_off = False
                return True
            raise ConnectionError("Healthcheck client creation failed")
        except Exception as e:
            if pool:
                try:
                    pool.reset_healthcheck_client()
                except Exception:
                    pass
            if gsm_status.obs_connected:
                logger.info(f"OBS WebSocket connection lost: {e}")
            gsm_status.obs_connected = False
            return self._recover_obs_connection()

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def run(self) -> None:
        from GameSentenceMiner.util.gsm_utils import SleepManager

        disconnect_sleep_manager = SleepManager(initial_delay=2.0, name="OBS_Disconnect")
        time.sleep(5)

        obs_service = get_obs_service()
        if obs_service:
            obs_service.tick(
                OBSTickOptions(
                    refresh_full_state=False,
                    force=True,
                )
            )

        skip_next_tick = False

        while self.running:
            # Adaptive sleep
            if not gsm_status.obs_connected:
                if self._backed_off:
                    time.sleep(_BACKED_OFF_CHECK_INTERVAL)
                else:
                    disconnect_sleep_manager.sleep()
            else:
                disconnect_sleep_manager.reset()
                time.sleep(self.check_connection_interval)

            if not self._check_obs_connection():
                continue

            # Tick
            if skip_next_tick:
                skip_next_tick = False
                continue

            with self._check_lock:
                obs_service = get_obs_service()
                if obs_service:
                    tick_options = obs_service.build_scheduled_tick_options()
                    if obs_service.has_tick_work(tick_options):
                        tick_start = time.monotonic()
                        obs_service.tick(tick_options)
                        tick_elapsed = time.monotonic() - tick_start
                        self.last_tick_time = time.time()
                        if tick_elapsed > _TICK_SKIP_THRESHOLD_SECONDS:
                            logger.warning(f"OBS tick took {tick_elapsed:.2f}s — skipping next tick cycle.")
                            skip_next_tick = True

            # Session expiry check
            if (
                gsm_state.replay_buffer_stopped_timestamp
                and time.time() - gsm_state.replay_buffer_stopped_timestamp > 900
            ):
                if gsm_state.disable_anki_confirmation_session:
                    gsm_state.disable_anki_confirmation_session = False
                    logger.info("Session expired: Anki confirmation re-enabled.")
                gsm_state.replay_buffer_stopped_timestamp = None

    def stop(self) -> None:
        self.running = False
