import asyncio
import contextlib
import functools
import json
import logging
import obsws_python as obs
import os.path
import psutil
import queue
import socket
import shlex
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from obsws_python.util import to_snake_case
from typing import Callable, Dict, List, Optional

from GameSentenceMiner.longplay_handler import LongPlayHandler
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import (
    get_app_directory,
    get_config,
    get_master_config,
    gsm_state,
    gsm_status,
    is_windows,
    logger,
    reload_config,
    save_full_config,
)
from GameSentenceMiner.util.gsm_utils import (
    make_unique_file_name,
    sanitize_filename,
)

# Thread-safe queue for GUI error messages
_gui_error_queue = queue.Queue()


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


connection_pool: "OBSConnectionPool" = None
event_client: obs.EventClient = None
obs_service: "OBSService" = None
obs_process_pid = None
OBS_PID_FILE = os.path.join(configuration.get_app_directory(), "obs_pid.txt")
obs_connection_manager = None
logging.getLogger("obsws_python").setLevel(logging.CRITICAL)
connecting = False
longplay_handler = LongPlayHandler(
    feature_enabled_getter=lambda: bool(get_config().features.generate_longplay),
    game_name_getter=lambda: get_current_game(sanitize=True),
)


VIDEO_SOURCE_KINDS = {"window_capture", "game_capture", "monitor_capture"}
VIDEO_SOURCE_PRIORITY = {
    "game_capture": 0,
    "window_capture": 1,
    "monitor_capture": 2,
}


def get_video_source_priority(input_kind: Optional[str]) -> int:
    return VIDEO_SOURCE_PRIORITY.get(str(input_kind or ""), 999)


def sort_video_sources_by_preference(
    scene_items: List[dict],
    input_active_by_name: Optional[Dict[str, bool]] = None,
    input_show_by_name: Optional[Dict[str, bool]] = None,
) -> List[dict]:
    """
    Sort scene items so working game capture is preferred, with window capture as fallback.

    Sources explicitly marked inactive or hidden are pushed behind candidates that still have
    a chance of producing output.
    """
    if not scene_items:
        return []

    video_sources = [item for item in scene_items if item.get("inputKind") in VIDEO_SOURCE_KINDS]
    if not video_sources:
        return list(scene_items)

    def sort_key(item: dict):
        source_name = item.get("sourceName")
        active_state = input_active_by_name.get(source_name) if input_active_by_name else None
        show_state = input_show_by_name.get(source_name) if input_show_by_name else None
        explicitly_inactive = active_state is False or show_state is False
        return (
            1 if explicitly_inactive else 0,
            get_video_source_priority(item.get("inputKind")),
        )

    return sorted(video_sources, key=sort_key)


def get_preferred_video_source(
    scene_items: List[dict],
    input_active_by_name: Optional[Dict[str, bool]] = None,
    input_show_by_name: Optional[Dict[str, bool]] = None,
):
    sorted_sources = sort_video_sources_by_preference(
        scene_items,
        input_active_by_name=input_active_by_name,
        input_show_by_name=input_show_by_name,
    )
    return sorted_sources[0] if sorted_sources else None


def get_video_scene_items(scene_items: List[dict]) -> List[dict]:
    if not scene_items:
        return []
    return [item for item in scene_items if item.get("inputKind") in VIDEO_SOURCE_KINDS]


def is_image_empty(img) -> bool:
    try:
        extrema = img.getextrema()
        if not extrema:
            return True
        if isinstance(extrema[0], tuple):
            return all(channel_min == channel_max for channel_min, channel_max in extrema)
        return extrema[0] == extrema[1]
    except Exception:
        return False


HELPER_SCENE_NAMES = {"GSM Helper - DONT TOUCH"}
HELPER_SOURCE_NAMES = {"window_getter", "game_window_getter"}


def _should_skip_image_validation(source_name: Optional[str] = None, scene_name: Optional[str] = None) -> bool:
    normalized_scene_name = str(scene_name or "").strip().casefold()
    if normalized_scene_name in {name.casefold() for name in HELPER_SCENE_NAMES}:
        return True

    normalized_source_name = str(source_name or "").strip().casefold()
    return normalized_source_name in {name.casefold() for name in HELPER_SOURCE_NAMES}


def _is_obs_recording_disabled(config_override=None) -> bool:
    cfg = config_override or get_config()
    return bool(getattr(cfg.obs, "disable_recording", False))


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


def _get_obs_retry_delay_seconds(attempt_index: int) -> float:
    return min(OBS_RETRY_BASE_DELAY_SECONDS * (attempt_index + 1), OBS_RETRY_MAX_DELAY_SECONDS)


def _is_retryable_obs_exception(exc: Exception) -> bool:
    if isinstance(exc, AttributeError):
        return False

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
        message = str(exc).lower()
        return any(token in message for token in OBS_RETRYABLE_ERROR_SUBSTRINGS)

    message = str(exc).lower()
    return any(token in message for token in OBS_RETRYABLE_ERROR_SUBSTRINGS)


class OBSConnectionPool:
    """Manages a pool of thread-safe connections to the OBS WebSocket."""

    def __init__(self, size=3, **kwargs):
        self.size = size
        self.connection_kwargs = kwargs
        self._clients = [None] * self.size
        self._client_locks = [threading.Lock() for _ in range(self.size)]
        self._last_connect_attempt = [0.0] * self.size
        self.min_reconnect_interval = 2.0

        self._next_idx = 0
        self._idx_lock = threading.Lock()
        self._healthcheck_client = None
        self._healthcheck_lock = threading.Lock()

        self.connected_once = False
        self.last_error_shown = [None] * self.size
        logger.background(f"Initialized OBSConnectionPool with size {self.size}")

    def connect_all(self):
        """Initializes all client objects in the pool."""
        time.sleep(2)
        for i in range(self.size):
            self._attempt_connect(i, initial=True)
        return True

    def _disconnect_client_instance(self, client):
        if not client:
            return
        try:
            client.disconnect()
        except Exception:
            pass

    def _invalidate_client(self, index: int, reset_backoff: bool = False):
        client = self._clients[index]
        self._disconnect_client_instance(client)
        self._clients[index] = None
        if reset_backoff:
            self._last_connect_attempt[index] = 0.0

    def _attempt_connect(self, index, initial=False):
        """Internal helper to connect a specific slot with cooldown handling."""
        now = time.time()
        if not initial and (now - self._last_connect_attempt[index] < self.min_reconnect_interval):
            return False

        self._last_connect_attempt[index] = now

        try:
            if self._clients[index]:
                self._disconnect_client_instance(self._clients[index])

            self._clients[index] = obs.ReqClient(**self.connection_kwargs)
            self._clients[index].get_version()

            self.connected_once = True
            self.last_error_shown[index] = None
            return True
        except Exception as e:
            self._invalidate_client(index)
            err_str = str(e)
            if err_str != self.last_error_shown[index]:
                if self.connected_once:
                    logger.error(f"Failed to create client {index} in pool: {e}")
                self.last_error_shown[index] = err_str
            time.sleep(0.5)
            return False

    def disconnect_all(self):
        """Disconnects all clients in the pool."""
        for i in range(self.size):
            self._invalidate_client(i)
        self.reset_healthcheck_client()
        logger.info("Disconnected all clients in OBSConnectionPool.")

    @contextlib.contextmanager
    def get_client(self) -> obs.ReqClient:
        """A context manager to safely get a client from the pool."""
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
            raise e
        finally:
            lock.release()

    def call(self, operation: Callable[[obs.ReqClient], object], retries: int = 0, retryable: bool = True):
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

    def get_healthcheck_client(self):
        """Returns a dedicated client for health checks, separate from the main pool."""
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


@dataclass
class OBSState:
    current_scene: str = ""
    scene_items_by_scene: Dict[str, List[dict]] = field(default_factory=dict)
    inputs_by_name: Dict[str, dict] = field(default_factory=dict)
    input_settings_by_name: Dict[str, dict] = field(default_factory=dict)
    input_active_by_name: Dict[str, bool] = field(default_factory=dict)
    input_show_by_name: Dict[str, bool] = field(default_factory=dict)
    output_state_by_name: Dict[str, dict] = field(default_factory=dict)
    replay_buffer_output_name: str = "Replay Buffer"
    replay_buffer_active: Optional[bool] = None
    record_active: Optional[bool] = None
    stream_active: Optional[bool] = None
    current_source_name: Optional[str] = None


@dataclass
class OBSTickIntervals:
    refresh_current_scene_seconds: float = 5.0
    refresh_scene_items_seconds: float = 5.0
    fit_to_screen_seconds: float = 20.0
    capture_source_switch_seconds: float = 20.0
    output_probe_seconds: float = 10.0
    replay_buffer_seconds: float = 5.0
    full_state_refresh_seconds: float = 15.0


@dataclass
class OBSTickOptions:
    refresh_current_scene: Optional[bool] = None
    refresh_scene_items: Optional[bool] = None
    fit_to_screen: Optional[bool] = None
    capture_source_switch: Optional[bool] = None
    output_probe: Optional[bool] = None
    manage_replay_buffer: Optional[bool] = None
    refresh_full_state: Optional[bool] = None
    force: bool = False


