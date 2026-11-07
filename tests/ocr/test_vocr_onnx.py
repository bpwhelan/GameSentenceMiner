"""Native-independent checks for VOCR's portable inference path."""

import numpy as np
import pytest
from PIL import Image

from GameSentenceMiner.ocr import vocr_onnx


def test_backend_selection_keeps_native_available(monkeypatch, tmp_path):
    monkeypatch.setenv("GSM_VOCR_BACKEND", "auto")
    monkeypatch.setenv("GSM_VITA_OCR_DIR", str(tmp_path))
    assets = tmp_path / "onnx"
    assets.mkdir()
    (assets / "manifest.json").write_text("{}", encoding="utf-8")
    assert vocr_onnx.selected_directory() == vocr_onnx.bundled_directory()
    monkeypatch.setenv("GSM_VOCR_BACKEND", "c")
    assert vocr_onnx.selected_directory() is None


def test_explicit_onnx_request_does_not_silently_load_c(monkeypatch, tmp_path):
    monkeypatch.setenv("GSM_VOCR_BACKEND", "onnx")
    monkeypatch.setattr(vocr_onnx, "bundled_directory", lambda: tmp_path)
    with pytest.raises(FileNotFoundError, match="bundled"):
        vocr_onnx.selected_directory()


def test_corrupt_export_is_rejected_before_onnx_load(monkeypatch, tmp_path):
    import json

    import onnxruntime as ort

    from GameSentenceMiner.ocr.vita_ocr import UPSTREAM_REVISION

    (tmp_path / "manifest.json").write_text(
        json.dumps({"revision": UPSTREAM_REVISION, "export_version": 1, "files": {"normal-faithful.onnx": "0" * 64}}),
        encoding="utf-8",
    )
    (tmp_path / "normal-faithful.onnx").write_bytes(b"broken model")
    monkeypatch.setattr(ort, "InferenceSession", lambda *a, **k: pytest.fail("Must not load a damaged model"))
    with pytest.raises(ValueError, match="checksum"):
        vocr_onnx.load_session(tmp_path, "normal-faithful.onnx", "recognizer")


def test_structural_detector_overflow_uses_python_grad(monkeypatch):
    from types import SimpleNamespace

    finder = object.__new__(vocr_onnx.ONNXLineFinder)
    finder.mode = "faithful"
    finder.metadata = {"revision": "test", "file": "textspot8"}
    finder.decode_model = SimpleNamespace()
    finder.detect_maps = lambda image: None
    monkeypatch.setattr(vocr_onnx, "spot_maps", lambda *args: SimpleNamespace(truncated=True, boxes=[]))
    monkeypatch.setattr(vocr_onnx, "_find_grad", lambda *args: ([(10, 20, 30, 15)], [1], False))
    boxes, metadata = finder.detect(Image.new("RGB", (1920, 1080)))
    assert metadata["finder"] == "grad"
    assert metadata["fallback_reason"]
    assert boxes[0]["box"] == (20, 40, 80, 70)
    assert boxes[0]["dark"] is True


def test_integer_luma_and_odd_half_scale():
    pixels = np.array([[[255, 0, 0], [0, 255, 0], [0, 0, 255]]], dtype=np.uint8)
    grey = vocr_onnx.grey_of(pixels)
    np.testing.assert_array_equal(grey, [[76, 149, 28]])
    np.testing.assert_array_equal(vocr_onnx.halve(grey), [[113, 28]])


def test_recognition_preprocessing_pads_last_column_and_inverts_before_resize():
    image = Image.fromarray(np.arange(33 * 9, dtype=np.uint8).reshape(33, 9))
    tensor, width = vocr_onnx.prepare_line(image, height=32, stride=8, max_width=1024, dark=True)
    assert width == 9
    assert tensor.shape == (1, 1, 32, 16)
    np.testing.assert_array_equal(tensor[..., 9:], np.repeat(tensor[..., 8:9], 7, axis=-1))
    assert tensor.dtype == np.float32
    assert -1 <= tensor.min() <= tensor.max() <= 1


def test_palette_images_use_palette_colors_for_recognition():
    image = Image.new("P", (19, 17), 1)
    image.putpalette([0, 0, 0, 255, 0, 0] + [0] * (768 - 6))
    actual, width = vocr_onnx.prepare_line(image)
    expected, expected_width = vocr_onnx.prepare_line(image.convert("RGBA"))
    assert width == expected_width
    np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize("size", [(0, 10), (10, 0), (16385, 1), (8001, 8000)])
def test_rejects_unsupported_capture_before_allocating(size):
    with pytest.raises(ValueError, match="dimensions"):
        vocr_onnx.check_dimensions(*size)


def test_ctc_keeps_repeats_separated_by_blank_and_character_cells():
    vocab = ["", "日", "本"]
    best = np.array([0, 1, 1, 0, 1, 2, 2, 0])
    text, characters = vocr_onnx.decode_line(best, vocab, np.zeros((32, 64), dtype=np.uint8), 64, stride=8)
    assert text == "日日本"
    assert "".join(c["text"] for c in characters) == text
    assert all(0 <= c["box"][0] < c["box"][0] + c["box"][2] <= 64 for c in characters)
    assert characters[0]["box"][0] + characters[0]["box"][2] == characters[1]["box"][0]


@pytest.mark.parametrize("reduction", [48, 96, 288, 512, 960])
def test_exported_quantized_matrix_matches_integer_reference(tmp_path, reduction):
    pytest.importorskip("onnx")
    import onnxruntime as ort
    from onnx import TensorProto as T
    from onnx import helper as H

    from scripts.export_vocr_onnx import Graph

    rng = np.random.default_rng(321)
    x = rng.normal(0, 7, (17, reduction)).astype(np.float32)
    x[0] = 0
    weight = rng.integers(-127, 128, (24, reduction), dtype=np.int8)
    scale = rng.uniform(0.001, 0.1, 24).astype(np.float32)
    bias = rng.normal(size=24).astype(np.float32)
    g = Graph()
    output = g.matrix("x", weight, scale, bias, "faithful")
    target = tmp_path / "matrix.onnx"
    g.save(
        target,
        [H.make_tensor_value_info("x", T.FLOAT, [17, reduction])],
        [H.make_tensor_value_info(output, T.FLOAT, [17, 24])],
        {},
    )
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(target), sess_options=options, providers=["CPUExecutionProvider"])
    actual = session.run(None, {"x": x})[0]
    maximum = np.abs(x).max(-1, keepdims=True)
    scaled = x * (np.float32(32767) / np.where(maximum > 0, maximum, np.float32(1)))
    q = (np.sign(scaled) * np.floor(np.abs(scaled) + np.float32(0.5))).clip(-32767, 32767).astype(np.int64)
    expected = np.zeros((17, 24), np.float32)
    for start in range(0, reduction, 512):
        expected += (q[:, start : start + 512] @ weight[:, start : start + 512].astype(np.int64).T).astype(np.float32)
    expected = expected * (maximum / np.float32(32767) * scale) + bias
    np.testing.assert_array_equal(actual, expected)
