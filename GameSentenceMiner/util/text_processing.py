from __future__ import annotations

import re
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
    text = apply_string_replacements(text, config.string_replacement)
    return text


def apply_string_replacements(text: str, config: StringReplacement | None) -> str:
    if not text or config is None or not config.enabled:
        return text
    for rule in _iter_rules(config.rules):
        text = _apply_rule(text, rule)
    return text


def _iter_rules(rules: Iterable[TextReplacementRule] | None) -> Iterable[TextReplacementRule]:
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
            # Users commonly enter <.*> to strip tags. Convert to a safe tag matcher
            # so tag content is preserved.
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
