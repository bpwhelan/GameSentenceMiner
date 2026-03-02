from GameSentenceMiner.owocr.owocr.ocr import OpenCvClassicalTextDetector


def test_classical_detector_merges_adjacent_boxes_into_line_regions():
    detector = OpenCvClassicalTextDetector.__new__(OpenCvClassicalTextDetector)
    detector.merge_x_gap = 8
    detector.merge_y_tolerance = 6
    detector.min_vertical_overlap = 0.4

    merged = detector._merge_text_boxes(
        [
            {"box": [10, 10, 30, 20], "score": 0.90},
            {"box": [33, 11, 50, 21], "score": 0.80},
            {"box": [200, 200, 230, 220], "score": 0.70},
        ]
    )

    assert len(merged) == 2
    assert merged[0]["box"] == [10.0, 10.0, 50.0, 21.0]
    assert merged[1]["box"] == [200.0, 200.0, 230.0, 220.0]


def test_classical_detector_merging_keeps_distant_rows_separate():
    detector = OpenCvClassicalTextDetector.__new__(OpenCvClassicalTextDetector)
    detector.merge_x_gap = 10
    detector.merge_y_tolerance = 4
    detector.min_vertical_overlap = 0.5

    merged = detector._merge_text_boxes(
        [
            {"box": [12, 10, 28, 19], "score": 0.91},
            {"box": [30, 40, 52, 50], "score": 0.88},
        ]
    )

    assert len(merged) == 2
