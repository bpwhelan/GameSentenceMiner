"""OBSService, connection management, state, events, and background loop."""

import asyncio
import contextlib
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

import obsws_python as obs
from obsws_python.util import to_snake_case

from GameSentenceMiner.util.config.configuration import (
    get_config,
    get_master_config,
    gsm_state,
    gsm_status,
    is_windows,
    logger,
    save_full_config,
)

from GameSentenceMiner.obs.launch import (
    _queue_error_for_gui,
    get_obs_websocket_config_values,
    get_preferred_video_source,
    is_helper_scene_name,
    is_helper_source_name,
    is_image_empty,
)

# ---------------------------------------------------------------------------
# Retry helpers
# ---------------------------------------------------------------------------
OBS_DEFAULT_RETRY_COUNT = 2
OBS_RETRY_BASE_DELAY_SECONDS = 0.2
OBS_RETRY_MAX_DELAY_SECONDS = 0.75
OBS_RETRYABLE_ERROR_SUBSTRINGS = (
    "broken pipe",
    "connection aborted",
    "connection closed",
    "connection refused",
    "connection reset",
    "not identified",
    "session invalid",
    "socket is already closed",
    "timed out",
    "timeout",
    "transport endpoint",
    "websocket",
)
OBS_SERVICE_REFRESH_COOLDOWN_SECONDS = 2.0
_obs_service_refresh_lock = threading.Lock()
_last_obs_service_refresh_attempt = 0.0


def _get_obs_retry_delay_seconds(attempt_index: int) -> float:
    return min(OBS_RETRY_BASE_DELAY_SECONDS * (attempt_index + 1), OBS_RETRY_MAX_DELAY_SECONDS)


def _is_retryable_obs_exception(exc: Exception) -> bool:
    if isinstance(exc, AttributeError):
        return False
    message = str(exc).lower()
    if isinstance(exc, obs.error.OBSSDKRequestError):
        request_name = str(getattr(exc, "req_name", "") or "").lower()
        request_code = getattr(exc, "code", None)
        if request_name == "getsourcescreenshot" and (request_code == 702 or "failed to render screenshot" in message):
            return True
    retryable_types = (
        BrokenPipeError,
        ConnectionAbortedError,
        ConnectionError,
        ConnectionRefusedError,
        ConnectionResetError,
        EOFError,
        OSError,
        TimeoutError,
        socket.timeout,
        obs.error.OBSSDKTimeoutError,
    )
    if isinstance(exc, retryable_types):
        return True
    if isinstance(exc, (obs.error.OBSSDKError, obs.error.OBSSDKRequestError)):
        return any(token in message for token in OBS_RETRYABLE_ERROR_SUBSTRINGS)
    return any(token in message for token in OBS_RETRYABLE_ERROR_SUBSTRINGS)


def _is_obs_recording_disabled(config_override=None) -> bool:
    cfg = config_override or get_config()
    return bool(getattr(cfg.obs, "disable_recording", False))


# ---------------------------------------------------------------------------
# OBSConnectionPool — thin wrapper around a single client for compat
# ---------------------------------------------------------------------------
class OBSConnectionPool:
    """Thread-safe pool of OBS WebSocket connections.

    Maintains *size* ``ReqClient`` instances behind individual locks and
    round-robins ``get_client`` / ``call`` across them so concurrent callers
    don't block each other.  When *size* is 1 the behaviour is identical to a
    single-client setup.
    """

    def __init__(self, size=1, **kwargs):
        self.size = max(1, size)
        self.connection_kwargs = kwargs
        self._clients: list[Optional[obs.ReqClient]] = [None] * self.size
        self._locks: list[threading.Lock] = [threading.Lock() for _ in range(self.size)]
        self._index = 0
        self._index_lock = threading.Lock()
        self._healthcheck_client: Optional[obs.ReqClient] = None
        self._healthcheck_lock = threading.Lock()
        self.connected_once = False
        self.last_error_shown: list = [None]
        self.min_reconnect_interval = 2.0
        self._last_connect_attempt = 0.0
        logger.background(f"Initialized OBSConnectionPool with size {self.size}")

    # -- connection lifecycle ------------------------------------------------

    def connect_all(self):
        time.sleep(2)
        for idx in range(self.size):
            self._attempt_connect_slot(idx, initial=True)
        return True

    def _disconnect_client_instance(self, client):
        if not client:
            return
        try:
            client.disconnect()
        except Exception:
            pass

    def _attempt_connect_slot(self, idx, initial=False):
        now = time.time()
        if not initial and (now - self._last_connect_attempt < self.min_reconnect_interval):
            return False
        self._last_connect_attempt = now
        try:
            self._disconnect_client_instance(self._clients[idx])
            client = obs.ReqClient(**self.connection_kwargs)
            client.get_version()
            self._clients[idx] = client
            self.connected_once = True
            self.last_error_shown = [None]
            return True
        except Exception as e:
            self._disconnect_client_instance(self._clients[idx])
            self._clients[idx] = None
            err_str = str(e)
            if err_str != (self.last_error_shown[0] if self.last_error_shown else None):
                if self.connected_once:
                    logger.error(f"Failed to create OBS client: {e}")
                self.last_error_shown = [err_str]
            time.sleep(0.5)
            return False

    def disconnect_all(self):
        for idx in range(self.size):
            with self._locks[idx]:
                self._disconnect_client_instance(self._clients[idx])
                self._clients[idx] = None
        self.reset_healthcheck_client()
        logger.info("Disconnected OBS clients.")

    # -- client access -------------------------------------------------------

    def _next_index(self) -> int:
        with self._index_lock:
            idx = self._index % self.size
            self._index += 1
            return idx

    @contextlib.contextmanager
    def get_client(self):
        idx = self._next_index()
        acquired = self._locks[idx].acquire(timeout=5)
        if not acquired:
            raise TimeoutError("Could not acquire OBS client lock.")
        try:
            if self._clients[idx] is None:
                self._attempt_connect_slot(idx)
            if self._clients[idx] is None:
                raise ConnectionError("OBS Client unavailable")
            yield self._clients[idx]
        except Exception as e:
            logger.debug(f"Error during OBS client usage: {e}")
            self._disconnect_client_instance(self._clients[idx])
            self._clients[idx] = None
            raise
        finally:
            self._locks[idx].release()

    def call(self, operation: Callable, retries: int = 0, retryable: bool = True):
        attempts = 1 + max(0, retries if retryable else 0)
        last_exception = None
        for attempt_index in range(attempts):
            try:
                with self.get_client() as client:
                    return operation(client)
            except Exception as exc:
                last_exception = exc
                if not retryable or attempt_index >= attempts - 1 or not _is_retryable_obs_exception(exc):
                    raise
                time.sleep(_get_obs_retry_delay_seconds(attempt_index))
        raise last_exception

    # -- healthcheck ---------------------------------------------------------

    def get_healthcheck_client(self):
        with self._healthcheck_lock:
            if self._healthcheck_client is None:
                try:
                    self._healthcheck_client = obs.ReqClient(**self.connection_kwargs)
                except Exception:
                    self._healthcheck_client = None
            return self._healthcheck_client

    def reset_healthcheck_client(self):
        with self._healthcheck_lock:
            self._disconnect_client_instance(self._healthcheck_client)
            self._healthcheck_client = None