class OBSService:
    def __init__(self, host, port, password, connections=2, check_output=False):
        self.host = host
        self.port = port
        self.password = password
        self.connections = connections
        self.check_output = check_output
        self._pool_kwargs = {
            "host": host,
            "port": port,
            "password": password,
            "timeout": 3,
        }
        self._event_client_kwargs = {
            "host": host,
            "port": port,
            "password": password,
            "timeout": 1,
        }
        self.connection_pool = OBSConnectionPool(
            size=connections,
            **self._pool_kwargs,
        )
        self.connection_pool.connect_all()

        self.event_client = obs.EventClient(**self._event_client_kwargs)

        self.state = OBSState()
        self._state_lock = threading.Lock()
        self._event_handlers: Dict[str, List[Callable]] = {}
        self._event_callbacks: Dict[str, Callable] = {}
        self._handler_accepts_event_name: Dict[Callable, bool] = {}

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
        self.tick_intervals = OBSTickIntervals()
        self._tick_last_run_by_operation: Dict[str, float] = {}

        self._register_default_handlers()
        self._initialize_state()
        self.initialized = False

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

    def on(self, event_name: str, handler: Callable):
        handlers = self._event_handlers.setdefault(event_name, [])
        if handler not in handlers:
            handlers.append(handler)
        self._ensure_event_callback(event_name)

    def off(self, event_name: str, handler: Callable):
        handlers = self._event_handlers.get(event_name, [])
        if handler in handlers:
            handlers.remove(handler)

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

    def _is_tick_operation_due(
        self, operation_name: str, interval_seconds: float, now: float, force: bool = False
    ) -> bool:
        if not hasattr(self, "_tick_last_run_by_operation"):
            self._tick_last_run_by_operation = {}
        if force or interval_seconds <= 0:
            return True
        last_run = self._tick_last_run_by_operation.get(operation_name)
        return last_run is None or (now - last_run) >= interval_seconds

    def _mark_tick_operation(self, operation_name: str, now: float):
        if not hasattr(self, "_tick_last_run_by_operation"):
            self._tick_last_run_by_operation = {}
        self._tick_last_run_by_operation[operation_name] = now

    def build_scheduled_tick_options(
        self, now: Optional[float] = None, overrides: Optional[OBSTickOptions] = None
    ) -> OBSTickOptions:
        now = time.time() if now is None else now
        overrides = overrides or OBSTickOptions()
        tick_intervals = getattr(self, "tick_intervals", OBSTickIntervals())

        def resolve(override_value: Optional[bool], operation_name: str, interval_seconds: float) -> bool:
            if override_value is not None:
                return override_value
            return self._is_tick_operation_due(
                operation_name,
                interval_seconds,
                now,
                force=overrides.force,
            )

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
            fit_to_screen=resolve(
                overrides.fit_to_screen,
                "fit_to_screen",
                tick_intervals.fit_to_screen_seconds,
            ),
            capture_source_switch=resolve(
                overrides.capture_source_switch,
                "capture_source_switch",
                tick_intervals.capture_source_switch_seconds,
            ),
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
            getattr(options, field)
            for field in (
                "refresh_current_scene",
                "refresh_scene_items",
                "fit_to_screen",
                "capture_source_switch",
                "output_probe",
                "manage_replay_buffer",
                "refresh_full_state",
            )
        )

    def tick(self, options: Optional[OBSTickOptions] = None):
        if not self.initialized:
            self._initialize_state()

        now = time.time()
        resolved_options = self.build_scheduled_tick_options(now=now, overrides=options)
        if not self.has_tick_work(resolved_options):
            return

        if resolved_options.refresh_full_state:
            self._initialize_state()
            self._mark_tick_operation("full_state_refresh", now)

        with self._state_lock:
            current_scene = self.state.current_scene
        scene_changed = False

        if resolved_options.refresh_current_scene:
            refreshed_scene = get_current_scene()
            if refreshed_scene:
                scene_changed = refreshed_scene != current_scene
                current_scene = refreshed_scene
                with self._state_lock:
                    self.state.current_scene = current_scene
                    if scene_changed:
                        self.state.current_source_name = None
                gsm_state.current_game = current_scene
            self._mark_tick_operation("refresh_current_scene", now)

        if scene_changed:
            resolved_options.refresh_scene_items = True
            resolved_options.fit_to_screen = True
            resolved_options.capture_source_switch = True
            resolved_options.output_probe = True

        if resolved_options.refresh_scene_items and current_scene:
            self._refresh_scene_items(current_scene)
            self._mark_tick_operation("refresh_scene_items", now)

        if resolved_options.fit_to_screen and current_scene:
            set_fit_to_screen_for_scene_items(current_scene)
            self._mark_tick_operation("fit_to_screen", now)

        source_active = None
        if resolved_options.capture_source_switch and current_scene:
            source_active = self._reconcile_capture_source_visibility(current_scene)
            self._mark_tick_operation("capture_source_switch", now)

        if resolved_options.output_probe and source_active is None:
            source_active = self._is_output_active_from_screenshot()
            self._mark_tick_operation("output_probe", now)

        if not self.check_output:
            return

        if not resolved_options.manage_replay_buffer:
            return
        self._mark_tick_operation("manage_replay_buffer", now)

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

    def _get_scene_items_for_scene(self, scene_name: str) -> List[dict]:
        if not scene_name:
            return []

        with self._state_lock:
            cached_items = self.state.scene_items_by_scene.get(scene_name)
            if cached_items is not None:
                return list(cached_items)

        self._refresh_scene_items(scene_name)

        with self._state_lock:
            cached_items = self.state.scene_items_by_scene.get(scene_name, [])
            return list(cached_items)

    def _set_scene_items_enabled(self, scene_name: str, scene_items: List[dict], enabled: bool):
        if not scene_name or not scene_items:
            return

        items_to_update = [item for item in scene_items if bool(item.get("sceneItemEnabled", True)) != bool(enabled)]
        if not items_to_update:
            return

        def _update_items(client):
            for item in items_to_update:
                item_id = item.get("sceneItemId")
                if item_id is None:
                    continue
                client.set_scene_item_enabled(scene_name, item_id, bool(enabled))

        self.connection_pool.call(_update_items, retries=OBS_DEFAULT_RETRY_COUNT)

        with self._state_lock:
            cached_items = self.state.scene_items_by_scene.get(scene_name, [])
            cached_items_by_id = {item.get("sceneItemId"): item for item in cached_items}

            for item in items_to_update:
                item["sceneItemEnabled"] = bool(enabled)
                cached_item = cached_items_by_id.get(item.get("sceneItemId"))
                if cached_item is not None:
                    cached_item["sceneItemEnabled"] = bool(enabled)
                source_name = item.get("sourceName")
                if source_name:
                    self.state.input_show_by_name[source_name] = bool(enabled)

    def _probe_source_has_output(self, source_name: Optional[str]) -> bool:
        if not source_name:
            return False
        img = get_screenshot_PIL_from_source(
            source_name,
            compression=50,
            img_format="jpg",
            width=8,
            height=8,
            retry=1,
        )
        if not img:
            return False
        return not self._is_image_empty(img)

    def _reconcile_capture_source_visibility(self, scene_name: str) -> Optional[bool]:
        scene_items = self._get_scene_items_for_scene(scene_name)
        video_items = get_video_scene_items(scene_items)
        if not video_items:
            return None

        game_items = [item for item in video_items if item.get("inputKind") == "game_capture"]
        window_items = [item for item in video_items if item.get("inputKind") == "window_capture"]

        preferred_game_item = game_items[0] if game_items else None
        preferred_window_item = window_items[0] if window_items else None

        def set_enabled_if_needed(items: List[dict], enabled: bool):
            if not items:
                return
            if any(bool(item.get("sceneItemEnabled", True)) != bool(enabled) for item in items):
                self._set_scene_items_enabled(scene_name, items, enabled)
                for item in items:
                    item["sceneItemEnabled"] = bool(enabled)

        if preferred_game_item and not bool(preferred_game_item.get("sceneItemEnabled", True)):
            set_enabled_if_needed([preferred_game_item], True)

        if preferred_game_item and self._probe_source_has_output(preferred_game_item.get("sourceName")):
            set_enabled_if_needed(game_items, True)
            set_enabled_if_needed(window_items, False)
            with self._state_lock:
                self.state.current_source_name = preferred_game_item.get("sourceName")
            return True

        if preferred_window_item and self._probe_source_has_output(preferred_window_item.get("sourceName")):
            set_enabled_if_needed(game_items, False)
            set_enabled_if_needed(window_items, True)
            with self._state_lock:
                self.state.current_source_name = preferred_window_item.get("sourceName")
            return True

        if game_items and window_items:
            set_enabled_if_needed(game_items, True)
            set_enabled_if_needed(window_items, True)
        elif game_items:
            set_enabled_if_needed(game_items, True)
        elif window_items:
            set_enabled_if_needed(window_items, True)

        return False

    def _ensure_event_callback(self, event_name: str):
        if event_name in self._event_callbacks:
            return

        def _handler(data):
            self._dispatch_event(event_name, data)

        _handler.__name__ = f"on_{to_snake_case(event_name)}"
        self.event_client.callback.register(_handler)
        self._event_callbacks[event_name] = _handler

    def _dispatch_event(self, event_name: str, data):
        self._update_state(event_name, data)
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

    def _initialize_state(self):
        try:

            def _initialize(client):
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
                self.initialized = True

            self.connection_pool.call(_initialize, retries=OBS_DEFAULT_RETRY_COUNT)
        except Exception as e:
            logger.error(f"Failed to initialize OBS state: {e}")

    def _register_default_handlers(self):
        self.on("CurrentProgramSceneChanged", self._handle_current_program_scene_changed)
        self.on("SceneItemCreated", self._handle_scene_item_change)
        self.on("SceneItemRemoved", self._handle_scene_item_change)
        self.on("SceneItemListReindexed", self._handle_scene_item_change)
        self.on("SceneItemEnableStateChanged", self._handle_scene_item_change)
        self.on("SceneNameChanged", self._handle_scene_name_changed)
        self.on("InputCreated", self._handle_input_created)
        self.on("InputRemoved", self._handle_input_removed)
        self.on("InputNameChanged", self._handle_input_renamed)
        self.on("InputSettingsChanged", self._handle_input_settings_changed)
        self.on("InputActiveStateChanged", self._handle_input_active_state_changed)
        self.on("InputShowStateChanged", self._handle_input_show_state_changed)
        self.on("ReplayBufferStateChanged", self._handle_replay_buffer_state_changed)
        self.on("RecordStateChanged", self._handle_record_state_changed)
        self.on("RecordFileChanged", self._handle_record_file_changed)
        self.on("StreamStateChanged", self._handle_stream_state_changed)
        self.on("OutputStateChanged", self._handle_output_state_changed)
        self.on("OutputStarted", self._handle_output_started)
        self.on("OutputStopped", self._handle_output_stopped)

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
            set_fit_to_screen_for_scene_items(scene_name)
        except Exception as e:
            logger.debug(f"Scene change refresh failed: {e}")

        if self.check_output:
            self._source_no_output_timestamp = None
            self._initial_replay_check_done = False
            self.tick(
                OBSTickOptions(
                    refresh_current_scene=False,
                    refresh_scene_items=True,
                    fit_to_screen=True,
                    capture_source_switch=True,
                    output_probe=True,
                    manage_replay_buffer=True,
                    refresh_full_state=False,
                    force=True,
                )
            )

    def _handle_scene_item_change(self, data):
        scene_name = getattr(data, "scene_name", None)
        if not scene_name:
            return
        try:
            self._refresh_scene_items(scene_name)
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

    def _handle_input_created(self, data):
        input_name = getattr(data, "input_name", None)
        input_kind = getattr(data, "input_kind", None)
        if not input_name:
            return
        with self._state_lock:
            self.state.inputs_by_name[input_name] = {
                "inputName": input_name,
                "inputKind": input_kind,
            }

    def _handle_input_removed(self, data):
        input_name = getattr(data, "input_name", None)
        if not input_name:
            return
        with self._state_lock:
            self.state.inputs_by_name.pop(input_name, None)
            self.state.input_settings_by_name.pop(input_name, None)
            self.state.input_active_by_name.pop(input_name, None)
            self.state.input_show_by_name.pop(input_name, None)

    def _handle_input_renamed(self, data):
        old_name = getattr(data, "input_name", None)
        new_name = getattr(data, "new_input_name", None)
        if not old_name or not new_name:
            return
        with self._state_lock:
            if old_name in self.state.inputs_by_name:
                self.state.inputs_by_name[new_name] = self.state.inputs_by_name.pop(old_name)
                self.state.inputs_by_name[new_name]["inputName"] = new_name
            if old_name in self.state.input_settings_by_name:
                self.state.input_settings_by_name[new_name] = self.state.input_settings_by_name.pop(old_name)
            if old_name in self.state.input_active_by_name:
                self.state.input_active_by_name[new_name] = self.state.input_active_by_name.pop(old_name)
            if old_name in self.state.input_show_by_name:
                self.state.input_show_by_name[new_name] = self.state.input_show_by_name.pop(old_name)
            if self.state.current_source_name == old_name:
                self.state.current_source_name = new_name

    def _handle_input_settings_changed(self, data):
        input_name = getattr(data, "input_name", None)
        settings = getattr(data, "input_settings", None)
        if not input_name or settings is None:
            return
        with self._state_lock:
            self.state.input_settings_by_name[input_name] = settings

    def _handle_input_active_state_changed(self, data):
        logger.debug(f"InputActiveStateChanged event data: {data}")
        input_name = getattr(data, "input_name", None)
        is_active = getattr(data, "video_active", None)
        if input_name is None or is_active is None:
            return
        with self._state_lock:
            self.state.input_active_by_name[input_name] = bool(is_active)

        if input_name == self.state.current_source_name:
            self._handle_source_activity_change()

    def _handle_input_show_state_changed(self, data):
        logger.info(f"InputShowStateChanged event data: {dict(data)}")
        input_name = getattr(data, "input_name", None)
        is_showing = getattr(data, "video_showing", None)
        if input_name is None or is_showing is None:
            return
        with self._state_lock:
            self.state.input_show_by_name[input_name] = bool(is_showing)

        if input_name == self.state.current_source_name:
            self._handle_source_activity_change()

    def _handle_source_activity_change(self):
        logger.info(f"Handling source activity change for {self.state.current_source_name}")
        if not self.check_output:
            return
        if _is_obs_recording_disabled():
            return
        source_active = self._is_current_source_active()
        if source_active is None:
            return
        replay_buffer_active = self._get_replay_buffer_active()
        if source_active:
            self._source_no_output_timestamp = None
            if replay_buffer_active is not True and self._can_auto_start_replay_buffer():
                start_replay_buffer()
        else:
            if replay_buffer_active:
                if self._source_no_output_timestamp is None:
                    self._source_no_output_timestamp = time.time()

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

        if bool(output_active):
            self._auto_start_paused_by_external_replay_stop = False
        elif internal_change:
            self._auto_start_paused_by_external_replay_stop = False
        else:
            logger.info(
                "Replay buffer was stopped outside GSM; auto-start is paused until replay buffer is started again."
            )
            self._auto_start_paused_by_external_replay_stop = True

        with self._state_lock:
            self.state.replay_buffer_active = bool(output_active)

        if self.check_output:
            self.tick(
                OBSTickOptions(
                    refresh_current_scene=False,
                    refresh_scene_items=False,
                    fit_to_screen=False,
                    capture_source_switch=False,
                    output_probe=True,
                    manage_replay_buffer=True,
                    refresh_full_state=False,
                    force=True,
                )
            )

    def _handle_record_state_changed(self, data):
        output_active = getattr(data, "output_active", None)
        output_path = getattr(data, "output_path", None)
        with self._state_lock:
            if output_active is not None:
                self.state.record_active = bool(output_active)
        longplay_handler.on_record_state_changed(output_active=output_active, output_path=output_path)

    def _handle_record_file_changed(self, data):
        new_output_path = getattr(data, "new_output_path", None)
        longplay_handler.on_record_file_changed(new_output_path)

    def _handle_stream_state_changed(self, data):
        output_active = getattr(data, "output_active", None)
        with self._state_lock:
            if output_active is not None:
                self.state.stream_active = bool(output_active)

    def _handle_output_state_changed(self, data):
        output_name = getattr(data, "output_name", None)
        if not output_name:
            return
        output_active = getattr(data, "output_active", None)
        output_state = getattr(data, "output_state", None)

        with self._state_lock:
            self.state.output_state_by_name[output_name] = {
                "outputName": output_name,
                "outputActive": output_active,
                "outputState": output_state,
            }

        if output_name == self.state.replay_buffer_output_name and self.check_output:
            self._refresh_replay_buffer_settings()

    def _handle_output_started(self, data):
        output_name = getattr(data, "output_name", None)
        output_kind = getattr(data, "output_kind", None)
        if output_name:
            with self._state_lock:
                self.state.output_state_by_name[output_name] = {
                    "outputName": output_name,
                    "outputKind": output_kind,
                    "outputActive": True,
                }
        if output_kind == "replay_buffer" and output_name:
            with self._state_lock:
                self.state.replay_buffer_output_name = output_name
            if self.check_output:
                self._refresh_replay_buffer_settings()

    def _handle_output_stopped(self, data):
        output_name = getattr(data, "output_name", None)
        if output_name:
            with self._state_lock:
                if output_name in self.state.output_state_by_name:
                    self.state.output_state_by_name[output_name]["outputActive"] = False

    def _refresh_scene_items(self, scene_name: str, client: Optional[obs.ReqClient] = None):
        if not scene_name:
            return
        if client is None:
            response = self.connection_pool.call(
                lambda req_client: req_client.get_scene_item_list(name=scene_name),
                retries=OBS_DEFAULT_RETRY_COUNT,
            )
        else:
            response = client.get_scene_item_list(name=scene_name)

        scene_items = response.scene_items if response else []
        with self._state_lock:
            self.state.scene_items_by_scene[scene_name] = scene_items
            if scene_name == self.state.current_scene:
                self.state.current_source_name = self._pick_source_name(scene_items)

    def _update_output_cache(self, outputs: List[dict]):
        with self._state_lock:
            self.state.output_state_by_name = {
                output.get("outputName"): output for output in outputs if output.get("outputName")
            }
            for output in outputs:
                if output.get("outputKind") == "replay_buffer":
                    self.state.replay_buffer_output_name = output.get("outputName")
                    break

    def _refresh_replay_buffer_settings(self, client: Optional[obs.ReqClient] = None):
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
                    lambda req_client: req_client.get_replay_buffer_status(),
                    retries=OBS_DEFAULT_RETRY_COUNT,
                )
            except Exception:
                replay_status = None
        else:
            replay_status = client.get_replay_buffer_status()

        if replay_status:
            with self._state_lock:
                self.state.replay_buffer_active = replay_status.output_active

    def _pick_source_name(self, scene_items: List[dict]) -> Optional[str]:
        if not scene_items:
            return None
        preferred_source = get_preferred_video_source(
            scene_items,
            input_active_by_name=self.state.input_active_by_name,
            input_show_by_name=self.state.input_show_by_name,
        )
        if preferred_source:
            return preferred_source.get("sourceName")
        return scene_items[0].get("sourceName")

    def _is_current_source_active(self) -> Optional[bool]:
        with self._state_lock:
            source_name = self.state.current_source_name
            if not source_name:
                return None
            active = self.state.input_active_by_name.get(source_name)
            showing = self.state.input_show_by_name.get(source_name)

        if active is None and showing is None:
            return None
        if active is None:
            return bool(showing)
        if showing is None:
            return bool(active)
        logger.info(f"Source '{source_name}' active: {active}, showing: {showing}")
        return bool(active and showing)

    def _get_replay_buffer_active(self) -> Optional[bool]:
        with self._state_lock:
            replay_buffer_active = self.state.replay_buffer_active
        if replay_buffer_active is not None:
            return replay_buffer_active

        replay_buffer_active = get_replay_buffer_status()
        if replay_buffer_active is not None:
            replay_buffer_active = bool(replay_buffer_active)
            with self._state_lock:
                self.state.replay_buffer_active = replay_buffer_active
        return replay_buffer_active

    def _is_output_active_from_screenshot(self) -> Optional[bool]:
        img = get_screenshot_PIL(compression=50, img_format="jpg", width=8, height=8)
        if not img:
            return None
        return not self._is_image_empty(img)

    def _is_image_empty(self, img):
        return is_image_empty(img)

    def _update_state(self, event_name: str, data):
        if event_name == "CurrentProgramSceneChanged":
            return
        if event_name == "SceneItemCreated":
            return
        if event_name == "SceneItemRemoved":
            return
        if event_name == "SceneItemListReindexed":
            return
        if event_name == "SceneItemEnableStateChanged":
            return
        if event_name == "SceneNameChanged":
            return
        if event_name == "InputCreated":
            return
        if event_name == "InputRemoved":
            return
        if event_name == "InputNameChanged":
            return
        if event_name == "InputSettingsChanged":
            return
        if event_name == "InputActiveStateChanged":
            return
        if event_name == "InputShowStateChanged":
            return
        if event_name == "ReplayBufferStateChanged":
            return
        if event_name == "RecordStateChanged":
            return
        if event_name == "RecordFileChanged":
            return
        if event_name == "StreamStateChanged":
            return
        if event_name == "OutputStateChanged":
            return
        if event_name == "OutputStarted":
            return
        if event_name == "OutputStopped":
            return


