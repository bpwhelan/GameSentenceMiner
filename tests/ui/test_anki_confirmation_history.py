import io
from concurrent.futures import Future
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf
from PyQt6.QtCore import QPoint, Qt
from PyQt6.QtGui import QPixmap, QTextCursor
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QComboBox

from GameSentenceMiner.ui import anki_confirmation_qt as confirmation
from GameSentenceMiner.util.media.screenshot_selection import ScreenshotMedia, ScreenshotSelectionResult
from tests.ui.test_anki_confirmation_qt import focus_confirmation_dialog as _base_confirmation_dialog

focus_confirmation_dialog = _base_confirmation_dialog


@pytest.fixture
def review(focus_confirmation_dialog, monkeypatch):
    dialog, config = focus_confirmation_dialog
    config.anki.confirmation_focus_on_show = False
    config.anki.previous_image_field = "Previous Picture"
    config.screenshot.animated_settings.extension = "avif"
    monkeypatch.setattr(confirmation.gsm_state, "current_replay_context", None)
    monkeypatch.setattr(confirmation.gsm_state, "audio_edit_context", None)
    monkeypatch.setattr(confirmation.gsm_state, "vad_result", None)
    monkeypatch.setattr(confirmation.gsm_state, "disable_anki_confirmation_session", False)
    monkeypatch.setattr(confirmation.window_state_manager, "restore_geometry", lambda *args: True)
    monkeypatch.setattr(confirmation, "save_current_config", lambda *args: None)
    dialog.populate_ui("word", "sentence", None, None, None, "translation", 0, 0)
    dialog.show()
    QApplication.instance().processEvents()
    return dialog, config


def shortcut(widget, key):
    QTest.keyClick(widget, key, Qt.KeyboardModifier.ControlModifier)
    QApplication.instance().processEvents()


def append(editor, text):
    editor.setFocus()
    editor.moveCursor(QTextCursor.MoveOperation.End)
    QTest.keyClicks(editor, text)


def test_selector_is_removed_and_history_spans_all_focused_controls(review):
    dialog, _config = review
    assert not dialog.findChildren(QComboBox)
    append(dialog.sentence_text, " edited")
    dialog.nsfw_tag_checkbox.click()
    append(dialog.translation_text, " edited")
    shortcut(dialog.translation_text, Qt.Key.Key_Z)
    assert dialog.translation_text.toPlainText() == "translation"
    shortcut(dialog.translation_text, Qt.Key.Key_Z)
    assert not dialog.nsfw_tag_checkbox.isChecked()
    shortcut(dialog.translation_text, Qt.Key.Key_Z)
    assert dialog.sentence_text.toPlainText() == "sentence"
    for _ in range(3):
        shortcut(dialog.nsfw_tag_checkbox, Qt.Key.Key_Y)
    assert dialog.sentence_text.toPlainText() == "sentence edited"
    assert dialog.translation_text.toPlainText() == "translation edited"
    assert dialog.nsfw_tag_checkbox.isChecked()


def test_new_edit_drops_redo_and_each_card_starts_with_empty_history(review):
    dialog, _config = review
    dialog.sentence_text.setPlainText("first")
    dialog.sentence_text.setPlainText("second")
    shortcut(dialog.sentence_text, Qt.Key.Key_Z)
    assert dialog.sentence_text.toPlainText() == "first"
    dialog.sentence_text.setPlainText("replacement")
    shortcut(dialog.sentence_text, Qt.Key.Key_Y)
    assert dialog.sentence_text.toPlainText() == "replacement"
    dialog.populate_ui("next", "new card", None, None, None, "new translation", 0, 0)
    shortcut(dialog.sentence_text, Qt.Key.Key_Z)
    assert dialog.sentence_text.toPlainText() == "new card"
    assert not dialog._review_history.stack.canUndo()


def test_options_undo_restores_saved_and_session_preferences(review):
    dialog, config = review
    dialog.autoplay_checkbox.click()
    dialog.disable_session_checkbox.click()
    dialog.regen_translation_checkbox.click()
    assert config.anki.autoplay_audio
    assert confirmation.gsm_state.disable_anki_confirmation_session
    for _ in range(3):
        shortcut(dialog.regen_translation_checkbox, Qt.Key.Key_Z)
    assert not config.anki.autoplay_audio
    assert not confirmation.gsm_state.disable_anki_confirmation_session
    assert dialog.regen_translation_checkbox.isChecked()
    for _ in range(3):
        shortcut(dialog.regen_translation_checkbox, Qt.Key.Key_Y)
    assert config.anki.autoplay_audio
    assert confirmation.gsm_state.disable_anki_confirmation_session
    assert not dialog.regen_translation_checkbox.isChecked()


