import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import pytest
import soundfile as sf
from PyQt6.QtCore import QEvent, QPoint, Qt
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QTextEdit, QVBoxLayout, QWidget

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


def test_waveform_decodes_with_ffmpeg_when_soundfile_cannot_read_original(waveform, monkeypatch, tmp_path):
    from GameSentenceMiner.util.media import ffmpeg

    original = tmp_path / "audio.opus"
    original.write_bytes(b"not readable by soundfile")
    decoded = tmp_path / "decoded.wav"
    sf.write(decoded, np.ones(4800), 48000)
    monkeypatch.setattr(ffmpeg, "convert_audio_to_wav_lossless", lambda path: str(decoded))

    assert waveform.load_audio(str(original))
    assert waveform.duration == pytest.approx(0.1)
    assert waveform.audio_data is not None
    assert not decoded.exists()


def test_waveform_clears_old_data_when_new_audio_cannot_be_loaded(waveform, monkeypatch, tmp_path):
    from GameSentenceMiner.util.media import ffmpeg

    monkeypatch.setattr(ffmpeg, "convert_audio_to_wav_lossless", lambda path: str(tmp_path / "missing.wav"))

    assert not waveform.load_audio(str(tmp_path / "bad.opus"))
    assert waveform.audio_data is None
    assert waveform.duration == 0
    assert waveform.get_selection_range() == (0.0, 0.0)


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


def test_expansion_rail_does_not_seek_or_trim_audio(waveform):
    waveform.set_expand_controls(True, can_expand_start=True, can_expand_end=True)
    seeks = []
    waveform.seek_requested.connect(seeks.append)

    QTest.mouseClick(waveform, Qt.MouseButton.LeftButton, pos=QPoint(200, 12))

    assert seeks == []
    assert waveform.get_selection_range() == (1.0, 9.0)


def test_time_mapping_uses_the_visible_waveform_bounds(waveform):
    plot = waveform._content_rect()

    assert plot.left() >= waveform.handle_width // 2
    assert waveform._time_from_x(plot.left()) == 0.0
    assert waveform._time_from_x(plot.right()) == waveform.duration
    assert waveform._time_from_x(plot.left() + (plot.right() - plot.left()) * 0.25) == pytest.approx(2.5)


def test_dragging_handles_can_restore_the_full_clip(waveform):
    plot = waveform._content_rect()
    span = plot.right() - plot.left()
    start_x = round(plot.left() + span * 0.1)
    end_x = round(plot.left() + span * 0.9)
    y = plot.center().y()

    QTest.mousePress(waveform, Qt.MouseButton.LeftButton, pos=QPoint(start_x, y))
    QTest.mouseMove(waveform, QPoint(plot.left(), y))
    QTest.mouseRelease(waveform, Qt.MouseButton.LeftButton, pos=QPoint(plot.left(), y))
    QTest.mousePress(waveform, Qt.MouseButton.LeftButton, pos=QPoint(end_x, y))
    QTest.mouseMove(waveform, QPoint(plot.right(), y))
    QTest.mouseRelease(waveform, Qt.MouseButton.LeftButton, pos=QPoint(plot.right(), y))

    assert waveform.get_selection_range() == (0.0, 10.0)


@pytest.mark.parametrize("width", [240, 400, 780])
def test_expansion_rail_keeps_long_timestamps_between_buttons(waveform, app, width):
    waveform.resize(width, 110)
    waveform.set_expand_step(5)
    waveform.set_expand_controls(
        True,
        can_expand_start=True,
        can_expand_end=True,
        range_text="12345.67s → 12355.67s · 10.00s selected",
    )
    waveform._update_expand_step_labels(Qt.KeyboardModifier.ShiftModifier)
    app.processEvents()

    left = waveform.expand_start_button.geometry()
    right = waveform.expand_end_button.geometry()
    summary = waveform.range_chip.geometry()
    assert left.right() < summary.left()
    assert summary.right() < right.left()
    assert waveform.rect().contains(left)
    assert waveform.rect().contains(right)


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

    plot = waveform._content_rect()
    start = QPoint(round(plot.left() + (plot.right() - plot.left()) * 0.2), plot.center().y())
    end = QPoint(round(plot.left() + (plot.right() - plot.left()) * 0.4), plot.center().y())
    QTest.mousePress(waveform, Qt.MouseButton.LeftButton, pos=start)
    QTest.mouseMove(waveform, end)
    QTest.mouseRelease(waveform, Qt.MouseButton.LeftButton, pos=end)
    app.processEvents()

    assert waveform.get_cut_ranges() == [(2.0, 4.0)]
    assert seeks == []


