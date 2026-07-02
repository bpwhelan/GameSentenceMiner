"""OCR process <-> Electron IPC.

Transport is the unified message bus (see bus_client.py and the Electron broker
in electron-src/main/runtime/message_bus.ts) when GSM is launched by Electron
(env GSM_BROKER_PORT/GSM_BROKER_TOKEN present). When run standalone, it falls
back to the legacy stdout/stdin line protocol (OCRMSG:/OCRCMD:) so the OCR
process is still usable on its own.

Bus mapping:
  - events  OCR -> main : topic "ocr.event", data {"event": <name>, "data": {...}}
  - commands main -> OCR: topic "ocr.command", data {"command": <name>, ...}

This module keeps the same public API it always had (register_command_handler,
start_ipc_listener, send_event, announce_*) so gsm_ocr.py doesn't need to change.
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

from GameSentenceMiner.util.communication import bus_client

# Bus topics for the OCR <-> main channel.
OCR_EVENT_TOPIC = "ocr.event"
OCR_COMMAND_TOPIC = "ocr.command"


class OCRCommand(Enum):
    """Available commands that can be sent from Electron to OCR process."""

    PAUSE = "pause"
    UNPAUSE = "unpause"
    TOGGLE_PAUSE = "toggle_pause"
    GET_STATUS = "get_status"
    MANUAL_OCR = "manual_ocr"
    WHOLE_WINDOW_OCR = "whole_window_ocr"
    AREA_SELECT_OCR = "area_select_ocr"
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


def _use_bus() -> bool:
    return bus_client.is_bus_available()


def register_command_handler(handler: CommandHandler) -> None:
    """Register a handler invoked for each parsed OCR command JSON object.
    Handler receives a dict with keys: command, data (optional), id (optional)."""
    global _command_handler
    _command_handler = handler


def send_event(event: str, data: Optional[Dict[str, Any]] = None, id: Optional[str] = None) -> None:
    """Send a structured event message to Electron (bus, or stdout fallback)."""
    if _use_bus():
        payload: Dict[str, Any] = {"event": event}
        if data is not None:
            payload["data"] = data
        if id is not None:
            payload["id"] = id
        # Broadcast: main consumes events for the UI; the backend consumes
        # ocr_result for the text-intake pipeline (no main relay).
        bus_client.get_bus().publish(bus_client.BROADCAST, OCR_EVENT_TOPIC, payload)
        logger.debug(f"OCR bus event sent: {event}")
        return

    # Legacy stdout fallback.
    payload = {"event": event}
    if data is not None:
        payload["data"] = data
    if id is not None:
        payload["id"] = id
    line = "OCRMSG:" + json.dumps(payload, ensure_ascii=False)
    print(line, flush=True)
    logger.debug(f"OCR IPC Sent: {line}")


def _dispatch_command(cmd_data: Dict[str, Any]) -> None:
    if _command_handler:
        try:
            _command_handler(cmd_data)
        except Exception as e:
            logger.warning(f"Error in OCR command handler: {e}")


def _on_bus_command(msg: Dict[str, Any]) -> None:
    """Bus subscriber: unwrap the command payload and dispatch it."""
    cmd_data = msg.get("data") or {}
    if isinstance(cmd_data, dict):
        logger.debug(f"OCR bus command received: {cmd_data.get('command')}")
        _dispatch_command(cmd_data)


def _stdin_loop() -> None:
    """Legacy blocking loop reading stdin for OCRCMD lines (standalone mode)."""
    logger.debug("Starting OCR stdin IPC loop (OCRCMD)...")
    try:
        for raw in sys.stdin:
            line = raw.strip()
            if not line or not line.startswith("OCRCMD:"):
                continue
            json_part = line[7:]
            try:
                msg = json.loads(json_part)
                logger.debug(f"OCR IPC Received command: {msg}")
                _dispatch_command(msg)
            except Exception as e:
                logger.warning(f"Failed to parse OCRCMD line: {line} error={e}")
    except Exception as e:
        logger.error(f"OCR stdin loop error: {e}")


def start_ipc_listener() -> Optional[threading.Thread]:
    """Begin receiving commands from Electron.

    On the bus: connect and subscribe to the command topic. Standalone: spawn the
    legacy stdin reader thread.
    """
    if _use_bus():
        client = bus_client.start_bus()
        client.subscribe(OCR_COMMAND_TOPIC, _on_bus_command)
        logger.info("OCR IPC listener started (message bus)")
        return None

    global _stdin_thread
    if _stdin_thread and _stdin_thread.is_alive():
        logger.warning("OCR IPC listener already running")
        return _stdin_thread

    _stdin_thread = threading.Thread(target=_stdin_loop, name="OCR_IPC_Listener", daemon=True)
    _stdin_thread.start()
    logger.info("OCR IPC listener started (stdin fallback)")
    return _stdin_thread


# Convenience wrappers for common events to Electron
def announce_started():
    send_event(OCREvent.STARTED.value)


def announce_stopped():
    send_event(OCREvent.STOPPED.value)


def announce_paused():
    send_event(OCREvent.PAUSED.value, {"paused": True})


def announce_unpaused():
    send_event(OCREvent.UNPAUSED.value, {"paused": False})


def announce_status(status: Dict[str, Any]):
    send_event(OCREvent.STATUS.value, status)


def announce_error(error: str, details: Optional[Dict[str, Any]] = None):
    data = {"error": error}
    if details:
        data.update(details)
    send_event(OCREvent.ERROR.value, data)


def announce_ocr_result(text: str, metadata: Optional[Dict[str, Any]] = None):
    data = {"text": text}
    if metadata:
        data.update(metadata)
    send_event(OCREvent.OCR_RESULT.value, data)


def announce_config_reloaded():
    send_event(OCREvent.CONFIG_RELOADED.value)


def announce_force_stable_changed(enabled: bool):
    send_event(OCREvent.FORCE_STABLE_CHANGED.value, {"enabled": enabled})
