import time
import asyncio
import subprocess
import sys

import os
import warnings

os.environ.pop('TCL_LIBRARY', None)


try:
    import os.path
    import signal
    from subprocess import Popen

    import keyboard
    import ttkbootstrap as ttk
    from PIL import Image, ImageDraw
    from pystray import Icon, Menu, MenuItem
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer
    import psutil

    from GameSentenceMiner.util.model import VADResult
    from GameSentenceMiner.vad import vad_processor
    from GameSentenceMiner.util.downloader.download_tools import download_obs_if_needed, download_ffmpeg_if_needed
    from GameSentenceMiner.util.communication.send import send_restart_signal
    from GameSentenceMiner.util.gsm_utils import wait_for_stable_file, make_unique_file_name, run_new_thread
    from GameSentenceMiner import anki
    from GameSentenceMiner import config_gui
    from GameSentenceMiner.util import configuration, notification, ffmpeg
    from GameSentenceMiner import gametext
    from GameSentenceMiner import obs
    from GameSentenceMiner.util.communication import Message
    from GameSentenceMiner.util.communication.websocket import connect_websocket, register_websocket_message_handler, \
        FunctionName
    from GameSentenceMiner.util.configuration import *
    from GameSentenceMiner.util.ffmpeg import get_audio_and_trim, get_video_timings, get_ffmpeg_path
    from GameSentenceMiner.obs import check_obs_folder_is_correct
    from GameSentenceMiner.util.text_log import GameLine, get_text_event, get_mined_line, get_all_lines, game_log
    from GameSentenceMiner.util import *
    from GameSentenceMiner.web import texthooking_page
    from GameSentenceMiner.web.service import handle_texthooker_button
    from GameSentenceMiner.web.texthooking_page import run_text_hooker_page
except Exception as e:
    from GameSentenceMiner.util.configuration import logger, is_linux, is_windows
    logger.info(
        "Something bad happened during import/initialization, closing in 5 seconds")
    logger.exception(e)
    time.sleep(5)
    sys.exit(1)

if is_windows():
    import win32api

procs_to_close = []
settings_window: config_gui.ConfigApp = None
obs_paused = False
icon: Icon
menu: Menu
root = None
warnings.simplefilter("ignore", DeprecationWarning)


class VideoToAudioHandler(FileSystemEventHandler):
    def __init__(self):
        super().__init__()

    def on_created(self, event):
        if event.is_directory or ("Replay" not in event.src_path and "GSM" not in event.src_path):
            return
        # Adjust based on your OBS output format
        if event.src_path.endswith(".mkv") or event.src_path.endswith(".mp4"):
            logger.info(f"MKV {event.src_path} FOUND, RUNNING LOGIC")
            wait_for_stable_file(event.src_path)
            self.process_replay(event.src_path)

    def process_replay(self, video_path):
        vad_trimmed_audio = ''
        final_audio_output = ''
        skip_delete = False
        selected_lines = []
        anki_card_creation_time = None
        mined_line = None
        gsm_state.previous_replay = video_path
        if gsm_state.line_for_audio or gsm_state.line_for_screenshot:
            handle_texthooker_button(
                video_path, get_audio_from_video=VideoToAudioHandler.get_audio)
            return
        try:
            if anki.card_queue and len(anki.card_queue) > 0:
                last_note, anki_card_creation_time, selected_lines = anki.card_queue.pop(
                    0)
            elif get_config().features.backfill_audio:
                last_note = anki.get_cards_by_sentence(
                    gametext.current_line_after_regex)
            else:
                logger.info(
                    "Replay buffer initiated externally. Skipping processing.")
                skip_delete = True
                return

            # Just for safety
            if not last_note:
                if get_config().anki.update_anki:
                    last_note = anki.get_last_anki_card()
                if get_config().features.backfill_audio:
                    last_note = anki.get_cards_by_sentence(
                        gametext.current_line_after_regex)

            # Get Info of line mined
            line_cutoff = None
            start_line = None
            if selected_lines:
                start_line = selected_lines[0]
                mined_line = get_mined_line(last_note, selected_lines)
                line_cutoff = selected_lines[-1].get_next_time()
            else:
                mined_line = get_text_event(last_note)
                if mined_line:
                    start_line = mined_line
                    if mined_line.next:
                        line_cutoff = mined_line.next.time
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
            note = anki.get_initial_card_info(last_note, selected_lines)
            tango = last_note.get_field(
                get_config().anki.word_field) if last_note else ''

            if get_config().anki.sentence_audio_field and get_config().audio.enabled:
                logger.debug("Attempting to get audio from video")
                final_audio_output, vad_result, vad_trimmed_audio = VideoToAudioHandler.get_audio(
                    start_line,
                    line_cutoff,
                    video_path,
                    anki_card_creation_time,
                    mined_line=mined_line)
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
                    should_update_audio=vad_result.success,
                    ss_time=ss_timing,
                    game_line=mined_line,
                    selected_lines=selected_lines
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
        finally:
            if not skip_delete:
                if video_path and get_config().paths.remove_video and os.path.exists(video_path):
                    os.remove(video_path)
                if vad_trimmed_audio and get_config().paths.remove_audio and os.path.exists(vad_trimmed_audio):
                    os.remove(vad_trimmed_audio)
                if final_audio_output and get_config().paths.remove_audio and os.path.exists(final_audio_output):
                    os.remove(final_audio_output)

    @staticmethod
    def get_audio(game_line, next_line_time, video_path, anki_card_creation_time=None, temporary=False, timing_only=False, mined_line=None):
        trimmed_audio = get_audio_and_trim(
            video_path, game_line, next_line_time, anki_card_creation_time)
        if temporary:
            return ffmpeg.convert_audio_to_wav_lossless(trimmed_audio)
        vad_trimmed_audio = make_unique_file_name(
            f"{os.path.abspath(configuration.get_temporary_directory())}/{obs.get_current_game(sanitize=True)}.{get_config().audio.extension}")
        final_audio_output = make_unique_file_name(os.path.join(get_config().paths.audio_destination,
                                                                f"{obs.get_current_game(sanitize=True)}.{get_config().audio.extension}"))

        vad_result = vad_processor.trim_audio_with_vad(
            trimmed_audio, vad_trimmed_audio, game_line)
        if timing_only:
            return vad_result
        if vad_result.output_audio:
            vad_trimmed_audio = vad_result.output_audio
        if get_config().audio.ffmpeg_reencode_options_to_use and os.path.exists(vad_trimmed_audio):
            ffmpeg.reencode_file_with_user_config(vad_trimmed_audio, final_audio_output,
                                                  get_config().audio.ffmpeg_reencode_options_to_use)
        elif os.path.exists(vad_trimmed_audio):
            shutil.move(vad_trimmed_audio, final_audio_output)
        return final_audio_output, vad_result, vad_trimmed_audio


