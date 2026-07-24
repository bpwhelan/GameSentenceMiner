import numpy as np
import soundfile as sf
from PyQt6.QtCore import Qt, pyqtSignal, QPointF
from PyQt6.QtGui import QBrush, QColor, QPainter, QPen, QPolygonF
from PyQt6.QtWidgets import QLabel, QPushButton, QWidget

AUDIO_EXPAND_SECONDS = 0.25
EXPAND_BUTTON_SECONDS_TEXT = f"{AUDIO_EXPAND_SECONDS:g}s"


class AudioWaveformWidget(QWidget):
    """
    Widget that displays an audio waveform and allows selecting a range.
    """

    range_changed = pyqtSignal(float, float)  # start_time, end_time
    handle_moved = pyqtSignal(str, float, float)  # which_handle ('start' or 'end'), start_time, end_time
    seek_requested = pyqtSignal(float)
    cut_ranges_changed = pyqtSignal(object)
    expand_start_requested = pyqtSignal()
    expand_end_requested = pyqtSignal()

    OVERLAY_MARGIN = 4
    OVERLAY_SPACING = 4
    MIN_CUT_SECONDS = 0.05

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(100)
        self.setMouseTracking(True)
        self.setToolTip("Click to seek. Shift+drag to mark audio for removal.")

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
        self.color_cut = QColor(220, 65, 65, 155)
        self.color_cut_border = QColor("#ff8a80")

        self.expand_start_button = QPushButton(f"◀ +{EXPAND_BUTTON_SECONDS_TEXT}", self)
        self.expand_start_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.expand_start_button.clicked.connect(self.expand_start_requested.emit)

        self.expand_end_button = QPushButton(f"+{EXPAND_BUTTON_SECONDS_TEXT} ▶", self)
        self.expand_end_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.expand_end_button.clicked.connect(self.expand_end_requested.emit)

        self.range_chip = QLabel(self)
        self.range_chip.setAlignment(Qt.AlignmentFlag.AlignCenter)

        button_base_style = """
            QPushButton {
                color: #eef6ff;
                background-color: rgba(15, 20, 28, 235);
                border: 1px solid rgba(122, 168, 255, 120);
                padding: 1px 7px;
                font-weight: 700;
            }
            QPushButton:hover {
                background-color: rgba(33, 72, 116, 240);
                border-color: rgba(193, 222, 255, 190);
            }
            QPushButton:pressed {
                background-color: rgba(24, 58, 93, 245);
            }
            QPushButton:disabled {
                color: rgba(238, 246, 255, 110);
                background-color: rgba(15, 20, 28, 150);
                border-color: rgba(122, 168, 255, 55);
            }
        """
        self.expand_start_button.setStyleSheet(
            button_base_style
            + """
            QPushButton {
                border-top-left-radius: 9px;
                border-top-right-radius: 0px;
                border-bottom-left-radius: 0px;
                border-bottom-right-radius: 9px;
            }
            """
        )
        self.expand_end_button.setStyleSheet(
            button_base_style
            + """
            QPushButton {
                border-top-left-radius: 0px;
                border-top-right-radius: 9px;
                border-bottom-left-radius: 9px;
                border-bottom-right-radius: 0px;
            }
            """
        )
        self.range_chip.setStyleSheet(
            """
            QLabel {
                color: #dcecff;
                background-color: rgba(10, 16, 24, 215);
                border: 1px solid rgba(122, 168, 255, 70);
                border-radius: 7px;
                padding: 1px 8px;
                font-weight: 600;
            }
            """
        )
        self.set_expand_controls(False)

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
            }
        )

    def set_expand_controls(self, visible, *, can_expand_start=False, can_expand_end=False, range_text=""):
        self._expand_controls_visible = visible
        self.expand_start_button.setVisible(visible)
        self.expand_end_button.setVisible(visible)
        self.range_chip.setVisible(visible and bool(range_text))
        self.expand_start_button.setEnabled(can_expand_start)
        self.expand_end_button.setEnabled(can_expand_end)
        self.range_chip.setText(range_text)
        self._position_overlay_controls()

    def _position_overlay_controls(self):
        if not self._expand_controls_visible:
            return

        spacing = self.OVERLAY_SPACING
        rail_rect = self._overlay_rail_rect()
        y = rail_rect.top()

        self.expand_start_button.adjustSize()
        self.expand_end_button.adjustSize()
        self.range_chip.adjustSize()

        left_x = rail_rect.left()
        right_x = max(rail_rect.left(), rail_rect.right() - self.expand_end_button.width() + 1)
        self.expand_start_button.move(left_x, y)
        self.expand_end_button.move(right_x, y)

        chip_x = max(rail_rect.left(), (self.width() - self.range_chip.width()) // 2)
        min_chip_x = self.expand_start_button.x() + self.expand_start_button.width() + spacing
        max_chip_x = self.expand_end_button.x() - self.range_chip.width() - spacing
        chip_x = max(chip_x, min_chip_x)
        chip_x = min(chip_x, max_chip_x) if max_chip_x >= min_chip_x else max(rail_rect.left(), chip_x)
        self.range_chip.move(chip_x, y)

    def _overlay_rail_height(self):
        if not self._expand_controls_visible:
            return 0

        button_height = max(self.expand_start_button.sizeHint().height(), self.expand_end_button.sizeHint().height())
        chip_height = self.range_chip.sizeHint().height()
        return max(button_height, chip_height) + self.OVERLAY_MARGIN * 2

    def _overlay_rail_rect(self):
        margin = self.OVERLAY_MARGIN
        rail_height = self._overlay_rail_height()
        return self.rect().adjusted(margin, margin, -margin, -(self.height() - rail_height))

    def _content_rect(self):
        rect = self.rect().adjusted(1, 1, -1, -1)
        if self._expand_controls_visible:
            rect.adjust(0, self._overlay_rail_height(), 0, 0)
        return rect

    def load_audio(self, file_path):
        """
        Loads audio from a file.
        """
        try:
            data, samplerate = sf.read(file_path)
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

        except Exception as e:
            print(f"Error loading audio for waveform: {e}")
            self.audio_data = None

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
        if self.duration <= 0 or self.width() <= 0:
            return 0.0
        return max(0.0, min((float(x) / self.width()) * self.duration, self.duration))

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
            x = (i / len(max_vals)) * width
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
            x = (i / len(min_vals)) * width
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

        width = self.width()

        rect = self.rect().adjusted(1, 1, -1, -1)
        painter.setPen(QPen(self.color_border, 1))
        painter.setBrush(self.color_background)
        painter.drawRoundedRect(rect, 10, 10)

        content_rect = self._content_rect()
        content_height = max(1, content_rect.height())

        if self._expand_controls_visible:
            divider_y = content_rect.top() - max(1, self.OVERLAY_MARGIN // 2)
            painter.setPen(QPen(QColor(255, 255, 255, 24), 1))
            painter.drawLine(content_rect.left() + 6, divider_y, content_rect.right() - 6, divider_y)

        if self.audio_data is None:
            painter.setPen(QColor("black") if self.color_background.lightness() > 128 else QColor("white"))
            painter.drawText(content_rect, Qt.AlignmentFlag.AlignCenter, "No Audio Loaded")
            return

        # Draw Waveform
        if self._waveform_polygon:
            # Scale polygon to height
            transform_poly = QPolygonF()
            for p in self._waveform_polygon:
                transform_poly.append(QPointF(p.x(), content_rect.top() + p.y() * content_height))

            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(self.color_waveform_unselected)  # Gray for unselected
            painter.drawPolygon(transform_poly)

            # Draw Selected Region in different color
            # We can use a clip path or just draw the selected part again on top

            # Calculate x coordinates for start/end
            x_start = (self.start_time / self.duration) * width
            x_end = (self.end_time / self.duration) * width

            # Clip region for selection
            painter.save()
            painter.setClipRect(int(x_start), content_rect.top(), int(x_end - x_start), content_height)
            painter.setBrush(self.color_waveform_selected)  # Blue for selected
            painter.drawPolygon(transform_poly)
            painter.restore()

            # Draw Handles
            # Start Handle
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(
                self.color_handle_hover if self._hover_start or self._dragging_start else self.color_handle
            )
            painter.drawRect(int(x_start), content_rect.top(), 2, content_height)  # Vertical line
            # Handle grip
            painter.drawRect(int(x_start) - self.handle_width // 2, content_rect.top(), self.handle_width, 10)
            painter.drawRect(
                int(x_start) - self.handle_width // 2,
                content_rect.bottom() - 9,
                self.handle_width,
                10,
            )

            # End Handle
            painter.setBrush(self.color_handle_hover if self._hover_end or self._dragging_end else self.color_handle)
            painter.drawRect(int(x_end), content_rect.top(), 2, content_height)  # Vertical line
            painter.drawRect(int(x_end) - self.handle_width // 2, content_rect.top(), self.handle_width, 10)
            painter.drawRect(int(x_end) - self.handle_width // 2, content_rect.bottom() - 9, self.handle_width, 10)

            # Dim out unselected areas
            painter.setBrush(self.color_dim)
            painter.drawRect(0, content_rect.top(), int(x_start), content_height)
            painter.drawRect(int(x_end), content_rect.top(), width - int(x_end), content_height)

            # Mark audio that will be removed. A hatched overlay keeps the
            # waveform readable while making the edit distinct from outer trim.
            cut_ranges = self.get_cut_ranges()
            if self._dragging_cut and self._cut_drag_anchor is not None and self._cut_drag_current is not None:
                cut_ranges.append((self._cut_drag_anchor, self._cut_drag_current))

            for cut_start, cut_end in self._normalize_cut_ranges(cut_ranges):
                cut_x_start = int((cut_start / self.duration) * width)
                cut_x_end = int((cut_end / self.duration) * width)
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

            # Draw Playback Cursor
            if self.playback_position >= 0:
                x_play = (self.playback_position / self.duration) * width
                if x_start <= x_play <= x_end:
                    painter.setPen(QPen(self.color_cursor, 2))
                    painter.drawLine(int(x_play), content_rect.top(), int(x_play), content_rect.bottom())

    def mousePressEvent(self, event):
        if self.audio_data is None or event.button() != Qt.MouseButton.LeftButton:
            return

        x = event.pos().x()
        width = self.width()

        x_start = (self.start_time / self.duration) * width
        x_end = (self.end_time / self.duration) * width

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
        if self.audio_data is None:
            return

        x = event.pos().x()
        width = self.width()

        x_start = (self.start_time / self.duration) * width
        x_end = (self.end_time / self.duration) * width
        tolerance = 10

        # Update hover state
        self._hover_start = abs(x - x_start) < tolerance
        self._hover_end = abs(x - x_end) < tolerance

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
            self._update_pointer_cursor(bool(event.modifiers() & Qt.KeyboardModifier.ShiftModifier))
            self.update()

    def mouseReleaseEvent(self, event):
        if self._dragging_cut and self._cut_drag_anchor is not None and self._cut_drag_current is not None:
            start, end = sorted((self._cut_drag_anchor, self._cut_drag_current))
            self._reset_cut_drag()
            self.add_cut_range(start, end)

        self._dragging_start = False
        self._dragging_end = False
        self._update_pointer_cursor(bool(event.modifiers() & Qt.KeyboardModifier.ShiftModifier))
        self.update()
