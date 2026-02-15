import argparse
import json
import mss
import os
import sys
import time
from PIL import Image
from PyQt6.QtCore import Qt, QRect, QTimer, QPoint
from PyQt6.QtGui import QPainter, QPen, QColor, QPixmap, QImage, QBrush, QAction, QGuiApplication
from PyQt6.QtWidgets import QApplication, QWidget, QPushButton, QVBoxLayout, QLabel, QMenu, QProgressDialog, QMessageBox

from GameSentenceMiner import obs
from GameSentenceMiner.ocr.gsm_ocr_config import set_dpi_awareness, get_window, get_scene_ocr_config_path, \
    get_ocr_config_path
from GameSentenceMiner.ocr.image_scaling import (
    scale_pil_image_to_minimum_bounds,
    scale_dimensions_by_aspect_buckets,
    scale_pil_image_to_bounds,
)
# Assuming get_config is available here based on your request
from GameSentenceMiner.util.config.configuration import logger, get_config
from GameSentenceMiner.util.gsm_utils import sanitize_filename

MIN_RECT_WIDTH = 25
MIN_RECT_HEIGHT = 25
COORD_SYSTEM_PERCENTAGE = "percentage"


class ControlPanelWidget(QWidget):
    """Separate control panel window with buttons for all actions."""
    
    def __init__(self, parent_selector):
        super().__init__()
        self.parent_selector = parent_selector
        self.init_ui()
    
    def init_ui(self):
        """Initialize the control panel UI."""
        self.setWindowTitle("Controls")
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Tool)
        
        # Disable resizing
        self.setFixedSize(self.sizeHint())
        
        # Create layout
        layout = QVBoxLayout()
        layout.setSpacing(5)
        layout.setContentsMargins(10, 10, 10, 10)
        
        # Instructions label
        if getattr(self.parent_selector, 'select_monitor_area', False):
            # Simplified instructions for monitor selection mode
            instr_text = (
                "Monitor Selection Mode:\n"
                "• Left Click + Drag: Create selection area.\n"
                "• Ctrl + A: Select entire screen.\n"
                "• Right-Click on a box: Delete it.\n"
                "• Modifiers (Shift/Ctrl) are disabled."
            )
        else:
            # Original instructions
            instr_text = (
                "How to Use:\n"
                "• Left Click + Drag: Create a capture area (green).\n"
                "• Shift + Left Click + Drag: Create an exclusion area (orange).\n"
                "• Ctrl + Left Click + Drag: Create a secondary (menu) area (purple).\n"
                "• Ctrl + A: Select entire screen (green).\n"
                "• Right-Click on a box: Delete it."
            )

        instructions = QLabel(instr_text)
        instructions.setWordWrap(True)
        layout.addWidget(instructions)
        
        # Buttons
        save_btn = QPushButton("Save and Quit (Ctrl+S)")
        save_btn.clicked.connect(self.parent_selector.save_and_quit)
        layout.addWidget(save_btn)
        
        undo_btn = QPushButton("Undo (Ctrl+Z)")
        undo_btn.clicked.connect(self.parent_selector.undo)
        layout.addWidget(undo_btn)
        
        redo_btn = QPushButton("Redo (Ctrl+Y)")
        redo_btn.clicked.connect(self.parent_selector.redo)
        layout.addWidget(redo_btn)
        
        # Add refresh button only if using OBS screenshot
        if self.parent_selector.use_obs_screenshot:
            refresh_btn = QPushButton("Refresh Screenshot (R)")
            refresh_btn.clicked.connect(self.parent_selector.refresh_screenshot)
            layout.addWidget(refresh_btn)
        
        toggle_instructions_btn = QPushButton("Toggle Instructions (I)")
        toggle_instructions_btn.clicked.connect(self.toggle_instructions)
        layout.addWidget(toggle_instructions_btn)
        
        quit_btn = QPushButton("Quit without Saving (Esc)")
        quit_btn.clicked.connect(self.parent_selector.close)
        layout.addWidget(quit_btn)
        
        self.setLayout(layout)
        
        # Position at top-left of screen
        screen = QApplication.primaryScreen()
        if screen:
            screen_geometry = screen.geometry()
            self.move(screen_geometry.x() + 10, screen_geometry.y() + 10)
        else:
            self.move(10, 10)
        
        self.setFixedWidth(350)
    
    def toggle_instructions(self):
        """Toggle instructions visibility on main selector."""
        self.parent_selector.instructions_visible = not self.parent_selector.instructions_visible
        self.parent_selector.update()
    
    def closeEvent(self, event):
        """When control panel closes, also close the main selector."""
        if self.parent_selector:
            self.parent_selector.close()
        event.accept()


