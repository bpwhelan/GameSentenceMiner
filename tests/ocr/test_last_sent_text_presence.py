from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

from GameSentenceMiner.util.overlay.last_sent_text_presence import (
    LastSentTextPresenceTracker,
    prepare_presence_candidate,
)


def _frame(*, text: bool, background_seed: int = 0) -> Image.Image:
    rng = np.random.default_rng(background_seed)
    pixels = rng.integers(20, 80, size=(80, 240), dtype=np.uint8)
    if text:
        cv2.putText(pixels, "OCR", (55, 52), cv2.FONT_HERSHEY_SIMPLEX, 1.2, 245, 2, cv2.LINE_AA)
    return Image.fromarray(pixels, mode="L")


def _payload() -> dict:
    return {
        "line_coords": [
            {
                "text": "OCR",
                "bounding_rect": {
                    "x1": 50,
                    "y1": 22,
                    "x2": 135,
                    "y2": 22,
                    "x3": 135,
                    "y3": 58,
                    "x4": 50,
                    "y4": 58,
                },
                "words": [],
            }
        ],
        "pipeline": {
            "processing": {"processed_size": {"width": 240, "height": 80}},
            "ocr": {"crop_coords": [45, 18, 140, 62]},
        },
    }


def test_presence_candidate_uses_tight_line_geometry():
    candidate = prepare_presence_candidate(_frame(text=True), _payload())

    assert candidate is not None
    assert candidate.frame_size == (240, 80)
    assert candidate.crop_box == (49, 21, 136, 59)
    assert candidate.presence_id


def test_dynamic_background_keeps_matching_text_present():
    tracker = LastSentTextPresenceTracker(required_misses=2)
    candidate = prepare_presence_candidate(_frame(text=True, background_seed=1), _payload())
    assert candidate is not None
    tracker.activate(candidate)

    assert tracker.observe(_frame(text=True, background_seed=2), enabled=True) is None
    assert tracker.has_active_reference is True


def test_text_must_be_missing_twice_before_single_invalidation():
    tracker = LastSentTextPresenceTracker(required_misses=2)
    candidate = prepare_presence_candidate(_frame(text=True, background_seed=1), _payload())
    assert candidate is not None
    tracker.activate(candidate)

    assert tracker.observe(_frame(text=False, background_seed=3), enabled=True) is None
    invalidation = tracker.observe(_frame(text=False, background_seed=4), enabled=True)

    assert invalidation is not None
    assert invalidation.presence_id == candidate.presence_id
    assert invalidation.similarity < tracker.similarity_threshold
    assert tracker.observe(_frame(text=False, background_seed=5), enabled=True) is None


def test_disabling_presence_check_clears_reference_without_invalidating():
    tracker = LastSentTextPresenceTracker(required_misses=1)
    candidate = prepare_presence_candidate(_frame(text=True), _payload())
    assert candidate is not None
    tracker.activate(candidate)

    assert tracker.observe(_frame(text=False), enabled=False) is None
    assert tracker.has_active_reference is False
