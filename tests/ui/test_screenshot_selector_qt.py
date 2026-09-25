import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QPixmap
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QDialog

from GameSentenceMiner.ui import screenshot_selector_qt as selector
from GameSentenceMiner.util.media.screenshot_selection import ScreenshotChoice


class DummyWorker:
    def __init__(self, directory):
        self.directory = str(directory)
        self.requests = []
        self.pages = []
        self.exports = []
        self.pinned = set()

    def request_page(self, generation, positions):
        self.pages.append((generation, tuple(positions)))
        self.requests.extend((generation * 25 + index, position) for index, position in enumerate(positions))

    def request_export(self, choices):
        self.exports.append(choices)

    def pin(self, path):
        self.pinned.add(path)

    def unpin(self, path):
        self.pinned.discard(path)

    def stop(self):
        pass

    def isFinished(self):
        return True


@pytest.fixture
def dialog(tmp_path, monkeypatch):
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr(selector.window_state_manager, "restore_geometry", lambda *args: True)
    monkeypatch.setattr(selector.window_state_manager, "save_geometry", lambda *args: None)
    widget = selector.ScreenshotSelectorDialog()
    widget._worker = DummyWorker(tmp_path / "worker")
    widget._session = 1
    widget._active = True
    widget._reference = 20
    widget._mode = "middle"
    widget._on_probed(1, 80, 30, "")
    widget.show()
    widget.activateWindow()
    app.processEvents()
    yield widget
    widget.done(QDialog.DialogCode.Rejected)
    app.processEvents()


def _load_frame(dialog, tmp_path, index):
    serial, position = dialog._worker.requests[-25:][index]
    image = tmp_path / f"frame-{serial}.png"
    pixmap = QPixmap(20, 10)
    pixmap.fill(Qt.GlobalColor.blue)
    assert pixmap.save(str(image))
    dialog._on_frame(dialog._session, serial, position, str(image), "")
    return str(image)


def _click(dialog, index, modifier=Qt.KeyboardModifier.NoModifier):
    QTest.mouseClick(dialog.thumbnails[index], Qt.MouseButton.LeftButton, modifier)


def test_grid_loads_25_half_second_frames_including_default(dialog):
    assert len(dialog.thumbnails) == 25
    assert len(dialog._worker.pages) == 1
    assert [position for _, position in dialog._worker.requests] == [14 + index * 0.5 for index in range(25)]
    assert not dialog.finish.isEnabled()
    assert dialog.tray_area.isHidden()


def test_thumbnails_stay_large_and_reflow_instead_of_shrinking(dialog, tmp_path):
    dialog.resize(980, 780)
    QApplication.processEvents()
    first = dialog.thumbnails[0]
    assert first.iconSize().width() >= 280
    assert first.iconSize().height() >= 157
    assert dialog.thumbnails[3].y() > first.y()
    assert dialog.grid_area.verticalScrollBar().maximum() > 0
    assert dialog.grid_area.horizontalScrollBar().maximum() == 0
    _load_frame(dialog, tmp_path, 0)
    before = first.iconSize()
    _click(dialog, 0, Qt.KeyboardModifier.ControlModifier)
    QApplication.processEvents()
    assert first.iconSize() == before
    dialog.resize(720, 520)
    QApplication.processEvents()
    assert first.iconSize().width() >= 280
    assert dialog.grid_area.horizontalScrollBar().maximum() == 0


def test_one_click_exports_the_displayed_still(dialog, tmp_path):
    image = _load_frame(dialog, tmp_path, 3)
    _click(dialog, 3)
    assert dialog._worker.exports == [(ScreenshotChoice(15.5, image),)]
    assert dialog._exporting
    assert not dialog.earlier.isEnabled()
    assert not dialog.later.isEnabled()


