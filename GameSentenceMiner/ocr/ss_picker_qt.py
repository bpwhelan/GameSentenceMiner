import io
import logging
from PIL import Image
import mss
import mss.tools
from PyQt6.QtWidgets import QApplication, QWidget
from PyQt6.QtCore import Qt, QRect
from PyQt6.QtGui import QPainter, QPen, QColor, QPixmap, QImage
import sys

logger = logging.getLogger("GSM_OCR")


class ScreenCropperWidget(QWidget):
    def __init__(self, captured_image, monitor_geometry, main_monitor, on_complete=None, transparent_mode=False):
        super().__init__()
        self.captured_image = captured_image
        self.monitor_geometry = monitor_geometry
        self.main_monitor = main_monitor
        self.on_complete = on_complete
        self.transparent_mode = transparent_mode
        self.result = None
        
        self.start_pos = None
        self.current_pos = None
        self.is_drawing = False
        
        if not transparent_mode:
            # Convert PIL Image to QPixmap
            img_data = self.captured_image.tobytes('raw', 'RGB')
            qimage = QImage(img_data, self.captured_image.width, self.captured_image.height, 
                           self.captured_image.width * 3, QImage.Format.Format_RGB888)
            self.pixmap = QPixmap.fromImage(qimage)
        else:
            self.pixmap = None
        
        self.init_ui()
    
    def init_ui(self):
        # Set window properties
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | 
                           Qt.WindowType.WindowStaysOnTopHint |
                           Qt.WindowType.Tool)
        
        if self.transparent_mode:
            # Make the window semi-transparent so user can see through
            self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        else:
            self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, False)
        
        # Set geometry to cover all monitors - use move and resize to ensure it works
        self.move(self.monitor_geometry['left'], self.monitor_geometry['top'])
        self.resize(self.monitor_geometry['width'], self.monitor_geometry['height'])
        
        # Set cursor
        self.setCursor(Qt.CursorShape.CrossCursor)
        
        # Show the window
        self.show()
        self.activateWindow()
        self.raise_()
    
    def paintEvent(self, event):
        painter = QPainter(self)
        
        if self.transparent_mode:
            # In transparent mode, draw a semi-transparent dark overlay
            painter.fillRect(self.rect(), QColor(0, 0, 0, 80))
            
            # Draw the selection rectangle if user is selecting
            if self.start_pos and self.current_pos:
                x1 = min(self.start_pos.x(), self.current_pos.x())
                y1 = min(self.start_pos.y(), self.current_pos.y())
                x2 = max(self.start_pos.x(), self.current_pos.x())
                y2 = max(self.start_pos.y(), self.current_pos.y())
                
                selection_rect = QRect(x1, y1, x2 - x1, y2 - y1)
                
                # Clear the dark overlay in selection area so user can see through
                painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_Clear)
                painter.fillRect(selection_rect, Qt.GlobalColor.transparent)
                painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
                
                # Draw red border around selection
                pen = QPen(QColor(255, 0, 0), 3)
                painter.setPen(pen)
                painter.drawRect(selection_rect)
        else:
            # Original mode with screenshot background
            # Draw the screenshot
            painter.drawPixmap(0, 0, self.pixmap)
            
            # Draw semi-transparent overlay
            painter.fillRect(self.rect(), QColor(0, 0, 0, 128))
            
            # If we're drawing a selection, clear that area and draw border
            if self.start_pos and self.current_pos:
                x1 = min(self.start_pos.x(), self.current_pos.x())
                y1 = min(self.start_pos.y(), self.current_pos.y())
                x2 = max(self.start_pos.x(), self.current_pos.x())
                y2 = max(self.start_pos.y(), self.current_pos.y())
                
                selection_rect = QRect(x1, y1, x2 - x1, y2 - y1)
                
                # Clear the overlay in selection area
                painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_Clear)
                painter.fillRect(selection_rect, Qt.GlobalColor.transparent)
                painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
                
                # Draw the screenshot in selection area (without overlay)
                painter.drawPixmap(selection_rect, self.pixmap, selection_rect)
                
                # Draw red border
                pen = QPen(QColor(255, 0, 0), 3)
                painter.setPen(pen)
                painter.drawRect(selection_rect)
    
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.start_pos = event.pos()
            self.current_pos = event.pos()
            self.is_drawing = True
            self.update()
    
    def mouseMoveEvent(self, event):
        if self.is_drawing:
            self.current_pos = event.pos()
            self.update()
    
    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.is_drawing:
            self.is_drawing = False
            self.current_pos = event.pos()
            
            x1 = min(self.start_pos.x(), self.current_pos.x())
            y1 = min(self.start_pos.y(), self.current_pos.y())
            x2 = max(self.start_pos.x(), self.current_pos.x())
            y2 = max(self.start_pos.y(), self.current_pos.y())
            
            if (x2 - x1) > 0 and (y2 - y1) > 0:
                if self.transparent_mode:
                    # In transparent mode, take a fresh screenshot of the selected area
                    try:
                        with mss.mss() as sct:
                            # Convert widget coordinates to screen coordinates
                            monitor_region = {
                                "left": self.monitor_geometry['left'] + x1,
                                "top": self.monitor_geometry['top'] + y1,
                                "width": x2 - x1,
                                "height": y2 - y1
                            }
                            sct_grab = sct.grab(monitor_region)
                            # Convert to PIL Image
                            self.result = Image.frombytes('RGB', sct_grab.size, sct_grab.bgra, 'raw', 'BGRX')
                            logger.info(f"Fresh screenshot captured: ({monitor_region['left']}, {monitor_region['top']}) size {monitor_region['width']}x{monitor_region['height']}")
                    except Exception as e:
                        logger.error(f"Error capturing fresh screenshot: {e}")
                        self.result = None
                else:
                    # Original mode: crop from the already-captured image
                    self.result = self.captured_image.crop((x1, y1, x2, y2))
                    logger.info(f"Selection made: ({x1}, {y1}) to ({x2}, {y2})")
                self.close()
            else:
                logger.warning("Selection area too small")
                self.start_pos = None
                self.current_pos = None
                self.update()
    
    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Escape:
            logger.info("Screen cropper cancelled")
            self.result = None
            self.close()
        elif event.key() == Qt.Key.Key_Return or event.key() == Qt.Key.Key_Enter:
            # Grab main monitor area
            self.result = self.captured_image.crop((
                self.main_monitor['left'],
                self.main_monitor['top'],
                self.main_monitor['left'] + self.main_monitor['width'],
                self.main_monitor['top'] + self.main_monitor['height']
            ))
            logger.info("Main monitor area selected")
            self.close()
    
    def closeEvent(self, event):
        if self.on_complete:
            self.on_complete(self.result)
        event.accept()


