import json
import subprocess
import tempfile

import clipboard
import config_reader
from config_reader import *
from util import *


def get_screenshot(video_file):
    output_image = make_unique_file_name(screenshot_destination + config_reader.current_game.replace(" ", "") + f".{screenshot_extension}")
    # FFmpeg command to extract the last frame of the video
    ffmpeg_command = ffmpeg_base_command_list + [
        "-sseof", "-1",  # Seek to 1 second before the end of the video
        "-i", video_file,
        "-vframes", "1",  # Extract only one frame
        "-compression_level", "6",
        "-q:v", screenshot_quality,
    ]

    if screenshot_width:
        ffmpeg_command.extend(["-vf", f"scale={screenshot_width}:-1"])

    ffmpeg_command.append(output_image)
    # Run the command
    subprocess.run(ffmpeg_command)

    logger.info(f"Screenshot saved to: {output_image}")

    return output_image


ffmpeg_base_command = "ffmpeg -hide_banner -loglevel error"
ffmpeg_base_command_list = ["ffmpeg", "-hide_banner", "-loglevel", "error"]


def get_audio_codec(video_path):
    command = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name",
        "-of", "json",
        video_path
    ]

    # Run the command and capture the output
    result = subprocess.run(command, capture_output=True, text=True)

    # Parse the JSON output
    try:
        output = json.loads(result.stdout)
        codec_name = output['streams'][0]['codec_name']
        return codec_name
    except (json.JSONDecodeError, KeyError, IndexError):
        logger.error("Failed to get codec information. Re-encoding Anyways")
        return None


def get_audio_and_trim(video_path):
    supported_formats = {
        'opus': 'opus',
        'mp3': 'libmp3lame',
        'ogg': 'libvorbis',
        'aac': 'aac',
        'm4a': 'aac',
    }

    codec = get_audio_codec(video_path)

    if codec == audio_extension:
        codec_command = '-c:a copy'
        logger.info(f"Extracting {audio_extension} from video")
    else:
        codec_command = f"-c:a {supported_formats[audio_extension]}"
        logger.info(f"Re-encoding {codec} to {audio_extension}")

    untrimmed_audio = tempfile.NamedTemporaryFile(dir=config_reader.temp_directory, suffix=f"_untrimmed.{audio_extension}").name

    # FFmpeg command to extract OR re-encode the audio
    command = f"{ffmpeg_base_command} -i \"{video_path}\" -map 0:a {codec_command} \"{untrimmed_audio}\""

    subprocess.call(command, shell=True)
    return trim_audio_based_on_clipboard(untrimmed_audio, video_path)


def get_video_duration(file_path):
    ffprobe_command = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        file_path
    ]
    result = subprocess.run(ffprobe_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    duration_info = json.loads(result.stdout)
    return float(duration_info["format"]["duration"])  # Return the duration in seconds


def trim_audio_based_on_clipboard(untrimmed_audio, video_path):
    trimmed_audio = tempfile.NamedTemporaryFile(dir=config_reader.temp_directory, suffix=f".{audio_extension}").name
    file_mod_time = get_file_modification_time(video_path)
    file_length = get_video_duration(video_path)
    time_delta = file_mod_time - clipboard.previous_clipboard_time
    # Convert time_delta to FFmpeg-friendly format (HH:MM:SS.milliseconds)
    total_seconds = file_length - time_delta.total_seconds() + config_reader.audio_beginning_offset
    if total_seconds < 0 or total_seconds >= file_length:
        logger.info(f"0 seconds trimmed off of beginning")
        return untrimmed_audio

    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    start_trim_time = "{:02}:{:02}:{:06.3f}".format(int(hours), int(minutes), seconds)

    ffmpeg_command = ffmpeg_base_command_list + [
        "-i", untrimmed_audio,
        "-ss", start_trim_time,
        "-c", "copy",  # Using copy to avoid re-encoding, adjust if needed
        trimmed_audio
    ]
    subprocess.run(ffmpeg_command)

    logger.info(f"{total_seconds} trimmed off of beginning")

    logger.info(f"Audio trimmed and saved to {trimmed_audio}")
    return trimmed_audio


def trim_audio_by_end_time(input_audio, end_time, output_audio):
    command = f"{ffmpeg_base_command} -i \"{input_audio}\" -to {end_time} -c copy \"{output_audio}\""
    subprocess.call(command, shell=True)


def convert_audio_to_wav(input_audio, output_wav):
    command = f"{ffmpeg_base_command} -i \"{input_audio}\" -ar 16000 -ac 1 \"{output_wav}\""
    subprocess.call(command, shell=True)
