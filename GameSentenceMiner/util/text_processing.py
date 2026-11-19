from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import replace
from typing import Any

from GameSentenceMiner.native.text import remove_repeated_chars, remove_repeated_lines
from GameSentenceMiner.util.config.configuration import (
    StringReplacement,
    TextProcessing,
    TextReplacementRule,
    get_config,
    logger,
)
from GameSentenceMiner.util.language_filter import LANGUAGE_FILTER_MODES, filter_target_language

HTML_TAG_WILDCARD_PATTERNS = {"<.*>", "<.+>"}
DOLLAR_CAPTURE_GROUP_PATTERN = re.compile(r"(?<!\\)\$(\d+)")
BRACKETED_TEXT_PATTERN = re.compile(r"[^\r\n「」]{0,8}「(?P<text>.*)」", re.DOTALL)

_PROCESSOR_FIELDS = {
    "remove_repeated_chars": "remove_repeated_chars",
    "remove_repeated_lines": "remove_repeated_lines_v2",
    "remove_control_chars": "remove_control_chars",
    "language_filter": "language_filter",
    "remove_non_japanese": "remove_non_japanese",
    "remove_newlines": "remove_newlines",
    "remove_numbers": "remove_numbers",
    "remove_english": "remove_english",
    "remove_curly_braces": "remove_curly_braces",
    "remove_angle_brackets": "remove_angle_brackets",
    "extract_bracketed_text": "extract_bracketed_text",
    "extract_lines": "extract_lines",
    "unicode_normalize": "unicode_normalize",
}


def processor_states(config: TextProcessing) -> dict[str, bool]:
    return {
        processor: (
            bool(config.string_replacement and config.string_replacement.enabled)
            if processor == "string_replacement"
            else bool(getattr(config, _PROCESSOR_FIELDS[processor]))
        )
        for processor in config.processor_order
        if processor == "string_replacement" or processor in _PROCESSOR_FIELDS
    }


def with_processor_overrides(config: TextProcessing, overrides: object) -> TextProcessing:
    if not isinstance(overrides, dict) or not overrides:
        return config
    changes: dict[str, Any] = {
        _PROCESSOR_FIELDS[processor]: enabled
        for processor, enabled in overrides.items()
        if processor in _PROCESSOR_FIELDS and isinstance(enabled, bool)
    }
    if isinstance(enabled := overrides.get("string_replacement"), bool):
        changes["string_replacement"] = replace(config.string_replacement or StringReplacement(), enabled=enabled)
    if (mode := overrides.get("language_filter_mode")) in LANGUAGE_FILTER_MODES:
        changes["language_filter_config"] = replace(config.language_filter_config, mode=mode)
    return replace(config, **changes) if changes else config


def apply_text_processing(text: str, config: TextProcessing | None, *, target_language: str | None = None) -> str:
    if not text or config is None:
        return text

    for processor_id in config.processor_order:
        text = run_text_processor(text, processor_id, config, target_language=target_language)
        if not text:
            break
    return text


def run_text_processor(
    text: str, processor_id: str, config: TextProcessing, *, target_language: str | None = None
) -> str:
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
        if config.remove_repeated_lines_v2:
            result = remove_repeated_lines(
                text,
                config.remove_repeated_lines_config.repeat_count,
            )
            # Single-character runs (e.g. 「いい」) belong to the separate character filter.
            if config.remove_repeated_lines_config.repeat_count < 2 and len(result) == 1:
                return text
            return result
    elif processor_id == "remove_control_chars":
        if config.remove_control_chars:
            return remove_control_chars(text)
    elif processor_id == "language_filter":
        if config.language_filter:
            language = get_config().general.target_language if target_language is None else target_language
            return filter_target_language(text, language, config.language_filter_config.mode)
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
    elif processor_id == "unicode_normalize" and config.unicode_normalize:
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
            return re.sub(pattern, _normalize_regex_replacement(replacement), text, flags=flags)
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


def _normalize_regex_replacement(replacement: str) -> str:
    """Allow JavaScript-style $1 capture references in regex replacements."""
    return DOLLAR_CAPTURE_GROUP_PATTERN.sub(r"\\g<\1>", replacement)


# --- Remove Control Characters ---


def remove_control_chars(text: str) -> str:
    # Only ASCII control codes: preserve line breaks/tabs and Unicode format
    # characters used by real text (e.g. emoji joiners and bidirectional marks).
    return "".join(c for c in text if c in ("\n", "\r", "\t") or (ord(c) >= 32 and c != "\x7f"))


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
    return "".join(text.splitlines())


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
    """Extract dialogue only from lines with a short prefix ending in 「」."""
    match = BRACKETED_TEXT_PATTERN.fullmatch(text)
    if match:
        return match.group("text")
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
