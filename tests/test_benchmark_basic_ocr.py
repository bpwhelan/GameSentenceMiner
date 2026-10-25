from types import SimpleNamespace

import numpy as np

from scripts.benchmark_basic_ocr import RecognitionOnly, normalized_text


def test_recognition_only_uses_line_crops_without_detection_and_restores_coordinates():
    calls = []

    def recognize(crops, **kwargs):
        calls.append((crops, kwargs))
        return [{"text": "字", "chars": [{"char": "字", "bbox": [1, 2, 5, 6], "conf": 0.9}]} for _ in crops]

    adapter = RecognitionOnly(SimpleNamespace(run_recognition=recognize))
    adapter.boxes = [{"box": [10, 20, 40, 50]}, {"box": [-5, -5, 10, 10]}, {"box": [80, 5, 90, 5]}]
    image = np.zeros((60, 100, 3), dtype=np.uint8)
    results = adapter.run_ocr(image, punct_conf_factor=0.2)
    crops, kwargs = calls[0]
    assert [crop.shape for crop in crops] == [(30, 30, 3), (10, 10, 3)]
    assert kwargs == {"punct_conf_factor": 0.2}
    assert results[0]["chars"][0]["bbox"] == [11, 22, 15, 26]
    assert results[1]["chars"][0]["bbox"] == [1, 2, 5, 6]


def test_reference_normalization_keeps_reading_order_and_spelling_differences():
    assert normalized_text("「ＡＢＣ！？」\nBLANK_LINE\nテスト") == "ABCテスト"
    assert normalized_text("テスト猫") != normalized_text("猫テスト")
    assert normalized_text("ザトー") != normalized_text("サトー")
