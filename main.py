import re
import shutil
import subprocess
import sys
import tempfile
import time
import keyboard
import psutil
from psutil import NoSuchProcess

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

import anki
import ffmpeg
import gametext
import configuration
import notification
import obs
import silero_trim
import util
import vosk_helper
import whisper_helper
from ffmpeg import get_audio_and_trim
from util import *
from configuration import *

config_pids = []


def remove_html_tags(text):
    clean_text = re.sub(r'<.*?>', '', text)
    return clean_text


def get_line_timing(last_note):
    if not last_note:
        return gametext.previous_line_time, 0
    line_time = gametext.previous_line_time
    next_line = 0
    try:
        sentence = last_note['fields'][get_config().anki.sentence_field]['value']
        if sentence:
            for i, (line, clip_time) in enumerate(reversed(gametext.line_history.items())):
                if remove_html_tags(sentence) in line:
                    line_time = clip_time
                    # next_time = list(clipboard.clipboard_history.values())[-i]
                    # if next_time > clipboard_time:
                    #     next_clipboard = next_time
                    break
    except Exception as e:
        logger.error(f"Using Default clipboard/websocket timing - reason: {e}")

    return line_time, next_line


class VideoToAudioHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory or "Replay" not in event.src_path:
            return
        if event.src_path.endswith(".mkv") or event.src_path.endswith(".mp4"):  # Adjust based on your OBS output format
            logger.info(f"MKV {event.src_path} FOUND, RUNNING LOGIC")
            self.convert_to_audio(event.src_path)

    @staticmethod
    def convert_to_audio(video_path):
        with util.lock:
            util.use_previous_audio = True
            last_note = None
            if get_config().anki.update_anki:
                last_note = anki.get_last_anki_card()
            line_time, next_line_time = get_line_timing(last_note)
            if last_note:
                logger.debug(json.dumps(last_note))

            if get_config().features.backfill_audio:
                last_note = anki.get_cards_by_sentence(gametext.previous_line)

            tango = last_note['fields'][get_config().anki.word_field]['value'] if last_note else ''

            trimmed_audio = get_audio_and_trim(video_path, line_time, next_line_time)

            vad_trimmed_audio = make_unique_file_name(f"{os.path.abspath(configuration.temp_directory)}/{configuration.current_game.replace(' ', '')}.{get_config().audio.extension}")
            final_audio_output = make_unique_file_name(
                f"{get_config().paths.audio_destination}{configuration.current_game.replace(' ', '')}.{get_config().audio.extension}")
            should_update_audio = True
            if get_config().vad.do_vad_postprocessing:
                match get_config().vad.selected_vad_model:
                    case configuration.SILERO:
                        should_update_audio = silero_trim.process_audio_with_silero(trimmed_audio, vad_trimmed_audio)
                    case configuration.VOSK:
                        should_update_audio = vosk_helper.process_audio_with_vosk(trimmed_audio, vad_trimmed_audio)
                    case configuration.WHISPER:
                        should_update_audio = whisper_helper.process_audio_with_whisper(trimmed_audio, vad_trimmed_audio)
                if not should_update_audio:
                    match get_config().vad.backup_vad_model:
                        case configuration.OFF:
                            pass
                        case configuration.SILERO:
                            should_update_audio = silero_trim.process_audio_with_silero(trimmed_audio, vad_trimmed_audio)
                        case configuration.VOSK:
                            should_update_audio = vosk_helper.process_audio_with_vosk(trimmed_audio, vad_trimmed_audio)
                        case configuration.WHISPER:
                            should_update_audio = whisper_helper.process_audio_with_whisper(trimmed_audio, vad_trimmed_audio)

            if get_config().audio.ffmpeg_reencode_options and os.path.exists(vad_trimmed_audio):
                ffmpeg.reencode_file_with_user_config(vad_trimmed_audio, final_audio_output, get_config().audio.ffmpeg_reencode_options)
            else:
                os.replace(vad_trimmed_audio, final_audio_output)
            try:
                # Only update sentenceaudio if it's not present. Want to avoid accidentally overwriting sentence audio
                try:
                    if get_config().anki.update_anki and last_note:
                        anki.update_anki_card(last_note, audio_path=vad_trimmed_audio, video_path=video_path, tango=tango,
                                         should_update_audio=should_update_audio)
                    elif get_config().features.notify_on_update and should_update_audio:
                        notification.send_audio_generated_notification(vad_trimmed_audio)
                except Exception as e:
                    logger.error(f"Card failed to update! Maybe it was removed? {e}")
            except FileNotFoundError as f:
                print(f)
                print("Something went wrong with processing, anki card not updated")

            if get_config().paths.remove_video and os.path.exists(video_path):
                os.remove(video_path)  # Optionally remove the video after conversion
            if get_config().paths.remove_audio and os.path.exists(vad_trimmed_audio):
                os.remove(vad_trimmed_audio)  # Optionally remove the screenshot after conversion