def test_audio_trim_cut_and_reset_are_reversible_as_complete_actions(review):
    dialog, _config = review
    dialog.audio_player = SimpleNamespace(is_playing=False, stop_audio=lambda: None)
    waveform = dialog.waveform_widget
    data = np.ones(48000)
    waveform.audio_data = data
    waveform.samplerate = 48000
    waveform.duration = 1.0
    waveform.start_time, waveform.end_time = 0.0, 1.0
    dialog._audio_edit_source_window = (2.0, 3.0)
    dialog._audio_edit_range = (2.0, 3.0)
    dialog._review_history.reset()
    waveform.start_time, waveform.end_time = 0.1, 0.9
    waveform.handle_moved.emit("start", 0.1, 0.9)
    dialog._trim_autoplay_timer.stop()
    waveform.add_cut_range(0.3, 0.4)
    dialog._reset_audio_trim()
    assert waveform.get_selection_range() == (0.0, 1.0)
    assert waveform.get_cut_ranges() == []
    shortcut(dialog, Qt.Key.Key_Z)
    assert waveform.get_selection_range() == (0.1, 0.9)
    assert waveform.get_cut_ranges() == [(0.3, 0.4)]
    shortcut(dialog, Qt.Key.Key_Z)
    assert waveform.get_cut_ranges() == []
    shortcut(dialog, Qt.Key.Key_Z)
    assert waveform.get_selection_range() == (0.0, 1.0)
    assert dialog._audio_edit_range == (2.0, 3.0)
    for _ in range(3):
        shortcut(dialog, Qt.Key.Key_Y)
    assert waveform.get_selection_range() == (0.0, 1.0)
    assert waveform.get_cut_ranges() == []
    assert waveform.audio_data is data


@pytest.mark.parametrize("edit", ["option", "trim"])
def test_undo_redo_keeps_waveform_drawn_without_resizing(review, tmp_path, edit):
    dialog, _config = review
    dialog.audio_player = SimpleNamespace(audio_available=True, is_playing=False, stop_audio=lambda: None)
    audio = tmp_path / "waveform.wav"
    times = np.arange(48000) / 48000
    sf.write(audio, 0.7 * np.sin(2 * np.pi * 12 * times), 48000)
    dialog.populate_ui("word", "sentence", None, None, str(audio), "translation", 0, 0)
    dialog.show()
    QApplication.instance().processEvents()
    waveform = dialog.waveform_widget
    original_size = waveform.size()
    original_image = waveform.grab().toImage()
    if edit == "option":
        dialog.nsfw_tag_checkbox.click()
    else:
        waveform.start_time, waveform.end_time = 0.1, 0.9
        waveform.handle_moved.emit("start", 0.1, 0.9)
        dialog._trim_autoplay_timer.stop()
        waveform.set_playback_position(-1)
    edited_image = waveform.grab().toImage()

    shortcut(dialog, Qt.Key.Key_Z)
    assert waveform.size() == original_size
    assert waveform.isVisible()
    assert waveform.grab().toImage() == original_image
    shortcut(dialog, Qt.Key.Key_Y)
    assert waveform.size() == original_size
    assert waveform.grab().toImage() == edited_image


