import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, List, Tuple, Optional, Any, Dict

if TYPE_CHECKING:
    from GameSentenceMiner.ui.qt_main import DialogManager

from GameSentenceMiner import obs
from GameSentenceMiner.util.config.configuration import (
    ffmpeg_base_command_list,
    get_ffprobe_path,
    logger,
    get_config,
    get_temporary_directory,
    gsm_state,
    is_linux,
    ffmpeg_base_command_list_info,
    KNOWN_ASPECT_RATIOS
)
from GameSentenceMiner.util.gsm_utils import (
    get_unique_temp_file_for_game,
    make_unique_file_name,
    get_file_modification_time
)
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.text_log import initial_time, TextSource


supported_formats = {
    'opus': {'codec': 'libopus', 'format': 'opus'},
    'mp3': {'codec': 'libmp3lame', 'format': 'mp3'},
    'ogg': {'codec': 'libvorbis', 'format': 'ogg'},
    'aac': {'codec': 'aac', 'format': 'adts'},  # ADTS is the proper container for raw AAC
    'm4a': {'codec': 'aac', 'format': 'ipod'},  # iPod/M4A format for AAC in MP4 container
}

# How close the detected ratio needs to be to a known ratio to snap (e.g., 0.05 = 5%)
RATIO_TOLERANCE = 0.05


class FFmpegHelper:
    """Helper class to encapsulate reusable FFmpeg operations."""

    @staticmethod
    def run(command: List[str], check: bool = True, capture_output: bool = True, text: bool = True, retries: int = 0) -> subprocess.CompletedProcess:
        """
        Executes an FFmpeg command with logging and retry logic.
        """
        cmd_str = " ".join(map(str, command))
        logger.debug(cmd_str)

        for i in range(retries + 1):
            try:
                # Log retry attempts
                if i > 0:
                    logger.debug(f"Retry attempt {i} for command...")

                result = subprocess.run(
                    command,
                    capture_output=capture_output,
                    text=text,
                    check=check if i == retries else False  # Only raise on last attempt if check=True
                )
                
                if result.returncode == 0:
                    return result
                
                # If failed and we have retries left
                if i < retries:
                    if capture_output and result.stderr:
                         logger.warning(f"FFmpeg attempt {i+1} failed. Stderr: {result.stderr}")
                    continue
                
                # If we're here, it's the last attempt and it failed (but check was False)
                return result

            except subprocess.CalledProcessError as e:
                logger.warning(f"FFmpeg attempt {i+1} raised exception: {e}")
                if i == retries and check:
                    raise e
        
        # Fallback for type safety, though unreachable if check=True and it fails
        return subprocess.CompletedProcess(command, -1, stdout="", stderr="Retries exhausted")

    @staticmethod
    def get_probe_json(file_path: str, entries: str, stream_select: str) -> Optional[dict]:
        """Runs ffprobe and returns parsed JSON."""
        cmd = [
            get_ffprobe_path(),
            "-v", "error",
        ]
        if stream_select:
            cmd.extend(["-select_streams", stream_select])
        cmd.extend([
            "-show_entries", entries,
            "-of", "json",
            str(file_path)
        ])
        logger.debug(" ".join(cmd))
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return json.loads(result.stdout)
        except Exception as e:
            logger.error(f"Error probing file {file_path}: {e}")
            return None

    @staticmethod
    def parse_custom_settings(custom_settings: str) -> Tuple[List[str], List[str]]:
        """
        Parses custom ffmpeg settings string.
        Returns (pre_input_args, post_input_args).
        """
        pre_input = []
        post_input = []
        
        if not custom_settings:
            return pre_input, post_input

        # Check for hwaccel
        if '-hwaccel' in custom_settings:
            parts = custom_settings.split()
            try:
                idx = parts.index('-hwaccel')
                # Take -hwaccel and the next argument
                pre_input = parts[idx:idx+2]
                pre_input_str = " ".join(pre_input)
                # Remove pre_input part from original string to get post_input
                post_input = custom_settings.replace(pre_input_str, "").split()
                return pre_input, post_input
            except (ValueError, IndexError):
                pass
        
        # If no hwaccel logic applied, everything is post-input
        post_input = custom_settings.split()
        return pre_input, post_input

    @staticmethod
    def extract_hwaccel_args(custom_settings: str) -> List[str]:
        """Return hwaccel args if defined in the screenshot custom settings."""
        if not custom_settings:
            return []

        parts = custom_settings.split()
        for idx, part in enumerate(parts):
            normalized = part.lower()
            if normalized in ("-hwaccel", "--hwaccel"):
                args = [part]
                if idx + 1 < len(parts):
                    next_part = parts[idx + 1]
                    # Only treat it as the hwaccel value if it does not look like another flag
                    if not next_part.startswith("-"):
                        args.append(next_part)
                return args

            if normalized.startswith("-hwaccel=") or normalized.startswith("--hwaccel="):
                return [part]

        return []

    @staticmethod
    def get_scale_filter(width: Any, height: Any, use_negative_two: bool = False) -> Optional[str]:
        """Returns a scale filter string if width or height is provided."""
        if width or height:
            default = -2 if use_negative_two else -1
            w = width or default
            h = height or default
            return f"scale={w}:{h}"
        return None


