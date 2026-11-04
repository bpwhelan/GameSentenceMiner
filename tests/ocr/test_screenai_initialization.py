import ctypes
import gc
import threading
import weakref
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from GameSentenceMiner.owocr.owocr import ocr as ocr_module


@pytest.fixture
def screenai_runtime(monkeypatch, tmp_path):
    engine_class = ocr_module.ScreenAIOCR
    library_path = tmp_path / "chrome_screen_ai.dll"
    model = Mock()
    model.InitOCRUsingCallback.return_value = True
    load = Mock(return_value=model)
    monkeypatch.setattr(engine_class, "_shared_runtime", None)
    monkeypatch.setattr(engine_class, "_library_names_for_platform", lambda *_args: [library_path.name])
    monkeypatch.setattr(engine_class, "_resolve_library_candidates", lambda *_args: [library_path])
    monkeypatch.setattr(engine_class, "_load_screen_ai_library", load)
    monkeypatch.setattr(ocr_module, "_load_screen_ai_pb2", lambda: None)
    return engine_class, model, load, tmp_path


def test_concurrent_screenai_constructors_initialize_native_runtime_once(screenai_runtime, monkeypatch):
    engine_class, model, load, _root = screenai_runtime
    constructors_ready = threading.Barrier(2)
    second_native_init = threading.Event()
    native_calls_lock = threading.Lock()
    native_calls = 0

    def load_parser():
        constructors_ready.wait(timeout=5)

    def initialize():
        nonlocal native_calls
        with native_calls_lock:
            native_calls += 1
            if native_calls > 1:
                second_native_init.set()
        # Give an overlapping constructor a chance to enter the native runtime.
        second_native_init.wait(timeout=0.2)
        return True

    monkeypatch.setattr(ocr_module, "_load_screen_ai_pb2", load_parser)
    model.InitOCRUsingCallback.side_effect = initialize

    with ThreadPoolExecutor(max_workers=2) as pool:
        engines = list(pool.map(lambda language: engine_class(lang=language), ["ja", "en"]))

    assert all(engine.available for engine in engines)
    assert [engine.lang for engine in engines] == ["ja", "en"]
    assert engines[0].model is engines[1].model
    assert engines[0]._size_callback is engines[1]._size_callback
    assert engines[0]._data_callback is engines[1]._data_callback
    assert engines[0]._resource_cache is engines[1]._resource_cache
    assert native_calls == 1
    load.assert_called_once()
    model.SetFileContentFunctions.assert_called_once()
    model.SetOCRLightMode.assert_called_once()


@pytest.mark.parametrize("failure", [False, OSError("exception: access violation reading 0x9")])
def test_failed_screenai_initialization_is_not_retried_in_same_process(screenai_runtime, failure):
    engine_class, model, load, _root = screenai_runtime
    if isinstance(failure, Exception):
        model.InitOCRUsingCallback.side_effect = failure
    else:
        model.InitOCRUsingCallback.return_value = failure

    first = engine_class()
    assert not first.available
    second = engine_class()

    assert not second.available
    model.InitOCRUsingCallback.assert_called_once()
    model.SetFileContentFunctions.assert_called_once()
    model.SetOCRLightMode.assert_not_called()
    load.assert_called_once()


def test_failed_screenai_runtime_keeps_native_callbacks_alive(screenai_runtime):
    engine_class, model, _load, root = screenai_runtime
    model.InitOCRUsingCallback.return_value = False
    (root / "test-model.bin").write_bytes(b"model contents")
    engine = engine_class()
    size_callback_ref = weakref.ref(engine._size_callback)
    data_callback_ref = weakref.ref(engine._data_callback)
    model.reset_mock()
    del engine
    gc.collect()

    # ScreenAI can retain callback pointers and background work after a partial
    # initialization. Those pointers must stay callable until process exit.
    size_callback = size_callback_ref()
    data_callback = data_callback_ref()
    assert size_callback is not None
    assert data_callback is not None
    assert size_callback(b"test-model.bin") == len(b"model contents")
    output = ctypes.create_string_buffer(len(b"model contents"))
    data_callback(b"test-model.bin", len(output), output)
    assert output.raw == b"model contents"


def test_screenai_reuses_successful_runtime_for_later_instances(screenai_runtime):
    engine_class, model, load, _root = screenai_runtime
    first = engine_class(lang="ja")
    second = engine_class(lang="en")

    assert first.available and second.available
    assert first._size_callback is second._size_callback
    assert first._resource_cache is second._resource_cache
    assert first.lang == "ja" and second.lang == "en"
    model.InitOCRUsingCallback.assert_called_once()
    load.assert_called_once()
