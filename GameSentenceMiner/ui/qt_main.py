"""
Qt6 GUI Main Entry Point
This module serves as the main entry point for all Qt6-based GUI components in GameSentenceMiner.
It provides a centralized way to launch various dialogs and windows.
"""

import sys
from PyQt6.QtWidgets import QApplication

# Import all Qt6 GUI modules
from GameSentenceMiner.ui.anki_confirmation_qt import show_anki_confirmation
from GameSentenceMiner.ui.screenshot_selector_qt import show_screenshot_selector
from GameSentenceMiner.ui.furigana_filter_preview_qt import show_furigana_filter_preview
from GameSentenceMiner.ocr.owocr_area_selector_qt import show_area_selector
from GameSentenceMiner.ocr.ss_picker_qt import show_screen_cropper
from GameSentenceMiner.ui.config_gui_qt import ConfigWindow

# Store global QApplication instance
_qt_app = None
_config_window = None


def get_qt_app():
    """
    Get or create the global QApplication instance.
    This ensures we only have one QApplication for all Qt6 GUIs.
    
    Returns:
        QApplication: The global QApplication instance
    """
    global _qt_app
    if _qt_app is None:
        _qt_app = QApplication.instance()
        if _qt_app is None:
            _qt_app = QApplication(sys.argv)
            # Set application-wide properties
            _qt_app.setApplicationName("GameSentenceMiner")
            # Note: AA_UseHighDpiPixmaps is deprecated in Qt6 and enabled by default
    return _qt_app


def ensure_qt_app(func):
    """
    Decorator to ensure QApplication exists before running a function.
    Use this for any function that creates Qt widgets.
    """
    def wrapper(*args, **kwargs):
        get_qt_app()
        return func(*args, **kwargs)
    return wrapper


# Re-export show functions with app initialization
@ensure_qt_app
def launch_anki_confirmation(parent, config_app, expression, sentence, screenshot_path, 
                             audio_path, translation, screenshot_timestamp):
    """
    Launch the Anki confirmation dialog.
    
    Returns:
        tuple: (use_voice, sentence, translation, screenshot_path, nsfw_tag, audio_path) or None
    """
    return show_anki_confirmation(parent, config_app, expression, sentence, screenshot_path,
                                  audio_path, translation, screenshot_timestamp)


@ensure_qt_app
def launch_screenshot_selector(parent, config_app, video_path, timestamp, mode='beginning', on_complete=None):
    """
    Launch the screenshot selector dialog.
    
    Returns:
        str: Selected screenshot path or None
    """
    return show_screenshot_selector(parent, config_app, video_path, timestamp, mode, on_complete)


@ensure_qt_app  
def launch_furigana_filter_preview(image=None, current_sensitivity=0, on_complete=None, title_suffix="", use_overlay=False):
    """
    Launch the furigana filter preview window.
    
    Args:
        image: Optional PIL Image to analyze (if None, will capture from OBS or overlay)
        current_sensitivity: Initial sensitivity value
        on_complete: Callback function to be called with the result
        title_suffix: Suffix for the window title
        use_overlay: If True and image is None, capture from overlay monitor instead of OBS
    
    Returns:
        The window instance
    """
    return show_furigana_filter_preview(image, current_sensitivity, on_complete, title_suffix, use_overlay)


@ensure_qt_app
def launch_area_selector(window_name, use_window_as_config=False, use_obs_screenshot=False, on_complete=None):
    """
    Launch the OCR area selector.
    
    Returns:
        list: Selected rectangles or None
    """
    return show_area_selector(window_name, use_window_as_config, use_obs_screenshot, on_complete)


@ensure_qt_app
def launch_screen_cropper(on_complete=None):
    """
    Launch the screen cropper for selecting screenshot area.
    
    Returns:
        PIL.Image: Cropped image or None
    """
    return show_screen_cropper(on_complete)


def run_qt_event_loop():
    """
    Run the Qt event loop. Call this if you need to keep the application running.
    This is typically not needed as individual dialogs use exec() which blocks.
    """
    app = get_qt_app()
    return app.exec()


def get_config_window():
    """
    Get or create the global ConfigWindow instance.
    This ensures we only have one config window for the entire application.
    
    Returns:
        ConfigWindow: The global config window instance
    """
    global _config_window
    if _config_window is None:
        get_qt_app()  # Ensure Qt app exists first
        _config_window = ConfigWindow()
    return _config_window


def start_qt_app(show_config_immediately=False):
    """
    Start the Qt application event loop.
    This should be called from the main thread and will block until the app exits.
    
    Args:
        show_config_immediately: If True, shows the config window before starting the event loop
    """
    window = get_config_window()
    if show_config_immediately:
        window.show_window()
    return run_qt_event_loop()


def shutdown_qt_app():
    """
    Shutdown the Qt application.
    Thread-safe method to close the config window and quit the Qt application.
    """
    global _config_window
    if _config_window is not None:
        _config_window.close_window()
        _config_window._quit_app_signal.emit()


# Main entry point for testing
if __name__ == "__main__":
    import os
    from PIL import Image
    import tempfile
    
    print("Qt6 GUI Test Menu")
    print("=================")
    print("1. Test Anki Confirmation Dialog")
    print("2. Test Screenshot Selector")
    print("3. Test Furigana Filter Preview")
    print("4. Test OCR Area Selector")
    print("5. Test Screen Cropper")
    print("6. Exit")
    
    choice = input("Enter choice (1-6): ").strip()
    
    if choice == "1":
        # Create test screenshot
        test_img = Image.new('RGB', (800, 600), color='lightblue')
        temp_screenshot = os.path.join(tempfile.gettempdir(), "test_screenshot.png")
        test_img.save(temp_screenshot)
        
        # Create test audio
        temp_audio = os.path.join(tempfile.gettempdir(), "test_audio.opus")
        with open(temp_audio, 'wb') as f:
            f.write(b"dummy audio data")
        
        result = launch_anki_confirmation(
            parent=None,
            config_app=None,
            expression="テスト",
            sentence="これはテストの文章です。",
            screenshot_path=temp_screenshot,
            audio_path=temp_audio,
            translation="This is a test translation.",
            screenshot_timestamp=0
        )
        print(f"Result: {result}")
        
        # Cleanup
        if os.path.exists(temp_screenshot):
            os.remove(temp_screenshot)
        if os.path.exists(temp_audio):
            os.remove(temp_audio)
    
    elif choice == "2":
        video_path = input("Enter video path: ").strip()
        if os.path.exists(video_path):
            result = launch_screenshot_selector(
                parent=None,
                config_app=None,
                video_path=video_path,
                timestamp=10.0,
                mode='middle'
            )
            print(f"Selected: {result}")
        else:
            print(f"Video not found: {video_path}")
    
    elif choice == "3":
        print("Furigana filter preview requires OBS or overlay screenshot.")
        print("This would normally be called from the main application.")
    
    elif choice == "4":
        print("OCR area selector requires OBS connection.")
        print("This would normally be called from the main application.")
    
    elif choice == "5":
        result = launch_screen_cropper()
        if result:
            print(f"Cropped image size: {result.size}")
        else:
            print("No image selected")
    
    elif choice == "6":
        print("Exiting...")
    
    else:
        print("Invalid choice")