def show_screen_cropper(on_complete=None, transparent_mode=False):
    """
    Displays a Qt-based screen cropper that allows the user to select a region.
    
    Args:
        on_complete: Callback function that receives the cropped PIL Image or None
        transparent_mode: If True, shows a transparent overlay and captures a fresh screenshot
                         of the selected area. If False, uses a frozen screenshot.
    
    Returns:
        The ScreenCropperWidget instance.
    """
    if not transparent_mode:
        # Original mode: capture screen first
        try:
            # Capture all monitors - optimized for speed
            with mss.mss() as sct:
                all_monitors_bbox = sct.monitors[0]
                main_monitor = sct.monitors[1]
                monitor_geometry = {
                    'left': all_monitors_bbox['left'],
                    'top': all_monitors_bbox['top'],
                    'width': all_monitors_bbox['width'],
                    'height': all_monitors_bbox['height']
                }
                sct_grab = sct.grab(all_monitors_bbox)
                
                # Convert directly from raw bytes to PIL Image (faster than to_png)
                # MSS returns BGRA format, convert to RGB
                captured_image = Image.frombytes('RGB', sct_grab.size, sct_grab.bgra, 'raw', 'BGRX')
                
                logger.info(f"Screen captured: {monitor_geometry['width']}x{monitor_geometry['height']}")
        except Exception as e:
            logger.error(f"Error capturing screen: {e}")
            if on_complete:
                on_complete(None)
            return
    else:
        # Transparent mode: just get monitor geometry, no screenshot needed yet
        try:
            with mss.mss() as sct:
                all_monitors_bbox = sct.monitors[0]
                main_monitor = sct.monitors[1]
                monitor_geometry = {
                    'left': all_monitors_bbox['left'],
                    'top': all_monitors_bbox['top'],
                    'width': all_monitors_bbox['width'],
                    'height': all_monitors_bbox['height']
                }
                captured_image = None  # No pre-captured image in transparent mode
                logger.info(f"Transparent mode: monitor geometry {monitor_geometry['width']}x{monitor_geometry['height']}")
        except Exception as e:
            logger.error(f"Error getting monitor geometry: {e}")
            if on_complete:
                on_complete(None)
            return
    
    # Create QApplication if it doesn't exist
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    
    # Create and show the cropper widget
    cropper = ScreenCropperWidget(captured_image, monitor_geometry, main_monitor, on_complete, transparent_mode)
    
    # Keep the widget alive by entering event loop until it's closed
    # This is necessary when called from dialog manager
    if on_complete:
        # Store the widget reference to keep it alive
        cropper.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        # Process events until the widget is destroyed
        while cropper.isVisible():
            app.processEvents()
        
    return cropper


# For backwards compatibility
class ScreenCropper:
    """Compatibility wrapper for synchronous usage (deprecated)"""
    def __init__(self):
        self.result = None
    
    def run(self, return_main_monitor=False):
        """
        Run the screen cropper and return the cropped image.
        Note: This is a synchronous wrapper.
        Use show_screen_cropper() with callback for better integration.
        """
        logger.warning("ScreenCropper.run() is deprecated. Use show_screen_cropper() with callback instead.")
        
        def on_complete(cropped_image):
            self.result = cropped_image
        
        show_screen_cropper(on_complete)
        return self.result


if __name__ == "__main__":
    def test_callback(cropped_img):
        if cropped_img:
            print("Image cropped successfully. Displaying cropped image...")
            cropped_img.show()
        else:
            print("No image was cropped.")
    
    show_screen_cropper(on_complete=test_callback)

