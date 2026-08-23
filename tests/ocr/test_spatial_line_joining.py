from GameSentenceMiner.owocr.owocr import ocr as ocr_module
from GameSentenceMiner.owocr.owocr.ocr import (
    BoundingBox,
    ImageProperties,
    Line,
    OcrResult,
    OneOCR,
    Paragraph,
    build_spatial_text,
    ocr_result_to_oneocr_tuple,
    post_process,
)


def test_build_spatial_text_joins_same_axis_lines_with_space():
    lines = [
        {"text": "The", "center_y": 100.0, "height": 20.0},
        {"text": "cat", "center_y": 104.0, "height": 20.0},
    ]

    assert build_spatial_text(lines) == "The cat"


def test_build_spatial_text_joins_different_axis_lines_with_newline():
    lines = [
        {"text": "First", "center_y": 100.0, "height": 20.0},
        {"text": "Second", "center_y": 140.0, "height": 20.0},
    ]

    assert build_spatial_text(lines) == "First\nSecond"


def test_build_spatial_text_avoids_space_before_punctuation():
    lines = [
        {"text": "Hello", "center_y": 200.0, "height": 20.0},
        {"text": "!", "center_y": 202.0, "height": 20.0},
    ]

    assert build_spatial_text(lines) == "Hello!"


def test_build_spatial_text_can_emit_blank_line_token():
    lines = [
        {"text": "Top", "center_y": 100.0, "height": 20.0},
        {"text": "Bottom", "center_y": 180.0, "height": 20.0},
    ]

    assert build_spatial_text(lines, blank_line_token="BLANK_LINE") == "Top\nBLANK_LINE\nBottom"


def test_build_spatial_text_uses_x_axis_for_vertical_lines():
    lines = [
        {
            "text": "A",
            "center_x": 100.0,
            "center_y": 100.0,
            "width": 20.0,
            "height": 80.0,
            "is_vertical": True,
        },
        {
            "text": "B",
            "center_x": 104.0,
            "center_y": 170.0,
            "width": 20.0,
            "height": 80.0,
            "is_vertical": True,
        },
    ]

    assert build_spatial_text(lines) == "A B"


def test_furigana_filter_reorders_surviving_fragments_by_position(monkeypatch):
    monkeypatch.setattr(ocr_module, "get_ocr_language", lambda: "ja")

    def line(text, center_x, center_y, width, height):
        return Line(
            text=text,
            words=[],
            bounding_box=BoundingBox(
                center_x=center_x,
                center_y=center_y,
                width=width,
                height=height,
            ),
        )

    # OneOCR can return the right-hand fragment first when ruby text sits above
    # it. Once those small ruby blocks are removed, reading order must come from
    # the surviving geometry rather than that stale engine order.
    lines = [
        line("記録できたッチ!", 0.547, 0.175, 0.323, 0.207),
        line("きろく", 0.431, 0.042, 0.051, 0.079),
        line("「うむ。しっかり", 0.197, 0.174, 0.306, 0.224),
        line("それではヨッチ村にレッツゴーだッチ!", 0.466, 0.454, 0.796, 0.221),
        line("むら", 0.410, 0.321, 0.034, 0.084),
    ]
    result = OcrResult(
        image_properties=ImageProperties(width=977, height=208),
        engine_capabilities=OneOCR.capabilities,
        paragraphs=[Paragraph(bounding_box=lines[-2].bounding_box, lines=lines)],
    )

    converted = ocr_result_to_oneocr_tuple(
        (True, result),
        furigana_filter_sensitivity=20,
        prefer_axis_spacing=True,
    )

    assert converted[1] == "「うむ。しっかり 記録できたッチ!\nそれではヨッチ村にレッツゴーだッチ!"
    assert post_process(converted[1], keep_blank_lines=True) == (
        "「うむ。しっかり記録できたッチ！\nそれではヨッチ村にレッツゴーだッチ！"
    )
