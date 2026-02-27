"""OCR text comparison utilities.

Extracted from ocr_main so they can be shared across modules without
pulling in heavy dependencies.
"""

from __future__ import annotations

import regex
from rapidfuzz import fuzz

punctuation_regex = regex.compile(r'[\p{P}\p{S}\p{Z}]')


def normalize_for_comparison(text: str) -> str:
    """Strip all non-letter/non-digit Unicode characters and collapse
    whitespace.

    This prevents punctuation (e.g. CJK `：` `、` `・・・`, ASCII `...` `:`)
    from inflating fuzzy-match scores between otherwise unrelated strings.
    Requires the ``regex`` package for Unicode property escapes (``\\p{L}``,
    ``\\p{N}``).
    """
    return punctuation_regex.sub('', str(text))


def is_evolving_text(shorter: str, longer: str, prefix_threshold: int = 85) -> bool:
    """Return True when *shorter* looks like a prefix of *longer*.

    Used to distinguish genuine text evolution (the same OCR line growing)
    from a complete change to a new line.  Both inputs should already be
    normalized with :func:`normalize_for_comparison`.
    """
    if not shorter or not longer or len(shorter) > len(longer):
        return False
    n = len(shorter)
    return fuzz.ratio(shorter, longer[:n]) >= prefix_threshold


def compare_ocr_results(
    prev_text: str | list | None,
    new_text: str | list | None,
    threshold: int = 90,
) -> bool:
    """Return True when *prev_text* and *new_text* are similar enough.

    Supports str and list[str | None] inputs.  Empty/None inputs always
    return False.
    """
    if not prev_text or not new_text:
        return False

    if isinstance(prev_text, list):
        prev_text = "".join(
            item for item in prev_text if item is not None
        )
    if isinstance(new_text, list):
        new_text = "".join(
            item for item in new_text if item is not None
        )

    prev_text = str(prev_text).strip()
    new_text = str(new_text).strip()
    if not prev_text or not new_text:
        return False

    # Normalize: strip punctuation/whitespace so that shared speaker tags or
    # trailing ellipses don't inflate the score between unrelated strings.
    norm_prev = normalize_for_comparison(prev_text)
    norm_new  = normalize_for_comparison(new_text)
    if not norm_prev or not norm_new:
        # Fall back to raw text if normalization produces empty strings
        # (e.g. punctuation-only input).
        norm_prev, norm_new = prev_text, new_text

    similarity = fuzz.ratio(norm_prev, norm_new)
    if similarity >= threshold:
        return True

    # For high-threshold duplicate checks, handle truncated OCR variants.
    # We use anchored prefix/suffix comparison rather than unconstrained
    # partial_ratio: genuine truncation means the shorter text IS a prefix
    # OR suffix of the longer, so max(prefix_ratio, suffix_ratio) is high.
    # An unconstrained partial_ratio can produce false positives when two
    # speeches from the same speaker share a long prefix but differ in
    # content (e.g. "Speaker: short." vs "Speaker: completely different line.")
    # because the shared speaker tag inflates the score.
    shorter_len = min(len(norm_prev), len(norm_new))
    longer_len = max(len(norm_prev), len(norm_new))
    if threshold >= 70 and shorter_len >= 8 and (shorter_len / longer_len) >= 0.25:
        # Require the base similarity to already be in the same ballpark;
        # without this, completely different texts with a shared prefix can
        # still score high on anchored ratio.
        if threshold >= 75 and similarity < (threshold - 15):
            return False
        shorter_str = norm_prev if len(norm_prev) <= len(norm_new) else norm_new
        longer_str  = norm_new  if len(norm_prev) <= len(norm_new) else norm_prev
        n = len(shorter_str)
        anchored = max(
            fuzz.ratio(shorter_str, longer_str[:n]),   # prefix truncation
            fuzz.ratio(shorter_str, longer_str[-n:]),  # suffix truncation
        )
        return anchored >= threshold

    return False
