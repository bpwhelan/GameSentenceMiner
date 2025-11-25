import sys
import asyncio
from queue import Queue

from PyQt6.QtWidgets import QApplication, QInputDialog
from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtGui import QIcon

from GameSentenceMiner.ui.anki_confirmation_qt import show_anki_confirmation
from GameSentenceMiner.ui.screenshot_selector_qt import show_screenshot_selector
from GameSentenceMiner.ui.furigana_filter_preview_qt import show_furigana_filter_preview
from GameSentenceMiner.ocr.ss_picker_qt import show_screen_cropper
from GameSentenceMiner.ui.config_gui_qt import ConfigWindow
from GameSentenceMiner.util.configuration import get_pickaxe_png_path, gsm_state, logger

_qt_app = None
_config_window = None
_dialog_manager = None


class DialogManager(QObject):
    """
    A thread-safe manager to show dialogs from any thread.
    It lives on the main GUI thread and listens for signals to execute actions.
    """
    _execute_on_gui_thread = pyqtSignal(object)

    def __init__(self):
        super().__init__()
        self._execute_on_gui_thread.connect(self._execute_callable)

    def _execute_callable(self, func):
        """Executes a function that was passed via the signal. Runs on GUI Thread."""
        func()

    async def _run_async(self, func_creator):
        """Internal helper for async calls."""
        loop = asyncio.get_running_loop()
        future = loop.create_future()

        def gui_logic():
            func_creator(lambda result: loop.call_soon_threadsafe(future.set_result, result))

        self._execute_on_gui_thread.emit(gui_logic)
        return await future

    def _run_sync(self, func_creator):
        """Internal helper for blocking sync calls."""
        result_queue = Queue()

        def gui_logic():
            # func_creator receives a callback that puts the result in the queue
            func_creator(lambda result: result_queue.put(result))

        self._execute_on_gui_thread.emit(gui_logic)
        # Block worker thread until GUI thread finishes
        return result_queue.get()

    # 1. Screenshot Selector
    # =========================================================================

    def _logic_screenshot(self, parent, video_path, timestamp, mode, callback):
        # The actual logic calling the imported UI function
        def on_complete(result):
            callback(result)
            
        show_screenshot_selector(
            parent=parent,
            video_path=video_path,
            timestamp=str(timestamp),
            mode=mode,
            on_complete=on_complete
        )

    async def screenshot_selector_async(self, video_path, timestamp, mode='beginning', parent=None):
        return await self._run_async(lambda cb: self._logic_screenshot(parent, video_path, timestamp, mode, cb))

    def screenshot_selector_sync(self, video_path, timestamp, mode='beginning', parent=None):
        return self._run_sync(lambda cb: self._logic_screenshot(parent, video_path, timestamp, mode, cb))

    # =========================================================================
    # 2. Anki Confirmation
    # =========================================================================

    def _logic_anki(self, parent, config_app, expression, sentence, screenshot_path, previous_screenshot_path, audio_path, translation, timestamp, previous_timestamp,callback):
        result = show_anki_confirmation(
            parent=parent,
            config_app=config_app,
            expression=expression,
            sentence=sentence,
            screenshot_path=screenshot_path,
            previous_screenshot_path=previous_screenshot_path,
            audio_path=audio_path,
            translation=translation,
            screenshot_timestamp=timestamp,
            previous_screenshot_timestamp=previous_timestamp
        )
        callback(result)

    async def anki_confirmation_async(self, expression, sentence, screenshot_path, previous_screenshot_path, audio_path=None, translation=None, timestamp=0, previous_timestamp=0, parent=None):
        return await self._run_async(lambda cb: self._logic_anki(parent, get_config_window(), expression, sentence, screenshot_path, previous_screenshot_path, audio_path, translation, timestamp, previous_timestamp, cb))

    def anki_confirmation_sync(self, expression, sentence, screenshot_path, previous_screenshot_path, audio_path=None, translation=None, timestamp=0, previous_timestamp=0, parent=None):
        return self._run_sync(lambda cb: self._logic_anki(parent, get_config_window(), expression, sentence, screenshot_path, previous_screenshot_path, audio_path, translation, timestamp, previous_timestamp, cb))

    # =========================================================================
    # 3. Text Input (General Utility)
    # =========================================================================

    def _logic_input(self, parent, title, label, callback):
        text, ok = QInputDialog.getText(parent, title, label)
        callback(text if ok else None)

    async def get_text_input_async(self, title, label, parent=None):
        return await self._run_async(lambda cb: self._logic_input(parent, title, label, cb))

    def get_text_input_sync(self, title, label, parent=None):
        return self._run_sync(lambda cb: self._logic_input(parent, title, label, cb))

    # =========================================================================
    # 4. Screen Cropper
    # =========================================================================

    def _logic_cropper(self, transparent_mode, callback):
        show_screen_cropper(on_complete=callback, transparent_mode=transparent_mode)

    async def screen_cropper_async(self, transparent_mode=False):
        return await self._run_async(lambda cb: self._logic_cropper(transparent_mode, cb))

    def screen_cropper_sync(self, transparent_mode=False):
        return self._run_sync(lambda cb: self._logic_cropper(transparent_mode, cb))

    # =========================================================================
    # 5. Scene Selection (Profile Selection)
    # =========================================================================

    def _logic_scene_selection(self, matched_configs, callback):
        dialog = QInputDialog()
        dialog.setOptions(QInputDialog.InputDialogOption.UseListViewForComboBoxItems)
        dialog.setComboBoxItems(matched_configs)
        dialog.setWindowTitle('Select Profile')
        dialog.setLabelText('Multiple profiles match this scene. Please select one:')
        
        result = dialog.textValue() if dialog.exec() == QInputDialog.DialogCode.Accepted else None
        callback(result)

    async def scene_selection_async(self, matched_configs):
        return await self._run_async(lambda cb: self._logic_scene_selection(matched_configs, cb))

    def scene_selection_sync(self, matched_configs):
        return self._run_sync(lambda cb: self._logic_scene_selection(matched_configs, cb))

    # =========================================================================
    # 6. Minimum Character Size Selector (Furigana Filter Preview)
    # =========================================================================

    def _logic_minimum_char_size(self, current_size, for_overlay, callback):
        show_furigana_filter_preview(current_sensitivity=current_size, on_complete=callback, for_overlay=for_overlay)

    async def minimum_char_size_async(self, current_size):
        return await self._run_async(lambda cb: self._logic_minimum_char_size(current_size, cb))

    def minimum_char_size_sync(self, current_size, for_overlay=False):
        return self._run_sync(lambda cb: self._logic_minimum_char_size(current_size, for_overlay, cb))

    # =========================================================================
    # 7. Area Selector
    # =========================================================================

    def _logic_area_selector(self, window_name, use_obs_screenshot, callback):
        from GameSentenceMiner.ocr.owocr_area_selector_qt import show_area_selector
        show_area_selector(window_name, use_obs_screenshot=use_obs_screenshot, on_complete=callback)

    async def area_selector_async(self, window_name="", use_obs_screenshot=False):
        return await self._run_async(lambda cb: self._logic_area_selector(window_name, use_obs_screenshot, cb))

    def area_selector_sync(self, window_name="", use_obs_screenshot=False):
        return self._run_sync(lambda cb: self._logic_area_selector(window_name, use_obs_screenshot, cb))

    # =========================================================================
    # 8. Furigana Filter Preview (for non-overlay usage)
    # =========================================================================

    def _logic_furigana_preview(self, current_sensitivity, callback):
        show_furigana_filter_preview(current_sensitivity=current_sensitivity, on_complete=callback)

    async def furigana_preview_async(self, current_sensitivity):
        return await self._run_async(lambda cb: self._logic_furigana_preview(current_sensitivity, cb))

    def furigana_preview_sync(self, current_sensitivity):
        return self._run_sync(lambda cb: self._logic_furigana_preview(current_sensitivity, cb))


