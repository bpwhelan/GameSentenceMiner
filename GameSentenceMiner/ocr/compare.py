"""OCR text comparison utilities.

Extracted from the OCR runtime so they can be shared across modules without
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


def _normalize_candidate(text: str) -> str:
    """Normalize text for fuzzy comparison, keeping raw fallback."""
    value = str(text).strip()
    if not value:
        return ""
    normalized = normalize_for_comparison(value)
    return normalized or value


def _compare_flat_strings(prev_text: str, new_text: str, threshold: int) -> bool:
    """Compare two strings with punctuation stripping and anchored truncation checks."""
    norm_prev = _normalize_candidate(prev_text)
    norm_new = _normalize_candidate(new_text)
    if not norm_prev or not norm_new:
        return False

    similarity = fuzz.ratio(norm_prev, norm_new)
    if similarity >= threshold:
        return True

    # For high-threshold duplicate checks, handle truncated OCR variants.
    # We use anchored prefix/suffix comparison rather than unconstrained
    # partial_ratio: genuine truncation means the shorter text IS a prefix
    # OR suffix of the longer, so max(prefix_ratio, suffix_ratio) is high.
    shorter_len = min(len(norm_prev), len(norm_new))
    longer_len = max(len(norm_prev), len(norm_new))
    if threshold >= 70 and shorter_len >= 8 and (shorter_len / longer_len) >= 0.25:
        # Require base similarity to already be in roughly the same ballpark.
        if threshold >= 75 and similarity < (threshold - 15):
            return False
        shorter_str = norm_prev if len(norm_prev) <= len(norm_new) else norm_new
        longer_str = norm_new if len(norm_prev) <= len(norm_new) else norm_prev
        n = len(shorter_str)
        anchored = max(
            fuzz.ratio(shorter_str, longer_str[:n]),   # prefix truncation
            fuzz.ratio(shorter_str, longer_str[-n:]),  # suffix truncation
        )
        return anchored >= threshold

    return False


def _normalize_chunks(chunks: list) -> list[str]:
    """Return normalized non-empty chunks."""
    normalized: list[str] = []
    for chunk in chunks:
        if chunk is None:
            continue
        candidate = _normalize_candidate(chunk)
        if candidate:
            normalized.append(candidate)
    return normalized


def _has_brand_new_chunk(prev_chunks: list, new_chunks: list, threshold: int) -> bool:
    """True when any new chunk is not represented by prior chunks."""
    norm_prev_chunks = _normalize_chunks(prev_chunks)
    norm_new_chunks = _normalize_chunks(new_chunks)
    if not norm_prev_chunks or not norm_new_chunks:
        return False

    prev_flat = "".join(norm_prev_chunks)

    for new_chunk in norm_new_chunks:
        # If content is already in prior flattened text, treat as known even
        # when chunk boundaries changed.
        if new_chunk in prev_flat:
            continue
        if any(
            _compare_flat_strings(prev_chunk, new_chunk, threshold)
            for prev_chunk in norm_prev_chunks
        ):
            continue
        return True
    return False


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

    prev_chunks = prev_text if isinstance(prev_text, list) else None
    new_chunks = new_text if isinstance(new_text, list) else None

    if isinstance(prev_text, list):
        prev_text = "".join(
            str(item) for item in prev_text if item is not None
        )
    if isinstance(new_text, list):
        new_text = "".join(
            str(item) for item in new_text if item is not None
        )

    prev_text = str(prev_text).strip()
    new_text = str(new_text).strip()
    if not prev_text or not new_text:
        return False

    # Stage 1: keep existing flattened-text comparison behavior.
    if not _compare_flat_strings(prev_text, new_text, threshold):
        return False

    # Stage 2: if both sides are chunked lists, ensure no completely new chunk
    # appears in the incoming text.
    if prev_chunks is not None and new_chunks is not None:
        if _has_brand_new_chunk(prev_chunks, new_chunks, threshold):
            return False

    return True
