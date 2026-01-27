import time
import asyncio
from GameSentenceMiner.util.configuration import get_config, logger

class SleepManager:
    def __init__(self, initial_delay=1.0, backoff_factor=1.5, name="Generic"):
        self.initial_delay = initial_delay
        self.current_delay = initial_delay
        self.backoff_factor = backoff_factor
        self.name = name

    def _get_max_delay(self):
        # Always fetch latest config
        return get_config().advanced.longest_sleep_time

    def reset(self):
        self.current_delay = self.initial_delay

    def sleep(self):
        max_delay = self._get_max_delay()
        # logger.debug(f"SleepManager '{self.name}' sleeping for {self.current_delay:.2f}s (Max: {max_delay:.2f}s)")
        time.sleep(self.current_delay)
        self.current_delay = min(self.current_delay * self.backoff_factor, max_delay)

    async def async_sleep(self):
        max_delay = self._get_max_delay()
        # logger.debug(f"SleepManager '{self.name}' async sleeping for {self.current_delay:.2f}s (Max: {max_delay:.2f}s)")
        await asyncio.sleep(self.current_delay)
        self.current_delay = min(self.current_delay * self.backoff_factor, max_delay)