# ---------------------------------------------------------------------------
# Minimal state dataclass
# ---------------------------------------------------------------------------
@dataclass
class OBSState:
    current_scene: str = ""
    scene_items_by_scene: Dict[str, List[dict]] = field(default_factory=dict)
    input_active_by_name: Dict[str, bool] = field(default_factory=dict)
    input_show_by_name: Dict[str, bool] = field(default_factory=dict)
    input_settings_by_name: Dict[str, dict] = field(default_factory=dict)
    output_state_by_name: Dict[str, dict] = field(default_factory=dict)
    replay_buffer_output_name: str = "Replay Buffer"
    replay_buffer_active: Optional[bool] = None
    record_active: Optional[bool] = None
    current_source_name: Optional[str] = None


# ---------------------------------------------------------------------------
# Tick intervals & options
# ---------------------------------------------------------------------------
@dataclass
class OBSTickIntervals:
    refresh_current_scene_seconds: float = 5.0
    refresh_scene_items_seconds: float = 5.0
    fit_to_screen_seconds: float = 20.0
    output_probe_seconds: float = 10.0
    replay_buffer_seconds: float = 5.0
    full_state_refresh_seconds: float = 15.0


@dataclass
class OBSTickOptions:
    refresh_current_scene: Optional[bool] = None
    refresh_scene_items: Optional[bool] = None
    fit_to_screen: Optional[bool] = None
    output_probe: Optional[bool] = None
    manage_replay_buffer: Optional[bool] = None
    refresh_full_state: Optional[bool] = None
    force: bool = False