def _bind_obs_service_clients():
    global connection_pool, event_client
    if obs_service:
        connection_pool = obs_service.connection_pool
        event_client = obs_service.event_client
    else:
        connection_pool = None
        event_client = None


def _resolve_obs_default(default=None, fallback=None):
    if fallback is not None:
        try:
            return fallback()
        except Exception as e:
            logger.debug(f"OBS fallback resolution failed: {e}")
    return default


def _recover_obs_service_clients_sync() -> bool:
    if connecting or not obs_service:
        return False
    recovered = obs_service.refresh_after_reconnect()
    if recovered is False:
        return False
    _bind_obs_service_clients()
    gsm_status.obs_connected = True
    return True


def _call_with_pool(pool, operation: Callable[[obs.ReqClient], object], retries: int = 0, retryable: bool = True):
    if hasattr(pool, "call") and callable(getattr(pool, "call")):
        return pool.call(operation, retries=retries, retryable=retryable)

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
    operation: Callable[[obs.ReqClient], object],
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
    if obs_service and (not connection_pool or not gsm_status.obs_connected):
        _recover_obs_service_clients_sync()

    if not connection_pool:
        return _resolve_obs_default(default=default, fallback=fallback)

    try:
        effective_retries = max(0, int(retries if retryable else 0))
        return _call_with_pool(
            connection_pool,
            operation,
            retries=effective_retries,
            retryable=bool(retryable),
        )
    except Exception as e:
        if raise_exc:
            raise e

        if suppress_obs_errors:
            return _resolve_obs_default(default=default, fallback=fallback)

        if error_msg:
            if debug_errors:
                logger.debug(f"{error_msg}: {e}")
            else:
                logger.error(f"{error_msg}: {e}")

        return _resolve_obs_default(default=default, fallback=fallback)


