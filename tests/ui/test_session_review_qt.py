import copy
import os
import shutil
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import QTimer
from PyQt6.QtGui import QFontDatabase
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QMessageBox

from GameSentenceMiner.ui import anki_confirmation_qt, session_review_qt
from tests.test_session_review import forbid_media_work, mock_note_api
from tests.test_session_review import saved_review as saved_review  # noqa: PLC0414 - pytest fixture re-export


@pytest.fixture(scope="module", autouse=True)
def keep_qt_app_alive():
    app = QApplication.instance() or QApplication([])
    if os.path.exists("C:/Windows/Fonts/segoeui.ttf"):
        QFontDatabase.addApplicationFont("C:/Windows/Fonts/segoeui.ttf")
    yield app
    app.processEvents()


class SilentAudio:
    audio_available = False
    is_playing = False

    def __init__(self, *args, **kwargs):
        pass

    def cleanup(self):
        pass


def make_window(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr(anki_confirmation_qt, "AudioPlayer", SilentAudio)
    monkeypatch.setattr(session_review_qt, "get_config", lambda: config)
    monkeypatch.setattr(session_review_qt, "submit_background_work", lambda function, **kwargs: function())
    monkeypatch.setattr(
        session_review_qt.SessionReviewWindow, "_submit_card_work", lambda self, function: function(), raising=False
    )
    monkeypatch.setattr(anki_confirmation_qt, "get_video_duration", lambda path: 10)
    window = session_review_qt.SessionReviewWindow()
    return app, window, entry, config


def add_review(entry, *, suffix="b", expression="Second"):
    second = copy.deepcopy(entry)
    second.folder = entry.folder.parent / (suffix * 32)
    shutil.copytree(entry.folder, second.folder)
    second.data["note_id"] += 1
    second.data["expression"] = expression
    second.data["sentence"] = f"{expression} sentence"
    second.save()
    return second


def test_review_embeds_confirmation_without_countdown(saved_review, monkeypatch):
    app, window, entry, _ = make_window(saved_review, monkeypatch)
    window.show()
    app.processEvents()
    assert window.card_list.item(0).text() == "Expression"
    assert window.editor.sentence_text.toPlainText() == "Sentence"
    assert window.editor._replay_context.saved_review
    assert window.editor._auto_accept_qtimer is None
    assert window.editor.disable_session_checkbox.isHidden()
    assert window.editor.voice_button.text() == "Confirm with audio"
    assert window.editor.no_voice_button.text() == "Confirm without audio"
    if path := os.environ.get("GSM_REVIEW_PREVIEW"):
        window.grab().save(path)
    window.close()
    assert entry.folder.exists()
    window.deleteLater()
    app.processEvents()


def test_review_keeps_editor_and_queue_on_save_failure(saved_review, monkeypatch):
    app, window, entry, _ = make_window(saved_review, monkeypatch)
    window.show()
    monkeypatch.setattr(
        session_review_qt.session_review, "apply_review", lambda *args: (_ for _ in ()).throw(RuntimeError("offline"))
    )
    window.editor.sentence_text.setPlainText("My edits")
    window.editor.no_voice_button.click()
    assert "offline" in window.status.text()
    assert window.editor.isEnabled()
    assert window.editor.sentence_text.toPlainText() == "My edits"
    assert window.card_list.count() == 1
    assert entry.folder.exists()
    assert window.isVisible()
    monkeypatch.setattr(QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
    window.close()
    window.deleteLater()
    app.processEvents()


def test_unchanged_confirm_does_not_export_audio_or_contact_anki(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    entry.data["fields"][config.anki.sentence_audio_field] = "[sound:original.opus]"
    entry.save()
    app, window, _, _ = make_window(saved_review, monkeypatch)
    forbid_media_work(monkeypatch)
    from GameSentenceMiner import anki

    monkeypatch.setattr(anki, "invoke", lambda *args, **kwargs: pytest.fail("Unchanged card contacted Anki"))
    exports = []
    monkeypatch.setattr(window.editor, "_save_trimmed_audio", lambda: exports.append(True) or window.editor.audio_path)
    window.editor.waveform_widget.audio_data = np.zeros(100)
    window.editor.waveform_widget.duration = 2.0
    window.editor.waveform_widget.start_time = 0.0
    window.editor.waveform_widget.end_time = 2.0
    # Editing then undoing a field must be treated the same as leaving it alone.
    window.editor.sentence_text.setPlainText("Draft")
    window.editor.sentence_text.setPlainText("Sentence")
    window.editor.voice_button.click()
    assert exports == []
    assert not entry.folder.exists()
    assert window.card_list.count() == 0
    window.close()
    window.deleteLater()
    app.processEvents()


def test_audio_save_allows_reviewing_next_card_and_keeps_its_draft(saved_review, monkeypatch):
    from GameSentenceMiner import anki
    from GameSentenceMiner.util.media import ffmpeg

    entry, config, *_ = saved_review
    entry.data["fields"][config.anki.sentence_audio_field] = "[sound:original.opus]"
    entry.save()
    second = add_review(entry)
    app, window, _, _ = make_window(saved_review, monkeypatch)
    window.card_list.setCurrentRow(next(i for i, item in enumerate(window.entries) if item.id == entry.id))
    _, calls = mock_note_api(monkeypatch, entry)
    forbid_media_work(monkeypatch, except_processors=("_process_audio",))
    entered, release = threading.Event(), threading.Event()
    wrong_thread = []
    main_thread = threading.get_ident()
    invoke = anki.invoke

    def worker_invoke(*args, **kwargs):
        assert threading.get_ident() != main_thread
        return invoke(*args, **kwargs)

    monkeypatch.setattr(anki, "invoke", worker_invoke)

    def trim(*args, **kwargs):
        if threading.get_ident() == main_thread:
            wrong_thread.append(True)
            raise RuntimeError("Audio export ran on Qt's thread")
        entered.set()
        assert release.wait(5)
        from pathlib import Path

        Path(kwargs["output_audio"]).write_bytes(b"edited")

    def upload(assets, note, *args, **kwargs):
        assert threading.get_ident() != main_thread
        assets.audio_in_anki = "edited.opus"
        note["fields"][config.anki.sentence_audio_field] = "[sound:edited.opus]"

    monkeypatch.setattr(anki_confirmation_qt, "trim_audio", trim)
    monkeypatch.setattr(ffmpeg, "trim_audio", trim)
    monkeypatch.setattr(anki, "_process_audio", upload)
    monkeypatch.setattr(QMessageBox, "critical", lambda *args: None)
    window.editor.waveform_widget.audio_data = np.zeros(100)
    window.editor.waveform_widget.duration = 2.0
    window.editor.waveform_widget.start_time = 0.25
    window.editor.waveform_widget.end_time = 1.75
    pool = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(session_review_qt, "submit_background_work", lambda function, **kwargs: pool.submit(function))
    monkeypatch.setattr(window, "_submit_card_work", lambda function: window._save_pool.submit(function, timeout=0))
    try:
        window.editor.voice_button.click()
        assert not wrong_thread
        deadline = time.monotonic() + 3
        while not entered.is_set() and time.monotonic() < deadline:
            QTest.qWait(10)
        assert entered.is_set()
        deadline = time.monotonic() + 3
        while window.busy and time.monotonic() < deadline:
            QTest.qWait(10)
        assert window.card_list.isEnabled(), "Saving audio disabled navigation to the next review"
        assert window.current_entry.id == second.id
        assert window.editor.isEnabled()
        window.editor.sentence_text.setPlainText("Draft for the next card")
        ticks = []
        QTimer.singleShot(0, lambda: ticks.append(True))
        app.processEvents()
        assert ticks == [True]
        assert not any(action == "updateNoteFields" for action, _ in calls)
        release.set()
        deadline = time.monotonic() + 3
        while window.pending_saves and time.monotonic() < deadline:
            QTest.qWait(10)
        assert not window.pending_saves
        assert not entry.folder.exists()
        assert len([action for action, _ in calls if action == "updateNoteFields"]) == 1
        assert window.current_entry.id == second.id
        assert window.editor.sentence_text.toPlainText() == "Draft for the next card"
        assert window.editor.isEnabled()
    finally:
        release.set()
        pool.shutdown(wait=True)
        window._save_pool.shutdown(wait=True)
        app.processEvents()
        monkeypatch.setattr(QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
        window.close()
        window.deleteLater()
        app.processEvents()


@pytest.mark.parametrize("action", ["confirm", "keep"])
def test_review_closes_after_finishing_last_card(saved_review, monkeypatch, action):
    app, window, entry, _ = make_window(saved_review, monkeypatch)
    window.show()
    app.processEvents()
    try:
        assert window.isVisible()
        if action == "confirm":
            window.editor.no_voice_button.click()
        else:
            window.keep_button.click()
        app.processEvents()
        assert not entry.folder.exists()
        assert not window.isVisible(), "The finished review window stayed open"
    finally:
        window.close()
        window.deleteLater()
        app.processEvents()


def test_review_waits_for_all_saves_before_closing(saved_review, monkeypatch):
    entry, *_ = saved_review
    add_review(entry)
    app, window, _, _ = make_window(saved_review, monkeypatch)
    work = []
    monkeypatch.setattr(window, "_submit_card_work", work.append)
    window.show()
    try:
        window.editor.no_voice_button.click()
        assert window.editor.isEnabled(), "Could not review another card during a save"
        window.editor.no_voice_button.click()
        assert len(work) == 2
        assert window.isVisible()
        assert not window.editor.isEnabled()
        window.close()
        assert window.isVisible(), "Closing abandoned unfinished saves"
        # No duplicate operation is submitted after the last card was confirmed.
        window.editor.no_voice_button.click()
        assert len(work) == 2
        work.pop(0)()
        app.processEvents()
        assert window.isVisible()
        work.pop(0)()
        app.processEvents()
        assert not window.isVisible()
    finally:
        for operation in work:
            operation()
        window.close()
        window.deleteLater()
        app.processEvents()


def test_failed_background_save_keeps_both_drafts_and_can_be_retried(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    second = add_review(entry)
    app, window, _, _ = make_window(saved_review, monkeypatch)
    window.card_list.setCurrentItem(window._item_for_entry(entry.id))
    work, results = [], []
    monkeypatch.setattr(window, "_submit_card_work", work.append)

    def save(item, prepared, result):
        results.append((item.id, result))
        if len(results) == 1:
            raise RuntimeError("Anki is offline")
        session_review_qt.session_review.finish_review(item, config.features.review_after_session)
        return "Saved"

    monkeypatch.setattr(session_review_qt.session_review, "apply_review", save)
    monkeypatch.setattr(QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
    window.show()
    try:
        window.editor.sentence_text.setPlainText("First draft")
        window.editor.waveform_widget.audio_data = np.zeros(100)
        window.editor.waveform_widget.duration = 2.0
        window.editor.waveform_widget.start_time = 0.25
        window.editor.waveform_widget.end_time = 1.75
        window.editor.voice_button.click()
        assert window.current_entry.id == second.id
        window.editor.sentence_text.setPlainText("Second draft")
        # Refreshing must retain the saving row without allowing duplicate saves.
        window.refresh()
        assert window.card_list.count() == 2
        assert not window._item_for_entry(entry.id).flags()
        work.pop(0)()
        app.processEvents()
        assert window.isVisible()
        assert window.current_entry.id == second.id
        assert window.editor.sentence_text.toPlainText() == "Second draft"
        assert "offline" in window.save_status.text()
        assert "Save failed" in window._item_for_entry(entry.id).text()
        assert not window.pending_saves
        assert entry.id in {item.id for item in session_review_qt.session_review.list_pending_reviews()}
        assert results[0][1][1] == "First draft"
        assert results[0][1][7]["review_audio_edit"].keep_ranges == ((0.25, 1.75),)

        window.card_list.setCurrentItem(window._item_for_entry(entry.id))
        assert window.editor.sentence_text.toPlainText() == "First draft"
        window.editor.voice_button.click()
        assert window.current_entry.id == second.id
        assert window.editor.sentence_text.toPlainText() == "Second draft"
        work.pop(0)()
        assert len(results) == 2
        assert results[1][1][7]["review_audio_edit"].keep_ranges == ((0.25, 1.75),)
        assert window.editor.sentence_text.toPlainText() == "Second draft"
        assert window.card_list.count() == 1
        assert not window.save_errors
    finally:
        for operation in work:
            operation()
        window.close()
        window.deleteLater()
        app.processEvents()


def test_save_submission_failure_keeps_review_available(saved_review, monkeypatch):
    app, window, entry, _ = make_window(saved_review, monkeypatch)
    monkeypatch.setattr(window, "_submit_card_work", lambda function: (_ for _ in ()).throw(RuntimeError("queue full")))
    monkeypatch.setattr(QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
    window.show()
    try:
        window.editor.sentence_text.setPlainText("Retain my draft")
        window.editor.no_voice_button.click()
        assert window.isVisible()
        assert not window.pending_saves
        assert "queue full" in window.status.text()
        assert window.editor.isEnabled()
        assert window.editor.sentence_text.toPlainText() == "Retain my draft"
        assert entry.id in {item.id for item in session_review_qt.session_review.list_pending_reviews()}
    finally:
        window.close()
        window.deleteLater()
        app.processEvents()


@pytest.mark.parametrize(
    ("button_name", "use_audio"),
    [("voice_button", True), ("no_voice_button", False), ("confirm_button", False)],
)
def test_confirmation_buttons_handle_qt_clicked_signal(saved_review, monkeypatch, button_name, use_audio):
    app, window, entry, _ = make_window(saved_review, monkeypatch)
    errors, confirmed = [], []
    monkeypatch.setattr(sys, "excepthook", lambda *error: errors.append(error))
    monkeypatch.setattr(window.editor, "_save_trimmed_audio", lambda: window.editor.audio_path)
    monkeypatch.setattr(
        session_review_qt.session_review,
        "apply_review",
        lambda item, prepared, result: confirmed.append((item.id, result)) or "Confirmed",
    )
    try:
        getattr(window.editor, button_name).click()
        app.processEvents()
        assert not errors, [str(error[1]) for error in errors]
        assert len(confirmed) == 1
        assert confirmed[0][0] == entry.id
        assert confirmed[0][1][0] is use_audio
    finally:
        window.close()
        window.deleteLater()
        app.processEvents()


def test_tts_button_handles_qt_clicked_signal(saved_review, monkeypatch):
    app, window, _, _ = make_window(saved_review, monkeypatch)
    errors, messages = [], []
    monkeypatch.setattr(sys, "excepthook", lambda *error: errors.append(error))
    monkeypatch.setattr(QMessageBox, "critical", lambda *args: messages.append(args))
    monkeypatch.setattr(QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
    window.editor.sentence_text.setPlainText("")
    try:
        window.editor.tts_button.click()
        app.processEvents()
        assert not errors, [str(error[1]) for error in errors]
        assert messages and messages[0][1] == "TTS Error"
    finally:
        window.close()
        window.deleteLater()
        app.processEvents()


def test_reset_audio_button_handles_qt_clicked_signal(saved_review, monkeypatch):
    app, window, _, _ = make_window(saved_review, monkeypatch)
    errors = []
    monkeypatch.setattr(sys, "excepthook", lambda *error: errors.append(error))
    try:
        window.editor.reset_audio_button.click()
        app.processEvents()
        assert not errors, [str(error[1]) for error in errors]
    finally:
        window.close()
        window.deleteLater()
        app.processEvents()


def test_review_reports_ui_completion_failure_without_crashing(saved_review, monkeypatch):
    app, window, entry, _ = make_window(saved_review, monkeypatch)
    errors = []
    monkeypatch.setattr(sys, "excepthook", lambda *error: errors.append(error))
    monkeypatch.setattr(
        window.editor, "populate_review", lambda *args: (_ for _ in ()).throw(RuntimeError("invalid media"))
    )
    try:
        window.work_finished.emit(window.prepared, None)
        app.processEvents()
        assert not errors, [str(error[1]) for error in errors]
        assert "invalid media" in window.status.text()
        assert not window.editor.isEnabled()
        assert window.refresh_button.isEnabled()
        assert entry.folder.exists()
    finally:
        window.close()
        window.deleteLater()
        app.processEvents()


def test_review_keeps_drafts_when_switching_cards(saved_review, monkeypatch):
    app, window, entry, _ = make_window(saved_review, monkeypatch)
    second = copy.deepcopy(entry)
    second.folder = entry.folder.parent / ("b" * 32)
    second.data["expression"] = "Second"
    second.data["sentence"] = "Second sentence"
    real_load = session_review_qt.session_review.load_review
    monkeypatch.setattr(
        session_review_qt.session_review, "list_pending_reviews", lambda *args, **kwargs: [entry, second]
    )
    monkeypatch.setattr(session_review_qt.session_review, "load_review", lambda item: real_load(entry))
    window.refresh()
    window.editor.sentence_text.setPlainText("Unsaved draft")
    window.card_list.setCurrentRow(1)
    assert window.editor.sentence_text.toPlainText() == "Second sentence"
    window.card_list.setCurrentRow(0)
    assert window.editor.sentence_text.toPlainText() == "Unsaved draft"
    monkeypatch.setattr(QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
    window.close()
    window.deleteLater()
    app.processEvents()


def test_controller_waits_for_pending_background_card_after_game_close(monkeypatch):
    from GameSentenceMiner.obs import active_game
    from GameSentenceMiner.util.config.configuration import ProfileConfig
    from GameSentenceMiner.util.platform import window_state_monitor

    app = QApplication.instance() or QApplication([])
    config = ProfileConfig()
    config.features.review_after_session.enabled = True
    config.features.review_after_session.delay_seconds = 0
    monkeypatch.setattr(session_review_qt, "get_config", lambda: config)
    snapshot = {"sceneName": "Game", "active": True}
    monkeypatch.setattr(active_game, "get_active_game_snapshot", lambda monitor: snapshot)
    monkeypatch.setattr(window_state_monitor, "get_window_state_monitor", lambda: None)
    pending = []
    monkeypatch.setattr(session_review_qt.session_review, "list_pending_reviews", lambda *args, **kwargs: pending)
    controller = session_review_qt.SessionReviewController(app)
    controller.timer.stop()
    opened = []
    monkeypatch.setattr(controller, "show", lambda: opened.append(True))
    controller.tick()
    snapshot["active"] = False
    controller.tick()
    assert not opened
    pending.append(SimpleNamespace())
    controller.tick()
    controller.tick()
    assert opened == [True]


def test_save_does_not_load_next_card_when_auto_advance_disabled(saved_review, monkeypatch):
    app, window, entry, config = make_window(saved_review, monkeypatch)
    config.features.review_after_session.auto_advance = False
    add_review(entry)
    window.refresh()
    loaded = []
    monkeypatch.setattr(session_review_qt.session_review, "load_review", lambda *args: loaded.append(True))
    window.editor.no_voice_button.click()
    assert not loaded
    assert window.card_list.currentRow() == -1
    assert window.editor.isHidden()
    window.close()
    window.deleteLater()
    app.processEvents()


def test_edit_in_anki_button_opens_current_note_without_saving_draft(saved_review, monkeypatch):
    app, window, entry, _ = make_window(saved_review, monkeypatch)
    _, calls = mock_note_api(monkeypatch, entry)
    monkeypatch.setattr(QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
    try:
        window.editor.sentence_text.setPlainText("Still only a draft")
        window.edit_anki_button.click()
        assert ("guiEditNote", {"note": entry.data["note_id"]}) in calls
        assert not any(action == "updateNoteFields" for action, _ in calls)
        assert window.editor.sentence_text.toPlainText() == "Still only a draft"
        assert window.current_entry.id == entry.id
        assert entry.folder.exists()
    finally:
        window.close()
        window.deleteLater()
        app.processEvents()


def test_future_context_appears_while_open_and_expands_off_thread_with_undo(saved_review, monkeypatch, tmp_path):
    import wave

    from GameSentenceMiner import anki, replay_handler
    from tests.test_session_review_context import save_future

    app, window, entry, config = make_window(saved_review, monkeypatch)
    window.show()
    window.editor.regen_translation_checkbox.setChecked(False)
    original_path = window.editor._replay_context.video_path
    original_duration = window.editor._replay_video_duration
    original_audio = window.editor.audio_path
    assert window.editor._next_dialogue_line() is None
    save_future(entry, config, saved_review[2], monkeypatch)
    window._append_new_entries()
    assert window.editor._next_dialogue_line().text == "Future 1"
    assert window.editor._replay_context.video_path == original_path
    assert window.editor.audio_path == original_audio

    output = tmp_path / "future.wav"
    with wave.open(str(output), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(8000)
        stream.writeframes(b"\x00\x00" * 8000)
    calls = []
    main_thread = threading.get_ident()

    def get_audio(start, cutoff, path, capture_time, **kwargs):
        assert threading.get_ident() != main_thread
        calls.append((path, capture_time))
        return replay_handler.ReplayAudioResult(str(output), None, str(output), 0, 1)

    monkeypatch.setattr(replay_handler.ReplayAudioExtractor, "get_audio", staticmethod(get_audio))
    monkeypatch.setattr(anki, "invoke", lambda *args, **kwargs: pytest.fail("Context preview contacted Anki"))
    pool = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(session_review_qt, "submit_background_work", lambda function, **kwargs: pool.submit(function))
    try:
        window.editor.add_next_line_button.click()
        deadline = time.monotonic() + 3
        while window.busy and time.monotonic() < deadline:
            QTest.qWait(10)
        assert not window.busy
        assert calls == [(window.prepared.future_clip.clip_path, window.prepared.future_clip.clip_end_time)]
        assert "Future 1" in window.editor.sentence_text.toPlainText()
        assert window.editor._replay_context.video_path == window.prepared.future_clip.clip_path
        assert window.editor.audio_path == str(output)
        window.editor._review_history.stack.undo()
        assert window.editor.sentence_text.toPlainText() == "Sentence"
        assert window.editor._replay_context.video_path == original_path
        assert window.editor._replay_video_duration == original_duration
        assert window.editor.audio_path == original_audio
        # Undoing the expansion restores a no-op confirmation, including media.
        window.editor.no_voice_button.click()
        assert not entry.folder.exists()
        assert not window.isVisible()
    finally:
        pool.shutdown(wait=True)
        app.processEvents()
        monkeypatch.setattr(QMessageBox, "question", lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
        window.close()
        window.deleteLater()
        app.processEvents()
