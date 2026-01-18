import os
import json
from enum import Enum
from PyQt6.QtWidgets import QWidget, QApplication
from PyQt6.QtCore import QRect
from GameSentenceMiner.util.configuration import logger, get_app_directory

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
                    return json.load(f)
            except Exception as e:
                logger.error(f"Failed to load window state: {e}")
                return {}
        return {}

    def _save_data(self):
        try:
            os.makedirs(os.path.dirname(self.file_path), exist_ok=True)
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
                if all(k in geom for k in ('x', 'y', 'w', 'h')):
                    # Validate position is within available screens
                    if self._is_position_valid(geom['x'], geom['y'], geom['w'], geom['h']):
                        window.move(geom['x'], geom['y'])
                        window.resize(geom['w'], geom['h'])
                        return True
                    else:
                        logger.warning(f"Saved position for {key} is outside available screens, skipping restore")
            except Exception as e:
                logger.error(f"Error restoring geometry for {key}: {e}")
        return False

    def _is_position_valid(self, x: int, y: int, width: int, height: int) -> bool:
        """
        Checks if a window position is fully visible on any available screen.
        Returns True if the window would be fully visible, False otherwise.
        """
        try:
            # Create a rectangle representing the window
            window_rect = QRect(x, y, width, height)
            
            # Check if window is fully contained within any available screen
            for screen in QApplication.screens():
                screen_geom = screen.geometry()
                if screen_geom.contains(window_rect):
                    return True
            
            return False
        except Exception as e:
            logger.error(f"Error validating window position: {e}")
            # If validation fails, assume position is invalid to be safe
            return False

    def save_geometry(self, window: QWidget, window_id: WindowId):
        """
        Saves the current geometry of the window.
        """
        key = window_id.value if isinstance(window_id, WindowId) else str(window_id)
        
        # Use pos() and size() for top-level windows to get actual screen position
        # geometry() can return position relative to parent (often 0,0 for top-level windows)
        pos = window.pos()
        size = window.size()
        
        # Reload current file state to ensure we don't overwrite other windows' updates
        current_file_data = self._load_data()
        
        current_file_data[key] = {
            'x': pos.x(),
            'y': pos.y(),
            'w': size.width(),
            'h': size.height()
        }
        
        self.data = current_file_data
        self._save_data()
        
window_state_manager = WindowStateManager()