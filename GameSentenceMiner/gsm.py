import signal
import time
from subprocess import Popen

import keyboard
import psutil
import ttkbootstrap as ttk
from PIL import Image, ImageDraw
from pystray import Icon, Menu, MenuItem
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from GameSentenceMiner import anki
from GameSentenceMiner import config_gui
from GameSentenceMiner import configuration
from GameSentenceMiner import ffmpeg
from GameSentenceMiner import gametext
from GameSentenceMiner import notification
from GameSentenceMiner import obs
from GameSentenceMiner import util
from GameSentenceMiner.configuration import *
from GameSentenceMiner.downloader.download_tools import download_obs_if_needed, download_ffmpeg_if_needed
from GameSentenceMiner.electron_messaging import signal_restart_settings_change
from GameSentenceMiner.ffmpeg import get_audio_and_trim
from GameSentenceMiner.gametext import get_text_event, get_mined_line
from GameSentenceMiner.util import *
from GameSentenceMiner.utility_gui import init_utility_window, get_utility_window
from GameSentenceMiner.vad import vosk_helper, silero_trim, whisper_helper

if is_windows():
    import win32api

obs_process = None
procs_to_close = []
settings_window: config_gui.ConfigApp = None
obs_paused = False
icon: Icon
menu: Menu
root = None


class VideoToAudioHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory or ("Replay" not in event.src_path and "GSM" not in event.src_path):
            return
        if event.src_path.endswith(".mkv") or event.src_path.endswith(".mp4"):  # Adjust based on your OBS output format
            logger.info(f"MKV {event.src_path} FOUND, RUNNING LOGIC")
            self.wait_for_stable_file(event.src_path)
            self.convert_to_audio(event.src_path)

    @staticmethod
    def wait_for_stable_file(file_path, timeout=10, check_interval=0.5):
        elapsed_time = 0
        last_size = -1

        while elapsed_time < timeout:
            try:
                current_size = os.path.getsize(file_path)
                if current_size == last_size:
                    return True
                last_size = current_size
                time.sleep(check_interval)
                elapsed_time += check_interval
            except Exception as e:
                logger.warning(f"Error checking file size, will still try updating Anki Card!: {e}")
                return False
        logger.warning("File size did not stabilize within the timeout period. Continuing...")
        return False

    @staticmethod
    def convert_to_audio(video_path):
        try:
            last_note = None
            if anki.card_queue and len(anki.card_queue) > 0:
                last_note = anki.card_queue.pop(0)
            with util.lock:
                util.set_last_mined_line(anki.get_sentence(last_note))
                if os.path.exists(video_path) and os.access(video_path, os.R_OK):
                    logger.debug(f"Video found and is readable: {video_path}")

                if get_config().obs.minimum_replay_size and not ffmpeg.is_video_big_enough(video_path,
                                                                                           get_config().obs.minimum_replay_size):
                    logger.debug("Checking if video is big enough")
                    notification.send_check_obs_notification(reason="Video may be empty, check scene in OBS.")
                    logger.error(
                        f"Video was unusually small, potentially empty! Check OBS for Correct Scene Settings! Path: {video_path}")
                    return
                if not last_note:
                    logger.debug("Attempting to get last anki card")
                    if get_config().anki.update_anki:
                        last_note = anki.get_last_anki_card()
                    if get_config().features.backfill_audio:
                        last_note = anki.get_cards_by_sentence(gametext.current_line_after_regex)
                line_cutoff = None
                start_line = None
                mined_line = get_text_event(last_note)
                if mined_line:
                    start_line = mined_line
                    if mined_line.next:
                        line_cutoff = mined_line.next.time

                if get_utility_window().lines_selected():
                    lines = get_utility_window().get_selected_lines()
                    start_line = lines[0]
                    mined_line = get_mined_line(last_note, lines)
                    line_cutoff = get_utility_window().get_next_line_timing()

                ss_timing = 0
                if mined_line and line_cutoff or mined_line and get_config().screenshot.use_beginning_of_line_as_screenshot:
                    ss_timing = ffmpeg.get_screenshot_time(video_path, mined_line)
                if last_note:
                    logger.debug(last_note.to_json())

                note = anki.get_initial_card_info(last_note, get_utility_window().get_selected_lines())

                tango = last_note.get_field(get_config().anki.word_field) if last_note else ''

                if get_config().anki.sentence_audio_field:
                    logger.debug("Attempting to get audio from video")
                    final_audio_output, should_update_audio, vad_trimmed_audio = VideoToAudioHandler.get_audio(
                        start_line,
                        line_cutoff,
                        video_path)
                else:
                    final_audio_output = ""
                    should_update_audio = False
                    vad_trimmed_audio = ""
                    logger.info("No SentenceAudio Field in config, skipping audio processing!")
                if get_config().anki.update_anki and last_note:
                    anki.update_anki_card(last_note, note, audio_path=final_audio_output, video_path=video_path,
                                          tango=tango,
                                          should_update_audio=should_update_audio,
                                          ss_time=ss_timing,
                                          game_line=start_line)
                elif get_config().features.notify_on_update and should_update_audio:
                    notification.send_audio_generated_notification(vad_trimmed_audio)
        except Exception as e:
            logger.error(f"Failed Processing and/or adding to Anki: Reason {e}")
            logger.debug(f"Some error was hit catching to allow further work to be done: {e}", exc_info=True)
            notification.send_error_no_anki_update()
        if get_config().paths.remove_video and os.path.exists(video_path):
            os.remove(video_path)  # Optionally remove the video after conversion
        if get_config().paths.remove_audio and os.path.exists(vad_trimmed_audio):
            os.remove(vad_trimmed_audio)  # Optionally remove the screenshot after conversion
        get_utility_window().reset_checkboxes()

    @staticmethod
    def get_audio(game_line, next_line_time, video_path):
        trimmed_audio = get_audio_and_trim(video_path, game_line, next_line_time)
        vad_trimmed_audio = make_unique_file_name(
            f"{os.path.abspath(configuration.get_temporary_directory())}/{obs.get_current_game(sanitize=True)}.{get_config().audio.extension}")
        final_audio_output = make_unique_file_name(os.path.join(get_config().paths.audio_destination,
                                                                f"{obs.get_current_game(sanitize=True)}.{get_config().audio.extension}"))
        should_update_audio = True
        if get_config().vad.do_vad_postprocessing:
            match get_config().vad.selected_vad_model:
                case configuration.SILERO:
                    should_update_audio = silero_trim.process_audio_with_silero(trimmed_audio, vad_trimmed_audio)
                case configuration.VOSK:
                    should_update_audio = vosk_helper.process_audio_with_vosk(trimmed_audio, vad_trimmed_audio)
                case configuration.WHISPER:
                    should_update_audio = whisper_helper.process_audio_with_whisper(trimmed_audio,
                                                                                    vad_trimmed_audio)
            if not should_update_audio:
                match get_config().vad.backup_vad_model:
                    case configuration.OFF:
                        pass
                    case configuration.SILERO:
                        should_update_audio = silero_trim.process_audio_with_silero(trimmed_audio,
                                                                                    vad_trimmed_audio)
                    case configuration.VOSK:
                        should_update_audio = vosk_helper.process_audio_with_vosk(trimmed_audio, vad_trimmed_audio)
                    case configuration.WHISPER:
                        should_update_audio = whisper_helper.process_audio_with_whisper(trimmed_audio,
                                                                                        vad_trimmed_audio)
            if not should_update_audio and get_config().vad.add_audio_on_no_results:
                logger.info("No voice activity detected, using full audio.")
                vad_trimmed_audio = trimmed_audio
                should_update_audio = True
        if get_config().audio.ffmpeg_reencode_options and os.path.exists(vad_trimmed_audio):
            ffmpeg.reencode_file_with_user_config(vad_trimmed_audio, final_audio_output,
                                                  get_config().audio.ffmpeg_reencode_options)
        elif os.path.exists(vad_trimmed_audio):
            os.replace(vad_trimmed_audio, final_audio_output)
        return final_audio_output, should_update_audio, vad_trimmed_audio


