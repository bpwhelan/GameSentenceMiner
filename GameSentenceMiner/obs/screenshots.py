"""Screenshot capture and OCR preprocessing helpers."""

from __future__ import annotations

import base64
import io

from GameSentenceMiner.obs._state import get_obs_service
from GameSentenceMiner.obs.client_wrapper import _call_with_obs_client, with_obs_client
from GameSentenceMiner.obs.types import (
    _should_skip_image_validation,
    is_image_empty,
    sort_video_sources_by_preference,
)
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import gsm_state, logger
from GameSentenceMiner.util.gsm_utils import make_unique_file_name

import os
import time


def get_screenshot_PIL_from_source(source_name, compression=75, img_format="png", width=None, height=None, retry=3):
    """Get a PIL Image screenshot from a specific OBS source."""
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


# ---------------------------------------------------------------------------
# OCR preprocessing
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# High-level screenshot functions
# ---------------------------------------------------------------------------


def get_best_source_for_screenshot(log_missing_source=True, suppress_errors=False):
    """Get the best available video source dict based on priority and image validation."""
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
    """Get a PIL Image screenshot.

    Optionally applies OCR preprocessing to the captured image before returning it.
    """
    # Look up via the package module so test monkeypatches take effect
    import GameSentenceMiner.obs as _obs_pkg

    _get_active_video_sources = _obs_pkg.get_active_video_sources
    _get_ss_from_source = _obs_pkg.get_screenshot_PIL_from_source

    obs_service = get_obs_service()

    if source_name:
        if return_source_dict:
            if suppress_errors:
                current_sources = _get_active_video_sources(_suppress_obs_errors=True)
            else:
                current_sources = _get_active_video_sources()
            if current_sources:
                for src in current_sources:
                    if src.get("sourceName") == source_name:
                        return src
            return None

        img = _get_ss_from_source(source_name, compression, img_format, width, height, retry)
        img = _apply_ocr_preprocessing(img, preprocess_mode=preprocess_mode, grayscale=grayscale)
        return img

    if suppress_errors:
        current_sources = _get_active_video_sources(_suppress_obs_errors=True)
    else:
        current_sources = _get_active_video_sources()
    if not current_sources:
        if log_missing_source:
            logger.error("No active video sources found in the current scene.")
        return None

    current_scene_name = getattr(getattr(obs_service, "state", None), "current_scene", None) or gsm_state.current_game
    input_active_by_name = getattr(getattr(obs_service, "state", None), "input_active_by_name", None)
    input_show_by_name = getattr(getattr(obs_service, "state", None), "input_show_by_name", None)

    # Sort sources: helper sources first (skip image validation), then by preference
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
        img = _get_ss_from_source(only_source.get("sourceName"), compression, img_format, width, height, retry)
        img = _apply_ocr_preprocessing(img, preprocess_mode=preprocess_mode, grayscale=grayscale)
        return img

    for source in sorted_sources:
        found_source_name = source.get("sourceName")
        if not found_source_name:
            continue

        img = _get_ss_from_source(found_source_name, compression, img_format, width, height, retry)
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


@with_obs_client(default=None, error_msg="Error getting screenshot")
def get_screenshot(client, compression=-1):
    from GameSentenceMiner.obs.operations import get_source_from_scene, update_current_game

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
    from GameSentenceMiner.obs.operations import get_current_game, get_source_from_scene, update_current_game

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