# ---------------------------------------------------------------------------
# OBSService
# ---------------------------------------------------------------------------
class OBSService:
    def __init__(self, host, port, password, connections=2, check_output=False):
        self.host = host
        self.port = port
        self.password = password
        self.connections = connections
        self.check_output = check_output

        self._pool_kwargs = {"host": host, "port": port, "password": password, "timeout": 3}
        self._event_client_kwargs = {"host": host, "port": port, "password": password, "timeout": 1}

        self.connection_pool = OBSConnectionPool(size=connections, **self._pool_kwargs)
        self.connection_pool.connect_all()

        self.event_client = obs.EventClient(**self._event_client_kwargs)

        self.state = OBSState()
        self._state_lock = threading.Lock()
        self._event_handlers: Dict[str, List[Callable]] = {}
        self._event_callbacks: Dict[str, Callable] = {}
        self._handler_accepts_event_name: Dict[Callable, bool] = {}
        self._scene_observed_handlers: List[Callable[[str], None]] = []

        # Replay buffer management
        self._replay_buffer_action_pending: Optional[bool] = None
        self._replay_buffer_action_pending_deadline = 0.0
        self._last_replay_buffer_action_timestamp = 0.0
        self._recent_replay_buffer_start_deadline = 0.0
        self._recent_replay_buffer_stop_deadline = 0.0
        self._replay_buffer_action_grace_seconds = 8.0
        self._source_no_output_timestamp: Optional[float] = None
        self._no_output_shutdown_seconds = 300
        self._initial_replay_check_done = False
        self._auto_start_paused_by_external_replay_stop = False
        self._connection_grace_deadline = 0.0

        # Fit-to-screen delayed timer
        self._fit_timer: Optional[threading.Timer] = None
        self._fit_to_screen_grace_deadline = 0.0

        # Tick scheduling & guards
        self.tick_intervals = OBSTickIntervals()
        self._tick_last_run_by_operation: Dict[str, float] = {}
        self._tick_running = False

        # Scene-item refresh debounce
        self._pending_scene_item_refresh: Optional[str] = None
        self._scene_item_refresh_deadline = 0.0
        self._scene_item_debounce_seconds = 2.0

        self._register_default_handlers()
        self.initialized = False
        self._initialize_state()

    # -- lifecycle -----------------------------------------------------------

    def disconnect(self):
        try:
            if self.event_client:
                self.event_client.disconnect()
        except Exception:
            pass
        try:
            if self.connection_pool:
                self.connection_pool.disconnect_all()
        except Exception:
            pass

    def refresh_after_reconnect(self) -> bool:
        old_pool = self.connection_pool
        old_event_client = self.event_client
        new_pool = None
        new_event_client = None
        try:
            new_pool = OBSConnectionPool(size=self.connections, **self._pool_kwargs)
            new_pool.connect_all()
            new_event_client = obs.EventClient(**self._event_client_kwargs)
            self.connection_pool = new_pool
            self.event_client = new_event_client
            self._event_callbacks = {}
            for event_name in list(self._event_handlers):
                self._ensure_event_callback(event_name)
            self._auto_start_paused_by_external_replay_stop = False
            self._replay_buffer_action_pending = None
            self._last_replay_buffer_action_timestamp = 0.0
            self._recent_replay_buffer_start_deadline = 0.0
            self._recent_replay_buffer_stop_deadline = 0.0
            self.initialized = False
            self._initialize_state()
            logger.info("Refreshed OBS clients after reconnect.")
            return True
        except Exception as e:
            logger.warning(f"Failed to refresh OBS clients after reconnect: {e}")
            if new_event_client:
                try:
                    new_event_client.disconnect()
                except Exception:
                    pass
            if new_pool:
                try:
                    new_pool.disconnect_all()
                except Exception:
                    pass
            return False
        finally:
            if self.connection_pool is new_pool:
                try:
                    if old_event_client:
                        old_event_client.disconnect()
                except Exception:
                    pass
                try:
                    if old_pool:
                        old_pool.disconnect_all()
                except Exception:
                    pass

    # -- event registration --------------------------------------------------

    def on(self, event_name: str, handler: Callable):
        handlers = self._event_handlers.setdefault(event_name, [])
        if handler not in handlers:
            handlers.append(handler)
        self._ensure_event_callback(event_name)

    def off(self, event_name: str, handler: Callable):
        handlers = self._event_handlers.get(event_name, [])
        if handler in handlers:
            handlers.remove(handler)

    def _ensure_event_callback(self, event_name: str):
        if event_name in self._event_callbacks:
            return

        def _handler(data):
            self._dispatch_event(event_name, data)

        _handler.__name__ = f"on_{to_snake_case(event_name)}"
        self.event_client.callback.register(_handler)
        self._event_callbacks[event_name] = _handler

    def _dispatch_event(self, event_name: str, data):
        handlers = list(self._event_handlers.get(event_name, []))
        for handler in handlers:
            self._safe_call_handler(handler, event_name, data)

    def _safe_call_handler(self, handler: Callable, event_name: str, data):
        accepts_event_name = self._handler_accepts_event_name.get(handler)
        if accepts_event_name is None:
            try:
                handler(event_name, data)
                accepts_event_name = True
            except TypeError:
                accepts_event_name = False
                handler(data)
            self._handler_accepts_event_name[handler] = accepts_event_name
            return
        if accepts_event_name:
            handler(event_name, data)
        else:
            handler(data)

    def on_scene_observed(self, handler: Callable[[str], None]):
        if handler not in self._scene_observed_handlers:
            self._scene_observed_handlers.append(handler)

    def off_scene_observed(self, handler: Callable[[str], None]):
        if handler in self._scene_observed_handlers:
            self._scene_observed_handlers.remove(handler)

    def _notify_scene_observed(self, scene_name: str):
        if not scene_name:
            return
        for handler in list(self._scene_observed_handlers):
            try:
                handler(scene_name)
            except Exception as e:
                logger.debug(f"Scene observed handler failed for '{scene_name}': {e}")

    # -- state init ----------------------------------------------------------

    def _initialize_state(self):
        try:

            def _init(client):
                response = client.get_current_program_scene()
                scene_name = response.scene_name if response else ""
                with self._state_lock:
                    self.state.current_scene = scene_name
                if scene_name:
                    gsm_state.current_game = scene_name
                self._refresh_scene_items(scene_name, client=client)

                outputs = client.get_output_list()
                outputs = outputs.outputs if outputs else []
                self._update_output_cache(outputs)

                try:
                    replay_status = client.get_replay_buffer_status()
                    with self._state_lock:
                        self.state.replay_buffer_active = replay_status.output_active if replay_status else None
                except Exception:
                    pass

                if self.check_output:
                    self._refresh_replay_buffer_settings(client=client)

                self._fit_to_screen_grace_deadline = time.time() + 60.0
                self._connection_grace_deadline = time.monotonic() + 15.0
                self.initialized = True

            self.connection_pool.call(_init, retries=OBS_DEFAULT_RETRY_COUNT)
        except Exception as e:
            logger.error(f"Failed to initialize OBS state: {e}")

    # -- default event handlers ----------------------------------------------

    def _register_default_handlers(self):
        self.on("CurrentProgramSceneChanged", self._handle_current_program_scene_changed)
        self.on("SceneItemCreated", self._handle_scene_item_change)
        self.on("SceneItemRemoved", self._handle_scene_item_change)
        self.on("SceneItemEnableStateChanged", self._handle_scene_item_change)
        self.on("SceneNameChanged", self._handle_scene_name_changed)
        self.on("InputActiveStateChanged", self._handle_input_active_state_changed)
        self.on("InputShowStateChanged", self._handle_input_show_state_changed)
        self.on("ReplayBufferStateChanged", self._handle_replay_buffer_state_changed)
        self.on("RecordStateChanged", self._handle_record_state_changed)
        self.on("RecordFileChanged", self._handle_record_file_changed)

    def _handle_current_program_scene_changed(self, data):
        logger.info("Handling CurrentProgramSceneChanged event." + str(data))
        scene_name = getattr(data, "scene_name", "")
        if not scene_name:
            return

        with self._state_lock:
            self.state.current_scene = scene_name
            self.state.current_source_name = None

        gsm_state.current_game = scene_name

        try:
            self._refresh_scene_items(scene_name)
        except Exception as e:
            logger.debug(f"Scene change refresh failed: {e}")

        # Schedule a delayed fit-to-screen (2s) so OBS has time to settle
        self._schedule_fit_to_screen(scene_name, delay=2.0)

        if self.check_output:
            self._source_no_output_timestamp = None
            self._initial_replay_check_done = False
            # Run source reconciliation + replay buffer check immediately
            try:
                self._periodic_work(force=True)
            except Exception as e:
                logger.debug(f"Post-scene-change periodic work failed: {e}")

    def _handle_scene_item_change(self, data):
        scene_name = getattr(data, "scene_name", None)
        if not scene_name:
            return
        try:
            self._refresh_scene_items(scene_name)
            self._enforce_helper_scene_items_disabled(scene_name)
        except Exception as e:
            logger.debug(f"Scene item refresh failed: {e}")

    def _handle_scene_name_changed(self, data):
        old_name = getattr(data, "old_scene_name", None)
        new_name = getattr(data, "scene_name", None)
        if not old_name or not new_name:
            return
        with self._state_lock:
            if old_name in self.state.scene_items_by_scene:
                self.state.scene_items_by_scene[new_name] = self.state.scene_items_by_scene.pop(old_name)
            if self.state.current_scene == old_name:
                self.state.current_scene = new_name
                gsm_state.current_game = new_name

    def _handle_input_active_state_changed(self, data):
        logger.debug(f"InputActiveStateChanged event data: {data}")
        input_name = getattr(data, "input_name", None)
        is_active = getattr(data, "video_active", None)
        if input_name is None or is_active is None:
            return
        with self._state_lock:
            self.state.input_active_by_name[input_name] = bool(is_active)

    def _handle_input_show_state_changed(self, data):
        logger.debug(f"InputShowStateChanged event data: {data}")
        input_name = getattr(data, "input_name", None)
        is_showing = getattr(data, "video_showing", None)
        if input_name is None or is_showing is None:
            return
        with self._state_lock:
            self.state.input_show_by_name[input_name] = bool(is_showing)

    def _handle_replay_buffer_state_changed(self, data):

        output_active = getattr(data, "output_active", None)
        if output_active is None:
            return

        now = time.monotonic()
        expected = self._replay_buffer_action_pending
        recent_internal_action = (
            now - self._last_replay_buffer_action_timestamp
        ) <= self._replay_buffer_action_grace_seconds
        recent_matching_internal_action = (
            now <= self._recent_replay_buffer_start_deadline
            if bool(output_active)
            else now <= self._recent_replay_buffer_stop_deadline
        )
        internal_change = recent_matching_internal_action or (expected is None and recent_internal_action)

        if expected is not None:
            if bool(output_active) == bool(expected):
                self._replay_buffer_action_pending = None
                self._replay_buffer_action_pending_deadline = 0.0
                internal_change = True
            elif now > self._replay_buffer_action_pending_deadline:
                logger.warning(
                    f"Replay buffer state ({bool(output_active)}) differed from requested state ({bool(expected)})."
                )
                self._replay_buffer_action_pending = None
                self._replay_buffer_action_pending_deadline = 0.0

        within_connection_grace = time.monotonic() <= self._connection_grace_deadline

        if bool(output_active):
            self._auto_start_paused_by_external_replay_stop = False
        elif internal_change or within_connection_grace:
            self._auto_start_paused_by_external_replay_stop = False
            if within_connection_grace and not internal_change:
                logger.debug("Ignoring replay buffer stop during connection grace period.")
        else:
            logger.info(
                "Replay buffer was stopped outside GSM; auto-start is paused until replay buffer is started again."
            )
            self._auto_start_paused_by_external_replay_stop = True

        with self._state_lock:
            self.state.replay_buffer_active = bool(output_active)

    def _handle_record_state_changed(self, data):
        import GameSentenceMiner.obs as _obs_pkg

        output_active = getattr(data, "output_active", None)
        output_path = getattr(data, "output_path", None)
        with self._state_lock:
            if output_active is not None:
                self.state.record_active = bool(output_active)
        _obs_pkg.longplay_handler.on_record_state_changed(output_active=output_active, output_path=output_path)

    def _handle_record_file_changed(self, data):
        import GameSentenceMiner.obs as _obs_pkg

        new_output_path = getattr(data, "new_output_path", None)
        _obs_pkg.longplay_handler.on_record_file_changed(new_output_path)

    # -- replay buffer helpers -----------------------------------------------

    def mark_replay_buffer_action(self, expected_state: Optional[bool] = None):
        now = time.monotonic()
        deadline = now + self._replay_buffer_action_grace_seconds
        self._last_replay_buffer_action_timestamp = now
        self._replay_buffer_action_pending = expected_state
        self._replay_buffer_action_pending_deadline = deadline if expected_state is not None else 0.0
        if expected_state is True:
            self._recent_replay_buffer_start_deadline = deadline
        elif expected_state is False:
            self._recent_replay_buffer_stop_deadline = deadline
        else:
            self._recent_replay_buffer_start_deadline = deadline
            self._recent_replay_buffer_stop_deadline = deadline

    def _can_auto_start_replay_buffer(self) -> bool:
        if not self._auto_start_paused_by_external_replay_stop:
            return True
        logger.debug("Skipping replay buffer auto-start because it was stopped outside GSM.")
        return False

    def _get_replay_buffer_active(self) -> Optional[bool]:
        with self._state_lock:
            rba = self.state.replay_buffer_active
        if rba is not None:
            return rba
        from GameSentenceMiner.obs.actions import get_replay_buffer_status

        rba = get_replay_buffer_status()
        if rba is not None:
            rba = bool(rba)
            with self._state_lock:
                self.state.replay_buffer_active = rba
        return rba

    # -- scene items & source helpers ----------------------------------------

    def _get_scene_items_for_scene(self, scene_name: str) -> List[dict]:
        if not scene_name:
            return []
        with self._state_lock:
            cached = self.state.scene_items_by_scene.get(scene_name)
            if cached is not None:
                return list(cached)
        self._refresh_scene_items(scene_name)
        with self._state_lock:
            return list(self.state.scene_items_by_scene.get(scene_name, []))

    def _refresh_scene_items(self, scene_name: str, client=None):
        if not scene_name:
            return
        if client is None:
            response = self.connection_pool.call(
                lambda c: c.get_scene_item_list(name=scene_name),
                retries=OBS_DEFAULT_RETRY_COUNT,
            )
        else:
            response = client.get_scene_item_list(name=scene_name)

        if response is None or not hasattr(response, "scene_items"):
            type_name = (
                getattr(response, "__name__", None) or type(response).__name__ if response is not None else "None"
            )
            logger.warning(f"OBS returned unexpected scene item list response for '{scene_name}': {type_name}")
            return

        scene_items = response.scene_items if response else []
        with self._state_lock:
            self.state.scene_items_by_scene[scene_name] = scene_items
            if scene_name == self.state.current_scene:
                self.state.current_source_name = self._pick_source_name(scene_items)

    def _enforce_helper_scene_items_disabled(self, scene_name: str):
        if not scene_name:
            return

        scene_items = self._get_scene_items_for_scene(scene_name)
        helper_items = [
            item
            for item in scene_items
            if bool(item.get("sceneItemEnabled", True))
            and (is_helper_scene_name(scene_name) or is_helper_source_name(item.get("sourceName")))
        ]
        if helper_items:
            self._set_scene_items_enabled(scene_name, helper_items, False)

    def _set_scene_items_enabled(self, scene_name: str, scene_items: List[dict], enabled: bool):
        if not scene_name or not scene_items:
            return
        requested_enabled = bool(enabled)
        items_to_update = []
        desired_enabled_by_item_id = {}

        for item in scene_items:
            item_id = item.get("sceneItemId")
            if item_id is None:
                continue

            source_name = item.get("sourceName")
            desired_enabled = requested_enabled
            if requested_enabled and (is_helper_scene_name(scene_name) or is_helper_source_name(source_name)):
                desired_enabled = False

            if bool(item.get("sceneItemEnabled", True)) == desired_enabled:
                continue

            items_to_update.append(item)
            desired_enabled_by_item_id[item_id] = desired_enabled

        if not items_to_update:
            return

        def _update(client):
            for item in items_to_update:
                item_id = item.get("sceneItemId")
                if item_id is None:
                    continue
                client.set_scene_item_enabled(scene_name, item_id, desired_enabled_by_item_id[item_id])

        self.connection_pool.call(_update, retries=OBS_DEFAULT_RETRY_COUNT)

        with self._state_lock:
            cached_items = self.state.scene_items_by_scene.get(scene_name, [])
            cached_items_by_id = {item.get("sceneItemId"): item for item in cached_items}
            for item in items_to_update:
                item_id = item.get("sceneItemId")
                desired_enabled = desired_enabled_by_item_id[item_id]
                item["sceneItemEnabled"] = desired_enabled
                cached_item = cached_items_by_id.get(item_id)
                if cached_item is not None:
                    cached_item["sceneItemEnabled"] = desired_enabled
                source_name = item.get("sourceName")
                if source_name:
                    self.state.input_show_by_name[source_name] = desired_enabled

    def _pick_source_name(self, scene_items: List[dict]) -> Optional[str]:
        if not scene_items:
            return None
        preferred = get_preferred_video_source(
            scene_items,
            input_active_by_name=self.state.input_active_by_name,
            input_show_by_name=self.state.input_show_by_name,
        )
        if preferred:
            return preferred.get("sourceName")
        return scene_items[0].get("sourceName")

    def _update_output_cache(self, outputs: List[dict]):
        with self._state_lock:
            self.state.output_state_by_name = {
                output.get("outputName"): output for output in outputs if output.get("outputName")
            }
            for output in outputs:
                if output.get("outputKind") == "replay_buffer":
                    self.state.replay_buffer_output_name = output.get("outputName")
                    break

    def _refresh_replay_buffer_settings(self, client=None):
        from GameSentenceMiner.obs.actions import (
            _get_replay_buffer_max_time_seconds_from_client,
            get_replay_buffer_max_time_seconds,
            get_replay_buffer_output,
        )

        output_name = self.state.replay_buffer_output_name
        if client is None:
            buffer_seconds = get_replay_buffer_max_time_seconds(name=output_name)
        else:
            buffer_seconds = _get_replay_buffer_max_time_seconds_from_client(client, name=output_name)

        if not buffer_seconds:
            replay_output = get_replay_buffer_output(client=client)
            if not replay_output:
                _queue_error_for_gui(
                    "OBS Replay Buffer Error",
                    "Replay Buffer output not found in OBS. Please enable Replay Buffer In OBS Settings -> Output -> Replay Buffer. I recommend 300 seconds (5 minutes) or higher.\n\nTo disable this message, turn off 'Automatically Manage Replay Buffer' in GSM settings.",
                    recheck_function=get_replay_buffer_output,
                )
                return
            output_name = replay_output.get("outputName") or output_name
            self.state.replay_buffer_output_name = output_name

        gsm_state.replay_buffer_length = buffer_seconds or 300
        self._no_output_shutdown_seconds = min(buffer_seconds * 1.10, 1800)

        if client is None:
            try:
                replay_status = self.connection_pool.call(
                    lambda c: c.get_replay_buffer_status(),
                    retries=OBS_DEFAULT_RETRY_COUNT,
                )
            except Exception:
                replay_status = None
        else:
            replay_status = client.get_replay_buffer_status()

        if replay_status:
            with self._state_lock:
                self.state.replay_buffer_active = replay_status.output_active

    # -- source probing ------------------------------------------------------

    def _is_output_active_from_screenshot(self) -> Optional[bool]:
        from GameSentenceMiner.obs.actions import get_screenshot_PIL

        img = get_screenshot_PIL(compression=50, img_format="jpg", width=8, height=8)
        if not img:
            return None
        return not is_image_empty(img)

    # -- fit-to-screen -------------------------------------------------------

    def _schedule_fit_to_screen(self, scene_name: str, delay: float = 2.0):
        if self._fit_timer is not None:
            self._fit_timer.cancel()

        def _do_fit():
            try:
                from GameSentenceMiner.obs.actions import set_fit_to_screen_for_scene_items

                set_fit_to_screen_for_scene_items(scene_name)
            except Exception as e:
                logger.debug(f"Delayed fit-to-screen failed: {e}")

        self._fit_timer = threading.Timer(delay, _do_fit)
        self._fit_timer.daemon = True
        self._fit_timer.start()

    # -- periodic work (called from OBSConnectionManager) --------------------

    def _periodic_work(self, force=False):
        """Runs output probing + replay buffer management."""
        if not self.initialized:
            self._initialize_state()

        with self._state_lock:
            current_scene = self.state.current_scene

        if not current_scene:
            return

        source_active = None
        try:
            source_active = self._is_output_active_from_screenshot()
        except Exception:
            pass

        if not self.check_output:
            return

        if source_active is None:
            return

        if _is_obs_recording_disabled():
            return

        replay_buffer_active = self._get_replay_buffer_active()

        if replay_buffer_active is False and not self._initial_replay_check_done:
            self._initial_replay_check_done = True
            if not source_active:
                return

        if not get_config().obs.automatically_manage_replay_buffer:
            return

        from GameSentenceMiner.obs.actions import start_replay_buffer, stop_replay_buffer

        now = time.time()
        if source_active:
            self._source_no_output_timestamp = None
            if replay_buffer_active is not True and self._can_auto_start_replay_buffer():
                start_replay_buffer()
            return

        if replay_buffer_active:
            if self._source_no_output_timestamp is None:
                self._source_no_output_timestamp = now
            elif now - self._source_no_output_timestamp >= self._no_output_shutdown_seconds:
                stop_replay_buffer()
                self._source_no_output_timestamp = None

    # -- tick scheduling -----------------------------------------------------

    def build_scheduled_tick_options(self, now=None, overrides=None):
        now = time.time() if now is None else now
        overrides = overrides or OBSTickOptions()
        tick_intervals = self.tick_intervals

        def _is_due(op_name, interval):
            if overrides.force or interval <= 0:
                return True
            last = self._tick_last_run_by_operation.get(op_name)
            return last is None or (now - last) >= interval

        def resolve(override_val, op_name, interval):
            if override_val is not None:
                return override_val
            return _is_due(op_name, interval)

        # fit_to_screen: only due if within grace window or force
        fit_due = False
        if overrides.fit_to_screen is not None:
            fit_due = overrides.fit_to_screen
        elif overrides.force:
            fit_due = True
        elif now <= getattr(self, "_fit_to_screen_grace_deadline", 0):
            fit_due = _is_due("fit_to_screen", tick_intervals.fit_to_screen_seconds)

        return OBSTickOptions(
            refresh_current_scene=resolve(
                overrides.refresh_current_scene,
                "refresh_current_scene",
                tick_intervals.refresh_current_scene_seconds,
            ),
            refresh_scene_items=resolve(
                overrides.refresh_scene_items,
                "refresh_scene_items",
                tick_intervals.refresh_scene_items_seconds,
            ),
            fit_to_screen=fit_due,
            output_probe=resolve(
                overrides.output_probe,
                "output_probe",
                tick_intervals.output_probe_seconds,
            ),
            manage_replay_buffer=resolve(
                overrides.manage_replay_buffer,
                "manage_replay_buffer",
                tick_intervals.replay_buffer_seconds,
            ),
            refresh_full_state=resolve(
                overrides.refresh_full_state,
                "full_state_refresh",
                tick_intervals.full_state_refresh_seconds,
            ),
            force=overrides.force,
        )

    def has_tick_work(self, options: OBSTickOptions) -> bool:
        return any(
            getattr(options, f)
            for f in (
                "refresh_current_scene",
                "refresh_scene_items",
                "fit_to_screen",
                "output_probe",
                "manage_replay_buffer",
                "refresh_full_state",
            )
        )

    def tick(self, options=None):
        """Main tick entry point. Each operation runs on its own interval."""
        if self._tick_running:
            return
        self._tick_running = True
        try:
            self._tick_inner(options)
        finally:
            self._tick_running = False

    def _tick_inner(self, options=None):
        if not self.initialized:
            self._initialize_state()

        now = time.time()
        resolved = self.build_scheduled_tick_options(now=now, overrides=options)
        if not self.has_tick_work(resolved):
            return

        if resolved.refresh_full_state:
            self._initialize_state()
            self._tick_last_run_by_operation["full_state_refresh"] = now

        with self._state_lock:
            current_scene = self.state.current_scene

        if resolved.refresh_current_scene:
            from GameSentenceMiner.obs.actions import get_current_scene

            refreshed = get_current_scene()
            if refreshed and refreshed != current_scene:
                current_scene = refreshed
                with self._state_lock:
                    self.state.current_scene = current_scene
                    self.state.current_source_name = None
                gsm_state.current_game = current_scene
            self._notify_scene_observed(current_scene)
            self._tick_last_run_by_operation["refresh_current_scene"] = now

        if resolved.refresh_scene_items and current_scene:
            self._refresh_scene_items(current_scene)
            self._tick_last_run_by_operation["refresh_scene_items"] = now

        if resolved.fit_to_screen and current_scene:
            from GameSentenceMiner.obs.actions import set_fit_to_screen_for_scene_items

            set_fit_to_screen_for_scene_items(current_scene)
            self._tick_last_run_by_operation["fit_to_screen"] = now

        source_active = None
        if resolved.output_probe and current_scene:
            source_active = self._is_output_active_from_screenshot()
            self._tick_last_run_by_operation["output_probe"] = now

        if not self.check_output or not resolved.manage_replay_buffer:
            return
        self._tick_last_run_by_operation["manage_replay_buffer"] = now

        if source_active is None or _is_obs_recording_disabled():
            return

        replay_buffer_active = self._get_replay_buffer_active()

        if replay_buffer_active is False and not self._initial_replay_check_done:
            self._initial_replay_check_done = True
            if not source_active:
                return

        if not get_config().obs.automatically_manage_replay_buffer:
            return

        from GameSentenceMiner.obs.actions import start_replay_buffer, stop_replay_buffer

        if source_active:
            self._source_no_output_timestamp = None
            if replay_buffer_active is not True and self._can_auto_start_replay_buffer():
                start_replay_buffer()
            return

        if replay_buffer_active:
            if self._source_no_output_timestamp is None:
                self._source_no_output_timestamp = now
            elif now - self._source_no_output_timestamp >= self._no_output_shutdown_seconds:
                stop_replay_buffer()
                self._source_no_output_timestamp = None

    def _mark_tick_operation(self, operation_name: str, now: float):
        self._tick_last_run_by_operation[operation_name] = now


