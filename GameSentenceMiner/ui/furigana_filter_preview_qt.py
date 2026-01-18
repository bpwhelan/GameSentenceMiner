import sys
import threading
import regex
from PyQt6.QtWidgets import QApplication, QDialog, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QSlider, QPushButton
from PyQt6.QtCore import Qt, pyqtSignal, QObject
from PyQt6.QtGui import QPixmap, QImage, QPainter, QPen, QColor
from PIL import Image

from GameSentenceMiner import obs
from GameSentenceMiner.util.configuration import logger, get_overlay_config
from GameSentenceMiner.owocr.owocr.ocr import GoogleLens, OneOCR


def get_overlay_screenshot() -> Image.Image:
    """
    Captures a screenshot from the configured overlay monitor using mss.
    
    Returns:
        A PIL Image object of the screenshot from the overlay monitor.
    """
    try:
        import mss
        overlay_config = get_overlay_config()
        monitor_index = overlay_config.monitor_to_capture
        
        with mss.mss() as sct:
            # mss.monitors[0] is all monitors combined, mss.monitors[1] is the first monitor
            # So we need to add 1 to the monitor_index to get the correct monitor
            monitor = sct.monitors[monitor_index + 1]
            screenshot = sct.grab(monitor)
            
            # Convert to PIL Image
            img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")
            logger.info(f"Screenshot captured from monitor {monitor_index + 1} ({img.width}x{img.height})")
            return img
            
    except ImportError:
        logger.error("mss library not found. Please install it to use overlay functionality.")
        raise
    except IndexError:
        logger.error(f"Monitor index {monitor_index + 1} not found. Available monitors: {len(sct.monitors) - 1}")
        raise
    except Exception as e:
        logger.error(f"Failed to capture overlay screenshot: {e}")
        raise


def get_ocr_results_from_image(image_obj: Image.Image) -> tuple:
    """
    This is the function where you will plug in your OCR logic.

    Args:
        image_obj: A PIL Image object of the screenshot (used by your actual OCR call).

    Returns:
        A tuple containing the OCR results from both engines.
    """
    lens = GoogleLens()
    oneocr = OneOCR()
    oneocr_res = oneocr(image_obj, return_dict=True)
    res = lens(image_obj, return_coords=True)
    
    return res[2], oneocr_res[3]


class OCRWorkerSignals(QObject):
    """Signals for OCR worker thread"""
    finished = pyqtSignal(object, object)


class FuriganaFilterCanvas(QWidget):
    """Custom widget to display image and rectangles"""
    def __init__(self, image: Image.Image, parent=None):
        super().__init__(parent)
        self.pil_image = image
        self.rectangles = []
        self.outline_color = QColor('green')
        self.loading = True
        
        # Convert PIL to QPixmap
        if image.mode in ('RGBA', 'LA', 'P'):
            if image.mode == 'P':
                image = image.convert('RGBA')
            rgb_img = Image.new('RGB', image.size, (255, 255, 255))
            rgb_img.paste(image, mask=image.split()[-1] if image.mode == 'RGBA' else None)
            image = rgb_img
        
        img_data = image.tobytes('raw', 'RGB')
        qimage = QImage(img_data, image.width, image.height, image.width * 3, QImage.Format.Format_RGB888)
        self.pixmap = QPixmap.fromImage(qimage)
        
        self.setMinimumSize(image.width, image.height)
        self.setMaximumSize(image.width, image.height)
    
    def set_rectangles(self, rectangles, color):
        """Set rectangles to draw"""
        self.rectangles = rectangles
        self.outline_color = QColor(color)
        self.update()
    
    def set_loading(self, loading):
        """Set loading state"""
        self.loading = loading
        self.update()
    
    def paintEvent(self, event):
        """Paint the canvas"""
        painter = QPainter(self)
        
        # Draw background image
        painter.drawPixmap(0, 0, self.pixmap)
        
        # Draw loading message
        if self.loading:
            painter.save()
            # Draw background box
            painter.fillRect(
                self.width() // 2 - 100, self.height() // 2 - 25,
                200, 50, QColor(0, 0, 0)
            )
            painter.setPen(QPen(QColor(255, 255, 255), 2))
            painter.drawRect(
                self.width() // 2 - 100, self.height() // 2 - 25,
                200, 50
            )
            # Draw text
            painter.setPen(QColor(255, 255, 255))
            painter.drawText(
                self.width() // 2 - 90, self.height() // 2 - 5,
                "Loading OCR data..."
            )
            painter.restore()
        
        # Draw rectangles
        painter.save()
        pen = QPen(self.outline_color, 2)
        painter.setPen(pen)
        for x1, y1, x2, y2 in self.rectangles:
            painter.drawRect(int(x1), int(y1), int(x2 - x1), int(y2 - y1))
        painter.restore()


