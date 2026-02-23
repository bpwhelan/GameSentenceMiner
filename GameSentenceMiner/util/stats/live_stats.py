import time

from GameSentenceMiner.util.config.configuration import get_stats_config
from GameSentenceMiner.util.database.db import punctuation_regex, repeating_chars_regex


class LiveSessionTracker:
    """
    Tracks reading statistics for the current live session on the fly.
    This includes character count and active reading time, which is used
    to calculate characters per hour.
    """
    def __init__(self):
        self.reset()

    def reset(self):
        """Resets all session statistics."""
        self.last_line_time = None
        self.total_characters = 0
        self.total_reading_seconds = 0.0
        self.session_start_time = None
        self.times_mined = 0

    def add_line(self, line_text: str, timestamp: float):
        """
        Adds a new line to the tracker, updating character counts and
        calculating active reading time based on gaps between lines.
        """
        if self.last_line_time:
            gap = timestamp - self.last_line_time
            # If the gap between lines exceeds the session gap, reset stats.
            if gap > get_stats_config().session_gap_seconds:
                self.reset()
            else:
                # Add the time since the last line to the total reading time,
                # but cap it at the AFK threshold to exclude long pauses.
                self.total_reading_seconds += min(gap, get_stats_config().afk_timer_seconds)
        else:
            # This is the first line of a new session.
            self.session_start_time = timestamp
            
        line_text = punctuation_regex.sub('', line_text).strip()
        if get_stats_config().regex_out_repetitions:
            line_text = repeating_chars_regex.sub(r'\1\1\1', line_text)

        self.last_line_time = timestamp
        self.total_characters += len(line_text) if line_text else 0

    def get_chars_per_hour(self) -> int:
        """
        Calculates and returns the characters per hour for the current session.
        Returns 0 if not enough reading time has been logged.
        """
        # Require at least a few seconds of reading to get a stable CPH.
        if self.total_reading_seconds > 5:
            hours = self.total_reading_seconds / 3600
            return int(self.total_characters / hours)
        return 0
    
    def get_total_chars(self) -> int:
        """Returns the total characters read in this session."""
        return self.total_characters
    
    def get_cards_mined(self) -> int:
        """Returns the number of cards mined in this session."""
        return self.times_mined
    
    def get_active_reading_time(self) -> float:
        """Returns the active reading time in seconds for this session."""
        return self.total_reading_seconds
    
    def add_mined_line(self):
        """Increments the count of lines mined in this session."""
        self.times_mined += 1

# Singleton instance to be used across the application
live_stats_tracker = LiveSessionTracker()