def with_obs_client(
    default=None, error_msg=None, raise_exc=False, retryable=True, retries=OBS_DEFAULT_RETRY_COUNT, fallback=None
):
    """
    Decorator to automatically acquire an OBS client from the pool and pass it
    as the first argument to the decorated function.
    """

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


class OBSConnectionManager(threading.Thread):
    def __init__(self, check_output=False):
        super().__init__()
        self.daemon = True
        self.running = True
        self.check_connection_interval = 1.0
        self.recovery_cooldown_seconds = 2.0
        self.last_errors = []
        self._check_lock = threading.Lock()
        self.check_output = check_output
        self.last_tick_time = 0
        self._last_recovery_attempt = 0.0

    def _recover_obs_connection(self) -> bool:
        now = time.monotonic()
        if connecting:
            return False
        if (now - self._last_recovery_attempt) < self.recovery_cooldown_seconds:
            return False

        self._last_recovery_attempt = now

        if connection_pool:
            try:
                connection_pool.reset_healthcheck_client()
            except Exception:
                pass

        if obs_service:
            if _recover_obs_service_clients_sync():
                logger.info("Recovered OBS WebSocket connection.")
                return True
            return False

        if not connecting:
            threading.Thread(
                target=connect_to_obs_sync,
                kwargs={"retry": 1, "check_output": self.check_output},
                daemon=True,
            ).start()
        return False

    def _check_obs_connection(self):
        if connecting:
            return False

        try:
            client = connection_pool.get_healthcheck_client() if connection_pool else None
            if client:
                client.get_version()
                gsm_status.obs_connected = True
                return True
            raise ConnectionError("Healthcheck client creation failed")
        except Exception as e:
            if connection_pool:
                try:
                    connection_pool.reset_healthcheck_client()
                except Exception:
                    pass
            if gsm_status.obs_connected:
                logger.info(f"OBS WebSocket connection lost: {e}")
            gsm_status.obs_connected = False
            return self._recover_obs_connection()

    def run(self):
        from GameSentenceMiner.util.gsm_utils import SleepManager

        disconnect_sleep_manager = SleepManager(initial_delay=2.0, name="OBS_Disconnect")
        time.sleep(5)
        if obs_service:
            obs_service.tick(
                OBSTickOptions(
                    refresh_full_state=False,
                    force=True,
                )
            )
        while self.running:
            if not gsm_status.obs_connected:
                disconnect_sleep_manager.sleep()
            else:
                disconnect_sleep_manager.reset()
                time.sleep(self.check_connection_interval)

            if not self._check_obs_connection():
                continue

            with self._check_lock:
                if obs_service:
                    tick_options = obs_service.build_scheduled_tick_options()
                    if obs_service.has_tick_work(tick_options):
                        obs_service.tick(tick_options)
                        self.last_tick_time = time.time()

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


def get_base_obs_dir():
    return os.path.join(configuration.get_app_directory(), "obs-studio")


def get_obs_path():
    config = get_config()
    if config.obs.obs_path:
        return config.obs.obs_path
    return os.path.join(configuration.get_app_directory(), "obs-studio/bin/64bit/obs64.exe")


def _resolve_obs_launch_command(obs_path: str):
    if os.path.exists(obs_path):
        return [obs_path], os.path.dirname(obs_path)

    try:
        cmd = shlex.split(obs_path)
    except ValueError:
        cmd = obs_path.split()

    if not cmd:
        return None, None

    exe = cmd[0]
    if os.path.exists(exe) or shutil.which(exe):
        cwd = os.path.dirname(exe) if os.path.exists(exe) else None
        return cmd, cwd

    return None, None


def _remove_obs_startup_artifact(path: str, label: str) -> None:
    if not os.path.exists(path):
        return

    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
        logger.debug(f"Deleted OBS startup {label}: {path}")
    except Exception as e:
        logger.error(f"Failed to delete OBS startup {label}: {e}")


def _cleanup_obs_startup_artifacts(app_directory: str = None) -> None:
    base_config_dir = os.path.join(
        app_directory or configuration.get_app_directory(),
        "obs-studio",
        "config",
        "obs-studio",
    )
    _remove_obs_startup_artifact(os.path.join(base_config_dir, ".sentinel"), "sentinel")
    _remove_obs_startup_artifact(
        os.path.join(
            base_config_dir,
            "plugin_config",
            "advanced-scene-switcher",
            ".running",
        ),
        "advanced-scene-switcher running file",
    )


def _build_obs_launch_command(base_cmd: list[str], config_override=None) -> list[str]:
    cfg = config_override or get_config()
    obs_cfg = cfg.obs

    obs_cmd = [*base_cmd, "--disable-shutdown-check", "--portable"]
    if not getattr(obs_cfg, "allow_automatic_updates", False):
        obs_cmd.append("--disable-updater")
    if not getattr(obs_cfg, "disable_recording", False):
        obs_cmd.append("--startreplaybuffer")
    return obs_cmd


def is_process_running(pid):
    try:
        process = psutil.Process(pid)
        return "obs" in process.exe().lower()
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        if os.path.exists(OBS_PID_FILE):
            try:
                os.remove(OBS_PID_FILE)
            except OSError:
                pass
        return False


def start_obs(force_restart=False):
    global obs_process_pid
    if os.path.exists(OBS_PID_FILE):
        with open(OBS_PID_FILE, "r") as f:
            try:
                obs_process_pid = int(f.read().strip())
                if is_process_running(obs_process_pid):
                    if force_restart:
                        try:
                            process = psutil.Process(obs_process_pid)
                            process.terminate()
                            process.wait(timeout=10)
                            print("OBS process terminated for restart.")
                        except Exception as e:
                            print(f"Error terminating OBS process: {e}")
                    else:
                        return obs_process_pid
            except ValueError:
                print("Invalid PID found in file. Launching new OBS instance.")
            except OSError:
                print("No process found with the stored PID. Launching new OBS instance.")

    obs_path = get_obs_path()
    base_cmd, base_cwd = _resolve_obs_launch_command(obs_path)
    if not base_cmd:
        print(f"OBS not found at {obs_path}. Please install OBS.")
        return None
    try:
        _cleanup_obs_startup_artifacts()
        obs_cmd = _build_obs_launch_command(base_cmd)
        obs_process = subprocess.Popen(obs_cmd, cwd=base_cwd)
        obs_process_pid = obs_process.pid
        with open(OBS_PID_FILE, "w") as f:
            f.write(str(obs_process_pid))
        logger.success("OBS launched successfully!")
        return obs_process_pid
    except Exception as e:
        logger.error(f"Error launching OBS: {e}")
        return None


async def wait_for_obs_connected():
    if not connection_pool:
        return False
    for _ in range(10):
        try:
            client = connection_pool.get_healthcheck_client()
            if client:
                response = client.get_version()
                if response:
                    return True
        except Exception as e:
            logger.debug(f"Waiting for OBS connection: {e}")
            await asyncio.sleep(1)
    return False


def is_obs_websocket_reachable(host: Optional[str] = None, port: Optional[int] = None, timeout: float = 0.25):
    host = host or get_config().obs.host
    port = port or get_config().obs.port
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


async def wait_for_obs_websocket_ready(
    timeout: Optional[float] = None,
    interval: float = 2.0,
    host: Optional[str] = None,
    port: Optional[int] = None,
):
    start = time.time()
    while True:
        if is_obs_websocket_reachable(host=host, port=port):
            return True
        if timeout is not None and (time.time() - start) >= timeout:
            return False
        if not gsm_state.keep_running:
            return False
        await asyncio.sleep(interval)


async def wait_for_obs_ready(
    timeout: Optional[float] = None,
    interval: float = 2.0,
    host: Optional[str] = None,
    port: Optional[int] = None,
    password: Optional[str] = None,
):
    start = time.time()
    host = host or get_config().obs.host
    port = port or get_config().obs.port
    password = password if password is not None else get_config().obs.password
    while True:
        if is_obs_websocket_reachable(host=host, port=port):
            try:
                client = obs.ReqClient(host=host, port=port, password=password, timeout=1)
                client.get_version()
                scene_response = client.get_scene_list()
                if scene_response and scene_response.scenes is not None:
                    return True
            except Exception:
                pass
        if timeout is not None and (time.time() - start) >= timeout:
            return False
        if not gsm_state.keep_running:
            return False
        await asyncio.sleep(interval)


async def check_obs_folder_is_correct():
    if await wait_for_obs_connected():
        try:
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


