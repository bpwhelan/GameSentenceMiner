import asyncio
import os
import shutil
import signal
import subprocess
import sys
import multiprocessing as mp
import threading
import time
import warnings
from dataclasses import dataclass, field
from subprocess import Popen
from typing import Any, Coroutine, Optional

import psutil
from PIL import Image
from watchdog.observers import Observer

from GameSentenceMiner import anki, gametext, obs
from GameSentenceMiner.obs import check_obs_folder_is_correct
from GameSentenceMiner.replay_handler import ReplayAudioExtractor, ReplayFileWatcher
from GameSentenceMiner.ui import qt_main
from GameSentenceMiner.util.clients.discord_rpc import discord_rpc_manager
from GameSentenceMiner.util.communication.electron_ipc import (
    FunctionName,
    announce_connected,
    register_command_handler,
    send_message,
    start_ipc_listener_in_thread,
)
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import (
    get_app_directory,
    get_config,
    get_ffmpeg_path,
    get_master_config,
    get_temporary_directory,
    gsm_state,
    gsm_status,
    is_dev,
    is_gsm_cloud_preview_enabled,
    is_linux,
    is_mac,
    is_windows,
    logger,
    switch_profile_and_save,
)
from GameSentenceMiner.util.gsm_cloud_auth_cache import gsm_cloud_auth_cache_service
from GameSentenceMiner.util.cloud_sync import cloud_sync_service
from GameSentenceMiner.util.database import db
from GameSentenceMiner.util.downloader.download_tools import (
    download_ffmpeg_if_needed,
    download_obs_if_needed,
    download_oneocr_dlls_if_needed,
    write_obs_configs,
)
from GameSentenceMiner.util.overlay.get_overlay_coords import (
    get_overlay_processor,
    init_overlay_processor,
)
from GameSentenceMiner.util.platform.hotkey import hotkey_manager
from GameSentenceMiner.util.platform.window_state_monitor import (
    cleanup_suspended_processes,
    toggle_active_game_pause,
)
from GameSentenceMiner.util.text_log import TextSource, game_log, get_all_lines
from GameSentenceMiner.vad import vad_processor
from GameSentenceMiner.web import texthooking_page
from GameSentenceMiner.web.gsm_websocket import websocket_manager
from GameSentenceMiner.web.service import set_get_audio_from_video_callback
from GameSentenceMiner.web.texthooking_page import run_text_hooker_page

try:
    from pystray import Icon, Menu, MenuItem
except Exception:
    Icon = None
    Menu = None
    MenuItem = None

if is_windows():
    import win32api

warnings.simplefilter("ignore", DeprecationWarning)

if os.name == "nt":
    # Ensure multiprocessing child workers reuse the current launched executable path.
    try:
        mp.set_executable(sys.executable)
    except Exception:
        pass


class AsyncBackgroundRunner:
    def __init__(self, name: str = "gsm-async"):
        self._name = name
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()

    def start(self) -> None:
        if self._thread:
            return
        self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
        self._thread.start()
        self._ready.wait(timeout=5)

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._ready.set()
        loop.run_forever()
        pending = asyncio.all_tasks(loop)
        if pending:
            for task in pending:
                task.cancel()
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        loop.close()

    def submit(self, coro: Coroutine[Any, Any, Any]):
        if not self._loop:
            raise RuntimeError("Async background loop is not running.")
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def stop(self, timeout: float = 2) -> None:
        if not self._loop:
            return
        self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(timeout=timeout)


@dataclass
class AppState:
    procs_to_close: list[Popen] = field(default_factory=list)
    settings_window: Optional[object] = None
    file_watcher_observer: Optional[Observer] = None
    file_watcher_path: Optional[str] = None
    async_runner: AsyncBackgroundRunner = field(default_factory=AsyncBackgroundRunner)


