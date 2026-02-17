from GameSentenceMiner.ocr import ocr_format_converter as converter


def test_convert_ocr_result_returns_none_for_empty():
    assert converter.convert_ocr_result_to_unified_format(None) is None
    assert converter.convert_ocr_result_to_unified_format([]) is None


def test_convert_ocr_result_handles_failure_tuple():
    result = converter.convert_ocr_result_to_unified_format((False, None, None, None, None, None), "engine")
    assert result is None


def test_convert_ocr_result_uses_filtered_lines_from_tuple():
    lines = [{"text": "x", "bounding_rect": {"x1": 1}}]
    result = converter.convert_ocr_result_to_unified_format((True, "ignored", lines, None, None, {}), "engine")
    assert result == lines


def test_convert_ocr_result_uses_response_dict_lines():
    lines = [{"text": "x", "bounding_rect": {"x1": 1}}]
    result = converter.convert_ocr_result_to_unified_format((True, None, None, None, None, {"lines": lines}), "engine")
    assert result == lines


def test_convert_ocr_result_uses_extract_from_api_response(monkeypatch):
    expected = [{"text": "from-api", "bounding_rect": {"x1": 0}}]
    monkeypatch.setattr(converter, "extract_from_api_response", lambda *_args, **_kwargs: expected)
    result = converter.convert_ocr_result_to_unified_format((True, None, None, None, None, {"k": "v"}), "engine")
    assert result == expected


def test_convert_ocr_result_handles_list_and_unrecognized_types():
    lines = [{"text": "x", "bounding_rect": {"x1": 1}}]
    assert converter.convert_ocr_result_to_unified_format(lines, "engine") == lines
    assert converter.convert_ocr_result_to_unified_format([{"text": "x"}], "engine") is None
    assert converter.convert_ocr_result_to_unified_format("bad", "engine") is None


def test_extract_from_api_response_dispatches_formats(monkeypatch):
    monkeypatch.setattr(converter, "extract_from_google_lens_protobuf_response", lambda *_args, **_kwargs: ["pb"])
    monkeypatch.setattr(converter, "extract_from_google_lens_json_response", lambda *_args, **_kwargs: ["json"])

    assert converter.extract_from_api_response({"objects_response": {}}, "engine") == ["pb"]
    assert converter.extract_from_api_response({"textAnnotations": []}, "engine") == ["json"]
    assert converter.extract_from_api_response({"other": True}, "engine") is None


def test_extract_from_google_lens_protobuf_response():
    response = {
        "objects_response": {
            "text": {
                "text_layout": {
                    "paragraphs": [
                        {
                            "lines": [
                                {
                                    "words": [
                                        {"plain_text": "hello", "text_separator": " "},
                                        {"plain_text": "world", "text_separator": ""},
                                    ],
                                    "geometry": {
                                        "bounding_box": {
                                            "center_x": 0.5,
                                            "center_y": 0.4,
                                            "width": 0.2,
                                            "height": 0.1,
                                        }
                                    },
                                }
                            ]
                        }
                    ]
                }
            }
        }
    }

    result = converter.extract_from_google_lens_protobuf_response(response)
    assert result is not None
    assert result[0]["text"] == "hello world"
    assert result[0]["normalized"] is True
    assert result[0]["bounding_rect"]["x1"] == 0.4
    assert result[0]["bounding_rect"]["y4"] == 0.45


def test_extract_from_google_lens_protobuf_response_empty():
    assert converter.extract_from_google_lens_protobuf_response({"objects_response": {}}) is None


def test_extract_from_google_lens_json_response():
    response = {
        "textAnnotations": [
            {
                "text": "abc",
                "boundingBox": {
                    "normalizedVertices": [
                        {"x": 0.1, "y": 0.2},
                        {"x": 0.4, "y": 0.2},
                        {"x": 0.4, "y": 0.6},
                        {"x": 0.1, "y": 0.6},
                    ]
                },
            }
        ]
    }

    result = converter.extract_from_google_lens_json_response(response)
    assert result is not None
    assert result[0]["text"] == "abc"
    assert result[0]["bounding_rect"]["width"] == 0.30000000000000004
    assert result[0]["height"] == 0.39999999999999997
    assert result[0]["normalized"] is True


def test_extract_from_google_lens_json_response_empty():
    assert converter.extract_from_google_lens_json_response({"textAnnotations": []}) is None


def test_convert_normalized_coords_to_pixels():
    lines = [
        {
            "text": "a",
            "normalized": True,
            "bounding_rect": {
                "x1": 0.1,
                "y1": 0.2,
                "x2": 0.3,
                "y2": 0.2,
                "x3": 0.3,
                "y3": 0.4,
                "x4": 0.1,
                "y4": 0.4,
                "width": 0.2,
                "height": 0.2,
            },
            "height": 0.2,
        },
        {
            "text": "b",
            "normalized": False,
            "bounding_rect": {"x1": 1, "y1": 2},
            "height": 2,
        },
    ]
    converted = converter.convert_normalized_coords_to_pixels(lines, 200, 100)
    assert converted[0]["normalized"] is False
    assert converted[0]["bounding_rect"]["x1"] == 20.0
    assert converted[0]["bounding_rect"]["y4"] == 40.0
    assert converted[0]["height"] == 20.0
    assert converted[1] == lines[1]
