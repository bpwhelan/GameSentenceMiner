"""One edit history for the card review, including its generated media state."""

import time
from contextlib import contextmanager
from functools import wraps

import numpy as np
from PyQt6.QtCore import QEvent, QObject, QSignalBlocker, Qt, QTimer
from PyQt6.QtGui import QKeySequence, QPixmap, QTextCursor, QUndoCommand, QUndoStack
from PyQt6.QtWidgets import QApplication, QTextEdit, QWidget

MODEL_FIELDS = (
    "screenshot_path",
    "previous_screenshot_path",
    "screenshot_timestamp",
    "previous_screenshot_timestamp",
    "audio_path",
    "vad_result",
    "reusing_audio",
    "reusing_screenshot",
    "_audio_edit_context",
    "_audio_edit_source_path",
    "_audio_edit_source_duration",
    "_audio_edit_source_window",
    "_audio_edit_range",
    "_audio_edit_rebase_on_selection_trim",
    "_has_performed_audio_expand",
    "_dialog_selected_lines",
    "_dialog_line_selection_changed",
    "_dialog_audio_result",
    "_dialog_translation_regenerated",
    "_replay_file_mod_time",
    "_replay_video_duration",
    "_dialogue_line_start_cache",
)
WAVE_FIELDS = (
    "audio_data",
    "samplerate",
    "duration",
    "channels",
    "start_time",
    "end_time",
    "_cut_ranges",
    "_cut_history",
    "_cut_mode",
)
CONTEXT_FIELDS = (
    "selected_lines",
    "start_line",
    "line_cutoff",
    "full_text",
    "sentence_for_translation",
    "audio_result",
)
CHECKS = (
    "nsfw_tag_checkbox",
    "autoplay_checkbox",
    "disable_session_checkbox",
    "regen_translation_checkbox",
    "cut_audio_button",
)
PRESENTATION = (
    "previous_screenshot_card",
    "prev_screenshot_label_title",
    "prev_image_label",
    "prev_screenshot_button",
    "screenshot_button",
    "animated_audio_notice_label",
    "translation_label_title",
    "translation_text",
    "audio_status_label",
    "codec_info_label",
    "waveform_widget",
    "audio_button",
    "cut_audio_button",
    "undo_audio_cut_button",
    "reset_audio_button",
    "cut_status_label",
    "tts_button",
    "tts_status_label",
    "voice_button",
    "no_voice_button",
    "confirm_button",
)


