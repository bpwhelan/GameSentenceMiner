import ctypes
import ctypes.wintypes
import logging
import mss
import mss.tools
import sys
from PIL import Image
from PyQt6.QtCore import Qt, QRect, QTimer
from PyQt6.QtGui import QPainter, QPen, QColor, QPixmap, QImage
from PyQt6.QtWidgets import QApplication, QWidget

# Import Window State Manager
from GameSentenceMiner.ui import window_state_manager, WindowId

logger = logging.getLogger("GSM_OCR")


# Windows helpers for forcing focus
HWND_TOPMOST = -1
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_SHOWWINDOW = 0x0040
SWP_FLAGS_TOPMOST = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW


def get_monitor_dpi_scale():
    """
    Get DPI scaling information for all monitors.
    Returns a dict mapping monitor index to scale factor.
    """
    if sys.platform != "win32":
        return {}

    try:
        # Get DPI awareness
        user32 = ctypes.windll.user32
        user32.SetProcessDPIAware()
        
        # Enumerate all monitors and their DPI
        monitors_dpi = {}
        
        def callback(hMonitor, hdcMonitor, lprcMonitor, dwData):
            try:
                # Get DPI for this monitor
                shcore = ctypes.windll.shcore
                dpiX = ctypes.c_uint()
                dpiY = ctypes.c_uint()
                
                # MDT_EFFECTIVE_DPI = 0
                shcore.GetDpiForMonitor(hMonitor, 0, ctypes.byref(dpiX), ctypes.byref(dpiY))
                
                # Standard DPI is 96, so scale factor is dpi/96
                scale = dpiX.value / 96.0
                
                # Store by monitor count
                idx = len(monitors_dpi)
                monitors_dpi[idx] = scale
                logger.debug(f"Monitor {idx}: DPI={dpiX.value}, Scale={scale:.2f}")
            except Exception as e:
                logger.warning(f"Failed to get DPI for monitor: {e}")
                monitors_dpi[len(monitors_dpi)] = 1.0
            return True
        
        # Define callback type
        MonitorEnumProc = ctypes.WINFUNCTYPE(
            ctypes.c_bool,
            ctypes.wintypes.HMONITOR,
            ctypes.wintypes.HDC,
            ctypes.POINTER(ctypes.wintypes.RECT),
            ctypes.wintypes.LPARAM
        )
        
        # Enumerate monitors
        user32.EnumDisplayMonitors(None, None, MonitorEnumProc(callback), 0)
        
        return monitors_dpi
    except Exception as e:
        logger.warning(f"Failed to get monitor DPI scaling: {e}. Using 1.0")
        return {}

# Global instance
_screen_cropper_instance = None


class ScreenCropperWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | 
                           Qt.WindowType.WindowStaysOnTopHint |
                           Qt.WindowType.Tool)
        
        # State placeholders
        self.captured_image = None
        self.monitor_geometry = None
        self.main_monitor = None
        self.on_complete = None
        self.transparent_mode = False
        self.result = None
        self.pixmap = None
        
        # DPI scaling factors
        self.dpi_scale_x = 1.0
        self.dpi_scale_y = 1.0
        self.physical_to_logical_scale = 1.0
        self._input_grabbed = False
        
        # Drawing state
        self.start_pos = None
        self.current_pos = None
        self.is_drawing = False

        self.setCursor(Qt.CursorShape.CrossCursor)

    def prepare_capture(self, captured_image, monitor_geometry, main_monitor, 
                       on_complete=None, transparent_mode=False, dpi_scale=1.0):
        """
        Resets the widget state for a new capture session.
        
        Args:
            captured_image: PIL Image captured at physical pixel resolution
            monitor_geometry: Physical pixel coordinates from mss
            main_monitor: Main monitor info from mss
            on_complete: Callback function
            transparent_mode: Whether to use transparent overlay mode
            dpi_scale: DPI scale factor for coordinate conversion
        """
        self.captured_image = captured_image
        self.monitor_geometry = monitor_geometry
        self.main_monitor = main_monitor
        self.on_complete = on_complete
        self.transparent_mode = transparent_mode
        self.result = None
        self.physical_to_logical_scale = dpi_scale
        
        # Reset drawing state
        self.start_pos = None
        self.current_pos = None
        self.is_drawing = False
        
        # Calculate logical coordinates for Qt widget
        # mss gives us physical pixels, Qt uses logical pixels
        logical_left = int(self.monitor_geometry['left'] / dpi_scale)
        logical_top = int(self.monitor_geometry['top'] / dpi_scale)
        logical_width = int(self.monitor_geometry['width'] / dpi_scale)
        logical_height = int(self.monitor_geometry['height'] / dpi_scale)
        
        if not self.transparent_mode and self.captured_image:
            # Keep the image at full physical resolution for best quality
            # Qt will handle the scaling automatically via devicePixelRatio
            img_data = self.captured_image.tobytes('raw', 'RGB')
            qimage = QImage(
                img_data, 
                self.captured_image.width, 
                self.captured_image.height, 
                self.captured_image.width * 3, 
                QImage.Format.Format_RGB888
            )
            self.pixmap = QPixmap.fromImage(qimage)
            # Set device pixel ratio so Qt knows this is a high-DPI image
            self.pixmap.setDevicePixelRatio(dpi_scale)
            logger.debug(f"Pixmap size: {self.pixmap.width()}x{self.pixmap.height()}, DPR: {dpi_scale}")
        else:
            self.pixmap = None
            
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, self.transparent_mode)
        
        # Set widget geometry using logical coordinates
        self.move(logical_left, logical_top)
        self.resize(logical_width, logical_height)
        
        logger.info(f"Widget positioned at logical ({logical_left}, {logical_top}) "
                   f"size {logical_width}x{logical_height}, DPI scale: {dpi_scale:.2f}")
        
        self.show()
        self.activateWindow()
        self.raise_()
        self._force_windows_focus()
        self._grab_input()
        self.update()
        QTimer.singleShot(300, self._force_windows_focus)

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
            if self.pixmap:
                # Scale the drawing to account for device pixel ratio
                # The pixmap has devicePixelRatio set, so it will draw at the correct size
                painter.drawPixmap(0, 0, self.width(), self.height(), self.pixmap)
            
            # If we're drawing a selection, only overlay outside the selection
            if self.start_pos and self.current_pos:
                x1 = min(self.start_pos.x(), self.current_pos.x())
                y1 = min(self.start_pos.y(), self.current_pos.y())
                x2 = max(self.start_pos.x(), self.current_pos.x())
                y2 = max(self.start_pos.y(), self.current_pos.y())
                
                selection_rect = QRect(x1, y1, x2 - x1, y2 - y1)
                
                # Draw overlay everywhere except selection area
                overlay_color = QColor(0, 0, 0, 128)
                
                # Top rectangle
                if y1 > 0:
                    painter.fillRect(0, 0, self.width(), y1, overlay_color)
                # Bottom rectangle
                if y2 < self.height():
                    painter.fillRect(0, y2, self.width(), self.height() - y2, overlay_color)
                # Left rectangle
                if x1 > 0:
                    painter.fillRect(0, y1, x1, y2 - y1, overlay_color)
                # Right rectangle
                if x2 < self.width():
                    painter.fillRect(x2, y1, self.width() - x2, y2 - y1, overlay_color)
                
                # Draw red border
                pen = QPen(QColor(255, 0, 0), 3)
                painter.setPen(pen)
                painter.drawRect(selection_rect)
            else:
                # No selection, draw overlay over everything
                painter.fillRect(self.rect(), QColor(0, 0, 0, 128))
    
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
                    # Convert widget logical coordinates to physical screen coordinates
                    try:
                        with mss.mss() as sct:
                            # Widget coordinates are in logical pixels, need to convert to physical
                            physical_x1 = int(x1 * self.physical_to_logical_scale)
                            physical_y1 = int(y1 * self.physical_to_logical_scale)
                            physical_x2 = int(x2 * self.physical_to_logical_scale)
                            physical_y2 = int(y2 * self.physical_to_logical_scale)
                            
                            monitor_region = {
                                "left": self.monitor_geometry['left'] + physical_x1,
                                "top": self.monitor_geometry['top'] + physical_y1,
                                "width": physical_x2 - physical_x1,
                                "height": physical_y2 - physical_y1
                            }
                            sct_grab = sct.grab(monitor_region)
                            # Convert to PIL Image
                            self.result = Image.frombytes('RGB', sct_grab.size, sct_grab.bgra, 'raw', 'BGRX')
                            logger.info(f"Fresh screenshot captured: ({monitor_region['left']}, {monitor_region['top']}) "
                                      f"size {monitor_region['width']}x{monitor_region['height']} (physical pixels)")
                    except Exception as e:
                        logger.error(f"Error capturing fresh screenshot: {e}")
                        self.result = None
                else:
                    # Original mode: crop from the already-captured image
                    # Widget coordinates are in logical pixels, need to convert to physical for cropping
                    if self.captured_image:
                        physical_x1 = int(x1 * self.physical_to_logical_scale)
                        physical_y1 = int(y1 * self.physical_to_logical_scale)
                        physical_x2 = int(x2 * self.physical_to_logical_scale)
                        physical_y2 = int(y2 * self.physical_to_logical_scale)
                        
                        self.result = self.captured_image.crop((physical_x1, physical_y1, physical_x2, physical_y2))
                        logger.info(f"Selection made: logical ({x1}, {y1}) to ({x2}, {y2}), "
                                  f"physical ({physical_x1}, {physical_y1}) to ({physical_x2}, {physical_y2})")
                
                # Hide instead of close to preserve instance
                self._finish()
            else:
                logger.warning("Selection area too small")
                self.start_pos = None
                self.current_pos = None
                self.update()
    
    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Escape:
            logger.info("Screen cropper cancelled")
            self.result = None
            self._finish()
        elif event.key() == Qt.Key.Key_Return or event.key() == Qt.Key.Key_Enter:
            # Grab main monitor area
            # Convert main monitor coords from physical to logical for cropping
            if self.captured_image:
                # Main monitor coordinates are in physical pixels
                main_left = self.main_monitor['left'] - self.monitor_geometry['left']
                main_top = self.main_monitor['top'] - self.monitor_geometry['top']
                main_right = main_left + self.main_monitor['width']
                main_bottom = main_top + self.main_monitor['height']
                
                self.result = self.captured_image.crop((
                    main_left,
                    main_top,
                    main_right,
                    main_bottom
                ))
            logger.info("Main monitor area selected")
            self._finish()
    
    def _finish(self):
        """Helper to handle closing logic: callback, hide, save geometry"""
        if self.on_complete:
            self.on_complete(self.result)
        
        # Save geometry (though mostly relevant for resizing, less so for fullscreen tools)
        window_state_manager.save_geometry(self, WindowId.SCREEN_CROPPER)
        self._release_input()
        self.hide()

    def closeEvent(self, event):
        """Handle actual window closing (if forced)"""
        if self.on_complete:
            self.on_complete(self.result)
        window_state_manager.save_geometry(self, WindowId.SCREEN_CROPPER)
        self._release_input()
        event.accept()

    def _force_windows_focus(self):
        if sys.platform != "win32":
            return
        try:
            hwnd = int(self.winId())
            user32 = ctypes.windll.user32
            user32.ReleaseCapture()
            user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_FLAGS_TOPMOST)
            user32.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(hwnd)
            user32.SetActiveWindow(hwnd)
            user32.SetFocus(hwnd)
        except Exception as e:
            logger.debug(f"Failed to force focus via Win32: {e}")

    def _grab_input(self):
        if self._input_grabbed:
            return
        try:
            self.grabKeyboard()
            self.grabMouse()
        except Exception as e:
            logger.debug(f"Failed to grab input: {e}")
        else:
            self._input_grabbed = True

    def _release_input(self):
        if not self._input_grabbed:
            return
        try:
            self.releaseKeyboard()
            self.releaseMouse()
        except Exception as e:
            logger.debug(f"Failed to release input grab: {e}")
        finally:
            self._input_grabbed = False


