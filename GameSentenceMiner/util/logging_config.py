"""
GameSentenceMiner Logging Configuration

A centralized logging system using loguru for clean, flexible, and powerful logging.
Provides separate loggers for different components (main app, OCR, overlay) with
automatic rotation, color coding, and context-aware configuration.
"""

import sys
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

if TYPE_CHECKING:
    from loguru import Logger

from loguru import logger as _logger

from GameSentenceMiner.util.data_directory import get_app_directory
from GameSentenceMiner.util.log_paths import SharedRotatingLog, get_component_log_path

# Remove default handler
_logger.remove()


class LoggerManager:
    """
    Manages loguru logger instances with context-aware configuration.
    Supports multiple log files for different components and automatic cleanup.
    """

    # Component to file patterns mapping for automatic context tagging
    COMPONENT_PATTERNS: ClassVar[dict[str, list[str]]] = {
        "OVERLAY": ["get_overlay_coords.py", "overlay", "gsm_overlay"],
        "VAD": ["vad.py", "voice_activity"],
        "ANKI": ["anki.py", "anki_connect"],
        "OCR": ["ocr/", "oneocr", "owocr"],
        "OBS": ["obs.py", "obsws"],
        "GAMETEXT": ["gametext.py", "gsm_websocket"],
        "CONFIG": ["configuration.py", "config_gui"],
        "DATABASE": ["db.py", "database"],
        "STATS": ["web/", "flask", "daily_rollup", "stats"],
        "UI": ["ui/", "config_gui_qt.py"],
        "PLUGIN": ["plugins.py", "user_plugins"],
        "SCHEDULED": ["cron/", "run_crons.py"],
    }

    def __init__(self):
        self._initialized = False
        self._log_dir: Path | None = None
        self._handlers = {}
        self._logger_name = None

    def _get_app_directory(self) -> Path:
        """Get the application config directory (platform-aware)."""
        return Path(get_app_directory())

    def _get_log_directory(self) -> Path:
        """Get or create the logs directory."""
        if self._log_dir is None:
            self._log_dir = self._get_app_directory() / "logs"
            self._log_dir.mkdir(parents=True, exist_ok=True)
        return self._log_dir

    def _determine_logger_name(self) -> str:
        """Determine the process role before loading its runtime."""
        # Import order must not decide the filename: the backend imports OCR
        # utilities too. Only use the process entrypoint, never the import stack.
        entrypoint = (sys.argv[0] if sys.argv else "").replace("\\", "/").lower()
        if entrypoint == "-m":
            # runpy imports the containing package before setting argv[0]. OCR's
            # package initializes logging during that import, so consult the
            # original interpreter arguments while the filename is unavailable.
            original_args = getattr(sys, "orig_argv", [])
            if "-m" in original_args:
                module_index = original_args.index("-m") + 1
                if module_index < len(original_args):
                    entrypoint = original_args[module_index].replace(".", "/").lower()
        if "overlay" in entrypoint:
            return "overlay"
        if "/ocr/" in entrypoint or "ocr" in Path(entrypoint).name:
            return "ocr"
        return "backend"

    def _detect_component_tag(self, record) -> str:
        """
        Detect the component tag based on the file path in the log record.
        Returns fixed-width component tag for consistent formatting.
        """
        try:
            file_path = record.get("file", {})
            if isinstance(file_path, dict):
                file_name = file_path.get("path", "")
            else:
                file_name = getattr(file_path, "path", str(file_path))

            # Normalize path separators
            file_name = file_name.replace("\\", "/")

            # Check each component pattern
            for component, patterns in self.COMPONENT_PATTERNS.items():
                for pattern in patterns:
                    if pattern in file_name:
                        # Return fixed-width component tag (pad to 10 characters)
                        return f"{component}".ljust(10)

            return "MAIN".ljust(10)  # Return 10 spaces for no component
        except Exception:  # noqa: BLE001 - logging must survive malformed diagnostic records.
            return "MAIN".ljust(10)

    def _add_console_handler(self, logger_name: str = "gamesentenceminer", level: str = "INFO"):
        """Add a console handler with appropriate formatting and color."""

        def format_with_component(record):
            component_tag = self._detect_component_tag(record)
            record["extra"]["component_tag"] = component_tag
            return True

        handler_id = _logger.add(
            sys.stdout,
            format="{time:YYYY-MM-DD HH:mm:ss} | {extra[component_tag]} | {level: <10} | {message}",
            level=level,
            colorize=True,
            backtrace=False,
            diagnose=False,
            filter=format_with_component,
        )
        self._handlers[f"{logger_name}_console"] = handler_id
        return handler_id

    def _add_file_handler(self, logger_name: str = "gamesentenceminer", level: str = "DEBUG"):
        """Add a rotating file handler for the specified logger."""
        log_dir = self._get_log_directory()
        log_file = get_component_log_path(log_dir, logger_name)
        process_sink = SharedRotatingLog(log_file)
        ocr_sink = SharedRotatingLog(log_dir / "ocr.log")

        def write_to_component(message):
            # The backend also runs OCR for the overlay. Keep those engine
            # diagnostics alongside standalone OCR without duplicating records.
            sink = ocr_sink if message.record["extra"]["component_tag"].strip() == "OCR" else process_sink
            sink.write(message)

        def format_with_component(record):
            component_tag = self._detect_component_tag(record)
            record["extra"]["component_tag"] = component_tag
            # Skip DISPLAY level from file logs
            return record["level"].name != "DISPLAY"

        # Main log file with rotation
        handler_id = _logger.add(
            write_to_component,
            format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | PID {process.id} | {extra[component_tag]}{name}:{function}:{line} | {message}",
            level=level,
            colorize=False,
            backtrace=True,
            diagnose=False,
            enqueue=True,  # Thread-safe logging
            filter=format_with_component,
        )
        self._handlers[f"{logger_name}_file"] = handler_id
        return handler_id

    def initialize(
        self,
        logger_name: str | None = None,
        console_level: str = "BACKGROUND",
        file_level: str = "DEBUG",
    ):
        """
        Initialize the logging system with handlers.

        Args:
            logger_name: Name of the logger (auto-detected if None)
            console_level: Minimum level for console output (INFO, DEBUG, etc.)
            file_level: Minimum level for file output
        """
        if self._initialized:
            return

        if logger_name is None:
            logger_name = self._determine_logger_name()
        self._logger_name = logger_name
        if logger_name == "ocr" and console_level == "BACKGROUND":
            console_level = "INFO"

        # Add handlers
        self._add_console_handler(logger_name, level=console_level)
        self._add_file_handler(logger_name, level=file_level)

        self._initialized = True
        _logger.log("BACKGROUND", f"Logging initialized for {logger_name}")
        _logger.debug(f"Log directory: {self._get_log_directory()}")

    def cleanup_old_logs(self, days: int = 7):
        """
        Clean up log files older than specified days.

        Args:
            days: Number of days to retain logs
        """
        from GameSentenceMiner.util.log_maintenance import maintain_logs

        maintain_logs(self._get_log_directory(), days=days)

    def get_logger(self) -> "Logger":
        """Get the configured loguru logger instance."""
        if not self._initialized:
            self.initialize()
        return _logger

    def add_custom_level(self, name: str, severity: int, color: str = ""):
        """
        Add a custom log level.

        Args:
            name: Level name (e.g., "DISPLAY")
            severity: Severity number (10=DEBUG, 20=INFO, 30=WARNING, 40=ERROR, 50=CRITICAL)
            color: Color tag for the level (e.g., "<blue>")
        """
        _logger.level(name, no=severity, color=color)

    def set_level(self, level: str, handler_type: str | None = None):
        """
        Change the logging level for specific or all handlers.

        Args:
            level: New level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
            handler_type: Specific handler to update (console or file) or None for all
        """
        if handler_type:
            handler_key = f"{self._logger_name}_{handler_type}"
            if handler_key in self._handlers:
                _logger.remove(self._handlers[handler_key])
                if handler_type == "console":
                    self._add_console_handler(self._logger_name, level=level)
                elif handler_type == "file":
                    self._add_file_handler(self._logger_name, level=level)
        else:
            # Update all handlers
            for key in list(self._handlers.keys()):
                _logger.remove(self._handlers[key])
            self._handlers.clear()
            self._initialized = False
            self.initialize(logger_name=self._logger_name, file_level=level, console_level=level)


