import regex

from GameSentenceMiner.util.overlay import get_overlay_coords


def test_filter_local_ocr_results_by_language_removes_non_japanese_lines():
    processor = get_overlay_coords.OverlayProcessor()
    processor.regex = regex.compile(r"[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]")

    source = [
        {"text": "hello world", "bounding_rect": {"x1": 1}, "words": []},
        {"text": "テスト", "bounding_rect": {"x1": 2}, "words": []},
    ]

    result = processor._filter_local_ocr_results_by_language(source)

    assert len(result) == 1
    assert result[0]["text"] == "テスト"


def test_filter_local_ocr_results_by_language_removes_non_japanese_words():
    processor = get_overlay_coords.OverlayProcessor()
    processor.regex = regex.compile(r"[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]")

    source = [
        {
            "text": "HP です",
            "bounding_rect": {"x1": 1},
            "words": [
                {"text": "HP", "bounding_rect": {"x1": 1}},
                {"text": "です", "bounding_rect": {"x1": 2}},
            ],
        }
    ]

    result = processor._filter_local_ocr_results_by_language(source)

    assert len(result) == 1
    assert result[0]["text"] == "です"
    assert len(result[0]["words"]) == 1
    assert result[0]["words"][0]["text"] == "です"

