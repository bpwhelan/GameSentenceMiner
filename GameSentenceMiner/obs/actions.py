"""OBS action functions — the public API that consumers call."""

import base64
import functools
import io
import os
import time
from typing import Optional

import obsws_python as obs

from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import (
    get_config,
    gsm_state,
    logger,
)
from GameSentenceMiner.util.gsm_utils import (
    make_unique_file_name,
    sanitize_filename,
)

from GameSentenceMiner.obs.launch import (
    VIDEO_SOURCE_KINDS,
    _should_skip_image_validation,
    get_preferred_video_source,
    get_video_scene_items,
    is_image_empty,
    sort_video_sources_by_preference,
)

from GameSentenceMiner.obs.service import (
    OBS_DEFAULT_RETRY_COUNT,
    _call_with_obs_client,
    _is_obs_recording_disabled,
)


# ---------------------------------------------------------------------------
# Decorator — backward compat; identical to the old with_obs_client
# ---------------------------------------------------------------------------
def with_obs_client(
    default=None, error_msg=None, raise_exc=False, retryable=True, retries=OBS_DEFAULT_RETRY_COUNT, fallback=None
):
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


# ---------------------------------------------------------------------------
# Replay buffer
# ---------------------------------------------------------------------------
@with_obs_client(error_msg="Error toggling buffer", retryable=False)
def toggle_replay_buffer(client: obs.ReqClient):
    import GameSentenceMiner.obs as _obs_pkg

    if _is_obs_recording_disabled():
        logger.warning("OBS replay buffer toggle blocked: OBS recording/replay is disabled in GSM settings.")
        return
    current_state = None
    svc = _obs_pkg.obs_service
    if svc:
        current_state = svc.state.replay_buffer_active
        if current_state is None:
            try:
                replay_status = client.get_replay_buffer_status()
                current_state = bool(getattr(replay_status, "output_active", False))
            except Exception:
                current_state = None
        if current_state is not None:
            svc.mark_replay_buffer_action(not bool(current_state))
        else:
            svc.mark_replay_buffer_action(None)
    client.toggle_replay_buffer()
    if svc and current_state is not None:
        with svc._state_lock:
            svc.state.replay_buffer_active = not bool(current_state)
        svc._auto_start_paused_by_external_replay_stop = False
    logger.info("Replay buffer Toggled.")


@with_obs_client(error_msg="Error starting replay buffer")
def start_replay_buffer(client: obs.ReqClient, initial=False):
    import GameSentenceMiner.obs as _obs_pkg

    if _is_obs_recording_disabled():
        logger.warning("OBS replay buffer start blocked: OBS recording/replay is disabled in GSM settings.")
        return
    try:
        replay_status = client.get_replay_buffer_status()
        if bool(getattr(replay_status, "output_active", False)):
            svc = _obs_pkg.obs_service
            if svc:
                with svc._state_lock:
                    svc.state.replay_buffer_active = True
            gsm_state.replay_buffer_stopped_timestamp = None
            return
    except Exception:
        pass
    svc = _obs_pkg.obs_service
    if svc:
        svc.mark_replay_buffer_action(True)
    client.start_replay_buffer()
    if svc:
        with svc._state_lock:
            svc.state.replay_buffer_active = True
        svc._auto_start_paused_by_external_replay_stop = False
    gsm_state.replay_buffer_stopped_timestamp = None
    if get_config().features.generate_longplay:
        start_recording(True)
    logger.info("Replay buffer started.")


@with_obs_client(default=None, error_msg="Error getting replay buffer status")
def get_replay_buffer_status(client: obs.ReqClient):
    import GameSentenceMiner.obs as _obs_pkg

    svc = _obs_pkg.obs_service
    if svc and svc.state.replay_buffer_active is not None:
        return svc.state.replay_buffer_active
    return client.get_replay_buffer_status().output_active


@with_obs_client(error_msg="Error stopping replay buffer")
def stop_replay_buffer(client: obs.ReqClient):
    import GameSentenceMiner.obs as _obs_pkg

    try:
        replay_status = client.get_replay_buffer_status()
        if not bool(getattr(replay_status, "output_active", False)):
            svc = _obs_pkg.obs_service
            if svc:
                with svc._state_lock:
                    svc.state.replay_buffer_active = False
            gsm_state.replay_buffer_stopped_timestamp = time.time()
            return
    except Exception:
        pass
    svc = _obs_pkg.obs_service
    if svc:
        svc.mark_replay_buffer_action(False)
    client.stop_replay_buffer()
    if svc:
        with svc._state_lock:
            svc.state.replay_buffer_active = False
        svc._auto_start_paused_by_external_replay_stop = False
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
    import GameSentenceMiner.obs as _obs_pkg

    svc = _obs_pkg.obs_service
    if svc and svc.state.output_state_by_name:
        for output in svc.state.output_state_by_name.values():
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
# Recording
# ---------------------------------------------------------------------------
@with_obs_client(error_msg="Error starting recording")
def start_recording(client: obs.ReqClient, longplay=False):
    import GameSentenceMiner.obs as _obs_pkg

    if _is_obs_recording_disabled():
        logger.warning("OBS recording start blocked: OBS recording/replay is disabled in GSM settings.")
        return
    try:
        record_status = client.get_record_status()
        if bool(getattr(record_status, "output_active", False)):
            if longplay:
                _obs_pkg.longplay_handler.on_record_start_requested()
            return
    except Exception:
        pass
    client.start_record()
    if longplay:
        _obs_pkg.longplay_handler.on_record_start_requested()
    logger.info("Recording started.")