@pytest.mark.parametrize("modifier", [Qt.KeyboardModifier.ControlModifier, Qt.KeyboardModifier.ShiftModifier])
def test_modifier_click_collects_toggles_and_finishes_in_selection_order(dialog, tmp_path, modifier):
    images = [_load_frame(dialog, tmp_path, index) for index in (2, 0, 4)]
    for index in (2, 0, 4):
        _click(dialog, index, modifier)
    assert dialog._worker.exports == []
    assert all(dialog.thumbnails[index].isChecked() for index in (2, 0, 4))
    _click(dialog, 0, modifier)
    assert not dialog.thumbnails[0].isChecked()
    assert images[1] not in dialog._worker.pinned
    assert dialog.finish.text() == "Use 2 screenshots"
    dialog.finish.click()
    assert [choice.start for choice in dialog._worker.exports[0]] == [15, 16]


def test_plain_click_keeps_collecting_until_selection_is_cleared(dialog, tmp_path):
    for index in (0, 1):
        _load_frame(dialog, tmp_path, index)
    _click(dialog, 0, Qt.KeyboardModifier.ControlModifier)
    _click(dialog, 1)
    assert len(dialog._choices) == 2
    assert dialog._worker.exports == []
    dialog.clear_selection.click()
    assert dialog._choices == ()
    assert dialog._worker.pinned == set()
    assert not dialog.thumbnails[0].isChecked()
    assert dialog.tray_area.isHidden()
    _click(dialog, 1)
    assert len(dialog._worker.exports[0]) == 1


def test_arrow_keys_page_25_frames_with_focused_thumbnail_and_keep_selection(dialog, tmp_path):
    image = _load_frame(dialog, tmp_path, 2)
    _click(dialog, 2, Qt.KeyboardModifier.ControlModifier)
    first_page = [position for _, position in dialog._worker.requests]
    dialog.thumbnails[2].setFocus()
    QTest.keyClick(dialog.thumbnails[2], Qt.Key.Key_Right)
    next_page = [position for _, position in dialog._worker.requests[-25:]]
    assert next_page == [position + 12.5 for position in first_page]
    assert not set(first_page) & set(next_page)
    assert dialog._choices == (ScreenshotChoice(15, image),)
    assert image in dialog._worker.pinned
    QTest.keyClick(dialog, Qt.Key.Key_Left)
    assert [position for _, position in dialog._worker.requests[-25:]] == first_page
    _load_frame(dialog, tmp_path, 2)
    assert dialog.thumbnails[2].isChecked()


def test_partial_boundary_pages_do_not_repeat_frames_and_navigation_is_reversible(dialog):
    initial = [position for _, position in dialog._worker.requests]
    dialog.earlier.click()
    earlier = [position for _, position in dialog._worker.requests[-25:]]
    assert earlier == [1.5 + index * 0.5 for index in range(25)]
    request_count = len(dialog._worker.requests)
    dialog.earlier.click()
    assert [position for _, position in dialog._worker.requests[request_count:]] == [0, 0.5, 1]
    assert not dialog.earlier.isEnabled()
    assert sum(not button.isHidden() for button in dialog.thumbnails) == 3
    dialog._move_page(-1)
    assert len(dialog._worker.requests) == request_count + 3
    dialog.later.click()
    assert [position for _, position in dialog._worker.requests[-25:]] == earlier
    dialog.reference_button.click()
    assert [position for _, position in dialog._worker.requests[-25:]] == initial
    assert "Beginning" not in dialog.boundary.text()


@pytest.mark.parametrize("duration,reference,expected", [(0.8, 0, [0, 0.5]), (0.02, 0, [0])])
def test_short_recordings_have_no_duplicate_or_out_of_bounds_frames(dialog, duration, reference, expected):
    dialog._worker.requests.clear()
    dialog._reference = reference
    dialog._on_probed(1, duration, 30, "")
    assert [position for _, position in dialog._worker.requests] == expected
    assert not dialog.earlier.isEnabled()
    assert not dialog.later.isEnabled()


@pytest.mark.parametrize("mode,first", [("beginning", 20), ("middle", 14), ("end", 8)])
def test_initial_page_respects_screenshot_timing_mode(dialog, mode, first):
    dialog._worker.requests.clear()
    dialog._mode = mode
    dialog._on_probed(1, 80, 30, "")
    assert [position for _, position in dialog._worker.requests] == [first + index * 0.5 for index in range(25)]


