from PIL import Image

from GameSentenceMiner.owocr.owocr import ocr as ocr_module


class _FakePrediction:
    def __init__(self, payload):
        self.json = {"res": payload}


def test_paddleocr_text_detector_converts_official_payload(monkeypatch):
    model_instances = []

    class FakeTextDetection:
        def __init__(self, **kwargs):
            self.init_kwargs = kwargs
            self.predict_calls = []
            model_instances.append(self)

        def predict(self, input_image, batch_size=1, **kwargs):
            self.predict_calls.append(
                {
                    "shape": getattr(input_image, "shape", None),
                    "batch_size": batch_size,
                    **kwargs,
                }
            )
            return [
                _FakePrediction(
                    {
                        "dt_polys": [
                            [[2, 3], [8, 3], [8, 9], [2, 9]],
                            [[12, 4], [18, 4], [18, 10], [12, 10]],
                        ],
                        "dt_scores": [0.91, "0.82"],
                    }
                )
            ]

    monkeypatch.setattr(
        ocr_module,
        "_load_paddleocr_dependencies",
        lambda: {"TextDetection": FakeTextDetection},
    )

    detector = ocr_module.PaddleOCRTextDetector(
        config={
            "model_name": "PP-OCRv5_mobile_det",
            "confidence_threshold": 0.45,
            "crop_padding": 1,
        }
    )

    success, text, coords, crop_coords_list, crop_coords, response_dict = detector(Image.new("RGB", (20, 12), color=0))

    assert detector.available is True
    assert model_instances[0].init_kwargs["model_name"] == "PP-OCRv5_mobile_det"
    assert model_instances[0].predict_calls[0]["batch_size"] == 1
    assert model_instances[0].predict_calls[0]["box_thresh"] == 0.45
    assert model_instances[0].predict_calls[0]["shape"] == (12, 20, 3)

    assert success is True
    assert text == ""
    assert coords == []
    assert crop_coords_list == [(1, 2, 9, 10), (11, 3, 19, 11)]
    assert crop_coords == (1, 2, 19, 11)
    assert response_dict["boxes"] == [
        {"box": [2.0, 3.0, 8.0, 9.0], "score": 0.91},
        {"box": [12.0, 4.0, 18.0, 10.0], "score": 0.82},
    ]
