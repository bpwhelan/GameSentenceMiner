"""All @with_obs_client decorated operations and related helpers.

This module contains the public API surface that the rest of GSM calls for
replay-buffer management, recording, scene/source queries, FPS tuning,
audio, and game management.
"""

from __future__ import annotations

import time
from typing import Optional

import obsws_python as obs

from GameSentenceMiner.longplay_handler import LongPlayHandler
from GameSentenceMiner.obs._state import (
    get_connection_pool,
    get_obs_service,
    is_connecting,
)
from GameSentenceMiner.obs.client_wrapper import (
    _call_with_obs_client,
    _recover_obs_service_clients_sync,
    with_obs_client,
)
from GameSentenceMiner.obs.types import (
    VIDEO_SOURCE_KINDS,
    _is_obs_recording_disabled,
    get_preferred_video_source,
    get_video_scene_items,
    sort_video_sources_by_preference,
)
from GameSentenceMiner.util.config.configuration import (
    get_config,
    get_master_config,
    gsm_state,
    logger,
    save_full_config,
)
from GameSentenceMiner.util.gsm_utils import sanitize_filename

# ---------------------------------------------------------------------------
# Longplay handler (lives here because it couples to recording operations)
# ---------------------------------------------------------------------------

longplay_handler = LongPlayHandler(
    feature_enabled_getter=lambda: bool(get_config().features.generate_longplay),
    game_name_getter=lambda: get_current_game(sanitize=True),
)


# ---------------------------------------------------------------------------
# Generic OBS call helper
# ---------------------------------------------------------------------------


def do_obs_call(method_name: str, from_dict=None, retry=3, **kwargs):
    from GameSentenceMiner.obs.connect import connect_to_obs_sync

    pool = get_connection_pool()
    if not pool:
        obs_service = get_obs_service()
        if obs_service:
            _recover_obs_service_clients_sync()
        elif not is_connecting():
            connect_to_obs_sync(retry=1)
    pool = get_connection_pool()
    if not pool:
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


# ---------------------------------------------------------------------------
# Replay buffer operations
# ---------------------------------------------------------------------------


@with_obs_client(error_msg="Error toggling buffer", retryable=False)
def toggle_replay_buffer(client: obs.ReqClient):
    if _is_obs_recording_disabled():
        logger.warning("OBS replay buffer toggle blocked: OBS recording/replay is disabled in GSM settings.")
        return
    obs_service = get_obs_service()
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
    obs_service = get_obs_service()
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
    obs_service = get_obs_service()
    if obs_service and obs_service.state.replay_buffer_active is not None:
        return obs_service.state.replay_buffer_active
    return client.get_replay_buffer_status().output_active


@with_obs_client(error_msg="Error stopping replay buffer")
def stop_replay_buffer(client: obs.ReqClient):
    obs_service = get_obs_service()
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


# ---------------------------------------------------------------------------
# Replay buffer settings
# ---------------------------------------------------------------------------


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
    obs_service = get_obs_service()
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


# ---------------------------------------------------------------------------
# Recording operations
# ---------------------------------------------------------------------------


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


@with_obs_client(default="", error_msg="Error getting recording folder")
def get_record_directory(client: obs.ReqClient):
    response = client.get_record_directory()
    return response.record_directory if response else ""


# ---------------------------------------------------------------------------
# Scene & source queries
# ---------------------------------------------------------------------------


@with_obs_client(
    default="",
    error_msg="Couldn't get scene",
    fallback=lambda: (
        get_obs_service().state.current_scene
        if get_obs_service() and get_obs_service().state.current_scene
        else gsm_state.current_game or ""
    ),
)
def get_current_scene(client: obs.ReqClient):
    obs_service = get_obs_service()
    if obs_service and obs_service.state.current_scene:
        return obs_service.state.current_scene
    response = client.get_current_program_scene()
    return response.scene_name if response else ""


@with_obs_client(default="", error_msg="Error getting source from scene")
def get_source_from_scene(client: obs.ReqClient, scene_name):
    obs_service = get_obs_service()
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
    obs_service = get_obs_service()
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


@with_obs_client(default=None, error_msg="Error getting scenes")
def get_obs_scenes(client: obs.ReqClient):
    if client is None:
        logger.error("OBS client is None. Skipping get_scene_list.")
        return None
    response = client.get_scene_list()
    return response.scenes if response else None


async def register_scene_change_callback(callback):
    from GameSentenceMiner.obs.connect import wait_for_obs_connected

    if await wait_for_obs_connected():
        obs_service = get_obs_service()
        if not obs_service:
            logger.error("OBS service is not connected.")
            return

        def _on_scene_changed(data):
            scene_name = getattr(data, "scene_name", None)
            if scene_name:
                callback(scene_name)

        obs_service.on("CurrentProgramSceneChanged", _on_scene_changed)
        logger.background("Scene change callback registered.")


# ---------------------------------------------------------------------------
# Game management
# ---------------------------------------------------------------------------


def update_current_game():
    obs_service = get_obs_service()
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


# ---------------------------------------------------------------------------
# FPS / performance
# ---------------------------------------------------------------------------


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

    obs_service = get_obs_service()
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
        pass

    try:
        record_status = client.get_record_status()
        record_was_active = bool(getattr(record_status, "output_active", False))
    except Exception:
        pass

    try:
        stream_status = client.get_stream_status()
        stream_was_active = bool(getattr(stream_status, "output_active", False))
    except Exception:
        pass

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


# ---------------------------------------------------------------------------
# Fit to screen
# ---------------------------------------------------------------------------


@with_obs_client(default=None, error_msg="An OBS error occurred")
def set_fit_to_screen_for_scene_items(client, scene_name: str):
    """Sets all sources in a given scene to "Fit to Screen" (like Ctrl+F in OBS)."""
    if not scene_name:
        return

    try:
        video_settings = client.get_video_settings()
        if not hasattr(video_settings, "base_width") or not hasattr(video_settings, "base_height"):
            logger.debug(
                "Video settings do not have base_width or base_height attributes, probably weird websocket error issue?"
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

            fit_to_screen_transform = {
                "boundsType": "OBS_BOUNDS_SCALE_INNER",
                "alignment": 5,
                "boundsWidth": canvas_width,
                "boundsHeight": canvas_height,
                "positionX": 0,
                "positionY": 0,
            }

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


# ---------------------------------------------------------------------------
# Input settings / window info
# ---------------------------------------------------------------------------


@with_obs_client(default=None, error_msg="Error getting current source input settings")
def get_current_source_input_settings(client):
    obs_service = get_obs_service()
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
    """Get window information from an OBS scene's capture source."""
    if not scene_name:
        return None
    obs_service = get_obs_service()
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


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# OBS folder validation
# ---------------------------------------------------------------------------


async def check_obs_folder_is_correct():
    from GameSentenceMiner.obs.connect import wait_for_obs_connected

    if await wait_for_obs_connected():
        try:
            import os

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