@with_obs_client(error_msg="Error stopping recording")
def stop_recording(client: obs.ReqClient):
    import GameSentenceMiner.obs as _obs_pkg

    try:
        record_status = client.get_record_status()
        if not bool(getattr(record_status, "output_active", False)):
            return None
    except Exception:
        pass
    resp = client.stop_record()
    output_path = resp.output_path if resp else None
    _obs_pkg.longplay_handler.on_record_stop_response(output_path=output_path)
    logger.info("Recording stopped.")
    return output_path


def add_longplay_srt_line(line_time, new_line):
    import GameSentenceMiner.obs as _obs_pkg

    _obs_pkg.longplay_handler.add_srt_line(line_time=line_time, new_line=new_line)


@with_obs_client(default="", error_msg="Error getting last recording filename")
def get_last_recording_filename(client: obs.ReqClient):
    response = client.get_record_status()
    return response.recording_filename if response else ""


# ---------------------------------------------------------------------------
# Scenes
# ---------------------------------------------------------------------------
@with_obs_client(
    default="",
    error_msg="Couldn't get scene",
    fallback=lambda: (
        __import__("GameSentenceMiner.obs", fromlist=["obs_service"]).obs_service.state.current_scene
        if __import__("GameSentenceMiner.obs", fromlist=["obs_service"]).obs_service
        and __import__("GameSentenceMiner.obs", fromlist=["obs_service"]).obs_service.state.current_scene
        else gsm_state.current_game or ""
    ),
)
def get_current_scene(client: obs.ReqClient):
    import GameSentenceMiner.obs as _obs_pkg

    svc = _obs_pkg.obs_service
    if svc and svc.state.current_scene:
        return svc.state.current_scene
    response = client.get_current_program_scene()
    return response.scene_name if response else ""