def video_to_anim(
    input_path: str | Path,
    output_path: str | Path = None,
    codec: str = "webp",        # "webp" or "avif" (ignored if audio=True)
    start: str = None,          # e.g. "00:00:12.5"
    duration: float = None,     # seconds
    fps: int = 12,
    max_width: int = 960, 
    max_height: int = None,
    quality: int = 65,          # 0..100, for avif: 0 (lossless) to 63 (worst), for webm: CRF value
    compression_level: int = 6, # for webp: 0..6 (ignored for audio)
    preset: str = "picture",    # for webp (ignored for audio)
    loop: int = 0,              # for webp: 0=infinite (ignored for audio)
    crop: str = None,           # e.g. "1280:720:0:140"
    extra_vf: list[str] = None,
    audio: bool = None          # whether to include audio, outputs WebM with VP9/Opus
) -> Path:
    """Convert video to efficient animated WebP/AVIF or WebM with audio using ffmpeg."""
    
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH.")

    codec = codec.lower()
    if codec not in {"webp", "avif"}:
        raise ValueError("codec must be 'webp' or 'avif'")

    input_path = Path(input_path)
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")

    # Determine output path and extension
    target_ext = ".webm" if audio else (".webp" if codec == "webp" else ".avif")
    if output_path:
        output_path = Path(output_path)
    else:
        output_path = input_path.with_suffix(target_ext)

    if output_path.suffix.lower() != target_ext:
        output_path = output_path.with_suffix(target_ext)

    # Build filter chain
    vf_parts = []
    
    if get_config().screenshot.trim_black_bars_wip:
        timestamp_for_detection = float(start) if start else 0
        crop_filter = find_black_bars(str(input_path), timestamp_for_detection)
        if crop_filter:
            vf_parts.append(crop_filter)
    
    if fps:
        vf_parts.append(f"fps={fps}")
    if crop:
        vf_parts.append(f"crop={crop}")
    
    # Scale logic
    if max_width and max_height:
        vf_parts.append(f"scale='min({max_width},iw)':min({max_height},ih):force_original_aspect_ratio=decrease")
    elif max_width:
        vf_parts.append(f"scale={max_width}:-1")
    elif max_height:
        vf_parts.append(f"scale=-1:{max_height}")
        
    vf_parts.append("pad=ceil(iw/2)*2:ceil(ih/2)*2")  # ensure even dimensions
    if extra_vf:
        vf_parts.extend(extra_vf)

    # Build command
    cmd = ffmpeg_base_command_list.copy()
    if start:
        cmd += ["-ss", str(start)]

    if codec == "avif":
        hwaccel_args = FFmpegHelper.extract_hwaccel_args(get_config().screenshot.custom_ffmpeg_settings)
        if hwaccel_args:
            cmd += hwaccel_args

    cmd += ["-i", str(input_path)]
    
    if duration is None or duration == 0:
        duration = 15.0
    cmd += ["-t", str(duration)]
    
    cmd += ["-vf", ",".join(vf_parts)]
    
    if not audio:
        cmd += ["-an"]

    # Codec settings
    if audio:
        cmd += [
            "-c:v", "libaom-av1",
            "-crf", str(quality),
            "-pix_fmt", "yuv420p",
            "-cpu-used", "6",
            "-c:a", "libopus",
            "-b:a", "128k",
            "-f", "webm",
        ]
    elif codec == "webp":
        cmd += [
            "-c:v", "libwebp",
            "-lossless", "0",
            "-q:v", str(quality),
            "-compression_level", str(compression_level),
            "-preset", preset,
            "-loop", str(loop),
            "-threads", "0",
        ]
    elif codec == "avif":
        cmd += [
            "-c:v", "libaom-av1",
            "-cpu-used", "6",
            "-crf", str(quality),
            "-pix_fmt", "yuv420p",
        ]

    cmd.append(str(output_path))

    FFmpegHelper.run(cmd, check=True)
    return str(output_path)


def video_to_animation_with_start_end(video_path: str | Path, start: float, end: float, **kwargs) -> Path:
    """Convert video to animation using start and end time strings."""
    if end < start:
        raise ValueError("end time must be after start time")
    duration = end - start
    
    output_path = get_unique_temp_file_for_game(obs.get_current_game(sanitize=True), get_config().screenshot.animated_settings.extension)

    return video_to_anim(
        input_path=video_path,
        output_path=output_path,
        start=start,
        duration=duration,
        **kwargs
    )


def call_frame_extractor(video_path, timestamp):
    """Calls the video frame extractor script."""
    try:
        dialog_manager: 'DialogManager' = gsm_state.dialog_manager
        return dialog_manager.screenshot_selector_sync(video_path, str(timestamp), get_config().screenshot.screenshot_timing_setting)
    except Exception as e:
        logger.error(f"Error calling screenshot selector: {e}")
        return None


