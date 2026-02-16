import sys
import threading

try:
    import regex
    from PyQt6.QtWidgets import QApplication, QDialog, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QSlider, QPushButton, QScrollArea, QSizePolicy, QFrame
    from PyQt6.QtCore import Qt, pyqtSignal, QObject
    from PyQt6.QtGui import QPixmap, QImage, QPainter, QPen, QColor
    from PIL import Image

    from GameSentenceMiner import obs
    from GameSentenceMiner.util.config.configuration import logger, get_overlay_config
    from GameSentenceMiner.util.config.electron_config import get_ocr_language
    from GameSentenceMiner.ocr.image_scaling import (
        scale_dimensions_by_aspect_buckets,
        scale_pil_image,
    )
    from GameSentenceMiner.ocr.ocr_format_converter import (
        convert_ocr_result_to_unified_format,
        convert_normalized_coords_to_pixels
    )
except Exception as e:
    if __name__ == "__main__":
        print(f"Error importing modules: {e}")
        sys.exit(1)


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
            # mss.monitors[0] is all monitors combined, mss.monitors[1] is the first monitor.
            # Add 1 to the monitor_index to get the correct monitor.
            monitor_slot = monitor_index + 1
            if monitor_slot >= len(sct.monitors):
                raise IndexError(
                    f"Monitor index {monitor_slot} not found. Available monitors: {len(sct.monitors) - 1}")
            monitor = sct.monitors[monitor_slot]
            screenshot = sct.grab(monitor)

            # Convert to PIL Image
            img = Image.frombytes("RGB", screenshot.size,
                                  screenshot.bgra, "raw", "BGRX")
            logger.info(
                f"Screenshot captured from monitor {monitor_index + 1} ({img.width}x{img.height})")
            return img

    except ImportError:
        logger.error(
            "mss library not found. Please install it to use overlay functionality.")
        raise
    except IndexError as e:
        logger.error(str(e))
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
        A tuple containing the OCR results from all engines in unified format.
    """
    lang = get_ocr_language()
    logger.debug(f"get_ocr_results_from_image: Language set to {lang}")

    try:
        # Lazy import to prevent DLL conflicts with PyQt6 (e.g. torch, cv2)
        logger.debug("get_ocr_results_from_image: Importing OCR engines...")
        from GameSentenceMiner.owocr.owocr.ocr import GoogleLens, OneOCR, MeikiOCR
        logger.debug("get_ocr_results_from_image: OCR engines imported.")
    except Exception as e:
        logger.debug(f"get_ocr_results_from_image: Import failed! {e}")
        return None, None, None

    lens_res = None
    oneocr_res = None
    meikiocr_res = None

    try:
        logger.debug("get_ocr_results_from_image: Running GoogleLens...")
        lens = GoogleLens(lang=lang)
        lens_raw = lens(image_obj, return_coords=True)
        logger.debug(f"get_ocr_results_from_image: GoogleLens finished. Raw result: {bool(lens_raw)}")
        
        # Convert to unified format
        lens_res = convert_ocr_result_to_unified_format(lens_raw, "GoogleLens")
        logger.debug(f"get_ocr_results_from_image: GoogleLens converted. Result: {bool(lens_res)}, Count: {len(lens_res) if lens_res else 0}")
    except Exception as e:
        logger.debug(f"Error initializing/running Lens: {e}")

    try:
        logger.debug("get_ocr_results_from_image: Running OneOCR...")
        oneocr = OneOCR(lang=lang)
        oneocr_raw = oneocr(image_obj, return_dict=True)
        logger.debug(f"get_ocr_results_from_image: OneOCR finished. Raw result type: {type(oneocr_raw)}")
        
        # Convert to unified format
        oneocr_res = convert_ocr_result_to_unified_format(oneocr_raw, "OneOCR")
        logger.debug(f"get_ocr_results_from_image: OneOCR converted. Result: {bool(oneocr_res)}, Count: {len(oneocr_res) if oneocr_res else 0}")
    except Exception as e:
        logger.debug(f"Error initializing/running OneOCR: {e}")

    try:
        if MeikiOCR:
            logger.debug("get_ocr_results_from_image: Running MeikiOCR...")
            meikiocr = MeikiOCR(lang=lang)
            meikiocr_raw = meikiocr(image_obj, return_dict=True)
            logger.debug(f"get_ocr_results_from_image: MeikiOCR finished. Raw result type: {type(meikiocr_raw)}")
            if isinstance(meikiocr_raw, tuple):
                logger.debug(f"get_ocr_results_from_image: MeikiOCR tuple length: {len(meikiocr_raw)}")
                logger.debug(f"get_ocr_results_from_image: MeikiOCR tuple[0] (success): {meikiocr_raw[0]}")
                logger.debug(f"get_ocr_results_from_image: MeikiOCR tuple[2] type: {type(meikiocr_raw[2]) if len(meikiocr_raw) > 2 else 'N/A'}")
                logger.debug(f"get_ocr_results_from_image: MeikiOCR tuple[5] type: {type(meikiocr_raw[5]) if len(meikiocr_raw) > 5 else 'N/A'}")
            
            # Convert to unified format
            meikiocr_res = convert_ocr_result_to_unified_format(meikiocr_raw, "MeikiOCR")
            logger.debug(f"get_ocr_results_from_image: MeikiOCR converted. Result: {bool(meikiocr_res)}, Count: {len(meikiocr_res) if meikiocr_res else 0}")
        else:
            logger.debug("get_ocr_results_from_image: MeikiOCR not available/enabled (None).")
    except Exception as e:
        logger.debug(f"Error initializing/running MeikiOCR: {e}")

    return lens_res, oneocr_res, meikiocr_res


class OCRWorkerSignals(QObject):
    """Signals for OCR worker thread"""
    finished = pyqtSignal(object, object, object)


class FuriganaFilterCanvas(QWidget):
    """Custom widget to display image and rectangles"""

    def __init__(self, image: Image.Image, parent=None):
        super().__init__(parent)
        self.pil_image = image
        self.pil_image = image
        self.rectangles = []  # List of tuples (rects, color, label)
        self.loading = True
        self._qimage_buffer = None

        # Convert PIL to QPixmap
        logger.debug(
            f"FuriganaFilterCanvas: Converting image {image.width}x{image.height} mode={image.mode}")
        if image.mode in ('RGBA', 'LA', 'P'):
            if image.mode == 'P':
                image = image.convert('RGBA')
            rgb_img = Image.new('RGB', image.size, (255, 255, 255))
            rgb_img.paste(image, mask=image.split()
                          [-1] if image.mode == 'RGBA' else None)
            image = rgb_img

        self._qimage_buffer = image.tobytes('raw', 'RGB')
        logger.debug(
            f"FuriganaFilterCanvas: Buffer size: {len(self._qimage_buffer)}")
        qimage = QImage(self._qimage_buffer, image.width, image.height,
                        image.width * 3, QImage.Format.Format_RGB888)
        logger.debug("FuriganaFilterCanvas: QImage created")
        self.pixmap = QPixmap.fromImage(qimage)
        logger.debug("FuriganaFilterCanvas: QPixmap created")

        self.setMinimumSize(image.width, image.height)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)

    def set_rectangles(self, rectangles_with_colors):
        """Set rectangles to draw. Expects list of (rects_list, color_name, label) tuples."""
        self.rectangles = rectangles_with_colors
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

        # Draw rectangles with labels
        painter.save()

        for item in self.rectangles:
            if len(item) == 3:
                rects, color_name, label = item
            else:
                rects, color_name = item
                label = None
            
            color = QColor(color_name)
            pen = QPen(color, 2)
            painter.setPen(pen)
            
            # Draw all rectangles
            for i, (x1, y1, x2, y2) in enumerate(rects):
                painter.drawRect(int(x1), int(y1), int(x2 - x1), int(y2 - y1))
            
            # Draw label only once per group (on the first rectangle)
            if label and rects:
                x1, y1, x2, y2 = rects[0]
                # Draw semi-transparent background for label
                label_padding = 4
                label_height = 16
                label_width = len(label) * 8 + label_padding * 2
                
                painter.fillRect(
                    int(x1), int(y1) - label_height - 2,
                    label_width, label_height,
                    QColor(0, 0, 0, 180)
                )
                
                # Draw label text
                painter.setPen(QColor(255, 255, 255))
                painter.drawText(
                    int(x1) + label_padding, int(y1) - 6,
                    label
                )
                painter.setPen(pen)  # Restore rect color

        painter.restore()


class FuriganaFilterVisualizer(QDialog):
    def __init__(self, image: Image.Image, current_furigana_sensitivity: int = 0, parent=None):
        super().__init__(parent)
        logger.debug("FuriganaFilterVisualizer: Initializing...")
        self.image = image
        self.ocr1_result = None  # Lens
        self.ocr2_result = None  # OneOCR
        self.ocr3_result = None  # MeikiOCR

        self.current_view_mode = 0  # 0: Unified, 1: Lens, 2: OneOCR, 3: MeikiOCR
        self.title_prefix = "Furigana Filter Visualizer"
        self.result_value = None

        # Data structure: { 1: [lines], 2: [lines], 3: [lines] }
        self.ocr_data = {
            1: [],  # Lens
            2: [],  # OneOCR
            3: []  # MeikiOCR
        }

        self.punctuation_regex = regex.compile(r'[\p{P}\p{S}]')

        # Set up UI
        logger.debug("FuriganaFilterVisualizer: Setting window title...")
        self.setWindowTitle(f"{self.title_prefix} - Lens")
        self.setWindowFlags(
            Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Dialog)
        self.setModal(True)

        # Main layout (QDialog doesn't need a central widget)
        logger.debug("FuriganaFilterVisualizer: Setting up layout...")
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)

        # Canvas in scroll area to allow smaller windows
        logger.debug("FuriganaFilterVisualizer: Creating canvas...")
        self.canvas = FuriganaFilterCanvas(image)
        logger.debug("FuriganaFilterVisualizer: Canvas created")
        self.canvas_scroll_area = QScrollArea()
        self.canvas_scroll_area = QScrollArea()
        self.canvas_scroll_area.setWidgetResizable(False)
        self.canvas_scroll_area.setFrameShape(QFrame.Shape.NoFrame)
        self.canvas_scroll_area.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.canvas_scroll_area.setWidget(self.canvas)
        main_layout.addWidget(self.canvas_scroll_area)

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
        self.swap_button = QPushButton("Switch View (Unified)")
        self.swap_button.setEnabled(False)
        self.swap_button.clicked.connect(self.cycle_view)
        control_layout.addWidget(self.swap_button)

        # OK button
        self.ok_button = QPushButton("OK")
        self.ok_button.setEnabled(False)
        self.ok_button.clicked.connect(self.on_ok)
        control_layout.addWidget(self.ok_button)

        main_layout.addWidget(control_panel)

        # Initial size and position
        self._apply_initial_size()
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

    def _apply_initial_size(self):
        screen = QApplication.primaryScreen()
        if not screen:
            return
        available = screen.availableGeometry()
        target_w = min(self.image.width + 80, int(available.width() * 0.9))
        target_h = min(self.image.height + 160, int(available.height() * 0.9))
        self.resize(max(640, target_w), max(480, target_h))

    def set_title_prefix(self, prefix: str):
        """Set the title prefix and update the current title."""
        self.title_prefix = prefix
        self._update_window_title()

    def _update_window_title(self):
        modes = {0: "Unified View", 1: "Lens", 2: "OneOCR", 3: "MeikiOCR"}
        mode_name = modes.get(self.current_view_mode, "Unknown")
        self.setWindowTitle(f"{self.title_prefix} - {mode_name}")

    def update_with_ocr_data(self, ocr1_result, ocr2_result, ocr3_result):
        """Called by the background thread to populate the GUI with OCR data."""
        logger.debug(
            f"update_with_ocr_data: Received results. Lens: {bool(ocr1_result)}, OneOCR: {bool(ocr2_result)}, Meiki: {bool(ocr3_result)}")
        self.ocr1_result = ocr1_result
        self.ocr2_result = ocr2_result
        self.ocr3_result = ocr3_result

        # Remove loading message
        self.canvas.set_loading(False)
        logger.debug("update_with_ocr_data: Loading state set to False")

        if not self.ocr1_result:
            logger.debug(
                "update_with_ocr_data: Lens result is empty! This might cause early exit if not handled.")
            # Still enable OK button to allow closing
            self.ok_button.setEnabled(True)
            # return # Removed return to allow other engines to show

        # Enable controls
        self.slider.setEnabled(True)
        self.ok_button.setEnabled(True)
        if self.ocr2_result or self.ocr3_result:
            self.swap_button.setEnabled(True)

        logger.debug(
            "update_with_ocr_data: Controls enabled. Processing geometries...")

        # Process and display initial data
        self.pre_process_word_geometries()
        self.update_filter_visualization(self.slider.value())

    def on_ok(self):
        self.accept()

    def cycle_view(self):
        self.current_view_mode = (self.current_view_mode + 1) % 4
        logger.debug(f"cycle_view: Mode switched to {self.current_view_mode}")

        modes_button = {0: "Switch View (Unified)", 1: "Switch View (Lens)",
                        2: "Switch View (OneOCR)", 3: "Switch View (MeikiOCR)"}
        self.swap_button.setText(modes_button.get(
            self.current_view_mode, "Switch View"))
        self._update_window_title()

        self.update_filter_visualization(self.slider.value())

    def pre_process_word_geometries(self):
        """
        Parses all OCR results and prepares them for visualization.
        """
        img_w, img_h = self.image.size
        logger.debug(
            f"pre_process_word_geometries: Processing geometries for image size {img_w}x{img_h}...")

        self.ocr_data[1] = self.process_single_engine_result(
            self.ocr1_result, is_lens=True)
        logger.debug(
            f"pre_process_word_geometries: Processed Lens lines: {len(self.ocr_data[1])}")

        self.ocr_data[2] = self.process_single_engine_result(
            self.ocr2_result, is_lens=False)
        logger.debug(
            f"pre_process_word_geometries: Processed OneOCR lines: {len(self.ocr_data[2])}")

        self.ocr_data[3] = self.process_single_engine_result(
            self.ocr3_result, is_lens=False)
        logger.debug(
            f"pre_process_word_geometries: Processed MeikiOCR lines: {len(self.ocr_data[3])}")

    def process_single_engine_result(self, ocr_result, is_lens=False):
        """
        Parses the OCR result structure, calculates absolute pixel values, 
        and stores them for high-performance updates.
        """
        img_w, img_h = self.image.size
        processed_lines = []

        if not ocr_result:
            return processed_lines

        # Convert normalized coordinates to pixels if needed
        if isinstance(ocr_result, list) and len(ocr_result) > 0:
            if isinstance(ocr_result[0], dict) and ocr_result[0].get('normalized', False):
                logger.debug(f"process_single_engine_result: Converting normalized coordinates to pixels")
                ocr_result = convert_normalized_coords_to_pixels(ocr_result, img_w, img_h)

        # List of dicts (OneOCR/MeikiOCR/Lens unified format from converter)
        if isinstance(ocr_result, list):
            logger.debug(
                f"process_single_engine_result: Processing list of {len(ocr_result)} items")
            for line in ocr_result:
                try:
                    bbox = line['bounding_rect']
                    x1, y1, x2, y2 = bbox['x1'], bbox['y1'], bbox['x3'], bbox['y3']
                    px_w = abs(x2 - x1)
                    px_h = abs(y2 - y1)
                    processed_lines.append({
                        'text': line.get('text', ''),
                        'px_w': px_w,
                        'px_h': px_h,
                        'coords': (x1, y1, x2, y2)
                    })
                except Exception as e:
                    logger.debug(
                        f"Skipping malformed line data (list format): {e}")
                    continue
            return processed_lines

        # Dictionary format (legacy support, should not be needed with converter)
        # Check for legacy (OneOCR dict with 'lines')
        if isinstance(ocr_result, dict) and 'lines' in ocr_result:
            for line in ocr_result.get('lines', []):
                try:
                    bbox = line['bounding_rect']
                    x1, y1, x2, y2 = bbox['x1'], bbox['y1'], bbox['x3'], bbox['y3']
                    px_w = abs(x2 - x1)
                    px_h = abs(y2 - y1)
                    processed_lines.append({
                        'text': line.get('text', ''),
                        'px_w': px_w,
                        'px_h': px_h,
                        'coords': (x1, y1, x2, y2)
                    })
                except Exception as e:
                    logger.warning(
                        f"Skipping malformed line data (dict format): {e}")
                    continue

        return processed_lines

    def _rectangles_overlap(self, rect1, rect2, threshold=20):
        """Check if two rectangles overlap or are very close (within threshold pixels)"""
        x1_1, y1_1, x2_1, y2_1 = rect1
        x1_2, y1_2, x2_2, y2_2 = rect2
        
        # Add threshold to expand the rectangles for overlap detection
        return not (x2_1 + threshold < x1_2 - threshold or 
                    x2_2 + threshold < x1_1 - threshold or 
                    y2_1 + threshold < y1_2 - threshold or 
                    y2_2 + threshold < y1_1 - threshold)
    
    def _group_nearby_rectangles(self, rects_with_engines, engine_labels):
        """Group nearby rectangles and merge their labels and colors"""
        if not rects_with_engines:
            return []
        
        # Build groups of overlapping rectangles
        groups = []  # Each group: [(coords, engine_id, color), ...]
        
        for rect_data in rects_with_engines:
            coords, engine_id, color = rect_data
            
            # Find if this rect belongs to an existing group
            found_group = False
            for group in groups:
                # Check if this rect overlaps with any rect in the group
                for existing_coords, _, _ in group:
                    if self._rectangles_overlap(coords, existing_coords):
                        group.append(rect_data)
                        found_group = True
                        break
                if found_group:
                    break
            
            if not found_group:
                # Create new group
                groups.append([rect_data])
        
        # Convert groups to visualization format
        result = []
        for group in groups:
            # Collect all rectangles and engines in this group
            all_rects = [coords for coords, _, _ in group]
            engine_ids = list(set(engine_id for _, engine_id, _ in group))
            engine_ids.sort()  # Consistent order
            
            # Determine color: use first color, or mix if multiple
            if len(engine_ids) == 1:
                color = group[0][2]
            else:
                # For multiple engines, use magenta to indicate overlap
                color = 'magenta'
            
            # Create combined label
            if engine_ids:
                label = ', '.join(engine_labels[eid] for eid in engine_ids if eid in engine_labels)
            else:
                label = None
            
            result.append((all_rects, color, label))
        
        return result

    def update_filter_visualization(self, slider_value):
        """
        Called on every slider move. Clears old rectangles and draws new ones
        for words that pass the sensitivity filter.
        """
        sensitivity = float(slider_value)
        self.slider_value_label.setText(f"{sensitivity:.0f} px")

        rectangles_by_color = []

        # Colors: Lens=Green, OneOCR=Blue, Meiki=Red
        # Labels for unified view
        engine_labels = {1: 'Lens', 2: 'OneOCR', 3: 'Meiki'}
        engine_colors = {1: 'green', 2: 'blue', 3: 'red'}
        
        views = []
        if self.current_view_mode == 0:  # Unified
            views = [(1, 'green', True), (2, 'blue', True), (3, 'red', True)]
        elif self.current_view_mode == 1:  # Lens
            views = [(1, 'green', False)]
        elif self.current_view_mode == 2:  # OneOCR
            views = [(2, 'blue', False)]
        elif self.current_view_mode == 3:  # MeikiOCR
            views = [(3, 'red', False)]

        if self.current_view_mode == 0:  # Unified view - merge overlapping labels
            # Collect all rectangles with their engine IDs
            all_rects_with_engine = []  # List of (coords, engine_id, color)
            for view_item in views:
                engine_id, color, show_label = view_item
                lines = self.ocr_data.get(engine_id, [])
                for line_data in lines:
                    if line_data['px_w'] > sensitivity and line_data['px_h'] > sensitivity:
                        all_rects_with_engine.append((line_data['coords'], engine_id, color))
            
            # Group overlapping/nearby rectangles
            rectangles_by_color = self._group_nearby_rectangles(all_rects_with_engine, engine_labels)
        else:  # Individual engine view
            for view_item in views:
                if len(view_item) == 3:
                    engine_id, color, show_label = view_item
                else:
                    engine_id, color = view_item
                    show_label = False
                
                lines = self.ocr_data.get(engine_id, [])
                filtered_rects = []
                for line_data in lines:
                    if line_data['px_w'] > sensitivity and line_data['px_h'] > sensitivity:
                        filtered_rects.append(line_data['coords'])
                if filtered_rects:
                    label = engine_labels.get(engine_id) if show_label else None
                    rectangles_by_color.append((filtered_rects, color, label))

        self.canvas.set_rectangles(rectangles_by_color)


def _ensure_qapplication():
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    return app


def _start_ocr_worker(image_obj, on_finished):
    signals = OCRWorkerSignals()

    def ocr_worker():
        logger.debug("OCR Worker: Thread started.")
        try:
            logger.debug("OCR Worker: Calling get_ocr_results_from_image...")
            ocr1_data, ocr2_data, ocr3_data = get_ocr_results_from_image(
                image_obj)
            logger.debug(f"OCR Worker: OCR finished. Emitting signal.")
            signals.finished.emit(ocr1_data, ocr2_data, ocr3_data)
        except Exception as e:
            logger.debug(f"OCR Worker: Exception caught! {e}")
            signals.finished.emit(None, None, None)

    signals.finished.connect(on_finished)
    threading.Thread(target=ocr_worker, daemon=True).start()
    return signals


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
            logger.info(
                "Using overlay mode - capturing from configured monitor...")
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
            screenshot_img = obs.get_screenshot_PIL(
                compression=90, img_format='jpg')
            title_suffix = obs.get_current_game()
            if not screenshot_img:
                logger.error("Failed to get screenshot from OBS.")
                return None

        # Scale down the image for performance using shared logic
        scaled = scale_dimensions_by_aspect_buckets(
            screenshot_img.width, screenshot_img.height, allow_upscale=True)
        if scaled and (scaled.width != screenshot_img.width or scaled.height != screenshot_img.height):
            screenshot_img = scale_pil_image(
                screenshot_img, scaled, resample=Image.Resampling.BILINEAR)

        source_type = "overlay monitor" if for_overlay else "OBS"
        logger.info(
            f"Screenshot received from {source_type} ({screenshot_img.width}x{screenshot_img.height}).")
    else:
        screenshot_img = image

    app = _ensure_qapplication()
    logger.debug("QApplication ensured (show_furigana_filter_preview)")

    # Create dialog
    logger.debug("Creating Visualizer Dialog...")
    dialog = FuriganaFilterVisualizer(
        screenshot_img, current_sensitivity, parent=parent)
    logger.debug(f"Furigana Filter Visualizer - {title_suffix}")
    dialog.set_title_prefix(f"Furigana Filter Visualizer - {title_suffix}")

    logger.debug("Starting OCR Worker...")
    _ = _start_ocr_worker(screenshot_img, dialog.update_with_ocr_data)
    logger.debug("OCR Worker Started")

    # Show dialog modally (blocks until user closes it)
    logger.debug("Executing Dialog Loop...")
    result = dialog.exec()
    logger.debug("Dialog Loop Finished")

    # Get the selected value if accepted
    selected_value = dialog.slider.value(
    ) if result == QDialog.DialogCode.Accepted else None

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
            numeric_args = [arg for arg in args if arg not in [
                "overlay", "--overlay"] and arg.isdigit()]
            if numeric_args:
                current_furigana_sensitivity = int(numeric_args[0])
        else:
            # Assume first argument is sensitivity
            try:
                current_furigana_sensitivity = int(args[0])
            except ValueError:
                logger.warning(
                    f"Invalid sensitivity value: {args[0]}. Using default value 0.")

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
            logger.error(
                f"Failed to connect to OBS. Please ensure OBS is running and the WebSocket server is enabled. Error: {e}")
            return

        logger.info("Taking OBS screenshot...")
        screenshot_img = obs.get_screenshot_PIL(
            compression=90, img_format='jpg')

        if not screenshot_img:
            logger.error("Failed to get screenshot from OBS.")
            return

    # Scale down the image for performance using shared logic
    scaled = scale_dimensions_by_aspect_buckets(
        screenshot_img.width, screenshot_img.height, allow_upscale=True)
    if scaled and (scaled.width != screenshot_img.width or scaled.height != screenshot_img.height):
        screenshot_img = scale_pil_image(
            screenshot_img, scaled, resample=Image.Resampling.BILINEAR)

    source_type = "overlay monitor" if use_overlay else "OBS"
    logger.info(
        f"Screenshot received from {source_type} ({screenshot_img.width}x{screenshot_img.height}).")

    app = _ensure_qapplication()
    logger.debug("QApplication ensured")

    logger.debug("Creating Visualizer Dialog...")
    dialog = FuriganaFilterVisualizer(
        screenshot_img, current_furigana_sensitivity)
    logger.debug("Visualizer Dialog Created")

    # Update window title to reflect source
    if use_overlay:
        overlay_config = get_overlay_config()
        monitor_num = overlay_config.monitor_to_capture + 1
        dialog.set_title_prefix(
            f"Furigana Filter Visualizer - Overlay Monitor {monitor_num}")

    logger.debug("Starting OCR Worker...")
    _ = _start_ocr_worker(screenshot_img, dialog.update_with_ocr_data)
    logger.debug("OCR Worker Started")

    # Show dialog and get result
    logger.debug("Executing Dialog Loop...")
    result = dialog.exec()
    logger.debug(f"Dialog Loop Finished, Result: {result}")

    if result == QDialog.DialogCode.Accepted:
        print(f"RESULT:[{dialog.slider.value()}]")

    sys.exit(0)


if __name__ == "__main__":
    main()
