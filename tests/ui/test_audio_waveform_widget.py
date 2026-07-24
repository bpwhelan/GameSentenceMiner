import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import pytest
from PyQt6.QtCore import QPoint, Qt
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ui.audio_waveform_widget import AudioWaveformWidget


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


@pytest.fixture
def waveform(app):
    widget = AudioWaveformWidget()
    widget.resize(400, 100)
    widget.audio_data = np.zeros(1000)
    widget.samplerate = 100
    widget.duration = 10.0
    widget.start_time = 1.0
    widget.end_time = 9.0
    widget.show()
    app.processEvents()
    yield widget
    widget.close()


def test_clicking_waveform_requests_seek_without_changing_trim(waveform, app):
    seeks = []
    waveform.seek_requested.connect(seeks.append)

    QTest.mouseClick(
        waveform,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
        QPoint(200, 60),
    )
    app.processEvents()

    assert seeks == [pytest.approx(5.0)]
    assert waveform.playback_position == pytest.approx(5.0)
    assert waveform.get_selection_range() == (1.0, 9.0)


def test_cut_ranges_are_clamped_merged_and_undoable(waveform):
    waveform.add_cut_range(4.0, 6.0)
    waveform.add_cut_range(2.0, 3.0)
    waveform.add_cut_range(2.5, 5.0)

    assert waveform.get_cut_ranges() == [(2.0, 6.0)]

    waveform.undo_last_cut()

    assert waveform.get_cut_ranges() == [(2.0, 3.0), (4.0, 6.0)]


def test_cut_mode_drag_marks_audio_without_seeking(waveform, app):
    seeks = []
    waveform.seek_requested.connect(seeks.append)
    waveform.set_cut_mode(True)

    QTest.mousePress(waveform, Qt.MouseButton.LeftButton, pos=QPoint(80, 60))
    QTest.mouseMove(waveform, QPoint(160, 60))
    QTest.mouseRelease(waveform, Qt.MouseButton.LeftButton, pos=QPoint(160, 60))
    app.processEvents()

    assert waveform.get_cut_ranges() == [(2.0, 4.0)]
    assert seeks == []


def test_shift_drag_marks_one_cut_without_entering_cut_mode(waveform, app):
    seeks = []
    waveform.seek_requested.connect(seeks.append)

    QTest.mousePress(
        waveform,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.ShiftModifier,
        QPoint(120, 60),
    )
    QTest.mouseMove(waveform, QPoint(200, 60))
    QTest.mouseRelease(
        waveform,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.ShiftModifier,
        QPoint(200, 60),
    )
    app.processEvents()

    assert waveform.get_cut_ranges() == [(3.0, 5.0)]
    assert waveform._cut_mode is False
    assert seeks == []


def test_cut_ranges_stay_inside_outer_trim(waveform):
    waveform.add_cut_range(0.0, 4.0)
    waveform.add_cut_range(8.0, 10.0)

    assert waveform.get_cut_ranges() == [(1.0, 4.0), (8.0, 9.0)]
