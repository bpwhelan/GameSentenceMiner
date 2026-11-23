"""Bounded, exact history for the overlay's recycled-line indicator."""

import os
import unicodedata
from collections import OrderedDict

from GameSentenceMiner.native import ocr
from GameSentenceMiner.native.runtime import NativeMode, get_native_mode


def desktop_owns_recycled_lines() -> bool:
    return os.environ.get("GSM_NATIVE_RECYCLED_LINES") == "1"


def normalize_text_for_comparison(text: str) -> str:
    """Remove Unicode whitespace and punctuation, preserving all other code points."""
    if text is None:
        return ""
    normalized_characters = []
    for character in str(text):
        if character.isspace():
            continue
        if unicodedata.category(character).startswith("P"):
            continue
        normalized_characters.append(character)
    return "".join(normalized_characters)


def _ignored_page(page: int) -> bytes:
    # Share the interpreter's exact Unicode version, including unassigned code
    # points. Rust asks once per 256-code-point page encountered by this index.
    mask = bytearray(32)
    for offset in range(256):
        ch = chr(page * 256 + offset)
        if ch.isspace() or unicodedata.category(ch).startswith("P"):
            mask[offset >> 3] |= 1 << (offset & 7)
    return bytes(mask)


class _PythonRecycledLines:
    def __init__(self, limit, minimum):
        self.keys = OrderedDict()
        self.limit = limit
        self.minimum = minimum

    def __len__(self):
        return len(self.keys)

    def __contains__(self, text):
        return normalize_text_for_comparison(text) in self.keys

    def add(self, text):
        key = normalize_text_for_comparison(text)
        if len(key) >= self.minimum:
            self.keys[key] = None
            if len(self.keys) > self.limit:
                self.keys.popitem(last=False)


class _ShadowRecycledLines:
    def __init__(self, reference, native):
        self.reference = reference
        self.native = native

    def __len__(self):
        return len(self.reference)

    def add(self, text):
        self.reference.add(text)
        self.native.add(text)

    def __contains__(self, text):
        expected = text in self.reference
        if (text in self.native) != expected:
            from GameSentenceMiner.util.logging_config import logger

            logger.warning("Native recycled-line check differs from the Python reference")
        return expected


def new_recycled_lines(limit, minimum):
    mode = get_native_mode("text")
    implementation = getattr(ocr._extension, "RecycledLines", None)
    if mode is NativeMode.PYTHON or implementation is None:
        return _PythonRecycledLines(limit, minimum)
    native = implementation(limit, minimum, _ignored_page)
    if mode is NativeMode.SHADOW:
        return _ShadowRecycledLines(_PythonRecycledLines(limit, minimum), native)
    return native
