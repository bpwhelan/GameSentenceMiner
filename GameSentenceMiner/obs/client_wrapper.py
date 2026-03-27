"""Wrapper and decorator for calling OBS operations through the connection pool."""

from __future__ import annotations

import functools
from typing import Callable, Optional

from GameSentenceMiner.obs._state import get_connection_pool, get_obs_service, is_connecting
from GameSentenceMiner.obs.types import (
    OBS_DEFAULT_RETRY_COUNT,
    _get_obs_retry_delay_seconds,
    _is_retryable_obs_exception,
)
from GameSentenceMiner.util.config.configuration import gsm_status, logger

import time


def _resolve_obs_default(default=None, fallback=None):
    if fallback is not None:
        try:
            return fallback()
        except Exception as e:
            logger.debug(f"OBS fallback resolution failed: {e}")
    return default


def _recover_obs_service_clients_sync() -> bool:
    """Attempt to refresh clients on the existing OBSService. Returns True on success."""
    from GameSentenceMiner.obs._state import set_connection_pool, set_event_client
    import GameSentenceMiner.obs as _obs_pkg

    if is_connecting():
        return False
    obs_service = getattr(_obs_pkg, "obs_service", None) or get_obs_service()
    if not obs_service:
        return False
    recovered = obs_service.refresh_after_reconnect()
    if recovered is False:
        return False
    # Re-bind module-level pool / event_client on both _state and the package
    set_connection_pool(obs_service.connection_pool)
    set_event_client(obs_service.event_client)
    _obs_pkg.connection_pool = obs_service.connection_pool
    _obs_pkg.event_client = obs_service.event_client
    gsm_status.obs_connected = True
    return True


def _call_with_pool_fallback(pool, operation, retries=0, retryable=True):
    """Fallback for pool objects that only have get_client() (e.g. test mocks)."""
    attempts = 1 + max(0, int(retries if retryable else 0))
    last_exception = None
    for attempt_index in range(attempts):
        try:
            with pool.get_client() as client:
                return operation(client)
        except Exception as exc:
            last_exception = exc
            if not retryable or attempt_index >= attempts - 1 or not _is_retryable_obs_exception(exc):
                raise
            time.sleep(_get_obs_retry_delay_seconds(attempt_index))
    raise last_exception


def _call_with_obs_client(
    operation: Callable,
    *,
    default=None,
    error_msg: Optional[str] = None,
    raise_exc: bool = False,
    retryable: bool = True,
    retries: int = OBS_DEFAULT_RETRY_COUNT,
    suppress_obs_errors: bool = False,
    debug_errors: bool = False,
    fallback=None,
):
    """Execute *operation(client)* using the module-level connection pool.

    If the pool is unavailable and an OBSService exists, attempt a single inline
    recovery.  If that fails too, return *default* — the connection manager thread
    handles long-term reconnection.
    """
    # Look up via the package module so monkeypatches (e.g. in tests) take effect
    import GameSentenceMiner.obs as _obs_pkg

    pool = getattr(_obs_pkg, "connection_pool", None) or get_connection_pool()
    obs_service = getattr(_obs_pkg, "obs_service", None) or get_obs_service()

    if obs_service and (not pool or not gsm_status.obs_connected):
        _recover_obs_service_clients_sync()
        pool = getattr(_obs_pkg, "connection_pool", None) or get_connection_pool()

    if not pool:
        return _resolve_obs_default(default=default, fallback=fallback)

    try:
        effective_retries = max(0, int(retries if retryable else 0))
        if hasattr(pool, "call") and callable(pool.call):
            return pool.call(operation, retries=effective_retries, retryable=bool(retryable))
        # Fallback for pools that only expose get_client() (e.g. test mocks)
        return _call_with_pool_fallback(pool, operation, retries=effective_retries, retryable=bool(retryable))
    except Exception as e:
        if raise_exc:
            raise

        if suppress_obs_errors:
            return _resolve_obs_default(default=default, fallback=fallback)

        if error_msg:
            if debug_errors:
                logger.debug(f"{error_msg}: {e}")
            else:
                logger.error(f"{error_msg}: {e}")

        return _resolve_obs_default(default=default, fallback=fallback)


def with_obs_client(
    default=None,
    error_msg=None,
    raise_exc=False,
    retryable=True,
    retries=OBS_DEFAULT_RETRY_COUNT,
    fallback=None,
):
    """Decorator: auto-acquire an OBS client and pass it as the first argument."""

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            suppress_obs_errors = bool(kwargs.pop("_suppress_obs_errors", False))
            override_retryable = bool(kwargs.pop("_retry_obs_errors", retryable))
            override_retries = kwargs.pop("_obs_retries", retries)
            msg = error_msg if error_msg else f"Error in {func.__name__}"
            return _call_with_obs_client(
                lambda client: func(client, *args, **kwargs),
                default=default,
                error_msg=msg,
                raise_exc=raise_exc,
                retryable=override_retryable,
                retries=override_retries,
                suppress_obs_errors=suppress_obs_errors,
                debug_errors=func.__name__ in ("get_replay_buffer_status", "get_current_scene"),
                fallback=fallback,
            )

        return wrapper

    return decorator