def get_obs_websocket_config_values():
    try:
        config_path = os.path.join(
            get_app_directory(),
            "obs-studio",
            "config",
            "obs-studio",
            "plugin_config",
            "obs-websocket",
            "config.json",
        )

        if not os.path.isfile(config_path):
            return

        with open(config_path, "r") as file:
            config = json.load(file)

        server_enabled = config.get("server_enabled", False)
        server_port = config.get("server_port", 7274)
        server_password = config.get("server_password", None)

        if not server_enabled:
            logger.info(
                "OBS WebSocket server is not enabled. Enabling it now... Restart OBS for changes to take effect."
            )
            config["server_enabled"] = True
            with open(config_path, "w") as file:
                json.dump(config, file, indent=4)

        if get_config().obs.password == "your_password":
            logger.info("OBS WebSocket password is not set. Setting it now...")
            full_config = get_master_config()
            full_config.get_config().obs.port = server_port
            full_config.get_config().obs.password = server_password
            full_config.sync_shared_fields()
            full_config.save()
            reload_config()
    except Exception as e:
        logger.error(f"Failed to check OBS WebSocket config: {e}")


async def connect_to_obs(retry=5, connections=2, check_output=False):
    global connection_pool, obs_connection_manager, event_client, obs_service, connecting
    if obs_service or connecting:
        return

    if is_windows():
        get_obs_websocket_config_values()

    connecting = True
    try:
        while retry > 0:
            try:
                obs_service = OBSService(
                    host=get_config().obs.host,
                    port=get_config().obs.port,
                    password=get_config().obs.password,
                    connections=connections,
                    check_output=check_output,
                )

                connection_pool = obs_service.connection_pool
                event_client = obs_service.event_client

                gsm_status.obs_connected = True
                logger.success("Connected to OBS WebSocket.")

                if not obs_connection_manager:
                    obs_connection_manager = OBSConnectionManager(check_output=check_output)
                    obs_connection_manager.start()

                try:
                    update_current_game()
                except Exception:
                    pass

                try:
                    apply_obs_performance_settings()
                except Exception:
                    pass

                if get_config().features.generate_longplay and check_output and not _is_obs_recording_disabled():
                    try:
                        start_recording(True)
                    except Exception:
                        pass
                break
            except Exception as e:
                retry -= 1
                if retry <= 0:
                    gsm_status.obs_connected = False
                    logger.error(f"Failed to connect to OBS WebSocket after retries: {e}")
                    connection_pool = None
                    event_client = None
                    obs_service = None
                    break
                await asyncio.sleep(1)
    finally:
        connecting = False


def connect_to_obs_sync(retry=2, connections=2, check_output=False):
    global connection_pool, obs_connection_manager, event_client, obs_service, connecting
    if obs_service or connecting:
        return

    if is_windows():
        get_obs_websocket_config_values()

    connecting = True
    try:
        while retry > 0:
            try:
                obs_service = OBSService(
                    host=get_config().obs.host,
                    port=get_config().obs.port,
                    password=get_config().obs.password,
                    connections=connections,
                    check_output=check_output,
                )

                connection_pool = obs_service.connection_pool
                event_client = obs_service.event_client

                gsm_status.obs_connected = True
                logger.success("Connected to OBS WebSocket.")

                if not obs_connection_manager:
                    obs_connection_manager = OBSConnectionManager(check_output=check_output)
                    obs_connection_manager.start()

                try:
                    update_current_game()
                except Exception:
                    pass

                try:
                    apply_obs_performance_settings()
                except Exception:
                    pass

                if get_config().features.generate_longplay and check_output and not _is_obs_recording_disabled():
                    try:
                        start_recording(True)
                    except Exception:
                        pass
                break
            except Exception as e:
                retry -= 1
                if retry <= 0:
                    gsm_status.obs_connected = False
                    logger.error(f"Failed to connect to OBS WebSocket: {e}")
                    connection_pool = None
                    event_client = None
                    obs_service = None
                    break
                time.sleep(1)
    finally:
        connecting = False


def disconnect_from_obs():
    global connection_pool, event_client, obs_service
    if obs_service:
        obs_service.disconnect()
        obs_service = None

    connection_pool = None
    event_client = None

    logger.info("Disconnected from OBS WebSocket.")


def do_obs_call(method_name: str, from_dict=None, retry=3, **kwargs):
    if not connection_pool:
        if obs_service:
            _recover_obs_service_clients_sync()
        elif not connecting:
            connect_to_obs_sync(retry=1)
    if not connection_pool:
        return None

    def _invoke(client):
        method_to_call = getattr(client, method_name)
        response = method_to_call(**kwargs)
        if response and getattr(response, "ok", False):
            return from_dict(response.datain) if from_dict else response.datain
        return None

    return _call_with_obs_client(
        _invoke,
        default=None,
        error_msg=f"Error calling OBS ('{method_name}')",
        retryable=True,
        retries=retry,
    )


@with_obs_client(error_msg="Error toggling buffer", retryable=False)
def toggle_replay_buffer(client: obs.ReqClient):
    if _is_obs_recording_disabled():
        logger.warning("OBS replay buffer toggle blocked: OBS recording/replay is disabled in GSM settings.")
        return
    current_state = None
    if obs_service:
        current_state = obs_service.state.replay_buffer_active
        if current_state is None:
            try:
                replay_status = client.get_replay_buffer_status()
                current_state = bool(getattr(replay_status, "output_active", False))
            except Exception:
                current_state = None
        if current_state is not None:
            obs_service.mark_replay_buffer_action(not bool(current_state))
        else:
            obs_service.mark_replay_buffer_action(None)
    client.toggle_replay_buffer()
    if obs_service and current_state is not None:
        with obs_service._state_lock:
            obs_service.state.replay_buffer_active = not bool(current_state)
        obs_service._auto_start_paused_by_external_replay_stop = False
    logger.info("Replay buffer Toggled.")


@with_obs_client(error_msg="Error starting replay buffer")
def start_replay_buffer(client: obs.ReqClient, initial=False):
    if _is_obs_recording_disabled():
        logger.warning("OBS replay buffer start blocked: OBS recording/replay is disabled in GSM settings.")
        return
    try:
        replay_status = client.get_replay_buffer_status()
        if bool(getattr(replay_status, "output_active", False)):
            if obs_service:
                with obs_service._state_lock:
                    obs_service.state.replay_buffer_active = True
            gsm_state.replay_buffer_stopped_timestamp = None
            return
    except Exception:
        pass
    if obs_service:
        obs_service.mark_replay_buffer_action(True)
    client.start_replay_buffer()
    if obs_service:
        with obs_service._state_lock:
            obs_service.state.replay_buffer_active = True
        obs_service._auto_start_paused_by_external_replay_stop = False
    gsm_state.replay_buffer_stopped_timestamp = None
    if get_config().features.generate_longplay:
        start_recording(True)
    logger.info("Replay buffer started.")


@with_obs_client(default=None, error_msg="Error getting replay buffer status")
def get_replay_buffer_status(client: obs.ReqClient):
    if obs_service and obs_service.state.replay_buffer_active is not None:
        return obs_service.state.replay_buffer_active
    return client.get_replay_buffer_status().output_active


@with_obs_client(error_msg="Error stopping replay buffer")
def stop_replay_buffer(client: obs.ReqClient):
    try:
        replay_status = client.get_replay_buffer_status()
        if not bool(getattr(replay_status, "output_active", False)):
            if obs_service:
                with obs_service._state_lock:
                    obs_service.state.replay_buffer_active = False
            gsm_state.replay_buffer_stopped_timestamp = time.time()
            return
    except Exception:
        pass
    if obs_service:
        obs_service.mark_replay_buffer_action(False)
    client.stop_replay_buffer()
    if obs_service:
        with obs_service._state_lock:
            obs_service.state.replay_buffer_active = False
        obs_service._auto_start_paused_by_external_replay_stop = False
    gsm_state.replay_buffer_stopped_timestamp = time.time()
    if get_config().features.generate_longplay:
        stop_recording()
    logger.info("Replay buffer stopped.")


@with_obs_client(error_msg="Error saving replay buffer", raise_exc=True, retryable=False)
def save_replay_buffer(client: obs.ReqClient):
    client.save_replay_buffer()
    logger.info(
        'Replay buffer saved. If your log stops here, make sure your obs output path matches "Path To Watch" in GSM settings.'
    )


@with_obs_client(error_msg="Error starting recording")
def start_recording(client: obs.ReqClient, longplay=False):
    if _is_obs_recording_disabled():
        logger.warning("OBS recording start blocked: OBS recording/replay is disabled in GSM settings.")
        return
    try:
        record_status = client.get_record_status()
        if bool(getattr(record_status, "output_active", False)):
            if longplay:
                longplay_handler.on_record_start_requested()
            return
    except Exception:
        pass
    client.start_record()
    if longplay:
        longplay_handler.on_record_start_requested()
    logger.info("Recording started.")


@with_obs_client(error_msg="Error stopping recording")
def stop_recording(client: obs.ReqClient):
    try:
        record_status = client.get_record_status()
        if not bool(getattr(record_status, "output_active", False)):
            return None
    except Exception:
        pass
    resp = client.stop_record()
    output_path = resp.output_path if resp else None
    longplay_handler.on_record_stop_response(output_path=output_path)
    logger.info("Recording stopped.")
    return output_path


def add_longplay_srt_line(line_time, new_line):
    longplay_handler.add_srt_line(line_time=line_time, new_line=new_line)


@with_obs_client(default="", error_msg="Error getting last recording filename")
def get_last_recording_filename(client: obs.ReqClient):
    response = client.get_record_status()
    return response.recording_filename if response else ""


@with_obs_client(
    default="",
    error_msg="Couldn't get scene",
    fallback=lambda: (
        obs_service.state.current_scene
        if obs_service and obs_service.state.current_scene
        else gsm_state.current_game or ""
    ),
)
def get_current_scene(client: obs.ReqClient):
    if obs_service and obs_service.state.current_scene:
        return obs_service.state.current_scene
    response = client.get_current_program_scene()
    return response.scene_name if response else ""


@with_obs_client(default="", error_msg="Error getting source from scene")
def get_source_from_scene(client: obs.ReqClient, scene_name):
    if obs_service:
        items = obs_service.state.scene_items_by_scene.get(scene_name)
        if items:
            preferred = get_preferred_video_source(
                items,
                input_active_by_name=obs_service.state.input_active_by_name,
                input_show_by_name=obs_service.state.input_show_by_name,
            )
            return preferred or items[0]
    response = client.get_scene_item_list(name=scene_name)
    if not response or not response.scene_items:
        return ""
    preferred = get_preferred_video_source(response.scene_items)
    return preferred or response.scene_items[0]


