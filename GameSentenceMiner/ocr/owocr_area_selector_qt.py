import argparse
import json
import sys
from PyQt6.QtWidgets import QApplication, QWidget, QPushButton, QVBoxLayout, QLabel, QMenu
from PyQt6.QtCore import Qt, QRect, QTimer
from PyQt6.QtGui import QPainter, QPen, QColor, QPixmap, QImage, QBrush, QAction
from PIL import Image

from GameSentenceMiner import obs
from GameSentenceMiner.ocr.gsm_ocr_config import set_dpi_awareness, get_window, get_scene_ocr_config_path
from GameSentenceMiner.util.configuration import logger

MIN_RECT_WIDTH = 25
MIN_RECT_HEIGHT = 25
COORD_SYSTEM_PERCENTAGE = "percentage"


def scale_down_width_height(width, height):
    """Scale down image dimensions based on aspect ratio."""
    if width == 0 or height == 0:
        return width, height
    aspect_ratio = width / height
    if aspect_ratio > 2.66:
        return 1920, 540
    elif aspect_ratio > 2.33:
        return 1920, 800
    elif aspect_ratio > 1.77:
        return 1280, 720
    elif aspect_ratio > 1.6:
        return 1280, 800
    elif aspect_ratio > 1.33:
        return 960, 720
    elif aspect_ratio > 1.25:
        return 900, 720
    elif aspect_ratio > 1.5:
        return 1080, 720
    else:
        logger.warning(f"Unrecognized aspect ratio {aspect_ratio}. Using original resolution.")
        return width, height


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
        
        # Create layout
        layout = QVBoxLayout()
        layout.setSpacing(5)
        layout.setContentsMargins(10, 10, 10, 10)
        
        # Instructions label
        instructions = QLabel(
            "How to Use:\n"
            "• Left Click + Drag: Create a capture area (green).\n"
            "• Shift + Left Click + Drag: Create an exclusion area (orange).\n"
            "• Ctrl + Left Click + Drag: Create a secondary (menu) area (purple).\n"
            "• Right-Click on a box: Delete it."
        )
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
    def __init__(self, window_name, use_window_as_config=False, use_obs_screenshot=False, on_complete=None):
        super().__init__()
        self.window_name = window_name
        self.use_window_as_config = use_window_as_config
        self.use_obs_screenshot = use_obs_screenshot
        self.on_complete = on_complete
        self.scene = None
        
        self.screenshot_img = None
        self.pixmap = None
        self.target_window_geometry = {}
        self.bounding_box = {}
        self.rectangles = []
        self.monitors = []
        
        self.start_pos = None
        self.current_pos = None
        self.is_drawing = False
        self.drawing_excluded = False
        self.drawing_secondary = False
        
        self.undo_stack = []
        self.redo_stack = []
        
        self.instructions_visible = True
        self.instructions_dimmed = False
        self.instructions_rect = QRect(20, 20, 400, 320)  # Panel position and size (increased height)
        
        self.control_panel = None  # Control panel widget
        
        # Long-press detection for save menu
        self.long_press_timer = QTimer()
        self.long_press_timer.timeout.connect(self._show_save_menu)
        self.long_press_pos = None
        self.long_press_active = False
        
        # Initialize
        self._initialize()
        self.init_ui()
    
    def _initialize(self):
        """Initialize OBS connection and capture screenshot."""
        try:
            obs.connect_to_obs_sync()
            self.scene = obs.get_current_scene()
            
            if self.use_obs_screenshot:
                self._init_obs_screenshot()
            else:
                self._init_window_capture()
            
            self._load_existing_rectangles()
            
            # Convert PIL Image to QPixmap
            img_to_convert = self.screenshot_img
            if img_to_convert.mode in ('RGBA', 'LA', 'P'):
                if img_to_convert.mode == 'P':
                    img_to_convert = img_to_convert.convert('RGBA')
                rgb_img = Image.new('RGB', img_to_convert.size, (255, 255, 255))
                rgb_img.paste(img_to_convert, mask=img_to_convert.split()[-1] if img_to_convert.mode == 'RGBA' else None)
                img_to_convert = rgb_img
            
            img_data = img_to_convert.tobytes('raw', 'RGB')
            qimage = QImage(img_data, img_to_convert.width, img_to_convert.height,
                          img_to_convert.width * 3, QImage.Format.Format_RGB888)
            self.pixmap = QPixmap.fromImage(qimage)
            
        except Exception as e:
            logger.error(f"Failed to initialize: {e}")
            raise
    
    def _init_obs_screenshot(self):
        """Initialize using OBS screenshot."""
        sources = obs.get_active_video_sources()
        best_source = obs.get_best_source_for_screenshot()
        if len(sources) > 1:
            logger.warning(f"Multiple active video sources found. Using '{best_source.get('sourceName')}'")
        
        self.screenshot_img = obs.get_screenshot_PIL(compression=100, img_format='jpg')
        if not self.screenshot_img:
            raise RuntimeError("Failed to get OBS screenshot, is OBS running with a valid video source?")
        
        # Scale down for performance
        self.screenshot_img = self.screenshot_img.resize(
            scale_down_width_height(self.screenshot_img.width, self.screenshot_img.height),
            Image.LANCZOS
        )
        
        self.target_window_geometry = {
            "left": 0,
            "top": 0,
            "width": self.screenshot_img.width,
            "height": self.screenshot_img.height
        }
        self.bounding_box = self.target_window_geometry.copy()
        
        # Mock monitor for OBS mode
        self.monitors = [{'index': 0, 'left': 0, 'top': 0,
                        'width': self.screenshot_img.width,
                        'height': self.screenshot_img.height}]
        
        logger.info(f"OBS Screenshot: {self.screenshot_img.width}x{self.screenshot_img.height}")
    
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
            
            self.bounding_box = {
                'left': left,
                'top': top,
                'width': right - left,
                'height': bottom - top
            }
            
            # Capture entire desktop
            sct_img = sct.grab(self.bounding_box)
            self.screenshot_img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
        
        logger.info(f"Captured {self.bounding_box['width']}x{self.bounding_box['height']} desktop area")
    
    def _load_existing_rectangles(self):
        """Load rectangles from config file."""
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
                    
                    # Convert from percentage to absolute pixels (relative to bounding box)
                    x_abs = int((x_pct * win_w) + win_l - self.bounding_box['left'])
                    y_abs = int((y_pct * win_h) + win_t - self.bounding_box['top'])
                    w_abs = int(w_pct * win_w)
                    h_abs = int(h_pct * win_h)
                    
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
    
    def init_ui(self):
        # Set window properties
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint |
                           Qt.WindowType.WindowStaysOnTopHint |
                           Qt.WindowType.Tool |
                           Qt.WindowType.BypassWindowManagerHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, False)
        
        # Set window title
        self.setWindowTitle('OWOCR Area Selector')
        
        # For OBS mode, center the window on the primary monitor
        if self.use_obs_screenshot:
            screen = QApplication.primaryScreen()
            if screen:
                screen_geometry = screen.geometry()
                # Center the window
                x = screen_geometry.x() + (screen_geometry.width() - self.bounding_box['width']) // 2
                y = screen_geometry.y() + (screen_geometry.height() - self.bounding_box['height']) // 2
                self.move(x, y)
                self.resize(self.bounding_box['width'], self.bounding_box['height'])
        else:
            # Set geometry to bounding box for multi-monitor
            self.move(self.bounding_box['left'], self.bounding_box['top'])
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
        alpha = 50 if self.instructions_dimmed else 230
        text_alpha = 80 if self.instructions_dimmed else 255
        border_alpha = 30 if self.instructions_dimmed else 100
        
        # Background
        painter.fillRect(panel_x, panel_y, panel_width, panel_height, QColor(0, 0, 0, alpha))
        painter.setPen(QPen(QColor(255, 255, 255, border_alpha), 1))
        painter.drawRect(panel_x, panel_y, panel_width, panel_height)
        
        # Title - always use full green, not affected by dimming
        painter.setPen(QColor(76, 175, 80))
        painter.drawText(panel_x + 10, panel_y + 25, "OWOCR Area Selector")
        
        # Instructions
        painter.setPen(QColor(255, 255, 255, text_alpha))
        y_offset = panel_y + 55
        line_height = 20
        
        instructions = [
            "Controls:",
            "• Left Click + Drag: Create capture area (green)",
            "• Shift + Left Click + Drag: Exclusion area (orange)",
            "• Ctrl + Left Click + Drag: Secondary area (purple)",
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
            self.start_pos = event.pos()
            self.current_pos = event.pos()
            self.is_drawing = True
            self.drawing_excluded = bool(event.modifiers() & Qt.KeyboardModifier.ShiftModifier)
            self.drawing_secondary = bool(event.modifiers() & Qt.KeyboardModifier.ControlModifier)
            
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
        # Check if mouse is over instructions panel
        if self.instructions_visible:
            mouse_over_panel = self.instructions_rect.contains(event.pos())
            if mouse_over_panel != self.instructions_dimmed:
                self.instructions_dimmed = mouse_over_panel
                self.update()  # Trigger repaint
        
        # Cancel long-press if mouse moves too much
        if self.long_press_active and self.long_press_pos:
            distance = (event.pos() - self.long_press_pos).manhattanLength()
            if distance > 10:  # 10 pixel threshold
                self.long_press_timer.stop()
                self.long_press_active = False
        
        # Handle drawing
        if self.is_drawing:
            self.current_pos = event.pos()
            self.update()
    
    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.is_drawing:
            # Stop long-press timer
            self.long_press_timer.stop()
            self.long_press_active = False
            
            self.is_drawing = False
            self.current_pos = event.pos()
            
            x1 = min(self.start_pos.x(), self.current_pos.x())
            y1 = min(self.start_pos.y(), self.current_pos.y())
            w = abs(self.current_pos.x() - self.start_pos.x())
            h = abs(self.current_pos.y() - self.start_pos.y())
            
            if w >= MIN_RECT_WIDTH and h >= MIN_RECT_HEIGHT:
                # Determine which monitor this rectangle is on
                rect_center_x = x1 + w // 2 + self.bounding_box['left']
                rect_center_y = y1 + h // 2 + self.bounding_box['top']
                
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
    
    def _show_context_menu(self, pos):
        """Show context menu with save/quit options."""
        menu = QMenu(self)
        
        # Draw options (at top level)
        draw_normal_action = QAction("🟢 Draw Normal Capture Area", self)
        draw_normal_action.triggered.connect(lambda: self._start_box_drawing(pos, excluded=False, secondary=False))
        menu.addAction(draw_normal_action)
        
        draw_exclusion_action = QAction("🟠 Draw Exclusion Area", self)
        draw_exclusion_action.triggered.connect(lambda: self._start_box_drawing(pos, excluded=True, secondary=False))
        menu.addAction(draw_exclusion_action)
        
        draw_secondary_action = QAction("🟣 Draw Secondary (Menu) Area", self)
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
        # Simulate starting a box draw
        self.start_pos = pos
        self.current_pos = pos
        self.is_drawing = True
        self.drawing_excluded = excluded
        self.drawing_secondary = secondary
        self.update()
        
        # Set cursor to indicate drawing mode
        if excluded:
            logger.info("Started drawing exclusion area from menu")
        elif secondary:
            logger.info("Started drawing secondary area from menu")
        else:
            logger.info("Started drawing normal capture area from menu")
    
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
        elif event.key() == Qt.Key.Key_Z and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self.undo()
        elif event.key() == Qt.Key.Key_Y and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self.redo()
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
    
    def save_and_quit(self):
        """Save rectangles and quit."""
        logger.info("Saving rectangles...")
        
        win_geom = self.target_window_geometry
        win_w, win_h, win_l, win_t = win_geom['width'], win_geom['height'], win_geom['left'], win_geom['top']
        
        # Convert rectangles to percentage-based coordinates
        output_rectangles = []
        for rect in self.rectangles:
            # Convert back from bounding-box-relative to absolute
            x_abs = rect['x'] + self.bounding_box['left']
            y_abs = rect['y'] + self.bounding_box['top']
            
            # Convert to percentage relative to target window
            x_pct = (x_abs - win_l) / win_w if win_w > 0 else 0
            y_pct = (y_abs - win_t) / win_h if win_h > 0 else 0
            w_pct = rect['w'] / win_w if win_w > 0 else 0
            h_pct = rect['h'] / win_h if win_h > 0 else 0
            
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
            logger.info(f"Saved {len(output_rectangles)} rectangles to {config_path}")
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
            win_geom = self.target_window_geometry
            win_w, win_h, win_l, win_t = win_geom['width'], win_geom['height'], win_geom['left'], win_geom['top']
            
            for rect in self.rectangles:
                # Convert back from bounding-box-relative to absolute
                x_abs = rect['x'] + self.bounding_box['left']
                y_abs = rect['y'] + self.bounding_box['top']
                
                # Convert to percentage relative to target window
                x_pct = (x_abs - win_l) / win_w if win_w > 0 else 0
                y_pct = (y_abs - win_t) / win_h if win_h > 0 else 0
                w_pct = rect['w'] / win_w if win_w > 0 else 0
                h_pct = rect['h'] / win_h if win_h > 0 else 0
                
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
    # Create QApplication if it doesn't exist
    app = QApplication.instance()
    created_app = False
    if app is None:
        app = QApplication(sys.argv)
        created_app = True
    
    # Create and show the selector widget
    _selector = OWOCRAreaSelectorWidget(window_name, use_window_as_config, use_obs_screenshot, on_complete)
    
    # Run the application event loop only if we created it
    if created_app:
        app.exec()
        # Clean up
        app.quit()
        del app
    
    return _selector


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OWOCR Area Selector")
    parser.add_argument("window_name", nargs='?', default="", help="Target window name")
    parser.add_argument("--use-window-as-config", action="store_true", help="Use window name for config")
    parser.add_argument("--obs", action="store_true", default=True, help="Use OBS screenshot")
    
    args = parser.parse_args()
    
    set_dpi_awareness()
    
    def on_complete(rectangles):
        logger.info(f"Completed with {len(rectangles)} rectangles")
    
    show_area_selector(args.window_name, args.use_window_as_config, args.obs, on_complete)