def initial_checks():
    try:
        subprocess.run(ffmpeg.ffmpeg_base_command_list)
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
    # try:
    last_note = anki.get_last_anki_card()
    gsm_state.anki_note_for_screenshot = last_note
    gsm_state.line_for_screenshot = get_mined_line(last_note, get_all_lines())
    obs.save_replay_buffer()
    #     image = obs.get_screenshot()
    #     wait_for_stable_file(image, timeout=3)
    #     if not image:
    #         raise Exception("Failed to get Screenshot from OBS")
    #     encoded_image = ffmpeg.process_image(image)
    #     if get_config().anki.update_anki and get_config().screenshot.screenshot_hotkey_updates_anki:
    #         last_note = anki.get_last_anki_card()
    #         if get_config().features.backfill_audio:
    #             last_note = anki.get_cards_by_sentence(gametext.current_line)
    #         if last_note:
    #             anki.add_image_to_card(last_note, encoded_image)
    #             notification.send_screenshot_updated(last_note.get_field(get_config().anki.word_field))
    #             if get_config().features.open_anki_edit:
    #                 notification.open_anki_card(last_note.noteId)
    #         else:
    #             notification.send_screenshot_saved(encoded_image)
    #     else:
    #         notification.send_screenshot_saved(encoded_image)
    # except Exception as e:
    #     logger.error(f"Failed to get Screenshot: {e}")


# def create_image():
#     """Create a simple pickaxe icon."""
#     width, height = 64, 64
#     image = Image.new("RGBA", (width, height), (0, 0, 0, 0))  # Transparent background
#     draw = ImageDraw.Draw(image)
#
#     # Handle (rectangle)
#     handle_color = (139, 69, 19)  # Brown color
#     draw.rectangle([(30, 15), (34, 50)], fill=handle_color)
#
#     # Blade (triangle-like shape)
#     blade_color = (192, 192, 192)  # Silver color
#     draw.polygon([(15, 15), (49, 15), (32, 5)], fill=blade_color)
#
#     return image

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


def open_multimine(icon, item):
    texthooking_page.open_texthooker()


