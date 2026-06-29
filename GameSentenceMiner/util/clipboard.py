"""Centralized clipboard utilities for GSM.

Provides a single, reliable interface for clipboard copy/paste operations
instead of scattering pyperclipfix imports across the codebase.

By default, prefers Qt6 clipboard (thread-safe via DialogManager signal)
with a pyperclipfix fallback. Set USE_PYPERCLIP_ONLY = True to bypass Qt
entirely and use pyperclipfix for all operations.
"""

from GameSentenceMiner.util.logging_config import logger

# ─── Configuration ───────────────────────────────────────────────────────────
# Set to True to skip Qt6 clipboard and use pyperclipfix exclusively.
USE_PYPERCLIP_ONLY = False
TRY_PYPERCLIP_FIRST = True
# ─────────────────────────────────────────────a────────────────────────────────

_pyperclipfix = None
_pyperclipfix_initialized = False


def _ensure_pyperclipfix():
    global _pyperclipfix, _pyperclipfix_initialized
    if _pyperclipfix_initialized:
        return _pyperclipfix
    _pyperclipfix_initialized = True
    try:
        import pyperclipfix

        _pyperclipfix = pyperclipfix
    except Exception:
        logger.warning("pyperclipfix not available; pyperclip fallback will be unavailable.")
        _pyperclipfix = None
    return _pyperclipfix


def _qt_clipboard_available() -> bool:
    """Return True if the Qt6 QApplication is running and clipboard is accessible."""
    if USE_PYPERCLIP_ONLY:
        return False
    try:
        from PyQt6.QtWidgets import QApplication

        return QApplication.instance() is not None
    except Exception:
        return False


def _qt_copy(text: str) -> bool:
    """Copy using Qt6 clipboard via the thread-safe DialogManager signal."""
    try:
        from GameSentenceMiner.ui.qt_main import send_to_clipboard

        send_to_clipboard(text)
        return True
    except Exception as e:
        logger.debug(f"Qt clipboard copy failed: {e}")
        return False


def _qt_paste() -> str | None:
    """Read clipboard via Qt6. Must run on GUI thread or use sync helper."""
    try:
        from GameSentenceMiner.ui.qt_main import get_dialog_manager
        from PyQt6.QtWidgets import QApplication
        from PyQt6.QtCore import QThread
        from queue import Queue

        app = QApplication.instance()
        if app is None:
            return None

        # If we're on the GUI thread, read directly
        if app.thread() == QThread.currentThread():
            return app.clipboard().text()

        # Otherwise, dispatch to GUI thread and wait for result
        manager = get_dialog_manager()
        if manager is None:
            return None

        result_queue: Queue[str | None] = Queue()

        def read_clipboard():
            try:
                result_queue.put(app.clipboard().text())
            except Exception:
                result_queue.put(None)

        manager._execute_on_gui_thread.emit(read_clipboard)
        return result_queue.get()
    except Exception as e:
        logger.debug(f"Qt clipboard paste failed: {e}")
        return None


def _pyperclip_copy(text: str) -> bool:
    """Copy using pyperclipfix."""
    mod = _ensure_pyperclipfix()
    if mod is None:
        return False
    try:
        mod.copy(text)
        return True
    except Exception as e:
        logger.debug(f"pyperclipfix copy failed: {e}")
        return False


def _pyperclip_paste() -> str | None:
    """Read clipboard using pyperclipfix."""
    mod = _ensure_pyperclipfix()
    if mod is None:
        return None
    try:
        return mod.paste()
    except Exception as e:
        logger.debug(f"pyperclipfix paste failed: {e}")
        return None


def copy(text: str) -> bool:
    """Copy text to the system clipboard. Returns True on success.

    Prefers Qt6 clipboard when available, falls back to pyperclipfix.
    """
    if not USE_PYPERCLIP_ONLY and _qt_clipboard_available():
        logger.background("Attempting to copy to clipboard via Qt.")
        if _qt_copy(text):
            return True
        # Qt failed, try pyperclipfix as fallback
        logger.background("Qt copy failed, falling back to pyperclipfix.")
    elif TRY_PYPERCLIP_FIRST:
        logger.background("Attempting to copy to clipboard via pyperclipfix first.")
        if _pyperclip_copy(text):
            return True
        logger.background("pyperclipfix copy failed, trying Qt if available.")
        if not USE_PYPERCLIP_ONLY and _qt_clipboard_available():
            return _qt_copy(text)

    return _pyperclip_copy(text)


def paste() -> str | None:
    """Read text from the system clipboard. Returns None on failure.

    Prefers Qt6 clipboard when available, falls back to pyperclipfix.
    """
    if not USE_PYPERCLIP_ONLY and _qt_clipboard_available():
        result = _qt_paste()
        if result is not None:
            return result
        logger.debug("Qt paste failed, falling back to pyperclipfix.")
    elif TRY_PYPERCLIP_FIRST:
        result = _pyperclip_paste()
        if result is not None:
            return result
        logger.debug("pyperclipfix paste failed, trying Qt if available.")
        if not USE_PYPERCLIP_ONLY and _qt_clipboard_available():
            return _qt_paste()

    return _pyperclip_paste()


def is_available() -> bool:
    """Return True if clipboard operations are available via any backend."""
    if not USE_PYPERCLIP_ONLY and _qt_clipboard_available():
        return True
    _ensure_pyperclipfix()
    return _pyperclipfix is not None


def test_qt6_copy() -> bool:
    example_text = "Hello, GSM Clipboard!"
    for i in range(50):
        example_text = (
            example_text + " " + example_text
        )  # Exponentially increase text size to test large clipboard handling
        if copy(example_text):
            logger.info("Successfully copied to clipboard.")
        else:
            logger.error("Failed to copy to clipboard.")

        pasted = paste()
        if pasted == example_text:
            logger.info("Successfully pasted from clipboard.")
        else:
            logger.error(f"Failed to paste from clipboard. Got: {pasted}")
