import copy

import pytest

from GameSentenceMiner.util.overlay.get_overlay_coords import OverlayProcessor
from GameSentenceMiner.util.text_log import normalize_text_for_comparison


STATIC_SCREEN_TEXT = (
    "受信メル閃光の指圧師なにを言っているのも理解できないきちんと説明してほしいを本当に見つけたのどこで萌郁"
)


@pytest.mark.parametrize(
    ("ocr_sentence", "hook_sentence"),
    [
        (
            "内部の犯行ならげ前都が怪しいと思っていたが",
            "内部の犯行ならば萌郁が怪しいと思っていたが",
        ),
        (
            "柳林神社からもIBN5100が消えでいたとなると萌郁の犯行というのは逆に不自然に思えてくる",
            "柳林神社からもＩＢＮ５１００が消えていた、となると、萌郁の犯行というのは逆に不自然に思えてくる。",
        ),
        (
            "やはりDメールによを過去改変の影響",
            "やはりＤメールによる過去改変の影響……？",
        ),
        (
            "あるいはSERNにJS組織的な動さか",
            "あるいは、ＳＥＲＮによる組織的な動きか。",
        ),
    ],
)
def test_stabilization_uses_correctable_structured_ocr_text(ocr_sentence, hook_sentence):
    processor = OverlayProcessor()
    ocr_results = [{"text": STATIC_SCREEN_TEXT + ocr_sentence, "words": []}]
    original_results = copy.deepcopy(ocr_results)

    stability_text = processor._build_overlay_stabilization_text(ocr_results, hook_sentence)

    assert ocr_results == original_results
    assert processor._is_overlay_text_stabilized(
        stability_text,
        last_result_flattened="",
        normalized_sentence_to_check=normalize_text_for_comparison(hook_sentence),
    )


def test_stabilization_does_not_accept_an_incomplete_corrected_sentence():
    processor = OverlayProcessor()
    hook_sentence = "やはりＤメールによる過去改変の影響……？"
    ocr_results = [{"text": STATIC_SCREEN_TEXT + "やはりDメールによ", "words": []}]

    stability_text = processor._build_overlay_stabilization_text(ocr_results, hook_sentence)

    assert not processor._is_overlay_text_stabilized(
        stability_text,
        last_result_flattened="",
        normalized_sentence_to_check=normalize_text_for_comparison(hook_sentence),
    )


def test_consecutive_stability_ignores_width_and_punctuation_jitter():
    processor = OverlayProcessor()

    assert processor._is_overlay_text_stabilized(
        "やはりDメールによる過去改変の影響?",
        last_result_flattened="やはりＤメールによる過去改変の影響？",
        normalized_sentence_to_check=None,
    )
