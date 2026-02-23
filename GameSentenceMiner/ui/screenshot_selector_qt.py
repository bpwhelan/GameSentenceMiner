import json
import os
import subprocess
import sys
from PIL import Image
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QPixmap, QImage
from PyQt6.QtWidgets import (QApplication, QDialog, QVBoxLayout, QGridLayout,
                             QLabel, QWidget, QMessageBox, QFrame, QScrollArea, QSizePolicy)

from GameSentenceMiner.ui import window_state_manager, WindowId
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.config.configuration import (get_config, get_temporary_directory, logger,
                                                         ffmpeg_base_command_list, get_ffprobe_path)
from GameSentenceMiner.util.gsm_utils import sanitize_filename

# Global instance for singleton pattern
_screenshot_selector_instance = None

class ClickableImageLabel(QLabel):
    """QLabel that emits a signal when clicked"""
    def __init__(self, image_path, on_click_callback, parent=None):
        super().__init__(parent)
        self.image_path = image_path
        self.on_click_callback = on_click_callback
        self.setStyleSheet("background-color: black;")
    
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.on_click_callback(self.image_path)


class ScreenshotSelectorDialog(QDialog):
    """
    A modal dialog that extracts frames from a video around a specific timestamp
    and allows the user to select the best one.
    """
    def __init__(self, parent):
        super().__init__(parent)
        self.parent = parent
        self.selected_path = None
        self.first_launch = True
        
        # Set window properties
        self.setWindowTitle("Select Screenshot")
        self.setModal(True)
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Dialog)
        self.setStyleSheet("background-color: black;")
        
        # Create base layout
        self.main_layout = QVBoxLayout(self)
        
        # Scroll area for thumbnails to avoid oversized windows
        self.scroll_area = QScrollArea()
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setFrameShape(QFrame.Shape.NoFrame)
        self.scroll_container = QWidget()
        self.scroll_layout = QVBoxLayout(self.scroll_container)
        self.scroll_layout.setContentsMargins(0, 0, 0, 0)
        self.scroll_layout.setSpacing(6)
        self.scroll_area.setWidget(self.scroll_container)
        self.main_layout.addWidget(self.scroll_area)
        
        # Initialize placeholders
        self.grid_widget = None
        self.loading_label = QLabel("Extracting frames, please wait...")
        self.loading_label.setStyleSheet("color: white; font-size: 16px; padding: 50px;")
        self.loading_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        
        # We don't add the loading label yet, we add it when prepare_selection is called

    def prepare_selection(self, video_path, timestamp, mode='beginning'):
        """
        Clears previous data, runs extraction, and rebuilds the UI.
        Returns True if extraction was successful, False otherwise.
        """
        # Reset state
        self.selected_path = None
        
        while self.scroll_layout.count():
            item = self.scroll_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()
        
        # Clear previous grid if it exists
        if self.grid_widget:
            self.scroll_layout.removeWidget(self.grid_widget)
            self.grid_widget.deleteLater()
            self.grid_widget = None

        # Show loading message
        self.scroll_layout.addWidget(self.loading_label, alignment=Qt.AlignmentFlag.AlignCenter)
        self.loading_label.show()
        
        # Force UI update so user sees loading text
        self.show() 
        QApplication.processEvents()

        try:
            image_paths, golden_frame = self._extract_frames(video_path, timestamp, mode)
            
            # Hide loading message
            self.loading_label.hide()
            self.scroll_layout.removeWidget(self.loading_label)
            
            if not image_paths:
                QMessageBox.critical(self, "Error", "Failed to extract frames from the video.")
                return False
            
            self._build_image_grid(image_paths, golden_frame)
            return True
            
        except Exception as e:
            logger.error(f"ScreenshotSelector failed: {e}")
            QMessageBox.critical(self, "Error", f"An unexpected error occurred: {e}")
            self.loading_label.hide()
            return False

    def showEvent(self, event):
        """Handle window showing: restore position or center."""
        if self.first_launch:
            restored = window_state_manager.restore_geometry(self, WindowId.SCREENSHOT_SELECTOR)
            if not restored:
                self._center_window()
            self.first_launch = False
        super().showEvent(event)

    def closeEvent(self, event):
        """Handle window close event: save position."""
        if self.selected_path is None:
            # If user closes via X without clicking an image, it's a rejection
            self.reject()
        
        window_state_manager.save_geometry(self, WindowId.SCREENSHOT_SELECTOR)
        super().closeEvent(event)

    def exec(self):
        """Override exec to ensure state is saved on exit."""
        super().exec()
        window_state_manager.save_geometry(self, WindowId.SCREENSHOT_SELECTOR)
        return self.result() if hasattr(self, 'result') else QDialog.DialogCode.Rejected

    def _extract_frames(self, video_path, timestamp, mode):
        """Extracts frames using ffmpeg, with automatic black bar removal."""
        temp_dir = os.path.join(
            get_temporary_directory(False),
            "screenshot_frames",
            sanitize_filename(os.path.splitext(os.path.basename(video_path))[0])
        )
        os.makedirs(temp_dir, exist_ok=True)
        
        frame_paths = []
        golden_frame = None
        timestamp_number = float(timestamp)
        video_duration = self.get_video_duration(video_path)
        
        if mode == 'middle':
            timestamp_number = max(0.0, timestamp_number - 2.5)
        elif mode == 'end':
            timestamp_number = max(0.0, timestamp_number - 5.0)
        
        if video_duration is not None and timestamp_number > video_duration:
            logger.warning(f"Timestamp {timestamp_number} exceeds video duration {video_duration}.")
            return [], None
        
        video_filters = []
        
        if get_config().screenshot.trim_black_bars_wip:
            crop_filter = ffmpeg.find_black_bars(video_path, timestamp_number)
            if crop_filter:
                video_filters.append(crop_filter)
        
        # Always add the frame extraction filter
        video_filters.append(f"fps=1/{0.25}")
        
        try:
            # Build the final command for frame extraction
            command = ffmpeg_base_command_list + [
                "-y",                          # Overwrite output files without asking
                "-ss", str(timestamp_number),
                "-i", video_path
            ]
            
            # Chain all collected filters (crop and fps) together with a comma
            command.extend(["-vf", ",".join(video_filters)])
            
            command.extend([
                "-vframes", "20",
                os.path.join(temp_dir, "frame_%02d.png")
            ])
            
            logger.debug(f"Executing frame extraction command: {' '.join(command)}")
            subprocess.run(command, check=True, capture_output=True, text=True)
            
            for i in range(1, 21):
                frame_path = os.path.join(temp_dir, f"frame_{i:02d}.png")
                if os.path.exists(frame_path):
                    frame_paths.append(frame_path)
            
            if not frame_paths:
                return [], None
            
            if mode == "beginning":
                golden_frame = frame_paths[0] if frame_paths else None
            elif mode == "middle":
                golden_frame = frame_paths[len(frame_paths) // 2] if frame_paths else None
            elif mode == "end":
                golden_frame = frame_paths[-1] if frame_paths else None
            
            return frame_paths, golden_frame
        
        except subprocess.CalledProcessError as e:
            logger.error(f"Error extracting frames: {e}")
            logger.error(f"FFmpeg command was: {' '.join(command)}")
            logger.error(f"FFmpeg output:\n{e.stderr}")
            return [], None
        except Exception as e:
            logger.error(f"An unexpected error occurred during frame extraction: {e}")
            return [], None
    
    def _build_image_grid(self, image_paths, golden_frame):
        """Creates and displays the grid of selectable images."""
        # Calculate thumbnail size based on screen size
        screen = QApplication.primaryScreen()
        if screen:
            screen_geometry = screen.geometry()
            # Use ~15% of screen width for each thumbnail (5 columns = 75% of screen)
            # Cap between 200 and 400 pixels width
            thumbnail_width = max(200, min(400, int(screen_geometry.width() * 0.15)))
            # Maintain 16:9 aspect ratio
            thumbnail_height = int(thumbnail_width * 9 / 16)
        else:
            # Fallback if screen detection fails
            thumbnail_width = 256
            thumbnail_height = 144
        
        # Create container widget for the grid
        self.grid_widget = QWidget()
        grid_layout = QGridLayout(self.grid_widget)
        grid_layout.setSpacing(3)
        
        max_cols = 5
        self.image_widgets = []  # Keep references to prevent garbage collection
        
        for i, path in enumerate(image_paths):
            try:
                img = Image.open(path)
                img.thumbnail((thumbnail_width, thumbnail_height))
                
                # Convert PIL to QPixmap
                if img.mode in ('RGBA', 'LA', 'P'):
                    if img.mode == 'P':
                        img = img.convert('RGBA')
                    rgb_img = Image.new('RGB', img.size, (255, 255, 255))
                    rgb_img.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                    img = rgb_img
                
                img_data = img.tobytes('raw', 'RGB')
                qimage = QImage(img_data, img.width, img.height, img.width * 3, QImage.Format.Format_RGB888)
                pixmap = QPixmap.fromImage(qimage)
                
                is_golden = (path == golden_frame)
                border_width = 4 if is_golden else 2
                border_color = "gold" if is_golden else "grey"
                
                # Create frame for border
                frame = QFrame()
                frame.setFrameStyle(QFrame.Shape.Box)
                frame.setLineWidth(border_width)
                frame.setStyleSheet(f"background-color: {border_color};")
                
                frame_layout = QVBoxLayout(frame)
                frame_layout.setContentsMargins(border_width, border_width, border_width, border_width)
                frame_layout.setSpacing(0)
                
                # Create clickable label
                label = ClickableImageLabel(path, self._on_image_click)
                label.setPixmap(pixmap)
                frame_layout.addWidget(label)
                
                # Make frame clickable too
                frame.mousePressEvent = lambda event, p=path: self._on_image_click(p) if event.button() == Qt.MouseButton.LeftButton else None
                
                grid_layout.addWidget(frame, i // max_cols, i % max_cols)
                self.image_widgets.append((frame, label, pixmap))
                
            except Exception as e:
                logger.error(f"Could not load image {path}: {e}")
                error_label = QLabel("Load Error")
                error_label.setStyleSheet("color: white; background-color: red; padding: 50px 10px;")
                error_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
                grid_layout.addWidget(error_label, i // max_cols, i % max_cols)
        
        self.scroll_layout.addWidget(self.grid_widget)
    
    def _on_image_click(self, path):
        """Handles a user clicking on an image."""
        self.selected_path = path
        self.accept()
    
    def _center_window(self):
        """Positions the dialog near the top-left of the primary screen."""
        screen = QApplication.primaryScreen()
        if screen:
            screen_geometry = screen.geometry()
            # Position at 10% from left, 10% from top
            x = screen_geometry.x() + int(screen_geometry.width() * 0.1)
            y = screen_geometry.y() + int(screen_geometry.height() * 0.1)
            self.move(x, y)
    
    def get_video_duration(self, file_path):
        try:
            ffprobe_command = [
                f"{get_ffprobe_path()}",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "json",
                file_path
            ]
            logger.debug(" ".join(ffprobe_command))
            result = subprocess.run(ffprobe_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
            duration_info = json.loads(result.stdout)
            logger.debug(f"Video duration: {duration_info}")
            return float(duration_info["format"]["duration"])
        except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError, FileNotFoundError) as e:
            logger.error(f"Failed to get video duration for {file_path}: {e}")
            return None


def show_screenshot_selector(parent, video_path, timestamp, mode='beginning', on_complete=None):
    """
    Show the screenshot selector dialog and return the selected path.
    Reuses the existing window instance to preserve position.
    """
    global _screenshot_selector_instance
    
    # Create QApplication if it doesn't exist
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    
    # Create singleton if needed
    if _screenshot_selector_instance is None:
        _screenshot_selector_instance = ScreenshotSelectorDialog(parent)
    
    # Prepare UI (runs extraction)
    # If extraction fails, success will be False and we return None
    success = _screenshot_selector_instance.prepare_selection(video_path, timestamp, mode)
    
    selected_path = None
    if success:
        result = _screenshot_selector_instance.exec()
        if result == QDialog.DialogCode.Accepted:
            selected_path = _screenshot_selector_instance.selected_path
    
    if on_complete:
        on_complete(selected_path)
    
    return selected_path


if __name__ == "__main__":
    # Test the dialog
    app = QApplication(sys.argv)
    
    # Placeholder for testing
    video_path = r"C:\Users\Beangate\Videos\GSM\Replay 2025-11-06 17-46-52.mp4"
    
    if os.path.exists(video_path):
        print("First call (should center/load from JSON)...")
        result = show_screenshot_selector(
            parent=None,
            video_path=video_path,
            timestamp=10.0,
            mode='middle'
        )
        print(f"Selected screenshot 1: {result}")
        
        # Second call to test position persistence
        # print("Second call (should stay in place)...")
        # result2 = show_screenshot_selector(
        #     parent=None,
        #     video_path=video_path,
        #     timestamp=15.0,
        #     mode='middle'
        # )
        # print(f"Selected screenshot 2: {result2}")
        
    else:
        print(f"Test video not found at: {video_path}")
        print("Please update the video_path in __main__ to test.")