class GSMTray(threading.Thread):
    def __init__(self, app: "GSMApplication"):
        super().__init__(daemon=True)
        self._app = app
        self.icon = None

    def run(self) -> None:
        if not Icon:
            logger.warning("Tray icon functionality is not available.")
            return
        self._run_tray()

    def _run_tray(self) -> None:
        if not Icon:
            logger.warning("Tray icon functionality is not available.")
            return

        def test_anki_confirmation(icon, item):
            from GameSentenceMiner.ui.qt_main import launch_anki_confirmation
            from GameSentenceMiner.util.models.model import VADResult

            gsm_state.current_replay = r"C:\Users\Beangate\Videos\GSM\Replay 2025-11-06 17-46-52.mp4"
            gsm_state.vad_result = VADResult(
                success=True,
                start=0,
                end=0,
                model="Whisper",
                output_audio=r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\test\NEKOPARAvol.1_2025-08-18-17-20-43-614.opus",
            )
            result = launch_anki_confirmation(
                expression="世界",
                sentence="おはよう世界、Good morning world!",
                screenshot_path=r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\test\GRlkYdonrE.png",
                previous_screenshot_path=r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\test\GRlkYdonrE.png",
                audio_path=r"C:\Users\Beangate\GSM\GameSentenceMiner\GameSentenceMiner\test\NEKOPARAvol.1_2025-08-18-17-20-43-614.opus",
                translation="Hello world! How are you?",
                screenshot_timestamp=0,
            )
            print(f"Anki Confirmation Result: {result}")

        def test_screenshot_selector(icon, item):
            from GameSentenceMiner.ui.qt_main import launch_screenshot_selector

            gsm_state.current_replay = r"C:\Users\Beangate\Videos\GSM\Replay 2025-11-06 17-46-52.mp4"
            result = launch_screenshot_selector(gsm_state.current_replay, 10, "middle")
            print(f"Screenshot Selector Result: {result}")

        def test_furigana_filter(icon, item):
            from GameSentenceMiner.ui.qt_main import launch_furigana_filter_preview

            result = launch_furigana_filter_preview(current_sensitivity=50)
            print(f"Furigana Filter Result: {result}")

        def test_area_selector(icon, item):
            from GameSentenceMiner.ui.qt_main import launch_area_selector

            result = launch_area_selector(window_name="", use_obs_screenshot=True)
            print(f"Area Selector Result: {result}")

        def test_screen_cropper(icon, item):
            from GameSentenceMiner.ui.qt_main import launch_screen_cropper

            result = launch_screen_cropper()
            print(f"Screen Cropper Result: {result}")

        profile_menu = Menu(
            *[
                MenuItem(
                    ("Active: " if profile == get_master_config().current_profile else "") + profile,
                    self.switch_profile,
                )
                for profile in get_master_config().get_all_profile_names()
            ]
        )

        menu_items = [
            MenuItem("Open Settings", self._app.open_settings, default=True),
            MenuItem("Open Texthooker", texthooking_page.open_texthooker),
            MenuItem("Open Log", self._app.open_log),
            MenuItem("Toggle Replay Buffer", self.play_pause),
            MenuItem("Restart OBS", self._app.restart_obs),
            MenuItem("Switch Profile", profile_menu),
            MenuItem("Exit", self._app.exit_program),
        ]

        if is_dev:
            test_menu = Menu(
                MenuItem("Anki Confirmation Dialog", test_anki_confirmation),
                MenuItem("Screenshot Selector", test_screenshot_selector),
                MenuItem("Furigana Filter Preview", test_furigana_filter),
                MenuItem("Area Selector", test_area_selector),
                MenuItem("Screen Cropper", test_screen_cropper),
            )
            menu_items.insert(-1, MenuItem("Test Windows", test_menu))

        menu = Menu(*menu_items)
        self.icon = Icon("TrayApp", self._app.create_image(), "GameSentenceMiner", menu)
        self.icon.run()

    def update_icon(self) -> None:
        if not self.icon:
            return
        profile_menu = Menu(
            *[
                MenuItem(
                    ("Active: " if profile == get_master_config().current_profile else "") + profile,
                    self.switch_profile,
                )
                for profile in get_master_config().get_all_profile_names()
            ]
        )

        menu = Menu(
            MenuItem("Open Settings", self._app.open_settings, default=True),
            MenuItem("Open Multi-Mine GUI", self._app.open_multimine),
            MenuItem("Open Log", self._app.open_log),
            MenuItem("Toggle Replay Buffer", self.play_pause),
            MenuItem("Restart OBS", self._app.restart_obs),
            MenuItem("Switch Profile", profile_menu),
            MenuItem("Exit", self._app.exit_program),
        )

        self.icon.menu = menu
        self.icon.update_menu()

    def switch_profile(self, icon, item) -> None:
        if not self.icon:
            return
        if "Active:" in item.text:
            logger.error("You cannot switch to the currently active profile!")
            return
        logger.info(f"Switching to profile: {item.text}")
        get_master_config().current_profile = item.text
        switch_profile_and_save(item.text)
        if self._app.state.settings_window:
            self._app.state.settings_window.reload_settings()

    def play_pause(self, icon, item) -> None:
        if not self.icon:
            return
        obs.toggle_replay_buffer()
        self.update_icon()

    def stop(self) -> None:
        if not self.icon:
            return
        self.icon.stop()


