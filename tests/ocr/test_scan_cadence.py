from itertools import pairwise
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw

from GameSentenceMiner.owocr.owocr import ocr_runtime as runtime


@pytest.fixture
def scan_loop(monkeypatch):
    """Exercise the real periodic loop with a clock and capture device we control."""

    def run(
        *,
        detector="vocr_detector",
        boxes=True,
        text="",
        frames=250,
        capture_seconds=0.04,
        ocr_seconds=0.015,
        scan_rate=0.1,
    ):
        engine_name = detector or "recognizer"
        clock = SimpleNamespace(now=100.0)
        reads, messages = [], []
        image = Image.new("RGB", (100, 60), "black")
        ImageDraw.Draw(image).rectangle((10, 10, 80, 40), fill="white")

        def now():
            # Account for normal Python loop overhead; no wall-clock waits.
            clock.now += 0.000001
            assert clock.now < 2000, "Periodic loop failed to finish"
            return clock.now

        def sleep(delay):
            assert delay >= 0
            clock.now += delay

        class Event:
            def set(self):
                clock.now += capture_seconds
                runtime.periodic_screenshot_queue.put((image, {"capture_source": "test"}))

        class Engine:
            name = engine_name
            key = "{"
            readable_name = "Test detector"
            available = True
            local = True

        def recognize(*_args, **_kwargs):
            reads.append(clock.now)
            clock.now += ocr_seconds
            if len(reads) >= frames:
                runtime.terminated = True
            has_boxes = boxes(len(reads)) if callable(boxes) else boxes
            payload = (
                {
                    "schema": runtime.TEXT_DETECTION_RESULT_SCHEMA,
                    "detector": detector,
                    "boxes": [{"box": [10, 10, 80, 40]}] if has_boxes else [],
                }
                if detector
                else None
            )
            return [], text, payload

        config = {"engines": "", "engine_color": "cyan", "pause_at_startup": False, "auto_pause": 0}
        sink = SimpleNamespace(info=lambda *_a, **_k: None)
        monkeypatch.setattr(
            runtime,
            "logger",
            SimpleNamespace(
                opt=lambda **_k: sink, info=lambda *_a: None, success=lambda *_a: None, background=messages.append
            ),
        )
        monkeypatch.setattr(
            runtime,
            "config",
            SimpleNamespace(has_config=False, get_general=lambda key: config.get(key, ""), get_engine=lambda _: None),
        )
        monkeypatch.setattr(runtime, "time", SimpleNamespace(time=now, monotonic=now, sleep=sleep))
        monkeypatch.setattr(
            runtime,
            "threading",
            SimpleNamespace(Event=Event, current_thread=lambda: "worker", main_thread=lambda: "main"),
        )
        monkeypatch.setattr(runtime, "inspect", SimpleNamespace(getmembers=lambda *_a: [("TestEngine", Engine)]))
        monkeypatch.setattr(runtime, "OBSScreenshotThread", lambda *_a, **_k: SimpleNamespace(start=lambda: None))
        monkeypatch.setattr(runtime, "_create_notifier", lambda: None)
        monkeypatch.setattr(runtime, "TextFiltering", lambda: None)
        monkeypatch.setattr(runtime, "get_ocr_ocr1", lambda: engine_name)
        monkeypatch.setattr(runtime, "get_ocr_ocr2", lambda: engine_name)
        monkeypatch.setattr(runtime, "get_ocr_scan_rate", lambda: scan_rate)
        monkeypatch.setattr(runtime, "get_ocr_two_pass_ocr", lambda: True)
        monkeypatch.setattr(runtime, "get_ocr_advanced_debug_logging", lambda: False)
        monkeypatch.setattr(runtime, "process_and_write_results", recognize)
        monkeypatch.setattr(runtime, "USE_OCR_IMAGE_STABILITY_GATE", False)
        # Restore runtime state after the real run() mutates its globals.
        for name in (
            "terminated",
            "engine_instances",
            "engine_keys",
            "engine_index",
            "paused",
            "screenshot_thread",
            "obs_screenshot_thread",
            "image_queue",
            "periodic_screenshot_queue",
            "screenshot_event",
            "ocr_1",
            "ocr_2",
            "just_unpaused",
            "first_pressed",
            "auto_pause_handler",
            "notifier",
            "websocket_server_thread",
        ):
            monkeypatch.setattr(runtime, name, getattr(runtime, name, None), raising=False)
        runtime.run(
            read_from="obs",
            read_from_secondary="",
            write_to="callback",
            ocr1=engine_name,
            ocr2=engine_name,
            combo_pause="",
            combo_engine_switch="",
            screen_capture_combo="",
            disable_user_input=True,
            configure_logger=False,
        )
        return [b - a for a, b in pairwise(reads)], messages

    return run


@pytest.mark.parametrize("detector", ["vocr_detector", "meiki_text_detector"])
def test_detected_boxes_keep_configured_cadence_over_a_long_session(scan_loop, detector):
    intervals, messages = scan_loop(detector=detector)
    assert max(intervals) < 0.12
    assert "No text detected, sleeping." not in messages


@pytest.mark.parametrize("scan_rate", [0.1, 0.15, 0.25])
def test_capture_and_recognition_time_are_included_in_the_scan_interval(scan_loop, scan_rate):
    intervals, _ = scan_loop(detector="", text="recognized text", frames=30, scan_rate=scan_rate)
    assert max(intervals) < scan_rate + 0.01
    assert min(intervals) >= scan_rate - 0.001


def test_slow_recognition_runs_as_fast_as_processing_allows(scan_loop):
    intervals, _ = scan_loop(frames=20, capture_seconds=0.04, ocr_seconds=0.2)
    assert min(intervals) >= 0.24
    assert max(intervals) < 0.25


def test_detector_empty_results_still_use_idle_backoff(scan_loop):
    intervals, messages = scan_loop(boxes=False, frames=100)
    assert intervals[-1] > 0.5
    assert "No text detected, sleeping." in messages


def test_detection_resets_backoff_after_a_blank_spell(scan_loop):
    intervals, _ = scan_loop(boxes=lambda index: index > 70, frames=100)
    assert intervals[68] > 0.4
    assert max(intervals[71:]) < 0.12