@with_obs_client(default="", error_msg="Error getting source from scene")
def get_source_from_scene(client: obs.ReqClient, scene_name):
    import GameSentenceMiner.obs as _obs_pkg

    svc = _obs_pkg.obs_service
    if svc:
        items = svc.state.scene_items_by_scene.get(scene_name)
        if items:
            preferred = get_preferred_video_source(
                items,
                input_active_by_name=svc.state.input_active_by_name,
                input_show_by_name=svc.state.input_show_by_name,
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
    import GameSentenceMiner.obs as _obs_pkg

    svc = _obs_pkg.obs_service
    current_game = gsm_state.current_game or (svc.state.current_scene if svc else None)
    if not current_game:
        try:
            response = client.get_current_program_scene()
            current_game = response.scene_name if response else ""
        except Exception:
            current_game = ""

    if not current_game:
        return None

    if svc and current_game in svc.state.scene_items_by_scene:
        scene_items_response = svc.state.scene_items_by_scene.get(current_game, [])
    else:
        response = client.get_scene_item_list(name=current_game)
        scene_items_response = response.scene_items if response else []

    if not scene_items_response:
        return None
    active_video_sources = [item for item in scene_items_response if item.get("inputKind") in VIDEO_SOURCE_KINDS]
    if active_video_sources:
        return sort_video_sources_by_preference(
            active_video_sources,
            input_active_by_name=svc.state.input_active_by_name if svc else None,
            input_show_by_name=svc.state.input_show_by_name if svc else None,
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
    import GameSentenceMiner.obs as _obs_pkg

    from GameSentenceMiner.obs.service import wait_for_obs_connected

    if await wait_for_obs_connected():
        svc = _obs_pkg.obs_service
        if not svc:
            logger.error("OBS service is not connected.")
            return

        def _on_scene_changed(data):
            scene_name = getattr(data, "scene_name", None)
            if scene_name:
                callback(scene_name)

        svc.on("CurrentProgramSceneChanged", _on_scene_changed)
        logger.background("Scene change callback registered.")


# ---------------------------------------------------------------------------
# Screenshots
# ---------------------------------------------------------------------------
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

    gray = ImageOps.autocontrast(gray, cutoff=1)
    return gray.filter(ImageFilter.UnsharpMask(radius=1.0, percent=120, threshold=2))


def get_best_source_for_screenshot(log_missing_source=True, suppress_errors=False):
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
    import GameSentenceMiner.obs as _obs_pkg

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

    svc = _obs_pkg.obs_service
    current_scene_name = getattr(getattr(svc, "state", None), "current_scene", None) or gsm_state.current_game
    input_active_by_name = getattr(getattr(svc, "state", None), "input_active_by_name", None)
    input_show_by_name = getattr(getattr(svc, "state", None), "input_show_by_name", None)
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
            only_source_name = only_source.get("sourceName")
            if not only_source_name:
                return None

            img = get_screenshot_PIL_from_source(
                only_source_name,
                compression,
                img_format,
                width,
                height,
                retry,
            )
            if not img:
                return None
            if _should_skip_image_validation(only_source_name, current_scene_name):
                return only_source
            try:
                if not is_image_empty(img):
                    return only_source
            except Exception as e:
                logger.warning(f"Failed to validate image from source '{only_source_name}': {e}")
                return only_source
            return None

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


# ---------------------------------------------------------------------------
# Current game / scene helpers
# ---------------------------------------------------------------------------
def update_current_game():
    import GameSentenceMiner.obs as _obs_pkg

    previous_game = gsm_state.current_game
    svc = _obs_pkg.obs_service
    if svc and svc.state.current_scene:
        gsm_state.current_game = svc.state.current_scene
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
# Fit to screen
# ---------------------------------------------------------------------------
@with_obs_client(default=None, error_msg="An OBS error occurred")
def set_fit_to_screen_for_scene_items(client, scene_name: str):
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


# ---------------------------------------------------------------------------
# Config / record directory
# ---------------------------------------------------------------------------
@with_obs_client(default="", error_msg="Error getting recording folder")
def get_record_directory(client: obs.ReqClient):
    response = client.get_record_directory()
    return response.record_directory if response else ""


# ---------------------------------------------------------------------------
# FPS / performance settings
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
    import GameSentenceMiner.obs as _obs_pkg

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

    svc = _obs_pkg.obs_service

    try:
        if had_active_outputs:
            logger.info(
                f"Restarting active OBS outputs for FPS update to {target_fps} "
                f"(replay={replay_was_active}, record={record_was_active}, stream={stream_was_active})."
            )
            if replay_was_active:
                try:
                    if svc:
                        svc.mark_replay_buffer_action(False)
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
                if svc:
                    svc.mark_replay_buffer_action(True)
                client.start_replay_buffer()
                gsm_state.replay_buffer_stopped_timestamp = None
            except Exception as e:
                logger.warning(f"Failed to restart replay buffer after FPS update: {e}")
            try:
                replay_status = client.get_replay_buffer_status()
                if not bool(getattr(replay_status, "output_active", False)):
                    if svc:
                        svc.mark_replay_buffer_action(True)
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
                    if svc:
                        svc.mark_replay_buffer_action(True)
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
# Input settings / window info
# ---------------------------------------------------------------------------
@with_obs_client(default=None, error_msg="Error getting current source input settings")
def get_current_source_input_settings(client):
    import GameSentenceMiner.obs as _obs_pkg

    current_scene = get_current_scene()
    if not current_scene:
        return None
    scene_items_response = client.get_scene_item_list(name=current_scene)
    items = scene_items_response.scene_items if scene_items_response and scene_items_response.scene_items else []
    if not items:
        return None
    video_items = get_video_scene_items(items)
    svc = _obs_pkg.obs_service
    preferred_item = get_preferred_video_source(
        video_items,
        input_active_by_name=svc.state.input_active_by_name if svc else None,
        input_show_by_name=svc.state.input_show_by_name if svc else None,
    )
    source_name = (preferred_item or (video_items[0] if video_items else items[0])).get("sourceName")
    if not source_name:
        return None

    if svc:
        cached = svc.state.input_settings_by_name.get(source_name)
        if cached is not None:
            return cached

    input_settings_response = client.get_input_settings(name=source_name)
    return input_settings_response.input_settings if input_settings_response else None


@with_obs_client(default=None, error_msg="Error getting window info from source")
def get_window_info_from_source(client, scene_name: str = None):
    import GameSentenceMiner.obs as _obs_pkg

    if not scene_name:
        return None
    scene_items_response = client.get_scene_item_list(name=scene_name)

    if not scene_items_response or not scene_items_response.scene_items:
        logger.warning("No scene items found in scene")
        return None

    candidate_items = get_video_scene_items(scene_items_response.scene_items)
    if not candidate_items:
        candidate_items = list(scene_items_response.scene_items)

    svc = _obs_pkg.obs_service
    for item in candidate_items:
        source_name = item.get("sourceName")
        if not source_name:
            continue

        cached_settings = svc.state.input_settings_by_name.get(source_name) if svc else None
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
# Audio tracks
# ---------------------------------------------------------------------------
@with_obs_client(default=None, error_msg="Error calling GetInputAudioTracks")
def get_input_audio_tracks(client, input_name: str = None, input_uuid: str = None):
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
# do_obs_call — generic OBS call helper
# ---------------------------------------------------------------------------
def do_obs_call(method_name: str, from_dict=None, retry=3, **kwargs):
    import GameSentenceMiner.obs as _obs_pkg

    from GameSentenceMiner.obs.service import connect_to_obs_sync as _connect_sync

    if not _obs_pkg.connection_pool:
        if _obs_pkg.obs_service:
            from GameSentenceMiner.obs.service import _recover_obs_service_clients_sync

            _recover_obs_service_clients_sync()
        elif not _obs_pkg.connecting:
            _connect_sync(retry=1)
    if not _obs_pkg.connection_pool:
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