class FuriganaFilterVisualizer(QDialog):
    def __init__(self, image: Image.Image, current_furigana_sensitivity: int = 0, parent=None):
        super().__init__(parent)
        self.image = image
        self.ocr1_result = None
        self.ocr2_result = None
        self.current_ocr = 1
        self.title_prefix = "Furigana Filter Visualizer"
        self.result_value = None
        
        self.words_data = []
        self.lines_data = []
        
        self.punctuation_regex = regex.compile(r'[\p{P}\p{S}]')
        
        # Set up UI
        self.setWindowTitle(f"{self.title_prefix} - Lens")
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Dialog)
        self.setModal(True)
        
        # Main layout (QDialog doesn't need a central widget)
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        
        # Canvas
        self.canvas = FuriganaFilterCanvas(image)
        main_layout.addWidget(self.canvas)
        
        # Control panel
        control_panel = QWidget()
        control_layout = QHBoxLayout(control_panel)
        control_layout.setContentsMargins(10, 10, 10, 10)
        
        # Label
        control_layout.addWidget(QLabel("Furigana Filter Sensitivity:"))
        
        # Slider
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setMinimum(0)
        self.slider.setMaximum(100)
        self.slider.setValue(current_furigana_sensitivity)
        self.slider.setEnabled(False)
        self.slider.valueChanged.connect(self.update_filter_visualization)
        control_layout.addWidget(self.slider, 1)
        
        # Slider value label
        self.slider_value_label = QLabel(f"{current_furigana_sensitivity} px")
        self.slider_value_label.setMinimumWidth(50)
        control_layout.addWidget(self.slider_value_label)
        
        # Swap button
        self.swap_button = QPushButton("Switch to OneOCR")
        self.swap_button.setEnabled(False)
        self.swap_button.clicked.connect(self.swap_ocr)
        control_layout.addWidget(self.swap_button)
        
        # OK button
        self.ok_button = QPushButton("OK")
        self.ok_button.setEnabled(False)
        self.ok_button.clicked.connect(self.on_ok)
        control_layout.addWidget(self.ok_button)
        
        main_layout.addWidget(control_panel)
        
        # Set fixed size
        self.setFixedSize(self.sizeHint())
        
        # Center window
        self._center_on_screen()
    
    def _center_on_screen(self):
        """Center the window on the screen"""
        screen = QApplication.primaryScreen()
        if screen:
            screen_geometry = screen.geometry()
            window_geometry = self.frameGeometry()
            center_point = screen_geometry.center()
            window_geometry.moveCenter(center_point)
            self.move(window_geometry.topLeft())
    
    def set_title_prefix(self, prefix: str):
        """Set the title prefix and update the current title."""
        self.title_prefix = prefix
        ocr_name = "Lens" if self.current_ocr == 1 else "OneOCR"
        self.setWindowTitle(f"{self.title_prefix} - {ocr_name}")
    
    def update_with_ocr_data(self, ocr1_result, ocr2_result):
        """Called by the background thread to populate the GUI with OCR data."""
        self.ocr1_result = ocr1_result
        self.ocr2_result = ocr2_result
        
        # Remove loading message
        self.canvas.set_loading(False)
        
        if not self.ocr1_result:
            logger.error("OCR processing failed or returned no data.")
            # Still enable OK button to allow closing
            self.ok_button.setEnabled(True)
            return
        
        # Enable controls
        self.slider.setEnabled(True)
        self.ok_button.setEnabled(True)
        if self.ocr2_result:
            self.swap_button.setEnabled(True)
        
        # Process and display initial data
        self.pre_process_word_geometries()
        self.update_filter_visualization(self.slider.value())
    
    def on_ok(self):
        self.accept()
    
    def swap_ocr(self):
        self.current_ocr = 2 if self.current_ocr == 1 else 1
        # Change to oneocr or lens, in title too
        if self.current_ocr == 1:
            self.swap_button.setText("Switch to OneOCR")
            self.setWindowTitle(f"{self.title_prefix} - Lens")
        else:
            self.swap_button.setText("Switch to Lens")
            self.setWindowTitle(f"{self.title_prefix} - OneOCR")
        self.pre_process_word_geometries()
        self.update_filter_visualization(self.slider.value())
    
    def pre_process_word_geometries(self):
        """
        Parses the OCR result structure (supports both original and new JSON formats),
        calculates absolute pixel values, and stores them for high-performance updates.
        """
        img_w, img_h = self.image.size
        logger.info(f"Processing word geometries for image size {img_w}x{img_h}...")
        
        # Select the current OCR result
        ocr_result = self.ocr1_result if self.current_ocr == 1 else self.ocr2_result
        if not ocr_result:
            return
        self.words_data.clear()
        self.lines_data.clear()
        
        # Try to detect the format: oneocr has 'lines' as a top-level key
        if 'lines' in ocr_result:
            for line in ocr_result.get('lines', []):
                for word in line.get('words', []):
                    try:
                        bbox = word['bounding_rect']
                        x1 = bbox['x1']
                        y1 = bbox['y1']
                        x2 = bbox['x3']
                        y2 = bbox['y3']
                        px_w = abs(x2 - x1)
                        px_h = abs(y2 - y1)
                        self.words_data.append({
                            'text': word.get('text', ''),
                            'px_w': px_w,
                            'px_h': px_h,
                            'coords': (x1, y1, x2, y2)
                        })
                    except Exception as e:
                        logger.warning(f"Skipping malformed word data (new format): {e}. Data: {word}")
                        continue
                try:
                    bbox = line['bounding_rect']
                    x1 = bbox['x1']
                    y1 = bbox['y1']
                    x2 = bbox['x3']
                    y2 = bbox['y3']
                    px_w = abs(x2 - x1)
                    px_h = abs(y2 - y1)
                    self.lines_data.append({
                        'text': line.get('text', ''),
                        'px_w': px_w,
                        'px_h': px_h,
                        'coords': (x1, y1, x2, y2)
                    })
                except Exception as e:
                    logger.warning(f"Skipping malformed line data (new format): {e}. Data: {line}")
                    continue
        else:
            # Lens format (nested paragraphs/lines/words)
            text_layout = ocr_result.get('objects_response', {}).get('text', {}).get('text_layout', {})
            if not text_layout:
                logger.error("Could not find 'text_layout' in the OCR response.")
                return
            for paragraph in text_layout.get('paragraphs', []):
                for line in paragraph.get('lines', []):
                    for word in line.get('words', []):
                        try:
                            bbox_pct = word['geometry']['bounding_box']
                            width_pct = bbox_pct['width']
                            height_pct = bbox_pct['height']
                            top_left_x_pct = bbox_pct['center_x'] - (width_pct / 2)
                            top_left_y_pct = bbox_pct['center_y'] - (height_pct / 2)
                            px_w = width_pct * img_w
                            px_h = height_pct * img_h
                            x1 = top_left_x_pct * img_w
                            y1 = top_left_y_pct * img_h
                            x2 = x1 + px_w
                            y2 = y1 + px_h
                            self.words_data.append({
                                'text': word.get('plain_text', ''),
                                'px_w': px_w,
                                'px_h': px_h,
                                'coords': (x1, y1, x2, y2)
                            })
                        except (KeyError, TypeError) as e:
                            logger.warning(f"Skipping malformed word data (orig format): {e}. Data: {word}")
                            continue
                    try:
                        line_bbox = line['geometry']['bounding_box']
                        width_pct = line_bbox['width']
                        height_pct = line_bbox['height']
                        top_left_x_pct = line_bbox['center_x'] - (width_pct / 2)
                        top_left_y_pct = line_bbox['center_y'] - (height_pct / 2)
                        px_w = width_pct * img_w
                        px_h = height_pct * img_h
                        x1 = top_left_x_pct * img_w
                        y1 = top_left_y_pct * img_h
                        x2 = x1 + px_w
                        y2 = y1 + px_h
                        self.lines_data.append({
                            'text': ''.join([w.get('plain_text', '') for w in line.get('words', [])]),
                            'px_w': px_w,
                            'px_h': px_h,
                            'coords': (x1, y1, x2, y2)
                        })
                    except (KeyError, TypeError) as e:
                        logger.warning(f"Skipping malformed line data (orig format): {e}. Data: {line}")
                        continue
        logger.info(f"Successfully pre-processed {len(self.lines_data)} lines.")
    
    def update_filter_visualization(self, slider_value):
        """
        Called on every slider move. Clears old rectangles and draws new ones
        for words that pass the sensitivity filter.
        """
        sensitivity = float(slider_value)
        self.slider_value_label.setText(f"{sensitivity:.0f} px")
        
        rectangles = []
        
        # Set color based on current OCR: green for Lens (OCR 1), blue for OneOCR (OCR 2)
        outline_color = 'green' if self.current_ocr == 1 else 'blue'
        
        for line_data in self.lines_data:
            if line_data['px_w'] > sensitivity and line_data['px_h'] > sensitivity:
                rectangles.append(line_data['coords'])
        
        self.canvas.set_rectangles(rectangles, outline_color)


