"""OBS process lifecycle: launch, kill, PID tracking, artifact cleanup."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess

import psutil

from GameSentenceMiner.obs._state import OBS_PID_FILE, get_obs_process_pid, set_obs_process_pid
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import (
    get_app_directory,
    get_config,
    get_master_config,
    logger,
    reload_config,
)


# ---------------------------------------------------------------------------
# Path helpers
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


# ---------------------------------------------------------------------------
# Startup artifact cleanup
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------


def is_process_running(pid):
    try:
        process = psutil.Process(pid)
        return "obs" in process.exe().lower()
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        if os.path.exists(OBS_PID_FILE):
            try:
                os.remove(OBS_PID_FILE)
            except OSError:
                pass
        return False


def start_obs(force_restart=False):
    obs_process_pid = get_obs_process_pid()
    if os.path.exists(OBS_PID_FILE):
        with open(OBS_PID_FILE, "r") as f:
            try:
                obs_process_pid = int(f.read().strip())
                set_obs_process_pid(obs_process_pid)
                if is_process_running(obs_process_pid):
                    if force_restart:
                        try:
                            process = psutil.Process(obs_process_pid)
                            process.terminate()
                            process.wait(timeout=10)
                            print("OBS process terminated for restart.")
                        except Exception as e:
                            print(f"Error terminating OBS process: {e}")
                    else:
                        return obs_process_pid
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
        obs_process_pid = obs_process.pid
        set_obs_process_pid(obs_process_pid)
        with open(OBS_PID_FILE, "w") as f:
            f.write(str(obs_process_pid))
        logger.success("OBS launched successfully!")
        return obs_process_pid
    except Exception as e:
        logger.error(f"Error launching OBS: {e}")
        return None


# ---------------------------------------------------------------------------
# OBS WebSocket config helpers
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