def initialize(reloading=False):
    global obs_process
    if not reloading:
        if is_windows():
            download_obs_if_needed()
            download_ffmpeg_if_needed()
        if get_config().obs.enabled:
            if get_config().obs.open_obs:
                obs_process = obs.start_obs()
            obs.connect_to_obs(start_replay=True)
            anki.start_monitoring_anki()
        gametext.start_text_monitor()
        os.makedirs(get_config().paths.folder_to_watch, exist_ok=True)
        os.makedirs(get_config().paths.screenshot_destination, exist_ok=True)
        os.makedirs(get_config().paths.audio_destination, exist_ok=True)
    if get_config().vad.do_vad_postprocessing:
        if VOSK in (get_config().vad.backup_vad_model, get_config().vad.selected_vad_model):
            vosk_helper.get_vosk_model()
        if WHISPER in (get_config().vad.backup_vad_model, get_config().vad.selected_vad_model):
            whisper_helper.initialize_whisper_model()


def initial_checks():
    try:
        subprocess.run(ffmpeg.ffmpeg_base_command_list)
        logger.debug("FFMPEG is installed and accessible.")
    except FileNotFoundError:
        logger.error("FFmpeg not found, please install it and add it to your PATH.")
        raise


def register_hotkeys():
    keyboard.add_hotkey(get_config().hotkeys.reset_line, gametext.reset_line_hotkey_pressed)
    keyboard.add_hotkey(get_config().hotkeys.take_screenshot, get_screenshot)
    keyboard.add_hotkey(get_config().hotkeys.open_utility, open_multimine)


def get_screenshot():
    try:
        image = obs.get_screenshot()
        time.sleep(2)  # Wait for ss to save
        if not image:
            raise Exception("Failed to get Screenshot from OBS")
        encoded_image = ffmpeg.process_image(image)
        if get_config().anki.update_anki and get_config().screenshot.screenshot_hotkey_updates_anki:
            last_note = anki.get_last_anki_card()
            if last_note:
                logger.debug(json.dumps(last_note))
            if get_config().features.backfill_audio:
                last_note = anki.get_cards_by_sentence(gametext.current_line)
            if last_note:
                anki.add_image_to_card(last_note, encoded_image)
                notification.send_screenshot_updated(last_note.get_field(get_config().anki.word_field))
                if get_config().features.open_anki_edit:
                    notification.open_anki_card(last_note.noteId)
            else:
                notification.send_screenshot_saved(encoded_image)
        else:
            notification.send_screenshot_saved(encoded_image)
    except Exception as e:
        logger.error(f"Failed to get Screenshot {e}")


def create_image():
    """Create a simple pickaxe icon."""
    width, height = 64, 64
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))  # Transparent background
    draw = ImageDraw.Draw(image)

    # Handle (rectangle)
    handle_color = (139, 69, 19)  # Brown color
    draw.rectangle([(30, 15), (34, 50)], fill=handle_color)

    # Blade (triangle-like shape)
    blade_color = (192, 192, 192)  # Silver color
    draw.polygon([(15, 15), (49, 15), (32, 5)], fill=blade_color)

    return image


def open_settings():
    obs.update_current_game()
    settings_window.show()


def open_multimine():
    obs.update_current_game()
    get_utility_window().show()


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


def exit_program(passed_icon, item):
    """Exit the application."""
    if not passed_icon:
        passed_icon = icon
    logger.info("Exiting...")
    passed_icon.stop()
    cleanup()


def play_pause(icon, item):
    global obs_paused, menu
    obs.toggle_replay_buffer()
    update_icon()


def update_icon():
    global menu, icon
    # Recreate the menu with the updated button text
    profile_menu = Menu(
        *[MenuItem(("Active: " if profile == get_master_config().current_profile else "") + profile, switch_profile) for
          profile in
          get_master_config().get_all_profile_names()]
    )

    menu = Menu(
        MenuItem("Open Settings", open_settings),
        MenuItem("Open Multi-Mine GUI", open_multimine),
        MenuItem("Open Log", open_log),
        MenuItem("Toggle Replay Buffer", play_pause),
        MenuItem("Restart OBS", restart_obs),
        MenuItem("Switch Profile", profile_menu),
        MenuItem("Exit", exit_program)
    )

    icon.menu = menu
    icon.update_menu()


