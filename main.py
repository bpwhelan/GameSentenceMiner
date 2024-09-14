import json
import shutil
import tempfile
import time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

import anki
import config_reader
import util
from ffmpeg import get_audio_and_trim
from util import *
from config_reader import *
from vosk_helper import process_audio_with_vosk
from anki import update_anki_card, get_last_anki_card

import obs


class VideoToAudioHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory or "Replay" not in event.src_path:
            return
        if event.src_path.endswith(".mkv") or event.src_path.endswith(".mp4"):  # Adjust based on your OBS output format
            logger.info(f"MKV {event.src_path} FOUND, RUNNING LOGIC")
            self.convert_to_audio(event.src_path)

    def convert_to_audio(self, video_path):
        with util.lock:
            last_note = get_last_anki_card()
            logger.debug(json.dumps(last_note))
            tango = last_note['fields']['Word']['value']

            trimmed_audio = get_audio_and_trim(video_path)

            output_audio = make_unique_file_name(f"{audio_destination}{current_game}.{audio_extension}")
            if do_vosk_postprocessing:
                anki.should_update_audio = process_audio_with_vosk(trimmed_audio, output_audio)
            else:
                shutil.copy2(trimmed_audio, output_audio)
            try:
                # Only update sentenceaudio if it's not present. Want to avoid accidentally overwriting sentence audio
                if update_anki and (not last_note['fields'][sentence_audio_field]['value'] or override_audio):
                    update_anki_card(last_note, output_audio, video_path, tango)
            except FileNotFoundError as f:
                print(f)
                print("Something went wrong with processing, anki card not updated")
            if remove_video:
                os.remove(video_path)  # Optionally remove the video after conversion


keep_running=True
def main():
    with tempfile.TemporaryDirectory(dir="./") as temp_dir:
        config_reader.temp_directory = temp_dir
        logger.info("Script started.")
        event_handler = VideoToAudioHandler()
        observer = Observer()
        observer.schedule(event_handler, folder_to_watch, recursive=False)
        observer.start()

        if obs_enabled and obs_start_buffer:
            obs.start_replay_buffer()

        print("Script Initalized. Happy Mining!")

        try:
            while keep_running:
                time.sleep(1)
        except KeyboardInterrupt:
            observer.stop()

        if obs_enabled and obs_start_buffer:
            obs.stop_replay_buffer()
            obs.disconnect_from_obs()
        observer.stop()
        observer.join()


if __name__ == "__main__":
    main()
