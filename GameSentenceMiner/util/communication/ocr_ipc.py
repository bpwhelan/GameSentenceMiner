"""Stdout/Stdin IPC utilities for OCR process <-> Electron communication.

This is a specialized IPC module for the OCR subprocess, following the same 
pattern as electron_ipc.py but tailored for OCR-specific commands.

Electron expects structured messages printed to stdout as lines:
    OCRMSG:{JSON}
Where JSON is an object: {"function": <name>, "data": {...}, "id": optional}

Electron sends commands to OCR via stdin as lines:
    OCRCMD:{JSON}

This module replaces the websocket-based remote control for OCR.
"""

from __future__ import annotations

import json
import sys
import threading
from enum import Enum
from typing import Callable, Optional, Dict, Any

# Use the centralized loguru logger
try:
    from GameSentenceMiner.util.logging_config import logger
except ImportError:
    # Fallback for standalone testing
    from loguru import logger


class OCRCommand(Enum):
    """Available commands that can be sent from Electron to OCR process."""
    PAUSE = "pause"
    UNPAUSE = "unpause"
    TOGGLE_PAUSE = "toggle_pause"
    GET_STATUS = "get_status"
    MANUAL_OCR = "manual_ocr"
    RELOAD_CONFIG = "reload_config"
    STOP = "stop"
    TOGGLE_FORCE_STABLE = "toggle_force_stable"
    SET_FORCE_STABLE = "set_force_stable"


class OCREvent(Enum):
    """Events that OCR process sends to Electron."""
    STARTED = "started"
    STOPPED = "stopped"
    PAUSED = "paused"
    UNPAUSED = "unpaused"
    STATUS = "status"
    ERROR = "error"
    OCR_RESULT = "ocr_result"
    CONFIG_RELOADED = "config_reloaded"
    FORCE_STABLE_CHANGED = "force_stable_changed"


CommandHandler = Callable[[Dict[str, Any]], None]
_command_handler: Optional[CommandHandler] = None
_stdin_thread: Optional[threading.Thread] = None


def register_command_handler(handler: CommandHandler) -> None:
    """Register a handler invoked for each parsed OCRCMD JSON object.
    Handler receives a dict with keys: command, data (optional), id (optional)."""
    global _command_handler
    _command_handler = handler


def send_event(event: str, data: Optional[Dict[str, Any]] = None, id: Optional[str] = None) -> None:
    """Send a structured event message to Electron via stdout."""
    payload = {"event": event}
    if data is not None:
        payload["data"] = data
    if id is not None:
        payload["id"] = id
    line = "OCRMSG:" + json.dumps(payload, ensure_ascii=False)
    print(line, flush=True)
    logger.debug(f"OCR IPC Sent: {line}")


def _stdin_loop() -> None:
    """Blocking loop reading stdin for OCRCMD lines."""
    logger.debug("Starting OCR stdin IPC loop (OCRCMD)...")
    try:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            if not line.startswith("OCRCMD:"):
                # Ignore non-command lines
                continue
            json_part = line[7:]
            try:
                msg = json.loads(json_part)
                logger.debug(f"OCR IPC Received command: {msg}")
                if _command_handler:
                    _command_handler(msg)
            except Exception as e:
                logger.warning(f"Failed to parse OCRCMD line: {line} error={e}")
    except Exception as e:
        logger.error(f"OCR stdin loop error: {e}")


def start_ipc_listener() -> threading.Thread:
    """Start stdin reading in a daemon thread so OCR main loop is not blocked."""
    global _stdin_thread
    if _stdin_thread and _stdin_thread.is_alive():
        logger.warning("OCR IPC listener already running")
        return _stdin_thread
    
    _stdin_thread = threading.Thread(target=_stdin_loop, name="OCR_IPC_Listener", daemon=True)
    _stdin_thread.start()
    logger.info("OCR IPC listener started")
    return _stdin_thread


# Convenience wrappers for common events to Electron
def announce_started():
    """Announce that OCR process has started."""
    send_event(OCREvent.STARTED.value)


def announce_stopped():
    """Announce that OCR process has stopped."""
    send_event(OCREvent.STOPPED.value)


def announce_paused():
    """Announce that OCR is now paused."""
    send_event(OCREvent.PAUSED.value, {"paused": True})


def announce_unpaused():
    """Announce that OCR is now unpaused."""
    send_event(OCREvent.UNPAUSED.value, {"paused": False})


def announce_status(status: Dict[str, Any]):
    """Announce current OCR status."""
    send_event(OCREvent.STATUS.value, status)


def announce_error(error: str, details: Optional[Dict[str, Any]] = None):
    """Announce an error occurred."""
    data = {"error": error}
    if details:
        data.update(details)
    send_event(OCREvent.ERROR.value, data)


def announce_ocr_result(text: str, metadata: Optional[Dict[str, Any]] = None):
    """Announce an OCR result."""
    data = {"text": text}
    if metadata:
        data.update(metadata)
    send_event(OCREvent.OCR_RESULT.value, data)


def announce_config_reloaded():
    """Announce that OCR config was reloaded."""
    send_event(OCREvent.CONFIG_RELOADED.value)


def announce_force_stable_changed(enabled: bool):
    """Announce that force stable mode changed."""
    send_event(OCREvent.FORCE_STABLE_CHANGED.value, {"enabled": enabled})


if __name__ == "__main__":
    # Example usage when run standalone for testing
    import time
    
    def test_handler(cmd: dict):
        print(f"Test handler received: {cmd}")
        command = cmd.get("command")
        
        if command == OCRCommand.GET_STATUS.value:
            announce_status({
                "paused": False,
                "engine": "test",
                "scan_rate": 1.0
            })
        elif command == OCRCommand.TOGGLE_PAUSE.value:
            announce_paused()
    
    register_command_handler(test_handler)
    start_ipc_listener()
    announce_started()
    
    print("OCR IPC test mode - send commands via stdin", file=sys.stderr)
    print("Example: OCRCMD:{\"command\":\"get_status\"}", file=sys.stderr)
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        announce_stopped()
        print("\nExiting OCR IPC test", file=sys.stderr)