def get_active_source():
    current_game = get_current_game()
    if not current_game:
        return None
    return get_source_from_scene(current_game)


@with_obs_client(default=None, error_msg="Error getting source active state")
def get_source_active(client: obs.ReqClient, source_name: str = None):
    client: obs.ReqClient
    kwargs = {}
    if source_name:
        kwargs["name"] = source_name
    if not kwargs:
        return None
    response = client.get_source_active(**kwargs)
    if not response:
        return None
    return response.video_active, response.video_showing


@with_obs_client(default=None, error_msg="Error getting scene items for active video source")
def get_active_video_sources(client: obs.ReqClient):
    current_game = gsm_state.current_game or (obs_service.state.current_scene if obs_service else None)
    if not current_game:
        try:
            response = client.get_current_program_scene()
            current_game = response.scene_name if response else ""
        except Exception:
            current_game = ""

    if not current_game:
        return None

    if obs_service and current_game in obs_service.state.scene_items_by_scene:
        scene_items_response = obs_service.state.scene_items_by_scene.get(current_game, [])
    else:
        response = client.get_scene_item_list(name=current_game)
        scene_items_response = response.scene_items if response else []

    if not scene_items_response:
        return None
    active_video_sources = [item for item in scene_items_response if item.get("inputKind") in VIDEO_SOURCE_KINDS]
    if active_video_sources:
        return sort_video_sources_by_preference(
            active_video_sources,
            input_active_by_name=obs_service.state.input_active_by_name if obs_service else None,
            input_show_by_name=obs_service.state.input_show_by_name if obs_service else None,
        )
    return [scene_items_response[0]]


@with_obs_client(default="", error_msg="Error getting recording folder")
def get_record_directory(client: obs.ReqClient):
    response = client.get_record_directory()
    return response.record_directory if response else ""


def _clamp_obs_recording_fps(value: int) -> int:
    try:
        return max(1, min(120, int(value)))
    except (TypeError, ValueError):
        return 15


def _get_effective_recording_fps(config_override=None) -> int:
    cfg = config_override or get_config()
    target_fps = _clamp_obs_recording_fps(getattr(cfg.obs, "recording_fps", 15))

    try:
        if cfg.screenshot.animated and cfg.screenshot.animated_settings:
            animated_fps = _clamp_obs_recording_fps(getattr(cfg.screenshot.animated_settings, "fps", target_fps))
            target_fps = max(target_fps, animated_fps)
    except Exception:
        pass

    return target_fps


@with_obs_client(default=False, error_msg="Error applying OBS recording FPS")
def apply_recording_fps(client: obs.ReqClient, config_override=None):
    if _is_obs_recording_disabled(config_override=config_override):
        logger.info("Skipped OBS recording FPS apply because OBS recording/replay is disabled in GSM settings.")
        return True

    target_fps = _get_effective_recording_fps(config_override=config_override)
    video_settings = client.get_video_settings()
    if not video_settings:
        return False

    fps_numerator = getattr(video_settings, "fps_numerator", None)
    fps_denominator = getattr(video_settings, "fps_denominator", None)
    if fps_numerator == target_fps and int(fps_denominator or 1) == 1:
        return True

    base_width = getattr(video_settings, "base_width", None)
    base_height = getattr(video_settings, "base_height", None)
    output_width = getattr(video_settings, "output_width", None)
    output_height = getattr(video_settings, "output_height", None)
    if None in (base_width, base_height, output_width, output_height):
        logger.warning("Could not update OBS recording FPS: missing video dimension fields from get_video_settings.")
        return False

    replay_was_active = False
    record_was_active = False
    stream_was_active = False

    try:
        replay_status = client.get_replay_buffer_status()
        replay_was_active = bool(getattr(replay_status, "output_active", False))
    except Exception:
        replay_was_active = False

    try:
        record_status = client.get_record_status()
        record_was_active = bool(getattr(record_status, "output_active", False))
    except Exception:
        record_was_active = False

    try:
        stream_status = client.get_stream_status()
        stream_was_active = bool(getattr(stream_status, "output_active", False))
    except Exception:
        stream_was_active = False

    had_active_outputs = replay_was_active or record_was_active or stream_was_active

    try:
        if had_active_outputs:
            logger.info(
                f"Restarting active OBS outputs for FPS update to {target_fps} "
                f"(replay={replay_was_active}, record={record_was_active}, stream={stream_was_active})."
            )
            if replay_was_active:
                try:
                    if obs_service:
                        obs_service.mark_replay_buffer_action(False)
                    client.stop_replay_buffer()
                    gsm_state.replay_buffer_stopped_timestamp = time.time()
                except Exception as e:
                    logger.warning(f"Failed to stop replay buffer before FPS update: {e}")
            if record_was_active:
                try:
                    client.stop_record()
                except Exception as e:
                    logger.warning(f"Failed to stop recording before FPS update: {e}")
            if stream_was_active:
                try:
                    client.stop_stream()
                except Exception as e:
                    logger.warning(f"Failed to stop stream before FPS update: {e}")
            time.sleep(2)

        client.set_video_settings(
            base_width=base_width,
            base_height=base_height,
            out_width=output_width,
            out_height=output_height,
            numerator=target_fps,
            denominator=1,
        )
        time.sleep(0.5)
        if stream_was_active:
            try:
                client.start_stream()
            except Exception as e:
                logger.warning(f"Failed to restart stream after FPS update: {e}")
        if record_was_active:
            try:
                client.start_record()
            except Exception as e:
                logger.warning(f"Failed to restart recording after FPS update: {e}")
        if replay_was_active:
            try:
                if obs_service:
                    obs_service.mark_replay_buffer_action(True)
                client.start_replay_buffer()
                gsm_state.replay_buffer_stopped_timestamp = None
            except Exception as e:
                logger.warning(f"Failed to restart replay buffer after FPS update: {e}")
            try:
                replay_status = client.get_replay_buffer_status()
                if not bool(getattr(replay_status, "output_active", False)):
                    if obs_service:
                        obs_service.mark_replay_buffer_action(True)
                    client.start_replay_buffer()
                    gsm_state.replay_buffer_stopped_timestamp = None
            except Exception as e:
                logger.warning(f"Replay buffer verification/restart failed after FPS update: {e}")

        logger.info(f"Applied OBS recording FPS: {target_fps}")
        return True
    except Exception as e:
        logger.warning(f"Failed to set OBS recording FPS to {target_fps}: {e}")
        if had_active_outputs:
            if stream_was_active:
                try:
                    client.start_stream()
                except Exception:
                    pass
            if record_was_active:
                try:
                    client.start_record()
                except Exception:
                    pass
            if replay_was_active:
                try:
                    if obs_service:
                        obs_service.mark_replay_buffer_action(True)
                    client.start_replay_buffer()
                    gsm_state.replay_buffer_stopped_timestamp = None
                except Exception:
                    pass
        return False


def apply_obs_performance_settings(config_override=None):
    cfg = config_override or get_config()
    apply_recording_fps(config_override=cfg)
    if getattr(cfg.obs, "disable_desktop_audio_on_connect", False):
        disable_desktop_audio()


def _get_replay_buffer_max_time_seconds_from_client(client: obs.ReqClient, name="Replay Buffer") -> int:
    response = client.get_output_settings(name=name)
    if response:
        settings = response.output_settings
        if settings and "max_time_sec" in settings:
            return settings["max_time_sec"]
        return 300
    logger.warning(f"get_output_settings for replay_buffer failed: {response.status}")
    return 0


@with_obs_client(default=0, error_msg="Exception while fetching replay buffer settings")
def get_replay_buffer_max_time_seconds(client: obs.ReqClient, name="Replay Buffer"):
    return _get_replay_buffer_max_time_seconds_from_client(client, name=name)


@with_obs_client(default=False, error_msg="Error enabling replay buffer")
def enable_replay_buffer(client: obs.ReqClient):
    response = client.set_output_settings(
        name="Replay Buffer",
        settings={
            "outputFlags": {
                "OBS_OUTPUT_AUDIO": True,
                "OBS_OUTPUT_ENCODED": True,
                "OBS_OUTPUT_MULTI_TRACK": True,
                "OBS_OUTPUT_SERVICE": False,
                "OBS_OUTPUT_VIDEO": True,
            }
        },
    )
    if response and response.ok:
        logger.info("Replay buffer enabled.")
        return True
    logger.error(f"Failed to enable replay buffer: {response.status if response else 'No response'}")
    return False


@with_obs_client(default=None, error_msg="Error getting output list")
def get_output_list(client: obs.ReqClient):
    response = client.get_output_list()
    return response.outputs if response else None


def get_replay_buffer_output(client: Optional[obs.ReqClient] = None):
    if obs_service and obs_service.state.output_state_by_name:
        for output in obs_service.state.output_state_by_name.values():
            if output.get("outputKind") == "replay_buffer":
                return output

    if client is None:
        outputs = get_output_list()
    else:
        response = client.get_output_list()
        outputs = response.outputs if response else None
    if not outputs:
        return None
    for output in outputs:
        if output.get("outputKind") == "replay_buffer":
            return output
    return None


@with_obs_client(default=None, error_msg="Error getting scenes")
def get_obs_scenes(client: obs.ReqClient):
    if client is None:
        logger.error("OBS client is None. Skipping get_scene_list.")
        return None
    response = client.get_scene_list()
    return response.scenes if response else None


async def register_scene_change_callback(callback):
    if await wait_for_obs_connected():
        if not obs_service:
            logger.error("OBS service is not connected.")
            return

        def _on_scene_changed(data):
            scene_name = getattr(data, "scene_name", None)
            if scene_name:
                callback(scene_name)

        obs_service.on("CurrentProgramSceneChanged", _on_scene_changed)
        logger.background("Scene change callback registered.")


@with_obs_client(default=None, error_msg="Error getting screenshot")
def get_screenshot(client: obs.ReqClient, compression=-1):
    screenshot = os.path.join(configuration.get_temporary_directory(), make_unique_file_name("screenshot.png"))
    update_current_game()
    if not configuration.current_game:
        logger.error("No active game scene found.")
        return None

    current_source = get_source_from_scene(configuration.current_game)
    current_source_name = current_source.get("sourceName") if isinstance(current_source, dict) else None
    if not current_source_name:
        logger.error("No active source found in the current scene.")
        return None

    start = time.time()
    logger.debug(f"Current source name: {current_source_name}")
    client.save_source_screenshot(
        name=current_source_name,
        img_format="png",
        width=None,
        height=None,
        file_path=screenshot,
        quality=compression,
    )
    logger.debug(f"Screenshot took {time.time() - start:.3f} seconds to save")
    return screenshot