def scale_down_width_height(width, height):
    if width == 0 or height == 0:
        return width, height
    aspect_ratio = width / height
    if aspect_ratio > 2.66:
        # Ultra-wide (32:9) - use 1920x540
        return 1920, 540
    elif aspect_ratio > 2.33:
        # 21:9 - use 1920x800
        return 1920, 800
    elif aspect_ratio > 1.77:
        # 16:9 - use 1280x720
        return 1280, 720
    elif aspect_ratio > 1.6:
        # 16:10 - use 1280x800
        return 1280, 800
    elif aspect_ratio > 1.33:
        # 4:3 - use 960x720
        return 960, 720
    elif aspect_ratio > 1.25:
        # 5:4 - use 900x720
        return 900, 720
    elif aspect_ratio > 1.5:
        # 3:2 - use 1080x720
        return 1080, 720
    else:
        # Default/fallback - use original resolution
        logger.warning(f"Unrecognized aspect ratio {aspect_ratio}. Using original resolution.")
        return width, height


def show_furigana_filter_preview(image: Image.Image = None, current_sensitivity: int = 0, on_complete=None, title_suffix="", for_overlay=False, parent=None):
    """
    Show the furigana filter preview window and return the selected sensitivity.
    
    Args:
        image: PIL Image to analyze (if None, will capture from OBS or overlay based on use_overlay flag)
        current_sensitivity: Initial sensitivity value
        on_complete: Callback function to be called with the result
        title_suffix: Suffix for the window title
        for_overlay: If True and image is None, capture from overlay monitor instead of OBS
        parent: Parent widget for the dialog
    
    Returns:
        The selected sensitivity value or None if cancelled.
    """
    # Get screenshot if not provided
    if image is None:
        if for_overlay:
            logger.info("Using overlay mode - capturing from configured monitor...")
            try:
                screenshot_img = get_overlay_screenshot()
                if not title_suffix:
                    overlay_config = get_overlay_config()
                    monitor_num = overlay_config.monitor_to_capture + 1
                    title_suffix = f"Overlay Monitor {monitor_num}"
            except Exception as e:
                logger.error(f"Failed to get overlay screenshot: {e}")
                return None
        else:
            logger.info("Taking OBS screenshot...")
            screenshot_img = obs.get_screenshot_PIL(compression=90, img_format='jpg')
            title_suffix = obs.get_current_game()
            if not screenshot_img:
                logger.error("Failed to get screenshot from OBS.")
                return None
        
        # Scale down the image for performance
        screenshot_img = screenshot_img.resize(
            scale_down_width_height(screenshot_img.width, screenshot_img.height),
            Image.LANCZOS
        )
        
        source_type = "overlay monitor" if for_overlay else "OBS"
        logger.info(f"Screenshot received from {source_type} ({screenshot_img.width}x{screenshot_img.height}).")
    else:
        screenshot_img = image
    
    # Create dialog
    dialog = FuriganaFilterVisualizer(screenshot_img, current_sensitivity, parent=parent)
    dialog.set_title_prefix(f"Furigana Filter Visualizer - {title_suffix}")
    
    # Set up OCR worker
    signals = OCRWorkerSignals()
    
    def ocr_worker():
        logger.info("Starting OCR process in background thread...")
        try:
            ocr1_data, ocr2_data = get_ocr_results_from_image(screenshot_img)
            signals.finished.emit(ocr1_data, ocr2_data)
        except Exception as e:
            logger.error(f"Error in OCR background thread: {e}")
            signals.finished.emit(None, None)
    
    signals.finished.connect(dialog.update_with_ocr_data)
    threading.Thread(target=ocr_worker, daemon=True).start()
    
    # Show dialog modally (blocks until user closes it)
    result = dialog.exec()
    
    # Get the selected value if accepted
    selected_value = dialog.slider.value() if result == QDialog.DialogCode.Accepted else None
    
    # Call callback if provided
    if on_complete:
        on_complete(selected_value)
    
    return selected_value