class GSMApplication:
    def __init__(self) -> None:
        self.state = AppState()
        self._replay_extractor = ReplayAudioExtractor()
        self._tray = GSMTray(self)
        self._threads: list[threading.Thread] = []
        self._obs_connect_task: Optional[asyncio.Task] = None

    def _start_thread(self, target, name: str) -> threading.Thread:
        thread = threading.Thread(target=target, name=name, daemon=True)
        thread.start()
        self._threads.append(thread)
        return thread

    def initial_checks(self) -> None:
        try:
            subprocess.run(configuration.ffmpeg_base_command_list)
            logger.debug("FFMPEG is installed and accessible.")
        except FileNotFoundError:
            logger.error("FFmpeg not found, please install it and add it to your PATH.")
            raise

    def register_hotkeys(self) -> None:
        hotkey_manager.clear()

        def call_overlay_processor():
            loop = get_overlay_processor().processing_loop
            if loop and loop.is_running():
                logger.info("Manually triggering overlay scan via hotkey.")
                asyncio.run_coroutine_threadsafe(
                    get_overlay_processor().find_box_and_send_to_overlay(source=TextSource.HOTKEY),
                    loop,
                )
            else:
                logger.warning("Overlay loop not ready yet.")

        hotkey_manager.register(lambda: get_config().hotkeys.play_latest_audio, self.play_most_recent_audio)
        hotkey_manager.register(lambda: get_config().hotkeys.manual_overlay_scan, call_overlay_processor)

        if is_windows():
            hotkey_manager.register(lambda: get_config().hotkeys.process_pause, toggle_active_game_pause)

    def create_image(self) -> Image.Image:
        image_path = os.path.join(os.path.dirname(__file__), "assets", "pickaxe.png")
        return Image.open(image_path)

    def open_settings(self, *args) -> None:
        obs.update_current_game()
        if self.state.settings_window:
            self.state.settings_window.show_window()

    def play_most_recent_audio(self) -> None:
        if (get_config().advanced.audio_player_path or get_config().advanced.video_player_path) and len(
            get_all_lines()
        ) > 0:
            gsm_state.line_for_audio = get_all_lines()[-1]
            obs.save_replay_buffer()
        else:
            logger.error("Feature Disabled. No audio or video player path set in config!")

    def open_log(self, *args) -> None:
        from pathlib import Path

        log_dir = Path(get_app_directory()) / "logs"
        log_file_path = log_dir / "gamesentenceminer.log"

        if not log_file_path.exists():
            logger.error("Log file not found!")
            return

        if sys.platform.startswith("win"):
            os.startfile(str(log_file_path))
        elif sys.platform.startswith("darwin"):
            subprocess.call(["open", log_file_path])
        elif sys.platform.startswith("linux"):
            subprocess.call(["xdg-open", log_file_path])
        else:
            logger.error("Unsupported platform!")
        logger.info("Log opened.")

    def open_multimine(self, icon=None, item=None) -> None:
        texthooking_page.open_texthooker()

    def exit_program(self, icon=None, item=None) -> None:
        logger.info("Exiting...")
        if icon:
            icon.stop()
        self.cleanup()

    def close_obs(self) -> None:
        obs.disconnect_from_obs()
        if obs.obs_process_pid:
            if is_linux() or is_mac():
                try:
                    os.kill(obs.obs_process_pid, signal.SIGTERM)
                    print(f"OBS (PID {obs.obs_process_pid}) has been terminated.")
                    if os.path.exists(obs.OBS_PID_FILE):
                        os.remove(obs.OBS_PID_FILE)
                except Exception as e:
                    print(f"Error terminating OBS: {e}")
                return
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(obs.obs_process_pid), "/F"],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                print(f"OBS (PID {obs.obs_process_pid}) has been terminated.")
                if os.path.exists(obs.OBS_PID_FILE):
                    os.remove(obs.OBS_PID_FILE)
            except subprocess.CalledProcessError as e:
                print(f"Error terminating OBS: {e.stderr}")
        else:
            print("OBS is not running.")

    def restart_obs(self, *args) -> None:
        if obs.obs_process_pid:
            self.close_obs()
            time.sleep(1)
            obs.start_obs()

    def cleanup(self) -> None:
        try:
            logger.info("Performing cleanup...")
            gsm_state.keep_running = False
            gsm_status.clear_words_being_processed()

            if obs.obs_connection_manager and obs.obs_connection_manager.is_alive():
                obs.obs_connection_manager.stop()
            obs.stop_replay_buffer()
            obs.disconnect_from_obs()

            if get_config().obs.close_obs:
                self.close_obs()

            websocket_manager.stop_all()
            gsm_cloud_auth_cache_service.stop_background_loop()
            cloud_sync_service.stop_background_loop()

            for proc in self.state.procs_to_close:
                try:
                    logger.info(f"Terminating process {proc.args[0]}")
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                        logger.info(f"Process {proc.args[0]} terminated.")
                    except subprocess.TimeoutExpired:
                        logger.warning(f"Process {proc.args[0]} didn't terminate in time, killing...")
                        proc.kill()
                        proc.wait(timeout=1)
                except psutil.NoSuchProcess:
                    logger.info("PID already closed.")
                except Exception as e:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    logger.error(f"Error terminating process {proc}: {e}")

            if self._tray:
                self._tray.stop()

            discord_rpc_manager.stop()

            if self.state.file_watcher_observer:
                try:
                    self.state.file_watcher_observer.stop()
                    self.state.file_watcher_observer.join(timeout=2)
                    if self.state.file_watcher_observer.is_alive():
                        logger.warning("File watcher observer didn't stop in time")
                except Exception as e:
                    logger.error(f"Error stopping file watcher observer: {e}")

            for video in gsm_state.videos_to_remove:
                try:
                    if os.path.exists(video):
                        os.remove(video)
                except Exception as e:
                    logger.error(f"Error removing temporary video file {video}: {e}")

            cleanup_suspended_processes()
            qt_main.shutdown_qt_app()
            self.state.async_runner.stop()

            send_message("cleanup_complete")
        except Exception as e:
            logger.exception(f"Error during cleanup: {e}")
            sys.exit(1)

    def handle_exit(self):
        def _handle_exit(signum, *args):
            logger.info(f"Received signal {signum}. Exiting gracefully...")
            self.cleanup()
            sys.exit(0)

        return _handle_exit

    def start_file_watcher(self) -> None:
        if self.state.file_watcher_observer:
            try:
                self.state.file_watcher_observer.stop()
                self.state.file_watcher_observer.join(timeout=2)
                logger.info("Stopped existing file watcher")
            except Exception as e:
                logger.error(f"Error stopping file watcher: {e}")

        watch_path = get_config().paths.folder_to_watch
        os.makedirs(watch_path, exist_ok=True)

        observer = Observer()
        observer.schedule(ReplayFileWatcher(self._replay_extractor), watch_path, recursive=False)
        observer.start()
        self.state.file_watcher_observer = observer
        self.state.file_watcher_path = watch_path
        logger.info(f"File watcher started for: {watch_path}")

    def on_config_changed(self) -> None:
        new_path = get_config().paths.folder_to_watch
        if self.state.file_watcher_path != new_path:
            logger.info(
                f"Watch path changed from '{self.state.file_watcher_path}' to '{new_path}', restarting file watcher..."
            )
            self.start_file_watcher()
        else:
            logger.debug("Config changed, but watch path unchanged - no restart needed")

    def initialize(self, reloading: bool = False) -> None:
        import GameSentenceMiner.web as web  # Register API routes after core modules load.
        web.register_routes()

        if not reloading:
            get_temporary_directory(delete=True)
            if is_windows():
                download_obs_if_needed()
                download_ffmpeg_if_needed()
                download_oneocr_dlls_if_needed()
                write_obs_configs(obs.get_base_obs_dir())
                if shutil.which("ffmpeg") is None:
                    os.environ["PATH"] += os.pathsep + os.path.dirname(get_ffmpeg_path())
            if is_mac():
                if shutil.which("ffmpeg") is None:
                    os.environ["PATH"] += os.pathsep + "/opt/homebrew/bin"

            try:
                from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup
                from GameSentenceMiner.util.database.db import GameLinesTable
                from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable

                first_rollup = StatsRollupTable.get_first_date()
                has_game_lines = GameLinesTable._db.fetchone(
                    f"SELECT COUNT(*) FROM {GameLinesTable._table}"
                )[0] > 0

                if has_game_lines and not first_rollup:
                    logger.info(
                        "Detected existing data without rollup table - running initial rollup generation..."
                    )
                    logger.info("This is a one-time migration for version upgrades. Please wait...")
                    rollup_result = run_daily_rollup()
                    logger.info(
                        f"Initial rollup complete: processed {rollup_result.get('processed', 0)} dates"
                    )
            except Exception as e:
                logger.warning(f"Failed to check/populate rollup table on startup: {e}")

            if get_config().obs.open_obs:
                obs.start_obs()

            try:
                os.makedirs(get_config().paths.folder_to_watch, exist_ok=True)
                os.makedirs(get_config().paths.output_folder, exist_ok=True)
            except Exception as e:
                logger.error(
                    "Error creating necessary directories, certain directories may not exist: "
                    f"{e}"
                )

            set_get_audio_from_video_callback(self._replay_extractor.get_audio)

        self.initial_checks()
        start_ipc_listener_in_thread()
        register_command_handler(self.handle_ipc_command)
        announce_connected()

    def start_background_threads(self) -> None:
        self._start_thread(anki.start_monitoring_anki, "anki-monitor")
        if get_config().paths.output_folder:
            self._start_thread(anki.migrate_old_word_folders, "anki-migrate-old-folders")

        if is_gsm_cloud_preview_enabled():
            gsm_cloud_auth_cache_service.start_background_loop()
            cloud_sync_service.start_background_loop()
        self._start_thread(run_text_hooker_page, "texthooker-page")

    def handle_ipc_command(self, cmd: dict) -> None:
        logger.info(f"IPC Command Received: {cmd}")
        try:
            function = cmd.get("function")
            if function == FunctionName.QUIT.value:
                self.cleanup()
                sys.exit(0)
            elif function == FunctionName.QUIT_OBS.value:
                self.close_obs()
            elif function == FunctionName.START_OBS.value:
                obs.start_obs(force_restart=not gsm_status.obs_connected)
            elif function == FunctionName.OPEN_SETTINGS.value:
                self.open_settings()
            elif function == FunctionName.OPEN_TEXTHOOKER.value:
                texthooking_page.open_texthooker()
            elif function == FunctionName.OPEN_LOG.value:
                self.open_log()
            elif function == FunctionName.TOGGLE_REPLAY_BUFFER.value:
                obs.toggle_replay_buffer()
            elif function == FunctionName.RESTART_OBS.value:
                self.restart_obs()
            elif function == FunctionName.EXIT.value:
                self.cleanup()
                sys.exit(0)
            elif function == FunctionName.CONNECT.value:
                logger.debug("Electron reported connect")
            else:
                logger.debug(f"Unknown IPC command: {cmd}")
        except Exception as e:
            logger.debug(f"Error handling IPC command: {e}")

    def get_previous_lines_for_game(self) -> None:
        previous_lines = set()
        try:
            all_lines = db.GameLinesTable.get_all_lines_for_scene(obs.get_current_scene())
            for line in all_lines:
                previous_lines.add(line.line_text)
            game_log.previous_lines = previous_lines
            logger.info(
                f"Loaded {len(previous_lines)} previous lines for game '{obs.get_current_game()}'"
            )
        except Exception as e:
            logger.debug(f"Error getting previous lines for game: {e}")

    async def register_scene_switcher_callback(self) -> None:
        def scene_switcher_callback(scene):
            from GameSentenceMiner.ui.qt_main import launch_scene_selection

            logger.info(f"Scene changed to: {scene}")
            gsm_state.current_game = obs.get_current_game()
            matching_configs = [
                name.strip()
                for name, config in get_master_config().configs.items()
                if scene.strip() in config.scenes
            ]
            switch_to = None
            self.get_previous_lines_for_game()

            if len(matching_configs) > 1:
                selected_scene = launch_scene_selection(matching_configs)
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
                if self.state.settings_window:
                    self.state.settings_window.reload_settings()

        await obs.register_scene_change_callback(scene_switcher_callback)

    async def post_init_async(self) -> None:
        logger.info("Post-Initialization started.")

        self.start_file_watcher()
        await init_overlay_processor()
        cleanup_suspended_processes()
        vad_processor.init()

        if not self._obs_connect_task or self._obs_connect_task.done():
            self._obs_connect_task = asyncio.create_task(self._connect_obs_when_available())

    async def _connect_obs_when_available(self) -> None:
        if gsm_status.obs_connected:
            return

        await obs.wait_for_obs_ready()
        if not gsm_state.keep_running:
            return

        await obs.connect_to_obs(connections=3, check_output=True)
        if not gsm_status.obs_connected:
            return

        await self.register_scene_switcher_callback()
        await check_obs_folder_is_correct()
        self.on_config_changed()

    async def background_tasks_async(self) -> None:
        from GameSentenceMiner.util.cron import cron_scheduler

        self.get_previous_lines_for_game()
        await cron_scheduler.start()
        await asyncio.Event().wait()

    async def start_text_monitor_async(self) -> None:
        await gametext.start_text_monitor()

    async def check_if_script_is_running(self) -> bool:
        if os.path.exists(os.path.join(get_app_directory(), "current_pid.txt")):
            with open(os.path.join(get_app_directory(), "current_pid.txt"), "r") as f:
                pid = int(f.read().strip())
                if psutil.pid_exists(pid) and "python" in psutil.Process(pid).name().lower():
                    logger.info(f"Script is already running with PID: {pid}")
                    psutil.Process(pid).terminate()
                    logger.info("Sent SIGTERM to the existing process.")
                    from GameSentenceMiner.util.platform import notification

                    notification.send_error_notification(
                        "Script was already running. Terminating the existing process."
                    )
                    return True
        return False

    async def log_current_pid(self) -> None:
        current_pid = os.getpid()
        logger.info(f"Current process ID: {current_pid}")
        with open(os.path.join(get_app_directory(), "current_pid.txt"), "w") as f:
            f.write(str(current_pid))

    def run(self, reloading: bool = False) -> None:
        self.initialize(reloading)

        self.state.settings_window = qt_main.get_config_window()
        gsm_state.config_app = self.state.settings_window

        self.start_background_threads()
        self.register_hotkeys()
        self.state.settings_window.add_save_hook(self.register_hotkeys)
        self.state.settings_window.add_save_hook(self.on_config_changed)

        self.state.async_runner.start()
        post_init = self.state.async_runner.submit(self.post_init_async())
        post_init.result()
        self.state.async_runner.submit(self.background_tasks_async())
        self.state.async_runner.submit(self.start_text_monitor_async())

        signal.signal(signal.SIGTERM, self.handle_exit())
        signal.signal(signal.SIGINT, self.handle_exit())
        if is_windows():
            win32api.SetConsoleCtrlHandler(self.handle_exit())

        gsm_status.clear_words_being_processed()
        gsm_status.ready = True
        gsm_status.status = "Ready"

        if Icon:
            self._tray.start()

        logger.success("Initialization complete. Happy Mining! がんばれ！")
        send_message(FunctionName.INITIALIZED.value, {"status": "ready"})
        from GameSentenceMiner.util.platform import notification

        notification.send_notification(
            "GSM Ready",
            "Initialization complete. Happy Mining! がんばれ！",
            5,
        )
        qt_main.start_qt_app(show_config_immediately=get_config().general.open_config_on_startup)


