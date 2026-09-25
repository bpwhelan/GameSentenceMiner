"""Optional Rust text kernels with exact Python references and rollout controls."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from difflib import SequenceMatcher
from typing import TypeVar

from GameSentenceMiner.native import ocr
from GameSentenceMiner.native.runtime import NativeMode, get_native_mode
from GameSentenceMiner.util.logging_config import logger
from GameSentenceMiner.util.text_utils import is_kanji

_Result = TypeVar("_Result")


def _dispatch(name: str, reference: Callable[..., _Result], *args) -> _Result:
    mode = get_native_mode("text")
    implementation = getattr(ocr._extension, name, None)
    if mode is NativeMode.PYTHON or implementation is None:
        return reference(*args)
    try:
        result = implementation(*args)
    except (TypeError, ValueError, OverflowError, RuntimeError):
        # Includes lone Python surrogates and integers outside Rust's range.
        return reference(*args)
    if mode is NativeMode.SHADOW:
        expected = reference(*args)
        equal = list(result.items()) == list(expected.items()) if isinstance(expected, dict) else result == expected
        if not equal:
            logger.warning("Native text result differs from the Python reference ({})", name)
        return expected
    return result


def matching_block_stats(reference: str, candidate: str, min_block_size: int) -> tuple[float, int]:
    return _dispatch("matching_block_stats", _matching_block_stats_python, reference, candidate, min_block_size)


def _matching_block_stats_python(reference: str, candidate: str, min_block_size: int) -> tuple[float, int]:
    if not reference or not candidate:
        return 0.0, 0
    matcher = SequenceMatcher(None, reference, candidate, autojunk=False)
    covered = 0
    longest = 0
    for _, _, size in matcher.get_matching_blocks():
        if size > longest:  # noqa: PLR1730 - retain the original reference for parity and timing
            longest = size
        if size >= min_block_size:
            covered += size
    return covered / len(candidate), longest


def sequence_ratio(reference: str, candidate: str) -> float:
    """Match SequenceMatcher(None, a, b, autojunk=False).ratio(), including ties."""
    return _dispatch("sequence_ratio", _sequence_ratio_python, reference, candidate)


def _sequence_ratio_python(reference: str, candidate: str) -> float:
    return SequenceMatcher(None, reference, candidate, autojunk=False).ratio()


def remove_repeated_chars(text: str, repeat_count: int = 1, keep_non_repeated: bool = True) -> str:
    """Auto-detect repetitions of 3+ characters, or honor an explicit count of 2+."""
    if not text:
        return text
    return _dispatch("remove_repeated_chars", _remove_repeated_chars_python, text, repeat_count, keep_non_repeated)


def remove_repeated_lines(text: str, repeat_count: int = 1) -> str:
    if not text:
        return text
    return _dispatch("remove_repeated_lines", _remove_repeated_lines_python, text, repeat_count)


def count_kanji(texts: list[str]) -> dict[str, int]:
    """Count a batch in one call, retaining first-seen order and the GSM ranges."""
    return _dispatch("count_kanji", _count_kanji_python, texts)


def _count_kanji_python(texts: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for text in texts:
        for char in text:
            if is_kanji(char):
                counts[char] = counts.get(char, 0) + 1
    return counts


# --- Remove Repeated Characters (AAAABBBBCCCC -> ABC) ---


def _remove_repeated_chars_python(text: str, repeat_count: int = 1, keep_non_repeated: bool = True) -> str:
    if not text:
        return text

    if repeat_count >= 2:
        guess_times = repeat_count
    else:
        # Auto-detect repetition count
        dump_time: Counter[int] = Counter()
        cnt = 1
        last_c = None
        for c in list(text) + [None]:  # type: ignore[list-item]
            if c != last_c:
                dump_time[cnt] += 1
                last_c = c
                cnt = 1
            else:
                cnt += 1
        if not dump_time:
            return text
        max_freq = max(dump_time.values())
        candidates = sorted(k for k, v in dump_time.items() if v == max_freq)
        if candidates[0] == 1 and len(candidates) > 1:
            candidates = candidates[1:]
        guess_times = candidates[0]

    # Natural pairs such as 「ええ」 are not enough evidence of hook duplication.
    if repeat_count < 2 and guess_times < 3:
        return text

    if keep_non_repeated:
        new_line = ""
        i = 0
        while i < len(text):
            new_line += text[i]
            segment = text[i : i + guess_times]
            if len(segment) == guess_times and len(set(segment)) == 1:
                i += guess_times
            else:
                i += 1
        return new_line
    else:
        return "".join(text[i * guess_times] for i in range(len(text) // guess_times))


# --- Remove Repeated Lines (ABCDABCDABCD -> ABCD) ---


def _remove_repeated_lines_python(text: str, repeat_count: int = 1) -> str:
    if not text:
        return text

    if repeat_count >= 2:
        guess_times = repeat_count
    else:
        # Auto-detect: find smallest repeating unit
        guess_times = len(text)
        while guess_times >= 1:
            unit_len = len(text) // guess_times
            if unit_len > 0 and text[:unit_len] * guess_times == text:
                break
            guess_times -= 1
        if guess_times <= 0:
            return text

    unit_len = len(text) // guess_times
    if unit_len <= 0:
        return text
    return text[:unit_len]
