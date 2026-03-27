"""Centralized module-level state for the OBS integration.

All mutable singletons live here behind accessor functions so that the rest of the
package never touches bare globals directly.
"""

from __future__ import annotations

import os
import queue
import threading
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import obsws_python as obs

    from GameSentenceMiner.obs.connection import OBSConnectionPool
    from GameSentenceMiner.obs.connection_manager import OBSConnectionManager
    from GameSentenceMiner.obs.service import OBSService

from GameSentenceMiner.util.config import configuration

# ---------------------------------------------------------------------------
# Module state singleton
# ---------------------------------------------------------------------------


class _OBSModuleState:
    """Holds every piece of mutable module-level state."""

    def __init__(self) -> None:
        self.obs_service: Optional[OBSService] = None
        self.connection_pool: Optional[OBSConnectionPool] = None
        self.event_client: Optional[obs.EventClient] = None
        self.obs_process_pid: Optional[int] = None
        self.obs_connection_manager: Optional[OBSConnectionManager] = None
        self.connecting: bool = False
        self._lock = threading.Lock()


_state = _OBSModuleState()

OBS_PID_FILE = os.path.join(configuration.get_app_directory(), "obs_pid.txt")

# ---------------------------------------------------------------------------
# Accessor helpers
# ---------------------------------------------------------------------------


def get_obs_service() -> Optional[OBSService]:
    return _state.obs_service


def set_obs_service(service: Optional[OBSService]) -> None:
    _state.obs_service = service


def get_connection_pool() -> Optional[OBSConnectionPool]:
    return _state.connection_pool


def set_connection_pool(pool: Optional[OBSConnectionPool]) -> None:
    _state.connection_pool = pool


def get_event_client():
    return _state.event_client


def set_event_client(client) -> None:
    _state.event_client = client


def get_obs_process_pid() -> Optional[int]:
    return _state.obs_process_pid


def set_obs_process_pid(pid: Optional[int]) -> None:
    _state.obs_process_pid = pid


def get_obs_connection_manager() -> Optional[OBSConnectionManager]:
    return _state.obs_connection_manager


def set_obs_connection_manager(manager: Optional[OBSConnectionManager]) -> None:
    _state.obs_connection_manager = manager


def is_connecting() -> bool:
    return _state.connecting


def set_connecting(value: bool) -> None:
    _state.connecting = value


# ---------------------------------------------------------------------------
# GUI error queue (thread-safe)
# ---------------------------------------------------------------------------

_gui_error_queue: queue.Queue = queue.Queue()


def _queue_error_for_gui(title, message, recheck_function=None):
    _gui_error_queue.put((title, message, recheck_function))


def get_queued_gui_errors():
    errors = []
    try:
        while True:
            errors.append(_gui_error_queue.get_nowait())
    except queue.Empty:
        pass
    return errors