def send_to_clipboard(text):
    """
    Thread-safe clipboard setter. Can be called from any thread.
    Uses the DialogManager to execute on the main GUI thread.
    """
    def set_clipboard():
        app = QApplication.instance()
        if app is None:
            logger.error("Cannot set clipboard: QApplication is not running")
            return
        clipboard = app.clipboard()
        try:
            clipboard.setText(str(text))
            logger.debug(f"Clipboard set successfully: {text[:50]}...")
        except Exception as e:
            logger.error(f"Error setting clipboard: {e}")
    
    # Get the dialog manager and use its signal to run on GUI thread
    manager = get_dialog_manager()
    if manager:
        manager._execute_on_gui_thread.emit(set_clipboard)
    else:
        logger.error("DialogManager not available for clipboard operation")

def get_qt_app():
    """
    Get or create the global QApplication instance.
    """
    global _qt_app, _dialog_manager
    import qdarktheme
    if _qt_app is None:
        _qt_app = QApplication.instance()
        if _qt_app is None:
            _qt_app = QApplication(sys.argv)
            _qt_app.setApplicationName("GameSentenceMiner")
            _qt_app.setQuitOnLastWindowClosed(False)
            
    # Setup dark theme
    qdarktheme.setup_theme(theme="dark")
    # Set Icon 
    pickaxe_path = get_pickaxe_png_path()
    _qt_app.setWindowIcon(QIcon(pickaxe_path))
    # Initialize the manager once the App exists
    if _dialog_manager is None:
        _dialog_manager = DialogManager()
        gsm_state.dialog_manager = _dialog_manager
        
    return _qt_app

def get_dialog_manager():
    """Get the global DialogManager, initializing App if needed."""
    get_qt_app() # Ensures App and Manager exist
    return _dialog_manager

def get_config_window():
    """Get or create the global ConfigWindow instance."""
    global _config_window
    if _config_window is None:
        get_qt_app()  # Ensure Qt app exists first
        _config_window = ConfigWindow()
    return _config_window

