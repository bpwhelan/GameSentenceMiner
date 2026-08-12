from __future__ import annotations

import copy

from GameSentenceMiner.native import ocr as native_ocr
from GameSentenceMiner.owocr.owocr import ocr_runtime


def test_native_ocr_extension_reports_stable_api_version():
    assert native_ocr.is_available()
    assert native_ocr.api_version() == 1


def test_native_text_filter_preserves_source_separators_and_deduplicates_prefix():
    first = "淳平「痛って！」したたか頭を打ちつける。"
    second = "身をよじって手をつこうとしたのだが、その先にはなにもなかった。"
    raw = f"{first}\n{second}"

    result = native_ocr.filter_text(
        source_text=raw,
        blocks=[first, second],
        language="ja",
        previous_blocks=[first],
        historic_compare_blocks=[],
    )

    assert result.text == second
    assert result.all_blocks == [first, second]
    assert result.compare_blocks == [
        "淳平痛ってしたたか頭を打ちつける",
        "身をよじって手をつこうとしたのだがその先にはなにもなかった",
    ]


def test_native_text_filter_rejects_ambiguous_non_target_noise():
    result = native_ocr.filter_text(
        source_text="Settings\n日本語です。",
        blocks=["Settings", "日本語です。"],
        language="ja",
        previous_blocks=[],
        historic_compare_blocks=[],
    )

    assert result.text == "日本語です。"
    assert result.all_blocks == ["日本語です。"]


def test_native_text_filter_includes_full_common_kanji_range():
    result = native_ocr.filter_text(
        source_text="一日",
        blocks=["一日"],
        language="ja",
        previous_blocks=[],
        historic_compare_blocks=[],
    )

    assert result.text == "一日"
    assert result.compare_blocks == ["一日"]


def test_native_text_filter_preserves_blank_line_markers():
    result = native_ocr.filter_text(
        source_text="一行目BLANK_LINE二行目",
        blocks=["一行目", "BLANK_LINE", "二行目"],
        language="ja",
        previous_blocks=[],
        historic_compare_blocks=[],
    )

    assert result.text == "一行目\n二行目"
    assert result.all_blocks == ["一行目", "\n", "二行目"]
    assert result.compare_blocks == ["一行目", "\n", "二行目"]


def test_native_spatial_text_handles_horizontal_and_vertical_axes():
    horizontal = native_ocr.build_spatial_text(
        [
            ("続き", 100.0, 20.0, 50.0, 20.0, False),
            ("です。", 160.0, 21.0, 45.0, 20.0, False),
        ]
    )
    vertical = native_ocr.build_spatial_text(
        [
            ("右", 200.0, 100.0, 20.0, 50.0, True),
            ("列", 201.0, 160.0, 20.0, 50.0, True),
        ]
    )

    assert horizontal == "続き です。"
    assert vertical == "右 列"


def test_native_overlay_filter_batches_line_and_word_decisions():
    result = native_ocr.filter_overlay_language(
        language="ja",
        lines=[
            (0, "hello world", [(0, "hello"), (1, "world")]),
            (1, "HP です", [(0, "HP"), (1, "です")]),
            (2, "々", []),
        ],
    )

    assert result == [
        native_ocr.OverlayFilterDecision(source_id=1, use_words=True, source_word_ids=[0, 1]),
        native_ocr.OverlayFilterDecision(source_id=2, use_words=False, source_word_ids=[]),
    ]


def test_native_layout_orders_horizontal_lines_top_to_bottom():
    result = native_ocr.order_layout(
        lines=[
            (0, "二行目", 0.5, 0.35, 0.5, 0.1, None, "LEFT_TO_RIGHT"),
            (1, "一行目", 0.5, 0.15, 0.5, 0.1, None, "LEFT_TO_RIGHT"),
        ],
        image_width=1000.0,
        image_height=1000.0,
        language="ja",
        furigana_filter=False,
        support_center_aligned_text=True,
        merge_close_paragraphs=True,
    )

    assert [[line.text for line in paragraph.lines] for paragraph in result] == [["一行目", "二行目"]]
    assert result[0].writing_direction == "LEFT_TO_RIGHT"
    assert [line.source_ids for line in result[0].lines] == [[1], [0]]


def test_text_filtering_defaults_to_native_without_loading_python_classifier(monkeypatch):
    monkeypatch.delenv("GSM_NATIVE_MODE", raising=False)
    monkeypatch.delenv("GSM_NATIVE_OCR_MODE", raising=False)
    monkeypatch.setattr(ocr_runtime, "get_ocr_language", lambda: "ja")
    filtering = ocr_runtime.TextFiltering("ja")
    filtering.classify = lambda _block: (_ for _ in ()).throw(AssertionError("Python classifier was called"))

    text, blocks = filtering("これは日本語です。", [], engine="oneocr", is_second_ocr=False)

    assert text == "これは日本語です。"
    assert blocks == ["これは日本語です。"]


def test_text_filtering_falls_back_to_python_when_native_call_fails(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OCR_MODE", "native")
    monkeypatch.setattr(ocr_runtime, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(
        native_ocr,
        "filter_text",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("synthetic native failure")),
    )
    filtering = ocr_runtime.TextFiltering("ja")
    filtering.classify = lambda _block: ("ja", 1.0)

    text, blocks = filtering("これは日本語です。", [], engine="oneocr", is_second_ocr=False)

    assert text == "これは日本語です。"
    assert blocks == ["これは日本語です。"]


def test_native_layout_matches_python_reference_for_mixed_orientation_and_furigana(monkeypatch):
    monkeypatch.setattr(ocr_runtime, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(ocr_runtime, "get_furigana_filter_sensitivity", lambda: 1)
    filtering = ocr_runtime.TextFiltering("ja")
    capabilities = ocr_runtime.EngineCapabilities(
        words=True,
        word_bounding_boxes=True,
        lines=True,
        line_bounding_boxes=True,
        paragraphs=True,
        paragraph_bounding_boxes=True,
    )

    def make_line(text, center_x, center_y, width, height):
        return ocr_runtime.Line(
            text=text,
            words=[],
            bounding_box=ocr_runtime.BoundingBox(
                center_x=center_x,
                center_y=center_y,
                width=width,
                height=height,
            ),
        )

    paragraphs = []
    for line, direction in [
        (make_line("漢字本文", 0.35, 0.25, 0.45, 0.10), "LEFT_TO_RIGHT"),
        (make_line("かんじ", 0.35, 0.19, 0.30, 0.04), "LEFT_TO_RIGHT"),
        (make_line("二行目", 0.35, 0.40, 0.45, 0.10), "LEFT_TO_RIGHT"),
        (make_line("縦書き", 0.78, 0.30, 0.08, 0.45), "TOP_TO_BOTTOM"),
    ]:
        paragraphs.append(
            ocr_runtime.Paragraph(
                bounding_box=line.bounding_box,
                lines=[line],
                writing_direction=direction,
            )
        )
    result = ocr_runtime.OcrResult(
        image_properties=ocr_runtime.ImageProperties(width=1200, height=800),
        engine_capabilities=capabilities,
        paragraphs=paragraphs,
    )

    native = filtering._order_paragraphs_and_lines_native(copy.deepcopy(result))
    python = filtering._order_paragraphs_and_lines_python(copy.deepcopy(result))

    assert filtering._layout_signature(native) == filtering._layout_signature(python)
