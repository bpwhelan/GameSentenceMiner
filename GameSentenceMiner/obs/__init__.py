"""OBS integration package for GameSentenceMiner."""

import logging
import os

import obsws_python as obs  # noqa: F401 — re-exported for consumers & tests

from GameSentenceMiner.longplay_handler import LongPlayHandler
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import get_config, gsm_state, gsm_status  # noqa: F401

logging.getLogger("obsws_python").setLevel(logging.CRITICAL)

# ---------------------------------------------------------------------------
# Module-level globals (accessed by gsm.py, tests, etc.)
# ---------------------------------------------------------------------------
obs_service: "OBSService" = None  # noqa: F821
connection_pool: "OBSConnectionPool" = None  # noqa: F821
event_client = None
obs_process_pid = None
OBS_PID_FILE = os.path.join(configuration.get_app_directory(), "obs_pid.txt")
obs_connection_manager = None
connecting = False


def _get_current_game_sanitized() -> str:
    # Lazy import to avoid circular dependency at module load time

    return get_current_game(sanitize=True)


longplay_handler = LongPlayHandler(
    feature_enabled_getter=lambda: bool(get_config().features.generate_longplay),
    game_name_getter=_get_current_game_sanitized,
)

# ---------------------------------------------------------------------------
# Re-export the full public API from submodules so that
#   ``from GameSentenceMiner import obs; obs.get_current_game()``
# keeps working exactly as before.
# ---------------------------------------------------------------------------
from GameSentenceMiner.obs.launch import (  # noqa: E402, F401
    VIDEO_SOURCE_KINDS,
    VIDEO_SOURCE_PRIORITY,
    _build_obs_launch_command,
    _cleanup_obs_startup_artifacts,
    _queue_error_for_gui,
    _resolve_obs_launch_command,
    _should_skip_image_validation,
    get_base_obs_dir,
    get_obs_path,
    get_obs_websocket_config_values,
    get_preferred_video_source,
    get_queued_gui_errors,
    get_video_scene_items,
    get_video_source_priority,
    is_image_empty,
    is_obs_websocket_reachable,
    is_process_running,
    parse_obs_window_target,
    sort_video_sources_by_preference,
    start_obs,
    wait_for_obs_ready,
    wait_for_obs_websocket_ready,
)

from GameSentenceMiner.obs.service import (  # noqa: E402, F401
    GAME_CAPTURE_REMOVAL_THRESHOLD,
    OBSConnectionManager,
    OBSConnectionPool,
    OBSService,
    OBSState,
    OBSTickIntervals,
    OBSTickOptions,
    _is_obs_recording_disabled,
    _is_retryable_obs_exception,
    check_obs_folder_is_correct,
    connect_to_obs,
    connect_to_obs_sync,
    disconnect_from_obs,
    wait_for_obs_connected,
)

from GameSentenceMiner.obs.actions import (  # noqa: E402, F401
    _apply_ocr_preprocessing,
    _normalize_ocr_preprocess_mode,
    add_longplay_srt_line,
    apply_obs_performance_settings,
    apply_recording_fps,
    disable_desktop_audio,
    get_active_source,
    get_active_video_sources,
    get_best_source_for_screenshot,
    get_current_game,
    get_current_scene,
    get_current_source_input_settings,
    get_input_audio_tracks,
    get_obs_scenes,
    get_output_list,
    get_record_directory,
    get_replay_buffer_max_time_seconds,
    get_replay_buffer_output,
    get_replay_buffer_status,
    get_screenshot,
    get_screenshot_base64,
    get_screenshot_PIL,
    get_screenshot_PIL_from_source,
    get_source_from_scene,
    get_window_info_from_source,
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
    with_obs_client,
)

import GameSentenceMiner.obs.service as _svc_mod  # noqa: E402
import GameSentenceMiner.obs.actions as _act_mod  # noqa: E402

# Patch logger onto the package namespace so tests that do ``obs_module.logger``
# or ``obs.logger`` see the canonical logger.
from GameSentenceMiner.util.config.configuration import logger  # noqa: E402, F401

# Allow ``import GameSentenceMiner.obs.service as obs_service_module`` in tests
# and ``import GameSentenceMiner.obs.connect as obs_connect_module`` (keep compat)
# by aliasing .connect → .service
import sys as _sys  # noqa: E402

_sys.modules.setdefault("GameSentenceMiner.obs.connect", _svc_mod)

# Re-export time for monkeypatching in tests
import time  # noqa: E402, F401
