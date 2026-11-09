"""Session review combines the existing confirmation editor with a durable card list."""

import time
from datetime import timedelta
from functools import wraps
from pathlib import Path

from PyQt6.QtCore import QSignalBlocker, Qt, QTimer, pyqtSignal
from PyQt6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from GameSentenceMiner import session_review
from GameSentenceMiner.ui import WindowId, window_state_manager
from GameSentenceMiner.ui.anki_confirmation_history import review_edit
from GameSentenceMiner.ui.anki_confirmation_qt import AnkiConfirmationDialog
from GameSentenceMiner.ui.qt_theme import apply_compact_theme
from GameSentenceMiner.util.concurrency.work_pool import BoundedWorkPool, submit_background_work
from GameSentenceMiner.util.config.configuration import get_config, logger, use_profile_config


def _with_profile(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with use_profile_config(self.review_profile or get_config()):
            return method(self, *args, **kwargs)

    return wrapped


class ReviewEditor(AnkiConfirmationDialog):
    save_requested = pyqtSignal(object)

    def __init__(self, parent):
        self.review_profile = None
        super().__init__(parent)
        self.setWindowFlags(Qt.WindowType.Widget)
        self.setModal(False)
        self.disable_session_checkbox.hide()

    def _apply_window_behavior_preferences(self):
        # Embedded editors don't own a native window or steal game focus.
        pass

    def showEvent(self, event):
        QDialog.showEvent(self, event)
        if getattr(get_config().anki, "confirmation_gamepad_enabled", False):
            self._start_gamepad_capture()

    def accept(self):
        self.save_requested.emit(self.result)

    def reject(self):
        self.window().close()

    def _selection_requires_fresh_replay(self, selected_lines):
        return False

    def _on_voice(self):
        self._confirm(True)

    def _on_no_voice(self):
        self._confirm(False)

    def _confirm(self, use_audio):
        if not self.isEnabled():
            return
        # Read widgets only on Qt's thread. Exporting the selection and talking
        # to Anki happen later in the window's background worker.
        with use_profile_config(self.review_profile or get_config()):
            edit = None
            if use_audio and self.waveform_widget.audio_data is not None:
                start, end = self.waveform_widget.get_selection_range()
                self._sync_audio_edit_selection_to_current_clip(start, end)
                edit = session_review.ReviewAudioEdit(
                    source_path=self.audio_path,
                    duration=self.waveform_widget.duration,
                    keep_ranges=tuple(
                        self._calculate_audio_keep_ranges(start, end, self.waveform_widget.get_cut_ranges())
                    ),
                )
            metadata = self._build_dialog_result_metadata()
            metadata["review_audio_edit"] = edit
            metadata["review_video_path"] = self._replay_context.video_path
            metadata["review_screenshot_time"] = self.screenshot_timestamp
            metadata["review_previous_screenshot_time"] = self.previous_screenshot_timestamp
            self._stop_dialogue_watchers()
            self.playback_timer.stop()
            self._autoplay_request_timer.stop()
            self._trim_autoplay_timer.stop()
            self._cleanup_audio()
            self.result = (
                use_audio,
                self.sentence_text.toPlainText().strip(),
                self.translation_text.toPlainText().strip(),
                self.screenshot_path,
                self.previous_screenshot_path,
                self.nsfw_tag_checkbox.isChecked(),
                self.audio_path,
                metadata,
            )
            self.accept()

    _select_screenshot = _with_profile(AnkiConfirmationDialog._select_screenshot)
    _generate_tts_audio = _with_profile(AnkiConfirmationDialog._generate_tts_audio)
    _render_audio_edit_range = _with_profile(AnkiConfirmationDialog._render_audio_edit_range)

    def _apply_dialogue_line_change(self, selected_lines, audio_result_override=None):
        self.window()._change_dialogue(selected_lines)

    def _regenerate_dialogue_audio(self, selected_lines, sentence_text):
        return self._prepared_dialogue_change.audio

    def _regenerate_dialogue_translation(self, sentence_text):
        change = self._prepared_dialogue_change
        return change.translation, change.translation_regenerated

    @_with_profile
    @review_edit("Change dialogue")
    def apply_prepared_dialogue(self, change):
        old_start = self._replay_file_mod_time - timedelta(seconds=self._replay_video_duration)
        new_start = change.context.anki_card_creation_time - timedelta(seconds=change.duration)
        shift = (old_start - new_start).total_seconds()
        if change.context.video_path != self._replay_context.video_path:
            self.screenshot_timestamp = max(0, min(change.duration, (self.screenshot_timestamp or 0) + shift))
            self.previous_screenshot_timestamp = max(
                0, min(change.duration, (self.previous_screenshot_timestamp or 0) + shift)
            )
        self._replay_context = change.context
        self._replay_file_mod_time = change.context.anki_card_creation_time
        self._replay_video_duration = change.duration
        self._dialogue_line_start_cache = {}
        self._prepared_dialogue_change = change
        try:
            AnkiConfirmationDialog._apply_dialogue_line_change(self, change.context.selected_lines)
        finally:
            self._prepared_dialogue_change = None

    def _refresh_audio_controls(self, sentence):
        with use_profile_config(self.review_profile or get_config()):
            super()._refresh_audio_controls(sentence)
        self.voice_button.setText("Confirm with audio")
        self.no_voice_button.setText("Confirm without audio")
        self.confirm_button.setText("Confirm card")
        if not self.audio_player.audio_available and self.audio_path and Path(self.audio_path).is_file():
            self.voice_button.show()
            self.no_voice_button.show()
            self.confirm_button.hide()

    def populate_review(self, entry, prepared):
        self.review_profile = prepared.config
        with use_profile_config(prepared.config):
            self.populate_ui(
                entry.data["expression"],
                entry.data["sentence"],
                prepared.screenshot_path,
                prepared.previous_screenshot_path,
                prepared.audio_path,
                entry.data["translation"],
                entry.data["screenshot_time"],
                entry.data["previous_screenshot_time"],
                pending_animated=entry.data["pending_animated"],
                replay_context=prepared.context,
                overlay_only=getattr(prepared.context.mined_line, "source", "") == "overlay",
            )
        self.disable_session_checkbox.hide()
        self._stop_dialogue_watchers()
        self._cancel_auto_accept()
        if prepared.config.anki.autoplay_audio:
            self._queue_autoplay(require_enabled=True)


class SessionReviewWindow(QDialog):
    work_finished = pyqtSignal(object, object)
    card_work_finished = pyqtSignal(str, object, object)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Review Anki cards after session")
        self.resize(1180, 790)
        self.entries = []
        self.current_entry = None
        self.prepared = None
        self.drafts = {}
        self.baselines = {}
        self.busy = False
        self.pending_saves = {}
        self.save_errors = {}
        self._finished_any = False
        # Serializing writes also keeps uploads from occupying all of the workers
        # used to load the next card. Each job owns its captured entry and edits.
        self._save_pool = BoundedWorkPool("gsm-session-review", max_workers=1, capacity=128)
        self.work_finished.connect(self._finish_work)
        self.card_work_finished.connect(self._finish_card_work)
        layout = QVBoxLayout(self)
        heading = QLabel("Review your session")
        heading.setProperty("role", "expression")
        layout.addWidget(heading)
        self.status = QLabel("Choose a card. Saving applies your edits to its existing Anki note.")
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        self.save_status = QLabel()
        self.save_status.setWordWrap(True)
        self.save_status.hide()
        layout.addWidget(self.save_status)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 8, 0)
        self.search = QLineEdit()
        self.search.setPlaceholderText("Filter expressions or sentences…")
        left_layout.addWidget(self.search)
        self.card_list = QListWidget()
        self.card_list.setMinimumWidth(215)
        left_layout.addWidget(self.card_list)
        self.count_label = QLabel()
        left_layout.addWidget(self.count_label)
        splitter.addWidget(left)
        self.editor = ReviewEditor(self)
        splitter.addWidget(self.editor)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([255, 900])
        layout.addWidget(splitter, 1)
        buttons = QHBoxLayout()
        self.keep_button = QPushButton("Keep card / remove from queue")
        self.keep_button.setToolTip("Keep the card as it is in Anki and finish its review without applying edits.")
        self.delete_button = QPushButton("Delete card…")
        self.edit_anki_button = QPushButton("Edit in Anki")
        self.edit_anki_button.setToolTip("Open this note in Anki's editor. Unsaved review edits remain here.")
        self.refresh_button = QPushButton("Refresh list")
        self.cleanup_button = QPushButton("Retry media cleanup")
        self.cleanup_button.setToolTip(
            "Retry removal of unused media from completed reviews after an Anki connection failure."
        )
        self.close_button = QPushButton("Review later")
        for button in (
            self.edit_anki_button,
            self.keep_button,
            self.delete_button,
            self.refresh_button,
            self.cleanup_button,
        ):
            buttons.addWidget(button)
        buttons.addStretch()
        buttons.addWidget(self.close_button)
        layout.addLayout(buttons)
        self.search.textChanged.connect(self._filter)
        self.card_list.currentItemChanged.connect(self._select)
        self.editor.save_requested.connect(self._save)
        self.keep_button.clicked.connect(lambda: self._discard(False))
        self.delete_button.clicked.connect(lambda: self._discard(True))
        self.edit_anki_button.clicked.connect(self._open_in_anki)
        self.refresh_button.clicked.connect(lambda: self.refresh())
        self.cleanup_button.clicked.connect(
            lambda: self._run_work(
                session_review.retry_media_cleanup,
                lambda remaining: self.status.setText(f"Cleanup finished. {remaining} file(s) still awaiting cleanup."),
            )
        )
        self.close_button.clicked.connect(self.close)
        apply_compact_theme(self)
        window_state_manager.restore_geometry(self, WindowId.SESSION_REVIEW)
        self.refresh()
        self.refresh_timer = QTimer(self)
        self.refresh_timer.setInterval(2000)
        self.refresh_timer.timeout.connect(self._append_new_entries)
        self.refresh_timer.start()

    def _remember_draft(self):
        if self.current_entry and self.prepared and not self.busy and self.current_entry.id not in self.pending_saves:
            self.drafts[self.current_entry.id] = (self.prepared, self.editor._review_history.capture())

    def _item_for_entry(self, entry_id):
        for index in range(self.card_list.count()):
            item = self.card_list.item(index)
            if item.data(Qt.ItemDataRole.UserRole).id == entry_id:
                return item
        return None

    def _update_item(self, item):
        entry = item.data(Qt.ItemDataRole.UserRole)
        saving = entry.id in self.pending_saves
        error = self.save_errors.get(entry.id)
        suffix = " — Saving…" if saving else " — Save failed" if error else ""
        item.setText((entry.data["expression"] or "(empty expression)") + suffix)
        item.setToolTip(
            f"{entry.data['scene']} · {entry.data['created_at'][:16].replace('T', ' ')}\n{entry.data['sentence']}"
            + (f"\nCould not save: {error}. Select this card to retry." if error else "")
        )
        flags = Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable
        item.setFlags(Qt.ItemFlag.NoItemFlags if saving else flags)

    def _add_entry(self, entry):
        item = QListWidgetItem()
        item.setData(Qt.ItemDataRole.UserRole, entry)
        self._update_item(item)
        self.card_list.addItem(item)

    def _update_count(self):
        text = f"{len(self.entries) - len(self.pending_saves)} card(s) awaiting review"
        if self.pending_saves:
            text += f" · {len(self.pending_saves)} saving"
        if self.save_errors:
            text += f" · {len(self.save_errors)} need retry"
        self.count_label.setText(text)

    def _update_controls(self):
        self.card_list.setEnabled(not self.busy)
        self.refresh_button.setEnabled(not self.busy)
        self.cleanup_button.setEnabled(not self.busy and not self.pending_saves)
        selected = bool(self.current_entry and self.current_entry.id not in self.pending_saves and not self.busy)
        self.keep_button.setEnabled(selected)
        self.delete_button.setEnabled(selected)
        self.edit_anki_button.setEnabled(selected)
        self.editor.setEnabled(selected and self.prepared is not None)

    def _select_next(self, start_row):
        count = self.card_list.count()
        for offset in range(count):
            row = (start_row + offset) % count
            item = self.card_list.item(row)
            if not item.isHidden() and item.data(Qt.ItemDataRole.UserRole).id not in self.pending_saves:
                self.card_list.setCurrentRow(row)
                return

    def refresh(self, *, select_row=None):
        if self.busy:
            return
        self._remember_draft()
        current_id = self.current_entry.id if self.current_entry else None
        self.entries = session_review.list_pending_reviews()
        known = {entry.id for entry in self.entries}
        self.entries.extend(entry for key, entry in self.pending_saves.items() if key not in known)
        self.entries.sort(key=lambda entry: entry.data["created_at"])
        with QSignalBlocker(self.card_list):
            self.card_list.clear()
            for entry in self.entries:
                self._add_entry(entry)
        self.current_entry = self.prepared = None
        self._update_count()
        self._filter(self.search.text())
        self.editor.hide()
        self._update_controls()
        if self.entries and select_row != -1:
            row = (
                min(select_row, len(self.entries) - 1)
                if select_row is not None
                else next((i for i, entry in enumerate(self.entries) if entry.id == current_id), 0)
            )
            self._select_next(row)
        elif not self.entries:
            self.status.setText("All caught up. New cards will appear here after mining.")

    def _append_new_entries(self):
        if self.busy or not self.isVisible():
            return
        known = {entry.id for entry in self.entries}
        for entry in session_review.list_pending_reviews():
            if entry.id in known:
                continue
            self.entries.append(entry)
            self._add_entry(entry)
        self._update_count()
        self._filter(self.search.text())
        self._refresh_future_context(update_controls=True)

    def _refresh_future_context(self, *, update_controls=False):
        if not self.prepared or self.prepared.future_clip is not None:
            return
        from GameSentenceMiner import session_review_context

        self.prepared.future_clip = session_review_context.load_future_clip(
            self.current_entry, self.prepared.original_clip
        )
        if update_controls and self.prepared.future_clip is not None:
            with use_profile_config(self.prepared.config):
                self.editor._update_dialogue_line_controls()

    def _filter(self, text):
        for index in range(self.card_list.count()):
            item = self.card_list.item(index)
            entry = item.data(Qt.ItemDataRole.UserRole)
            item.setHidden(
                text.casefold()
                not in f"{entry.data['expression']} {entry.data['sentence']} {entry.data['scene']}".casefold()
            )

    def _select(self, item, _previous):
        if not item or self.busy:
            return
        entry = item.data(Qt.ItemDataRole.UserRole)
        if entry.id in self.pending_saves:
            return
        self._remember_draft()
        self.editor._cleanup_audio()
        self.editor._stop_dialogue_watchers()
        self.current_entry = entry
        self.editor.show()
        self.prepared = None
        self.editor.setEnabled(False)
        self._run_work(lambda: session_review.load_review(entry), self._loaded)

    def _loaded(self, prepared):
        self.prepared = prepared
        entry = self.current_entry
        draft = self.drafts.get(entry.id)
        if draft:
            self.prepared = draft[0]
        self._refresh_future_context()
        self.editor.populate_review(entry, self.prepared)
        if draft:
            self.editor._review_history.restore(draft[1])
        else:
            self.baselines[entry.id] = self.editor._review_history.capture()["key"]
        self.editor.setEnabled(True)
        self.status.setText(
            f"{entry.data['scene']} · {entry.data['created_at'][:16].replace('T', ' ')} · edits save to Anki"
        )
        if error := self.save_errors.get(entry.id):
            self.status.setText(f"Could not save: {error}. Your edits are ready to retry.")

    def _run_work(self, function, done):
        self.busy = True
        self._done = done
        self._update_controls()
        self.status.setText("Working in the background…")

        def run():
            try:
                value, error = function(), None
            except Exception as exc:  # noqa: BLE001 - Surface worker errors without closing the review.
                logger.exception("Session review operation failed.")
                value, error = None, exc
            self.work_finished.emit(value, error)

        try:
            submit_background_work(run, timeout=0)
        except Exception as exc:  # noqa: BLE001 - Also report a full or stopped worker queue.
            self.work_finished.emit(None, exc)

    def _finish_work(self, value, error):
        self.busy = False
        self._update_controls()
        if error:
            self.status.setText(f"Could not finish: {error}")
            return
        try:
            self._done(value)
        except Exception as exc:  # noqa: BLE001 - Exceptions escaping Qt slots can abort the backend.
            logger.exception("Could not update the session review window.")
            self.prepared = None
            self.editor.setEnabled(False)
            self.status.setText(f"Could not finish: {exc}")
        self._update_controls()
        self._close_if_finished()

    def _save(self, result):
        if self.busy or not self.current_entry or not self.prepared:
            return
        entry, prepared = self.current_entry, self.prepared
        self._start_card_work(lambda: session_review.apply_review(entry, prepared, result))

    def _open_in_anki(self):
        if self.busy or not self.current_entry:
            return
        entry = self.current_entry
        self._run_work(lambda: session_review.open_in_anki(entry), self.status.setText)

    def _change_dialogue(self, selected_lines):
        if self.busy or not self.prepared or not selected_lines:
            return
        prepared = self.prepared
        translation = self.editor.translation_text.toPlainText().strip()
        refresh_translation = (
            self.editor.regen_translation_checkbox.isVisible() and self.editor.regen_translation_checkbox.isChecked()
        )
        self._run_work(
            lambda: session_review.prepare_dialogue_change(
                prepared,
                selected_lines,
                translation=translation,
                refresh_translation=refresh_translation,
            ),
            self.editor.apply_prepared_dialogue,
        )
        if self.busy:
            self.status.setText("Preparing the selected dialogue…")

    def _discard(self, delete_note):
        if self.busy or not self.current_entry:
            return
        if (
            delete_note
            and QMessageBox.question(
                self,
                "Delete Anki note?",
                "Delete this note and all of its cards from Anki?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        entry = self.current_entry
        self._start_card_work(lambda: session_review.discard_review(entry, delete_note=delete_note))

    def _submit_card_work(self, function):
        return self._save_pool.submit(function, timeout=0)

    def _start_card_work(self, function):
        entry = self.current_entry
        if entry.id in self.pending_saves:
            return
        self._remember_draft()
        try:
            session_review.claim_entry(entry)
        except Exception as exc:  # noqa: BLE001 - A duplicate claim must not escape a Qt callback.
            self.status.setText(f"Could not save: {exc}")
            return

        self.pending_saves[entry.id] = entry
        self.save_errors.pop(entry.id, None)
        row = self.card_list.currentRow()
        self.editor._cleanup_audio()
        self.editor._stop_dialogue_watchers()
        self.editor._review_history.suspend()
        for timer in (
            self.editor.playback_timer,
            self.editor._autoplay_request_timer,
            self.editor._trim_autoplay_timer,
            self.editor._auto_line_expand_timer,
            self.editor._translation_poll_timer,
        ):
            timer.stop()
        self.current_entry = self.prepared = None
        with QSignalBlocker(self.card_list):
            self.card_list.setCurrentRow(-1)
            self._update_item(self._item_for_entry(entry.id))
        self.editor.hide()
        self._update_count()
        self._update_controls()
        self.save_status.setText("Saving in the background. You can continue reviewing other cards.")
        self.save_status.show()
        self.status.setText("Choose another card while this save finishes.")
        if get_config().features.review_after_session.auto_advance:
            self._select_next(row + 1)

        def run():
            try:
                value, error = function(), None
            except Exception as exc:  # noqa: BLE001 - Keep failed cards and their drafts available for retry.
                logger.exception("Session review save failed.")
                value, error = None, exc
            self.card_work_finished.emit(entry.id, value, error)

        try:
            self._submit_card_work(run)
        except Exception as exc:  # noqa: BLE001 - Handle a full or stopped save queue just like a failed save.
            self.card_work_finished.emit(entry.id, None, exc)

    def _finish_card_work(self, entry_id, message, error):
        entry = self.pending_saves.pop(entry_id, None)
        if entry is None:
            return
        session_review.release_entry(entry)
        try:
            item = self._item_for_entry(entry_id)
            if error:
                self.save_errors[entry_id] = str(error)
                self._update_item(item)
                self.save_status.setText(f"Could not save {entry.data['expression']}: {error}. Select it to retry.")
                if self.current_entry is None and not self.busy:
                    self.card_list.setCurrentItem(item)
            else:
                self._finished_any = True
                self.drafts.pop(entry_id, None)
                self.baselines.pop(entry_id, None)
                self.save_errors.pop(entry_id, None)
                self.entries = [entry for entry in self.entries if entry.id != entry_id]
                # Finishing another card must not reload the editor or touch the
                # draft/selection of the card the user is currently reviewing.
                with QSignalBlocker(self.card_list):
                    self.card_list.takeItem(self.card_list.row(item))
                self.save_status.setText(message)
            self.save_status.show()
            self._update_count()
            self._update_controls()
            self._close_if_finished()
        except Exception as exc:  # noqa: BLE001 - Exceptions escaping Qt slots can abort the backend.
            logger.exception("Could not update the completed session review.")
            self.save_status.setText(f"Could not finish updating the review window: {exc}")
            self.save_status.show()

    def _close_if_finished(self):
        if self._finished_any and not self.entries and not self.pending_saves and not self.busy:
            self._append_new_entries()
            if not self.entries:
                self.close()

    def closeEvent(self, event):
        if self.busy or self.pending_saves:
            self.save_status.setText("Waiting for saves to finish. You can continue reviewing other cards.")
            self.save_status.show()
            event.ignore()
            return
        self._remember_draft()
        dirty = any(state["key"] != self.baselines.get(key) for key, (_, state) in self.drafts.items())
        if (
            dirty
            and QMessageBox.question(
                self,
                "Review later?",
                "Unsaved edits in this window will be discarded. Pending cards and saved replays stay available for later review.",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            != QMessageBox.StandardButton.Yes
        ):
            event.ignore()
            return
        self.editor._cleanup_audio()
        self.editor._stop_dialogue_watchers()
        self.editor._review_history.suspend()
        self.drafts.clear()
        self.refresh_timer.stop()
        self._save_pool.shutdown(wait=False)
        window_state_manager.save_geometry(self, WindowId.SESSION_REVIEW)
        event.accept()

    def reject(self):
        self.close()


class SessionReviewController:
    """Lives on Qt's thread; capture probes and saving continue in their own workers."""

    def __init__(self, parent):
        self.window = None
        self.gate = session_review.SessionCloseGate()
        self.pending_scene = None
        self._context_poll = None
        self.timer = QTimer(parent)
        self.timer.setInterval(1000)
        self.timer.timeout.connect(self.tick)
        self.timer.start()

    def tick(self):
        try:
            from PyQt6.QtWidgets import QApplication

            from GameSentenceMiner.obs.active_game import get_active_game_snapshot
            from GameSentenceMiner.util.platform.window_state_monitor import get_window_state_monitor

            config = get_config()
            settings = config.features.review_after_session
            snapshot = get_active_game_snapshot(get_window_state_monitor())
            from GameSentenceMiner import session_review_context

            if session_review_context.has_pending() and (self._context_poll is None or self._context_poll.done()):
                self._context_poll = submit_background_work(
                    lambda: session_review_context.poll(config=config, scene=snapshot.get("sceneName")), timeout=0
                )
            scene = self.gate.observe(snapshot, time.monotonic(), settings.delay_seconds)
            if not settings.enabled or not settings.open_on_game_close:
                self.pending_scene = None
                return
            if scene:
                self.pending_scene = scene
            if snapshot.get("active") is True:
                self.pending_scene = None
            if self.pending_scene and session_review.list_pending_reviews(config):
                if QApplication.activeModalWidget() is not None:
                    return
                self.pending_scene = None
                self.show()
        except Exception:  # noqa: BLE001 - A transient capture error must not escape a Qt timer callback.
            logger.exception("Could not check for session reviews.")

    def show(self):
        if self.window is not None and self.window.isVisible():
            self.window.raise_()
            self.window.activateWindow()
            return
        if self.window is not None:
            self.window.deleteLater()
        self.window = SessionReviewWindow()
        self.window.show()
        self.window.raise_()
        self.window.activateWindow()


def open_session_review():
    from GameSentenceMiner.ui.qt_main import get_dialog_manager

    manager = get_dialog_manager()
    manager._execute_on_gui_thread.emit(manager.session_review_controller.show)
