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
    assert result[0]["text"] == "HPです"
    assert len(result[0]["words"]) == 2
    assert [word["text"] for word in result[0]["words"]] == ["HP", "です"]


def test_filter_local_ocr_results_by_language_keeps_standalone_iteration_mark():
    processor = get_overlay_coords.OverlayProcessor()
    processor.regex = regex.compile(r"[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]")

    source = [
        {"text": "々", "bounding_rect": {"x1": 1}, "words": []},
    ]

    result = processor._filter_local_ocr_results_by_language(source)

    assert len(result) == 1
    assert result[0]["text"] == "々"


def test_filter_precomputed_results_by_minimum_character_size_removes_small_words():
    processor = get_overlay_coords.OverlayProcessor()
    source = [
        {
            "text": "漢ふ",
            "bounding_rect": {"x1": 0, "y1": 0, "x2": 24, "y2": 0, "x3": 24, "y3": 24, "x4": 0, "y4": 24},
            "words": [
                {
                    "text": "漢",
                    "bounding_rect": {"x1": 0, "y1": 0, "x2": 18, "y2": 0, "x3": 18, "y3": 18, "x4": 0, "y4": 18},
                },
                {
                    "text": "ふ",
                    "bounding_rect": {"x1": 18, "y1": 0, "x2": 24, "y2": 0, "x3": 24, "y3": 6, "x4": 18, "y4": 6},
                },
            ],
        }
    ]

    result = processor._filter_precomputed_results_by_minimum_character_size(source, 10)

    assert len(result) == 1
    assert result[0]["text"] == "漢"
    assert [word["text"] for word in result[0]["words"]] == ["漢"]
    assert result[0]["bounding_rect"] == {
        "x1": 0.0,
        "y1": 0.0,
        "x2": 18.0,
        "y2": 0.0,
        "x3": 18.0,
        "y3": 18.0,
        "x4": 0.0,
        "y4": 18.0,
    }