@with_obs_client(default=None, error_msg="Error getting screenshot")
def get_screenshot_base64(client, compression=75, width=None, height=None):
    update_current_game()
    current_game = get_current_game()
    if not current_game:
        logger.error("No active game scene found.")
        return None
    current_source = get_source_from_scene(current_game)
    current_source_name = current_source.get("sourceName") if isinstance(current_source, dict) else None
    if not current_source_name:
        logger.error("No active source found in the current scene.")
        return None

    response = client.get_source_screenshot(
        name=current_source_name,
        img_format="png",
        quality=compression,
        width=width,
        height=height,
    )

    if response and response.image_data:
        return response.image_data.split(",", 1)[-1]
    logger.error(f"Error getting base64 screenshot: {response}")
    return None


def get_screenshot_PIL_from_source(source_name, compression=75, img_format="png", width=None, height=None, retry=3):
    """
    Get a PIL Image screenshot from a specific OBS source.
    """
    import base64
    import io

    from PIL import Image

    if not source_name:
        logger.error("No source name provided.")
        return None

    def _capture(client):
        response = client.get_source_screenshot(
            name=source_name,
            img_format=img_format,
            quality=compression,
            width=width,
            height=height,
        )
        if not response or not hasattr(response, "image_data") or not response.image_data:
            raise AttributeError("Invalid screenshot response")
        image_data = response.image_data.split(",", 1)[-1]
        image_data = base64.b64decode(image_data)
        img = Image.open(io.BytesIO(image_data))
        img.load()
        return img

    return _call_with_obs_client(
        _capture,
        default=None,
        error_msg=f"Error getting screenshot from source '{source_name}'",
        retryable=True,
        retries=max(0, retry - 1),
    )


def _normalize_ocr_preprocess_mode(preprocess_mode=None, grayscale=False):
    raw_mode = str(preprocess_mode or "").strip().lower()
    aliases = {
        "off": "none",
        "false": "none",
        "0": "none",
        "gray": "grayscale",
        "greyscale": "grayscale",
        "sharpen": "grayscale_unsharp",
        "enhanced": "grayscale_unsharp",
    }
    normalized = aliases.get(raw_mode, raw_mode)
    if not normalized:
        normalized = "grayscale" if grayscale else "none"
    if normalized not in {"none", "grayscale", "grayscale_unsharp"}:
        normalized = "none"
    if grayscale and normalized == "none":
        normalized = "grayscale"
    return normalized


def _apply_ocr_preprocessing(img, preprocess_mode=None, grayscale=False):
    if img is None:
        return None

    normalized_mode = _normalize_ocr_preprocess_mode(preprocess_mode=preprocess_mode, grayscale=grayscale)
    if normalized_mode == "none":
        return img

    from PIL import ImageFilter, ImageOps

    gray = ImageOps.grayscale(img)
    if normalized_mode == "grayscale":
        return gray

    # Enhanced OCR preprocessing: normalize contrast and sharpen thin glyph edges.
    gray = ImageOps.autocontrast(gray, cutoff=1)
    return gray.filter(ImageFilter.UnsharpMask(radius=1.0, percent=120, threshold=2))


def get_best_source_for_screenshot(log_missing_source=True, suppress_errors=False):
    """
    Get the best available video source dict based on priority and image validation.

    Priority order: game_capture > window_capture > monitor_capture

    Returns:
        The source dict of the best available source, or None if no valid source found.
    """
    kwargs = {
        "return_source_dict": True,
        "log_missing_source": log_missing_source,
    }
    if suppress_errors:
        kwargs["suppress_errors"] = True
    return get_screenshot_PIL(**kwargs)


def get_screenshot_PIL(
    source_name=None,
    compression=75,
    img_format="jpg",
    width=None,
    height=None,
    retry=3,
    return_source_dict=False,
    grayscale=False,
    preprocess_mode=None,
    log_missing_source=True,
    suppress_errors=False,
):
    """
    Get a PIL Image screenshot.
    Optionally applies OCR preprocessing to the captured image before returning it.
    """
    if source_name:
        if return_source_dict:
            if suppress_errors:
                current_sources = get_active_video_sources(_suppress_obs_errors=True)
            else:
                current_sources = get_active_video_sources()
            if current_sources:
                for src in current_sources:
                    if src.get("sourceName") == source_name:
                        return src
            return None

        img = get_screenshot_PIL_from_source(source_name, compression, img_format, width, height, retry)
        img = _apply_ocr_preprocessing(img, preprocess_mode=preprocess_mode, grayscale=grayscale)
        return img

    if suppress_errors:
        current_sources = get_active_video_sources(_suppress_obs_errors=True)
    else:
        current_sources = get_active_video_sources()
    if not current_sources:
        if log_missing_source:
            logger.error("No active video sources found in the current scene.")
        return None

    current_scene_name = getattr(getattr(obs_service, "state", None), "current_scene", None) or gsm_state.current_game
    input_active_by_name = getattr(getattr(obs_service, "state", None), "input_active_by_name", None)
    input_show_by_name = getattr(getattr(obs_service, "state", None), "input_show_by_name", None)
    helper_sources = [
        source
        for source in current_sources
        if _should_skip_image_validation(source.get("sourceName"), current_scene_name)
    ]
    non_helper_sources = [source for source in current_sources if source not in helper_sources]
    sorted_sources = [
        *helper_sources,
        *sort_video_sources_by_preference(
            non_helper_sources,
            input_active_by_name=input_active_by_name,
            input_show_by_name=input_show_by_name,
        ),
    ]

    if len(sorted_sources) == 1:
        only_source = sorted_sources[0]
        if return_source_dict:
            return only_source

        img = get_screenshot_PIL_from_source(
            only_source.get("sourceName"),
            compression,
            img_format,
            width,
            height,
            retry,
        )
        img = _apply_ocr_preprocessing(img, preprocess_mode=preprocess_mode, grayscale=grayscale)
        return img

    for source in sorted_sources:
        found_source_name = source.get("sourceName")
        if not found_source_name:
            continue

        img = get_screenshot_PIL_from_source(found_source_name, compression, img_format, width, height, retry)

        if not img:
            continue

        img = _apply_ocr_preprocessing(img, preprocess_mode=preprocess_mode, grayscale=grayscale)
        if _should_skip_image_validation(found_source_name, current_scene_name):
            return source if return_source_dict else img

        try:
            if not is_image_empty(img):
                return source if return_source_dict else img
        except Exception as e:
            logger.warning(f"Failed to validate image from source '{found_source_name}': {e}")
            return source if return_source_dict else img

    return None


def update_current_game():
    previous_game = gsm_state.current_game
    if obs_service and obs_service.state.current_scene:
        gsm_state.current_game = obs_service.state.current_scene
    else:
        gsm_state.current_game = get_current_scene()

    if gsm_state.current_game and gsm_state.current_game != previous_game:
        try:
            from GameSentenceMiner.util.yomitan_dict.sudachi_user_dict import (
                queue_ensure_scene_dictionary,
            )

            queue_ensure_scene_dictionary(
                gsm_state.current_game,
                reason="scene-change",
            )
        except Exception as exc:
            logger.debug(f"Failed to queue Sudachi user dictionary update for '{gsm_state.current_game}': {exc}")


def get_current_game(sanitize=False, update=True):
    if not gsm_state.current_game or update:
        update_current_game()

    if sanitize:
        return sanitize_filename(gsm_state.current_game)
    return gsm_state.current_game


@with_obs_client(default=None, error_msg="An OBS error occurred")
def set_fit_to_screen_for_scene_items(client, scene_name: str):
    """
    Sets all sources in a given scene to "Fit to Screen" (like Ctrl+F in OBS).
    """
    if not scene_name:
        return

    try:
        video_settings = client.get_video_settings()
        if not hasattr(video_settings, "base_width") or not hasattr(video_settings, "base_height"):
            logger.debug(
                "Video settings do not have base_width or base_height attributes, probably weird websocket error issue? Idk what causes it.."
            )
            return
        canvas_width = video_settings.base_width
        canvas_height = video_settings.base_height

        scene_items_response = client.get_scene_item_list(scene_name)
        items = scene_items_response.scene_items if scene_items_response.scene_items else []

        if not items:
            logger.warning(f"No items found in scene '{scene_name}'.")
            return

        for item in items:
            item_id = item["sceneItemId"]
            source_name = item["sourceName"]

            scene_item_transform = item.get("sceneItemTransform", {})

            source_width = scene_item_transform.get("sourceWidth", None)
            source_height = scene_item_transform.get("sourceHeight", None)

            aspect_ratio_different = False
            already_cropped = any(
                [
                    scene_item_transform.get("cropLeft", 0) != 0,
                    scene_item_transform.get("cropRight", 0) != 0,
                    scene_item_transform.get("cropTop", 0) != 0,
                    scene_item_transform.get("cropBottom", 0) != 0,
                ]
            )

            if source_width and source_height and not already_cropped:
                source_aspect_ratio = source_width / source_height
                canvas_aspect_ratio = canvas_width / canvas_height
                aspect_ratio_different = abs(source_aspect_ratio - canvas_aspect_ratio) > 0.01

                standard_ratios = [
                    4 / 3,
                    16 / 9,
                    16 / 10,
                    21 / 9,
                    32 / 9,
                    5 / 4,
                    3 / 2,
                ]

                def is_standard_ratio(ratio):
                    return any(abs(ratio - std) < 0.02 for std in standard_ratios)

                if aspect_ratio_different:
                    if not (is_standard_ratio(source_aspect_ratio) and is_standard_ratio(canvas_aspect_ratio)):
                        aspect_ratio_different = False

            fit_to_screen_transform = {
                "boundsType": "OBS_BOUNDS_SCALE_INNER",
                "alignment": 5,
                "boundsWidth": canvas_width,
                "boundsHeight": canvas_height,
                "positionX": 0,
                "positionY": 0,
            }

            if not True:
                fit_to_screen_transform.update(
                    {
                        "cropLeft": 0
                        if not aspect_ratio_different or canvas_width > source_width
                        else (source_width - canvas_width) // 2,
                        "cropRight": 0
                        if not aspect_ratio_different or canvas_width > source_width
                        else (source_width - canvas_width) // 2,
                        "cropTop": 0
                        if not aspect_ratio_different or canvas_height > source_height
                        else (source_height - canvas_height) // 2,
                        "cropBottom": 0
                        if not aspect_ratio_different or canvas_height > source_height
                        else (source_height - canvas_height) // 2,
                    }
                )

            try:
                client.set_scene_item_transform(
                    scene_name=scene_name,
                    item_id=item_id,
                    transform=fit_to_screen_transform,
                )
            except obs.error.OBSSDKError as e:
                logger.error(f"Failed to set transform for source '{source_name}': {e}")

    except obs.error.OBSSDKError as e:
        logger.error(f"An OBS error occurred: {e}")
    except Exception as e:
        logger.error(f"An unexpected error occurred: {e}")