def show_screen_cropper(on_complete=None, transparent_mode=False):
    """
    Displays a Qt-based screen cropper that allows the user to select a region.
    Reuses the existing widget instance.
    Properly handles Windows DPI scaling.
    """
    global _screen_cropper_instance

    # Get DPI scaling information for all monitors
    monitors_dpi = get_monitor_dpi_scale()
    
    if not transparent_mode:
        # Original mode: capture screen first
        try:
            # Capture all monitors - optimized for speed
            with mss.mss() as sct:
                all_monitors_bbox = sct.monitors[0]
                main_monitor = sct.monitors[1]
                
                # Determine DPI scale - use primary monitor's scale
                # mss monitor indices start at 1 for actual monitors
                dpi_scale = monitors_dpi.get(0, 1.0)  # Monitor 0 in our enum is monitor 1 in mss
                
                monitor_geometry = {
                    'left': all_monitors_bbox['left'],
                    'top': all_monitors_bbox['top'],
                    'width': all_monitors_bbox['width'],
                    'height': all_monitors_bbox['height']
                }
                
                # mss captures at physical pixel resolution
                sct_grab = sct.grab(all_monitors_bbox)
                
                # Convert directly from raw bytes to PIL Image (faster than to_png)
                # MSS returns BGRA format, convert to RGB
                captured_image = Image.frombytes('RGB', sct_grab.size, sct_grab.bgra, 'raw', 'BGRX')
                
                logger.info(f"Screen captured: {monitor_geometry['width']}x{monitor_geometry['height']} "
                          f"(physical pixels), DPI scale: {dpi_scale:.2f}")
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
                
                # Determine DPI scale
                dpi_scale = monitors_dpi.get(0, 1.0)
                
                monitor_geometry = {
                    'left': all_monitors_bbox['left'],
                    'top': all_monitors_bbox['top'],
                    'width': all_monitors_bbox['width'],
                    'height': all_monitors_bbox['height']
                }
                captured_image = None
                logger.info(f"Transparent mode: monitor geometry {monitor_geometry['width']}x{monitor_geometry['height']} "
                          f"(physical pixels), DPI scale: {dpi_scale:.2f}")
        except Exception as e:
            logger.error(f"Error getting monitor geometry: {e}")
            if on_complete:
                on_complete(None)
            return
    
    # Create QApplication if it doesn't exist
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    
    # Create Singleton if needed
    if _screen_cropper_instance is None:
        _screen_cropper_instance = ScreenCropperWidget()
        
    # Prepare the widget with the new screenshot data
    _screen_cropper_instance.prepare_capture(
        captured_image, 
        monitor_geometry, 
        main_monitor, 
        on_complete, 
        transparent_mode,
        dpi_scale
    )
    
    # Keep the widget alive by entering event loop until it's hidden
    if on_complete:
        # Since we are not using exec_(), we rely on the main loop. 
        # If this is called from a script without a running loop, processEvents is needed.
        while _screen_cropper_instance.isVisible():
            app.processEvents()
        
    return _screen_cropper_instance


# For backwards compatibility
class ScreenCropper:
    """Compatibility wrapper for synchronous usage (deprecated)"""
    def __init__(self):
        self.result = None
    
    def run(self, return_main_monitor=False):
        """
        Run the screen cropper and return the cropped image.
        Note: This is a synchronous wrapper.
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
    
    print("Testing Screen Cropper...")
    show_screen_cropper(on_complete=test_callback)
