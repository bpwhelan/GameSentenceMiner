from __future__ import annotations

import ctypes
from types import SimpleNamespace

from PIL import Image

import GameSentenceMiner.ocr.gsm_ocr as gsm_ocr
from GameSentenceMiner.owocr.owocr import ocr as ocr_module
from GameSentenceMiner.owocr.owocr import ocr_runtime


def test_ocr_diagnostic_file_writes_are_disabled_by_default(monkeypatch):
    saves = []

    class FakeImage:
        def save(self, *_args, **_kwargs):
            saves.append(True)

    monkeypatch.setattr(gsm_ocr, "SAVE_OCR_DEBUG_IMAGES", False, raising=False)

    gsm_ocr.save_result_image(FakeImage(), pre_crop_image=FakeImage())

    assert saves == []
    assert gsm_ocr.OCR_METRICS_CAPTURE_ENABLED is False


def test_meiki_does_not_convert_rgb_twice_or_probe_debug_directory(monkeypatch):
    class FakeModel:
        def run_ocr(self, image, punct_conf_factor):
            assert image.shape == (4, 6, 3)
            assert punct_conf_factor == 0.2
            return [
                {
                    "text": "字",
                    "chars": [{"char": "字", "bbox": [1, 1, 4, 3], "conf": 1.0}],
                }
            ]

    monkeypatch.setattr(
        ocr_module, "get_config", lambda: SimpleNamespace(vad=SimpleNamespace(use_cpu_for_inference_v2=True))
    )
    monkeypatch.setattr(ocr_module.SharedMeikiOCRModel, "get_model", lambda **_kwargs: FakeModel())
    monkeypatch.setattr(ocr_module, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(
        ocr_module.os.path,
        "exists",
        lambda _path: (_ for _ in ()).throw(AssertionError("debug directory should not be probed")),
    )

    convert_calls = 0
    original_convert = Image.Image.convert

    def counting_convert(self, *args, **kwargs):
        nonlocal convert_calls
        convert_calls += 1
        return original_convert(self, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "convert", counting_convert)

    engine = ocr_module.MeikiOCR(config={}, lang="ja", get_furigana_sens_from_file=False)
    result = engine(Image.new("RGB", (6, 4), color="white"), return_coords=True)

    assert result[0] is True
    assert convert_calls == 0


def test_screenai_native_call_does_not_duplicate_the_pixel_buffer(monkeypatch):
    output = ctypes.create_string_buffer(b"ok")

    class FakeModel:
        def PerformOCR(self, _bitmap, output_length):
            ctypes.cast(output_length, ctypes.POINTER(ctypes.c_uint32)).contents.value = 2
            return ctypes.addressof(output)

        def FreeLibraryAllocatedCharArray(self, _result_ptr):
            return None

    engine = ocr_module.ScreenAIOCR.__new__(ocr_module.ScreenAIOCR)
    engine.model = FakeModel()
    image = Image.new("RGBA", (3, 2), color=(1, 2, 3, 255))

    monkeypatch.setattr(
        ocr_module.ctypes,
        "create_string_buffer",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("pixel bytes were copied twice")),
    )

    assert engine._perform_ocr(image) == b"ok"


def test_callback_signature_is_cached(monkeypatch):
    calls = 0
    original_signature = ocr_runtime.inspect.signature

    def callback(*_args, raw_text=None):
        return raw_text

    def counting_signature(target):
        nonlocal calls
        calls += 1
        return original_signature(target)

    monkeypatch.setattr(ocr_runtime.inspect, "signature", counting_signature)

    first = ocr_runtime._get_callback_signature_support(callback)
    second = ocr_runtime._get_callback_signature_support(callback)

    assert first == second
    assert calls == 1


def test_exclusion_masks_reuse_one_image_draw_context(monkeypatch):
    calls = 0
    original_draw = ocr_runtime.ImageDraw.Draw

    def counting_draw(image):
        nonlocal calls
        calls += 1
        return original_draw(image)

    monkeypatch.setattr(ocr_runtime.ImageDraw, "Draw", counting_draw)
    config = SimpleNamespace(
        rectangles=[
            SimpleNamespace(coordinates=[0, 0, 2, 2], is_excluded=True, is_secondary=False),
            SimpleNamespace(coordinates=[2, 0, 2, 2], is_excluded=True, is_secondary=False),
            SimpleNamespace(coordinates=[0, 0, 6, 4], is_excluded=False, is_secondary=False),
        ]
    )

    processed, _offset = ocr_runtime.apply_ocr_config_to_image(
        Image.new("RGB", (6, 4), color="white"),
        config,
        return_full_size=False,
    )

    assert calls == 1
    assert processed.getpixel((0, 0)) == (0, 0, 0)


def test_changed_pil_frame_is_rejected_before_numpy_conversion(monkeypatch):
    reference = Image.new("RGB", (32, 32), color="black")
    reference_np = ocr_runtime.np.asarray(reference)
    candidate = reference.copy()
    candidate.putpixel((0, 0), (255, 0, 0))

    calls = 0
    original_asarray = ocr_runtime.np.asarray

    def counting_asarray(value):
        nonlocal calls
        calls += 1
        return original_asarray(value)

    monkeypatch.setattr(ocr_runtime.np, "asarray", counting_asarray)

    assert ocr_runtime.are_images_identical(candidate, reference, reference_np) is False
    assert calls == 0


def test_blank_frame_check_only_converts_a_small_pil_sample(monkeypatch):
    converted_pil_sizes = []
    converted_array_sizes = []
    original_asarray = ocr_runtime.np.asarray

    def tracking_asarray(value):
        if isinstance(value, Image.Image):
            converted_pil_sizes.append(value.size)
        result = original_asarray(value)
        converted_array_sizes.append(result.size)
        return result

    monkeypatch.setattr(ocr_runtime.np, "asarray", tracking_asarray)

    assert ocr_runtime._is_capture_frame_empty(Image.new("RGB", (1920, 1080), color=(10, 10, 10))) is True
    assert converted_pil_sizes == []
    assert converted_array_sizes
    assert max(converted_array_sizes) < 1920 * 1080 * 3 // 100