def get_anki_compatible_video(video_file, screenshot_timing, vad_start, vad_end, **kwargs):
    screenshot_timing = screenshot_timing if screenshot_timing else 1
    animated_ss = video_to_animation_with_start_end(video_file, screenshot_timing + vad_start, screenshot_timing + vad_end, **kwargs)
    return animated_ss


def get_raw_screenshot(video_file, screenshot_timing, try_selector=False):
    """Extract a frame as a raw PNG without filters."""
    screenshot_timing = screenshot_timing if screenshot_timing else 1
    if try_selector:
        filepath = call_frame_extractor(video_path=video_file, timestamp=screenshot_timing)
        if filepath:
            return filepath
        else:
            logger.error("Frame extractor script failed to run or returned no output, defaulting")

    output_image = make_unique_file_name(os.path.join(
        get_temporary_directory(), f"{obs.get_current_game(sanitize=True)}_raw.png"))
    
    ffmpeg_command = ffmpeg_base_command_list + [
        "-ss", f"{screenshot_timing}",
        "-i", f"{video_file}",
        "-vframes", "1",
        output_image
    ]

    try:
        FFmpegHelper.run(ffmpeg_command, check=True)
    except Exception as e:
        logger.error(f"Error extracting raw screenshot: {e}")
        raise

    logger.debug(f"Raw screenshot saved to: {output_image}")
    return output_image


def encode_screenshot(input_image, source_video_path=None, screenshot_timing=None, output_path=None):
    """Encode a screenshot with user's configured settings."""
    if output_path is None:
        output_image = make_unique_file_name(os.path.join(
            get_temporary_directory(), f"{obs.get_current_game(sanitize=True)}.{get_config().screenshot.extension}"))
    else:
        output_image = output_path
    
    # Parse custom settings
    pre_input_args, post_input_args = FFmpegHelper.parse_custom_settings(
        get_config().screenshot.custom_ffmpeg_settings
    )

    ffmpeg_command = ffmpeg_base_command_list + pre_input_args + ["-i", input_image]

    # Build filters
    video_filters = []
    if get_config().screenshot.trim_black_bars_wip:
        crop_filter = find_black_bars(source_video_path, screenshot_timing)
        if crop_filter:
            video_filters.append(crop_filter)

    scale_filter = FFmpegHelper.get_scale_filter(
        get_config().screenshot.width, 
        get_config().screenshot.height, 
        use_negative_two=True
    )
    if scale_filter:
        video_filters.append(scale_filter)

    if video_filters:
        ffmpeg_command.extend(["-vf", ",".join(video_filters)])

    # Add post-input args or defaults
    if get_config().screenshot.custom_ffmpeg_settings:
        ffmpeg_command.extend(post_input_args)
    else:
        ffmpeg_command.extend([
            "-q:v", str(get_config().screenshot.quality),
            "-pix_fmt", "yuvj420p"
        ])

    ffmpeg_command.append(output_image)

    try:
        result = FFmpegHelper.run(ffmpeg_command, check=True)
    except Exception as e:
        logger.error(f"Error encoding screenshot: {e}")
        raise

    logger.debug(f"Encoded screenshot saved to: {output_image}")
    return output_image


def get_screenshot(video_file, screenshot_timing, try_selector=False):
    screenshot_timing = screenshot_timing if screenshot_timing else 1
    if try_selector:
        filepath = call_frame_extractor(video_path=video_file, timestamp=screenshot_timing)
        output = process_image(filepath)
        if output:
            return output
        else:
            logger.error("Frame extractor script failed to run or returned no output, defaulting")

    output_image = make_unique_file_name(os.path.join(
        get_temporary_directory(), f"{obs.get_current_game(sanitize=True)}.{get_config().screenshot.extension}"))
    
    # Parse custom settings
    pre_input_args, post_input_args = FFmpegHelper.parse_custom_settings(
        get_config().screenshot.custom_ffmpeg_settings
    )
    
    ffmpeg_command = ffmpeg_base_command_list + [
        "-ss", f"{screenshot_timing}",
    ] + pre_input_args + [
        "-i", f"{video_file}",
        "-vframes", "1"
    ]
    
    # Build filters
    video_filters = []
    if get_config().screenshot.trim_black_bars_wip:
        crop_filter = find_black_bars(video_file, screenshot_timing)
        if crop_filter:
            video_filters.append(crop_filter)

    scale_filter = FFmpegHelper.get_scale_filter(
        get_config().screenshot.width, 
        get_config().screenshot.height
    )
    if scale_filter:
        video_filters.append(scale_filter)

    if video_filters:
        ffmpeg_command.extend(["-vf", ",".join(video_filters)])

    if get_config().screenshot.custom_ffmpeg_settings:
        ffmpeg_command.extend(post_input_args)
    else:
        ffmpeg_command.extend(["-compression_level", "6", "-q:v", str(get_config().screenshot.quality)])

    ffmpeg_command.append(f"{output_image}")

    try:
        # Retry loop using FFmpegHelper logic manually due to fallback requirements
        result = FFmpegHelper.run(ffmpeg_command, check=False, retries=2)
        if result.returncode != 0:
             raise RuntimeError(f"FFmpeg command failed. Stderr: {result.stderr}")
             
    except Exception as e:
        logger.error(f"Error running FFmpeg command: {e}. Defaulting to standard PNG.")
        output_image = make_unique_file_name(os.path.join(
            get_temporary_directory(),
            f"{obs.get_current_game(sanitize=True)}.png"))
        # Fallback command
        fallback_command = ffmpeg_base_command_list + [
            "-ss", f"{screenshot_timing}",
            "-i", video_file,
            "-vframes", "1",
            output_image
        ]
        FFmpegHelper.run(fallback_command, check=False)

    logger.debug(f"Screenshot saved to: {output_image}")
    return output_image


