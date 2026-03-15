from types import SimpleNamespace

from PIL import Image

from GameSentenceMiner.owocr.owocr import ocr as ocr_module
from GameSentenceMiner.owocr.owocr import run as run_module
from GameSentenceMiner.owocr.owocr.ocr import (
    BoundingBox,
    Line,
    OcrResult,
    Paragraph,
    ScreenAIOCR,
    Word,
    ocr_result_to_oneocr_tuple,
)


def test_screenai_scales_rects_back_to_original_coordinates(monkeypatch):
    def fake_parse(_raw_proto):
        return [
            {
                "text": "テスト",
                "box": {"x": 100, "y": 50, "width": 200, "height": 40, "angle": 0.0},
                "words": [
                    {
                        "text": "テスト",
                        "box": {
                            "x": 100,
                            "y": 50,
                            "width": 200,
                            "height": 40,
                            "angle": 0.0,
                        },
                        "has_space_after": False,
                    }
                ],
            }
        ]

    monkeypatch.setattr(
        ocr_module, "_screen_ai_parse_visual_annotation_manual", fake_parse
    )

    engine = ScreenAIOCR.__new__(ScreenAIOCR)
    engine._parser = "manual"
    engine._screen_ai_pb2 = None
    engine.capabilities = ScreenAIOCR.capabilities

    ocr_result = engine._to_generic_result(
        b"ignored",
        img_width=1000,
        img_height=500,
        scale_x=0.5,
        scale_y=0.5,
    )

    success, text, filtered_lines, *_ = ocr_result_to_oneocr_tuple((True, ocr_result))

    assert success is True
    assert text == "テスト"

    line_rect = filtered_lines[0]["bounding_rect"]
    assert line_rect["x1"] == 200
    assert line_rect["y1"] == 100
    assert line_rect["x3"] == 600
    assert line_rect["y3"] == 180


def test_screenai_furigana_filter_keeps_punctuation_like_lens(monkeypatch):
    monkeypatch.setattr(ocr_module, "get_ocr_language", lambda: "ja")

    line = Line(
        text="ふり。",
        bounding_box=BoundingBox(center_x=0.5, center_y=0.5, width=0.08, height=0.08),
        words=[
            Word(
                text="ふり",
                bounding_box=BoundingBox(
                    center_x=0.5, center_y=0.5, width=0.08, height=0.08
                ),
            ),
            Word(
                text="。",
                bounding_box=BoundingBox(
                    center_x=0.55, center_y=0.5, width=0.02, height=0.08
                ),
            ),
        ],
    )
    ocr_result = OcrResult(
        image_properties=ocr_module.ImageProperties(width=100, height=100),
        engine_capabilities=ScreenAIOCR.capabilities,
        paragraphs=[Paragraph(bounding_box=line.bounding_box, lines=[line])],
    )

    engine = ScreenAIOCR.__new__(ScreenAIOCR)
    engine.available = True
    engine._preprocess = lambda img, mode="grayscale": img
    engine._perform_ocr = lambda _processed: b"ignored"
    engine._to_generic_result = lambda _raw, _w, _h: ocr_result

    success, text, filtered_lines, crop_coords_list, crop_coords, _ = engine(
        Image.new("RGBA", (100, 100), (255, 255, 255, 255)),
        furigana_filter_sensitivity=10,
    )

    assert success is True
    assert text == "。"
    assert filtered_lines == []
    assert crop_coords_list == []
    assert crop_coords is None


def test_screenai_filters_out_non_target_language_lines(monkeypatch):
    monkeypatch.setattr(ocr_module, "get_ocr_language", lambda: "ja")

    english_line = Line(
        text="HP 120",
        bounding_box=BoundingBox(center_x=0.2, center_y=0.2, width=0.2, height=0.1),
        words=[
            Word(
                text="HP",
                bounding_box=BoundingBox(
                    center_x=0.15, center_y=0.2, width=0.08, height=0.1
                ),
            ),
            Word(
                text="120",
                bounding_box=BoundingBox(
                    center_x=0.25, center_y=0.2, width=0.08, height=0.1
                ),
            ),
        ],
    )
    japanese_line = Line(
        text="テスト",
        bounding_box=BoundingBox(center_x=0.5, center_y=0.5, width=0.2, height=0.1),
        words=[
            Word(
                text="テスト",
                bounding_box=BoundingBox(
                    center_x=0.5, center_y=0.5, width=0.2, height=0.1
                ),
            ),
        ],
    )
    ocr_result = OcrResult(
        image_properties=ocr_module.ImageProperties(width=100, height=100),
        engine_capabilities=ScreenAIOCR.capabilities,
        paragraphs=[
            Paragraph(
                bounding_box=japanese_line.bounding_box,
                lines=[english_line, japanese_line],
            )
        ],
    )

    engine = ScreenAIOCR.__new__(ScreenAIOCR)

    success, text, filtered_lines, *_ = (
        engine._to_oneocr_tuple_lens_like_furigana_filter(ocr_result, 0)
    )

    assert success is True
    assert text == "テスト"
    assert len(filtered_lines) == 1
    assert filtered_lines[0]["text"] == "テスト"


def test_apply_ocr_config_to_image_supports_grayscale_masking():
    img = Image.new("L", (12, 12), color=255)
    config = SimpleNamespace(
        rectangles=[
            SimpleNamespace(
                coordinates=[0, 0, 3, 3], is_excluded=True, is_secondary=False
            ),
            SimpleNamespace(
                coordinates=[0, 0, 12, 12], is_excluded=False, is_secondary=False
            ),
        ]
    )

    processed, offset = run_module.apply_ocr_config_to_image(
        img,
        config,
        return_full_size=False,
    )

    assert processed.mode == "L"
    assert offset == (0, 0)
    assert processed.getpixel((0, 0)) == 0
    assert processed.getpixel((8, 8)) == 255
