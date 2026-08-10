from GameSentenceMiner.util.overlay.get_overlay_coords import OverlayProcessor
from GameSentenceMiner.util.text_log import TextSource


def test_text_appears_instantly_allows_a_second_overlay_ocr_attempt():
    assert OverlayProcessor._resolve_local_ocr_attempts(TextSource.HOOKER, 5, True) == 2
    assert OverlayProcessor._resolve_local_ocr_attempts(TextSource.HOOKER, 5, False) == 5


def test_empty_overlay_ocr_result_uses_short_retry_delay():
    assert OverlayProcessor._resolve_local_ocr_retry_delay(previous_attempt_had_text=False) == 0.1
    assert OverlayProcessor._resolve_local_ocr_retry_delay(previous_attempt_had_text=True) == 1.0


def test_text_appears_instantly_requires_half_likeness_to_reference_text():
    assert not OverlayProcessor._should_stop_local_ocr_attempts(
        stabilized=False,
        text_appears_instantly=True,
        current_text="",
        reference_text="期待する文章",
    )
    assert not OverlayProcessor._should_stop_local_ocr_attempts(
        stabilized=False,
        text_appears_instantly=True,
        current_text="まったく別の文字列",
        reference_text="期待する文章",
    )
    assert OverlayProcessor._should_stop_local_ocr_attempts(
        stabilized=False,
        text_appears_instantly=True,
        current_text="期待する文章です",
        reference_text="期待する文章",
    )


def test_text_appears_instantly_without_reference_stops_after_text_is_found():
    assert OverlayProcessor._should_stop_local_ocr_attempts(
        stabilized=False,
        text_appears_instantly=True,
        current_text="画面上の文字",
        reference_text=None,
    )


def test_text_appears_instantly_accepts_similarity_at_fifty_percent():
    assert not OverlayProcessor._should_stop_local_ocr_attempts(
        stabilized=False,
        text_appears_instantly=True,
        current_text="a",
        reference_text="abcd",
    )
    assert OverlayProcessor._should_stop_local_ocr_attempts(
        stabilized=False,
        text_appears_instantly=True,
        current_text="a",
        reference_text="abc",
    )
