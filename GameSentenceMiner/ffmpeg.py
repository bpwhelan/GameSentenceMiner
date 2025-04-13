import subprocess
import tempfile
import time

from GameSentenceMiner import obs, util, configuration
from GameSentenceMiner.configuration import *
from GameSentenceMiner.util import *
from GameSentenceMiner.gametext import initial_time


def get_ffmpeg_path():
    return os.path.join(get_app_directory(), "ffmpeg", "ffmpeg.exe") if util.is_windows() else "ffmpeg"

def get_ffprobe_path():
    return os.path.join(get_app_directory(), "ffmpeg", "ffprobe.exe") if util.is_windows() else "ffprobe"

ffmpeg_base_command_list = [get_ffmpeg_path(), "-hide_banner", "-loglevel", "error", '-nostdin']


def get_screenshot(video_file, screenshot_timing):
    screenshot_timing = screenshot_timing if screenshot_timing else 1
    output_image = make_unique_file_name(os.path.join(
        get_config().paths.screenshot_destination, f"{obs.get_current_game(sanitize=True)}.{get_config().screenshot.extension}"))
    # FFmpeg command to extract the last frame of the video
    ffmpeg_command = ffmpeg_base_command_list + [
        "-ss", f"{screenshot_timing}",  # Seek to 1 second after the beginning
        "-i", f"{video_file}",
        "-vframes", "1"  # Extract only one frame
    ]

    if get_config().screenshot.custom_ffmpeg_settings:
        ffmpeg_command.extend(get_config().screenshot.custom_ffmpeg_settings.replace("\"", "").split(" "))
    else:
        ffmpeg_command.extend(["-compression_level", "6", "-q:v", get_config().screenshot.quality])

    if get_config().screenshot.width or get_config().screenshot.height:
        ffmpeg_command.extend(
            ["-vf", f"scale={get_config().screenshot.width or -1}:{get_config().screenshot.height or -1}"])

    ffmpeg_command.append(f"{output_image}")

    logger.debug(f"FFMPEG SS Command: {ffmpeg_command}")

    # Run the command
    subprocess.run(ffmpeg_command)

    logger.info(f"Screenshot saved to: {output_image}")

    return output_image

def get_screenshot_for_line(video_file, game_line):
    return get_screenshot(video_file, get_screenshot_time(video_file, game_line))


def get_screenshot_time(video_path, game_line, default_beginning=False, vad_beginning=None, vad_end=None):
    if game_line:
        line_time = game_line.time
    else:
        # Assuming initial_time is defined elsewhere if game_line is None
        line_time = initial_time

    file_length = get_video_duration(video_path)
    file_mod_time = get_file_modification_time(video_path)

    # Calculate when the line occurred within the video file (seconds from start)
    time_delta = file_mod_time - line_time
    line_timestamp_in_video = file_length - time_delta.total_seconds()
    screenshot_offset = get_config().screenshot.seconds_after_line

    # Calculate screenshot time from the beginning by adding the offset
    if vad_beginning and vad_end:
        logger.debug("Using VAD to determine screenshot time")
        screenshot_time_from_beginning = line_timestamp_in_video + vad_end - screenshot_offset
    elif get_config().screenshot.use_new_screenshot_logic:
        if game_line.next:
            logger.debug("Finding time between lines for screenshot")
            screenshot_time_from_beginning = line_timestamp_in_video + ((game_line.next.time - game_line.time).total_seconds() / 2)
        else:
            logger.debug("Using end of line for screenshot")
            screenshot_time_from_beginning = file_length - screenshot_offset
    else:
        screenshot_time_from_beginning = line_timestamp_in_video + screenshot_offset

    # Check if the calculated time is out of bounds
    if screenshot_time_from_beginning < 0 or screenshot_time_from_beginning > file_length:
        logger.error(
             f"Calculated screenshot time ({screenshot_time_from_beginning:.2f}s) is out of bounds for video (length {file_length:.2f}s)."
        )
        if default_beginning:
            logger.info("Defaulting to using the beginning of the video (1.0s)")
            # Return time for the start of the video
            return 1.0
        logger.info(f"Defaulting to using the end of the video ({file_length:.2f}s)")
        return file_length - screenshot_offset

    logger.info("Screenshot time from beginning: " + str(screenshot_time_from_beginning))

    # Return the calculated time from the beginning
    return screenshot_time_from_beginning


