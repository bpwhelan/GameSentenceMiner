import json
import re
import shutil
import sys
import tempfile
import time
import keyboard

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

import anki
import config_gui
import ffmpeg
import gametext
import config_reader
import notification
import obs
import offset_updater
import silero_trim
import util
import vosk_helper
import whisper_helper
from config_reader import *
from ffmpeg import get_audio_and_trim
from util import *
from vosk_helper import process_audio_with_vosk


def remove_html_tags(text):
    clean_text = re.sub(r'<.*?>', '', text)
    return clean_text


def get_line_timing(last_note):
    if not last_note:
        return gametext.previous_line_time, 0
    line_time = gametext.previous_line_time
    next_line = 0
    try:
        sentence = last_note['fields'][sentence_field]['value']
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
            last_note = anki.get_last_anki_card()
            line_time, next_line_time = get_line_timing(last_note)
            if last_note:
                logger.debug(json.dumps(last_note))

            if backfill_audio:
                last_note = anki.get_cards_by_sentence(gametext.previous_line)

            tango = last_note['fields'][word_field]['value'] if last_note else ''

            trimmed_audio = get_audio_and_trim(video_path, line_time, next_line_time)

            output_audio = make_unique_file_name(f"{audio_destination}{config_reader.current_game.replace(' ', '')}.{audio_extension}")
            should_update_audio = True
            if do_vosk_postprocessing:
                if do_whisper_instead:
                    should_update_audio = whisper_helper.process_audio_with_whisper(trimmed_audio, output_audio)
                elif do_silero_instead:
                    should_update_audio = silero_trim.process_audio_with_silero(trimmed_audio, output_audio)
                else:
                    should_update_audio = vosk_helper.process_audio_with_vosk(trimmed_audio, output_audio)
            else:
                shutil.copy2(trimmed_audio, output_audio)

            if ffmpeg_reencode_options and os.path.exists(output_audio):
                ffmpeg.reencode_file_with_user_config(output_audio, ffmpeg_reencode_options)
            try:
                # Only update sentenceaudio if it's not present. Want to avoid accidentally overwriting sentence audio
                try:
                    if update_anki and last_note:
                        anki.update_anki_card(last_note, audio_path=output_audio, video_path=video_path, tango=tango,
                                         should_update_audio=should_update_audio)
                    else:
                        notification.send_audio_generated_notification(output_audio)
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
    gametext.start_text_monitor()
    if not os.path.exists(folder_to_watch):
        os.mkdir(folder_to_watch)
    if not os.path.exists(screenshot_destination):
        os.mkdir(screenshot_destination)
    if not os.path.exists(audio_destination):
        os.mkdir(audio_destination)
    if not os.path.exists("temp_files"):
        os.mkdir("temp_files")
    else:
        for filename in os.scandir('temp_files'):
            file_path = os.path.join('temp_files', filename.name)
            if filename.is_file() or filename.is_symlink():
                os.remove(file_path)
            elif filename.is_dir():
                shutil.rmtree(file_path)
    if do_vosk_postprocessing:
        vosk_helper.get_vosk_model()
        if do_whisper_instead:
            whisper_helper.initialize_whisper_model()
    if obs_enabled:
        obs.connect_to_obs()
        if obs_start_buffer:
            obs.start_replay_buffer()
        config_reader.current_game = obs.get_current_scene()
        obs.start_monitoring_anki()


def register_hotkeys():
    print(f"Press {offset_reset_hotkey.upper()} to update the audio offsets.")
    keyboard.add_hotkey(offset_reset_hotkey, offset_updater.prompt_for_offset_updates)
    keyboard.add_hotkey(reset_line_hotkey, gametext.reset_line_hotkey_pressed)
    keyboard.add_hotkey(take_screenshot_hotkey, get_screenshot)


def get_screenshot():
    image = obs.get_screenshot()
    encoded_image = ffmpeg.process_image(image)
    if update_anki and screenshot_hotkey_save_to_anki:
        last_note = anki.get_last_anki_card()
        if last_note:
            logger.debug(json.dumps(last_note))
        if backfill_audio:
            last_note = anki.get_cards_by_sentence(gametext.previous_line)
        if last_note:
            anki.add_image_to_card(last_note, encoded_image)
            notification.send_screenshot_updated(last_note['fields'][word_field]['value'])
            if open_anki_edit:
                notification.open_anki_card(last_note['noteId'])
        else:
            notification.send_screenshot_saved(encoded_image)
    else:
        notification.send_screenshot_saved(encoded_image)


def main():
    logger.info("Script started.")
    initialize()
    with tempfile.TemporaryDirectory(dir="temp_files") as temp_dir:
        config_reader.temp_directory = temp_dir
        event_handler = VideoToAudioHandler()
        observer = Observer()
        observer.schedule(event_handler, folder_to_watch, recursive=False)
        observer.start()

        print("Script Initialized. Happy Mining!")
        register_hotkeys()

        # game_process_id = get_process_id_by_title(config_reader.current_game)
        #
        # game_script = find_script_for_game(config_reader.current_game)
        #
        # agent_thread = threading.Thread(target=run_agent_and_hook,
        #                                 args=(game_process_id, game_script))
        # agent_thread.start()

        print("Enter \"config\" to open the config gui, the script will restart after the gui is closed")
        try:
            while util.keep_running:
                command = input()
                if command == 'config':
                    result = subprocess.run([sys.executable, "config_gui.py"])
                    if result.returncode == 0:
                        print("ATTEMPTING SCRIPT RESTART WITH NEW SETTINGS")
                        print()
                        print('─' * 50)
                        print()
                        observer.stop()
                        observer.join()
                        main()
                    else:
                        print("settings not saved, not restarting script!")

                time.sleep(1)

        except KeyboardInterrupt:
            util.keep_running = False
            observer.stop()

        if obs_enabled:
            if obs_start_buffer:
                obs.stop_replay_buffer()
            obs.disconnect_from_obs()
        observer.stop()
        observer.join()


if __name__ == "__main__":
    main()
