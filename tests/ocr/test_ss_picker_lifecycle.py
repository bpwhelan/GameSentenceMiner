import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PIL import Image
from PyQt6.QtCore import QElapsedTimer, QEvent, QPoint, Qt, QTimer
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QWidget

from GameSentenceMiner.ocr import ss_picker_qt as picker


@pytest.fixture
def cropper(monkeypatch):
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr(picker.window_state_manager, "save_geometry", lambda *args: None)
    widget = picker.ScreenCropperWidget()
    yield widget
    widget.on_complete = None
    monkeypatch.setattr(picker.window_state_manager, "save_geometry", lambda *args: None)
    widget.close()
    widget.deleteLater()
    app.processEvents()


def prepare(widget, callback, *, transparent=False):
    geometry = {"left": -20, "top": 10, "width": 100, "height": 80}
    widget.prepare_capture(Image.new("RGB", (100, 80), "white"), geometry, geometry, callback, transparent)


def wait_until(predicate):
    # Native focus events and Qt timers can arrive late on busy CI runners.
    timer = QElapsedTimer()
    timer.start()
    while not predicate() and timer.elapsed() < 2000:
        QTest.qWait(10)
    assert predicate(), "Qt condition did not settle within two seconds"


@pytest.fixture
def fake_capture(cropper, monkeypatch):
    geometry = {"left": 0, "top": 0, "width": 100, "height": 80}

    class Capture:
        def __init__(self):
            self.monitors = [geometry, geometry]

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def grab(self, region):
            size = (region["width"], region["height"])
            return SimpleNamespace(size=size, bgra=Image.new("RGB", size, "white").tobytes("raw", "BGRX"))

    monkeypatch.setattr(picker, "_screen_cropper_instance", cropper)
    monkeypatch.setattr(picker, "get_monitor_dpi_scale", dict)
    monkeypatch.setattr(picker.mss, "mss", Capture)
    return Capture


@pytest.mark.parametrize("event_type", [QEvent.Type.WindowDeactivate, QEvent.Type.Hide])
def test_interrupted_picker_cancels_once_and_can_be_reopened(cropper, monkeypatch, event_type):
    results = []
    prepare(cropper, results.append)
    QApplication.processEvents()
    monkeypatch.setattr(cropper, "isActiveWindow", lambda: False)
    QApplication.sendEvent(cropper, QEvent(event_type))
    wait_until(lambda: bool(results))
    assert results == [None]
    assert not cropper.isVisible()
    cropper.close()
    prepare(cropper, results.append)
    QTest.keyClick(cropper, Qt.Key.Key_Escape)
    assert results == [None, None]


def test_callback_runs_after_input_and_window_cleanup_and_only_once(cropper, monkeypatch):
    observations = []
    monkeypatch.setattr(cropper, "_release_input", lambda: observations.append("released"))

    def callback(result):
        observations.append((result, cropper.isVisible(), cropper.on_complete))

    prepare(cropper, callback)
    QTest.keyClick(cropper, Qt.Key.Key_Escape)
    cropper._finish()
    assert observations == ["released", (None, False, None)]


def test_failed_callback_or_geometry_save_cannot_strand_picker(cropper, monkeypatch):
    calls = []

    def fail(*args):
        calls.append(args)
        raise RuntimeError("simulated failure")

    prepare(cropper, fail)
    monkeypatch.setattr(picker.window_state_manager, "save_geometry", fail)
    # Call directly so failures are reported by pytest instead of PyQt's exception hook.
    cropper._finish()
    cropper._finish()
    assert not cropper.isVisible()
    assert cropper.on_complete is None
    assert len(calls) == 2


def test_callback_can_start_next_capture_without_old_cleanup_hiding_it(cropper):
    results = []
    prepare(cropper, lambda result: prepare(cropper, results.append))
    cropper._finish()
    assert cropper.isVisible()
    QTest.keyClick(cropper, Qt.Key.Key_Escape)
    assert results == [None]


def test_second_request_does_not_overwrite_first_callback_or_capture_overlay(cropper, monkeypatch):
    first, second = [], []
    prepare(cropper, first.append)
    monkeypatch.setattr(picker, "_screen_cropper_instance", cropper)
    monkeypatch.setattr(picker, "get_monitor_dpi_scale", lambda: pytest.fail("duplicate request captured screen"))

    assert picker.show_screen_cropper(second.append) is cropper
    assert second == [None]
    assert first == []
    QTest.keyClick(cropper, Qt.Key.Key_Escape)
    assert first == [None]