def handle_error_in_initialization(exc: Exception) -> None:
    try:
        logger.exception(f"Error during initialization: {exc}")
        logger.info(
            "An error occurred during initialization. Maybe try updating GSM from the menu or if running "
            "manually, try installing `pip install --update GameSentenceMiner`."
        )
        from GameSentenceMiner.util.communication import electron_ipc

        try:
            for raw in sys.stdin:
                line = raw.strip()
                if "quit" in line.lower():
                    logger.info("Exiting due to quit command.")
                    electron_ipc.send_message("cleanup_complete")
                    sys.exit(1)
        except KeyboardInterrupt:
            logger.info("Exiting due to initialization error.")
            sys.exit(1)
    except Exception:
        print(f"Error during initialization: {exc}")
        raise


def main() -> None:
    logger.info("Starting GSM")
    if any(arg in ("-h", "--help") for arg in sys.argv[1:]):
        print(
            """
GameSentenceMiner (GSM) - Visual Novel and Game Sentence Mining Tool

Usage:
    python -m GameSentenceMiner.gsm [options]

Options:
    -h, --help        Show this help message and exit

Description:
    GameSentenceMiner is a tool for mining sentences, screenshots, and audio from games and visual novels.
    It provides a GUI for configuration, hotkeys for mining, and integration with Anki.

For more information, see: https://github.com/bpwhelan/GameSentenceMiner
            """
        )
        sys.exit(0)
    try:
        app = GSMApplication()
        app.run()
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as exc:
        handle_error_in_initialization(exc)


if __name__ == "__main__":
    main()
