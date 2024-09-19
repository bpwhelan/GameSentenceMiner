import json
import shutil
import tempfile
import time
import os
import sys
import subprocess
import threading
import keyboard

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

import anki
import config_reader
import obs
import util
from anki import update_anki_card, get_last_anki_card
from config_reader import *
from ffmpeg import get_audio_and_trim
from util import *
from vosk_helper import process_audio_with_vosk

# Global variable to control script execution
keep_running = True
offset_prompt_triggered = False
restart_flag_file = "restart.flag"

def prompt_for_offset_updates():
    """Call the external offset updater script."""
    global offset_prompt_triggered
    print("Calling offset updater script...\n")
    try:
        # Start offset_updater.py and wait for it to complete
        result = subprocess.run(["python", "offset_updater.py"], check=True)
        if result.returncode == 0:
            offset_prompt_triggered = True
            # Create a flag file to signal that the script should restart
            with open(restart_flag_file, "w") as f:
                f.write("restart")
        else:
            print("Offset update failed.")
    except subprocess.CalledProcessError as e:
        print(f"Error calling offset updater script: {e}")

def handle_restart():
    """Check if a restart is needed and handle it."""
    if os.path.exists(restart_flag_file):
        print("Restarting the script with updated settings...\n")
        os.remove(restart_flag_file)
        subprocess.Popen([sys.executable, os.path.abspath(__file__)])
        sys.exit()  # Exit the current instance

class VideoToAudioHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory or "Replay" not in event.src_path:
            return
        if event.src_path.endswith(".mkv") or event.src_path.endswith(".mp4"):  # Adjust based on your OBS output format
            logger.info(f"MKV {event.src_path} FOUND, RUNNING LOGIC")
            self.convert_to_audio(event.src_path)

    def convert_to_audio(self, video_path):
        with util.lock:
            util.use_previous_audio = True
            last_note = get_last_anki_card()
            logger.debug(json.dumps(last_note))
            tango = last_note['fields'][word_field]['value']

            trimmed_audio = get_audio_and_trim(video_path)

            output_audio = make_unique_file_name(f"{audio_destination}{config_reader.current_game}.{audio_extension}")
            if do_vosk_postprocessing:
                anki.should_update_audio = process_audio_with_vosk(trimmed_audio, output_audio)
            else:
                shutil.copy2(trimmed_audio, output_audio)
            try:
                # Only update sentenceaudio if it's not present. Want to avoid accidentally overwriting sentence audio
                try:
                    if update_anki and (not last_note['fields'][sentence_audio_field]['value'] or override_audio):
                        update_anki_card(last_note, output_audio, video_path, tango)
                except Exception as e:
                    logger.error(f"Card failed to update! Maybe it was removed? {e}")
            except FileNotFoundError as f:
                print(f)
                print("Something went wrong with processing, anki card not updated")
            if remove_video and os.path.exists(video_path):
                os.remove(video_path)  # Optionally remove the video after conversion
            if remove_audio and os.path.exists(output_audio):
                os.remove(output_audio)  # Optionally remove the screenshot after conversion

def initialize():
    if not os.path.exists(folder_to_watch):
        os.mkdir(folder_to_watch)
    if not os.path.exists(screenshot_destination):
        os.mkdir(screenshot_destination)
    if not os.path.exists(audio_destination):
        os.mkdir(audio_destination)
    if not os.path.exists("temp_files"):
        os.mkdir("temp_files")
    else:
        for filename in os.listdir("temp_files"):
            file_path = os.path.join("temp_files", filename)
            if os.path.isfile(file_path) or os.path.islink(file_path):
                os.unlink(file_path)
            elif os.path.isdir(file_path):
                shutil.rmtree(file_path)

def f4_detection_thread():
    """Thread to handle F4 key press detection."""
    global keep_running, offset_prompt_triggered
    time.sleep(2)  # Add a small delay at the start to prevent immediate F4 detection after a restart
    while keep_running:
        if keyboard.is_pressed('f4'):
            print("F4 Key Pressed.")
            prompt_for_offset_updates()
            time.sleep(1)  # Small delay to prevent multiple triggers
        if offset_prompt_triggered:
            time.sleep(5)  # Additional delay to avoid immediate re-trigger of the prompt
            offset_prompt_triggered = False
        time.sleep(0.1)  # Adjust the sleep interval if needed

def main():
    global keep_running
    initialize()
    with tempfile.TemporaryDirectory(dir="temp_files") as temp_dir:
        config_reader.temp_directory = temp_dir
        logger.info("Script started.")
        event_handler = VideoToAudioHandler()
        observer = Observer()
        observer.schedule(event_handler, folder_to_watch, recursive=False)
        observer.start()

        if obs_enabled and obs_start_buffer:
            obs.start_replay_buffer()

        print("Script Initialized. Happy Mining!")
        print("Press F4 to update the audio offsets.")

        # Start the F4 detection thread
        f4_thread = threading.Thread(target=f4_detection_thread, daemon=True)
        f4_thread.start()

        try:
            while keep_running:
                handle_restart()  # Check if a restart is needed
                time.sleep(1)  # Main thread sleeps while F4 thread handles key press detection

        except KeyboardInterrupt:
            keep_running = False
            observer.stop()

        if obs_enabled and obs_start_buffer:
            obs.stop_replay_buffer()
            obs.disconnect_from_obs()
        observer.stop()
        observer.join()

if __name__ == "__main__":
    main()
