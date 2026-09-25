"""Minute-precise goal windows, with inclusive dates for legacy goals."""

import datetime
import re

import pytz


def has_goal_time(value):
    return isinstance(value, str) and "T" in value


def local_midnight(day, tz):
    value = datetime.datetime.combine(day, datetime.time.min)
    return tz.localize(value) if hasattr(tz, "localize") else value.replace(tzinfo=tz)


def parse_goal_window(start, end, tz):
    """Return aware [start, end) bounds; a date-only end includes its entire day."""

    def parse(value, is_end):
        if not isinstance(value, str):
            # All malformed API date values use the same validation exception.
            raise ValueError("Start and end dates are required")  # noqa: TRY004
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            day = datetime.date.fromisoformat(value)
            if is_end:
                day += datetime.timedelta(days=1)
            return local_midnight(day, tz)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?", value):
            raise ValueError("Invalid date or time format")
        parsed = datetime.datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            try:
                parsed = tz.localize(parsed, is_dst=None) if hasattr(tz, "localize") else parsed.replace(tzinfo=tz)
            except (pytz.AmbiguousTimeError, pytz.NonExistentTimeError) as exc:
                raise ValueError("This local time needs an explicit UTC offset") from exc
        return parsed.astimezone(tz)

    start_at, end_at = parse(start, False), parse(end, True)
    if end_at <= start_at:
        raise ValueError("End date and time must be after start date and time")
    return start_at, end_at
