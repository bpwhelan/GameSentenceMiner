"""Qt entry points for the Rust desktop, in the live Qt session or an on-demand worker."""

import asyncio
import dataclasses
import json
import sys
from datetime import datetime
from pathlib import Path
from uuid import uuid4


def _wire(value):
    """Export editable line identities without traversing their linked history."""
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    from GameSentenceMiner.util.models.model import VADResult
    from GameSentenceMiner.util.text_log import GameLine

    if isinstance(value, GameLine):
        return {"id": value.id, "text": value.text, "time": value.time.isoformat(), "scene": value.scene}
    if isinstance(value, VADResult):
        return _wire(vars(value))
    if dataclasses.is_dataclass(value):
        return {field.name: _wire(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, dict):
        return {k: _wire(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [_wire(item) for item in value]
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    return value


def _crop_result(image):
    if image is None:
        return None
    from GameSentenceMiner.util.config.configuration import get_temporary_directory

    directory = Path(get_temporary_directory())
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"crop-{uuid4().hex}.png"
    try:
        image.save(path, format="PNG")
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return {"path": str(path), "metadata": getattr(image, "_gsm_screen_crop_metadata", None)}


def _when_hidden(window, completed):
    from PyQt6.QtCore import QEvent, QObject, QTimer

    class FinishOnHide(QObject):
        def eventFilter(self, watched, event):
            if event.type() == QEvent.Type.Hide:
                watched.removeEventFilter(self)
                QTimer.singleShot(0, lambda: completed(None))
            return False

    watcher = FinishOnHide(window)
    window.installEventFilter(watcher)
    return watcher


def open_dialog(request, complete, *, standalone):
    """Called on the Qt thread. Return a strong reference for modeless widgets."""
    from GameSentenceMiner.ui import qt_main

    name = request["dialog"]
    args = {k: v for k, v in request.items() if k != "dialog" and v is not None}
    if name == "ankiConfirmation":
        args.setdefault("screenshot_path", None)
        args.setdefault("previous_screenshot_path", None)
    if name in ("syncSettings", "promptHelp", "recommendedAnkiSetup"):
        window = qt_main.get_config_window()
        if name == "syncSettings":
            from GameSentenceMiner.ui.config.tabs.advanced import open_sync_dialog

            open_sync_dialog(window)
        elif name == "promptHelp":
            window.show_prompt_help_dialog()
        else:
            from GameSentenceMiner.ui.config.anki_setup import open_recommended_anki_setup

            open_recommended_anki_setup(window)
        complete(None)
        return None
    if name in ("settings", "sessionReview"):
        if name == "settings":
            window = qt_main.get_config_window()
            window.show_window(**args)
        elif standalone:
            from GameSentenceMiner.ui.session_review_qt import SessionReviewWindow

            window = SessionReviewWindow()
            window.show()
        else:
            controller = qt_main.get_dialog_manager().session_review_controller
            controller.show()
            window = controller.window
        if standalone:
            return window, _when_hidden(window, complete)
        complete(None)
        return window
    if name in ("areaSelector", "monitorSelector"):
        from GameSentenceMiner.ocr.owocr_area_selector_qt import (
            AreaSelectorCancelled,
            show_area_selector,
            show_monitor_selector,
        )

        show = show_area_selector if name == "areaSelector" else show_monitor_selector
        try:
            window = show(on_complete=complete, **args)
        except AreaSelectorCancelled:
            complete(None)
            return None
        from GameSentenceMiner.util.communication import bus_client

        if bus_client.is_bus_available():
            client = bus_client.get_bus()

            def notify_saved():
                if client.connected:
                    client.publish(bus_client.MAIN, "gui.ocrAreaSaved")

            window.config_saved.connect(notify_saved)
        return window
    if name == "screenCropper":
        from GameSentenceMiner.ocr.ss_picker_qt import show_screen_cropper

        return show_screen_cropper(on_complete=complete, **args)
    if name in ("minimumCharacterSize", "furiganaPreview") and (path := args.pop("image_path", None)):
        from PIL import Image

        from GameSentenceMiner.ui.furigana_filter_preview_qt import show_furigana_filter_preview

        with Image.open(path) as source:
            image = source.copy()
        sensitivity = args["current_sensitivity"] if name == "furiganaPreview" else args["current_size"]
        complete(show_furigana_filter_preview(image=image, current_sensitivity=sensitivity))
        return None
    functions = {
        "ankiConfirmation": qt_main.launch_anki_confirmation,
        "ankiFieldGrouping": qt_main.launch_anki_field_grouping,
        "screenshotSelector": qt_main.launch_screenshot_selector,
        "textInput": qt_main.launch_text_input,
        "sceneSelection": qt_main.launch_scene_selection,
        "minimumCharacterSize": qt_main.launch_minimum_character_size_selector,
        "furiganaPreview": qt_main.launch_furigana_filter_preview,
    }
    complete(functions[name](**args))
    return None


def _encode(request, value):
    if request["dialog"] == "screenCropper":
        return _crop_result(value)
    if request["dialog"] in ("ankiConfirmation", "screenshotSelector"):
        return _wire(value)
    return value


async def handle_dialog(message):
    # Qt objects belong to the application thread, including their construction.
    if message.get("src") != "main":
        raise PermissionError("Only the desktop can open a dialog")
    from PyQt6.QtCore import QTimer

    from GameSentenceMiner.ui import qt_main

    manager = qt_main.gsm_state.dialog_manager
    if manager is None:
        raise RuntimeError("The Qt application is still starting")
    request = message["data"]
    loop = asyncio.get_running_loop()
    done = loop.create_future()
    key = object()

    def resolve(value, error=None):
        if not done.done():
            if error is None:
                done.set_result(value)
            else:
                done.set_exception(error)

    def complete(value):
        # Modeless selectors keep their last Python reference on the Qt thread.
        # A synchronous modal callback may run before open_dialog has returned.
        QTimer.singleShot(0, lambda: manager.desktop_windows.pop(key, None))
        try:
            loop.call_soon_threadsafe(resolve, _encode(request, value))
        except Exception as exc:  # noqa: BLE001 - forward serialization failures to the desktop.
            loop.call_soon_threadsafe(resolve, None, exc)

    def show():
        try:
            manager.desktop_windows[key] = open_dialog(request, complete, standalone=False)
        except Exception as exc:  # noqa: BLE001 - widget exceptions must resolve the waiting request.
            loop.call_soon_threadsafe(resolve, None, exc)

    manager._execute_on_gui_thread.emit(show)
    return await done


def run_worker(request_path, result_path):
    from PyQt6 import sip
    from PyQt6.QtCore import QCoreApplication, QEvent, QTimer

    from GameSentenceMiner.ui.qt_main import get_qt_app

    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    # Area saves can take effect while the selector is still open. Other
    # one-shot windows never need their own broker connection.
    bus = None
    if request["dialog"] in ("areaSelector", "monitorSelector"):
        from GameSentenceMiner.util.communication import bus_client

        if bus_client.is_bus_available():
            bus = bus_client.start_bus()
    app = get_qt_app(track_sessions=False)
    widgets = []
    result = {}

    def complete(value):
        try:
            result["value"] = _encode(request, value)
        except Exception as exc:  # noqa: BLE001 - report serialization failures before exiting Qt.
            result["error"] = str(exc)
        app.quit()

    def show():
        try:
            widgets.append(open_dialog(request, complete, standalone=True))
        except Exception as exc:  # noqa: BLE001 - report widget failures before exiting Qt.
            result["error"] = str(exc)
            app.quit()

    QTimer.singleShot(0, show)
    app.exec()
    # Destroy the windows and their multimedia children on the Qt thread
    # while the interpreter and the Qt platform plugin are still alive.
    selector = sys.modules.get("GameSentenceMiner.ui.screenshot_selector_qt")
    for window in app.topLevelWidgets():
        if selector and isinstance(window, selector.ScreenshotSelectorDialog):
            window.finish_workers()
        window.deleteLater()
    QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
    widgets.clear()
    sip.delete(app)
    if bus is not None:
        bus.stop()
    Path(result_path).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    run_worker(*sys.argv[1:])
