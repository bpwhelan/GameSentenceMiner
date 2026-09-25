"""Native overlay projection with the original Python behavior as a fallback."""

from __future__ import annotations

import copy
from collections.abc import Callable
from functools import partial

from GameSentenceMiner.native import ocr
from GameSentenceMiner.native.runtime import NativeMode, get_native_mode
from GameSentenceMiner.util.logging_config import logger

# Share the OCR facade's ABI-checked extension loader. Optional capabilities let
# source checkouts with an older native binary keep using the Python reference.


def copy_payload(value):
    """Copy built-in payload containers in Rust, retaining deepcopy semantics."""
    return get_payload_copier()(value)


def get_payload_copier():
    """Resolve rollout mode once for callers copying many words in one frame."""
    mode = get_native_mode("overlay")
    clone = getattr(ocr._extension, "copy_overlay_payload", None)
    if mode is NativeMode.PYTHON or clone is None:
        return copy.deepcopy
    return partial(_copy_payload, clone, mode)


def _copy_payload(clone, mode, value):
    try:
        result = clone(value)
    except (TypeError, ValueError, OverflowError, RuntimeError):
        return copy.deepcopy(value)
    if result is None:
        return copy.deepcopy(value)
    if mode is NativeMode.SHADOW:
        expected = copy.deepcopy(value)
        try:
            equal = result == expected
        except RecursionError:
            # Cyclic metadata is copyable, but Python equality cannot compare
            # distinct cycles. Keep returning the reference in diagnostic mode.
            return expected
        if not equal:
            logger.warning("Native overlay payload copy differs from the Python reference")
        return expected
    return result


def filter_geometry(lines, *, kind, parameter, reference, merge_boxes):
    """Apply native keep decisions to independent copies of the original lines."""
    mode = get_native_mode("overlay")
    decide = getattr(ocr._extension, f"filter_overlay_{kind}", None)
    if mode is NativeMode.PYTHON or decide is None:
        return reference()
    try:
        decisions = decide(lines, parameter)
    except (TypeError, ValueError, OverflowError, RuntimeError) as exc:
        logger.debug("Native overlay geometry unavailable; using Python: {}", exc)
        return reference()
    if decisions is None:
        return reference()
    result = []
    clone = get_payload_copier()
    for line_id, word_ids in decisions:
        line = clone(lines[line_id])
        if word_ids is not None:
            words = line["words"]
            kept_words = [words[index] for index in word_ids]
            line["words"] = kept_words
            changed = len(kept_words) != len(words)
            if changed:
                line["text"] = "".join(str(word.get("text", "")) for word in kept_words)
            if changed or kind == "minimum_size":
                merged = merge_boxes([word.get("bounding_rect", {}) for word in kept_words])
                if merged is not None:
                    line["bounding_rect"] = merged
        result.append(line)
    if mode is NativeMode.SHADOW:
        expected = reference()
        try:
            equal = result == expected
        except RecursionError:
            return expected
        if not equal:
            logger.warning("Native overlay geometry differs from the Python reference ({})", kind)
        return expected
    return result


def project_coordinates(
    lines: list[dict],
    *,
    kind: str,
    x_axis: tuple[float, float, float, float],
    y_axis: tuple[float, float, float, float],
    reference: Callable[[], list[dict]],
    append_space: bool = False,
) -> list[dict]:
    mode = get_native_mode("overlay")
    project = getattr(ocr._extension, "project_overlay_coordinates", None)
    if mode is NativeMode.PYTHON or project is None:
        return reference()

    # The OneOCR contract mutates boxes and word text in place. A diagnostic
    # shadow call must operate on a copy or the reference would project twice.
    # Only copy built-in metadata: invoking a custom deepcopy protocol here
    # would introduce behavior absent from the in-place Python reference.
    native_input = lines
    try:
        if mode is NativeMode.SHADOW and kind == "oneocr":
            clone = getattr(ocr._extension, "copy_overlay_payload", None)
            native_input = clone(lines) if clone is not None else None
        result = None if native_input is None else project(native_input, kind, x_axis, y_axis, append_space)
    except (TypeError, ValueError, OverflowError, RuntimeError) as exc:
        logger.debug("Native overlay projection unavailable; using Python: {}", exc)
        return reference()
    if result is None:
        return reference()
    if mode is NativeMode.SHADOW:
        expected = reference()
        try:
            equal = result == expected
        except RecursionError:
            return expected
        if not equal:
            logger.warning("Native overlay projection differs from the Python reference ({})", kind)
        return expected
    return result