def process_image(image_file):
    output_image = make_unique_file_name(
        os.path.join(get_config().paths.screenshot_destination, f"{obs.get_current_game(sanitize=True)}.{get_config().screenshot.extension}"))

    # FFmpeg command to process the input image
    ffmpeg_command = ffmpeg_base_command_list + [
        "-i", image_file
    ]

    if get_config().screenshot.custom_ffmpeg_settings:
        ffmpeg_command.extend(get_config().screenshot.custom_ffmpeg_settings.split(" "))
    else:
        ffmpeg_command.extend(["-compression_level", "6", "-q:v", get_config().screenshot.quality])

    if get_config().screenshot.width or get_config().screenshot.height:
        ffmpeg_command.extend(
            ["-vf", f"scale={get_config().screenshot.width or -1}:{get_config().screenshot.height or -1}"])

    ffmpeg_command.append(output_image)
    logger.debug(ffmpeg_command)
    logger.debug(" ".join(ffmpeg_command))
    # Run the command
    subprocess.run(ffmpeg_command)

    logger.info(f"Processed image saved to: {output_image}")

    return output_image


def get_audio_codec(video_path):
    command = [
        f"{get_ffprobe_path()}",
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name",
        "-of", "json",
        video_path
    ]

    logger.debug(" ".join(command))
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


def get_audio_and_trim(video_path, game_line, next_line_time):
    supported_formats = {
        'opus': 'libopus',
        'mp3': 'libmp3lame',
        'ogg': 'libvorbis',
        'aac': 'aac',
        'm4a': 'aac',
    }

    codec = get_audio_codec(video_path)

    if codec == get_config().audio.extension:
        codec_command = ['-c:a', 'copy']
        logger.info(f"Extracting {get_config().audio.extension} from video")
    else:
        codec_command = ["-c:a", f"{supported_formats[get_config().audio.extension]}"]
        logger.info(f"Re-encoding {codec} to {get_config().audio.extension}")

    untrimmed_audio = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(),
                                                  suffix=f"_untrimmed.{get_config().audio.extension}").name

    command = ffmpeg_base_command_list + [
        "-i", video_path,
        "-map", "0:a"] + codec_command + [
                  untrimmed_audio
              ]

    # FFmpeg command to extract OR re-encode the audio
    # command = f"{ffmpeg_base_command} -i \"{video_path}\" -map 0:a {codec_command} \"{untrimmed_audio}\""
    logger.debug("Doing initial audio extraction")
    logger.debug(" ".join(command))

    subprocess.run(command)

    return trim_audio_based_on_last_line(untrimmed_audio, video_path, game_line, next_line_time)