def switch_profile(icon, item):
    if "Active:" in item.text:
        logger.error("You cannot switch to the currently active profile!")
        return
    logger.info(f"Switching to profile: {item.text}")
    prev_config = get_config()
    get_master_config().current_profile = item.text
    switch_profile_and_save(item.text)
    settings_window.reload_settings()
    update_icon()
    if get_config().restart_required(prev_config):
        signal_restart_settings_change()


def run_tray():
    global menu, icon

    profile_menu = Menu(
        *[MenuItem(("Active: " if profile == get_master_config().current_profile else "") + profile, switch_profile) for
          profile in
          get_master_config().get_all_profile_names()]
    )

    menu = Menu(
        MenuItem("Open Settings", open_settings),
        MenuItem("Open Multi-Mine GUI", open_multimine),
        MenuItem("Open Log", open_log),
        MenuItem("Toggle Replay Buffer", play_pause),
        MenuItem("Restart OBS", restart_obs),
        MenuItem("Switch Profile", profile_menu),
        MenuItem("Exit", exit_program)
    )

    icon = Icon("TrayApp", create_image(), "Game Sentence Miner", menu)
    icon.run()


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
    if obs_process:
        try:
            subprocess.run(["taskkill", "/PID", str(obs_process), "/F"], check=True, capture_output=True, text=True)
            print(f"OBS (PID {obs_process}) has been terminated.")
        except subprocess.CalledProcessError as e:
            print(f"Error terminating OBS: {e.stderr}")
    else:
        print("OBS is not running.")


def restart_obs():
    global obs_process
    if obs_process:
        close_obs()
        time.sleep(2)
        obs_process = obs.start_obs()
        obs.connect_to_obs(start_replay=True)


def cleanup():
    logger.info("Performing cleanup...")
    util.keep_running = False

    if get_config().obs.enabled:
        if get_config().obs.start_buffer:
            obs.stop_replay_buffer()
    obs.disconnect_from_obs()
    if get_config().obs.close_obs:
        close_obs()

    proc: Popen
    for proc in procs_to_close:
        try:
            logger.info(f"Terminating process {proc.args[0]}")
            proc.terminate()
            proc.wait()  # Wait for OBS to fully close
            logger.info(f"Process {proc.args[0]} terminated.")
        except psutil.NoSuchProcess:
            logger.info("PID already closed.")
        except Exception as e:
            proc.kill()
            logger.error(f"Error terminating process {proc}: {e}")

    settings_window.window.destroy()
    logger.info("Cleanup complete.")


def check_for_stdin():
    while True:
        for line in sys.stdin:
            logger.info(f"Got stdin: {line}")
            if "exit" in line:
                cleanup()
                sys.exit(0)
            elif "restart_obs" in line:
                restart_obs()
            elif "update" in line:
                update_icon()
            sys.stdin.flush()


def handle_exit():
    """Signal handler for graceful termination."""

    def _handle_exit(signum):
        logger.info(f"Received signal {signum}. Exiting gracefully...")
        cleanup()
        sys.exit(0)

    return _handle_exit


def main(reloading=False, do_config_input=True):
    global root, settings_window
    logger.info("Script started.")
    util.run_new_thread(check_for_stdin)
    root = ttk.Window(themename='darkly')
    settings_window = config_gui.ConfigApp(root)
    init_utility_window(root)
    initialize(reloading)
    util.run_new_thread(run_tray)
    initial_checks()
    event_handler = VideoToAudioHandler()
    observer = Observer()
    observer.schedule(event_handler, get_config().paths.folder_to_watch, recursive=False)
    observer.start()

    logger.info("Script Initialized. Happy Mining!")
    if not is_linux():
        register_hotkeys()

    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, handle_exit())  # Handle `kill` commands
    signal.signal(signal.SIGINT, handle_exit())  # Handle Ctrl+C
    if is_windows():
        win32api.SetConsoleCtrlHandler(handle_exit())

    try:
        if get_config().general.open_config_on_startup:
            root.after(0, settings_window.show)
        if get_config().general.open_multimine_on_startup:
            root.after(0, get_utility_window().show)
        settings_window.add_save_hook(update_icon)
        settings_window.on_exit = exit_program
        root.mainloop()
    except KeyboardInterrupt:
        cleanup()

    try:
        observer.stop()
        observer.join()
    except Exception as e:
        logger.error(f"Error stopping observer: {e}")


if __name__ == "__main__":
    main()
