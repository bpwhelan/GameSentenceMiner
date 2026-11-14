from __future__ import annotations

import asyncio
import copy
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
from PIL import Image

from GameSentenceMiner.util.overlay import get_overlay_coords


def _line(text="OCR", *, left=50, top=22, right=135, bottom=58):
    rect = {"x1": left, "y1": top, "x2": right, "y2": top, "x3": right, "y3": bottom, "x4": left, "y4": bottom}
    return {"text": text, "bounding_rect": rect, "words": [{"text": text, "bounding_rect": rect.copy()}]}


def _frame(*, left=None, seed=0):
    pixels = np.random.default_rng(seed).integers(20, 80, size=(80, 240), dtype=np.uint8)
    if left is not None:
        cv2.putText(pixels, "OCR", (left + 5, 52), cv2.FONT_HERSHEY_SIMPLEX, 1.2, 245, 2, cv2.LINE_AA)
    return Image.fromarray(pixels)


def _processor(monkeypatch, engine):
    monkeypatch.setattr(get_overlay_coords.get_config().general, "target_language", "en")
    processor = get_overlay_coords.OverlayProcessor()
    processor.ocr_language = "en"
    processor.oneocr = engine
    processor.current_engine_config = get_overlay_coords.OverlayEngine.ONEOCR.value
    config = SimpleNamespace(
        engine_v2=processor.current_engine_config,
        last_sent_ocr_presence_check=True,
        last_sent_ocr_presence_remove_notation=True,
        last_sent_ocr_presence_invalidate_lookups=True,
        use_text_filtering=False,
        use_overlay_area_config=False,
        minimum_character_size=0,
    )
    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", lambda: config)
    monkeypatch.setattr(get_overlay_coords, "is_windows", lambda: True)
    monkeypatch.setattr(get_overlay_coords.websocket_manager, "has_clients", lambda _channel: True)
    monkeypatch.setattr(get_overlay_coords, "LAST_SENT_PRESENCE_SCAN_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(processor, "_get_overlay_minimum_character_size", lambda: 0)
    return processor


def _ocr_result(lines):
    return True, [line["text"] for line in lines], copy.deepcopy(lines), [], None, None


def test_moved_text_is_rescanned_once_repositioned_and_monitored_at_its_new_location(monkeypatch):
    frames = [
        _frame(left=50, seed=1),
        _frame(left=50, seed=2),
        _frame(left=150, seed=3),
        _frame(left=150, seed=4),
        _frame(left=150, seed=5),
        _frame(left=150, seed=6),
        _frame(seed=7),
        _frame(seed=8),
        _frame(left=150, seed=9),
    ]
    captures = iter(frames)
    scans = []
    coordinate_sends = []
    overlay_sends = []
    finished = asyncio.Event()
    moved_line = _line(left=150, right=235)

    def scan(image, **kwargs):
        scans.append((image, kwargs))
        if len(scans) == 1:
            return _ocr_result([_line("MENU"), moved_line])
        return _ocr_result([])

    processor = _processor(monkeypatch, scan)
    geometry = ((240, 80), 100, 50, 480, 160, 1000, 500, "test")

    def capture(data):
        frame = next(captures)
        pixel_payload = processor._presence_pixel_payload(
            data,
            frame,
            offset_x=100,
            offset_y=50,
            content_width=480,
            content_height=160,
            monitor_width=1000,
            monitor_height=500,
        )
        return frame, geometry, pixel_payload

    async def coordinate_send(payload):
        coordinate_sends.append(copy.deepcopy(payload))

    async def overlay_send(_channel, payload):
        overlay_sends.append(payload)
        if payload["type"] == "ocr_text_revalidated":
            finished.set()

    monkeypatch.setattr(processor, "_capture_last_sent_presence_frame", capture)
    monkeypatch.setattr(get_overlay_coords, "send_word_coordinates_to_overlay", coordinate_send)
    monkeypatch.setattr(get_overlay_coords.websocket_manager, "send", overlay_send)
    payload = {
        "type": "word_coordinates",
        "presence_id": "moving-text",
        "line_id": "dialogue-1",
        "latest_text": "OCR",
        "is_final": True,
        "is_sentence_recycled": False,
        "data": processor._convert_source_space_results_to_percentages(
            [_line()], 240, 80, 480, 160, 1000, 500, 100, 50
        ),
    }

    async def run():
        task = asyncio.create_task(processor._monitor_last_sent_overlay_text("moving-text", payload, 0))
        processor._last_sent_presence_task = task
        try:
            await asyncio.wait_for(finished.wait(), timeout=1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())

    assert [image for image, _ in scans] == [frames[3], frames[7]]
    assert all(kwargs["return_coords"] for _, kwargs in scans)
    assert all(kwargs["language"] == "en" for _, kwargs in scans)
    assert len(coordinate_sends) == 1
    replacement = coordinate_sends[0]
    assert {key: value for key, value in replacement.items() if key != "data"} == {
        key: value for key, value in payload.items() if key != "data"
    }
    assert [line["text"] for line in replacement["data"]] == ["OCR"]
    assert replacement["data"][0]["bounding_rect"]["x1"] == pytest.approx(0.4)
    assert replacement["data"][0]["words"][0]["bounding_rect"]["x1"] == pytest.approx(0.4)
    assert replacement["data"][0]["words"][0]["text"] == "OCR "
    assert [message["type"] for message in overlay_sends] == ["ocr_text_invalidated", "ocr_text_revalidated"]
    assert overlay_sends[1]["payload"]["data"] == replacement["data"]
    # A later window move must also reuse the new positions.
    assert processor.last_raw_results["lines"][0]["bounding_rect"] == moved_line["bounding_rect"]


@pytest.mark.parametrize(
    ("expected", "scanned", "matched"),
    [
        (["OCR"], ["MENU", "OCR"], ["OCR"]),
        (["今日はいい天気ですね"], ["今日はいい", "天気ですね"], ["今日はいい", "天気ですね"]),
        (["HP", "今日はいい天気ですね"], ["今日はいい天気ですね", "HP"], ["今日はいい天気ですね", "HP"]),
        (["１２３", "今日は、いい天気ですね！"], ["123", "今日は いい天気ですね"], ["123", "今日は いい天気ですね"]),
        (["今日はいい天気ですね"], ["今日はいい天汽ですね"], ["今日はいい天汽ですね"]),
        (["今日はいい天気ですね"], ["今日はいい"], []),
        (["今日はいい天気ですね", "OPTIONSAUTOSAVELOG"], ["OPTIONSAUTOSAVELOG"], []),
        (["OCR"], ["OTHER"], []),
        (["OCR", "OCR"], ["OCR"], []),
        ([""], ["OCR"], []),
    ],
)
def test_presence_text_matching_requires_the_previous_text_and_ignores_other_screen_text(expected, scanned, matched):
    result = get_overlay_coords.OverlayProcessor._match_last_sent_presence_lines(
        [_line(text) for text in expected], [_line(text) for text in scanned]
    )
    assert [line["text"] for line in result] == matched


@pytest.mark.parametrize("outcome", ["empty", "unrelated", "failed", "exception", "unavailable"])
def test_secondary_scan_failure_does_not_claim_the_previous_text_is_present(monkeypatch, outcome):
    def scan(_image, **_kwargs):
        if outcome == "exception":
            raise RuntimeError("OCR failed")
        if outcome == "failed":
            return False, "OCR failed"
        return _ocr_result([_line("OTHER")] if outcome == "unrelated" else [])

    processor = _processor(monkeypatch, None if outcome == "unavailable" else scan)
    if outcome == "unavailable":
        monkeypatch.setattr(get_overlay_coords, "OneOCR", None)

    assert not processor._rescan_last_sent_overlay_text(_frame(), [_line()])


def test_secondary_scan_applies_area_exclusions_without_mutating_the_presence_frame(monkeypatch):
    scans = []
    processor = _processor(monkeypatch, lambda image, **_kwargs: scans.append(image) or _ocr_result([]))
    area = SimpleNamespace(rectangles=[SimpleNamespace(is_excluded=True, coordinates=[150, 20, 85, 40])])
    monkeypatch.setattr(processor, "_get_effective_overlay_area_config", lambda *_args: area)
    frame = _frame(left=150)
    original = np.asarray(frame).copy()

    processor._rescan_last_sent_overlay_text(frame, [_line()])

    assert len(scans) == 1
    assert np.array_equal(np.asarray(frame), original)
    assert not np.array_equal(np.asarray(scans[0]), original)


def test_secondary_scan_loads_local_engine_for_lens_without_a_cloud_request(monkeypatch):
    processor = _processor(monkeypatch, None)
    config = get_overlay_coords.get_overlay_config()
    config.engine_v2 = get_overlay_coords.OverlayEngine.LENS.value
    constructed = []

    def oneocr(**kwargs):
        constructed.append(kwargs)
        return lambda _image, **_kwargs: _ocr_result([_line()])

    def lens(**_kwargs):
        pytest.fail("Presence checks must not make a Lens request")

    monkeypatch.setattr(get_overlay_coords, "OneOCR", oneocr)
    monkeypatch.setattr(get_overlay_coords, "GoogleLens", lens)

    assert processor._rescan_last_sent_overlay_text(_frame(left=50), [_line()])
    assert len(constructed) == 1


@pytest.mark.parametrize(
    ("engine_name", "constructor"),
    [("MeikiOCR", "MeikiOCR"), ("ScreenAI", "ScreenAIOCR")],
)
def test_secondary_scan_uses_the_selected_local_engine(monkeypatch, engine_name, constructor):
    processor = _processor(monkeypatch, None)
    config = get_overlay_coords.get_overlay_config()
    config.engine_v2 = (
        get_overlay_coords.OverlayEngine.MEIKIOCR.value
        if engine_name == "MeikiOCR"
        else get_overlay_coords.OverlayEngine.SCREENAI.value
    )
    calls = []

    def create_engine(**kwargs):
        calls.append(kwargs)
        return lambda _image, **_kwargs: _ocr_result([_line()])

    monkeypatch.setattr(get_overlay_coords, constructor, create_engine)

    assert processor._rescan_last_sent_overlay_text(_frame(left=50), [_line()])
    assert len(calls) == 1


def test_newer_overlay_event_supersedes_a_completed_presence_rescan(monkeypatch):
    processor = _processor(monkeypatch, None)
    frames = iter([_frame(left=50), _frame(), _frame()])
    monkeypatch.setattr(
        processor,
        "_capture_last_sent_presence_frame",
        lambda _data: (next(frames), ((240, 80), 0, 0, 240, 80, 240, 80, "test"), {"line_coords": [_line()]}),
    )
    scans = []

    def scan(_image, _data):
        scans.append(True)
        asyncio.get_running_loop().call_soon(processor._cancel_last_sent_presence_monitor)
        return [_line(left=150, right=235)]

    async def unexpected_send(*_args):
        pytest.fail("A superseded presence check must not send coordinates or invalidate newer text")

    monkeypatch.setattr(processor, "_rescan_last_sent_overlay_text", scan)
    monkeypatch.setattr(get_overlay_coords, "send_word_coordinates_to_overlay", unexpected_send)
    monkeypatch.setattr(get_overlay_coords.websocket_manager, "send", unexpected_send)

    asyncio.run(processor._monitor_last_sent_overlay_text("old-text", {"data": [_line()]}, 0))

    assert scans == [True]


def test_presence_monitor_waits_to_capture_when_game_is_already_paused(monkeypatch):
    processor = _processor(monkeypatch, None)
    monkeypatch.setattr(get_overlay_coords, "LAST_SENT_PRESENCE_SCAN_INTERVAL_SECONDS", 0.005)
    state = {"paused": True, "generation": 1}
    monkeypatch.setattr(
        get_overlay_coords,
        "get_game_process_pause_state",
        lambda: (state["paused"], state["generation"]),
        raising=False,
    )
    captured = asyncio.Event()
    captures = []

    def capture(_data):
        captures.append(state["paused"])
        captured.set()
        return _frame(left=50), ((240, 80), 0, 0, 240, 80, 240, 80, "test"), {"line_coords": [_line()]}

    monkeypatch.setattr(processor, "_capture_last_sent_presence_frame", capture)

    async def run():
        task = asyncio.create_task(processor._monitor_last_sent_overlay_text("text", {"data": [_line()]}, 0))
        try:
            await asyncio.sleep(0.03)
            assert captures == []
            state["paused"] = False
            await asyncio.wait_for(captured.wait(), timeout=1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())
    assert captures == [False]


def test_presence_monitor_skips_paused_game_and_resets_misses_on_resume(monkeypatch):
    processor = _processor(monkeypatch, None)
    monkeypatch.setattr(get_overlay_coords, "LAST_SENT_PRESENCE_SCAN_INTERVAL_SECONDS", 0.01)
    state = {"paused": False, "generation": 0}
    monkeypatch.setattr(
        get_overlay_coords,
        "get_game_process_pause_state",
        lambda: (state["paused"], state["generation"]),
        raising=False,
    )
    first_miss = asyncio.Event()
    first_after_resume = asyncio.Event()
    invalidated = asyncio.Event()
    captures = []
    scans = []
    sends = []

    def capture(_data):
        captures.append(state["paused"])
        if len(captures) == 2:
            first_miss.set()
        if len(captures) == 3:
            first_after_resume.set()
        frame = _frame(left=50) if len(captures) == 1 else _frame()
        return frame, ((240, 80), 0, 0, 240, 80, 240, 80, "test"), {"line_coords": [_line()]}

    def scan(_image, _data):
        scans.append(state["paused"])
        return []

    async def send(_channel, payload):
        sends.append(payload)
        invalidated.set()

    monkeypatch.setattr(processor, "_capture_last_sent_presence_frame", capture)
    monkeypatch.setattr(processor, "_rescan_last_sent_overlay_text", scan)
    monkeypatch.setattr(get_overlay_coords.websocket_manager, "send", send)

    async def run():
        task = asyncio.create_task(processor._monitor_last_sent_overlay_text("text", {"data": [_line()]}, 0))
        try:
            await asyncio.wait_for(first_miss.wait(), timeout=1)
            state.update(paused=True, generation=1)
            await asyncio.sleep(0.04)
            assert captures == [False, False]
            assert scans == []
            assert sends == []
            state["paused"] = False
            await asyncio.wait_for(first_after_resume.wait(), timeout=1)
            assert scans == []
            assert sends == []
            await asyncio.wait_for(invalidated.wait(), timeout=1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())
    assert captures == [False] * 4
    assert scans == [False]
    assert [payload["type"] for payload in sends] == ["ocr_text_invalidated"]


def test_presence_rescan_discards_results_if_a_pause_occurs_during_ocr(monkeypatch):
    processor = _processor(monkeypatch, None)
    monkeypatch.setattr(get_overlay_coords, "LAST_SENT_PRESENCE_SCAN_INTERVAL_SECONDS", 0.001)
    state = {"paused": False, "generation": 0}
    monkeypatch.setattr(
        get_overlay_coords,
        "get_game_process_pause_state",
        lambda: (state["paused"], state["generation"]),
        raising=False,
    )
    frames = iter([_frame(left=50)] + [_frame()] * 4)
    scans = []
    sends = []
    finished = asyncio.Event()
    monkeypatch.setattr(
        processor,
        "_capture_last_sent_presence_frame",
        lambda _data: (next(frames), ((240, 80), 0, 0, 240, 80, 240, 80, "test"), {"line_coords": [_line()]}),
    )

    def scan(_image, _data):
        scans.append(True)
        if len(scans) == 1:
            # A complete pause and resume can happen while OCR is running.
            state["generation"] += 1
        return []

    async def send(_channel, payload):
        sends.append((len(scans), payload))
        finished.set()

    monkeypatch.setattr(processor, "_rescan_last_sent_overlay_text", scan)
    monkeypatch.setattr(get_overlay_coords.websocket_manager, "send", send)

    async def run():
        task = asyncio.create_task(processor._monitor_last_sent_overlay_text("text", {"data": [_line()]}, 0))
        try:
            await asyncio.wait_for(finished.wait(), timeout=1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())
    assert len(scans) == 2
    assert [(count, payload["type"]) for count, payload in sends] == [(2, "ocr_text_invalidated")]


def test_presence_reference_discards_a_frame_captured_during_pause(monkeypatch):
    processor = _processor(monkeypatch, None)
    monkeypatch.setattr(get_overlay_coords, "LAST_SENT_PRESENCE_SCAN_INTERVAL_SECONDS", 0.005)
    state = {"paused": False, "generation": 0}
    monkeypatch.setattr(
        get_overlay_coords,
        "get_game_process_pause_state",
        lambda: (state["paused"], state["generation"]),
        raising=False,
    )
    interrupted = asyncio.Event()
    recovered = asyncio.Event()
    captures = []
    signatures = []
    prepare_candidate = get_overlay_coords.prepare_presence_candidate

    def capture(_data):
        captures.append(True)
        if len(captures) == 1:
            state.update(paused=True, generation=1)
            interrupted.set()
            frame = _frame()
        else:
            frame = _frame(left=50)
            recovered.set()
        return frame, ((240, 80), 0, 0, 240, 80, 240, 80, "test"), {"line_coords": [_line()]}

    def prepare(frame, *args, **kwargs):
        signatures.append(frame)
        return prepare_candidate(frame, *args, **kwargs)

    monkeypatch.setattr(processor, "_capture_last_sent_presence_frame", capture)
    monkeypatch.setattr(get_overlay_coords, "prepare_presence_candidate", prepare)

    async def run():
        task = asyncio.create_task(processor._monitor_last_sent_overlay_text("text", {"data": [_line()]}, 0))
        try:
            await asyncio.wait_for(interrupted.wait(), timeout=1)
            await asyncio.sleep(0.02)
            assert len(captures) == 1
            assert signatures == []
            state["paused"] = False
            await asyncio.wait_for(recovered.wait(), timeout=1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())
    assert len(signatures) == 1


@pytest.mark.parametrize("interrupted_capture", [1, 2])
def test_presence_monitor_retries_capture_failures_caused_by_pause(monkeypatch, interrupted_capture):
    processor = _processor(monkeypatch, None)
    monkeypatch.setattr(get_overlay_coords, "LAST_SENT_PRESENCE_SCAN_INTERVAL_SECONDS", 0.005)
    state = {"paused": False, "generation": 0}
    monkeypatch.setattr(
        get_overlay_coords,
        "get_game_process_pause_state",
        lambda: (state["paused"], state["generation"]),
        raising=False,
    )
    interrupted = asyncio.Event()
    recovered = asyncio.Event()
    captures = []

    def capture(_data):
        captures.append(True)
        if len(captures) == interrupted_capture:
            state.update(paused=True, generation=1)
            interrupted.set()
            raise RuntimeError("game paused during capture")
        if len(captures) > interrupted_capture:
            recovered.set()
        return _frame(left=50), ((240, 80), 0, 0, 240, 80, 240, 80, "test"), {"line_coords": [_line()]}

    monkeypatch.setattr(processor, "_capture_last_sent_presence_frame", capture)

    async def run():
        task = asyncio.create_task(processor._monitor_last_sent_overlay_text("text", {"data": [_line()]}, 0))
        try:
            await asyncio.wait_for(interrupted.wait(), timeout=1)
            await asyncio.sleep(0.02)
            assert len(captures) == interrupted_capture
            assert not task.done()
            state["paused"] = False
            await asyncio.wait_for(recovered.wait(), timeout=1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())


def test_presence_monitor_uses_tracked_game_pause_state(monkeypatch):
    from GameSentenceMiner.util.platform import base_window_monitor

    processor = _processor(monkeypatch, None)
    monkeypatch.setattr(get_overlay_coords, "LAST_SENT_PRESENCE_SCAN_INTERVAL_SECONDS", 0.005)
    monkeypatch.setattr(base_window_monitor, "_suspended_pids", {})
    monkeypatch.setattr(base_window_monitor, "_process_pause_generation", 0)
    monkeypatch.setattr(base_window_monitor, "_is_pid_allowed_to_suspend", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(base_window_monitor, "_get_process_creation_time", lambda _pid: 42)
    monkeypatch.setattr(base_window_monitor, "_get_process_exe_name", lambda _pid: "game.exe")
    monkeypatch.setattr(base_window_monitor, "_suspend_process", lambda _pid: True)
    monkeypatch.setattr(base_window_monitor, "_process_matches_record", lambda _pid, _record: True)
    monkeypatch.setattr(base_window_monitor, "_resume_and_record", lambda _pid, _record: True)
    monkeypatch.setattr(base_window_monitor, "_save_suspended_pids", lambda: None)
    monkeypatch.setattr(base_window_monitor, "_mark_process_pausing_activity", lambda: None)
    monkeypatch.setattr(base_window_monitor, "_ensure_auto_resume_task", lambda: None)
    reference_captured = asyncio.Event()
    resumed_capture = asyncio.Event()
    captures = []

    def capture(_data):
        captures.append(base_window_monitor.get_game_process_pause_state()[0])
        if len(captures) == 1:
            reference_captured.set()
        else:
            resumed_capture.set()
        return _frame(left=50), ((240, 80), 0, 0, 240, 80, 240, 80, "test"), {"line_coords": [_line()]}

    monkeypatch.setattr(processor, "_capture_last_sent_presence_frame", capture)

    async def run():
        task = asyncio.create_task(processor._monitor_last_sent_overlay_text("text", {"data": [_line()]}, 0))
        try:
            await asyncio.wait_for(reference_captured.wait(), timeout=1)
            assert base_window_monitor._suspend_process_with_tracking(4242, "test") is True
            await asyncio.sleep(0.03)
            assert captures == [False]
            assert base_window_monitor._resume_tracked_process(4242, "test") is True
            await asyncio.wait_for(resumed_capture.wait(), timeout=1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())
    assert captures == [False, False]
