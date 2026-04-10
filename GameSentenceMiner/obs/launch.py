"""OBS process lifecycle, path helpers, source utilities, and GUI error queue."""

import asyncio
import json
import os
import psutil
import queue
import shlex
import shutil
import socket
import subprocess
import time
from typing import Dict, List, Optional

from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import (
    get_app_directory,
    get_config,
    get_master_config,
    gsm_state,
    logger,
    reload_config,
)

# ---------------------------------------------------------------------------
# GUI error queue
# ---------------------------------------------------------------------------
_gui_error_queue: queue.Queue = queue.Queue()


def _queue_error_for_gui(title, message, recheck_function=None):
    _gui_error_queue.put((title, message, recheck_function))


def get_queued_gui_errors():
    errors = []
    try:
        while True:
            errors.append(_gui_error_queue.get_nowait())
    except queue.Empty:
        pass
    return errors


# ---------------------------------------------------------------------------
# Video source constants & utilities
# ---------------------------------------------------------------------------
VIDEO_SOURCE_KINDS = {"window_capture", "game_capture", "monitor_capture"}
VIDEO_SOURCE_PRIORITY = {
    "game_capture": 0,
    "window_capture": 1,
    "monitor_capture": 2,
}


def get_video_source_priority(input_kind: Optional[str]) -> int:
    return VIDEO_SOURCE_PRIORITY.get(str(input_kind or ""), 999)


def sort_video_sources_by_preference(
    scene_items: List[dict],
    input_active_by_name: Optional[Dict[str, bool]] = None,
    input_show_by_name: Optional[Dict[str, bool]] = None,
) -> List[dict]:
    if not scene_items:
        return []
    video_sources = [item for item in scene_items if item.get("inputKind") in VIDEO_SOURCE_KINDS]
    if not video_sources:
        return list(scene_items)

    def sort_key(item: dict):
        source_name = item.get("sourceName")
        active_state = input_active_by_name.get(source_name) if input_active_by_name else None
        show_state = input_show_by_name.get(source_name) if input_show_by_name else None
        explicitly_inactive = active_state is False or show_state is False
        return (
            1 if explicitly_inactive else 0,
            get_video_source_priority(item.get("inputKind")),
        )

    return sorted(video_sources, key=sort_key)


def get_preferred_video_source(
    scene_items: List[dict],
    input_active_by_name: Optional[Dict[str, bool]] = None,
    input_show_by_name: Optional[Dict[str, bool]] = None,
):
    sorted_sources = sort_video_sources_by_preference(
        scene_items,
        input_active_by_name=input_active_by_name,
        input_show_by_name=input_show_by_name,
    )
    return sorted_sources[0] if sorted_sources else None


def get_video_scene_items(scene_items: List[dict]) -> List[dict]:
    if not scene_items:
        return []
    return [item for item in scene_items if item.get("inputKind") in VIDEO_SOURCE_KINDS]


def is_image_empty(img) -> bool:
    try:
        extrema = img.getextrema()
        if not extrema:
            return True
        if isinstance(extrema[0], tuple):
            return all(channel_min == channel_max for channel_min, channel_max in extrema)
        return extrema[0] == extrema[1]
    except Exception:
        return False


HELPER_SCENE_NAMES = {"GSM Helper - DONT TOUCH"}
HELPER_SOURCE_NAMES = {
    "window_getter",
    "game_window_getter",
    "capture_card_getter",
    "audio_input_getter",
}
_NORMALIZED_HELPER_SCENE_NAMES = {name.casefold() for name in HELPER_SCENE_NAMES}
_NORMALIZED_HELPER_SOURCE_NAMES = {name.casefold() for name in HELPER_SOURCE_NAMES}


def is_helper_scene_name(scene_name: Optional[str]) -> bool:
    return str(scene_name or "").strip().casefold() in _NORMALIZED_HELPER_SCENE_NAMES