def start_qt_app(show_config_immediately=False):
    """
    Start the Qt application event loop. 
    BLOCKING call. Should be called from Main Thread.
    """
    window = get_config_window()
    if show_config_immediately:
        window.show_window()
    
    app = get_qt_app()
    return app.exec()

def shutdown_qt_app():
    """Thread-safe shutdown."""
    global _config_window
    if _config_window is not None:
        # We can use the manager to safely close the window from any thread
        def close_logic():
            _config_window.close_window()
            _config_window._quit_app_signal.emit()
            
        if _dialog_manager:
            _dialog_manager._execute_on_gui_thread.emit(close_logic)

def launch_anki_confirmation(expression, sentence, screenshot_path, previous_screenshot_path, audio_path=None, translation=None, screenshot_timestamp=0, previous_screenshot_timestamp=0):
    """
    Launch Anki confirmation. Thread-safe, blocking.
    Returns: (use_voice, sentence, translation, screenshot_path, nsfw_tag, audio_path) or None
    """
    return get_dialog_manager().anki_confirmation_sync(
        expression, sentence, screenshot_path, previous_screenshot_path, audio_path, translation, screenshot_timestamp, previous_screenshot_timestamp
    )

def launch_screenshot_selector(video_path, timestamp, mode='beginning'):
    """
    Launch screenshot selector. Thread-safe, blocking.
    Returns: Selected screenshot path or None
    """
    return get_dialog_manager().screenshot_selector_sync(video_path, timestamp, mode)

def launch_screen_cropper(transparent_mode=False):
    """
    Launch screen cropper. Thread-safe, blocking.
    
    Args:
        transparent_mode: If True, shows a transparent overlay and captures a fresh screenshot.
                         If False (default), uses a frozen screenshot.
    
    Returns: PIL.Image or None
    """
    return get_dialog_manager().screen_cropper_sync(transparent_mode)

def launch_text_input(title, label):
    """
    Launch simple text input. Thread-safe, blocking.
    Returns: String or None
    """
    return get_dialog_manager().get_text_input_sync(title, label)

def launch_scene_selection(matched_configs):
    """
    Launch scene/profile selection. Thread-safe, blocking.
    Returns: Selected profile name or None
    """
    return get_dialog_manager().scene_selection_sync(matched_configs)

def launch_minimum_character_size_selector(current_size, for_overlay=False):
    """
    Launch minimum character size selector. Thread-safe, blocking.
    Returns: Selected size or None
    """
    return get_dialog_manager().minimum_char_size_sync(current_size, for_overlay)

def launch_area_selector(window_name="", use_obs_screenshot=False):
    """
    Launch area selector. Thread-safe, blocking.
    Returns: Selected area or None
    """
    return get_dialog_manager().area_selector_sync(window_name, use_obs_screenshot)

def launch_furigana_filter_preview(current_sensitivity):
    """
    Launch furigana filter preview. Thread-safe, blocking.
    Returns: Selected sensitivity or None
    """
    return get_dialog_manager().furigana_preview_sync(current_sensitivity)


if __name__ == "__main__":
    import os
    from PIL import Image
    import tempfile
    # time not needed in this test block
    
    # Start the app in a separate thread to simulate the real environment
    # where the GUI loop runs on Main, and we might call from workers.
    # HOWEVER, for this specific test script, we simply run the loop at the end.
    
    print("Qt6 GUI Test Menu")
    print("Note: In this test script, dialogs run on the main thread.")
    print("1. Test Anki Confirmation Dialog")
    print("2. Test Screenshot Selector")
    print("3. Test Screen Cropper")
    print("4. Test Input Dialog")
    
    choice = input("Enter choice (1-4): ").strip()
    
    # Ensure App Exists
    get_qt_app()
    
    if choice == "1":
        # Mock data
        test_img = Image.new('RGB', (800, 600), color='lightblue')
        temp_screenshot = os.path.join(tempfile.gettempdir(), "test_screenshot.png")
        test_img.save(temp_screenshot)
        temp_audio = os.path.join(tempfile.gettempdir(), "test_audio.opus")
        with open(temp_audio, 'wb') as f:
            f.write(b"dummy")
        
        print("Launching Anki Dialog...")
        # Calling the wrapper
        result = launch_anki_confirmation("Test Word", "Test Sentence", temp_screenshot, temp_audio, "Translation", 0)
        print(f"Result: {result}")
        
        # Cleanup
        if os.path.exists(temp_screenshot):
            os.remove(temp_screenshot)
        if os.path.exists(temp_audio):
            os.remove(temp_audio)

    elif choice == "2":
        vid = input("Video path: ")
        if os.path.exists(vid):
            print(f"Selected: {launch_screenshot_selector(vid, 10.0)}")
        else:
            print("File not found.")

    elif choice == "3":
        print(f"Result: {launch_screen_cropper()}")

    elif choice == "4":
        print(f"Input: {launch_text_input('Test Title', 'Enter something:')}")