# ---------------------------------------------------------------------------
# Helper to call through the pool with error handling
# ---------------------------------------------------------------------------
def _bind_obs_service_clients():
    import GameSentenceMiner.obs as _obs_pkg

    if _obs_pkg.obs_service:
        _obs_pkg.connection_pool = _obs_pkg.obs_service.connection_pool
        _obs_pkg.event_client = _obs_pkg.obs_service.event_client
    else:
        _obs_pkg.connection_pool = None
        _obs_pkg.event_client = None


def _recover_obs_service_clients_sync() -> bool:
    global _last_obs_service_refresh_attempt

    import GameSentenceMiner.obs as _obs_pkg

    if _obs_pkg.connecting or not _obs_pkg.obs_service:
        return False
    now = time.monotonic()
    if (now - _last_obs_service_refresh_attempt) < OBS_SERVICE_REFRESH_COOLDOWN_SECONDS:
        return False
    if not _obs_service_refresh_lock.acquire(blocking=False):
        return False
    try:
        if _obs_pkg.connecting or not _obs_pkg.obs_service:
            return False
        if _obs_pkg.connection_pool and gsm_status.obs_connected:
            return True
        now = time.monotonic()
        if (now - _last_obs_service_refresh_attempt) < OBS_SERVICE_REFRESH_COOLDOWN_SECONDS:
            return False
        _last_obs_service_refresh_attempt = now
        recovered = _obs_pkg.obs_service.refresh_after_reconnect()
        if not recovered:
            return False
        _bind_obs_service_clients()
        gsm_status.obs_connected = True
        return True
    finally:
        _obs_service_refresh_lock.release()


