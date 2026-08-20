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


def test_filter_local_ocr_results_by_language_normalizes_leading_stroke_before_kanji():
    processor = get_overlay_coords.OverlayProcessor()
    processor.regex = regex.compile(r"[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]")

    source = [
        {
            "text": "-際大きな声",
            "bounding_rect": {"x1": 1},
            "words": [
                {"text": "-", "bounding_rect": {"x1": 1}},
                {"text": "際", "bounding_rect": {"x1": 2}},
                {"text": "大", "bounding_rect": {"x1": 3}},
                {"text": "き", "bounding_rect": {"x1": 4}},
                {"text": "な", "bounding_rect": {"x1": 5}},
                {"text": "声", "bounding_rect": {"x1": 6}},
            ],
        }
    ]

    result = processor._filter_local_ocr_results_by_language(source)

    assert len(result) == 1
    assert result[0]["text"] == "一際大きな声"
    assert [word["text"] for word in result[0]["words"]] == ["一", "際", "大", "き", "な", "声"]


def test_filter_local_ocr_results_by_language_normalizes_katakana_long_vowels():
    processor = get_overlay_coords.OverlayProcessor()
    processor.regex = regex.compile(r"[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]")

    source = [
        {
            "text": "ス-パ-",
            "bounding_rect": {"x1": 1},
            "words": [
                {"text": "ス", "bounding_rect": {"x1": 1}},
                {"text": "-", "bounding_rect": {"x1": 2}},
                {"text": "パ", "bounding_rect": {"x1": 3}},
                {"text": "-", "bounding_rect": {"x1": 4}},
            ],
        }
    ]

    result = processor._filter_local_ocr_results_by_language(source)

    assert len(result) == 1
    assert result[0]["text"] == "スーパー"
    assert [word["text"] for word in result[0]["words"]] == ["ス", "ー", "パ", "ー"]


def test_filter_local_ocr_results_uses_native_batch_for_standard_language_regex(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    processor.ocr_language = "ja"
    processor.regex = get_overlay_coords.get_regex("ja")
    calls = []

    def fake_native_filter(*, language, lines):
        calls.append((language, lines))
        return [
            get_overlay_coords.native_ocr.OverlayFilterDecision(
                source_id=1,
                use_words=True,
                source_word_ids=[0, 1],
            )
        ]

    monkeypatch.setenv("GSM_NATIVE_OCR_MODE", "native")
    monkeypatch.setattr(get_overlay_coords.native_ocr, "has_overlay_language_filter", lambda: True)
    monkeypatch.setattr(get_overlay_coords.native_ocr, "filter_overlay_language", fake_native_filter)
    source = [
        {"text": "hello", "bounding_rect": {"x1": 1}, "words": []},
        {
            "text": "HP です",
            "bounding_rect": {"x1": 2},
            "words": [
                {"text": "HP", "bounding_rect": {"x1": 2}},
                {"text": "です", "bounding_rect": {"x1": 3}},
            ],
        },
    ]

    result = processor._filter_local_ocr_results_by_language(source)

    assert calls == [
        (
            "ja",
            [
                (0, "hello", []),
                (1, "HP です", [(0, "HP"), (1, "です")]),
            ],
        )
    ]
    assert result == [
        {
            "text": "HPです",
            "bounding_rect": {"x1": 2},
            "words": [
                {"text": "HP", "bounding_rect": {"x1": 2}},
                {"text": "です", "bounding_rect": {"x1": 3}},
            ],
        }
    ]


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


def test_filter_precomputed_results_by_exclusion_regions_removes_overlapped_characters():
    processor = get_overlay_coords.OverlayProcessor()
    source = [
        {
            "text": "日時会話",
            "bounding_rect": {
                "x1": 0.1,
                "y1": 0.1,
                "x2": 0.5,
                "y2": 0.1,
                "x3": 0.5,
                "y3": 0.2,
                "x4": 0.1,
                "y4": 0.2,
            },
            "words": [
                {
                    "text": character,
                    "bounding_rect": {
                        "x1": left,
                        "y1": 0.1,
                        "x2": left + 0.1,
                        "y2": 0.1,
                        "x3": left + 0.1,
                        "y3": 0.2,
                        "x4": left,
                        "y4": 0.2,
                    },
                }
                for character, left in zip("日時会話", (0.1, 0.2, 0.3, 0.4))
            ],
        }
    ]
    exclusion_regions = [
        {
            "x1": 0.09,
            "y1": 0.09,
            "x2": 0.31,
            "y2": 0.09,
            "x3": 0.31,
            "y3": 0.21,
            "x4": 0.09,
            "y4": 0.21,
        }
    ]

    result = processor._filter_precomputed_results_by_exclusion_regions(source, exclusion_regions)

    assert result[0]["text"] == "会話"
    assert [word["text"] for word in result[0]["words"]] == ["会", "話"]
    assert result[0]["bounding_rect"] == {
        "x1": 0.3,
        "y1": 0.1,
        "x2": 0.5,
        "y2": 0.1,
        "x3": 0.5,
        "y3": 0.2,
        "x4": 0.3,
        "y4": 0.2,
    }


def test_filter_precomputed_results_by_exclusion_regions_drops_fully_excluded_line():
    processor = get_overlay_coords.OverlayProcessor()
    bounding_rect = {
        "x1": 0.1,
        "y1": 0.1,
        "x2": 0.2,
        "y2": 0.1,
        "x3": 0.2,
        "y3": 0.2,
        "x4": 0.1,
        "y4": 0.2,
    }

    result = processor._filter_precomputed_results_by_exclusion_regions(
        [{"text": "日", "bounding_rect": bounding_rect, "words": [{"text": "日", "bounding_rect": bounding_rect}]}],
        [bounding_rect],
    )

    assert result == []
