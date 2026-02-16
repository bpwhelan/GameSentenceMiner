"""
GameSentenceMiner Logging Configuration

A centralized logging system using loguru for clean, flexible, and powerful logging.
Provides separate loggers for different components (main app, OCR, overlay) with
automatic rotation, color coding, and context-aware configuration.
"""

import copy
import inspect
import os
import sys
from pathlib import Path
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from loguru import Logger

from loguru import logger as _logger

# Remove default handler
_logger.remove()


class LoggerManager:
    """
    Manages loguru logger instances with context-aware configuration.
    Supports multiple log files for different components and automatic cleanup.
    """
    
    # Component to file patterns mapping for automatic context tagging
    COMPONENT_PATTERNS = {
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
        self._log_dir: Optional[Path] = None
        self._handlers = {}
        
    def _get_app_directory(self) -> Path:
        """Get the application config directory (platform-aware)."""
        if sys.platform == 'win32':
            appdata_dir = os.getenv('APPDATA')
        else:
            appdata_dir = os.path.expanduser('~/.config')
        
        config_dir = Path(appdata_dir) / 'GameSentenceMiner'
        config_dir.mkdir(parents=True, exist_ok=True)
        return config_dir
    
    def _get_log_directory(self) -> Path:
        """Get or create the logs directory."""
        if self._log_dir is None:
            self._log_dir = self._get_app_directory() / 'logs'
            self._log_dir.mkdir(parents=True, exist_ok=True)
        return self._log_dir
    
    def _determine_logger_name(self) -> str:
        """
        Intelligently determine the logger name based on calling context.
        Returns appropriate name for main app, OCR utilities, or overlay.
        """
        frame = inspect.currentframe()
        try:
            # Walk up the call stack to find the context
            while frame:
                filename = frame.f_code.co_filename
                if filename.endswith(('gsm.py', 'gamesentenceminer.py', '__main__.py')):
                    return "gamesentenceminer"
                elif 'ocr' in filename.lower() and 'overlay' not in filename.lower():
                    return "misc_ocr_utils"
                elif 'overlay' in filename.lower():
                    return "gsm_overlay"
                frame = frame.f_back
            
            # Fallback: check main module
            main_module = inspect.getmodule(inspect.stack()[-1][0])
            if main_module and hasattr(main_module, '__file__'):
                main_file = os.path.basename(main_module.__file__)
                if main_file in ('gsm.py', 'gamesentenceminer.py'):
                    return "gamesentenceminer"
                elif 'ocr' in main_file.lower():
                    return "misc_ocr_utils"
                elif 'overlay' in main_file.lower():
                    return "gsm_overlay"
            
            return "gamesentenceminer"  # Default
        finally:
            del frame
    
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
                file_name = str(file_path)
            
            # Normalize path separators
            file_name = file_name.replace("\\", "/")
            
            # Check each component pattern
            for component, patterns in self.COMPONENT_PATTERNS.items():
                for pattern in patterns:
                    if pattern in file_name:
                        # Return fixed-width component tag (pad to 10 characters)
                        return f"{component}".ljust(10)
            
            return "MAIN".ljust(10)  # Return 10 spaces for no component
        except Exception:
            return "MAIN".ljust(10)
    
    def _add_console_handler(self, logger_name: str = "gamesentenceminer"):
        """Add a console handler with appropriate formatting and color."""
        def format_with_component(record):
            component_tag = self._detect_component_tag(record)
            record["extra"]["component_tag"] = component_tag
            return True
        
        handler_id = _logger.add(
            sys.stdout,
            format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <dim>{extra[component_tag]}</dim> | <level>{message}</level>",
            level="INFO",
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
        log_file = log_dir / f"{logger_name}.log"
        
        def format_with_component(record):
            component_tag = self._detect_component_tag(record)
            record["extra"]["component_tag"] = component_tag
            # Skip DISPLAY level from file logs
            return record["level"].name != "DISPLAY"
        
        # Main log file with rotation
        handler_id = _logger.add(
            str(log_file),
            format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {extra[component_tag]}{name}:{function}:{line} | {message}",
            level=level,
            rotation="5 MB",
            retention="7 days",
            compression="zip",
            encoding="utf-8",
            colorize=True,
            backtrace=True,
            diagnose=True,
            enqueue=True,  # Thread-safe logging
            filter=format_with_component,
        )
        self._handlers[f"{logger_name}_file"] = handler_id
        return handler_id
    
    def _add_error_handler(self):
        """Add a dedicated error log file for ERROR and CRITICAL messages."""
        log_dir = self._get_log_directory()
        error_log = log_dir / "error.log"
        
        def format_with_component(record):
            component_tag = self._detect_component_tag(record)
            record["extra"]["component_tag"] = component_tag
            # Only log ERROR and above
            return record["level"].no >= 40
        
        handler_id = _logger.add(
            str(error_log),
            format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {extra[component_tag]}{name}:{function}:{line} - {message}\n{exception}",
            level="ERROR",
            rotation="5 MB",
            retention="14 days",
            compression="zip",
            encoding="utf-8",
            backtrace=True,
            diagnose=True,
            enqueue=True,
            filter=format_with_component,
        )
        self._handlers["error_file"] = handler_id
        return handler_id
    
    def initialize(self, logger_name: Optional[str] = None, console_level: str = "INFO", file_level: str = "DEBUG"):
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
        
        # Add handlers
        self._add_console_handler(logger_name)
        self._add_file_handler(logger_name, level=file_level)
        self._add_error_handler()
        
        # Configure logger context
        _logger.configure(
            extra={"logger_name": logger_name},
            patcher=lambda record: record.update(name=logger_name)
        )
        
        self._initialized = True
        _logger.success(f"Logging initialized for {logger_name}")
        _logger.debug(f"Log directory: {self._get_log_directory()}")
    
    def cleanup_old_logs(self, days: int = 7):
        """
        Clean up log files older than specified days.
        
        Args:
            days: Number of days to retain logs
        """
        import time
        
        log_dir = self._get_log_directory()
        now = time.time()
        cutoff = now - (days * 86400)
        
        if not log_dir.exists():
            return
        
        cleaned_count = 0
        for log_file in log_dir.iterdir():
            if log_file.is_file():
                try:
                    file_modified = log_file.stat().st_mtime
                    if file_modified < cutoff:
                        log_file.unlink()
                        cleaned_count += 1
                        _logger.debug(f"Deleted old log file: {log_file}")
                except Exception as e:
                    _logger.warning(f"Error deleting log file {log_file}: {e}")
        
        if cleaned_count > 0:
            _logger.success(f"Cleaned up {cleaned_count} old log files")
    
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
    
    def set_level(self, level: str, handler_type: Optional[str] = None):
        """
        Change the logging level for specific or all handlers.
        
        Args:
            level: New level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
            handler_type: Specific handler to update (console, file, error) or None for all
        """
        if handler_type:
            handler_key = f"{self._determine_logger_name()}_{handler_type}"
            if handler_key in self._handlers:
                _logger.remove(self._handlers[handler_key])
                if handler_type == "console":
                    self._add_console_handler()
                elif handler_type == "file":
                    self._add_file_handler(level=level)
        else:
            # Update all handlers
            for key in list(self._handlers.keys()):
                _logger.remove(self._handlers[key])
            self._handlers.clear()
            self._initialized = False
            self.initialize(file_level=level, console_level=level)


# Global logger manager instance
_manager = LoggerManager()


def get_logger(name: Optional[str] = None) -> "Logger":
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


def initialize_logging(logger_name: Optional[str] = None, console_level: str = "INFO", file_level: str = "DEBUG"):
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


# Export the logger directly for convenience
logger = get_logger()

# Add a custom DISPLAY level (between INFO and WARNING) for user-facing messages that should not be logged
_manager.add_custom_level("DISPLAY", 25, "")

_manager.add_custom_level("BACKGROUND", 25, "<dim>")

_manager.add_custom_level("TEXT_RECEIVED", 25, "<cyan>")

def display(message: str):
    """Display a message at DISPLAY level (custom level for user-facing messages)."""
    frame = inspect.currentframe().f_back
    logger.patch(lambda record: record.update(
        file=frame.f_code.co_filename,
        line=frame.f_lineno,
        function=frame.f_code.co_name
    )).log("DISPLAY", message)
    
def background(message: str):
    """Log a message at BACKGROUND level (custom level for low-importance background info)."""
    frame = inspect.currentframe().f_back
    logger.patch(lambda record: record.update(
        file=frame.f_code.co_filename,
        line=frame.f_lineno,
        function=frame.f_code.co_name
    )).log("BACKGROUND", message)

# def text_received(message: str, *args, **kwargs):
#     """Log a message at TEXT_RECEIVED level (custom level for received text)."""
#     formatted = _format_message(message, args, kwargs)
#     frame = inspect.currentframe().f_back
#     logger.patch(lambda record: record.update(
#         file=frame.f_code.co_filename,
#         line=frame.f_lineno,
#         function=frame.f_code.co_name
#     )).log("TEXT_RECEIVED", formatted)

logger.display = display
logger.background = background
# logger.text_received = text_received

__all__ = [
    'logger',
    'get_logger',
    'initialize_logging',
    'cleanup_old_logs',
    'display',
    'background',
    'LoggerManager',
]