def initialize(reloading=False):
    if not reloading:
        if get_config().general.open_config_on_startup:
            proc = subprocess.Popen([sys.executable, "config_gui.py"])
            config_pids.append(proc.pid)
        gametext.start_text_monitor()
        if not os.path.exists(get_config().paths.folder_to_watch):
            os.mkdir(get_config().paths.folder_to_watch)
        if not os.path.exists(get_config().paths.screenshot_destination):
            os.mkdir(get_config().paths.screenshot_destination)
        if not os.path.exists(get_config().paths.audio_destination):
            os.mkdir(get_config().paths.audio_destination)
        if not os.path.exists("temp_files"):
            os.mkdir("temp_files")
        else:
            for filename in os.scandir('temp_files'):
                file_path = os.path.join('temp_files', filename.name)
                if filename.is_file() or filename.is_symlink():
                    os.remove(file_path)
                elif filename.is_dir():
                    shutil.rmtree(file_path)
    if get_config().vad.do_vad_postprocessing:
        if VOSK in (get_config().vad.backup_vad_model, get_config().vad.selected_vad_model):
            vosk_helper.get_vosk_model()
        if WHISPER in (get_config().vad.backup_vad_model, get_config().vad.selected_vad_model):
            whisper_helper.initialize_whisper_model()
    if not reloading:
        if get_config().obs.enabled:
            obs.connect_to_obs()
            if get_config().obs.start_buffer:
                obs.start_replay_buffer()
            configuration.current_game = obs.get_current_scene()
            obs.start_monitoring_anki()
        watch_for_config_changes()


def register_hotkeys():
    keyboard.add_hotkey(get_config().hotkeys.reset_line, gametext.reset_line_hotkey_pressed)
    keyboard.add_hotkey(get_config().hotkeys.take_screenshot, get_screenshot)


def get_screenshot():
    image = obs.get_screenshot()
    encoded_image = ffmpeg.process_image(image)
    if get_config().anki.update_anki:
        last_note = anki.get_last_anki_card()
        if last_note:
            logger.debug(json.dumps(last_note))
        if get_config().features.backfill_audio:
            last_note = anki.get_cards_by_sentence(gametext.previous_line)
        if last_note:
            anki.add_image_to_card(last_note, encoded_image)
            notification.send_screenshot_updated(last_note['fields'][get_config().anki.word_field]['value'])
            if get_config().features.open_anki_edit:
                notification.open_anki_card(last_note['noteId'])
        else:
            notification.send_screenshot_saved(encoded_image)
    else:
        notification.send_screenshot_saved(encoded_image)


def check_for_config_input():
    command = input()
    if command == 'config':
        logger.info(
            'opening config, most settings are live, so once the config is saved, the script will attempt to reload the config')
        proc = subprocess.Popen([sys.executable, "config_gui.py"])
        config_pids.append(proc.pid)
    time.sleep(1)

def start_thread(task):
    input_thread = threading.Thread(target=task)
    input_thread.start()

def main(reloading=False):
    logger.info("Script started.")
    initialize(reloading)
    with tempfile.TemporaryDirectory(dir="temp_files") as temp_dir:
        configuration.temp_directory = temp_dir
        event_handler = VideoToAudioHandler()
        observer = Observer()
        observer.schedule(event_handler, get_config().paths.folder_to_watch, recursive=False)
        observer.start()

        logger.info("Script Initialized. Happy Mining!")
        if not is_linux():
            register_hotkeys()

        start_thread(check_for_config_input)

        logger.info("Enter \"config\" to open the config gui")
        try:
            while util.keep_running and not util.shutdown_event.is_set():
                time.sleep(1)

        except KeyboardInterrupt:
            util.keep_running = False
            observer.stop()

        if get_config().obs.enabled:
            if get_config().obs.start_buffer:
                obs.stop_replay_buffer()
            obs.disconnect_from_obs()
        observer.stop()
        observer.join()
        for pid in config_pids:
            try:
                p = psutil.Process(pid)
                p.terminate()  # or p.kill()
            except NoSuchProcess:
                print("Config already Closed")


if __name__ == "__main__":
    main()
