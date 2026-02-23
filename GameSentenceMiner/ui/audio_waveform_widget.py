import numpy as np
import soundfile as sf
from PyQt6.QtCore import Qt, pyqtSignal, QRectF, QPointF
from PyQt6.QtGui import QPainter, QColor, QPen, QBrush, QPolygonF
from PyQt6.QtWidgets import QWidget, QHBoxLayout, QVBoxLayout


class AudioWaveformWidget(QWidget):
    """
    Widget that displays an audio waveform and allows selecting a range.
    """
    range_changed = pyqtSignal(float, float) # start_time, end_time
    handle_moved = pyqtSignal(str, float, float) # which_handle ('start' or 'end'), start_time, end_time
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(100)
        self.setMouseTracking(True)
        
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
        
        # Interaction state
        self._dragging_start = False
        self._dragging_end = False
        self._hover_start = False
        self._hover_end = False
        
        self.handle_width = 10
        
        # Theme Colors
        self.color_background = QColor("#f0f0f0")
        self.color_waveform_unselected = QColor("#a0a0a0")
        self.color_waveform_selected = QColor("#007bff")
        self.color_handle = QColor("#0056b3")
        self.color_handle_hover = QColor("#003d80")
        self.color_dim = QColor(0, 0, 0, 50)
        self.color_cursor = QColor("red")
        
    def set_colors(self, colors):
        """
        Set theme colors.
        colors: dict with keys matching attribute names (without 'color_' prefix, e.g. 'background')
        """
        if 'background' in colors: self.color_background = QColor(colors['background'])
        if 'waveform_unselected' in colors: self.color_waveform_unselected = QColor(colors['waveform_unselected'])
        if 'waveform_selected' in colors: self.color_waveform_selected = QColor(colors['waveform_selected'])
        if 'handle' in colors: self.color_handle = QColor(colors['handle'])
        if 'handle_hover' in colors: self.color_handle_hover = QColor(colors['handle_hover'])
        if 'dim' in colors: self.color_dim = QColor(colors['dim'])
        if 'cursor' in colors: self.color_cursor = QColor(colors['cursor'])
        self.update()

    def set_dark_mode(self):
        """Convenience method to set a dark theme."""
        self.set_colors({
            'background': "#2b2b2b",
            'waveform_unselected': "#555555",
            'waveform_selected': "#4a90e2",
            'handle': "#357abd",
            'handle_hover': "#5b9dd9",
            'dim': QColor(0, 0, 0, 100),
            'cursor': "red"
        })

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
            
            self._generate_waveform_polygon()
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
        padded_data = np.pad(self.audio_data, (0, pad_size), mode='constant')
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
            y = 0.5 - (val * 0.5) # normalized 0..1
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
        super().resizeEvent(event)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        
        width = self.width()
        height = self.height()
        
        # Background
        painter.fillRect(0, 0, width, height, self.color_background)
        
        if self.audio_data is None:
            painter.setPen(QColor("black") if self.color_background.lightness() > 128 else QColor("white"))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "No Audio Loaded")
            return

        # Draw Waveform
        if self._waveform_polygon:
            # Scale polygon to height
            transform_poly = QPolygonF()
            for p in self._waveform_polygon:
                transform_poly.append(QPointF(p.x(), p.y() * height))
                
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(self.color_waveform_unselected) # Gray for unselected
            painter.drawPolygon(transform_poly)
            
            # Draw Selected Region in different color
            # We can use a clip path or just draw the selected part again on top
            
            # Calculate x coordinates for start/end
            x_start = (self.start_time / self.duration) * width
            x_end = (self.end_time / self.duration) * width
            
            # Clip region for selection
            painter.save()
            painter.setClipRect(int(x_start), 0, int(x_end - x_start), height)
            painter.setBrush(self.color_waveform_selected) # Blue for selected
            painter.drawPolygon(transform_poly)
            painter.restore()
            
            # Draw Handles
            # Start Handle
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(self.color_handle_hover if self._hover_start or self._dragging_start else self.color_handle)
            painter.drawRect(int(x_start), 0, 2, height) # Vertical line
            # Handle grip
            painter.drawRect(int(x_start) - self.handle_width // 2, 0, self.handle_width, 10) 
            painter.drawRect(int(x_start) - self.handle_width // 2, height - 10, self.handle_width, 10)

            # End Handle
            painter.setBrush(self.color_handle_hover if self._hover_end or self._dragging_end else self.color_handle)
            painter.drawRect(int(x_end), 0, 2, height) # Vertical line
            painter.drawRect(int(x_end) - self.handle_width // 2, 0, self.handle_width, 10)
            painter.drawRect(int(x_end) - self.handle_width // 2, height - 10, self.handle_width, 10)
            
            # Dim out unselected areas
            painter.setBrush(self.color_dim)
            painter.drawRect(0, 0, int(x_start), height)
            painter.drawRect(int(x_end), 0, width - int(x_end), height)
            
            # Draw Playback Cursor
            if self.playback_position >= 0:
                x_play = (self.playback_position / self.duration) * width
                if x_start <= x_play <= x_end:
                    painter.setPen(QPen(self.color_cursor, 2))
                    painter.drawLine(int(x_play), 0, int(x_play), height)

    def mousePressEvent(self, event):
        if self.audio_data is None:
            return
            
        x = event.pos().x()
        width = self.width()
        
        x_start = (self.start_time / self.duration) * width
        x_end = (self.end_time / self.duration) * width
        
        # Check handles with some tolerance
        tolerance = 10
        
        if abs(x - x_start) < tolerance:
            self._dragging_start = True
        elif abs(x - x_end) < tolerance:
            self._dragging_end = True
        else:
            # Click inside to seek?
            # Or click outside to reset handles?
            # Let's say click sets playback pos, unless dragging
            pass
            
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
            new_time = (x / width) * self.duration
            self.start_time = max(0.0, min(new_time, self.end_time - 0.1)) # Min 0.1s duration
            self.range_changed.emit(self.start_time, self.end_time)
            self.handle_moved.emit('start', self.start_time, self.end_time)
            self.update()
        elif self._dragging_end:
            new_time = (x / width) * self.duration
            self.end_time = min(self.duration, max(new_time, self.start_time + 0.1))
            self.range_changed.emit(self.start_time, self.end_time)
            self.handle_moved.emit('end', self.start_time, self.end_time)
            self.update()
        else:
            if self._hover_start or self._hover_end:
                self.setCursor(Qt.CursorShape.SizeHorCursor)
            else:
                self.setCursor(Qt.CursorShape.ArrowCursor)
            self.update()

    def mouseReleaseEvent(self, event):
        self._dragging_start = False
        self._dragging_end = False
        self.update()
