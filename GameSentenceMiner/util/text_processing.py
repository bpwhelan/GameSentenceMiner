from __future__ import annotations

import re
import unicodedata
from collections import Counter
from typing import Iterable

from GameSentenceMiner.util.config.configuration import (
    StringReplacement,
    TextProcessing,
    TextReplacementRule,
    logger,
)

HTML_TAG_WILDCARD_PATTERNS = {"<.*>", "<.+>"}


def apply_text_processing(text: str, config: TextProcessing | None) -> str:
    if not text or config is None:
        return text

    for processor_id in config.processor_order:
        text = _run_processor(text, processor_id, config)
        if not text:
            break
    return text


def _run_processor(text: str, processor_id: str, config: TextProcessing) -> str:
    """Run a single processor by ID if it is enabled."""
    if processor_id == "string_replacement":
        if config.string_replacement and config.string_replacement.enabled:
            return apply_string_replacements(text, config.string_replacement)
    elif processor_id == "remove_repeated_chars":
        if config.remove_repeated_chars:
            return remove_repeated_chars(
                text,
                config.remove_repeated_chars_config.repeat_count,
                config.remove_repeated_chars_config.keep_non_repeated,
            )
    elif processor_id == "remove_repeated_lines":
        if config.remove_repeated_lines:
            return remove_repeated_lines(
                text,
                config.remove_repeated_lines_config.repeat_count,
            )
    elif processor_id == "remove_control_chars":
        if config.remove_control_chars:
            return remove_control_chars(text)
    elif processor_id == "remove_non_japanese":
        if config.remove_non_japanese:
            return remove_non_japanese(text)
    elif processor_id == "remove_newlines":
        if config.remove_newlines:
            return remove_newlines(text)
    elif processor_id == "remove_numbers":
        if config.remove_numbers:
            return remove_numbers(text)
    elif processor_id == "remove_english":
        if config.remove_english:
            return remove_english(text)
    elif processor_id == "remove_curly_braces":
        if config.remove_curly_braces:
            return remove_curly_braces(text)
    elif processor_id == "remove_angle_brackets":
        if config.remove_angle_brackets:
            return remove_angle_brackets(text)
    elif processor_id == "extract_bracketed_text":
        if config.extract_bracketed_text:
            return extract_bracketed_text(text)
    elif processor_id == "extract_lines":
        if config.extract_lines:
            return extract_lines(
                text,
                config.extract_lines_config.max_lines,
                config.extract_lines_config.from_end,
            )
    elif processor_id == "unicode_normalize":
        if config.unicode_normalize:
            return unicode_normalize(text, config.unicode_normalize_config.form)
    return text


# --- String Replacement (existing) ---


def apply_string_replacements(text: str, config: StringReplacement | None) -> str:
    if not text or config is None or not config.enabled:
        return text
    for rule in _iter_rules(config.rules):
        text = _apply_rule(text, rule)
    return text


def _iter_rules(
    rules: Iterable[TextReplacementRule] | None,
) -> Iterable[TextReplacementRule]:
    if not rules:
        return ()
    return (rule for rule in rules if rule and rule.enabled)


def _apply_rule(text: str, rule: TextReplacementRule) -> str:
    find = rule.find or ""
    if not find:
        return text

    mode = (rule.mode or "plain").strip().lower()
    replacement = "" if rule.replace is None else rule.replace

    if mode in ("regex", "regex_replace"):
        pattern = find
        if replacement == "" and pattern.replace(" ", "") in HTML_TAG_WILDCARD_PATTERNS:
            pattern = r"<[^>]*>"
        if rule.whole_word:
            pattern = r"\b" + pattern + r"\b"
        flags = 0 if rule.case_sensitive else re.IGNORECASE
        try:
            return re.sub(pattern, replacement, text, flags=flags)
        except re.error as exc:
            logger.warning(f"Invalid regex in text replacement rule '{find}': {exc}")
            return text

    if rule.case_sensitive and not rule.whole_word:
        return text.replace(find, replacement)

    pattern = re.escape(find)
    if rule.whole_word:
        pattern = r"\b" + pattern + r"\b"
    flags = 0 if rule.case_sensitive else re.IGNORECASE
    return re.sub(pattern, lambda _: replacement, text, flags=flags)


# --- Remove Repeated Characters (AAAABBBBCCCC -> ABC) ---


def remove_repeated_chars(text: str, repeat_count: int = 1, keep_non_repeated: bool = True) -> str:
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

    if guess_times <= 1:
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


def remove_repeated_lines(text: str, repeat_count: int = 1) -> str:
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


# --- Remove Control Characters ---


def remove_control_chars(text: str) -> str:
    return "".join(c for c in text if not (ord(c) < 32 and c not in ("\n", "\r", "\t")))


# --- Remove Non-Japanese (non-Shift-JIS) Characters ---


def remove_non_japanese(text: str) -> str:
    new_line = ""
    for char in text:
        try:
            char.encode("shiftjis")
            new_line += char
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return new_line


# --- Remove Newlines ---


def remove_newlines(text: str) -> str:
    return " ".join(segment for segment in text.splitlines() if segment)


# --- Remove Numbers ---


def remove_numbers(text: str) -> str:
    return re.sub(r"[0-9]+", "", text)


# --- Remove English Letters ---


def remove_english(text: str) -> str:
    return re.sub(r"[a-zA-Z]+", "", text)


# --- Remove Curly Braces / Game Script Tags ---


def remove_curly_braces(text: str) -> str:
    text = re.sub(r"\{(\w+)(.*?)\}(.*?)\{/\1\}", r"\3", text)
    text = re.sub(r"\{([^}]?)[:/](.*?)\}", r"\1", text)
    text = re.sub(r"\{.*?\}", "", text)
    return text


# --- Remove Angle Brackets / HTML Tags ---


def remove_angle_brackets(text: str) -> str:
    return re.sub(r"<[^>]*>", "", text)


# --- Extract Text Between 「」 Brackets ---


def extract_bracketed_text(text: str) -> str:
    if "「" in text and "」" in text:
        start = text.index("「")
        end = text.rindex("」")
        if start < end:
            return text[start : end + 1]
    return text


# --- Extract/Limit Lines ---


def extract_lines(text: str, max_lines: int = 3, from_end: bool = True) -> str:
    lines = text.splitlines()
    if len(lines) <= abs(max_lines):
        return text
    if from_end:
        return "\n".join(lines[-max_lines:])
    else:
        return "\n".join(lines[:max_lines])


# --- Unicode Normalization ---


def unicode_normalize(text: str, form: str = "NFKC") -> str:
    if form not in ("NFD", "NFC", "NFKD", "NFKC"):
        form = "NFKC"
    return unicodedata.normalize(form, text)
