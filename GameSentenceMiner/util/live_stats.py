import time
from GameSentenceMiner.util.configuration import get_stats_config, save_stats_config
from GameSentenceMiner.util.db import punctuation_regex, repeating_chars_regex

class LiveSessionTracker:
    """
    Tracks reading statistics for the current live session on the fly.
    This includes character count and active reading time, which is used
    to calculate characters per hour.

    Supports three AFK detection modes:
    - 'fixed': Uses a fixed afk_timer_seconds threshold
    - 'character_aware': Uses character-based heuristic (Algorithm 1)
    - 'adaptive': Uses EMA-based adaptive threshold (Algorithm 2)
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
        self.prev_char_count = 0  # Track previous line's char count for AFK detection

    def _get_afk_threshold(self, char_count: int, config) -> float:
        """
        Get the appropriate AFK threshold based on detection mode.

        Args:
            char_count: Number of characters in the previous line
            config: StatsConfig instance

        Returns:
            float: Threshold in seconds
        """
        mode = config.afk_detection_mode

        if mode == 'fixed':
            return float(config.afk_timer_seconds)

        if char_count <= 0:
            return config.afk_min_threshold

        if mode == 'character_aware':
            # Algorithm 1: Character-based heuristic
            threshold = char_count * config.afk_char_multiplier
            return max(config.afk_min_threshold, min(threshold, config.afk_max_threshold))

        # 'adaptive' mode: Use EMA if warmed up, otherwise fallback to Algorithm 1
        if config.afk_ema_sample_count >= config.afk_min_samples and config.afk_ema_time_per_char > 0:
            # Algorithm 2: EMA-based adaptive threshold
            threshold = char_count * config.afk_ema_time_per_char * config.afk_anomaly_multiplier
            return max(config.afk_min_threshold, min(threshold, config.afk_max_threshold))
        else:
            # Warmup period: use Algorithm 1
            threshold = char_count * config.afk_char_multiplier
            return max(config.afk_min_threshold, min(threshold, config.afk_max_threshold))

    def _update_ema(self, time_per_char: float, config) -> None:
        """
        Update the EMA with a new reading and persist to config.

        Args:
            time_per_char: Time per character for the current reading
            config: StatsConfig instance
        """
        if config.afk_ema_time_per_char <= 0:
            # First sample: use current value directly
            config.afk_ema_time_per_char = time_per_char
        else:
            # EMA update: α × current + (1-α) × previous
            config.afk_ema_time_per_char = (
                config.afk_ema_alpha * time_per_char +
                (1 - config.afk_ema_alpha) * config.afk_ema_time_per_char
            )

        config.afk_ema_sample_count += 1
        save_stats_config(config)

    def add_line(self, line_text: str, timestamp: float):
        """
        Adds a new line to the tracker, updating character counts and
        calculating active reading time based on gaps between lines.

        Uses character-aware AFK detection when enabled, adapting the
        threshold based on the previous line's length and learned reading speed.
        """
        config = get_stats_config()

        if self.last_line_time:
            gap = timestamp - self.last_line_time
            # If the gap between lines exceeds the session gap, reset stats.
            if gap > config.session_gap_seconds:
                self.reset()
            else:
                # Get threshold based on detection mode and previous line's char count
                threshold = self._get_afk_threshold(self.prev_char_count, config)

                # Update EMA if in adaptive mode and this is NOT an AFK gap
                if config.afk_detection_mode == 'adaptive' and gap <= threshold and self.prev_char_count > 0:
                    time_per_char = gap / self.prev_char_count
                    # Only update EMA if the reading speed is reasonable
                    # (avoid outliers from very short lines or very fast clicks)
                    if time_per_char > 0.01 and time_per_char < 10.0:  # 0.01s to 10s per char
                        self._update_ema(time_per_char, config)

                # Add the time since the last line to the total reading time,
                # but cap it at the calculated threshold to exclude long pauses.
                self.total_reading_seconds += min(gap, threshold)
        else:
            # This is the first line of a new session.
            self.session_start_time = timestamp

        line_text = punctuation_regex.sub('', line_text).strip()
        if config.regex_out_repetitions:
            line_text = repeating_chars_regex.sub(r'\1\1\1', line_text)

        self.last_line_time = timestamp
        char_count = len(line_text) if line_text else 0
        self.total_characters += char_count
        self.prev_char_count = char_count  # Store for next gap calculation

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
