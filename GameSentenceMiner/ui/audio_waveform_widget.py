import os

import numpy as np
import soundfile as sf
from PyQt6.QtCore import QEvent, QPointF, QRectF, Qt, pyqtSignal
from PyQt6.QtGui import QBrush, QColor, QPainter, QPen, QPolygonF
from PyQt6.QtWidgets import QApplication, QLabel, QPushButton, QWidget

AUDIO_EXPAND_SECONDS = 0.25


class AudioWaveformWidget(QWidget):
    """
    Widget that displays an audio waveform and allows selecting a range.
    """

    range_changed = pyqtSignal(float, float)  # start_time, end_time
    handle_moved = pyqtSignal(str, float, float)  # which_handle ('start' or 'end'), start_time, end_time
    seek_requested = pyqtSignal(float)
    cut_ranges_changed = pyqtSignal(object)
    expand_start_requested = pyqtSignal(float)
    expand_end_requested = pyqtSignal(float)

    OVERLAY_MARGIN = 6
    OVERLAY_SPACING = 8
    PLOT_MARGIN = 10
    MIN_CUT_SECONDS = 0.05

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(96)
        self.setMouseTracking(True)
        self.setAccessibleName("Audio waveform and trim selection")

        # Audio data
        self.audio_data = None
        self.samplerate = 0
        self.duration = 0
        self.channels = 0

        # Selection state (in seconds)
        self.start_time = 0.0
        self.end_time = 0.0

        # Playback cursor (in seconds)
        self.playback_position = -1.0

        # Visual caching
        self._waveform_polygon = None
        self._expand_controls_visible = False
        self._expand_step = AUDIO_EXPAND_SECONDS
        self._expand_modifiers = Qt.KeyboardModifier.NoModifier
        self._effective_expand_step = self._expand_step
        self._range_text = ""

        # Interaction state
        self._dragging_start = False
        self._dragging_end = False
        self._dragging_cut = False
        self._hover_start = False
        self._hover_end = False
        self._cut_mode = False
        self._cut_drag_anchor = None
        self._cut_drag_current = None
        self._cut_ranges = []
        self._cut_history = []

        self.handle_width = 10

        # Theme Colors
        self.color_background = QColor("#f0f0f0")
        self.color_waveform_unselected = QColor("#a0a0a0")
        self.color_waveform_selected = QColor("#007bff")
        self.color_handle = QColor("#0056b3")
        self.color_handle_hover = QColor("#003d80")
        self.color_dim = QColor(0, 0, 0, 50)
        self.color_cursor = QColor("red")
        self.color_border = QColor("#4a4f57")
        self.color_text = QColor("#202124")
        self.color_text_muted = QColor("#62666d")
        self.color_cut = QColor(220, 65, 65, 155)
        self.color_cut_border = QColor("#ff8a80")

        self.expand_start_button = QPushButton(self)
        self.expand_start_button.setAccessibleName("Add audio before the selection")
        self.expand_start_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.expand_start_button.clicked.connect(lambda: self.expand_start_requested.emit(self._effective_expand_step))

        self.expand_end_button = QPushButton(self)
        self.expand_end_button.setAccessibleName("Add audio after the selection")
        self.expand_end_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.expand_end_button.clicked.connect(lambda: self.expand_end_requested.emit(self._effective_expand_step))

        self.range_chip = QLabel(self)
        self.range_chip.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._hint_text = "Drag edges to trim  ·  Click to seek  ·  Shift+drag to cut"
        self.interaction_hint = QLabel(self._hint_text, self)
        self.interaction_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.interaction_hint.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self._update_overlay_styles()
        self.set_expand_step(AUDIO_EXPAND_SECONDS)
        self.set_expand_controls(False)

    def _update_overlay_styles(self):
        button_style = f"""
            QPushButton {{
                color: {self.color_text.name()}; background: transparent;
                border: 1px solid {self.color_border.name()}; border-radius: 5px;
                padding: 3px 8px; min-height: 14px; font-size: 11px;
            }}
            QPushButton:hover, QPushButton:focus {{ border-color: {self.color_handle.name()}; }}
            QPushButton:pressed {{ background: {self.color_border.name()}; }}
            QPushButton:disabled {{ color: {self.color_text_muted.name()}; border-color: transparent; }}
        """
        self.expand_start_button.setStyleSheet(button_style)
        self.expand_end_button.setStyleSheet(button_style)
        self.range_chip.setStyleSheet(
            f"color: {self.color_text.name()}; background: transparent; border: none; font-size: 11px;"
        )
        self.interaction_hint.setStyleSheet(
            f"color: {self.color_text_muted.name()}; background: transparent; border: none; font-size: 11px;"
        )

    def set_expand_step(self, seconds):
        self._expand_step = seconds
        self._update_expand_step_labels(self._expand_modifiers)

    def _update_expand_step_labels(self, modifiers):
        self._expand_modifiers = modifiers
        shift = bool(modifiers & Qt.KeyboardModifier.ShiftModifier)
        control = bool(modifiers & Qt.KeyboardModifier.ControlModifier)
        factor = 1 if shift == control else (5 if shift else 0.2)
        self._effective_expand_step = round(self._expand_step * factor, 6)
        seconds_text = f"{self._effective_expand_step:g}s"
        if self.expand_start_button.text() == f"◀ +{seconds_text}":
            return
        self.expand_start_button.setText(f"◀ +{seconds_text}")
        self.expand_end_button.setText(f"+{seconds_text} ▶")
        self._position_overlay_controls()

    def showEvent(self, event):
        super().showEvent(event)
        QApplication.instance().installEventFilter(self)
        self._update_expand_step_labels(QApplication.keyboardModifiers())

    def hideEvent(self, event):
        QApplication.instance().removeEventFilter(self)
        self._update_expand_step_labels(Qt.KeyboardModifier.NoModifier)
        super().hideEvent(event)

    def eventFilter(self, watched, event):
        # Watch the whole dialog so labels follow modifiers even while editing text.
        # Other settings widgets store their parent in an attribute named `window`.
        if isinstance(watched, QWidget) and QWidget.window(watched) is QWidget.window(self):
            event_type = event.type()
            if event_type in (QEvent.Type.KeyPress, QEvent.Type.KeyRelease):
                modifiers = event.modifiers()
                modifier = {
                    Qt.Key.Key_Shift: Qt.KeyboardModifier.ShiftModifier,
                    Qt.Key.Key_Control: Qt.KeyboardModifier.ControlModifier,
                }.get(event.key())
                if modifier is not None:
                    if event_type == QEvent.Type.KeyPress:
                        modifiers |= modifier
                    else:
                        modifiers &= ~modifier
                self._update_expand_step_labels(modifiers)
            elif event_type in (QEvent.Type.MouseButtonPress, QEvent.Type.MouseButtonRelease, QEvent.Type.MouseMove):
                self._update_expand_step_labels(event.modifiers())
            elif event_type == QEvent.Type.WindowActivate:
                self._update_expand_step_labels(QApplication.keyboardModifiers())
            elif event_type == QEvent.Type.WindowDeactivate:
                self._update_expand_step_labels(Qt.KeyboardModifier.NoModifier)
        return super().eventFilter(watched, event)

    def set_colors(self, colors):
        """
        Set theme colors.
        colors: dict with keys matching attribute names (without 'color_' prefix, e.g. 'background')
        """
        if "background" in colors:
            self.color_background = QColor(colors["background"])
        if "waveform_unselected" in colors:
            self.color_waveform_unselected = QColor(colors["waveform_unselected"])
        if "waveform_selected" in colors:
            self.color_waveform_selected = QColor(colors["waveform_selected"])
        if "handle" in colors:
            self.color_handle = QColor(colors["handle"])
        if "handle_hover" in colors:
            self.color_handle_hover = QColor(colors["handle_hover"])
        if "dim" in colors:
            self.color_dim = QColor(colors["dim"])
        if "cursor" in colors:
            self.color_cursor = QColor(colors["cursor"])
        if "border" in colors:
            self.color_border = QColor(colors["border"])
        if "text" in colors:
            self.color_text = QColor(colors["text"])
        if "text_muted" in colors:
            self.color_text_muted = QColor(colors["text_muted"])
        self._update_overlay_styles()
        self._position_overlay_controls()
        self.update()

    def set_dark_mode(self):
        """Convenience method to set a dark theme."""
        self.set_colors(
            {
                "background": "#2b2b2b",
                "waveform_unselected": "#555555",
                "waveform_selected": "#4a90e2",
                "handle": "#357abd",
                "handle_hover": "#5b9dd9",
                "dim": QColor(0, 0, 0, 100),
                "cursor": "red",
                "border": "#3d4652",
                "text": "#ececef",
                "text_muted": "#a0a4ad",
            }
        )

    def set_expand_controls(self, visible, *, can_expand_start=False, can_expand_end=False, range_text=""):
        self._expand_controls_visible = visible
        self.expand_start_button.setVisible(visible)
        self.expand_end_button.setVisible(visible)
        self.range_chip.setVisible(visible and bool(range_text))
        self.expand_start_button.setEnabled(can_expand_start)
        self.expand_end_button.setEnabled(can_expand_end)
        self._range_text = range_text
        self._position_overlay_controls()
        self.update()

    def _position_overlay_controls(self):
        spacing = self.OVERLAY_SPACING
        rail_rect = self._overlay_rail_rect()
        text_x = rail_rect.left()
        text_width = rail_rect.width()
        hint_y = rail_rect.top()

        if self._expand_controls_visible:
            for button in (self.expand_start_button, self.expand_end_button):
                button.adjustSize()
            left_x = rail_rect.left()
            right_x = max(left_x, rail_rect.right() - self.expand_end_button.width() + 1)
            self.expand_start_button.move(
                left_x, rail_rect.top() + (rail_rect.height() - self.expand_start_button.height()) // 2
            )
            self.expand_end_button.move(
                right_x, rail_rect.top() + (rail_rect.height() - self.expand_end_button.height()) // 2
            )
            text_x = self.expand_start_button.geometry().right() + spacing
            text_width = max(0, self.expand_end_button.x() - spacing - text_x)
            chip_height = self.range_chip.sizeHint().height()
            self.range_chip.setGeometry(text_x, rail_rect.top(), text_width, chip_height)
            self.range_chip.setText(
                self.range_chip.fontMetrics().elidedText(self._range_text, Qt.TextElideMode.ElideMiddle, text_width)
            )
            if self._range_text:
                hint_y += chip_height + 2

        self.interaction_hint.setGeometry(text_x, hint_y, text_width, self.interaction_hint.sizeHint().height())
        self.interaction_hint.setText(
            self.interaction_hint.fontMetrics().elidedText(self._hint_text, Qt.TextElideMode.ElideRight, text_width)
        )

    def _overlay_rail_height(self):
        text_height = self.interaction_hint.sizeHint().height()
        button_height = 0
        if self._expand_controls_visible:
            button_height = max(
                self.expand_start_button.sizeHint().height(), self.expand_end_button.sizeHint().height()
            )
            if self._range_text:
                text_height += self.range_chip.sizeHint().height() + 2
        return max(button_height, text_height) + self.OVERLAY_MARGIN * 2

    def _overlay_rail_rect(self):
        margin = self.OVERLAY_MARGIN
        rail_height = self._overlay_rail_height()
        return self.rect().adjusted(margin, margin, -margin, -(self.height() - rail_height + margin))

    def _content_rect(self):
        return self.rect().adjusted(
            self.PLOT_MARGIN,
            self._overlay_rail_height() + 2,
            -self.PLOT_MARGIN + 1,
            -8,
        )

    def load_audio(self, file_path):
        """
        Loads audio from a file.
        """
        try:
            try:
                data, samplerate = sf.read(file_path)
            except (OSError, RuntimeError, ValueError):
                # Some valid FFmpeg-encoded files cannot be read by libsndfile.
                # Decode a temporary WAV without the voice-detection filters so
                # waveform preview and editing still use the original audio.
                from GameSentenceMiner.util.media.ffmpeg import convert_audio_to_wav_lossless

                wav_path = convert_audio_to_wav_lossless(file_path)
                try:
                    data, samplerate = sf.read(wav_path)
                finally:
                    if wav_path and os.path.abspath(wav_path) != os.path.abspath(file_path):
                        try:
                            os.unlink(wav_path)
                        except OSError:
                            pass
            if not samplerate or len(data) == 0:
                raise ValueError("Audio contains no samples")
            self.samplerate = samplerate

            # Handle multi-channel: mix down to mono for visualization
            if data.ndim > 1:
                self.channels = data.shape[1]
                # Simple average mix
                self.audio_data = np.mean(data, axis=1)
            else:
                self.channels = 1
                self.audio_data = data

            self.duration = len(self.audio_data) / self.samplerate

            # Reset selection to full range
            self.start_time = 0.0
            self.end_time = self.duration
            self.playback_position = -1.0
            self._cut_ranges = []
            self._cut_history = []
            self._reset_cut_drag()

            self._generate_waveform_polygon()
            self._position_overlay_controls()
            self.update()
            return True

        except Exception as e:
            print(f"Error loading audio for waveform: {e}")
            self.audio_data = None
            self.samplerate = 0
            self.duration = 0
            self.channels = 0
            self.start_time = self.end_time = 0.0
            self._waveform_polygon = None
            self.update()
            return False

    def set_playback_position(self, position):
        """
        Sets the playback cursor position in seconds.
        Set to < 0 to hide.
        """
        self.playback_position = position
        self.update()

    def get_selection_range(self):
        """
        Returns (start_time, end_time) in seconds.
        """
        return self.start_time, self.end_time

    def set_cut_mode(self, enabled):
        self._cut_mode = bool(enabled)
        self._hint_text = (
            "Cut mode: drag across unwanted audio  ·  Click Finish Cutting when done"
            if self._cut_mode
            else "Drag edges to trim  ·  Click to seek  ·  Shift+drag to cut"
        )
        self._position_overlay_controls()
        if not self._cut_mode:
            self._reset_cut_drag()
        self._update_pointer_cursor()
        self.update()

    def get_cut_ranges(self):
        return list(self._cut_ranges)

    def set_cut_ranges(self, ranges, *, clear_history=True):
        normalized = self._normalize_cut_ranges(ranges)
        changed = normalized != self._cut_ranges
        self._cut_ranges = normalized
        if clear_history:
            self._cut_history = []
        if changed:
            self.cut_ranges_changed.emit(self.get_cut_ranges())
        self.update()

    def add_cut_range(self, start, end):
        previous_ranges = self.get_cut_ranges()
        next_ranges = self._normalize_cut_ranges([*previous_ranges, (start, end)])
        if next_ranges == previous_ranges:
            return
        cut_duration = sum(cut_end - cut_start for cut_start, cut_end in next_ranges)
        if self.end_time - self.start_time - cut_duration < self.MIN_CUT_SECONDS:
            return

        self._cut_history.append(previous_ranges)
        self._cut_ranges = next_ranges
        self.cut_ranges_changed.emit(self.get_cut_ranges())
        self.update()

    def undo_last_cut(self):
        if not self._cut_history:
            return

        self._cut_ranges = self._normalize_cut_ranges(self._cut_history.pop())
        self.cut_ranges_changed.emit(self.get_cut_ranges())
        self.update()

    def clear_cut_ranges(self):
        if not self._cut_ranges:
            return

        self._cut_history.append(self.get_cut_ranges())
        self._cut_ranges = []
        self.cut_ranges_changed.emit([])
        self.update()

    def _normalize_cut_ranges(self, ranges):
        normalized = []
        selection_start = max(0.0, float(self.start_time))
        selection_end = min(float(self.duration), float(self.end_time))

        for start, end in ranges:
            start = max(selection_start, min(float(start), selection_end))
            end = max(selection_start, min(float(end), selection_end))
            if end < start:
                start, end = end, start
            if end - start < self.MIN_CUT_SECONDS:
                continue
            normalized.append((start, end))

        normalized.sort()
        merged = []
        for start, end in normalized:
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
        return merged

    def _constrain_cut_ranges_to_selection(self):
        constrained = self._normalize_cut_ranges(self._cut_ranges)
        if constrained == self._cut_ranges:
            return

        self._cut_ranges = constrained
        self.cut_ranges_changed.emit(self.get_cut_ranges())

    def _reset_cut_drag(self):
        self._dragging_cut = False
        self._cut_drag_anchor = None
        self._cut_drag_current = None

    def _time_from_x(self, x):
        rect = self._content_rect()
        span = rect.right() - rect.left()
        if self.duration <= 0 or span <= 0:
            return 0.0
        return max(0.0, min((float(x) - rect.left()) / span * self.duration, self.duration))

    def _x_from_time(self, seconds):
        rect = self._content_rect()
        fraction = max(0.0, min(float(seconds) / self.duration, 1.0)) if self.duration > 0 else 0.0
        return rect.left() + fraction * (rect.right() - rect.left())

    def _selection_time_from_x(self, x):
        return max(self.start_time, min(self._time_from_x(x), self.end_time))

    def _update_pointer_cursor(self, cut_modifier=False):
        if cut_modifier:
            cursor = Qt.CursorShape.CrossCursor
        elif self._hover_start or self._hover_end:
            cursor = Qt.CursorShape.SizeHorCursor
        elif self._cut_mode:
            cursor = Qt.CursorShape.CrossCursor
        else:
            cursor = Qt.CursorShape.PointingHandCursor
        self.setCursor(cursor)

    def _begin_cut_drag(self, x):
        self._dragging_cut = True
        self._cut_drag_anchor = self._selection_time_from_x(x)
        self._cut_drag_current = self._cut_drag_anchor
        self.update()

    def _generate_waveform_polygon(self):
        if self.audio_data is None or len(self.audio_data) == 0:
            self._waveform_polygon = None
            return

        # Downsample for display
        # We want roughly 1 sample per pixel width, or a bit more detail
        width = self.width()
        if width <= 0:
            return

        n_samples = len(self.audio_data)
        samples_per_pixel = max(1, n_samples // width)

        # Reshape to (width, samples_per_pixel) roughly
        # This is an approximation for visualization
        # We take min and max of each chunk to draw the envelope

        # Pad to be divisible by samples_per_pixel
        pad_size = (samples_per_pixel - (n_samples % samples_per_pixel)) % samples_per_pixel
        padded_data = np.pad(self.audio_data, (0, pad_size), mode="constant")
        reshaped = padded_data.reshape(-1, samples_per_pixel)

        min_vals = np.min(reshaped, axis=1)
        max_vals = np.max(reshaped, axis=1)

        # Normalize to -1..1 range (though data should already be there)
        # But we draw in 0..height coordinates
        # Center is height/2

        polygon = QPolygonF()

        # Create points for top envelope
        for i, val in enumerate(max_vals):
            x = i / max(1, len(max_vals) - 1)
            # val is -1..1. Map 1 -> 0, -1 -> height. Center is height/2.
            # Actually usually typical waveform view:
            # 1.0 -> 0 (top)
            # 0.0 -> height/2
            # -1.0 -> height (bottom)
            # But we want to center it.
            # y = height/2 - (val * height/2)
            y = 0.5 - (val * 0.5)  # normalized 0..1
            polygon.append(QPointF(x, y))

        # Create points for bottom envelope (reverse order)
        for i in range(len(min_vals) - 1, -1, -1):
            val = min_vals[i]
            x = i / max(1, len(min_vals) - 1)
            y = 0.5 - (val * 0.5)
            polygon.append(QPointF(x, y))

        self._waveform_polygon = polygon

    def resizeEvent(self, event):
        self._generate_waveform_polygon()
        self._position_overlay_controls()
        super().resizeEvent(event)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        rect = self.rect().adjusted(1, 1, -1, -1)
        painter.setPen(QPen(self.color_border, 1))
        painter.setBrush(self.color_background)
        painter.drawRoundedRect(rect, 10, 10)

        content_rect = self._content_rect()
        content_height = max(1, content_rect.height())

        if self.audio_data is None or self.duration <= 0:
            painter.setPen(self.color_text_muted)
            painter.drawText(content_rect, Qt.AlignmentFlag.AlignCenter, "No audio loaded")
            return

        x_start = self._x_from_time(self.start_time)
        x_end = self._x_from_time(self.end_time)
        selection_rect = QRectF(x_start, content_rect.top(), x_end - x_start, content_height)
        selection_fill = QColor(self.color_waveform_selected)
        selection_fill.setAlpha(20)
        selection_border = QColor(self.color_waveform_selected)
        selection_border.setAlpha(85)
        painter.setPen(QPen(selection_border, 1))
        painter.setBrush(selection_fill)
        painter.drawRoundedRect(selection_rect, 3, 3)
        painter.setPen(QPen(self.color_border, 1))
        painter.drawLine(
            content_rect.left(), content_rect.center().y(), content_rect.right(), content_rect.center().y()
        )

        # Draw Waveform
        if self._waveform_polygon:
            # Scale polygon to height
            transform_poly = QPolygonF()
            for p in self._waveform_polygon:
                transform_poly.append(
                    QPointF(
                        content_rect.left() + p.x() * (content_rect.right() - content_rect.left()),
                        content_rect.top() + 4 + p.y() * max(1, content_height - 8),
                    )
                )

            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(self.color_waveform_unselected)  # Gray for unselected
            painter.drawPolygon(transform_poly)

            # Clip region for selection
            painter.save()
            painter.setClipRect(selection_rect)
            painter.setBrush(self.color_waveform_selected)  # Blue for selected
            painter.drawPolygon(transform_poly)
            painter.restore()

            # Dim out unselected areas
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(self.color_dim)
            painter.drawRect(
                QRectF(content_rect.left(), content_rect.top(), x_start - content_rect.left(), content_height)
            )
            painter.drawRect(QRectF(x_end, content_rect.top(), content_rect.right() - x_end, content_height))

            # Mark audio that will be removed. A hatched overlay keeps the
            # waveform readable while making the edit distinct from outer trim.
            cut_ranges = self.get_cut_ranges()
            if self._dragging_cut and self._cut_drag_anchor is not None and self._cut_drag_current is not None:
                cut_ranges.append((self._cut_drag_anchor, self._cut_drag_current))

            for cut_start, cut_end in self._normalize_cut_ranges(cut_ranges):
                cut_x_start = int(self._x_from_time(cut_start))
                cut_x_end = int(self._x_from_time(cut_end))
                cut_width = max(1, cut_x_end - cut_x_start)
                painter.setPen(QPen(self.color_cut_border, 1))
                painter.setBrush(QBrush(self.color_cut, Qt.BrushStyle.BDiagPattern))
                painter.drawRect(cut_x_start, content_rect.top(), cut_width, content_height - 1)
                if cut_width >= 34:
                    painter.setPen(self.color_cut_border)
                    painter.drawText(
                        cut_x_start,
                        content_rect.top(),
                        cut_width,
                        content_height,
                        Qt.AlignmentFlag.AlignCenter,
                        "CUT",
                    )

            # Rounded grips stay fully inside the canvas, including at the clip edges.
            for x, active in (
                (x_start, self._hover_start or self._dragging_start),
                (x_end, self._hover_end or self._dragging_end),
            ):
                handle_color = self.color_handle_hover if active else self.color_handle
                painter.setPen(QPen(handle_color, 2))
                painter.drawLine(QPointF(x, content_rect.top()), QPointF(x, content_rect.bottom()))
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(handle_color)
                grip_height = min(22, content_height)
                grip = QRectF(
                    x - self.handle_width / 2,
                    content_rect.center().y() - grip_height / 2,
                    self.handle_width,
                    grip_height,
                )
                painter.drawRoundedRect(grip, 4, 4)
                painter.setPen(QPen(self.color_background, 1))
                for offset in (-2, 2):
                    painter.drawLine(QPointF(x + offset, grip.top() + 7), QPointF(x + offset, grip.bottom() - 7))

            # Draw Playback Cursor
            if 0 <= self.playback_position <= self.duration:
                x_play = self._x_from_time(self.playback_position)
                painter.setPen(QPen(self.color_cursor, 1.5))
                painter.drawLine(QPointF(x_play, content_rect.top()), QPointF(x_play, content_rect.bottom()))
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(self.color_cursor)
                painter.drawPolygon(
                    QPolygonF(
                        [
                            QPointF(x_play - 4, content_rect.top()),
                            QPointF(x_play + 4, content_rect.top()),
                            QPointF(x_play, content_rect.top() + 5),
                        ]
                    )
                )

    def _in_waveform(self, position):
        # The handles extend slightly beyond the plotting area.
        return self._content_rect().adjusted(-self.handle_width // 2, 0, self.handle_width // 2, 0).contains(position)

    def mousePressEvent(self, event):
        if self.audio_data is None or self.duration <= 0 or event.button() != Qt.MouseButton.LeftButton:
            return
        if not self._in_waveform(event.pos()):
            return

        x = event.pos().x()

        x_start = self._x_from_time(self.start_time)
        x_end = self._x_from_time(self.end_time)

        # Check handles with some tolerance
        tolerance = 10
        shift_cut = bool(event.modifiers() & Qt.KeyboardModifier.ShiftModifier)

        if shift_cut:
            self._begin_cut_drag(x)
        elif abs(x - x_start) < tolerance:
            self._dragging_start = True
        elif abs(x - x_end) < tolerance:
            self._dragging_end = True
        elif self._cut_mode:
            self._begin_cut_drag(x)
        else:
            position = self._selection_time_from_x(x)
            self.set_playback_position(position)
            self.seek_requested.emit(position)

    def mouseMoveEvent(self, event):
        if self.audio_data is None or self.duration <= 0:
            return

        x = event.pos().x()

        x_start = self._x_from_time(self.start_time)
        x_end = self._x_from_time(self.end_time)
        tolerance = 10

        # Update hover state
        in_waveform = self._in_waveform(event.pos())
        self._hover_start = in_waveform and abs(x - x_start) < tolerance
        self._hover_end = in_waveform and abs(x - x_end) < tolerance

        if self._dragging_start:
            new_time = self._time_from_x(x)
            self.start_time = max(0.0, min(new_time, self.end_time - 0.1))  # Min 0.1s duration
            self._constrain_cut_ranges_to_selection()
            self.range_changed.emit(self.start_time, self.end_time)
            self.handle_moved.emit("start", self.start_time, self.end_time)
            self.update()
        elif self._dragging_end:
            new_time = self._time_from_x(x)
            self.end_time = min(self.duration, max(new_time, self.start_time + 0.1))
            self._constrain_cut_ranges_to_selection()
            self.range_changed.emit(self.start_time, self.end_time)
            self.handle_moved.emit("end", self.start_time, self.end_time)
            self.update()
        elif self._dragging_cut:
            self._cut_drag_current = self._selection_time_from_x(x)
            self.update()
        else:
            if in_waveform:
                self._update_pointer_cursor(bool(event.modifiers() & Qt.KeyboardModifier.ShiftModifier))
            else:
                self.setCursor(Qt.CursorShape.ArrowCursor)
            self.update()

    def leaveEvent(self, event):
        self._hover_start = self._hover_end = False
        self.update()
        super().leaveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._dragging_cut and self._cut_drag_anchor is not None and self._cut_drag_current is not None:
            start, end = sorted((self._cut_drag_anchor, self._cut_drag_current))
            self._reset_cut_drag()
            self.add_cut_range(start, end)

        self._dragging_start = False
        self._dragging_end = False
        self._update_pointer_cursor(bool(event.modifiers() & Qt.KeyboardModifier.ShiftModifier))
        self.update()
