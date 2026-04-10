"""Helpers for formatting Jiten difficulty values."""

import math
from typing import Optional

JITEN_DIFFICULTY_LABELS = (
    "Beginner",
    "Easy",
    "Average",
    "Hard",
    "Expert",
    "Insane",
)


def get_jiten_difficulty_label(difficulty) -> Optional[str]:
    """Return the Jiten difficulty bucket name for a numeric difficulty value."""
    if difficulty in (None, ""):
        return None

    try:
        difficulty_value = float(difficulty)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(difficulty_value):
        return None

    bucket = math.floor(difficulty_value)
    bucket = min(max(bucket, 0), len(JITEN_DIFFICULTY_LABELS) - 1)
    return JITEN_DIFFICULTY_LABELS[bucket]