def main():
    """Main execution function."""
    # Parse command line arguments
    current_furigana_sensitivity = 0
    use_overlay = False
    
    if len(sys.argv) > 1:
        # Check if any argument is "overlay" or "--overlay"
        args = sys.argv[1:]
        if "overlay" in args or "--overlay" in args:
            use_overlay = True
            # Remove overlay flags and use remaining numeric argument as sensitivity
            numeric_args = [arg for arg in args if arg not in ["overlay", "--overlay"] and arg.isdigit()]
            if numeric_args:
                current_furigana_sensitivity = int(numeric_args[0])
        else:
            # Assume first argument is sensitivity
            try:
                current_furigana_sensitivity = int(args[0])
            except ValueError:
                logger.warning(f"Invalid sensitivity value: {args[0]}. Using default value 0.")
    
    if use_overlay:
        logger.info("Using overlay mode - capturing from configured monitor...")
        try:
            screenshot_img = get_overlay_screenshot()
        except Exception as e:
            logger.error(f"Failed to get overlay screenshot: {e}")
            return
    else:
        try:
            logger.info("Connecting to OBS...")
            obs.connect_to_obs_sync()
        except Exception as e:
            logger.error(f"Failed to connect to OBS. Please ensure OBS is running and the WebSocket server is enabled. Error: {e}")
            return
        
        logger.info("Taking OBS screenshot...")
        screenshot_img = obs.get_screenshot_PIL(compression=90, img_format='jpg')
        
        if not screenshot_img:
            logger.error("Failed to get screenshot from OBS.")
            return
    
    # Scale down the image for performance
    screenshot_img = screenshot_img.resize(
        scale_down_width_height(screenshot_img.width, screenshot_img.height),
        Image.LANCZOS
    )
    
    source_type = "overlay monitor" if use_overlay else "OBS"
    logger.info(f"Screenshot received from {source_type} ({screenshot_img.width}x{screenshot_img.height}).")
    
    _ = QApplication(sys.argv)  # Ensure QApplication exists for standalone usage
    
    dialog = FuriganaFilterVisualizer(screenshot_img, current_furigana_sensitivity)
    
    # Update window title to reflect source
    if use_overlay:
        overlay_config = get_overlay_config()
        monitor_num = overlay_config.monitor_to_capture + 1
        dialog.set_title_prefix(f"Furigana Filter Visualizer - Overlay Monitor {monitor_num}")
    
    # Set up OCR worker
    signals = OCRWorkerSignals()
    
    def ocr_worker():
        logger.info("Starting OCR process in background thread...")
        try:
            ocr1_data, ocr2_data = get_ocr_results_from_image(screenshot_img)
            signals.finished.emit(ocr1_data, ocr2_data)
        except Exception as e:
            logger.error(f"Error in OCR background thread: {e}")
            signals.finished.emit(None, None)
    
    signals.finished.connect(dialog.update_with_ocr_data)
    threading.Thread(target=ocr_worker, daemon=True).start()
    
    # Show dialog and get result
    result = dialog.exec()
    if result == QDialog.DialogCode.Accepted:
        print(f"RESULT:[{dialog.slider.value()}]")
    
    sys.exit(0)


if __name__ == "__main__":
    main()
