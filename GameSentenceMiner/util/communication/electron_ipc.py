"""Stdout/Stdin IPC utilities for GSM <-> Electron communication.

Electron expects structured messages printed to stdout as lines:
    GSMMSG:{JSON}
Where JSON is an object: {"function": <name>, "data": {...}, "id": optional}

Electron sends commands to GSM via stdin as lines:
    GSMCMD:{JSON}

This module replaces previous WebSocket-based communication.
"""

from __future__ import annotations

import json
import sys
import threading
from enum import Enum
from typing import Callable, Optional, Dict, Any

from GameSentenceMiner.util.configuration import logger


class FunctionName(Enum):
    QUIT = "quit"
    START = "start"
    STOP = "stop"
    QUIT_OBS = "quit_obs"
    START_OBS = "start_obs"
    OPEN_SETTINGS = "open_settings"
    OPEN_TEXTHOOKER = "open_texthooker"
    OPEN_LOG = "open_log"
    TOGGLE_REPLAY_BUFFER = "toggle_replay_buffer"
    RESTART_OBS = "restart_obs"
    EXIT = "exit"
    GET_STATUS = "get_status"
    CONNECT = "on_connect"


CommandHandler = Callable[[Dict[str, Any]], None]
_command_handler: Optional[CommandHandler] = None

def register_command_handler(handler: CommandHandler) -> None:
    """Register a handler invoked for each parsed GSMCMD JSON object.
    Handler receives a dict with keys: function, data, id (optional)."""
    global _command_handler
    _command_handler = handler


def send_message(function: str, data: Optional[Dict[str, Any]] = None, id: Optional[str] = None) -> None:
    """Print a structured message to stdout so Electron can pick it up."""
    payload = {"function": function}
    if data is not None:
        payload["data"] = data
    if id is not None:
        payload["id"] = id
    line = "GSMMSG:" + json.dumps(payload, ensure_ascii=False)
    print(line, flush=True)
    logger.debug(f"IPC Sent: {line}")


def _stdin_loop() -> None:
    """Blocking loop reading stdin for GSMCMD lines."""
    logger.debug("Starting stdin IPC loop (GSMCMD)...")
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        if not line.startswith("GSMCMD:"):
            # Ignore non-command lines
            continue
        json_part = line[7:]
        try:
            msg = json.loads(json_part)
            logger.debug(f"IPC Received command: {msg}")
            if _command_handler:
                _command_handler(msg)
        except Exception as e:
            logger.warning(f"Failed to parse GSMCMD line: {line} error={e}")


def start_ipc_listener_in_thread() -> threading.Thread:
    """Start stdin reading in a daemon thread so GSM main loop is not blocked."""
    t = threading.Thread(target=_stdin_loop, name="GSM_IPC_Listener", daemon=True)
    t.start()
    return t


# Convenience wrappers for common messages to Electron
def announce_start():
    send_message(FunctionName.START.value)

def announce_stop():
    send_message(FunctionName.STOP.value)

def announce_connected():
    send_message(FunctionName.CONNECT.value, {"message": "Python Connected"})

def announce_status(status: Dict[str, Any]):
    send_message(FunctionName.GET_STATUS.value, status)


if __name__ == "__main__":
    # Example usage when run standalone
    register_command_handler(lambda cmd: logger.info(f"Received command (standalone): {cmd}"))
    start_ipc_listener_in_thread()
    announce_connected()
    send_message("example", {"hello": "world"})
    # Keep process alive for manual testing
    try:
        while True:
            pass
    except KeyboardInterrupt:
        logger.info("Exiting standalone IPC test.")
