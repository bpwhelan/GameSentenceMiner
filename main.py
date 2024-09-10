import base64
import datetime
import json
import logging
import os
import random
import shutil
import string
import tempfile
import threading
import time
import pyperclip
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import urllib.request
import subprocess
from config import *
from datetime import datetime
from vosk_helper import process_audio_with_vosk

previous_clipboard = pyperclip.paste()
previous_clipboard_time = datetime.now()
tmpdirname = ''


def monitor_clipboard():
    global previous_clipboard_time, previous_clipboard

    # Initial clipboard content
    previous_clipboard = pyperclip.paste()

    while True:
        current_clipboard = pyperclip.paste()

        if current_clipboard != previous_clipboard:
            previous_clipboard = current_clipboard
            previous_clipboard_time = datetime.now()

        time.sleep(0.05)


# Start monitoring clipboard
# Run monitor_clipboard in the background
clipboard_thread = threading.Thread(target=monitor_clipboard)
clipboard_thread.daemon = True  # Ensures the thread will exit when the main program exits
clipboard_thread.start()

ffmpeg_base_command = "ffmpeg -hide_banner -loglevel error"
ffmpeg_base_command_list = ["ffmpeg", "-hide_banner", "-loglevel", "error"]

logging.basicConfig(filename='anki_script.log', level=logging.INFO,
                    format='%(asctime)s - %(levelname)s - %(message)s')

def trim_audio_by_end_time(input_audio, end_time, output_audio):
    command = f"{ffmpeg_base_command} -i \"{input_audio}\" -to {end_time} -c copy \"{output_audio}\""
    subprocess.call(command, shell=True)


def convert_opus_to_wav(input_opus, output_wav):
    command = f"{ffmpeg_base_command} -i \"{input_opus}\" -ar 16000 -ac 1 \"{output_wav}\""
    subprocess.call(command, shell=True)


class VideoToAudioHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        if event.src_path.endswith(".mkv"):  # Adjust based on your OBS output format
            logging.info(f"MKV {event.src_path} FOUND, RUNNING LOGIC")
            self.convert_to_audio(event.src_path)

    def convert_to_audio(self, video_path):
        added_ids = invoke('findNotes', query='added:1')
        last_note = invoke('notesInfo', notes=[added_ids[-1]])[0]
        logging.info(last_note)
        tango = last_note['fields']['Word']['value']
        audio_path = audio_destination + tango + ".opus"
        trimmed_audio = get_audio_and_trim(video_path)

        output_audio = make_unique_file_name(audio_path)
        if do_vosk_postprocessing:
            process_audio_with_vosk(trimmed_audio, output_audio, tmpdirname)
        else:
            shutil.copy2(trimmed_audio, output_audio)
        try:
            # Only update sentenceaudio if it's not present. Want to avoid accidentally overwriting sentence audio
            if update_anki and not last_note['fields'][sentence_audio_field]['value']:
                update_anki_card(last_note, output_audio, video_path, tango)
        except FileNotFoundError as f:
            print(f)
            print("Something went wrong with processing, anki card not updated")
        if remove_video:
            os.remove(video_path)  # Optionally remove the video after conversion


def get_audio_and_trim(video_path):
    untrimmed_audio = tempfile.NamedTemporaryFile(dir=tmpdirname, suffix="_untrimmed.opus").name
    # FFmpeg command to extract the audio without re-encoding
    command = f"{ffmpeg_base_command} -i \"{video_path}\" -map 0:a -c:a copy \"{untrimmed_audio}\""
    subprocess.call(command, shell=True)
    return trim_audio_based_on_clipboard(untrimmed_audio, video_path)


def request(action, **params):
    return {'action': action, 'params': params, 'version': 6}


def invoke(action, **params):
    requestJson = json.dumps(request(action, **params)).encode('utf-8')
    response = json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765', requestJson)))
    if len(response) != 2:
        raise Exception('response has an unexpected number of fields')
    if 'error' not in response:
        raise Exception('response is missing required error field')
    if 'result' not in response:
        raise Exception('response is missing required result field')
    if response['error'] is not None:
        raise Exception(response['error'])
    return response['result']


def update_anki_card(last_note, audio_path, video_path, tango):
    audio_in_anki = store_media_file(audio_path)
    audio_html = f"[sound:{audio_in_anki}]"
    screenshot_in_anki = store_media_file(get_screenshot(video_path, tango))
    image_html = f"<img src=\"{screenshot_in_anki}\">"
    invoke("updateNoteFields", note={'id': last_note['noteId'], 'fields': {sentence_audio_field: audio_html,
                                                                           picture_field: image_html,
                                                                           source_field: current_game}})
    logging.info(f"UPDATED ANKI CARD FOR {last_note['noteId']}")


def store_media_file(path):
    return invoke('storeMediaFile', filename=path, data=convert_to_base64(path))


def convert_to_base64(file_path):
    with open(file_path, "rb") as file:
        file_base64 = base64.b64encode(file.read()).decode('utf-8')
    return file_base64


def make_unique_file_name(path):
    split = path.rsplit('.', 1)
    filename = split[0]
    extension = split[1]
    return filename + "_" + get_random_digit_string() + "." + extension


def get_random_digit_string():
    return ''.join(random.choice(string.digits) for i in range(9))


# V2, get the image from the video instead of relying on another program
def get_screenshot(video_file, term):
    output_image = make_unique_file_name(screenshot_destination + term + ".webp")
    # FFmpeg command to extract the last frame of the video
    ffmpeg_command = ffmpeg_base_command_list + [
        "-sseof", "-1",  # Seek to 3 seconds before the end of the video
        "-i", video_file,
        "-vframes", "1",  # Extract only one frame
        "-compression_level", "6",
        "-q:v", "85",
        output_image
    ]
    # Run the command
    subprocess.run(ffmpeg_command)

    return output_image


def timedelta_to_ffmpeg_friendly_format(td_obj):
    total_seconds = td_obj.total_seconds()
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return "{:02}:{:02}:{:06.3f}".format(int(hours), int(minutes), seconds)


def get_file_modification_time(file_path):
    mod_time_epoch = os.path.getmtime(file_path)
    mod_time = datetime.fromtimestamp(mod_time_epoch)
    return mod_time


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
    trimmed_audio = tempfile.NamedTemporaryFile(dir=tmpdirname, suffix=".opus").name
    file_mod_time = get_file_modification_time(video_path)
    file_length = get_video_duration(video_path)
    time_delta = file_mod_time - previous_clipboard_time
    # Convert time_delta to FFmpeg-friendly format (HH:MM:SS.milliseconds)
    total_seconds = file_length - time_delta.total_seconds()
    if total_seconds < 0 or total_seconds >= file_length:
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

    logging.info(f"{total_seconds} trimmed off of beginning")

    print(f"Audio trimmed and saved to {trimmed_audio}")
    return trimmed_audio


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(dir="./") as tmpdirname:
        logging.info("Script started.")
        event_handler = VideoToAudioHandler()
        observer = Observer()
        observer.schedule(event_handler, folder_to_watch, recursive=False)
        observer.start()

        if start_obs_replaybuffer:
            subprocess.call("obs-cli replaybuffer start", shell=True)
            subprocess.call("obs-cli scene switch \"Dragon Quest\"", shell=True)

        print("Script Initalized. Happy Mining!")

        try:
            while True:
                time.sleep(10)
        except KeyboardInterrupt:
            observer.stop()
            if start_obs_replaybuffer:
                subprocess.call("obs-cli replaybuffer stop", shell=True)
        observer.join()
