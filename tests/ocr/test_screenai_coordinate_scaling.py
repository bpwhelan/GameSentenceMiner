from GameSentenceMiner.owocr.owocr import ocr as ocr_module
from GameSentenceMiner.owocr.owocr.ocr import ScreenAIOCR, ocr_result_to_oneocr_tuple


def test_screenai_scales_rects_back_to_original_coordinates(monkeypatch):
    def fake_parse(_raw_proto):
        return [
            {
                "text": "テスト",
                "box": {"x": 100, "y": 50, "width": 200, "height": 40, "angle": 0.0},
                "words": [
                    {
                        "text": "テスト",
                        "box": {"x": 100, "y": 50, "width": 200, "height": 40, "angle": 0.0},
                        "has_space_after": False,
                    }
                ],
            }
        ]

    monkeypatch.setattr(ocr_module, "_screen_ai_parse_visual_annotation_manual", fake_parse)

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
