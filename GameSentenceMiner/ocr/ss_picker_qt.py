import ctypes
import ctypes.wintypes
import logging
import sys
import time

import mss
from PIL import Image
from PyQt6.QtCore import QEvent, QEventLoop, QPoint, QRect, Qt, QTimer
from PyQt6.QtGui import QColor, QCursor, QImage, QPainter, QPen, QPixmap
from PyQt6.QtWidgets import QApplication, QWidget

from GameSentenceMiner.ocr.coordinate_math import logical_box_to_even_physical_box

# Import Window State Manager
from GameSentenceMiner.ui import WindowId, window_state_manager

logger = logging.getLogger("GSM_OCR")


SESSION_TIMEOUT_MS = 60_000
ACTIVATION_GRACE_SECONDS = 1.0


def _notify_complete(callback, result):
    if callback is not None:
        try:
            callback(result)
        except Exception:
            logger.exception("Screen cropper completion callback failed")


def create_high_visibility_crosshair_cursor() -> QCursor:
    """Return a crosshair that stays visible over light and dark screenshots."""
    size = 33
    center = size // 2
    gap = 4
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)

    segments = (
        (QPoint(2, center), QPoint(center - gap, center)),
        (QPoint(center + gap, center), QPoint(size - 3, center)),
        (QPoint(center, 2), QPoint(center, center - gap)),
        (QPoint(center, center + gap), QPoint(center, size - 3)),
    )
    painter = QPainter(pixmap)
    painter.setPen(QPen(QColor("#000000"), 5, Qt.PenStyle.SolidLine, Qt.PenCapStyle.FlatCap))
    for start, end in segments:
        painter.drawLine(start, end)
    painter.setPen(QPen(QColor("#00e5ff"), 2, Qt.PenStyle.SolidLine, Qt.PenCapStyle.FlatCap))
    for start, end in segments:
        painter.drawLine(start, end)
    painter.end()

    return QCursor(pixmap, center, center)


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
            except Exception as e:  # noqa: BLE001 - Never let a DPI probe failure escape a native callback.
                logger.warning(f"Failed to get DPI for monitor: {e}")
                monitors_dpi[len(monitors_dpi)] = 1.0
            return True

        # Define callback type
        MonitorEnumProc = ctypes.WINFUNCTYPE(
            ctypes.c_bool,
            ctypes.wintypes.HMONITOR,
            ctypes.wintypes.HDC,
            ctypes.POINTER(ctypes.wintypes.RECT),
            ctypes.wintypes.LPARAM,
        )

        # Enumerate monitors
        user32.EnumDisplayMonitors(None, None, MonitorEnumProc(callback), 0)

        return monitors_dpi
    except Exception as e:  # noqa: BLE001 - DPI discovery is best effort; capture can use the default scale.
        logger.warning(f"Failed to get monitor DPI scaling: {e}. Using 1.0")
        return {}


# Global instance
_screen_cropper_instance = None


class ScreenCropperWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Tool)

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
        self._session_active = False
        self._activation_deadline = 0.0
        self._session_timeout = QTimer(self)
        self._session_timeout.setSingleShot(True)
        self._session_timeout.setInterval(SESSION_TIMEOUT_MS)
        self._session_timeout.timeout.connect(lambda: self._cancel("selection timed out"))
        self._safety_timer = QTimer(self)
        self._safety_timer.setInterval(250)
        self._safety_timer.timeout.connect(self._check_session)
        self._focus_loss_timer = QTimer(self)
        self._focus_loss_timer.setSingleShot(True)
        self._focus_loss_timer.setInterval(50)
        self._focus_loss_timer.timeout.connect(self._cancel_if_unfocused)
        app = QApplication.instance()
        app.applicationStateChanged.connect(self._application_state_changed)
        app.aboutToQuit.connect(lambda: self._cancel("application is shutting down"))
        app.screenRemoved.connect(lambda screen: self._cancel("screen configuration changed"))
        app.screenAdded.connect(lambda screen: self._cancel("screen configuration changed"))

        # Drawing state
        self.start_pos = None
        self.current_pos = None
        self.is_drawing = False

        self.setCursor(create_high_visibility_crosshair_cursor())
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    def prepare_capture(
        self,
        captured_image,
        monitor_geometry,
        main_monitor,
        on_complete=None,
        transparent_mode=False,
        dpi_scale=1.0,
    ):
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
        if self._session_active:
            logger.info("Ignoring another screen cropper request while selection is active")
            _notify_complete(on_complete, None)
            return

        self._session_active = True
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
        logical_left = int(self.monitor_geometry["left"] / dpi_scale)
        logical_top = int(self.monitor_geometry["top"] / dpi_scale)
        logical_width = int(self.monitor_geometry["width"] / dpi_scale)
        logical_height = int(self.monitor_geometry["height"] / dpi_scale)

        if not self.transparent_mode and self.captured_image:
            # Keep the image at full physical resolution for best quality
            # Qt will handle the scaling automatically via devicePixelRatio
            img_data = self.captured_image.tobytes("raw", "RGB")
            qimage = QImage(
                img_data,
                self.captured_image.width,
                self.captured_image.height,
                self.captured_image.width * 3,
                QImage.Format.Format_RGB888,
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

        logger.info(
            f"Widget positioned at logical ({logical_left}, {logical_top}) "
            f"size {logical_width}x{logical_height}, DPI scale: {dpi_scale:.2f}"
        )

        self._activation_deadline = time.monotonic() + ACTIVATION_GRACE_SECONDS
        self._session_timeout.start()
        self._safety_timer.start()
        self.show()
        self.activateWindow()
        self.raise_()
        self.setFocus()
        # Qt automatically captures the mouse for a drag. Explicit mouse/keyboard
        # grabs survive focus changes and can leave the desktop apparently frozen.
        self.update()

    def event(self, event):
        if getattr(self, "_session_active", False):
            if event.type() == QEvent.Type.WindowDeactivate:
                self._focus_loss_timer.start()
            elif event.type() == QEvent.Type.WindowActivate:
                self._focus_loss_timer.stop()
            elif event.type() == QEvent.Type.WindowStateChange and self.isMinimized():
                self._cancel("picker was minimized")
        return super().event(event)

    def hideEvent(self, event):
        self._cancel("picker was hidden")
        super().hideEvent(event)

    def _application_state_changed(self, state):
        if self._session_active and state != Qt.ApplicationState.ApplicationActive:
            self._focus_loss_timer.start()

    def _cancel_if_unfocused(self):
        # Windows can deliver the old window's deactivation after its callback
        # has reopened this widget. Check the settled focus before cancelling.
        if not self.isActiveWindow() or QApplication.applicationState() != Qt.ApplicationState.ApplicationActive:
            self._cancel("picker lost focus")

    def _check_session(self):
        if not self._session_active:
            return
        if not self.isVisible() or self.isMinimized():
            self._cancel("picker is no longer visible")
        elif time.monotonic() >= self._activation_deadline and (
            not self.isActiveWindow() or QApplication.applicationState() != Qt.ApplicationState.ApplicationActive
        ):
            # Also handles a denied activation or a missed native deactivation event.
            self._cancel("picker could not keep focus")
        elif self.is_drawing and not (QApplication.mouseButtons() & Qt.MouseButton.LeftButton):
            # A window switch can swallow the mouse release. Allow a fresh drag.
            self._reset_selection()

    def _reset_selection(self):
        self.is_drawing = False
        self.start_pos = None
        self.current_pos = None
        self._release_input()
        self.update()

    def _cancel(self, reason):
        if self._session_active:
            logger.info("Screen cropper cancelled: %s", reason)
            self.result = None
            self._finish()

    def _attach_result_metadata(
        self,
        image,
        selection_left: int,
        selection_top: int,
        selection_width: int,
        selection_height: int,
    ):
        if image is None or not self.monitor_geometry:
            return
        metadata = {
            "virtual_left": int(self.monitor_geometry.get("left", 0)),
            "virtual_top": int(self.monitor_geometry.get("top", 0)),
            "virtual_width": int(self.monitor_geometry.get("width", 0)),
            "virtual_height": int(self.monitor_geometry.get("height", 0)),
            "selection_left": int(selection_left),
            "selection_top": int(selection_top),
            "selection_width": int(selection_width),
            "selection_height": int(selection_height),
            "transparent_mode": bool(self.transparent_mode),
        }
        try:
            image._gsm_screen_crop_metadata = metadata
        except (AttributeError, TypeError) as e:
            logger.debug(f"Failed to attach crop metadata to image: {e}")

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
        if self._session_active and event.button() == Qt.MouseButton.LeftButton:
            self.start_pos = event.pos()
            self.current_pos = event.pos()
            self.is_drawing = True
            self.update()

    def mouseMoveEvent(self, event):
        if self.is_drawing:
            self.current_pos = event.pos()
            self.update()

    def mouseReleaseEvent(self, event):
        if self._session_active and event.button() == Qt.MouseButton.LeftButton and self.is_drawing:
            self.is_drawing = False
            self.current_pos = event.pos()

            x1 = min(self.start_pos.x(), self.current_pos.x())
            y1 = min(self.start_pos.y(), self.current_pos.y())
            x2 = max(self.start_pos.x(), self.current_pos.x())
            y2 = max(self.start_pos.y(), self.current_pos.y())

            if x2 <= x1 or y2 <= y1:
                logger.warning("Selection area too small")
                self._reset_selection()
                return
            try:
                self._capture_selection(x1, y1, x2, y2)
            except Exception:
                logger.exception("Screen cropper selection failed")
                self._cancel("selection failed")

    def _capture_selection(self, x1, y1, x2, y2):
        physical_x1, physical_y1, physical_x2, physical_y2 = logical_box_to_even_physical_box(
            x1,
            y1,
            x2,
            y2,
            scale=self.physical_to_logical_scale,
            max_width=int(self.monitor_geometry["width"]),
            max_height=int(self.monitor_geometry["height"]),
        )
        if physical_x2 <= physical_x1 or physical_y2 <= physical_y1:
            logger.warning("Selection area too small after even-coordinate alignment")
            self._reset_selection()
            return

        region = {
            "left": self.monitor_geometry["left"] + physical_x1,
            "top": self.monitor_geometry["top"] + physical_y1,
            "width": physical_x2 - physical_x1,
            "height": physical_y2 - physical_y1,
        }
        if self.transparent_mode:
            with mss.mss() as sct:
                grab = sct.grab(region)
                self.result = Image.frombytes("RGB", grab.size, grab.bgra, "raw", "BGRX")
        else:
            self.result = self.captured_image.crop((physical_x1, physical_y1, physical_x2, physical_y2))
        self._attach_result_metadata(self.result, region["left"], region["top"], region["width"], region["height"])
        logger.info("Screen cropper selected region: %s", region)
        self._finish()

    def keyPressEvent(self, event):
        if not self._session_active:
            return
        if event.key() == Qt.Key.Key_Escape:
            self._cancel("Escape pressed")
        elif event.key() == Qt.Key.Key_Return or event.key() == Qt.Key.Key_Enter:
            try:
                self._select_main_monitor()
            except Exception:
                logger.exception("Screen cropper main monitor selection failed")
                self._cancel("main monitor selection failed")

    def _select_main_monitor(self):
        # Grab main monitor area
        # Convert main monitor coords from physical to logical for cropping
        if self.captured_image:
            # Main monitor coordinates are in physical pixels
            main_left = self.main_monitor["left"] - self.monitor_geometry["left"]
            main_top = self.main_monitor["top"] - self.monitor_geometry["top"]
            main_right = main_left + self.main_monitor["width"]
            main_bottom = main_top + self.main_monitor["height"]

            main_left, main_top, main_right, main_bottom = logical_box_to_even_physical_box(
                main_left,
                main_top,
                main_right,
                main_bottom,
                scale=1.0,
                max_width=int(self.captured_image.width),
                max_height=int(self.captured_image.height),
            )

            self.result = self.captured_image.crop((main_left, main_top, main_right, main_bottom))
            self._attach_result_metadata(
                self.result,
                self.monitor_geometry["left"] + main_left,
                self.monitor_geometry["top"] + main_top,
                main_right - main_left,
                main_bottom - main_top,
            )
        logger.info("Main monitor area selected")
        self._finish()

    def _finish(self):
        """End each session once, releasing the desktop before waking its caller."""
        if not self._session_active:
            return
        self._session_active = False
        callback, self.on_complete = self.on_complete, None
        result = self.result
        self._session_timeout.stop()
        self._safety_timer.stop()
        self._focus_loss_timer.stop()
        self.is_drawing = False
        self.start_pos = None
        self.current_pos = None
        self._release_input()
        self.hide()
        self.captured_image = None
        self.pixmap = None
        try:
            window_state_manager.save_geometry(self, WindowId.SCREEN_CROPPER)
        except Exception:
            logger.exception("Could not save screen cropper geometry")
        # The callback may open the picker again. Do no session cleanup after it.
        _notify_complete(callback, result)

    def closeEvent(self, event):
        self._cancel("picker was closed")
        event.accept()

    def _release_input(self):
        # Check Qt's actual owners, including its implicit grab during a drag.
        for grabber, release in (
            (QWidget.mouseGrabber, self.releaseMouse),
            (QWidget.keyboardGrabber, self.releaseKeyboard),
        ):
            try:
                if grabber() is self:
                    release()
            except Exception:
                logger.exception("Failed to release screen cropper input")


def show_screen_cropper(on_complete=None, transparent_mode=False):
    """
    Displays a Qt-based screen cropper that allows the user to select a region.
    Reuses the existing widget instance.
    Properly handles Windows DPI scaling.
    """
    global _screen_cropper_instance

    if _screen_cropper_instance is not None and _screen_cropper_instance._session_active:
        # Never replace an active caller's callback (or capture the overlay itself).
        logger.info("Ignoring another screen cropper request while selection is active")
        _notify_complete(on_complete, None)
        return _screen_cropper_instance

    # Create QApplication if it doesn't exist
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)

    # Create Singleton if needed
    if _screen_cropper_instance is None:
        _screen_cropper_instance = ScreenCropperWidget()

    widget = _screen_cropper_instance
    loop = QEventLoop()
    completed = False

    def complete(result):
        nonlocal completed
        completed = True
        loop.quit()
        _notify_complete(on_complete, result)

    try:
        monitors_dpi = get_monitor_dpi_scale()
        with mss.mss() as sct:
            monitor_geometry = dict(sct.monitors[0])
            main_monitor = dict(sct.monitors[1])
            dpi_scale = monitors_dpi.get(0, 1.0)
            captured_image = None
            if not transparent_mode:
                grab = sct.grab(monitor_geometry)
                captured_image = Image.frombytes("RGB", grab.size, grab.bgra, "raw", "BGRX")

        widget.prepare_capture(captured_image, monitor_geometry, main_monitor, complete, transparent_mode, dpi_scale)
    except Exception:
        logger.exception("Could not prepare screen cropper")
        if widget._session_active:
            widget._cancel("capture setup failed")
        elif not completed:
            complete(None)
        return widget

    # Keep the synchronous API, but sleep in Qt's event loop instead of spinning
    # processEvents(). Completion belongs to this session, not widget visibility:
    # another request may open the singleton again before this call returns.
    if on_complete is not None and not completed:
        loop.exec()

    return widget


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