def test_recording_end_is_reachable_and_stops_navigation(dialog):
    seen = set()
    while dialog.later.isEnabled():
        start = len(dialog._worker.requests)
        dialog.later.click()
        positions = [position for _, position in dialog._worker.requests[start:]]
        assert not seen.intersection(positions)
        assert all(0 <= position < 80 for position in positions)
        seen.update(positions)
    assert max(seen) == 79.5
    count = len(dialog._worker.requests)
    dialog._move_page(1)
    assert len(dialog._worker.requests) == count
    assert "End" in dialog.boundary.text()


def test_pending_page_ignores_old_frames_and_cannot_select_them(dialog, tmp_path):
    image = _load_frame(dialog, tmp_path, 0)
    old_serial, position = dialog._worker.requests[0]
    dialog.later.click()
    dialog._on_frame(1, old_serial, position, image, "")
    dialog._on_frame(0, dialog._worker.requests[-25][0], position, image, "")
    assert dialog._thumb_data == {}
    _click(dialog, 0)
    assert dialog._worker.exports == []


def test_export_failure_keeps_selection_for_retry_and_blocks_edits_during_export(dialog, tmp_path, monkeypatch):
    image = _load_frame(dialog, tmp_path, 0)
    _click(dialog, 0, Qt.KeyboardModifier.ControlModifier)
    dialog.finish.click()
    count = len(dialog._worker.requests)
    dialog._move_page(1)
    dialog._remove_choice(0)
    dialog._clear_selection()
    assert len(dialog._worker.requests) == count
    assert dialog._choices == (ScreenshotChoice(14, image),)
    monkeypatch.setattr(selector.QMessageBox, "critical", lambda *args: None)
    dialog._on_exported(1, None, "encoder unavailable")
    assert dialog.finish.isEnabled()
    assert dialog.later.isEnabled()
    assert "failed" in dialog.status.text().lower()
    dialog.finish.click()
    assert len(dialog._worker.exports) == 2


def test_new_invocation_resets_selection_and_ignores_previous_recording(dialog, tmp_path, monkeypatch):
    image = _load_frame(dialog, tmp_path, 0)
    _click(dialog, 0, Qt.KeyboardModifier.ControlModifier)
    old_session = dialog._session
    dialog.selected_result = object()

    class Signal:
        def connect(self, callback):
            pass

    class FakeWorker(DummyWorker):
        def __init__(self, session, source):
            super().__init__(tmp_path / f"worker-{session}")
            self.probed = Signal()
            self.frame_ready = Signal()
            self.exported = Signal()
            self.finished = Signal()

        def start(self):
            pass

    monkeypatch.setattr(selector, "FrameWorker", FakeWorker)
    video = tmp_path / "second.mp4"
    video.write_bytes(b"video")
    assert dialog.prepare_selection(str(video), 4)
    assert dialog._choices == ()
    assert dialog.selected_result is None
    assert dialog._source_path == str(video)
    assert dialog._reference == 4
    assert dialog._page == 0
    assert not dialog.finish.isEnabled()
    dialog._on_frame(old_session, 0, 14, image, "")
    assert dialog._thumb_data == {}


def test_cancel_discards_collection_without_export(dialog, tmp_path):
    _load_frame(dialog, tmp_path, 0)
    _click(dialog, 0, Qt.KeyboardModifier.ControlModifier)
    worker = dialog._worker
    QTest.keyClick(dialog, Qt.Key.Key_Escape)
    assert dialog.result() == QDialog.DialogCode.Rejected
    assert dialog._choices == ()
    assert dialog.selected_result is None
    assert worker.exports == []


def test_cancel_callback_completes_once(monkeypatch):
    app = QApplication.instance() or QApplication([])

    class CancelledDialog:
        _active = False
        selected_result = None

        def __init__(self):
            self._retired = []

        def prepare_selection(self, *args):
            return True

        def exec(self):
            return QDialog.DialogCode.Rejected

    monkeypatch.setattr(selector, "_screenshot_selector_instance", CancelledDialog())
    completions = []
    assert selector.show_screenshot_selector(None, "recording.mp4", 2, on_complete=completions.append) is None
    assert completions == [None]
    assert app is not None
