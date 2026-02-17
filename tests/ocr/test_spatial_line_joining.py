from GameSentenceMiner.owocr.owocr.ocr import build_spatial_text


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
        {"text": "A", "center_x": 100.0, "center_y": 100.0, "width": 20.0, "height": 80.0, "is_vertical": True},
        {"text": "B", "center_x": 104.0, "center_y": 170.0, "width": 20.0, "height": 80.0, "is_vertical": True},
    ]

    assert build_spatial_text(lines) == "A B"
