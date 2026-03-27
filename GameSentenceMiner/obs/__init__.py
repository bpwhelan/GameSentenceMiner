"""GameSentenceMiner.obs — OBS WebSocket integration package.

This ``__init__.py`` re-exports the complete public API so that every
``import GameSentenceMiner.obs as obs`` / ``from GameSentenceMiner.obs import …``
in the codebase continues to work without changes.

Module-level state variables (``connection_pool``, ``obs_service``, etc.) are
backed by accessor functions in ``_state``.  ``__getattr__`` delegates reads
there; writes (e.g. test monkeypatches) are stored directly on this module
and take precedence on subsequent reads.
"""

from __future__ import annotations

# Re-export standard library modules that tests monkeypatch on this module
import logging as _logging
import time  # noqa: F401  — tests monkeypatch obs_module.time

import obsws_python as obs  # noqa: F401  — tests monkeypatch obs_module.obs

# Silence obsws_python logger
_logging.getLogger("obsws_python").setLevel(_logging.CRITICAL)

# ---------------------------------------------------------------------------
# Types / dataclasses / constants
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.types import (  # noqa: F401
    HELPER_SCENE_NAMES,
    HELPER_SOURCE_NAMES,
    OBS_DEFAULT_RETRY_COUNT,
    OBS_RETRYABLE_ERROR_SUBSTRINGS,
    OBS_RETRY_BASE_DELAY_SECONDS,
    OBS_RETRY_MAX_DELAY_SECONDS,
    OBSState,
    OBSTickIntervals,
    OBSTickOptions,
    VIDEO_SOURCE_KINDS,
    VIDEO_SOURCE_PRIORITY,
    _get_obs_retry_delay_seconds,
    _is_obs_recording_disabled,
    _is_retryable_obs_exception,
    _should_skip_image_validation,
    get_preferred_video_source,
    get_video_scene_items,
    get_video_source_priority,
    is_image_empty,
    sort_video_sources_by_preference,
)

# ---------------------------------------------------------------------------
# State accessors + GUI error queue
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs._state import (  # noqa: F401
    OBS_PID_FILE,
    _queue_error_for_gui,
    get_queued_gui_errors,
)

# ---------------------------------------------------------------------------
# Connection pool
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.connection import OBSConnectionPool  # noqa: F401

# ---------------------------------------------------------------------------
# Client wrapper / decorator
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.client_wrapper import (  # noqa: F401
    _call_with_obs_client,
    _recover_obs_service_clients_sync,
    with_obs_client,
)

# ---------------------------------------------------------------------------
# OBSService
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.service import OBSService  # noqa: F401

# ---------------------------------------------------------------------------
# Connection manager
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.connection_manager import OBSConnectionManager  # noqa: F401

# ---------------------------------------------------------------------------
# Screenshots
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.screenshots import (  # noqa: F401
    _apply_ocr_preprocessing,
    _normalize_ocr_preprocess_mode,
    get_best_source_for_screenshot,
    get_screenshot,
    get_screenshot_base64,
    get_screenshot_PIL,
    get_screenshot_PIL_from_source,
)

# ---------------------------------------------------------------------------
# Operations (replay buffer, recording, scenes, sources, FPS, audio, game)
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.operations import (  # noqa: F401
    _clamp_obs_recording_fps,
    _get_effective_recording_fps,
    _get_replay_buffer_max_time_seconds_from_client,
    add_longplay_srt_line,
    apply_obs_performance_settings,
    apply_recording_fps,
    check_obs_folder_is_correct,
    disable_desktop_audio,
    do_obs_call,
    enable_replay_buffer,
    get_active_source,
    get_active_video_sources,
    get_current_game,
    get_current_scene,
    get_current_source_input_settings,
    get_input_audio_tracks,
    get_last_recording_filename,
    get_obs_scenes,
    get_output_list,
    get_record_directory,
    get_replay_buffer_max_time_seconds,
    get_replay_buffer_output,
    get_replay_buffer_status,
    get_source_active,
    get_source_from_scene,
    get_window_info_from_source,
    longplay_handler,
    register_scene_change_callback,
    save_replay_buffer,
    set_fit_to_screen_for_scene_items,
    set_input_audio_tracks,
    start_recording,
    start_replay_buffer,
    stop_recording,
    stop_replay_buffer,
    toggle_replay_buffer,
    update_current_game,
)

# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.process import (  # noqa: F401
    _build_obs_launch_command,
    _cleanup_obs_startup_artifacts,
    _remove_obs_startup_artifact,
    _resolve_obs_launch_command,
    get_base_obs_dir,
    get_obs_path,
    get_obs_websocket_config_values,
    is_process_running,
    start_obs,
)

# ---------------------------------------------------------------------------
# Connect / disconnect / wait
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.connect import (  # noqa: F401
    connect_to_obs,
    connect_to_obs_sync,
    disconnect_from_obs,
    is_obs_websocket_reachable,
    wait_for_obs_connected,
    wait_for_obs_ready,
    wait_for_obs_websocket_ready,
)

# ---------------------------------------------------------------------------
# Re-exported configuration objects that tests monkeypatch on this module
# ---------------------------------------------------------------------------
from GameSentenceMiner.util.config.configuration import (  # noqa: F401
    gsm_state,
    gsm_status,
    logger,
)

# ---------------------------------------------------------------------------
# __getattr__ for mutable state variables backed by _state accessors
# ---------------------------------------------------------------------------

# Names that are delegated to _state module on read (if not already set
# directly on this module, e.g. by a monkeypatch).
_STATE_ATTR_GETTERS = {
    "connection_pool": "get_connection_pool",
    "event_client": "get_event_client",
    "obs_service": "get_obs_service",
    "obs_process_pid": "get_obs_process_pid",
    "obs_connection_manager": "get_obs_connection_manager",
    "connecting": "is_connecting",
}


def __getattr__(name: str):
    getter_name = _STATE_ATTR_GETTERS.get(name)
    if getter_name is not None:
        from GameSentenceMiner.obs import _state

        getter = getattr(_state, getter_name)
        return getter()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
