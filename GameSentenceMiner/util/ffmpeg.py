import subprocess
import tempfile
import time
from pathlib import Path

from GameSentenceMiner import obs
from GameSentenceMiner.util.gsm_utils import make_unique_file_name, get_file_modification_time
from GameSentenceMiner.util import configuration
from GameSentenceMiner.util.configuration import *
from GameSentenceMiner.util.model import VADResult
from GameSentenceMiner.util.text_log import initial_time


def get_ffmpeg_path():
    return os.path.join(get_app_directory(), "ffmpeg", "ffmpeg.exe") if is_windows() else "ffmpeg"

def get_ffprobe_path():
    return os.path.join(get_app_directory(), "ffmpeg", "ffprobe.exe") if is_windows() else "ffprobe"

ffmpeg_base_command_list = [get_ffmpeg_path(), "-hide_banner", "-loglevel", "error", '-nostdin']

supported_formats = {
    'opus': 'libopus',
    'mp3': 'libmp3lame',
    'ogg': 'libvorbis',
    'aac': 'aac',
    'm4a': 'aac',
}

def call_frame_extractor(video_path, timestamp):
    """
    Calls the video frame extractor script and captures the output.

    Args:
        video_path (str): Path to the video file.
        timestamp (str): Timestamp string (HH:MM:SS).

    Returns:
        str: The path of the selected image, or None on error.
    """
    try:
        # Get the directory of the current script
        current_dir = os.path.dirname(os.path.abspath(__file__))
        # Construct the path to the frame extractor script
        script_path = os.path.join(current_dir, "ss_selector.py")  # Replace with the actual script name if different

        logger.info(' '.join([sys.executable, "-m", "GameSentenceMiner.util.ss_selector", video_path, str(timestamp)]))

        # Run the script using subprocess.run()
        result = subprocess.run(
            [sys.executable, "-m", "GameSentenceMiner.util.ss_selector", video_path, str(timestamp), get_config().screenshot.screenshot_timing_setting],  # Use sys.executable
            capture_output=True,
            text=True,  # Get output as text
            check=False  # Raise an exception for non-zero exit codes
        )
        if result.returncode != 0:
            logger.error(f"Script failed with return code: {result.returncode}")
            return None
        logger.info(result)
        # Print the standard output
        logger.info(f"Frame extractor script output: {result.stdout.strip()}")
        return result.stdout.strip() # Return the output

    except subprocess.CalledProcessError as e:
        logger.error(f"Error calling script: {e}")
        logger.error(f"Script output (stderr): {e.stderr.strip()}")
        return None
    except FileNotFoundError:
        logger.error(f"Error: Script not found at {script_path}.  Make sure the script name is correct.")
        return None
    except Exception as e:
        logger.error(f"An unexpected error occurred: {e}")
        return None

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
        get_config().paths.screenshot_destination, f"{obs.get_current_game(sanitize=True)}.{get_config().screenshot.extension}"))
    # FFmpeg command to extract the last frame of the video
    ffmpeg_command = ffmpeg_base_command_list + [
        "-ss", f"{screenshot_timing}",
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

    try:
        for i in range(3):
            logger.debug(" ".join(ffmpeg_command))
            result = subprocess.run(ffmpeg_command)
            if result.returncode != 0 and i < 2:
                raise RuntimeError(f"FFmpeg command failed with return code {result.returncode}")
            else:
                break
    except Exception as e:
        logger.error(f"Error running FFmpeg command: {e}. Defaulting to standard PNG.")
        output_image = make_unique_file_name(os.path.join(
            get_config().paths.screenshot_destination,
            f"{obs.get_current_game(sanitize=True)}.png"))
        ffmpeg_command = ffmpeg_base_command_list + [
            "-ss", f"{screenshot_timing}",  # Default to 1 second
            "-i", video_file,
            "-vframes", "1",
            output_image
        ]
        subprocess.run(ffmpeg_command)

    logger.debug(f"Screenshot saved to: {output_image}")

    return output_image

def get_screenshot_for_line(video_file, game_line, try_selector=False):
    return get_screenshot(video_file, get_screenshot_time(video_file, game_line), try_selector)


def get_screenshot_time(video_path, game_line, default_beginning=False, vad_result=None, doing_multi_line=False, previous_line=False, anki_card_creation_time=0):
    if game_line:
        line_time = game_line.time
    else:
        # Assuming initial_time is defined elsewhere if game_line is None
        line_time = initial_time
    if previous_line:
        logger.debug(f"Calculating screenshot time for previous line: {str(game_line.text)}")
    else:
        logger.debug("Calculating screenshot time for line: " + str(game_line.text))

    file_length = get_video_duration(video_path)
    if anki_card_creation_time:
        file_mod_time = anki_card_creation_time
    else:
        file_mod_time = get_file_modification_time(video_path)

    # Calculate when the line occurred within the video file (seconds from start)
    time_delta = file_mod_time - line_time
    line_timestamp_in_video = file_length - time_delta.total_seconds()
    screenshot_offset = get_config().screenshot.seconds_after_line

    # Calculate screenshot time from the beginning by adding the offset
    # if vad_result and vad_result.success and not doing_multi_line:
    #     screenshot_time_from_beginning = line_timestamp_in_video + vad_result.end - 1
    #     logger.info(f"Using VAD result {vad_result} for screenshot time: {screenshot_time_from_beginning} seconds from beginning of replay")
    if get_config().screenshot.screenshot_timing_setting == "beginning":
        screenshot_time_from_beginning = line_timestamp_in_video + screenshot_offset
        logger.debug(f"Using 'beginning' setting for screenshot time: {screenshot_time_from_beginning} seconds from beginning of replay")
    elif get_config().screenshot.screenshot_timing_setting == "middle":
        if game_line.next:
            screenshot_time_from_beginning = line_timestamp_in_video + ((game_line.next.time - game_line.time).total_seconds() / 2) + screenshot_offset
        else:
            screenshot_time_from_beginning = (file_length - ((file_length - line_timestamp_in_video) / 2)) + screenshot_offset
        logger.debug(f"Using 'middle' setting for screenshot time: {screenshot_time_from_beginning} seconds from beginning of replay")
    elif get_config().screenshot.screenshot_timing_setting == "end":
        if game_line.next:
            screenshot_time_from_beginning = line_timestamp_in_video + (game_line.next.time - game_line.time).total_seconds() - screenshot_offset
        else:
            screenshot_time_from_beginning = file_length - screenshot_offset
        logger.debug(f"Using 'end' setting for screenshot time: {screenshot_time_from_beginning} seconds from beginning of replay")
    else:
        logger.error(f"Invalid screenshot timing setting: {get_config().screenshot.screenshot_timing_setting}")
        screenshot_time_from_beginning = line_timestamp_in_video + screenshot_offset

    # Check if the calculated time is out of bounds
    if screenshot_time_from_beginning < 0 or screenshot_time_from_beginning > file_length:
        logger.error(
             f"Calculated screenshot time ({screenshot_time_from_beginning:.2f}s) is out of bounds for video (length {file_length:.2f}s)."
        )
        if default_beginning:
            return 1.0
        return file_length - screenshot_offset

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
    try:
        for i in range(3):
            logger.debug(" ".join(ffmpeg_command))
            result = subprocess.run(ffmpeg_command)
            if result.returncode != 0 and i < 2:
                raise RuntimeError(f"FFmpeg command failed with return code {result.returncode}")
            else:
                break
    except Exception as e:
        logger.error(f"Error re-encoding screenshot: {e}. Defaulting to standard PNG.")
        output_image = make_unique_file_name(os.path.join(get_config().paths.screenshot_destination, f"{obs.get_current_game(sanitize=True)}.png"))
        shutil.move(image_file, output_image)

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


def get_audio_and_trim(video_path, game_line, next_line_time, anki_card_creation_time):
    codec = get_audio_codec(video_path)

    if codec == get_config().audio.extension:
        codec_command = ['-c:a', 'copy']
        logger.debug(f"Extracting {get_config().audio.extension} from video")
    else:
        codec_command = ["-c:a", f"{supported_formats[get_config().audio.extension]}"]
        logger.debug(f"Re-encoding {codec} to {get_config().audio.extension}")

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

    return trim_audio_based_on_last_line(untrimmed_audio, video_path, game_line, next_line_time, anki_card_creation_time)


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


def trim_audio_based_on_last_line(untrimmed_audio, video_path, game_line, next_line, anki_card_creation_time):
    trimmed_audio = tempfile.NamedTemporaryFile(dir=configuration.get_temporary_directory(),
                                                suffix=f".{get_config().audio.extension}").name
    start_trim_time, total_seconds, total_seconds_after_offset, file_length = get_video_timings(video_path, game_line, anki_card_creation_time)
    end_trim_time = 0

    ffmpeg_command = ffmpeg_base_command_list + [
        "-i", untrimmed_audio,
        "-ss", str(start_trim_time)]
    if next_line and next_line > game_line.time:
        end_total_seconds = total_seconds + (next_line - game_line.time).total_seconds() + get_config().audio.pre_vad_end_offset
        end_trim_time = f"{end_total_seconds:.3f}"
        ffmpeg_command.extend(['-to', end_trim_time])
        logger.debug(
            f"Looks Like this is mining from History, or Multiple Lines were selected Trimming end of audio to {end_trim_time} seconds")
    elif get_config().audio.pre_vad_end_offset and get_config().audio.pre_vad_end_offset < 0:
        end_total_seconds = file_length + get_config().audio.pre_vad_end_offset
        end_trim_time = f"{end_total_seconds:.3f}"
        ffmpeg_command.extend(['-to', end_trim_time])
        logger.debug(f"Trimming end of audio to {end_trim_time} seconds due to pre-vad end offset")

    ffmpeg_command.extend([
        "-c", "copy",  # Using copy to avoid re-encoding, adjust if needed
        trimmed_audio
    ])

    logger.debug(" ".join(ffmpeg_command))
    subprocess.run(ffmpeg_command)
    gsm_state.previous_trim_args = (untrimmed_audio, start_trim_time, end_trim_time)

    logger.debug(f"{total_seconds_after_offset} trimmed off of beginning")

    if end_trim_time:
        logger.info(f"Audio Extracted and trimmed to {start_trim_time} seconds with end time {end_trim_time}")
    else:
        logger.info(f"Audio Extracted and trimmed to {start_trim_time} seconds")

    logger.debug(f"Audio trimmed and saved to {trimmed_audio}")
    return trimmed_audio

def get_video_timings(video_path, game_line, anki_card_creation_time=None):
    if anki_card_creation_time:
        file_mod_time = anki_card_creation_time
    else:
        file_mod_time = get_file_modification_time(video_path)
    file_length = get_video_duration(video_path)
    time_delta = file_mod_time - game_line.time
    # Convert time_delta to FFmpeg-friendly format (HH:MM:SS.milliseconds)
    total_seconds = file_length - time_delta.total_seconds()
    total_seconds_after_offset = total_seconds + get_config().audio.beginning_offset
    if total_seconds < 0 or total_seconds >= file_length:
        logger.error("Line mined is outside of the replay buffer! Defaulting to the beginning of the replay buffer. ")
        logger.info("Recommend either increasing replay buffer length in OBS Settings or mining faster.")
        return 0, 0, 0, file_length

    return total_seconds_after_offset, total_seconds, total_seconds_after_offset, file_length


def reencode_file_with_user_config(input_file, final_output_audio, user_ffmpeg_options):
    logger.debug(f"Re-encode running with settings:  {user_ffmpeg_options}")
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
    logger.debug(" ".join(command))
    subprocess.run(command)


def convert_audio_to_wav(input_audio, output_wav):
    command = ffmpeg_base_command_list + [
        "-i", input_audio,
        "-ar", "16000",  # Resample to 16kHz
        "-ac", "1",      # Convert to mono
        "-af", "afftdn,dialoguenhance" if not is_linux() else "afftdn",
        output_wav
    ]
    logger.debug(" ".join(command))
    subprocess.run(command)

def convert_audio_to_wav_lossless(input_audio):
    output_wav = make_unique_file_name(
        os.path.join(configuration.get_temporary_directory(), "output.wav")
    )
    command = ffmpeg_base_command_list + [
        "-i", input_audio,
        output_wav
    ]
    logger.debug(" ".join(command))
    subprocess.run(command)
    return output_wav

def convert_audio_to_mp3(input_audio):
    output_mp3 = make_unique_file_name(
        os.path.join(configuration.get_temporary_directory(), "output.mp3")
    )
    command = ffmpeg_base_command_list + [
        "-i", input_audio,
        "-codec:a", "libmp3lame",
        "-qscale:a", "2",  # Quality scale for MP3
        output_mp3
    ]
    logger.debug(" ".join(command))
    subprocess.run(command)
    return output_mp3


# Trim the audio using FFmpeg based on detected speech timestamps
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
    #     fade_filter.append(f'afade=t=out:d={fade_out_duration}')

    if end_time > 0:
        command.extend([
            '-to', f"{end_time:.2f}",
        ])

    if fade_filter:
        command.extend(['-af', f'afade=t=in:d={fade_in_duration},afade=t=out:st={end_time - fade_out_duration:.2f}:d={fade_out_duration}'])
        command.extend(['-c:a', supported_formats[get_config().audio.extension]])
    else:
        command.extend(['-c', 'copy'])

    command.append(output_audio)

    logger.debug(" ".join(command))

    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as e:
        logger.error(f"FFmpeg command failed with error: {e}")
        logger.error(f"Command: {' '.join(command)}")
    except FileNotFoundError:
        logger.error("FFmpeg not found. Please ensure FFmpeg is installed and in your PATH.")


def combine_audio_files(audio_files, output_file):
    if not audio_files:
        logger.error("No audio files provided for combination.")
        return

    command = ffmpeg_base_command_list + [
        "-i", "concat:" + "|".join(audio_files),
        "-c", "copy",
        output_file
    ]

    logger.debug("Combining audio files with command: " + " ".join(command))

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


def get_audio_length(path):
    result = subprocess.run(
        [get_ffprobe_path(), "-v", "error", "-show_entries", "format=duration", "-of",
         "default=noprint_wrappers=1:nokey=1", path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    return float(result.stdout.strip())
