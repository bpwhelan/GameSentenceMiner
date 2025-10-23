# There should be no imports here, as any error will crash the program.
# All imports should be done in the try/except block below.
def handle_error_in_initialization(e):
    """Handle errors that occur during initialization."""
    logger.exception(e, exc_info=True)
    logger.info(
        "An error occurred during initialization, Maybe try updating GSM from the menu or if running manually, try installing `pip install --update GameSentenceMiner`")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("Exiting due to initialization error.")
        sys.exit(1)


try:
    import asyncio
    import os
    import shutil
    import subprocess
    import sys
    import tempfile
    import threading
    import time
    import warnings
    import requests
    import os.path
    import signal
    import datetime
    from subprocess import Popen
    os.environ.pop('TCL_LIBRARY', None)

    import keyboard
    import ttkbootstrap as ttk
    from PIL import Image
    from pystray import Icon, Menu, MenuItem
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer
    import psutil

    start_time = time.time()
    import GameSentenceMiner.util.configuration
    from GameSentenceMiner.util.configuration import logger, gsm_state, get_config, anki_results, AnkiUpdateResult, \
    get_temporary_directory, get_log_path, get_master_config, switch_profile_and_save, get_app_directory, gsm_status, \
    is_windows, is_linux, get_ffmpeg_path

    logger.debug(f"[Import] configuration: {time.time() - start_time:.3f}s")
    
    start_time = time.time()
    from GameSentenceMiner.util.get_overlay_coords import init_overlay_processor
    from GameSentenceMiner.util.gsm_utils import remove_html_and_cloze_tags, add_srt_line
    logger.debug(f"[Import] get_overlay_coords (OverlayThread, remove_html_and_cloze_tags): {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.util.model import VADResult
    logger.debug(f"[Import] VADResult model: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.vad import vad_processor
    logger.debug(f"[Import] vad_processor: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.util.downloader.download_tools import download_obs_if_needed, download_ffmpeg_if_needed, write_obs_configs, download_oneocr_dlls_if_needed
    logger.debug(
        f"[Import] download_tools (download_obs_if_needed, download_ffmpeg_if_needed): {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.util.communication.send import send_restart_signal
    logger.debug(
        f"[Import] send_restart_signal: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.util.gsm_utils import wait_for_stable_file, make_unique_file_name, run_new_thread
    logger.debug(
        f"[Import] gsm_utils (wait_for_stable_file, make_unique_file_name, run_new_thread): {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner import anki
    logger.debug(f"[Import] anki: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.ui import config_gui
    logger.debug(f"[Import] config_gui: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.util import configuration, notification, ffmpeg
    logger.debug(
        f"[Import] util (configuration, notification, ffmpeg): {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner import gametext
    logger.debug(f"[Import] gametext: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner import obs
    logger.debug(f"[Import] obs: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.util.communication import Message
    logger.debug(f"[Import] Message: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.util.communication.websocket import connect_websocket, register_websocket_message_handler, FunctionName
    logger.debug(
        f"[Import] websocket (connect_websocket, register_websocket_message_handler, FunctionName): {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.util.ffmpeg import get_audio_and_trim, get_video_timings
    logger.debug(
        f"[Import] util.ffmpeg (get_audio_and_trim, get_video_timings, get_ffmpeg_path): {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.obs import check_obs_folder_is_correct
    logger.debug(
        f"[Import] obs.check_obs_folder_is_correct: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.util.text_log import GameLine, get_text_event, get_mined_line, get_all_lines, game_log
    logger.debug(
        f"[Import] util.text_log (GameLine, get_text_event, get_mined_line, get_all_lines, game_log): {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.web import texthooking_page
    logger.debug(
        f"[Import] web.texthooking_page: {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.web.service import handle_texthooker_button, set_get_audio_from_video_callback
    logger.debug(
        f"[Import] web.service (handle_texthooker_button, set_get_audio_from_video_callback): {time.time() - start_time:.3f}s")

    start_time = time.time()
    from GameSentenceMiner.web.texthooking_page import run_text_hooker_page
    logger.debug(
        f"[Import] web.texthooking_page.run_text_hooker_page: {time.time() - start_time:.3f}s")
except Exception as e:
    from GameSentenceMiner.util.configuration import logger, is_linux, is_windows
    handle_error_in_initialization(e)

if is_windows():
    import win32api

procs_to_close = []
settings_window: config_gui.ConfigApp = None
obs_paused = False
root = None
warnings.simplefilter("ignore", DeprecationWarning)


class VideoToAudioHandler(FileSystemEventHandler):
    def __init__(self):
        super().__init__()

    def on_created(self, event):
        file_name = os.path.basename(event.src_path)
        if event.is_directory or ("Replay" not in file_name and "GSM" not in file_name):
            # This shows up as soon as recording starts, so it's kinda hard to use...
            # if get_config().features.generate_longplay and event.src_path.endswith(".mkv") or event.src_path.endswith(".mp4"):
            #     add_srt_line(datetime.datetime.now(), get_all_lines()[-1])
            #     logger.info(f"Recording {event.src_path} FOUND, RUNNING LOGIC")
            #     wait_for_stable_file(event.src_path)
            #     current_srt = gsm_state.current_srt
            #     srt_name = os.path.splitext(os.path.basename(event.src_path))[0] + ".srt"
            #     srt_path = os.path.join(os.path.dirname(event.src_path), srt_name)
            #     shutil.move(current_srt, srt_path)
            #     gsm_state.current_srt = None
            #     # self.process_replay(event.src_path)
            return
        # Adjust based on your OBS output format
        if file_name.endswith(".mkv") or file_name.endswith(".mp4"):
            logger.info(f"MKV {event.src_path} FOUND, RUNNING LOGIC")
            wait_for_stable_file(event.src_path)
            self.process_replay(event.src_path)

    def process_replay(self, video_path):
        gsm_state.current_replay = video_path
        vad_trimmed_audio = ''
        final_audio_output = ''
        skip_delete = False
        selected_lines = []
        anki_card_creation_time = None
        mined_line = None
        start_time = 0
        end_time = 0
        if gsm_state.line_for_audio or gsm_state.line_for_screenshot:
            handle_texthooker_button(video_path)
            return
        try:
            if anki.card_queue and len(anki.card_queue) > 0:
                last_note, anki_card_creation_time, selected_lines, mined_line = anki.card_queue.pop(
                    0)
            else:
                logger.info(
                    "Replay buffer initiated externally. Skipping processing.")
                skip_delete = True
                return

            # Just for safety
            if not last_note:
                if get_config().anki.update_anki:
                    last_note = anki.get_last_anki_card()

            note, last_note = anki.get_initial_card_info(
                last_note, selected_lines)
            tango = last_note.get_field(
                get_config().anki.word_field) if last_note else ''

            # Get Info of line mined
            line_cutoff = None
            start_line = None
            full_text = ''
            if selected_lines:
                start_line = selected_lines[0]
                # mined_line = get_mined_line(last_note, selected_lines)
                line_cutoff = selected_lines[-1].get_next_time()
                full_text = remove_html_and_cloze_tags(note['fields'][get_config().anki.sentence_field])
            else:
                # mined_line = get_text_event(last_note)
                if mined_line:
                    start_line = mined_line
                    if mined_line.next:
                        line_cutoff = mined_line.next.time
                    full_text = mined_line.text

            gsm_state.last_mined_line = mined_line

            if os.path.exists(video_path) and os.access(video_path, os.R_OK):
                logger.debug(f"Video found and is readable: {video_path}")
            if get_config().obs.minimum_replay_size and not ffmpeg.is_video_big_enough(video_path,
                                                                                       get_config().obs.minimum_replay_size):
                logger.debug("Checking if video is big enough")
                notification.send_check_obs_notification(
                    reason="Video may be empty, check scene in OBS.")
                logger.error(
                    f"Video was unusually small, potentially empty! Check OBS for Correct Scene Settings! Path: {video_path}")
                return

            if last_note:
                logger.debug(last_note.to_json())

            if get_config().anki.sentence_audio_field and get_config().audio.enabled:
                logger.debug("Attempting to get audio from video")
                final_audio_output, vad_result, vad_trimmed_audio, start_time, end_time = VideoToAudioHandler.get_audio(
                    start_line,
                    line_cutoff,
                    video_path,
                    anki_card_creation_time,
                    mined_line=mined_line,
                    full_text=full_text)
            else:
                final_audio_output = ""
                vad_result = VADResult(True, 0, 0, '')
                vad_trimmed_audio = ""
                if not get_config().audio.enabled:
                    logger.info(
                        "Audio is disabled in config, skipping audio processing!")
                elif not get_config().anki.sentence_audio_field:
                    logger.info(
                        "No SentenceAudio Field in config, skipping audio processing!")

            ss_timing = ffmpeg.get_screenshot_time(video_path, mined_line, vad_result=vad_result, doing_multi_line=bool(
                selected_lines), anki_card_creation_time=anki_card_creation_time)
            # prev_ss_timing = 0
            # if get_config().anki.previous_image_field and get_config().vad.do_vad_postprocessing:
            #     prev_ss_timing = ffmpeg.get_screenshot_time(video_path, mined_line.prev,
            #                                                 vad_result=VideoToAudioHandler.get_audio(game_line=mined_line.prev,
            #                                                  next_line_time=mined_line.time,
            #                                                  video_path=video_path,
            #                                                  anki_card_creation_time=anki_card_creation_time,
            #                                                  timing_only=True) ,doing_multi_line=bool(selected_lines), previous_line=True)

            if get_config().anki.update_anki and last_note:
                anki.update_anki_card(
                    last_note, note, audio_path=final_audio_output, video_path=video_path,
                    tango=tango,
                    should_update_audio=vad_result.output_audio,
                    ss_time=ss_timing,
                    game_line=mined_line,
                    selected_lines=selected_lines,
                    start_time=start_time,
                    end_time=end_time,
                    vad_result=vad_result
                )
            elif get_config().features.notify_on_update and vad_result.success:
                notification.send_audio_generated_notification(
                    vad_trimmed_audio)
        except Exception as e:
            if mined_line:
                anki_results[mined_line.id] = AnkiUpdateResult.failure()
            logger.error(
                f"Failed Processing and/or adding to Anki: Reason {e}", exc_info=True)
            logger.debug(
                f"Some error was hit catching to allow further work to be done: {e}", exc_info=True)
            notification.send_error_no_anki_update()
        if get_config().paths.remove_video and video_path and not skip_delete:
            try:
                if os.path.exists(video_path):
                    logger.debug(f"Removing video: {video_path}")
                    os.remove(video_path)
            except Exception as e:
                logger.error(
                    f"Error removing video file {video_path}: {e}", exc_info=True)

    @staticmethod
    def get_audio(game_line, next_line_time, video_path, anki_card_creation_time=None, temporary=False, timing_only=False, mined_line=None, full_text=''):
        trimmed_audio, start_time, end_time = get_audio_and_trim(
            video_path, game_line, next_line_time, anki_card_creation_time)
        if temporary:
            return ffmpeg.convert_audio_to_wav_lossless(trimmed_audio)
        if not get_config().vad.do_vad_postprocessing:
            return trimmed_audio, VADResult(True, start_time, end_time, "No VAD"), trimmed_audio, start_time, end_time
        vad_trimmed_audio = make_unique_file_name(
            f"{os.path.abspath(configuration.get_temporary_directory())}/{obs.get_current_game(sanitize=True)}.{get_config().audio.extension}")
        final_audio_output = make_unique_file_name(os.path.join(get_temporary_directory(),
                                                                f"{obs.get_current_game(sanitize=True)}.{get_config().audio.extension}"))

        vad_result = vad_processor.trim_audio_with_vad(
            trimmed_audio, vad_trimmed_audio, game_line, full_text)
        if timing_only:
            return vad_result

        if not vad_result.success:
            if get_config().vad.add_audio_on_no_results:
                logger.info("No voice activity detected, using full audio.")
                vad_result.output_audio = trimmed_audio
            elif get_config().vad.use_tts_as_fallback:
                try:
                    logger.info(
                        "No voice activity detected, using TTS as fallback.")
                    text_to_tts = full_text if full_text else game_line.text
                    url = get_config().vad.tts_url.replace("$s", text_to_tts)
                    tts_resp = requests.get(url)
                    if not tts_resp.ok:
                        logger.error(
                            f"Error fetching TTS audio from {url}. Is it running?: {tts_resp.status_code} {tts_resp.text}")
                    with tempfile.NamedTemporaryFile(dir=get_temporary_directory(), delete=False, suffix=".opus") as tmpfile:
                        tmpfile.write(tts_resp.content)
                        vad_result.output_audio = tmpfile.name
                except Exception as e:
                    logger.error(f"Error getting TTS audio: {e}, skipping audio.")
        else:
            logger.info(vad_result.trim_successful_string())
        if vad_result.output_audio:
            vad_trimmed_audio = vad_result.output_audio
        if get_config().audio.ffmpeg_reencode_options_to_use and os.path.exists(vad_trimmed_audio):
            ffmpeg.reencode_file_with_user_config(vad_trimmed_audio, final_audio_output,
                                                  get_config().audio.ffmpeg_reencode_options_to_use)
        elif os.path.exists(vad_trimmed_audio):
            shutil.move(vad_trimmed_audio, final_audio_output)
        return final_audio_output, vad_result, vad_trimmed_audio, start_time, end_time


def initial_checks():
    try:
        subprocess.run(GameSentenceMiner.util.configuration.ffmpeg_base_command_list)
        logger.debug("FFMPEG is installed and accessible.")
        
    except FileNotFoundError:
        logger.error(
            "FFmpeg not found, please install it and add it to your PATH.")
        raise


def register_hotkeys():
    if get_config().hotkeys.reset_line:
        keyboard.add_hotkey(get_config().hotkeys.reset_line,
                            gametext.reset_line_hotkey_pressed)
    if get_config().hotkeys.take_screenshot:
        keyboard.add_hotkey(
            get_config().hotkeys.take_screenshot, get_screenshot)
    if get_config().hotkeys.play_latest_audio:
        keyboard.add_hotkey(
            get_config().hotkeys.play_latest_audio, play_most_recent_audio)


def get_screenshot():
    last_note = anki.get_last_anki_card()
    gsm_state.anki_note_for_screenshot = last_note
    gsm_state.line_for_screenshot = get_mined_line(last_note, get_all_lines())
    obs.save_replay_buffer()


def create_image():
    image_path = os.path.join(os.path.dirname(
        __file__), "assets", "pickaxe.png")
    return Image.open(image_path)


def open_settings():
    obs.update_current_game()
    settings_window.show()


def play_most_recent_audio():
    if get_config().advanced.audio_player_path or get_config().advanced.video_player_path and len(
            get_all_lines()) > 0:
        gsm_state.line_for_audio = get_all_lines()[-1]
        obs.save_replay_buffer()
    else:
        logger.error(
            "Feature Disabled. No audio or video player path set in config!")


def open_log():
    """Function to handle opening log."""
    """Open log file with the default application."""
    log_file_path = get_log_path()
    if not os.path.exists(log_file_path):
        logger.error("Log file not found!")
        return

    if sys.platform.startswith("win"):  # Windows
        os.startfile(log_file_path)
    elif sys.platform.startswith("darwin"):  # macOS
        subprocess.call(["open", log_file_path])
    elif sys.platform.startswith("linux"):  # Linux
        subprocess.call(["xdg-open", log_file_path])
    else:
        logger.error("Unsupported platform!")
    logger.info("Log opened.")


def open_multimine(icon, item):
    texthooking_page.open_texthooker()


def exit_program(passed_icon, item):
    """Exit the application."""
    if not passed_icon:
        passed_icon = icon
    logger.info("Exiting...")
    passed_icon.stop()
    cleanup()


class GSMTray(threading.Thread):
    def __init__(self):
        super().__init__()
        self.daemon = True
        self.menu = None
        self.icon = None

    def run(self):
        self.run_tray()

    def run_tray(self):
        def run_anki_confirmation_window():
            settings_window.show_anki_confirmation_dialog(expression="こんにちは",
                sentence="こんにちは、世界！元気ですか？",
                screenshot_path="test_image.png",
                audio_path="C:/path/to/my/audio.mp3",
                translation="Hello world! How are you?")

        self.profile_menu = Menu(
            *[MenuItem(("Active: " if profile == get_master_config().current_profile else "") + profile, self.switch_profile) for
              profile in
              get_master_config().get_all_profile_names()]
        )

        menu = Menu(
            MenuItem("Open Settings", open_settings, default=True),
            MenuItem("Open Texthooker", texthooking_page.open_texthooker),
            MenuItem("Open Log", open_log),
            MenuItem("Toggle Replay Buffer", self.play_pause),
            MenuItem("Restart OBS", restart_obs),
            MenuItem("Switch Profile", self.profile_menu),
            MenuItem("Run Test Code", run_anki_confirmation_window),
            MenuItem("Exit", exit_program)
        )
        
        self.icon = Icon("TrayApp", create_image(), "GameSentenceMiner", menu)
        self.icon.run()

    def update_icon(self, profile=None):
        global menu, icon
        # Recreate the menu with the updated button text
        profile_menu = Menu(
            *[MenuItem(("Active: " if profile == get_master_config().current_profile else "") + profile, self.switch_profile) for
              profile in
              get_master_config().get_all_profile_names()]
        )

        menu = Menu(
            MenuItem("Open Settings", open_settings, default=True),
            MenuItem("Open Multi-Mine GUI", open_multimine),
            MenuItem("Open Log", open_log),
            MenuItem("Toggle Replay Buffer", self.play_pause),
            MenuItem("Restart OBS", restart_obs),
            MenuItem("Switch Profile", profile_menu),
            MenuItem("Exit", exit_program)
        )

        self.icon.menu = menu
        self.icon.update_menu()

    def switch_profile(self, icon, item):
        if "Active:" in item.text:
            logger.error("You cannot switch to the currently active profile!")
            return
        logger.info(f"Switching to profile: {item.text}")
        prev_config = get_config()
        get_master_config().current_profile = item.text
        switch_profile_and_save(item.text)
        settings_window.reload_settings()
        self.update_icon()
        if get_config().restart_required(prev_config):
            send_restart_signal()

    def play_pause(self, icon, item):
        global obs_paused, menu
        obs.toggle_replay_buffer()
        self.update_icon()

    def stop(self):
        if self.icon:
            self.icon.stop()


gsm_tray = GSMTray()


# def close_obs():
#     if obs_process:
#         logger.info("Closing OBS")
#         proc = None
#         if obs_process:
#             try:
#                 logger.info("Closing OBS")
#                 proc = psutil.Process(obs_process)
#                 proc.send_signal(signal.CTRL_BREAK_EVENT)
#                 proc.wait(timeout=5)
#                 logger.info("Process closed gracefully.")
#             except psutil.NoSuchProcess:
#                 logger.info("PID already closed.")
#             except psutil.TimeoutExpired:
#                 logger.info("Process did not close gracefully, terminating.")
#                 proc.terminate()
#                 proc.wait()

def close_obs():
    obs.disconnect_from_obs()
    if obs.obs_process_pid:
        try:
            subprocess.run(["taskkill", "/PID", str(obs.obs_process_pid),
                           "/F"], check=True, capture_output=True, text=True)
            print(f"OBS (PID {obs.obs_process_pid}) has been terminated.")
            if os.path.exists(obs.OBS_PID_FILE):
                os.remove(obs.OBS_PID_FILE)
        except subprocess.CalledProcessError as e:
            print(f"Error terminating OBS: {e.stderr}")
    else:
        print("OBS is not running.")


def restart_obs():
    if obs.obs_process_pid:
        close_obs()
        time.sleep(1)
        obs.start_obs()


def cleanup():
    try:
        if gsm_state.current_srt and len(get_all_lines()) > 0:
            add_srt_line(datetime.datetime.now(), get_all_lines()[-1])
        logger.info("Performing cleanup...")
        gsm_state.keep_running = False

        if obs.obs_connection_manager and obs.obs_connection_manager.is_alive():
            obs.obs_connection_manager.stop()
        obs.stop_replay_buffer()
        obs.disconnect_from_obs()
        if get_config().obs.close_obs:
            close_obs()

        if texthooking_page.websocket_server_threads:
            for thread in texthooking_page.websocket_server_threads:
                if thread and isinstance(thread, threading.Thread) and thread.is_alive():
                    thread.stop_server()
                    thread.join()

        proc: Popen
        for proc in procs_to_close:
            try:
                logger.info(f"Terminating process {proc.args[0]}")
                proc.terminate()
                proc.wait()
                logger.info(f"Process {proc.args[0]} terminated.")
            except psutil.NoSuchProcess:
                logger.info("PID already closed.")
            except Exception as e:
                proc.kill()
                logger.error(f"Error terminating process {proc}: {e}")

        if gsm_tray:
            gsm_tray.stop()

        for video in gsm_state.videos_to_remove:
            try:
                if os.path.exists(video):
                    os.remove(video)
            except Exception as e:
                logger.error(
                    f"Error removing temporary video file {video}: {e}")

        settings_window.window.destroy()
        # time.sleep(5)
        logger.info("Cleanup complete.")
    except Exception as e:
        logger.error(f"Error during cleanup: {e}", exc_info=True)
        sys.exit(1)


def handle_exit():
    """Signal handler for graceful termination."""

    def _handle_exit(signum, *args):
        logger.info(f"Received signal {signum}. Exiting gracefully...")
        cleanup()
        sys.exit(0)

    return _handle_exit


def initialize(reloading=False):
    global obs_process
    if not reloading:
        get_temporary_directory(delete=True)
        if is_windows():
            download_obs_if_needed()
            download_ffmpeg_if_needed()
            download_oneocr_dlls_if_needed()
            write_obs_configs(obs.get_base_obs_dir())
            if shutil.which("ffmpeg") is None:
                os.environ["PATH"] += os.pathsep + \
                    os.path.dirname(get_ffmpeg_path())
        if get_config().obs.open_obs:
            obs_process = obs.start_obs()
            # obs.connect_to_obs(start_replay=True)
            # anki.start_monitoring_anki()
        # gametext.start_text_monitor()
        os.makedirs(get_config().paths.folder_to_watch, exist_ok=True)
        os.makedirs(get_config().paths.output_folder, exist_ok=True)
        set_get_audio_from_video_callback(VideoToAudioHandler.get_audio)
    initial_checks()
    register_websocket_message_handler(handle_websocket_message)
    # if get_config().vad.do_vad_postprocessing:
    #     if VOSK in (get_config().vad.backup_vad_model, get_config().vad.selected_vad_model):
    #         vosk_helper.get_vosk_model()
    #     if WHISPER in (get_config().vad.backup_vad_model, get_config().vad.selected_vad_model):
    #         whisper_helper.initialize_whisper_model()


def initialize_async():
    tasks = [connect_websocket]
    threads = []
    tasks.append(anki.start_monitoring_anki)
    for task in tasks:
        threads.append(run_new_thread(task))
    return threads


def handle_websocket_message(message: Message):
    logger.info(f"WebSocket Message Received: {message.to_json()}")
    try:
        match FunctionName(message.function):
            case FunctionName.QUIT:
                cleanup()
                sys.exit(0)
            case FunctionName.QUIT_OBS:
                close_obs()
            case FunctionName.START_OBS:
                obs.start_obs(force_restart=not gsm_status.obs_connected)
            case FunctionName.OPEN_SETTINGS:
                open_settings()
            case FunctionName.OPEN_TEXTHOOKER:
                texthooking_page.open_texthooker()
            case FunctionName.OPEN_LOG:
                open_log()
            case FunctionName.TOGGLE_REPLAY_BUFFER:
                obs.toggle_replay_buffer()
            case FunctionName.RESTART_OBS:
                restart_obs()
            case FunctionName.EXIT:
                cleanup()
                sys.exit(0)
            case FunctionName.CONNECT:
                logger.debug("Electron WSS connected")
            case _:
                logger.debug(
                    f"unknown message from electron websocket: {message.to_json()}")
    except Exception as e:
        logger.debug(f"Error handling websocket message: {e}")


def initialize_text_monitor():
    asyncio.run(gametext.start_text_monitor())


def async_loop():
    async def loop():
        logger.info("Post-Initialization started.")
        await obs.connect_to_obs(connections=3, check_output=True)
        await register_scene_switcher_callback()
        await check_obs_folder_is_correct()
        vad_processor.init()
        await init_overlay_processor()

        # Keep loop alive
        # if is_beangate:
        # await run_test_code()

    asyncio.run(loop())


async def register_scene_switcher_callback():
    def scene_switcher_callback(scene):
        logger.info(f"Scene changed to: {scene}")
        gsm_state.current_game = obs.get_current_game()
        all_configured_scenes = [
            config.scenes for config in get_master_config().configs.values()]
        print(all_configured_scenes)
        matching_configs = [name.strip() for name, config in get_master_config().configs.items(
        ) if scene.strip() in config.scenes]
        switch_to = None

        if len(matching_configs) > 1:
            selected_scene = settings_window.show_scene_selection(
                matched_configs=matching_configs)
            if selected_scene:
                switch_to = selected_scene
            else:
                return
        elif matching_configs:
            switch_to = matching_configs[0]
        elif get_master_config().switch_to_default_if_not_found:
            switch_to = configuration.DEFAULT_CONFIG

        if switch_to and switch_to != get_master_config().current_profile:
            logger.info(f"Switching to profile: {switch_to}")
            get_master_config().current_profile = switch_to
            switch_profile_and_save(switch_to)
            settings_window.reload_settings()
            gsm_tray.update_icon()

    await obs.register_scene_change_callback(scene_switcher_callback)


async def run_test_code():
    if get_config().overlay.websocket_port:
        boxes = await gametext.find_box_for_sentence("ちぇっ少しなの？")
        if boxes:
            await texthooking_page.send_word_coordinates_to_overlay(boxes)
        await asyncio.sleep(2)


async def check_if_script_is_running():
    """Check if the script is already running and kill it if so."""
    if os.path.exists(os.path.join(get_app_directory(), "current_pid.txt")):
        with open(os.path.join(get_app_directory(), "current_pid.txt"), "r") as f:
            pid = int(f.read().strip())
            if psutil.pid_exists(pid) and 'python' in psutil.Process(pid).name().lower():
                logger.info(f"Script is already running with PID: {pid}")
                # Attempt to terminate the existing process
                psutil.Process(pid).terminate()
                logger.info("Sent SIGTERM to the existing process.")
                notification.send_error_notification(
                    "Script was already running. Terminating the existing process.")
                return True
    return False


async def log_current_pid():
    """Log the current process ID."""
    current_pid = os.getpid()
    logger.info(f"Current process ID: {current_pid}")
    with open(os.path.join(get_app_directory(), "current_pid.txt"), "w") as f:
        f.write(str(current_pid))


async def async_main(reloading=False):
    try:
        global root, settings_window
        initialize(reloading)
        root = ttk.Window(themename='darkly')
        start_time = time.time()
        settings_window = config_gui.ConfigApp(root)
        gsm_state.config_app = settings_window
        initialize_async()
        observer = Observer()
        observer.schedule(VideoToAudioHandler(),
                          get_config().paths.folder_to_watch, recursive=False)
        observer.start()
        if is_windows():
            register_hotkeys()

        run_new_thread(initialize_text_monitor)
        run_new_thread(run_text_hooker_page)
        run_new_thread(async_loop).join()

        logger.info("Initialization complete. Happy Mining! がんばれ！")

        # await check_if_script_is_running()
        # await log_current_pid()

        # Register signal handlers for graceful shutdown
        signal.signal(signal.SIGTERM, handle_exit())  # Handle `kill` commands
        signal.signal(signal.SIGINT, handle_exit())  # Handle Ctrl+C
        if is_windows():
            win32api.SetConsoleCtrlHandler(handle_exit())

        gsm_status.ready = True
        gsm_status.status = "Ready"
        try:
            if get_config().general.open_config_on_startup:
                root.after(50, settings_window.show)
            root.after(50, gsm_tray.start)
            # root.after(100, settings_window.show_anki_confirmation_dialog(expression="こんにちは",
            #     sentence="こんにちは、世界！元気ですか？",
            #     screenshot_path="test_image.png",
            #     audio_path="C:/path/to/my/audio.mp3",
            #     translation="Hello world! How are you?"))
            settings_window.add_save_hook(gsm_tray.update_icon)
            settings_window.on_exit = exit_program
            root.mainloop()
        except KeyboardInterrupt:
            cleanup()

        try:
            observer.stop()
            observer.join()
        except Exception as e:
            logger.error(f"Error stopping observer: {e}")
    except Exception as e:
        handle_error_in_initialization(e)


def main():
    logger.info("Starting GSM")
    try:
        asyncio.run(async_main())
    except Exception as e:
        handle_error_in_initialization(e)


if __name__ == "__main__":
    logger.info("Starting GSM")
    try:
        asyncio.run(async_main())
    except Exception as e:
        handle_error_in_initialization(e)
