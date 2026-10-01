"""Lightweight stats helpers for GameSentenceMiner."""

from collections.abc import Iterable, Sequence
from math import isfinite

# Adaptive reading time constants
# These live here (rather than in web.stats) to avoid circular imports,
# since live_stats.py and stats.py both need them.
MAX_SEC_PER_CHAR = 3.0  # Fallback seconds per character before a session pace is available
ABSOLUTE_CEILING = 300.0  # Hard upper bound (5 min) on any single line's time
MIN_CHARS_FOR_SPEED = 5  # Minimum chars for a line to contribute to the session pace
MIN_GAP_FOR_SPEED = 1.0  # Subsecond text-delivery bursts are not reliable pace samples

# Cap each line at 2.5 times its expected duration at the actual session median.
ADAPTIVE_FLOOR_SECONDS = 2.0  # Minimum cap for a nonempty line
ADAPTIVE_TOLERANCE = 2.5  # Slack for difficult lines and brief lookups
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


def reading_speed_sample(gap_seconds: float, char_count: int) -> float | None:
    """Return raw chars/second when a gap is usable for learning the pace.

    Tiny lines and subsecond bursts mostly measure text delivery. Gaps beyond
    the hard reading-time ceiling cannot be fully credited, so letting them
    teach the pace would turn repeated long breaks into normal reading.

    Do not filter against the adaptive cap or learn from capped durations:
    either would bias the median faster and prevent learning a slower pace.
    """
    if char_count < MIN_CHARS_FOR_SPEED or not isfinite(gap_seconds):
        return None
    if not MIN_GAP_FOR_SPEED <= gap_seconds <= ABSOLUTE_CEILING:
        return None
    return char_count / gap_seconds


def session_median_cps(gaps: Iterable[tuple[float, int]]) -> float:
    """Actual median chars/second of usable raw gaps within one session.

    Returns zero when no pace is available. The median tolerates a minority of
    fast or slow outliers, but timestamps alone cannot distinguish persistent
    interruptions from genuinely slow reading.
    """
    speeds = [speed for gap, chars in gaps if (speed := reading_speed_sample(gap, chars)) is not None]
    return _median(speeds)


def adaptive_cap_seconds(char_count: int, median_cps: float) -> float:
    """Max plausible reading seconds for one line at the session's pace.

    cap = char_count / median_cps * ADAPTIVE_TOLERANCE, with a small floor
    for nonempty lines and the shared absolute ceiling. This is an upper bound,
    not an assigned duration: callers must also limit credit to the actual gap.
    Falls back to the fixed per-char cap until a usable pace is available.
    """
    if char_count <= 0:
        return 0.0
    if isfinite(median_cps) and median_cps > 0:
        cap = max(ADAPTIVE_FLOOR_SECONDS, (char_count / median_cps) * ADAPTIVE_TOLERANCE)
    else:
        cap = max(ADAPTIVE_FLOOR_SECONDS, char_count * MAX_SEC_PER_CHAR)
    return min(cap, ABSOLUTE_CEILING)


def count_cards_from_line(line) -> int:
    """Return number of Anki cards for a single line.

    Prefers `note_ids` when present; otherwise counts either
    `screenshot_in_anki` or `audio_in_anki` as a single card.
    """
    if hasattr(line, "archived_card_count"):
        return line.archived_card_count
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
    if hasattr(line, "archived_card_count"):
        return line.archived_card_count > 0
    if hasattr(line, "note_ids") and line.note_ids:
        return True

    has_screenshot = bool(line.screenshot_in_anki and line.screenshot_in_anki.strip())
    has_audio = bool(line.audio_in_anki and line.audio_in_anki.strip())

    return bool(has_screenshot or has_audio)
