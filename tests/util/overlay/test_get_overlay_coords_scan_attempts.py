from GameSentenceMiner.util.overlay.get_overlay_coords import OverlayProcessor
from GameSentenceMiner.util.text_log import TextSource


def test_text_appears_instantly_forces_one_overlay_ocr_attempt():
    assert OverlayProcessor._resolve_local_ocr_attempts(TextSource.HOOKER, 5, True) == 1
    assert OverlayProcessor._resolve_local_ocr_attempts(TextSource.HOOKER, 5, False) == 5