def _call_with_obs_client(
    operation,
    *,
    default=None,
    error_msg=None,
    raise_exc=False,
    retryable=True,
    retries=OBS_DEFAULT_RETRY_COUNT,
    suppress_obs_errors=False,
    debug_errors=False,
    fallback=None,
):
    import GameSentenceMiner.obs as _obs_pkg

    pool = _obs_pkg.connection_pool

    if _obs_pkg.obs_service and (not pool or not gsm_status.obs_connected):
        _recover_obs_service_clients_sync()
        pool = _obs_pkg.connection_pool

    def _resolve_default():
        if fallback is not None:
            try:
                return fallback()
            except Exception:
                pass
        return default

    if not pool:
        return _resolve_default()

    try:
        effective_retries = max(0, int(retries if retryable else 0))
        return pool.call(operation, retries=effective_retries, retryable=bool(retryable))
    except Exception as e:
        if raise_exc:
            raise
        if suppress_obs_errors:
            return _resolve_default()
        if error_msg:
            if debug_errors:
                logger.debug(f"{error_msg}: {e}")
            else:
                logger.error(f"{error_msg}: {e}")
        return _resolve_default()


# ---------------------------------------------------------------------------
# OBSConnectionManager — background daemon thread
# ---------------------------------------------------------------------------
class OBSConnectionManager(threading.Thread):
    def __init__(self, check_output=False):
        super().__init__()
        self.daemon = True
        self.running = True
        self.check_connection_interval = 5.0
        self.recovery_cooldown_seconds = 2.0
        self.check_output = check_output
        self._last_recovery_attempt = 0.0
        self.last_errors = []
        self._check_lock = threading.Lock()
        self.last_tick_time = 0

    def _recover_obs_connection(self) -> bool:
        import GameSentenceMiner.obs as _obs_pkg

        now = time.monotonic()
        if _obs_pkg.connecting:
            return False
        if (now - self._last_recovery_attempt) < self.recovery_cooldown_seconds:
            return False
        self._last_recovery_attempt = now

        if _obs_pkg.connection_pool:
            try:
                _obs_pkg.connection_pool.reset_healthcheck_client()
            except Exception:
                pass

        if _obs_pkg.obs_service:
            if _recover_obs_service_clients_sync():
                logger.info("Recovered OBS WebSocket connection.")
                return True
            return False

        if not _obs_pkg.connecting:
            threading.Thread(
                target=connect_to_obs_sync,
                kwargs={"retry": 1, "check_output": self.check_output},
                daemon=True,
            ).start()
        return False

    def _check_obs_connection(self):
        import GameSentenceMiner.obs as _obs_pkg

        if _obs_pkg.connecting:
            return False
        last_error = None
        try:
            client = _obs_pkg.connection_pool.get_healthcheck_client() if _obs_pkg.connection_pool else None
            if client:
                client.get_version()
                gsm_status.obs_connected = True
                return True
            raise ConnectionError("Healthcheck client creation failed")
        except Exception as e:
            last_error = e
            if _obs_pkg.connection_pool:
                try:
                    _obs_pkg.connection_pool.reset_healthcheck_client()
                except Exception:
                    pass
            try:
                client = _obs_pkg.connection_pool.get_healthcheck_client() if _obs_pkg.connection_pool else None
                if client:
                    client.get_version()
                    gsm_status.obs_connected = True
                    return True
            except Exception as retry_error:
                last_error = retry_error
            if gsm_status.obs_connected:
                logger.info(f"OBS WebSocket connection lost: {last_error}")
            gsm_status.obs_connected = False
            return self._recover_obs_connection()

    def run(self):
        from GameSentenceMiner.util.gsm_utils import SleepManager

        import GameSentenceMiner.obs as _obs_pkg

        disconnect_sleep_manager = SleepManager(initial_delay=2.0, name="OBS_Disconnect")
        time.sleep(5)

        # Initial periodic work
        if _obs_pkg.obs_service:
            try:
                _obs_pkg.obs_service._periodic_work(force=True)
            except Exception:
                pass

        while self.running:
            if not gsm_status.obs_connected:
                disconnect_sleep_manager.sleep()
            else:
                disconnect_sleep_manager.reset()
                time.sleep(self.check_connection_interval)

            if not self._check_obs_connection():
                continue

            # Tick — each operation runs on its own interval
            with self._check_lock:
                if _obs_pkg.obs_service:
                    try:
                        _obs_pkg.obs_service.tick()
                    except Exception as e:
                        logger.debug(f"Tick failed: {e}")

            # Session expiry check
            if (
                gsm_state.replay_buffer_stopped_timestamp
                and time.time() - gsm_state.replay_buffer_stopped_timestamp > 900
            ):
                if gsm_state.disable_anki_confirmation_session:
                    gsm_state.disable_anki_confirmation_session = False
                    logger.info("Session expired: Anki confirmation re-enabled.")
                gsm_state.replay_buffer_stopped_timestamp = None

    def stop(self):
        self.running = False


