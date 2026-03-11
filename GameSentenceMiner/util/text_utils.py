"""Shared text-analysis utilities for GameSentenceMiner."""

from __future__ import annotations


def is_kanji(char: str) -> bool:
    """Check if a character is a CJK Unified Ideograph.

    Covers:
      - CJK Unified Ideographs:        U+4E00 – U+9FFF
      - CJK Unified Ideographs Ext. A: U+3400 – U+4DBF
      - CJK Unified Ideographs Ext. B: U+20000 – U+2A6DF

    Returns False for non-single-character input without raising.
    """
    if not isinstance(char, str) or len(char) != 1:
        return False
    cp = ord(char)
    return (
        0x4E00 <= cp <= 0x9FFF
        or 0x3400 <= cp <= 0x4DBF
        or 0x20000 <= cp <= 0x2A6DF
    )