def get_video_dimensions(video_file):
    """Get the width and height of a video file."""
    info = FFmpegHelper.get_probe_json(video_file, "stream=width,height", "v:0")
    if info and 'streams' in info and len(info['streams']) > 0:
        return info['streams'][0]['width'], info['streams'][0]['height']
    return None, None


def _calculate_target_crop(orig_width, orig_height, target_ratio):
    """Calculates the new dimensions and offsets for a target aspect ratio."""
    orig_ratio = orig_width / orig_height

    if abs(orig_ratio - target_ratio) < 0.01:
        return orig_width, orig_height, 0, 0

    if orig_ratio > target_ratio:
        new_width = round(orig_height * target_ratio)
        new_height = orig_height
        x_offset = round((orig_width - new_width) / 2)
        y_offset = 0
    else:
        new_width = orig_width
        new_height = round(orig_width / target_ratio)
        x_offset = 0
        y_offset = round((orig_height - new_height) / 2)

    # Ensure even dimensions
    new_width = new_width if new_width % 2 == 0 else new_width - 1
    new_height = new_height if new_height % 2 == 0 else new_height - 1
    x_offset = x_offset if x_offset % 2 == 0 else x_offset - 1
    y_offset = y_offset if y_offset % 2 == 0 else y_offset - 1
    
    return new_width, new_height, x_offset, y_offset


def find_black_bars_with_ratio_snapping(video_file, screenshot_timing):
    # NOTE: We intentionally do NOT cache black bar detection results.
    # Games can dynamically change resolution/aspect ratio (e.g., 4:3 cutscenes -> 16:9 gameplay),
    # and caching would apply incorrect crops until the app restarts.
    # Since this only runs once per Anki card creation, the performance impact is negligible.
    
    logger.info("Attempting to detect black bars with aspect ratio snapping...")
    crop_filter = None
    try:
        orig_width, orig_height = get_video_dimensions(video_file)
        if not orig_width or not orig_height:
            logger.warning("Could not determine video dimensions. Skipping black bar detection.")
            return None
        
        orig_aspect = orig_width / orig_height
        logger.debug(f"Original video dimensions: {orig_width}x{orig_height} (Ratio: {orig_aspect:.3f})")
        
        cropdetect_command = ffmpeg_base_command_list_info + [
            "-i", video_file,
            "-ss", f"{screenshot_timing}",
            "-t", "5",
            "-vf", "cropdetect=limit=16",
            "-f", "null", "-"
        ]
        
        result = FFmpegHelper.run(cropdetect_command, check=False)
        
        crop_lines = re.findall(r"crop=\d+:\d+:\d+:\d+", result.stderr)
        if not crop_lines:
            logger.debug("cropdetect did not find any black bars to remove.")
            return None
            
        last_crop_params = crop_lines[-1]
        match = re.match(r"crop=(\d+):(\d+):(\d+):(\d+)", last_crop_params)
        if not match:
            logger.warning(f"Could not parse cropdetect output: {last_crop_params}")
            return None

        detected_width = int(match.group(1))
        detected_height = int(match.group(2))
        
        if detected_width == orig_width and detected_height == orig_height:
            logger.info("cropdetect suggests no cropping is needed.")
            return None

        detected_aspect = detected_width / detected_height
        
        best_match = None
        min_diff = float('inf')

        for known in KNOWN_ASPECT_RATIOS:
            diff = abs(detected_aspect - known["ratio"]) / known["ratio"]
            if diff < min_diff:
                min_diff = diff
                best_match = known
        
        if best_match and min_diff <= RATIO_TOLERANCE:
            target_name = best_match["name"]
            target_ratio = best_match["ratio"]
            
            crop_width, crop_height, crop_x, crop_y = _calculate_target_crop(
                orig_width, orig_height, target_ratio
            )
            
            area_ratio = (crop_width * crop_height) / (orig_width * orig_height)
            if area_ratio < 0.50:
                logger.warning("Calculated crop would remove too much video. Skipping.")
                return None
            
            crop_filter = f"crop={crop_width}:{crop_height}:{crop_x}:{crop_y}"
            logger.info(f"Applying snapped aspect ratio filter: {crop_filter}")
            
        else:
            return None

    except Exception as e:
        logger.error(f"Error during black bar detection: {e}. Proceeding without cropping.")
    
    return crop_filter


