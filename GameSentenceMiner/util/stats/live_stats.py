import time

from GameSentenceMiner.util.config.configuration import get_stats_config
from GameSentenceMiner.util.database.db import clean_text_for_stats
from GameSentenceMiner.util.stats.stats_util import (
    MAX_SEC_PER_CHAR,
    FLOOR_SECONDS,
    ABSOLUTE_CEILING,
    MIN_CHARS_FOR_SPEED,
    MIN_LINES_FOR_CPH,
    adaptive_cap_seconds,
    _median,
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
        # Cleaned char count of the last line, credited when the next line arrives.
        self.last_line_chars = 0
        self.total_characters = 0
        self.total_reading_seconds = 0.0
        self.session_start_time = None
        self.times_mined = 0
        self.lines_count = 0
        # v2: per-line raw reading speeds (chars/sec) for the adaptive cap.
        self._speed_samples: list[float] = []

    def _credit_gap(self, gap: float):
        """Credit the time spent reading the previous line, capped per the active algorithm."""
        prev_char_count = len(self.last_line_text) if self.last_line_text else 0
        if get_stats_config().reading_time_adaptive_v2:
            # v2: cap the gap by the session's own median reading speed.
            if prev_char_count >= MIN_CHARS_FOR_SPEED and gap > 0:
                self._speed_samples.append(prev_char_count / gap)
            max_time = adaptive_cap_seconds(prev_char_count, _median(self._speed_samples))
        else:
            # v1: fixed seconds-per-char cap on the previous line.
            max_time = max(FLOOR_SECONDS, prev_char_count * MAX_SEC_PER_CHAR)
            max_time = min(max_time, ABSOLUTE_CEILING)
        self.total_reading_seconds += min(gap, max_time)

    def add_line(self, line_text: str, timestamp: float):
        """
        Adds a new line to the tracker, updating character counts and
        calculating active reading time based on gaps between lines.

        A line's reading time *and* characters are only credited once the next
        line arrives (i.e. when the reader is "done" with it). Crediting them
        together keeps read speed from spiking the instant a huge line appears.

        The maximum time credited for a gap is capped per the active algorithm
        (v1 fixed seconds-per-char, or v2 adaptive to session median speed).
        """
        stats_config = get_stats_config()
        if self.last_line_time:
            gap = timestamp - self.last_line_time
            # If the gap between lines exceeds the session gap, reset stats.
            if gap > stats_config.session_gap_seconds:
                self.reset()
                # This line starts a fresh session; raw time counts from here.
                self.session_start_time = timestamp
            else:
                # Previous line is now done: credit its time and characters together.
                self._credit_gap(gap)
                self.total_characters += self.last_line_chars
        else:
            # This is the first line of a new session.
            self.session_start_time = timestamp

        self.lines_count += 1

        # Store raw text (for the adaptive cap) and the cleaned char count; both
        # are credited when the next line arrives, not now.
        self.last_line_text = line_text
        cleaned = clean_text_for_stats(
            line_text,
            regex_out_repetitions=getattr(stats_config, "regex_out_repetitions", False),
            extra_punctuation_regex=getattr(stats_config, "extra_punctuation_regex", ""),
        )
        self.last_line_chars = len(cleaned) if cleaned else 0
        self.last_line_time = timestamp

        publish_live_stats_update(self, reason="line")
        # Keep overlay goals advancing while reading (throttled inside the publisher).
        try:
            from GameSentenceMiner.web.live_goals import publish_live_goals_update

            publish_live_goals_update()
        except Exception:
            pass

    def get_chars_per_hour(self) -> int:
        """
        Calculates and returns the characters per hour for the current session.
        Returns 0 if not enough reading time has been logged.
        """
        # Require at least a few seconds of reading to get a stable CPH.
        if self.total_reading_seconds <= 5:
            return 0
        # v2 anti-spike guard: also require enough lines so a freshly-reset
        # session (e.g. returning from AFK) doesn't flash a bogus huge cph.
        if get_stats_config().reading_time_adaptive_v2 and self.lines_count < MIN_LINES_FOR_CPH:
            return 0
        hours = self.total_reading_seconds / 3600
        return int(self.total_characters / hours)

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

            # Force past the throttle so a mined-cards goal updates immediately.
            publish_live_goals_update(force=True)
        except Exception:
            pass


# Singleton instance to be used across the application
live_stats_tracker = LiveSessionTracker()
