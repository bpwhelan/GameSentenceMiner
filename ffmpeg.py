import tempfile
import time

import configuration
from configuration import *
from util import *


def get_screenshot(video_file):
    output_image = make_unique_file_name(
        get_config().paths.screenshot_destination + configuration.current_game.replace(" ", "") + f".{get_config().screenshot.extension}")
    # FFmpeg command to extract the last frame of the video
    ffmpeg_command = ffmpeg_base_command_list + [
        "-sseof", "-1",  # Seek to 1 second before the end of the video
        "-i", f"{video_file}",
        "-vframes", "1"  # Extract only one frame
    ]

    if get_config().screenshot.custom_ffmpeg_settings:
        ffmpeg_command.extend(get_config().screenshot.custom_ffmpeg_settings.split())
    else:
        ffmpeg_command.extend(["-compression_level", "6", "-q:v", get_config().screenshot.quality])

    if get_config().screenshot.width or get_config().screenshot.height:
        ffmpeg_command.extend(["-vf", f"scale={get_config().screenshot.width or -1}:{get_config().screenshot.height or -1}"])

    logger.debug(f"FFMPEG SS Command: {ffmpeg_command}")

    ffmpeg_command.append(f"{output_image}")
    # Run the command
    subprocess.run(ffmpeg_command)

    logger.info(f"Screenshot saved to: {output_image}")

    return output_image


def process_image(image_file):
    output_image = make_unique_file_name(
        get_config().paths.screenshot_destination + current_game.replace(" ", "") + f".{get_config().screenshot.extension}")

    # FFmpeg command to process the input image
    ffmpeg_command = ffmpeg_base_command_list + [
        "-i", image_file
    ]

    if get_config().screenshot.custom_ffmpeg_settings:
        ffmpeg_command.extend(get_config().screenshot.custom_ffmpeg_settings.split())
    else:
        ffmpeg_command.extend(["-compression_level", "6", "-q:v", get_config().screenshot.quality])

    if get_config().screenshot.width or get_config().screenshot.height:
        ffmpeg_command.extend(["-vf", f"scale={get_config().screenshot.width or -1}:{get_config().screenshot.height or -1}"])

    logger.debug(f"FFMPEG Image Command: {ffmpeg_command}")

    ffmpeg_command.append(output_image)
    # Run the command
    subprocess.run(ffmpeg_command)

    logger.info(f"Processed image saved to: {output_image}")

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


def get_audio_and_trim(video_path, line_time, next_line_time):
    supported_formats = {
        'opus': 'opus',
        'mp3': 'libmp3lame',
        'ogg': 'libvorbis',
        'aac': 'aac',
        'm4a': 'aac',
    }

    codec = get_audio_codec(video_path)

    if codec == get_config().audio.extension:
        codec_command = '-c:a copy'
        logger.info(f"Extracting {get_config().audio.extension} from video")
    else:
        codec_command = f"-c:a {supported_formats[get_config().audio.extension]}"
        logger.info(f"Re-encoding {codec} to {get_config().audio.extension}")

    untrimmed_audio = tempfile.NamedTemporaryFile(dir=configuration.temp_directory,
                                                  suffix=f"_untrimmed.{get_config().audio.extension}").name

    # FFmpeg command to extract OR re-encode the audio
    command = f"{ffmpeg_base_command} -i \"{video_path}\" -map 0:a {codec_command} \"{untrimmed_audio}\""

    logger.debug(command)

    subprocess.run(command)

    return trim_audio_based_on_last_line(untrimmed_audio, video_path, line_time, next_line_time)


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


def trim_audio_based_on_last_line(untrimmed_audio, video_path, line_time, next_line):
    trimmed_audio = tempfile.NamedTemporaryFile(dir=configuration.temp_directory, suffix=f".{get_config().audio.extension}").name
    file_mod_time = get_file_modification_time(video_path)
    file_length = get_video_duration(video_path)
    time_delta = file_mod_time - line_time
    # Convert time_delta to FFmpeg-friendly format (HH:MM:SS.milliseconds)
    total_seconds = file_length - time_delta.total_seconds() + get_config().audio.beginning_offset
    if total_seconds < 0 or total_seconds >= file_length:
        logger.info(f"0 seconds trimmed off of beginning")
        return untrimmed_audio

    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    start_trim_time = "{:02}:{:02}:{:06.3f}".format(int(hours), int(minutes), seconds)

    ffmpeg_command = ffmpeg_base_command_list + [
        "-i", untrimmed_audio,
        "-ss", start_trim_time]

    if next_line:
        end_total_seconds = total_seconds + (next_line - line_time).total_seconds()
        hours, remainder = divmod(end_total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        end_trim_time = "{:02}:{:02}:{:06.3f}".format(int(hours), int(minutes), seconds)
        ffmpeg_command.extend(['-to', end_trim_time])
        logger.info(
            f"Looks like Clipboard/Websocket was modified before the script knew about the anki card! Trimming end of video to {end_trim_time}")

    ffmpeg_command.extend([
        "-c", "copy",  # Using copy to avoid re-encoding, adjust if needed
        trimmed_audio
    ])
    subprocess.run(ffmpeg_command)

    logger.info(f"{total_seconds} trimmed off of beginning")

    logger.info(f"Audio trimmed and saved to {trimmed_audio}")
    return trimmed_audio


def reencode_file_with_user_config(input_file, user_ffmpeg_options):
    logger.info(f"Re-encode running with settings:  {user_ffmpeg_options}")
    temp_file = input_file + ".temp"
    command = f"{ffmpeg_base_command} -i \"{input_file}\" -map 0:a {user_ffmpeg_options} \"{temp_file}\""

    logger.debug(command)
    process = subprocess.run(command)

    if process.returncode != 0:
        logger.error("Re-encode failed, using original audio")
        return

    replace_file_with_retry(temp_file, input_file)


def replace_file_with_retry(temp_file, input_file, retries=5, delay=1):
    for attempt in range(retries):
        try:
            os.replace(temp_file, input_file)
            logger.info(f'Re-encode Finished!')
            return
        except OSError as e:
            if attempt < retries - 1:
                logger.warning(f"Attempt {attempt + 1}: File still in use. Retrying in {delay} seconds...")
                time.sleep(delay)
            else:
                logger.error(f"Failed to replace the file after {retries} attempts. Error: {e}")
                raise


def trim_audio_by_end_time(input_audio, end_time, output_audio):
    command = f"{ffmpeg_base_command} -i \"{input_audio}\" -to {end_time} -c copy \"{output_audio}\""
    subprocess.run(command)


def convert_audio_to_wav(input_audio, output_wav):
    command = f"{ffmpeg_base_command} -i \"{input_audio}\" -ar 16000 -ac 1 \"{output_wav}\""
    subprocess.run(command)
