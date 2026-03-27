"""Dataclasses, constants, and pure helper functions for the OBS integration."""

from __future__ import annotations

import socket
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import obsws_python as obs

# ---------------------------------------------------------------------------
# Video source kinds & priority
# ---------------------------------------------------------------------------

VIDEO_SOURCE_KINDS = {"window_capture", "game_capture", "monitor_capture"}
VIDEO_SOURCE_PRIORITY = {
    "game_capture": 0,
    "window_capture": 1,
    "monitor_capture": 2,
}

HELPER_SCENE_NAMES = {"GSM Helper - DONT TOUCH"}
HELPER_SOURCE_NAMES = {"window_getter", "game_window_getter"}

# ---------------------------------------------------------------------------
# Retry / backoff constants
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

# Circuit-breaker thresholds
CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5
CIRCUIT_BREAKER_COOLDOWN_SECONDS = 10.0

# ---------------------------------------------------------------------------
# OBS state dataclasses
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Pure helper functions
# ---------------------------------------------------------------------------


def get_video_source_priority(input_kind: Optional[str]) -> int:
    return VIDEO_SOURCE_PRIORITY.get(str(input_kind or ""), 999)


def sort_video_sources_by_preference(
    scene_items: List[dict],
    input_active_by_name: Optional[Dict[str, bool]] = None,
    input_show_by_name: Optional[Dict[str, bool]] = None,
) -> List[dict]:
    """Sort scene items so working game capture is preferred, with window capture as fallback.

    Sources explicitly marked inactive or hidden are pushed behind candidates that still
    have a chance of producing output.
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


def _should_skip_image_validation(source_name: Optional[str] = None, scene_name: Optional[str] = None) -> bool:
    normalized_scene_name = str(scene_name or "").strip().casefold()
    if normalized_scene_name in {name.casefold() for name in HELPER_SCENE_NAMES}:
        return True
    normalized_source_name = str(source_name or "").strip().casefold()
    return normalized_source_name in {name.casefold() for name in HELPER_SOURCE_NAMES}


def _is_obs_recording_disabled(config_override=None) -> bool:
    from GameSentenceMiner.util.config.configuration import get_config

    cfg = config_override or get_config()
    return bool(getattr(cfg.obs, "disable_recording", False))


# ---------------------------------------------------------------------------
# Retry helpers
# ---------------------------------------------------------------------------


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