def find_black_bars(video_file, screenshot_timing):
    # NOTE: We intentionally do NOT cache black bar detection results.
    # Games can dynamically change resolution/aspect ratio (e.g., 4:3 cutscenes -> 16:9 gameplay),
    # and caching would apply incorrect crops until the app restarts.
    # Since this only runs once per Anki card creation, the performance impact is negligible.
    
    logger.info("Attempting to detect black bars...")
    crop_filter = None
    try:
        orig_width, orig_height = get_video_dimensions(video_file)
        if not orig_width or not orig_height:
            logger.warning("Could not determine video dimensions. Skipping black bar detection.")
            return None
        
        ss_seek = max(0, float(screenshot_timing) - 0.5)
        cropdetect_command = ffmpeg_base_command_list_info + [
            "-ss", str(ss_seek),
            "-i", video_file,
            "-t", "1",
            "-an",
            "-vf", "cropdetect=limit=16:round=2",
            "-frames:v", "8",
            "-f", "null", "-"
        ]
        
        result = FFmpegHelper.run(cropdetect_command, check=False)
        
        crop_lines = re.findall(r"crop=\d+:\d+:\d+:\d+", result.stderr)
        if crop_lines:
            crop_params = crop_lines[-1]
            match = re.match(r"crop=(\d+):(\d+):(\d+):(\d+)", crop_params)
            if match:
                crop_width = int(match.group(1))
                crop_height = int(match.group(2))
                
                area_ratio = (crop_width * crop_height) / (orig_width * orig_height)
                
                if area_ratio > 0.95:
                    logger.info("Detected crop would only remove minimal area. Skipping.")
                    return None
                
                if area_ratio < 0.25:
                    logger.warning("Crop would remove too much of the video. Skipping.")
                    return None
                
                orig_aspect = orig_width / orig_height
                crop_aspect = crop_width / crop_height
                aspect_diff = abs(orig_aspect - crop_aspect) / orig_aspect
                
                if aspect_diff > 0.30:
                    found_match = False
                    for ratio in KNOWN_ASPECT_RATIOS:
                        known_diff = abs(crop_aspect - ratio["ratio"]) / ratio["ratio"]
                        if known_diff < RATIO_TOLERANCE:
                            found_match = True
                            break
                    if not found_match:
                        logger.warning("Crop would significantly change aspect ratio. Skipping.")
                        return None
                
                crop_filter = crop_params
                logger.info(f"Detected valid black bars. Applying filter: {crop_filter}")
            else:
                logger.warning("Could not parse crop parameters.")
        else:
            logger.debug("cropdetect did not find any black bars to remove.")
            
    except Exception as e:
        logger.error(f"Error during black bar detection: {e}. Proceeding without cropping.")
    return crop_filter


def get_screenshot_for_line(video_file, game_line, try_selector=False):
    return get_screenshot(video_file, get_screenshot_time(video_file, game_line), try_selector)


def get_raw_screenshot_for_line(video_file, game_line, try_selector=False):
    return get_raw_screenshot(video_file, get_screenshot_time(video_file, game_line), try_selector)


def get_screenshot_time(video_path, game_line, default_beginning=False, vad_result=None, doing_multi_line=False, previous_line=False, anki_card_creation_time=0):
    if game_line:
        line_time = game_line.time
        if previous_line:
            logger.debug(f"Calculating screenshot time for previous line: {str(game_line.text)}")
        else:
            logger.debug("Calculating screenshot time for line: " + str(game_line.text))
    else:
        line_time = initial_time
        
    file_length = get_video_duration(video_path)
    if anki_card_creation_time:
        file_mod_time = anki_card_creation_time
    else:
        file_mod_time = get_file_modification_time(video_path)

    time_delta = file_mod_time - line_time
    line_timestamp_in_video = file_length - time_delta.total_seconds()
    screenshot_offset = get_config().screenshot.seconds_after_line

    if get_config().screenshot.screenshot_timing_setting == "beginning":
        screenshot_time_from_beginning = line_timestamp_in_video + screenshot_offset
    elif get_config().screenshot.screenshot_timing_setting == "middle":
        if game_line and game_line.next_line():
            screenshot_time_from_beginning = line_timestamp_in_video + ((game_line.next_line().time - game_line.time).total_seconds() / 2) + screenshot_offset
        else:
            screenshot_time_from_beginning = (file_length - ((file_length - line_timestamp_in_video) / 2)) + screenshot_offset
    elif get_config().screenshot.screenshot_timing_setting == "end":
        if game_line and game_line.next_line():
            screenshot_time_from_beginning = line_timestamp_in_video + (game_line.next_line().time - game_line.time).total_seconds() - screenshot_offset
        else:
            screenshot_time_from_beginning = file_length - screenshot_offset
    else:
        screenshot_time_from_beginning = line_timestamp_in_video + screenshot_offset

    logger.debug(f"Calculated screenshot time: {screenshot_time_from_beginning} (Strategy: {get_config().screenshot.screenshot_timing_setting})")

    if screenshot_time_from_beginning < 0 or screenshot_time_from_beginning > file_length:
        logger.error(f"Calculated screenshot time ({screenshot_time_from_beginning:.2f}s) is out of bounds (len {file_length:.2f}s).")
        if default_beginning:
            return 1.0
        return file_length - screenshot_offset

    return screenshot_time_from_beginning


