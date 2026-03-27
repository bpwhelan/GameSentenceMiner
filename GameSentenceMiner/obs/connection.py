"""Thread-safe connection pool for OBS WebSocket with circuit-breaker per slot."""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from typing import Callable, Optional

import obsws_python as obs

from GameSentenceMiner.obs.types import (
    CIRCUIT_BREAKER_COOLDOWN_SECONDS,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    _get_obs_retry_delay_seconds,
    _is_retryable_obs_exception,
)
from GameSentenceMiner.util.config.configuration import logger

# Silence the obsws library's own logging
logging.getLogger("obsws_python").setLevel(logging.CRITICAL)


class OBSConnectionPool:
    """Manages a pool of thread-safe connections to the OBS WebSocket.

    Each slot has an independent circuit-breaker: after *CIRCUIT_BREAKER_FAILURE_THRESHOLD*
    consecutive failures the slot enters a longer cooldown, preventing runaway reconnection
    attempts.
    """

    def __init__(self, size: int = 3, **kwargs) -> None:
        self.size = size
        self.connection_kwargs = kwargs
        self._clients: list[Optional[obs.ReqClient]] = [None] * self.size
        self._client_locks = [threading.Lock() for _ in range(self.size)]
        self._last_connect_attempt = [0.0] * self.size
        self.min_reconnect_interval = 2.0

        # Circuit-breaker state per slot
        self._consecutive_failures = [0] * self.size
        self._circuit_open_until = [0.0] * self.size

        # Round-robin index
        self._next_idx = 0
        self._idx_lock = threading.Lock()

        # Separate healthcheck client
        self._healthcheck_client: Optional[obs.ReqClient] = None
        self._healthcheck_lock = threading.Lock()

        logger.background(f"Initialized OBSConnectionPool with size {self.size}")

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def connect_all(self) -> bool:
        """Initialise all client objects in the pool."""
        time.sleep(2)
        for i in range(self.size):
            self._attempt_connect(i, initial=True)
        return True

    def disconnect_all(self) -> None:
        """Disconnect every client including the healthcheck client."""
        for i in range(self.size):
            self._invalidate_client(i)
        self.reset_healthcheck_client()
        logger.info("Disconnected all clients in OBSConnectionPool.")

    # ------------------------------------------------------------------
    # Internal connect / disconnect helpers
    # ------------------------------------------------------------------

    def _disconnect_client_instance(self, client: Optional[obs.ReqClient]) -> None:
        if not client:
            return
        try:
            client.disconnect()
        except Exception:
            pass

    def _invalidate_client(self, index: int, reset_backoff: bool = False) -> None:
        client = self._clients[index]
        self._disconnect_client_instance(client)
        self._clients[index] = None
        if reset_backoff:
            self._last_connect_attempt[index] = 0.0
            self._consecutive_failures[index] = 0
            self._circuit_open_until[index] = 0.0

    def _attempt_connect(self, index: int, initial: bool = False) -> bool:
        """Try to connect a specific slot, respecting cooldown and circuit-breaker."""
        now = time.time()

        # Circuit-breaker: if open, refuse until cooldown expires
        if self._circuit_open_until[index] > now:
            return False

        # Per-slot reconnect cooldown
        if not initial and (now - self._last_connect_attempt[index] < self.min_reconnect_interval):
            return False

        self._last_connect_attempt[index] = now

        try:
            if self._clients[index]:
                self._disconnect_client_instance(self._clients[index])

            self._clients[index] = obs.ReqClient(**self.connection_kwargs)
            self._clients[index].get_version()

            # Success — reset circuit-breaker
            self._consecutive_failures[index] = 0
            self._circuit_open_until[index] = 0.0
            return True
        except Exception as e:
            self._invalidate_client(index)
            self._consecutive_failures[index] += 1

            if self._consecutive_failures[index] >= CIRCUIT_BREAKER_FAILURE_THRESHOLD:
                self._circuit_open_until[index] = now + CIRCUIT_BREAKER_COOLDOWN_SECONDS
                logger.warning(
                    f"OBS pool slot {index}: circuit-breaker open for "
                    f"{CIRCUIT_BREAKER_COOLDOWN_SECONDS:.0f}s after "
                    f"{self._consecutive_failures[index]} consecutive failures"
                )
            else:
                # Exponential-ish backoff per slot (0.2s, 0.4s, 0.6s … capped)
                delay = _get_obs_retry_delay_seconds(self._consecutive_failures[index] - 1)
                time.sleep(delay)

            if self._consecutive_failures[index] <= 1:
                logger.error(f"Failed to create client {index} in pool: {e}")
            return False

    # ------------------------------------------------------------------
    # Client acquisition
    # ------------------------------------------------------------------

    @contextlib.contextmanager
    def get_client(self):
        """Context manager: acquire a pooled client via round-robin."""
        with self._idx_lock:
            idx = self._next_idx
            self._next_idx = (self._next_idx + 1) % self.size

        lock = self._client_locks[idx]
        acquired = lock.acquire(timeout=5)
        if not acquired:
            raise TimeoutError("Could not acquire OBS client lock.")

        try:
            if self._clients[idx] is None:
                self._attempt_connect(idx)

            if self._clients[idx] is None:
                raise ConnectionError("OBS Client unavailable")

            yield self._clients[idx]

        except Exception as e:
            logger.debug(f"Error during OBS client usage (Slot {idx}): {e}")
            self._invalidate_client(idx, reset_backoff=True)
            raise
        finally:
            lock.release()

    def call(
        self,
        operation: Callable[[obs.ReqClient], object],
        retries: int = 0,
        retryable: bool = True,
    ):
        """Execute *operation* with bounded retries."""
        attempts = 1 + max(0, retries if retryable else 0)
        last_exception: Optional[Exception] = None
        for attempt_index in range(attempts):
            try:
                with self.get_client() as client:
                    return operation(client)
            except Exception as exc:
                last_exception = exc
                if not retryable or attempt_index >= attempts - 1 or not _is_retryable_obs_exception(exc):
                    raise
                time.sleep(_get_obs_retry_delay_seconds(attempt_index))
        raise last_exception  # type: ignore[misc]

    # ------------------------------------------------------------------
    # Healthcheck client (separate from pool)
    # ------------------------------------------------------------------

    def get_healthcheck_client(self) -> Optional[obs.ReqClient]:
        """Return a dedicated client used only for connection health probes."""
        with self._healthcheck_lock:
            if self._healthcheck_client is None:
                try:
                    self._healthcheck_client = obs.ReqClient(**self.connection_kwargs)
                except Exception:
                    self._healthcheck_client = None
            return self._healthcheck_client

    def reset_healthcheck_client(self) -> None:
        with self._healthcheck_lock:
            self._disconnect_client_instance(self._healthcheck_client)
            self._healthcheck_client = None