@pytest.mark.parametrize("previous", [False, True])
def test_screenshot_undo_restores_animation_and_ordered_selection(review, monkeypatch, tmp_path, previous):
    dialog, _config = review
    paths = []
    for index, color in enumerate((Qt.GlobalColor.red, Qt.GlobalColor.blue, Qt.GlobalColor.green)):
        path = tmp_path / f"image-{index}.png"
        pixmap = QPixmap(40, 20)
        pixmap.fill(color)
        pixmap.save(str(path))
        paths.append(str(path))
    dialog.populate_ui("word", "sentence", paths[0], paths[0], None, "translation", 0, 0, pending_animated=True)
    dialog.show()
    QApplication.instance().processEvents()
    selected = ScreenshotSelectionResult("replay.mp4", (ScreenshotMedia(paths[1], 1.0), ScreenshotMedia(paths[2], 2.0)))
    calls = []
    monkeypatch.setattr(
        "GameSentenceMiner.ui.qt_main.launch_screenshot_selector",
        lambda *args, **kwargs: calls.append(True) or selected,
    )
    dialog._select_screenshot(previous=previous)
    attribute = "previous_screenshot_path" if previous else "screenshot_path"
    assert getattr(dialog, attribute) == selected
    shortcut(dialog, Qt.Key.Key_Z)
    assert getattr(dialog, attribute) == paths[0]
    if not previous:
        assert dialog.animated_audio_notice_label.isVisible()
        assert dialog.screenshot_button.text() == "Replace animation"
    shortcut(dialog, Qt.Key.Key_Y)
    assert getattr(dialog, attribute) == selected
    assert calls == [True]


def test_generated_translation_can_be_undone_without_late_result_overwriting_it(review):
    dialog, _config = review
    future = Future()
    dialog.populate_ui("word", "sentence", None, None, None, "", 0, 0, translation_future=future)
    future.set_result("generated translation")
    dialog._poll_translation_future()
    assert dialog.translation_text.toPlainText() == "generated translation"
    shortcut(dialog.translation_text, Qt.Key.Key_Z)
    assert dialog.translation_text.toPlainText() == ""
    dialog._poll_translation_future()
    assert dialog.translation_text.toPlainText() == ""
    shortcut(dialog.translation_text, Qt.Key.Key_Y)
    assert dialog.translation_text.toPlainText() == "generated translation"


def test_text_context_menu_uses_the_same_dialog_history(review):
    dialog, _config = review
    dialog.nsfw_tag_checkbox.click()
    menu = dialog._review_history.create_context_menu(dialog.sentence_text)
    undo = next(action for action in menu.actions() if action.objectName() == "edit-undo")
    assert undo.isEnabled()
    undo.trigger()
    assert not dialog.nsfw_tag_checkbox.isChecked()
    menu.deleteLater()
    menu = dialog._review_history.create_context_menu(dialog.sentence_text)
    redo = next(action for action in menu.actions() if action.objectName() == "edit-redo")
    assert redo.isEnabled()
    redo.trigger()
    assert dialog.nsfw_tag_checkbox.isChecked()
    menu.deleteLater()


def test_dialogue_regeneration_is_one_edit_and_redo_reuses_generated_media(review, monkeypatch, tmp_path):
    dialog, _config = review
    dialog.audio_player = SimpleNamespace(audio_available=True, is_playing=False, stop_audio=lambda: None)
    old_audio, new_audio = tmp_path / "old.wav", tmp_path / "new.wav"
    sf.write(old_audio, np.zeros(1000), 1000)
    sf.write(new_audio, np.ones(2000) * 0.1, 1000)
    dialog.populate_ui("word", "sentence", None, None, str(old_audio), "translation", 0, 0)
    first = SimpleNamespace(id="first", text="first", prev=None, next=None, get_next_time=lambda: "after-first")
    second = SimpleNamespace(id="second", text="second", prev=first, next=None, get_next_time=lambda: "after-second")
    first.next = second
    context = SimpleNamespace(
        video_path="replay.mp4",
        mined_line=first,
        selected_lines=[],
        start_line=first,
        line_cutoff="after-first",
        full_text="sentence",
        sentence_for_translation="sentence",
        audio_result=None,
    )
    dialog._replay_context = context
    dialog._dialog_selected_lines = [first]
    dialog._dialog_original_selected_line_ids = ("first",)
    calls = []
    monkeypatch.setattr(dialog, "_build_dialogue_sentence", lambda lines: "combined sentence")
    monkeypatch.setattr(
        dialog,
        "_regenerate_dialogue_translation",
        lambda text: calls.append("translation") or ("new translation", True),
    )
    generated = SimpleNamespace(
        vad_result=SimpleNamespace(success=True), audio_edit_context=None, final_audio_output=str(new_audio)
    )
    monkeypatch.setattr(dialog, "_regenerate_dialogue_audio", lambda *args: calls.append("audio") or generated)
    dialog._review_history.reset()
    original_samples = dialog.waveform_widget.audio_data
    dialog._apply_dialogue_line_change([first, second])
    assert dialog._review_history.stack.count() == 1
    assert context.selected_lines == [first, second]
    assert dialog.audio_path == str(new_audio)
    dialog._review_history.undo()
    assert context.selected_lines == []
    assert context.full_text == "sentence"
    assert dialog._dialog_selected_lines == [first]
    assert dialog.audio_path == str(old_audio)
    assert dialog.waveform_widget.audio_data is original_samples
    assert dialog.sentence_text.toPlainText() == "sentence"
    assert dialog.translation_text.toPlainText() == "translation"
    dialog._review_history.redo()
    assert context.selected_lines == [first, second]
    assert context.full_text == "combined sentence"
    assert dialog.audio_path == str(new_audio)
    assert dialog.translation_text.toPlainText() == "new translation"
    assert calls == ["translation", "audio"]