def is_helper_source_name(source_name: Optional[str]) -> bool:
    return str(source_name or "").strip().casefold() in _NORMALIZED_HELPER_SOURCE_NAMES


def _should_skip_image_validation(source_name: Optional[str] = None, scene_name: Optional[str] = None) -> bool:
    if is_helper_scene_name(scene_name):
        return True
    return is_helper_source_name(source_name)


# ---------------------------------------------------------------------------
# OBS window target parsing
# ---------------------------------------------------------------------------
def parse_obs_window_target(window_string: str) -> Optional[dict]:
    """Parse an OBS window target string ``"Title:Class:exe"`` into its parts.

    The title itself may contain colons, so we split from the right.
    """
    if not window_string:
        return None
    parts = window_string.rsplit(":", 2)
    if len(parts) < 3:
        return None
    return {
        "title": parts[0].strip(),
        "window_class": parts[1].strip(),
        "exe": parts[2].strip(),
    }


def _window_target_exists(target: str) -> bool:
    """Return True if the OBS window-capture target appears to be running."""
    parsed = parse_obs_window_target(target)
    if not parsed or not parsed.get("exe"):
        return True  # can't determine — assume it exists
    exe_lower = parsed["exe"].lower()
    try:
        for proc in psutil.process_iter(["name"]):
            if proc.info["name"] and proc.info["name"].lower() == exe_lower:
                return True
    except Exception:
        return True
    return False


# ---------------------------------------------------------------------------
# OBS process management
# ---------------------------------------------------------------------------
def get_base_obs_dir():
    return os.path.join(configuration.get_app_directory(), "obs-studio")


def get_obs_path():
    config = get_config()
    if config.obs.obs_path:
        return config.obs.obs_path
    return os.path.join(configuration.get_app_directory(), "obs-studio/bin/64bit/obs64.exe")


def _resolve_obs_launch_command(obs_path: str):
    if os.path.exists(obs_path):
        return [obs_path], os.path.dirname(obs_path)
    try:
        cmd = shlex.split(obs_path)
    except ValueError:
        cmd = obs_path.split()
    if not cmd:
        return None, None
    exe = cmd[0]
    if os.path.exists(exe) or shutil.which(exe):
        cwd = os.path.dirname(exe) if os.path.exists(exe) else None
        return cmd, cwd
    return None, None


def _remove_obs_startup_artifact(path: str, label: str) -> None:
    if not os.path.exists(path):
        return
    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
        logger.debug(f"Deleted OBS startup {label}: {path}")
    except Exception as e:
        logger.error(f"Failed to delete OBS startup {label}: {e}")


def _cleanup_obs_startup_artifacts(app_directory: str = None) -> None:
    base_config_dir = os.path.join(
        app_directory or configuration.get_app_directory(),
        "obs-studio",
        "config",
        "obs-studio",
    )
    _remove_obs_startup_artifact(os.path.join(base_config_dir, ".sentinel"), "sentinel")
    _remove_obs_startup_artifact(
        os.path.join(
            base_config_dir,
            "plugin_config",
            "advanced-scene-switcher",
            ".running",
        ),
        "advanced-scene-switcher running file",
    )


def _build_obs_launch_command(base_cmd: list[str], config_override=None) -> list[str]:
    cfg = config_override or get_config()
    obs_cfg = cfg.obs
    obs_cmd = [*base_cmd, "--disable-shutdown-check", "--portable"]
    if not getattr(obs_cfg, "allow_automatic_updates", False):
        obs_cmd.append("--disable-updater")
    if not getattr(obs_cfg, "disable_recording", False):
        obs_cmd.append("--startreplaybuffer")
    return obs_cmd


def is_process_running(pid):
    import GameSentenceMiner.obs as _obs_pkg

    try:
        process = psutil.Process(pid)
        return "obs" in process.exe().lower()
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        if os.path.exists(_obs_pkg.OBS_PID_FILE):
            try:
                os.remove(_obs_pkg.OBS_PID_FILE)
            except OSError:
                pass
        return False


