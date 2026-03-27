"""OBSService — central OBS state manager and event router.

Changes vs. the original monolithic obs.py:
* Removed dead ``_update_state()`` method (every branch returned early).
* Removed ``_handler_accepts_event_name`` introspection hack — all handlers
  receive ``(data)`` only (the obsws convention).
* Added tick concurrency guard (``_tick_running`` flag).
* Added tick budget: warn at >2 s, abort remaining work at >5 s.
* Added replay-buffer auto-start rate limiter (max 3 per 60 s).
* ``_tick_last_run_by_operation`` initialised in ``__init__`` (no hasattr).
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Dict, List, Optional

import obsws_python as obs
from obsws_python.util import to_snake_case

from GameSentenceMiner.obs.connection import OBSConnectionPool
from GameSentenceMiner.obs.types import (
    OBS_DEFAULT_RETRY_COUNT,
    OBSState,
    OBSTickIntervals,
    OBSTickOptions,
    _is_obs_recording_disabled,
    get_preferred_video_source,
    get_video_scene_items,
    is_image_empty,
)
from GameSentenceMiner.obs._state import _queue_error_for_gui
from GameSentenceMiner.util.config.configuration import get_config, gsm_state, logger

# Tick budget thresholds (seconds)
_TICK_WARN_SECONDS = 2.0
_TICK_ABORT_SECONDS = 5.0

# Replay buffer auto-start rate limiter
_REPLAY_AUTOSTART_MAX = 3
_REPLAY_AUTOSTART_WINDOW_SECONDS = 60.0


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

        # Replay buffer action grace-period tracking
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

        # Replay buffer auto-start rate limiter
        self._replay_autostart_timestamps: list[float] = []

        # Tick scheduling & guards
        self.tick_intervals = OBSTickIntervals()
        self._tick_last_run_by_operation: Dict[str, float] = {}
        self._tick_running = False

        self._register_default_handlers()
        self._initialize_state()
        self.initialized = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Event system
    # ------------------------------------------------------------------

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
            try:
                handler(data)
            except Exception as exc:
                logger.debug(f"Error in OBS event handler for {event_name}: {exc}")

    # ------------------------------------------------------------------
    # Replay buffer grace-period helpers
    # ------------------------------------------------------------------

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
        if self._auto_start_paused_by_external_replay_stop:
            logger.debug("Skipping replay buffer auto-start because it was stopped outside GSM.")
            return False
        # Rate-limit auto-start attempts
        now = time.monotonic()
        cutoff = now - _REPLAY_AUTOSTART_WINDOW_SECONDS
        self._replay_autostart_timestamps = [t for t in self._replay_autostart_timestamps if t > cutoff]
        if len(self._replay_autostart_timestamps) >= _REPLAY_AUTOSTART_MAX:
            logger.debug(
                f"Replay buffer auto-start rate-limited ({_REPLAY_AUTOSTART_MAX} "
                f"attempts in last {_REPLAY_AUTOSTART_WINDOW_SECONDS:.0f}s)."
            )
            return False
        self._replay_autostart_timestamps.append(now)
        return True

    # ------------------------------------------------------------------
    # Tick scheduling
    # ------------------------------------------------------------------

    def _is_tick_operation_due(
        self, operation_name: str, interval_seconds: float, now: float, force: bool = False
    ) -> bool:
        if force or interval_seconds <= 0:
            return True
        last_run = self._tick_last_run_by_operation.get(operation_name)
        return last_run is None or (now - last_run) >= interval_seconds

    def _mark_tick_operation(self, operation_name: str, now: float):
        self._tick_last_run_by_operation[operation_name] = now

    def build_scheduled_tick_options(
        self, now: Optional[float] = None, overrides: Optional[OBSTickOptions] = None
    ) -> OBSTickOptions:
        now = time.time() if now is None else now
        overrides = overrides or OBSTickOptions()
        tick_intervals = self.tick_intervals

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

    # ------------------------------------------------------------------
    # Main tick
    # ------------------------------------------------------------------

    def tick(self, options: Optional[OBSTickOptions] = None):
        # Guard against concurrent ticks
        if getattr(self, "_tick_running", False):
            return
        self._tick_running = True
        tick_start = time.monotonic()
        try:
            self._tick_inner(options, tick_start)
        finally:
            elapsed = time.monotonic() - tick_start
            if elapsed > _TICK_WARN_SECONDS:
                logger.warning(f"OBS tick took {elapsed:.2f}s (budget {_TICK_WARN_SECONDS}s)")
            self._tick_running = False

    def _tick_inner(self, options: Optional[OBSTickOptions], tick_start: float):
        if not self.initialized:
            self._initialize_state()

        now = time.time()
        resolved_options = self.build_scheduled_tick_options(now=now, overrides=options)
        if not self.has_tick_work(resolved_options):
            return

        def _over_budget() -> bool:
            return (time.monotonic() - tick_start) > _TICK_ABORT_SECONDS

        if resolved_options.refresh_full_state:
            self._initialize_state()
            self._mark_tick_operation("full_state_refresh", now)

        with self._state_lock:
            current_scene = self.state.current_scene
        scene_changed = False

        if resolved_options.refresh_current_scene:
            # Import via package so monkeypatches take effect
            import GameSentenceMiner.obs as _obs_pkg

            refreshed_scene = _obs_pkg.get_current_scene()
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

        if _over_budget():
            return

        if resolved_options.refresh_scene_items and current_scene:
            self._refresh_scene_items(current_scene)
            self._mark_tick_operation("refresh_scene_items", now)

        if resolved_options.fit_to_screen and current_scene:
            import GameSentenceMiner.obs as _obs_pkg

            _obs_pkg.set_fit_to_screen_for_scene_items(current_scene)
            self._mark_tick_operation("fit_to_screen", now)

        if _over_budget():
            return

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
                import GameSentenceMiner.obs as _obs_pkg

                _obs_pkg.start_replay_buffer()
            return

        if replay_buffer_active:
            if self._source_no_output_timestamp is None:
                self._source_no_output_timestamp = now
            elif now - self._source_no_output_timestamp >= self._no_output_shutdown_seconds:
                import GameSentenceMiner.obs as _obs_pkg

                _obs_pkg.stop_replay_buffer()
                self._source_no_output_timestamp = None

    # ------------------------------------------------------------------
    # Scene-item helpers
    # ------------------------------------------------------------------

    def _get_scene_items_for_scene(self, scene_name: str) -> List[dict]:
        if not scene_name:
            return []
        with self._state_lock:
            cached_items = self.state.scene_items_by_scene.get(scene_name)
            if cached_items is not None:
                return list(cached_items)
        self._refresh_scene_items(scene_name)
        with self._state_lock:
            return list(self.state.scene_items_by_scene.get(scene_name, []))

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
        from GameSentenceMiner.obs.screenshots import get_screenshot_PIL_from_source

        img = get_screenshot_PIL_from_source(source_name, compression=50, img_format="jpg", width=8, height=8, retry=1)
        if not img:
            return False
        return not is_image_empty(img)

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

        # Temporarily enable game capture to probe it
        if preferred_game_item and not bool(preferred_game_item.get("sceneItemEnabled", True)):
            set_enabled_if_needed([preferred_game_item], True)

        # Decision: prefer game capture if it has output
        if preferred_game_item and self._probe_source_has_output(preferred_game_item.get("sourceName")):
            set_enabled_if_needed(game_items, True)
            set_enabled_if_needed(window_items, False)
            with self._state_lock:
                self.state.current_source_name = preferred_game_item.get("sourceName")
            return True

        # Fallback: window capture
        if preferred_window_item and self._probe_source_has_output(preferred_window_item.get("sourceName")):
            set_enabled_if_needed(game_items, False)
            set_enabled_if_needed(window_items, True)
            with self._state_lock:
                self.state.current_source_name = preferred_window_item.get("sourceName")
            return True

        # Neither has output — enable all available so they're ready when game starts
        if game_items and window_items:
            set_enabled_if_needed(game_items, True)
            set_enabled_if_needed(window_items, True)
        elif game_items:
            set_enabled_if_needed(game_items, True)
        elif window_items:
            set_enabled_if_needed(window_items, True)

        return False

    # ------------------------------------------------------------------
    # State refresh helpers
    # ------------------------------------------------------------------

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
        import GameSentenceMiner.obs as _obs_pkg

        output_name = self.state.replay_buffer_output_name
        if client is None:
            buffer_seconds = _obs_pkg.get_replay_buffer_max_time_seconds(name=output_name)
        else:
            buffer_seconds = _obs_pkg._get_replay_buffer_max_time_seconds_from_client(client, name=output_name)
        if not buffer_seconds:
            replay_output = _obs_pkg._obs_pkg.get_replay_buffer_output(client=client)
            if not replay_output:
                _queue_error_for_gui(
                    "OBS Replay Buffer Error",
                    "Replay Buffer output not found in OBS. Please enable Replay Buffer In OBS Settings -> Output -> Replay Buffer. I recommend 300 seconds (5 minutes) or higher.\n\nTo disable this message, turn off 'Automatically Manage Replay Buffer' in GSM settings.",
                    recheck_function=_obs_pkg.get_replay_buffer_output,
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

        import GameSentenceMiner.obs as _obs_pkg

        replay_buffer_active = _obs_pkg.get_replay_buffer_status()
        if replay_buffer_active is not None:
            replay_buffer_active = bool(replay_buffer_active)
            with self._state_lock:
                self.state.replay_buffer_active = replay_buffer_active
        return replay_buffer_active

    def _is_output_active_from_screenshot(self) -> Optional[bool]:
        import GameSentenceMiner.obs as _obs_pkg

        img = _obs_pkg.get_screenshot_PIL(compression=50, img_format="jpg", width=8, height=8)
        if not img:
            return None
        return not is_image_empty(img)

    # ------------------------------------------------------------------
    # Default event handlers
    # ------------------------------------------------------------------

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
            import GameSentenceMiner.obs as _obs_pkg

            self._refresh_scene_items(scene_name)
            _obs_pkg.set_fit_to_screen_for_scene_items(scene_name)
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
                import GameSentenceMiner.obs as _obs_pkg

                _obs_pkg.start_replay_buffer()
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
        from GameSentenceMiner.obs import longplay_handler

        output_active = getattr(data, "output_active", None)
        output_path = getattr(data, "output_path", None)
        with self._state_lock:
            if output_active is not None:
                self.state.record_active = bool(output_active)
        longplay_handler.on_record_state_changed(output_active=output_active, output_path=output_path)

    def _handle_record_file_changed(self, data):
        from GameSentenceMiner.obs import longplay_handler

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