def test_tts_generation_can_be_undone_and_redone_without_another_request(review, monkeypatch, tmp_path):
    dialog, config = review
    config.vad.tts_url = "http://test/$s"
    config.anki.replay_audio_on_tts_generation = False
    dialog.audio_player = SimpleNamespace(audio_available=True, is_playing=False, stop_audio=lambda: None)
    content = io.BytesIO()
    sf.write(content, np.zeros(1000), 1000, format="WAV")
    calls = []
    monkeypatch.setattr(confirmation, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(
        confirmation.requests,
        "get",
        lambda *args, **kwargs: calls.append(True) or SimpleNamespace(ok=True, content=content.getvalue()),
    )
    dialog._review_history.reset()
    dialog._generate_tts_audio()
    generated = dialog.audio_path
    assert generated is not None
    assert "TTS" in dialog.audio_status_label.text()
    dialog._review_history.undo()
    assert dialog.audio_path is None
    assert dialog.waveform_widget.audio_data is None
    dialog._review_history.redo()
    assert dialog.audio_path == generated
    assert dialog.waveform_widget.audio_data is not None
    assert "TTS" in dialog.audio_status_label.text()
    assert calls == [True]


def test_expanding_audio_restores_source_mapping_and_reuses_render_on_redo(review, monkeypatch, tmp_path):
    dialog, _config = review
    dialog.audio_player = SimpleNamespace(audio_available=True, is_playing=False, stop_audio=lambda: None)
    source, clip = tmp_path / "source.wav", tmp_path / "clip.wav"
    sf.write(source, np.ones(3000) * 0.1, 1000)
    sf.write(clip, np.zeros(1000), 1000)
    dialog.populate_ui("word", "sentence", None, None, str(clip), "translation", 0, 0)
    dialog._audio_edit_source_path = str(source)
    dialog._audio_edit_source_duration = 3.0
    dialog._audio_edit_source_window = (1.0, 2.0)
    dialog._audio_edit_range = (1.0, 2.0)
    calls = []

    def render(**kwargs):
        calls.append(kwargs)
        length = round((kwargs["end_time"] - kwargs["start_time"]) * 1000)
        sf.write(kwargs["output_audio"], np.zeros(length), 1000, format="WAV")

    monkeypatch.setattr(confirmation, "trim_audio", render)
    monkeypatch.setattr(confirmation, "get_temporary_directory", lambda: str(tmp_path))
    dialog._review_history.reset()
    dialog._expand_audio_start(0.25)
    rendered = dialog.audio_path
    assert dialog._audio_edit_source_window == (0.75, 2.0)
    dialog._review_history.undo()
    assert dialog.audio_path == str(clip)
    assert dialog._audio_edit_source_window == (1.0, 2.0)
    assert dialog.waveform_widget.get_selection_range() == (0.0, 1.0)
    dialog._review_history.redo()
    assert dialog.audio_path == rendered
    assert dialog._audio_edit_source_window == (0.75, 2.0)
    assert len(calls) == 1


def test_undo_cancels_pending_replay_and_ignores_its_late_result(review, monkeypatch):
    dialog, _config = review
    requests = []

    def request(**kwargs):
        future = Future()
        requests.append(future)
        return future

    monkeypatch.setattr(confirmation, "request_dialogue_replay_refresh", request)
    monkeypatch.setattr(dialog, "_build_dialogue_sentence", lambda lines: "combined")
    lines = [SimpleNamespace(id="next")]
    dialog.nsfw_tag_checkbox.click()
    dialog._start_dialogue_replay_refresh(lines)
    dialog._review_history.undo()
    assert dialog.nsfw_tag_checkbox.isChecked()
    assert dialog._dialogue_replay_future is None
    dialog._review_history.redo()
    assert len(requests) == 1
    assert dialog._dialogue_replay_future is requests[0]
    dialog._review_history.undo()
    requests[0].set_result(SimpleNamespace(capture_time=None, audio_result=None))
    dialog._poll_dialogue_replay_refresh()
    assert dialog.sentence_text.toPlainText() == "sentence"
    applied = []
    monkeypatch.setattr(dialog, "_apply_dialogue_line_change", lambda selected, **kwargs: applied.append(selected))
    dialog._review_history.redo()
    assert len(requests) == 1
    assert applied == [lines]


def test_drag_is_one_undo_and_ctrl_shift_z_also_redoes(review):
    dialog, _config = review
    dialog.audio_player = SimpleNamespace(is_playing=False, stop_audio=lambda: None)
    waveform = dialog.waveform_widget
    waveform.audio_data = np.ones(48000)
    waveform.samplerate = 48000
    waveform.duration = waveform.end_time = 1.0
    waveform.start_time = 0.0
    waveform.show()
    QApplication.instance().processEvents()
    dialog._review_history.reset()
    point = QPoint(1, waveform.height() // 2)
    QTest.mousePress(waveform, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, point)
    for start in (0.1, 0.15, 0.2):
        waveform.start_time = start
        waveform.handle_moved.emit("start", start, 1.0)
    QTest.mouseRelease(waveform, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, point)
    QApplication.instance().processEvents()
    dialog._trim_autoplay_timer.stop()
    assert dialog._review_history.stack.count() == 1
    shortcut(dialog, Qt.Key.Key_Z)
    assert waveform.start_time == 0.0
    QTest.keyClick(dialog, Qt.Key.Key_Z, Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.ShiftModifier)
    assert waveform.start_time == 0.2


def test_undo_cancels_queued_autoplay(review, monkeypatch):
    dialog, _config = review
    dialog.audio_path = "audio.wav"
    calls = []
    monkeypatch.setattr(dialog, "_play_range", lambda: calls.append(True))
    dialog._review_history.reset()
    dialog.autoplay_checkbox.click()
    assert dialog._autoplay_request_timer.isActive()
    dialog._review_history.undo()
    assert not dialog._autoplay_request_timer.isActive()
    dialog._run_queued_autoplay()
    assert calls == []


def test_typing_after_moving_cursor_starts_a_new_undo_group(review):
    dialog, _config = review
    editor = dialog.sentence_text
    append(editor, " AB")
    QTest.keyClick(editor, Qt.Key.Key_Left)
    QTest.keyClicks(editor, "X")
    assert editor.toPlainText() == "sentence AXB"
    shortcut(editor, Qt.Key.Key_Z)
    assert editor.toPlainText() == "sentence AB"
    shortcut(editor, Qt.Key.Key_Z)
    assert editor.toPlainText() == "sentence"


def test_undo_restores_cursor_after_non_bmp_text(review):
    dialog, _config = review
    editor = dialog.sentence_text
    editor.setPlainText("sentence 😀")
    dialog._review_history.reset()
    append(editor, " extra")
    shortcut(editor, Qt.Key.Key_Z)
    assert editor.toPlainText() == "sentence 😀"
    assert editor.textCursor().position() == editor.document().characterCount() - 1


def test_screenshot_picker_does_not_merge_other_updates_into_the_selection(review, monkeypatch):
    dialog, _config = review
    selected = ScreenshotSelectionResult("replay.mp4", (ScreenshotMedia("new.png", 1.0),))

    def choose(*args, **kwargs):
        dialog.translation_text.setPlainText("translation finished while picker was open")
        return selected

    monkeypatch.setattr("GameSentenceMiner.ui.qt_main.launch_screenshot_selector", choose)
    dialog._select_screenshot()
    assert dialog._review_history.stack.count() == 2
    dialog._review_history.undo()
    assert dialog.screenshot_path is None
    assert dialog.translation_text.toPlainText() == "translation finished while picker was open"
    dialog._review_history.undo()
    assert dialog.translation_text.toPlainText() == "translation"
