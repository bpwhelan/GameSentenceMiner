# GameSentenceMiner Logging System

## Overview

The GameSentenceMiner logging system has been rebuilt from the ground up using [loguru](https://github.com/Delgan/loguru), a powerful and elegant logging library for Python. This provides a clean, flexible, and feature-rich logging solution with automatic rotation, color coding, and context-aware configuration.

## Key Features

### 🎨 Enhanced Formatting
- **Colorized console output** with syntax highlighting
- **Structured log format** with timestamps, levels, and context
- **Better exception tracebacks** with full diagnostics

### 🔄 Automatic Log Rotation
- **File rotation** at 10MB for main logs
- **Automatic compression** of old logs (ZIP format)
- **Retention policies**: 7 days for main logs, 14 days for error logs
- **Automatic cleanup** of old log files

### 📂 Multi-Component Support
- **Context-aware logger names**: Automatically detects if running from main app, OCR utilities, or overlay
- **Separate log files** for different components (gamesentenceminer.log, misc_ocr_utils.log, gsm_overlay.log)
- **Dedicated error log** for ERROR and CRITICAL messages across all components

### 🔒 Thread-Safe
- **Enqueued logging** for thread-safe operations
- **Async-compatible** for use with asyncio

### 🎯 Custom Log Levels
- **DISPLAY level** (25): Special level for user-facing messages
- Standard levels: DEBUG (10), INFO (20), WARNING (30), ERROR (40), CRITICAL (50)

## Usage

### Basic Usage

```python
from GameSentenceMiner.util.logging_config import logger

# Standard logging
logger.info("Application started")
logger.debug("Debug information")
logger.warning("Warning message")
logger.error("Error occurred")
logger.success("Operation completed successfully")  # loguru-specific

# Exception logging with full traceback
try:
    risky_operation()
except Exception as e:
    logger.exception("Failed to execute operation")
```

### Custom DISPLAY Level

```python
from GameSentenceMiner.util.logging_config import logger

# User-facing message at DISPLAY level (between INFO and WARNING)
logger.display("This message is intended for end users")
```

### Backward Compatibility

The logger is still available from `configuration.py` for backward compatibility:

```python
# Old way (still works)
from GameSentenceMiner.util.configuration import logger

# New way (recommended)
from GameSentenceMiner.util.logging_config import logger
```

### Advanced Usage

#### Manual Initialization

```python
from GameSentenceMiner.util.logging_config import initialize_logging

# Initialize with custom settings
initialize_logging(
    logger_name="my_component",
    console_level="DEBUG",
    file_level="DEBUG"
)
```

#### Log Cleanup

```python
from GameSentenceMiner.util.logging_config import cleanup_old_logs

# Clean up logs older than 7 days (default)
cleanup_old_logs()

# Custom retention period
cleanup_old_logs(days=14)
```

#### Dynamic Level Changes

```python
from GameSentenceMiner.util.logging_config import get_logger

logger = get_logger()
_manager = logger._manager  # Access the manager

# Change console level only
_manager.set_level("DEBUG", handler_type="console")

# Change all handlers
_manager.set_level("DEBUG")
```

## Log File Locations

All logs are stored in the application config directory:

- **Windows**: `%APPDATA%\GameSentenceMiner\logs\`
- **Linux/macOS**: `~/.config/GameSentenceMiner/logs/`

### Log Files

- `gamesentenceminer.log` - Main application logs
- `misc_ocr_utils.log` - OCR-related logs
- `gsm_overlay.log` - Overlay application logs
- `error.log` - All ERROR and CRITICAL messages from all components

Compressed archives (`.zip`) are created for rotated logs.

## Log Format

### Console Format
```
2026-01-21 15:14:22 | INFO     | gamesentenceminer:main:42 - Application started
```

### File Format
```
2026-01-21 15:14:22.123 | INFO     | gamesentenceminer:main:42 - Application started
```

Components:
- **Timestamp**: Date and time (milliseconds in file logs)
- **Level**: Log level (8 characters, aligned)
- **Name**: Logger name (component)
- **Function**: Function name where log was called
- **Line**: Line number in source file
- **Message**: The actual log message

## Architecture

### LoggerManager Class

The `LoggerManager` class handles all logging configuration:

```python
class LoggerManager:
    def initialize(self, logger_name, console_level, file_level)
    def cleanup_old_logs(self, days)
    def get_logger(self)
    def add_custom_level(self, name, severity, color)
    def set_level(self, level, handler_type)
```

### Context Detection

The system automatically detects the appropriate logger name based on:
1. Call stack analysis (looks for `gsm.py`, OCR modules, overlay modules)
2. Main module inspection
3. Falls back to "gamesentenceminer"

## Migration Guide

### For Existing Code

Most code will continue to work without changes since the logger is still exported from `configuration.py`. However, for new code:

**Old:**
```python
from GameSentenceMiner.util.configuration import logger
```

**New (recommended):**
```python
from GameSentenceMiner.util.logging_config import logger
```

### Removed Functions

The following functions have been removed from `configuration.py`:
- `get_logger_name()` - Now handled internally by logging_config
- `get_log_path()` - Now handled internally by logging_config
- `get_error_log_path()` - Now handled internally by logging_config
- `cleanup_old_logs()` - Now available from logging_config

If you were using these functions, import them from `logging_config` instead.

## Benefits Over Previous System

### Old System (stdlib logging)
- Manual configuration of handlers and formatters
- Complex rotation setup
- No color support
- Limited exception formatting
- Manual log cleanup

### New System (loguru)
- Automatic handler configuration
- Built-in rotation and compression
- Colorized output out-of-box
- Enhanced exception tracebacks with code context
- Automatic log cleanup
- More intuitive API
- Better performance with enqueued logging

## Performance Considerations

- **Enqueued logging**: All file writes are enqueued for non-blocking I/O
- **Lazy evaluation**: Message formatting only happens if the log level is enabled
- **Efficient rotation**: Uses efficient file operations for rotation and compression

## Troubleshooting

### Logs not appearing
- Check that logging is initialized (usually automatic)
- Verify log directory exists: `~/.config/GameSentenceMiner/logs/`
- Check console output for initialization messages

### Too many log files
- Old logs are automatically cleaned up (7-day retention by default)
- Manually trigger cleanup: `cleanup_old_logs(days=3)`

### Performance issues
- Increase rotation size if writing large logs frequently
- Adjust retention period to reduce disk I/O during cleanup

## Examples

### Complete Example

```python
from GameSentenceMiner.util.logging_config import logger, initialize_logging, cleanup_old_logs

# Initialize (optional, happens automatically)
initialize_logging(console_level="INFO", file_level="DEBUG")

# Use logging throughout your code
logger.info("Starting application")

try:
    # Your code here
    result = complex_operation()
    logger.success(f"Operation succeeded: {result}")
except ValueError as e:
    logger.error(f"Invalid value: {e}")
except Exception as e:
    logger.exception("Unexpected error occurred")
finally:
    logger.info("Cleanup complete")

# Clean up old logs
cleanup_old_logs()
```

### Context Manager Example

```python
from GameSentenceMiner.util.logging_config import logger

logger.info("Starting batch process")

with logger.contextualize(batch_id=123):
    logger.info("Processing item 1")  # Will include batch_id in context
    logger.info("Processing item 2")

logger.info("Batch complete")
```

## API Reference

### Functions

- `get_logger(name: Optional[str] = None) -> Logger`
  - Get the configured logger instance
  
- `initialize_logging(logger_name: Optional[str] = None, console_level: str = "INFO", file_level: str = "DEBUG")`
  - Initialize the logging system
  
- `cleanup_old_logs(days: int = 7)`
  - Clean up log files older than specified days
  
- `display(message: str)`
  - Display a message at DISPLAY level

### Logger Methods

All standard loguru methods are available:

- `logger.trace()`, `logger.debug()`, `logger.info()`, `logger.success()`
- `logger.warning()`, `logger.error()`, `logger.critical()`
- `logger.exception()` - Log exception with full traceback
- `logger.log(level, message)` - Log at custom level
- `logger.display()` - Log at DISPLAY level (custom)

## Future Enhancements

Potential future improvements:
- Log aggregation/shipping to external services
- Structured logging (JSON format option)
- Performance metrics collection
- Custom filters for sensitive data
- Integration with monitoring tools