def start_obs(force_restart=False):
    import GameSentenceMiner.obs as _obs_pkg

    if os.path.exists(_obs_pkg.OBS_PID_FILE):
        with open(_obs_pkg.OBS_PID_FILE, "r") as f:
            try:
                _obs_pkg.obs_process_pid = int(f.read().strip())
                if is_process_running(_obs_pkg.obs_process_pid):
                    if force_restart:
                        try:
                            process = psutil.Process(_obs_pkg.obs_process_pid)
                            process.terminate()
                            process.wait(timeout=10)
                        except Exception as e:
                            print(f"Error terminating OBS process: {e}")
                    else:
                        return _obs_pkg.obs_process_pid
            except ValueError:
                print("Invalid PID found in file. Launching new OBS instance.")
            except OSError:
                print("No process found with the stored PID. Launching new OBS instance.")

    obs_path = get_obs_path()
    base_cmd, base_cwd = _resolve_obs_launch_command(obs_path)
    if not base_cmd:
        print(f"OBS not found at {obs_path}. Please install OBS.")
        return None
    try:
        _cleanup_obs_startup_artifacts()
        obs_cmd = _build_obs_launch_command(base_cmd)
        obs_process = subprocess.Popen(obs_cmd, cwd=base_cwd)
        _obs_pkg.obs_process_pid = obs_process.pid
        with open(_obs_pkg.OBS_PID_FILE, "w") as f:
            f.write(str(_obs_pkg.obs_process_pid))
        logger.success("OBS launched successfully!")
        return _obs_pkg.obs_process_pid
    except Exception as e:
        logger.error(f"Error launching OBS: {e}")
        return None


# ---------------------------------------------------------------------------
# WebSocket readiness helpers
# ---------------------------------------------------------------------------
def is_obs_websocket_reachable(host: Optional[str] = None, port: Optional[int] = None, timeout: float = 0.25):
    host = host or get_config().obs.host
    port = port or get_config().obs.port
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
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
    import obsws_python as obs

    start = time.time()
    host = host or get_config().obs.host
    port = port or get_config().obs.port
    password = password if password is not None else get_config().obs.password
    while True:
        if is_obs_websocket_reachable(host=host, port=port):
            client = None
            try:
                client = obs.ReqClient(host=host, port=port, password=password, timeout=1)
                client.get_version()
                scene_response = client.get_scene_list()
                if scene_response and scene_response.scenes is not None:
                    return True
            except Exception:
                pass
            finally:
                if client:
                    try:
                        client.disconnect()
                    except Exception:
                        pass
        if timeout is not None and (time.time() - start) >= timeout:
            return False
        if not gsm_state.keep_running:
            return False
        await asyncio.sleep(interval)


# ---------------------------------------------------------------------------
# OBS WebSocket config sync
# ---------------------------------------------------------------------------
def get_obs_websocket_config_values():
    try:
        config_path = os.path.join(
            get_app_directory(),
            "obs-studio",
            "config",
            "obs-studio",
            "plugin_config",
            "obs-websocket",
            "config.json",
        )
        if not os.path.isfile(config_path):
            return

        with open(config_path, "r") as file:
            config = json.load(file)

        server_enabled = config.get("server_enabled", False)
        server_port = config.get("server_port", 7274)
        server_password = config.get("server_password", None)

        if not server_enabled:
            logger.info(
                "OBS WebSocket server is not enabled. Enabling it now... Restart OBS for changes to take effect."
            )
            config["server_enabled"] = True
            with open(config_path, "w") as file:
                json.dump(config, file, indent=4)

        if get_config().obs.password == "your_password":
            logger.info("OBS WebSocket password is not set. Setting it now...")
            full_config = get_master_config()
            full_config.get_config().obs.port = server_port
            full_config.get_config().obs.password = server_password
            full_config.sync_shared_fields()
            full_config.save()
            reload_config()
    except Exception as e:
        logger.error(f"Failed to check OBS WebSocket config: {e}")