def get_video_duration(file_path):
    ffprobe_command = [
        f"{get_ffprobe_path()}",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        file_path
    ]
    logger.debug(" ".join(ffprobe_command))
    result = subprocess.run(ffprobe_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    duration_info = json.loads(result.stdout)
    logger.debug(f"Video duration: {duration_info}")
    return float(duration_info["format"]["duration"])  # Return the duration in seconds


def trim_audio_based_on_last_line(untrimmed_audio, video_path, game_line, next_line):
    trimmed_audio = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(),
                                                suffix=f".{get_config().audio.extension}").name
    start_trim_time, total_seconds, total_seconds_after_offset = get_video_timings(video_path, game_line)

    ffmpeg_command = ffmpeg_base_command_list + [
        "-i", untrimmed_audio,
        "-ss", str(start_trim_time)]
    if next_line and next_line > game_line.time:
        end_total_seconds = total_seconds + (next_line - game_line.time).total_seconds() + 1
        hours, remainder = divmod(end_total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        end_trim_time = "{:02}:{:02}:{:06.3f}".format(int(hours), int(minutes), seconds)
        ffmpeg_command.extend(['-to', end_trim_time])
        logger.info(
            f"Looks Like this is mining from History, or Multiple Lines were selected Trimming end of audio to {end_trim_time}")

    ffmpeg_command.extend([
        "-c", "copy",  # Using copy to avoid re-encoding, adjust if needed
        trimmed_audio
    ])

    logger.debug(" ".join(ffmpeg_command))
    subprocess.run(ffmpeg_command)

    logger.info(f"{total_seconds_after_offset} trimmed off of beginning")

    logger.info(f"Audio trimmed and saved to {trimmed_audio}")
    return trimmed_audio

def get_video_timings(video_path, game_line):
    file_mod_time = get_file_modification_time(video_path)
    file_length = get_video_duration(video_path)
    time_delta = file_mod_time - game_line.time
    # Convert time_delta to FFmpeg-friendly format (HH:MM:SS.milliseconds)
    total_seconds = file_length - time_delta.total_seconds()
    total_seconds_after_offset = total_seconds + get_config().audio.beginning_offset
    if total_seconds < 0 or total_seconds >= file_length:
        logger.error("Line mined is outside of the replay buffer! Defaulting to the beginning of the replay buffer. ")
        logger.info("Recommend either increasing replay buffer length in OBS Settings or mining faster.")
        return 0, 0, 0

    hours, remainder = divmod(total_seconds_after_offset, 3600)
    minutes, seconds = divmod(remainder, 60)
    start_trim_time = "{:02}:{:02}:{:06.3f}".format(int(hours), int(minutes), seconds)
    return start_trim_time, total_seconds, total_seconds_after_offset


def reencode_file_with_user_config(input_file, final_output_audio, user_ffmpeg_options):
    logger.info(f"Re-encode running with settings:  {user_ffmpeg_options}")
    temp_file = create_temp_file_with_same_name(input_file)
    command = ffmpeg_base_command_list + [
        "-i", input_file,
        "-map", "0:a"
    ] + user_ffmpeg_options.replace("\"", "").split(" ") + [
                  temp_file
              ]

    logger.debug(" ".join(command))
    process = subprocess.run(command)

    if process.returncode != 0:
        logger.error("Re-encode failed, using original audio")
        return

    replace_file_with_retry(temp_file, final_output_audio)


def create_temp_file_with_same_name(input_file: str):
    split = input_file.split(".")
    return f"{split[0]}_temp.{split[1]}"


def replace_file_with_retry(temp_file, input_file, retries=5, delay=1):
    for attempt in range(retries):
        try:
            shutil.move(temp_file, input_file)
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
    command = ffmpeg_base_command_list + [
        "-i", input_audio,
        "-to", str(end_time),
        "-c", "copy",
        output_audio
    ]
    logger.debug(" ".join(command))
    subprocess.run(command)


def convert_audio_to_wav(input_audio, output_wav):
    command = ffmpeg_base_command_list + [
        "-i", input_audio,
        "-ar", "16000",
        "-ac", "1",
        "-af", "afftdn,dialoguenhance" if not util.is_linux() else "afftdn",
        output_wav
    ]
    logger.debug(" ".join(command))
    subprocess.run(command)


# Trim the audio using FFmpeg based on detected speech timestamps
def trim_audio(input_audio, start_time, end_time, output_audio):
    command = ffmpeg_base_command_list.copy()

    command.extend(['-i', input_audio])

    if get_config().vad.trim_beginning and start_time > 0:
        logger.info(f"trimming beginning to {start_time}")
        command.extend(['-ss', f"{start_time:.2f}"])

    command.extend([
        '-to', f"{end_time:.2f}",
        '-c', 'copy',
        output_audio
    ])

    logger.debug(" ".join(command))

    subprocess.run(command)


def is_video_big_enough(file_path, min_size_kb=250):
    try:
        file_size = os.path.getsize(file_path)  # Size in bytes
        file_size_kb = file_size / 1024  # Convert to KB
        return file_size_kb >= min_size_kb
    except FileNotFoundError:
        logger.error("File not found!")
        return False
    except Exception as e:
        logger.error(f"Error: {e}")
        return False

