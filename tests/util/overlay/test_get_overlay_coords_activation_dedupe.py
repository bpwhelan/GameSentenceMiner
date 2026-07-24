from GameSentenceMiner.util.overlay.get_overlay_coords import OverlayProcessor


def test_activation_dedupe_skips_results_at_or_above_95_percent_similarity():
    previous = "a" * 100

    assert OverlayProcessor._should_skip_similar_overlay_text(previous, "a" * 95 + "b" * 5, 0.95) is True
    assert OverlayProcessor._should_skip_similar_overlay_text(previous, "a" * 99 + "b", 0.95) is True


def test_activation_dedupe_resends_results_below_95_percent_similarity():
    previous = "a" * 100

    assert OverlayProcessor._should_skip_similar_overlay_text(previous, "a" * 94 + "b" * 6, 0.95) is False


def test_activation_dedupe_ignores_punctuation_and_whitespace_jitter():
    previous = "これは、同じ文章です。"
    current = "これは 同じ文章です"

    assert OverlayProcessor._should_skip_similar_overlay_text(previous, current, 0.95) is True


def test_activation_dedupe_does_not_suppress_without_comparable_text():
    assert OverlayProcessor._should_skip_similar_overlay_text(None, "new result", 0.95) is False
    assert OverlayProcessor._should_skip_similar_overlay_text("old result", "", 0.95) is False