def test_shift_drag_marks_one_cut_without_entering_cut_mode(waveform, app):
    seeks = []
    waveform.seek_requested.connect(seeks.append)
    plot = waveform._content_rect()
    start = QPoint(round(plot.left() + (plot.right() - plot.left()) * 0.3), plot.center().y())
    end = QPoint(round(plot.left() + (plot.right() - plot.left()) * 0.5), plot.center().y())

    QTest.mousePress(
        waveform,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.ShiftModifier,
        start,
    )
    QTest.mouseMove(waveform, end)
    QTest.mouseRelease(
        waveform,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.ShiftModifier,
        end,
    )
    app.processEvents()

    assert waveform.get_cut_ranges() == [(3.0, 5.0)]
    assert waveform._cut_mode is False
    assert seeks == []


def test_cut_ranges_stay_inside_outer_trim(waveform):
    waveform.add_cut_range(0.0, 4.0)
    waveform.add_cut_range(8.0, 10.0)

    assert waveform.get_cut_ranges() == [(1.0, 4.0), (8.0, 9.0)]


@pytest.mark.parametrize("step", [0.1, 0.25, 0.5, 1, 2, 3, 4, 5])
@pytest.mark.parametrize(
    ("modifier", "factor"),
    [
        (Qt.KeyboardModifier.NoModifier, 1),
        (Qt.KeyboardModifier.ShiftModifier, 5),
        (Qt.KeyboardModifier.ControlModifier, 0.2),
        (Qt.KeyboardModifier.ShiftModifier | Qt.KeyboardModifier.ControlModifier, 1),
    ],
)
def test_expand_click_uses_configured_step_and_mouse_modifiers(waveform, step, modifier, factor):
    waveform.set_expand_step(step)
    waveform.set_expand_controls(True, can_expand_start=True, can_expand_end=True)
    starts, ends = [], []
    waveform.expand_start_requested.connect(starts.append)
    waveform.expand_end_requested.connect(ends.append)

    QTest.mouseClick(waveform.expand_start_button, Qt.MouseButton.LeftButton, modifier)
    QTest.mouseClick(waveform.expand_end_button, Qt.MouseButton.LeftButton, modifier)

    expected = step * factor
    assert starts == [pytest.approx(expected)]
    assert ends == [pytest.approx(expected)]
    assert waveform.expand_start_button.text() == f"◀ +{expected:g}s"
    assert waveform.expand_end_button.text() == f"+{expected:g}s ▶"


def test_expand_labels_follow_modifier_keys_with_focus_in_another_field(app):
    window = QWidget()
    layout = QVBoxLayout(window)
    editor = QTextEdit()
    waveform = AudioWaveformWidget()
    layout.addWidget(editor)
    layout.addWidget(waveform)
    waveform.set_expand_step(0.25)
    waveform.set_expand_controls(True, can_expand_start=True, can_expand_end=True)
    window.show()
    editor.setFocus()
    app.processEvents()
    try:
        for key, expected in [(Qt.Key.Key_Shift, "1.25"), (Qt.Key.Key_Control, "0.05")]:
            QTest.keyPress(editor, key)
            assert waveform.expand_start_button.text() == f"◀ +{expected}s"
            assert waveform.expand_end_button.text() == f"+{expected}s ▶"
            QTest.keyRelease(editor, key)
            assert waveform.expand_start_button.text() == "◀ +0.25s"
        QTest.keyPress(editor, Qt.Key.Key_Shift)
        QApplication.sendEvent(window, QEvent(QEvent.Type.WindowDeactivate))
        assert waveform.expand_start_button.text() == "◀ +0.25s"
        QTest.keyRelease(editor, Qt.Key.Key_Shift)
        window.hide()
        waveform.set_expand_step(2)
        window.show()
        assert waveform.expand_end_button.text() == "+2s ▶"
    finally:
        window.close()
        window.deleteLater()
        app.processEvents()
