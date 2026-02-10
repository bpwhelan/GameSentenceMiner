import asyncio
import threading
import time
from pypresence import Presence, PyPresenceException

from GameSentenceMiner import obs
from GameSentenceMiner.util.config.configuration import logger, get_master_config
from GameSentenceMiner.util.stats.live_stats import live_stats_tracker


# Decorator to guard methods if self.DISABLED is True
def disabled_guard(method):
    def wrapper(self, *args, **kwargs):
        if getattr(self, 'DISABLED', False):
            return
        return method(self, *args, **kwargs)
    return wrapper

class DiscordRPCManager:
    def __init__(self):
        self.client_id = '1441571345942052935'  # Public GSM App ID
        self.rpc = None
        self.rpc_thread = None
        self.running = False
        self.last_game_name = None
        self.start_time = None
        self.current_cph = 0
        self.stop_timer = None
        # Flag to disable all functionality, to release this feature, change this to False
        self.DISABLED = False

    def _interruptible_sleep(self, duration):
        """Sleep in small chunks so self.running can be checked frequently."""
        end_time = time.time() + duration
        while self.running and time.time() < end_time:
            time.sleep(0.5)  # Check every 0.5 seconds

    @disabled_guard
    def _run(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        while self.running:
            try:
                config = get_master_config()
                discord_config = config.discord
                
                match(discord_config.icon):
                    case "GSM":
                        icon = "gsm"
                    case "Cute":
                        icon = "gsm_cute"
                    case "Jacked":
                        icon = "gsm_jacked"
                    case "Cursed":
                        icon = "gsm_cursed"
                    case _:
                        icon = "gsm"
                
                # Check if Discord RPC is enabled and not in a blacklisted scene
                if not discord_config.enabled:
                    self._interruptible_sleep(discord_config.update_interval)
                    continue
                
                # Check if current scene is blacklisted
                try:
                    current_scene = obs.get_current_scene()
                    if current_scene and current_scene in discord_config.blacklisted_scenes:
                        # Scene is blacklisted, disconnect and wait
                        if self.rpc:
                            self.stop_rpc_instance()
                        self._interruptible_sleep(discord_config.update_interval)
                        continue
                except Exception:
                    pass  # If we can't get scene, continue anyway
                
                if not self.rpc:
                    self.rpc = Presence(self.client_id, pipe=0)
                    self.rpc.connect()
                    logger.success("Discord RPC connected.")
                    self.rpc.clear()

                # Build state message based on config
                state_message = "Mining sentences..."
                if discord_config.show_reading_stats != 'None':
                    if discord_config.show_reading_stats == 'Characters per Hour':
                        self.current_cph = live_stats_tracker.get_chars_per_hour()
                        if self.current_cph > 0:
                            state_message = f"{self.current_cph:,} char/hr"
                    elif discord_config.show_reading_stats == 'Total Characters':
                        total_chars = live_stats_tracker.get_total_chars()
                        if total_chars > 0:
                            state_message = f"{total_chars:,} chars total"
                    elif discord_config.show_reading_stats == 'Cards Mined':
                        cards = live_stats_tracker.get_cards_mined()
                        if cards > 0:
                            state_message = f"{cards:,} cards mined"
                    elif discord_config.show_reading_stats == 'Active Reading Time':
                        reading_time = live_stats_tracker.get_active_reading_time()
                        if reading_time > 0:
                            hours = int(reading_time // 3600)
                            minutes = int((reading_time % 3600) // 60)
                            if hours > 0:
                                state_message = f"{hours}h {minutes}m reading"
                            else:
                                state_message = f"{minutes}m reading"

                if self.last_game_name:
                    self.rpc.update(
                        name=f"{self.last_game_name}",
                        details="Mining with GameSentenceMiner...",
                        state=state_message,
                        start=self.start_time,
                        large_image=icon,
                        large_text="GameSentenceMiner",
                        state_url="https://github.com/bpwhelan/GameSentenceMiner",
                        details_url="https://github.com/bpwhelan/GameSentenceMiner",
                        large_url="https://github.com/bpwhelan/GameSentenceMiner",
                    )
                else:
                    self.rpc.update(
                        details="GameSentenceMiner",
                        state="Waiting for game...",
                        start=self.start_time,
                        large_image=icon,
                        large_text="GameSentenceMiner",
                        state_url="https://github.com/bpwhelan/GameSentenceMiner",
                        details_url="https://github.com/bpwhelan/GameSentenceMiner",
                        large_url="https://github.com/bpwhelan/GameSentenceMiner",
                    )
                self._interruptible_sleep(discord_config.update_interval)
            except PyPresenceException as e:
                # logger.warning(f"Discord RPC connection error: {e}. Retrying in 20s.")
                if self.rpc:
                    self.stop_rpc_instance()
                self._interruptible_sleep(20)
            except Exception as e:
                # logger.error(f"An unexpected error occurred in Discord RPC thread: {e}", exc_info=True)
                self.running = False

    @disabled_guard
    def start(self):
        config = get_master_config()
        if not config.discord.enabled:
            return
        if not self.running:
            self.running = True
            self.start_time = int(time.time())
            self.rpc_thread = threading.Thread(target=self._run, daemon=True)
            self.rpc_thread.start()
            logger.info("Discord RPC thread started.")

    @disabled_guard
    def update(self, game_name):
        config = get_master_config()
        if not config.discord.enabled:
            if self.running:
                self.stop()
            return
        if not self.running:
            self.start()

        # Reset inactivity stop timer when updates arrive
        try:
            inactivity_seconds = int(config.discord.inactivity_timer)
        except Exception:
            inactivity_seconds = 300
        if self.stop_timer:
            try:
                self.stop_timer.cancel()
            except Exception:
                pass
            self.stop_timer = None
        # Schedule stop due to inactivity
        try:
            self.stop_timer = threading.Timer(inactivity_seconds, self._stop_rpc_due_to_inactivity)
            self.stop_timer.start()
        except Exception:
            self.stop_timer = None

        if game_name and game_name != self.last_game_name:
            logger.info(f"Updating Discord RPC for game: {game_name}")
            self.last_game_name = game_name
            # The running thread will pick up the new game name

    @disabled_guard
    def _stop_rpc_due_to_inactivity(self):
        self.stop(inactivity=True)

    @disabled_guard
    def stop(self, inactivity=False):
        if self.running:
            self.clear()
            if self.stop_timer:
                self.stop_timer.cancel()
                self.stop_timer = None
            if inactivity:
                logger.info("Stopping Discord RPC due to inactivity.")
            else:
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
    def clear(self):
        if self.rpc:
            try:
                self.rpc.clear()
            except Exception as e:
                pass

    @disabled_guard
    def stop_rpc_instance(self):
        if self.rpc:
            try:
                self.clear()
                self.rpc.close()
            except Exception as e:
                pass
            finally:
                self.rpc = None

# Singleton instance
discord_rpc_manager = DiscordRPCManager()