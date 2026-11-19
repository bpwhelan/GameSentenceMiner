"""Read-only projection of the desktop's current mining session."""

import asyncio
import ctypes
import os

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.config.desktop_profile import enabled

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
                _state = state
                master = get_master_config()
                profile = state.get("profile")
                if master and profile in master.configs:
                    master.current_profile = profile
                gsm_state.current_game = state["scene"]
                changed.set()
            if after is None:
                await asyncio.sleep(0.5)
    finally:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
