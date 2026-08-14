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


def test_ocr2_optimization_debug_images_capture_before_and_after_crop(monkeypatch, tmp_path):
    image = Image.new("RGB", (10, 8), color="black")
    image.putpixel((3, 2), (255, 0, 0))

    monkeypatch.setattr(gsm_ocr, "SAVE_OCR_DEBUG_IMAGES", True, raising=False)
    monkeypatch.setattr(gsm_ocr, "get_ocr_advanced_debug_logging", lambda: False)
    monkeypatch.setattr(gsm_ocr, "get_ocr_optimize_second_scan", lambda: True)
    monkeypatch.setattr(gsm_ocr, "get_temporary_directory", lambda: str(tmp_path))

    cropped = gsm_ocr.get_ocr2_image((2, 1, 6, 4), image, ocr2_engine="oneocr")

    assert cropped.size == (4, 3)
    assert (tmp_path / "last_ocr2_optimization_precrop.png").exists()
    assert (tmp_path / "last_ocr2_optimization_crop.png").exists()

    before = Image.open(tmp_path / "last_ocr2_optimization_precrop.png")
    after = Image.open(tmp_path / "last_ocr2_optimization_crop.png")
    assert before.size == image.size
    assert after.size == cropped.size
    assert before.getpixel((3, 2)) == (255, 0, 0)


def test_google_lens_ocr2_crop_keeps_minimum_context(monkeypatch):
    image = Image.new("RGB", (20, 20), color="black")
    image.putpixel((6, 6), (255, 0, 0))

    monkeypatch.setattr(gsm_ocr, "SAVE_OCR_DEBUG_IMAGES", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "get_ocr_advanced_debug_logging", lambda: False)
    monkeypatch.setattr(gsm_ocr, "get_ocr_optimize_second_scan", lambda: True)

    cropped = gsm_ocr.get_ocr2_image((6, 6, 10, 10), image, ocr2_engine="glens")

    padding = gsm_ocr.GOOGLE_LENS_OCR2_CONTEXT_PADDING
    assert cropped.size == (4 + 2 * padding, 4 + 2 * padding)
    assert cropped.getpixel((padding, padding)) == (255, 0, 0)


def test_google_lens_formula_only_response_requires_every_word_to_be_formula():
    def response(*word_types):
        return {
            "objects_response": {
                "text": {
                    "text_layout": {
                        "paragraphs": [
                            {
                                "lines": [
                                    {
                                        "words": [
                                            {"plain_text": text, **({"type": word_type} if word_type else {})}
                                            for text, word_type in word_types
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                }
            }
        }

    assert ocr_module.google_lens_response_is_formula_only(response(("lceil z rfloor", "FORMULA")))
    assert not ocr_module.google_lens_response_is_formula_only(response(("普通の文字", None), ("x", "FORMULA")))
    assert not ocr_module.google_lens_response_is_formula_only(response())


def test_ocr_runtime_marks_formula_only_google_lens_payload(monkeypatch):
    raw_response = {
        "objects_response": {
            "text": {
                "text_layout": {
                    "paragraphs": [
                        {
                            "lines": [
                                {
                                    "words": [
                                        {
                                            "plain_text": "lceil z -? rfloor",
                                            "type": "FORMULA",
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            }
        }
    }

    class FakeGoogleLens:
        name = "glens"
        readable_name = "Google Lens"

        def __call__(self, *_args, **_kwargs):
            return True, "lceil z -? rfloor", [], [], None, raw_response

    class FakeLogger:
        def opt(self, **_kwargs):
            return self

        def info(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(ocr_runtime, "engine_instances", [FakeGoogleLens()], raising=False)
    monkeypatch.setattr(ocr_runtime, "auto_pause_handler", None, raising=False)
    monkeypatch.setattr(ocr_runtime, "config", SimpleNamespace(get_general=lambda _key: "cyan"))
    monkeypatch.setattr(ocr_runtime, "logger", FakeLogger())
    monkeypatch.setattr(ocr_runtime, "get_ocr_language", lambda: "en")

    _chunks, _text, payload = ocr_runtime.process_and_write_results(
        Image.new("RGB", (20, 10), color="white"),
        engine="glens",
        return_payload=True,
    )

    assert payload["pipeline"]["ocr"]["google_lens_formula_only"] is True


def test_google_lens_uses_upstream_request_configuration(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 500

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return FakeResponse()

    monkeypatch.setattr(ocr_module, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(ocr_module.random, "randint", lambda *_args: 42)
    monkeypatch.setattr(ocr_module.random, "randbytes", lambda _size: b"a" * 16)
    monkeypatch.setattr(ocr_module.curl_cffi, "post", fake_post)

    engine = ocr_module.GoogleLens(lang="ja", get_furigana_sens_from_file=False)
    image = Image.new("RGB", (100, 100), color=(12, 34, 56))

    assert engine(image) == (False, "Unknown error!")
    assert captured["url"] == "https://lensfrontend-pa.googleapis.com/v1/crupload"
    assert captured["headers"] == {
        "Host": "lensfrontend-pa.googleapis.com",
        "Connection": "keep-alive",
        "Content-Type": "application/x-protobuf",
        "X-Goog-Api-Key": "AIzaSyDr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Dest": "empty",
    }
    assert captured["impersonate"] == "chrome"
    assert captured["timeout"] == 20

    request = engine._lens_proto_deps["LensOverlayServerRequestPb2"]()
    request.ParseFromString(captured["data"])
    context = request.objects_request.request_context
    assert context.request_id.uuid == 42
    assert context.request_id.sequence_id == 0
    assert context.request_id.image_sequence_id == 0
    assert context.request_id.analytics_id == b"a" * 16
    assert context.client_context.platform == engine._lens_proto_deps["PLATFORM_WEB"]
    assert context.client_context.surface == engine._lens_proto_deps["SURFACE_CHROMIUM"]
    assert context.client_context.locale_context.language == "ja"
    assert context.client_context.locale_context.region == "Asia/Tokyo"
    assert context.client_context.locale_context.time_zone == ""
    assert context.client_context.app_id == ""
    assert context.client_context.client_filters.filter[0].filter_type == engine._lens_proto_deps["AUTO_FILTER"]
    assert request.objects_request.image_data.payload.image_bytes == ocr_module.pil_image_to_bytes(image)
    assert request.objects_request.image_data.image_metadata.width == 100
    assert request.objects_request.image_data.image_metadata.height == 100


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