def process_image(image_file):
    output_image = make_unique_file_name(
        os.path.join(get_temporary_directory(), f"{obs.get_current_game(sanitize=True)}.{get_config().screenshot.extension}"))
    
    # Parse custom settings
    pre_input_args, post_input_args = FFmpegHelper.parse_custom_settings(
        get_config().screenshot.custom_ffmpeg_settings
    )

    ffmpeg_command = ffmpeg_base_command_list + pre_input_args + ["-i", image_file]

    if get_config().screenshot.custom_ffmpeg_settings:
        ffmpeg_command.extend(post_input_args)
    else:
        ffmpeg_command.extend(["-compression_level", "6", "-q:v", get_config().screenshot.quality])

    scale_filter = FFmpegHelper.get_scale_filter(
        get_config().screenshot.width,
        get_config().screenshot.height
    )
    if scale_filter:
        ffmpeg_command.extend(["-vf", scale_filter])

    ffmpeg_command.append(output_image)

    try:
        FFmpegHelper.run(ffmpeg_command, check=True, retries=2)
    except Exception as e:
        logger.error(f"Error re-encoding screenshot: {e}. Defaulting to standard PNG.")
        output_image = make_unique_file_name(os.path.join(get_temporary_directory(), f"{obs.get_current_game(sanitize=True)}.png"))
        shutil.move(image_file, output_image)

    logger.success(f"Processed image saved to: {output_image}")
    return output_image


def get_audio_codec(video_path):
    info = FFmpegHelper.get_probe_json(video_path, "stream=codec_name", "a:0")
    if info and 'streams' in info and len(info['streams']) > 0:
        return info['streams'][0]['codec_name']
    logger.error("Failed to get codec information. Re-encoding Anyways")
    return None


def get_audio_and_trim(video_path, game_line, next_line_time, anki_card_creation_time):
    codec = get_audio_codec(video_path)
    target_ext = get_config().audio.extension

    if codec == target_ext:
        codec_command = ['-c:a', 'copy']
        logger.debug(f"Extracting {target_ext} from video")
    else:
        codec_command = ["-c:a", f"{supported_formats[target_ext]['codec']}"]
        logger.debug(f"Re-encoding {codec} to {target_ext}")

    untrimmed_audio = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(),
                                                  suffix=f"_untrimmed.{target_ext}").name

    command = ffmpeg_base_command_list + [
        "-i", video_path,
        "-map", "0:a"] + codec_command + [untrimmed_audio]

    logger.debug("Doing initial audio extraction")
    FFmpegHelper.run(command, check=False)

    return trim_audio_based_on_last_line(untrimmed_audio, video_path, game_line, next_line_time, anki_card_creation_time)

def get_video_duration(file_path):
    info = FFmpegHelper.get_probe_json(file_path, "format=duration", "")
    # Original used specific ffprobe command that outputted plain text, not JSON
    # get_probe_json might not work if "default=noprint..." is used with "-of json" which overrides?
    # Let's fallback to original command style for this specific one if strictness required.
    # Actually, let's just use JSON format which is cleaner.
    if info and 'format' in info:
        return float(info["format"]["duration"])
    
    # Fallback to plain run if JSON fails or returns nothing (e.g. for some audio files)
    try:
        result = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file_path],
            capture_output=True, text=True
        )
        return float(result.stdout.strip())
    except Exception:
        return 0.0

def trim_audio_based_on_last_line(untrimmed_audio, video_path, game_line, next_line, anki_card_creation_time):
    trimmed_audio = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(),
                                                suffix=f".{get_config().audio.extension}").name
    start_trim_time, total_seconds, total_seconds_after_offset, file_length = get_video_timings(video_path, game_line, anki_card_creation_time)
    end_trim_seconds = 0
    source_padding = 0.0
    if game_line:
        source_padding = getattr(game_line, "source_padding", None)
        if source_padding is None:
            source_padding = TextSource.padding_seconds(getattr(game_line, "source", None))
        start_trim_time = max(0, start_trim_time - float(source_padding))

    ffmpeg_command = ffmpeg_base_command_list + [
        "-i", untrimmed_audio,
        "-ss", str(start_trim_time)
    ]
    
    if next_line and next_line > game_line.time and total_seconds:
        end_trim_seconds = total_seconds + (next_line - game_line.time).total_seconds() + get_config().audio.pre_vad_end_offset
        ffmpeg_command.extend(['-to', f"{end_trim_seconds:.3f}"])
        logger.debug(f"Trimming end of audio to {end_trim_seconds:.3f} seconds")
    elif get_config().audio.pre_vad_end_offset and get_config().audio.pre_vad_end_offset < 0:
        end_trim_seconds = file_length + get_config().audio.pre_vad_end_offset
        ffmpeg_command.extend(['-to', str(end_trim_seconds)])
        logger.debug(f"Trimming end of audio to {end_trim_seconds} seconds")

    ffmpeg_command.extend(["-c", "copy", trimmed_audio])

    FFmpegHelper.run(ffmpeg_command, check=False)
    
    gsm_state.previous_trim_args = (untrimmed_audio, start_trim_time, end_trim_seconds)
    logger.debug(f"{total_seconds_after_offset} trimmed off of beginning")
    if source_padding:
        logger.debug(f"Applied source padding of {source_padding:.2f}s for audio start trim (source: {getattr(game_line, 'source', None)})")
    logger.success(f"Audio Extracted and trimmed to {start_trim_time} seconds" + 
                   (f" with end time {end_trim_seconds} seconds" if end_trim_seconds else ""))
    
    return trimmed_audio, start_trim_time, end_trim_seconds

