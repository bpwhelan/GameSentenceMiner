import sys
import os
import json
import subprocess
from PyQt6.QtWidgets import (QApplication, QDialog, QVBoxLayout, QGridLayout, 
                              QLabel, QWidget, QMessageBox, QFrame)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QPixmap, QImage
from PIL import Image

from GameSentenceMiner.util import ffmpeg
from GameSentenceMiner.util.gsm_utils import sanitize_filename
from GameSentenceMiner.util.configuration import (get_config, get_temporary_directory, logger, 
                                                  ffmpeg_base_command_list, get_ffprobe_path)


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
    def __init__(self, parent, video_path, timestamp, mode='beginning'):
        super().__init__(parent)
        self.parent = parent
        self.selected_path = None  # This will store the final result
        
        # Set window properties
        self.setWindowTitle("Select Screenshot")
        self.setModal(True)
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Dialog)
        self.setStyleSheet("background-color: black;")
        
        # Create layout
        self.main_layout = QVBoxLayout(self)
        
        # Show loading message
        self.loading_label = QLabel("Extracting frames, please wait...")
        self.loading_label.setStyleSheet("color: white; font-size: 16px; padding: 50px;")
        self.loading_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.main_layout.addWidget(self.loading_label)
        
        # Force UI update
        self.show()
        QApplication.processEvents()
        
        # Run extraction and build the main UI
        try:
            image_paths, golden_frame = self._extract_frames(video_path, timestamp, mode)
            
            # Remove loading message
            self.main_layout.removeWidget(self.loading_label)
            self.loading_label.deleteLater()
            
            if not image_paths:
                QMessageBox.critical(self, "Error", "Failed to extract frames from the video.")
                self.reject()
                return
            
            self._build_image_grid(image_paths, golden_frame)
            
        except Exception as e:
            logger.error(f"ScreenshotSelector failed: {e}")
            QMessageBox.critical(self, "Error", f"An unexpected error occurred: {e}")
            self.reject()
            return
        
        # Center the dialog
        self._center_window()
    
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
            
            # The rest of your logic remains the same
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
        
        # Create grid layout
        grid_widget = QWidget()
        grid_layout = QGridLayout(grid_widget)
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
        
        self.main_layout.addWidget(grid_widget)
    
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
    
    def closeEvent(self, event):
        """Handle window close event"""
        if self.selected_path is None:
            self.reject()
        event.accept()


def show_screenshot_selector(parent, video_path, timestamp, mode='beginning', on_complete=None):
    """
    Show the screenshot selector dialog and return the selected path.
    
    Args:
        parent: Config application reference
        video_path: Path to the video file
        timestamp: Timestamp to extract frames from
        mode: 'beginning', 'middle', or 'end'
        on_complete: Callback function that receives the selected path
    
    Returns:
        The selected screenshot path, or None if cancelled
    """
    # Create QApplication if it doesn't exist
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    
    dialog = ScreenshotSelectorDialog(parent, video_path, timestamp, mode)
    result = dialog.exec()
    
    selected_path = dialog.selected_path if result == QDialog.DialogCode.Accepted else None
    
    if on_complete:
        on_complete(selected_path)
    
    return selected_path


if __name__ == "__main__":
    # Test the dialog
    app = QApplication(sys.argv)
    
    # You'll need a real video file to test
    # For now, this is just a placeholder
    video_path = r"C:\Users\Beangate\Videos\GSM\Replay 2025-11-06 17-46-52.mp4"
    
    if os.path.exists(video_path):
        result = show_screenshot_selector(
            parent=None,
            video_path=video_path,
            timestamp=10.0,
            mode='middle'
        )
        
        print(f"Selected screenshot: {result}")
    else:
        print(f"Test video not found at: {video_path}")
        print("Please update the video_path in __main__ to test.")
