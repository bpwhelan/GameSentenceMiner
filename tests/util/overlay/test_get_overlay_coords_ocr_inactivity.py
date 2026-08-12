import importlib

from GameSentenceMiner.util.overlay import get_overlay_coords


screenshot_capture_module = importlib.import_module("GameSentenceMiner.obs.screenshot_capture")


class _FakeTimerHandle:
    def __init__(self):
        self.cancelled = False

    def cancel(self):
        self.cancelled = True


class _FakeLoop:
    def __init__(self):
        self.calls = []

    def call_later(self, delay, callback, *args):
        handle = _FakeTimerHandle()
        self.calls.append((delay, callback, args, handle))
        return handle


class _FakeEngine:
    def __init__(self):
        self.close_calls = 0

    def close(self):
        self.close_calls += 1


def test_schedules_ocr_engine_unload_after_five_minutes():
    processor = get_overlay_coords.OverlayProcessor()
    processor.processing_loop = _FakeLoop()

    processor._schedule_ocr_engine_unload()

    delay, _, _, _ = processor.processing_loop.calls[0]
    assert delay == 5 * 60


def test_new_ocr_activity_cancels_pending_unload():
    processor = get_overlay_coords.OverlayProcessor()
    processor.processing_loop = _FakeLoop()
    processor._schedule_ocr_engine_unload()
    handle = processor.processing_loop.calls[0][3]

    processor._mark_ocr_engine_active()

    assert handle.cancelled is True
    assert processor._ocr_engine_unload_handle is None


def test_inactivity_unloads_all_ocr_engines_and_capture_session(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    engines = [_FakeEngine() for _ in range(4)]
    processor.oneocr, processor.meikiocr, processor.screenai, processor.lens = engines
    stop_capture_calls = []
    monkeypatch.setattr(screenshot_capture_module, "stop_wgc_sessions", lambda: stop_capture_calls.append(True))

    processor._unload_ocr_engines_if_inactive(processor._ocr_engine_activity_generation)

    assert [engine.close_calls for engine in engines] == [1, 1, 1, 1]
    assert processor.oneocr is None
    assert processor.meikiocr is None
    assert processor.screenai is None
    assert processor.lens is None
    assert stop_capture_calls == [True]


def test_stale_inactivity_callback_does_not_unload_active_engine_or_capture(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    engine = _FakeEngine()
    processor.oneocr = engine
    stop_capture_calls = []
    monkeypatch.setattr(screenshot_capture_module, "stop_wgc_sessions", lambda: stop_capture_calls.append(True))
    stale_generation = processor._ocr_engine_activity_generation
    processor._mark_ocr_engine_active()

    processor._unload_ocr_engines_if_inactive(stale_generation)

    assert engine.close_calls == 0
    assert processor.oneocr is engine
    assert stop_capture_calls == []