def get_video_timings(video_path, game_line, anki_card_creation_time=None):
    if anki_card_creation_time:
        file_mod_time = anki_card_creation_time
    else:
        file_mod_time = get_file_modification_time(video_path)
    file_length = get_video_duration(video_path)
    time_delta = file_mod_time - game_line.time
    
    total_seconds = file_length - time_delta.total_seconds()
    total_seconds_after_offset = total_seconds + get_config().audio.beginning_offset
    
    if total_seconds < 0 or total_seconds >= file_length:
        logger.error("Line mined is outside of the replay buffer! Defaulting to the last 30 seconds.")
        return max(file_length - 30, 0), 0, max(file_length - 30, 0), file_length

    return total_seconds_after_offset, total_seconds, total_seconds_after_offset, file_length


def reencode_file_with_user_config(input_file, final_output_audio, user_ffmpeg_options):
    logger.debug(f"Re-encode running with settings:  {user_ffmpeg_options}")
    temp_file = create_temp_file_with_same_name(input_file)
    
    ext = get_config().audio.extension
    format_spec = supported_formats.get(ext, {})
    
    command = ffmpeg_base_command_list + [
        "-i", input_file,
        "-map", "0:a"
    ] + user_ffmpeg_options.replace("\"", "").split()
    
    if 'format' in format_spec:
        command.extend(["-f", format_spec['format']])
    
    command.append(temp_file)

    result = FFmpegHelper.run(command, check=False)

    if result.returncode != 0:
        logger.error("Re-encode failed, using original audio")
        return

    replace_file_with_retry(temp_file, final_output_audio)

def create_temp_file_with_same_name(input_file: str):
    path = Path(input_file)
    return str(path.with_name(f"{path.stem}_temp{path.suffix}"))

def replace_file_with_retry(temp_file, input_file, retries=5, delay=1):
    for attempt in range(retries):
        try:
            shutil.move(temp_file, input_file)
            return
        except OSError as e:
            if attempt < retries - 1:
                logger.warning(f"Attempt {attempt + 1}: File still in use. Retrying in {delay} seconds...")
                time.sleep(delay)
            else:
                logger.error(f"Failed to replace the file after {retries} attempts. Error: {e}")
                raise

def trim_audio_by_end_time(input_audio, end_time, output_audio):
    command = ffmpeg_base_command_list + [
        "-i", input_audio,
        "-to", str(end_time),
        "-c", "copy",
        output_audio
    ]
    FFmpegHelper.run(command, check=False)

def convert_audio_to_wav(input_audio, output_wav, use_filters: bool = True):
    def _run(filter_chain: Optional[str]):
        command = ffmpeg_base_command_list + [
            "-y",
            "-i", input_audio,
            "-vn",
            "-ar", "16000",
            "-ac", "1",
        ]
        if filter_chain:
            command.extend(["-af", filter_chain])
        command.extend(["-acodec", "pcm_s16le", output_wav])
        return FFmpegHelper.run(command, check=False)

    if not use_filters:
        return _run(None)

    filter_chain = "afftdn" if is_linux() else "afftdn,dialoguenhance"
    result = _run(filter_chain)
    if result.returncode != 0 and filter_chain != "afftdn":
        logger.warning("FFmpeg dialoguenhance filter failed; retrying with afftdn only.")
        result = _run("afftdn")
    return result

def convert_audio_to_wav_lossless(input_audio):
    output_wav = make_unique_file_name(
        os.path.join(configuration.get_temporary_directory(), "output.wav")
    )
    command = ffmpeg_base_command_list + ["-i", input_audio, output_wav]
    FFmpegHelper.run(command, check=False)
    return output_wav

def convert_audio_to_mp3(input_audio):
    output_mp3 = make_unique_file_name(
        os.path.join(configuration.get_temporary_directory(), "output.mp3")
    )
    command = ffmpeg_base_command_list + [
        "-i", input_audio,
        "-codec:a", "libmp3lame",
        "-qscale:a", "2",
        output_mp3
    ]
    FFmpegHelper.run(command, check=False)
    return output_mp3

