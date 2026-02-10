"""Lightweight stats helpers for GameSentenceMiner."""

from typing import Iterable


def count_cards_from_line(line) -> int:
    """Return number of Anki cards for a single line.

    Prefers `note_ids` when present; otherwise counts either
    `screenshot_in_anki` or `audio_in_anki` as a single card.
    """
    if hasattr(line, 'note_ids') and line.note_ids:
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
    if hasattr(line, 'note_ids') and line.note_ids:
        return True

    has_screenshot = bool(line.screenshot_in_anki and line.screenshot_in_anki.strip())
    has_audio = bool(line.audio_in_anki and line.audio_in_anki.strip())

    return bool(has_screenshot or has_audio)