class OWOCRAreaSelectorWidget(QWidget):
    def __init__(self, window_name, use_window_as_config=False, use_obs_screenshot=False, 
                 on_complete=None, select_monitor_area=False, monitor_index=None):
        super().__init__()
        logger.debug("Initializing OWOCRAreaSelectorWidget...")
        logger.debug(f"  window_name: '{window_name}'")
        logger.debug(f"  use_window_as_config: {use_window_as_config}")
        logger.debug(f"  use_obs_screenshot: {use_obs_screenshot}")
        logger.debug(f"  select_monitor_area: {select_monitor_area}")
        logger.debug(f"  monitor_index: {monitor_index}")
        
        self.window_name = window_name
        self.use_window_as_config = use_window_as_config
        self.use_obs_screenshot = use_obs_screenshot
        self.on_complete = on_complete
        
        # New mode flag and monitor index
        self.select_monitor_area = select_monitor_area
        self.target_monitor_index = monitor_index
        
        self.scale_factor_w = 1.0
        self.scale_factor_h = 1.0
        self.monitor_geometry = None # To store left/top/width/height of physical monitor
        
        self.scene = None
        self.screenshot_img = None
        self.pixmap = None
        self.target_window_geometry = {}
        self.bounding_box = {}
        self.bounding_box_original = None
        self.rectangles = []
        self.monitors = []
        self.reference_screen_geometry = None
        
        self.start_pos = None
        self.current_pos = None
        self.is_drawing = False
        self.drawing_excluded = False
        self.drawing_secondary = False
        self.menu_drawing_mode = False
        
        self.undo_stack = []
        self.redo_stack = []
        
        self.instructions_visible = True
        self.instructions_dimmed = False
        self.instructions_rect = QRect(20, 20, 400, 320)
        
        self.control_panel = None
        
        self.long_press_timer = QTimer()
        self.long_press_timer.timeout.connect(self._show_save_menu)
        self.long_press_pos = None
        self.long_press_active = False
        
        logger.debug("Calling _initialize()...")
        self._initialize()
        # Only initialize UI if screenshot was successful
        if self.pixmap:
            logger.debug("Pixmap created successfully, initializing UI...")
            self.init_ui()
            logger.debug("UI initialization complete")
        else:
            logger.error("Pixmap creation failed, UI will not be initialized")
            raise RuntimeError("Failed to create pixmap during initialization")
    
    def _initialize(self):
        """Initialize appropriate capture method."""
        try:
            logger.info("Starting initialization...")
            if self.select_monitor_area:
                logger.info("Initializing monitor capture mode...")
                self._init_monitor_capture()
                logger.info("Connecting to OBS...")
                obs.connect_to_obs_sync()
                logger.info("Getting current scene...")
                self.scene = obs.get_current_scene()
                logger.info(f"Current scene: {self.scene}")
                logger.info("Loading existing overlay rectangles...")
                self._load_existing_overlay_rectangles()    
            else:
                logger.info("Connecting to OBS...")
                obs.connect_to_obs_sync()
                logger.info("Getting current scene...")
                self.scene = obs.get_current_scene()
                logger.info(f"Current scene: {self.scene}")
                
                if self.use_obs_screenshot:
                    logger.info("Initializing OBS screenshot mode...")
                    self._init_obs_screenshot()
                else:
                    logger.info("Initializing window capture mode...")
                    self._init_window_capture()
                
                logger.info("Loading existing rectangles...")
                self._load_existing_rectangles()
            
            # Convert PIL Image to QPixmap
            logger.info("Converting PIL Image to QPixmap...")
            img_to_convert = self.screenshot_img
            logger.info(f"Image mode: {img_to_convert.mode}, size: {img_to_convert.size}")
            
            if img_to_convert.mode in ('RGBA', 'LA', 'P'):
                logger.info(f"Converting image mode from {img_to_convert.mode} to RGB...")
                if img_to_convert.mode == 'P':
                    img_to_convert = img_to_convert.convert('RGBA')
                rgb_img = Image.new('RGB', img_to_convert.size, (255, 255, 255))
                rgb_img.paste(img_to_convert, mask=img_to_convert.split()[-1] if img_to_convert.mode == 'RGBA' else None)
                img_to_convert = rgb_img
            
            logger.info("Creating QImage from image data...")
            img_data = img_to_convert.tobytes('raw', 'RGB')
            qimage = QImage(img_data, img_to_convert.width, img_to_convert.height,
                          img_to_convert.width * 3, QImage.Format.Format_RGB888)
            self.pixmap = QPixmap.fromImage(qimage)
            logger.info(f"QPixmap created successfully: {self.pixmap.width()}x{self.pixmap.height()}")
            logger.info("Initialization completed successfully")
            
        except Exception as e:
            logger.exception(f"Failed to initialize: {e}")
            import traceback
            traceback.print_exc()
            # Display error in a box and exit gracefully
            try:
                QMessageBox.critical(None, "Initialization Error", str(e))
            except:
                logger.error("Failed to show error dialog")
            sys.exit(1)

    def _init_monitor_capture(self):
        """Initialize by capturing the configured monitor via MSS."""
        
        # Determine target monitor index
        if self.target_monitor_index is not None:
            target_idx = self.target_monitor_index
        else:
            try:
                config = get_config()
                target_idx = config.overlay.monitor
            except Exception as e:
                logger.warning(f"Could not read config for monitor index, defaulting to 0. Error: {e}")
                target_idx = 0

        self.target_monitor_index = target_idx
        logger.info(f"Monitor Selection Mode: Targeting monitor index {target_idx}")

        with mss.mss() as sct:
            # MSS monitors list starts with [0] as 'All Monitors Combined'.
            # Index 1 in MSS is usually the primary monitor (OS index 0).
            mss_idx = target_idx + 1
            
            if mss_idx >= len(sct.monitors):
                logger.error(f"Monitor index {target_idx} out of range (Found {len(sct.monitors)-1} monitors). Using primary.")
                mss_idx = 1 # Fallback to primary
                self.target_monitor_index = 0
            
            monitor_info = sct.monitors[mss_idx]
            self.monitor_geometry = monitor_info # Store for UI positioning
            
            # Capture specific monitor
            sct_img = sct.grab(monitor_info)
            full_img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
            
            original_w = full_img.width
            original_h = full_img.height

            # Scale down logic for the canvas
            target_size = scale_dimensions_by_aspect_buckets(original_w, original_h)
            target_w, target_h = target_size.as_tuple()
            
            if target_w != original_w or target_h != original_h:
                logger.info(f"Scaling monitor capture from {original_w}x{original_h} to {target_w}x{target_h}")
                self.screenshot_img = full_img.resize((target_w, target_h), Image.LANCZOS)
            else:
                self.screenshot_img = full_img
            
            self.bounding_box_original = {
                'left': 0, 'top': 0,
                'width': original_w,
                'height': original_h
            }
            self._fit_capture_to_screen(original_w, original_h)
            self.target_window_geometry = self.bounding_box_original.copy()
            
            # Dummy monitor list for compatibility
            self.monitors = [{'index': self.target_monitor_index, 'left': 0, 'top': 0, 
                              'width': original_w, 'height': original_h}]

    def _init_obs_screenshot(self):
        """Initialize using OBS screenshot."""
        sources = obs.get_active_video_sources()
        best_source = obs.get_best_source_for_screenshot()
        if len(sources) > 1:
            logger.warning(f"Multiple active video sources found. Using '{best_source.get('sourceName')}'")
        
        # Attempt to get screenshot with retry logic
        self.screenshot_img = None
        retry_count = 10
        retry_delay = 3
        
        # Create a progress dialog to warn the user and allow quitting
        progress = QProgressDialog("Connecting to OBS...", "Quit", 0, retry_count)
        progress.setWindowTitle("Waiting for Game Source")
        progress.setWindowModality(Qt.WindowModality.ApplicationModal)
        progress.setMinimumDuration(0)
        progress.setCancelButtonText("Quit")
        
        # Center the dialog on the primary screen
        screen = QApplication.primaryScreen()
        if screen:
            geo = screen.geometry()
            progress.move(geo.center() - progress.rect().center())
        
        for i in range(retry_count):
            try:
                # Update dialog text
                remaining = retry_count - i
                progress.setLabelText(
                    "OBS Source appears blank or invalid.\n"
                    "Please open your game.\n"
                    f"Retrying... ({remaining} attempts left)"
                )
                progress.setValue(i)
                
                # Check for cancellation/quit
                if progress.wasCanceled():
                    logger.info("User quit during screenshot retry.")
                    sys.exit(0)
                
                # Attempt capture - get fresh scene data implicitly via the obs call or connection check
                self.screenshot_img = obs.get_screenshot_PIL(compression=90, img_format='jpg')
                
                # If we got a valid image, break the loop
                if self.screenshot_img:
                    break
                
            except Exception as e:
                logger.debug(f"Attempt {i+1} failed: {e}")
            
            # Wait with event processing to keep UI responsive
            t_end = time.time() + retry_delay
            while time.time() < t_end:
                QApplication.processEvents()
                time.sleep(0.01)
        
        progress.close()

        if not self.screenshot_img:
            raise RuntimeError("Failed to get OBS screenshot after multiple retries. Is the game running and visible in OBS?")
        
        original_w = self.screenshot_img.width
        original_h = self.screenshot_img.height

        # Scale down for performance
        self.screenshot_img, _ = scale_pil_image_to_minimum_bounds(
            self.screenshot_img,
            resample=Image.LANCZOS,
        )
        
        self.target_window_geometry = {
            "left": 0,
            "top": 0,
            "width": original_w,
            "height": original_h
        }
        self.bounding_box_original = self.target_window_geometry.copy()
        self._fit_capture_to_screen(original_w, original_h)
        
        # Mock monitor for OBS mode
        self.monitors = [{'index': 0, 'left': 0, 'top': 0,
                        'width': original_w,
                        'height': original_h}]
        
        logger.info(f"OBS Screenshot: {original_w}x{original_h} (scaled to {self.screenshot_img.width}x{self.screenshot_img.height})")
    
    def _init_window_capture(self):
        """Initialize using window capture with mss."""
        import mss
        
        with mss.mss() as sct:
            self.monitors = [{'index': i, **m} for i, m in enumerate(sct.monitors[1:])]
        
        if not self.monitors:
            raise RuntimeError("No monitors found")
        
        logger.info(f"Targeting window: '{self.window_name}'")
        target_window = get_window(self.window_name)
        if not target_window:
            raise RuntimeError(f"Could not find window '{self.window_name}'")
        
        self.target_window_geometry = {
            "left": target_window.left,
            "top": target_window.top,
            "width": max(1, target_window.width),
            "height": max(1, target_window.height)
        }
        
        # Calculate bounding box of all monitors
        import mss
        with mss.mss() as sct:
            left = min(m['left'] for m in self.monitors)
            top = min(m['top'] for m in self.monitors)
            right = max(m['left'] + m['width'] for m in self.monitors)
            bottom = max(m['top'] + m['height'] for m in self.monitors)
            
            self.bounding_box_original = {
                'left': left,
                'top': top,
                'width': right - left,
                'height': bottom - top
            }
            
            # Capture entire desktop
            sct_img = sct.grab(self.bounding_box_original)
            self.screenshot_img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
            original_w = self.bounding_box_original['width']
            original_h = self.bounding_box_original['height']
        
        self._fit_capture_to_screen(original_w, original_h)
        logger.info(f"Captured {original_w}x{original_h} desktop area (scaled to {self.screenshot_img.width}x{self.screenshot_img.height})")

    def _get_reference_screen_geometry(self):
        screen = None
        if self.select_monitor_area and self.monitor_geometry:
            center_x = self.monitor_geometry['left'] + (self.monitor_geometry['width'] // 2)
            center_y = self.monitor_geometry['top'] + (self.monitor_geometry['height'] // 2)
            screen = QGuiApplication.screenAt(QPoint(center_x, center_y))
        elif self.target_window_geometry:
            center_x = self.target_window_geometry['left'] + (self.target_window_geometry['width'] // 2)
            center_y = self.target_window_geometry['top'] + (self.target_window_geometry['height'] // 2)
            screen = QGuiApplication.screenAt(QPoint(center_x, center_y))

        if screen is None:
            screen = QApplication.primaryScreen()

        return screen.availableGeometry() if screen else None

    def _fit_capture_to_screen(self, original_w, original_h):
        """Scale the capture to fit within the active screen, track scale factor."""
        self.reference_screen_geometry = self._get_reference_screen_geometry()
        if not self.reference_screen_geometry:
            self.scale_factor_w = original_w / max(1, self.screenshot_img.width)
            self.scale_factor_h = original_h / max(1, self.screenshot_img.height)
            self.bounding_box = {
                'left': 0,
                'top': 0,
                'width': self.screenshot_img.width,
                'height': self.screenshot_img.height
            }
            return

        max_w = max(1, int(self.reference_screen_geometry.width() * 0.98))
        max_h = max(1, int(self.reference_screen_geometry.height() * 0.98))
        scaled_img, scaled_size = scale_pil_image_to_bounds(
            self.screenshot_img,
            max_width=max_w,
            max_height=max_h,
            allow_upscale=False,
            resample=Image.LANCZOS,
        )
        self.screenshot_img = scaled_img
        self.scale_factor_w = original_w / max(1, scaled_size.width)
        self.scale_factor_h = original_h / max(1, scaled_size.height)
        self.bounding_box = {
            'left': 0,
            'top': 0,
            'width': scaled_size.width,
            'height': scaled_size.height
        }
    
    def _load_existing_rectangles(self):
        """Load rectangles from config file."""
        if self.select_monitor_area:
            return

        config_path = get_scene_ocr_config_path(self.use_window_as_config, self.window_name)
        win_geom = self.target_window_geometry
        win_w, win_h, win_l, win_t = win_geom['width'], win_geom['height'], win_geom['left'], win_geom['top']
        
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
            
            if config_data.get("coordinate_system") != COORD_SYSTEM_PERCENTAGE:
                logger.warning(f"Config file does not use '{COORD_SYSTEM_PERCENTAGE}' system")
                return
            
            logger.info(f"Loading rectangles from {config_path}")
            loaded_count = 0
            
            for rect_data in config_data.get("rectangles", []):
                try:
                    coords_pct = rect_data["coordinates"]
                    x_pct, y_pct, w_pct, h_pct = map(float, coords_pct)
                    
                    # Convert from percentage to absolute pixels (relative to original capture)
                    x_abs = int((x_pct * win_w) + win_l)
                    y_abs = int((y_pct * win_h) + win_t)
                    w_abs = int(w_pct * win_w)
                    h_abs = int(h_pct * win_h)

                    # Scale from original capture coords to widget coords
                    x_abs = int((x_abs - self.bounding_box_original['left']) / self.scale_factor_w)
                    y_abs = int((y_abs - self.bounding_box_original['top']) / self.scale_factor_h)
                    w_abs = int(w_abs / self.scale_factor_w)
                    h_abs = int(h_abs / self.scale_factor_h)
                    
                    monitor_index = rect_data["monitor"]['index']
                    
                    self.rectangles.append({
                        'x': x_abs,
                        'y': y_abs,
                        'w': w_abs,
                        'h': h_abs,
                        'monitor_index': monitor_index,
                        'is_excluded': rect_data["is_excluded"],
                        'is_secondary': rect_data.get("is_secondary", False)
                    })
                    # Add to undo stack so previously saved boxes can be undone
                    self.undo_stack.append(('add', len(self.rectangles) - 1))
                    loaded_count += 1
                except (KeyError, ValueError, TypeError) as e:
                    logger.warning(f"Skipping malformed rectangle: {e}")
            
            logger.info(f"Loaded {loaded_count} rectangles")
        except FileNotFoundError:
            logger.info(f"No config found at {config_path}. Starting fresh.")
        except Exception as e:
            logger.error(f"Error loading config: {e}")
    
    def _load_existing_overlay_rectangles(self):
        """Load rectangles from overlay config file for monitor mode."""
        try:
            # Get scene name
            scene = sanitize_filename(self.scene or "Default")
            ocr_config_dir = get_ocr_config_path()
            overlay_config_path = os.path.join(ocr_config_dir, f"{scene}_overlay.json")
            
            if not os.path.exists(overlay_config_path):
                logger.info(f"No overlay config found at {overlay_config_path}. Starting fresh.")
                return
            
            with open(overlay_config_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
            
            logger.info(f"Loading overlay rectangles from {overlay_config_path}")
            print(f"Existing overlay config: {json.dumps(config_data, indent=2)}")
            
            # Get actual monitor dimensions (original, before scaling)
            monitor_width = self.monitor_geometry['width'] if self.monitor_geometry else self.screenshot_img.width
            monitor_height = self.monitor_geometry['height'] if self.monitor_geometry else self.screenshot_img.height
            
            # Check if using percentage-based coordinates
            use_percentage = config_data.get("coordinate_system") == COORD_SYSTEM_PERCENTAGE
            
            loaded_count = 0
            for rect_data in config_data.get("rects", []):
                try:
                    if use_percentage:
                        # Convert from percentage to pixel coordinates
                        x_pct = float(rect_data["x"])
                        y_pct = float(rect_data["y"])
                        w_pct = float(rect_data["w"])
                        h_pct = float(rect_data["h"])
                        
                        x_orig = int(x_pct * monitor_width)
                        y_orig = int(y_pct * monitor_height)
                        w_orig = int(w_pct * monitor_width)
                        h_orig = int(h_pct * monitor_height)
                    else:
                        # Legacy: absolute pixel coordinates
                        x_orig = int(rect_data["x"])
                        y_orig = int(rect_data["y"])
                        w_orig = int(rect_data["w"])
                        h_orig = int(rect_data["h"])
                    
                    # Scale from original monitor coords to scaled widget coords
                    x_scaled = int(x_orig / self.scale_factor_w)
                    y_scaled = int(y_orig / self.scale_factor_h)
                    w_scaled = int(w_orig / self.scale_factor_w)
                    h_scaled = int(h_orig / self.scale_factor_h)
                    
                    self.rectangles.append({
                        'x': x_scaled,
                        'y': y_scaled,
                        'w': w_scaled,
                        'h': h_scaled,
                        'monitor_index': self.target_monitor_index,
                        'is_excluded': False,
                        'is_secondary': False
                    })
                    self.undo_stack.append(('add', len(self.rectangles) - 1))
                    loaded_count += 1
                except (KeyError, ValueError, TypeError) as e:
                    logger.warning(f"Skipping malformed rectangle: {e}")
            
            logger.info(f"Loaded {loaded_count} overlay rectangles")
        except Exception as e:
            logger.error(f"Error loading overlay config: {e}")
    
    def init_ui(self):
        # Set window properties
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint |
                           Qt.WindowType.Tool |
                           Qt.WindowType.BypassWindowManagerHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, False)
        
        # Set window title
        self.setWindowTitle('OWOCR Area Selector')
        
        # Disable resizing
        self.setFixedSize(self.bounding_box['width'], self.bounding_box['height'])
        
        # Positioning logic
        if self.select_monitor_area and self.monitor_geometry:
            # Center the selector on the target monitor
            monitor_width = self.monitor_geometry['width']
            monitor_height = self.monitor_geometry['height']
            window_width = self.bounding_box['width']
            window_height = self.bounding_box['height']
            
            x = self.monitor_geometry['left'] + (monitor_width - window_width) // 2
            y = self.monitor_geometry['top'] + (monitor_height - window_height) // 2
            
            self.move(x, y)
            self.resize(window_width, window_height)
        
        elif self.use_obs_screenshot:
            # Center on reference screen
            screen_geometry = self.reference_screen_geometry or (QApplication.primaryScreen().geometry() if QApplication.primaryScreen() else None)
            if screen_geometry:
                x = screen_geometry.x() + (screen_geometry.width() - self.bounding_box['width']) // 2
                y = screen_geometry.y() + (screen_geometry.height() - self.bounding_box['height']) // 2
                self.move(x, y)
                self.resize(self.bounding_box['width'], self.bounding_box['height'])
        
        else:
            # Center on reference screen to avoid oversized/multi-monitor offsets
            screen_geometry = self.reference_screen_geometry or (QApplication.primaryScreen().geometry() if QApplication.primaryScreen() else None)
            if screen_geometry:
                x = screen_geometry.x() + (screen_geometry.width() - self.bounding_box['width']) // 2
                y = screen_geometry.y() + (screen_geometry.height() - self.bounding_box['height']) // 2
                self.move(x, y)
            self.resize(self.bounding_box['width'], self.bounding_box['height'])
        
        # Set cursor
        self.setCursor(Qt.CursorShape.CrossCursor)
        
        # Enable mouse tracking for hover events
        self.setMouseTracking(True)
        
        # Show window
        self.show()
        self.activateWindow()
        self.raise_()
        
        # Create and show control panel
        self.control_panel = ControlPanelWidget(self)
        self.control_panel.show()
    
    def paintEvent(self, event):
        painter = QPainter(self)
        
        # Draw the screenshot
        painter.drawPixmap(0, 0, self.pixmap)
        
        # Draw a bright border around the entire window
        border_color = QColor(0, 255, 255)  # Cyan
        border_pen = QPen(border_color, 2)  # 2 pixels thick
        painter.setPen(border_pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        # Draw rectangle slightly inset so the border is fully visible
        painter.drawRect(1, 1, self.width() - 2, self.height() - 2)
        
        # Draw existing rectangles
        for rect in self.rectangles:
            self._draw_rectangle(painter, rect)
        
        # Draw current drawing rectangle
        if self.start_pos and self.current_pos:
            x1 = min(self.start_pos.x(), self.current_pos.x())
            y1 = min(self.start_pos.y(), self.current_pos.y())
            w = abs(self.current_pos.x() - self.start_pos.x())
            h = abs(self.current_pos.y() - self.start_pos.y())
            
            temp_rect = {
                'x': x1,
                'y': y1,
                'w': w,
                'h': h,
                'is_excluded': self.drawing_excluded,
                'is_secondary': self.drawing_secondary
            }
            self._draw_rectangle(painter, temp_rect)
        
        # Draw instructions
        if self.instructions_visible:
            self._draw_instructions(painter)
    
    def _draw_rectangle(self, painter, rect):
        """Draw a rectangle with appropriate color."""
        # Save painter state to avoid affecting other drawing
        painter.save()
        
        if rect['is_excluded']:
            color = QColor(255, 165, 0)  # Orange for excluded
        elif rect.get('is_secondary', False):
            color = QColor(128, 0, 128)  # Purple for secondary
        else:
            color = QColor(0, 255, 0)  # Green for normal
        
        pen = QPen(color, 3)
        painter.setPen(pen)
        
        # Draw border
        painter.drawRect(rect['x'], rect['y'], rect['w'], rect['h'])
        
        # Draw semi-transparent fill
        brush = QBrush(QColor(color.red(), color.green(), color.blue(), 50))
        painter.setBrush(brush)
        painter.drawRect(rect['x'], rect['y'], rect['w'], rect['h'])
        
        # Restore painter state
        painter.restore()
    
    def _draw_instructions(self, painter):
        """Draw instruction panel."""
        # Save painter state to prevent color bleed from rectangle drawing
        painter.save()
        
        panel_x = 20
        panel_y = 20
        panel_width = 400
        panel_height = 320
        
        # Determine opacity based on hover state
        alpha = 5 if self.instructions_dimmed else 230
        text_alpha = 10 if self.instructions_dimmed else 255
        border_alpha = 5 if self.instructions_dimmed else 100
        
        # Background
        painter.fillRect(panel_x, panel_y, panel_width, panel_height, QColor(0, 0, 0, alpha))
        painter.setPen(QPen(QColor(255, 255, 255, border_alpha), 1))
        painter.drawRect(panel_x, panel_y, panel_width, panel_height)
        
        # Title - always use full green, not affected by dimming
        painter.setPen(QColor(76, 175, 80))
        painter.drawText(panel_x + 10, panel_y + 25, "OCR Area Selector")
        
        # Instructions
        painter.setPen(QColor(255, 255, 255, text_alpha))
        y_offset = panel_y + 55
        line_height = 20
        
        if self.select_monitor_area:
            instructions = [
                f"Monitor Selection Mode (Monitor {self.target_monitor_index}):",
                "• Left Click + Drag: Create selection area",
                "• Ctrl + A: Select entire screen",
                "• Right-Click on box: Delete it",
                "• Modifiers (Shift/Ctrl) are DISABLED",
                "",
                "Save Options:",
                "• Double-Click empty space",
                "• Middle Mouse Button",
                "• Ctrl + S or use Control Panel"
            ]
        else:
            instructions = [
                "Controls:",
                "• Left Click + Drag: Create capture area (green)",
                "• Shift + Left Click + Drag: Exclusion area (orange)",
                "• Ctrl + Left Click + Drag: Secondary area (purple)",
                "• Ctrl + A: Select entire screen (green)",
                "• Right-Click on box: Delete it",
                "• Right-Click empty space: Menu",
                "",
                "Save Options (No Keyboard Needed!):",
                "• Double-Click empty space",
                "• Middle Mouse Button",
                "• Long-press (1s) empty space",
                "• Ctrl + S or use Control Panel"
            ]
        
        for line in instructions:
            painter.drawText(panel_x + 10, y_offset, line)
            y_offset += line_height
        
        # Restore painter state
        painter.restore()
    
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            # Clamp position to window bounds
            clamped_pos = self._clamp_position(event.pos())
            self.start_pos = clamped_pos
            self.current_pos = clamped_pos
            self.is_drawing = True
            
            if self.select_monitor_area:
                # In monitor selection mode, strictly prevent specialized rectangles
                self.drawing_excluded = False
                self.drawing_secondary = False
                self.menu_drawing_mode = False
            else:
                # Menu-selected mode should persist; otherwise use current modifiers for this drag.
                if not self.menu_drawing_mode:
                    self.drawing_excluded = bool(event.modifiers() & Qt.KeyboardModifier.ShiftModifier)
                    self.drawing_secondary = bool(event.modifiers() & Qt.KeyboardModifier.ControlModifier)
                    self.menu_drawing_mode = False
            
            # Start long-press timer (1 second)
            self.long_press_pos = event.pos()
            self.long_press_active = True
            self.long_press_timer.start(1000)
            
            self.update()
        elif event.button() == Qt.MouseButton.MiddleButton:
            # Middle mouse button to save
            logger.info("Middle mouse button pressed - saving")
            self.save_and_quit()
        elif event.button() == Qt.MouseButton.RightButton:
            # Check if clicking on a rectangle first
            rect_clicked = False
            for i, rect in enumerate(self.rectangles):
                if (rect['x'] <= event.pos().x() <= rect['x'] + rect['w'] and
                    rect['y'] <= event.pos().y() <= rect['y'] + rect['h']):
                    self._delete_rectangle_at(event.pos())
                    rect_clicked = True
                    break
            
            # If not on a rectangle, show context menu
            if not rect_clicked:
                self._show_context_menu(event.pos())
    
    def mouseMoveEvent(self, event):
        """Handle mouse movement for drawing and hover detection."""
        # Clamp position to window bounds
        clamped_pos = self._clamp_position(event.pos())
        
        # Check if mouse is over instructions panel
        if self.instructions_visible:
            mouse_over_panel = self.instructions_rect.contains(clamped_pos)
            if mouse_over_panel != self.instructions_dimmed:
                self.instructions_dimmed = mouse_over_panel
                self.update()  # Trigger repaint
        
        # Cancel long-press if mouse moves too much
        if self.long_press_active and self.long_press_pos:
            distance = (clamped_pos - self.long_press_pos).manhattanLength()
            if distance > 10:  # 10 pixel threshold
                self.long_press_timer.stop()
                self.long_press_active = False
        
        # Handle drawing
        if self.is_drawing:
            self.current_pos = clamped_pos
            self.update()
    
    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.is_drawing:
            # Stop long-press timer
            self.long_press_timer.stop()
            self.long_press_active = False
            
            self.is_drawing = False
            self.current_pos = self._clamp_position(event.pos())
            
            x1 = min(self.start_pos.x(), self.current_pos.x())
            y1 = min(self.start_pos.y(), self.current_pos.y())
            w = abs(self.current_pos.x() - self.start_pos.x())
            h = abs(self.current_pos.y() - self.start_pos.y())
            
            if w >= MIN_RECT_WIDTH and h >= MIN_RECT_HEIGHT:
                # Determine which monitor this rectangle is on
                rect_center_x = int((x1 + w // 2) * self.scale_factor_w + self.bounding_box_original['left'])
                rect_center_y = int((y1 + h // 2) * self.scale_factor_h + self.bounding_box_original['top'])
                
                monitor_index = 0
                for i, mon in enumerate(self.monitors):
                    if (mon['left'] <= rect_center_x < mon['left'] + mon['width'] and
                        mon['top'] <= rect_center_y < mon['top'] + mon['height']):
                        monitor_index = i
                        break
                
                new_rect = {
                    'x': x1,
                    'y': y1,
                    'w': w,
                    'h': h,
                    'monitor_index': monitor_index,
                    'is_excluded': self.drawing_excluded,
                    'is_secondary': self.drawing_secondary
                }
                
                self.undo_stack.append(('add', len(self.rectangles)))
                self.rectangles.append(new_rect)
                self.redo_stack.clear()
                
                logger.info(f"Added rectangle: {new_rect}")
            else:
                logger.warning(f"Rectangle too small: {w}x{h}")
            
            self.start_pos = None
            self.current_pos = None
            if not self.menu_drawing_mode:
                self.drawing_excluded = False
                self.drawing_secondary = False
            self.update()
    
    def _delete_rectangle_at(self, pos):
        """Delete rectangle at given position."""
        for i, rect in enumerate(self.rectangles):
            if (rect['x'] <= pos.x() <= rect['x'] + rect['w'] and
                rect['y'] <= pos.y() <= rect['y'] + rect['h']):
                self.undo_stack.append(('delete', i, rect.copy()))
                del self.rectangles[i]
                self.redo_stack.clear()
                logger.info(f"Deleted rectangle at index {i}")
                self.update()
                break
    
    def _clamp_position(self, pos):
        """Clamp a position to stay within the window bounds."""
        from PyQt6.QtCore import QPoint
        x = max(0, min(pos.x(), self.width() - 1))
        y = max(0, min(pos.y(), self.height() - 1))
        return QPoint(x, y)
    
    def _show_context_menu(self, pos):
        """Show context menu with save/quit options."""
        menu = QMenu(self)
        
        # Draw options (at top level)
        draw_normal_action = QAction("🟢 Draw Normal Capture Area(s)", self)
        draw_normal_action.triggered.connect(lambda: self._start_box_drawing(pos, excluded=False, secondary=False))
        menu.addAction(draw_normal_action)
        
        # Only show specific drawing options if NOT in monitor selection mode
        if not self.select_monitor_area:
            draw_exclusion_action = QAction("🟠 Draw Exclusion Area(s)", self)
            draw_exclusion_action.triggered.connect(lambda: self._start_box_drawing(pos, excluded=True, secondary=False))
            menu.addAction(draw_exclusion_action)
            
            draw_secondary_action = QAction("🟣 Draw Secondary (Menu) Area(s)", self)
            draw_secondary_action.triggered.connect(lambda: self._start_box_drawing(pos, excluded=False, secondary=True))
            menu.addAction(draw_secondary_action)
        
        menu.addSeparator()
        
        save_action = QAction("💾 Save and Quit", self)
        save_action.triggered.connect(lambda: QTimer.singleShot(0, self.save_and_quit))
        menu.addAction(save_action)
        
        menu.addSeparator()
        
        undo_action = QAction("↶ Undo", self)
        undo_action.triggered.connect(self.undo)
        undo_action.setEnabled(len(self.undo_stack) > 0)
        menu.addAction(undo_action)
        
        redo_action = QAction("↷ Redo", self)
        redo_action.triggered.connect(self.redo)
        redo_action.setEnabled(len(self.redo_stack) > 0)
        menu.addAction(redo_action)
        
        menu.addSeparator()
        
        toggle_instructions_action = QAction("Toggle Instructions", self)
        toggle_instructions_action.triggered.connect(lambda: setattr(self, 'instructions_visible', not self.instructions_visible) or self.update())
        menu.addAction(toggle_instructions_action)
        
        menu.addSeparator()
        
        quit_action = QAction("❌ Quit without Saving", self)
        quit_action.triggered.connect(lambda: QTimer.singleShot(0, self.close))
        menu.addAction(quit_action)
        
        # Show menu at cursor position
        menu.exec(self.mapToGlobal(pos))
    
    def _start_box_drawing(self, pos, excluded=False, secondary=False):
        """Start drawing a box from the context menu position."""
        # Reset any previous drawing state first
        self.is_drawing = False
        self.current_pos = None
        self.start_pos = None
        
        # Set the drawing mode flags, but DON'T start drawing yet
        # The user will click/drag to actually start drawing
        if self.select_monitor_area:
            self.drawing_excluded = False
            self.drawing_secondary = False
            self.menu_drawing_mode = False
        else:
            self.drawing_excluded = excluded
            self.drawing_secondary = secondary
            self.menu_drawing_mode = True
        
        # Set cursor to indicate drawing mode
        if excluded:
            logger.info("Drawing mode set to exclusion area - click and drag to draw")
        elif secondary:
            logger.info("Drawing mode set to secondary area - click and drag to draw")
        else:
            logger.info("Drawing mode set to normal capture area - click and drag to draw")
        
        self.update()
    
    def _show_save_menu(self):
        """Show save menu after long-press."""
        if self.long_press_active and self.long_press_pos:
            logger.info("Long-press detected - showing save menu")
            self._show_context_menu(self.long_press_pos)
            self.long_press_active = False
    
    def mouseDoubleClickEvent(self, event):
        """Handle double-click to save."""
        if event.button() == Qt.MouseButton.LeftButton:
            # Check if double-clicking on empty space (not on a rectangle)
            on_rectangle = False
            for rect in self.rectangles:
                if (rect['x'] <= event.pos().x() <= rect['x'] + rect['w'] and
                    rect['y'] <= event.pos().y() <= rect['y'] + rect['h']):
                    on_rectangle = True
                    break
            
            if not on_rectangle:
                logger.info("Double-click detected - saving")
                self.save_and_quit()
    
    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Escape:
            logger.info("Area selector cancelled")
            self.close()
        elif event.key() == Qt.Key.Key_S and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self.save_and_quit()
        elif event.key() == Qt.Key.Key_A and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self.create_fullscreen_box()
        elif event.key() == Qt.Key.Key_Z and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self.undo()
        elif event.key() == Qt.Key.Key_Y and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self.redo()
        elif event.key() == Qt.Key.Key_R:
            self.refresh_screenshot()
        elif event.key() == Qt.Key.Key_I:
            self.instructions_visible = not self.instructions_visible
            self.update()
    
    def undo(self):
        """Undo last action."""
        if not self.undo_stack:
            logger.info("Nothing to undo")
            return
        
        action = self.undo_stack.pop()
        if action[0] == 'add':
            # Undo add: remove the rectangle
            rect = self.rectangles.pop(action[1])
            self.redo_stack.append(('add', action[1], rect))
        elif action[0] == 'delete':
            # Undo delete: restore the rectangle
            self.rectangles.insert(action[1], action[2])
            self.redo_stack.append(('delete', action[1]))
        
        logger.info(f"Undid action: {action[0]}")
        self.update()
    
    def redo(self):
        """Redo last undone action."""
        if not self.redo_stack:
            logger.info("Nothing to redo")
            return
        
        action = self.redo_stack.pop()
        if action[0] == 'add':
            # Redo add: restore the rectangle
            self.rectangles.insert(action[1], action[2])
            self.undo_stack.append(('add', action[1]))
        elif action[0] == 'delete':
            # Redo delete: remove the rectangle
            rect = self.rectangles.pop(action[1])
            self.undo_stack.append(('delete', action[1], rect))
        
        logger.info(f"Redid action: {action[0]}")
        self.update()
    
    def create_fullscreen_box(self):
        """Create a rectangle covering the entire window (Ctrl+A)."""
        # Remove all existing green (normal) rectangles first
        remaining_rects = []
        removed_indices = []
        
        for i, rect in enumerate(self.rectangles):
            if rect['is_excluded'] or rect.get('is_secondary', False):
                # Keep excluded and secondary rectangles
                remaining_rects.append(rect)
            else:
                # Track removed green rectangles for undo
                removed_indices.append((i, rect.copy()))
        
        # Add all removed rectangles to undo stack (in reverse order so undo works correctly)
        for idx, rect in reversed(removed_indices):
            self.undo_stack.append(('delete', len(remaining_rects), rect))
        
        # Update rectangles list
        num_removed = len(removed_indices)
        self.rectangles = remaining_rects
        
        if num_removed > 0:
            logger.info(f"Removed {num_removed} existing green rectangle(s)")
        
        # Determine which monitor this is on
        monitor_index = 0
        if self.monitors:
            monitor_index = self.monitors[0]['index']
        
        # Create a green (normal) rectangle covering the entire visible area
        new_rect = {
            'x': 0,
            'y': 0,
            'w': self.width(),
            'h': self.height(),
            'monitor_index': monitor_index,
            'is_excluded': False,
            'is_secondary': False
        }
        
        self.undo_stack.append(('add', len(self.rectangles)))
        self.rectangles.append(new_rect)
        self.redo_stack.clear()
        
        logger.info(f"Created fullscreen rectangle: {new_rect}")
        self.update()
    
    def refresh_screenshot(self):
        """Refresh the screenshot from OBS without blocking the UI."""
        if not self.use_obs_screenshot:
            logger.info("Refresh is only available in OBS screenshot mode")
            return
        
        logger.info("Refreshing OBS screenshot...")
        
        # Use QTimer.singleShot to run the capture asynchronously
        def do_refresh():
            try:
                # Capture new screenshot
                new_screenshot = obs.get_screenshot_PIL(compression=90, img_format='jpg')
                
                if not new_screenshot:
                    logger.warning("Failed to capture new screenshot")
                    return
                
                # Scale down for performance
                new_screenshot, _ = scale_pil_image_to_minimum_bounds(
                    new_screenshot,
                    resample=Image.LANCZOS,
                )
                
                # Convert PIL Image to QPixmap
                img_to_convert = new_screenshot
                if img_to_convert.mode in ('RGBA', 'LA', 'P'):
                    if img_to_convert.mode == 'P':
                        img_to_convert = img_to_convert.convert('RGBA')
                    rgb_img = Image.new('RGB', img_to_convert.size, (255, 255, 255))
                    rgb_img.paste(img_to_convert, mask=img_to_convert.split()[-1] if img_to_convert.mode == 'RGBA' else None)
                    img_to_convert = rgb_img
                
                img_data = img_to_convert.tobytes('raw', 'RGB')
                qimage = QImage(img_data, img_to_convert.width, img_to_convert.height,
                              img_to_convert.width * 3, QImage.Format.Format_RGB888)
                
                # Update the screenshot and pixmap
                self.screenshot_img = new_screenshot
                self.pixmap = QPixmap.fromImage(qimage)
                
                # Trigger repaint
                self.update()
                
                logger.info("Screenshot refreshed successfully")
                
            except Exception as e:
                logger.error(f"Failed to refresh screenshot: {e}")
        
        # Execute refresh after a short delay to avoid blocking
        QTimer.singleShot(0, do_refresh)
    
    def save_and_quit(self):
        """Save rectangles and quit."""
        logger.info("Saving rectangles...")
        
        # =========================================================
        # SPECIAL BRANCH: Monitor Area Selection
        # =========================================================
        if self.select_monitor_area:
            final_rects = []
            
            # Get actual monitor dimensions (original, before scaling)
            monitor_width = self.monitor_geometry['width'] if self.monitor_geometry else self.screenshot_img.width
            monitor_height = self.monitor_geometry['height'] if self.monitor_geometry else self.screenshot_img.height

            for rect in self.rectangles:
                # Convert from widget/scaled coords back to monitor pixel coords
                x_orig = int(rect['x'] * self.scale_factor_w)
                y_orig = int(rect['y'] * self.scale_factor_h)
                w_orig = int(rect['w'] * self.scale_factor_w)
                h_orig = int(rect['h'] * self.scale_factor_h)
                
                # Convert to percentage coordinates (0-1 range)
                x_pct = x_orig / monitor_width if monitor_width > 0 else 0
                y_pct = y_orig / monitor_height if monitor_height > 0 else 0
                w_pct = w_orig / monitor_width if monitor_width > 0 else 0
                h_pct = h_orig / monitor_height if monitor_height > 0 else 0
                
                final_rects.append({
                    "x": x_pct,
                    "y": y_pct,
                    "w": w_pct,
                    "h": h_pct
                })
            
            output_data = {
                "monitor_index": self.target_monitor_index,
                "coordinate_system": COORD_SYSTEM_PERCENTAGE,
                "rects": final_rects
            }

            # Print to stdout
            print(json.dumps(output_data, indent=2))
            
            # Save to specific file with scene name + _overlay.json
            try:
                scene = sanitize_filename(self.scene or "Default")
                ocr_config_dir = get_ocr_config_path()
                out_path = os.path.join(ocr_config_dir, f"{scene}_overlay.json")
                with open(out_path, 'w') as f:
                    json.dump(output_data, f, indent=2)
                logger.success(f"Saved {len(final_rects)} monitor regions and index {self.target_monitor_index} to {out_path}")
            except Exception as e:
                logger.error(f"Failed to save monitor selection: {e}")
            
            self.close()
            return
        # =========================================================
        
        win_geom = self.target_window_geometry
        win_w, win_h, win_l, win_t = win_geom['width'], win_geom['height'], win_geom['left'], win_geom['top']
        
        # Convert rectangles to percentage-based coordinates
        output_rectangles = []
        for rect in self.rectangles:
            # Convert back from widget to original capture coords
            x_abs = int(rect['x'] * self.scale_factor_w + self.bounding_box_original['left'])
            y_abs = int(rect['y'] * self.scale_factor_h + self.bounding_box_original['top'])
            
            # Convert to percentage relative to target window
            x_pct = (x_abs - win_l) / win_w if win_w > 0 else 0
            y_pct = (y_abs - win_t) / win_h if win_h > 0 else 0
            w_abs = int(rect['w'] * self.scale_factor_w)
            h_abs = int(rect['h'] * self.scale_factor_h)
            w_pct = w_abs / win_w if win_w > 0 else 0
            h_pct = h_abs / win_h if win_h > 0 else 0
            
            monitor = next((m for m in self.monitors if m['index'] == rect['monitor_index']), self.monitors[0])
            
            output_rectangles.append({
                "monitor": monitor,
                "coordinates": [x_pct, y_pct, w_pct, h_pct],
                "is_excluded": rect['is_excluded'],
                "is_secondary": rect.get('is_secondary', False)
            })
        
        config_data = {
            "scene": self.scene,
            "coordinate_system": COORD_SYSTEM_PERCENTAGE,
            "rectangles": output_rectangles,
            "window_geometry": win_geom
        }
        
        print(config_data)
        
        config_path = get_scene_ocr_config_path(self.use_window_as_config, self.window_name)
        
        try:
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2)
            logger.success(f"Saved {len(output_rectangles)} rectangles to {config_path}")
        except Exception as e:
            logger.error(f"Failed to save config: {e}")
        
        self.close()
    
    def closeEvent(self, event):
        # Close control panel if it exists
        if self.control_panel:
            self.control_panel.close()
            self.control_panel = None
        
        if self.on_complete:
            # Return the rectangles in the expected format
            result_rectangles = []
            
            # Helper for export logic
            if self.select_monitor_area:
                 for rect in self.rectangles:
                     result_rectangles.append({
                        'x': int(rect['x'] * self.scale_factor_w),
                        'y': int(rect['y'] * self.scale_factor_h),
                        'width': int(rect['w'] * self.scale_factor_w),
                        'height': int(rect['h'] * self.scale_factor_h),
                        'is_excluded': False,
                        'is_secondary': False
                     })
            else:
                win_geom = self.target_window_geometry
                win_w, win_h, win_l, win_t = win_geom['width'], win_geom['height'], win_geom['left'], win_geom['top']
                
                for rect in self.rectangles:
                    # Convert back from widget to original capture coords
                    x_abs = int(rect['x'] * self.scale_factor_w + self.bounding_box_original['left'])
                    y_abs = int(rect['y'] * self.scale_factor_h + self.bounding_box_original['top'])
                    
                    # Convert to percentage relative to target window
                    x_pct = (x_abs - win_l) / win_w if win_w > 0 else 0
                    y_pct = (y_abs - win_t) / win_h if win_h > 0 else 0
                    w_abs = int(rect['w'] * self.scale_factor_w)
                    h_abs = int(rect['h'] * self.scale_factor_h)
                    w_pct = w_abs / win_w if win_w > 0 else 0
                    h_pct = h_abs / win_h if win_h > 0 else 0
                    
                    result_rectangles.append({
                        'x': x_pct,
                        'y': y_pct,
                        'width': w_pct,
                        'height': h_pct,
                        'is_excluded': rect['is_excluded'],
                        'is_secondary': rect.get('is_secondary', False)
                    })
            
            self.on_complete(result_rectangles)
        
        # Accept the close event
        event.accept()
        
        # Ensure the widget is properly destroyed
        self.deleteLater()
        
        # Quit the application after a brief delay to ensure cleanup
        QTimer.singleShot(100, lambda: QApplication.instance().quit() if QApplication.instance() else None)


def show_area_selector(window_name, use_window_as_config=False, use_obs_screenshot=False, on_complete=None):
    """
    Displays a Qt-based area selector for OCR configuration.
    
    :param window_name: Name of target window (or empty if using OBS)
    :param use_window_as_config: Whether to use window name for config path
    :param use_obs_screenshot: Whether to use OBS screenshot instead of window capture
    :param on_complete: Callback function that receives the selection result
    """
    logger.info("show_area_selector called")
    logger.info(f"  window_name: '{window_name}'")
    logger.info(f"  use_window_as_config: {use_window_as_config}")
    logger.info(f"  use_obs_screenshot: {use_obs_screenshot}")
    
    # Create QApplication if it doesn't exist
    app = QApplication.instance()
    created_app = False
    if app is None:
        logger.info("Creating new QApplication instance...")
        app = QApplication(sys.argv)
        created_app = True
        logger.info("QApplication created successfully")
    else:
        logger.info("Using existing QApplication instance")
    
    # Create and show the selector widget
    logger.info("Creating OWOCRAreaSelectorWidget...")
    try:
        _selector = OWOCRAreaSelectorWidget(window_name, use_window_as_config, use_obs_screenshot, on_complete)
        logger.info("OWOCRAreaSelectorWidget created successfully")
    except Exception as e:
        logger.exception(f"Failed to create OWOCRAreaSelectorWidget: {e}")
        raise
    
    # Run the application event loop only if we created it
    if created_app:
        logger.info("Starting Qt event loop...")
        app.exec()
        logger.info("Qt event loop exited")
        # Clean up
        app.quit()
        del app
        logger.info("QApplication cleaned up")
    
    return _selector

def show_monitor_selector(monitor_index=0, on_complete=None):
    """
    Displays a Qt-based area selector for a specific monitor defined in config.
    Captures via MSS, scales down, and allows basic rectangle selection.
    """
    logger.info(f"show_monitor_selector called with monitor_index={monitor_index}")
    
    app = QApplication.instance()
    created_app = False
    if app is None:
        logger.info("Creating new QApplication instance...")
        app = QApplication(sys.argv)
        created_app = True
        logger.info("QApplication created successfully")
    else:
        logger.info("Using existing QApplication instance")
    
    logger.info("Creating OWOCRAreaSelectorWidget in monitor selection mode...")
    try:
        _selector = OWOCRAreaSelectorWidget(
            window_name="", 
            use_window_as_config=False, 
            use_obs_screenshot=False, 
            on_complete=on_complete,
            select_monitor_area=True,
            monitor_index=monitor_index
        )
        logger.info("OWOCRAreaSelectorWidget created successfully")
    except Exception as e:
        logger.exception(f"Failed to create OWOCRAreaSelectorWidget: {e}")
        raise
    
    if created_app:
        logger.info("Starting Qt event loop...")
        app.exec()
        logger.info("Qt event loop exited")
        app.quit()
        del app
        logger.info("QApplication cleaned up")
    
    return _selector

if __name__ == "__main__":
    try:
        logger.info("=" * 60)
        logger.info("OWOCR Area Selector starting...")
        logger.info(f"Python version: {sys.version}")
        logger.info(f"Arguments: {sys.argv}")
        logger.info("=" * 60)
        
        parser = argparse.ArgumentParser(description="OWOCR Area Selector")
        parser.add_argument("window_name", nargs='?', default="", help="Target window name")
        parser.add_argument("--use-window-as-config", action="store_true", help="Use window name for config")
        parser.add_argument("--obs", action="store_true", default=True, help="Use OBS screenshot")
        parser.add_argument("--monitor", action="store", default=None, help="Use monitor selection mode with index (0=Primary)")
        
        logger.info("Parsing command line arguments...")
        args = parser.parse_args()
        logger.info(f"Parsed arguments: window_name='{args.window_name}', use_window_as_config={args.use_window_as_config}, obs={args.obs}, monitor={args.monitor}")
        
        logger.info("Setting DPI awareness...")
        set_dpi_awareness()
        logger.info("DPI awareness set successfully")
        
        def on_complete(rectangles):
            logger.info(f"Completed with {len(rectangles)} rectangles")
        
        if args.monitor is not None:
            logger.info(f"Starting monitor selection mode for monitor index: {args.monitor}")
            show_monitor_selector(monitor_index=int(args.monitor), on_complete=on_complete)
        else:
            logger.info(f"Starting area selector for window: '{args.window_name}', OBS mode: {args.obs}")
            show_area_selector(args.window_name, args.use_window_as_config, args.obs, on_complete)
        
        logger.success("OWOCR Area Selector completed successfully")
    except Exception as e:
        logger.exception(f"Fatal error in main: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
