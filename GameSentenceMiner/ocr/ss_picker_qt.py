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
    def __init__(self, captured_image, monitor_geometry, main_monitor, on_complete=None):
        super().__init__()
        self.captured_image = captured_image
        self.monitor_geometry = monitor_geometry
        self.main_monitor = main_monitor
        self.on_complete = on_complete
        self.result = None
        
        self.start_pos = None
        self.current_pos = None
        self.is_drawing = False
        
        # Convert PIL Image to QPixmap
        img_data = self.captured_image.tobytes('raw', 'RGB')
        qimage = QImage(img_data, self.captured_image.width, self.captured_image.height, 
                       self.captured_image.width * 3, QImage.Format.Format_RGB888)
        self.pixmap = QPixmap.fromImage(qimage)
        
        self.init_ui()
    
    def init_ui(self):
        # Set window properties
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | 
                           Qt.WindowType.WindowStaysOnTopHint |
                           Qt.WindowType.Tool |
                           Qt.WindowType.BypassWindowManagerHint)
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
                # Crop the image
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


def show_screen_cropper(on_complete=None):
    """
    Displays a Qt-based screen cropper that allows the user to select a region.
    
    Args:
        on_complete: Callback function that receives the cropped PIL Image or None
    
    Returns:
        The ScreenCropperWidget instance.
    """
    try:
        # Capture all monitors
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
            
            img_bytes = mss.tools.to_png(sct_grab.rgb, sct_grab.size)
            captured_image = Image.open(io.BytesIO(img_bytes))
            
            # Convert to RGB if needed
            if captured_image.mode == 'RGBA':
                rgb_image = Image.new('RGB', captured_image.size, (255, 255, 255))
                rgb_image.paste(captured_image, mask=captured_image.split()[3])
                captured_image = rgb_image
            
            logger.info(f"Screen captured: {monitor_geometry['width']}x{monitor_geometry['height']}")
    except Exception as e:
        logger.error(f"Error capturing screen: {e}")
        if on_complete:
            on_complete(None)
        return
    
    # Create QApplication if it doesn't exist
    app = QApplication.instance()
    created_app = False
    if app is None:
        app = QApplication(sys.argv)
        created_app = True
    
    # Create and show the cropper widget
    cropper = ScreenCropperWidget(captured_image, monitor_geometry, main_monitor, on_complete)
    
    # Run the application if we created it
    if created_app:
        app.exec()
        
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