def test_delayed_focus_attempt_cannot_resurrect_finished_picker(cropper, monkeypatch):
    focus_attempts = []
    monkeypatch.setattr(cropper, "_force_windows_focus", lambda: focus_attempts.append(True), raising=False)
    prepare(cropper, lambda result: None)
    QTest.keyClick(cropper, Qt.Key.Key_Escape)
    focus_attempts.clear()
    QTest.qWait(350)
    assert focus_attempts == []
    assert not cropper.isVisible()


def test_valid_selection_preserves_physical_coordinates_and_metadata(cropper):
    results = []
    geometry = {"left": -200, "top": 40, "width": 200, "height": 160}
    cropper.prepare_capture(Image.new("RGB", (200, 160), "white"), geometry, geometry, results.append, False, 2)
    QTest.mousePress(cropper, Qt.MouseButton.LeftButton, pos=QPoint(10, 12))
    QTest.mouseRelease(cropper, Qt.MouseButton.LeftButton, pos=QPoint(30, 32))

    assert len(results) == 1
    assert results[0].size == (40, 40)
    assert results[0]._gsm_screen_crop_metadata == {
        "virtual_left": -200,
        "virtual_top": 40,
        "virtual_width": 200,
        "virtual_height": 160,
        "selection_left": -180,
        "selection_top": 64,
        "selection_width": 40,
        "selection_height": 40,
        "transparent_mode": False,
    }


def test_selection_failure_cancels_instead_of_leaving_overlay_open(cropper, monkeypatch):
    results = []
    prepare(cropper, results.append)

    def fail(*args, **kwargs):
        raise ValueError("simulated crop failure")

    monkeypatch.setattr(picker, "logical_box_to_even_physical_box", fail)
    cropper.mousePressEvent(SimpleNamespace(button=lambda: Qt.MouseButton.LeftButton, pos=lambda: QPoint(10, 10)))
    cropper.mouseReleaseEvent(SimpleNamespace(button=lambda: Qt.MouseButton.LeftButton, pos=lambda: QPoint(30, 30)))
    assert results == [None]
    assert not cropper.isVisible()


def test_sync_entry_point_completes_when_cancelled_during_startup(cropper, fake_capture, monkeypatch):
    results = []
    # Avoid screen access; exercise cancellation before the local event loop starts.
    original_prepare = cropper.prepare_capture

    def cancel_on_prepare(*args):
        original_prepare(*args)
        cropper.close()

    monkeypatch.setattr(cropper, "prepare_capture", cancel_on_prepare)
    assert picker.show_screen_cropper(results.append, transparent_mode=True) is cropper
    assert results == [None]


def test_application_deactivation_cancels_picker(cropper, monkeypatch):
    results = []
    prepare(cropper, results.append)
    QApplication.processEvents()
    monkeypatch.setattr(QApplication, "applicationState", lambda: Qt.ApplicationState.ApplicationInactive)
    QApplication.instance().applicationStateChanged.emit(Qt.ApplicationState.ApplicationInactive)
    wait_until(lambda: bool(results))
    assert results == [None]
    assert not cropper.isVisible()


@pytest.mark.parametrize("timeout_ms", [1, 150])
def test_session_timeout_releases_waiting_caller(cropper, timeout_ms):
    results = []
    prepare(cropper, results.append)
    cropper._session_timeout.setInterval(timeout_ms)
    wait_until(lambda: bool(results))
    assert results == [None]
    assert not cropper.isVisible()


@pytest.mark.parametrize("transparent", [False, True])
def test_sync_wait_is_session_scoped_when_callback_reopens_picker(cropper, fake_capture, transparent):
    second = []
    QTimer.singleShot(0, cropper._finish)
    # A failsafe prevents a regression from hanging pytest.
    timer = QTimer()
    timer.setSingleShot(True)
    timer.timeout.connect(cropper.close)
    timer.start(1000)
    picker.show_screen_cropper(
        lambda result: prepare(cropper, second.append, transparent=transparent), transparent_mode=True
    )
    timer.stop()
    QTest.qWait(100)
    assert cropper.isVisible()
    assert second == []


def test_focus_watchdog_cancels_when_activation_fails(cropper, monkeypatch):
    results = []
    prepare(cropper, results.append)
    monkeypatch.setattr(cropper, "isActiveWindow", lambda: False)
    monkeypatch.setattr(picker.time, "monotonic", lambda: cropper._activation_deadline + 1)
    cropper._check_session()
    assert results == [None]
    assert not cropper.isVisible()


