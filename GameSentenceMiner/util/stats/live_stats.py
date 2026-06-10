import time

from GameSentenceMiner.util.config.configuration import get_stats_config
from GameSentenceMiner.util.database.db import clean_text_for_stats
from GameSentenceMiner.util.stats.stats_util import (
    MAX_SEC_PER_CHAR,
    FLOOR_SECONDS,
    ABSOLUTE_CEILING,
)


LIVE_STATS_UPDATE_TYPE = "live_stats_update"

LIVE_STATS_FIELDS = (
    {
        "key": "chars_per_hour",
        "label": "Chars/hour",
        "format": "integer",
        "default_visible": True,
    },
    {
        "key": "total_characters",
        "label": "Characters",
        "format": "integer",
        "default_visible": True,
    },
    {
        "key": "active_reading_time",
        "label": "Active time",
        "format": "duration",
        "default_visible": True,
    },
    {
        "key": "raw_reading_time",
        "label": "Raw time",
        "format": "duration",
        "default_visible": True,
    },
    {
        "key": "cards_mined",
        "label": "Cards mined",
        "format": "integer",
        "default_visible": True,
    },
)


def get_live_stats_field_options() -> list[dict]:
    """Return user-selectable live stats fields for overlay display."""
    return [dict(field) for field in LIVE_STATS_FIELDS]


def build_live_stats_payload(
    tracker: "LiveSessionTracker",
    *,
    reason: str = "update",
    now: float | None = None,
) -> dict:
    """Build a serializable live stats snapshot for overlay consumers."""
    updated_at = time.time() if now is None else float(now)
    return {
        "type": LIVE_STATS_UPDATE_TYPE,
        "reason": reason,
        "updated_at": updated_at,
        "session_active": tracker.last_line_time is not None,
        "session_start_time": tracker.session_start_time,
        "last_line_time": tracker.last_line_time,
        "fields": get_live_stats_field_options(),
        "values": {
            "chars_per_hour": tracker.get_chars_per_hour(),
            "total_characters": tracker.get_total_chars(),
            "active_reading_time": round(tracker.get_active_reading_time(), 1),
            "raw_reading_time": round(tracker.get_raw_reading_time(), 1),
            "cards_mined": tracker.get_cards_mined(),
        },
    }


def publish_live_stats_update(
    tracker: "LiveSessionTracker",
    *,
    reason: str = "update",
) -> bool:
    """Publish a live stats snapshot to overlay websocket clients if available."""
    try:
        from GameSentenceMiner.web.gsm_websocket import ID_OVERLAY, websocket_manager

        if not websocket_manager.has_clients(ID_OVERLAY):
            return False

        websocket_manager.send_nowait(
            ID_OVERLAY,
            build_live_stats_payload(tracker, reason=reason),
        )
        return True
    except Exception:
        return False


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
        self.last_line_text = None
        self.total_characters = 0
        self.total_reading_seconds = 0.0
        self.session_start_time = None
        self.times_mined = 0

    def add_line(self, line_text: str, timestamp: float):
        """
        Adds a new line to the tracker, updating character counts and
        calculating active reading time based on gaps between lines.

        Uses adaptive per-line cap: the maximum time credited for a gap
        is proportional to the character count of the *previous* line,
        with a floor for short/empty lines and an absolute ceiling.
        """
        if self.last_line_time:
            gap = timestamp - self.last_line_time
            # If the gap between lines exceeds the session gap, reset stats.
            if gap > get_stats_config().session_gap_seconds:
                self.reset()
                # This line starts a fresh session; raw time counts from here.
                self.session_start_time = timestamp
            else:
                # Adaptive cap based on the previous line's character count.
                prev_char_count = len(self.last_line_text) if self.last_line_text else 0
                max_time = max(FLOOR_SECONDS, prev_char_count * MAX_SEC_PER_CHAR)
                max_time = min(max_time, ABSOLUTE_CEILING)
                self.total_reading_seconds += min(gap, max_time)
        else:
            # This is the first line of a new session.
            self.session_start_time = timestamp

        # Store raw text before cleanup for adaptive cap calculation on next line.
        self.last_line_text = line_text
        self.last_line_time = timestamp

        stats_config = get_stats_config()
        line_text = clean_text_for_stats(
            line_text,
            regex_out_repetitions=getattr(stats_config, "regex_out_repetitions", False),
            extra_punctuation_regex=getattr(stats_config, "extra_punctuation_regex", ""),
        )

        self.total_characters += len(line_text) if line_text else 0
        publish_live_stats_update(self, reason="line")

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

    def get_raw_reading_time(self) -> float:
        """Returns raw wall-clock session length (first to last line) in seconds.

        Unlike active reading time, this is not AFK-capped. The widget ticks
        this forward live from session_start_time while a session is active.
        """
        if self.session_start_time is None or self.last_line_time is None:
            return 0.0
        return max(0.0, self.last_line_time - self.session_start_time)

    def add_mined_line(self):
        """Increments the count of lines mined in this session."""
        self.times_mined += 1
        publish_live_stats_update(self, reason="mined")
        try:
            from GameSentenceMiner.web.live_goals import publish_live_goals_update

            publish_live_goals_update()
        except Exception:
            pass


# Singleton instance to be used across the application
live_stats_tracker = LiveSessionTracker()