def trim_audio(input_audio, start_time, end_time=0, output_audio=None, trim_beginning=False, fade_in_duration=0.05,
               fade_out_duration=0.05):
    command = ffmpeg_base_command_list.copy()
    command.extend(['-i', input_audio])

    if trim_beginning and start_time > 0:
        logger.debug(f"trimming beginning to {start_time}")
        command.extend(['-ss', f"{start_time:.2f}"])

    fade_filter = []
    if fade_in_duration > 0:
        fade_filter.append(f'afade=t=in:d={fade_in_duration}')
    if fade_out_duration > 0:
        fade_filter.append(f'afade=t=out:st={end_time - fade_out_duration:.2f}:d={fade_out_duration}')

    if end_time > 0:
        command.extend(['-to', f"{end_time:.2f}"])

    if fade_filter:
        command.extend(['-af', ",".join(fade_filter)]) # Fixed: Join multiple filters if both exist? Original had duplicate -af calls or combined string logic that was slightly off or just overwrote.
        # Original: command.extend(['-af', f'afade=t=in:d={fade_in_duration},afade=t=out:st={end_time - fade_out_duration:.2f}:d={fade_out_duration}'])
        # Original code actually hardcoded the combination if fade_filter was true (which meant ANY fade was true).
        # My logic above mimics the original "if fade_filter:" block by just putting them in the list.
        # But wait, original code:
        # if fade_filter:
        #    command.extend(['-af', f'afade=t=in:d={fade_in_duration},afade=t=out:st={end_time - fade_out_duration:.2f}:d={fade_out_duration}'])
        # It blindly added BOTH fades if 'fade_filter' list was not empty. Even if one was 0 duration?
        # Actually `if fade_in_duration > 0` adds to list.
        # So I should join the list.
        command.extend(['-c:a', supported_formats[get_config().audio.extension]['codec']])
    else:
        command.extend(['-c', 'copy'])

    command.append(output_audio)

    FFmpegHelper.run(command, check=True)

def combine_audio_files(audio_files, output_file):
    if not audio_files:
        logger.error("No audio files provided for combination.")
        return

    command = ffmpeg_base_command_list + [
        "-i", "concat:" + "|".join(audio_files),
        "-c", "copy",
        output_file
    ]
    FFmpegHelper.run(command, check=False)

def trim_replay_for_gameline(video_path, start_time, end_time, accurate=False):
    """Trims the video replay based on the start and end times."""
    output_name = f"trimmed_{Path(video_path).stem}.mp4"
    trimmed_video = os.path.join(configuration.get_temporary_directory(), output_name)
    
    command = ffmpeg_base_command_list + [
        "-ss", str(start_time),
        "-i", video_path,
    ]
    
    duration = end_time - start_time
    if duration > 0:
        command.extend(["-t", str(duration)])

    if accurate:
        command.extend(["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"])
        log_msg = f"Accurately trimming video (re-encoding) {video_path}"
    else:
        command.extend(["-c:v", "copy", "-c:a", "copy"])
        log_msg = f"Fast trimming video (stream copy) {video_path}"

    command.append(trimmed_video)
    
    video_length = get_video_duration(video_path)
    logger.info(f"{log_msg} of length {video_length} from {start_time} to {end_time} seconds.")
    
    FFmpegHelper.run(command, check=False)
    
    return trimmed_video

def is_video_big_enough(file_path, min_size_kb=250):
    try:
        file_size = os.path.getsize(file_path)
        file_size_kb = file_size / 1024
        return file_size_kb >= min_size_kb
    except Exception as e:
        logger.error(f"Error checking video size: {e}")
        return False

def get_audio_length(path):
    info = FFmpegHelper.get_probe_json(path, "format=duration", "")
    # Original used specific ffprobe command that outputted plain text, not JSON
    # get_probe_json might not work if "default=noprint..." is used with "-of json" which overrides?
    # Let's fallback to original command style for this specific one if strictness required.
    # Actually, let's just use JSON format which is cleaner.
    if info and 'format' in info:
        return float(info["format"]["duration"])
    
    # Fallback to plain run if JSON fails or returns nothing (e.g. for some audio files)
    try:
        result = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True
        )
        return float(result.stdout.strip())
    except Exception:
        return 0.0

def splice_audio(input_audio, output_audio, keep_ranges, fade_duration=0.05):
    """
    Splices audio by keeping specified ranges and concatenating them.
    keep_ranges: list of tuples (start, end) in seconds.
    """
    temp_files = []
    try:
        for i, (start, end) in enumerate(keep_ranges):
            seg_name = make_unique_file_name(
                os.path.join(get_temporary_directory(), f"segment_{i}_{os.path.basename(input_audio)}")
            )
            
            f_in = fade_duration if i == 0 else 0.01
            f_out = fade_duration if i == len(keep_ranges) - 1 else 0.01
            
            trim_audio(
                input_audio=input_audio,
                start_time=start,
                end_time=end,
                output_audio=seg_name,
                trim_beginning=True,
                fade_in_duration=f_in,
                fade_out_duration=f_out
            )
            temp_files.append(seg_name)
            
        combine_audio_files(temp_files, output_audio)
        
    finally:
        for f in temp_files:
            if os.path.exists(f):
                try:
                    os.remove(f)
                except Exception as e:
                    logger.error(f"Failed to remove temp file {f}: {e}")