def test_missing_mouse_release_allows_fresh_selection(cropper, monkeypatch):
    results = []
    prepare(cropper, results.append)
    monkeypatch.setattr(cropper, "isActiveWindow", lambda: True)
    QTest.mousePress(cropper, Qt.MouseButton.LeftButton, pos=QPoint(10, 10))
    monkeypatch.setattr(QApplication, "mouseButtons", lambda: Qt.MouseButton.NoButton)
    cropper._check_session()
    assert not cropper.is_drawing
    assert cropper.start_pos is None
    assert cropper.isVisible()
    QTest.mousePress(cropper, Qt.MouseButton.LeftButton, pos=QPoint(10, 10))
    QTest.mouseRelease(cropper, Qt.MouseButton.LeftButton, pos=QPoint(30, 30))
    assert len(results) == 1
    assert results[0].size == (20, 20)


@pytest.mark.parametrize("transparent", [False, True])
def test_sync_selection_works_for_both_capture_modes(cropper, fake_capture, transparent):
    results = []

    def select():
        QTest.mousePress(cropper, Qt.MouseButton.LeftButton, pos=QPoint(10, 10))
        QTest.mouseRelease(cropper, Qt.MouseButton.LeftButton, pos=QPoint(30, 30))

    QTimer.singleShot(0, select)
    picker.show_screen_cropper(results.append, transparent_mode=transparent)
    assert len(results) == 1
    assert results[0].size == (20, 20)
    assert results[0]._gsm_screen_crop_metadata["transparent_mode"] is transparent


def test_enter_still_selects_main_monitor(cropper):
    results = []
    prepare(cropper, results.append)
    QTest.keyClick(cropper, Qt.Key.Key_Return)
    assert len(results) == 1
    assert results[0].size == (100, 80)
    assert not cropper.isVisible()


@pytest.mark.parametrize("failure", ["capture", "prepare"])
def test_setup_failure_completes_waiting_caller_once(cropper, fake_capture, monkeypatch, failure):
    results = []

    def fail(*args):
        raise RuntimeError("simulated setup failure")

    if failure == "capture":
        monkeypatch.setattr(fake_capture, "grab", fail)
    else:
        monkeypatch.setattr(cropper, "resize", fail)
    picker.show_screen_cropper(results.append)
    assert results == [None]
    assert not cropper.isVisible()


def test_rapid_window_switches_cancel_drag_and_leave_picker_reusable(cropper):
    results = []
    other = QWidget()
    other.setGeometry(150, 50, 200, 100)
    try:
        other.show()
        for index in range(10):
            prepare(cropper, results.append)
            wait_until(cropper.isActiveWindow)
            assert cropper.isActiveWindow()
            # There must be no session-long grabs before a drag starts.
            assert QWidget.mouseGrabber() is not cropper
            assert QWidget.keyboardGrabber() is not cropper
            QTest.mousePress(cropper, Qt.MouseButton.LeftButton, pos=QPoint(10, 10))
            other.activateWindow()
            wait_until(lambda: len(results) >= index + 1)
            assert results == [None] * (index + 1)
            assert not cropper.isVisible()
            assert QWidget.mouseGrabber() is not cropper
            assert QWidget.keyboardGrabber() is not cropper
            QTest.mouseRelease(other, Qt.MouseButton.LeftButton)
    finally:
        other.close()


def test_focus_returning_before_deactivation_settles_keeps_selection(cropper, monkeypatch):
    results = []
    prepare(cropper, results.append)
    QApplication.processEvents()
    monkeypatch.setattr(cropper, "isActiveWindow", lambda: True)
    monkeypatch.setattr(QApplication, "applicationState", lambda: Qt.ApplicationState.ApplicationActive)
    QApplication.sendEvent(cropper, QEvent(QEvent.Type.WindowDeactivate))
    QTest.qWait(80)
    assert results == []
    assert cropper.isVisible()


def test_failed_mouse_release_still_releases_keyboard(cropper, monkeypatch):
    released = []
    monkeypatch.setattr(QWidget, "mouseGrabber", lambda: cropper)
    monkeypatch.setattr(QWidget, "keyboardGrabber", lambda: cropper)

    def fail():
        raise RuntimeError("simulated mouse release failure")

    monkeypatch.setattr(cropper, "releaseMouse", fail)
    monkeypatch.setattr(cropper, "releaseKeyboard", lambda: released.append("keyboard"))
    cropper._release_input()
    assert released == ["keyboard"]
