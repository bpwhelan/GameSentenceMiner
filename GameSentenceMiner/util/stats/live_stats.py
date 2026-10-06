import time
from datetime import datetime, timedelta, timezone
from datetime import time as datetime_time
from itertools import pairwise
from math import isfinite

from GameSentenceMiner.util.config.configuration import get_stats_config
from GameSentenceMiner.util.database.db import clean_text_for_stats
from GameSentenceMiner.util.stats.stats_util import (
    MIN_LINES_FOR_CPH,
    _median,
    adaptive_cap_seconds,
    count_cards_from_lines,
    reading_speed_sample,
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


def build_today_live_stats_payload(
    tracker: "LiveSessionTracker",
    *,
    reason: str = "refresh",
    now: float | None = None,
) -> dict:
    """Restore the current stats day from saved history, including live revisions.

    This queries the database and must run outside the live text/websocket loop.
    Daily raw time adds session spans, so time between sessions is not counted.
    """
    from GameSentenceMiner.util.database.game_archive import archived_stats_lines
    from GameSentenceMiner.web.stats import calculate_actual_reading_time
    from GameSentenceMiner.web.stats_repository import StatsLineRecord, query_stats_lines

    updated_at = time.time() if now is None else float(now)
    config = get_stats_config()
    rollover_hour = max(0, min(23, int(getattr(config, "day_rollover_hour", 4))))
    local_now = datetime.fromtimestamp(updated_at, timezone.utc).astimezone()
    stats_date = local_now.date()
    if local_now.hour < rollover_hour:
        stats_date -= timedelta(days=1)
    # Construct both local boundaries separately to respect daylight saving time.
    period_start = datetime.combine(stats_date, datetime_time(rollover_hour)).timestamp()
    period_end = datetime.combine(stats_date + timedelta(days=1), datetime_time(rollover_hour)).timestamp()

    lines = query_stats_lines(
        where_clause="timestamp >= ? AND timestamp < ? AND timestamp <= ?",
        params=(period_start, period_end, updated_at),
    )
    lines.extend(archived_stats_lines(period_start, min(period_end, updated_at)))
    by_id = {line.id: line for line in lines if period_start <= line.timestamp < period_end}
    for line_id, text, timestamp in tracker.get_live_lines():
        if not period_start <= timestamp < period_end or timestamp > updated_at:
            continue
        line = by_id.get(line_id)
        if line is None:
            line = StatsLineRecord(line_id, "", "", timestamp=timestamp)
            by_id[line_id] = line
        # Keep the saved mining information when replacing provisional text.
        line.line_text = clean_text_for_stats(
            text,
            regex_out_repetitions=getattr(config, "regex_out_repetitions", False),
            extra_punctuation_regex=getattr(config, "extra_punctuation_regex", ""),
        )

    sorted_lines = sorted(by_id.values(), key=lambda line: line.timestamp)
    timestamps = [line.timestamp for line in sorted_lines]
    texts = [line.line_text or "" for line in sorted_lines]
    total_characters = sum(len(text) for text in texts)
    active_seconds = calculate_actual_reading_time(timestamps, texts)
    raw_seconds = sum(
        gap
        for previous, current in pairwise(timestamps)
        if 0 <= (gap := current - previous) <= config.session_gap_seconds
    )
    last_line_time = tracker.last_line_time
    session_active = (
        last_line_time is not None
        and period_start <= last_line_time <= updated_at
        and updated_at - last_line_time <= config.session_gap_seconds
    )
    if session_active:
        raw_seconds += updated_at - last_line_time

    return {
        "type": LIVE_STATS_UPDATE_TYPE,
        "scope": "today",
        "reason": reason,
        "updated_at": updated_at,
        "period_start": period_start,
        "period_end": period_end,
        "session_active": session_active,
        "session_start_time": tracker.session_start_time,
        "last_line_time": last_line_time,
        "session_expires_at": last_line_time + config.session_gap_seconds if session_active else None,
        "fields": get_live_stats_field_options(),
        "values": {
            "chars_per_hour": int(total_characters * 3600 / active_seconds)
            if active_seconds > 5 and len(sorted_lines) >= MIN_LINES_FOR_CPH
            else 0,
            "total_characters": total_characters,
            "active_reading_time": round(active_seconds, 1),
            "raw_reading_time": round(raw_seconds, 1),
            "cards_mined": count_cards_from_lines(sorted_lines),
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
        self.last_line_id = None
        self._line_ledger: dict[str, dict[str, object]] = {}
        # Per-line raw reading speeds (chars/sec) for the adaptive cap.
        self._speed_samples: list[float] = []

    def reset_if_inactive(self, *, now: float | None = None) -> bool:
        """Expire an idle session without waiting for another line to arrive."""
        if self.last_line_time is None:
            return False
        current_time = time.time() if now is None else float(now)
        if current_time - self.last_line_time <= get_stats_config().session_gap_seconds:
            return False
        self.reset()
        publish_live_stats_update(self, reason="session_timeout")
        return True

    def _credit_gap(self, gap: float):
        """Credit the previous line's reading time, capped at the session's pace."""
        # Use the same cleaned text length as the CPH numerator and batch stats.
        prev_char_count = self.last_line_chars
        speed = reading_speed_sample(gap, prev_char_count)
        if speed is not None:
            self._speed_samples.append(speed)
        max_time = adaptive_cap_seconds(prev_char_count, _median(self._speed_samples))
        self.total_reading_seconds += min(gap, max_time)

    def add_line(
        self,
        line_text: str,
        timestamp: float,
        *,
        line_id: str | None = None,
        revision: int = 1,
    ):
        """
        Adds a new line to the tracker, updating character counts and
        calculating active reading time based on gaps between lines.

        A line's reading time *and* characters are only credited once the next
        line arrives (i.e. when the reader is "done" with it). Crediting them
        together keeps read speed from spiking the instant a huge line appears.

        The maximum time credited for a gap is 2.5 times its expected duration at
        the session's actual median reading speed.
        """
        if not isfinite(timestamp):
            return
        stats_config = get_stats_config()
        cleaned = clean_text_for_stats(
            line_text,
            regex_out_repetitions=getattr(stats_config, "regex_out_repetitions", False),
            extra_punctuation_regex=getattr(stats_config, "extra_punctuation_regex", ""),
        )
        char_count = len(cleaned) if cleaned else 0
        if line_id:
            previous = self._line_ledger.get(line_id)
            if previous is not None:
                if int(revision) <= int(previous["revision"]):
                    return
                old_chars = int(previous["chars"])
                previous["revision"] = int(revision)
                previous["chars"] = char_count
                previous["text"] = line_text
                if bool(previous["credited"]):
                    self.total_characters = max(0, self.total_characters + char_count - old_chars)
                elif self.last_line_id == line_id:
                    self.last_line_text = line_text
                    self.last_line_chars = char_count
                publish_live_stats_update(self, reason="line_revision")
                return

        if self.last_line_time is not None:
            # First-seen order is authoritative. A wall-clock correction may
            # move backward, but it must never create negative reading time.
            gap = max(0.0, timestamp - self.last_line_time)
            # If the gap between lines exceeds the session gap, reset stats.
            if gap > stats_config.session_gap_seconds:
                self.reset()
                # This line starts a fresh session; raw time counts from here.
                self.session_start_time = timestamp
            else:
                # Previous line is now done: credit its time and characters together.
                self._credit_gap(gap)
                self.total_characters += self.last_line_chars
                if self.last_line_id in self._line_ledger:
                    self._line_ledger[self.last_line_id]["credited"] = True
        else:
            # This is the first line of a new session.
            self.session_start_time = timestamp

        self.lines_count += 1

        # Retain raw text for revisions. Time and characters use the cleaned
        # count and are credited when the next line arrives, not now.
        self.last_line_text = line_text
        self.last_line_chars = char_count
        self.last_line_time = timestamp
        self.last_line_id = line_id
        if line_id:
            self._line_ledger[line_id] = {
                "revision": int(revision),
                "chars": char_count,
                "text": line_text,
                "timestamp": timestamp,
                "credited": False,
            }

        publish_live_stats_update(self, reason="line")
        # Keep overlay goals advancing while reading (throttled inside the publisher).
        try:
            from GameSentenceMiner.web.live_goals import schedule_live_goals_update

            schedule_live_goals_update()
        except Exception:
            pass

    def get_live_lines(self) -> list[tuple[str, str, float]]:
        """Copy live text for daily snapshots without exposing the revision ledger."""
        return [
            (line_id, str(line["text"]), float(line["timestamp"])) for line_id, line in self._line_ledger.copy().items()
        ]

    def get_chars_per_hour(self) -> int:
        """
        Calculates and returns the characters per hour for the current session.
        Returns 0 if not enough reading time has been logged.
        """
        # Require at least a few seconds of reading to get a stable CPH.
        if self.total_reading_seconds <= 5:
            return 0
        # Anti-spike guard: also require enough lines so a freshly-reset
        # session (e.g. returning from AFK) doesn't flash a bogus huge cph.
        if self.lines_count < MIN_LINES_FOR_CPH:
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
