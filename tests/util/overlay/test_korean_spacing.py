from copy import deepcopy

import pytest

from GameSentenceMiner.util.overlay import get_overlay_coords
from GameSentenceMiner.util.overlay.get_overlay_coords import OverlayProcessor

SENTENCE = "음성 파일 다운로드가 완료되었습니다."
WORDS = SENTENCE.split(" ")


def processor(language):
    subject = OverlayProcessor.__new__(OverlayProcessor)
    subject.ocr_language = language
    subject.last_monitor_left = 0
    subject.last_monitor_top = 0
    subject.calculated_width_scale_factor = 1.0
    subject.calculated_height_scale_factor = 1.0
    return subject


def local_line(texts, text):
    return {
        "text": text,
        "bounding_rect": {"x1": 0, "y1": 0, "x3": 800, "y3": 40},
        "words": [
            {
                "text": word,
                "bounding_rect": {"x1": index * 100, "y1": 0, "x3": index * 100 + 90, "y3": 40},
            }
            for index, word in enumerate(texts)
        ],
    }


def lens_response(texts, separators):
    geometry = {"bounding_box": {"center_x": 0.5, "center_y": 0.5, "width": 0.8, "height": 0.1}}
    line = {
        "geometry": geometry,
        "words": [
            {"plain_text": text, "text_separator": separator, "geometry": deepcopy(geometry)}
            for text, separator in zip(texts, separators)
        ],
    }
    return {"objects_response": {"text": {"text_layout": {"paragraphs": [{"lines": [line]}]}}}}


@pytest.mark.parametrize("use_percentages", [False, True])
def test_lens_preserves_korean_separators(use_percentages):
    # Lens may split a word into fragments; an empty separator is significant too.
    response = lens_response(["음성", "파", "일", "다운로드가", "완료되었습니다."], [" ", "", " ", " ", ""])
    result = processor("ko")._extract_text_with_pixel_boxes(response, 1920, 1080, 0, 0, 1920, 1080, use_percentages)

    assert result[0]["text"] == SENTENCE
    assert "".join(word["text"] for word in result[0]["words"]) == SENTENCE


def test_lens_can_reuse_korean_response_with_omitted_empty_separators():
    response = lens_response(["음성", "파", "일", "다운로드가", "완료되었습니다."], [" ", "", " ", " ", ""])
    words = response["objects_response"]["text"]["text_layout"]["paragraphs"][0]["lines"][0]["words"]
    del words[1]["text_separator"]
    del words[-1]["text_separator"]
    before = deepcopy(response)
    subject = processor("ko")

    for _ in range(2):
        result = subject._extract_text_with_pixel_boxes(response, 1920, 1080, 0, 0, 1920, 1080, True)
        assert result[0]["text"] == SENTENCE
        assert response == before


@pytest.mark.parametrize("mode", ["python", "native", "shadow"])
@pytest.mark.parametrize(
    "language,words,expected",
    [("ko", WORDS, SENTENCE), ("ja", ["音声", "ファイル"], "音声ファイル"), ("zh", ["音频", "文件"], "音频文件")],
)
def test_local_ocr_word_spacing(monkeypatch, mode, language, words, expected):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", mode)
    result = processor(language)._convert_oneocr_results_to_percentages([local_line(words, expected)], 1920, 1080)

    assert "".join(word["text"] for word in result[0]["words"]).rstrip() == expected


@pytest.mark.parametrize("language,words", [("ja", ["音声", "ファイル"]), ("zh", ["音频", "文件"])])
def test_lens_keeps_unspaced_languages_unchanged(language, words):
    response = lens_response(words, [" ", ""])
    result = processor(language)._extract_text_with_pixel_boxes(response, 1920, 1080, 0, 0, 1920, 1080, True)

    assert result[0]["text"] == "".join(words)


@pytest.mark.parametrize("mode", ["python", "native", "shadow"])
@pytest.mark.parametrize(
    "fragments", [WORDS, list(SENTENCE.replace(" ", "")), ["음성", "파", "일", "다운로드가", "완료되었습니다."]]
)
def test_korean_local_filter_and_projection_preserve_only_source_spaces(monkeypatch, mode, fragments):
    monkeypatch.setenv("GSM_NATIVE_OCR_MODE", mode)
    monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", mode)
    subject = processor("ko")
    subject.regex = get_overlay_coords.get_regex("ko")
    source = [local_line(fragments, SENTENCE)]
    before = deepcopy(source)

    filtered = subject._filter_local_ocr_results_by_language(source)
    assert source == before
    assert filtered[0]["text"] == SENTENCE
    projected = subject._convert_oneocr_results_to_percentages(filtered, 1920, 1080)
    assert "".join(word["text"] for word in projected[0]["words"]).rstrip() == SENTENCE
