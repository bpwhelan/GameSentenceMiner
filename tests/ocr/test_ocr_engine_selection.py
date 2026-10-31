from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from PIL import Image

from GameSentenceMiner.ocr import gsm_ocr
from GameSentenceMiner.owocr.owocr import ocr as ocr_module
from GameSentenceMiner.owocr.owocr import ocr_runtime


@pytest.fixture
def engine_runtime(monkeypatch):
    state = SimpleNamespace(created=[], calls=[], unavailable=set(), failed=set())

    class FirstOCR:
        __module__ = ocr_module.__name__
        name = "firstocr"
        readable_name = "First OCR"
        key = "f"

        def __init__(self):
            state.created.append(self.name)
            self.available = self.name not in state.unavailable

        def __call__(self, image, sensitivity):
            state.calls.append((self.name, image, sensitivity))
            if self.name in state.failed:
                return False, "Recognition failed"
            return True, f"Text from {self.name}", [], [], None, None

    class SecondOCR(FirstOCR):
        __module__ = ocr_module.__name__
        name = "secondocr"
        readable_name = "Second OCR"
        key = "s"

    state.first = FirstOCR()
    state.second_class = SecondOCR
    state.image = Image.new("RGB", (100, 50), "white")
    state.filtering = lambda text, _last_result, **_kwargs: (text, [text])
    monkeypatch.setattr(ocr_runtime, "TestFirstOCR", FirstOCR, raising=False)
    monkeypatch.setattr(ocr_runtime, "TestSecondOCR", SecondOCR, raising=False)
    monkeypatch.setattr(ocr_runtime, "engine_instances", [state.first], raising=False)
    monkeypatch.setattr(ocr_runtime, "engine_keys", [state.first.key], raising=False)
    monkeypatch.setattr(ocr_runtime, "engine_index", 0, raising=False)
    monkeypatch.setattr(ocr_runtime, "ocr_1", FirstOCR.name, raising=False)
    monkeypatch.setattr(ocr_runtime, "ocr_2", SecondOCR.name, raising=False)
    monkeypatch.setattr(ocr_runtime, "auto_pause_handler", None, raising=False)
    log_sink = SimpleNamespace(info=lambda *_args, **_kwargs: None)
    monkeypatch.setattr(ocr_runtime, "logger", SimpleNamespace(opt=lambda **_kwargs: log_sink))
    monkeypatch.setattr(
        ocr_runtime,
        "config",
        SimpleNamespace(
            get_general=lambda key: {"engine_color": "cyan", "notifications": False}.get(key),
            get_engine=lambda _name: None,
        ),
    )
    monkeypatch.setattr(ocr_runtime, "get_ocr_language", lambda: "en")
    monkeypatch.setattr(ocr_runtime, "get_ocr_keep_newline", lambda _source: False)
    monkeypatch.setattr(ocr_runtime, "get_ocr_advanced_debug_logging", lambda: False)
    monkeypatch.setattr(ocr_runtime, "do_configured_ocr_replacements", lambda text: text)
    return state


@pytest.mark.parametrize("requested_name", ["secondocr", " SECONDocr "])
def test_named_ocr_loads_changed_engine_once_without_switching_ocr1(engine_runtime, requested_name):
    state = engine_runtime
    for _ in range(2):
        chunks, text, payload = ocr_runtime.process_and_write_results(
            state.image, filtering=state.filtering, engine=requested_name, return_payload=True
        )
        assert text == "Text from secondocr"
        assert chunks == [text]
        assert payload["pipeline"]["engine"] == "secondocr"
    assert state.created == ["firstocr", "secondocr"]
    assert state.calls == [("secondocr", state.image, 0)] * 2
    assert ocr_runtime.engine_keys == ["f", "s"]
    assert ocr_runtime.engine_index == 0
    assert ocr_runtime.engine_instances[0] is state.first


def test_named_ocr_does_not_select_an_engine_with_a_shorter_name(engine_runtime):
    state = engine_runtime
    state.second_class.name = "firstocr_extra"
    _chunks, text = ocr_runtime.process_and_write_results(
        state.image, filtering=state.filtering, engine=state.second_class.name
    )
    assert text == "Text from firstocr_extra"
    assert state.calls == [("firstocr_extra", state.image, 0)]


@pytest.mark.parametrize("requested_name", ["secondocr", "unknownocr"])
def test_unavailable_named_engine_reports_which_engine_failed(engine_runtime, requested_name):
    state = engine_runtime
    state.unavailable.add(requested_name)
    with pytest.raises(RuntimeError, match=f"OCR engine '{requested_name}' is not available"):
        ocr_runtime.process_and_write_results(state.image, filtering=state.filtering, engine=requested_name)
    assert state.calls == []
    assert ocr_runtime.engine_instances == [state.first]
    assert ocr_runtime.engine_index == 0


def test_ocr2_failure_loads_missing_ocr1_for_fallback(monkeypatch, engine_runtime):
    state = engine_runtime
    second = state.second_class()
    state.failed.add(second.name)
    monkeypatch.setattr(ocr_runtime, "engine_instances", [second])
    monkeypatch.setattr(ocr_runtime, "engine_keys", [second.key])
    chunks, text, payload = ocr_runtime.process_and_write_results(
        state.image, filtering=state.filtering, engine=second.name, return_payload=True
    )
    assert text == "Text from firstocr"
    assert chunks == [text]
    assert payload["pipeline"]["engine"] == "firstocr"
    assert [name for name, *_ in state.calls] == ["secondocr", "firstocr"]


def test_area_select_delivers_text_after_engine_change(monkeypatch, engine_runtime):
    state = engine_runtime
    delivered = []
    controller = SimpleNamespace(last_ocr2_result=[], last_sent_result="", config=gsm_ocr.TwoPassConfig())
    monkeypatch.setattr(gsm_ocr, "get_controller", lambda: controller)
    monkeypatch.setattr(gsm_ocr, "get_ocr_ocr2", lambda: "secondocr")
    monkeypatch.setattr(gsm_ocr, "get_ocr_advanced_debug_logging", lambda: False)
    monkeypatch.setattr(gsm_ocr, "save_result_image", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "capture_ocr_metrics_sample", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "send_result", lambda text, _time, **kwargs: delivered.append((text, kwargs)))
    processor = object.__new__(gsm_ocr.OCRProcessor)
    processor.filtering = state.filtering

    processor.do_second_ocr(
        "",
        datetime(2026, 10, 29, tzinfo=UTC),
        state.image,
        state.filtering,
        ignore_previous_result=True,
        ignore_furigana_filter=True,
        source=gsm_ocr.TextSource.SCREEN_CROPPER,
    )

    assert len(delivered) == 1
    text, metadata = delivered[0]
    assert text == "Text from secondocr"
    assert metadata["source"] == gsm_ocr.TextSource.SCREEN_CROPPER
    assert metadata["response_dict"]["pipeline"]["engine"] == "secondocr"