def _clone(value):
    # Sample buffers and pipeline objects are retained by reference. Edits replace
    # buffers; copying them per keystroke would multiply the clip's memory usage.
    if isinstance(value, dict):
        return {key: _clone(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_clone(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_clone(item) for item in value)
    return value


def _key(value):
    if isinstance(value, dict):
        return tuple((key, _key(item)) for key, item in sorted(value.items(), key=lambda entry: str(entry[0])))
    if isinstance(value, (tuple, list)):
        return tuple(_key(item) for item in value)
    if isinstance(value, np.ndarray):
        return ("samples", id(value))
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return (type(value).__name__, id(value))


def review_edit(label):
    """Combine all signals/model updates from one user operation into one edit."""

    def decorate(function):
        @wraps(function)
        def wrapped(dialog, *args, **kwargs):
            history = getattr(dialog, "_review_history", None)
            if history is None:
                return function(dialog, *args, **kwargs)
            with history.transaction(label):
                return function(dialog, *args, **kwargs)

        return wrapped

    return decorate


class _ReviewEdit(QUndoCommand):
    def __init__(self, history, before, after, label, merge_key):
        super().__init__(label)
        self.history, self.before, self.after = history, before, after
        self.merge_key = merge_key
        self.timestamp = time.monotonic()
        self.first_redo = True

    def id(self):
        return 1 if self.merge_key is not None else -1

    def mergeWith(self, other):
        if self.merge_key != other.merge_key or other.timestamp - self.timestamp > 0.9:
            return False
        self.after, self.timestamp = other.after, other.timestamp
        self.setObsolete(self.before["key"] == self.after["key"])
        return True

    def undo(self):
        self.history.restore(self.before)

    def redo(self):
        if self.first_redo:
            self.first_redo = False
        else:
            self.history.restore(self.after)


class ReviewHistory(QObject):
    def __init__(self, dialog):
        super().__init__(dialog)
        self.dialog = dialog
        self.stack = QUndoStack(self)
        self.stack.setUndoLimit(100)
        self.ready = False
        self.restoring = False
        self.depth = 0
        self.current = None
        self.merge_epoch = 0
        self.text_key = None
        self.interacting = False
        self.pending_redo = None
        self.generation = 0
        self.editors = {"sentence_text": dialog.sentence_text, "translation_text": dialog.translation_text}
        dialog.destroyed.connect(lambda *_args: setattr(self, "ready", False))
        for name, editor in self.editors.items():
            editor.setUndoRedoEnabled(False)
            editor.textChanged.connect(lambda name=name: self.record_text(name))
            editor.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
            editor.customContextMenuRequested.connect(
                lambda point, editor=editor: self.show_context_menu(editor, point)
            )
        for name in CHECKS:
            control = getattr(dialog, name)
            signal = control.stateChanged if hasattr(control, "stateChanged") else control.toggled
            signal.connect(lambda _value, name=name: self.record(f"Change {name}"))
        for widget in [dialog, *dialog.findChildren(QWidget)]:
            widget.installEventFilter(self)

    def suspend(self):
        self.generation += 1
        self.dialog._autoplay_request_timer.stop()
        self.ready = False
        self.interacting = False
        self.depth = 0
        self.pending_redo = None
        self.stack.clear()
        self.current = None

    def reset(self):
        self.generation += 1
        self.stack.clear()
        self.depth = 0
        self.pending_redo = None
        self.merge_epoch += 1
        self.text_key = None
        self.current = self.capture()
        self.ready = True

    def capture(self):
        from GameSentenceMiner.ui import anki_confirmation_qt as review

        dialog = self.dialog
        context = dialog._replay_context
        presentation = {}
        for name in PRESENTATION:
            widget = getattr(dialog, name)
            presentation[name] = {
                "visible": not widget.isHidden(),
                "enabled": widget.isEnabled(),
                "text": widget.text() if hasattr(widget, "text") and not isinstance(widget, QTextEdit) else None,
                "tooltip": widget.toolTip(),
                "tone": widget.property("gsmStatusTone"),
                "boxed": bool(widget.property("gsmStatusBoxed")),
            }
        images = {}
        for name in ("image_label", "prev_image_label"):
            label = getattr(dialog, name)
            pixmap = label._original_pixmap
            images[name] = (
                QPixmap(pixmap) if pixmap is not None else None,
                label.text(),
                label.toolTip(),
                label.property("gsmStatusTone"),
                bool(label.property("gsmStatusBoxed")),
            )
        state = {
            "texts": {name: editor.toPlainText() for name, editor in self.editors.items()},
            "cursors": {
                name: (editor.textCursor().position(), editor.textCursor().anchor())
                for name, editor in self.editors.items()
            },
            "checks": {name: getattr(dialog, name).isChecked() for name in CHECKS},
            "model": {name: _clone(getattr(dialog, name)) for name in MODEL_FIELDS},
            "wave": {name: _clone(getattr(dialog.waveform_widget, name)) for name in WAVE_FIELDS},
            "context": context,
            "context_fields": {
                name: _clone(getattr(context, name)) for name in CONTEXT_FIELDS if hasattr(context, name)
            },
            "presentation": presentation,
            "images": images,
            "global_audio_context": _clone(review.gsm_state.audio_edit_context),
            "global_vad": review.gsm_state.vad_result,
        }
        state["key"] = _key((state["texts"], state["checks"], state["model"], state["wave"], state["context_fields"]))
        return state

    @contextmanager
    def transaction(self, label):
        if not self.ready or self.restoring:
            yield
            return
        outer = self.depth == 0
        self.depth += 1
        try:
            yield
        finally:
            self.depth -= 1
            if outer:
                self.record(label)

    def record(self, label, merge_key=None):
        if not self.ready or self.restoring or self.depth:
            return
        after = self.capture()
        if self.current is not None and after["key"] != self.current["key"]:
            self.pending_redo = None
            command = _ReviewEdit(self, self.current, after, label, merge_key)
            self.stack.push(command)
        self.current = after

    def record_text(self, name):
        merge_key = None
        if self.text_key is not None and self.text_key[0] == name:
            merge_key = (*self.text_key, self.merge_epoch)
        self.text_key = None
        self.record("Edit sentence" if name == "sentence_text" else "Edit translation", merge_key)

    def _stop_pending(self):
        dialog = self.dialog
        for timer in (
            dialog._trim_autoplay_timer,
            dialog._auto_line_expand_timer,
            dialog._translation_poll_timer,
            dialog._dialogue_replay_poll_timer,
            dialog._autoplay_request_timer,
        ):
            timer.stop()
        dialog._pending_auto_line_direction = None
        dialog._autoplay_request = None
        dialog._force_autoplay = False
        dialog._translation_future = None
        dialog._translation_pending = False
        dialog.translation_text.setPlaceholderText("")
        dialog._dialogue_replay_future = None
        dialog._dialogue_replay_selected_lines = None

    def restore(self, state):
        from GameSentenceMiner.ui import anki_confirmation_qt as review

        dialog = self.dialog
        self.restoring = True
        self.generation += 1
        try:
            self._stop_pending()
            stop_audio = getattr(dialog.audio_player, "stop_audio", None)
            if callable(stop_audio):
                stop_audio()
            dialog.playback_timer.stop()
            for name, value in state["model"].items():
                setattr(dialog, name, _clone(value))
            dialog._replay_context = state["context"]
            for name, value in state["context_fields"].items():
                setattr(dialog._replay_context, name, _clone(value))
            if not getattr(dialog._replay_context, "saved_review", False):
                review.gsm_state.vad_result = state["global_vad"]
                review.gsm_state.audio_edit_context = _clone(state["global_audio_context"])
            for name, editor in self.editors.items():
                if editor.toPlainText() != state["texts"][name]:
                    with QSignalBlocker(editor):
                        editor.setPlainText(state["texts"][name])
                        position, anchor = state["cursors"][name]
                        cursor = editor.textCursor()
                        maximum = editor.document().characterCount() - 1
                        cursor.setPosition(min(anchor, maximum))
                        cursor.setPosition(min(position, maximum), QTextCursor.MoveMode.KeepAnchor)
                        editor.setTextCursor(cursor)
            for name, checked in state["checks"].items():
                with QSignalBlocker(getattr(dialog, name)):
                    getattr(dialog, name).setChecked(checked)
            config = review.get_config()
            autoplay = state["checks"]["autoplay_checkbox"]
            if config.anki.autoplay_audio != autoplay:
                config.anki.autoplay_audio = autoplay
                review.save_current_config(config)
            if not getattr(dialog._replay_context, "saved_review", False):
                review.gsm_state.disable_anki_confirmation_session = state["checks"]["disable_session_checkbox"]
            waveform = dialog.waveform_widget
            for name, value in state["wave"].items():
                setattr(waveform, name, _clone(value))
            waveform._generate_waveform_polygon()
            waveform._dragging_start = waveform._dragging_end = False
            waveform._reset_cut_drag()
            waveform.set_cut_mode(state["checks"]["cut_audio_button"])
            waveform.set_playback_position(-1)
            dialog._playing_full_audio = False
            dialog._playback_resume_position = waveform.start_time
            for name, (pixmap, text, tooltip, tone, boxed) in state["images"].items():
                label = getattr(dialog, name)
                label.setPixmap(pixmap)
                if pixmap is None or pixmap.isNull():
                    label.setText(text)
                label.setToolTip(tooltip)
                if tone is not None:
                    review.set_status_style(label, tone, boxed=boxed)
            for name, properties in state["presentation"].items():
                widget = getattr(dialog, name)
                if properties["text"] is not None and name != "prev_image_label":
                    widget.setText(properties["text"])
                widget.setVisible(properties["visible"])
                widget.setEnabled(properties["enabled"])
                widget.setToolTip(properties["tooltip"])
                if properties["tone"] is not None:
                    review.set_status_style(widget, properties["tone"], boxed=properties["boxed"])
            dialog._update_cut_controls()
            dialog._update_audio_expand_buttons()
            dialog._update_dialogue_line_controls()
            if hasattr(dialog.audio_player, "is_playing"):
                dialog._update_audio_buttons()
            dialog._configure_tab_order()
            dialog._cancel_auto_accept()
            waveform.update()
            self.current = self.capture()
        finally:
            self.restoring = False

    def undo(self):
        dialog = self.dialog
        self.merge_epoch += 1
        if self.interacting:
            self._finish_interaction()
        if dialog._dialogue_replay_future is not None:
            self.pending_redo = (
                list(dialog._dialogue_replay_selected_lines or []),
                dialog._dialogue_replay_future,
            )
            self._stop_pending()
            dialog._update_dialogue_line_controls()
            dialog._cancel_auto_accept()
            return
        self.pending_redo = None
        self.stack.undo()

    def redo(self):
        self.merge_epoch += 1
        if self.pending_redo is not None:
            (lines, future), self.pending_redo = self.pending_redo, None
            cancelled = getattr(future, "cancelled", lambda: False)()
            if cancelled:
                self.dialog._start_dialogue_replay_refresh(lines)
            else:
                self.dialog._dialogue_replay_selected_lines = lines
                self.dialog._dialogue_replay_future = future
                if future.done():
                    self.dialog._poll_dialogue_replay_refresh()
                else:
                    self.dialog._dialogue_replay_poll_timer.start()
                    self.dialog._update_dialogue_line_controls()
        else:
            self.stack.redo()

    def create_context_menu(self, editor):
        menu = editor.createStandardContextMenu()
        for action in menu.actions():
            if action.objectName() == "edit-undo":
                action.triggered.disconnect()
                action.triggered.connect(self.undo)
                action.setEnabled(self.stack.canUndo() or self.dialog._dialogue_replay_future is not None)
            elif action.objectName() == "edit-redo":
                action.triggered.disconnect()
                action.triggered.connect(self.redo)
                action.setEnabled(self.stack.canRedo() or self.pending_redo is not None)
        return menu

    def show_context_menu(self, editor, point):
        menu = self.create_context_menu(editor)
        menu.exec(editor.mapToGlobal(point))
        menu.deleteLater()

    def _finish_interaction(self):
        if self.interacting:
            self.interacting = False
            self.depth -= 1
            self.record("Edit audio")

    def eventFilter(self, watched, event):
        if not self.ready or self.restoring:
            return False
        modal = QApplication.activeModalWidget()
        if modal is not None and modal is not self.dialog:
            return False
        kind = event.type()
        if kind not in (
            QEvent.Type.ShortcutOverride,
            QEvent.Type.KeyPress,
            QEvent.Type.FocusOut,
            QEvent.Type.MouseButtonPress,
            QEvent.Type.MouseButtonRelease,
        ):
            return False
        if kind in (QEvent.Type.ShortcutOverride, QEvent.Type.KeyPress):
            undo = event.matches(QKeySequence.StandardKey.Undo)
            redo = event.matches(QKeySequence.StandardKey.Redo)
            control = bool(event.modifiers() & Qt.KeyboardModifier.ControlModifier)
            shift = bool(event.modifiers() & Qt.KeyboardModifier.ShiftModifier)
            if control and not event.modifiers() & Qt.KeyboardModifier.AltModifier:
                undo = undo or (event.key() == Qt.Key.Key_Z and not shift)
                redo = redo or event.key() == Qt.Key.Key_Y or (event.key() == Qt.Key.Key_Z and shift)
            if undo or redo:
                if kind == QEvent.Type.KeyPress:
                    self.undo() if undo else self.redo()
                event.accept()
                return True
        editor_name = next(
            (name for name, editor in self.editors.items() if watched is editor or editor.isAncestorOf(watched)), None
        )
        if editor_name and kind == QEvent.Type.KeyPress:
            editor = self.editors[editor_name]
            cursor = editor.textCursor()
            self.current = {
                **self.current,
                "cursors": {**self.current["cursors"], editor_name: (cursor.position(), cursor.anchor())},
            }
            navigation = event.key() in (
                Qt.Key.Key_Left,
                Qt.Key.Key_Right,
                Qt.Key.Key_Up,
                Qt.Key.Key_Down,
                Qt.Key.Key_Home,
                Qt.Key.Key_End,
                Qt.Key.Key_PageUp,
                Qt.Key.Key_PageDown,
            )
            if navigation or event.modifiers() & (
                Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier
            ):
                self.merge_epoch += 1
                self.text_key = None
            else:
                deletion = event.key() in (Qt.Key.Key_Backspace, Qt.Key.Key_Delete)
                self.text_key = (editor_name, "delete" if deletion else "type")
        elif editor_name and kind in (QEvent.Type.FocusOut, QEvent.Type.MouseButtonPress):
            self.merge_epoch += 1
            self.text_key = None
        if watched is self.dialog.waveform_widget:
            if kind == QEvent.Type.MouseButtonPress and not self.interacting:
                self.interacting = True
                self.depth += 1
            elif kind == QEvent.Type.MouseButtonRelease:
                QTimer.singleShot(0, self._finish_interaction)
        return False