def update_icon(profile=None):
    global menu, icon
    # Recreate the menu with the updated button text
    profile_menu = Menu(
        *[MenuItem(("Active: " if profile == get_master_config().current_profile else "") + profile, switch_profile) for
          profile in
          get_master_config().get_all_profile_names()]
    )

    menu = Menu(
        MenuItem("Open Settings", open_settings, default=True),
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
        send_restart_signal()


def run_tray():
    global menu, icon

    profile_menu = Menu(
        *[MenuItem(("Active: " if profile == get_master_config().current_profile else "") + profile, switch_profile) for
          profile in
          get_master_config().get_all_profile_names()]
    )

    menu = Menu(
        MenuItem("Open Settings", open_settings, default=True),
        MenuItem("Open Texthooker", texthooking_page.open_texthooker),
        MenuItem("Open Log", open_log),
        MenuItem("Toggle Replay Buffer", play_pause),
        MenuItem("Restart OBS", restart_obs),
        MenuItem("Switch Profile", profile_menu),
        MenuItem("Exit", exit_program)
    )

    icon = Icon("TrayApp", create_image(), "GameSentenceMiner", menu)
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
    logger.info("Performing cleanup...")
    gsm_state.keep_running = False

    if get_config().obs.enabled:
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

    if icon:
        icon.stop()

    for video in gsm_state.videos_to_remove:
        try:
            if os.path.exists(video):
                os.remove(video)
        except Exception as e:
            logger.error(f"Error removing temporary video file {video}: {e}")

    settings_window.window.destroy()
    time.sleep(5)
    logger.info("Cleanup complete.")


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
        if is_windows():
            download_obs_if_needed()
            download_ffmpeg_if_needed()
            if shutil.which("ffmpeg") is None:
                os.environ["PATH"] += os.pathsep + \
                    os.path.dirname(get_ffmpeg_path())
        if get_config().obs.enabled:
            if get_config().obs.open_obs:
                obs_process = obs.start_obs()
            # obs.connect_to_obs(start_replay=True)
            # anki.start_monitoring_anki()
        # gametext.start_text_monitor()
        os.makedirs(get_config().paths.folder_to_watch, exist_ok=True)
        os.makedirs(get_config().paths.screenshot_destination, exist_ok=True)
        os.makedirs(get_config().paths.audio_destination, exist_ok=True)
    initial_checks()
    register_websocket_message_handler(handle_websocket_message)
    # if get_config().vad.do_vad_postprocessing:
    #     if VOSK in (get_config().vad.backup_vad_model, get_config().vad.selected_vad_model):
    #         vosk_helper.get_vosk_model()
    #     if WHISPER in (get_config().vad.backup_vad_model, get_config().vad.selected_vad_model):
    #         whisper_helper.initialize_whisper_model()


def initialize_async():
    tasks = [connect_websocket, run_tray]
    threads = []
    tasks.append(anki.start_monitoring_anki)
    for task in tasks:
        threads.append(run_new_thread(task))
    return threads


def handle_websocket_message(message: Message):
    match FunctionName(message.function):
        case FunctionName.QUIT:
            cleanup()
            sys.exit(0)
        case FunctionName.QUIT_OBS:
            close_obs()
        case FunctionName.START_OBS:
            obs.start_obs()
        case FunctionName.OPEN_SETTINGS:
            open_settings()
        case FunctionName.OPEN_TEXTHOOKER:
            texthooking_page.open_texthooker()
        case FunctionName.OPEN_LOG:
            open_log()
        case FunctionName.TOGGLE_REPLAY_BUFFER:
            play_pause(None, None)
        case FunctionName.RESTART_OBS:
            restart_obs()
        case FunctionName.EXIT:
            exit_program(None, None)
        case _:
            logger.debug(
                f"unknown message from electron websocket: {message.to_json()}")


def post_init2():
    asyncio.run(gametext.start_text_monitor())


def async_loop():
    async def loop():
        await obs.connect_to_obs()
        if get_config().obs.enabled:
            await register_scene_switcher_callback()
            await check_obs_folder_is_correct()
        logger.info("Post-Initialization started.")
        vad_processor.init()
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
        matching_configs = [name.strip() for name, config in config_instance.configs.items(
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
            update_icon()

    await obs.register_scene_change_callback(scene_switcher_callback)


async def run_test_code():
    if get_config().wip.overlay_websocket_port and get_config().wip.overlay_websocket_send:
        boxes = await gametext.find_box_for_sentence("ちぇっ少しなの？")
        if boxes:
            await texthooking_page.send_word_coordinates_to_overlay(boxes)
        await asyncio.sleep(2)


async def async_main(reloading=False):
    try:
        global root, settings_window
        initialize(reloading)
        logger.info("Script started.")
        root = ttk.Window(themename='darkly')
        settings_window = config_gui.ConfigApp(root)
        initialize_async()
        observer = Observer()
        observer.schedule(VideoToAudioHandler(),
                        get_config().paths.folder_to_watch, recursive=False)
        observer.start()
        if is_windows():
            register_hotkeys()

        run_new_thread(post_init2)
        run_new_thread(run_text_hooker_page)
        run_new_thread(async_loop)

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
    except Exception as e:
        logger.error(f"An error occurred during initialization: {e}", exc_info=True)
        notification.send_error_notification(
            "An error occurred during initialization. Check the log for details.")
        asyncio.sleep(5)
        raise e


def main():
    """Main function to run the Game Sentence Miner."""
    logger.info("Starting GSM")
    try:
        asyncio.run(async_main())
    except Exception as e:
        logger.exception(e, exc_info=True)
        logger.info(
            "An error occurred during initialization, closing in 5 seconds")
        time.sleep(5)


if __name__ == "__main__":
    logger.info("Starting GSM")
    try:
        asyncio.run(async_main())
    except Exception as e:
        logger.exception(e, exc_info=True)
        logger.info(
            "An error occurred during initialization, closing in 5 seconds")
        time.sleep(5)
