"""Connect / disconnect / wait helpers for the OBS WebSocket."""

from __future__ import annotations

import asyncio
import socket
import time
from typing import Optional

import obsws_python as obs

from GameSentenceMiner.obs._state import (
    get_connection_pool,
    get_obs_connection_manager,
    get_obs_service,
    is_connecting,
    set_connecting,
    set_connection_pool,
    set_event_client,
    set_obs_connection_manager,
    set_obs_service,
)
from GameSentenceMiner.obs.connection_manager import OBSConnectionManager
from GameSentenceMiner.obs.service import OBSService
from GameSentenceMiner.obs.types import _is_obs_recording_disabled
from GameSentenceMiner.util.config.configuration import get_config, gsm_state, gsm_status, is_windows, logger


# ---------------------------------------------------------------------------
# Reachability
# ---------------------------------------------------------------------------


def is_obs_websocket_reachable(host: Optional[str] = None, port: Optional[int] = None, timeout: float = 0.25):
    host = host or get_config().obs.host
    port = port or get_config().obs.port
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Wait helpers
# ---------------------------------------------------------------------------


async def wait_for_obs_connected():
    pool = get_connection_pool()
    if not pool:
        return False
    for _ in range(10):
        try:
            client = pool.get_healthcheck_client()
            if client:
                response = client.get_version()
                if response:
                    return True
        except Exception as e:
            logger.debug(f"Waiting for OBS connection: {e}")
            await asyncio.sleep(1)
    return False


async def wait_for_obs_websocket_ready(
    timeout: Optional[float] = None,
    interval: float = 2.0,
    host: Optional[str] = None,
    port: Optional[int] = None,
):
    start = time.time()
    while True:
        if is_obs_websocket_reachable(host=host, port=port):
            return True
        if timeout is not None and (time.time() - start) >= timeout:
            return False
        if not gsm_state.keep_running:
            return False
        await asyncio.sleep(interval)


async def wait_for_obs_ready(
    timeout: Optional[float] = None,
    interval: float = 2.0,
    host: Optional[str] = None,
    port: Optional[int] = None,
    password: Optional[str] = None,
):
    start = time.time()
    host = host or get_config().obs.host
    port = port or get_config().obs.port
    password = password if password is not None else get_config().obs.password
    while True:
        if is_obs_websocket_reachable(host=host, port=port):
            try:
                client = obs.ReqClient(host=host, port=port, password=password, timeout=1)
                client.get_version()
                scene_response = client.get_scene_list()
                if scene_response and scene_response.scenes is not None:
                    return True
            except Exception:
                pass
        if timeout is not None and (time.time() - start) >= timeout:
            return False
        if not gsm_state.keep_running:
            return False
        await asyncio.sleep(interval)


# ---------------------------------------------------------------------------
# Connect / disconnect
# ---------------------------------------------------------------------------


async def connect_to_obs(retry=5, connections=2, check_output=False):
    if get_obs_service() or is_connecting():
        return

    if is_windows():
        from GameSentenceMiner.obs.process import get_obs_websocket_config_values

        get_obs_websocket_config_values()

    set_connecting(True)
    try:
        while retry > 0:
            try:
                obs_service = OBSService(
                    host=get_config().obs.host,
                    port=get_config().obs.port,
                    password=get_config().obs.password,
                    connections=connections,
                    check_output=check_output,
                )

                set_obs_service(obs_service)
                set_connection_pool(obs_service.connection_pool)
                set_event_client(obs_service.event_client)

                gsm_status.obs_connected = True
                logger.success("Connected to OBS WebSocket.")

                if not get_obs_connection_manager():
                    manager = OBSConnectionManager(check_output=check_output)
                    set_obs_connection_manager(manager)
                    manager.start()

                try:
                    from GameSentenceMiner.obs.operations import update_current_game

                    update_current_game()
                except Exception:
                    pass

                try:
                    from GameSentenceMiner.obs.operations import apply_obs_performance_settings

                    apply_obs_performance_settings()
                except Exception:
                    pass

                if get_config().features.generate_longplay and check_output and not _is_obs_recording_disabled():
                    try:
                        from GameSentenceMiner.obs.operations import start_recording

                        start_recording(True)
                    except Exception:
                        pass
                break
            except Exception as e:
                retry -= 1
                if retry <= 0:
                    gsm_status.obs_connected = False
                    logger.error(f"Failed to connect to OBS WebSocket after retries: {e}")
                    set_connection_pool(None)
                    set_event_client(None)
                    set_obs_service(None)
                    break
                await asyncio.sleep(1)
    finally:
        set_connecting(False)


def connect_to_obs_sync(retry=2, connections=2, check_output=False):
    if get_obs_service() or is_connecting():
        return

    if is_windows():
        from GameSentenceMiner.obs.process import get_obs_websocket_config_values

        get_obs_websocket_config_values()

    set_connecting(True)
    try:
        while retry > 0:
            try:
                obs_service = OBSService(
                    host=get_config().obs.host,
                    port=get_config().obs.port,
                    password=get_config().obs.password,
                    connections=connections,
                    check_output=check_output,
                )

                set_obs_service(obs_service)
                set_connection_pool(obs_service.connection_pool)
                set_event_client(obs_service.event_client)

                gsm_status.obs_connected = True
                logger.success("Connected to OBS WebSocket.")

                if not get_obs_connection_manager():
                    manager = OBSConnectionManager(check_output=check_output)
                    set_obs_connection_manager(manager)
                    manager.start()

                try:
                    from GameSentenceMiner.obs.operations import update_current_game

                    update_current_game()
                except Exception:
                    pass

                try:
                    from GameSentenceMiner.obs.operations import apply_obs_performance_settings

                    apply_obs_performance_settings()
                except Exception:
                    pass

                if get_config().features.generate_longplay and check_output and not _is_obs_recording_disabled():
                    try:
                        from GameSentenceMiner.obs.operations import start_recording

                        start_recording(True)
                    except Exception:
                        pass
                break
            except Exception as e:
                retry -= 1
                if retry <= 0:
                    gsm_status.obs_connected = False
                    logger.error(f"Failed to connect to OBS WebSocket: {e}")
                    set_connection_pool(None)
                    set_event_client(None)
                    set_obs_service(None)
                    break
                time.sleep(1)
    finally:
        set_connecting(False)


def disconnect_from_obs():
    obs_service = get_obs_service()
    if obs_service:
        obs_service.disconnect()
        set_obs_service(None)

    set_connection_pool(None)
    set_event_client(None)

    logger.info("Disconnected from OBS WebSocket.")