@with_obs_client(default=None, error_msg="Error getting current source input settings")
def get_current_source_input_settings(client):
    current_scene = get_current_scene()
    if not current_scene:
        return None
    scene_items_response = client.get_scene_item_list(name=current_scene)
    items = scene_items_response.scene_items if scene_items_response and scene_items_response.scene_items else []
    if not items:
        return None
    video_items = get_video_scene_items(items)
    preferred_item = get_preferred_video_source(
        video_items,
        input_active_by_name=obs_service.state.input_active_by_name if obs_service else None,
        input_show_by_name=obs_service.state.input_show_by_name if obs_service else None,
    )
    source_name = (preferred_item or (video_items[0] if video_items else items[0])).get("sourceName")
    if not source_name:
        return None

    if obs_service:
        cached = obs_service.state.input_settings_by_name.get(source_name)
        if cached is not None:
            return cached

    input_settings_response = client.get_input_settings(name=source_name)
    return input_settings_response.input_settings if input_settings_response else None


@with_obs_client(default=None, error_msg="Error getting window info from source")
def get_window_info_from_source(client, scene_name: str = None):
    """
    Get window information from an OBS scene's capture source.
    """
    if not scene_name:
        return None
    scene_items_response = client.get_scene_item_list(name=scene_name)

    if not scene_items_response or not scene_items_response.scene_items:
        logger.warning("No scene items found in scene")
        return None

    candidate_items = get_video_scene_items(scene_items_response.scene_items)
    if not candidate_items:
        candidate_items = list(scene_items_response.scene_items)

    for item in candidate_items:
        source_name = item.get("sourceName")
        if not source_name:
            continue

        cached_settings = obs_service.state.input_settings_by_name.get(source_name) if obs_service else None
        input_settings = cached_settings

        if input_settings is None:
            try:
                input_settings_response = client.get_input_settings(name=source_name)
                if input_settings_response and input_settings_response.input_settings:
                    input_settings = input_settings_response.input_settings
            except Exception as e:
                logger.debug(f"Error getting input settings for source {source_name}: {e}")
                continue

        if input_settings:
            window_value = input_settings.get("window")
            if window_value:
                parts = window_value.split(":")
                if len(parts) >= 3:
                    return {
                        "title": parts[0].strip(),
                        "window_class": parts[1].strip(),
                        "exe": parts[2].strip(),
                    }

    return None


@with_obs_client(default=None, error_msg="Error calling GetInputAudioTracks")
def get_input_audio_tracks(client, input_name: str = None, input_uuid: str = None):
    """Retrieve the enable state of all audio tracks for a given input."""
    try:
        kwargs = {}
        if input_name:
            kwargs["inputName"] = input_name
        if input_uuid:
            kwargs["inputUuid"] = input_uuid
        response = client.get_input_audio_tracks(**kwargs)
        return response.input_audio_tracks if response else None
    except AttributeError:
        logger.error("OBS client does not support 'get_input_audio_tracks' (older websocket/version).")
        return None


@with_obs_client(default=False, error_msg="Error calling SetInputAudioTracks")
def set_input_audio_tracks(
    client,
    input_name: str = None,
    input_uuid: str = None,
    input_audio_tracks: dict = None,
):
    """Set the enable state of audio tracks for a given input."""
    if input_audio_tracks is None:
        logger.error("No `input_audio_tracks` provided to set_input_audio_tracks.")
        return False
    try:
        kwargs = {"inputAudioTracks": input_audio_tracks}
        if input_name:
            kwargs["inputName"] = input_name
        if input_uuid:
            kwargs["inputUuid"] = input_uuid
        response = client.set_input_audio_tracks(**kwargs)
        if response and getattr(response, "ok", False):
            return True
        return False
    except AttributeError:
        logger.error("OBS client does not support 'set_input_audio_tracks' (older websocket/version).")
        return False


@with_obs_client(default=False, error_msg="Error disabling desktop audio")
def disable_desktop_audio(client):
    """Disable all audio tracks for the desktop audio input."""
    candidate_names = [
        "Desktop Audio",
        "Desktop Audio 2",
        "Desktop Audio Device",
        "Desktop",
    ]

    try:
        inputs_resp = client.get_input_list()
        inputs = inputs_resp.inputs if inputs_resp else []
    except Exception:
        inputs = []

    desktop_input = None
    for inp in inputs:
        name = inp.get("inputName") or inp.get("name")
        kind = inp.get("inputKind") or inp.get("kind")
        if (
            name in candidate_names
            or (isinstance(kind, str) and "audio" in kind.lower())
            or (name and "desktop" in name.lower())
        ):
            desktop_input = inp
            break

    if not desktop_input:
        for inp in inputs:
            kind = inp.get("inputKind") or inp.get("kind")
            if kind in (
                "monitor_capture",
                "wasapi_output_capture",
                "pulse_audio_output_capture",
            ) or (kind and "audio" in kind.lower()):
                desktop_input = inp
                break

    if not desktop_input:
        logger.error("Desktop audio input not found in OBS inputs.")
        return False

    input_name = desktop_input.get("inputName") or desktop_input.get("name")
    input_uuid = desktop_input.get("inputId") or desktop_input.get("id")

    current_tracks = get_input_audio_tracks(input_name=input_name, input_uuid=input_uuid)
    if not current_tracks:
        tracks_payload = {str(i): False for i in range(1, 7)}
    else:
        tracks_payload = {k: False for k in current_tracks.keys()}

    success = set_input_audio_tracks(input_name=input_name, input_uuid=input_uuid, input_audio_tracks=tracks_payload)
    if success:
        logger.info(f"Disabled desktop audio for input '{input_name}'")
        return True
    logger.error("Failed to disable desktop audio via SetInputAudioTracks")
    return False


def main():
    start_obs()
    connect_to_obs_sync()
    print("Testing `get_obs_path`:", get_obs_path())
    print("Testing `is_process_running` with PID 1:", is_process_running(1))
    print("Testing `check_obs_folder_is_correct`:")
    asyncio.run(check_obs_folder_is_correct())
    print("Testing `get_obs_websocket_config_values`:")
    try:
        get_obs_websocket_config_values()
    except FileNotFoundError as e:
        print(e)
    print("Testing `toggle_replay_buffer`:")
    toggle_replay_buffer()
    print("Testing `start_replay_buffer`:")
    start_replay_buffer()
    print("Testing `get_replay_buffer_status`:", get_replay_buffer_status())
    print("Testing `stop_replay_buffer`:")
    stop_replay_buffer()
    print("Testing `save_replay_buffer`:")
    try:
        save_replay_buffer()
    except Exception as e:
        print(f"Could not save replay buffer: {e}")
    current_scene = get_current_scene()
    print("Testing `get_current_scene`:", current_scene)
    print(
        "Testing `get_source_from_scene` with current scene:",
        get_source_from_scene(current_scene),
    )
    print("Testing `get_record_directory`:", get_record_directory())
    print("Testing `get_obs_scenes`:", get_obs_scenes())
    print("Testing `get_screenshot`:", get_screenshot())
    print("Testing `get_screenshot_base64`:")
    get_screenshot_base64()
    print("Testing `update_current_game`:")
    update_current_game()
    print("Testing `get_current_game`:", get_current_game())
    disconnect_from_obs()


@with_obs_client(retryable=False)
def create_scene(client):
    request_json = r'{"sceneName":"SILENT HILL f","inputName":"SILENT HILL f - Capture","inputKind":"window_capture","inputSettings":{"mode":"window","window":"SILENT HILL f  :UnrealWindow:SHf-Win64-Shipping.exe","capture_audio":true,"cursor":false,"method":"2"}}'
    request_dict = json.loads(request_json)
    scene_name = request_dict.get("sceneName")
    input_name = request_dict.get("inputName")
    input_kind = request_dict.get("inputKind")
    input_settings = request_dict.get("inputSettings")
    input_settings["method"] = 2
    request_dict.pop("sceneName", None)
    client.create_input(
        inputName=input_name,
        inputKind=input_kind,
        sceneName=scene_name,
        inputSettings=input_settings,
        sceneItemEnabled=True,
    )


def pretty_print_response(resp):
    print(json.dumps(resp, indent=4))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    connect_to_obs_sync()

    # outputs = get_output_list()
    # print(outputs)

    # output = get_replay_buffer_output()
    # print(output)

    # Test speed of png 75 none none vs jpeg 90 none none vs jpeg 90 1280x720
    # from GameSentenceMiner.owocr.owocr.ocr import OneOCR
    # oneocr = OneOCR()
    # times = {}
    # for test in ["png 75 none none", "jpeg 90 none none", "jpeg 90 1280 720"]:
    #     parts = test.split()
    #     compression = int(parts[1])
    #     width = None if parts[2] == "none" else int(parts[2])
    #     height = None if parts[3] == "none" else int(parts[3])
    #     timess = []
    #     ocr_times = []
    #     for _ in range(10):
    #         start_time = time.time()
    #         img = get_screenshot_PIL(
    #             compression=compression,
    #             img_format=parts[0],
    #             width=width,
    #             height=height,
    #         )
    #         end_time = time.time()
    #         timess.append(end_time - start_time)
    #         start_time = time.time()
    #         ocr_result = oneocr(img)
    #         end_time = time.time()
    #         ocr_times.append(end_time - start_time)
    #     avg_time = sum(timess) / len(timess)
    #     times[test] = avg_time
    #     print(f"Test '{test}' took {avg_time:.2f} seconds on average")
    #     print(f"Test '{test}' OneOCR took {sum(ocr_times) / len(ocr_times):.2f} seconds on average")