# ---------------------------------------------------------------------------
# Connection lifecycle
# ---------------------------------------------------------------------------
async def connect_to_obs(
    retry=5,
    connections=2,
    check_output=False,
    healthcheck_enabled=True,
    start_manager=True,
):
    import GameSentenceMiner.obs as _obs_pkg

    if _obs_pkg.obs_service or _obs_pkg.connecting:
        return

    if is_windows():
        get_obs_websocket_config_values()

    _obs_pkg.connecting = True
    try:
        while retry > 0:
            try:
                _obs_pkg.obs_service = OBSService(
                    host=get_config().obs.host,
                    port=get_config().obs.port,
                    password=get_config().obs.password,
                    connections=connections,
                    check_output=check_output,
                )
                _bind_obs_service_clients()
                gsm_status.obs_connected = True
                logger.success("Connected to OBS WebSocket.")

                if start_manager and not _obs_pkg.obs_connection_manager:
                    _obs_pkg.obs_connection_manager = OBSConnectionManager(check_output=check_output)
                    _obs_pkg.obs_connection_manager.start()

                try:
                    from GameSentenceMiner.obs.actions import update_current_game

                    update_current_game()
                except Exception:
                    pass

                try:
                    from GameSentenceMiner.obs.actions import apply_obs_performance_settings

                    apply_obs_performance_settings()
                except Exception:
                    pass

                if get_config().features.generate_longplay and check_output and not _is_obs_recording_disabled():
                    try:
                        from GameSentenceMiner.obs.actions import start_recording

                        start_recording(True)
                    except Exception:
                        pass
                break
            except Exception as e:
                retry -= 1
                if retry <= 0:
                    gsm_status.obs_connected = False
                    logger.error(f"Failed to connect to OBS WebSocket after retries: {e}")
                    _obs_pkg.connection_pool = None
                    _obs_pkg.event_client = None
                    _obs_pkg.obs_service = None
                    break
                await asyncio.sleep(1)
    finally:
        _obs_pkg.connecting = False