# Global logger manager instance
_manager = LoggerManager()


def get_logger(name: str | None = None) -> "Logger":
    """
    Get the configured logger instance.

    Args:
        name: Optional logger name (auto-detected if None)

    Returns:
        Configured loguru logger
    """
    if not _manager._initialized:
        _manager.initialize(logger_name=name)
    return _manager.get_logger()


def initialize_logging(
    logger_name: str | None = None,
    console_level: str = "BACKGROUND",
    file_level: str = "DEBUG",
):
    """
    Initialize the logging system (convenience function).

    Args:
        logger_name: Name of the logger (auto-detected if None)
        console_level: Console output level
        file_level: File output level
    """
    _manager.initialize(logger_name=logger_name, console_level=console_level, file_level=file_level)


def cleanup_old_logs(days: int = 7):
    """Clean up old log files (convenience function)."""
    _manager.cleanup_old_logs(days=days)


# Add custom levels before first logger initialization.
# BACKGROUND is intentionally below INFO so simple/basic console filtering can hide it.
_manager.add_custom_level("DISPLAY", 25, "")
_manager.add_custom_level("BACKGROUND", 15, "<dim>")
_manager.add_custom_level("TEXT_RECEIVED", 21, "<cyan>")

# Export the logger directly for convenience
logger = get_logger()


def _format_message(message: str, args, kwargs) -> str:
    if args or kwargs:
        try:
            return message.format(*args, **kwargs)
        except Exception:  # noqa: BLE001 - user-defined __format__ must not break logging.
            return message
    return message


def display(message: str, *args, **kwargs):
    """Display a message at DISPLAY level (custom level for user-facing messages)."""
    formatted = _format_message(message, args, kwargs)
    logger.opt(depth=1).log("DISPLAY", formatted)


def background(message: str, *args, **kwargs):
    """Log a message at BACKGROUND level (custom level for low-importance background info)."""
    formatted = _format_message(message, args, kwargs)
    logger.opt(depth=1).log("BACKGROUND", formatted)


logger.display = display
logger.background = background

__all__ = [
    "LoggerManager",
    "background",
    "cleanup_old_logs",
    "display",
    "get_logger",
    "initialize_logging",
    "logger",
]
