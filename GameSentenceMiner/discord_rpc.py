import asyncio
import threading
import time

from pypresence import Presence, PyPresenceException

from GameSentenceMiner.live_stats import live_stats_tracker
from GameSentenceMiner.util.configuration import get_config, logger


# Decorator to guard methods if self.DISABLED is True
def disabled_guard(method):
    def wrapper(self, *args, **kwargs):
        if getattr(self, "DISABLED", False):
            return
        return method(self, *args, **kwargs)

    return wrapper


class DiscordRPCManager:
    def __init__(self):
        self.client_id = "1441571345942052935"  # Public GSM App ID
        self.rpc = None
        self.rpc_thread = None
        self.running = False
        self.last_game_name = None
        self.start_time = None
        self.current_cph = 0
        self.stop_timer = None
        # Flag to disable all functionality, to release this feature, change this to False
        self.DISABLED = False

    @disabled_guard
    def _run(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        while self.running:
            try:
                if not self.rpc:
                    self.rpc = Presence(self.client_id, pipe=0)
                    self.rpc.connect()
                    logger.info("Discord RPC connected.")

                self.current_cph = live_stats_tracker.get_chars_per_hour()

                if self.last_game_name:
                    state_message = "Mining sentences..."
                    if self.current_cph > 0:
                        state_message = f"{self.current_cph:,} char/hr"

                    self.rpc.update(
                        name=f"GSM: {self.last_game_name}",
                        details="Mining with GameSentenceMiner...",
                        state=state_message,
                        start=self.start_time,
                        large_image="gsm_cute",
                        large_text="GameSentenceMiner",
                    )
                else:
                    self.rpc.update(
                        details="GameSentenceMiner",
                        state="Waiting for game...",
                        start=self.start_time,
                        large_image="gsm_cute",
                        large_text="GameSentenceMiner",
                    )
                time.sleep(15)  # Discord RPC updates are limited to every 15 seconds
            except PyPresenceException as e:
                logger.warning(f"Discord RPC connection error: {e}. Retrying in 20s.")
                self.stop_rpc_instance()
                time.sleep(20)
            except Exception as e:
                logger.error(
                    f"An unexpected error occurred in Discord RPC thread: {e}",
                    exc_info=True,
                )
                self.running = False

    @disabled_guard
    def start(self):
        if not get_config().features.discord_rpc_enable:
            return
        if not self.running:
            self.running = True
            self.start_time = int(time.time())
            self.rpc_thread = threading.Thread(target=self._run, daemon=True)
            self.rpc_thread.start()
            logger.info("Discord RPC thread started.")

    @disabled_guard
    def update(self, game_name):
        if not get_config().features.discord_rpc_enable:
            return
        if not self.running:
            self.start()

        if self.stop_timer:
            self.stop_timer.cancel()
        self.stop_timer = threading.Timer(120, self._stop_rpc_due_to_inactivity)
        self.stop_timer.start()

        if game_name and game_name != self.last_game_name:
            logger.info(f"Updating Discord RPC for game: {game_name}")
            self.last_game_name = game_name
            # The running thread will pick up the new game name

    @disabled_guard
    def _stop_rpc_due_to_inactivity(self):
        logger.info("Stopping Discord RPC due to 2 minutes of inactivity.")
        self.stop()

    @disabled_guard
    def stop(self):
        if self.running:
            if self.stop_timer:
                self.stop_timer.cancel()
                self.stop_timer = None
            logger.info("Stopping Discord RPC.")
            self.running = False
            self.stop_rpc_instance()
            if self.rpc_thread and self.rpc_thread.is_alive():
                self.rpc_thread.join(timeout=5)
            self.rpc_thread = None
            self.last_game_name = None
            self.start_time = None
            live_stats_tracker.reset()

    @disabled_guard
    def stop_rpc_instance(self):
        if self.rpc:
            try:
                self.rpc.close()
            except Exception as e:
                logger.warning(f"Error closing Discord RPC: {e}")
            finally:
                self.rpc = None


# Singleton instance
discord_rpc_manager = DiscordRPCManager()
