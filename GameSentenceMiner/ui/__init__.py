import json
import os
from PyQt6.QtCore import QPoint, QRect, QSize
from PyQt6.QtWidgets import QWidget, QApplication
from enum import Enum

from GameSentenceMiner.util.config.configuration import logger, get_app_directory


class WindowId(Enum):
    ANKI_CONFIRMATION = "anki_confirmation"
    FURIGANA_FILTER = "furigana_filter"
    CONFIG_GUI = "config_gui"
    SCREENSHOT_SELECTOR = "screenshot_selector"
    SCREEN_CROPPER = "screen_cropper"

class WindowStateManager:
    """
    Manages saving and restoring window positions/sizes to a JSON file.
    """
    def __init__(self, file_path: str = None):
        if file_path is None:
            directory = get_app_directory()
            self.file_path = os.path.join(directory, "window_layout.json")
        else:
            self.file_path = file_path
            
        # Initial load to get data into memory
        self.data = self._load_data()

    def _load_data(self) -> dict:
        if os.path.exists(self.file_path):
            try:
                with open(self.file_path, 'r', encoding='utf-8') as f:
                    loaded = json.load(f)
                    if isinstance(loaded, dict):
                        return loaded
                    logger.warning("Window state file is not a JSON object; resetting state.")
                    return {}
            except Exception as e:
                logger.error(f"Failed to load window state: {e}")
                return {}
        return {}

    def _save_data(self):
        try:
            directory = os.path.dirname(self.file_path)
            if directory:
                os.makedirs(directory, exist_ok=True)
            with open(self.file_path, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, indent=4)
        except Exception as e:
            logger.error(f"Failed to save window state: {e}")

    def restore_geometry(self, window: QWidget, window_id: WindowId) -> bool:
        """
        Applies saved geometry to the window if it exists.
        Returns True if restored, False if not found.
        """
        # Handle both Enum and string (just in case)
        key = window_id.value if isinstance(window_id, WindowId) else str(window_id)
        
        # Refresh data in case another window saved recently
        self.data = self._load_data()

        if key in self.data:
            geom = self.data[key]
            try:
                if not isinstance(geom, dict):
                    logger.warning(f"Invalid window geometry payload type for {key}: {type(geom).__name__}")
                    return False

                target_rect = self._resolve_geometry(window, geom)
                if target_rect is None:
                    logger.warning(f"Invalid geometry for {key}, skipping restore.")
                    return False

                # Resize first, then move so frame calculations are stable across platforms.
                window.resize(target_rect.size())
                window.move(target_rect.topLeft())
                return True
            except Exception as e:
                logger.error(f"Error restoring geometry for {key}: {e}")
        return False

    def center_window(self, window: QWidget) -> bool:
        """
        Places the window near the center of the best available screen.
        Returns True if centered, False if no screen is available.
        """
        try:
            screens = QApplication.screens()
            if not screens:
                return False

            anchor = window.pos()
            screen = QApplication.screenAt(anchor) or QApplication.primaryScreen() or screens[0]
            available = screen.availableGeometry()

            width = max(1, min(window.width(), available.width()))
            height = max(1, min(window.height(), available.height()))

            x = available.x() + max(0, (available.width() - width) // 2)
            y = available.y() + max(0, (available.height() - height) // 2)

            window.resize(width, height)
            window.move(x, y)
            return True
        except Exception as e:
            logger.error(f"Error centering window: {e}")
            return False

    @staticmethod
    def _to_int(value):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None

    def _resolve_geometry(self, window: QWidget, geom: dict) -> QRect | None:
        x = self._to_int(geom.get('x'))
        y = self._to_int(geom.get('y'))
        width = self._to_int(geom.get('w'))
        height = self._to_int(geom.get('h'))

        if None in (x, y, width, height):
            return None

        # Keep width/height sane before applying screen clamps.
        min_width = max(1, int(window.minimumWidth() or 1))
        min_height = max(1, int(window.minimumHeight() or 1))
        width = max(min_width, width)
        height = max(min_height, height)

        max_width = int(window.maximumWidth() or 0)
        max_height = int(window.maximumHeight() or 0)
        if 0 < max_width < 16777215:
            width = min(width, max_width)
        if 0 < max_height < 16777215:
            height = min(height, max_height)

        return self._fit_rect_to_screens(QRect(x, y, width, height))

    def _fit_rect_to_screens(self, rect: QRect) -> QRect | None:
        """
        Fits the rectangle to the nearest available screen so stale/off-screen positions
        still restore to a sensible location.
        """
        try:
            screens = QApplication.screens()
            if not screens:
                return None

            available_geometries = [screen.availableGeometry() for screen in screens]
            target_screen = self._pick_best_screen(rect, available_geometries)
            if target_screen is None:
                return None

            fitted_size = QSize(
                max(1, min(rect.width(), target_screen.width())),
                max(1, min(rect.height(), target_screen.height())),
            )

            min_x = target_screen.left()
            max_x = target_screen.right() - fitted_size.width() + 1
            min_y = target_screen.top()
            max_y = target_screen.bottom() - fitted_size.height() + 1

            clamped_x = min_x if max_x < min_x else max(min_x, min(rect.x(), max_x))
            clamped_y = min_y if max_y < min_y else max(min_y, min(rect.y(), max_y))

            return QRect(QPoint(clamped_x, clamped_y), fitted_size)
        except Exception as e:
            logger.error(f"Error fitting window geometry to screens: {e}")
            return None

    def _pick_best_screen(self, rect: QRect, screens: list[QRect]) -> QRect | None:
        if not screens:
            return None

        # Prefer the screen with the largest overlap (common case when monitor layout changed).
        best_overlap = 0
        best_screen = None
        for screen in screens:
            intersection = rect.intersected(screen)
            overlap = max(0, intersection.width()) * max(0, intersection.height())
            if overlap > best_overlap:
                best_overlap = overlap
                best_screen = screen

        if best_screen is not None:
            return best_screen

        # If there is no overlap, choose nearest screen center as a best-guess fallback.
        rect_center = rect.center()

        def distance_sq(point_a: QPoint, point_b: QPoint) -> int:
            dx = point_a.x() - point_b.x()
            dy = point_a.y() - point_b.y()
            return dx * dx + dy * dy

        return min(screens, key=lambda screen: distance_sq(rect_center, screen.center()))

    def save_geometry(self, window: QWidget, window_id: WindowId):
        """
        Saves the current geometry of the window.
        """
        key = window_id.value if isinstance(window_id, WindowId) else str(window_id)
        
        # If minimized/maximized/fullscreen, preserve the "normal" window geometry.
        geometry = window.normalGeometry() if (window.isMinimized() or window.isMaximized() or window.isFullScreen()) else window.geometry()

        if geometry.width() <= 1 or geometry.height() <= 1:
            logger.debug(f"Skipping geometry save for {key}: invalid dimensions {geometry.width()}x{geometry.height()}")
            return
        
        # Reload current file state to ensure we don't overwrite other windows' updates
        current_file_data = self._load_data()
        
        current_file_data[key] = {
            'x': geometry.x(),
            'y': geometry.y(),
            'w': geometry.width(),
            'h': geometry.height()
        }
        
        self.data = current_file_data
        self._save_data()
        
window_state_manager = WindowStateManager()