def connect_to_obs_sync(retry=2, connections=2, check_output=False, healthcheck_enabled=True, start_manager=True):
    import GameSentenceMiner.obs as _obs_pkg

    if _obs_pkg.obs_service or _obs_pkg.connecting:
        return

    if is_windows():
        get_obs_websocket_config_values()

    _obs_pkg.connecting = True
    try:
        while retry > 0:
            try:
                _obs_pkg.obs_service = OBSService(
                    host=get_config().obs.host,
                    port=get_config().obs.port,
                    password=get_config().obs.password,
                    connections=connections,
                    check_output=check_output,
                )
                _bind_obs_service_clients()
                gsm_status.obs_connected = True
                logger.success("Connected to OBS WebSocket.")

                if start_manager and not _obs_pkg.obs_connection_manager:
                    _obs_pkg.obs_connection_manager = OBSConnectionManager(check_output=check_output)
                    _obs_pkg.obs_connection_manager.start()

                try:
                    from GameSentenceMiner.obs.actions import update_current_game

                    update_current_game()
                except Exception:
                    pass

                try:
                    from GameSentenceMiner.obs.actions import apply_obs_performance_settings

                    apply_obs_performance_settings()
                except Exception:
                    pass

                if get_config().features.generate_longplay and check_output and not _is_obs_recording_disabled():
                    try:
                        from GameSentenceMiner.obs.actions import start_recording

                        start_recording(True)
                    except Exception:
                        pass
                break
            except Exception as e:
                retry -= 1
                if retry <= 0:
                    gsm_status.obs_connected = False
                    logger.error(f"Failed to connect to OBS WebSocket: {e}")
                    _obs_pkg.connection_pool = None
                    _obs_pkg.event_client = None
                    _obs_pkg.obs_service = None
                    break
                time.sleep(1)
    finally:
        _obs_pkg.connecting = False


