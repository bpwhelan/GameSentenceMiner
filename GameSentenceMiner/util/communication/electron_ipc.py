"""Backend <-> Electron IPC.

Transport is the unified message bus (see bus_client.py and the Electron broker
in electron-src/main/runtime/message_bus.ts) when GSM is launched by Electron
(env GSM_BROKER_PORT/GSM_BROKER_TOKEN present). When run standalone it falls
back to the legacy stdout/stdin line protocol (GSMMSG:/GSMCMD:).

Bus mapping:
  - backend -> main : topic "backend.event",   data {"function": <name>, "data": {...}}
  - main -> backend : topic "backend.command", data {"function": <name>, "data": {...}}
  - ocr broadcast   : topic "ocr.event" is also subscribed so OCR results reach the
                      backend directly (no main relay); an ocr_result event is
                      bridged into the same command handler as the legacy path.

The public API is unchanged (send_message, register_command_handler,
start_ipc_listener_in_thread, announce_*, send_install_progress, ...) so callers
across the backend don't need to change.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from enum import Enum
from typing import Callable, Optional, Dict, Any

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.communication import bus_client

# Bus topics for the backend <-> main channel.
BACKEND_EVENT_TOPIC = "backend.event"
BACKEND_COMMAND_TOPIC = "backend.command"
OCR_EVENT_TOPIC = "ocr.event"


class FunctionName(Enum):
    QUIT = "quit"
    START = "start"
    STOP = "stop"
    INITIALIZED = "initialized"
    QUIT_OBS = "quit_obs"
    START_OBS = "start_obs"
    OPEN_SETTINGS = "open_settings"
    RELOAD_SETTINGS = "reload_settings"
    OPEN_OVERLAY_SETTINGS = "open_overlay_settings"
    OPEN_TEXTHOOKER = "open_texthooker"
    SWITCH_PROFILE = "switch_profile"
    RELATE_SCENE_TO_PROFILE = "relate_scene_to_profile"
    OPEN_LOG = "open_log"
    TOGGLE_REPLAY_BUFFER = "toggle_replay_buffer"
    RESTART_OBS = "restart_obs"
    TEST_ANKI_CONFIRMATION = "test_anki_confirmation"
    TEST_SCREENSHOT_SELECTOR = "test_screenshot_selector"
    TEST_FURIGANA_FILTER = "test_furigana_filter"
    TEST_AREA_SELECTOR = "test_area_selector"
    TEST_SCREEN_CROPPER = "test_screen_cropper"
    EXIT = "exit"
    GET_STATUS = "get_status"
    CONNECT = "on_connect"
    RESTART_PYTHON_APP = "restart_python_app"
    TEXTHOOK_TEXT = "texthook_text"
    OCR_RESULT = "ocr_result"


CommandHandler = Callable[[Dict[str, Any]], None]
_command_handler: Optional[CommandHandler] = None

# Text events are non-blocking (just schedule a coroutine). They must never be
# queued behind slow commands like config reloads or OBS restarts.
_FAST_PATH_FUNCTIONS = frozenset({FunctionName.TEXTHOOK_TEXT.value, FunctionName.OCR_RESULT.value})

# Worker thread for slow IPC commands so the transport reader is never blocked.
_command_dispatch_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="GSM_IPC_Cmd")

_stdin_thread: Optional[threading.Thread] = None


def _use_bus() -> bool:
    return bus_client.is_bus_available()


def register_command_handler(handler: CommandHandler) -> None:
    """Register a handler invoked for each parsed command object.
    Handler receives a dict with keys: function, data, id (optional)."""
    global _command_handler
    _command_handler = handler


def send_message(function: str, data: Optional[Dict[str, Any]] = None, id: Optional[str] = None) -> None:
    """Send a structured message to Electron (bus, or stdout fallback)."""
    if _use_bus():
        payload: Dict[str, Any] = {"function": function}
        if data is not None:
            payload["data"] = data
        if id is not None:
            payload["id"] = id
        bus_client.get_bus().publish(bus_client.MAIN, BACKEND_EVENT_TOPIC, payload)
        logger.debug(f"IPC bus event sent: {function}")
        return

    payload = {"function": function}
    if data is not None:
        payload["data"] = data
    if id is not None:
        payload["id"] = id
    line = "GSMMSG:" + json.dumps(payload, ensure_ascii=False)
    print(line, flush=True)
    logger.debug(f"IPC Sent: {line}")


def get_install_session_id() -> str:
    return str(os.environ.get("GSM_INSTALL_SESSION_ID", "") or "").strip()


def send_install_progress(
    stage_id: str,
    status: str,
    progress_kind: str = "indeterminate",
    progress: Optional[float] = None,
    message: str = "",
    downloaded_bytes: Optional[int] = None,
    total_bytes: Optional[int] = None,
    error: Optional[str] = None,
    session_id: Optional[str] = None,
) -> None:
    payload: Dict[str, Any] = {
        "session_id": session_id if session_id is not None else get_install_session_id(),
        "stage_id": stage_id,
        "status": status,
        "progress_kind": progress_kind,
        "message": message,
    }
    if progress is not None:
        payload["progress"] = max(0.0, min(1.0, float(progress)))
    if downloaded_bytes is not None:
        payload["downloaded_bytes"] = int(downloaded_bytes)
    if total_bytes is not None:
        payload["total_bytes"] = int(total_bytes)
    if error:
        payload["error"] = str(error)
    send_message("install_progress", payload)


def _safe_dispatch(msg: Dict[str, Any]) -> None:
    """Execute the command handler (used on the dispatch worker thread)."""
    try:
        if _command_handler:
            _command_handler(msg)
    except Exception as e:
        logger.warning(f"Error in IPC command dispatch: {e}")


def _dispatch_command(msg: Dict[str, Any]) -> None:
    """Route a {function, data, id} command: fast-path inline, slow ones to a worker."""
    if not _command_handler:
        return
    func = msg.get("function") or ""
    if func in _FAST_PATH_FUNCTIONS:
        try:
            _command_handler(msg)
        except Exception as e:
            logger.warning(f"Error in fast-path IPC handler: {e}")
    else:
        _command_dispatch_pool.submit(_safe_dispatch, msg)


def _on_backend_command(busmsg: Dict[str, Any]) -> None:
    cmd = busmsg.get("data") or {}
    if isinstance(cmd, dict):
        logger.debug(f"IPC bus command received: {cmd.get('function')}")
        _dispatch_command(cmd)


def _on_ocr_event(busmsg: Dict[str, Any]) -> None:
    """Bridge an OCR broadcast result into the backend command handler."""
    data = busmsg.get("data") or {}
    if isinstance(data, dict) and data.get("event") == FunctionName.OCR_RESULT.value:
        _dispatch_command({"function": FunctionName.OCR_RESULT.value, "data": data.get("data")})


def _stdin_loop() -> None:
    """Legacy stdin reader for GSMCMD lines (standalone mode)."""
    logger.debug("Starting stdin IPC loop (GSMCMD)...")
    for raw in sys.stdin:
        line = raw.strip()
        if not line or not line.startswith("GSMCMD:"):
            continue
        try:
            msg = json.loads(line[7:])
        except Exception as e:
            logger.warning(f"Failed to parse GSMCMD line: {line} error={e}")
            continue
        logger.debug(f"IPC Received command: {msg}")
        _dispatch_command(msg)


def start_ipc_listener_in_thread() -> Optional[threading.Thread]:
    """Begin receiving commands from Electron (bus, or stdin fallback)."""
    if _use_bus():
        client = bus_client.start_bus()
        client.subscribe(BACKEND_COMMAND_TOPIC, _on_backend_command)
        client.subscribe(OCR_EVENT_TOPIC, _on_ocr_event)
        logger.debug("Backend IPC listener started (message bus)")
        return None

    global _stdin_thread
    t = threading.Thread(target=_stdin_loop, name="GSM_IPC_Listener", daemon=True)
    t.start()
    _stdin_thread = t
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


def request_python_app_restart(reason: str = "", open_settings: bool = True):
    payload: Dict[str, Any] = {}
    if reason:
        payload["reason"] = reason
    payload["open_settings"] = bool(open_settings)
    send_message(FunctionName.RESTART_PYTHON_APP.value, payload or None)
