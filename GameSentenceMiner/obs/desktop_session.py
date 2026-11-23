"""Read-only projection of the desktop's current mining session."""

import asyncio
import ctypes
import os
import threading

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.config.desktop_profile import enabled as backend_enabled

__all__ = ["enabled", "select_profile", "snapshot", "validated_hwnd", "watch"]

_EMPTY = {
    "scene": "",
    "source_name": "",
    "target_id": None,
    "target_pid": None,
    "window_info": None,
    "capture_source": "",
    "capture_kind": "window",
    "process_path": "",
    "available": False,
    "active": None,
}
_state = _EMPTY
_reader = None
_reader_lock = threading.Lock()
_APPLICATION_FIELDS = (
    "scene",
    "scene_epoch",
    "profile",
    "choices",
    "connection",
    "connected",
    "replay_active",
    "record_active",
    "record_directory",
    "replay_seconds",
)


def reader_enabled():
    return bool(os.environ.get("GSM_OBS_READER_PORT")) and os.environ.get("GSM_OBS_BACKEND_PID") != str(os.getpid())


def enabled():
    return backend_enabled() or reader_enabled()


def reader_bus():
    """Give each desktop-owned OCR/preview process a separate read-only subscription."""
    from GameSentenceMiner.util.communication.bus_client import MAIN, BusClient

    global _reader, _state
    with _reader_lock:
        if _reader is None:
            bus = BusClient(
                client_id=f"obs-reader-{os.getpid()}",
                port=int(os.environ["GSM_OBS_READER_PORT"]),
                token=os.environ["GSM_OBS_READER_TOKEN"],
            )
            bus.start()
            try:
                if not bus.wait_connected(5):
                    raise ConnectionError("Desktop OBS reader could not connect")
                _state = bus.request(MAIN, "game.session")
            except Exception:
                bus.stop()
                raise
            _reader = bus
            bus.submit(_watch_reader(bus, _state["revision"]))
        return _reader


async def _watch_reader(bus, revision):
    from websockets.exceptions import ConnectionClosed

    from GameSentenceMiner.util.communication.bus_client import MAIN

    global _state
    while True:
        try:
            _state = await bus.request_async(MAIN, "game.session", {"after": revision}, timeout=12)
            revision = _state["revision"]
        except (OSError, RuntimeError, ConnectionClosed):
            _state, revision = _EMPTY, None
            await asyncio.sleep(0.5)


def stop_reader():
    global _reader, _state
    with _reader_lock:
        if _reader is not None:
            _reader.stop()
            _reader, _state = None, _EMPTY


def snapshot():
    return _state.copy()


def validated_hwnd(state):
    hwnd, pid = state.get("target_id"), state.get("target_pid")
    if os.name != "nt" or not hwnd or not pid:
        return None
    current_pid = ctypes.c_ulong()
    ctypes.windll.user32.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(current_pid))
    return hwnd if current_pid.value == pid else None


def select_profile(name, *, scene_epoch=None):
    from GameSentenceMiner.util.communication import bus_client

    args = {"name": name}
    if scene_epoch is not None:
        args["scene_epoch"] = scene_epoch
    return bus_client.get_bus().request(bus_client.MAIN, "game.profile.select", args)


def window_action(action, hwnd, target_pid=None, **options):
    from GameSentenceMiner.util.communication import bus_client

    state = _state
    if not hwnd or hwnd != state.get("target_id") or (target_pid and target_pid != state.get("target_pid")):
        return False
    return bus_client.get_bus().request(
        bus_client.MAIN, "game.windowInput", {"action": action, "hwnd": hwnd, "pid": state["target_pid"], **options}
    )


async def watch(on_change):
    from websockets.exceptions import ConnectionClosed

    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.util.config.configuration import get_master_config, gsm_state

    global _state
    after = None
    previous = _EMPTY
    changed = asyncio.Event()

    async def apply_changes():
        nonlocal previous
        while True:
            await changed.wait()
            changed.clear()
            latest = _state
            try:
                await asyncio.to_thread(on_change, previous, latest)
                previous = latest
            except Exception:  # noqa: BLE001 - keep the subscription alive if a mining callback fails
                logger.exception("Could not apply the current desktop game session")
                await asyncio.sleep(1)
                changed.set()

    worker = asyncio.create_task(apply_changes())
    try:
        while True:
            try:
                state = await bus_client.get_bus().request_async(
                    bus_client.MAIN, "game.session", {"after": after}, timeout=12
                )
                after = state["revision"]
            except (OSError, RuntimeError, ConnectionClosed):
                state, after = _EMPTY, None
            if state != _state:
                application_changed = any(state.get(key) != _state.get(key) for key in _APPLICATION_FIELDS)
                window_changed = state.get("window_state") != _state.get("window_state") or state.get(
                    "target_id"
                ) != _state.get("target_id")
                _state = state
                if window_changed and os.name == "nt":
                    from GameSentenceMiner.util.platform.window_state_monitor import get_window_state_monitor

                    if monitor := get_window_state_monitor():
                        monitor.request_refresh()
                if application_changed:
                    master = get_master_config()
                    profile = state.get("profile")
                    if master and profile in master.configs:
                        master.current_profile = profile
                    gsm_state.current_game = state["scene"]
                    changed.set()
            stopped = gsm_state.replay_buffer_stopped_timestamp
            if stopped:
                import time

                if time.time() - stopped > 900:
                    gsm_state.disable_anki_confirmation_session = False
                    gsm_state.replay_buffer_stopped_timestamp = None
            if after is None:
                await asyncio.sleep(0.5)
    finally:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