def disconnect_from_obs():
    import GameSentenceMiner.obs as _obs_pkg

    if _obs_pkg.obs_service:
        _obs_pkg.obs_service.disconnect()
        _obs_pkg.obs_service = None
    _obs_pkg.connection_pool = None
    _obs_pkg.event_client = None
    logger.info("Disconnected from OBS WebSocket.")


async def wait_for_obs_connected():
    import GameSentenceMiner.obs as _obs_pkg

    pool = _obs_pkg.connection_pool
    if not pool:
        return False
    for _ in range(10):
        try:
            client = pool.get_healthcheck_client()
            if client:
                response = client.get_version()
                if response:
                    return True
        except Exception as e:
            logger.debug(f"Waiting for OBS connection: {e}")
            await asyncio.sleep(1)
    return False


async def check_obs_folder_is_correct():
    if await wait_for_obs_connected():
        try:
            from GameSentenceMiner.obs.actions import get_record_directory

            obs_record_directory = get_record_directory()
            if obs_record_directory and os.path.normpath(obs_record_directory) != os.path.normpath(
                get_config().paths.folder_to_watch
            ):
                logger.info("OBS Path wrong, Setting OBS Recording folder in GSM Config...")
                get_config().paths.folder_to_watch = os.path.normpath(obs_record_directory)
                get_master_config().sync_shared_fields()
                save_full_config(get_master_config())
            else:
                logger.debug("OBS Recording path looks correct")
        except Exception as e:
            logger.error(f"Error checking OBS folder: {e}")


# Needed by check_obs_folder_is_correct
import os  # noqa: E402
