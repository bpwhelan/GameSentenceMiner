"""Lightweight stats helpers for GameSentenceMiner."""

from typing import Iterable, Sequence


# Adaptive reading time constants
# These live here (rather than in web.stats) to avoid circular imports,
# since live_stats.py and stats.py both need them.
MAX_SEC_PER_CHAR = 3.0  # Max seconds allowed per character in a line
FLOOR_SECONDS = 15.0  # Minimum time allowed for any line (even empty)
ABSOLUTE_CEILING = 300.0  # Hard upper bound (5 min) on any single line's time
MIN_CHARS_FOR_SPEED = 5  # Minimum chars for a line to be included in IQR analysis
MIN_SAMPLES_FOR_IQR = 10  # Minimum lines needed before applying IQR filtering

# --- v2 adaptive reading time constants ---
# v2 caps each line at what it *should* take at the session's own median
# reading speed, instead of a fixed seconds-per-char. Shared by the live
# tracker (live_stats.py) and the historical calc (web/stats.py) so both agree.
ADAPTIVE_FLOOR_SECONDS = 2.0  # Minimum time credited for any line in v2
ADAPTIVE_TOLERANCE = 2.5  # Slack factor over the expected per-line time
MIN_LINES_FOR_CPH = 5  # Lines required before live cph is shown (anti-spike guard)


def _median(values: Sequence[float]) -> float:
    """Median of a sequence; 0.0 when empty."""
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2.0


def session_median_cps(gaps: Iterable[tuple[float, int]]) -> float:
    """Median chars/second from (gap_seconds, char_count) pairs.

    Tiny lines and zero gaps are ignored so the reference speed reflects real
    reading. Median is robust to the occasional AFK outlier.
    """
    speeds = [c / g for g, c in gaps if c >= MIN_CHARS_FOR_SPEED and g > 0]
    return _median(speeds)


def adaptive_cap_seconds(char_count: int, median_cps: float) -> float:
    """Max plausible reading seconds for one line at the session's pace.

    cap = char_count / median_cps * ADAPTIVE_TOLERANCE, with a small floor and
    the shared absolute ceiling. Falls back to the fixed per-char cap until a
    median speed is available (start of session).
    """
    if median_cps and median_cps > 0:
        cap = max(ADAPTIVE_FLOOR_SECONDS, (char_count / median_cps) * ADAPTIVE_TOLERANCE)
    else:
        cap = max(ADAPTIVE_FLOOR_SECONDS, char_count * MAX_SEC_PER_CHAR)
    return min(cap, ABSOLUTE_CEILING)


def count_cards_from_line(line) -> int:
    """Return number of Anki cards for a single line.

    Prefers `note_ids` when present; otherwise counts either
    `screenshot_in_anki` or `audio_in_anki` as a single card.
    """
    if hasattr(line, "note_ids") and line.note_ids:
        return len(line.note_ids)

    has_screenshot = bool(line.screenshot_in_anki and line.screenshot_in_anki.strip())
    has_audio = bool(line.audio_in_anki and line.audio_in_anki.strip())

    return 1 if (has_screenshot or has_audio) else 0


def count_cards_from_lines(lines: Iterable) -> int:
    """Return total Anki cards for an iterable of lines."""
    if not lines:
        return 0

    return sum(count_cards_from_line(line) for line in lines)


def has_cards(line) -> bool:
    """Return True if the line has any Anki cards."""
    if hasattr(line, "note_ids") and line.note_ids:
        return True

    has_screenshot = bool(line.screenshot_in_anki and line.screenshot_in_anki.strip())
    has_audio = bool(line.audio_in_anki and line.audio_in_anki.strip())

    return bool(has_screenshot or has_audio)
