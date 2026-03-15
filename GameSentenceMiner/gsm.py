import sys


def handle_error_in_initialization(exc: Exception) -> None:
    boot_logger = globals().get("logger")
    if boot_logger is None:
        try:
            from GameSentenceMiner.util.config.configuration import (
                logger as boot_logger,
            )
        except Exception:
            boot_logger = None

    try:
        if boot_logger is not None:
            boot_logger.exception(f"Error during initialization: {exc}")
            boot_logger.info(
                "An error occurred during initialization. Try updating GSM from the application menu or by "
                "reinstalling the latest release. If you are running it manually in your own Python environment, "
                "you can update with `pip install --upgrade GameSentenceMiner`.")
        else:
            print(f"Error during initialization: {exc}")

        try:
            from GameSentenceMiner.util.communication import electron_ipc
        except Exception:
            electron_ipc = None

        try:
            for raw in sys.stdin:
                line = raw.strip()
                if "quit" in line.lower():
                    if boot_logger is not None:
                        boot_logger.info("Exiting due to quit command.")
                    if electron_ipc is not None:
                        electron_ipc.send_message("cleanup_complete")
                    sys.exit(1)
        except KeyboardInterrupt:
            if boot_logger is not None:
                boot_logger.info("Exiting due to initialization error.")
            sys.exit(1)
    except Exception:
        print(f"Error during initialization: {exc}")
        raise


try:
    import asyncio
    import os
    import shutil
    import signal
    import subprocess
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

    from GameSentenceMiner import obs
    from GameSentenceMiner.obs import check_obs_folder_is_correct
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
    from GameSentenceMiner.util.platform.hotkey import hotkey_manager
    from GameSentenceMiner.util.text_log import TextSource, game_log, get_all_lines

    try:
        from pystray import Icon, Menu, MenuItem
    except Exception:
        Icon = None
        Menu = None
        MenuItem = None

    if is_windows():
        import win32api
except Exception as exc:
    handle_error_in_initialization(exc)
    raise SystemExit(1)

warnings.simplefilter("ignore", DeprecationWarning)

if os.name == "nt":
    # Ensure multiprocessing child workers reuse the current launched executable path.
    try:
        mp.set_executable(sys.executable)
    except Exception:
        pass


_TRUTHY_ENV_VALUES = {"1", "true", "yes", "on"}


def _is_running_under_electron() -> bool:
    return os.getenv("GSM_ELECTRON", "").strip().lower() in _TRUTHY_ENV_VALUES


def _get_anki_module():
    from GameSentenceMiner import anki

    return anki


def _get_qt_main_module():
    from GameSentenceMiner.ui import qt_main

    return qt_main


def _get_gametext_module():
    from GameSentenceMiner import gametext

    return gametext


def _get_replay_handler_module():
    from GameSentenceMiner import replay_handler

    return replay_handler


def _get_overlay_coords_module():
    from GameSentenceMiner.util.overlay import get_overlay_coords

    return get_overlay_coords


def _get_window_state_monitor_module():
    from GameSentenceMiner.util.platform import window_state_monitor

    return window_state_monitor


def _get_vad_processor():
    from GameSentenceMiner.vad import vad_processor

    return vad_processor


def _get_texthooking_page_module():
    from GameSentenceMiner.web import texthooking_page

    return texthooking_page


def _get_websocket_manager():
    from GameSentenceMiner.web.gsm_websocket import websocket_manager

    return websocket_manager


def _set_audio_callback(callback) -> None:
    from GameSentenceMiner.web.service import set_get_audio_from_video_callback

    set_get_audio_from_video_callback(callback)


def _get_run_text_hooker_page():
    from GameSentenceMiner.web.texthooking_page import run_text_hooker_page

    return run_text_hooker_page


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

    def custom_exception_handler(self, loop, context):
        message = context.get("message", "")
        if "Task was destroyed but it is pending" in message:
            return

        loop.default_exception_handler(context)

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        loop.set_exception_handler(self.custom_exception_handler)
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
    """System-tray icon manager.

    On macOS, AppKit requires ``NSWindow`` (and related objects) to be
    instantiated on the main thread.  ``pystray``'s darwin backend creates
    ``NSStatusBar`` items inside ``Icon.__init__``, so we **cannot** construct
    the icon on a background thread.

    The solution uses ``Icon.run_detached()`` on macOS: the icon is created on
    the *main* thread (before Qt's ``app.exec()`` takes over) and the Qt event
    loop processes Cocoa events for both Qt and pystray.

    On other platforms the original behaviour is preserved: the tray runs in its
    own daemon thread with a blocking ``Icon.run()`` call.
    """

    def __init__(self, app: "GSMApplication"):
        super().__init__(daemon=True)
        self._app = app
        self.icon = None

    # -- public helpers used by GSMApplication --------------------------------

    def setup_detached(self) -> None:
        """Create the tray icon on the **current** (main) thread and call
        ``run_detached``.  Use this on macOS so that AppKit objects are
        created on the main thread while the Qt event loop processes their
        events.
        """
        if not Icon:
            logger.warning("Tray icon functionality is not available.")
            return
        self._build_icon()
        self.icon.run_detached()

    # -- threading.Thread overrides -------------------------------------------

    def run(self) -> None:
        if not Icon:
            logger.warning("Tray icon functionality is not available.")
            return
        self._run_tray()

    def _run_tray(self) -> None:
        if not Icon:
            logger.warning("Tray icon functionality is not available.")
            return

        self._build_icon()
        self.icon.run()

    def _build_icon(self) -> None:
        """Construct the pystray ``Icon`` and assign it to ``self.icon``.

        Separated from ``_run_tray`` so that ``setup_detached`` (macOS) can
        create the icon on the main thread without entering a blocking
        ``Icon.run()`` loop.
        """
        self.icon = Icon(
            "TrayApp",
            self._app.create_image(),
            "GameSentenceMiner",
            self._build_menu(),
        )

    def update_icon(self) -> None:
        if not self.icon:
            return
        self.icon.menu = self._build_menu()
        self.icon.update_menu()

    def _build_profile_menu(self):
        return Menu(
            *[
                MenuItem(
                    (
                        "Active: "
                        if profile == get_master_config().current_profile
                        else ""
                    )
                    + profile,
                    self.switch_profile,
                )
                for profile in get_master_config().get_all_profile_names()
            ]
        )

    def _build_menu(self):
        menu_items = [
            MenuItem("Open Settings", self._app.open_settings, default=True),
            MenuItem("Open Texthooker", self._app.open_texthooker),
            Menu.SEPARATOR,
            MenuItem("Switch Profile", self._build_profile_menu()),
        ]

        if is_dev:
            test_menu = Menu(
                MenuItem("Anki Confirmation Dialog", self._app.test_anki_confirmation),
                MenuItem("Screenshot Selector", self._app.test_screenshot_selector),
                MenuItem("Furigana Filter Preview", self._app.test_furigana_filter),
                MenuItem("Area Selector", self._app.test_area_selector),
                MenuItem("Screen Cropper", self._app.test_screen_cropper),
            )
            menu_items.append(MenuItem("Test Windows", test_menu))

        menu_items.extend([Menu.SEPARATOR, MenuItem("Exit", self._app.exit_program)])
        return Menu(*menu_items)

    def switch_profile(self, icon, item) -> None:
        if not self.icon:
            return
        if "Active:" in item.text:
            logger.error("You cannot switch to the currently active profile!")
            return
        self._app.switch_profile(item.text)

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
        self._replay_extractor = _get_replay_handler_module().ReplayAudioExtractor()
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
        overlay_coords = _get_overlay_coords_module()

        def call_overlay_processor():
            overlay_processor = overlay_coords.get_overlay_processor()
            loop = overlay_processor.processing_loop
            if loop and loop.is_running():
                logger.info("Manually triggering overlay scan via hotkey.")
                asyncio.run_coroutine_threadsafe(
                    overlay_processor.find_box_and_send_to_overlay(source=TextSource.HOTKEY),
                    loop,
                )
            else:
                logger.warning("Overlay loop not ready yet.")

        hotkey_manager.register(
            lambda: get_config().hotkeys.play_latest_audio, self.play_most_recent_audio
        )
        hotkey_manager.register(
            lambda: get_config().hotkeys.manual_overlay_scan, call_overlay_processor
        )

        if is_windows():
            hotkey_manager.register(
                lambda: get_config().hotkeys.process_pause,
                _get_window_state_monitor_module().toggle_active_game_pause,
            )

    def create_image(self) -> Image.Image:
        image_path = os.path.join(os.path.dirname(__file__), "assets", "pickaxe.png")
        return Image.open(image_path)

    def open_settings(
        self, *args, root_tab_key: str = "", subtab_key: str = ""
    ) -> None:
        obs.update_current_game()
        if self.state.settings_window:
            self.state.settings_window.show_window(
                root_tab_key=root_tab_key,
                subtab_key=subtab_key,
            )

    def play_most_recent_audio(self) -> None:
        if (
            get_config().advanced.audio_player_path
            or get_config().advanced.video_player_path
        ) and len(get_all_lines()) > 0:
            gsm_state.line_for_audio = get_all_lines()[-1]
            obs.save_replay_buffer()
        else:
            logger.error(
                "Feature Disabled. No audio or video player path set in config!"
            )

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
        self.open_texthooker()

    def open_texthooker(self, *args) -> None:
        _get_texthooking_page_module().open_texthooker()

    def switch_profile(self, profile_name: str) -> None:
        logger.info(f"Switching to profile: {profile_name}")
        get_master_config().current_profile = profile_name
        switch_profile_and_save(profile_name)
        if self.state.settings_window:
            self.state.settings_window.reload_settings()

    def test_anki_confirmation(self, *args) -> None:
        from GameSentenceMiner.ui.qt_main import launch_anki_confirmation
        from GameSentenceMiner.util.models.model import VADResult

        gsm_state.current_replay = (
            r"C:\Users\Beangate\Videos\GSM\Replay 2025-11-06 17-46-52.mp4"
        )
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

    def test_screenshot_selector(self, *args) -> None:
        from GameSentenceMiner.ui.qt_main import launch_screenshot_selector

        gsm_state.current_replay = (
            r"C:\Users\Beangate\Videos\GSM\Replay 2025-11-06 17-46-52.mp4"
        )
        result = launch_screenshot_selector(gsm_state.current_replay, 10, "middle")
        print(f"Screenshot Selector Result: {result}")

    def test_furigana_filter(self, *args) -> None:
        from GameSentenceMiner.ui.qt_main import launch_furigana_filter_preview

        result = launch_furigana_filter_preview(current_sensitivity=50)
        print(f"Furigana Filter Result: {result}")

    def test_area_selector(self, *args) -> None:
        from GameSentenceMiner.ui.qt_main import launch_area_selector

        result = launch_area_selector(window_name="", use_obs_screenshot=True)
        print(f"Area Selector Result: {result}")

    def test_screen_cropper(self, *args) -> None:
        from GameSentenceMiner.ui.qt_main import launch_screen_cropper

        result = launch_screen_cropper()
        print(f"Screen Cropper Result: {result}")

    def exit_program(self, icon=None, item=None) -> None:
        logger.info("Exiting...")
        if icon:
            icon.stop()
        send_message("python_exit_requested", {"source": "pickaxe_icon"})
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

            _get_websocket_manager().stop_all()
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
                        logger.warning(
                            f"Process {proc.args[0]} didn't terminate in time, killing..."
                        )
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

            _get_window_state_monitor_module().cleanup_suspended_processes()
            _get_qt_main_module().shutdown_qt_app()
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
        observer.schedule(
            _get_replay_handler_module().ReplayFileWatcher(self._replay_extractor),
            watch_path,
            recursive=False,
        )
        observer.start()
        self.state.file_watcher_observer = observer
        self.state.file_watcher_path = watch_path
        logger.background(f"File watcher started for: {watch_path}")

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
                    os.environ["PATH"] += os.pathsep + os.path.dirname(
                        get_ffmpeg_path()
                    )
            if is_mac():
                if shutil.which("ffmpeg") is None:
                    os.environ["PATH"] += os.pathsep + "/opt/homebrew/bin"

            try:
                from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup
                from GameSentenceMiner.util.database.db import GameLinesTable
                from GameSentenceMiner.util.database.stats_rollup_table import (
                    StatsRollupTable,
                )

                first_rollup = StatsRollupTable.get_first_date()
                has_game_lines = (
                    GameLinesTable._db.fetchone(
                        f"SELECT COUNT(*) FROM {GameLinesTable._table}"
                    )[0]
                    > 0
                )

                if has_game_lines and not first_rollup:
                    logger.info(
                        "Detected existing data without rollup table - running initial rollup generation..."
                    )
                    logger.info(
                        "This is a one-time migration for version upgrades. Please wait..."
                    )
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

            _set_audio_callback(self._replay_extractor.get_audio)

        self.initial_checks()
        start_ipc_listener_in_thread()
        register_command_handler(self.handle_ipc_command)
        announce_connected()

    def start_background_threads(self) -> None:
        anki = _get_anki_module()
        self._start_thread(anki.start_monitoring_anki, "anki-monitor")
        if get_config().paths.output_folder:
            self._start_thread(
                anki.migrate_old_word_folders, "anki-migrate-old-folders"
            )

        if is_gsm_cloud_preview_enabled():
            gsm_cloud_auth_cache_service.start_background_loop()
            cloud_sync_service.start_background_loop()
        self._start_thread(_get_run_text_hooker_page(), "texthooker-page")

    def handle_ipc_command(self, cmd: dict) -> None:
        logger.background(f"IPC Command Received: {cmd}")
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
                data = cmd.get("data") if isinstance(cmd, dict) else {}
                if not isinstance(data, dict):
                    data = {}
                self.open_settings(
                    root_tab_key=str(data.get("root_tab_key") or ""),
                    subtab_key=str(data.get("subtab_key") or ""),
                )
            elif function == FunctionName.OPEN_OVERLAY_SETTINGS.value:
                from GameSentenceMiner.web.gsm_websocket import (
                    request_overlay_settings_open,
                )

                request_overlay_settings_open()
            elif function == FunctionName.OPEN_TEXTHOOKER.value:
                self.open_texthooker()
            elif function == FunctionName.SWITCH_PROFILE.value:
                data = cmd.get("data") if isinstance(cmd, dict) else {}
                if not isinstance(data, dict):
                    data = {}
                profile_name = str(data.get("profile_name") or "").strip()
                if profile_name:
                    self.switch_profile(profile_name)
            elif function == FunctionName.OPEN_LOG.value:
                self.open_log()
            elif function == FunctionName.TOGGLE_REPLAY_BUFFER.value:
                obs.toggle_replay_buffer()
            elif function == FunctionName.RESTART_OBS.value:
                self.restart_obs()
            elif function == FunctionName.TEST_ANKI_CONFIRMATION.value:
                self.test_anki_confirmation()
            elif function == FunctionName.TEST_SCREENSHOT_SELECTOR.value:
                self.test_screenshot_selector()
            elif function == FunctionName.TEST_FURIGANA_FILTER.value:
                self.test_furigana_filter()
            elif function == FunctionName.TEST_AREA_SELECTOR.value:
                self.test_area_selector()
            elif function == FunctionName.TEST_SCREEN_CROPPER.value:
                self.test_screen_cropper()
            elif function == FunctionName.EXIT.value:
                self.cleanup()
                sys.exit(0)
            elif function == FunctionName.CONNECT.value:
                logger.debug("Electron reported connect")
            else:
                logger.background(f"Unknown IPC command: {cmd}")
        except Exception as e:
            logger.background(f"Error handling IPC command: {e}")

    def get_previous_lines_for_game(self) -> None:
        previous_lines = set()
        try:
            all_lines = db.GameLinesTable.get_all_lines_for_scene(
                obs.get_current_scene()
            )
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
        logger.background("Post-Initialization started.")

        if gsm_status.obs_connected:
            await check_obs_folder_is_correct()
            self.on_config_changed()
        elif not get_config().obs.open_obs:
            self.on_config_changed()

        self.start_file_watcher()
        await _get_overlay_coords_module().init_overlay_processor()
        _get_window_state_monitor_module().cleanup_suspended_processes()
        _get_vad_processor().init()

        if not self._obs_connect_task or self._obs_connect_task.done():
            self._obs_connect_task = asyncio.create_task(
                self._connect_obs_when_available()
            )

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
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            pass

    async def start_text_monitor_async(self) -> None:
        await _get_gametext_module().start_text_monitor()

    def _wait_for_startup_ready(
        self, timeout: float = 20.0, interval: float = 0.1
    ) -> None:
        wait_for_obs = bool(get_config().obs.open_obs)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and gsm_state.keep_running:
            text_monitor_ready = _get_gametext_module().is_text_monitor_initialized()
            obs_ready = (not wait_for_obs) or gsm_status.obs_connected
            if text_monitor_ready and obs_ready:
                return
            time.sleep(interval)

    def _announce_startup_ready(self) -> None:
        self._wait_for_startup_ready()
        if not gsm_state.keep_running:
            return

        logger.success("GSM Loaded. Happy Mining! がんばれ！")
        logger.info("-" * 84)
        from GameSentenceMiner.util.platform import notification

        notification.send_notification(
            "GSM Ready",
            "GSM Loaded. Happy Mining! がんばれ！",
            5,
        )

    async def check_if_script_is_running(self) -> bool:
        if os.path.exists(os.path.join(get_app_directory(), "current_pid.txt")):
            with open(os.path.join(get_app_directory(), "current_pid.txt"), "r") as f:
                pid = int(f.read().strip())
                if (
                    psutil.pid_exists(pid)
                    and "python" in psutil.Process(pid).name().lower()
                ):
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

        self.state.settings_window = _get_qt_main_module().get_config_window()
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

        if Icon and not _is_running_under_electron():
            if is_mac():
                # macOS requires AppKit objects (NSStatusBar, NSWindow, etc.)
                # to be created on the main thread.  Use run_detached() so that
                # the Qt event loop (also on the main thread) processes Cocoa
                # events for both Qt and the pystray status-bar item.
                self._tray.setup_detached()
            else:
                self._tray.start()
        elif Icon and _is_running_under_electron():
            logger.info("Skipping pystray tray icon because GSM is running under Electron.")

        send_message(FunctionName.INITIALIZED.value, {"status": "ready"})
        self._start_thread(self._announce_startup_ready, "startup-ready-announcer")
        _get_qt_main_module().start_qt_app(
            show_config_immediately=get_config().general.open_config_on_startup
        )


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
